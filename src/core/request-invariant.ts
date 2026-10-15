/**
 * 运行时请求 invariant：校验「这次真的发给模型的消息」能不能从会话日志 + 投影链重建。
 *
 * 为什么要有它：投影链（plugins/prompt.ts 的 rewrite）约定是纯函数，但约定没人守时它
 * 不会自己响。一旦某个投影带随机数/时间戳、或者就地改了输入，模型看到的就和日志能重建的
 * 对不上——这种 bug 平时悄无声息，等用户发现「模型怎么记错了」时早已无从追溯。这里在
 * 调用点逐条比对，把「模型可见 ⟺ 日志可重建」钉成一条可执行的检查（对应 dsh 的
 * agent-loop invariant：请求 messages 与 `session.deriveMessages()` 逐字节相等）。
 *
 * 与 dsh 的取舍不同：dsh 在 `llm/stream` waterfall 里不符即 `fail`（杀请求）。dsc 选择
 * **只报不杀**——报出来人还能救（看 notice、去查是哪条投影），杀掉会话只会让用户白白丢
 * 一轮对话。所以本模块**绝不抛异常、绝不阻断请求、绝不 mutate 输入**；调用点拿到报告后
 * 自行决定怎么报。
 *
 * @module dsc/core/request-invariant
 */
import { contentText, type ChatMessage } from './llm.js'

/** 一次比对的结果。`ok:false` 时其余字段给出可行动的定位。 */
export interface InvariantReport {
  /** true = 发送侧与重建侧一致（或差异只落在尾部运行时注入段，见下）。 */
  ok: boolean
  /** 第一条对不上的下标（0 基，含头部 system）。 */
  firstDiffIndex?: number
  /** 人话原因：第几条起、两侧 role、总条数差。 */
  reason?: string
  /** 失配形状指纹：同一会话同一形状只报一次的去重键（不含正文，所以随机值也稳定）。 */
  digest?: string
}

/** content 相等：字符串/null 按值，数组按「逐段」比（不 stringify——图像 data URL 很大）。 */
function sameContent(a: ChatMessage['content'], b: ChatMessage['content']): boolean {
  if (typeof a === 'string' || a === null || a === undefined) {
    return typeof b === 'string' || b === null || b === undefined ? a === b : false
  }
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    if (x.type !== y.type) return false
    if (x.type === 'text') {
      if (y.type !== 'text' || x.text !== y.text) return false
    } else if (y.type !== 'image_url' || x.image_url.url !== y.image_url.url) {
      return false
    }
  }
  return true
}

/** 工具调用相等：id / type / 函数名 / 参数字符串逐个比。 */
function sameToolCalls(a: ChatMessage['tool_calls'], b: ChatMessage['tool_calls']): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!
    const y = b[i]!
    if (x.id !== y.id || x.type !== y.type || x.function.name !== y.function.name || x.function.arguments !== y.function.arguments) {
      return false
    }
  }
  return true
}

/**
 * 单条消息是否等价。只比协议上有意义的字段——`ts` 这类记账字段不算内容差异
 * （它是落库时刻，两次派生之间本来就不同，比它会制造误报）。
 */
function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.role === b.role &&
    a.tool_call_id === b.tool_call_id &&
    a.reasoning_content === b.reasoning_content &&
    sameContent(a.content, b.content) &&
    sameToolCalls(a.tool_calls, b.tool_calls)
  )
}

/**
 * 深到「足够抓就地改」的一份快照：消息对象、content 数组、tool_calls 数组与其中每项
 * 都复制一层（大字符串按引用共享——不可变，安全）。用来在投影链跑之前拍一份输入，
 * 之后与跑完的输入比，就能发现「投影就地改了它拿到的输入」。
 *
 * 为什么值得单独做：就地改比「结果不一致」更隐蔽——结果看着对，可被改的消息对象与
 * 会话日志是同一批引用，日志已经被写花了（下一次请求就带着花掉的历史）。
 */
export function snapshotMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const out: ChatMessage = {
      role: message.role,
      content:
        typeof message.content === 'string' || message.content === null || message.content === undefined
          ? (message.content ?? null)
          : message.content.map((part) =>
              part.type === 'text'
                ? { type: 'text' as const, text: part.text }
                : { type: 'image_url' as const, image_url: { url: part.image_url.url } },
            ),
    }
    if (message.reasoning_content !== undefined) out.reasoning_content = message.reasoning_content
    if (message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id
    if (message.tool_calls !== undefined) {
      out.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: call.type,
        function: { name: call.function.name, arguments: call.function.arguments },
      }))
    }
    if (message.ts !== undefined) out.ts = message.ts
    return out
  })
}

/**
 * 输入被就地改动的第一条下标；没被改返回 null。`before` 应是 {@link snapshotMessages}
 * 拍的快照，`after` 是投影链跑完的同一份输入。长度先比（塞/删一条最直观），再逐条比字段。
 */
export function firstMutatedIndex(before: readonly ChatMessage[], after: readonly ChatMessage[]): number | null {
  if (before.length !== after.length) return Math.min(before.length, after.length)
  for (let i = 0; i < before.length; i += 1) {
    if (!sameMessage(before[i]!, after[i]!)) return i
  }
  return null
}

/**
 * 运行时注入段的识别标记。这些段的正文由投影在请求尾部追加、内容依赖外部状态
 * （当天日期 / 钩子结果 / 编辑器诊断），天生不满足「重放可复现」；其中
 * `user-prompt-submit`、`lsp-write-diagnostics` 还会在第一次跑时消费掉待发队列，
 * 第二次派生必然少掉那一段。比对前把这些段从两侧都摘掉、剩下的正文再逐字节比——
 * 这是本模块唯一的放宽点，也是「零误报」的关键（对易变段放宽成结构比对）。
 *
 * 标记与来源一一对应（新增一类尾部注入时要往这里补一行）：
 *   - env-facts：`plugins/prompt.ts` 的 environmentSnapshot
 *   - lsp-write-diagnostics：`plugins/lsp.ts`
 *   - user-prompt-submit：`plugins/lifecycle-hooks.ts`
 */
const RUNTIME_INJECTION_MARKERS = [
  '本条是程序在每次请求时自动附上的当前环境快照',
  '【LSP 诊断】',
  '<external_content source="hook:',
]

/** 这条是不是「运行时注入段」（尾部追加、不要求重放可复现的 user 消息）。 */
function isRuntimeInjection(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  const text = contentText(message.content)
  return RUNTIME_INJECTION_MARKERS.some((marker) => text.includes(marker))
}

/** 摘掉运行时注入段，同时记住每条在原数组里的下标（报错要指回原位置）。 */
function stripRuntimeInjections(messages: readonly ChatMessage[]): Array<{ message: ChatMessage; index: number }> {
  const out: Array<{ message: ChatMessage; index: number }> = []
  messages.forEach((message, index) => {
    if (!isRuntimeInjection(message)) out.push({ message, index })
  })
  return out
}

/**
 * 校验「发出去的那份」(sent) 能不能从「按同一路径重新派生的那份」(derived) 重建。
 *
 * 两条判定，按顺序：
 *   1. **就地改输入**（`input` 给了才查）：投影改了它拿到的输入 → 直接判不一致。
 *      这条独立于「结果是否一致」——结果可能碰巧对，日志却已被污染。
 *   2. **逐条比对**：先按 {@link RUNTIME_INJECTION_MARKERS} 从两侧摘掉运行时注入段
 *      （易变段放宽），剩下的正文逐条比，第一条对不上即报出。
 *
 * 绝不抛异常、绝不 mutate 任何入参。
 *
 * @param sent - 真正要发出去的消息（组装 + 投影链的结果）。
 * @param derived - 按同一路径重新派生的结果。
 * @param input - 可选：投影链跑之前的输入快照与跑完的输入，用来查就地改动。
 */
export function checkReconstructable(
  sent: readonly ChatMessage[],
  derived: readonly ChatMessage[],
  input?: { before: readonly ChatMessage[]; after: readonly ChatMessage[] },
): InvariantReport {
  if (input !== undefined) {
    const mutated = firstMutatedIndex(input.before, input.after)
    if (mutated !== null) {
      const role = input.after[mutated]?.role ?? '（无）'
      return {
        ok: false,
        firstDiffIndex: mutated,
        reason: `投影就地改了输入：第 ${mutated + 1} 条（${role}）被就地改写，会话日志可能已被污染`,
        digest: `mut:${mutated}:${role}`,
      }
    }
  }
  const sentCore = stripRuntimeInjections(sent)
  const derivedCore = stripRuntimeInjections(derived)
  const max = Math.min(sentCore.length, derivedCore.length)
  let k = 0
  while (k < max && sameMessage(sentCore[k]!.message, derivedCore[k]!.message)) k += 1
  if (k === sentCore.length && k === derivedCore.length) return { ok: true }
  const roleA = sentCore[k]?.message.role ?? '（无）'
  const roleB = derivedCore[k]?.message.role ?? '（无）'
  // 定位回原数组下标：优先发送侧那条，发送侧没有（重建侧多出来）就用重建侧那条。
  const firstDiffIndex = sentCore[k]?.index ?? derivedCore[k]?.index ?? Math.max(sent.length, derived.length)
  const delta = sentCore.length - derivedCore.length
  return {
    ok: false,
    firstDiffIndex,
    reason: `第 ${firstDiffIndex + 1} 条起不一致（发送侧 ${roleA}，重建侧 ${roleB}；可比条数 ${sentCore.length} vs ${derivedCore.length}，差 ${delta >= 0 ? '+' : ''}${delta}）`,
    // digest 只取「可比位置 + 两侧 role」，不含长度：一个回合内多条请求的条数天然不同，
    // 带上长度会把同一处 bug 拆成多种形状、每轮重复报（去重就失效了）。
    digest: `${k}:${roleA}:${roleB}`,
  }
}
