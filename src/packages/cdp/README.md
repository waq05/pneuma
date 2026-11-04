# cdp（CDP 底层库）

一句话：Chrome DevTools Protocol 的传输、动作、快照与启动器，被三个功能包共用同一份实现。

## Model Experience（模型体验）

- 库包本身不注册工具、不写提示词、不登记快照片段；没有 `apply`，只做再导出（index.ts:1-21）。
- 模型看到的是引用方包出来的工具；cdp 只提供底层动作与快照文本（actions.ts:1-24；snapshot.ts:1-20）。
- 快照只给可交互节点发 ref，ref 带代际；动作前复核后端节点还在、role / name 没变（snapshot.ts:12-17；actions.ts:4-10）。
- 动作等待是简化版：短轮询 box model 与 DOM 域，不是 Playwright 那套 actionability（actions.ts:12-14）。
- 动作层只认 `CdpCommandTarget`，WebSocket 与 dock 视图两条后端共用同一份逻辑（actions.ts:19-22）。

## Known Limitations（已知限制）

- 不引第三方包，WebSocket 用 Node 内置全局，要求 Node ≥ 22.19（transport.ts:17）。
- 浏览器级与页面级两级事件共用一条 WebSocket，靠 `sessionId` 区分投递（transport.ts:9-15）。
- 元素稳定、命中测试、receives-events 判定都没做；做不到的写在错误信息里，不假装做了（actions.ts:12-14）。
- 对话框必须在超时后由插件层放掉，否则一次 `alert()` 就能把整条自动化卡死（actions.ts:15-17）。
- 启动器自己起浏览器、自建 profile；Windows 用 `taskkill /PID <pid> /T /F` 整树杀，等 300ms 再删目录（launch.ts:3-20）。

## 谁在用它

- `browser`：七个模块全用（actions、cloud-metadata、launch、report、ring-buffer、snapshot、transport），跑模型那台受控 Chrome（browser/index.ts:33-50）。
- `dock-browser`：用六个（actions、cloud-metadata、report、ring-buffer、snapshot、transport），把右侧栏那台浏览器接到同一条动作链（dock-browser/index.ts:42-62）。
- `host-stdio`：只用 `transport` 的 `CdpCommandTarget` 类型（host-stdio/index.ts:26）。
- 库包没有行、不参与开关；升级随应用走，不能单独停用或替换（package.json:17-21；index.ts:8-10）。
