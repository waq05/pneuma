# 批次 08：浏览器与桌面控制

> 状态：已归档（2026-11-17）：2026-11-09 一次性审查报告；14 条 P0 已全部修复（见同目录 FIXES.md）。

## 范围

全文读过（按工作区现状）：

- `src/packages/browser/index.ts`（1474 行）
- `src/packages/cdp/index.ts`（21）、`transport.ts`（435）、`launch.ts`（552）、`actions.ts`（774）、`snapshot.ts`（386）、`report.ts`（99）、`ring-buffer.ts`（40）、`cloud-metadata.ts`（16）、`package.json`、`tests/cdp.test.mjs`
- `src/packages/dock-browser/index.ts`（880 行）、`tests/dock-browser.test.mjs`
- `src/packages/computer-use/index.ts`（638 行）、`desktop-control.ts`（1521 行）
- `src/packages/desktop-dock/index.ts`（636 行）、`tests/desktop-dock.test.mjs`
- `src/core/dock-browser.ts`（228）、`dock-ops.ts`（120）、`dock-session.ts`（59）、`host-browser-link.ts`（65）、`desktop-control.ts`（1 行垫片）、`path-policy.ts`（334）
- `src/packages/host-stdio/index.ts`（445 行）

对照抽读（只读调用关系，不是审查对象）：`src/packages/sandbox/win/doctor.ts:225-300`、`sandbox/win/setup.ts:350-410`、`sandbox/policy.ts:555-600`、`src/core/web-static.ts:20-55`、`src/core/ui-methods.ts:85/414-417`、`scripts/dock-browser-test.mjs`、`scripts/computer-use-test.mjs`、`desktop/electron/main/dock.ts`（仅 grep 命中行：27-32、86、115、139-142、163、243、374、453-475）。

**在途改动说明**：本批次范围内**没有一个文件**出现在 `git status --porcelain` 的改动清单里（30 个在途文件全是 `ui-*`、`docs`、`scripts/ui-*` 与 `ui-shell/src/plugin-api.ts`）。所以这一批按 HEAD 现状审查，结论不受在途改动影响。

## 结论摘要

- **P0 2 条 / P1 10 条 / P2 10 条**
- 最重要的一句：`dock-browser` 默认把**唯一的快照入口**关掉了（`lookWithoutApproval: false` 就不注册 `browser_dock_look`），而 `browser_dock` 的 9 个动作里有 5 个只收 ref——出厂配置下这台侧栏浏览器点不了、填不了，工具说明还让模型去调那个没注册的工具。
- 第二句：两条浏览器链的「工具层」是各写一遍的（browser 565 行 / dock 490 行对位），共享只到 `src/packages/cdp/` 的动作与快照；共享层里又写死了 `browser_look` 这个工具名，dock 侧报错直接指错插件。
- 第三句：`desktop-control.ts` 1521 行、`runDesktopAction` 一个 switch 196 行 16 个分支、PowerShell 执行体全仓三份（返回形状三种）；`desktop-dock` 的路径围栏 `inside()` 没跟上 `core/path-policy.ts` 2026-10-30 那次「跟 realpath」的修补。

## 四套实现的边界（问题 1）

| | `browser` | `dock-browser` | `cdp`（库） | `computer-use` |
| --- | --- | --- | --- | --- |
| 管什么 | 自己 `spawn` 的 Chrome/Edge 进程 | 桌面主进程里那台 `WebContentsView`（侧栏页签） | 无（库，被前两者 + `host-stdio` 引用） | 整台 Windows 桌面（屏幕像素 + UIA） |
| 传输 | Node 内置 WebSocket 直连 `ws://127.0.0.1:<port>/devtools/browser/<uuid>`（`launch.ts:110-121`、`transport.ts:131-177`） | `parentPort` 消息 → 桌面主进程 `webContents.debugger.sendCommand`（`host-stdio/index.ts:263-285`、`core/dock-session.ts:40-58`） | 定义 `CdpTransport` 与 `CdpCommandTarget` 两个形状（`transport.ts:105-402`） | 每次动作起一个 `powershell.exe`（`desktop-control.ts:277-317`） |
| 进程/资源归属 | 本进程持有，收尾 `taskkill /PID x /T /F` + 等 300ms + 删自建 profile（`launch.ts:449-459`） | 桌面壳持有；agent 只发 `browser-open`/`browser-close`，自己只清内存状态 | 无 | `activeChildren` 集合，急停 `killAllPowerShell()`（`desktop-control.ts:254-271`） |
| 定位方式 | 无障碍 `ref` + 代际校验（`snapshot.ts:214-284`、`actions.ts:224-252`） | 同一份 `serializeAxTree` + 每视图各存一份代际（`dock-browser/index.ts:159-173`、`383-418`） | 提供 `verifyRef` / `lookupSnapshotRef` | UIA 元素索引 + `state_id`（`desktop-control.ts:777-820`） |
| 地址口径 | 协议 + 私网 + 云元数据 + 域名 allow/deny + 落地复查（`browser/index.ts:227-282`、`789-805`） | 只拒非 http(s) 与云元数据（`dock-browser/index.ts:126-154`） | 只给 `CLOUD_METADATA_HOSTS` 数据 | 无（打的是本机桌面，不是网址） |
| 默认状态 | 默认关，第一次调用工具才拉起（`browser/index.ts:352-361`） | 插件在，但只读工具默认不注册（`dock-browser/index.ts:825`） | 常驻库 | 默认关 |

**同一能力两边各实现一遍的清单**（这是本批次的主结论之一）：

| 能力 | `browser` | `dock-browser` | 判定 |
| --- | --- | --- | --- |
| 连接管理 | `launch.ts:357-476` 的 `BrowserProcess`（懒启动 + 重连预算） | `host-stdio/index.ts:245-285` 的 `browserPending`（自增号 + 待办表 + 超时） | **各一套**，见 P1-10 |
| 快照 / ref 代际 | `browser/index.ts:572-604` + 状态 `337-341` | `dock-browser/index.ts:383-411` + `ViewState 159-173` | 算法共用（`cdp/snapshot.ts`），**外层包装各一套** |
| 动作执行 | `runAct` `browser/index.ts:758-1051`（294 行） | `runAct` `dock-browser/index.ts:564-735`（172 行） | **各一套**，见 P1-1 |
| 截图 | 直接用 `actions.captureScreenshot`（`browser/index.ts:686`） | 先查 `visible` 再截（`dock-browser/index.ts:444-469`） | 同一函数，**dock 多一道可见性前置**（合理，但没回灌 browser） |
| 等待「页面能动了」 | `actions.waitForPageLoad` 轮询 `readyState`（`actions.ts:588-601`） | `waitForPageLoad` + 自写 `waitForDockPage` 轮询 URL 落点（`dock-browser/index.ts:351-370`） | **两套** |
| 等待网络空闲 | 无 | 无 | 全仓 `src` 里 `networkidle` / `Network.loadingFinished` / `Page.loadEventFired` **零命中**：这项能力四套里都没实现，别在文档里当成已有 |
| 对话框 | 三策略 + 超时兜底 + 模型可见提示（`browser/index.ts:114`、`409-436`、`971-990`） | **完全没有**：事件白名单里有、消费端没有、动作枚举里也没有 | 见 P0-2 |

### 能不能抽一个「浏览器工具内核」

能，边界已经在 `core/dock-browser.ts:139-145` 的 `CdpCommandTarget` 上——缺的是它上面那一层。可抽的部分（按行数算约 460 行/侧）：

1. `takeSnapshot` + `lookupRef`（browser 572-611 / dock 383-418）：**纯对位**，只有页眉文案里「当前标签页」与「视图 X 当前地址」的差别。
2. `lookupRef` 的失败文案（`cdp/snapshot.ts:364-385` 已经是共用实现，只需把工具名变成参数）。
3. 9 个动作分支中的 8 个（navigate/click/hover/type/press/scroll/evaluate/close）：**逐段**对照见 P1-1。
4. `typedTextBlockReason`（见 P2-1 的逐字对照）。
5. 事件接线里「控制台/异常/网络/主框架跳转」四类映射（browser 439-501 / dock 240-296）：两边的 switch 分支一字不差，只是事件来源一个来自 `CdpSessionView.on`、一个来自 `link.onEvent` 的 `browser-event` 消息。
6. 工具 schema（browser 1055-1140 / dock 739-814）。

不可抽的四件事，也就是代价：

- **生命周期**：一边是「本进程 spawn 的进程树」，一边是「桌面壳的视图」，清理动作一个是 `taskkill /T /F` + 删目录，一个是发一条 `browser-close` 消息。同一接口会强迫两边都长出用不到的钩子。
- **寻址模型**：`browser` 是「一台浏览器 + 一个当前页 + 可切 frame」，`dock` 是「多台视图 + 每台一份 ref 代际」。抽内核必须把「当前目标」从内核里拿掉改成参数——这一步等于重写两个插件的状态机。
- **信任口径**：`browser` 一次性 profile（私网全拒），`dock` 是用户带登录态的持久分区（localhost 可能是正常开发目标）。地址判定不能合。
- **审批/守卫位置**：`browser` 用 `ctx.guards.register`（`browser/index.ts:1149-1190`）在动手前拒，`dock` 完全没有守卫、靠 `risk:'exec'`。抽内核要决定守卫归谁，这件事现在两边答案不同。

务实做法：先抽第 1、4、5、6 项（快照包装、输入体检、事件映射、schema），把「动作分支」留到最后——因为动作分支的输出与错误文案已经是模型可见契约，改动要配回归脚本。

## 按插件分节

### @pneuma/dock-browser

#### [P0] P0-1 · 默认配置下没有快照入口，5 个只收 ref 的动作全部不可用

- 位置：`src/packages/dock-browser/index.ts:97`、`:825`、`:759`、`:376`、`:752-781`；对照 `src/packages/computer-use/index.ts:429-447`
- 现象：`lookWithoutApproval` 默认 `false`，`syncTools()` 只在它为真时才注册 `browser_dock_look`。而 `browser_dock` 的 `click / hover / type / press / scroll` 全部要 `ref`，ref 只能从 `snapshot` 拿，`snapshot` 只存在于 `browser_dock_look` 里。于是出厂配置下这台浏览器能 `open`、能 `navigate`、能 `evaluate`，但点不动任何东西。
- 证据：
  ```
  97:   lookWithoutApproval: false,
  759:         '别一次铺一堆动作。动手前先 browser_dock_look action=snapshot 拿 ref。',
  825:       if (config.lookWithoutApproval) toolOffs.push(ctx.effect(() => ctx.tools.register(lookTool), 'dock-browser: tools.register #2'))
  ```
  同族插件 `computer-use` 遇到同一个选择时走的是另一条路——没开免审批就把只读动作**合进 exec 工具一起过审批**，而不是不注册：
  ```
  435:         (action) => !disabled().has(action) && (!config.lookWithoutApproval || !LOOK_ACTIONS.includes(action)),
  ```
- 影响：用户装好桌面端、打开 dock-browser、让 agent 点侧栏页面上的按钮，模型只能回一句「拿不到 ref」。工具说明与错误文案（`:759`、`:376` 的「或 browser_dock_look action=views 看现在有哪几台」）都在指引一个不存在的工具，模型会反复重试同一个失败。
- 建议：照 `computer-use` 的形状改——`lookWithoutApproval` 为假时，把 `DOCK_LOOK_ACTIONS` 并进 `browser_dock` 的 `action` 枚举（`risk` 仍是 `exec`），为真时才额外单独注册 `read` 档；`:759` 与 `:376` 的文案按「当前有没有那个工具」现算。
- 置信度：高（已核对 `DOCK_ACTIONS`/`DOCK_LOOK_ACTIONS` 两个枚举、`syncTools` 全部分支、以及 `computer-use` 的对照实现）

#### [P0] P0-2 · 对话框事件被白名单放行、被消费端静默丢弃；dock 侧连处理动作都没有

- 位置：`src/core/dock-browser.ts:76-77`（白名单）、`src/packages/dock-browser/index.ts:240-295`（尤其 `:291-293` 的 `default`）、`src/packages/dock-browser/index.ts:164-174`（动作枚举）
- 现象：契约把 `Page.javascriptDialogOpening` / `Page.javascriptDialogClosed` 列进允许推送的事件，桌面侧 `shouldForwardDockEvent` 因此会真的推上来；但 `ensureEvents` 的 switch 没有这两个 case，落到 `default` 被当成「不该推过来的事件」丢掉。同时 `DOCK_ACTIONS` 里没有 `dialog`，模型即使知道也处理不了。
- 证据：
  ```
  core/dock-browser.ts:76:   'Page.javascriptDialogOpening',
  dock-browser/index.ts:291:           default:
  dock-browser/index.ts:292:             // 白名单之外的事件本就不该推过来，静默忽略
  ```
  对照 `browser` 侧把这件事当成必须处理的一条：`browser/index.ts:114`（`DIALOG_TIMEOUT_MS = 300_000`）、`:419-435`（挂起 + 写系统提示 + 超时自动 dismiss）、`:971-990`（`dialog` 动作）。
- 影响：侧栏页面弹出 `alert()` / `confirm()` 之后，该视图上的每条 CDP 命令都会被浏览器压住，直到 `DOCK_CALL_TIMEOUT_MS`（`core/dock-browser.ts:148`，25 秒）超时；模型只看到「超时」，看不到「有个弹窗」，也没有任何可用动作，只能放弃整个任务。`browser` 插件为此专门写过「一次 alert 能把整条自动化卡死」，dock 这条路把那个坑原样留着了。
- 建议：二选一，不要留半截——要么在 `DOCK_CDP_EVENTS` 里删掉这两条（承认不支持，至少在契约层不再假装支持），要么在 `ensureEvents` 里补 case：记一个 `pendingDialog` 到 `ViewState`、`ctx.transcript.system` 提示一次、并在 `DOCK_ACTIONS` 加 `dialog`（桌面侧 `Page.handleJavaScriptDialog` 已在命令白名单 `core/dock-browser.ts:39`）。推荐后者，这是 `browser` 已验证过的形状。
- 置信度：高（白名单、转发判据、switch 分支、动作枚举四处都核对过）；唯一待核实的是 Electron 的 `webContents.debugger` 会不会真的把这两条事件推上来——即使它不推，这个 `default` 丢弃也是错的（会连带丢掉将来加的白名单事件）。

#### [P1] P1-1 · `act` / `look` / `snapshot` 与 `browser` 逐段对位重写，dock 侧约 85% 有 browser 对位

- 位置：`src/packages/browser/index.ts:572-611`、`:632-742`、`:747-756`、`:758-1051`、`:1055-1140` 对照 `src/packages/dock-browser/index.ts:383-418`、`:422-548`、`:553-562`、`:564-735`、`:739-814`
- 现象：两条链的工具层是两份代码，动作分支逐段对位，只有 `viewId`、输出前缀与工具名不同。逐段行数对照：

  | 段 | browser | dock-browser | 是否对位 |
  | --- | --- | --- | --- |
  | 快照（取树 → 文本 → 截断 → 围栏） | 572-604（33 行） | 383-411（29 行） | 对位 |
  | ref 查表 | 607-611（5） | 414-418（5） | 逐字对位 |
  | 事件接线 | 439-501（63） | 240-296（57） | 对位 |
  | 开域 | 504-519（16） | 328-341（14） | 对位（dock 多 `networkReady` 惰性） |
  | 只读动作 | 632-742（111） | 422-548（127） | 对位（dock 多 `views`、多截图可见性闸） |
  | 动手动作 | 758-1051（294） | 564-735（172） | 8 个动作对位，browser 多 select/fill_form/upload/dialog/frame，dock 多 open |
  | 输入体检 | 747-756（10） | 553-562（10） | 对位（文案差一句，见 P2-1） |
  | 工具 schema | 1055-1140（86） | 739-814（76） | 对位 |
  | 合计 | 565 行 | 490 行 | dock 侧仅 `open`（38 行）+ 截图可见性闸（14 行）+ `waitForDockPage`（20 行）是独有的 |

  动作级对位（举例）：`navigate` browser 784-819 / dock 625-639；`click` 821-842 / 641-653；`hover` 844-851 / 655-663；`type` 853-870 / 665-679；`press` 872-884 / 681-694；`scroll` 904-924 / 696-716；`evaluate` 946-954 / 718-730；`close` 763-773 / 611-618。
- 证据（同一段逻辑两处各一遍，`scroll` 的参数拼装逐字对位）：
  ```
  browser/index.ts:910:       const outcome = await actions.scrollPage(
  browser/index.ts:911:         session,
  dock-browser/index.ts:702:           const outcome = await actions.scrollPage(
  dock-browser/index.ts:703:             page,
  ```
- 影响：下一次需求只要动「动作的行为或文案」（比如给 `click` 加「点击后自动等 300ms」、把「点到了≠生效了」换成更强的话），就得改两处并记住两套测试；漏掉一处，两条链对同一个失败给出两种说法——`cdp/report.ts:6-7` 的注释已经把这件事写成规矩（「同一个错误在两处说成两种话，模型就学不会」），但只做到了输出行，没做到动作与错误。
- 建议：按上文「能不能抽一个浏览器工具内核」的顺序，先把快照包装 + 输入体检 + 事件映射 + schema 抽到 `src/packages/cdp/`（新增 `tool-kit.ts`，入参是 `CdpCommandTarget` + `{toolName, targetLabel}`），动作分支第二步再做。别一次性重写两个插件。
- 置信度：高（两侧文件全文读过，行数按段数出来的）

#### [P1] P1-2 · 没有 guards / prompt / commands：三条「防照旧 ref 动手」的规矩只写在 browser 那一侧

- 位置：`src/packages/dock-browser/index.ts:187`（`inject: ['tools', 'settings']`）；对照 `src/packages/browser/index.ts:302`、`:1149-1190`、`:1195-1211`、`:1215-1246`
- 现象：`browser` 注册了守卫（navigate 前判地址、evaluate 前判敏感原语与禁用开关）、系统提示词（「ref 只对最近一次快照有效」「点到了不等于生效了」）、`/browser status|close` 命令；`dock-browser` 三样都没有，全文没有一处 `ctx.guards` / `ctx.prompt` / `ctx.commands`。
- 证据：
  ```
  dock-browser/index.ts:187:   inject: ['tools', 'settings'],
  browser/index.ts:302:   inject: ['tools', 'commands', 'settings', 'transcript', 'guards', 'prompt', 'session'],
  ```
- 影响：dock 路径上「旧 ref 必须重新快照」「动作后要再确认」这两条只存在于 `browser_dock` 的 description（一行）里；`browser` 侧是用整段系统提示词反复强调的。同一套 ref 代际机制，两条链的模型教育强度差一个量级，dock 路径更容易照着上一代 ref 连点。另外 `browser` 的守卫在审批之前拒绝非法 navigate，dock 侧只有 `assertHttpUrl` 在动作层内（`:573`、`:626`），意味着审批卡上会先出现一个注定失败的地址。
- 建议：`prompt.register` 抽成共用文案函数（`cdp` 包给一份 `browserPromptText({toolLook, toolAct, dialogSupported})`），两个插件各传参数；守卫侧把 dock 的 `assertHttpUrl` 提前到 `guards.decide`（`order: 20` 与 browser 同档）。
- 置信度：高

#### [P1] P1-3 · 只读路径完全不可取消：`runLook` 不接 `runCtx`，`waitForCondition` 不传 signal

- 位置：`src/packages/dock-browser/index.ts:813`、`:543`；对照 `src/packages/browser/index.ts:737`
- 现象：`lookTool.run` 写成 `(args) => runLook(args)`，把 `runCtx` 丢了，于是 `wait_for` 的 `waitForCondition` 没有 signal；用户按 Ctrl+C 之后这个循环还会跑到 `timeoutMs`（上限 120000）才结束。
- 证据：
  ```
  dock-browser/index.ts:813:       run: (args) => runLook(args),
  dock-browser/index.ts:543:       const result = await actions.waitForCondition(page, { text, selector }, timeoutMs)
  browser/index.ts:737:       const result = await actions.waitForCondition(session, { text, selector }, timeoutMs, runCtx.signal)
  ```
- 影响：`wait_for` 是模型最常用来「等页面」的动作，最长等两分钟；用户打断这一轮之后界面已经显示「已取消」，宿主里还挂着一个每秒两次 `Runtime.evaluate` 的循环，跨进程打到桌面壳上。`waitForDockPage`（`351-370`）同样是裸轮询，但那段有 8 秒上限，问题小些。
- 建议：`run: (args, runCtx) => runLook(args, runCtx)`，把 `runCtx.signal` 透到 `waitForCondition` 与 `waitForDockPage`；这是两行改动，顺手把它做成 `cdp` 内核的硬性签名（`runLook(args, runCtx)` 由内核定义）。
- 置信度：高

#### [P2] P2-1 · 四个配置项「有读无写」：设置分区只暴露 `lookWithoutApproval`，环形缓冲也不会 resize

- 位置：`src/packages/dock-browser/index.ts:189-198`（读）、`:831-857`（设置分区）、`:214`（建缓冲）；对照 `src/packages/browser/index.ts:1391-1392`
- 现象：`maxSnapshotChars` / `consoleBuffer` / `networkBuffer` / `waitTimeoutMs` 在 `readConfig` 里解析、在 `runLook`/`runAct` 里使用，但 `fields()` 只有 `lookWithoutApproval` + 一条 info，`save()` 对其他 key 一律返回 `save.unknownKey`。也就是说这四项只能手改 `plugins.json`。而且即使手改了，已建的 `RingBuffer` 不会跟着变容量（`ringsFor` 只在首次创建时取 `config.consoleBuffer`）。
- 证据：
  ```
  852:         if (key !== 'lookWithoutApproval') return t('save.unknownKey', { key })
  214:         bucket = { console: new RingBuffer<ConsoleEntry>(config.consoleBuffer), network: new RingBuffer<NetworkEntry>(config.networkBuffer) }
  ```
- 影响：用户想「快照长一点」「控制台多看几条」找不到入口；`browser` 侧同样四项都在设置页里（`browser/index.ts:1292-1309`），两个插件同一个参数名两种待遇，读代码的人会以为 dock 侧是没写完。
- 建议：照 `browser` 的分组补 `fields`/`values`/`save` 三个分支，并在 `save` 里对已有缓冲调 `resize`（`RingBuffer.resize` 已经支持，`cdp/ring-buffer.ts:36-39`）。
- 置信度：高

#### [P2] P2-2 · `states` / `rings` 只在 `action=close` 时回收；用户自己关页签就一直留着

- 位置：`src/packages/dock-browser/index.ts:611-618`（唯一的 `delete`）、`:211-218`（按任意 `viewId` 懒建桶）、`:863-878`（dispose 只清空）
- 现象：`states.delete` / `rings.delete` 只出现在 `browser_dock action=close` 里。用户在壳里点页签的 ×、或者桌面壳重开，`states` 里的 `ViewState`（含 `refs` 里的 `SnapshotRef`）与两个环形缓冲都没有任何触发点清理。事件推送还会为**任何** `viewId` 懒建桶——包括用户自己开的、agent 从未接触过的页签。
- 证据：
  ```
  615:         states.delete(viewId)
  616:         rings.delete(viewId)
  241:         const bucket = ringsFor(event.viewId)
  ```
- 影响：一次会话里开开关关十几张页签，`states` 与 `rings` 只增不减，旧 `refs` 一直留在内存里；`generation` 也随 viewId 复活而从 0 重来（`310-322` 只在 `state === undefined || state.link !== link` 时新建），一旦壳复用同一个 id，旧 ref 的 `generation` 可能与新代际撞上而通过校验。
- 建议：在 `views()` 拿回列表后做一次对账（列表里没有的 viewId 就 `delete` 两个表）；事件桶改成「先用 `states.get(viewId)` 判断这台有没有人观察过」，没有就丢弃，不为用户自己的页签建桶。
- 置信度：中（`viewId` 是否会复用没有查到桌面侧的发号实现 `desktop/electron/main/dock.ts`，见待核实 1）

#### [P2] P2-3 · `close` 这个词在两条链上炸的是两个量级

- 位置：`src/packages/browser/index.ts:763-773`（杀整棵进程树 + 删 profile）、`:1219-1229`（`/browser close` 同义）、`src/packages/dock-browser/index.ts:611-618`（关一张页签）
- 现象：同一个动作名 `close`，`browser` 侧关的是这台受控浏览器（连 profile 一起删），`dock` 侧关的是一张页签。两边的模型提示词也各说各的。
- 证据：
  ```
  browser/index.ts:770:         return report(`已关闭受控浏览器（整棵进程树都杀了${profile === '' ? '' : `，自建 profile ${profile} 已删除`}）。`, {
  dock-browser/index.ts:617:         return report(`已关掉视图 ${viewId}（连带壳里那张页签）。`, { action: 'close', viewId })
  ```
- 影响：模型在两个工具之间迁移时会把「关掉这张页签」和「关掉浏览器」混为一谈；更实际的风险是抽内核时这两个语义必须先拆名——dock 侧真正想要「全部关掉」时只能逐台 `close`，而 `browser` 的 `close` 没有 viewId 概念。
- 建议：dock 侧改名 `close-tab`（或 `close_view`），`browser` 保留 `close` 表示整台；抽内核时把「关什么」写进参数而不是靠工具名区分。
- 置信度：高

### @pneuma/browser

#### [P1] P1-4 · 1474 行里 1171 行都塞在 `apply()` 一个函数体里

- 位置：`src/packages/browser/index.ts:303-1473`（`apply` 起止）
- 现象：一个 `apply()` 里依次做：读配置（305-323）、15 个模块级状态（326-350）、启动器持有（352-361）、ref 代际（363-368）、对话框状态机（370-436）、事件接线（439-519）、页面附着（522-556）、快照（572-611）、只读工具（632-742）、输入体检（747-756）、动手工具（758-1051）、工具注册（1055-1145）、守卫（1149-1190）、提示词（1195-1211）、命令（1215-1246）、设置分区（1256-1437）、收尾（1441-1472）。口径里的第 4 类靶子（「一个 `apply()` 里塞了整条业务链」）在这里是满配。
- 证据：
  ```
  303:   apply(ctx, passed: unknown) {
  ...
  1464:       offAct()
  1465:       offLook()
  ```
- 影响：任何一处改动都要在这 1171 行里定位；15 个闭包变量跨段共享（`launcher`/`page`/`mainPage`/`generation`/`refs`…），抽任何一段出去都要先设计一个会话对象。第二次改动（比如给 `click` 加「试试 force」）会同时动状态、动作、schema 三段。
- 建议：拆成 `browser-session.ts`（类：`ensurePage`/`takeSnapshot`/`invalidateRefs`/`closeAttachments`/对话框状态机）、`tools.ts`（`runLook`/`runAct` + schema）、`settings.ts`（字段与 `save`/`action`），`index.ts` 只留注册与收尾。这是本批次里收益最大的一个拆分，也是 P1-1 抽内核的前置。
- 置信度：高

#### [P2] P2-4 · 声明了 `session` 依赖，全文没有一处用 `ctx.session`

- 位置：`src/packages/browser/index.ts:302`、`:1250-1252`
- 现象：`inject` 里带 `'session'`，但换会话时用的是事件总线（`ctx.on('dsc/session-open', ...)`），没有一次 `ctx.session`。多声明的依赖会让插件等到会话服务就绪才激活，等于给启动顺序加了一条实际不需要的约束。
- 证据：
  ```
  302:   inject: ['tools', 'commands', 'settings', 'transcript', 'guards', 'prompt', 'session'],
  1250:     const offSessionOpen = ctx.on('dsc/session-open', () => {
  ```
- 影响：插件中心里关掉某个 `session` 相关包时，browser 会跟着起不来，而它其实只需要事件；排查这类「开关联动」时 `inject` 是唯一线索，多一条就多一次误判。
- 建议：从 `inject` 删掉 `'session'`，跑一次 `pnpm run typecheck` 确认事件仍能到（`dsc/session-open` 走的是事件总线，不依赖服务就绪）。
- 置信度：高

#### [P2] P2-5 · `safeStringify` 两个插件都 import 了却都没用

- 位置：`src/packages/browser/index.ts:47`、`src/packages/dock-browser/index.ts:59`；唯一消费者在 `src/packages/cdp/report.ts:87`
- 现象：两个插件的 import 列表里都带着 `safeStringify`，文件体内零引用——`consoleLineTextOf` 已经在 `report.ts` 内部用了它。
- 证据：
  ```
  browser/index.ts:47:   safeStringify,
  dock-browser/index.ts:59:   safeStringify,
  report.ts:87:       if (record.value !== undefined) return safeStringify(record.value)
  ```
- 影响：`cdp/report.ts:9-10` 的注释正是「这几个函数原先在两处逐字各写一份…合到一处后」，现在 import 表里还留着一半的痕迹，下一个人会以为插件层也要用它。
- 建议：删掉两处 import；若开了 `noUnusedLocals` 这类检查，它们本来就会红。
- 置信度：高

### @pneuma/cdp

#### [P1] P1-5 · 共享层的错误文案写死了 `browser_look`，dock 侧报错指向另一个插件的工具

- 位置：`src/packages/cdp/snapshot.ts:372`、`:377`、`:382`；`src/packages/cdp/actions.ts:228`、`:292`；消费点在 `src/packages/dock-browser/index.ts:414-418`、`:644`
- 现象：`lookupSnapshotRef` 的三条拒绝理由、`verifyRef` 的「页面已变」、`waitForClickPoint` 的超时提示，都把工具名硬编码成 `browser_look`。`dock-browser` 直接复用这三处，于是它报给模型的是「先 browser_look action=snapshot」——那是 `browser` 插件的工具，在桌面端很可能根本没打开；而且 dock 侧自己的工具名是 `browser_dock_look`（且默认不注册，见 P0-1）。
- 证据：
  ```
  snapshot.ts:372:     return { ok: false, reason: '这次动作要一个 ref（形如 e5）。先 browser_look action=snapshot 拿一份快照' }
  snapshot.ts:382:       reason: `ref「${name}」属于上一次快照：页面已变，请重新 snapshot（browser_look action=snapshot）再动手`,
  actions.ts:228:         '页面已变，请重新 snapshot（browser_look action=snapshot）拿新 ref 再动手',
  ```
- 影响：模型照着错误信息去调一个不存在的工具，失败后再被同样的信息指一次；用户看到的是「agent 在乱调工具」。这是共用内核最常见的漏水方式——算法抽走了，给人看的话术没抽。
- 建议：给 `lookupSnapshotRef` / `verifyRef` / `waitForClickPoint` 加一个 `hint: { snapshotTool: string; waitTool?: string }` 参数（或一个 `ToolNames` 类型），两个插件各传自己的名字；`cdp/snapshot.ts` 的默认值保留 `browser_look` 只为兼容自检。
- 置信度：高（三处调用点全部核对）

#### [P2] P2-6 · 传输层的 `onClose` / `onAny` / `pendingCount` / `reason` 没有生产消费者，注释却写着「崩溃重连靠它」

- 位置：`src/packages/cdp/transport.ts:184-192`、`:270-286`；对照 `src/packages/cdp/launch.ts:403-442`
- 现象：`onClose` 的注释是「崩溃重连靠它：浏览器被杀、页面被关、CDP 主动断，都会走到这里」，但 `BrowserProcess.browserTransport` 从不订阅 `onClose`，它是在下一次调用时用 `transport.closed` 懒判断（`:405`）。`onAny`（注释写「调试与自检用」）、`pendingCount`（注释写「诊断与自检用」）、`reason` 在全仓 `src`+`scripts` 里零引用。
- 证据：
  ```
  277:    * 订「连接断了」。返回退订函数。
  278:    * 崩溃重连靠它：浏览器被杀、页面被关、CDP 主动断，都会走到这里。
  405:     if (this.transport !== null && !this.transport.closed) return this.transport
  ```
- 影响：读代码的人会以为「浏览器被杀之后会自动重连」，实际要等模型下一次调工具才发生；排查「点了没反应」时会往错误的方向找。另外这三个导出挂在 `CdpTransport` 的公开面上，任何人改这个类都得考虑它们。
- 建议：把注释改成事实（「下次调用时按 `closed` 懒重连」）；`onAny`/`pendingCount`/`reason` 若确认只服务自检，标注 `@internal` 或删掉——本轮在 `src` 与 `scripts` 都没搜到使用者。
- 置信度：中（`src` 与 `scripts` 都 grep 过；`lib/` 是产物不计）

### @pneuma/computer-use

#### [P1] P1-6 · `desktop-control.ts` 1521 行扛着六类职责，`runDesktopAction` 一个 switch 196 行

- 位置：`src/packages/computer-use/desktop-control.ts`（整文件）
- 现象：按段数，这个文件实际是六个模块压在一起：

  | 职责 | 行区间 | 行数 |
  | --- | --- | --- |
  | 动作枚举 / 别名 / 只读档 | 31-69 | 39 |
  | PowerShell 源码常量（P/Invoke、UIA 引导） | 124-198 | 75 |
  | 键名表 / 鼠标键位 / 引号转义 | 200-251 | 52 |
  | PowerShell 进程执行（`activeChildren`、急停、超时） | 253-317 | 65 |
  | 脚本生成器 ×14（截屏、观察、元素动作、拖拽、点击、滚动、按键、粘贴、输入、列窗口/应用/显示器、探窗） | 342-719 | 378 |
  | 纯函数：坐标换算 / 目标解析 / 帧缓存 / 差分 / settle | 721-1006 | 286 |
  | 进程内动作（`probeScreen`/`assertAllowedApp`/`observeAppState`/`bindWindow`/`clickAt`/`typeText`） | 1008-1136 | 129 |
  | `runDesktopAction` 总分派 switch | 1143-1338 | 196 |
  | 元素动作 / 截图 / 前台 / 显示器 | 1340-1441 | 102 |
  | 危险分级 + 审计 + 沙箱说明 | 1443-1521 | 79 |

- 证据：
  ```
  1143: export async function runDesktopAction(
  1154:   switch (canonical) {
  1164:     case 'click': {
  ```
- 影响：14 个脚本生成器是最常改的一段（Windows 每个版本的行为差异都落在这里），但改它们要在一个 1521 行的文件里翻；`runDesktopAction` 的 16 个分支每个都要重复「`probeScreen` → `assertAllowedApp` → `bindWindow`」这三步（`:1165-1168`、`:1176-1179`、`:1188-1190`、`:1196-1198`、`:1212-1214`…），漏一个就是不设白名单的动作。
- 建议：按上表切成五个文件：`powershell.ts`（253-317 + `psQuote`，与沙箱那两份合并，见 P1-7）、`scripts.ts`（342-719，纯字符串函数，自检直接断言，本来就是这么设计的）、`frames.ts`（721-1006）、`desktop-control.ts`（1008-1338 + 1340-1441）、`audit.ts`（1443-1504）。`runDesktopAction` 里的「三步前置」抽成一个 `prepare(args)` 返回 `{bounds, bind}`，16 个分支就不会再各写一遍。
- 置信度：高（全文读过，行数按段数出来的）

#### [P1] P1-7 · `runPowerShell` 全仓三份，返回形状三种；桌面这份还走 PATH

- 位置：`src/packages/computer-use/desktop-control.ts:277-317`、`src/packages/sandbox/win/doctor.ts:243`、`src/packages/sandbox/win/setup.ts:367`
- 现象：三份同名函数，签名与返回形状互不相同：桌面这份返回 `Promise<string>`（只给 stdout，非零退出就把 stderr 抛出去）；`doctor.ts` 返回 `{code, stdout, stderr}`；`setup.ts` 返回 `{code, stdout, stderr, timedOut}`，第三份多一个 `timedOut`，另两份没有。
- 证据：
  ```
  desktop-control.ts:277: export function runPowerShell(script: string, timeoutMs = 20000, signal?: AbortSignal): Promise<string> {
  doctor.ts:243: function runPowerShell(command: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  setup.ts:367: function runPowerShell(
  ```
  另一处差异：沙箱两份都钉死系统 PowerShell 5.1 的绝对路径（`setup.ts` 的 `systemPowerShellPath()`、`doctor.ts` 里 `join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...)`），桌面这份直接 `spawn('powershell.exe', ...)`（`desktop-control.ts:279-283`），吃 PATH。
- 影响：三份各自处理超时/杀进程/编码，改一处（比如把输出编码统一成 UTF-8——`doctor.ts:250` 已经这么做了，另两份没做）就要改三处；桌面这份走 PATH，意味着 PATH 里排在前面的同名可执行文件会被优先启动，而它接下来要注入鼠标键盘事件。中文输出在 `-NoProfile` 的 PS 5.1 下按 GBK 出来，桌面这份没有 `[Console]::OutputEncoding` 那一步。
- 建议：抽到 `src/packages/sandbox/win/powershell.ts`（或 `core/powershell.ts`）：`runPowerShell(command, {timeoutMs, signal, encoding}) → {code, stdout, stderr, timedOut}`，三处改成薄包装；顺便把可执行文件路径钉死成系统 5.1（桌面控制尤其需要，它依赖 `Add-Type` 与 UIA 程序集）。
- 置信度：高（三份都读了实现体；`setup.ts`/`doctor.ts` 只读 350-410 与 225-300 段）

#### [P2] P2-7 · `LOOK_ACTIONS` 只是 `READ_ACTIONS` 的别名，同一份清单两个名字混用

- 位置：`src/packages/computer-use/index.ts:95`；`READ_ACTIONS` 定义在 `desktop-control.ts:62-69`，两处消费（`index.ts:315/317/435/452` 用 `LOOK_ACTIONS`，`index.ts:352` 与 `desktop-control.ts:1457` 用 `READ_ACTIONS`）
- 现象：`export const LOOK_ACTIONS: readonly DesktopAction[] = READ_ACTIONS`，然后同一个文件里两种名字混用。
- 证据：
  ```
  95: export const LOOK_ACTIONS: readonly DesktopAction[] = READ_ACTIONS
  352:         if (READ_ACTIONS.includes(action)) {
  ```
- 影响：改「什么算只读」时要先确认这两个名字还相等；`index.ts:352` 用 `READ_ACTIONS` 而 `:315` 用 `LOOK_ACTIONS`，读起来像两套判定，实际一套。
- 建议：删掉别名，统一叫 `READ_ACTIONS`（它已经有 `desktop-control.ts:61-69` 的注释说明语义）。
- 置信度：高

### @pneuma/desktop-dock

#### [P1] P1-8 · 工作区围栏的第三份实现没跟上 `path-policy` 的 realpath 修补，还带着 `..foo` 误判

- 位置：`src/packages/desktop-dock/index.ts:632-636`（`inside`），使用点 `:125`、`:333`、`:366`、`:385`；对照 `src/core/path-policy.ts:124-139`、`:142-149`、`:152-157`；第三份在 `src/packages/sandbox/policy.ts:566-576`
- 现象：全仓「目标是否在根内」有三份实现。`core/path-policy.ts` 的 `isInsideCwd` 会先 `realpathSync` 跟到底（注释 `:152-157` 写着这是 2026-10-30 为「把 `~/.ssh/id_rsa` 软链成 `notes.txt` 之后的绕过」专门补的）；`sandbox/policy.ts:566` 的 `insideRoot` 至少按 win32 归一大小写、并且明确避开了 `startsWith('..')` 的误判（`:572-574` 的注释）；`desktop-dock` 的 `inside` 两样都没有：
  ```
  632: function inside(path: string, root: string): boolean {
  633:   if (!isAbsolute(path)) return false
  634:   const rel = relative(resolve(root), resolve(path)).toLowerCase()
  635:   return rel === '' || (!rel.startsWith('..') && !rel.split(/[\\/]/)[0]!.includes(':'))
  636: }
  ```
- 证据：`path-policy.ts:147` 的对应规避写法是 `const parent = rel === '..' || rel.startsWith(\`..${sep}\`)`，注释 `:146` 点名「`..foo` 是根内的普通文件」；`sandbox/policy.ts:573` 的注释更直白：「不能笼统 `startsWith('..')`——根内名为 `..foo` 的文件会被误判成越界」。`desktop-dock` 正好踩了这一句。
- 影响：两个方向都有实例。(1) 工作区里放一个指向 `C:\Users\<me>\.ssh` 的目录 junction（Windows 上不需要管理员权限），`fs-read` 的 `file=junction/id_rsa` 会通过 `inside` 检查并把文件读给界面——`dock-ops.ts:16` 的威胁模型写的正是「浏览器里拿到 Cookie 的页面不该有这个能力」，而读档是**明确放行**给界面 HTTP 面的（`ui-methods.ts:417`）。(2) 工作区里有个叫 `..notes` 的目录，`fs-list` 会被误判成越界，用户看到「路径超出工作目录」但文件明明在里面。
- 建议：删掉 `desktop-dock` 的 `inside`，改调 `isInsideCwd(baseCwd(), target)`（`core/path-policy.ts:142`）——三个调用点（`fs-list`/`fs-read`/`term-spawn`）语义一致，`readUntracked` 那条也一样。若担心 `realpathSync` 的开销，至少补上 `rel === '..' || rel.startsWith(\`..${sep}\`)` 这一句。做完顺手在 `desktop-dock/tests` 里加一条 junction 用例（临时目录 + `fs.symlinkSync(..., 'junction')`）。
- 置信度：高（三份实现逐行对照过；junction 这条路 Windows 语义已确认，`path-policy.ts:152-157` 的注释也是同一个结论）

#### [P1] P1-9 · 没有 `inject` 声明，靠 `ctx.get` 摸 `session` / `approval` / `git`，其中 `session` 是手写结构类型

- 位置：`src/packages/desktop-dock/index.ts:271-272`（无 `inject`）、`:290-296`（`session`）、`:317-318`（`approval`）、`:612`（`git`）
- 现象：插件只 `provide: 'dock'`，一个 `inject` 都没写，但运行时要三个别的服务：当前会话的 cwd、审批裁决、git 快照刷新。`session` 那个还用手写结构类型 + 双层可选链去取 `meta.cwd`，绕过了任何契约类型。
- 证据：
  ```
  271:   provide: 'dock',
  291:       const session = ctx.get('session') as
  292:         | { current(): { meta?: { cwd?: unknown } } }
  293:         | undefined
  612:       if (write) ctx.get('git')?.refresh()
  ```
- 影响：三个依赖都不在声明里，激活顺序只能靠「调用时它们已经起来了」这个巧合；`fallbackCwd`（`:277`）就是为了兜住这个窗口期，于是多了一条「宿主刚起来时文件面板指向启动目录」的路径。`session` 手写的 `{current(): {meta?: {cwd?: unknown}}}` 一旦上游改了 `current()` 的形状，这里不会编译报错，只会在运行时静默落回 `fallbackCwd`——`:282-288` 的注释正是这个 bug 的历史（用户报「切了工作区面板还指着旧目录」），下次再犯时没人能靠类型发现。
- 建议：`inject: ['session', 'approval', 'git']`（`approval` 若确实可能缺席，用 cordis 的可选 inject 形式），并把 `session` 的形状换成契约里的类型；若 `src/services/types.ts` 里没有 `session` 的契约类型，先补类型再改这里。
- 置信度：高（`grep inject|provide|ctx.get` 全文确认；服务名 `session`/`approval`/`git` 与 `browser/index.ts:302` 的 inject 清单同名）

#### [P2] P2-8 · 分档清单只有一份数据，但两个判定函数没人用，`runOp` 还把类型丢了

- 位置：`src/core/dock-ops.ts:30`、`:45`、`:53`、`:60-62`；`src/packages/desktop-dock/index.ts:327`、`:609`；`src/core/ui-methods.ts:417`
- 现象：`dock-ops.ts` 定义了 `DOCK_READ_OPS` / `DOCK_OPS` / `isDockTermOp` / `DockOp`，但全仓只有三个东西真的被用：`isDockWriteOp`（`desktop-dock:609`）、`DOCK_UI_OPS`（`ui-methods:417` 的实参枚举）、`DOCK_WRITE_LABEL`（`desktop-dock:319`）。`DOCK_OPS`、`DOCK_READ_OPS`、`isDockTermOp`、`DockTermOp`、`DockOp` 零外部引用。而 `runOp(op: string, ...)`（`:327`）收的是 `string` 而不是 `DockOp`——新加第 15 个 op 时，`dock-ops.ts` 加了名字，`runOp` 的 switch 不会编译报错，只会在运行时走到 `default`。
- 证据：
  ```
  327:     const runOp = async (op: string, payload: Record<string, unknown>, cwd: string): Promise<unknown> => {
  594:           throw new Error(`dock 未知操作：${op}`)
  ```
- 影响：分档的「读 / 写 / 终端」在数据层是单份的（这点没问题，不是重复定义），但检查面漏了：真正决定「这个 op 能不能从 HTTP 进来」的只有 `ui-methods.ts:417` 的枚举，`desktop-dock` 自己不校验 op 是否在名单里，靠 switch 的 `default` 兜。加 op 时忘改一处就是「界面点了没反应，日志里一句 dock 未知操作」。
- 建议：`runOp(op: DockOp, ...)`，并在 `handle` 入口加一句 `if (!DOCK_OPS.includes(op)) throw ...`（用上已有的常量）；删掉确认为死的 `isDockTermOp` / `DOCK_READ_OPS`，或给它们找到调用点——若终端档真的只靠传输保证，就在注释里写明「这两个函数是给未来用的」，别让它们看起来像主路径。
- 置信度：高（`DOCK_UI_OPS|DOCK_READ_OPS|DOCK_OPS|isDockTermOp` 全仓 grep 过）

### @pneuma/host-stdio

#### [P1] P1-10 · 第二套「自增号 + 待办表 + 超时」，以及第三个 `CdpCommandTarget` 实现

- 位置：`src/packages/host-stdio/index.ts:245-285`；对照 `src/packages/cdp/transport.ts:109`、`:201-246`（第一套）、`src/core/dock-session.ts:40-58`（第三个实现）、`src/packages/cdp/transport.ts:376-402`（`CdpSessionView`）
- 现象：`CdpTransport.send` 与 `host-stdio.requestBrowser` 是同一套骨架的两份实现：自增 id、`Map<number, Pending>`、每命令一个 `setTimeout`、settle 时摘表清定时器、迟到应答丢弃。`createDockSession` 又给 `CdpCommandTarget` 造了第三个形状（`CdpSessionView` 一个、dock 会话一个）。
- 证据：
  ```
  host-stdio/index.ts:263:     const requestBrowser = <T>(build: (id: number) => RuntimeToHostMessage, what: string, timeoutMs: number): Promise<T> => {
  host-stdio/index.ts:269:           if (entry === undefined) return // 已经结过账（超时后迟到的应答）：丢掉
  transport.ts:337:     if (entry === undefined) return // 超时后迟到的应答：丢掉
  ```
  两处连注释都是同一句话，说明是照抄的。
- 影响：超时、取消、迟到应答、断开时统一拒绝这四条语义现在有两份，各自演化。举一个具体缺口：`CdpTransport.send` 支持 `signal`（`transport.ts:224-239`），`requestBrowser` 不支持——于是 dock 路径上任何一条 CDP 命令都不能被用户打断（与 P1-3 的只读路径不可取消是同一个病的两个位置）。另外 `host-stdio` 的 pending 表在 `dispose` 里要手工遍历拒绝（`:395-397`），`CdpTransport` 在 `handleClose` 里做同一件事（`:356-372`）。
- 建议：把这层抽成 `src/core/pending-calls.ts`（`createPendingTable<T>({timeoutMsOf, onSettle})`），两处共用；`requestBrowser` 加 `signal` 参数，把 `runCtx.signal` 一路透到 `link.call`。`createDockSession` 不用动——它是刻意的适配器（`core/dock-session.ts:1-16` 说清了为什么），但应在注释里点明它和 `CdpSessionView` 是「同一接口的两个后端」，避免下一个人再写第三个。
- 置信度：高（两份实现全文对照；`createDockSession` 的调用点只有 `host-stdio:348`）

### 跨包：core 侧的旧路径

#### [P2] P2-9 · 7 个 `core/cdp` 垫片零引用、`core/desktop-control` 只剩一个测试，另有 9 处注释仍指旧路径

- 位置：`src/core/cdp/{actions,cloud-metadata,launch,report,ring-buffer,snapshot,transport}.ts`（每个 1 行 `export *`）、`src/core/desktop-control.ts`（1 行）；注释残留：`src/packages/browser/index.ts:23`、`src/packages/dock-browser/index.ts:21`、`src/core/dock-session.ts:2`、`:9`、`src/core/dock-browser.ts:25`、`src/core/host-browser-link.ts:51`、`src/packages/cdp/ring-buffer.ts:8`、`src/core/clock.ts:4`、`src/packages/host-stdio/index.ts:347`
- 现象：按「解析 import 说明符 → 落到真实文件」的口径，7 个 `core/cdp/*` 在 `src`、`scripts`、`desktop/electron`、`ui-shell/src` 里**零引用**（`scripts/` 里连 `lib/core/cdp/` 都没有）。`core/desktop-control.ts` 只被 `scripts/computer-use-test.mjs:57` 用动态 `import('../lib/core/desktop-control.js')` 引用——静态扫描看不见，这是垫片一直没被删的原因。另外 9 行注释还在告诉读者「实现在 `src/core/cdp/`」，那是个只剩 7 个转发文件的目录。
- 证据：
  ```
  src/core/cdp/actions.ts:1: export * from '../../packages/cdp/actions.js';
  scripts/computer-use-test.mjs:57: } = await import('../lib/core/desktop-control.js')
  src/packages/browser/index.ts:23:  * 支撑模块（本插件独占）：`src/core/cdp/{transport,launch,snapshot,actions}.ts`
  ```
- 影响：读代码的人会先翻 `src/core/cdp/`，看到 7 个一行文件再折回来，多一跳；更要紧的是 `cdp` 包自己的注释（`ring-buffer.ts:8`）也指向旧路径，等于新位置的人被旧路径引走。这批文件和全仓 58 个垫片是同一批债，但**本批次这 8 个里有 8 个是死的**（7 个 cdp + 1 个 desktop-control），比全局口径里的 39/58 更高。
- 建议：删 7 个 `core/cdp/*`；把 `scripts/computer-use-test.mjs:57` 的 import 改到 `lib/packages/computer-use/desktop-control.js` 之后再删 `core/desktop-control.ts`；9 处注释改成 `src/packages/cdp/`。删完在 CI 里加一条字面扫描「`src/core` 下不允许出现 `../packages/`」（这正是 `90-global-evidence.md` 第 7 节建议的那一条）。
- 置信度：高（`core/cdp/`、`core/desktop-control`、`core/cdp/` 三组 grep 都做过；动态 import 那处已定位到具体行）

#### [P2] P2-10 · 同一批浏览器动词有三张表，只有 dock 的那张住在契约层

- 位置：`src/packages/browser/index.ts:615-630`（13 个）、`src/core/dock-browser.ts:154-174`（9 个）、`src/packages/computer-use/desktop-control.ts:31-48`（16 个）
- 现象：`navigate / click / hover / type / press / scroll / evaluate / close` 这 8 个动词在 `browser` 与 `dock` 两张表里各列一遍，`browser` 那张还是插件内私有常量；只有 dock 的枚举提到 `core/dock-browser.ts`，因为桌面主进程也要认。`computer-use` 那张语义不同（点的是屏幕坐标），可以不合并，但「浏览器类」的两张应该是一张。
- 证据：
  ```
  browser/index.ts:615:     const lookActions = ['snapshot', 'screenshot', 'console', 'network', 'tabs', 'wait_for']
  browser/index.ts:616:     const actActions = [
  core/dock-browser.ts:164: export const DOCK_ACTIONS: readonly string[] = [
  ```
- 影响：抽内核时枚举会成为第三个争点（前两个是传输与寻址）；现在两张表已经漂了——`browser` 有 `select/fill_form/upload/dialog/frame`，`dock` 有 `open` 却没有 `dialog`（P0-2），谁也不知道这是「后端能力不同」还是「忘记补」。
- 建议：把「浏览器动作名」提到 `src/contract/browser-actions.ts`，用能力标记区分（`DOCK_SUPPORTED` / `FRAME_SUPPORTED` 之类），两个插件从它派生自己的枚举；`computer-use` 的 `DESKTOP_ACTIONS` 保持独立。
- 置信度：高（三张表逐条比对过）

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
| --- | --- | --- | --- | --- |
| CDP 传输/启动/快照/动作（7 个垫片） | `src/core/cdp/{actions,cloud-metadata,launch,report,ring-buffer,snapshot,transport}.ts`（每个 1 行 `export *`） | `src/packages/cdp/*.ts`（经 `@pneuma/cdp/xxx.js` 子路径） | **无人**：`src` + `scripts` + `desktop/electron` + `ui-shell/src` 全 grep 过，只有 9 行**注释**提到 `core/cdp/`（见 P2-9） | 直接删 7 个垫片；`scripts/` 里没有 `lib/core/cdp/` 的 import，删完不影响自检 |
| 桌面操作实现 | `src/core/desktop-control.ts`（1 行垫片，指向 `packages/computer-use/desktop-control.js`） | `src/packages/computer-use/desktop-control.ts` | 只有 `scripts/computer-use-test.mjs:57` 动态 `import('../lib/core/desktop-control.js')` | 把测试改到 `lib/packages/computer-use/desktop-control.js`，再删垫片（改动只有一行 import，属批次 06/09 的测试收敛口径） |
| dock 浏览器契约 | `src/core/dock-browser.ts`（`HOST_PROTOCOL_VERSION`、命令/事件白名单、`DockViewInfo`、`CdpCommandTarget`、动作枚举、线上消息类型） | 无新家（这份就是权威定义） | **是活代码**：`host-stdio:27/32/33`、`dock-browser:40`、`cdp/transport.ts:24`（类型）、`core/dock-session.ts:18`、`core/host-browser-link.ts:16`、`desktop/electron/main/dock.ts:27-32`、`scripts/dock-browser-test.mjs:160` | 保留。它的注释（`:4-9`）解释了为什么不放包内（两棵编译树 + 探针类型擦除直读），这个理由成立 |
| dock 会话适配 | `src/core/dock-session.ts`（`createDockSession`） | 无替代 | **是活代码**：`host-stdio:34/348`、`scripts/dock-browser-test.mjs:176` | 保留。它把「无 WebSocket 后端」包成 `CdpCommandTarget`，是 `cdp` 动作层能复用的前提 |
| 宿主浏览器链路门面 | `src/core/host-browser-link.ts`（接口 + 服务名 + 错误类） | 实现只有 `host-stdio` 一份 | **是活代码**：`dock-browser:41/302`、`host-stdio:35-36` | 保留；注意它第 4 行注释还写着 `src/plugins/dock-browser.ts`（旧路径），随 P2-9 一起改 |
| `HOST_PROTOCOL_VERSION` 出口 | `host-stdio/index.ts:52` 的 `export { HOST_PROTOCOL_VERSION }` | `core/dock-browser.ts:20` 的定义 | `scripts/dock-browser-test.mjs:205-206` **明确断言**这个旧出口必须留着（否则旧 import 编不过）；`host-stdio/tests/host-stdio.test.mjs:64` 用它比对 | 保留（有测试钉着，属刻意的兼容层，不判死） |

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
| --- | --- | --- | --- | --- |
| 浏览器工具层（快照包装 / 只读动作 / 动手动作 / 工具 schema） | `browser/index.ts:572-611`、`632-742`、`758-1051`、`1055-1140`（565 行） | `dock-browser/index.ts:383-418`、`422-548`、`564-735`、`739-814`（490 行） | 8 个动作逐段对位；dock 独有 `open`、截图可见性闸、`waitForDockPage`（合计约 72 行）；browser 独有 select/fill_form/upload/dialog/frame（约 105 行）。两边的工具名与输出前缀不同 | 见 P1-1：先抽快照包装 + 事件映射 + schema，动作分支第二步 |
| 事件 → 环形缓冲的映射 switch | `browser/index.ts:439-501`（63 行，`session.on` 逐条订阅） | `dock-browser/index.ts:240-296`（57 行，单条 `link.onEvent` + switch） | 分支内容一字不差；dock **少两个 case**（`Page.javascriptDialogOpening/Closed`），见 P0-2 | 抽 `createEventSink({console, network, invalidate})` 到 `cdp` 包，两边各喂一个事件源 |
| 输入文本前的凭据体检 | `browser/index.ts:747-756` | `dock-browser/index.ts:553-562`、`computer-use/index.ts:417-427` | 三份骨架相同（`text === '' → null`；`redact(text) !== text → 提示`）；`computer-use` 多一条 `classifyCommand` 灾难命令判定（`:422-425`）；括号里顿号不同（`/` vs `、`），`computer-use` 多一个「密码」；末句「或者先用设置里的『求值』/ evaluate 做别的办法」两有一无；变量名 `text` / `value` / `text` | 抽 `core/text-input-guard.ts`：`secretShapedReason(text, {where: 'web'\|'desktop', alternative?})`；灾难命令判定留在 `computer-use`（依赖 `command-policy`，且只对桌面有意义） |
| 「目标是否在根内」 | `core/path-policy.ts:142-149`（跟 realpath，win32 归一） | `desktop-dock/index.ts:632-636`、`sandbox/policy.ts:566-576`，另有第四份 `core/web-static.ts:33-36`（静态文件伺服，纯前缀匹配，语义不同） | `path-policy` 跟软链 + 只认 `..` 或 `..\`；`desktop-dock` 不跟软链 + 用 `startsWith('..')`（会误判 `..foo`）；`sandbox/policy` 与 `path-policy` 同款规避但自己算 win32 归一 | 见 P1-8：`desktop-dock` 改调 `isInsideCwd`；`sandbox/policy` 可保留（它要 `win32` 参数化），但应在注释里指向 `path-policy` 说明为什么不能直接复用 |
| PowerShell 执行体 | `computer-use/desktop-control.ts:277-317`（→ `string`，超时抛错，支持 signal） | `sandbox/win/doctor.ts:243`（→ `{code,stdout,stderr}`）、`sandbox/win/setup.ts:367`（→ `{code,stdout,stderr,timedOut}`） | 返回形状三种；沙箱两份钉死系统 PS 5.1 绝对路径，桌面这份走 PATH；只有 `doctor` 设了 UTF-8 输出编码 | 见 P1-7：合成 `sandbox/win/powershell.ts`，三处改薄包装 |
| CDP 命令的「id 配对 + 待办表 + 超时」 | `cdp/transport.ts:109`、`:201-246`（WebSocket 方向） | `host-stdio/index.ts:245-285`（父端口方向） | 骨架相同，连「超时后迟到的应答：丢掉」的注释都一样；`requestBrowser` **没有** `signal` 支持 | 见 P1-10：抽 `core/pending-calls.ts` |
| `CdpCommandTarget` 的实现 | `cdp/transport.ts:376-402`（`CdpSessionView`，按 sessionId 过滤事件） | `core/dock-session.ts:40-58`（`createDockSession`，按 viewId + method 双过滤） | 语义等价、后端不同 | 保留两份（这是刻意适配），但补一句互相指认的注释，别让第三份出现 |
| 「等到能动手」的等待 | `cdp/actions.ts:588-601`（轮询 `readyState`） | `dock-browser/index.ts:351-370`（轮询 URL 是否落到目标） | 一个等加载状态、一个等地址；都不是网络空闲（全仓无 `networkidle`） | dock 那份可以留在 dock（壳自己发起 load，host 侧看不到 readyState 的时机），但两处都应注明「不是 networkidle」 |
| 只读档遇「免审批关闭」的处理 | `computer-use/index.ts:429-447`（把只读动作并进 exec 工具一起过审批） | `dock-browser/index.ts:818-826`（干脆不注册） | 见 P0-1，两种答案 | 以 `computer-use` 为模板，`dock-browser` 跟齐 |
| 动作词表 | `browser/index.ts:615-630`（13 个，插件内私有） | `core/dock-browser.ts:154-174`（9 个，契约层）+ `computer-use/desktop-control.ts:31-48`（16 个，插件内） | 同一批动词散在两个层：`browser` 与 `computer-use` 的枚举在插件里，只有 dock 的在契约里 | 见 P2-10：浏览器类两张合到 `src/contract/browser-actions.ts`；`computer-use` 保持独立 |

## 待核实

1. **`viewId` 会不会复用**：`dock-browser/index.ts:310-322` 的 `generation` 在新建 `ViewState` 时从 0 开始。桌面侧发号规则（`agent-N`）在 `desktop/electron/main/dock.ts` 里（本轮只 grep 未通读），如果壳会复用 id，旧 ref 的代际可能与新视图撞上；这条决定 P2-2 是 P2 还是 P1。
2. **Electron 的 `webContents.debugger` 到底推不推 `Page.javascriptDialogOpening`**：`desktop/electron/main/dock.ts:374` 只做白名单过滤，没看到对事件类型的额外处理。若根本不推，P0-2 的「丢弃」仍成立（`default` 分支会把将来新增的白名单事件一起丢掉），但修复优先级可以从「补 case」降到「先删两条 + 文档写明不支持」。
3. **`desktop/electron/main/dock.ts:86` 的 `isHttpUrl`**：这是「只认 http(s)」的第四份实现（另三份是 `browser/index.ts:238-243` 的协议判定、`dock-browser/index.ts:149-151` 的 `assertHttpUrl`、`core/dock-browser.ts:99-103` 的 `dockNavigateTarget` 只抽 URL 不判协议）。本轮只读了命中行，没读函数体，所以没写成发现；若它和 `assertHttpUrl` 的判据有出入（大小写、尾斜杠、空主机），就是一条新的 P2。
4. **`scripts/dock-browser-test.mjs` 的文本断言**（561 行，`:189-229` 直接读 `src/core/dock-browser.ts` 的源码文本，并断言「不许出现 import」「不许本地定义 `HOST_PROTOCOL_VERSION`」）：这三份 `core/dock-*` 文件在改造时必须同步改这个脚本。本条属批次 06/09 的测试口径，这里只做提示。
5. **`cdp` 库包对 `@pneuma/runtime` 的依赖**：`snapshot.ts:22`（`oneLine`）、`report.ts:19-20`（`clockText`、`neutralizeInline`）、`actions.ts:31`（`readBlockReason`）。方向本身合规（包 → `@pneuma/runtime`），本轮没判为问题；但 `actions.ts` 为了 `upload` 拉进了读禁清单，意味着 CDP 动作层不是「与宿主策略无关的库」。若将来第三个后端（远程浏览器之类）要复用 `cdp`，这条依赖会成为障碍——列入观察，不列为发现。
6. **`runCtx.signal` 透到 `link.call` 的可行性**：`HostBrowserLink.call`（`core/host-browser-link.ts:47`）签名里没有 signal，`requestBrowser` 也没有；P1-3 / P1-10 的修复要同时动这条链上的三个签名（`link.call`、`requestBrowser`、`createDockSession.send`）。本轮只读，未验证改签名对 cordis 服务接口的影响面。
7. **`browser` 设置页的 `look-tab` 按钮**（`browser/index.ts:1413-1431`）用 15 秒 `AbortController`，而 `ensurePage` 里冷启动的超时是 30 秒（`launch.ts:148` 的 `LAUNCH_TIMEOUT_MS`）。冷启动时点这个按钮可能稳定拿到「操作超时」——要真起一台浏览器才能确认，本轮按静态阅读列入待核实，没写成发现。
