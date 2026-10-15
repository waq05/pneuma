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
| 视图被摆到**窗口之外**（rect 整块落在内容区外） | **视口塌成 `0×0`**：`document.hidden` 变 true、`elementFromPoint` 恒 null、点击落在空处 |
| 窗口截图 `capturePage` | **拍不到原生子视图**：侧栏那一块永远是空的（看侧栏画面只能用 CDP 截图） |

这几行是这条链路必须绕的坑，直接决定了三条设计：

1. **agent 要能自己把页签开出来并聚焦**（截图/渲染类操作在被节流的页面上不成立）。
   `browser-open` 因此不是「顺便提供」的便利，而是这条链路的前置条件。
2. **几何必须等落定再上报**（侧栏展开是从右缘滑入的，过渡那一拍量到的矩形带着 transform）。
   详见第八节第 2 条——这一条是把「点得动」从「偶尔点得动」拉到确定性的那道修。
3. **视觉证据只能来自 CDP 截图**：桌面端 `capturePage` 拍不到原生子视图，走查里那张
   「侧栏页签里的画面」是从工具返回的 base64 里抠出来存盘的（见第九节）。

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
  按 `computer-use` 那条既有先例决定注册与风险档——默认**不注册**，用户在「设置 → 侧栏浏览器」
  打开 `lookWithoutApproval` 之后才以 `read` 注册（那张分区由插件自己注册，开关热生效）。
  理由：dock 视图是用户自己的持久登录态，和 `browser.ts` 那台一次性的 Chrome 不是一回事。
- 审批卡上要带视图 id 与目标地址（`isAgentView` 区分出「agent 自己开的」）。
- `open` 会**等页面真的落到目标地址**（有界 8s，见第八节第 4 条）：壳那条路是「先建视图、
  再由壳去 load」，不等的话模型紧接着 snapshot 会读到一棵空树。

## 六、验收

1. `pnpm run typecheck` + `pnpm run build` + `ui-shell` + `desktop` 各自 typecheck/构建全绿；
2. 新增探针绿（`scripts/dock-browser-test.mjs`），既有电池不回归
   （`ui-native-bridge-test` / `ui-plugin-test` / `ui-batches-test` / `computer-use-test` /
   `ui-legacy-compat-test` / `settings-sections-check` / `ui-settings-nav-test` / `ui-events-test`）；
3. 实机走查 `desktop/shots/_dock-walkthrough.ps1` 全绿（见第九节）；
4. 负向验证：白名单外的 method（如 `Runtime.compileScript`）必须拒；`Page.navigate` 指向
   `file://` 必须拒；云元数据地址必须拒。

## 七、有意不做

- **不做 `file://`、上传文件、下载**：与 ZCode 的 IAB 口径一致（它明确 `capability_unsupported`）。
- **不做多用户分区隔离**：dock 沿用一份持久分区（`persist:dsc-browser`），换分区只动
  `browserPartition()` 一处。
- **不给 `browser.ts` 那台自管 Chrome 换后端**：它是另一条既有能力，这次不动它。
- **不把 CDP 端口暴露到进程外**（不开 `--remote-debugging-port`）：命令走已有的 parentPort
  协议，不新开一个谁都能连的调试口。

## 八、实机走查抓出来的四个缺陷（都在既有代码里）

走查是「假端点驱动真回合 + 真桌面端 + 真靶页」，一路把下面四条逼了出来。它们**都不是**
这次新写的代码的问题，而是这次新链路第一次把既有代码用到位才暴露出来的：

1. **CDP 应答读少了一层**（`src/core/cdp/actions.ts`）。`DOM.getBoxModel` 的应答是
   `{ model: { content: [...] } }`、`DOM.resolveNode` 是 `{ object: { objectId } }`，而代码按
   `{ content }` / `{ objectId }` 读 → 永远是 `undefined` → `click`/`hover`/`scroll` 一路等到
   5 秒超时。**既有的 `browser` 插件走的是同一个函数，同样受影响**——只是那条链路从来没有
   真点过一次，而动作层当时**没有任何探针覆盖**（全仓 `.mjs`/`.js`/`.ps1` 里
   `clickRef`/`getBoxModel` 零命中），所以它一直活着。
2. **过渡期量到的几何被当成真几何**（`ui-shell/src/plugins/browser/ui.tsx`）。侧栏展开是从
   右缘**滑入**的（transform），过渡那一拍 `getBoundingClientRect()` 把变换算进去：实测窗口
   1440 宽、报出去 `x=1861`（= 落定位置 1021 + 一个侧栏宽度的位移）。原生视图被摆到窗口外
   之后视口塌成 `0×0`（第一节实测），于是**点击落在空处、截图一片空白**；而 transform 变化
   既不触发 `ResizeObserver` 也不触发 `window resize`，所以这一错会一直错到底。
   修法：几何没落定（整块在视口外）就下一帧再看，超上限照报。桌面侧另外留一行账
   （`[dock] 视图 … 被摆到窗口之外`），下次一眼就能看见。
3. **视图被摆到窗口外时没有任何账**：现象是「点了没反应」，成因在几何上——不留一行 stderr，
   下次还得从「点不动」倒着查回布局。见第 2 条的修法末尾。
4. **`open` 不等页面加载**：`browser-open` 的语义是「视图出现了」，而页面是壳随后才去
   `load` 的，模型紧接着 `snapshot` 会读到「可交互元素 0 个」并以为页面是空的。修法：
   `open` 之后有界地等这一页落到请求的地址（与 ZCode「`goto` 之后显式等 domcontentloaded」
   是同一件事，只是替模型做了）。

## 九、怎么再跑一遍（实机走查配方）

资产都在 `desktop/shots/`（整目录 gitignored，不入库）：

| 文件 | 作用 |
| --- | --- |
| `_dock-seed.mjs` | 造隔离 HOME：假端点配置 + `full-access` 审批档 + 显式打开 `dock-browser` 插件 |
| `_dock-page.mjs` | 靶页：一颗按钮，点一下改文档标题并给计数 `+1`（「点到了」因此是可观测的） |
| `_dock-fake-llm.mjs` | 假端点：按上一轮工具调用分派 open → snapshot → 布局诊断 → click → 读标题 → 截图 |
| `_dock-extract-shot.mjs` | 从会话落盘里把工具返回的截图抠出来存盘（`capturePage` 拍不到原生子视图） |
| `_dock-walkthrough.ps1` | 串起全部并给判定 |

```powershell
# 前置：三份产物都构建过
pnpm build ; pnpm build:ui ; cd desktop ; pnpm build ; cd ..
pwsh -NoProfile -File desktop/shots/_dock-walkthrough.ps1
```

判定 15 条：假端点六步走完（含「ref 是从真快照读出来的」）、点击落在按钮中心
（`(118, 157)`）、标题变 `clicked-1`、页面计数涨到 1、原生视图真的建了、几何没被摆到窗口外
（回归闸）、壳体在、eval 拿到读数、窗口截图写出、对话正文里有点回来的标题、侧栏页签的原生
视图回执、侧栏页签标题也跟着变了、侧栏视图自己截出了图。

**注意两件事**：① 走查会**弹出真窗口并置顶**（`DSC_DESKTOP_SHOT_TOPMOST=1`），别在人用电脑时跑；
② 它用的隔离 HOME 是四件套（`HOME`/`USERPROFILE`/`DSC_HOME`/`DSC_DESKTOP_STATE`），
不碰真实 `~/.dsc`。
