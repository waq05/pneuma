# host-stdio（宿主协议桥）

一句话：host-stdio 包把 `ui` 服务（DscRuntime）暴露成宿主协议，桌面 Electron 壳拉起这个无头进程后靠它双向通信。

## Model Experience（模型体验）

- 不注册工具：它是传输层，把 `invoke` / `exit` 收进来，把 `hello` / `result` / `snapshot` / `ui-url` 发出去（index.ts:56-79、226-239）。
- 对模型的间接影响之一：它登记 `interactive` 服务，审批插件据此判断「有没有人能点卡」，没人就立刻按拒，不白等超时（index.ts:195-198、approval/index.ts:423-427）。
- 对模型的间接影响之二：它同时是侧栏浏览器链路的实现方，缺了它 `browser_dock` 会直接报「宿主里没有桌面壳」（index.ts:17-20、338-351）。
- 提示词贡献为零：没有 `ctx.prompt` 调用。
- 停用之后，模型侧少掉：没人能回答审批卡时的「立刻拒」判定改为按终端是否 TTY 猜；桌面壳连不上界面，这条链路整个消失。

## Known Limitations（已知限制）

- 只在有宿主时可用：stdio 传输那头是管道或远端，永远不会有桌面主进程来答 browser-* 请求，`available()` 只认 parentPort（index.ts:83-90）。
- 协议版本 3，宿主版本对不上会被拒绝握手（index.ts:46-52）。
- stdout 只承载协议消息，非 JSON 行容错忽略——往 stdout 打日志会污染协议（index.ts:4）。
- 方法白名单：不在 `isInvokableMethod` 表里的调用直接回错误，不会被执行（index.ts:226-229）。
- 快照按 80ms 起节流推送（可调 16~1000ms），节流是「一帧最密的间隔」而不是先等一个窗口（index.ts:191-222、core/snapshot-throttle.ts:17-27）。

## 行与开关

- 行 id `host-stdio`，包名 `@pneuma/host-stdio`，order 9010。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 一个服务 `ui`（index.ts:188）；运行时另外 provide `interactive`（index.ts:198）与 `HOST_BROWSER_SERVICE`（index.ts:351）。
- 双传输自动探测：进程带 `process.parentPort` 走结构化克隆，否则走每行一个 JSON 的 stdio（index.ts:6-10、110-112）。
