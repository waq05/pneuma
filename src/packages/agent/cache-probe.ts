/**
 * 缓存归因探针与工具定义排序：回答「这次请求的前缀和同会话上一次差在哪一段」。
 *
 * 为什么需要探针：命中率掉下来（实测遇到过单次 50%、5%）时，`ch`/`cm` 只能说明
 * 「没命中」，说明不了「从第几条消息开始断、是系统提示变了还是工具集变了」。这里把
 * 「第一条签名不同的消息下标 + system/tools 是否变」算出来，写进 `usage.jsonl` 那一行
 * （字段见 core/usage-log 的 `CacheBreakPoint`），排查时一眼指到具体组件。
 *
 * 默认关：只有 `DSC_CACHE_PROBE=1` 才计算与记录。每一轮要给全部消息做 sha256，虽然只是
 * 毫秒级，但这不是产品功能，没人排查时不该占任何开销——关着时 {@link CacheProbe.observe}
 * 第一行就返回，连签名都不算。
 *
 * 只记录、不改请求。这边同时做的工具定义排序（{@link sortToolSchemas}）是产品行为，
 * 与探针开关无关，任何情况下都执行：同一组工具不论插件注册先后，序列化出来逐字节相同，
 * 前缀缓存才不会被「顺序没变但排法飘了」白断一次。
 *
 * @module dsc/packages/agent/cache-probe
 */
import { createHash } from 'node:crypto'
import type { ChatMessage, StreamRequest, ToolSchema } from '@pneuma/runtime/core/llm.js'
import type { CacheBreakPoint } from '@pneuma/runtime/core/usage-log.js'

/** 一个进程里最多记多少条会话的「上一次请求」；超出按最久没动的淘汰。 */
const MAX_SESSIONS = 64

/** 探针开关：只认字面 `1`，别的值（`true` / `false` / 空串）一律当关。 */
export function cacheProbeEnabled(): boolean {
  return process.env['DSC_CACHE_PROBE'] === '1'
}

/** 一次请求里参与前缀比较的三部分，全部压成 16 位十六进制。 */
export interface RequestPrefix {
  /** 全部 system 消息正文（fold 前可能不止一条）。 */
  system: string
  /** 工具定义的 name + 描述 + 参数；按名字排序后序列化。 */
  tools: string
  /** 逐条消息的签名，下标与 `messages` 一一对应。 */
  messages: string[]
  /** 与 `messages` 等长；只为给断点带上角色名，不进比较。 */
  roles: ChatMessage['role'][]
}

/** sha256 取前 16 位：够区分，又不至于让日志行变长。 */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** 工具名比较：按 UTF-16 码元，不用 localeCompare（它随系统语言变，跨机器会飘）。 */
function byName(a: ToolSchema, b: ToolSchema): number {
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

/**
 * 把工具定义按名字字典序排好（浅拷贝，不改调用方那份）。
 *
 * 没有工具（undefined / 空数组）时原样返回同一个对象：请求体里本来就没有这一项，
 * 多造一份拷贝只会让「这次请求是不是同一个对象」的引用判断失效。
 */
export function sortToolSchemas(request: StreamRequest): StreamRequest {
  if (request.tools === undefined || request.tools.length === 0) return request
  return { ...request, tools: [...request.tools].sort(byName) }
}

/** system 正文签名：多条 system 拼起来算一次（fold 之后本来就是一条）。 */
function systemDigest(messages: readonly ChatMessage[]): string {
  return digest(
    messages
      .filter((message) => message.role === 'system')
      .map((message) => JSON.stringify(message.content))
      .join('\n'),
  )
}

/** 工具定义签名：排序后逐条序列化；没有工具记空串（与「工具有但都是空定义」区分开）。 */
function toolsDigest(tools: readonly ToolSchema[] | undefined): string {
  if (tools === undefined || tools.length === 0) return ''
  return digest(JSON.stringify([...tools].sort(byName).map((tool) => [tool.name, tool.description, tool.parameters])))
}

/**
 * 一条消息的签名。
 *
 * 参与的是**发到 wire 上的字段**（core/llm 的 serializeMessages 只留 role/content/
 * reasoning_content/tool_calls/tool_call_id）；`ts`/`files`/`origin` 不进请求，
 * 把它们算进来会让「界面记账变了」被误报成「前缀断了」。
 */
function messageDigest(message: ChatMessage): string {
  return digest(
    JSON.stringify({
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoning_content,
      toolCalls: message.tool_calls,
      toolCallId: message.tool_call_id,
    }),
  )
}

/** 算一份请求的前缀签名（纯函数，方便单测直接喂假请求）。 */
export function requestPrefix(request: Pick<StreamRequest, 'messages' | 'tools'>): RequestPrefix {
  return {
    system: systemDigest(request.messages),
    tools: toolsDigest(request.tools),
    messages: request.messages.map(messageDigest),
    roles: request.messages.map((message) => message.role),
  }
}

/**
 * 比两次请求的前缀，给出断点；不该算断点（第一次请求、只追加消息）时返回 undefined。
 *
 * 判据：
 * - 逐条比消息签名，第一个不同的下标就是 `at`；
 * - 消息**变短**（压缩/投影删了历史）也算断，`at` 取「被删掉的第一条」的下标；
 * - 消息**变长且旧前缀全同**是纯追加，不算断点（这是最理想的一轮）；
 * - system / tools 单独给标记：它们变了但消息没变时 `at = -1`（断在消息列表之外）。
 */
export function comparePrefix(previous: RequestPrefix, next: RequestPrefix): CacheBreakPoint | undefined {
  const sys = previous.system !== next.system
  const tools = previous.tools !== next.tools
  const shared = Math.min(previous.messages.length, next.messages.length)
  let at = -1
  for (let index = 0; index < shared; index += 1) {
    if (previous.messages[index] !== next.messages[index]) {
      at = index
      break
    }
  }
  if (at === -1 && next.messages.length < previous.messages.length) at = next.messages.length
  if (at === -1 && !sys && !tools) return undefined
  const role = at < 0 ? undefined : (next.roles[at] ?? previous.roles[at])
  return {
    at,
    ...(role === undefined ? {} : { role }),
    ...(sys ? { sys: true } : {}),
    ...(tools ? { tools: true } : {}),
  }
}

/** 一条会话的探针状态：上一次请求的签名 + 还没被 usage 事件取走的断点。 */
interface ProbeEntry {
  prefix: RequestPrefix
  break?: CacheBreakPoint
}

/**
 * 按会话记「上一次请求」的探针（有界，最多 {@link MAX_SESSIONS} 条）。
 *
 * 生命周期：`stream` 包装层每次发请求前 `observe`；usage 事件落盘时 `take` 取走。
 * 为什么按会话分：后台 agent 与当前查看的 agent 会交替发请求，混在一起比会把两条
 * 无关会话的首条差异当成同一条的前缀断。
 */
export class CacheProbe {
  private readonly entries = new Map<string, ProbeEntry>()

  /** 记下这次请求的前缀，与同会话上一次比出断点留给下一次 usage 落盘。关闭时整段旁路。 */
  observe(sessionId: string, request: Pick<StreamRequest, 'messages' | 'tools'>): void {
    if (!cacheProbeEnabled()) return
    const prefix = requestPrefix(request)
    const previous = this.entries.get(sessionId)
    const breakPoint = previous === undefined ? undefined : comparePrefix(previous.prefix, prefix)
    this.put(sessionId, { prefix, ...(breakPoint === undefined ? {} : { break: breakPoint }) })
  }

  /**
   * 取走这次请求的断点（取后清空）。
   *
   * 取走而不是读：usage 事件是异步到达的，不排空的话下一次请求失败、没有 usage 时，
   * 下一条无关的 usage 会拿到上一轮的旧断点。
   */
  take(sessionId: string): CacheBreakPoint | undefined {
    if (!cacheProbeEnabled()) return undefined
    const entry = this.entries.get(sessionId)
    if (entry === undefined) return undefined
    const breakPoint = entry.break
    delete entry.break
    return breakPoint
  }

  /** 当前记着多少条会话（有界性测试与排查用）。 */
  get trackedSessions(): number {
    return this.entries.size
  }

  private put(sessionId: string, entry: ProbeEntry): void {
    if (this.entries.has(sessionId)) {
      // 重新插到队尾：Map 的迭代序就是「最久没动」的顺序，淘汰先删队头。
      this.entries.delete(sessionId)
    } else if (this.entries.size >= MAX_SESSIONS) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(sessionId, entry)
  }
}
