/**
 * agent 插件：provide `agent` 服务——按会话常驻的 ReAct 循环注册表（0.6.48 对齐 dsh）。
 *
 * 0.6.47 之前全局只有一个 MiniAgent，切会话 = 换掉它底下的会话并 abort 当前轮
 * （中止收尾的工具结果还会误写进新会话的日志）。0.6.48 起改为**每个会话一个常驻
 * agent**：切换只换「当前查看」指向，正在跑的轮次留在后台继续跑完（dsh 的
 * AgentRegistry + UI 订阅语义）；完全闲下来又不是当前查看的 agent 就地收摊，
 * 释放写租约与内存——资源占用与旧模型相当，只是运行中的多留一份。
 *
 * 事件路由是这套模型的另一半：只有当前查看 agent 的事件进转录（后台 agent 的
 * delta/工具卡留在各自会话的 jsonl 里，切回去时按日志重放）；回合起止则以
 * dsc/turn-start / dsc/turn-end（带会话归属）与 dsc/agent-status（跨会话状态点）
 * 广播，消费方按 sessionId 自己认领。
 *
 * 另外干两件实事：把用量落一条到 `~/.dsc/usage/usage.jsonl`（设置「用量统计」的数据源，
 * 按发起回合的会话记账），以及把「一轮干净结束」广播成 `dsc/turn-end`。
 *
 * @module dsc/plugins/agent
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { CONTEXT_INJECTION_KINDS, contextInjectionPreview, type ContextInjectionView } from '@pneuma/runtime/contract.js'
import { appendRepeatReminder, planRepeatReminder } from '@pneuma/runtime/core/repeat-reminder.js'
import { InjectionNoteLedger } from '@pneuma/runtime/core/context-injection-report.js'
import { Session, type InboxOrigin } from '@pneuma/runtime/core/session.js'
import type { UserFileAttachment } from '@pneuma/runtime/core/attachments.js'
import { MiniAgent } from '@pneuma/session-core/loop.js'
import { appendToolRecord, appendUsageRecord } from '@pneuma/runtime/core/usage-log.js'
import { publishDshUsage } from '@pneuma/runtime/core/dsh-compat/llm-usage-event.js'
import { createDshSessionEventBridge } from '@pneuma/runtime/core/dsh-compat/session-events.js'
import { clearReadLedger } from '@pneuma/runtime/core/path-policy.js'
import { errText } from '@pneuma/runtime/adapter/transcript.js'
import type { AgentService, TurnSignal } from '@pneuma/runtime/services/types.js'

/**
 * 切走之后最多留几个空闲会话（见 {@link rememberIdle}）。
 * 3 够覆盖「在最近三条之间来回跳」，再多只是白占内存。
 */
const IDLE_KEEP = 3

export const agentPlugin: Plugin.Object = {
  name: 'agent',
  inject: ['session', 'transcript', 'tools', 'llm', 'compact', 'prompt', 'guards'],
  provide: 'agent',
  apply(ctx) {
    /** 常驻注册表：会话 id（meta.id）→ agent。含当前查看的那个。 */
    const agents = new Map<string, MiniAgent>()
    /** 切走但还留着的空闲会话（按「最近切走的」排在后面），上限见 {@link IDLE_KEEP}。 */
    const idleOrder: string[] = []
    /** 收摊 agent 的墓碑：id → jsonl 路径。非常驻投递（followup 带 id）靠它找文件。 */
    const tombstones = new Map<string, string>()
    /** 当前查看的 agent。不变量：它的会话就是 ctx.session.current() 那个对象。 */
    let active: MiniAgent | null = null

    const turnSignal = (session: Session): TurnSignal => ({
      sessionId: session.meta.id,
      sessionPath: session.filePath,
    })

    const makeAgent = (session: Session): MiniAgent => {
      /** 工具名按 callId 记着：`tool/result` 事件只带 callId，工具行要写工具名。 */
      const toolNames = new Map<string, string>()
      /**
       * 上一次重写里投影报上来的上下文注入（循环取走后清空）。
       *
       * 每次重写换一只新数组：invariant 校验会拿同一份输入再跑一遍投影链，那一遍报的
       * 东西不该混进这一轮，也不该留到下一轮去。
       */
      let lastInjections: ContextInjectionView[] = []
      // dsh 插件的广播面：一个会话一座桥，把回合过程按 dsh 的 session/event 形状播出去
      // （为什么要有它、以及哪些不发，见 core/dsh-compat/session-events 的头注释）。
      const dshEvents = createDshSessionEventBridge({
        ctx,
        sessionId: session.meta.id,
        cwd: session.meta.cwd,
        createdAt: session.meta.createdAt,
        route: () => ({ provider: ctx.llm.providerOf(session), model: ctx.llm.modelOf(session) }),
      })
      return new MiniAgent(
        {
          // 这个 agent 自己的模型/档位（后台会话不拿「用户正在看」的那一份）
          route: () => ctx.llm.routeForSession(session),
          // 系统提示每次请求重拼：切模式、改 AGENTS.md、换模型都不用重启。
          // 拼好的正文由循环在发请求那一刻落进自己会话的 system-prompt 状态条目
          //（hash 去重），这里只负责拼——正文与段清单同一次拼出（见 AgentDeps.systemPrompt）。
          systemPrompt: () =>
            // 带上「这个 agent 的会话」：模式那段话与段的取舍都按它算。不带的话，
            // 后台会话的提示词会跟着「你此刻点开的会话」变（0.6.48 多 agent 的坑）。
            ctx.prompt.systemPromptParts(session.meta.cwd, {
              sessionId: session.meta.id,
              cwd: session.meta.cwd,
            }),
          // 模型面前那份目录走 visible()：模式（预设）在这里做减法，极简档因此只看到 bash。
          // 队友不走这条路——它们按自己的工牌从全量注册表里挑（见 plugins/subagent.ts）。
          // 同样带会话：模式白名单按**这个 agent 的**档算（见 plugins/presets.ts 的 bySession）
          tools: () => ctx.tools.visible({ sessionId: session.meta.id }),
          guards: ctx.guards,
          emit: (event) => {
            // 先把这条内核事件翻译成 dsh 的 session/event 广播出去（旁路，内部吞错）：
            // 订阅它的插件才能看见「正在跑的这一轮」，而不是只有磁盘上的历史。
            dshEvents.publish(event)
            // 用量按发起回合的会话记账落一条到 ~/.dsc/usage/usage.jsonl；落盘失败
            // 已被 appendUsageRecord 自己吞掉，不能影响对话轮次。这一步的墙钟读数
            // （lm/ft/d）同一条出账：界面按整个会话累计算输出速度与首字延迟。
            if (event.type === 'usage') {
              appendUsageRecord({
                provider: ctx.llm.providerOf(session),
                model: ctx.llm.modelOf(session),
                i: event.inputTokens,
                o: event.outputTokens,
                ...(event.cacheHitTokens === undefined ? {} : { ch: event.cacheHitTokens }),
                ...(event.cacheMissTokens === undefined ? {} : { cm: event.cacheMissTokens }),
                sid: session.meta.id,
                ...(event.llmMs === undefined ? {} : { lm: event.llmMs }),
                ...(event.ttftMs === undefined ? {} : { ft: event.ttftMs }),
                ...(event.decodeMs === undefined ? {} : { d: event.decodeMs }),
              })
              // dsh 的计费插件（cost-meter 这类）不听用量日志，而是在 `llm/stream`
              // 这个 waterfall 事件上包一层流读 usage chunk。这里把同一次调用的用量
              // 作为旁路事件发出去——发不发得出去都不影响回合（内部吞错）。
              void publishDshUsage(ctx, {
                sessionId: session.meta.id,
                provider: ctx.llm.providerOf(session),
                model: ctx.llm.modelOf(session),
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                ...(event.cacheHitTokens === undefined ? {} : { cacheHitTokens: event.cacheHitTokens }),
                ...(event.cacheMissTokens === undefined ? {} : { cacheMissTokens: event.cacheMissTokens }),
              })
            }
            // 工具调用也记一条（第二种行）：界面读同一个文件算「工具耗时」。
            // 没带 ms 的（打断时补的合成结果）不记——没有起点就没有耗时。
            if (event.type === 'tool/call') toolNames.set(event.callId, event.name)
            if (event.type === 'tool/result' && event.ms !== undefined) {
              appendToolRecord({ sid: session.meta.id, n: toolNames.get(event.callId) ?? '', ms: event.ms })
              toolNames.delete(event.callId)
            }
            // 回合起止广播出去（带会话归属）：目标续跑、压缩守卫、生命周期钩子这些
            // 「接着往下推/守着门」的行为自己听，按 sessionId 认领；循环不认识目标。
            if (event.type === 'turn/start') {
              ctx.emit('dsc/turn-start', turnSignal(session))
              ctx.emit('dsc/agent-status', { sessionId: session.meta.id, path: session.filePath, state: 'working' })
            }
            if (event.type === 'turn/end') {
              ctx.emit('dsc/turn-end', event.reason, turnSignal(session))
              ctx.emit('dsc/agent-status', { sessionId: session.meta.id, path: session.filePath, state: 'idle' })
            }
            // 只有当前查看 agent 的事件进转录：后台 agent 的流式增量与工具卡留在
            // 各自会话的 jsonl 里，切回去时由转录插件按日志重放。这正是「切走不打断」
            // 的显示面——旧模型里中止轮的残留事件污染新会话视图，这里从源头掐掉。
            // 归属也交给转录层兜一道（0.6.68）：这里判一次「当前是不是我」，转录层再按
            // 会话 id 判一次——两道都过才写，防的是以后有人绕过这道 if 直接写卡片。
            if (active !== null && active.sessionId === session.meta.id) {
              ctx.transcript.emit(event, session.meta.id)
            }
          },
          // 不阻断的运行时提醒（当前：请求 invariant 失配）。接成 dsc/notice，
          // 由 transcript 折成一条 system 条目；不打断请求，只让用户知道有这回事。
          // 带上会话归属：后台会话的提醒不该写进用户正在看的那个视图（0.6.68）。
          notice: (text) => ctx.emit('dsc/notice', text, undefined, session.filePath),
          // 压缩的取消信号跟着回合走（T41）：用户打断时压到一半的模型调用跟着停；
          // 压缩目标永远是这个 agent 自己的会话（0.6.48 起显式传入）。
          beforeRequest: (signal) => ctx.compact.check(signal, session),
          // 请求因爆窗失败时压一次再重试（对齐 dsh 的溢出重试；压不出空间就把原错误抛回去）
          onContextOverflow: (signal) => ctx.compact.forceCompact(signal, session),
          rewrite: (messages) => {
            // 投影往请求里加了什么（环境快照 / 模式 / 沙箱 / 待办提醒），由投影自己报给
            // 这只录音机；循环随后取走，落一条「上下文注入」卡。每次重写换一只新的：
            // invariant 的二次派生不会把报告混进这一轮。
            const collected: ContextInjectionView[] = []
            const out = ctx.prompt.rewrite(messages, session, (view) => collected.push(view))
            lastInjections = collected
            return out
          },
          // 循环在请求发出前取走这一轮的注入清单（取走即清空，见 loop 的 takeContextInjections）
          takeContextInjections: () => {
            const taken = lastInjections
            lastInjections = []
            return taken
          },
          // 发请求走 llm 服务的适配器表：端点声明什么协议就由谁的适配器去说
          stream: (api, request, handlers) => ctx.llm.stream(api, request, handlers),
          // 完全闲下来又不是当前查看的：就地收摊（释放写租约与内存）。正被查看的
          // 留着——用户下一句话还得靠它。
          //
          // 收摊统一走 disposeAgent（2026-11-03）：它同时清「空闲保留」名册（idleOrder），
          // 这里要是自己删一遍，名册里就会留下已经收摊的 id。
          onIdle: () => {
            if (active !== null && active.sessionId === session.meta.id) return
            const agent = agents.get(session.meta.id)
            if (agent === undefined) return
            disposeAgent(agent)
          },
        },
        session,
      )
    }

    // ── 重复调用提醒（投影，order 850）───────────────────────────────────────
    // 回合环没有步数上限（`packages/session-core/loop.ts:362`），模型若一直要求调工具，
    // 这一轮会无限跑下去。加步数上限会斩断正常的长活，所以这里只补一句**建议性**的提醒：
    // 历史尾部连着用同一份规范化参数调同一个工具、且次数正好命中某一档（默认第 3/5/8 次）
    // 时，往这一轮请求末尾追加一条 user 消息。不否决、不改写任何调用，工具照常执行。
    //
    // 为什么数**会话历史**而不是这一份 `messages`：env-facts(600) 与 todo-reminder(800)
    // 已经往尾巴上补过 user 消息，拿组装好的那份数会把它们当成「用户又说话了」，计数每次
    // 都被清零、永远到不了阈值。判定只读日志侧（`session.messages`），注入只落在请求侧，
    // 这也正好是「模型可见 ⟺ 日志可复算」的形状：重放日志 + 同一条投影链 = 同一份请求。
    //
    // order 850：排在 todo-reminder(800) 之后、drop-images(900) 之前——提醒是这一轮最后
    // 追加的话，图该剥的照样在它之后剥，两个投影互不干扰。
    /**
     * 已为哪一份历史落过提醒 note：判据是「会话 id + 历史最后一条消息的对象引用 + 提醒正文」，
     * 实现与待办提醒共用 `core/context-injection-report.ts` 的 {@link InjectionNoteLedger}。
     *
     * 一次请求组装完，循环会拿同一份日志再跑一遍投影链做校验（`loop.ts:452` 的
     * checkRequestInvariant）。那一遍算出来的提醒与真发出去的一字不差，但并没有发给模型；
     * 不挡的话每注入一次会多记一条重复 note。判据用「最后一条消息」而不是历史条数：
     * 两次真请求之间一定落过新的 assistant / tool 消息，对象引用不同；同一份历史重跑时
     * 最后一条还是同一个对象。表满整表清（与 `packages/prompt` 的 envSent 同一套）。
     */
    const reminderNotes = new InjectionNoteLedger()
    const offRepeatReminder = ctx.prompt.registerProjection(
      'repeat-reminder',
      (messages, session, report) => {
        // 拿不到会话（老调用方）时不猜：组装好的那份里带着注入，数出来的次数不可信，
        // 这一跳就不提醒（宁可不提醒，也不要按错的次数报）。
        if (session === undefined) return messages
        const plan = planRepeatReminder(session.messages)
        const out = appendRepeatReminder(messages, plan)
        // 真补了才报（appendRepeatReminder 没补时原样返回同一个数组）：注入卡只该在
        // 「这一跳真的多了一句提醒」时出现，不是每跳都长一张。
        if (out !== messages) {
          // 提醒是投影现算的、日志上没有这一句（`session-core/loop.ts:77` 的规矩）：
          // 注入方自己落一条 note，事后回看日志能逐字对出模型当时多看了什么。写法照
          // `packages/lsp/index.ts:219` / `packages/hooks/index.ts:552`——正文就是注入原文。
          // 同一份历史的二次派生（invariant 校验）不重复落，判据见上面 reminderNotes。
          const last = session.messages[session.messages.length - 1]
          if (reminderNotes.take(session.meta.id, last, plan.text)) session.appendNote('repeat-reminder', plan.text)
          report?.({
            kind: CONTEXT_INJECTION_KINDS.repeatReminder,
            source: 'repeat-reminder',
            where: 'user-tail',
            chars: plan.text.length,
            preview: contextInjectionPreview(plan.text),
          })
        }
        return out
      },
      { order: 850 },
    )
    ctx.effect(() => offRepeatReminder, 'agent: prompt.registerProjection')

    const disposeAgent = (agent: MiniAgent): void => {
      agents.delete(agent.sessionId)
      const idleAt = idleOrder.indexOf(agent.sessionId)
      if (idleAt >= 0) idleOrder.splice(idleAt, 1)
      tombstones.set(agent.sessionId, agent.session.filePath)
      // 「先读过才许改」的台账跟着会话走，收摊时一起清，防长窗口无界增长
      clearReadLedger(agent.sessionId)
      agent.dispose()
    }

    /**
     * 切走之后**先不收摊**，把空闲 agent 留下几个（0.6.48 常驻多 agent 的延伸，2026-11-03）。
     *
     * 为什么：切会话的耗时里最大的一块是重新把整份 jsonl 读回来解析（实测 6.8MB 的会话
     * 45–65ms，同步跑在宿主主线程上）。而人在几条会话之间来回跳是常态——刚切走又切回来，
     * 那时磁盘上的文件一个字都没变，重读纯属白烧。留下最近几个，切回去直接命中
     * `sessionFor`（`plugins/session.ts` 的 open 里那条短路），一次读盘都不用。
     *
     * 为什么是 3：配合 `IDLE_KEEP` 的数量，内存里最多三份已解析的历史（每份几 MB），
     * 换来「来回跳」全部零加载；再多就只是白占内存。
     *
     * 与「常驻」不冲突：这里留下的都是**空闲**的（跑着的走上面 busy 那条分支，本来就不收摊），
     * 也就是说不会有一轮在跑、却因为被人切走而被打断或错位。
     */
    const rememberIdle = (sessionId: string): void => {
      const at = idleOrder.indexOf(sessionId)
      if (at >= 0) idleOrder.splice(at, 1)
      idleOrder.push(sessionId)
      while (idleOrder.length > IDLE_KEEP) {
        const oldest = idleOrder.shift()
        const agent = oldest === undefined ? undefined : agents.get(oldest)
        if (agent !== undefined) disposeAgent(agent)
      }
    }

    // ---- 初始 agent：内核启动恢复/新建的那个会话 ----
    active = makeAgent(ctx.session.current())
    agents.set(active.sessionId, active)

    ctx.on('dsc/session-open', ({ session }) => {
      const prev = active
      let next = agents.get(session.meta.id)
      if (next === undefined) {
        next = makeAgent(session)
        agents.set(session.meta.id, next)
      } else {
        // 又切回来了一条还留着的会话：把它从「空闲待收摊」里摘出来（它就是现在这条）。
        const idleAt = idleOrder.indexOf(session.meta.id)
        if (idleAt >= 0) idleOrder.splice(idleAt, 1)
      }
      active = next
      if (prev !== null && prev !== next) {
        if (prev.busy) {
          // 被切走且还有活的（回合在跑/排了下一轮）：留在后台继续——这正是 0.6.48
          // 的语义（旧模型在这里 abort）。重发一次状态：它被查看期间转录层清了
          // 状态点，回后台后侧栏的点要重新亮起来，收工才能翻成「已完成未读」。
          // 挂着审批卡的发 awaiting-approval（0.6.50）：以前一律发 working，会把
          // 「等你批准」盖成「还在跑」，侧栏两个状态点就此错位。
          const waitingApproval = ctx.get('approval')?.pendingFor(prev.session.filePath) === true
          ctx.emit('dsc/agent-status', {
            sessionId: prev.sessionId,
            path: prev.session.filePath,
            state: waitingApproval ? 'awaiting-approval' : 'working',
          })
        } else {
          rememberIdle(prev.sessionId)
        }
      }
    })

    ctx.on('dsc/exit', () => {
      for (const agent of [...agents.values()]) agent.dispose()
      agents.clear()
    })

    /**
     * 把一条输入写进没有常驻 agent 的休眠会话（等用户回去自己看到，不起回合）。
     *
     * `origin` 必须透传（2026-11-06 复审）：机器投递（后台作业完成、定时补投、目标续跑）
     * 丢了它，落进 jsonl 就成了一条普通用户消息；审批判官按 `origin === 'notice'` 区分
     * 「能不能授权」，丢一次就等于把系统通知升级成用户授权。
     */
    const deliverToDormant = (sessionId: string, text: string, images?: string[], files?: UserFileAttachment[], origin: InboxOrigin = 'user'): void => {
      const path = tombstones.get(sessionId)
      if (path === undefined) {
        ctx.emit('dsc/notice', `一条通知没能投递：会话 ${sessionId.slice(0, 8)} 不在本窗口的名册里`)
        return
      }
      try {
        const dormant = Session.load(path, true)
        dormant.appendUser(text, images, files, origin)
        dormant.close()
      } catch (error) {
        ctx.emit('dsc/notice', `一条通知没能写进会话 ${sessionId.slice(0, 8)}：${errText(error)}`)
      }
    }

    const service: AgentService = {
      followup(text: string, images?: string[], sessionId?: string, origin?: InboxOrigin, files?: UserFileAttachment[]) {
        if (sessionId === undefined) {
          if (active !== null) active.followup(text, images, origin, files)
          return
        }
        const agent = agents.get(sessionId)
        if (agent !== undefined) {
          agent.followup(text, images, origin, files)
          return
        }
        deliverToDormant(sessionId, text, images, files, origin)
      },
      interrupt(filePath?: string) {
        if (filePath === undefined) {
          if (active !== null) active.cancel()
          return
        }
        // 后台可停（0.6.49）：侧栏行右键按路径停任意在跑的会话；找常驻 agent——
        // 收摊了的会话没有在跑的回合，天然是空操作。
        for (const agent of agents.values()) {
          if (agent.session.filePath === filePath) agent.cancel()
        }
      },
      hasAgent(sessionId: string) {
        return agents.has(sessionId)
      },
      // 排队输入的三个动作（0.6.67）：只作用于**当前查看**的那个 agent——队列条画在
      // 输入框下方，编辑 / 删除 / 插话的都是眼前这一队；后台会话的排队输入留在它自己的
      // 收件箱里，切回去时随快照一起出现。入箱与编辑删除都会发 `inbox` 事件，
      // 转录层收到即刷新快照，这里不必再补一次 touch。
      editQueued(index: number, text: string) {
        return active?.editQueued(index, text) ?? false
      },
      removeQueued(index: number) {
        return active?.removeQueued(index) ?? false
      },
      steerQueued(index?: number) {
        return active?.steerQueued(index) ?? false
      },
      sessionById(sessionId: string) {
        return agents.get(sessionId)?.session
      },
      sessionFor(filePath: string) {
        for (const agent of agents.values()) {
          if (agent.session.filePath === filePath) return agent.session
        }
        return undefined
      },
      isRunning(filePath: string) {
        for (const agent of agents.values()) {
          if (agent.session.filePath === filePath) return agent.isRunning
        }
        return false
      },
      async stop(filePath: string) {
        const agent = [...agents.values()].find((item) => item.session.filePath === filePath)
        if (agent === undefined) return
        // 排队输入先按归档语义丢弃（对齐 dsh 的归档停机）：cancel 本身不清箱，回合
        // 收尾的 drainInbox 会把排队消息落库再排下一轮——归档前不清，取消反而唤醒新回合。
        agent.session.takeAsyncInbox()
        agent.cancel()
        // 等完全收摊（onIdle 把它移出注册表、写租约释放）再放行，归档才挪得动文件；
        // 10s 兜底强制收（正常路径 busy 归零与收摊在同一段同步代码里，等不到兜底）。
        const deadline = Date.now() + 10_000
        while (agents.get(agent.sessionId) === agent && agent.busy && Date.now() <= deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        if (agents.get(agent.sessionId) === agent) disposeAgent(agent)
      },
    }
    ctx.provide('agent', service)
  },
}
