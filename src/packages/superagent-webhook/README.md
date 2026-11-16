# Super Agent Webhook

一句话：给 Super Agent 加一种**只发不收**的 webhook 来源；它不改主包一行，只实现一个 `SourceKind` 并注册进 `SourceRegistry`，用来验证「加第三种来源」是插件级扩展。

包里的三样东西：

- `webhook.ts`：`SourceKind<WebhookConfig>`（`kind: 'webhook'`、zod schema、`fields` 含 `rows` / `fact`、`health: ['webhook']`、只出的 `channel`、策略段与准入行、`scope`）；
- `index.ts`：cordis 入口（`name` / `inject: ['orchestrator']` / `apply`），从 `ctx.get('orchestrator')` 拿 `SourceHost` 注册 kind，并用 `setInterval` 刷新本来源的体检格；
- `tests/`：真 `SourceRegistry` + 真 `HealthBoard` + 真 `SettingsSchema` 的验收用例。

## Model Experience

- 插件默认关。打开后，设置 → Super Agent 的来源区按 `webhookKind.fields` 多出四格：默认地址、签名密钥、通知目标表、投递方式（只读事实）。
- 工单结束时，出站队列按 `message.channel.source === 'webhook'` 找到本 kind，把 `{ source, id, kind, text, ticketId?, target? }` 以 JSON POST 到 `message.channel.address.url`；地址里的 `secret` 进 `X-Webhook-Secret` 请求头。
- 2xx 算送达，404/410 算目标已不要（不重试），其余非 2xx 与网络失败抛给出站队列重试。
- 体检格 `webhook` 按 `pollSeconds` 刷新：停用时报 `Off`，没填地址报 `Waiting for a webhook URL`，配好报 `Outbound only; N target(s)`。

## Known Limitations

- 只发不收：没有入站触发、没有线程上下文、没有 `find` / `repliesTo` / `environment`；`scope()` 固定 `{ listened: true, observed: false }`。
- `SourceChannel.send` 的签名拿不到实例配置，所以出站地址与密钥必须由消息的 `channel.address` 带上（键 `url` / `secret` / `target`），kind 自己不去注册表反查配置。
- 设置契约的 `SettingsField` 有 `rows` / `fact` 两支，但主包当前的来源字段投影（`host/settings-section.ts`）把 `rows` 画成逗号分隔的文本框、把 `fact` 画成 `info` 行；真正的表格控件要等主包改成投影 `rows` / `fact`。
- 设置契约没有「密文」控件，`secret` 在设置页明文显示；正式环境请用只读的部署密钥。
- 主包 `@pneuma/superagent` 的 `package.json` 还没有 `./sources/*` 子路径导出：本包源码里的契约引用是 `import type`，编译后擦除，所以运行时不需要它；仓库外的作者按裸包名构建时会解析失败（见交接报告）。
- 刷新定时器只写体检格，不探测远端可达性；端点是否活着要等一次真实投递才知道。
