/**
 * 旁问的会话内状态（2026-10-25）。
 *
 * 为什么不用 useState 挂在组件里：旁问有三个入口（选区浮钮、命令面板、快捷键），而页签本身
 * 会被关掉重开——状态挂在组件上，关一次就丢。这里放一张**模块级**的表，按会话 id 分桶：
 * 切会话各看各的，重启即清空（与 dsh-btw 的「不落盘」同一口径）。
 *
 * @module dsc-ui-shell/plugins/ask/store
 */
import { createSignal } from '@dsc/ui'

/** 一条旁问的状态。 */
export type AskStatus = 'running' | 'done' | 'stopped' | 'error'

/** 一条旁问（问题 + 引用 + 答案）。 */
export interface AskBubble {
  id: string
  question: string
  quote: string
  answer: string
  status: AskStatus
  /** 答完才有的模型名与耗时（毫秒）。 */
  model?: string
  ms?: number
  /** status = 'error' 时给用户的那句话（已过 humanizeError）。 */
  error?: string
}

/** 空桶共用一份：每帧新建数组会让 useSyncExternalStore 白白重渲染。 */
const EMPTY: readonly AskBubble[] = Object.freeze([])

const buckets = new Map<string, readonly AskBubble[]>()
/** 变更通道：桶是按会话 id 分的 Map，值不在信号里——写完喊一声，页签各自重读（`createSignal` 的 notify 用法）。 */
const askChannel = createSignal(0)
/** 打开页签时带过去的引用（一次性的：页签读到就清）。 */
let pendingQuote: string | null = null
/** 每来一次打开请求 +1：页签靠它知道「有新引用要我读」。 */
let pendingVersionOf = 0

/** 订阅（useSyncExternalStore 的接口）。 */
export function subscribeAsk(listener: () => void): () => void {
  return askChannel.subscribe(listener)
}

/** 某个会话的旁问列表（引用稳定：没变过就是同一个数组）。 */
export function askSnapshot(sessionId: string): readonly AskBubble[] {
  return buckets.get(sessionId) ?? EMPTY
}

/** 打开请求的版本号（页签订阅它：每来一次请求就 +1）。 */
export function pendingVersion(): number {
  return pendingVersionOf
}

/** 读走并清空「打开时带过来的引用」。 */
export function takePendingQuote(): string | null {
  const quote = pendingQuote
  pendingQuote = null
  return quote
}

/** 请求打开页签（可带一段引用）。 */
export function requestAskOpen(quote?: string): void {
  pendingQuote = quote ?? null
  pendingVersionOf += 1
  askChannel.notify()
}

/** 改某一桶（纯函数式更新）。 */
export function updateAsk(
  sessionId: string,
  change: (list: readonly AskBubble[]) => readonly AskBubble[],
): void {
  buckets.set(sessionId, change(askSnapshot(sessionId)))
  askChannel.notify()
}

/** 追加一条。 */
export function addBubble(sessionId: string, bubble: AskBubble): void {
  updateAsk(sessionId, (list) => [...list, bubble])
}

/** 改一条（按 id）。 */
export function patchBubble(sessionId: string, id: string, patch: Partial<AskBubble>): void {
  updateAsk(sessionId, (list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))
}

/** 追加一段正文增量（流式答案）。 */
export function appendAnswer(sessionId: string, id: string, delta: string): void {
  if (delta === '') return
  updateAsk(sessionId, (list) => list.map((item) => (item.id === id ? { ...item, answer: item.answer + delta } : item)))
}

/** 删一条。 */
export function removeBubble(sessionId: string, id: string): void {
  updateAsk(sessionId, (list) => list.filter((item) => item.id !== id))
}
