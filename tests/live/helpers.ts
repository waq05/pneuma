/**
 * 真模型冒烟的公共设施（设计 §10）：环境变量、内核配置、会话读面。
 *
 * ## 与 harness 的分工
 *
 * 起内核仍然走 `tests/harness.ts` 的 `bootKernel`：它已经做了三件必须做对的事——
 * 拒绝在真实主目录上起内核、铺隔离主目录（关长期记忆 / OS 沙箱 / 会话标题，后两者
 * 会多发请求并 spawn 子进程）、以及等回合真正结束。这里只把供应商换成真实端点。
 *
 * ## 模型能力为什么写死
 *
 * live 层验的是「真模型能不能把这条链跑通」，不是「端点上报的模型能力对不对」。
 * 能力面给一份保守值（纯文本、无思考档位）就够了：思考档位一旦声明，选中的档位会
 * 变成请求字段，多一个变量就多一处与 live 目标无关的失败点。
 *
 * @module dsc/tests/live/helpers
 */
import { bootKernel, type BootedKernel } from '../harness.js'

/** 官方地址：设计 §10.1「缺省用官方地址」。产品面向 DeepSeek 兼容端点。 */
export const DEFAULT_LIVE_BASE_URL = 'https://api.deepseek.com/v1'
/** 缺省模型：与官方 v1 端点的对话模型同名。 */
export const DEFAULT_LIVE_MODEL = 'deepseek-chat'

/** live 层的环境读数。 */
export interface LiveEnv {
  apiKey: string
  baseUrl: string
  model: string
}

/** key 配了没配（空串也算没配——CI 的 secret 缺失时给的是空串，不是 undefined）。 */
export function liveKeyConfigured(): boolean {
  const key = process.env.DSC_LIVE_API_KEY
  return key !== undefined && key.trim() !== ''
}

/**
 * 读 live 环境变量。
 *
 * @throws 没配 key 时抛错——调用方必须先 `describe.skipIf(!liveKeyConfigured())`，
 *   真跑到了却读不到 key 属于编排错误，不能静默跳过（设计 §10.3 防假绿）。
 */
export function liveEnv(): LiveEnv {
  const apiKey = process.env.DSC_LIVE_API_KEY?.trim() ?? ''
  if (apiKey === '') throw new Error('live 用例被执行了，但 DSC_LIVE_API_KEY 没配——编排错误，拒绝假绿')
  const baseUrl = process.env.DSC_LIVE_BASE_URL?.trim() ?? DEFAULT_LIVE_BASE_URL
  const model = process.env.DSC_LIVE_MODEL?.trim() ?? DEFAULT_LIVE_MODEL
  return { apiKey, baseUrl, model }
}

/** 把 live 环境拼成内核配置（供应商名固定 `live`，会话日志里读得到）。 */
export function liveKernelConfig(env: LiveEnv = liveEnv()): Record<string, unknown> {
  return {
    providers: {
      live: {
        name: 'live',
        displayName: 'Live',
        baseUrl: env.baseUrl,
        apiKey: env.apiKey,
        models: [
          {
            id: env.model,
            name: env.model,
            contextWindow: 128_000,
            maxTokens: 8_192,
            // 保守能力面：纯文本、无思考档位（见文件头「模型能力为什么写死」）。
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
            modalities: ['text'],
          },
        ],
      },
    },
    defaultProvider: 'live',
    defaultModel: env.model,
  }
}

/** live 会话里的一条消息（只声明断言用到的字段）。 */
export interface LiveMessage {
  role: string
  content?: unknown
  tool_calls?: { id: string; type?: string; function?: { name?: string; arguments?: string } }[]
  tool_call_id?: string
}

/** 内核里 live 用例够得到的服务面。 */
export interface LiveSurface {
  on(event: string, listener: (...args: unknown[]) => void): () => void
  agent: {
    followup(text: string): void
    interrupt(filePath?: string): void
    isRunning(filePath: string): boolean
  }
  session: { current(): { filePath: string; messages: LiveMessage[] } }
  compact?: { forceCompact(): Promise<boolean>; run(): Promise<void> }
}

/** 起一个连真模型的内核（调用方负责 `dispose`）。 */
export async function bootLiveKernel(): Promise<BootedKernel> {
  const env = liveEnv()
  return bootKernel({ providerBaseUrl: env.baseUrl, config: liveKernelConfig(env), surface: 'none' })
}

/** 把 `bootKernel` 的不透明 ctx 窄化成 live 用例读得懂的服务面。 */
export function surfaceOf(kernel: BootedKernel): LiveSurface {
  return kernel.ctx as unknown as LiveSurface
}

/** 当前会话的消息（浅拷贝：断言里排序不会改到内核状态）。 */
export function currentMessages(kernel: BootedKernel): LiveMessage[] {
  return [...surfaceOf(kernel).session.current().messages]
}

/** 消息里的纯文本（content 可能是字符串或内容块数组）。 */
export function textOf(message: LiveMessage): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

/** 所有助手正文拼起来（包含工具调用轮里的说明文字）。 */
export function assistantText(kernel: BootedKernel): string {
  return currentMessages(kernel)
    .filter((message) => message.role === 'assistant')
    .map(textOf)
    .join('\n')
}

/** 所有工具结果拼起来（工具调用的输出）。 */
export function toolText(kernel: BootedKernel): string {
  return currentMessages(kernel)
    .filter((message) => message.role === 'tool')
    .map(textOf)
    .join('\n')
}

/**
 * 发一条消息并在 `interruptAfterMs` 后打断，等回合结束事件。
 *
 * 为什么不用 `runTurn`：它等的是「回合自然结束」，而 L4 要验的正是被打断之后的收尾。
 * 监听要在 `followup` **之前**挂（同步结束的回合会漏事件），与 harness 的说明同一条。
 */
export async function runTurnAndInterrupt(kernel: BootedKernel, text: string, interruptAfterMs = 1_500): Promise<void> {
  const surface = surfaceOf(kernel)
  const ended = new Promise<void>((resolveEnd) => {
    const off = surface.on('dsc/turn-end', () => {
      off()
      resolveEnd()
    })
  })
  surface.agent.followup(text)
  await new Promise((resolveTick) => setTimeout(resolveTick, interruptAfterMs))
  surface.agent.interrupt()
  await ended
  // 与 harness 的 runTurn 同一拍：给会话写流 80ms 落盘，随后才读得到最后一条。
  await new Promise((resolveTick) => setTimeout(resolveTick, 80))
}
