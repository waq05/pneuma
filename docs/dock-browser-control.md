# dock 浏览器控制：让 agent 驱动侧栏那台浏览器

2026-10-15 起做的一件事：**改完界面让 agent 自己在侧栏浏览器里点一遍**。

对齐对象是 ZCode 的 in-app browser（IAB）：它把侧栏那台浏览器的 webContents 挂上 CDP，
再开一条私有管道把这条通道交给 agent 运行时，于是 agent 能 `goto` / 点击 / 输入 / 截图 /
读无障碍树。dsc 的三块拼图原本齐了两块半：侧栏浏览器有（`desktop/electron/main/dock.ts`）、
agent 侧 CDP 自动化有（`src/plugins/browser.ts` + `src/core/cdp/`）、宿主↔桌面主进程的
双向协议有（`desktop/electron/main/protocol.ts` ↔ `src/plugins/host-stdio.ts`）。
缺的只是**把 agent 接到 dock 视图上**这一段。

## 一、机制事实（已实测，别再怀疑）

2026-10-15 用一次性 spike（`WebContentsView` + `webContents.debugger`）在真 Electron 上验过：

| 能力 | 结论 |
| --- | --- |
| `view.webContents.debugger.attach('1.3')` | 通过（`isAttached()` 为真） |
| `Page/DOM/Accessibility/Runtime/Network.enable` | 通过 |
| `Accessibility.getFullAXTree` | 通过（拿到 RootWebArea / generic / button / StaticText 等角色） |
| `Runtime.evaluate` | 通过（`document.title` / `document.hidden` / 视口尺寸都读得到） |
| `DOM.getDocument` → `querySelector` → `getBoxModel` | 通过（拿到内容盒四角） |
| `Input.dispatchMouseEvent` ×3（moved/pressed/released） | **点击真生效**（按钮 onclick 改标题，读回来确认） |
| `Page.captureScreenshot` | 视图挂着窗口上时通过 |
| 视图从窗口摘下后 `document.hidden` | **变 true（页面被节流）** |
| 视图摘下后 `Page.captureScreenshot` | **卡死超时（8s 无应答）** |

最后两行是这条链路唯一必须绕的坑，直接决定了两条设计：

1. **截图前必须先确认这一台是露出来的**（`guest.attached`），没露出来就报一句人话，
   不能让它挂住——挂着的那条命令会把整次工具调用拖到超时，用户看到的是「卡住了」。
2. **agent 要能自己把页签开出来并聚焦**（截图/渲染类操作在被节流的页面上不成立）。
   `browser-open` 因此不是「顺便提供」的便利，而是这条链路的前置条件。

## 二、分层

```
agent 工具（src/plugins/dock-browser.ts）
   │  ctx.get('hostBrowser')
宿主链路门面（HostBrowserLink，实现落在 src/plugins/host-stdio.ts）
   │  parentPort 消息：browser-call / browser-open / browser-close / browser-views  ↕  browser-result / browser-event
桌面主进程（desktop/electron/main/dock.ts）
   │  webContents.debugger.attach('1.3') + sendCommand
dock 视图（WebContentsView，persist:dsc-browser）
```

与 ZCode 的分工完全同构，只是进程数少一层（ZCode 多一个 MCP 子进程 + 私有命名管道，
我们复用已有的 parentPort 协议）。

## 三、冻结的契约

三份文件是**共用真源**，两侧都引用，不许各写一份：

| 文件 | 内容 |
| --- | --- |
| `src/core/dock-browser.ts` | 协议版本（3）、CDP 命令/事件白名单、动作枚举、超时预算、线上消息类型、页签事件名、`DockViewInfo` |
| `src/core/host-browser-link.ts` | 服务名 `hostBrowser`、`HostBrowserLink` 接口、`DockBrowserUnavailableError` |
| `src/core/cdp/transport.ts` | `CdpCommandTarget`（结构类型；`CdpSessionView` 已 implements 它） |

### 线上消息（协议版本 2 → 3）

runtime → host：

```ts
| { type: 'browser-call'; id: number; viewId: string; method: string; params?: Record<string, unknown> }
| { type: 'browser-open'; id: number; url: string; viewId?: string }
| { type: 'browser-close'; id: number; viewId: string }
| { type: 'browser-views'; id: number }
```

host → runtime：

```ts
| { type: 'browser-result'; id: number; ok: true; value: unknown }
| { type: 'browser-result'; id: number; ok: false; error: string }
| { type: 'browser-event'; viewId: string; method: string; params: Record<string, unknown> }
```

两条与既有消息的分别：既有 `invoke` 是「host 调 runtime，runtime 回 result」，
这四条是反方向（runtime 请求、host 应答），所以用**另一对 id 空间**（同一个 `nextId`
递增即可，两个方向各自记账，互不干扰）。

### 桌面壳 → 界面（原生桥事件面）

`DOCK_TAB_OPEN_EVENT = 'browser-tab-open-request'`、`DOCK_TAB_CLOSE_EVENT = 'browser-tab-close-request'`
（两条都要进 `NATIVE_EVENTS` 白名单，否则壳订阅不到）。载荷 `{ id, url? }`——**id 由桌面侧发号，
壳必须照用**，否则宿主对不上号。

### 信任模型（这几条是硬性的，不是建议）

- `browser-call` 的 method 必须过 `isAllowedDockCommand`，不在名单里直接拒；
- `Page.navigate` 必须用 `dockNavigateTarget` 取出地址再过一遍 http/https 判定
  （否则它是绕开 `navigateDockBrowser` 那道闸门的直通车，能把带登录态的视图导到 `file://`）；
- 只有 `guests` 台账里的 id 能被指名（台账里只可能有 dock 视图，主窗口的 webContents 进不来）；
- `Runtime.evaluate` 的敏感原语黑名单沿用 `src/plugins/browser.ts` 那道守卫，不因为换了后端就少一道；
- 写类动作走审批（见第五节）。

## 四、五条线的任务边界

每条线一个 worktree、一个子智能体，互不重叠文件。接口已冻结，**不许改契约文件**
（`src/core/dock-browser.ts` / `src/core/host-browser-link.ts`）——要用到别的东西就写进线内文件，
或回来找主控加。

| 线 | 分支 | 文件 |
| --- | --- | --- |
| 1 桌面主进程 | `feat/dock-browser-desktop` | `desktop/electron/main/{dock,protocol,index}.ts` + `src/core/native-bridge.ts`（只加两条事件名） |
| 2 宿主协议 + 链路实现 | `feat/dock-browser-host` | `src/plugins/host-stdio.ts`、新 `src/core/dock-session.ts`、`src/core/cdp/{actions,snapshot}.ts`（只放宽形参类型） |
| 3 工具面 | `feat/dock-browser-tools` | 新 `src/plugins/dock-browser.ts`、`src/host/kernel.ts`（登记 + 默认关） |
| 4 壳的页签开户 | `feat/dock-browser-shell` | `ui-shell/src/ui-dockkit/{dock-model,dock-state}.ts`、`ui-shell/src/plugins/browser/ui.tsx` |
| 5 探针 | `feat/dock-browser-probe` | 新 `scripts/dock-browser-test.mjs` |

线 3、4 的**运行期**行为依赖线 1/2 合流后才成立；各线自己的编译与纯模块探针必须当场绿。

## 五、工具面（线 3 的口径）

- `browser_dock`（risk `exec`，每次审批）：`open` / `navigate` / `click` / `hover` / `type` /
  `press` / `scroll` / `evaluate` / `close`。
- `browser_dock_look`：`views` / `snapshot` / `screenshot` / `console` / `network` / `wait_for`。
  按 `computer-use` 那条既有先例（`lookWithoutApproval` 设置项）决定注册与风险档——
  默认**不注册**，用户打开设置后才以 `read` 注册。理由：dock 视图是用户自己的持久登录态，
  和 `browser.ts` 那台一次性的 Chrome 不是一回事。
- 审批卡上要带视图 id 与目标地址（`isAgentView` 区分出「agent 自己开的」）。

## 六、验收

1. `pnpm run typecheck` + `pnpm run build` + `desktop` 侧 `pnpm run typecheck` 全绿；
2. 新增探针绿，且**全量无头电池不回归**；
3. 实机走查：桌面端起来后，agent 能 `open` 出侧栏页签 → `snapshot` 读出角色树 →
   `click` 一个按钮 → 页面状态真的变了 → `screenshot` 拿到图。
4. 负向验证：把 `browser-call` 的 method 换成不在白名单里的（如 `Runtime.compileScript`），
   桌面侧必须拒；把 `Page.navigate` 指向 `file://`，必须拒。

## 七、有意不做

- **不做 `file://`、上传文件、下载**：与 ZCode 的 IAB 口径一致（它明确 `capability_unsupported`）。
- **不做多用户分区隔离**：dock 沿用一份持久分区（`persist:dsc-browser`），换分区只动
  `browserPartition()` 一处。
- **不给 `browser.ts` 那台自管 Chrome 换后端**：它是另一条既有能力，这次不动它。
- **不把 CDP 端口暴露到进程外**（不开 `--remote-debugging-port`）：命令走已有的 parentPort
  协议，不新开一个谁都能连的调试口。
