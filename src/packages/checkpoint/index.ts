/**
 * checkpoint 插件：每个回合前后各拍一份**影子 git 快照**，并把工作区还原到某一回合之前。**默认开**。
 *
 * 快照：回合开始前一张、收工后一张，存进 `~/.dsc/checkpoints/`；`/checkpoint restore <回合>`
 * 把它们变成「退回去」：逐路径判断用户有没有手改，没改的写回起点版本，改过的做三方合并
 * （保住用户手改的那部分），合并不干净就整次不写盘（判定在 `shadow.ts` 的 `restoreTurn`）。
 *
 * 三条纪律，写在这里免得后来人加功能时踩：
 *   1. **不碰用户的仓库**：`GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` 全指到影子仓库，
 *      工作区里连 `.git` 都不建一个（`shadow.ts` 的文件头写了为什么）。
 *   2. **不许影响回合**：快照是旁路，任何失败都只落 logger.debug，会话流里最多提醒一次；
 *      同一时刻只跑一个快照，撞上了就跳过这一次（丢一张快照比卡住回合便宜）。
 *   3. **有上限**：post 快照后量一次仓库占用，超过设置的上限就停用并说一次，
 *      不让一个长期项目把磁盘写满。
 *
 * 挂载点：`dsc/turn-start` / `dsc/turn-end` 两个事件、设置分区 `checkpoint`、`/checkpoint` 命令。
 *
 * @module dsc/plugins/checkpoint
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type {
  CommandContext,
  SettingsField,
  SettingsSectionSpec,
  SettingsValues,
  TurnSignal,
} from '@pneuma/runtime/services/types.js'
import { clockText } from '@pneuma/runtime/core/clock.js'
import { errText } from '@pneuma/runtime/core/err-text.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import {
  bumpTurn,
  currentTurn,
  listSnapshots,
  recordTurnLedger,
  repoSizeMB,
  restoreTurn,
  shadowRepoPath,
  shadowRoot,
  snapshot,
  type RestoreResult,
} from './shadow.js'

/** 设置分区的 id，也是 `plugins.json` 里这一条的键。 */
const CONFIG_KEY = 'checkpoint'

/** 设置分区的导航位置：审批地板 33、压缩 35、目标 36、上下文瘦身 38 之后（37 是转存）。 */
const SECTION_ORDER = 39

/** 默认值：开、512MB 上限、列表显示 20 条。 */
const DEFAULTS = { enabled: true, maxRepoMB: 512, listLimit: 20 } as const

/** 设置面文案的取词器（语言来自 config.yaml，字典是本包的 locale/ui.*.json）。 */
const t = hostT(import.meta.dirname)

/** 生效的配置。 */
interface CheckpointConfig {
  enabled: boolean
  maxRepoMB: number
  listLimit: number
}

/** 每次现读磁盘：设置页改完立刻生效，不用重启宿主。 */
function readConfig(passed: unknown): CheckpointConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : DEFAULTS.enabled
  const maxRepoMB = Number(raw['maxRepoMB'])
  const listLimit = Number(raw['listLimit'])
  return {
    enabled,
    maxRepoMB: Number.isFinite(maxRepoMB) && maxRepoMB > 0 ? Math.round(maxRepoMB) : DEFAULTS.maxRepoMB,
    listLimit:
      Number.isFinite(listLimit) && listLimit >= 1
        ? Math.min(200, Math.round(listLimit))
        : DEFAULTS.listLimit,
  }
}

/** `2026-11-11T16:42:50+08:00` → `2026-11-11 16:42:50`（本地时间；列快照要看得见日期）。 */
function stampText(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return iso
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clockText(ts)}`
}

export const checkpointPlugin: Plugin.Object = {
  name: 'checkpoint',
  inject: ['session', 'commands', 'settings', 'transcript'],
  apply(ctx, passed: unknown) {
    /** 一次快照还在跑时不再起第二次（诊断日志里能看出跳过了哪一半）。 */
    let busy = false
    /** 仓库超过上限后停用：本进程内一直停着，直到用户在设置里把上限调大。 */
    let stoppedByQuota = false
    /** 失败只在会话流里说一次，避免每回合刷一行同样的报错。 */
    let failureNoticed = false
    /** 超限提示只发一次；调大上限时复位，再次超限还能再说一次。 */
    let quotaNoticed = false

    /** 往会话流写一行；带回合的会话归属，后台回合的提示不会画到用户正看的会话里。 */
    const say = (text: string, signal?: TurnSignal): void => {
      try {
        ctx.transcript.system(text, 'info', false, signal?.sessionId)
      } catch {
        // transcript 不在（收摊中）：这一行提示不值得把回合带崩
      }
    }

    /** 快照失败：记 debug，会话流最多说一次。 */
    const failOnce = (detail: string, signal?: TurnSignal): void => {
      ctx.logger.debug('checkpoint: 快照失败：%s', detail)
      if (failureNoticed) return
      failureNoticed = true
      say(`影子快照失败（不影响回合）：${detail}`, signal)
    }

    /**
     * 这个回合该拍哪个工作目录。
     *
     * 回合事件带会话归属（0.6.48），但这里拿不到「按 id 找会话」的服务（inject 里只有
     * session）；对不上当前会话就跳过——宁可少一张快照，也不能把后台会话的回合拍到
     * 用户正打开的那个工作区里。
     */
    const turnCwd = (signal?: TurnSignal): string | null => {
      try {
        const current = ctx.session.current()
        if (signal !== undefined && typeof signal.sessionId === 'string' && signal.sessionId !== '' && signal.sessionId !== current.meta.id) {
          return null
        }
        return current.meta.cwd
      } catch {
        return null
      }
    }

    /**
     * 跑一张快照。
     *
     * 顺序固定：`pre` 先自增回合号（同一回合的 pre/post 共用这个号），post 拍完顺手量占用。
     * 所有异常在这里收干净——调用方是事件回调，抛出去没有任何人接。
     */
    const run = async (label: 'pre' | 'post', signal?: TurnSignal): Promise<void> => {
      const config = readConfig(passed)
      if (!config.enabled || stoppedByQuota) return
      const cwd = turnCwd(signal)
      if (cwd === null) return
      if (busy) {
        ctx.logger.debug('checkpoint: 上一张快照还在跑，跳过这次 %s', label)
        return
      }
      busy = true
      try {
        if (label === 'pre') await bumpTurn(cwd)
        const turn = currentTurn(cwd)
        const result = await snapshot(cwd, label, `turn ${turn} ${label}`)
        if (!result.ok) {
          failOnce(result.error ?? '未知错误', signal)
          return
        }
        if (label === 'post') {
          // 账本跟着 post 快照一起记：它只做「谁改的」归属，记不上也不影响快照与还原
          await recordTurnLedger(cwd, turn)
          const sizeMB = await repoSizeMB(cwd)
          if (sizeMB > config.maxRepoMB) {
            stoppedByQuota = true
            if (!quotaNoticed) {
              quotaNoticed = true
              say(
                `影子快照已停用：仓库超过上限（${sizeMB.toFixed(1)}MB > ${config.maxRepoMB}MB），/checkpoint 里可调`,
                signal,
              )
            }
          }
        }
      } catch (error) {
        failOnce(errText(error), signal)
      } finally {
        busy = false
      }
    }

    // ── 回合钩子 ─────────────────────────────────────────────────────────────

    ctx.on('dsc/turn-start', (signal: TurnSignal) => {
      void run('pre', signal)
    })
    ctx.on('dsc/turn-end', (_reason, signal: TurnSignal) => {
      void run('post', signal)
    })

    // ── /checkpoint ──────────────────────────────────────────────────────────

    /** 现状：开关、仓库路径、回合数、占用。 */
    const statusText = async (cwd: string): Promise<string> => {
      const config = readConfig(passed)
      const state = !config.enabled ? '关（设置里已停用）' : stoppedByQuota ? '已停用（仓库超过上限）' : '开'
      const sizeMB = await repoSizeMB(cwd)
      return [
        `影子快照：${state}`,
        `仓库：${shadowRepoPath(cwd)}`,
        `回合数：${String(currentTurn(cwd))}｜占用：${sizeMB.toFixed(1)}MB（上限 ${String(config.maxRepoMB)}MB）`,
      ].join('\n')
    }

    /** `/checkpoint list [条数]`：最近几次快照的回合号与时间（新的在前）。 */
    const listText = async (cwd: string, requested: number | undefined): Promise<string> => {
      const config = readConfig(passed)
      const limit =
        requested !== undefined && Number.isFinite(requested) && requested >= 1
          ? Math.min(200, Math.round(requested))
          : config.listLimit
      const entries = await listSnapshots(cwd, limit)
      if (entries.length === 0) return '还没有影子快照：下一次回合开始时自动存一份。'
      const lines = [`最近 ${String(entries.length)} 次影子快照（新的在前）：`]
      for (const entry of entries) {
        const when = stampText(entry.at)
        // 手动快照没有回合号：它是「还原前那一刻」，单独一个说法。
        if (entry.label === 'manual') {
          lines.push(`  还原前 · ${when}`)
          continue
        }
        const half = entry.label === 'pre' ? '回合前' : '回合后'
        lines.push(`  回合 ${String(entry.turn)} · ${half} · ${when}`)
      }
      return lines.join('\n')
    }

    /**
     * `/checkpoint restore` 的说话方式：总数、写回、跳过、冲突四样都要说清。
     *
     * 冲突时只列前 10 条——一屏刷不完的清单没人看得完，剩下的交给「另有 N 条」。
     */
    const restoreText = (result: RestoreResult, requested: number): string => {
      if (!result.ok) {
        if (result.error === 'bad-turn') {
          return '用法：/checkpoint restore <回合号>，例如 /checkpoint restore 3（回合号见 /checkpoint list）。'
        }
        if (result.error === 'missing') {
          const recent =
            result.available.length === 0
              ? '还没有任何回合快照（下一个回合开始时才会存第一张）'
              : `最近可用的回合：${result.available.join('、')}`
          return `没有第 ${String(requested)} 个回合的快照。${recent}`
        }
        if (result.error === 'missing-post') {
          return `第 ${String(requested)} 个回合没有回合后快照（那一回合可能被中断），算不出模型改了什么，没有动任何文件。`
        }
        if (result.error?.startsWith('safety:') === true) {
          return `还原前的安全快照没存下来，已取消还原（没有动任何文件）：${result.error.slice('safety:'.length)}`
        }
        const tail =
          result.written > 0
            ? `已写盘 ${String(result.written)} 处，${result.safetyTag === undefined ? '没有安全快照' : `还原前的现场在 ${result.safetyTag}`}`
            : '没有动任何文件'
        return `还原失败：${result.error ?? '未知错误'}（${tail}）`
      }
      const counts =
        `模型改过 ${String(result.changed)} 处，写回 ${String(result.written)} 处，` +
        `跳过 ${String(result.skipped)} 处，冲突 ${String(result.conflicts.length)} 处`
      const safety =
        result.safetyTag === undefined ? '' : `还原前的现场存成了快照 ${result.safetyTag}（还能再还原回来）。`
      if (result.changed === 0) return `第 ${String(result.turn)} 回合模型没有改动文件，不用还原。`
      if (result.conflicts.length > 0) {
        const lines = [
          `第 ${String(result.turn)} 回合没有写盘：${counts}。`,
          '这些文件两边都改了同一段，没有自动写盘：',
        ]
        for (const path of result.conflicts.slice(0, 10)) lines.push(`  ${path}`)
        if (result.conflicts.length > 10) lines.push(`  ……另有 ${String(result.conflicts.length - 10)} 条`)
        if (safety !== '') lines.push(safety)
        return lines.join('\n')
      }
      return `第 ${String(result.turn)} 回合已还原：${counts}。${safety}`
    }

    const handleCommand = async (args: string[], ui: CommandContext): Promise<void> => {
      let cwd: string
      try {
        cwd = ctx.session.current().meta.cwd
      } catch {
        ui.notice('没有打开的会话，读不到工作目录。')
        return
      }
      const head = (args[0] ?? 'status').toLowerCase()
      if (head === 'status') {
        ui.notice(await statusText(cwd))
        return
      }
      if (head === 'list') {
        const requested = args[1] === undefined ? undefined : Number(args[1])
        ui.notice(await listText(cwd, requested))
        return
      }
      if (head === 'restore') {
        const requested = args[1] === undefined ? Number.NaN : Number(args[1])
        if (!Number.isFinite(requested) || requested < 1) {
          ui.notice('用法：/checkpoint restore <回合号>，例如 /checkpoint restore 3（回合号见 /checkpoint list）。')
          return
        }
        const turn = Math.floor(requested)
        let result: RestoreResult
        try {
          result = await restoreTurn(cwd, turn)
        } catch (error) {
          // restoreTurn 自己会收错误；这里兜的是「连它都没兜住」的那种，别把命令带崩。
          ui.notice(`还原失败（没有动任何文件）：${errText(error)}`)
          return
        }
        ui.notice(restoreText(result, turn))
        return
      }
      ui.notice('用法：/checkpoint [status] | /checkpoint list [条数] | /checkpoint restore <回合>')
    }

    const offCommand = ctx.commands.register(
      {
        name: 'checkpoint',
        args: '[status | list [条数] | restore <回合>]',
        label: t('command.label'),
        description: t('command.description'),
      },
      ({ args, ui }) => {
        void handleCommand(args, ui)
      },
    )
    ctx.effect(() => offCommand, 'checkpoint: commands.register')

    // ── 设置分区 ─────────────────────────────────────────────────────────────

    /** 设置页可能在还没有会话时打开：读不到工作目录就只少一行「仓库在哪」，别让整页报错。 */
    const currentCwd = (): string | null => {
      try {
        return ctx.session.current().meta.cwd
      } catch {
        return null
      }
    }

    const fields = (): SettingsField[] => {
      const list: SettingsField[] = [
        {
          type: 'switch',
          key: 'enabled',
          label: t('field.enabled.label'),
          help: t('field.enabled.help'),
        },
        {
          type: 'number',
          key: 'maxRepoMB',
          label: t('field.maxRepoMB.label'),
          min: 16,
          max: 102_400,
          step: 64,
          help: t('field.maxRepoMB.help'),
        },
        {
          type: 'number',
          key: 'listLimit',
          label: t('field.listLimit.label'),
          min: 1,
          max: 200,
          step: 1,
          help: t('field.listLimit.help'),
        },
      ]
      const cwd = currentCwd()
      if (cwd !== null) {
        list.push({
          type: 'info',
          label: t('field.repo.label'),
          mono: true,
          copyable: true,
          text: shadowRoot(cwd),
        })
      }
      return list
    }

    const section: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: SECTION_ORDER,
      fields,
      // 每次打开分区现读磁盘：手改 plugins.json 也能看到真值。
      values(): SettingsValues {
        const config = readConfig(passed)
        return { enabled: config.enabled, maxRepoMB: config.maxRepoMB, listLimit: config.listLimit }
      },
      save(key, value): string | void {
        switch (key) {
          case 'enabled':
            writePluginConfig(CONFIG_KEY, { enabled: value === true })
            return
          case 'maxRepoMB': {
            const number = Number(value)
            if (!Number.isFinite(number) || number <= 0) return t('save.notNumber')
            writePluginConfig(CONFIG_KEY, { maxRepoMB: Math.round(number) })
            // 调大上限是用户对「停用」的回应：下一个回合就该恢复快照。
            stoppedByQuota = false
            quotaNoticed = false
            return
          }
          case 'listLimit': {
            const number = Number(value)
            if (!Number.isFinite(number) || number < 1) return t('save.notNumber')
            writePluginConfig(CONFIG_KEY, { listLimit: Math.min(200, Math.round(number)) })
            return
          }
          default:
            return t('save.unknownKey', { key })
        }
      },
    }
    const offSection = ctx.settings.registerSection(section)
    ctx.effect(() => offSection, 'checkpoint: settings.registerSection')

    return () => offSection()
  },
}
