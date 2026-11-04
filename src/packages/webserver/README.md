# webserver（本机界面服务）

一句话：webserver 是插件版界面的宿主半边：回环 HTTP + 一次性令牌 + 插件 bundle 下发，默认不占端口，桌面或 `DSC_UI_SERVER=1` 时才起来。

## Model Experience（模型体验）

- 不注册模型工具、不贡献提示词，模型侧看不到这个服务本身（index.ts:104-112）。
- 它会把插件装载问题写进会话流：没信任的第三方插件、api 不匹配、bundle 缺失都以 `transcript.system` 的形式进模型上下文（index.ts:259-264）。
- 那条 `transcript` 注入就是为这段准备的；少了它 `ensure()` 会整个 reject，桌面壳收不到界面地址（index.ts:107-111）。
- 停用后模型侧少了这些装载提示，界面也打不开（index.ts:300-305）。

## Known Limitations（已知限制）

- 默认不监听：只有桌面主进程要地址、`DSC_UI_SERVER=1`、或配置 `enabled: true` 才起（index.ts:6-8、97、300）。
- 端口 0 表示系统分配；非法或越界一律回落 0（index.ts:61-65）。
- 热更默认只在开发态开，打包态关；`DSC_UI_HMR=1` 或 `0` 可强开强关（index.ts:73-88）。
- 界面通道只放 `UI_METHODS` 列出的那批方法：凭据类、破坏性、任意命令执行、策略写入一律排除，实参还要过个数、类型、长度、枚举校验（index.ts:161-165、178-189）。
- 伺服哪份界面由 `assetsDir` 或 `DSC_UI_ASSETS` 决定，缺省是 `lib/ui/assets`（index.ts:16-18、99）。
- 地址只打印一次，且是带一次性令牌的那条；桌面主进程从服务上拿同一个地址，不解析 stdout（index.ts:10-11、266-267）。

## 行与开关

- 行 id `webserver`，包名 `@pneuma/webserver`，order 300（package.json:2、14）。
- resolution 是 overridable（package.json:15）；默认开：cordis.patch.yml 里没有 `disabled`。
- 宿主半 inject 两个服务：`ui` 与 `transcript`（index.ts:111）。
- provide `webServer`，两个成员：`ensure()` 与只读的 `running`（index.ts:271-283）。
- 卸载时先停数据通道再关服务，端口不留在已卸的插件手里（index.ts:285-298）。
