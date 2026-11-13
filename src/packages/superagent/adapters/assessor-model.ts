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

/** 装配参数。 */
export interface ModelAssessorOptions {
  complete: AssessorComplete
  /** 现读设置：规则表与接单模式改了，下一条判定就用新的。 */
  settings: () => Settings
  onError?: (error: unknown, evalId: string) => void
  log?: (line: string) => void
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
 */
export function assessmentPrompt(trigger: Trigger, settings: Settings): string {
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
        const reply = await this.options.complete(assessmentPrompt(trigger, settings))
        const parsed = ModelOutputSchema.safeParse(jsonOf(reply))
        if (!parsed.success) {
          this.options.log?.(`[superagent] 判定 ${item.evalId} 的模型输出不合形状：${parsed.error.message.slice(0, 200)}`)
          continue
        }
        const outcome: AssessmentOutcome = assessmentOutcome(parsed.data as Assessment, settings, candidate.strength)
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
