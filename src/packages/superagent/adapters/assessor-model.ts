/**
 * 模型版判定器：把「这条请求算不算被授权」交给模型，输出经核心的规则校验后才生效。
 *
 * 为什么不用上游那套「把候选卡片投给主会话、由主会话调工具判定」（`app/assessment.ts:104`）：
 * DSC 没有那个常驻主会话。这里换成一次性问答——给一段提示词，拿一份 JSON，自己校验。
 * 语义上与上游一致：判定结果仍然经 `Engine.decide` 落库，规则与强度仍由核心判。
 *
 * 三条硬约束（都是踩过才知道的）：
 *
 * 1. **必须调 `engine.candidateDelivered(evalId)`**。核心的 Eval 截止时间只有在候选「已投递」
 *    之后才开始算（`core/evals.ts:43`），而 `ManualAssessor` 从不调它也不会出事——它同步就判
 *    完了。模型版一旦慢或挂住，不调这一步就永远不会过期，工单也不会有人来兜（`core/evals.ts:60`
 *    的重排与「判定器不可用」全靠它）。所以先「投递」，再等模型。
 * 2. **判定结果必须整份交给核心校验**（`assessmentOutcome`，`core/policy.ts:52`）。模型说
 *    「接单」不等于接单：方向要定、至少命中一条启用规则、还要有 `intent_evidence`。这里不
 *    自己写一遍这些检查，只把模型的 JSON 原样递过去——两套校验迟早会分叉。
 * 3. **模型输出不可信**。可能带 ```json 围栏、可能少一条规则判定、可能整个不是 JSON。三种
 *    都要落成「这一条判不了」，而不是抛到泵上把整拍打断。
 *
 * @module dsc/packages/superagent/adapters/assessor-model
 */
import { z } from 'zod'
import type { Engine, AssessmentOutcome, Assessor, Candidate } from '../core/index.js'
import { assessmentOutcome, type Assessment, type Settings } from '../core/policy.js'
import type { Trigger } from '../core/model.js'

/** 队列里的一条：Eval 的 id 与它持有的一条 Trigger（`decide` 按 Trigger 定位 Eval）。 */
interface PendingAssessment { evalId: string; triggerId: string }

/**
 * 模型输出的形状。
 *
 * 比核心的 `Assessment` 宽一点：`title` / `scope` / `reason` 给了缺省空串，因为忽略类的判定
 * 通常不带这三个字段，而核心的类型要求它们存在。`rule_assessments` 一条都不能少——少一条
 * 核心会拒（`core/policy.ts:56`），这里不替它补。
 */
const ModelOutputSchema = z.object({
  decision: z.enum(['accept', 'ignore', 'unavailable']),
  rule_assessments: z.array(z.object({
    rule_id: z.string().min(1),
    matched: z.boolean(),
    reason: z.string().min(1).max(500),
  })),
  direction: z.unknown(),
  title: z.string().default(''),
  scope: z.string().default(''),
  reason: z.string().default(''),
  intent_evidence: z.string().nullable().optional(),
  acknowledgement: z.string().nullable().optional(),
  worktree_name: z.string().optional(),
})

/** 一次问答：给提示词，拿回复正文。装配处接宿主模型，测试传假函数。 */
export type AssessorComplete = (prompt: string) => Promise<string>

/**
 * 一条被挂起的推断候选（backlog G1）。
 *
 * 为什么把整份 outcome 交出去而不是在这里 decide：决定「接不接」是人的事，判定器
 * 只负责「这条按规则能不能接」。交出去之后，落库、界面显示、人点确认都发生在适配层，
 * 判定器不碰存储也不碰界面。
 */
export interface HeldCandidate {
  /** Eval 的 id（收件箱里那条的 id）。 */
  evalId: string
  /** 触发它的消息。 */
  triggerId: string
  /** 主线程 key（界面上按线程分组）。 */
  threadKey: string
  /** 判定结果：人点接单时原样交给引擎。 */
  outcome: AssessmentOutcome
  /** 卡片标题。 */
  title: string
  /** 模型给的理由。 */
  reason: string
  /** 工单范围。 */
  scope: string
  /** 来源（`github` / `feishu`）。 */
  source: string
}

/**
 * 挂起时写进 `decision` 表的理由。
 *
 * 为什么还要记一条 `ignore`：Eval 必须结束，否则它会挂到超时、重排、再判一次、
 * 再进一次收件箱——同一个候选在界面上出现两遍。记成 ignore 是「这次判定没有接单」，
 * 真实结论在候选收件箱里，等人给。
 */
export const AWAITING_PERSON = 'awaiting-person'

/**
 * 取一条 Trigger 的线程上下文（可读文本；没有就 `undefined`）。
 *
 * 为什么由外面注入而不是这里自己读 GitHub：判定器不认识来源，也不该认识。读窗口要令牌、
 * 要分页、要按来源判「这条有没有对话」——都是适配层的事；这里只要一段能拼进提示词的文本。
 */
export type AssessorContext = (trigger: Trigger) => Promise<string | undefined>

/** 装配参数。 */
export interface ModelAssessorOptions {
  complete: AssessorComplete
  /** 现读设置：规则表与接单模式改了，下一条判定就用新的。 */
  settings: () => Settings
  /**
   * 线程上下文；不给 = 提示词里没有「上下文」这一节（与加它之前逐字一致）。
   *
   * 读失败由本文件兜住（记一行日志、按没有上下文继续判），不让「读不到前后文」变成
   * 「这条判不了」——那会把一条本来能判的请求推给超时重排。
   */
  context?: AssessorContext
  onError?: (error: unknown, evalId: string) => void
  log?: (line: string) => void
  /**
   * 推断候选的落点（backlog G1）。
   *
   * 给了它，`inferred` 强度的 accept 就不直接建工单，而是交给它等人点头；不给 = 老行为
   * （判定即接单）。明确请求永远直接接单，不走这条路——那是人自己敲的，不需要再问一次。
   */
  holdCandidate?: (hold: HeldCandidate) => void
}

/** 从模型回复里抠出 JSON：允许 ```json 围栏与前后闲话，抠不出就返回 undefined。 */
function jsonOf(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply)
  const body = (fenced?.[1] ?? reply).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * 判定提示词。
 *
 * 规则表的每一行都是核心里的原文（`core/policy.ts:74-77` 的默认值或用户改过的），不在这里
 * 转述：转述就等于在这里藏了第二份规则表。
 *
 * `context` 是线程窗口渲染出来的可读文本（`runtime.ts` 的 `renderThreadContext`）。**必须写明
 * 它只用来判断「这条消息是不是在请求干活」**：不带这句，模型会把上下文里的旧需求当成这张工单
 * 的正文，于是「上一条评论要 A、这一条只是回一句收到」会被判成又一个 A。它也可能被截断 /
 * 省略，所以再说一句「不是工单正文、可能不完整」，逼模型只把上下文当语气与指代线索。
 */
export function assessmentPrompt(trigger: Trigger, settings: Settings, context?: string): string {
  const rules = settings.policy.rules.filter((rule) => rule.enabled)
    .map((rule) => `- ${rule.id}（${rule.name}）：${rule.instruction}`)
    .join('\n')
  return [
    '你是 Super Agent 的研判器。判断下面这条请求是否被某条已启用的规则授权。',
    '',
    '启用规则：',
    rules === '' ? '（没有启用任何规则）' : rules,
    '',
    '请求：',
    `来源：${trigger.source}`,
    `发起人：${trigger.actor.id}`,
    `标题：${typeof trigger.meta.title === 'string' ? trigger.meta.title : '（未给）'}`,
    '正文：',
    trigger.text,
    '',
    ...context === undefined ? [] : [
      '上下文（只用来判断这条消息是不是在请求干活，不是工单正文；可能省略了中间的发言，不要把它当成本次要处理的需求）：',
      context,
      '',
    ],
    '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。字段：',
    'decision: "accept" | "ignore" | "unavailable"',
    'direction: 方向判定，必须是对象 {implementation_requested: boolean（是不是要改代码）, ' +
      'target_basis: "specified" | "existing-standard" | "undetermined"（目标由请求点名、还是照着现状改、还是说不清）, ' +
      'requires_design_decision: boolean（要不要先定设计）, evidence: "引用的原话"}',
    'rule_assessments: 每条启用规则一项 {rule_id, matched, reason}，一条都不能少',
    'title: 接单时的工单标题；scope: 要改的范围；reason: 判定理由',
    'intent_evidence: 接单时必须给，引用请求里支撑判定的原话',
    'acknowledgement: 可选，给发起人的一句确认',
    '',
    '只按上面的规则判，不要臆造需求；拿不准就 ignore，不要 accept。',
  ].join('\n')
}

/**
 * 模型版判定器。
 *
 * 与 `ManualAssessor` 同一套节奏：`request` 只入队，泵每拍调 `drain`。区别只在 `drain` 是
 * 异步的（要等模型），所以它同步返回空数组，结果稍后经 `engine.decide` 落库。
 */
export class ModelAssessor implements Assessor {
  private readonly queue: PendingAssessment[] = []
  /** 已经叫过模型、还没回来的 Eval；用来防止同一拍重复投递。 */
  private readonly inFlight = new Set<string>()
  private readonly options: ModelAssessorOptions

  constructor(options: ModelAssessorOptions) {
    this.options = options
  }

  /** 记下一条待判定；同一个 Eval 重复投递只记一次。 */
  request(candidate: Candidate): void {
    const triggerId = candidate.triggers[0]?.id
    if (triggerId === undefined) return
    if (this.inFlight.has(candidate.evalId)) return
    if (this.queue.some((item) => item.evalId === candidate.evalId)) return
    this.queue.push({ evalId: candidate.evalId, triggerId })
  }

  /** 泵的一拍：把队列里的候选全部叫醒，不等结果。 */
  drain(engine: Engine): string[] {
    void this.drainAsync(engine)
    return []
  }

  /**
   * 取一条 Trigger 的线程上下文。
   *
   * 读失败只记一行、返回 `undefined`：判定器该在「没有前后文」的状态下照常判。把异常抛给
   * `drainAsync` 的 catch 也不是不行，但那会走 `onError`（判定失败）；而这里的事实是
   * 「上下文没读到」，不是「这一条判不了」——两者混在一起，日志里会多出误导人的失败记录。
   */
  private async contextOf(trigger: Trigger, evalId: string): Promise<string | undefined> {
    const load = this.options.context
    if (load === undefined) return undefined
    try {
      const text = await load(trigger)
      return text === undefined || text.trim() === '' ? undefined : text
    } catch (error) {
      this.options.log?.(
        `[superagent] 判定 ${evalId} 的线程上下文没读到（按没有上下文判定）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /**
   * 真正干活的那一份；测试直接 await 它。
   *
   * @returns 这一拍建出的工单 id。模型是异步的，这里必然为空——调用方不该拿它做判断。
   */
  async drainAsync(engine: Engine): Promise<string[]> {
    const created: string[] = []
    for (const item of this.queue.splice(0)) {
      if (this.inFlight.has(item.evalId)) continue
      this.inFlight.add(item.evalId)
      try {
        // 重新读一次候选：入队到出队之间，Eval 可能已过期、已判定、或换了 Policy 版本。
        const candidate = engine.candidate(item.triggerId)
        if (candidate === undefined || candidate.evalId !== item.evalId) continue
        const trigger = candidate.triggers[0]
        if (trigger === undefined) continue
        // 先记「候选已投递」，截止时间才从这一刻开始算（见文件头第 1 条）。
        engine.candidateDelivered(item.evalId)
        const settings = this.options.settings()
        // 上下文要现读（一次网络往返），所以放在投递之后：读它花掉的时间也算在 Eval 的
        // 截止时间里，而不是在「投递之前」偷偷攒一段不计时的等待。
        const context = await this.contextOf(trigger, item.evalId)
        const reply = await this.options.complete(assessmentPrompt(trigger, settings, context))
        const parsed = ModelOutputSchema.safeParse(jsonOf(reply))
        if (!parsed.success) {
          this.options.log?.(`[superagent] 判定 ${item.evalId} 的模型输出不合形状：${parsed.error.message.slice(0, 200)}`)
          continue
        }
        const outcome: AssessmentOutcome = assessmentOutcome(parsed.data as Assessment, settings, candidate.strength)
        // 推断候选：交给候选收件箱等人点头（backlog G1）。明确请求照旧直接接单——
        // 那是人自己敲的，不需要再问一次。
        //
        // 为什么这里要顺手把 Eval 结束掉：不结束它会挂到超时、重排、再判一次、
        // 再进一次收件箱，同一个候选在界面上出现两遍。记成 ignore 是「这次判定没有接单」，
        // 真实结论在收件箱里等人给。
        if (outcome.kind === 'accept' && candidate.strength !== 'explicit' && this.options.holdCandidate !== undefined) {
          this.options.holdCandidate({
            evalId: item.evalId,
            triggerId: item.triggerId,
            threadKey: candidate.thread.key,
            outcome,
            title: outcome.title,
            reason: typeof outcome.reason === 'string' ? outcome.reason : '',
            scope: outcome.scope,
            source: trigger.source,
          })
          engine.decide(item.triggerId, { kind: 'ignore', reason: AWAITING_PERSON, evalId: item.evalId })
          continue
        }
        const decision = engine.decide(item.triggerId, { ...outcome, evalId: item.evalId })
        if (decision.ticketId !== undefined) created.push(decision.ticketId)
      } catch (error) {
        // 单条判定失败只记一笔：核心那边会让 Eval 按超时重排或记「判定器不可用」。
        this.options.onError?.(error, item.evalId)
      } finally {
        this.inFlight.delete(item.evalId)
      }
    }
    return created
  }

  /** 丢掉一个 Eval 的待办；在飞的也丢——它回来时 `decide` 会因 Eval 已结束而抛，被 onError 收走。 */
  release(evalId: string): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]?.evalId === evalId) this.queue.splice(index, 1)
    }
    this.inFlight.delete(evalId)
  }

  /** 丢掉全部待办；runtime 关闭时用。 */
  clear(): void {
    this.queue.length = 0
    this.inFlight.clear()
  }
}
