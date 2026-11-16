/**
 * 原生服务层：DSC 面板（`ui-superagent`）与插件运行期之间的唯一入口。
 *
 * ## 这个文件为什么存在
 *
 * 上游的面板是一套 HTTP 路由（`src/app/http.ts` 把 `src/app/api.ts` 的路由表接到 `Runtime`）。
 * DSC 没有那套 web 服务，面板走 `INVOKABLE_METHODS` 白名单：`packages/runtime` 把
 * `superagentPublish` 等几条转给 `ctx.get('superagent')`（`src/packages/runtime/index.ts:358-411`），
 * 契约在 `src/contract/runtime.ts:422-451` 的 `SuperagentService`。所以本文件**不搬 HTTP**，
 * 只做旧 `service.ts` + `surface.ts` 那两件事：
 *
 *   1. `surface()`：把运行期读成一份 `SuperagentSurface` 快照（界面每帧读它）；
 *   2. 八个写动作：发布、停、重试、回答、清目录、看转录、接候选、忽略候选。
 *
 * 快照的工单行来自新树的视图投影（`app/views/tickets.ts` 的 `ticketList`），动作走新树
 * 运行期的公开成员（`engine.stopTicket` / `receive` / `pump` 等）。旧 `service.ts` /
 * `surface.ts` 留在原地不动（W9-2 删旧树时一起删），本文件不 import 它们。
 *
 * ## 与上游 `app/api.ts` 的对应
 *
 * 上游那份 50 行只有**路由契约**：`TICKET_FILTERS` / `THREAD_FILTERS` 两个筛选常量、
 * `Api` 路由表、`RouteParams` / `ApiRequest` / `ApiResponse` 三个类型。DSC 的等价物是
 * 「`INVOKABLE_METHODS` 白名单 + `SuperagentService` 接口」，路由表本身没有对应物，
 * 因此这里只把两个筛选常量原样搬来（`THREAD_FILTERS` 已在 `views/threads.ts` 落地，
 * 这里转出，不另写第二份），类型面用契约里的 `SuperagentService`，不重复声明。
 *
 * ## 与旧 `service.ts` 的差异（逐条）
 *
 * 1. **候选收件箱取消**：新树没有「等人拍板的候选」这张表——候选的判定结果由主会话的
 *    `orchestrator_eval` / `orchestrator_route` 工具直接消费（`app/assessment.ts`、
 *    `app/tools/main.ts`），收件箱（backlog G1）是 DSC 旧树的机制。所以
 *    `acceptCandidate` / `ignoreCandidate` 在这里只剩一句「新架构没有这条路」的报错，
 *    快照面也不再给 `candidates` 那一格（界面按缺省不画）。
 * 2. **发布是异步的**：旧 `publish` 同步判定完再取工单 id；新树里判定由主会话的模型回合
 *    完成（`MasterAssessor` → `Sessions.prompt` → 主会话调工具）。这里发完触发器后轮询
 *    到「有工单 / 有决策」或超时，尽量沿用旧契约「返回工单 id」的语义，但判定被 ignore
 *    时按旧实现同样抛错。
 * 3. **清理不再动 git 工作树**：新执行器给每张工单一个普通目录（`ticket.execution.directory`，
 *    `executor/dsh.ts:156`），不是 git worktree。这里只删这个目录，且必须先确认它落在
 *    设置里的执行根（`executionRoot`）之下，拒绝删任何别处的路径。
 * 4. **`recent` 为空**：旧快照的「最近动态」来自旧 `adapters/notify.ts` 的内存窗口，新树
 *    没有对应窗口（通知改走 `app/notices.ts` + Effects）。快照面先给空数组，界面按
 *    「暂无」画；不伪造数据。
 * 5. **手动来源的准入**：`manual` 不是新树的 Source kind（新树只有 github / feishu 两个
 *    kind），但核心准入闸只读 `policy.sources.manual.allowed`（`core/policy.ts:181`）。
 *    DSC 的 `superagentPublish` 又要一条显式的人工触发器，所以这里在第一次发布前把
 *    `operator` 补进那份名单（旧 `adapters/settings.ts` 的 `defaultSettings` 做的是同一件事）。
 *
 * @module dsc/packages/superagent/app/api
 */
/** Native panel service for Super Agent: snapshot projection plus the RPC actions DSC's interface invokes. */
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve as resolvePath, sep } from 'node:path'
import type {
  SuperagentAnswerInput,
  SuperagentPublishInput,
  SuperagentService,
  SuperagentSourceView,
  SuperagentSurface,
  SuperagentTicketView,
  TranscriptEntry,
} from '@pneuma/runtime/contract.js'
import { Transcript } from '@pneuma/runtime/adapter/transcript.js'
import { Session } from '@pneuma/runtime/core/session.js'
import { key, latestReport, liveTicket, reasonText, threadKey, type Decision, type Thread, type Ticket, type Trigger } from '../core/index.js'
import { SettingsSchema, policyVersion, type Settings } from '../core/policy.js'
import { workerSessionId } from '../executor/dsh.js'
import { sessionsDir } from '../paths.js'
import { executionRoot } from './execution-environment.js'
import type { Runtime } from './runtime.js'
import { ticketList } from './views/tickets.js'
import type { TicketSummaryView } from './views/records.js'

/** 上游 `src/app/api.ts` 的工单筛选值，逐字搬来（本仓没有 HTTP 路由，只留契约本身）。 */
export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
/** 上游同文件的两个线程筛选值在 `views/threads.ts` 已落地（避开两处定义），这里转出给面板侧。 */
export { THREAD_FILTERS, type ThreadFilter } from './views/threads.js'

/** 一条回答最多多少字。旧 `service.ts:37` 的同一条业务上限（界面通道另有一道字节闸）。 */
export const ANSWER_MAX_CHARS = 4000

/** 手动来源的名字与占位发送者：与 `adapters/manual.ts` 的 `MANUAL_SOURCE` / `DEFAULT_ACTOR` 同值。 */
const MANUAL_SOURCE = 'manual'
const DEFAULT_ACTOR = 'operator'
/** 快照面列出的来源：顺序固定 github → feishu（旧 `index.ts` 的 `buildSourceViews` 同序）。 */
const SOURCE_IDS = ['github', 'feishu'] as const
/** 快照一页最多取多少张工单：面板不翻页，一次给全量；上限只是防病态数据。 */
const MAX_TICKET_VIEWS = 10_000
/** 发布后等主会话判定的上限：一次模型回合的宽裕值。 */
const PUBLISH_TIMEOUT_MS = 120_000
/** 等待期间的复查间隔。 */
const POLL_MS = 100

const now = (): string => new Date().toISOString()
const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)
const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * 把一条手动请求包成领域 `Trigger`。
 *
 * 与旧 `adapters/manual.ts:48-67` 同一形状（本文件不 import 旧适配器，避免新入口依赖
 * W9-2 要删的旧树）：id 掺随机量保证「同一句话两次发布」是两条触发器；`addressed: 'direct'`
 * 让准入闸给显式强度；标题进 `meta.title`，正文进 `text`。
 */
function manualTrigger(input: { title: string; body: string }, at: string): Trigger {
  const title = input.title.trim()
  if (title === '') throw new Error('manual trigger needs a non-empty title')
  const body = input.body.trim() === '' ? title : input.body.trim()
  const id = key('trigger', MANUAL_SOURCE, at, title, body, randomUUID())
  return {
    id,
    source: MANUAL_SOURCE,
    // 每条面板发布一条独立线程：两次发布不会被 Eval 的防抖合并成一张工单。
    threads: [{ source: MANUAL_SOURCE, id: `${MANUAL_SOURCE}:${id}` }],
    actor: { source: MANUAL_SOURCE, id: DEFAULT_ACTOR },
    human: true,
    addressed: 'direct',
    at,
    text: body,
    meta: { title },
  }
}

/** 把面板上的一句回答包成挂到已有线程的人工 `Trigger`（旧 `adapters/manual.ts:103-121` 同形）。 */
function answerTrigger(input: { thread: { source: string; id: string }; text: string; ticketId: string }, at: string): Trigger {
  const text = input.text.trim()
  if (text === '') throw new Error('answer trigger needs non-empty text')
  const id = key('trigger', MANUAL_SOURCE, at, threadKey(input.thread), text, randomUUID())
  return {
    id,
    source: MANUAL_SOURCE,
    threads: [input.thread],
    actor: { source: MANUAL_SOURCE, id: DEFAULT_ACTOR },
    human: true,
    addressed: 'direct',
    at,
    text,
    meta: { ticketId: input.ticketId },
  }
}

/** 一张工单的视图行 → 契约里的工单投影（只换字段名；阶段判定在视图层已经做过）。 */
function ticketViewOf(row: TicketSummaryView): SuperagentTicketView {
  const action = 'action' in row ? row.action : undefined
  const stage: SuperagentTicketView['stage'] = row.stage === 'person'
    ? { stage: 'person', action: action as 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
    : row.stage === 'working' ? { stage: 'working', ...(action === 'queued' ? { action: 'queued' as const } : {}) }
      : { stage: row.stage }
  return {
    id: row.id,
    title: row.title,
    stage,
    at: row.createdAt,
    ...(row.summary === '' ? {} : { summary: row.summary }),
    ...(row.attention?.question === undefined ? {} : { question: row.attention.question }),
  }
}

/** 两个来源的轮询状态：开关现读设置，时刻与错误来自各自的体检项（旧 `status()` 的等价读数）。 */
function sourceViews(runtime: Runtime, settings: Settings): SuperagentSourceView[] {
  return SOURCE_IDS.map(id => {
    const enabled = runtime.sources.instance(id, settings)?.enabled ?? settings.sources[id]?.enabled ?? false
    const health = runtime.health[id]
    return {
      id,
      enabled,
      ...(health?.at === undefined ? {} : { lastPollAt: health.at }),
      ...(health?.state === 'error' ? { lastError: health.detail } : {}),
    }
  })
}

/** 发布的结果：出了工单给工单，出了别的决策给决策，都没有就是超时。 */
interface PublishOutcome { ticket?: Ticket; decision?: Decision }

/**
 * 面板服务本体。
 *
 * 不继承 cordis 的 `Service`：本仓二十多个服务都是「普通对象 + `ctx.provide(name, value)`」
 * （旧 `service.ts:66-73` 同一条写法），自动注销由插件 fiber 负责。界面通道只看类型
 * （`SuperagentService`），不关心怎么注册的。
 */
export class PanelApi implements SuperagentService {
  constructor(private readonly runtime: Runtime) {}

  /**
   * 当前快照面。
   *
   * 运行期由插件入口在 `apply` 里直接构造（本批起不再懒建），所以到这里只要读库；
   * 读失败降级成「不可用 + 原因」，不把异常抛给每一帧快照。
   */
  surface(): SuperagentSurface {
    const runtime = this.runtime
    try {
      const settings = runtime.store.settings()
      const tickets = this.ticketViews()
      const counts = { needsYou: 0, running: 0, done: 0 }
      for (const ticket of tickets) {
        if (ticket.stage.stage === 'person') counts.needsYou += 1
        else if (ticket.stage.stage === 'ended') counts.done += 1
        else counts.running += 1
      }
      const problem = runtime.setupProblem
      return {
        ready: true,
        ...(problem === undefined ? {} : { problem: { code: problem.code, detail: problem.detail } }),
        counts,
        // 「最近动态」窗口随旧通知适配器一起不移植（见文件头第 4 条）：给空数组，不伪造。
        recent: [],
        tickets,
        sources: sourceViews(runtime, settings),
      }
    } catch (error) {
      return {
        ready: false,
        problem: { code: 'store_unavailable', detail: describe(error) },
        counts: { needsYou: 0, running: 0, done: 0 },
        tickets: [],
        recent: [],
      }
    }
  }

  /**
   * 发布一条需求，返回工单 id。
   *
   * 与旧实现一样，标题必填、正文缺省等于标题（`/sa new` 同一条规则）。`base`（工作树起点）
   * 在新树的手动触发器模型里没有落点（旧 `ManualRequest` 也没有这个字段），这里忽略它，
   * 工作目录由执行器的 prepare 步骤决定。
   *
   * 新树的判定由主会话的模型回合完成，所以这里收下触发器后轮询：出了工单就返回它的 id；
   * 判定为不接单就按旧语义抛错；超时抛错并带上触发器 id，方便对照日志。
   */
  async publish(input: SuperagentPublishInput): Promise<string> {
    const source = (input ?? {}) as Partial<SuperagentPublishInput>
    const title = typeof source.title === 'string' ? source.title.trim() : ''
    if (title === '') throw new Error('标题不能为空：先写一句要它做什么')
    const body = typeof source.body === 'string' && source.body.trim() !== '' ? source.body.trim() : title
    const runtime = this.runtime
    if (!runtime.configured()) throw new Error(`Super Agent 还没完成部署检查：${runtime.setupProblem?.detail ?? '等待设置'}`)
    // 暂停只挡住「要判定」的工作（评估、派工、出站）；发布正是要判定，先于触发器拒掉，
    // 免得用户在暂停状态下发一条、等两分钟后只看到超时。
    if (runtime.store.settings().paused) throw new Error('处理已暂停：先到面板恢复处理，再发布需求')
    this.ensureManualSender()
    const trigger = manualTrigger({ title, body }, now())
    const received = runtime.receive(trigger)
    if (received !== 'stored') throw new Error(`需求没入库（${received}）：来源没被监听，或这条需求已经在处理`)
    const outcome = await this.awaitDecision(trigger)
    if (outcome.ticket !== undefined) return outcome.ticket.id
    if (outcome.decision !== undefined) throw new Error(`需求已收到（触发器 ${trigger.id}），但没有接单：${reasonText(outcome.decision.reason)}`)
    throw new Error(`需求已收到（触发器 ${trigger.id}），但判定超时；到工单列表或宿主日志里看结果`)
  }

  /** 停止一张工单；领域收尾后立刻跑一拍把停止效果（收 worker）推出去。 */
  async stop(id: string): Promise<void> {
    this.runtime.engine.stopTicket(this.idOf(id))
    await this.runtime.pump()
  }

  /** 重试一张失败 / 卡住的工单，同样跑一拍让新分配起来。 */
  async retry(id: string): Promise<void> {
    this.runtime.engine.retryTicket(this.idOf(id))
    await this.runtime.pump()
  }

  /**
   * 回答工单当前的那个问题。
   *
   * 走与 GitHub 评论 / 飞书消息同一条路：造一条人的 `Trigger` 挂到这张工单订阅着的线程上，
   * 交给 `Engine.receive`（`core/intake.ts` 的入库、扇出、唤醒都在那里），核心里没有
   * 「面板回话」的第二条分支。线程取最近有动静的那条（旧 `runtime.ts:1469-1477` 同一判据）。
   */
  async answer(input: SuperagentAnswerInput): Promise<void> {
    const source = (input ?? {}) as Partial<SuperagentAnswerInput>
    const ticketId = this.idOf(source.ticketId ?? '')
    const text = typeof source.text === 'string' ? source.text.trim() : ''
    if (text === '') throw new Error('回答不能为空')
    if (text.length > ANSWER_MAX_CHARS) throw new Error(`回答太长：最多 ${String(ANSWER_MAX_CHARS)} 字，现在 ${String(text.length)} 字`)
    const ticket = this.runtime.store.tickets.get(ticketId)
    if (ticket === undefined) throw new Error(`没有这张工单：${ticketId}`)
    if (!liveTicket(ticket)) throw new Error(`这张工单已经结束（${ticket.title}），没有可回答的问题`)
    const thread = this.answerThreadOf(ticketId)
    if (thread === undefined) throw new Error('这张工单没有可回话的线程（消息可能来自不支持回话的来源）')
    const received = this.runtime.receive(answerTrigger({ thread: thread.ref, text, ticketId }, now()))
    // 三种结果都要说清：`stored` 才是「真的挂到工单上了」。
    if (received === 'duplicate') throw new Error('这条回答重复了：同一条消息已经收过一次，这次没有进工单')
    if (received === 'filtered') throw new Error('准入闸没放行：这条回答的来源不在允许名单里')
    await this.runtime.pump()
  }

  /**
   * 清理一张**已结束**工单的执行目录。
   *
   * 新执行器每张工单一个普通目录（不是旧树的 git worktree），所以这里删目录而不是
   * `git worktree remove`。只删落在设置执行根之下的路径：路径是库里的值，不能信它一定是
   * 执行器写的；越界的路径一律拒绝，把决定留给看见的人。
   */
  async clean(id: string): Promise<void> {
    const ticketId = this.idOf(id)
    const ticket = this.runtime.store.tickets.get(ticketId)
    if (ticket === undefined) throw new Error(`没有这张工单：${ticketId}`)
    if (!ticket.ended) throw new Error(`这张工单还没结束（${ticket.title}），不能清理它的目录`)
    const directory = ticket.execution?.directory
    if (directory === undefined || directory === '') throw new Error('这张工单没有执行目录，没什么可清理')
    const root = resolvePath(executionRoot(this.runtime.store.settings(), this.runtime.machine.stateDir))
    const target = resolvePath(directory)
    const normalize = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
    const base = normalize(root.endsWith(sep) ? root : root + sep)
    if (!normalize(target).startsWith(base)) throw new Error(`执行目录不在工单目录根下，拒绝删除：${directory}`)
    rmSync(target, { recursive: true, force: true })
  }

  /**
   * 只读读一张工单执行会话的转录（不拿写租约）。
   *
   * 与旧 `surface.ts:170-194`、新 `app/resources.ts:142-192` 同一条只读口径：
   * `Session.load(..., { lease: false })` 重放 jsonl；worker 会话一票一个文件
   * （`app/sessions.ts:404-417`），所以只读那一个。日志不在 = 这张单还没派过工。
   */
  async peekSession(id: string): Promise<TranscriptEntry[]> {
    const ticketId = this.idOf(id)
    const file = join(sessionsDir(ticketId), `${workerSessionId(ticketId)}.jsonl`)
    if (!existsSync(file)) throw new Error(`这张工单还没有执行会话：${ticketId}`)
    const session = Session.load(file, true, { lease: false })
    try {
      const replay = new Transcript()
      replay.replayHistory(session.messages, session.toolErrors, session.fileChanges, session.presentations)
      return [...replay.entries, ...replay.liveEntries()]
    } finally {
      session.close()
    }
  }

  /**
   * 接一条等人拍板的推断候选。
   *
   * 新架构没有候选收件箱（见文件头第 1 条）：推断候选的判定结果直接进主会话的
   * `orchestrator_eval` / `orchestrator_route`。面板不会显示候选卡片，也就走不到这里；
   * 真被调到就给一句明确的话，不假装成功。
   */
  async acceptCandidate(_id: string, _title?: string): Promise<string> {
    throw new Error('新架构没有等人拍板的候选：判定结果由主会话直接处理，面板不再收候选')
  }

  /** 忽略一条候选；理由同上（`acceptCandidate`）。 */
  async ignoreCandidate(_id: string, _reason?: string): Promise<void> {
    throw new Error('新架构没有等人拍板的候选：判定结果由主会话直接处理，面板不再收候选')
  }

  /**
   * 可见面的一次指纹：计数 + 工单的阶段 / 摘要 + 来源状态。
   *
   * 插件入口每 2 秒比一次，变了才发 `dsc/changed`（旧 `service.ts:52-58` 的 `pulseOf` 同一件事）。
   * 为什么入口需要这条桥：新树的编排会话是本进程里自己造的 `MiniAgent`，回合事件不经过
   * DSC 的会话服务，所以宿主收不到任何 `dsc/changed`；面板读的是快照，没有这条桥就只能等
   * 别的插件碰巧发事件才重画。指纹取「人看得见的那几项」，不参与界面的字段（如内部 id）
   * 不算进来，免得每拍都白推一次。
   */
  pulse(): string {
    const surface = this.surface()
    const tickets = surface.tickets.map(ticket => `${ticket.id}:${ticket.stage.stage}:${'action' in ticket.stage ? ticket.stage.action ?? '' : ''}:${ticket.summary ?? ''}`)
    const sources = (surface.sources ?? []).map(source => `${source.id}:${String(source.enabled)}:${source.lastPollAt ?? ''}:${source.lastError ?? ''}`)
    return `${String(surface.ready)}|${String(surface.problem?.detail ?? '')}|${JSON.stringify(surface.counts)}|${tickets.join('|')}|${sources.join('|')}`
  }

  /** 快照的工单行：开放与已结束各取一页，合并后按建单时刻倒序（与旧 `list()` 的新在前一致）。 */
  private ticketViews(): SuperagentTicketView[] {
    const host = { store: this.runtime.store, sources: this.runtime.sources, links: this.runtime.links() }
    const rows = [
      ...ticketList(host, 'open', 0, MAX_TICKET_VIEWS).items,
      ...ticketList(host, 'ended', 0, MAX_TICKET_VIEWS).items,
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return rows.map(ticketViewOf)
  }

  /** 回答要回到的那条线程：订阅这张工单的线程里最近有动静的一条（同一时刻按 key 定序）。 */
  private answerThreadOf(ticketId: string): Thread | undefined {
    const subscribed = this.runtime.store.threads.list().filter(thread => thread.subscriptions.includes(ticketId))
    const first = subscribed[0]
    if (first === undefined) return undefined
    const recency = (thread: Thread): string => thread.lastAt ?? thread.createdAt
    return subscribed.reduce((best, thread) => {
      const [a, b] = [recency(thread), recency(best)]
      if (a !== b) return a > b ? thread : best
      return thread.key > best.key ? thread : best
    }, first)
  }

  /** 发布后等判定：出了工单返回工单，出了非接单决策返回决策，超时都为空。 */
  private async awaitDecision(trigger: Trigger): Promise<PublishOutcome> {
    const deadline = Date.now() + PUBLISH_TIMEOUT_MS
    const first = trigger.threads[0]
    const keyOfThread = first === undefined ? undefined : threadKey(first)
    for (;;) {
      await this.runtime.pump()
      await this.runtime.idle()
      const decision = keyOfThread === undefined ? undefined
        : this.runtime.store.decisions.byThread(keyOfThread).find(item => item.triggerIds.includes(trigger.id))
      if (decision !== undefined) {
        const ticket = decision.ticketId === undefined ? undefined : this.runtime.store.tickets.get(decision.ticketId)
        if (ticket !== undefined) return { ticket, decision }
        if (decision.kind !== 'accept' && decision.kind !== 'reopen') return { decision }
      }
      if (Date.now() >= deadline) return {}
      // 判定由主会话的模型回合完成：等它闲下来再复查，别在回合中间空转。
      await this.runtime.sessions.whenIdle(this.runtime.masterId).catch(() => undefined)
      await sleep(POLL_MS)
    }
  }

  /**
   * 把 `operator` 补进 `policy.sources.manual.allowed`（只在名单为空时写一次）。
   *
   * 旧 `defaultSettings` 在造运行期时做同一件事；新树的设置默认值是空表，而 DSC 的发布
   * 入口仍要一条显式的人工触发器（`addressed: 'direct'` + 名单里的人 = 显式请求）。
   * 名单非空说明用户 / 迁移已经配过，不再覆盖。
   */
  private ensureManualSender(): void {
    const store = this.runtime.store
    const settings = store.settings()
    if ((settings.policy.sources[MANUAL_SOURCE]?.allowed.length ?? 0) > 0) return
    const next = SettingsSchema.parse({
      ...settings,
      policy: { ...settings.policy, sources: { ...settings.policy.sources, [MANUAL_SOURCE]: { allowed: [{ id: DEFAULT_ACTOR }] } } },
    })
    store.saveSettings(next, { source: 'internal', policyVersion: policyVersion(next), policyChanged: true, notified: [] })
  }

  /** 工单 id：服务这一层只收字符串；外层（`packages/runtime`）负责把 `{ id }` 拆开。 */
  private idOf(id: string): string {
    const value = typeof id === 'string' ? id.trim() : ''
    if (value === '') throw new Error('要给一个工单 id')
    return value
  }
}

/**
 * 造一个面板服务（插件入口在 `apply` 里调用；返回的对象直接 `ctx.provide('superagent', ...)`）。
 *
 * 返回具体类而不是接口：入口另要用 {@link PanelApi.pulse} 做快照失效桥（见 `index.ts`），
 * 那个方法不属于 `SuperagentService` 契约，面板侧看不到。
 */
export function createApi(runtime: Runtime): PanelApi {
  return new PanelApi(runtime)
}
