# compact（压缩）

一句话：上下文快装不下时，compact 包把旧历史折成一份摘要，并把不许被摘要改写的文本原样接在摘要后面。

## Model Experience（模型体验）

- 不注册工具，注册 `/compact` 命令（index.ts:436-446）；这条命令不吃参数，多打的字会被提示用法。
- 自动触发线 = min(窗口 × 80%, 窗口 − 输出预留 − 安全余量)，余量按窗口 6.4% 算、封顶 65536（index.ts:278-287；80% 是 69 行的缺省值）。
- 摘要请求复用主对话前缀：系统提示词取自 prompt 服务、工具目录取自 tools 服务（index.ts:198-205），让摘要调用成为上一次真实请求的前缀扩展，好命中服务端缓存。
- 摘要之外保留最近 20 条原文（`DEFAULT_KEEP_RECENT`，packages/session-core/compact.ts:38）；自动压缩时还按窗口 16% 折成 token 预算（index.ts:171-182）。
- 压缩包里多一段「原样带过去」的文本：`registerCarry` 收集各功能点登记的文本，拼在摘要之后（index.ts:207-214）；任务清单与会话目标各登记一段（todo/index.ts:139、goal/index.ts:184-188）。
- 停用之后，模型侧少掉这道兜底：上下文跑到窗口上限只能等请求报错；`registerCarry` 不存在，todo 与 goal 也挂不上（两者都 inject compact）。

## Known Limitations（已知限制）

- 摘要由模型生成，原文不保证保住：只有 `registerCarry` 登记的那几段与最近 20 条是原样。
- 回合跑着时拒绝手动压缩，只发一条提示（index.ts:394-402）。
- 压一次不一定够：补压次数默认 1、最多 3（index.ts:91-92）；补完仍超阈值只报数，不保证成功（index.ts:344-349）。
- 阈值依赖 llm 给的路由与窗口，`inject` 里缺 llm / tools / prompt 任一个都挂不上（index.ts:148）。
- 与 dsh 同族能力的差异：待确认，本包注释多处写「口径对齐 dsh」（index.ts:268-274、439），但没有列出差异。

## 行与开关

- 行 id `compact`，包名 `@pneuma/compact`，order 200。
- resolution 是 pinned：应用安装目录里的这一份优先（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 六个服务：`llm`、`session`、`commands`、`settings`、`prompt`、`tools`（index.ts:148）。
- 设置分区 id `compact`，九个可调值（保留条数 5..200、触发线 50..95%、保留占比 5..40%、补压 0..3 等，见 index.ts:449 起）。
