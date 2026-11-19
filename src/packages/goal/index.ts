/**
 * goal 插件：provide `goal` 服务——会话目标与它的跨轮自动续跑。
 *
 * 功能点自己那几块：
 *   1. 工具 `goal`（建目标 / 报完成 / 报阻塞；暂停恢复只能用户做）与命令 `/goal`；
 *   2. 界面快照里的 `goal` 投影；
 *   3. 会话状态条目 `goal`：恢复历史会话或切会话后一律**卸膛**，要续跑得用户亲自点继续；
 *   4. 自动续跑的驱动：听 `dsc/turn-end`（一轮干净结束）向自己要一轮，再交给 agent 排队补发；
 *   5. 压缩时要原样带过去的目标一句话（`ctx.compact.registerCarry`）。
 *
 * 「有没有卡片挂着等用户」问 `ctx.waiting`——有卡就不许自动往下推，
 * 这条规则原先靠挨个查审批 / 计划 / 提问三个功能点，现在只问登记表。
 * 0.6.48 起问的是**自己这条会话**（`waiting.anyFor(会话 id)`）：后台会话挂着的审批卡
 * 不拦这条会话的续跑（P0-6）。目标存储也按会话分表，工具按调用方会话读写（P0-7）。
 *
 * 缺省轮次上限与 `/goal rounds` 每次放宽的幅度是插件配置（`goal.defaultMaxRounds` / `goal.extendRoundsBy`），
 * 也注册成设置分区「会话目标」的两项；保存后本插件立刻重读，下一条目标就用新值。
 *
 * @module dsc/plugins/goal
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { DEFAULT_MAX_GOAL_ROUNDS, GoalStore } from './goal.js'
import { resolvePluginConfig, writePluginConfig } from '@pneuma/runtime/core/plugin-registry.js'
import { Session } from '@pneuma/runtime/core/session.js'
import type { GoalView, SettingsField, SettingsValues } from '@pneuma/runtime/contract.js'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { GoalService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { clampInt as clamp } from '@pneuma/runtime/core/clamp.js'
import { hostT } from '@pneuma/runtime/core/i18n.js'

/**
 * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
 * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
 */
const t = hostT(import.meta.dirname)

/** 配置键（`~/.dsc/plugins.json` 条目树里 `file` 等于这个名字那一项的 `config`）。 */
const CONFIG_KEY = 'goal'

/** 目标插件的可调项。 */
interface GoalConfig {
  /** 建目标时没写 maxRounds 用的轮次上限。 */
  defaultMaxRounds: number
  /** `/goal rounds` 一次放宽多少轮。 */
  extendRoundsBy: number
}

const DEFAULTS: GoalConfig = { defaultMaxRounds: DEFAULT_MAX_GOAL_ROUNDS, extendRoundsBy: 8 }

/**
 * 从插件配置里取可调项并夹到合理区间。
 * @param passed - 装配时直接传进来的配置（内核挂载时的第二参数）。
 */
function readConfig(passed?: unknown): GoalConfig {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  return {
    // 上限 256 与 goal.ts 的硬顶一致：配置只能在这个范围内放开，不能取消上限。
    defaultMaxRounds: clamp(raw.defaultMaxRounds, 1, 256, DEFAULTS.defaultMaxRounds),
    extendRoundsBy: clamp(raw.extendRoundsBy, 1, 64, DEFAULTS.extendRoundsBy),
  }
}

export const goalPlugin: Plugin.Object = {
  name: 'goal',
  inject: ['session', 'tools', 'commands', 'agent', 'transcript', 'surfaces', 'waiting', 'compact', 'settings'],
  provide: 'goal',
  apply(ctx, passed) {
    let config = readConfig(passed)
    /** 写盘并立刻重读：新建的目标就用新值。 */
    const applyConfig = (patch: Record<string, unknown | null>): void => {
      writePluginConfig(CONFIG_KEY, patch)
      config = readConfig(passed)
    }
    // 缺省轮次交给一个取值函数：设置里改了数值，下一条目标立刻跟着变，不必重启宿主。
    const newStore = (): GoalStore => new GoalStore({ defaultMaxRounds: () => config.defaultMaxRounds })
    /**
     * 会话 id → 目标存储。**一条会话一份**（P0-7）：宿主从 0.6.48 起同时常驻多条会话的
     * agent，后台会话与队友也会建目标；全进程一个 store 会让两条会话互相覆盖，还会把状态
     * 写进用户正看着的那条 jsonl。建表时按那条会话自己的日志恢复（恢复后一律卸膛）。
     */
    const stores = new Map<string, GoalStore>()
    const storeFor = (session: Session): GoalStore => {
      const existing = stores.get(session.meta.id)
      if (existing !== undefined) return existing
      const created = newStore()
      created.restore(session.state('goal') ?? null)
      stores.set(session.meta.id, created)
      return created
    }
    /** 当前查看会话的目标存储：界面投影、`/goal` 命令、自动续跑都问它。 */
    const store = (): GoalStore => storeFor(ctx.session.current())
    /**
     * 这次工具调用归哪条会话。判定顺序与 `todo` 包同一套（两边各留一份小函数：可写白名单
     * 只许改这两个文件，不为它单开跨包模块），先按调用方身份、最后才回落到界面：
     *   1. `sessionPath`：先问 agent 名册（常驻会话在里面，零读盘）；名册里没有的——
     *      队友会话由 `subagent` 直接 `Session.create/load`，不登记进名册——按路径读一份
     *      只读视图并缓存，之后的 `appendState` 仍写回这个路径；
     *   2. `sessionId`：名册里按 id 找；
     *   3. 都没有才 `ctx.session.current()`：界面、`/命令` 这类非工具调用路径。
     */
    const loadedByPath = new Map<string, Session>()
    const sessionAtPath = (filePath: string): Session | undefined => {
      const live = ctx.get('agent')?.sessionFor(filePath)
      if (live !== undefined) return live
      const cached = loadedByPath.get(filePath)
      if (cached !== undefined) return cached
      let loaded: Session
      try {
        // keepPath=true：状态要写回读进来的这个路径（队友日志住在 `.teammates` 下）；
        // lease=false：只读重放，不抢写租约、不修复中断回合、不投递收件箱。文件不存在时
        // `load` 直接抛错（它从不建空文件），按解析不到处理。
        loaded = Session.load(filePath, true, { lease: false })
      } catch {
        return undefined
      }
      loadedByPath.set(filePath, loaded)
      return loaded
    }
    const sessionOf = (runCtx: { sessionId?: string; sessionPath?: string }): Session => {
      const filePath = runCtx.sessionPath
      if (filePath !== undefined && filePath !== '') {
        const byPath = sessionAtPath(filePath)
        if (byPath !== undefined) return byPath
      }
      const sessionId = runCtx.sessionId
      return (
        (sessionId !== undefined && sessionId !== '' ? ctx.get('agent')?.sessionById(sessionId) : undefined) ??
        ctx.session.current()
      )
    }

    const touch = (): void => ctx.emit('dsc/changed')
    /**
     * 把当前目标快照写进会话日志（恢复会话时靠它）并让快照失效。
     *
     * **空目标也要写**：用户点 ✕ 清空之后快照是 null，得追加一条 `goal = null` 盖掉
     * 日志里上一条真目标；不写的话日志最后一条仍是清空前那份，重启重放又把它读回来
     * （2026-11-02 报障「目标关闭后重启又会出现」）。
     */
    const persist = (session: Session): void => {
      const goals = storeFor(session)
      session.appendState('goal', goals.snapshot)
      touch()
    }

    /**
     * 某条会话的目标快照（界面投影与压缩携带共用这一份判定）。
     * 按会话取（P2）：压缩携带传被压缩的那条，不能拿用户眼前那条的目标。
     */
    const viewOf = (session: Session): GoalView | null => {
      const goals = storeFor(session)
      const snapshot = goals.snapshot
      if (snapshot === null) return null
      return {
        objective: snapshot.objective,
        phase: snapshot.phase,
        rounds: snapshot.rounds,
        maxRounds: snapshot.maxRounds,
        ...(snapshot.blockedReason !== undefined ? { blockedReason: snapshot.blockedReason } : {}),
        armed: goals.armed,
      }
    }

    const service: GoalService = {
      goalView() {
        return viewOf(ctx.session.current())
      },
      get goals() {
        return store()
      },
      goalAction(action) {
        config = readConfig(passed)
        const goals = store()
        const result =
          action === 'pause'
            ? goals.pauseByUser()
            : action === 'resume'
              ? goals.resumeByUser()
              : action === 'clear'
                ? goals.clearByUser()
                : goals.editByUser({ maxRounds: (goals.snapshot?.maxRounds ?? config.defaultMaxRounds) + config.extendRoundsBy })
        if (!result.ok) return { ok: false, error: result.error ?? '目标操作失败' }
        persist(ctx.session.current())
        ctx.emit(
          'dsc/notice',
          `目标：${action === 'pause' ? '已暂停' : action === 'resume' ? '已继续' : action === 'clear' ? '已清空' : '轮次上限已放宽'}`,
        )
        return { ok: true }
      },
      takeGoalRound() {
        const session = ctx.session.current()
        const goals = storeFor(session)
        if (!goals.shouldContinue) return null
        // 只问**这条会话**有没有卡在等用户做决定：别的会话（后台队友、另一条对话）的
        // 审批卡不该把这里的目标永久钉死（P0-6）。全进程口径的 `any` 留给界面。
        if (ctx.waiting.anyFor(session.meta.id)) return null
        const snapshot = goals.countRound()
        persist(session)
        if (snapshot === null || snapshot.phase !== 'active') {
          ctx.emit('dsc/notice', `目标跑满 ${snapshot?.maxRounds ?? 0} 轮上限，自动停下等用户处理`)
          return null
        }
        return (
          `（目标自动续跑：第 ${snapshot.rounds}/${snapshot.maxRounds} 轮）目标还没做完：${snapshot.objective}\n` +
          '对照目标看还差什么，继续往下推进；全部做完并用证据验证过，才调用 goal(action=complete)；' +
          '真的卡住了就 goal(action=blocked, reason=…) 说清需要什么。别因为已经跑了几轮就收手。'
        )
      },
    }
    ctx.provide('goal', service)
    ctx.effect(() => ctx.surfaces.register('goal', () => service.goalView()), 'goal: surfaces.register')

    const goalTool: ToolEntry = {
      name: 'goal',
      description:
        '设置或收尾一个跨轮次的会话目标。目标一旦建立，这一轮做完后系统会自动接着往下跑，直到完成、被你标记阻塞、或跑满轮次上限。' +
        'action=create 建目标（一句话说清要交付什么，可选 maxRounds 放宽轮次上限）；' +
        'action=complete 只在目标真的全部做完并用证据验证过时用；action=blocked 必须写清卡在哪里。' +
        '暂停、恢复、改目标、放宽上限这些只能由用户操作（/goal pause 等），你不能自己给自己续命。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'create | complete | blocked' },
          objective: { type: 'string', description: 'create 时必填：目标一句话' },
          maxRounds: {
            type: 'number',
            description: `create 时可选：自动续跑的轮次上限（默认 ${DEFAULTS.defaultMaxRounds}）`,
          },
          reason: { type: 'string', description: 'blocked 时必填：卡在哪里、需要用户提供什么' },
        },
        required: ['action'],
      },
      risk: 'read',
      async run(args, runCtx) {
        // 写哪条会话由**发起这次调用的会话**决定（P0-7）：后台会话 / 队友建目标时
        // `ctx.session.current()` 是用户正看着的别家会话，落盘绝不能跟着它走。
        const session = sessionOf(runCtx)
        const goals = storeFor(session)
        const action = String(args.action ?? '')
        if (action === 'create') {
          const result = goals.create(
            String(args.objective ?? ''),
            typeof args.maxRounds === 'number' ? args.maxRounds : undefined,
          )
          persist(session)
          if (!result.ok) throw new Error(result.error)
          return `目标已建立：${result.snapshot.objective}（上限 ${result.snapshot.maxRounds} 轮，到点自动 blocked）`
        }
        if (action === 'complete') {
          const result = goals.complete()
          persist(session)
          if (!result.ok) throw new Error(result.error)
          return '目标已标记完成，自动续跑已停止。'
        }
        if (action === 'blocked') {
          const result = goals.block(String(args.reason ?? ''))
          persist(session)
          if (!result.ok) throw new Error(result.error)
          return '目标已标记阻塞，自动续跑已停止，等用户处理。'
        }
        throw new Error('action 只能是 create / complete / blocked（暂停恢复由用户用 /goal 命令做）')
      },
    }
    ctx.effect(() => ctx.tools.register(goalTool), 'goal: tools.register')

    // 摘要模型会把目标改写成另一句话，所以目标原文要原样带进压缩后的上下文。
    // 带会话：按**被压缩的那条**取目标；拿不到会话时才回落当前查看的（兼容老调用方）。
    ctx.effect(() => ctx.compact.registerCarry((session?: Session) => {
      const view = viewOf(session ?? ctx.session.current())
      if (view === null) return ''
      return `会话目标：${view.objective}（已跑 ${view.rounds}/${view.maxRounds} 轮，阶段 ${view.phase}）`
    }), 'goal: compact.registerCarry')

    // /goal：用户侧的目标操作（模型不能自己续命）。
    ctx.effect(() => ctx.commands.register(
      { name: 'goal', args: '<目标 | pause | resume | clear | rounds>', description: '设置或控制会话目标（跨轮自动续跑）' },
      ({ args, ui }) => {
        const head = args[0] ?? ''
        if (head === '') {
          const view = service.goalView()
          ui.notice(
            view === null
              ? '当前没有目标。用法：/goal <一句话说清要交付什么>'
              : `当前目标：${view.objective}（${view.rounds}/${view.maxRounds} 轮，${view.phase}）`,
          )
          return
        }
        if (head === 'pause' || head === 'resume' || head === 'clear' || head === 'rounds') {
          const result = service.goalAction(head as 'pause' | 'resume' | 'clear' | 'extend')
          if (!result.ok) ui.notice(result.error ?? '目标操作失败')
          return
        }
        const result = store().create(args.join(' '))
        if (!result.ok) {
          ui.notice(result.error ?? '目标建立失败')
          return
        }
        persist(ctx.session.current())
        ui.notice(`目标已建立：${result.snapshot.objective}（上限 ${result.snapshot.maxRounds} 轮）`)
      },
    ), 'goal: commands.register')

    /**
     * 目标自动续跑：本轮干净结束后，目标还开着就自己补一条消息接着跑。
     * 走 agent 的排队通道，所以不会跟用户刚发的消息抢；有卡挂着时 takeGoalRound 会挡下来。
     * 0.6.48：只认当前查看会话的回合——目标状态是跟着查看会话走的，
     * 后台 agent 的回合结束不该偷跑这里的目标。
     */
    ctx.on('dsc/turn-end', (reason, signal) => {
      if (reason !== 'completed') return
      // 载荷缺省（老式直接 emit）按当前会话算
      const target = signal?.sessionId ?? ctx.session.current().meta.id
      if (target !== ctx.session.current().meta.id) return
      setTimeout(() => {
        // 0ms 定时器可能在插件卸载之后才轮到：integration 层「起内核 → 跑一轮 → dispose」
        // 的用例里，dispose 会让 cordis 的服务上下文失活，这里再取 session 就抛出
        // `cannot get required service "session" in inactive context`——它落在定时器回调
        // 里没人接，被 Vitest 记成 Unhandled Error，整份集成 job 跟着红（2026-11-19 查账）。
        // 内核都卸了，续跑没有任何意义：静默收场，别把定时器的正常竞态变成未捕获异常。
        try {
          // 这 0ms 里用户可能已经切走：续跑只推它自己那条会话，不隔会话点火。
          if (ctx.session.current().meta.id !== target) return
          const reminder = service.takeGoalRound()
          if (reminder === null) return
          ctx.transcript.system(`目标自动续跑：继续推进「${service.goalView()?.objective ?? ''}」`)
          ctx.agent.followup(reminder, undefined, undefined, 'notice')
        } catch {
          // 上下文已失活（插件卸载 / 内核 dispose）：本就不该再续跑。
        }
      }, 0)
    })

    ctx.on('dsc/session-open', ({ session }) => {
      // 切会话：目标跟着新会话回来，自动续跑一律先卸膛（不隔会话点火）。
      storeFor(session).restore(session.state('goal') ?? null)
      touch()
    })

    const fields: SettingsField[] = [
      {
        type: 'number',
        key: 'defaultMaxRounds',
        label: t('field.defaultMaxRounds.label'),
        min: 1,
        max: 256,
        step: 1,
        help: t('field.defaultMaxRounds.help'),
      },
      {
        type: 'number',
        key: 'extendRoundsBy',
        label: t('field.extendRoundsBy.label'),
        min: 1,
        max: 64,
        step: 1,
        help: t('field.extendRoundsBy.help'),
      },
    ]

    const section: SettingsSectionSpec = {
      id: 'goal',
      title: t('section.title'),
      subtitle: t('section.subtitle'),
      order: 36,
      fields: () => fields,
      // 每次打开分区现读磁盘：手改 plugins.json 也能看到真值。
      values: (): SettingsValues => {
        config = readConfig(passed)
        return { defaultMaxRounds: config.defaultMaxRounds, extendRoundsBy: config.extendRoundsBy }
      },
      // 契约：save 返回字符串 = 失败原因。
      save: (key, value): string | void => {
        const num = Number(value)
        if (!Number.isFinite(num)) return t('save.notNumber')
        if (key === 'defaultMaxRounds') applyConfig({ defaultMaxRounds: num })
        else if (key === 'extendRoundsBy') applyConfig({ extendRoundsBy: num })
        else return t('save.unknownKey', { key })
      },
    }
    const offSection = ctx.settings.registerSection(section)
    ctx.effect(() => offSection, 'goal: settings.registerSection')

    return () => offSection()
  },
}
