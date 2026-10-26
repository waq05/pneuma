/**
 * 把一次模型调用的用量，按 dsh 的 `llm/stream` 事件发出去。
 *
 * 为什么需要：dsh 的计费类插件（`dsh-cost-meter` 就是）记**实时花费**不听用量日志，而是
 * 在 `llm/stream` 这个 **waterfall 事件**上包一层流：拿到下游流之后自己逐个 chunk 读，
 * 见到 `{ type: 'usage', usage }` 就记账，再把 chunk 原样吐给调用方。只做会话历史读取
 * （core/dsh-compat/session-bridge）不会让它有数——2026-10-26 真包验收时确认过。
 *
 * 我们这边没有 dsh 那种流式 chunk 协议，所以走**最小可信的合成**：把这一次调用的用量
 * 包成**唯一一个 chunk** 交出去，然后把这个（被插件包过的）迭代器消费掉，让插件的
 * `finally` 与记账逻辑跑完。谁也没看见假数据：chunk 里的数字就是本次请求真实的 token 数。
 *
 * 边界：这条事件只影响「听它的插件」，不改变回合本身的流式路径——我们的流仍然是回调式
 * （`LlmService.stream` 的 handlers），这里只是并行发一条旁路读数。插件抛错一律吞掉：
 * 记账失败绝不能把用户的回合带崩。
 *
 * @module dsc/core/dsh-compat/llm-usage-event
 */

/** 一次模型调用的用量（与 `core/usage-log` 的字段一一对应）。 */
export interface LlmUsageInfo {
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  /** prompt_tokens 总量（命中**包含在内**，与内核 `usage` 事件同口径）。 */
  readonly inputTokens: number
  readonly outputTokens: number
  /** 输入里的缓存命中 token 数。 */
  readonly cacheHitTokens?: number
  /** 输入里的未命中 token 数（不报时按总量减命中算）。 */
  readonly cacheMissTokens?: number
  readonly reasoningTokens?: number
}

/** dsh 的用量形状：各分项**互斥**（见下面的换算）。 */
export interface DshTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
}

/** 我们这边的用量读数（内核 `usage` 事件 + 用量日志的字段）。 */
export interface KernelUsageLike {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheHitTokens?: number
  readonly cacheMissTokens?: number
  readonly reasoningTokens?: number
}

/**
 * 把我们的用量换算成 dsh 的分项。
 *
 * 两边的口径不一样，直接抄会**多算钱**：我们的 `inputTokens` 是 prompt_tokens 总量，
 * 缓存命中**包含在内**；dsh 的 `inputTokens` 只算未命中的部分，命中另记
 * `cacheReadTokens`，计费时三项相加。照搬就把命中那部分按未命中价又收了一遍。
 *
 * `cacheWriteTokens` 一律 0：我们这边没有「缓存写入」这个概念（命中的补集是未命中，
 * 不是写入）。dsh 的 `totalTokens` 是四项相加，这里按同一口径给出。
 *
 * @param usage - 内核读数
 * @returns dsh 口径的分项
 */
export function toDshUsage(usage: KernelUsageLike): DshTokenUsage {
  const hit = usage.cacheHitTokens ?? 0
  const miss = usage.cacheMissTokens ?? Math.max(usage.inputTokens - hit, 0)
  return {
    inputTokens: Math.max(miss, 0),
    outputTokens: usage.outputTokens,
    cacheReadTokens: Math.max(hit, 0),
    cacheWriteTokens: 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    totalTokens: Math.max(miss, 0) + usage.outputTokens + Math.max(hit, 0),
  }
}

/** dsh 的 chunk 形状（只用到 `usage` 这一种；其余字段我们不发）。 */
export interface DshStreamChunk {
  readonly type: 'usage'
  readonly usage: DshTokenUsage
}

/** 事件名。抽成常量：发布侧与自检都引它，拼错一个字符就两边同时红。 */
export const LLM_STREAM_EVENT = 'llm/stream'

/**
 * 派发一次 `llm/stream`，把用量作为唯一 chunk 交给监听者链。
 *
 * @param ctx - 宿主上下文（waterfall 在它上面派发）
 * @param info - 本次调用的用量与会话归属
 * @returns 派发完成（无论有没有监听者）；永不抛错
 */
export async function publishDshUsage(ctx: unknown, info: LlmUsageInfo): Promise<void> {
  const chunk: DshStreamChunk = {
    type: 'usage',
    // 分项换算在一处：两个出口（流旁路与事件旁路）必须同一口径，不然同一个回合
    // 在两处会报出两个不同的数。
    usage: toDshUsage({
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      ...(info.cacheHitTokens === undefined ? {} : { cacheHitTokens: info.cacheHitTokens }),
      ...(info.cacheMissTokens === undefined ? {} : { cacheMissTokens: info.cacheMissTokens }),
      ...(info.reasoningTokens === undefined ? {} : { reasoningTokens: info.reasoningTokens }),
    }),
  }
  const next = async function* (): AsyncGenerator<DshStreamChunk> {
    yield chunk
  }
  try {
    // 形状按 cordis 的 waterfall 约定：最后一个参数是 next，监听者可以「包住」它。
    const dispatch = (ctx as { waterfall?: (name: string, ...args: unknown[]) => unknown }).waterfall
    if (typeof dispatch !== 'function') return
    const stream = dispatch.call(ctx, LLM_STREAM_EVENT, {
      sessionId: info.sessionId,
      provider: info.provider,
      model: info.model,
    }, next)
    const iterator = (stream as AsyncIterable<unknown> | undefined)?.[Symbol.asyncIterator]
    if (iterator === undefined) return
    // 必须消费完：插件在 `finally` 里记账与释放，不消费就永远不跑。
    for await (const ignored of stream as AsyncIterable<unknown>) void ignored
  } catch (error) {
    // 记账是旁路：插件抛错不该影响用户的回合。留一行 warn 给排查，不写进对话流。
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[dsh-compat] llm/stream 旁路派发失败（不影响回合）：${reason}\n`)
  }
}
