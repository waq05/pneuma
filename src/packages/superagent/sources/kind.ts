/**
 * 逐字移植自上游 `src/sources/kind.ts`（115 行）。
 * 改动只有三处：
 *   ① import 路径：`../core/index.ts` → `../core/index.js`；`../deployment.ts` → `../deployment.js`；
 *      `../infra/commands.ts` → `../infra/commands.js`（目录已按上游镜像，相对深度与上游一致）。
 *   ② `Agent`（`@deepseek-ai/dsh-agent` 的会话句柄）→ `SourceAgent`：本仓还没有会话句柄这一层，
 *      `ThreadContext.image` / `TriggerContext.image` 先收一个不透明值（缝在 `./host.js`，TODO(P9-G/J)）；
 *   ③ 注释译成中文、`@module` 换成 `dsc/packages/superagent/sources/kind`。
 * 与上游的差异逐条列在这里：除上面三处外没有。契约字段一个没少——`rows` / `fact` / `images` /
 * `image` 全保留；我们设置契约现在只有 text / number / select / switch 四种，`rows` / `fact` 要等
 * 契约补齐后才有界面（那是后面批次的事，不是删掉上游字段的理由）。
 *
 * SourceKind 插件契约：配置 schema、设置表单字段、策略扩展、出站通道、线程上下文读取。
 *
 * @module dsc/packages/superagent/sources/kind
 */
import type { z } from 'zod'
import type { OutboundMessage, ScopeResult, Trigger } from '../core/index.js'
import type { Deployment } from '../deployment.js'
import type { Commands } from '../infra/commands.js'
import type { SourceAgent, SourceContext, SourceHost } from './host.js'

export interface Localized { zh: string; en: string }
/** `advanced` 把一个不常改的字段（比如轮询间隔这类可调项）折进卡片的 Advanced 区。 */
interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }
/**
 * 配置字段规格；`rows` 按首列编辑一组记录，`choose` 从已解析的来源标签里选，`fact` 展示 `facts` 里的只读值。
 */
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'select'; options: { value: string; label: Localized }[] }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized }
  | FieldBase & { type: 'fact'; settings?: 'deployment' }
  | FieldBase & { type: 'rows'; columns: ({ key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; choose?: Localized; refresh?: Localized } | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] })[] }

export interface VariableSpec { key: string; description: Localized }
export interface EnvironmentInput<C> { deployment: Deployment; config: C; trigger?: Trigger }
export interface AdmissionRowView { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }
/** 一个来源 kind 的策略扩展：允许的发送者、准入表行，以及可选的外部名单同步。 */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  /** 校验 Policy 里属于这个 Source 的那一段，含 `allowed`（能发起工作的发送者）。 */
  schema: z.ZodType<P>
  /** 策略段的表单字段；第一个是 `allowed`。 */
  fields: FieldSpec[]
  /** 说明这个 Source 把什么算作「对智能体说」——允许名单里的人发起明确请求时，这一位得成立。 */
  explicit: Localized
  /** 没列进名单的人类或机器人发送者，在原始 ID 不可读时用的兜底显示名。 */
  unnamed?: { person: Localized; bot: Localized }
  /** 准入表在 `config` 下的接收范围（与 `scope().row` 对得上）；没有 `rows` 的 kind 用表的默认行。 */
  rows?(config: Record<string, unknown>): AdmissionRowView[]
  /** 可选的外部名单同步（比如群成员）；`ready` 报告 `part` 里有没有可刷新的目标。 */
  sync?: { label: Localized; ready(part: P): boolean; run(host: SourceHost, part: P, signal: AbortSignal): Promise<P> }
}
/** 通道地址对应的界面链接；`triggerId` 指一个 Trigger，有它自己的深链时优先用那条。 */
export interface ChannelLink { url: string; label: Localized; triggerId?: string }
export type ChannelLinks = Partial<Pick<Deployment, 'repository' | 'feishu'>>
/** 一个来源 kind 的线程出站发送适配器。 */
export interface SourceChannel<C> {
  /** 还能不能往 `address` 回话；没有这个方法时，所有地址都能收回复。 */
  allowed?(address: Record<string, string>, config: C): boolean
  /**
   * 按 ID 幂等地发一条；目标会话不再收回复时返回 `'gone'`。
   * @throws 投递失败、但以后重试可能成功时抛。
   */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
  /** 返回 `address` 的 URL 与标签；`links` 缺所需部署信息时 `url` 为空串。 */
  link(address: Record<string, string>, links: ChannelLinks): ChannelLink
}
/** 线程上下文读取器归一化后的消息；`bot` 标记非人类发送者，这类消息本身永远不能授权工作（顶多是推断候选）。 */
export interface ContextMessage {
  id: string; from: string; at: string; text: string
  bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number
}
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }
/** 评估用来读 Trigger 周边消息与图片的、有上限的线程上下文读取器。 */
export interface ThreadContext<C> {
  /** Trigger 自己那条消息在它所在 Thread 的消息里的 ID。 */
  messageId(trigger: Trigger): string
  /** 读一页线程消息（`thread`，`cursor` 省略时是第一页）、话题根（`root`），或被回复的那条（`parent`）。 */
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
  /** 从消息正文里认出 `image` 能读的图片 key；不支持图片的 kind 不实现。 */
  images?(text: string): string[]
  /** 把 Trigger 所在 Thread 里某条消息的一张图读成 `agent` 的附件。 */
  image?(agent: SourceAgent, commands: Commands, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
export interface TriggerContext {
  readonly messageId: string
  read(commands: Commands, part: ContextPartName, cursor?: string): Promise<ContextPart>
  images(text: string): string[]
  /** @throws kind 不支持图片时。 */
  image(agent: SourceAgent, commands: Commands, message: { id: string; text: string }, key: string, stateDir: string,
    signal: AbortSignal): Promise<unknown>
}
/** 注册进 SourceRegistry 的可插拔来源 kind 描述。 */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  /** 稳定 ID；设置里没存这个 kind 的实例时，按同 ID 给一份默认实例。 */
  kind: string
  title: Localized
  description: Localized
  /** 由 `deployment` 推出来的只读状态事实（等部署期间是 undefined），按字段 key 索引。 */
  facts?(deployment: Deployment | undefined): Record<string, Localized | string>
  /** 校验存下来的与提交上来的配置，并补齐默认值。 */
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** 这个 kind 拥有的 `health[...]` 体检项名；别的 kind 与核心循环都不许上报这些名字。 */
  health: string[]
  /** 这个 kind 的 Trigger（或记录下来的 Mandate 依据）的接收规则；没有 `scope` 的 kind 收自己产出的全部、但一条都不观察。 */
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  /** 出站回复适配器；没有 `channel` 的 kind 不产出回复，也不做通道检查。 */
  channel?: SourceChannel<C>
  /** 评估用的有界上下文读取器；没有 `threadContext` 的 kind 在评估时一条上下文都不读。 */
  threadContext?: ThreadContext<C>
  /** 把搜索词映射成候选 Thread key（如 `github:12`）与 Trigger 搜索词（如飞书的 `om_` ID）。 */
  find?(query: string): { threads: string[]; terms: string[] }
  /** 不联网就能推出来时，返回「这条 Trigger 回的是哪条消息」的 ID。 */
  repliesTo?(trigger: Trigger): string | undefined
  /** 发送者有自己身份体系的 kind 的策略段。 */
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  /** 重新读行 key 的显示名（比如群名），把解析到的名字存进 `KV.sources.labels(kind)` 并返回。 */
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>
  /** 这个 kind 向执行环境注册的变量，以及它们的值怎么算。 */
  environment?: { variables: readonly VariableSpec[]; values(input: EnvironmentInput<C>): Record<string, string> }
}

export interface SourceInstance<C extends Record<string, unknown> = Record<string, unknown>> { id: string; kind: string; enabled: boolean; config: C }
