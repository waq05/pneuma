/**
 * 验收切片：Super Agent 的第三种来源 `webhook`，只发不收。
 *
 * ## 这个文件证明什么
 *
 * 上游 `dsh-superagent/src/sources/kind.ts` + `registry.ts` 的设计目标是「加一种来源只写一个
 * 插件包」。本包不改主包一行：只实现一个 `SourceKind<WebhookConfig>`，交给
 * `SourceRegistry.register` 登记。注册表负责领体检项、解析实例配置、校验策略段、按 channel
 * 分发消息；本文件只声明它的形状与发送方式。
 *
 * ## 为什么是「只发不收」
 *
 * webhook 在这套契约里的定位是**出站渠道**：触发某件事的地方把消息交给运行期的出站队列，
 * 由 `SourceRegistry.send` 按 `message.channel.source === 'webhook'` 找到这里再 POST 出去。
 * 它不接收外部事件，所以：
 *   - 不实现 `threadContext`（不产生 Trigger，评估没有东西可读）；
 *   - `scope()` 永远 `{ listened: true, observed: false }`（听自己产出的全部，一条也不观察）；
 *   - 策略段只有一张 `allowed` 名单（策略段 schema 强制要 `allowed`），准入表不参与判定。
 *
 * ## 和飞书 / GitHub 的差别（都是契约允许的省略）
 *
 * 飞书 `feishuKind` 有 `threadContext` / `find` / `repliesTo` / `environment` / `refreshLabels`，
 * GitHub 有 `threadContext` / `find`；这里一个都没有。`SourceKind` 上这些都是可选的，省略不是
 * 偷工减料：没有入站消息就没有线程上下文可读，没有仓库/机器人身份就没有环境变量可算。
 *
 * ## 出站地址从哪来
 *
 * `SourceChannel.send` 的签名只拿得到 `message` 与 `commands`，**拿不到实例配置**（契约如此：
 * 发送时按消息自己的 channel 找 kind）。所以出站地址与密钥放在
 * `message.channel.address` 里，键是 `url` / `secret` / `target`：
 *   - `url`：绝对 http(s) 地址，必填；不合法直接抛（可重试的投递失败）；
 *   - `secret`：可选，非空时放进 `X-Webhook-Secret` 请求头；
 *   - `target`：可选，对应设置里 `targets` 表的 `name`，只做投递记录里的标识。
 * 这样 kind 的发送实现是纯函数，不需要去注册表里反查配置，也就不用把实例配置塞进发送路径。
 *
 * @module dsc/packages/superagent-webhook/webhook
 */
import { z } from 'zod'
import type { ChannelLink, FieldSpec, Localized, SourceKind } from '@pneuma/superagent/sources/kind.js'
import type { SourceContext } from '@pneuma/superagent/sources/host.js'

/** 行身份：与 `cordis.patch.yml` 的行 id、设置里 `sources.webhook` 的键同一个字符串。 */
export const WEBHOOK_SOURCE = 'webhook'

/** 本 kind 拥有的体检项名：注册表注册时替它领，别的部分不许上报同名项。 */
export const WEBHOOK_HEALTH = 'webhook'

/** 一条 http(s) 地址；空串是「还没配置」，不是「配错了」。 */
const HTTP_URL = /^https?:\/\/[^\s]+$/

/** 投递超时：webhook 端点卡住时不让出站队列一直挂着。 */
const TIMEOUT_MS = 10_000

/** 地址是不是 http(s)；`config.url` 与 `channel.address.url` 用同一条判据。 */
export function isHttpUrl(value: string): boolean {
  return HTTP_URL.test(value)
}

/** 一条通知目标：`name` 是准入表与投递记录里的标识，`address` 是它的 POST 地址。 */
const WebhookTargetSchema = z.object({
  name: z.string().trim().min(1).max(60),
  address: z.string().trim().max(2048).regex(HTTP_URL, 'Write an http(s) URL'),
}).strict()

/**
 * 实例配置。
 *
 * 为什么 `url` 允许空串（界面上却算「必填」）：注册表 `resolve` 在存下来的配置校验不过时
 * 会退回 `schema.parse({})` 再停用实例（`sources/registry.ts:155-158`），schema 若要求非空，
 * 这条退路自己会抛，整个 `instances()` 就崩了。所以「必填」落在行为上：空串 = 未配置，
 * 体检报暂停、`channel.allowed` 一律拒绝，而不是让配置解析失败。
 */
export const WebhookConfigSchema = z.object({
  url: z.string().trim().max(2048).refine(value => value === '' || isHttpUrl(value), 'Write an http(s) URL, or leave it empty until it is configured').default(''),
  secret: z.string().max(500).default(''),
  pollSeconds: z.number().int().min(5).max(3600).default(60),
  targets: z.array(WebhookTargetSchema)
    .refine(list => new Set(list.map(item => item.name)).size === list.length, 'Duplicate target names')
    .default([]),
}).strict()
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>

/** 出站消息的形状直接取自契约的 `channel.send` 第二个参数，不从主包拖 core 的运行时模块。 */
type OutboundMessage = Parameters<NonNullable<SourceKind<WebhookConfig>['channel']>['send']>[1]

/**
 * 发一条消息：POST JSON 到 `message.channel.address.url`。
 *
 * 返回值按契约分三种情况：
 *   - 2xx → `'sent'`；
 *   - 404 / 410 → `'gone'`（目标端点已经不要这类消息了，重试没有意义）；
 *   - 其余非 2xx 或网络失败 → 抛错（投递失败、以后重试可能成功，出站队列据此重试）。
 *
 * `_host` 用不上：webhook 不需要执行器命令，只发 HTTP。留着这个形参是因为契约签名要求它。
 */
export async function sendWebhook(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const address = message.channel.address
  const url = address['url'] ?? ''
  if (!isHttpUrl(url)) throw new Error('The webhook channel address is not an http(s) URL')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const secret = address['secret']
  if (secret !== undefined && secret !== '') headers['x-webhook-secret'] = secret
  const body = {
    source: WEBHOOK_SOURCE,
    id: message.id,
    kind: message.kind,
    text: message.text,
    ...message.ticketId === undefined ? {} : { ticketId: message.ticketId },
    ...address['target'] === undefined ? {} : { target: address['target'] },
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (response.status === 404 || response.status === 410) return 'gone'
  if (!response.ok) throw new Error(`The webhook answered HTTP ${String(response.status)}`)
  return 'sent'
}

/** 通道地址的界面链接：地址本身可点，非 http(s) 时给空串（契约里空 URL = 没有可点的链接）。 */
export function linkWebhook(address: Record<string, string>): ChannelLink {
  const url = address['url'] ?? ''
  return { url: isHttpUrl(url) ? url : '', label: { zh: 'Webhook 地址', en: 'Webhook address' } }
}

/**
 * 策略段的 `allowed` 名单。
 *
 * 只发不收的来源其实没有「谁能发起工作」这件事，但 `SourcePolicyPart` 要求策略段必须有
 * `allowed`（契约 `sources/kind.ts:41-54`），而且设置页要画第一行 `allowed`。这里保留它：
 * 名单是「允许这个渠道对谁说话」的声明，准入表（`admission`）不参与本来源的判定。
 */
const WebhookPolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).default([]),
}).strict()

/** 一张准入行的三格：与主包 `AdmissionRowView` 同形；本来源三格全 false（从不接收消息）。 */
const NO_CELLS = { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } as const

/** 设置面上的字段声明：`text`（地址 / 密钥）、`rows`（目标表）、`fact`（只读出站说明）。 */
const FIELDS: FieldSpec[] = [
  { key: 'url', type: 'text', label: { zh: '默认 Webhook 地址', en: 'Default webhook URL' },
    hint: { zh: 'http(s) 地址，消息 POST 到这里；留空表示还没配置。单个目标可以用下面的表覆盖它。', en: 'An http(s) URL that receives the POSTed messages; empty means not configured yet. A single target may override it below.' } },
  { key: 'secret', type: 'text', label: { zh: '签名密钥', en: 'Signing secret' },
    hint: { zh: '非空时随请求头发 X-Webhook-Secret；设置页明文显示，正式环境请用只读部署密钥。', en: 'Sent as X-Webhook-Secret when non-empty; the settings page shows it in clear text, so use a read-only deployment secret in production.' } },
  { key: 'targets', type: 'rows', label: { zh: '通知目标', en: 'Notification targets' },
    hint: { zh: '每条记录一个投递目标：名字做标识，地址是 POST 的 http(s) URL。没有记录时用上面的默认地址。', en: 'One record per delivery target: a name as the identifier and an http(s) POST URL. With no records the default URL above is used.' },
    columns: [
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' } },
      { key: 'address', type: 'text', label: { zh: '地址', en: 'Address' } },
    ] },
  { key: 'delivery', type: 'fact', label: { zh: '投递方式', en: 'Delivery' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '刷新间隔 / 秒', en: 'Refresh interval / seconds' },
    hint: { zh: '只刷新体检格（配置是否就绪、有几个目标），不探测远端可达性。', en: 'Only refreshes the health cell (whether the configuration is ready and how many targets exist); it does not probe the remote endpoint.' } },
]

/**
 * webhook 来源的 kind 描述。注册进 `SourceRegistry` 之后：
 *   - `instances()` 多出一行 `webhook`，设置页按 `fields` 画出地址 / 密钥 / 目标表 / 只读事实；
 *   - `sources.healthEntries(['webhook'])` 有它的一格，插件轮询往里写状态；
 *   - `sources.send` 把 `channel.source === 'webhook'` 的消息交给下面的 `sendWebhook`。
 */
export const webhookKind: SourceKind<WebhookConfig> = {
  kind: WEBHOOK_SOURCE,
  title: { zh: 'Webhook', en: 'Webhook' },
  description: {
    zh: '只发不收的出站渠道：智能体把通知 POST 到配置的 http(s) 地址，不接收消息，也不产生 Trigger。',
    en: 'An outbound-only channel: the agent POSTs notices to configured http(s) URLs; it receives no messages and produces no Triggers.',
  },
  schema: WebhookConfigSchema,
  fields: FIELDS,
  health: [WEBHOOK_HEALTH],
  // 只发不收：听自己产出的全部（`listened`），一条都不观察（`observed`）。
  scope: () => ({ listened: true, observed: false }),
  channel: {
    // 只有「来源已配置 + 消息地址是 http(s)」时才允许回话；实例停用由注册表先拦。
    allowed: (address, config) => isHttpUrl(config.url) && isHttpUrl(address['url'] ?? ''),
    send: sendWebhook,
    link: linkWebhook,
  },
  policy: {
    schema: WebhookPolicySchema,
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '允许对这个渠道说话的账号', en: 'Accounts that may speak through this channel' },
        hint: { zh: '只做声明与展示：本来源不接收消息，准入表不参与判定。', en: 'Declaration and display only: this Source receives no messages, so the admission table does not decide anything here.' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '账号 ID', en: 'Account ID' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
    ],
    explicit: {
      zh: 'webhook 来源只出站：不存在「对它说」的消息，因此没有明确请求，准入表也不适用。',
      en: 'The webhook Source is outbound only: no message ever speaks to it, so it makes no explicit request and its admission table never applies.',
    },
    rows(config) {
      const parsed = WebhookConfigSchema.safeParse(config)
      const targets = parsed.success ? parsed.data.targets : []
      const rows = targets.map(target => ({
        id: target.name,
        label: target.name,
        note: { zh: '仅出站目标', en: 'Outbound target' },
        cells: { ...NO_CELLS },
      }))
      // 至少一行：没有配置目标时也给一行说明，设置页的准入表不会空着像加载失败。
      return rows.length > 0 ? rows : [{
        id: 'outbound',
        label: { zh: '仅出站', en: 'Outbound only' },
        note: { zh: '不接收消息，准入表不适用于这个来源', en: 'Receives no messages; the admission table does not apply to this Source' },
        cells: { ...NO_CELLS },
      }]
    },
  },
  // 部署事实：`facts()` 只拿得到 deployment，webhook 与仓库/机器人身份无关，这里说明投递方向。
  facts: (): Record<string, Localized | string> => ({
    delivery: { zh: '仅出站：不接收消息，也不产生 Trigger', en: 'Outbound only: receives no messages and creates no Triggers' },
  }),
}
