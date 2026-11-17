/**
 * 逐字移植自上游 `src/sources/registry.ts`（138 行）。
 * 改动只有两处：
 *   ① import 路径：`../core/index.ts` → `../core/index.js`；`../policy.ts` → `../core/policy.js`（本仓
 *      Policy 在 `core/`）；`../infra/commands.ts` / `../infra/health.ts` / `./kind.ts` 只差 NodeNext 的
 *      `.js` 扩展名（目录已按上游镜像，相对深度与上游一致）。
 *   ② 注释译成中文、`@module` 换成 `dsc/packages/superagent/sources/registry`。
 * 与上游的差异逐条列在这里：构造签名（三个位置参数，健康板子默认 `new HealthBoard()`）、健康项的领取与
 * 释放（`board.claim` 拿 `HealthEntry`、`entry.release()` 还）、方法名、判定顺序、「孤儿实例」「schema
 * 失败降级并停用」「`sync:` 前缀健康名保留给设置层」全部逐条对齐；`find` / `repliesTo` 原样搬
 * （本仓还没有调用方，等接线后用）。
 *
 * 已安装来源 kind、它们的已配置实例，以及引擎那个 `SourceScope` 的实现。
 *
 * @module dsc/packages/superagent/sources/registry
 */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.js'
import type { Commands } from '../infra/commands.js'
import { HealthBoard, type HealthEntry } from '../infra/health.js'
import { AdmissionTableSchema, type Settings } from '../core/policy.js'
import type { ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.js'


/**
 * 管理已注册的 SourceKind 插件，校验它们的实例配置与策略配置，并替引擎实现 `SourceScope`。
 * 注册每个 kind 时在健康板子上领走它声明的体检项，并替 Runtime、Settings、Outbox、MasterAssessor 中转
 * 通道、链接、环境变量与线程上下文读取器。
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /** 注册一个 SourceKind，在健康板子上领走它声明的体检项（拒绝 `sync:` 前缀，那是设置层的），返回注销函数。 */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); release(); unregistered() }
  }
  /**
   * 返回 `names` 里当前活跃的健康格子。Source 上下文写的是它被造出来时拿到的格子，
   * 所以注册结束之后、哪怕同名 kind 又注册了，旧的报告也写不进新格子。
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** 每个已注册 kind 的实例按 ID 排序在前，后面跟着设置里存了、但 kind 没装的孤儿实例（配置原样保留）。 */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).map(kind => ({ ...this.resolve(kind, settings.sources[kind.kind]), installed: true }))
    const orphaned = Object.entries(settings.sources).filter(([id]) => !this.kinds.has(id)).map(([id, stored]) => ({ id, kind: id, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kinds.get(id)
    return kind ? this.resolve(kind, settings.sources[id]) as SourceInstance<C> : undefined
  }
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const kind = this.kinds.get(id)
    if (!kind) throw new Error(`Source kind not installed: ${id}`)
    return { enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** 拿每个 Source 的策略段对它自己的 kind 校验；没装的 Source kind 的策略段原样保留。 */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kinds.get(id)?.policy
      // `admission` 由 Policy 自己的 schema 校验（所有 kind 共用一张表），kind 只校验自己那一段的其余部分。
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kinds.get(id)?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kinds.get(channel.source)
    if (!kind) return false
    const instance = this.resolve(kind, settings.sources[channel.source])
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** 每个已安装 kind 的环境变量声明，启用与停用的都算。 */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  environments(settings = this.settings()) {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => {
      const instance = this.resolve(kind, settings.sources[kind.kind])
      return kind.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * 按消息自己的 Channel 找到 kind，幂等地把它发出去；kind 没装时返回 `'waiting'`，
   * 目标（或没有 channel 的 kind）永远收不了话时返回 `'gone'`。
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kinds.get(message.channel.source)
    if (!kind) return 'waiting'
    return kind.channel ? kind.channel.send({ commands }, message) : 'gone'
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.kinds.get(channel.source)?.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  /**
   * 把搜索词交给每个声明了 `find` 的 kind，合并去重。
   * 本仓还没有调用方（设置页的搜索、主会话的资源检索都要等接线），签名先按上游留着。
   */
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.values()].flatMap(kind => kind.find ? [kind.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  /** 只有来源自己知道「这条 Trigger 回的是哪条消息」时才有值；没声明的 kind 返回 undefined，不联网猜。 */
  repliesTo(trigger: Trigger): string | undefined { return this.kinds.get(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kinds.get(trigger.source)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const { config } = this.resolve(kind, settings.sources[kind.kind])
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kinds.get(input.source)
    const stored = settings.sources[input.source]
    // 没有 kind 插件就判定不了存下来的范围，所以设置里配了、插件却没装的 Source 一条都不听（与上游一致）。
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind, stored)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** 存下来的配置校验不过时：退回 schema 默认值，并把实例降成停用。 */
  private resolve(kind: SourceKind, stored: { enabled: boolean; config: Record<string, unknown> } | undefined): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id: kind.kind, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}
