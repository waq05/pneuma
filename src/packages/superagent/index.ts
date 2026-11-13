/**
 * superagent 插件：把一句话需求派给一个独占工作区的智能体去改代码，结果回到工单里。
 *
 * **第 8 步的装配**：这个文件仍然只做装配——不写业务逻辑、不拼 SQL、不判定需求。
 * `apply` 里做六件事：
 *   1. 登记设置分区 `superagent`：`repoPath` / `maxWorkers` / `ticketTimeoutSeconds`
 *      三个字段，值现读 `~/.dsc/plugins.json`（`resolvePluginConfig`），保存走
 *      `writePluginConfig`——**重启宿主后值还在**，这是第 8 步唯一的硬验收；
 *   2. 注册 `/sa` 命令（`commands.ts`）；
 *   3. 起一个 2 秒的泵，调 `service.tick()`（`runtime.pump()` + 阶段变样时推快照）；
 *   4. 懒建 `SuperagentRuntime`：第一次用到（发命令 / 界面拉快照 / 调五个方法）才打开编排库；
 *   5. provide `superagent` 服务并把快照面登记进 `ctx.surfaces`（`service.ts` / `surface.ts`）；
 *   6. 向 doctor 的 `ctx.health` 登记一项体检（编排库能不能写、锁被占没有、几张工单卡在 running）。
 *
 * 为什么懒建而不是 `apply` 时就连库：插件在设置页里是「可停用」的一行，宿主启动时
 * 十几行插件都会 `apply`；谁在 `apply` 里开库，谁就把「打开数据库」变成宿主启动的
 * 前置条件。一条插件挂了不该拖垮整个宿主（§5.4），所以连库推迟到真正有人用。
 *
 * 为什么泵不主动触发建库：泵每 2 秒跑一次，如果它负责建库，插件一启用就会去抢编排库
 * 的单实例锁——用户还没发任何需求，锁已经被占住。泵只驱动已经建好的运行期；
 * 用户第一次 `/sa new` 之后它才开始工作。
 *
 * **启动恢复与保留策略挂在「运行期第一次建起来」那一刻**（`ensure` 里）：懒启动下，
 * 那才是真正意义上的「这次启动」。恢复把上次崩在 `running` 的工单标成失败、把 `pending`
 * 的重新入队；保留策略删掉已结束超过 30 天的会话目录。之后每天再扫一次会话目录。
 *
 * **出错不炸宿主**：`ensure()` 把打开失败收敛成 `null` + 一条日志，命令据此显示
 * 「未启动」；泵的每一拍也各自捕获异常。插件停在「未启动」状态，与设计文档 §5.4 一致。
 *
 * @module pneuma/superagent
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsField, SettingsValue, SettingsValues } from '@pneuma/runtime/contract.js'
import type { HealthService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { clampInt } from '@pneuma/runtime/core/clamp.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import { openStore, type DscStore } from './adapters/store.js'
import { registerCommands } from './commands.js'
import { LIMITS } from './core/limits.js'
import { createSuperagentHealth } from './health.js'
import { SuperagentRuntime } from './runtime.js'
import { SuperagentService } from './service.js'
import { registerSurface } from './surface.js'

/** 行身份：与 `cordis.patch.yml` 的 `id`、产物目录名三处一致。 */
export const name = 'superagent'

/**
 * 依赖的服务：设置（分区）、命令（`/sa`），以及执行器要的模型 / 工具 / 守卫。
 *
 * 后三项从第 5 步起是硬依赖：worker 就是「另一个 MiniAgent」，没有 `llm` 发不出请求、
 * 没有 `tools` 只拿得到空工具表、没有 `guards` 则沙箱与审批整条链不在场。它们起不来时
 * 本插件也不该起来——这是正确的失败方式（不降级成「看起来能派工」）。
 * 沙箱与压缩是**可选**能力：执行器用 `ctx.get(...)` 读，不在场就少一道围栏 / 少一次压缩，
 * 不写进 inject，免得那两个插件停用时把本插件一起拖得挂不上。
 * `health`（doctor 的体检登记表）同样不写进 inject：doctor 停用时少一项体检，不影响派工。
 */
export const inject = ['settings', 'commands', 'tools', 'llm', 'guards', 'surfaces']

/**
 * 配置键：`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`。
 *
 * 与设置分区 id、patch 行 id 同一个字符串：三处一致，才不会出现「分区写进去了、
 * 插件读的是另一条」这种查半天的错。
 */
const CONFIG_KEY = 'superagent'

/** 设置分区里三个字段的键。P0 只有一个 `repoPath`，第 8 步补齐其余两个。 */
const REPO_PATH_KEY = 'repoPath'
const MAX_WORKERS_KEY = 'maxWorkers'
const TIMEOUT_KEY = 'ticketTimeoutSeconds'

/** 泵的间隔：设计文档 §6.3 写的是 2 秒。 */
const PUMP_INTERVAL_MS = 2000

/** 会话目录的清扫间隔：启动时扫一次，之后每天一次。 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 超时的上限（秒）：24 小时。再长就等于不限，而「不限」用 0 表达。 */
const TIMEOUT_MAX_SECONDS = 24 * 60 * 60

/** 缺省值：并发 2（设计文档 §6.2）、单工单 30 分钟。 */
const DEFAULTS = { maxWorkers: 2, ticketTimeoutSeconds: 1800 } as const

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（中文原文是语义真源，英文是译本）。
 */
const t = hostT(import.meta.dirname)

/** 把未知异常压成一行，日志里用。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 设置面读回来的三个值（都收好了类型与区间）。 */
export interface SuperagentConfig {
  /** 执行器建工作树的仓库根；空 = 没配。 */
  repoPath: string
  /** 并发上限，夹在 1–16。 */
  maxWorkers: number
  /** 单工单超时秒数；0 = 不限。 */
  ticketTimeoutSeconds: number
}

/**
 * 读设置：**每次现读磁盘**，所以设置页保存完不必重启宿主。
 *
 * 三档来源由 `resolvePluginConfig` 统一决定（宿主直给 > patch 行 > `plugins.json`），
 * 这里只负责「类型不对用缺省、数值夹回区间」——库文件与配置文件用户都能手改，
 * 读路径不能信它们的形状。
 *
 * @param passed - 装配时传进来的行配置（cordis 的第二参数）
 */
export function readSuperagentConfig(passed?: unknown): SuperagentConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  return {
    repoPath: typeof raw[REPO_PATH_KEY] === 'string' ? raw[REPO_PATH_KEY].trim() : '',
    maxWorkers: clampInt(raw[MAX_WORKERS_KEY], LIMITS.maxWorkers.min, LIMITS.maxWorkers.max, DEFAULTS.maxWorkers),
    ticketTimeoutSeconds: clampInt(raw[TIMEOUT_KEY], 0, TIMEOUT_MAX_SECONDS, DEFAULTS.ticketTimeoutSeconds),
  }
}

/**
 * 建设置分区：三个字段 + `values()` 现读磁盘 + `save()` 真落盘。
 *
 * 单独导出而不是在 `apply` 里内联，是为了包级测试能直接验「保存 → 读回 → 重开还在」，
 * 不必为一个设置分区造一整套 cordis 上下文。`apply` 用的就是这一个函数，没有第二份。
 *
 * @param passed - 装配时传进来的行配置；与 `apply` 收到的是同一个
 */
export function createSettingsSection(passed?: unknown): SettingsSectionSpec {
  return {
    id: CONFIG_KEY,
    title: t('section.title'),
    subtitle: t('section.subtitle'),
    // 排在「定时任务」（32）、「子代理」（29）之后：都属于「让别的智能体替你干活」那一类。
    order: 39,
    fields(): SettingsField[] {
      return [
        {
          type: 'text',
          key: REPO_PATH_KEY,
          label: t('field.repoPath.label'),
          placeholder: '/path/to/repo',
          mono: true,
          help: t('field.repoPath.help'),
        },
        {
          type: 'number',
          key: MAX_WORKERS_KEY,
          label: t('field.maxWorkers.label'),
          min: LIMITS.maxWorkers.min,
          max: LIMITS.maxWorkers.max,
          step: 1,
          help: t('field.maxWorkers.help'),
        },
        {
          type: 'number',
          key: TIMEOUT_KEY,
          label: t('field.ticketTimeoutSeconds.label'),
          min: 0,
          max: TIMEOUT_MAX_SECONDS,
          step: 60,
          help: t('field.ticketTimeoutSeconds.help'),
        },
      ]
    },
    values(): SettingsValues {
      // 现读磁盘而不是读闭包里的缓存：这是「重启后值还在」与「保存即生效」的同一条路径。
      const config = readSuperagentConfig(passed)
      return {
        [REPO_PATH_KEY]: config.repoPath,
        [MAX_WORKERS_KEY]: config.maxWorkers,
        [TIMEOUT_KEY]: config.ticketTimeoutSeconds,
      }
    },
    save(key: string, value: SettingsValue): string | void {
      switch (key) {
        case REPO_PATH_KEY: {
          const text = String(value).trim()
          // 空串 = 删掉这个键（回到缺省的空路径）；写空串只会在 plugins.json 里留一条没意义的记录。
          writePluginConfig(CONFIG_KEY, { [REPO_PATH_KEY]: text === '' ? null : text })
          return
        }
        case MAX_WORKERS_KEY: {
          const number = Number(value)
          if (!Number.isFinite(number)) return t('save.maxWorkersBad')
          writePluginConfig(CONFIG_KEY, {
            [MAX_WORKERS_KEY]: clampInt(number, LIMITS.maxWorkers.min, LIMITS.maxWorkers.max, DEFAULTS.maxWorkers),
          })
          return
        }
        case TIMEOUT_KEY: {
          const number = Number(value)
          if (!Number.isFinite(number)) return t('save.timeoutBad')
          writePluginConfig(CONFIG_KEY, {
            [TIMEOUT_KEY]: clampInt(number, 0, TIMEOUT_MAX_SECONDS, DEFAULTS.ticketTimeoutSeconds),
          })
          return
        }
        default:
          return t('save.unknownKey', { key })
      }
    },
  }
}

/**
 * 装配入口：设置分区 + `/sa` 命令 + 2 秒泵 + 体检项，运行期懒建。
 *
 * 返回值故意是 void：所有退订 / 清理都交给 `ctx.effect` 统一收口（与 schedule、
 * approval-floor 同一写法），停用这一行时 cordis 自动调它，不需要手写清理清单。
 * @param ctx - 插件上下文（cordis 注入，`settings` 与 `commands` 服务已就绪）
 * @param passed - 装配时传进来的行配置（`cordis.patch.yml` 那一行的 `config`）
 */
export function apply(ctx: Context, passed?: unknown): void {
  /** 现读设置：每次用值时都调它，保存完立刻生效。 */
  const config = (): SuperagentConfig => readSuperagentConfig(passed)

  const offSection = ctx.settings.registerSection(createSettingsSection(passed))
  ctx.effect(() => offSection, 'superagent: settings.registerSection')

  // ── 运行期：懒建 / 泵 / 命令 ────────────────────────────────────────────────

  /** 打开着的库；它归插件这一侧所有，运行期关闭时**不**替我们关（见 `close()`）。 */
  let store: DscStore | null = null
  /** 已建好的运行期；null = 还没人用过（或上次启动失败）。 */
  let runtime: SuperagentRuntime | null = null
  /** 启动失败只记一次日志：泵每 2 秒一拍，不设这道闸会把控制台刷满。 */
  let warned = false
  /** 上次建库失败的一句人话；成功即清空（快照面 `problem.detail` 读它）。 */
  let lastProblem: string | null = null
  /**
   * 失败后多久才重试建库（毫秒）。
   *
   * 快照每次装配都会问 `surface()`，而它要拿运行期；不设这道闸，库一直打不开时
   * 每次重画界面都会重试一次 open + 抢锁。10 秒既不让界面卡在旧状态太久，也不打转。
   */
  let retryAt = 0
  const RETRY_MS = 10_000

  /**
   * 取运行期，没有就建一个。
   *
   * 失败一律收敛成 `null`：调用方（命令、服务）据此显示「未启动」，插件本身继续挂在
   * 宿主上。这是 §5.4「拿不到锁 / 库损坏 → 插件停在未启动，不崩宿主」的落点。
   *
   * 建起来之后立刻跑两件只在启动时做的事（各带自己的 try/catch，失败不影响插件可用）：
   *   - `recover()`：上次崩溃留下的 `running` 标失败、`pending` 重新入队；
   *   - `sweep()`：删掉已结束超过 30 天的会话目录。
   */
  function ensure(): SuperagentRuntime | null {
    if (runtime !== null) return runtime
    if (Date.now() < retryAt) return null
    try {
      store = openStore()
      // 运行期的日志走宿主控制台：`ctx.logger` 不在本包的 inject 里，P0 不为一条日志
      // 多认一个硬依赖。
      // 执行器从 `ctx` 取模型 / 工具 / 守卫；仓库路径、并发上限、超时都从设置现读——
      // 设置页改了，下一张工单 / 下一拍就用新值。
      const opened = new SuperagentRuntime(store, {
        log: (line) => { console.warn(line) },
        ctx,
        worker: { repo: () => config().repoPath, maxWorkers: config().maxWorkers, model: null },
        timeoutSeconds: () => config().ticketTimeoutSeconds,
      })
      runtime = opened
      warned = false
      lastProblem = null
      // 恢复与清扫各自兜底：它们坏了不该让「插件已经能用」这件事退回去。
      try {
        const recovery = opened.recover()
        if (recovery.failed.length > 0 || recovery.requeued.length > 0) {
          console.warn(
            `[superagent] 启动恢复：${String(recovery.failed.length)} 张标为失败（宿主重启，worker 丢了）、` +
              `${String(recovery.requeued.length)} 张重新入队`,
          )
        }
      } catch (error) {
        console.warn(`[superagent] 启动恢复失败（插件照常可用）：${errorText(error)}`)
      }
      try {
        opened.sweep()
      } catch (error) {
        console.warn(`[superagent] 会话清理失败（插件照常可用）：${errorText(error)}`)
      }
      return runtime
    } catch (error) {
      const reason = errorText(error)
      lastProblem = `编排库没打开：${reason}`
      retryAt = Date.now() + RETRY_MS
      if (!warned) {
        warned = true
        console.warn(`[superagent] 未启动：编排库没打开（${reason}）`)
      }
      // 建库失败时 `openStore` 已经把自己的连接关掉了；这里只兜「赋值到一半」的情况。
      store?.close()
      store = null
      return null
    }
  }

  // ── 服务：五个可调方法 + 快照面 ─────────────────────────────────────────────
  // 服务只拿回调，不持有库：谁开谁关的规则仍然由本文件一个人守（见 `ensure`）。
  const service = new SuperagentService({
    current: () => runtime,
    ensure,
    problem: () => (lastProblem === null ? null : { code: 'store_unavailable', detail: lastProblem }),
    changed: () => { ctx.emit('dsc/changed') },
  })
  ctx.provide('superagent', service)
  // 面登记包在 ctx.effect 里（见 `surface.ts`），停用插件即摘掉这一格。
  registerSurface(ctx, () => service.surface())

  // ── 体检项：登记进 doctor 的 health 表 ──────────────────────────────────────
  // doctor 的 pneuma.order 是 3450，早于本插件的 3800，所以 apply 时它已经 provide 了
  // `health`。doctor 没开（或将来被换掉）时 `ctx.get` 给 undefined，少一项体检而已。
  const health = ctx.get('health') as HealthService | undefined
  if (health !== undefined) {
    const offHealth = health.register(createSuperagentHealth({
      store: () => store,
      running: () => runtime?.runningStats() ?? { total: 0, orphaned: 0 },
    }))
    ctx.effect(() => offHealth, 'superagent: health.register')
  }

  ctx.effect(() => {
    const offCommands = registerCommands(ctx, ensure)
    const timer = setInterval(() => {
      // 泵不触发懒建（见文件头）；运行期建好后它负责兜底：超时取消、到期 Eval、
      // 待判定候选，并在工单阶段变了时推一次快照（`service.tick`，见 `service.ts`）。
      if (runtime === null) return
      try {
        service.tick()
      } catch (error) {
        // 单拍失败只记日志，不中断下一拍（§5.4「泵任务抛错：记日志，不中断下一轮」）。
        console.warn(`[superagent] 泵失败：${errorText(error)}`)
      }
    }, PUMP_INTERVAL_MS)
    // 每天清一次会话目录。启动那次已经在 `ensure` 里跑过；这里只接「长期开着」的那一段。
    const sweeper = setInterval(() => {
      if (runtime === null) return
      try {
        runtime.sweep()
      } catch (error) {
        console.warn(`[superagent] 会话清理失败：${errorText(error)}`)
      }
    }, SWEEP_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      clearInterval(sweeper)
      offCommands()
      // 先关运行期（它只释放自己的队列），再关库（库归本文件所有）。
      runtime?.close()
      runtime = null
      store?.close()
      store = null
    }
  }, 'superagent: commands + pump + sweep + runtime')
}
