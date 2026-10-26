/**
 * 把 Pneuma 的回合过程，按 dsh 的 `session/event` 形状播出去。
 *
 * 为什么需要：dsh 的插件普遍**不听「日志文件变了」，而是订阅 `session/event`**
 * 这条广播——回合开合、步的开合、助手消息（带用量）、工具调用与结果。只做会话历史
 * 读取（core/dsh-compat/session-bridge）能让插件查到过去，但正在跑的这一轮它一无所知：
 * `dsh-cost-meter` 的统计预热等 `turn/end`，按事件对账的那部分等
 * `assistant/message` 里的 `usage`。2026-10-26 真包验收时确认过：缺了这条，
 * 那些功能安静地什么都不做。
 *
 * 这是**合成**，所以边界写在这里：
 *
 *   1. 只发我们真的知道的东西：`turn/start`、`step/start`、`assistant/message`
 *      （正文 + 推理 + 工具调用 + 用量）、`tool/call`、`tool/result`、`step/end`、
 *      `turn/end`、`user/message`。不认识的 dsh 事件类型一律不发，不编。
 *   2. `seq` 是我们自己从 0 起的连续计数，不是 dsh 会话日志里的 seq——它是给
 *      「活着的监听者」用的序号，不承诺能从磁盘复现同一串。
 *   3. 传出去的第一个参数是**只读会话视图**（`id` / `header` / `cwd` / 最近事件尾巴），
 *      不是 dsh 的 `Session` 实例：插件只能看，不能 `append`。真有插件去写，
 *      它在自己的代码里就会抛错——比我们假装支持、然后悄悄丢数据好。
 *   4. 用户消息里的图片**不进事件**（dsh 的 ImageBlock 要附件引用，我们给不出真的）。
 *      正文照发；要看图片走会话桥读历史。
 *   5. 助手消息的 `stream` 记录只还原「说了什么」，不还原逐 delta 的节奏——
 *      我们的流式增量走的是回调，没有 dsh 那种带时间戳的记录。
 *
 * 派发失败一律吞掉并留一行 stderr：广播是旁路，插件的记账绝不能把用户的回合带崩。
 *
 * @module dsc/core/dsh-compat/session-events
 */
import { randomUUID } from 'node:crypto'
import type { CoreEvent } from '../events.js'
import { toDshUsage, type DshTokenUsage } from './llm-usage-event.js'

/** 事件名。抽成常量：发布侧与自检都引它，拼错一个字符就两边同时红。 */
export const DSH_SESSION_EVENT = 'session/event'

/**
 * 只读会话视图的尾巴留多少条：够监听者回溯最近几步，又不把整段会话（含大段正文）
 * 常驻内存——一个会话一座桥，长会话不留无界状态。
 */
const TAIL_LIMIT = 64

/** dsh 的 TokenUsage（缓存字段在它那边是可选，我们统一补齐成数字）。 */
type TokenUsage = DshTokenUsage

/** dsh 的内容块（只用到 text / reasoning / tool-call 三种）。 */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }

/** 一个 dsh 会话语义上的「消息」（只看字段，不引它的包）。 */
interface MessageView {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: ContentBlock[]
  source: Record<string, unknown>
}

/** 发出去的一条事件。 */
export interface DshSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  /** 会改动模型可见面的那几类事件带这个；生命周期事件不许有。 */
  surfaceOp?: 'append'
}

/** 交给监听者的只读会话视图。字段名对着 dsh 的 Session，只留读得到的。 */
export interface DshSessionCarrierView {
  readonly id: string
  readonly header: { readonly id: string; readonly cwd?: string; readonly createdAt?: number }
  readonly cwd?: string
  /** 最近发出去的事件（最多 256 条）。 */
  readonly events: readonly DshSessionEvent[]
}

/** 桥的构造参数。 */
export interface DshSessionEventBridgeOptions {
  /** 宿主上下文：事件在它上面派发（兼容层插件的监听器也在同一棵树上）。 */
  readonly ctx: unknown
  readonly sessionId: string
  readonly cwd?: string
  readonly createdAt?: number
  /**
   * 当前路由。每条助手消息都要带 provider / model（dsh 的 MessageSource 要求），
   * 而我们的用量事件只带 model——所以问一次宿主要答案。
   */
  readonly route?: () => { provider: string; model: string }
}

/** 桥的对外面。 */
export interface DshSessionEventBridge {
  /** 投喂一条内核事件。非回合事件自动忽略，永不抛错。 */
  publish(event: CoreEvent): void
  /** 交给监听者的那个只读视图。 */
  readonly carrier: DshSessionCarrierView
}

/** 一次未定稿的助手消息：等用量到了再一起发（dsh 把它们放在同一条事件里）。 */
interface PendingAssistant {
  message: MessageView
  stream: Record<string, unknown>[]
  text: string
}

/**
 * 造一座桥。**一个会话一座**：`seq` / `turn` / `step` 都是它的内部状态。
 *
 * @param options - 会话身份、宿主上下文与路由读取方式
 * @returns 可以投喂内核事件的桥
 */
export function createDshSessionEventBridge(options: DshSessionEventBridgeOptions): DshSessionEventBridge {
  const { ctx, sessionId, cwd, createdAt, route } = options
  const header = {
    id: sessionId,
    ...(cwd === undefined ? {} : { cwd }),
    ...(createdAt === undefined ? {} : { createdAt }),
  }
  const tail: DshSessionEvent[] = []
  const carrier: DshSessionCarrierView = {
    id: sessionId,
    header,
    ...(cwd === undefined ? {} : { cwd }),
    get events() {
      return tail
    },
  }

  let seq = 0
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  let stepHasMessage = false
  /** 回合还没开就来了的用户消息：按 dsh 的顺序，它们属于接下来那个回合。 */
  const bufferedUsers: string[] = []
  /** 等用量的助手消息。 */
  let pending: PendingAssistant | null = null
  /** 最近一条错误事件的文案：回合以 error 收尾时它是 reason 里唯一有信息量的东西。 */
  let lastError = ''

  /** 派发一条事件；失败只留一行 stderr（广播是旁路）。 */
  function dispatch(event: DshSessionEvent): void {
    tail.push(event)
    if (tail.length > TAIL_LIMIT) tail.splice(0, tail.length - TAIL_LIMIT)
    try {
      const emit = (ctx as { emit?: (name: string, ...args: unknown[]) => unknown } | null | undefined)?.emit
      if (typeof emit !== 'function') return
      emit.call(ctx, DSH_SESSION_EVENT, carrier, event)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[dsh-compat] session/event 旁路派发失败（不影响回合）：${reason}\n`)
    }
  }

  /** 组装一条完整事件（seq 自增、时间取当下）。 */
  function make(type: string, data: Record<string, unknown>, surface = false): DshSessionEvent {
    const event: DshSessionEvent = {
      type,
      seq,
      time: Date.now(),
      data,
      ...(surface ? { surfaceOp: 'append' as const } : {}),
    }
    seq += 1
    return event
  }

  /** 开一步（一次模型调用 + 它的工具）。 */
  function openStep(): void {
    if (turn <= 0) return
    step += 1
    stepOpen = true
    stepHasMessage = false
    dispatch(make('step/start', { turn, step }))
  }

  /** 关掉当前这一步（没开就什么都不做）。 */
  function closeStep(): void {
    if (!stepOpen) return
    stepOpen = false
    stepHasMessage = false
    dispatch(make('step/end', { turn, step }))
  }

  /** 定稿一条助手消息：带不带用量都发出去。 */
  function flushAssistant(usage?: TokenUsage): void {
    if (pending === null) return
    const current = pending
    pending = null
    if (!stepOpen) openStep()
    if (stepOpen) stepHasMessage = true
    const data: Record<string, unknown> = {
      turn,
      step,
      message: current.message,
      stream: current.stream,
    }
    if (usage !== undefined) data['usage'] = usage
    dispatch(make('assistant/message', data, true))
  }

  /** 回合收尾前把手上所有半成品落定。 */
  function flushAll(): void {
    flushAssistant()
  }

  /** 把一条用户消息发出去。 */
  function emitUser(text: string): void {
    if (!turnOpen) {
      bufferedUsers.push(text)
      return
    }
    dispatch(
      make(
        'user/message',
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        },
        true,
      ),
    )
  }

  return {
    carrier,
    publish(event: CoreEvent): void {
      try {
        switch (event.type) {
          case 'user': {
            // 回合没开时先收着：dsh 的顺序是 turn/start 在前。
            emitUser(event.text)
            return
          }
          case 'turn/start': {
            flushAll()
            closeStep()
            turn += 1
            turnOpen = true
            dispatch(make('turn/start', { turn }))
            while (bufferedUsers.length > 0) {
              const text = bufferedUsers.shift()
              if (text !== undefined) emitUser(text)
            }
            return
          }
          case 'context': {
            // 请求组装完、流还没开：正好是 dsh 的「一步开始」。重试会让同一轮再来一条
            // context——那还是同一步（这一步的助手消息还没定稿），不另开。
            if (!turnOpen) return
            if (stepOpen && stepHasMessage) {
              flushAssistant()
              closeStep()
            }
            if (!stepOpen) openStep()
            return
          }
          case 'message': {
            flushAll()
            if (!stepOpen) openStep()
            const blocks: ContentBlock[] = []
            if (event.text !== '') blocks.push({ type: 'text', text: event.text })
            if (event.reasoning !== '') blocks.push({ type: 'reasoning', text: event.reasoning })
            for (const call of event.toolCalls ?? []) {
              blocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
            }
            const router = route?.()
            const now = Date.now()
            const stream: Record<string, unknown>[] = []
            if (event.text !== '') {
              stream.push({ type: 'chunk', time: now, chunk: { type: 'text-delta', index: 0, text: event.text } })
            }
            pending = {
              message: {
                id: randomUUID(),
                role: 'assistant',
                content: blocks,
                source: { kind: 'model', provider: router?.provider ?? '', model: router?.model ?? '' },
              },
              stream,
              text: event.text,
            }
            return
          }
          case 'usage': {
            // 与 llm/stream 那条旁路同一份换算：分项互斥，别把命中按未命中价再收一次。
            const usage = toDshUsage({
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              ...(event.cacheHitTokens === undefined ? {} : { cacheHitTokens: event.cacheHitTokens }),
              ...(event.cacheMissTokens === undefined ? {} : { cacheMissTokens: event.cacheMissTokens }),
            })
            if (pending !== null) {
              pending.stream.push({ type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage } })
              flushAssistant(usage)
            }
            return
          }
          case 'tool/call': {
            flushAll()
            if (!stepOpen) openStep()
            dispatch(make('tool/call', { turn, step, callId: event.callId, name: event.name, arguments: event.args }))
            return
          }
          case 'tool/result': {
            flushAll()
            if (!stepOpen) openStep()
            const failed = event.error !== undefined
            dispatch(
              make(
                'tool/result',
                {
                  turn,
                  step,
                  message: {
                    id: randomUUID(),
                    role: 'tool',
                    content: [{ type: 'text', text: event.text }],
                    source: { kind: 'tool', callId: event.callId },
                    toolCallId: event.callId,
                    ...(failed ? { isError: true } : {}),
                  },
                  ...(failed ? { error: { name: 'ToolError', code: event.error as string, reason: event.text } } : {}),
                },
                true,
              ),
            )
            return
          }
          case 'turn/end': {
            flushAll()
            closeStep()
            if (!turnOpen) return
            turnOpen = false
            const reason =
              event.reason === 'completed'
                ? { kind: 'completed' }
                : event.reason === 'aborted'
                  ? { kind: 'aborted', reason: { kind: 'user' } }
                  : {
                      kind: 'error',
                      // 内核先发 error 再发 turn/end，把它记住：只写「这一轮失败了」
                      // 等于把唯一的诊断信息丢掉。
                      error: { message: lastError === '' ? '这一轮失败了（没有更多信息）' : lastError, code: 'UNKNOWN' },
                    }
            lastError = ''
            dispatch(make('turn/end', { turn, reason }))
            return
          }
          case 'error': {
            // dsh 没有通用的「出错了」事件：失败是 turn/end 的 reason。记下来，随它一起发。
            lastError = event.message
            return
          }
          default:
            return
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[dsh-compat] session/event 消息映射失败（不影响回合）：${reason}\n`)
      }
    },
  }
}
