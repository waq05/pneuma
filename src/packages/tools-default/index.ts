/**
 * tools-default 插件：向 tools 注册表注册 6 件套默认工具
 * （bash/read/write/edit/glob/grep）。剔除本插件即可得到纯对话 harness。
 *
 * 超时与输出预算是部署差异的选择，不在代码里钉死：读自己的插件配置
 * （`~/.dsc/plugins.json` 条目树里 `file: "tools-default"` 那条的 config），
 * 并以设置分区交给界面；保存后按新预算重注册工具，下一次调用就用新值。
 *
 * @module dsc/plugins/tools-default
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { createBashTool, BASH_DEFAULT_BUDGETS, createJobTools, createTerminalTool, JobTable, stopAllBackgroundChildren, stopBackgroundChild, TerminalTable, type BashBudgets } from './bash.js'
import { createPersistentShellTool, PERSISTENT_TIMEOUT_MS, PersistentShellTable } from './persistent-shell.js'
import { createReadTool, editTool, READ_DEFAULT_LINE_LIMIT, writeTool } from '@pneuma/runtime/core/tools/fs-tools.js'
import { readImageTool } from './image-tool.js'
import { globTool, grepTool } from './search-tools.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import type { BackgroundOutputView, BackgroundWorkView, SettingsField, SettingsMutationOk, SettingsValues } from '@pneuma/runtime/contract.js'
import type { BackgroundWorksService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { clampInt as clamp } from '@pneuma/runtime/core/clamp.js'
import {
  detectShells,
  forgetShellDetection,
  parseShellChoice,
  readShellChoice,
  shellChoiceLabel,
  shellLabel,
  SHELL_CHOICES,
} from '@pneuma/runtime/core/terminal-env.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
 */
const t = hostT(import.meta.dirname)

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'tools-default'

/** 可调值的取值区间：超时太小等于没跑，太大等于占着一轮不放。 */
const TIMEOUT_RANGE = { min: 5_000, max: 600_000 }
/** 输出与行数的区间：太小截不出有用信息，太大 spill/审批环节看了也白看。 */
const OUTPUT_RANGE = { min: 1_000, max: 200_000 }
const LINE_RANGE = { min: 100, max: 10_000 }

/** 从插件配置取预算，区间外的值夹回来（配置写错不至于把工具夹死）。 */
function readBudgets(passed?: unknown): BashBudgets & { readLineLimit: number } {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  return {
    timeoutMs: clamp(raw.bashTimeoutMs, TIMEOUT_RANGE.min, TIMEOUT_RANGE.max, BASH_DEFAULT_BUDGETS.timeoutMs),
    maxTimeoutMs: clamp(raw.bashMaxTimeoutMs, TIMEOUT_RANGE.min, TIMEOUT_RANGE.max, BASH_DEFAULT_BUDGETS.maxTimeoutMs),
    outputChars: clamp(raw.bashOutputChars, OUTPUT_RANGE.min, OUTPUT_RANGE.max, BASH_DEFAULT_BUDGETS.outputChars),
    readLineLimit: clamp(raw.readLineLimit, LINE_RANGE.min, LINE_RANGE.max, READ_DEFAULT_LINE_LIMIT),
  }
}

/**
 * 把表上的输出视图（作业的 JobOutputView / 终端的 TerminalOutputView，两者同族）折成
 * 界面要的那几个字段。`kind` 由调用点给（前缀已经在那边判过）。
 */
function toOutputView(
  view: { id: string; status: string; text: string; totalChars: number; from: number; droppedChars: number; atEnd: boolean },
  kind: 'job' | 'terminal',
): BackgroundOutputView {
  return {
    id: view.id,
    kind,
    status: view.status,
    text: view.text,
    totalChars: view.totalChars,
    from: view.from,
    droppedChars: view.droppedChars,
    atEnd: view.atEnd,
  }
}

export const toolsDefaultPlugin: Plugin.Object = {
  name: 'tools-default',
  // T15：完成通知走 agent.followup（排队提交一条消息叫模型回来收结果）。
  // session：后台活清单/停止要按「当前查看会话」筛（0.6.67）；少写进 inject 的话
  // read 里访问 ctx.session 会静默抛「cannot get property "session" without inject」，
  // 快照里整个 backgroundWorks 键缺席（surface-registry 把 read 的错吞成「留旧值」）。
  inject: ['tools', 'settings', 'agent', 'surfaces', 'session'],
  apply(ctx, passed) {
    let budgets = readBudgets(passed)
    /** 当前注册进注册表的清理函数；换预算时先撤旧的再注册新的。 */
    let disposers: Array<() => void> = []

    // ---- T15 后台作业表 ----
    // 完成通知做 800ms 合并：几个作业同时收尾时合成一条 followup，不炸出一串轮次。
    // 0.6.48：合并桶按会话分——通知投给它所属会话的常驻 agent（agent.followup 的
    // sessionId 参数），不再看「当前查看的是哪个会话」；不知道归属的老调用方（探针）
    // 落空桶，照旧投给当前 agent。
    const pendingNotices = new Map<string, string[]>()
    const noticeTimers = new Map<string, NodeJS.Timeout>()
    const table = new JobTable({
      notify: (text, owner) => {
        // 作业状态变了（完成 / 失败 / 起不来）：抖一帧快照——状态面板的「终端」区
        // 立刻把收工那一行撤掉，不等下一次别的变化（快照片段是拉取式，帧才是推）。
        ctx.emit('dsc/changed')
        const key = owner ?? ''
        const bucket = pendingNotices.get(key) ?? []
        bucket.push(text)
        pendingNotices.set(key, bucket)
        if (noticeTimers.has(key)) return
        const timer = setTimeout(() => {
          noticeTimers.delete(key)
          const merged = (pendingNotices.get(key) ?? []).splice(0)
          if (merged.length > 0) ctx.agent.followup(merged.join('\n'), undefined, owner, 'notice')
        }, 800)
        timer.unref?.()
        noticeTimers.set(key, timer)
      },
    })

    // ---- T20 终端会话表 ----
    // 与作业表共用同一张进程登记表（stopAllBackgroundChildren 收摊时一并收掉）；
    // onExit 与作业的完成通知同一条理由：进程自己退出也要把面板那一行撤掉。
    const terminals = new TerminalTable({ onExit: () => ctx.emit('dsc/changed') })

    // ---- 持久 shell 表（极简档的 `shell` 工具）----
    // 每个会话一条常驻 shell，状态跨调用保留；进程同样进后台登记表，收摊时一并收掉。
    const shells = new PersistentShellTable()

    // ---- 状态面板「终端」区的数据面与停止动作 ----
    /** 一行标题：取首行、压到 max 字（面板行只有一行）。 */
    const workTitle = (text: string, max: number): string => {
      const line = (text.split('\n', 1)[0] ?? '').trim()
      return line.length > max ? `${line.slice(0, max)}…` : line
    }
    // 只出**正在跑**的、且**当前查看会话起的**那几条（对齐参考实现：后台工作清单挂在
    // 会话快照上、按会话寻址，切会话互不可见）。收工的由完成通知与台账负责，面板摆的是
    // 现场不是历史；不知道归属的调用方（脚本 / 老探针）起的那几条也不出——面板只画会话
    // 自己的活，归属在 JobRecord / TerminalRecord 的 owner 上（起活时由工具调用身份写入）。
    ctx.effect(() => ctx.surfaces.register('backgroundWorks', (): BackgroundWorkView[] => {
      const sid = ctx.session.current().meta.id
      const works: BackgroundWorkView[] = []
      for (const job of table.list()) {
        if (job.status !== 'running' || job.owner !== sid) continue
        works.push({ id: job.id, kind: 'job', title: workTitle(job.command, 60), startedAt: job.startedAt })
      }
      for (const term of terminals.list()) {
        if (term.status !== 'running' || term.owner !== sid) continue
        const sent = workTitle(term.lastSent, 40)
        works.push({
          id: term.id,
          kind: 'terminal',
          title: sent === '' ? `终端会话 ${term.id}` : `终端 · ${sent}`,
          startedAt: term.startedAt,
        })
      }
      return works.sort((left, right) => left.startedAt - right.startedAt)
    }), 'tools-default: surfaces.register')
    // 「收掉一个」的入口（状态面板的停止钮）：归属校验按当前查看会话做（参考实现的
    // 取消也以会话寻址）——面板只列当前会话的活，收也只收它的；开工的路仍在工具面
    // 与桌面原生桥，这里只有收（与 stopTeammate 同一档，界面通道直接放行）。
    const backgroundWorks: BackgroundWorksService = {
      stop(id: string): string {
        const sid = ctx.session.current().meta.id
        if (id.startsWith('term-')) {
          const term = terminals.list().find((item) => item.id === id)
          if (term !== undefined && term.owner !== undefined && term.owner !== sid) {
            throw new Error(`终端会话 ${id} 属于别的会话，不收（面板只收当前会话起的活）`)
          }
          const text = terminals.close(id)
          ctx.emit('dsc/changed')
          return text
        }
        const job = table.get(id)
        if (job === undefined) throw new Error(`没有这个后台作业或终端会话：${id}（列表按面板现取的 id）`)
        if (job.owner !== undefined && job.owner !== sid) {
          throw new Error(`后台作业 ${id} 属于别的会话，不收（面板只收当前会话起的活）`)
        }
        if (job.status !== 'running') return `${id} 已经是 ${job.status}，不用再收`
        table.markKilled(id)
        const stopped = stopBackgroundChild(id)
        ctx.emit('dsc/changed')
        return stopped
          ? `${id} 正在终止（整树收尾，已收输出保留，还能用 job_output 读到）`
          : `${id} 的进程已经不在了，作业记为被终止`
      },
      // 只读读一次输出快照（状态面板「终端」区点开的那一页轮询它）：归属校验与 stop 同口径
      // ——只读当前查看会话起的活，读别家会话的与收别家的一样拒。走表上的 peek（尾部快照、
      // 不动模型的增量读游标），界面按秒轮询因此不会把模型下一次该读到的输出吃掉。
      read(id: string): BackgroundOutputView {
        const sid = ctx.session.current().meta.id
        if (id.startsWith('term-')) {
          const term = terminals.list().find((item) => item.id === id)
          if (term === undefined) throw new Error(`没有这个终端会话：${id}（列表按面板现取的 id）`)
          if (term.owner !== undefined && term.owner !== sid) {
            throw new Error(`终端会话 ${id} 属于别的会话，读不了（面板只读当前会话起的活）`)
          }
          const view = terminals.peek(id)
          return toOutputView(view, 'terminal')
        }
        const job = table.get(id)
        if (job === undefined) throw new Error(`没有这个后台作业或终端会话：${id}（列表按面板现取的 id）`)
        if (job.owner !== undefined && job.owner !== sid) {
          throw new Error(`后台作业 ${id} 属于别的会话，读不了（面板只读当前会话起的活）`)
        }
        return toOutputView(table.peek(id), 'job')
      },
    }
    ctx.provide('backgroundWorks', backgroundWorks)

    const syncTools = (): void => {
      for (const off of disposers) off()
      disposers = [
        ctx.effect(() => ctx.tools.register(createBashTool(budgets, table)), 'tools-default: tools.register'),
        ...createJobTools(table).map((entry) => ctx.effect(() => ctx.tools.register(entry), 'tools-default: tools.register #2')),
        ctx.effect(() => ctx.tools.register(createTerminalTool(terminals)), 'tools-default: tools.register #3'),
        ctx.effect(
          () => ctx.tools.register(createPersistentShellTool(shells, { timeoutMs: PERSISTENT_TIMEOUT_MS }, shellLabel(readShellChoice()))),
          'tools-default: tools.register #10',
        ),
        ctx.effect(() => ctx.tools.register(createReadTool(budgets.readLineLimit)), 'tools-default: tools.register #4'),
        ctx.effect(() => ctx.tools.register(readImageTool), 'tools-default: tools.register #5'),
        ctx.effect(() => ctx.tools.register(writeTool), 'tools-default: tools.register #6'),
        ctx.effect(() => ctx.tools.register(editTool), 'tools-default: tools.register #7'),
        ctx.effect(() => ctx.tools.register(globTool), 'tools-default: tools.register #8'),
        ctx.effect(() => ctx.tools.register(grepTool), 'tools-default: tools.register #9'),
      ]
    }
    syncTools()

    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      budgets = readBudgets()
      syncTools()
    }

    const fields: SettingsField[] = [
      {
        type: 'number',
        key: 'bashTimeoutMs',
        label: t('field.bashTimeoutMs.label'),
        min: TIMEOUT_RANGE.min,
        max: TIMEOUT_RANGE.max,
        step: 5000,
        help: t('field.bashTimeoutMs.help'),
      },
      {
        type: 'number',
        key: 'bashMaxTimeoutMs',
        label: t('field.bashMaxTimeoutMs.label'),
        min: TIMEOUT_RANGE.min,
        max: TIMEOUT_RANGE.max,
        step: 5000,
        help: t('field.bashMaxTimeoutMs.help'),
      },
      {
        type: 'number',
        key: 'bashOutputChars',
        label: t('field.bashOutputChars.label'),
        min: OUTPUT_RANGE.min,
        max: OUTPUT_RANGE.max,
        step: 1000,
        help: t('field.bashOutputChars.help'),
      },
      {
        type: 'number',
        key: 'readLineLimit',
        label: t('field.readLineLimit.label'),
        min: LINE_RANGE.min,
        max: LINE_RANGE.max,
        step: 100,
        help: t('field.readLineLimit.help'),
      },
    ]

    const section: SettingsSectionSpec = {
      id: CONFIG_KEY,
      title: t('section.budget.title'),
      subtitle: t('section.budget.subtitle'),
      order: 36,
      fields: () => fields,
      // 每次打开分区都现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        budgets = readBudgets()
        return {
          bashTimeoutMs: budgets.timeoutMs,
          bashMaxTimeoutMs: budgets.maxTimeoutMs,
          bashOutputChars: budgets.outputChars,
          readLineLimit: budgets.readLineLimit,
        }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        const num = Number(value)
        if (!Number.isFinite(num)) return t('save.notNumber')
        if (key === 'bashTimeoutMs') applyConfig({ bashTimeoutMs: num })
        else if (key === 'bashMaxTimeoutMs') applyConfig({ bashMaxTimeoutMs: num })
        else if (key === 'bashOutputChars') applyConfig({ bashOutputChars: num })
        else if (key === 'readLineLimit') applyConfig({ readLineLimit: num })
        else return t('save.unknownKey', { key })
      },
    }
    const offSection = ctx.settings.registerSection(section)
    ctx.effect(() => offSection, 'tools-default: settings.registerSection')

    // ---- 终端环境（2026-10-30）：探出这台机器上有哪几个 shell，让用户选默认执行器 ----
    //
    // 为什么并进「通用」、而不是塞进「工具预算」：这一项改的不是预算而是**命令怎么写**。
    // 选了 Git Bash，模型该写 `ls -la`；选了 PowerShell，该写 `Get-ChildItem`。
    // 挨着预算摆，用户会以为是同一类旋钮。
    //
    // 为什么不单开一页（2026-11-06 用户要求）：它只有三个控件，单独占一格左导航太重。
    // 具名插槽走注册契约的 `parent`——这边声明「并进 general」，界面壳把它整块画在
    // 「通用」页末尾（标题、说明、控件都是这份声明自己的，读写仍按 terminal-env 走），
    // 壳里没有「如果是 tools-default 就画终端环境」这种硬编。
    const shellSection: SettingsSectionSpec = {
      id: 'terminal-env',
      title: t('section.shell.title'),
      subtitle: t('section.shell.subtitle'),
      parent: 'general',
      order: 6,
      fields(): SettingsField[] {
        // 每次打开分区都现探一次（10 秒缓存）：刚装好 PowerShell 7 再打开就能看见。
        const detected = detectShells()
        const current = readShellChoice()
        const options = detected
          .filter((item) => item.value === 'auto' || item.available)
          .map((item) => ({ value: item.value, label: item.label }))
        // 选过但现在已经不可用（卸载了 Git / 关掉了 WSL）：仍要能显示当前值，
        // 否则下拉会显示成第一项，用户以为已经跟着改了。
        if (!options.some((option) => option.value === current)) {
          options.push({ value: current, label: t('field.bashShell.option.missing', { shell: current }) })
        }
        // 检测结果拆成两半，各说一件事，不互相复述：
        //   左栏 help：这台机器上有哪几个 shell 可用（完整 ✓/✗ 列表，可折行）；
        //   右栏 text：当前选的是哪一个（「当前：Git Bash 5.3.15」，不带 ✓、不重复标「当前」）。
        // 为什么不全塞右侧：设置页的 .setting-info 是单行省略（max-width 60% + nowrap），
        // 五个 shell 连版本号排一行必然被截掉一半——并进「通用」页后右侧更窄，更不能赌。
        const markOf = (item: { available: boolean }): string => (item.available ? '✓' : '✗')
        // 标记与名字之间用不换行空格：折行只发生在两个 shell 之间，不会把「✓」单独留在行尾。
        const summary = detected.map((item) => `${markOf(item)}\u00A0${item.label}`).join('　')
        const hit = detected.find((item) => item.value === current)
        const currentText = t('field.detected.currentValue', { shell: hit === undefined ? current : hit.label })
        return [
          {
            type: 'select',
            key: 'bashShell',
            label: t('field.bashShell.label'),
            options,
            help: t('field.bashShell.help'),
          },
          { type: 'info', label: t('field.detected.label'), text: currentText, help: summary },
          {
            type: 'button',
            action: 'redetect',
            label: t('field.redetect.label'),
            style: 'ghost',
            help: t('field.redetect.help'),
          },
        ]
      },
      values: (): SettingsValues => ({ bashShell: readShellChoice() }),
      // 契约：save 返回字符串 = 失败原因，返回对象 = 成功（`notice` 是给用户看的回执）。
      // 这里成功必须走对象——返回字符串会被当成「失败原因」摆到界面上（2026-10-30 自查发现）。
      save: (key, value): string | SettingsMutationOk => {
        if (key !== 'bashShell') return t('save.unknownKey', { key })
        if (typeof value !== 'string' || !(SHELL_CHOICES as readonly string[]).includes(value)) {
          return t('save.unknownShell', { shell: String(value) })
        }
        const choice = parseShellChoice(value)
        const detected = detectShells()
        const hit = detected.find((item) => item.value === choice)
        if (choice !== 'auto' && hit !== undefined && !hit.available) {
          return t('save.shellMissing', { shell: hit.label })
        }
        // 走 applyConfig：写 plugins.json 之后重注册工具——工具说明里的终端名要跟着换。
        applyConfig({ bashShell: choice })
        forgetShellDetection()
        return { notice: t('save.shellSwitched', { shell: shellChoiceLabel(choice) }) }
      },
      action: (name): string | void => {
        // 动作的契约与 save 不同：字符串是**成功**的提示文案，失败要抛错。
        if (name !== 'redetect') throw new Error(`不认识的按钮：${name}`)
        forgetShellDetection()
        const detected = detectShells(true)
        const available = detected.filter((item) => item.available).map((item) => item.label)
        return t('action.redetect', { shells: available.join('、') })
      },
    }
    const offShellSection = ctx.settings.registerSection(shellSection, { inSettings: true })
    ctx.effect(() => offShellSection, 'tools-default: settings.registerSection #2')

    // 后台预热一次探测（挂载 50ms 之后，不占启动关键路径）：设置页第一次打开时下拉里就该
    // 已经有选项。不预热的话，`sections()` 会同步跑一次冷探测（四个子进程约 2.5 秒），
    // 用户点开设置就是一阵卡。
    const primeTimer = setTimeout(() => {
      detectShells(true)
    }, 50)
    primeTimer.unref?.()

    return () => {
      for (const off of disposers) off()
      disposers = []
      // T15：内核收摊收掉还在跑的后台作业（跨会话存活的另一面是进程得有人收）
      for (const timer of noticeTimers.values()) clearTimeout(timer)
      noticeTimers.clear()
      shells.closeAll()
      stopAllBackgroundChildren()
      clearTimeout(primeTimer)
      offSection()
      offShellSection()
    }
  },
}
