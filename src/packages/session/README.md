# session（会话）

一句话：session 包管「当前是哪个会话」这件事——从 jsonl 读历史、往 jsonl 追加消息，以及会话库的归档、恢复、删除、改名、置顶与分叉。

## Model Experience（模型体验）

- 不注册工具、不注册命令、不注册提示词块：本包只 provide `session` 服务（index.ts:352）。
- 模型这一轮看到的历史来自 `ctx.session.current().messages`，那份历史是 jsonl 逐行重放出来的（core/session.ts:3-4）。
- 会话级状态条目也走它：`appendState('model'|'todos'|'goal'|…)` 写进 jsonl，恢复会话时用 `state(id)` 读回（读端例子见 llm/index.ts:71、todo/index.ts:100-101）。
- 换会话只从这里广播：`ctx.emit('dsc/session-open', …)` 一发（index.ts:122、323），提示词里的工作目录与环境快照跟着换。
- 本包只交出 `messages` 与 `meta.cwd`，把它们拼成一次请求的是 `agent` 循环（agent/index.ts:53 同时 inject llm、compact、prompt）。
- 停用之后，模型侧没有历史可发：`ctx.session` 不存在，声明 `inject: ['session']` 的包大面积挂不上（如 llm/index.ts:53、todo/index.ts:96）。

## Known Limitations（已知限制）

- 不承诺同一个 jsonl 能被两个进程同时写：常驻 agent 攥着写租约，`open()` 遇到它攥着的会话时复用实例，而不是再 load 一份（index.ts:113-119）。
- 会话打开失败只发一条通知，不重试也不回滚到上一条（index.ts:123-125）。
- 归档与删除都不能作用于当前正在看的会话（index.ts:163-164、226-228）。
- 编辑历史（rewind）只作用于当前会话，且这一轮还在跑时拒绝（index.ts:282-289）。
- 与 dsh 同族能力的差异：待确认，本包只在注释里说「对齐 dsh 的会话实例常驻 + openState 短路」（index.ts:91），没有列出差异。

## 行与开关

- 行 id `session`，包名 `@pneuma/session`，order 20。
- resolution 是 pinned：应用安装目录里的这一份优先（core/plugin-loader.ts:1306-1312）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 为空：本包不依赖其它服务，只 provide `session`（index.ts:47-49）。
- 启动参数由宿主给 `{ resumeSessionPath, cwd }`（host/kernel.ts:47）；`resumeSessionPath` 为 `'auto'` 表示沿用上次的会话指针（index.ts:58）。
