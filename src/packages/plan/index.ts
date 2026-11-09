/**
 * plan 插件：provide `plan` 服务——`exit_plan_mode` 工具与它的评审卡。
 *
 * 功能点自己那四块：
 *   1. 工具 `exit_plan_mode`（把计划写进 `.dsc/plans/` 并弹卡等用户批）；
 *   2. 界面快照里的 `pendingPlan` 投影 + 「正在等人」登记（有卡挂着时别自动往下推）；
 *   3. 会话状态条目 `plan`（恢复会话时那张卡还在）+ `plans`（本会话的计划目录账，
 *      状态面板的「计划」区按会话出它，见 apply 里那段注释）；
 *   4. 批准后切回执行档——这是模式服务的事，所以这里声明 `inject: ['mode']` 调它，
 *      而不是反过来让模式偷偷查计划（依赖方向只有一条，依赖图上没有环）。
 *
 * 0.6.49 常驻模型：卡跟自己的会话走——多卡并存（每个会话最多一张，互不顶掉），
 * surface 只出「当前查看会话」的卡；切会话不再把挂起的评审按拒收尾（后台会话的卡
 * 继续等它的用户，对齐 dsh 卡只画在发起会话视图里的语义）。
 *
 * @module dsc/plugins/plan
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
import { planFilePath } from '@pneuma/session-core/modes.js'
import { audit } from '@pneuma/runtime/core/audit.js'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { PlanDecision, PlanEntryView, PlanView } from '@pneuma/runtime/contract.js'
import type { PlanService } from '@pneuma/runtime/services/types.js'

/** propose 的结果：决定本身 + 拒绝时用户附的反馈原话（仅 rejected 且用户填了才有）。 */
interface PlanOutcome {
  decision: PlanDecision
  feedback?: string
}

/** 面板「计划」区显示多少条：它是回看口，不是文件管理器；更早的用右侧栏文件树翻 `.dsc/plans/`。 */
const PLAN_DIRECTORY_LIMIT = 12
/** 会话账里最多存多少条：面板只显示最近 12 条，账多留一些，同时防它无界增长（状态条目整表重写）。 */
const PLAN_HISTORY_LIMIT = 50

/** 一张活挂起的评审卡。 */
interface PendingPlanCard {
  id: string
  view: PlanView
  /** 提交计划的会话（后台提卡也归属它）：落库、事件归属、surface 认领全靠它。 */
  sessionPath: string
  /** 提交计划的会话 id：`waiting` 按会话登记时用它（会话路径会被搬动，id 不会）。 */
  sessionId: string
  /** 拒绝时用户附的反馈原文（answerPlan 带进来，经 exit_plan_mode 的结果文案捎给模型）。 */
  rejectionFeedback?: string
  finish(decision: PlanDecision, quiet?: boolean): void
}

export const planPlugin: Plugin.Object = {
  name: 'plan',
  inject: ['session', 'tools', 'mode', 'surfaces', 'waiting'],
  provide: 'plan',
  apply(ctx) {
    /** 当前查看会话的「僵尸」计划卡：状态条目里 decision=pending 的计划（进程重启前留下的）。 */
    const pendingStateOf = (session: { state(name: string): unknown }): PlanView | null => {
      const state = session.state('plan') as PlanView | undefined
      return state?.decision === 'pending' ? state : null
    }
    let restored: PlanView | null = pendingStateOf(ctx.session.current())
    /** 那张僵尸卡属于哪条会话：`waiting` 按会话登记时用它，别的会话的卡不挡这条会话。 */
    let restoredSessionId: string | null = restored === null ? null : ctx.session.current().meta.id
    /** 活挂起的评审卡：卡 id → 卡。多卡并存（0.6.49）。 */
    const pendings = new Map<string, PendingPlanCard>()

    const touch = (): void => ctx.emit('dsc/changed')

    /** 当前查看会话的那张活卡（没有就 null）——surface 与应答都只认它。 */
    const cardOfCurrent = (): PendingPlanCard | undefined => {
      const path = ctx.session.current().filePath
      for (const card of pendings.values()) {
        if (card.sessionPath === path) return card
      }
      return undefined
    }

    /**
     * 收掉当前查看会话的僵尸卡：把终结状态写回会话的 `plan` 条目，再清内存。
     *
     * 为什么必须写状态：僵尸卡是从会话 jsonl 的 `plan` 条目读出来的（`pendingStateOf`），
     * 只清内存的话下次恢复会话它又回来，`anyFor(那条会话)` 依旧恒真——计划卡又是三类卡里
     * 唯一没有超时的，这条会话的目标续跑会永久停摆。
     *
     * @param decision - 用户点的答案；`quiet` = 「同一会话交来新计划」时的作废，不算决定。
     */
    const settleRestored = (decision: PlanDecision, quiet = false): void => {
      if (restored === null || decision === 'pending') return
      const here = ctx.session.current()
      if (restoredSessionId === null || restoredSessionId !== here.meta.id) return
      const settled: PlanView = { ...restored, decision }
      // 先写盘、成功之后再清内存：反过来（先清后写）在写盘抛错时会留下「内存已空、
      // 磁盘仍 pending」的幽灵——重启后僵尸卡又回来了，而这一轮已经切过模式、写过审计。
      // 写盘失败就让它抛出去，内存保持原状，用户重按一次还能重试。
      here.appendState('plan', settled)
      restored = null
      restoredSessionId = null
      ctx.emit('dsc/plan', settled, here.filePath)
      if (quiet) {
        touch()
        return
      }
      ctx.emit('dsc/notice', decision === 'approved' ? '计划已批准，切回执行模式开工。' : '计划未获批准，留在计划模式。', undefined, here.filePath)
      // 与活卡同口径：批准之后该由哪一档继续干活，是模式服务自己的事。
      if (decision === 'approved') ctx.mode.setMode('build')
      audit({
        ts: Date.now(),
        kind: 'mode-change',
        reason: `计划评审：${decision === 'approved' ? '批准' : '拒绝'}`,
        sessionId: here.meta.id,
        cwd: here.meta.cwd,
      })
      touch()
    }

    /** 交一份计划等用户批：挂起直到批准 / 拒绝 / 这一轮被打断。 */
    const propose = (next: PlanView, signal: AbortSignal, sessionPath?: string): Promise<PlanOutcome> =>
      new Promise<PlanOutcome>((resolveDone) => {
        // 提交会话按工具运行身份显式解析（0.6.49 常驻模型：后台回合提卡时
        // ctx.session.current() 是用户正看着的别家会话，落库绝不能跟着它走）。
        const proposed =
          (sessionPath !== undefined ? ctx.get('agent')?.sessionFor(sessionPath) : undefined) ?? ctx.session.current()
        const path = proposed.filePath
        // 同一会话交来新计划：上一张僵尸卡已经没人能答（那次评审随进程重启丢了），
        // 在这里作废它——写终结状态 + 清内存，别让它把新一轮的续跑继续钉着。
        if (restored !== null && restoredSessionId === proposed.meta.id) settleRestored('rejected', true)
        const id = randomUUID()
        /** 提交时刻：计划目录的账按它排（决定可能隔几分钟才下来，排序得看交的时刻）。 */
        const submittedAt = Date.now()
        const finish = (decision: PlanDecision, quiet = false): void => {
          const card = pendings.get(id)
          if (card === undefined) return
          pendings.delete(id)
          const settled: PlanView = { ...next, decision }
          proposed.appendState('plan', settled)
          // 同一会话的僵尸卡跟活卡一起收：新卡的终结状态已经写进同一个 `plan` 条目
          // （上一行），内存里那张再留着会让这条会话的 `anyFor` 恒真。
          if (restored !== null && restoredSessionId === proposed.meta.id) {
            restored = null
            restoredSessionId = null
          }
          // 计划目录的账（状态面板「计划」区按会话出它）：终结就入账——批、拒、
          // 中断清理都算终结（与参考实现「终态计划才进目录」同口径）。待批的不在账里。
          const history = proposed.state('plans')?.items ?? []
          proposed.appendState('plans', {
            items: [...history, { file: next.file, title: next.title, at: submittedAt, decision }].slice(
              -PLAN_HISTORY_LIMIT,
            ),
          })
          ctx.emit('dsc/plan', settled, path)
          // quiet = 退出这类「没人做决定」的清理：卡收掉、状态记成拒绝，不再喊界面。
          if (!quiet) {
            ctx.emit('dsc/notice', decision === 'approved' ? '计划已批准，切回执行模式开工。' : '计划未获批准，留在计划模式。', undefined, path)
          }
          // 批准之后该由哪一档继续干活，是模式服务自己的事：这里只是把结果告诉它。
          if (decision === 'approved') ctx.mode.setMode('build')
          audit({
            ts: Date.now(),
            kind: 'mode-change',
            reason: `计划评审：${decision === 'approved' ? '批准' : '拒绝'}`,
            sessionId: proposed.meta.id,
            cwd: proposed.meta.cwd,
          })
          // 提卡会话还在跑（决定完工具就返回、回合继续）：状态点从「等审批」翻回 working；
          // quiet 路径交给回合收尾的 turn-end 收口。
          if (!quiet) {
            ctx.emit('dsc/agent-status', { sessionId: proposed.meta.id, path, state: 'working' })
          }
          touch()
          const feedback = card.rejectionFeedback
          resolveDone({
            decision,
            ...(decision === 'rejected' && feedback !== undefined ? { feedback } : {}),
          })
        }
        pendings.set(id, { id, view: next, sessionPath: path, sessionId: proposed.meta.id, finish })
        ctx.emit('dsc/plan', next, path)
        ctx.emit('dsc/agent-status', { sessionId: proposed.meta.id, path, state: 'awaiting-approval' })
        signal.addEventListener('abort', () => finish('rejected'), { once: true })
        touch()
      })

    const service: PlanService = {
      pendingPlan() {
        // 只出当前查看会话的卡：活卡优先，没有再看这个会话状态里留的僵尸卡。
        return cardOfCurrent()?.view ?? restored
      },
      proposePlan: (input, signal) => propose({ ...input, decision: 'pending' }, signal).then((outcome) => outcome.decision),
      answerPlan(decision, feedback) {
        const card = cardOfCurrent()
        if (card === undefined) {
          // 没有活卡，可能是重启前留下的僵尸卡：以前这里直接返回，卡撤不掉、
          // `anyFor(这条会话)` 恒真（目标续跑永久停摆）。按用户点的答案把它收掉。
          settleRestored(decision)
          return
        }
        if (decision === 'rejected' && typeof feedback === 'string' && feedback.trim() !== '') {
          card.rejectionFeedback = feedback.trim()
        }
        card.finish(decision)
      },
    }
    ctx.provide('plan', service)
    ctx.effect(() => ctx.surfaces.register('pendingPlan', () => service.pendingPlan()), 'plan: surfaces.register')
    ctx.effect(() => ctx.waiting.register('plan', (owner?: string) => {
      // 按会话登记（P0-6）：`owner` 缺省 = 全进程有没有卡（界面口径），
      // 给了就只算那条会话的活卡与僵尸卡，别的会话挂着计划卡不挡这条会话。
      for (const card of pendings.values()) {
        if (owner === undefined || card.sessionId === owner) return true
      }
      return restored !== null && (owner === undefined || restoredSessionId === owner)
    }), 'plan: waiting.register')

    // ── 「计划」区（状态面板）：本会话提交过的计划目录 ──────────────────────────
    //
    // 数据源是会话状态（`plans` 条目，见 finish 里的入账），不扫盘：面板的「计划」区
    // 与参考实现「计划目录 = 会话自己的终态计划」同一口径——只出本会话的、切会话
    // 互不可见、跨重启还在（状态条目写在会话 jsonl 里，恢复会话就读回来）。
    // `.dsc/plans/` 下的文件仍是全工作区共享的回看口（人和 git 看）：它没有会话
    // 归属，扫盘分不出哪份是谁交的，所以面板不拿它当数据源。
    // 待批的那张不进目录（只有终结时才入账；挂着的那张在输入框上方的评审卡里）。
    // 引入这份账之前的老会话没有它——目录空着，不回溯（要翻文件用右侧栏文件树）。
    ctx.effect(() => ctx.surfaces.register('planDirectory', (): PlanEntryView[] => {
      const items = ctx.session.current().state('plans')?.items ?? []
      return items
        .slice()
        .sort((left, right) => right.at - left.at)
        .slice(0, PLAN_DIRECTORY_LIMIT)
        .map(({ file, title, at }) => ({ file, title, at }))
    }), 'plan: surfaces.register #2')

    const exitPlanTool: ToolEntry = {
      name: 'exit_plan_mode',
      description:
        '把你写好的计划交给用户批。参数 plan 是计划全文（markdown，第一行是 # 标题）。' +
        '本工具会把计划写进 .dsc/plans/ 下的文件，并弹出一张评审卡：用户批准就自动切回执行模式开始干活，' +
        '拒绝就留在计划模式继续改方案。一次回答最多交一份计划；改方案要交完整的新版本，不要交补丁。',
      parameters: {
        type: 'object',
        properties: {
          plan: { type: 'string', description: '计划全文（markdown）' },
          title: { type: 'string', description: '计划标题（可省略，默认取正文第一个 # 标题）' },
        },
        required: ['plan'],
      },
      risk: 'read',
      async run(args, runCtx) {
        const text = typeof args.plan === 'string' ? args.plan.trim() : ''
        if (text === '') throw new Error('plan 不能是空的')
        const heading = /^#\s+(.+)$/m.exec(text)
        const title =
          typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : (heading?.[1] ?? '本次改动计划')
        const file = planFilePath(runCtx.cwd, title)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, `${text}\n`, 'utf8')
        const outcome = await propose({ file, title, text, decision: 'pending' }, runCtx.signal, runCtx.sessionPath)
        if (outcome.decision === 'approved') {
          return (
            `用户已批准这份计划（${file}）。现在按计划开工：` +
            '先用 todo_write 把计划里的分步任务立成清单，再一步步做完并实时更新状态。' +
            '计划模式已退出，写操作按权限模式与审批卡走。'
          )
        }
        // T40：拒绝反馈现在有通道了——用户在评审卡里填的原话原样捎给模型，不再让它盲猜。
        const feedback = outcome.feedback === undefined ? '' : `用户的反馈原话：${outcome.feedback}\n`
        return `用户没有批准这份计划（${file}）。${feedback}留在计划模式：把用户的反馈吸收进方案，改完再交一份完整的新计划。`
      },
    }
    ctx.effect(() => ctx.tools.register(exitPlanTool), 'plan: tools.register')

    ctx.on('dsc/session-open', ({ session, filePath }) => {
      // 0.6.49 常驻模型：切会话不再收尾挂起的评审（后台会话的卡继续等它的用户，
      // T29 当年的悬 Promise 死锁在常驻模型下不存在了——提卡的 agent 活着）。
      // 这里只换「当前查看会话」的僵尸计划卡：恢复会话时把计划条目放回会话流，
      // 这张卡用户批过也要看得见批了什么。
      restored = pendingStateOf(session)
      restoredSessionId = restored === null ? null : session.meta.id
      if (filePath !== undefined && restored !== null) ctx.emit('dsc/plan', restored)
      touch()
    })

    ctx.on('dsc/exit', () => {
      for (const card of [...pendings.values()]) card.finish('rejected', true)
      pendings.clear()
      // 僵尸卡也一起收：宿主退出后没人能答它，内存里留着没有意义
      // （状态条目里的 pending 由下次恢复时的 answerPlan / 新计划作废收尾）。
      restored = null
      restoredSessionId = null
    })
  },
}
