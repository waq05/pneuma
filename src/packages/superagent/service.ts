/**
 * superagent 插件对外露的服务（`ctx.superagent`）：快照面 + 五个可调方法。
 *
 * 为什么要有这一层：内核的 `packages/runtime` 不能 import 插件的类（依赖方向只能
 * packages → contract），界面通道只能经 `ctx.get('superagent')` 转发。所以这里把
 * 运行期包成一个服务，方法与快照面都从它走。
 *
 * **薄**是这一层的规矩：五个方法只做「取运行期 → 调对应方法 → 通知快照失效」，
 * 不拼 SQL、不判定工单、不建目录。业务在 `runtime.ts` 与 `core/`；
 * 装配在 `surface.ts`。
 *
 * @module dsc/packages/superagent/service
 */
import type {
  SuperagentPublishInput,
  SuperagentService as SuperagentServicePort,
  SuperagentSurface,
  TranscriptEntry,
} from '@pneuma/runtime/contract.js'
import { buildSurface, readSessionTranscript } from './surface.js'
import type { SuperagentRuntime } from './runtime.js'

/** 服务从插件装配处拿的四件东西（全是回调，服务自己不持有库）。 */
export interface SuperagentServiceDeps {
  /** 已经建好的运行期；null = 还没建（泵用，不触发建库）。 */
  current(): SuperagentRuntime | null
  /** 取运行期，没有就建一个；建不出来返回 null（建库归 `index.ts` 的 ensure）。 */
  ensure(): SuperagentRuntime | null
  /** 上次建库失败的说明；没有失败返回 null。 */
  problem(): { code: string; detail: string } | null
  /** 可见面变了：让快照失效（`dsc/changed`）。 */
  changed(): void
}

/** 把未知异常压成一行可读文本。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 可见面的一次指纹：工单阶段 + 最近动态的条数/时刻。
 *
 * 值没变就不推快照（泵每 2 秒一拍，不为此重画界面）；最近动态也要算进来——工单结束时
 * 通知是先入出站队列、下一拍才被 `pump` 取进内存窗口的，只看阶段会漏掉这一条。
 */
function pulseOf(runtime: SuperagentRuntime): string {
  const tickets = runtime.list().map((ticket) =>
    `${ticket.id}:${ticket.stage.stage}:${'action' in ticket.stage ? ticket.stage.action ?? '' : ''}`)
  const recent = runtime.recent().map((notice) => notice.at)
  return `${tickets.join('|')}||${recent.join(',')}`
}

/**
 * 插件服务本体。
 *
 * 不继承 cordis 的 `Service` 基类：仓库里 20 多个服务（mode / goal / transcript……）
 * 都是「普通对象 + `ctx.provide(name, service)`」，这里照同一写法，自动注销由插件
 * fiber 负责。界面通道那侧只看类型（`SuperagentService`），不关心怎么注册的。
 */
export class SuperagentService implements SuperagentServicePort {
  private readonly deps: SuperagentServiceDeps
  /** 上一次泵拍看到的指纹；首次为空串，保证第一拍会推一次快照。 */
  private pulse = ''

  constructor(deps: SuperagentServiceDeps) {
    this.deps = deps
  }

  /**
   * 当前快照面。
   *
   * 这里**会**惰性启动运行期（`ensure`）：快照是界面唯一的数据来源，第一次拉快照就是
   * 「第一次真要用」。`apply` 仍然不碰磁盘（§9.1），区别只是「开插件后第一次画面板」
   * 与「第一次敲 /sa」哪一个先到。
   */
  surface(): SuperagentSurface {
    let runtime: SuperagentRuntime | null
    try {
      runtime = this.deps.ensure()
    } catch (error) {
      return this.notReady('store_unavailable', describe(error))
    }
    if (runtime === null) {
      const problem = this.deps.problem()
      return this.notReady(
        problem?.code ?? 'not_started',
        problem?.detail ?? 'Super Agent 还没启动：发布一张工单，或检查编排库能不能打开',
      )
    }
    try {
      return buildSurface(runtime)
    } catch (error) {
      // 读库失败不该让整个快照生不出来：这一格降级成「不可用 + 原因」，别的面照常画。
      return this.notReady('read_failed', describe(error))
    }
  }

  /**
   * 发布一张需求，返回工单 id。
   *
   * 标题必填（空标题在库里没有意义），正文缺省等于标题——与 `/sa new` 同一条规则
   * （`commands.ts:47-48`）。
   */
  async publish(input: SuperagentPublishInput): Promise<string> {
    const source = (input ?? {}) as Partial<SuperagentPublishInput>
    const title = typeof source.title === 'string' ? source.title.trim() : ''
    if (title === '') throw new Error('标题不能为空：先写一句要它做什么')
    const body = typeof source.body === 'string' && source.body.trim() !== '' ? source.body.trim() : title
    const base = typeof source.base === 'string' && source.base.trim() !== '' ? source.base.trim() : undefined
    const runtime = this.require()
    const id = runtime.publish({ title, body, ...(base === undefined ? {} : { base }) })
    // `publish` 没接单时返回的是 Trigger id（`runtime.ts:195-198`），工单列表里查不到。
    // 这种 id 交给界面只会让它去查一张不存在的工单，宁可当场报错说清楚。
    if (!runtime.list().some((ticket) => ticket.id === id)) {
      throw new Error(`需求已收到，但没有接单成功（id ${id}）；看宿主日志里那条「没有建出工单」`)
    }
    this.notify()
    return id
  }

  /** 停止一张工单；领域收尾在先、停 worker 在后（顺序在 runtime 里）。 */
  async stop(id: string): Promise<void> {
    this.require().stop(this.idOf(id))
    this.notify()
  }

  /** 重试一张失败 / 卡住的工单。 */
  async retry(id: string): Promise<void> {
    this.require().retry(this.idOf(id))
    this.notify()
  }

  /** 清理一张已结束工单的工作树。 */
  async clean(id: string): Promise<void> {
    this.require().clean(this.idOf(id))
    this.notify()
  }

  /** 只读读执行会话转录：不需要运行期（文件可能还在，库还没开也看得到）。 */
  async peekSession(id: string): Promise<TranscriptEntry[]> {
    return readSessionTranscript(this.idOf(id))
  }

  /**
   * 接一条等人拍板的推断候选，返回建出来的工单 id。
   *
   * 判定结果整份从库里取、原样交给引擎（`runtime.acceptCandidate`）：界面只给 id
   * 与可选的标题覆盖，不转手那份 JSON——少一个 `rules` 就会被引擎按「推断候选没有
   * 命中规则」拒掉（`core/evals.ts:152`）。
   */
  async acceptCandidate(id: string, title?: string): Promise<string> {
    const ticketId = this.require().acceptCandidate(this.idOf(id), title)
    this.notify()
    return ticketId
  }

  /** 忽略一条候选：它就此结束，不再进工单。 */
  async ignoreCandidate(id: string, reason?: string): Promise<void> {
    this.require().ignoreCandidate(this.idOf(id), reason)
    this.notify()
  }

  /**
   * 泵的一拍：驱动运行期，可见面变样时推一次快照。
   *
   * 为什么不每拍都推：2 秒一次的全量快照重算 + 界面重画是纯浪费；只有工单阶段真的
   * 变了（派工、收工、失败）才需要界面知道。
   */
  tick(): void {
    const runtime = this.deps.current()
    if (runtime === null) return
    runtime.pump()
    const next = pulseOf(runtime)
    if (next === this.pulse) return
    this.pulse = next
    this.notify()
  }

  /** 取运行期；没有就建一个，建不出来给一句能读的话。 */
  private require(): SuperagentRuntime {
    const runtime = this.deps.ensure()
    if (runtime !== null) return runtime
    const problem = this.deps.problem()
    throw new Error(problem?.detail ?? 'Super Agent 还没启动：编排库没打开，先看宿主日志')
  }

  /** 工单 id：服务这一层只收字符串；外层（runtime 包）负责把 `{ id }` 拆开。 */
  private idOf(id: string): string {
    const value = typeof id === 'string' ? id.trim() : ''
    if (value === '') throw new Error('要给一个工单 id')
    return value
  }

  /** 通知快照失效（工单变了，列表与计数都要重画）。 */
  private notify(): void {
    try {
      this.deps.changed()
    } catch {
      // 通知失败不影响动作本身：账已经落库，界面下一拍会自己对上。
    }
  }

  /** 「不可用」那一档的快照面：三组计数全 0，界面只画一句原因。 */
  private notReady(code: string, detail: string): SuperagentSurface {
    return {
      ready: false,
      problem: { code, detail },
      counts: { needsYou: 0, running: 0, done: 0 },
      tickets: [],
      recent: [],
    }
  }
}
