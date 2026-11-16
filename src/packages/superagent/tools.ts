/**
 * worker 的六个工具：报状态、先回执、两条线程订阅、把不归自己的消息交回去、读自己这张工单的上下文。
 *
 * ## 为什么非有这些工具（backlog G7 + 第三批 + 第八批）
 *
 * 执行器原先只从 `turn/end` 推两种状态：正常收尾记 `ready`、出错记 `failed`
 * （`adapters/executor.ts` 的 `turnEndReport`）。可核心的 `ReportState` 有六种
 * （`core/model.ts:216`），其中 `blocked` / `progress` / `waiting` 根本没人产生。
 * 后果是 worker 在正文里问「用 A 还是 B」，那句话只会并进摘要，工单照样按 `ready` 收尾——
 * 用户看到的是「干完了」，实际在等人拍板。上游的正解是给 worker 一组工具
 * （保护仓 `src/app/tools/executor.ts:28-103`），状态与线程处置由模型显式说出来，
 * 而不是由执行器猜。
 *
 * 第八批再补 `superagent_context`：上游给执行者留了一个 `readTool`（`executor.ts:26-27`），
 * 让 worker 能读**它自己这张工单**的触发消息与线程历史。DSC 原先只把工单标题与正文塞进
 * 系统提示词，遇到含糊需求只能报 `blocked` 问人；现在它能先自己读一眼再决定要不要问。
 *
 * ## 为什么依赖是窄接口
 *
 * 工具只认识一个端口（`SuperagentWorkerCommandHost`，见 `runtime.ts`）：按会话反查 worker、
 * 交出六个动作。执行器（工作树、队列、会话那一大摊）和引擎都不在工具手里——参数校验、
 * 状态机、线程归属判定全在 `core/`，工具不复制第二份。测试塞一个假端口就能测。
 *
 * ## 为什么风险记 `read`
 *
 * 六个工具都不写文件、不跑命令、不碰工作树；它们只把一段事实交给引擎，真正的校验与副作用
 * 在 `core/`（`core/assignments.ts`、`core/tickets.ts`、`core/replies.ts`）。记成 `write`
 * 只会让无人值守的 worker 每次回执都撞审批闸，而那个闸后面没有人能点。
 *
 * @module dsc/packages/superagent/tools
 */
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import { UserError, type UserErrorCode, type WorkerReport } from './core/index.js'
import type { SuperagentWorkerCommandHost } from './runtime.js'

/** 工具能报的五种状态；`waiting` 不开放——那是执行器自己判的「回合结束没交东西」。 */
const REPORT_STATES = ['progress', 'ready', 'blocked', 'failed', 'dropped'] as const

/** {@link REPORT_STATES} 的元素类型。 */
type ReportToolState = (typeof REPORT_STATES)[number]

/** 回执正文的上限（上游 `IM_WORDS` = 100 词，中文按宽松侧折成 200 字）。 */
const ACK_MAX = 200

/** 线程处置理由的上限（与上游 `reason` 同一口径：一句话）。 */
const REASON_MAX = 300

/** 要人拍板的问题上限（上游 `human_action` 的 1000 字）。 */
const HUMAN_ACTION_MAX = 1000

/** 读上下文时一页的缺省条数（与主会话的 `superagent_read` 同一口径）。 */
const CONTEXT_DEFAULT_LIMIT = 20

/**
 * 读上下文时一页最多几条。
 *
 * 为什么工具这层也拦：上限是「一次能塞进模型上下文多少」的一部分。交给运行期截断的话，
 * 模型会以为传 500 也真拿到 500 条，下一次照传不误。
 */
const CONTEXT_MAX_LIMIT = 50

/** 三种 resource 的说明，参数校验与报错文案共用一份。 */
const CONTEXT_RESOURCES = 'ticket / thread / input:<id>' as const

/**
 * 会话不是 worker 时六个工具的同一句话。
 *
 * 为什么用同一句：模型看到的是「这个工具不属于这条会话」，比看到 `undefined` 或一条
 * 空成功更容易纠正自己；而工具之间说法不一致时，模型会以为是工具本身坏了。
 */
const WORKER_ONLY = '这个工具只在 Super Agent 的 worker 会话里可用：当前会话不属于任何正在跑的工单'

/**
 * 六个只在 worker 会话里出现的工具名（顺序即注册顺序）。
 *
 * 为什么单列一个常量：用户会话的投影（`index.ts` 的 `tools.project`）要按它把这一组
 * 整个藏掉；漏一个，模型就会在主会话里替某张工单回执 / 交回消息，那条会话连 worker
 * 都不是，只会撞一句报错。`superagent_read` 等主会话工具不在这里。
 */
export const WORKER_ONLY_TOOL_NAMES: readonly string[] = [
  'superagent_report',
  'superagent_context',
  'superagent_ack',
  'superagent_thread_unrelated',
  'superagent_thread_follow',
  'superagent_trigger_handback',
]

/**
 * 报告工具的依赖面。
 *
 * 返回 `false` = 这条会话不是正在跑的 worker（工具据此抛错，不改任何状态）。
 * 为什么用布尔而不是抛错：执行器那边「找不到」是正常情况（用户在普通会话里调到了它），
 * 抛错该由工具这层翻译成模型看得懂的一句话。
 */
export interface ReportToolDeps {
  /**
   * 把报告交给这个会话所属的 worker。
   *
   * @param sessionId - 发起调用的会话（`ToolContext.sessionId`）
   * @param report - 状态、摘要、要人拍板的问题与两条消息 id
   * @returns true = 找到了 worker 并已上报；false = 这条会话不属于任何 worker
   */
  report(sessionId: string, report: WorkerReport): boolean
  /**
   * 认领这张报告里带的 PR（`pr_number`）：先绑线程，绑成了才写报告。
   *
   * 为什么单独一个动作而不是把整个 worker 端口递进来：报告工具只用得到「认领」这一件，
   * 端口上的回执 / 线程 / 交回对它都是越权面。测试塞一个假 claim 就能钉住「先认领后报告」
   * 的顺序（`worker-tools.test.mjs`）。
   *
   * @returns 拒绝原因（一句中文，说清为什么不行、该传什么）；成功 / 本来就绑着 → undefined
   */
  claim(sessionId: string, number: number): Promise<string | undefined>
}

/**
 * 除报告工具之外五个工具唯一的依赖（报告工具另有 {@link ReportToolDeps}，见 {@link createWorkerTools}）。
 *
 * 为什么不只是一个端口：运行期是懒建的，插件 `apply` 时它还不存在；而且工具要先知道
 * 「这条会话是不是 worker」，再决定能不能调端口——**不是 worker 会话就返回 null**。
 * 这道闸不能省：端口方法返回 `false` 另有含义（`followForContext` 的「本来就在跟」、
 * `handback` 的「没交回」），把「不是 worker」也压成 `false` 就没法区分了。
 */
export interface WorkerToolDeps {
  /**
   * 取这条会话的 worker 端口。
   *
   * @param sessionId - 发起调用的会话（`ToolContext.sessionId`）
   * @returns 运行期没起来、或者这条会话不属于任何 worker 时给 null
   */
  host(sessionId: string): SuperagentWorkerCommandHost | null
}

/** 参数里取一段文本：非字符串当空串（模型偶尔给 null 或数字）。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 字符数：按码点算，一个汉字、一个 emoji 都算 1 个。 */
function charCount(text: string): number {
  return [...text].length
}

/**
 * 取一个整数参数。
 *
 * 缺省值走 `fallback`；不是整数或越界时抛一句人话——模型看到「limit 要是 1~50 之间的整数」
 * 比看到运行期默默截成 20 条更容易纠正自己。
 */
function integerOf(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null) return fallback
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} 要是 ${String(min)}~${String(max)} 之间的整数，收到「${String(value)}」`)
  }
  return number
}

/** 取端口；拿不到就抛 {@link WORKER_ONLY}。 */
function hostOf(deps: WorkerToolDeps, sessionId: string): SuperagentWorkerCommandHost {
  const host = deps.host(sessionId)
  if (host === null) throw new Error(WORKER_ONLY)
  return host
}

/**
 * 引擎拒人时的码，翻成一句中文。
 *
 * 为什么只列这几个：`UserError` 的文案模板是英文（`core/errors.ts`），worker 的模型看到
 * 「This is the thread the ticket started on…」还得自己猜；这五个工具真会撞到的就这些，
 * 别的原样带回原文，免得翻译表比真话还长、还容易过时。码留在括号里，查日志时对得上。
 */
const REFUSALS: Partial<Record<UserErrorCode, string>> = {
  unknownTicket: '没有这张工单',
  unknownTrigger: '没有这条消息',
  ticketEnded: '这张工单已经结束',
  ticketStopped: '这张工单已经被人停过',
  sourceThread: '这是这张工单的源线程，不能掉',
  followedThread: '这是这张工单自己的线程（比如它的 PR），不能掉',
  notFollowing: '这张工单本来就没跟这条线程',
  notReached: '这条消息不属于这张工单',
  handedBack: '这张工单已经交回过这条消息了',
  ackEnded: '工单已经结束，不要再补回执',
  ackNoChannel: '这条消息没有能发回执的渠道',
  ackNotPerson: '回执只能回给人的原始消息，不能回给机器人 / CI / 执行者报告',
}

/** 一条异常的人话：`UserError` 照 {@link REFUSALS} 说，其余按「没做」如实带回。 */
function refusalOf(error: unknown): string {
  if (error instanceof UserError) {
    const translated = REFUSALS[error.code]
    return translated === undefined ? `引擎拒绝：${error.message}` : `${translated}（${error.code}）`
  }
  return `没做：${error instanceof Error ? error.message : String(error)}`
}

/**
 * 线程键的形状检查：`<source>:<id>`，第一个冒号前是来源、后面是非空 id。
 *
 * 为什么工具这层也要查一遍：运行期在切 `{ source, id }` 时对形状不对的只能返回 `false`，
 * 而 `false` 在「跟线程」这个动作里表示「本来就在跟」——直接翻译过去就是一句假话。
 * 在调端口之前拦掉，模型才知道该改成 `github:123` 这种写法。
 */
function threadShapeOk(thread: string): boolean {
  const at = thread.indexOf(':')
  return at > 0 && at < thread.length - 1
}

/**
 * 报告落定后回给模型的一句话：说清「接下来该干别的还是停下」。
 *
 * `question` 三种状态各有说法：字符串 = 提了问题、`null` = 清掉了原问题、
 * `undefined` = 报告没带这一项（原问题保留）。
 */
function confirmationOf(state: ReportToolState, question: string | null | undefined): string {
  const asked = typeof question === 'string' && question !== '' ? `（问题：${question}）` : ''
  switch (state) {
    case 'blocked':
      if (question === null) return '已报 blocked，并清掉了原来那个待回答的问题：工单会停下来等人接手，这一回合到此为止。'
      return `已报 blocked${asked}：工单会停下来等人回答，这一回合到此为止，不要再继续动手。`
    case 'ready':
      return '已报 ready：工单按交付收尾。'
    case 'progress':
      return `已报 progress${asked}：人能看到中途进展，但它不算交付，干完还要报 ready。`
    case 'failed':
      return '已报 failed：工单会停在「等人处理」。'
    case 'dropped':
      return '已报 dropped：工单不再继续。'
  }
}

/**
 * 造 `superagent_report` 工具。
 *
 * 参数从三个扩到五个（第三批对齐上游）：`question` 改名 `human_action`，并补上
 * `question_for_trigger_id` 与 `reply_to_trigger_id`——问题问在哪个人写的地方、这份报告
 * 回答的是哪条人的提问，都由这两条消息 id 决定（`core/assignments.ts:16-19` 的
 * `askedBy` / `answers`）。P4 再补 `pr_number`：带了就先把 PR 认领给工单，再写报告
 * （上游 `app/tools/executor.ts:82` 的同一个参数）。
 *
 * @param deps - 上报出口（生产环境接到运行期 / 执行器）
 */
export function createReportTool(deps: ReportToolDeps): ToolEntry {
  return {
    name: 'superagent_report',
    description:
      '给 Super Agent 的工单报状态：progress（有值得知道的进展）/ ready（这一回合干完、要交付）/ '
      + 'blocked（要人拍板才能继续）/ failed（确定做不下去）/ dropped（这件事不该由这张工单做）。'
      + '只在 Super Agent 的 worker 会话里可用，主会话没有这个工具。'
      + '需要人回答时用 blocked，把要问的原话写进 human_action，然后停下等回复；'
      + '干完要交付时用 ready。只在真有必要时调，不必每轮都报，也别拿 progress 代替 ready。'
      + '开了 PR 就把 pr_number 一起报上来：工单会认领它，之后它的合并 / 关闭会收掉工单。',
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: [...REPORT_STATES],
          description: 'progress / ready / blocked / failed / dropped；要给工单定终态就用后四个里的一个。',
        },
        summary: {
          type: 'string',
          description: '一句话说清现在的状态：progress 说做到了哪一步，ready 说交付了什么，blocked 说卡在哪。',
        },
        human_action: {
          type: 'string',
          description: '要人拍板的具体问题（最多 1000 字），state=progress 时也可以带；'
            + '不传 = 保留原来那个待回答的问题，传空串 = 清掉它。',
        },
        question_for_trigger_id: {
          type: 'string',
          description: '配合 human_action：提出这个问题的原始人的消息 id，决定这句话问在哪儿。',
        },
        reply_to_trigger_id: {
          type: 'string',
          description: '这份报告回答的是哪条人的提问（那条原始消息 id）；普通进展不要带。',
        },
        pr_number: {
          type: 'integer',
          minimum: 1,
          description: '这张工单的 PR 号：来源那条 PR，或者机器人自己开的、分支名对应这张单的 PR。没有 PR 就别传。',
        },
      },
      required: ['state', 'summary'],
    },
    // 见文件头：它不写文件、不跑命令，状态变更由引擎做。
    risk: 'read',
    async run(args, ctx) {
      const raw = String(args.state ?? '').trim() as ReportToolState
      if (!(REPORT_STATES as readonly string[]).includes(raw)) {
        throw new Error(`state 只能是 ${REPORT_STATES.join(' / ')}，收到「${String(args.state ?? '')}」`)
      }
      const state = raw
      const summary = String(args.summary ?? '').trim()
      if (summary === '') throw new Error('summary 不能为空：一句话说清现在是什么状态')

      // 第三批把参数从 `question` 改名成 `human_action`（对齐上游）。不认旧名：参数表里
      // 没有的键，模型本来也不该给；留一条隐式别名只会让同一个意思有两种写法。
      const rawReason = args.human_action
      let question: string | null | undefined
      if (rawReason === null) {
        question = null
      } else if (typeof rawReason === 'string') {
        const trimmed = rawReason.trim()
        if (trimmed === '') {
          // 空串 = 清掉：引擎里 `null` 才是「清空」，`undefined` 是「保留原来的」。
          question = null
        } else {
          const count = charCount(trimmed)
          if (count > HUMAN_ACTION_MAX) {
            throw new Error(`human_action 最多 ${String(HUMAN_ACTION_MAX)} 字，收到 ${String(count)} 字：把要拍板的那一点问准就行`)
          }
          question = trimmed
        }
      }
      // ready 不能带问题：核心的 `questionWithResult`（`core/assignments.ts:102`）会拒掉整份报告。
      // 这里先拦一句，否则报告写不进去时工具只能回一句「不在 worker 会话里」，误导模型。
      if (state === 'ready' && typeof question === 'string') {
        throw new Error('state=ready 不能带 human_action：有问题先报 blocked，等人拍板再报 ready')
      }

      const report: WorkerReport = { state, summary }
      // 只有显式给了才带这一项：不传 = 保留原来的问题，传 null = 清掉。
      if (question !== undefined) report.question = question
      const askedBy = textOf(args.question_for_trigger_id).trim()
      if (askedBy !== '') report.askedBy = askedBy
      const answers = textOf(args.reply_to_trigger_id).trim()
      if (answers !== '') report.answers = answers

      // PR 认领（对齐上游 `orchestrator_report`：`app/tools/executor.ts:88-92`）。顺序必须是
      // **先认领、后写报告**：认领被拒说明那张 PR 不属于这张单，报告也就不该把状态写进工单，
      // 否则模型会以为「PR 已经挂上、状态也报好了」。认领成功或本来就绑着（undefined）才继续。
      const prNumber = args.pr_number
      if (prNumber !== undefined && prNumber !== null) {
        if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber < 1) {
          throw new Error(`pr_number 要是 PR 号（正整数），收到「${String(prNumber)}」`)
        }
        const refused = await deps.claim(ctx.sessionId, prNumber)
        if (refused !== undefined) throw new Error(refused)
      }

      if (!deps.report(ctx.sessionId, report)) throw new Error(WORKER_ONLY)
      return confirmationOf(state, question)
    },
  }
}

/**
 * 造 `superagent_ack`。
 *
 * 上游一句话（`executor.ts:26-40`）：动大手术之前，先回执人的原始请求；回执发到那条消息
 * 所在的渠道。DSC 的引擎方法就是 `reply({ purpose: 'acknowledgement', … })`
 * （`core/replies.ts:48-62`），运行期负责入队后催一拍泵。
 */
function ackTool(deps: WorkerToolDeps): ToolEntry {
  return {
    name: 'superagent_ack',
    description:
      '在动大手术之前，先给人一句回执：比如要改十几个文件、要跑很久的测试、要换一个方案。'
      + '它作为回复发到人原来那条消息所在的会话，不是工单内部的状态；'
      + '所以别拿它代替 superagent_report，状态照样要报。'
      + 'trigger_id 是那条人的原始消息 id，text 是回执正文（非空、最多 200 字，一两句话）。'
      + '只在 Super Agent 的 worker 会话里可用。',
    parameters: {
      type: 'object',
      properties: {
        trigger_id: { type: 'string', description: '要回执的那条人的原始消息 id（工单输入里的 trigger id）。' },
        text: { type: 'string', description: `回执正文：说清要做什么、预期什么，最多 ${String(ACK_MAX)} 字。` },
      },
      required: ['trigger_id', 'text'],
    },
    risk: 'read',
    async run(args, ctx) {
      const host = hostOf(deps, ctx.sessionId)
      const triggerId = textOf(args.trigger_id).trim()
      if (triggerId === '') throw new Error('trigger_id 不能为空：写那条人的原始消息 id')
      const text = textOf(args.text).trim()
      if (text === '') throw new Error('text 不能为空：回执要写清要做什么、预期什么')
      const count = charCount(text)
      if (count > ACK_MAX) throw new Error(`text 最多 ${String(ACK_MAX)} 字，收到 ${String(count)} 字：回执一两句就够`)
      let acked: boolean
      try {
        acked = host.ack(ctx.sessionId, triggerId, text)
      } catch (error) {
        throw new Error(`${refusalOf(error)}：trigger_id=${triggerId}`)
      }
      if (!acked) throw new Error(WORKER_ONLY)
      // 回执是一条已经排上队的出站消息，面板可能显示「正在回执」以外的状态；推一次快照让人看见。
      host.changed()
      return '已回执给人'
    },
  }
}

/**
 * 造 `superagent_thread_unrelated`。
 *
 * 上游一句话（`executor.ts:41-49`）：掉掉一条挂在工单上、但跟工单无关的线程；工单自己的线程
 * 不能掉。这条限制在引擎里（`core/errors.ts` 的 `sourceThread` / `followedThread`），
 * 工具不复制「哪些线程算自己的」那套判定。
 */
function threadUnrelatedTool(deps: WorkerToolDeps): ToolEntry {
  return {
    name: 'superagent_thread_unrelated',
    description:
      '掉掉一条挂在工单上、但跟这张工单无关的线程订阅：它之后的消息不再作为上下文送进来。'
      + '工单自己开在的线程（它自己的 PR、它来源的那个话题）掉不掉，引擎会拒。'
      + 'thread 是线程键，形如 github:123 或 feishu:<chat>:<root>；reason 一句话说清为什么无关（最多 300 字）。'
      + '只在 Super Agent 的 worker 会话里可用。',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: '线程键，例如 github:123、feishu:<chat>:<root>。' },
        reason: { type: 'string', description: `一句话说清它为什么与工单无关，最多 ${String(REASON_MAX)} 字。` },
      },
      required: ['thread', 'reason'],
    },
    risk: 'read',
    async run(args, ctx) {
      const host = hostOf(deps, ctx.sessionId)
      const thread = textOf(args.thread).trim()
      if (thread === '') throw new Error('thread 不能为空：写成 github:123 或 feishu:<chat>:<root> 这样')
      if (!threadShapeOk(thread)) throw new Error('thread 要是 <source>:<id>，比如 github:123 或 feishu:<chat>:<root>')
      const reason = textOf(args.reason).trim()
      if (reason === '') throw new Error('reason 不能为空：一句话说清这条线程为什么与工单无关')
      const count = charCount(reason)
      if (count > REASON_MAX) throw new Error(`reason 最多 ${String(REASON_MAX)} 字，收到 ${String(count)} 字：一句话就够`)
      let removed: boolean
      try {
        removed = host.markUnrelated(ctx.sessionId, thread, reason)
      } catch (error) {
        throw new Error(`${refusalOf(error)}：thread=${thread}`)
      }
      if (!removed) throw new Error(WORKER_ONLY)
      // 线程订阅是面板可见的状态：真的掉掉了才推快照。
      host.changed()
      return '已不再跟这条线程'
    },
  }
}

/**
 * 造 `superagent_thread_follow`。
 *
 * 上游一句话（`executor.ts:50-64`）：跟一条相关线程（别的 Issue、另一个 PR），只为读上下文。
 * 已经跟着的线程再跟一次不算错——引擎返回 `false`，工具如实说「本来就在跟」。
 */
function threadFollowTool(deps: WorkerToolDeps): ToolEntry {
  return {
    name: 'superagent_thread_follow',
    description:
      '跟一条与工单相关的线程，只为读上下文（比如它引用的 Issue、另一个 PR）：'
      + '它的消息会作为上下文送进这张工单，但不会当成要干的活。'
      + 'thread 是线程键，形如 github:123 或 feishu:<chat>:<root>；reason 一句话说清为什么相关（最多 300 字）。'
      + '已经跟着的线程再跟一次会告诉你「本来就在跟」。'
      + '只在 Super Agent 的 worker 会话里可用。',
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: '线程键，例如 github:123、feishu:<chat>:<root>。' },
        reason: { type: 'string', description: `一句话说清它为什么相关，最多 ${String(REASON_MAX)} 字。` },
      },
      required: ['thread', 'reason'],
    },
    risk: 'read',
    async run(args, ctx) {
      const host = hostOf(deps, ctx.sessionId)
      const thread = textOf(args.thread).trim()
      if (thread === '') throw new Error('thread 不能为空：写成 github:123 或 feishu:<chat>:<root> 这样')
      if (!threadShapeOk(thread)) throw new Error('thread 要是 <source>:<id>，比如 github:123 或 feishu:<chat>:<root>')
      const reason = textOf(args.reason).trim()
      if (reason === '') throw new Error('reason 不能为空：一句话说清这条线程为什么相关')
      const count = charCount(reason)
      if (count > REASON_MAX) throw new Error(`reason 最多 ${String(REASON_MAX)} 字，收到 ${String(count)} 字：一句话就够`)
      let followed: boolean
      try {
        followed = host.followForContext(ctx.sessionId, thread)
      } catch (error) {
        throw new Error(`${refusalOf(error)}：thread=${thread}`)
      }
      // 这里 `false` 只有一个意思：这条线程本来就在跟（引擎的 `followForContext` 对已订阅
      // 的线程返回 false）。不是 worker 会话走不到这里——`hostOf` 已经拦掉了。
      if (!followed) return '本来就在跟这条线程：没有重复订阅'
      // 新订阅的线程会进面板的线程视图：推一次快照。
      host.changed()
      return '已跟上这条线程：只读它的上下文'
    },
  }
}

/**
 * 造 `superagent_trigger_handback`。
 *
 * 上游一句话（`executor.ts:65-73`）：一条消息要求的东西超出这张工单（或者本来属于别的工单），
 * 交回去重新判定；同一条只能交回一次。`queued = false` 不是失败——另一张工单还在决定它，
 * 或者这条消息本来就不归任何工单（比如机器人的消息）。
 */
function triggerHandbackTool(deps: WorkerToolDeps): ToolEntry {
  return {
    name: 'superagent_trigger_handback',
    description:
      '把一条要求的东西超出这张工单（或者本来属于别的工单）的消息交回去，让它重新判定归哪张工单。'
      + '同一条消息只能交回一次；另一张工单还在决定它、或者它本来就不归任何工单（比如机器人的消息）时交不回来，'
      + '工具会说清是哪种情况。'
      + 'trigger_id 是那条消息 id，reason 一句话说清它要求的东西为什么超出这张工单（最多 300 字）。'
      + '只在 Super Agent 的 worker 会话里可用。',
    parameters: {
      type: 'object',
      properties: {
        trigger_id: { type: 'string', description: '要交回的那条消息 id（工单输入里的 trigger id）。' },
        reason: { type: 'string', description: `一句话说清它要求的东西为什么超出这张工单，最多 ${String(REASON_MAX)} 字。` },
      },
      required: ['trigger_id', 'reason'],
    },
    risk: 'read',
    async run(args, ctx) {
      const host = hostOf(deps, ctx.sessionId)
      const triggerId = textOf(args.trigger_id).trim()
      if (triggerId === '') throw new Error('trigger_id 不能为空：写那条要交回的消息 id')
      const reason = textOf(args.reason).trim()
      if (reason === '') throw new Error('reason 不能为空：一句话说清它为什么超出这张工单')
      const count = charCount(reason)
      if (count > REASON_MAX) throw new Error(`reason 最多 ${String(REASON_MAX)} 字，收到 ${String(count)} 字：一句话就够`)
      let queued: boolean
      try {
        queued = host.handback(ctx.sessionId, triggerId, reason)
      } catch (error) {
        throw new Error(`${refusalOf(error)}：trigger_id=${triggerId}`)
      }
      // `false` 不是失败：另一张工单还在决定它（轮不到这张交回），或者它本来就不归任何工单
      // （比如机器人的消息，判定时就不会落到某张工单头上）。说清是哪种情况，模型才不会白重试。
      if (!queued) return '没交回：另一张工单还在决定它，或者这条消息本来就不归这张工单，不需要交回'
      // 交回会改变这张工单的输入 / 判定队列：推一次快照。
      host.changed()
      return '已交回：它会重新判定归哪张工单'
    },
  }
}

/**
 * 造 `superagent_context`（第八批）。
 *
 * 上游给执行者的 `readTool`（`executor.ts:26-27`）能读它自己工单的触发消息 / 线程历史 /
 * 图片 / 文件。DSC 只搬了「读自己这张单」这一半：没有图片与文件资源（worker 的图片在会话
 * 消息里，不是工单的输入），也没有「翻别的工单」的口子——`input:<id>` 只在这张单里找。
 *
 * 为什么参数校验留在这里、装配与分页放在运行期：仓储与线程消息表只有运行期拿得到；
 * 工具只该决定「模型问的这句话合不合法」和「结果怎么念给模型听」。
 */
function contextTool(deps: WorkerToolDeps): ToolEntry {
  return {
    name: 'superagent_context',
    description:
      '读你正在做的这张工单的上下文：触发它的那条消息、它所在线程的历史、它收到的输入原文。'
      + `resource 三选一：ticket（这张工单本身：id、标题、创建时间、要求原文，以及最近 10 条输入，`
      + '每条带来源、时间、正文摘要）；'
      + 'thread（这张工单所在线程上的消息，旧 → 新，每条给 { at, actor, text }；'
      + `limit 缺省 ${String(CONTEXT_DEFAULT_LIMIT)}、最多 ${String(CONTEXT_MAX_LIMIT)}，还有下一页时带 next_offset）；`
      + 'input:<id>（一条输入的完整原文，id 从 ticket 的输入清单里取，只能读这张工单自己的输入）。'
      + '这是读你正在做的这张工单，不是读整个系统：别拿它翻别的工单。'
      + '需求含糊、缺前因、看不出来在回哪句话时，先读上下文再决定要不要报 blocked；看完就动手。'
      + '返回 JSON 文本；只在 Super Agent 的 worker 会话里可用。',
    parameters: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: `读哪一格：${CONTEXT_RESOURCES}。` },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'thread 从第几条开始（把上一页的 next_offset 原样传回）；缺省 0。',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: CONTEXT_MAX_LIMIT,
          description: `thread 这一页最多几条，缺省 ${String(CONTEXT_DEFAULT_LIMIT)}、最多 ${String(CONTEXT_MAX_LIMIT)}。`,
        },
      },
      required: ['resource'],
    },
    // 见文件头：它只读、不写任何东西，状态变更由引擎做。
    risk: 'read',
    async run(args, ctx) {
      // 先确认这条会话属于某个 worker：拿不到端口就没有「自己的工单」可读。参数校验放到后面，
      // 免得普通会话拿到一句「resource 写错了」——那句会让模型以为换个参数就能读。
      const host = hostOf(deps, ctx.sessionId)
      const resource = textOf(args.resource).trim()
      if (resource === '') throw new Error(`resource 不能为空：只支持 ${CONTEXT_RESOURCES}`)
      const inputId = resource.startsWith('input:') ? resource.slice('input:'.length).trim() : ''
      if (resource !== 'ticket' && resource !== 'thread' && inputId === '') {
        throw new Error(`resource 只支持 ${CONTEXT_RESOURCES}，收到「${resource}」`)
      }
      const offset = integerOf(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
      const limit = integerOf(args.limit, CONTEXT_DEFAULT_LIMIT, 1, CONTEXT_MAX_LIMIT, 'limit')
      // 传规范形状给运行期：`input: x` 这种带空格的写法在这里收成 `input:x`，只在一处拼前缀。
      const view = host.context(ctx.sessionId, inputId === '' ? resource : `input:${inputId}`, offset, limit)
      // 运行期对「不是这张单的输入」与「工单读不到」都回 null：它在乎的是「能不能读」，
      // 由工具按 resource 翻成两句不同的话——模型对「这条输入不属于这张单」才有可纠正的动作。
      if (view === null) {
        throw new Error(inputId === ''
          ? '读不到这张工单的上下文：它可能已经结束或被删了'
          : '这条输入不属于这张工单：只能读你正在做的这张工单的输入')
      }
      // 与主会话的 superagent_read 同一形态：返回 JSON 文本，模型读到的是一棵能看懂的树。
      return { text: JSON.stringify(view, null, 2) }
    },
  }
}

/**
 * 造 worker 的六个工具（顺序与 {@link WORKER_ONLY_TOOL_NAMES} 一致）。
 *
 * 报告工具也在这里一起造：它的上报出口可以从同一个端口取（端口上有 `report`），
 * 这样注册处只认一个依赖面。单独导出的 {@link createReportTool} 留给只测报告映射的调用方。
 *
 * @param deps - 按会话取 worker 端口（运行期没起来时给 null）
 */
export function createWorkerTools(deps: WorkerToolDeps): ToolEntry[] {
  return [
    // 端口里本来就转给执行器的 `reportBySession`；拿不到端口就是「不是 worker 会话」。
    // 真的记进工单之后推一次快照：摘要 / 等人问题变了，界面要重画（报告工具自己拿不到
    // `changed`，所以在这层补上）。
    createReportTool({
      report: (sessionId, report) => {
        const host = deps.host(sessionId)
        if (host === null) return false
        const reported = host.report(sessionId, report)
        if (reported) host.changed()
        return reported
      },
      // `claimPull` 的拒绝原因由工具翻成一句抛错（模型据此改参数或去掉 pr_number）。
      // 拿不到端口时返回同一句 WORKER_ONLY：运行时按「不是 worker 会话」处理，抛错文案一致。
      claim: async (sessionId, number) => {
        const host = deps.host(sessionId)
        if (host === null) return WORKER_ONLY
        return host.claimPull(sessionId, number)
      },
    }),
    contextTool(deps),
    ackTool(deps),
    threadUnrelatedTool(deps),
    threadFollowTool(deps),
    triggerHandbackTool(deps),
  ]
}
