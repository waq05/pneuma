/**
 * 移植自上游 `src/sources/host.ts`（67 行）。改动只有两条：
 *   ① import 路径：`../core/index.ts` → `../core/index.js`（NodeNext 扩展名）；`Commands` / `Deployment` /
 *      `FeishuBot` / `SetupProblem` / `Tally` 改成从各自真实模块取，`fill` 改从 `../infra/text.js` 取
 *      （与上游同模块，只差扩展名）。目录已按上游镜像，所以相对深度与上游一致。
 *   ② 两处缝，各标一行 TODO：`Key` / `Family` 本地别名（上游在 `kv.ts`，TODO(P9-C)）、
 *      `SourceAgent = unknown`（上游是 dsh 的 `Agent`，TODO(P9-G/J)）。
 * 与上游的差异逐条列在这里：能力清单与命名一个没动——`deployment` / `commands` / `ready` /
 * `configured` / `problem` / `config` / `receive` / `atomic` / `state` / `threads` / `tickets` /
 * `triggers` / `notify` / `report`，以及 `SourceHost` / `ThreadDescription` / `sourceContext` 全部保留；
 * `HEALTH_TEXT` 的英文模板照抄，中文由界面层按 `code` 翻，契约层不自创错误码。
 *
 * Host 与上下文接口：来源插件与应用之间的能力接缝；界面面板也会 import 这一份，所以它不能引 Node 专属模块。
 *
 * @module dsc/packages/superagent/sources/host
 */
import type { ChannelRef, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger } from '../core/index.js'
import type { Commands } from '../infra/commands.js'
import type { Deployment } from '../deployment.js'
import type { SourceRegistry } from './registry.js'
import type { SetupProblem } from '../setup.js'
import { fill } from '../infra/text.js'

// TODO(P9-C): 上游在 `kv.ts` 里定义 `Key` / `Family`；本仓按批次约定先留本地别名，接线时改成 `import type { Family, Key } from '../kv.js'`。
/** KV 记录的键，值类型是 `V`；纯字符串表示无类型的键（上游 `kv.ts:11`）。 */
export type Key<V> = string & { readonly __value?: V }
/** 共享前缀的 KV 键族：可调用（用名字各部分拼出键），并暴露 `prefix` 供列举（上游 `kv.ts:13`）。 */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
// TODO(P9-G/J): 上游是 `@deepseek-ai/dsh-agent` 的 `Agent`；本仓还没有会话句柄这一层，先收不透明值。
export type SourceAgent = unknown

/** 固定的英文体检模板（`{name}` 占位符）；面板按 `code` 翻成当前界面语言。 */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuCliUnset: 'The Source is on, and its bot lark-cli is not set',
  feishuBotMissing: 'Waiting for the Feishu bot',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string> }
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
}

/** 一个来源发布在线程上的显示名、URL 与事实（`null` 表示删掉这条事实）。 */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
export interface SourceHost {
  readonly sources: SourceRegistry
  /** 返回一个来源 kind 的上下文；它的 `report` 只能写这个 kind 声明过的体检项。 */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
/** 暴露给来源 kind 的应用能力：读状态、灌 Trigger、管线程与工单、上报体检。 */
export interface SourceContext {
  readonly deployment: Deployment
  readonly commands: Commands
  readonly ready: Promise<void>
  /** 设置解析出仓库与账号之后才是 true；来源只在此时开始轮询。 */
  configured(): boolean
  /** 让这个 Source 的账号跑不起来的那一个设置问题；目前只有飞书机器人检查会上报。 */
  readonly problem?: SetupProblem | undefined
  /** 这个 kind 处在启用状态时返回它的配置，停用或没装时返回 undefined。 */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** 把一条 Trigger 灌进引擎并安排下一轮评估；调用方应先等它完成再推进读游标。 */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  atomic<T>(work: () => T): T
  /** 来源作用域的 KV 记录（比如读游标）；写 `undefined` 表示删掉一条。 */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** 重读线程后设置或删除（`undefined`）它 `meta` 里的键；线程不存在时什么都不做。 */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** 未结束的工单，新的在前。 */
    open(): Ticket[]
    /** 把一张未结束的工单绑到某个来源线程上（`own` = 这条线程是这张单自己开的），此后由线程关闭而不是 ready 报告来结束它。 */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** 报告被跟的线程在 `at` 关闭了；凡是跟它的未结束工单，在不再有自己开的线程开着、也没有恢复的在跑之后各结束一次。 */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; /** 线程上最新的一条 Trigger。 */ latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  /** 上报这个 kind 声明过的某一格体检项；未声明的名字抛错。 */
  report(entry: string, health: Health): void
}
export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }): SourceContext => host.context(kind)
