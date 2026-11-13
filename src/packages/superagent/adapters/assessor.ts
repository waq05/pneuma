/**
 * P0 的判定器：手动来源里只有「明确请求」这一种，所以判定不需要模型。
 *
 * 为什么 `request` 只入队、不在这里调 `engine.decide`：`request` 是在
 * `Engine.evaluateDue()` 的写事务里被调用的（`core/evals.ts:118`，外层是
 * `core/engine.ts:83` 的 `repo.atomic`）。在这个位置再进一次 `Engine.decide`，
 * 等于在一个还没提交的事务里重入同一段领域代码：一旦某一步抛错，回滚的是外层
 * 那一整批（包括别的线程刚排上的 Eval），而调用方只看到「这条没建成」。
 *
 * 所以判定分两拍：
 *   1. `request(candidate)`：只把「哪个 Eval 要判定」记为待办；
 *   2. `drain(engine)`：由泵（或者 `publish`）在事务之外逐条取件，重新读一次
 *      候选，再 `engine.decide(...)`。
 *
 * 这个类不启动任何会话、不碰数据库：它只持有队列。
 *
 * @module dsc/packages/superagent/adapters/assessor
 */
import type { Engine, AssessmentOutcome, Candidate, Assessor } from '../core/index.js'
import type { Trigger } from '../core/model.js'

/** 队列里的一条：Eval 的 id 与它持有的一条 Trigger（`decide` 按 Trigger 定位 Eval）。 */
interface PendingAssessment { evalId: string; triggerId: string }

/**
 * 从触发器正文里取标题。
 *
 * 优先 `meta.title`（`manual.ts` 写进去的那个），回落到正文第一行非空文本：
 * 将来若有别的来源也走手动路径、却没写 `meta.title`，至少不会给工单一个空标题。
 */
function titleOf(trigger: Trigger): string {
  const fromMeta = trigger.meta.title
  if (typeof fromMeta === 'string' && fromMeta.trim() !== '') return fromMeta.trim()
  const firstLine = trigger.text.split('\n').map(line => line.trim()).find(line => line !== '')
  return firstLine ?? 'Untitled request'
}

/**
 * P0 的判定规则。
 *
 * - `explicit`：用户自己敲的明确请求，直接接单。`scope` 记 `manual`，
 *   它是 Mandate 上的来源范围，不是线程 id。
 * - 其余（P0 不该出现）：只记一条 `ignore`，不抛错。核心对「推断候选被接受」
 *   有额外限制（`core/evals.ts:152`，要求自动模式且命中规则），P0 没有规则表，
 *   所以这里宁可忽略也不越权。
 */
function assess(candidate: Candidate): AssessmentOutcome {
  const trigger = candidate.triggers[0]
  const title = trigger ? titleOf(trigger) : 'Untitled request'
  if (candidate.strength === 'explicit') {
    return { kind: 'accept', title, scope: 'manual', reason: 'Explicit manual request from the terminal' }
  }
  return { kind: 'ignore', reason: 'Manual source admits only explicit requests in P0' }
}

/**
 * 手动来源的判定器。
 *
 * 构造时接一个 `onError`，是为了让单条判定失败（比如 Eval 恰好过期、核心抛
 * `evalFinished`）只记一笔、不把同一拍里其余待办一起打断——设计文档 §5.4 的
 * 「泵任务抛错：记日志，不中断下一轮」。默认吞掉，调用方（`runtime.ts`）传日志。
 */
export class ManualAssessor implements Assessor {
  private readonly queue: PendingAssessment[] = []
  private readonly onError: (error: unknown, evalId: string) => void

  constructor(onError: (error: unknown, evalId: string) => void = () => {}) {
    this.onError = onError
  }

  /**
   * 记下一条待判定。
   *
   * 按 `evalId` 去重：同一个 Eval 的候选可能被重复投递（比如处理暂停后重跑），
   * 重复入队会让第二次 `decide` 撞上「Eval 已结束」。
   */
  request(candidate: Candidate): void {
    const triggerId = candidate.triggers[0]?.id
    if (triggerId === undefined) return
    if (this.queue.some(item => item.evalId === candidate.evalId)) return
    this.queue.push({ evalId: candidate.evalId, triggerId })
  }

  /**
   * 逐条判定队列里的候选。
   *
   * 每条都**重新**读候选（`engine.candidate`）：入队到出队之间，Eval 可能已经过期、
   * 被判定、或被新的 Policy 版本重启。重新读能把「拿着旧快照去决定」挡掉；
   * 读不到（`undefined`）或 `evalId` 对不上，说明这条已经不需要判定了，直接丢。
   *
   * @returns 这一拍建出的工单 id，按判定顺序；没有接单时是空数组
   */
  drain(engine: Engine): string[] {
    const created: string[] = []
    for (const item of this.queue.splice(0)) {
      try {
        const candidate = engine.candidate(item.triggerId)
        if (candidate === undefined || candidate.evalId !== item.evalId) continue
        const decision = engine.decide(item.triggerId, { ...assess(candidate), evalId: candidate.evalId })
        if (decision.ticketId !== undefined) created.push(decision.ticketId)
      } catch (error) {
        this.onError(error, item.evalId)
      }
    }
    return created
  }

  /**
   * 丢掉一个 Eval 的待办。
   *
   * 核心在 Eval 结束（判定完成、过期、被新版本重启）时会调用它
   * （`core/evals.ts:68` 与 `:324`），所以「判定完还留着」的那条不会在下一拍
   * 被重复判定。
   */
  release(evalId: string): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]?.evalId === evalId) this.queue.splice(index, 1)
    }
  }

  /** 丢掉全部待办；runtime 关闭时用，避免持有旧 Engine 的 Eval id。 */
  clear(): void {
    this.queue.length = 0
  }
}
