# dsh-compat（dsh 插件兼容）

一句话：dsh-compat 包是 dsh（DeepSeek Harness）外部插件的兼容层，补上 logger 服务与模块解析钩子，并把 DSH_HOME 钉到 Pneuma 的家。

## Model Experience（模型体验）

- 不注册工具：它补三处兼容——`logger` 服务、模块解析钩子、工具形状适配（工具类型适配在 loader 侧，本包只提供开关语义）（index.ts:5-20）。
- 对模型的贡献是间接的：外部 dsh 插件能挂上，它们自己的工具才进得了工具表；少了本包，那些插件一声明 `inject: ['logger']` 就永远等不到服务（index.ts:6-9）。
- 把插件的 warn / error 镜像进对话流：文案经 `Logger.format` 还原 printf 占位符，前缀标「dsh 插件·名字」，info / debug 不转以防刷屏（index.ts:45-55）。
- 提示词贡献为零：没有 `ctx.prompt` 调用。
- 停用之后，模型侧少掉：dsh 插件带进来的那些工具，以及它们写进对话流的告警。

## Known Limitations（已知限制）

- 明确不支持的 dsh 服务：inject 里出现 `sessionProjections`、`agents`、`goals`、`systemPrompt` 的插件挂载时会响亮报错——那要整个 dsh 会话语义，个人版不背（index.ts:19-20）。
- risk 映射按插件条目配置；dsh 没有风险等级这个概念，缺省是每次调用都过审批卡（index.ts:16-17）。
- 一律覆盖 `DSH_HOME`：从 dsh 终端里启动 Pneuma 会继承 `DSH_HOME=~/.dsh`，照抄等于让插件把账本写进 dsh 的家；想换 Pneuma 的家请设 `DSC_HOME`（index.ts:38-43）。
- 只有 warn / error 进 transcript，info / debug 留在日志管道里（index.ts:45-47）。
- 模块解析钩子只对插件目录里的导入方生效，普通工程代码的模块解析不受影响（index.ts:12-14）。
- 默认关：官方可开关插件（index.ts:2、cordis.patch.yml 的 `disabled: true`）。

## 行与开关

- 行 id `dsh-compat`，包名 `@pneuma/dsh-compat`，order 3780。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认关：cordis.patch.yml 里写着 `disabled: true`。
- inject 一个服务 `transcript`（index.ts:32）；provide 一个服务 `logger`（index.ts:33、66）。
- 挂载时同步注册一次模块解析钩子（幂等），loader 在挂外部插件前还会再调一次（index.ts:35-36）。
