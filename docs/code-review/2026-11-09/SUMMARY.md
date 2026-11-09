# 汇总：Pneuma 代码规范与架构审查（2026-11-09）

> 分支 `feat/pluginization`，按工作区现状只读审查；未修改任何源码。
> 逐批报告在本目录 `01-…` 至 `10-…`，跨批次机械取证在 `90-global-evidence.md`，
> 改造方案在 `ARCHITECTURE.md`。
>
> **10 个批次、200 条发现：P0 15 / P1 96 / P2 89。主控核对后 P0 保留 14 条**
> （批次 04 的「折叠偏好」降为 P1，理由见主题 B）。

## 一、批次统计

| 批次 | 主题 | P0 | P1 | P2 | 报告 |
| --- | --- | --- | --- | --- | --- |
| 01 | 内核底座与会话链路 | 1 | 9 | 9 | `01-kernel-session.md` |
| 02 | 插件模型与装配 | 3 | 9 | 12 | `02-plugin-runtime.md` |
| 03 | 界面壳与界面运行时 | 1 | 7 | 7 | `03-ui-shell.md` |
| 04 | 对话呈现 | 1 | 12 | 8 | `04-conversation-ui.md` |
| 05 | 侧栏、设置与文件 | 1 | 9 | 10 | `05-sidebar-settings.md` |
| 06 | 工具与安全 | 3 | 10 | 7 | `06-tools-security.md` |
| 07 | 智能体编排 | 2 | 12 | 10 | `07-agent-orchestration.md` |
| 08 | 浏览器与桌面控制 | 2 | 10 | 10 | `08-browser-desktop.md` |
| 09 | 连接与外部工具 | 1 | 9 | 6 | `09-connectivity.md` |
| 10 | TUI 与入口 | 0 | 9 | 10 | `10-tui-entry.md` |
| **合计** | **10 个批次** | **15** | **96** | **89** | **200 条** |

## 二、P0：已经在出错或必然出错

跨批次共 14 条（批次报告合计 15 条；批次 04 的「折叠偏好」经主控核对降为 P1，
理由见下面主题 B）。其中 P0-1、P0-2 目前**没有内置使用者**，是对外契约与第三方插件的坑；
P0-3、P0-4 是现网每次点开关都会走到的路径；P0-5 只在 TUI 状态栏可见（费用默认开）；
P0-6、P0-7 是多会话常驻下的现网问题；P0-8、P0-9、P0-10 是安全链上的现网缺口；
P0-11 正好落在这次未提交的「统一预览页签」改动上；P0-12、P0-13 是侧栏浏览器
（`dock-browser`）默认配置下的两条断链；P0-14 是 Windows 上 MCP 的官方示例起不来。

### P0-1 插件声明的 `services` 在组启动图时被丢掉

- 位置：`core/ui-manifest.ts:295-302`（丢弃）、`core/ui-bundles.ts:1774`（上游有值）、
  `ui-boot/ui/boot.ts:498/583`（下游读不到）。
- 人话：插件写「我要等 actions 服务就绪再装」，启动图里根本没有这一项，装载器读到空数组，
  于是**从来没有等过**。第三方插件照着 README 写 `services`，实际不生效。
- 修法：`composeUiBootGraph` 的 map 补一行透传，加一条探针。
- 主控核对：已读三处原文，确认 `entries` 只搬了 `inject/external/immediately`。

### P0-2 组合包 patch 里的 `config:` 从未被读取

- 位置：`core/plugin-patch.ts:199-202`（实现「整块替换」）、`core/plugin-loader.ts:1580-1586`
  （挂载时只传 inject/native/宿主配置）、`:495`（配置只从 `plugins.json` 取）。
- 人话：组合包在 `cordis.patch.yml` 里写 `config: {...}`，装上去插件拿到的是空配置，
  而且没有任何告警。当前仓库没有使用者，但这是对外契约。
- 修法：`mountRow` 把 `row.config` 一并传给 `mountExternalPlugin`；补探针。

### P0-3 界面点一次插件开关，`plugins.json` 写两遍

- 位置：`packages/runtime/index.ts:179` → `writePluginEnabled`，随后
  `setPluginEnabledHot` → `core/plugin-loader.ts:920/924` 再写一次。
- 人话：两次「读整份 JSON → 改一条 → 整份写回」，中间任何并发写（信任记录、设置保存）
  都会被后一次覆盖。`writePluginEntries` 本身不是原子写。
- 修法：只留一处写盘；`setPluginEnabledHot` 不再负责持久化，或反过来把校验上提。

### P0-4 「插件开没开」有两套判定，结论可以不同

- 位置：`core/plugin-registry.ts:404-421`（认旧键别名、认 `defaultDisabled`、有批版）
  vs `core/plugin-loader.ts:1973-1975`（只认精确 file、每次全量读盘）。
- 人话：同一份 `plugins.json`，插件中心与装载器可能一个说开、一个说关。
- 修法：删后者，统一走 `readEnabledPlugins`。

### P0-5 会话费用只有内存一份，切走再切回就消失

- 位置：`adapter/transcript.ts:288`（`clear()` 清空 `costBuckets`）、
  `:803-828`（内存累加）、`packages/transcript/index.ts:229-230`（只回填 `contextUsed`）、
  `core/usage-log.ts:399-409`（磁盘有按会话的 token，但没有按模型分桶的费用回填）。
- 人话：切到别的会话再切回来，状态栏的费用整格不见了。
- **主控限定**：桌面壳里只有 TUI 状态栏消费 `status.cost`（`tui/app/StatusBar.tsx:208`），
  所以这是 TUI 可见的问题；桌面壳不显示会话费用。双账本仍然要收。
- 修法：费用以磁盘为准（推荐），或在 `session-open` 里按 `usage.jsonl` 回填桶。

### P0-6 一张后台会话的审批卡，能让当前会话的目标永久停摆

- 位置：`packages/waiting/index.ts:29-40`（`any` 遍历全进程 waiters，不按会话过滤）、
  `packages/goal/index.ts:124`（`if (ctx.waiting.any) return null`）、
  `packages/schedule/index.ts:210`（投递前也问同一个全局值）；
  注册方 `approval/index.ts:1527`、`plan/index.ts:150`、`ask/index.ts:239` 都只报「本进程有没有卡」。
- 人话：后台会话挂着一张审批卡没人答，你正在看的这条会话的目标自动续跑就永远不动，
  切会话也不会恢复。定时任务投递同样被挡住。
- 修法：`waiting` 的登记与查询都带上会话归属（`register(owner, fn)`、`anyFor(sessionPath)`），
  goal / schedule 只问自己那条会话。
- 主控核对：已读三处注册与两处消费，确认没有会话参数。

### P0-7 `todo` / `goal` 的工具把状态写进「用户正在看的那条会话」

- 位置：`packages/todo/index.ts:106`（全进程一个 `TodoStore`）、`:113`（写 `ctx.session.current()`）；
  `packages/goal/index.ts:85-87`（`persist()` 写 `ctx.session.current()`）。
- 人话：后台会话或队友调一次 `todo_write`，清单会写进你正在看的会话的 jsonl，而不是调用方那条；
  两个会话并行时互相覆盖。这是「单会话假设」留在多会话常驻架构里的典型残骸。
- 修法：工具 `run` 拿到的 `ToolContext` 已经带 `sessionId/sessionPath`，用它定位会话；
  `TodoStore` / `GoalStore` 按会话分表，而不是全进程一个。
- 主控核对：已读两处工具注册与写入路径，确认没有用调用方会话。

### P0-8 队友自己新建一条守卫链，沙箱 / 地板 / 钩子对队友全部不生效

- 位置：`packages/subagent/index.ts:477-529`（`guardsFor` 里 `new ToolGuardRegistry()`）、`:622`
  （队友循环挂的是这条链）；对照 `packages/guards/index.ts:20-31`（主会话唯一全局链）。
- 人话：主链上 order 5 的灾难地板、8 的沙箱、20/25 的钩子、50 的溢出，队友那条链上都没有。
  用户在 `hooks.json` 写「本项目禁止碰 migrations/」，主会话守得住，队友照样改。
- 修法：删掉队友的独立链，改成在全局链前插一位 `teammate-mode`，其余守卫共享。
- 主控核对：已读 `guardsFor` 与 `guards` 插件，确认是两条独立注册。

### P0-9 `grep` 绕过读禁名单，能把 `.env` / 私钥内容印进对话

- 位置：`packages/tools-default/search-tools.ts:373/389-425`（`fs.readFile` 全文扫，不调
  `readBlockReason`）；`read` 的防线在 `core/tools/fs-tools.ts:98`、`core/path-policy.ts:169-200`；
  `risk: 'read'` 让审批 / 沙箱 / 地板都 defer（`core/tool-guards.ts:149`、`sandbox/index.ts:290`、
  `approval-floor.ts:710`）。
- 人话：模型一条 `grep({ pattern: "KEY|SECRET", path: "." })` 就能读到工作区里 `.env` 的键值行，
  全程不过审批卡。读禁名单只挡住了 `read`，没挡住搜索。
- 修法：`grep` / `glob` 的逐文件读取统一过 `readBlockReason`；或者把「可读文件」收成
  `path-policy` 的一个 `isReadableFile()`，所有读盘入口共用。
- 主控核对：已读 `grep` 的 `scan()`，确认只判大小与 `\0`。

### P0-10 同一条命令三套分类结论，`git push --force` 永远看不到审批卡

- 位置：`core/command-policy.ts:303/322`（审批面：ask）、`packages/sandbox/execpolicy.ts:321/480-489`
  （围栏面：网络关 → forbidden）、`packages/approval-floor/approval-floor.ts:506-513`（地板：内联
  `-command` / `/c` 判不出 → deny）。链上顺序是地板 5 → 沙箱 8 → 审批 30。
- 人话：`git push --force` 在审批面是「问人」，在沙箱是「硬拒」，结果卡根本不弹；
  `powershell -Command "Get-Content .env"` 在地板是「拒」，在沙箱是「只读放行」。
  用户看到的是「怎么没问我」，实际是前两道先把它拦了。
- 修法：定一份优先级（谁能覆盖谁）并写进一处；三套表至少共享同一份「命令意图」判定，
  不要让「审批面 ask」与「围栏面 forbidden」对同一条命令各说各话。
- 主控核对：已读三处表与 `approval-floor` 的 `INLINE_FLAGS` 分支，结论一致。

### P0-11 文件的「改动快照」只增不减，新预览页签会显示上一刀的 diff

- 位置：`ui-dockkit/ui/dock-state.ts:276`（`patchSources` 全局 Map）、`:261`/`:346`
  （只有 `set`，全仓无 `delete`/`clear`）；消费方 `ui-preview/ui/ui.tsx:112/163-198`（在途改动）；
  另一个入口 `ui-files/ui/ui.tsx:186`（点文件树走 `setDockPreview({path})`，不带 patch）。
- 人话：让 agent 改一次 `foo.ts` → 从「文件已更改」卡点开（挂上 patch）→ 关掉页签 →
  再从文件树点开同一个文件，页签头上会挂着上一刀的 `+N/−N` 和「改动」开关，点开是旧 hunks。
  换会话、换轮次都不清，因为键只是路径。
- 修法：给 `patchSources` 一个失效策略（页签关闭时删、或按 `rev`/时间戳判新旧），
  预览页签只在「这次入口带 patch」时才画改动视图；补一条探针。
- 主控核对：已读 `dock-state.ts` 的 set/get，确认没有删除路径；这正是本次在途改动接上的新入口。

### P0-12 侧栏浏览器默认配置下没有快照入口，5 个只收 ref 的动作全不可用

- 位置：`packages/dock-browser/index.ts:825`（`lookWithoutApproval` 为 false 就不注册 `browser_dock_look`）、
  `:97`（默认 false）、`:564-735`（`runAct` 的 9 个动作里 5 个只收 ref）、`:164-174`（动作枚举）。
- 人话：出厂配置下模型没有拿到 ref 的入口，却有一把只认 ref 的动作工具；工具说明还让它去调
  `browser_dock_look`，而那个工具根本没注册。
- 修法：二选一——默认注册只读的 `look`（走审批），或让 `act` 的 click/type 等支持 selector/坐标；
  不能保留「有动作、没眼睛」的默认组合。
- 主控核对：已读工具注册分支与默认配置，确认默认 false 且 lookTool 未注册。

### P0-13 侧栏浏览器把 `alert()`/`confirm()` 事件放行后又静默丢掉，页面卡死 25 秒

- 位置：`core/dock-browser.ts:76-77`（事件白名单含 `Page.javascriptDialogOpening/Closed`）、
  `packages/dock-browser/index.ts:291-293`（`default` 静默忽略）、`:164-174`（`DOCK_ACTIONS` 没有 `dialog`）。
- 人话：页面弹出确认框后，这个视图上的每条 CDP 命令都被浏览器压住，直到 25 秒超时；
  模型只看到「超时」，不知道有弹窗，也没有 `dialog` 动作可调。`browser` 侧为这个坑专门写了
  挂起 + 提示 + 超时 dismiss（`browser/index.ts:419-435/971-990`），dock 这条路原样留着。
- 修法：要么从白名单删掉这两条并在契约层承认不支持；要么补 `pendingDialog` 状态、提示与
  `dialog` 动作（推荐，照 browser 已验证的形状）。
- 主控核对：已读三处，确认白名单与 switch 不一致。

### P0-14 Windows 上 MCP 的 `"command": "npx"` 起不来

- 位置：`packages/mcp/mcp.ts:298-316`（候选顺序 `[root, ...suffixes]`，无后缀优先）、
  `:304-311`（命中无后缀的 `npx` 后 `shell:false` 交给 spawn）；对照 `packages/lsp/servers.ts:150-162`
  （带后缀的候选排在前面，注释写明了「无后缀的 npm 往往是 sh 包装脚本，spawn 起不来」）。
- 人话：设置页给的官方示例就是 `"command": "npx"`；Windows 上 PATH 里无后缀的 `npx` 是 shell 包装脚本，
  `existsSync` 认得出，`spawn(shell:false)` 起不来。LSP 那边修过同一个坑，MCP 没跟着修。
- 修法：把 `resolveCommand` 的候选顺序改成「带 PATHEXT 后缀优先、无后缀兜底」，
  或直接复用 LSP 的 `resolveExecutable`（批次 09 的 P1 也建议合并这两份）。
- 主控核对：已读两处候选顺序与 `needsShell`，确认顺序相反。

## 三、根因：单会话假设，撞上了多会话常驻

上面 P0-6、P0-7 不是孤立 bug，而是同一条断层：0.6.48 起一个宿主可以同时养多条会话
（后台 agent、队友、定时任务），但一批插件服务仍是**进程级单例**：

- `todo` 一个 `TodoStore`、`goal` 一个 `goals`、`waiting` 一张全局表、`subagent` 一份名册；
- 它们读写时默认 `ctx.session.current()`，也就是「用户此刻在看的那条」；
- 界面侧又按会话过滤（`transcript` 的 `owned()`、`approval.pendingView`），两边假设不一致。

这就是「旧逻辑与新逻辑打架」的主病灶：**会话已经是多份，服务还按一份写**。
它比工具卡三份、主题三份更难查，因为症状是「刚才还好好的，切个会话/挂张卡就不动了」。

机械统计：全仓 `ctx.session.current()` 共 **164 处，分布在 32 个包**（transcript 19、sandbox 16、
self-improve 14、hooks 13、llm 13、subagent 13、approval 11……）。不是这 164 处都错：
界面与「当前视图」读 current 是合理的；**工具执行、后台任务、定时投递**必须用调用方会话，
而这几类里恰好有 P0-6、P0-7。

## 四、P1 的五个主题（不按包，按病根）

### 主题 A：旧路径没退场

- 58 个 core 垫片，39 个零引用，16 个只有测试在用，3 个还被源码用；
  其中 `lsp/manager.ts:16` 经由 `core/mcp` 垫片形成「功能包 import 功能包」。
- 功能包为了 `errText` 去 import `adapter/transcript.js`（8 处），层级反了。
- **这次在途改动自己留下了一条死路**：Git 面板点文件已改走预览页签，但
  `ui-files/ui/changes.tsx:145-152` 的 `toggleDiff(group, file)` 仍保留 `file`/`staged` 分支，
  `:276` 只用 `('all', null)` 调它，`GitDiffView` 的 `inline` 永远不传，`staged` 分支不可达；
  `git-diff-inline` 样式也因此失去消费方。
- 两个入口 `src/boot.ts` 与 `src/headless.ts` 除 `surface` 一个字面量外逐行相同，
  改启动流程要改两份。
- 门禁 `plugin-dep-graph.mjs:30-34` 只认 `@pneuma/` 说明符，相对路径跨层全漏。
- 详见 `90-global-evidence.md` 第 1、2、7 节。

### 主题 B：同一事实多份状态

- 费用：内存 `costBuckets` vs 磁盘 `usage.jsonl`。
- 上下文占用：`compact/index.ts:308`（只看消息）、`:251`（加 system+tools）、
  `session-core/loop.ts:439`（按请求分段）三套算法。
- 会话轮数：「真人发言」判据全仓 5 份，状态栏与对话页轮数对不上。
- **分轮定义在两个载体里相反**：Web 的 `ui-transcript/ui/rounds.ts:97-148` 明确「插话不开新轮」，
  TUI 的 `tui/app/scroll-model.ts:281-289` 只排除 `internal`、把插话算成新轮；同一份 jsonl，
  终端刻度比桌面多几枚，`[`/`]` 跳的也不是同一个东西。
- 主题/字号默认值：`prefs.ts`、`appearance.ts`、桌面主进程各一份；`system` 档在桌面侧丢失。
- 折叠回复默认值（原报 P0，主控核对后降为 P1）：四处归一化，`core/prefs.ts:182` 默认
  `final`，而 `ui-transcript:176`、`ui-runtime/appearance.ts:119-121`、`ui-settings:1238`
  都把「不是 final」回落成 `all`。**主控核对**：`runtime/index.ts` 的 `getUiPrefs()` 返回
  `ctx.settings.prefs().ui`，宿主已用 `readPrefs` 补全默认值，所以正常路径不会缺字段；
  实际影响是「首帧 / 缓存为空 / 老宿主」这几种情形回落 `all`，与默认 `final` 不一致，
  且设置页注释写着「与宿主一致」但事实相反。修法仍然是收成一份 `normalizeFoldedReplies`。
- 会话列表：`core/session.ts` 与 `session-search` 各扫一遍盘、各一套缓存键。
- 路径判定：`core/path-policy.ts` 与 `packages/sandbox/policy.ts` 两套，对 NT 中缀、ADS、
  UNC、`~`、`.dsc` 控制文件的结论不一致；同一条路径可能一个说许写、一个说拒。
  `desktop-dock` 的 `inside()` 是第三份，没跟上 `path-policy` 2026-10-30 的 realpath 修补，
  还留着 `..foo` 误判。
- 命令输出截断：`tools-default/bash.ts:274` 截到 8000 字符后交给 spill，spill 又落盘并
  在正文里写「完整输出已落盘」（`core/spill.ts:279`），实际落的是截断后的那段。
- 子进程环境：`ops` 的 worker 起进程时没传 `env`（`ops/worker.ts:232`），整份继承
  `process.env`，模型 API key 也在里面；`mcp` / `lsp` 都走 `buildChildEnv` 白名单
  （`mcp.ts:249`、`servers.ts:165`）。三条外部进程链路只有这一条没脱敏。
- 插件开关：两套判定 + 三种键形状（`ui-<id>`、`<目录>/ui/client.js`、`<包名>/client`）。
- 队友名册：「谁在队、什么状态」有 5 份副本（`subagent:394` 内存 Map、`roster.json`、
  转录里的子代理卡、快照 `subagents`、壳侧 3 秒轮询），僵尸判定只在一处（`subagent:830`）。
- 「有没有卡挂着」：`waiting` 一张全局表，卡片却按会话存；goal 续跑与 schedule 投递都读全局值。
- 「停用要不要刷新」：宿主只认 `ui-layout` / `ui-renderer` 两个根单元（`runtime/index.ts:191`），
  界面却按卡片种类硬判（`ui-plugins/ui/ui.tsx:694-699` 给所有内置行标「即时生效」，
  `:869` 给所有第三方行标「刷新后生效」），两边说法相反。

### 主题 C：上帝文件与上帝组件

- `ui-status/ui/ui.tsx` 2310 行、15 件事；`SessionList` 一个组件约 1200 行。
- `tui/app/App.tsx` 1863 行、17 类职责、61 份本地状态，一个 `useInput` 434 行；
  命令、鼠标、审批、提问、计划、设置、五个浮层、滚动、附件全挂在同一个组件上。
- `ui-settings/models.tsx` 1936 行；`approval/index.ts` 1544 行；
  `subagent/index.ts` 1526 行、14 项职责；`computer-use/desktop-control.ts` 1522 行；
  `browser/index.ts` 1475 行；`ui-layout/app.tsx` 1296 行；`plugin-loader.ts` 1987 行。
- `core/session.ts` 1686 行、`Session` 类担 13 类职责，`SessionStateMap` 内建 12 种插件状态形状。

### 主题 D：同一功能写了三份

- 工具卡：`rows/tool-row.tsx:70`、`tool-card/factory.tsx:170`、`ui-trace/ui.tsx:773`；
  连展开高度常量都在 `fold-body.ts` 与 `factory.tsx` 各一份。
- 浏览器工具层：`browser/index.ts:758-1051` 的 `runAct`（294 行）与
  `dock-browser/index.ts:564-735` 的 `runAct`（172 行）逐段对位，约 85% 重写；
  共享只到 `packages/cdp/` 的动作与快照。
- 守卫链：主会话一条（`guards/index.ts`），队友另建一条（`subagent:477-529`），
  沙箱/地板/钩子对队友不生效。
- 命令分类：审批面 `classifyCommand`（allow/ask/deny）、围栏面 `evaluateCommand`
  （allow/prompt/forbidden）、地板 `INLINE_FLAGS` 三套，对 `git push --force` 给出三个结论。
- 技能校验：`core/skills.ts` 的解析/名字规则与 `self-improve/skill-write.ts` 的硬校验两套；
  威胁扫描两张规则表已经分叉（`memory.ts:309-349` vs `skill-write.ts:190-230`）。
- 端点/模型草稿校验：界面 `ui-settings/models.tsx:220-241` 与宿主 `core/config-store.ts:187-214`
  两套，名字正则、模型 id 去重、maxTokens、能力枚举各缺一半，界面放过的宿主可能拒。
- 文件工具两族：`tools-default` 的 `read/write/edit/glob/grep` 与 `ops` 的 13 件。
  围栏共用 `core/path-policy`，但并发锚一个用 mtime、一个用 SHA-256 修订号；
  输出上限一个 16000 字符、一个 128KiB；diff 有三份产物。同一个文件用两族改，结论会不同。
- `git status` 三处各跑：`git` 插件按 12/30 秒轮询、`desktop-dock` 每次面板请求跑一次、
  `core/git-info` 每回合首尾各跑一次；porcelain 解析两套（`-z` 版与按行版），
  detached 时分支一个给短 sha、一个给 `HEAD`。
- 子代理系统提示另起一套装配（`subagent/index.ts:602-616`），队友拿不到 AGENTS.md、
  技能目录与工具规范；主会话那套在 `session-core/prompt.ts`。
- 两台界面服务器：`webserver` 与 `remote` 各写一遍 HTTP 引导、路由表、凭据闸与错误应答，
  只有 `ui-events`/`ui-route`/`ui-server` 的几个函数共用；两份启动图已经漂移
  （手机那份没有 `host.language`，也没有 `ask` 通道）。
- 插件装载器：TUI `ui-core/tui-plugins.ts`（332 行）与 Web `ui-boot/boot.ts` 是同一套算法
  的两份实现（`requireFor` 白名单、两轮重试、回滚账本、报告表逐段同形）；`services`
  只在 TUI 侧真正生效（Web 侧被启动图丢掉，见 P0-1），两个载体的「等提供者就绪」行为不同。
- token 格式化：`core/text-format.ts:16-20`（TUI）与 `ui-primitives/ui/tokens.ts:21-38`（Web）
  两个口径，同一个数在两处显示可能不一样。
- 浏览器输入前的密钥拦截：`browser:747`、`computer-use:417`、`dock-browser:553`，
  桌面那份多一条命令策略判定，网页两份没有。
- 主题默认值与枚举：`prefs.ts`、`appearance.ts`、`desktop main`；`system` 档在桌面侧丢失。
- 思考档位标签：`core/model-caps.ts`、`ui-composer/model-picker.ts`、`ui-settings/model-infer.ts`。
- 时长/多久以前/token/路径格式化：各 2–3 份，散在 `ui-primitives`、`ui-status`、`ui-statusbar`。

### 主题 E：跨包靠字符串总线，调用面有四套闸门

- 6–8 个 `window` CustomEvent（`shell.settings.open` 等），发/收两侧各写字符串，
  `detail` 形状无类型。
- `invoke` 有四条通道、四种闸门：`host-stdio`（全量白名单、无实参校验）、
  本机 HTTP `/api/invoke`（`UI_METHODS` + `validateUiArgs` + 附件净化）、
  远程 HTTP（有校验、无净化）、远程 WS（只查方法名）；此外桌面页还留着一条
  没有消费者的 `window.dsc.invoke`，直通最宽的方法面。
- `host-stdio` 与 `/api/invoke` 的快照节流：一个 leading-edge、一个 trailing，
  加上 `remote` 共三份泵；`core/snapshot-throttle.ts` 只有阈值没有泵。
- 这不算错，但加一个方法要想两遍，且两边行为会漂。

## 五、看起来像重复、其实是故意的（不要误伤）

- `core/host-methods.ts` vs `core/ui-methods.ts`：宿主协议全量面 vs 页面可调用子集，
  两份都有编译期覆盖检查，不是复制。
- `core/ui-server.ts` vs `packages/webserver`：实现与服务包装，按设计分家。
- `host-stdio` vs `webserver` vs `remote`：三种传输（Electron 管道 / 本机 HTTP / 手机），
  安全模型不同；该合的是校验与节流机制，不是传输本身。
- `core/remote/frames.ts` vs `ui-core/frames.ts`：宿主侧 diff/缓冲 vs 客户端归并，
  一个严格、一个容忍版本漂移。
- `core/approval.ts`(垫片) vs `contract/approval.ts`：内核裁决类型 vs 界面视图投影。
- `lib/node_modules/@pneuma/<id>` 的再导出桩：构建期为了保证单实例，不能删。
- TUI 与 Web 的组件：两个载体，应该共享判据与格式化，不应该合并组件。

**做对了的复用（后面照着这套做）**：

- 启动图行 `toUiPluginRows` 两个组图点共用（`ui-bundles.ts:1774`）；
- `core/ui-route.ts` 的单资源解析被 `remote` 直接复用（批次 03 记为正面样本）；
- 组合包界面判定 `judgePackageClient` 被「发现」与「信任卡」共用（`ui-bundles.ts:1405`）；
- `native-bridge` / `token-estimate` / `model-caps` / `diff-text` 经 `@dsc/ui-core` 转出，
  宿主与壳读同一份；
- `session-core` 被 hooks/compact/prompt/agent 共用，没有各写一套循环；
- `core/git-exec` 被 `desktop-dock` 与 `git` 共用，porcelain 解析只有一份；
- `commands-core` 的命令表被 TUI、壳、插件三端共用。

## 六、下一步建议

1. 先做第 0 期 14 个 P0（`ARCHITECTURE.md` 第 3 节），每个配一条探针；其中 P0-6/7/8/9/10
   是安全与多会话相关，建议排在最前；P0-11 与这次在途改动直接相关，建议先修。
2. 再做第 1 期删旧路径（39 个垫片 + 16 个测试改 import + 3 处源码引用）。
3. 第 2 期拆上帝模块按「先界面、后内核」排，界面可用截图验收，内核要跑全量会话探针。
4. 每一步单独提交，按仓库规范分批；没让推就不推。

**待你拍板**：是先动第 0 期，还是先挑一份报告逐条过？

