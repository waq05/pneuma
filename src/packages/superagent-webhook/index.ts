/**
 * Super Agent 的第三种来源：`webhook`（只发不收）的 cordis 插件入口。
 *
 * ## 装配顺序
 *
 * 1. 从 `ctx.get('orchestrator')` 拿 `SourceHost`——那是主包 `app/runtime.ts` 构造时
 *    `ctx.provide('orchestrator', this)` 放上去的运行期，`sources` 属性就是 `SourceRegistry`；
 * 2. `ctx.effect` 里 `host.sources.register(webhookKind)`：注册 kind，注册表替它领 `webhook`
 *    体检项，返回的注销函数交给 effect 当清理函数；
 * 3. 另一个 `ctx.effect` 起本插件自己的 `setInterval`：每轮只刷新体检格（配置就绪没有、
 *    有几个目标），间隔取当前配置的 `pollSeconds`，配置改了下一轮自动换周期；effect 清理时
 *    `clearInterval`。
 *
 * ## 为什么轮询只写体检、不发送
 *
 * 「只发」这件事的驱动方是运行期的出站队列：工单结束时 `Outbox.send` 落一条回执，
 * `Passes` 的泵再按 `message.channel.source` 找到本 kind 的 `channel.send` 发出去
 * （`sources/registry.ts:111`）。本插件没有入站事件要收，所以定时器唯一能做、也唯一该做的
 * 事是把「这个来源现在是什么状态」写进注册表替它领的那格体检项；它不发网络请求，
 * 也不自己造消息，免得一个插件绕过运行期直接对用户端点发东西。
 *
 * ## 为什么没有单独的设置分区
 *
 * 来源的配置不再由来源插件自己画界面：主包 `host/settings-section.ts` 的 `sourceFields`
 * 遍历 `sources.instances()`，把每个 kind 的 `fields` 投影成设置页控件。本包只要把
 * `webhookKind.fields` 声明对（含 `rows` / `fact`），设置页就多出这几格——这正是本切片要
 * 证明的「加第三种来源 = 插件级扩展」。
 *
 * @module dsc/packages/superagent-webhook
 */
/** Cordis entry: registers the outbound-only webhook Source kind and keeps its health cell fresh. */
import type { Context } from '@deepseek-ai/cordis'
import type { SourceContext, SourceHost } from '@pneuma/superagent/sources/host.js'
import { isHttpUrl, WEBHOOK_HEALTH, WEBHOOK_SOURCE, webhookKind, type WebhookConfig } from './webhook.js'

/** 行身份：与 `cordis.patch.yml` 的 `id`、产物目录名三处一致。 */
export const name = 'superagent-webhook'

/**
 * 依赖的宿主服务：`orchestrator` 就是主包的 `Runtime`（`SourceHost`）。
 *
 * 只写这一个依赖：本插件不碰设置页、工具、会话，缺了别的服务也能装；`orchestrator`
 * 没起来之前 apply 不会跑，拿到它才能注册来源。
 */
export const inject = ['orchestrator']

/** 定时器的下限：`pollSeconds` 最小 5 秒，再小也不会比以前更频繁。 */
const TICK_FLOOR_MS = 5_000

/** 配置还没解析出来时的默认间隔，与 schema 的 `.default(60)` 一致。 */
const DEFAULT_POLL_SECONDS = 60

/**
 * 插件装配：注册 kind、起体检轮询，两件都挂在 `ctx.effect` 上，停用插件时自动清理。
 *
 * @param ctx - cordis 插件上下文（`orchestrator` 已就绪）
 */
export function apply(ctx: Context): void {
  const host = ctx.get('orchestrator')
  if (host === undefined) {
    // `inject` 保证 apply 运行时服务已在；这里只是把「契约被破坏」这一种情况说清楚，不静默降级。
    ctx.logger.warn('superagent-webhook: the orchestrator service is missing; the webhook Source was not started')
    return
  }
  ctx.effect(() => host.sources.register(webhookKind), 'superagent-webhook: sources.register')
  ctx.effect(() => pollHealth(host), 'superagent-webhook: health.poll')
}

/**
 * 起体检轮询。
 *
 * 用 `setInterval` 而不是递归 `setTimeout`：每轮开头先比一次周期，配置里的 `pollSeconds`
 * 变了就 `clearInterval` 再按新周期重建——设置保存后不用重启插件也能生效。
 *
 * @param host - 来源宿主（已注册 `webhookKind`，它们的体检格可以取到）
 * @returns 清理函数：停掉定时器
 */
function pollHealth(host: SourceHost): () => void {
  const source = host.context(webhookKind)
  let timer: ReturnType<typeof setInterval> | undefined
  let periodMs = 0
  const tick = (): void => {
    const config = source.config<WebhookConfig>(WEBHOOK_SOURCE)
    const nextPeriodMs = Math.max(TICK_FLOOR_MS, (config?.pollSeconds ?? DEFAULT_POLL_SECONDS) * 1000)
    if (nextPeriodMs !== periodMs) {
      periodMs = nextPeriodMs
      if (timer !== undefined) clearInterval(timer)
      timer = setInterval(tick, periodMs)
      // 只是体检的节奏，不该让进程为了它一直醒着（尤其桌面端退出时）。
      timer.unref()
    }
    report(source, config)
  }
  tick()
  return () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
}

/**
 * 把当前状态写进本 kind 领的那格体检项。
 *
 * `detail` 用英文原样写：主包 `HEALTH_TEXT` 是给各组件共用的固定模板，来源插件不能往里加
 * 自己的错误码（那会让界面层多一份翻译表），所以这里给一句自解释的状态文本。
 *
 * @param source - 本 kind 的来源上下文（`report` 只许写它声明过的体检项）
 * @param config - 解析后的实例配置；停用或没装时注册表给 `undefined`
 */
function report(source: SourceContext, config: WebhookConfig | undefined): void {
  const at = new Date().toISOString()
  if (config === undefined) {
    source.report(WEBHOOK_HEALTH, { state: 'paused', detail: 'Off', at })
    return
  }
  if (!isHttpUrl(config.url)) {
    source.report(WEBHOOK_HEALTH, { state: 'paused', detail: 'Waiting for a webhook URL', at })
    return
  }
  source.report(WEBHOOK_HEALTH, { state: 'ready', detail: `Outbound only; ${String(config.targets.length)} target(s)`, at })
}
