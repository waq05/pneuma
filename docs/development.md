# dsc 开发手册

面向**要改这份代码的人**（包括下次坐到位子上的 AI 助手）。讲清楚代码怎么分层、一个新功能
该落在哪一层、改完怎么验证、出问题去哪看。

| 想知道 | 去看 |
| --- | --- |
| 怎么装、怎么跑、怎么配模型 | [README.md](../README.md) |
| **代码怎么分层、往哪改、怎么验证** | **本文档** |
| **界面怎么改、控件往哪加、颜色字号怎么取值** | [ui-design.md](ui-design.md) |
| 为什么长成这样、踩过哪些坑 | [development-log.md](development-log.md) |
| 记什么：对照 codex / hermes / dsh 还缺哪些能力 | [harness-benchmark-roadmap.md](harness-benchmark-roadmap.md) |
| 三家对标产品的功能清单全文（差距的证据底料） | [peer-feature-inventory.md](peer-feature-inventory.md) |
| 怎么写一个插件 | [plugin-development.md](plugin-development.md) |

## 1. 一张图看懂运行时

```
             ┌──────────────── Electron 主进程 ────────────────┐
             │  electron/main/index.ts   窗口 / 托盘 / 菜单     │
             │  electron/main/dsc-core.ts 运行时子进程与协议     │
             │  electron/main/dock.ts     终端与浏览器视图       │
             └───────┬────────────────────────────▲────────────┘
        IPC 单点     │ 'dsc:invoke'               │ 'dsc:event'
             ┌───────▼──────────────┐             │
             │  renderer (React)    │─────────────┘  快照流
             │  src/renderer/*.tsx  │   只能调白名单里的方法
             └──────────────────────┘
                    ▲
                    │ MessagePort（没有 parentPort 时走 stdio 一行一条 JSON）＋版本握手
             ┌──────┴───────────────────────────────────────────┐
             │  运行时子进程（node utilityProcess）              │
             │  lib/headless.js → host-stdio 插件               │
             │    └ createKernel() → cordis 上下文              │
             │        内核插件 34 + 官方可开关 18 + 外部插件 N                     │
             │  src/core/* 是纯能力，被插件包装后对外提供服务      │
             └──────────────────────────────────────────────────┘
```

三条铁律：

1. **内核不碰界面**。`src/core/` 里出现 `ink`、`electron`、`react` 就算越界；
2. **UI 不碰内核**。renderer 只能调 `host-stdio` 白名单里的方法（`src/plugins/host-stdio.ts`
   的 `INVOKABLE_METHODS`：它就是 `DscRuntime` 去掉 `subscribe`/`getSnapshot`/`exit`/`dispose`
   这四个只在宿主进程里成立的方法，清单漏一个编译就报错），想知道内核有什么，看
   `src/contract.ts` 的 `DscRuntime`；
3. **装配只在 cordis 里**。新功能往扩展点上挂，不改 `src/core/loop.ts` 的执行流程。要改循环，
   先改这份文档的扩展点清单。

## 2. 仓库地图

规模现量于 2026-10-28（0.7.1 时点），只数源文件行数，当量尺用。

| 路径 | 规模 | 职责 |
| --- | --- | --- |
| `src/core/` | 156 个文件 ≈47000 行 | 纯能力：模型客户端与协议适配器、会话（含写租约）、循环、审批、压缩、溢出落盘、会话检索、MCP 客户端、工具、技能、设置、任务板；token 粗估（`token-estimate.ts`）、错误文案（`err-text.ts`）、数值收敛（`clamp.ts`）、对象判定（`records.ts`）、消息取文（`transcript-text.ts`）、cmd 引号与 shell 选择（`shell-quote.ts`）、默认终端探测（`terminal-env.ts`）、字符串判定（`strings.ts`）、安全序列化（`json-text.ts`）、快照推送节流（`snapshot-throttle.ts`）、git 读数相等判断（`git-surface.ts`）、时间格式化（`clock.ts`）都是全仓库唯一一份 |
| `src/core/tools/` | 6 个文件 ≈1700 行 | 内置六件套 `bash`/`read`/`write`/`edit`/`glob`/`grep`（预算由 tools-default 配置下发）+ 沙箱的一次性升权参数与命令执行器缝 |
| `src/core/lsp/` | 7 个文件 ≈2400 行 | LSP 代码智能：`client`（连接/实例）、`manager`（池化调度）、`normalize`（应答归并）、`line-shift`（诊断行号对齐）、`framing`/`servers`/`uri` |
| `src/core/dsh-compat/` | 9 个文件 ≈1900 行 | dsh 插件兼容层的模块解析钩子与工具形状适配 |
| `src/plugins/` | 58 个文件 ≈24100 行 | 每个服务一个 cordis 插件 + 十八个官方可开关插件；`remote/` 拆成 `types`/`http`/`routes`（HTTP 路由）+ `remote.ts`（传输与装配） |
| `src/host/kernel.ts` | 487 行 | 内核装配顺序与三档插件元数据 |
| `src/contract.ts` | 26 行 | **只做转出**：`export * from './contract/*.js'`，导出面与拆分前一个不差 |
| `src/contract/` | 10 个文件 ≈2100 行 | UI ⇄ 运行时的中性契约按域分家：`mode`（思考档位 / 权限 / 协作）、`task`（待办、计划、后台、定时、目标、提问）、`transcript`（工具卡、转录、差异）、`usage`（token 与用量）、`runtime`（状态行、预设面、git 读数、快照面）、`approval`（审批卡）、`session`（会话、归档、偏好）、`plugin`（插件、信任、队友、模型选择、技能、市场）、`settings`（设置、供应商、连接测试）、`snapshot`（运行时快照、`DscRuntime`、电脑操作）。每份 75–438 行 |
| `src/services/types.ts` | 1432 行 | 服务面声明（`ctx.llm`、`ctx.mcp` 这些是什么类型） |
| `src/adapter/transcript.ts` | 702 行 | 内核事件 → UI 快照的折叠投影 |
| `src/app/` | 39 个文件 ≈7900 行 | ink 终端界面（与桌面端共用契约）；显示宽度（`display-width.ts`）是终端侧唯一一份 |
| `desktop/electron/` | 7 个文件 ≈2670 行 | main + preload：窗口、托盘、运行时子进程、终端与浏览器 dock |
| `ui-shell/` | 124 个文件 ≈39500 行 | 桌面与手机共用的界面壳（插件化：布局 + 基元 + 官方界面插件；产物落 `lib/ui/assets`）。**这是唯一的界面**——旧渲染层 21,035 行已于 2026-10-28 整体删除 |
| `shots/` | 脚本 + 实拍产物 | 自检与实拍（全部跑在临时 HOME 上）。**这个目录被 `.gitignore` 忽略**：它只在本机存在，不随版本库分发 |
| `examples/plugins/` | 5 个示例 | 手写插件的参照（上手路径见 [plugin-development.md](plugin-development.md) §0） |

## 3. 三条启动链路

**TUI**（`numa`）

1. `bin/dsc.js`（bin 键 `numa`）解析 `--resume` / `config` 子命令，spawn `node lib/boot.js`；
2. `src/boot.ts` 只做装配，按顺序：`migrateFromDsh()`（幂等，只读 dsh）→ `readConfig()` →
   `readUiConfig()` → `createKernel()` → 装 TUI 插件 → `loadExternalPlugins()` →
   `emitStartupNotes()`。`readUiConfig()` 读 `config.yaml` 的 `ui` 段与 `plugins` 段，
   但 boot 是**无条件**挂 TUI 的（`src/boot.ts:27`）——真正起作用的只有 `plugins` 段；
3. `--resume` 走 `DSC_RESUME_SESSION` 环境变量传给子进程（`auto` = 看 `.last-session` 指针）。

**桌面**（`dist/win-unpacked/Pneuma.exe` 或 `pnpm run dev`）

1. 主进程 `readState()` 读 `~/.dsc/desktop.json`（最近工作目录最多记 12 个、托盘提示是否
   弹过），写侧 `writeState()` 做合并（`desktop/electron/main/dsc-core.ts:42-60`）；
2. `requestSingleInstanceLock()`，`DSC_DESKTOP_USER_DATA` 可以换 userData 让并行实例互不干扰
   （`desktop/electron/main/index.ts:363`）；
3. `dsc-core.ts` 以 `ELECTRON_RUN_AS_NODE=1` spawn 打包进 `resources/dsc-core/` 的运行时
   （`src/headless.ts:1-6`：exe 兼作内核的 node 解释器）；
4. 运行时 `hello { protocolVersion }` 握手，版本对不上直接报错；
5. renderer 通过 `bridge.ts` 调白名单方法，收快照流渲染。

**无头**（桌面端的运行时子进程，也是脚本化调用的入口）

1. `bin/headless.cjs` → `lib/headless.js`，stdin 关闭即退出；
2. 顺序和 TUI 一样：迁移检查 → 读配置 → `createKernel()`，只是装的插件换成
   `hostStdioPlugin`（`src/headless.ts`），不装任何界面；
3. 传输自动探测：`process.parentPort` 存在就用结构化克隆的 MessagePort（Electron
   `utilityProcess` 走这条），否则按「stdio 上一行一条 JSON」通信，不是 JSON 的行直接忽略。

## 4. 装配规则（cordis）

一个插件长这样，四条规矩都在代码里强制执行：

```ts
export const myPlugin: Plugin.Object = {
  name: 'my-plugin',
  inject: ['llm', 'transcript'],   // ① 要用的服务必须声明；没声明的读 ctx.xxx 会抛
  provide: 'mine',                 // ② 对外提供的服务名（可选）
  apply(ctx, config) {
    const off = ctx.tools.register({ ... })   // ③ 注册一律返回清理函数
    return () => off()                        // ④ apply 返回合并后的清理函数
  },
}
```

- **可选服务不能进 `inject`**：插件关着时它不存在，声明了会让整个挂载失败。别人要用
  `ctx.get('名字')` 读（读不到是 `undefined`），**不能**写 `ctx.名字?.`——cordis 的属性代理
  对没声明的名字是直接抛错，可选链救不了（这条是打包版里真踩出来的，见
  [development-log.md 坑 4](development-log.md)）。
- **waterfall 监听必须调 `next()`**，不调就把链断了。

### 三档插件

| 档 | 判定 | 开关 | 现在有谁 |
| --- | --- | --- | --- |
| 自定义 | `source: 'external'`，文件在 `~/.dsc/plugins/*.js` | 可拨，默认开 | 用户自己的（dsh 风格的插件走兼容层，见 [plugin-development.md](plugin-development.md) 的「dsh 兼容层」章） |
| 官方可开关 | `source: 'builtin'` + `toggleable: true` | 可拨，默认由 `defaultDisabled` 定 | 见下面那张表，共 18 个 |
| 运行内核 | `source: 'builtin'` 且没标 `toggleable` | 不给开关 | `llm`/`session`/`guards`/`surfaces`/`waiting`/`approval`/`hooks`/`tools`/`tools-default`/`transcript`/`commands`/`skills`/`prompt`/`mode`/`presets`/`ptc`/`runtime-api`/`settings`/`compact`/`microcompact`/`image-diet`/`session-title`/`todo`/`plan`/`ask`/`agent`/`goal`/`memory`/`runtime`/`webserver` 共 30 个 |

官方可开关插件（`src/host/kernel.ts` 的 `OFFICIAL_PLUGINS` + `OFFICIAL_OBJECTS`）：

| 插件 | 默认 | 设置分区 | 干什么 |
| --- | --- | --- | --- |
| `subagent` 子智能体 | 关 | `subagent` | 把任务派给有明确授权的子智能体（`subagent` 工具），设置递归层级、数量和模型；队友按会话隔离 |
| `team` 智能体团队 | 关 | `team` | 协作层：共享任务看板（`team_task` 工具），看板按会话各一块；已启用 `subagent` 而没动过它时自动跟着打开 |
| `computer-use` 电脑操作 | 关 | `computer-use` | 截屏、点击、输入 Windows 桌面，每次动手都要审批 |
| `web-search` 网页搜索 | 开 | `web-search` | 提供 `web_search` 工具，经 Tavily / 博查 / Serper 检索网页 |
| `approval-floor` 审批灾难地板 | 开 | `approval-floor` | 守卫链 order 5 的硬闸：灾难命令、deny 黑名单、命令白名单、无人值守 |
| `spill` 大输出溢出 | 开 | `spill` | 工具输出超阈值落到临时文件，回给模型的只有前几行与续读写法 |
| `session-search` 会话全文检索 | 开 | `session-search` | 历史会话的中文全文索引，提供 `session_search` 工具与 `/search` 命令 |
| `lifecycle-hooks` 生命周期钩子 | 关 | `lifecycle-hooks` | 读 `~/.dsc/lifecycle-hooks.json`，按 codex 的十二个事件名跑外部命令钩子 |
| `mcp` MCP 客户端 | 关 | `mcp` | 连 stdio 或 streamable-http 的 MCP server，工具挂成 `mcp__服务器__工具` |
| `tool-search` 工具渐进披露 | 关 | `tool-search` | 用 `tool_search` / `tool_describe` / `tool_call` 替下这一轮用不到的工具 schema |
| `sandbox` 沙箱 | 开 | `sandbox` | 守卫链 order 8 的策略围栏（codex 路线）：三档模式、可写根白名单、受保护路径、命令前缀策略、一次性升权（`sandbox_permissions` + `justification` 成对）；容器后端可换真隔离，降级时照常执行 + 审批兜底并如实上报 |
| `schedule` 定时任务 | 关 | `schedule` | `after`/`at`/`every`/`daily`/`weekly`/`cron` 六种选择器，到点把提醒投回原会话；至多一次、catch-up 补投、pre-dispatch 校验 |
| `lsp` LSP 代码智能 | 关 | `lsp` | 连语言服务器查定义/引用/实现/悬停，并把本次编辑新引入的报错附在 write/edit 结果里 |
| `browser` 浏览器自动化 | 关 | `browser` | DOM 级控制浏览器：无障碍快照 + ref 定位点击输入（`browser_look` 只读 / `browser` 动手），不是截图比坐标 |
| `file-review` 文件更改预览 | 开 | `file-review` | edit / write 落盘前把 unified diff 摆进对话流，改哪几行看得见，超长按行截断 |
| `dock-browser` 侧栏浏览器控制 | 关 | `dock-browser` | 让模型驱动桌面端侧栏那台浏览器（用户持久会话）：无障碍快照 + ref 定位，动手动作每次审批 |
| `self-improve` 自我改进 | 关 | `self-improve` | 三条闭环：纠正捕获候选、复盘产技能草稿（默认停用待人启用）、技能自修 + 台账回滚 |
| `dsh-compat` dsh 兼容层 | 关 | — | 挂载 dsh（DeepSeek Harness）外部插件：`logger` 服务、模块解析钩子、dsh 风格工具注册的形状适配 |

默认开关按一条规矩定：会拉起外部进程、连外部服务器或改写每轮请求工具面的那几档默认关（`lifecycle-hooks`、`mcp`、`tool-search`、`schedule`、`lsp`、`browser`、`self-improve`）；提升安全与本地便利、且不配就完全无副作用的那几档默认开。沙箱是唯一的例外档：它默认开——不配就没有外部进程与外部服务器，开着的收益（越界写入当场拒）大于打扰，且默认档 workspace-write 不挡正常的工作区读写。

内核清单在 `src/host/kernel.ts` 的 `BUILTIN_PLUGINS`。新增一档官方可开关插件的三步写在 [plugin-development.md §3.4](plugin-development.md)。

### 界面壳那侧也走 cordis（2026-10-26 起）

界面壳（`ui-shell/`）原先自己写了一份小一号的装载器：`boot.ts` 用一支退订账本管回收、用
`unmetDependencies` 管依赖、用 `UiBootPluginState.state` 管状态。那份与宿主内核的 cordis 语义各说
各话——同一件事（装、等依赖、卸）在两边两套实现。

现在壳里也有一个 cordis 根（`ui-shell/src/ui-renderer/cordis-host.ts`），装插件走 fiber：

| 旧账本 | 现在 |
| --- | --- |
| `ledgerOfPlugin` 手工倒序调用 | `ctx.effect()` + fiber，依赖顺序由框架保证 |
| `disposers` 表 + `uninstall` | `fiber.dispose()` |
| `UiBootPluginState.state` 自己维护 | `fiber.state`（0 待装 / 1 装载中 / 2 生效 / 3 失败 / 4 已卸），账本的 `fiber` 字段就是它 |

**插件写法不变**：还是 `export default defineUiPlugin({ apply(ui) })`，拿到的 `ui` 还是那六项
（`id` / `slots` / `host` / `runtime` / `provide` / `consume`）。壳把 cordis 的 `ctx` 包成 `ui`
交过去，所以 19 个内置插件一行没改。

两条路并存是**回滚面**：默认 19 条全走 cordis（`boot.ts` 的 `CORDIS_DEFAULT_ALL`），旧退订账本
留着——出问题时在页面里写 `globalThis.__DSC_CORDIS_PROBE__ = 'none'` 就整体退回，不必重新构建；
写数组（例如 `['sessions']`）则只有名单里的走 cordis。账本里每条的 `via` 字段（`cordis` /
`ledger`）就是它走的哪条，诊断区每行末尾也写着（`?diag=1` 打开，或装载失败时自动出现）。

三个坑：

1. **服务名不能撞 cordis 自带的 Context 成员**。`runtime` / `effect` / `fiber` 都是 Context 上的
   访问器，第一次 `provide` 就抛 `property "runtime" is already declared as accessor`，症状是
   整个壳起不来、诊断区只有一行 `boot 失败`。壳里那个通道服务因此叫 `uiRuntime`。
2. **壳提供的服务是三个**：`slots` / `host` / `uiRuntime`。插件 `ui.provide()` 出来的服务同时写
   界面侧服务表（`useService` 读它）与 cordis（`inject` 声明服务名时才等得到），两边同一个值、
   同一次释放。
3. **cordis 卸载是异步的**。HMR 换装必须 `await cordis.unmount(id)` 再装新的，否则新旧两条纤维
   同时占着同一个槽格子（症状是状态栏叠成两份）。

### 两种依赖，两个字段（2.0 起）

界面清单里曾经只有一个 `inject` 字段，既当「插件 id」又当「服务名」，靠「这个名字在不在清单里」
猜。2.0 把它拆成两个字段（`src/ui/manifest.ts`），两类依赖各走各的：

- **`inject`（插件 id）**（例：`trace` 的 `inject: ['transcript']`）→ 由装载器的
  `unmetDependencies` 在装之前检查，缺了就报「插件 transcript 没装上」，重试轮再试一次；
- **`services`（服务名）** → 交给 cordis 的 `inject`，由框架等它就绪；服务在更晚的批里、
  或者 HMR 时才补上，那条纤维会**自己启动**，不必重装。

依赖没就绪时 `await fiber` 会直接放行（纤维停在状态 0），所以装配器要单独看 `fiber.state`：
不是 2 就记一条「等待服务：X、Y」进诊断区，并订阅 `internal/status`——服务补上来、纤维变 2 时，
账本自己翻成「已生效」。这三条 cordis 行为有自检钉着（`scripts/ui-cordis-test.mjs` 的 [0] 一节）。

验证：`node scripts/ui-cordis-test.mjs`（真 Electron + 真宿主 + 一轮换装，31 条断言）。
要连诊断区一起量：`DSC_CORDIS_DIAG=1 node scripts/ui-cordis-test.mjs`。

### dsh 组合包怎么装（2026-10-26 起）

dsh 的安装单位不是文件，是「bundle + profile + pnpm」：

```
~/.dsc/profiles/<名字>/
  package.json        # { "dsh": { "profile": { "bundles": ["包名", ...] } } }
  cordis.patch.yml    # 这一层自己的 patch（可选）
  compatibility.json  # 版本闸豁免（可选）
  node_modules/       # pnpm 装的包
```

一个包的 `package.json` 用 `dsh.bundle.patch` 指向自己的 patch 文件。patch 是 YAML 数组，
**按行 id 定位**：`{ id, config }` 改某一行的配置（整块替换，不深合并），`{ insert: [...] }`
往某个 group 里插行，`{ id, name }` 顺带核对名字防改错行。层序是 profile 里 `bundles` 的顺序，
后面的层盖前面的（同一层内部也是后盖前）。

装卸只有一条入口：

```sh
numa plugin add <包名|tarball|本地路径> [--profile 名字]
numa plugin remove <包名> [--profile 名字]
numa plugin list [--profile 名字]
```

版本闸比的是 **dsh 的插件契约版本**（`DSH_CONTRACT_VERSION = 0.2.1`），不是 Pneuma 自己的
0.7.x：包的 `engines.dsh` 或 `@deepseek-ai/dsh*` 的 peer 范围不满足就不装，除非在
`compatibility.json` 里登记豁免。

编码上的落点：`src/core/plugin-patch.ts`（层算法）、`src/core/plugin-bundle.ts`（读包与版本闸）、
`src/core/plugin-loader.ts` 的 `mountBundlePlugins`、`src/tools/plugin-cli.ts`（CLI）。
没配 profile 的用户启动路径完全不变（`activeProfileDir()` 返回 null 就整条路径不碰）。

**插件中心怎么看**：来自组合包的插件，名字后面挂一枚「组合包 <包名>」标记（卸载要回命令行，
不是在这里停用）。包如果自带界面半（`dsh.client.platform = "pneuma"`），会单独出现在
「组合包界面」那一组，带开关——装了就算同意，没有「确认信任」这一步；键是 `<包名>/client`。
那一组的行上还能看见三样东西：包版本（`v1.9.41`）、来源（`profile work`，即装在哪个
profile 目录）、停用状态（停掉的会多一枚「已停用」，不必只看开关的位置）；组标题上也先说
一句这组属于哪个 profile。字段来自 `UiTrustView.version` / `.profile`，第三方那组没有
这两项——目录里没有版本这个概念，不许拿组合包的字段冒充。
界面半默认只服务浏览器壳；要让它也进终端壳，在 `dsh.client.platforms` 里写 `["web", "tui"]`。dsh 客户端插件声明的界面能力（`dsh.client`）也会列一行
「界面能力（dsh 客户端插件）：platform:web、card · 只列不加载」——**只读展示，不执行它的界面代码**，
理由见 `PluginInfoView.clientCapabilities` 的注释：那要一份 dsh 自己的客户端运行时，与 Pneuma
更严的信任模型冲突。

### 真装一个 dsh 组合包：四道必须过的关（2026-10-26 用 dsh-cost-meter 1.9.41 验的）

线上真包（`dsh-cost-meter`）与自造的合成包有四处分歧，逐条补齐后它才挂得上：

1. **包名那一行要解析到入口文件**。patch 里写的是包名，pnpm 装上来的是目录，而 ESM 的
   `import()` 不吃目录（`ERR_UNSUPPORTED_DIR_IMPORT`）。`mountBundlePlugins` 现在按
   `exports["."]` → `main` → `index.js` 的顺序落成文件（`plugin-loader.ts` 的 `entryFileOf`）。
2. **两个 dsh 宿主库换成我们自己的实现**。真包 import `@deepseek-ai/dsh-home-paths`
   （`resolveDshHome`）与 `@deepseek-ai/dsh-credentials`（`credentialRef`）；照原样装，
   它们的默认根是 `~/.dsh`，插件的账本会写进 dsh 的家目录。现在由解析钩子把它们映射到
   `src/core/dsh-compat/shims/`：前者返回 `~/.dsc`（受 `DSC_HOME` 覆盖），后者只复刻
   名字的语法与校验。
3. **`DSH_HOME` 要在导入之前翻掉**。有一半 dsh 插件不走 home-paths，而在模块顶层直接算
   `process.env.DSH_HOME || join(homedir(), '.dsh')` 并存成常量。所以兼容层开着时，
   loader 在 `import()` 之前就把 `DSH_HOME` 设成 Pneuma 的家；从 dsh 终端里启动 Pneuma
   会继承到 `DSH_HOME=~/.dsh`，照抄就等于让插件写进别人的目录。
4. **缺服务要说清缺什么**。真包不声明 `inject`，而是在 apply 里 `ctx.get('sessions')` 现取；
   取到 undefined 再调方法，原本只剩一句 `Cannot read properties of undefined`。现在
   loader 记下它取过的服务名，挂载失败时按判定表（`service-map.ts`）逐条说明差在哪。

验证：`node scripts/dsh-real-plugin-check.mjs`（10 条断言，含「兼容层关着时指路」与
「账本落在 `~/.dsc` 而不是 `~/.dsh`」；脚本读 `DSC_REAL_HOME` 下预装好的 profile，
入库）。合成包那一路是 `node scripts/dsh-bundle-check.mjs`（15 条）；三条一起跑用
`pnpm run check:dsh`。

**内置插件的界面半也读同一处**：`ui-shell/src/plugins/<id>/package.json` 的 `dsh.client`
（19 个已全部迁完，旧 `plugin.json` 已删；两处并存构建会失败）。

**构建产物布局（2.0 起：一个插件一处声明）**：

```
lib/ui/plugins/
  manifest.json      # 只写 { version, apiVersion }：壳契约版本，**不再列插件**
  <id>/
    client.js        # 工厂注册形状的 bundle
    bundle.json      # 这份产物的自述：apiVersion / file / platforms / api / phase / inject / services
```

宿主**扫目录、读各自述**，不再按中央清单列插件：加一个插件 = 多一个目录，删一个 = 少一个目录，
开发态热更也按产物目录的 mtime 发现这件事（新增/删掉时成员文件的 stat 不会变）。旧产物（只有
中央 `plugins` 数组、没有自述）仍能装——那是给「拿着旧产物升级宿主」留的兜底，同时会被点名
「没有 `bundle.json`」，看到这句就重建界面壳。

**界面半**（2.0 起）：同一个包若在 `dsh.client` 里声明 `platform: "pneuma"` 与 `api`，
它的 `exports["./client"]` 会被收进界面启动图（发现、门禁、取字节、组图在
`src/core/ui-bundles.ts` 的 `discoverPackageUiArtifacts`，路由在 `src/core/ui-route.ts`）。
版本门禁是**失败关闭**的：清单没写 `apiVersion`（不是当前构建写的）时，连没声明 `api` 的
条目也一并拒掉——两边都没有依据就是无从判断，放行等于给手写清单开一条绕过门禁的路。
写 `platform: "web"` 的是 dsh 自己的界面半，仍然只列不加载——理由见
[plugin-development.md §10.6.1](plugin-development.md)。完整示例是
`examples/plugin-two-halves/`（宿主半一个工具、界面半状态栏一段）；自检三条：
`scripts/ui-package-plugin-test.mjs`（发现/门禁/组图/卡片/远程 38 条）、`scripts/ui-two-halves-test.mjs`
（装进 profile 后两半都到位 + 示例 bundle 的工厂形状，16 条）、`scripts/ui-two-halves-e2e.mjs`（真 Electron，11 条，
截图 `desktop/shots/two-halves.png`）。

**已知边界**：包能挂上、能在插件中心认出来源，但 `dsh-cost-meter` 的成本条不会真有数——
它靠 `sessionPersistence` + `sessions` 读会话历史算成本，这两个服务 Pneuma 没有（见
`service-map.ts`）。这属于「服务适配器」的活，不是安装链路的问题：**形状差异、只读子集
怎么切、拿真包怎么验收，写在 [dsh-service-bridge-plan.md](archive/dsh-service-bridge-plan.md)** 里
（2026-10-26 记，仍未开工）。想先看用量，走设置里的「用量统计」或状态栏读数。

## 5. 契约层与进程间协议

`src/contract.ts` 定义 `DscRuntime`：TUI 与桌面端消费同一接口，桌面端经协议转接。

**消息种类**（`src/plugins/host-stdio.ts:29-42`，桌面侧镜像在
`desktop/electron/main/protocol.ts:36`）：

| 方向 | 消息 | 作用 |
| --- | --- | --- |
| 宿主 → 运行时 | `invoke { id, method, args }` | 调白名单方法 |
| 宿主 → 运行时 | `exit` | 让运行时收尾退进程 |
| 运行时 → 宿主 | `hello { protocolVersion }` | 启动握手 |
| 运行时 → 宿主 | `result { id, ok, value \| error }` | 调用应答 |
| 运行时 → 宿主 | `snapshot { snapshot }` | 全量快照推送 |
| 运行时 → 宿主 | `ui { action: 'open-picker' }` | 命令要求开界面 |
| 运行时 → 宿主 | `dock-data { id, data }` | 终端输出流 |

**方法白名单**就是 `DscRuntime` 去掉 `subscribe` / `getSnapshot` / `exit` / `dispose`
（这四个只在宿主进程里成立：快照走 `snapshot` 消息流，退出由宿主动手）。清单按主题分组：
会话操作、模型与思考强度、插件开关、队友（`listTeammates` / `peekTranscript`）、命令、
审批应答、dock、会话库（归档/恢复/删除/改名/置顶/分叉）、界面偏好、技能中心、设置界面与
模型配置。

**加一个方法要走三步**，少一步就是「renderer 里点了没反应」：

1. `src/contract.ts` 的 `DscRuntime` 加签名；
2. `src/plugins/runtime.ts` 实现；
3. `src/plugins/host-stdio.ts` 的 `INVOKABLE_METHODS` 加名字，renderer 侧 `bridge.ts` 加一行转发。
   两份清单现在都由 `DscRuntime` 推出来：第 3 步漏了会编译报错（白名单那份 `satisfies`
   一份类型兜底，`bridge.ts` 那份是映射类型，少写一个实现就补不上），不再靠人记。
4. **要让浏览器里的插件壳也够得着**，还得进 `src/core/ui-methods.ts`：`UI_METHODS` 放行，
   `UI_ARG_SPECS` 给实参规格（个数 / 类型 / 长度 / 枚举，`validateUiArgs` 是那道闸）。
   注意这条通道的规矩：**省略只能从尾部开始**——`null`/`undefined` 占位会被拒，所以
   「第二个参数可选」这种排布在这一面根本表达不出来（`newSessionIn` 因此是独立方法，
   而不是 `openSession(id?, cwd?)`）。
5. **手机（远程页）是第三份清单**：`src/plugins/remote/types.ts` 的 `REMOTE_SHELL_METHODS`
   = `REMOTE_METHODS` + 几条壳的必要交互。壳与电脑是同一份产物，所以每加一条要问
   「手机上点得到吗、点到了是读还是写」：**只读投影一律放行**（`getModelConfig` /
   `listPresets` / `readPreset`，2026-10-27 补的），写入类（`saveProvider` /
   `setProviderKey` / `setDefaultModel` / `setSettingValue`）留在外面——看得到配置就够了，
   改端点与 key 请回电脑上改。`scripts/remote-host-test.mjs` 两头都有断言：放行的在、
   挡的还得挡。

**开新口子时的一条尺子**：要给壳开一条「能触发某类动作」的路，别把底层的通用执行口整条
放行——加一个只管这一类的方法，名字面在宿主侧钉死。现成的一对例子：`runCommand`（能跑任意
命令）持续留在 `UI_EXCLUDED`，壳的 `/` 菜单走新增的 `runUiCommand`：它只派发
`src/core/commands-completion.ts` 里标了 `shell: true` 的命令，闸是纯函数
`shellCommandRejection`（探针直测）；命令表以后加一条新命令不会自动变成可达。

同一条通道与终端**共用注册表、不共用能跑的范围**：壳只放行 `shell: true` 那批，所以
`/help` 在壳里只列这七条（`shellHelpText`，2026-10-27 修），终端里仍是全量；命令看得见
自己在哪一端，靠 `CommandContext.shell`（`runUiCommand` 置真）。命令名前缀展开也带参数生效
（`/di HEAD` → `/diff HEAD`），不再只在裸命令时成立。命令输出（`/` 命令写进会话的那条
system 条目）带 `command: true`：壳的空会话欢迎态原先把首屏 system 条目整批不画，新会话里
打第一条命令什么也看不到；命令输出因此单独放行，画成左对齐等宽的 `.entry-system-command`。

版本号一览：

| 常量 | 位置 | 当前值 | 什么时候动 |
| --- | --- | --- | --- |
| `KERNEL_API_VERSION` | `src/core/plugin-registry.ts:79` | 6 | 插件能用的扩展点有增减 |
| `HOST_PROTOCOL_VERSION` | `src/core/dock-browser.ts:20`（`src/plugins/host-stdio.ts` 只做再导出） | 3 | 协议消息种类或白名单语义变了 |
| `NATIVE_BRIDGE_VERSION` | `src/core/native-bridge.ts:70` | 3 | **加操作不涨**；改某个操作的实参或语义才涨 |
| 插件契约版本（`apiVersion`） | `ui-shell/package.json` 的 `version` → `build-plugins.mjs` 写进清单 | 0.7.1 | **跟产品号同版**（`release.yml` 四方对账） |

两个版本都是「加载时对不上就报错」，不做静默兼容。插件可以声明 `apiVersion`，内核只拒绝
**高于**自己的版本。

第四个号（`apiVersion`）**跟产品号同版**。它写的是「插件面对的 `@dsc/ui` 契约」，
由 `ui-shell/package.json` 的 `version` 写进清单，`release.yml` 按 tag / 根 / `desktop` / `ui-shell`
四方对账。

**代价要清楚**：19 个内置插件的 `package.json` 都声明 `"@dsc/ui": "^0.7.1"` 这样的区间，
构建期（`ui-shell/build-plugins.mjs` 读 `shellVersion`）逐个校验。所以每次改版本号，
**19 个插件的 peer 区间要一起改**——`^0.7.1` 只认到 0.8.0 以下，出 0.8.0 那天不改就会被门禁拒掉。

好在漏改不会静默：`build-plugins` 会把失配的插件点名，`release.yml` 在打包前先跑一次
`build-plugins`，19 个全挂时发版直接停在 verify 作业，不会产出一个「界面全空」的安装包。

**加一个原生操作 / 事件**（`NATIVE_OPS` / `NATIVE_EVENTS`）要走四处，漏一处编译期就拦：

1. `src/core/native-bridge.ts`：`NATIVE_OPS`（或 `NATIVE_EVENTS`）加名字；
2. 同文件 `NATIVE_ARG_SPECS` 给实参规格——它是 `Record<NativeOp, …>`，漏写一个编不过；
3. `desktop/electron/main/index.ts` 的 `NATIVE_HANDLERS` 加实现——同样是 `Record<NativeOp, …>`，
   漏实现编不过（「白名单」与「真有实现」被绑在一起）；
4. 要推事件的话主进程 `mainWindow?.webContents.send('dsc:<事件名>', payload)`——preload 的
   `on()` 是通用转发（按 `NATIVE_EVENT_SET` 拒生名字），不用改。

**加一个设置项**：宿主侧 `src/plugins/settings.ts` 的某个分区 `fields()` 加控件声明、`values()`
回读、`save()` 加键分派（写进 `core/prefs.ts` 的偏好键）；壳侧不用动（通用表单渲染器按声明画）。
若这项的值可能「不在选项表里」（派生值，如权限预设的 `custom`），在 select 字段上声明
`derivedLabelKey`：壳读 `values[该键]` 当显示名，并把这一行渲染成**置灰只读**——派生值本来
就选不了，画成能点的下拉只会让人以为能选、点了还报错。

## 6. 数据与文件面

全在 `~/.dsc/` 下（工作区里的技能目录例外，见表末）。改任何一个格式都要先确认读写两侧。

| 路径 | 谁写 | 作用 |
| --- | --- | --- |
| `config.yaml` | 用户 / 设置界面（容错读写在 `src/core/config-store.ts`）/ `dsc config migrate` | 主配置：默认 provider/model + `providers`（`baseURL`/`apiKeyEnv`/`models`，可选 `api` 选协议适配器，缺省 `openai-completions`）+ `skills` 自定义目录 + `ui` 段选界面。每个模型可选 `contextWindow`/`maxTokens`/`thinkingLevels`/`thinkingParam`/`effortMap`/`modalities`（不写=四档 + `thinking` 开关 + 只吃文本） |
| `credentials.yaml` | 用户 / 设置界面 | key 的第二来源（第一是 `apiKeyEnv` 指向的环境变量，第三是回退读 `~/.dsh`） |
| `config.json` | 用户（可选） | 轻量覆盖：provider / model / temperature |
| `settings.json` | 设置界面与 `ctx.settings`（`src/core/prefs.ts:15`） | 审批与思考强度默认值、市场源清单、关窗是否缩托盘、侧栏界面偏好（排序、工作区顺序与别名） |
| `plugins.json` | 插件中心、`plugin_manager` 工具 | 条目树：`entries[{file, disabled, config}]` + `history` 版本记录（自动回滚靠它）。十八个官方可开关插件各占一条，`config` 里存它们的可调值（dsh 插件的 `risk` / `risks` 也存这里） |
| `skills.json` | 技能中心 | 每个技能的开关 |
| `desktop.json` | 桌面主进程（`desktop/electron/main/dsc-core.ts:42-60`） | 最近工作目录（最多记 12 个）、托盘提示是否弹过 |
| `.last-session` | 会话插件 | `--resume` 无参时指向上次的会话文件 |
| `sessions/<cwd 压缩名>/<uuid>.jsonl` | 会话插件 | 会话历史，append-only，恢复靠重放 |
| `attachments/v1/objects/<sha 前两位>/<sha256>` | 附件仓库（`src/core/attachments.ts`） | 用户贴进来的图片/视频/文件，内容寻址去重；`v1/tmp/` 是写入暂存区（原子改名发布）。会话 jsonl 只记引用，请求组装时才把图片读成 data URL |
| `sessions/meta.json` | 会话插件 | sidecar：归档 / 置顶 / 改名，**不进 jsonl** |
| `sessions/.archived/<工作区名>/` | 会话库（归档） | 归档区（把文件挪进来，不是在 jsonl 里打标记） |
| `.trash/<工作区名>/` | 会话库（「永久删除」） | 其实是回收站：按 mtime 超过 30 天才扫掉（`src/core/session.ts:564`），删错了还能手工捞回来 |
| `sessions/.teammates/<cwd>/<id>.jsonl` | 子智能体插件 | 队友运行记录。目录以点开头 ⇒ 会话列表扫不到 |
| `team/roster.json` | 子智能体插件 | 队友名册（收工的队友靠它出现在侧栏） |
| `team/boards/<会话 id>.json` | 智能体团队插件 | 共享任务板，每个会话各一块（0.6.16 及以前是全局的 `team/board.json`，不再读写） |
| `team/inbox/<队友名>.jsonl` | 子智能体插件 | 给队友的留言（追加写，队友在回合边界读） |
| `agents/<角色名>.md` | 用户 / 子智能体设置分区 | 队友角色文件，一个角色一个文件 |
| `plugins/*.js` | 用户 | 自定义插件 |
| `skills/` | 技能中心（安装） | 用户级技能目录，每个子目录一份 `SKILL.md` |
| `cache/` | 技能市场（`src/core/market.ts:10`） | 市场条目清单，缓存 1 小时 |
| `cache/session-index.json` | session-search 插件（`src/core/session-index.ts`） | 会话全文检索的倒排索引，带 `version`；是旁路缓存，删掉只会让下次检索重新回填 |
| `spill/` | spill 插件（`src/core/spill.ts`） | 工具输出超阈值时落盘的文件，目录 0700、文件 0600；按 mtime 保留 7 天、目录总量超上限从最旧的删 |
| `lifecycle-hooks.json` | 用户 | codex 形态的十二事件外部命令钩子配置（lifecycle-hooks 插件读它，与安全钩子的 `hooks.json` 各读各的） |
| `memory/` | memory 插件（内核，`src/core/memory.ts`） | 跨会话留下的长期事实：全局事实、用户偏好、当前工作区各一格 |
| `sandbox/tmp/<会话或工作区哈希>/` | sandbox 插件 | 沙箱私有临时目录：`TMP`/`TEMP`/`HOME` 在工具执行期间被重定向到这里，按会话×工作区隔离 |
| `schedule/` | schedule 插件 | `tasks.json` 任务定义（tmp+rename 原子替换）+ `runs.jsonl` 执行台账 + `.lock` 单实例互斥（pid + 启动时间指纹） |
| `learnings/<工作区哈希>/candidates.jsonl` | self-improve 插件 | 纠正/失败候选（`dsc/turn-end` 落一条），**不进系统提示**，`/learnings promote` 才生效 |
| `skills/.ledger.jsonl`、`skills/.usage.json`、`skills/.archive/` | self-improve 插件 | 技能变更台账（前后 hash，`/skills-ledger rollback <id>` 可回滚；patch 前另有 `SKILL.md.bak.<秒级时间戳>` 漂移备份）、命中计数与老化（active → stale 14 天 → archived 30 天，pin 挡自动改写）、归档区（只搬不删） |

技能发现的优先级（rank 小的赢，`src/core/skills.ts` 的 `skillRoots`）：

| rank | 目录 | 作用域 |
| --- | --- | --- |
| 100 | `<cwd>/.dsc/skills` | 项目 |
| 200 | `<cwd>/.agents/skills` | 项目 |
| 300 | `config.yaml` 的 `skills` 段自定义目录 | 全局 |
| 350 | `~/.agents/skills`（公共 Agent 目录，与 dsh 同一个位置） | 全局 |
| 400 | `~/.dsc/skills` | 全局 |
| 450 | `$DSH_HOME/skills`（缺省 `~/.dsh/skills`，dsh 自己的全局技能） | 全局 |

同一个目录被两条根指向时按目录去重（`DSH_HOME` 指到 `~/.dsc` 时就是这样），不会扫两遍。
作用域写在 `SkillInfoView.scope` 上，技能页据此分成「全局 / 项目」两组。
**插件自己的可调值统一存 `plugins.json` 条目里那份 `config`**：设置分区点「保存」走
`writePluginConfig` 写它，插件取值走 `resolvePluginConfig(file, passed)`
（`src/core/plugin-registry.ts:168`）——装配时传进来的那份作底，磁盘上那份覆盖它，
插件每次用值时现调这个函数，所以改完不必重启宿主。
界面上就能改的：`compact`（压缩保留条数、自动压缩触发线、锚点索引与用户原话两个字符预算）、`goal`（缺省轮次、一次加几轮）、`approval-floor`、`spill`、`session-search`、`lifecycle-hooks`、`mcp`、`tool-search`、`subagent`、`computer-use`、`web-search`——插件贡献的分区都排在**插件中心**那个插件的详情页里（内置插件要在内核清单里声明 `settingsSection`，见 `src/host/kernel.ts` 的 `BUILTIN_PLUGINS` 与 `OFFICIAL_PLUGINS`），设置面板只列内核自己的六个分区。
只能手写这个文件的：`approval.approvalTimeoutMs`（每次弹卡现读，改完下一张卡生效）、
`ask.maxQuestions` / `ask.maxOptions`（每次提问现读）、`prompt.instructionBudget`（每次拼提示词现读）、
`host-stdio.snapshotThrottleMs`（只在挂载时读一次，改完要重启）。

带 `version` 字段的有四个文件：`plugins.json`、`skills.json`、`sessions/meta.json`、`cache/session-index.json`。前三个都写死 `version: 1`，读到别的值就整表当空的重来（`src/core/session-meta.ts:53`）；`session-index.json` 的版本对不上（或内容读不懂）就整表重建，它是旁路缓存，没有迁移价值。
**会话 jsonl 本身没有格式版本号**——这是明写的取舍（`src/core/session.ts:4-5`），
所以改事件种类时没有加载期检查会替你兜底。

**会话 jsonl 的事件种类**（`src/core/session.ts`）：

```
meta     { cwd, createdAt, ... }        第一行，重写时保留
user     { text, images?, files? }       images = 图片引用；files = 视频/文件元数据（视频带 frames）
assistant{ text, reasoning, toolCalls? }
tool     { callId, name, text, images?, error? }   error = rejected | tool-error
summary  { text, keep? }                压缩产生的摘要；keep = 摘要之外保留了尾部多少条
state    { id, payload }                功能点状态（模式/清单/计划/目标/记忆/学习/system-prompt…）
note     { id, text }                   请求注入备忘（投影塞进请求体的日志外内容在此留底）
```

**附件链路**（2026-10-28 起，对齐 dsh 的 `attachment-local`）：

1. 输入区把文件 `POST /api/attachments?name=…`（裸字节，图片 20MiB / 其它 200MiB 上限）；
2. 宿主 `src/core/attachments.ts` 按魔数认类型、算 sha256、落到
   `<DSC_HOME>/attachments/v1/objects/<前两位>/<sha>`（同字节去重），回一份引用；
3. `submit(text, images, files)` 只带引用：`images` 是图片（含视频抽帧挂在 `files[].frames`），
   `files` 是视频/通用文件。宿主 `sanitizeFileRefs` 会丢掉页面编的 `path`，按 sha 重算；
4. `Session.appendUser` 把图片引用读成 data URL 塞进请求，视频/文件拼一行「路径 + 大小 +
   摘要前缀」的句柄；**jsonl 只写引用**，重放时再读回来；
5. 界面用同源 `GET /api/attachments/<sha>` 显示（支持 Range，视频能拖进度条）；
6. 帧只进请求、不进 `images` 列：气泡里仍是一张视频卡（dsh 把视频当独立 modality，
   这里没有 provider 的 video 块，就用「原件 + 关键帧」达到同一件事）。

**改附件之前先看**：`scripts/attachments-test.mjs` 覆盖了去重、上限、魔数、引用读回、
Range、会话投影与路径洗白；界面侧的上传/规范化/抽帧在
`ui-shell/src/plugins/composer/attachments.ts`，类型定义在 `draft.ts`（那份必须零 import，
`ui-composer-draft-test.mjs` 会红）。

**「模型可见 ⟺ 已记录」**（对齐 dsh 的 Model-visible ⟺ logged）：发给模型的每一份
都要求能从日志重建——消息历史存原文，改写走 `ctx.prompt.registerProjection` 的
**命名纯投影链**（内置 `fold-system` 并 system、`drop-images` 兜底换图，插件投影按
order 插队）；系统提示词不进消息流，由 agent 插件在每次请求时把用到的全文写进
`system-prompt` 状态条目（hash 去重，恢复会话后最后一条即当前生效的那份）；投影往
请求里注入的日志外内容（LSP 写后诊断、生命周期钩子话术）必须用 `session.appendNote`
落一条 `note` 记录。重建公式：**日志原文 + 投影链定义 + system-prompt + notes = 模型
看到的完整请求**。

读到 `summary` 记录时，`Session.load` 把已经读到的消息换成「摘要 + 末尾 `keep` 条」，尾部在清空之前先取下来：日志是 append-only，摘要之前的原始记录一条都没删，重放时只能靠这个数字知道接回多少。老日志没有 `keep` 字段，按 0 处理，结果是「摘要 + 摘要之后的记录」——这是刻意的向后兼容，比把摘要之前的原文整段读回来（压缩等于白压）好得多。

`tool` 的 `error` 只影响界面（工具卡显示「已拒绝」还是「完成」），不进 OpenAI 协议消息，
所以它存在 jsonl 里、由 `Session.toolErrors` 在重放时单独递给 transcript；
早于这个字段的老日志没有它，读的时候按固定拒绝文案补判一次（`src/core/session.ts` 的 `REJECTED_TOOL_TEXT`）。

**内核事件**（`src/core/loop.ts` 发出，`src/adapter/transcript.ts` 折叠成快照）：
`user` / `turn/start` / `turn/end{completed|aborted|error}` / `error` /
`delta{kind,text}` / `message` / `usage` / `tool/call` / `tool/result{error:tool-error|rejected}`。

## 7. 扩展点清单（新功能往这儿挂）

| 我要做的事 | 用的服务 | 落在哪 |
| --- | --- | --- |
| 给模型加一个工具 | `ctx.tools.register({ name, description, parameters, risk, run })` | `risk='read'` 自动放行，`write`/`exec` 走审批卡 |
| 加一个 `/命令` | `ctx.commands.register()` | 命令名撞内置的会被拒 |
| 往系统提示加一段 | `ctx.prompt.register(id, 取文本, { order })` | 插件关着时这段话自动消失；order 决定段次（模式条款 30、模型信息 890） |
| 加一个模型协议 | `ctx.llm.registerAdapter({ id, stream })` | 端点在 config.yaml 用 `api: <id>` 选择；未注册的协议发请求时响亮报错 |
| 改写发给模型的消息 | `ctx.prompt.registerProjection(id, fn, { order })` | **命名纯投影**：同一输入永远同一输出；模型可见 ⟺ 日志原文 + 投影链（旧截图裁剪用的就是它）。往请求里塞日志上没有的内容时必须配 `session.appendNote` |
| 工具动手之前拦一道 | `ctx.guards.register({ id, order, decide })` | 内置刻度：灾难地板 5、沙箱 8、协作模式 10、LSP 写前留底 7、安全钩子 20、浏览器域名 20、生命周期钩子 25、审批 30；守卫自己抛错按「拒」处理 |
| 改写工具的输出 | `ctx.guards.registerObserver({ id, order, observe })` | 内置刻度：密钥遮红 10、LSP 诊断注入 46、生命周期钩子 45、大输出溢出 50；order 小的先加工，后一位看到的是前一位的输出 |
| 换掉命令的执行体（真隔离） | `registerCommandRunner()`（`src/core/tools/command-runner.ts`） | 随包发布的内置插件可用（外部插件拿不到）：沙箱的容器后端把 `powershell -Command X` 换成 `docker run … sh -c X`；没有注册者时行为与从前完全一致 |
| 往界面快照加一块状态 | `ctx.surfaces.register(id, 取值)` | 先在 `contract.ts` 的 `RuntimeSurfaces` 上声明合并；快照装配层不认识具体功能 |
| 有张卡片正等用户点 | `ctx.waiting.register(id, () => 是否在等)` | 会话目标的自动续跑据此刹车 |
| 自己那块状态要跟着会话走 | `ctx.session.appendState(id, payload)` + `session.state(id)` | 先在 `SessionStateMap` 上声明合并；写进去是一条 `state` 记录 |
| 监听内核事件 | `ctx.events.on(...)` | 见 plugin-development.md §5 |
| 加一个设置分区 | `ctx.settings.registerSection()` | 声明式控件，插件拿不到 DOM |
| 挂一个技能来源 | `ctx.skills.registerProvider()` | 技能中心会多一个来源 |
| 对外提供能力给 UI | `ctx.provide('名字', {...})` + `contract.ts` + 白名单 | 见 §5 三步 |
| 让 UI 说话 | `ctx.transcript.system(...)` / `ui.notice` | **绝不用 console.log**，用户看不见 |

### 会话什么时候落盘（2026-10-29 起）

- **新建只在内存**：`Session.create` 当场给 id 与路径，但**不建文件**；`appendState` 写的记账（权限、模型、目标、清单）先攒进 `pendingState` 队列。
- **第一条真日志才写出**：user / assistant / tool / summary / note 任意一条落地时，一次写出 `meta → 攒下的 state → 这一条`（顺序不能反：恢复时逐条重放、最后一条生效）。
- **列表只认说过话的文件**：`listSessions` 跳过既无 `user` 也无 `assistant` 记录的 jsonl。写探针 / 插件时想「按路径切回某条会话」，先给它 `appendUser` 一句，否则磁盘上没有它。
- **首条消息出现后侧栏自动补行**：宿主在 `dsc/changed` 里认「当前会话文件在了、列表缓存没有」就补刷一次（同一路径只刷一次，防循环）。

两条与之配套的读数口径：输入框草稿住在 `ui-shell/src/plugins/composer/ui.tsx` 的模块级 `DRAFT_STORE`（进程内，刷新即清）；「上下文已用」的分母来自模型配置的 `contextWindow`，分子在重开会话 / 重启宿主时由 `readSessionUsage(sid).lastInputTokens` 回填（`Transcript.seedContextUsage`），没有用量行时整段不画。

## 8. 开发流程

```sh
# 装依赖：一个 workspace 装齐四个项目（内核 / 界面壳 / 桌面端 / 遥控 Web），
# 子项目不用再单独 install（2026-10-28 起）
pnpm install

# 内核（改 src/** 之后必跑）
cd D:\dsc && pnpm run build        # tsc → lib/，自检脚本跑的就是 lib/

# 类型检查（桌面端）
cd D:\dsc\desktop && pnpm run typecheck

# 自检脚本：全部在临时 HOME 上跑，不碰真实 ~/.dsc
# 三条汇总入口都按文件名自动发现，新探针不用回来登记：
pnpm run check:ui                  # 45 条纯 Node 探针，40 秒
pnpm run check:ui:e2e              # 4 条要真 Chromium，61 秒（含 diff 卡、手机尺寸远程壳）
pnpm run check:dsh                 # dsh 兼容层 + 组合包 + 真包挂载 + 会话桥 + 流/事件旁路 + 合成验收，180 条
pnpm run check:core                # 67 条内核探针（协议 / TUI / 会话库 / LLM 适配 / 审批），约 9 分钟
pnpm run check:style               # 排版闸门：制表符 / 行尾空白 / BOM / 混用行尾 / 末尾缺换行，2 秒
pnpm run check:style -- --changed  # 只查本次改动的文件（提交前用这个）
pnpm run check:all                 # 上面四条串起来（不含 e2e）
node scripts/dsh-real-package-e2e.mjs  # 真包验收（要联网：numa plugin add dsh-cost-meter）
node shots/team-check.mjs          # 插件与团队，98 条（shots/ 里的，不在库里）
node shots/storage-check.mjs       # 会话存储与会话库
node shots/llm-retry-check.mjs     # LLM 重试（连接失败 / 429 重试，400 与取消不重试）+ 版本号（10 条）
node shots/llm-adapter-check.mjs   # 协议适配器接缝：注册/派发/卸载、重复拒绝、未注册报错、api 字段校验（11 条）
node shots/prompt-projection-check.mjs # 命名投影链 + system-prompt 落盘 + note 记录与重放（17 条）
node scripts/dsh-compat-check.mjs  # dsh 兼容层：解析钩子、工具兼容面、内容钩子、logger 桥、不支持项响亮拒绝（43 条）
node scripts/dsh-session-bridge-check.mjs # 会话历史只读桥：形状照真实消费方、事件翻成 dsh 类型、写侧响亮拒绝（42 条）
node scripts/dsh-llm-event-check.mjs # llm/stream 旁路：事件名/参数/chunk 形状/不伤人（12 条）
node scripts/dsh-session-events-check.mjs # session/event 旁路：顺序、seq、surfaceOp、重试不另开步、真挂载（36 条）
node scripts/dsh-compat-live-check.mjs # 合成验收：真内核跑真回合，一个探针插件同时吃三条面（19 条）
node scripts/ui-dsh-card-replay-test.mjs # 重开会话后 dsh 卡片还在：日志落盘 → Session 读回 → transcript 重放（9 条）
node shots/model-caps-check.mjs    # 模型能力字段读写往返 + 档位 → 请求字段映射（23 条）
node shots/order-check.mjs         # 侧栏工作区排序落点 + 按工作区树的层级（跑前先编 workspace-order.ts）
node shots/sandbox-check.mjs       # 沙箱：路径围栏、命令策略、一次性升权、降级可见（193 条）
node shots/schedule-check.mjs      # 定时任务：六种选择器、DST、至多一次、catch-up、原子落盘（207 条）
node shots/lsp-check.mjs           # LSP：分帧、URI/UTF-16、服务器表、真握手（自带假语言服务器，167 条）
node shots/browser-check.mjs       # 浏览器：CDP 消息层、ref 代际、快照截断、整树清理（210 条，本机有 Chrome/Edge 才跑真启动段）
node shots/self-improve-check.mjs  # 自我改进：候选状态机、SKILL.md 硬校验、台账回滚、老化（181 条）
node shots/integration-check.mjs   # 集成交付自检（既有：守卫链次序 + 灾难命令 + 压缩重放，95 条）
node shots/m5-integration-check.mjs# 第五轮集成自检：五插件登记/挂载/热卸载/沙箱默认开不误伤（起四次真内核）
node shots/seed-ui-home.mjs        # 造一份临时 HOME 的会话数据，配 DSC_DESKTOP_SHOT 拍侧栏/轨迹
node shots/seed-model-home.mjs     # 造三个带能力字段的端点 + 一条带贴图的消息，拍模型设置与贴图
node scripts/composer-test.mjs     # TUI 输入候选面板

# 打包版实拍
cd D:\dsc\desktop && pnpm run dist:dir     # → dist/win-unpacked/Pneuma.exe
```

实拍的环境变量钩子（`desktop/electron/main/index.ts`，截图块从 `:433` 起，
`captureCaptionStrip` 在 `:545`，界面参数钩子在 `:499` 附近）：

| 变量 | 作用 |
| --- | --- |
| `DSC_DESKTOP_SHOT=<png 路径>` | 加载完成后截图并退出（带看门狗，`capturePage` 卡住也会退） |
| `DSC_DESKTOP_SHOT_DELAY` | 截图前等多久，默认 4000 ms |
| `DSC_DESKTOP_SHOT_TOPMOST=1` | 把窗口钉在最上层并 `show()` 一次。脚本启动 exe 时 STARTUPINFO 里的 `SW_HIDE` 会让窗口开成隐藏的，那样整屏抓图只能抓到窗口后面的东西 |
| `DSC_DESKTOP_SHOT_STRIP=<png 路径>` | 整屏抓图后裁出窗口右上角的原生控件条，写出 PNG 并把取样颜色打进日志。系统画的最小化/最大化/关闭**不在 `capturePage` 里**，只能这么看（实现见 `captureCaptionStrip`，`:433`） |
| `DSC_DESKTOP_SHOT_EVAL=<js>` | 截图前先在渲染层跑一段脚本：点开某个弹层，或把算出来的颜色读回来 |
| `DSC_DESKTOP_SHOT_EVAL_LEAD` | 上面这段脚本提前多少毫秒跑，默认 2000 ms |
| `DSC_DESKTOP_SEARCH` | 拼到界面的 query：`view=plugins`、`settings=subagent`、`teammates=1`、`peek=1`、`reveal=1`（让 hover 才出现的按钮常驻） |
| `DSC_DESKTOP_USER_DATA` | 换 userData 目录，单实例锁不跟已开着的实例抢 |
| `DSC_DESKTOP_DEMO=1` | 自动跑一轮真实对话（要模型 key） |

**拍图前必须清掉 `ELECTRON_RUN_AS_NODE`**：带着它启动打包 exe，会被当成纯 Node 直接退出，
退出码 0、无输出、不写文件，看上去像「截图功能坏了」。这个变量在环境里出现是合法的——
桌面壳启动内核就是靠它把同一份 exe 当 node 用（`src/headless.ts:1-6`），只有当你想让
exe 当**桌面端**跑的时候才要清掉它。

界面参数想自动化，就加 `?xxx=1` 这类一次性钩子（`ui-shell/src/ui-renderer/boot.ts` 已经
有 `view` / `settings` / `reveal` / `dropline` / `peek` 五个），别在自检脚本里手写点击。

**审查台账**：2026-10-28 做过一次全仓代码审查（开发规范 / 格式统一 / 重复代码 / 架构），
问题清单、复现命令与三批整改建议在 [code-review-2026-10-28.md](archive/code-review-2026-10-28.md)。
前三批已入库（HEAD `32a26af`）：两条 P0 清掉，`errText`、`clampInt`、`asRecord` 三个小工具各归一处，
TUI 浮层外框收成一份，提交对话框补上焦点管理，仓库地图的规模数字重填。
第四批到第七批（同日）在工作区：`errText` 又收掉八份（界面插件一律经 `@dsc/ui-primitives` 拿，
不在种子里直接引 core），`displayWidth` / `quoteForCmd` / `expandHome` / `lastUserText` / `splitList` /
`shellOf` / `jsonText` / `utf16Buffer` / 吞吐读数 / 浏览器输出口径（`cdp/report`、`cdp/ring-buffer`）/
快照推送节流 / git 读数相等判断 / 壳里十个插件的快照读数（`ui-primitives/snapshot`）各收成一份；
明细见报告 §十二 至 §十五。
第八批（同日）改动两处：时间格式化统一走 `core/clock.ts`（原先浏览器那条链输出 UTC、沙箱日志输出本地时间，
同一屏两套时间）；界面壳的模块级状态多了一份 `createSignal`，试点落在 `ui-layout/thread-view.ts`。
第九批（同日）把模块级状态收完：切页、团队面板、设置面板、动作表、dock 布局、文件树、旁问、启动账本
共八处改用 `createSignal`（值归信号用 `set`，值在别处用 `notify`）；`host-channel` 与 `hmr` 是实例作用域，
明确不收。函数体重复组复扫 **0**。
**当前状态与逐条结清情况看那份文档的 §十（总览）、§十一 至 §十七（各批）**；判断这一层是不是又欠了新账，
对照 §四 逐条看；经过写在 [development-log.md](development-log.md) 的「2026-10-28 全仓代码审查」一节。

新增这类小工具前先看 `src/core/` 下有没有现成的：`err-text`（错误文案）、`clamp`（数值）、`records`（对象判定）、
`strings`（切词与空串判定）、`json-text`（安全序列化）、`transcript-text`（从消息取文）、`shell-quote`（起 shell）、
`snapshot-throttle`（快照推送节流）、`git-surface`（git 读数相等判断）、`clock`（时:分:秒）、
`cdp/report` 与 `cdp/ring-buffer`（浏览器输出与事件缓冲）、`src/ui/signal.ts`（模块级信号，界面侧用）。
界面侧还要看基元包：`@dsc/ui-primitives` 已经有时间、token、文件大小、路径、吞吐、错误文案、git 读数相等判断，
以及**从宿主快照取数**（`snapshot`：工作目录 / 会话清单 / 条目流 / 回合状态）这些口径。

还开着的是 P1-3（巨石文件：契约已拆、组件未拆）与 P3-1（自检脚本无覆盖率统计）。
旧渲染层日落、收 workspace、契约拆分三件都已落地（2026-10-28）。

**自动门禁**：每次推与每个 PR 由 `.github/workflows/verify.yml` 跑三处 typecheck 加排版检查
（`check:style`）；夜跑（每天 02:00）与手动触发再跑两套探针——内核 `check:core`、界面
`check:ui`（各自先 build，探针读的是编译产物）。`release.yml` 只在推 tag 时跑。所以"本地绿"
不算数，以这两条工作流的结论为准。

**编辑器口径**：仓库根有一份 `.editorconfig`（UTF-8 / LF / 末尾换行 / 2 空格缩进，markdown
保留行尾空格，`.ps1` 走 CRLF）。它不管重排——为什么不引 Prettier / ESLint 见
`scripts/style-check.mjs` 的头注释；那份文件也只查四条硬规则。

## 9. 打包与发布

`pnpm run dist:dir`（试）/ `pnpm run dist`（安装包与便携版）三步：

1. `electron-vite build` → `out/`（主进程 + preload + renderer）；
2. `scripts/prepare-runtime.mjs` → `runtime-staging/dsc-core/`：拷 `D:\dsc\{bin,lib,package.json}`
   与运行期依赖（依赖用 `realpath` 穿过 pnpm 虚拟 store 解析）；
3. `electron-builder`：`files: [out/**, package.json]`，`extraResources` 把 `dsc-core` 与
   托盘图标放进 `resources/`，`afterPack` 再把 `dsc-core/node_modules` 落到位。

产物里的位置：`resources/app.asar`（壳）+ `resources/dsc-core/lib`（内核）。
**内核没跟着 exe 更新**时先怀疑 `prepare-runtime` 之前没跑 `pnpm run build`。

`asar: true` 会吃掉 fs 直读，自检脚本里那句「`app.asar` 里没找到运行时」就是这么来的。

## 10. 代码约定

- 注释与文档写中文，说人话：主语谓语宾语齐、逻辑词显式、能用数字就别用范畴词。
- **注释只写本地事实**：不复述代码、不留「这里原来怎样」的评审史。
- **不在插件里硬编码可调值**：会随部署变的东西一律进 `Config` 字段并能在界面改；协议常量
  和安全不变量该固定的就固定。
- **注册即副作用**：每个注册返回清理函数，`apply` 返回合并后的清理函数。
- **配置错误宁可炸**：能加载时发现的就在加载时报错，绝不静默跳过引用不到的东西。
- 空 `catch` 必须说明吞了什么、为什么。
- **按会话算的东西不许挂在模块级变量上**（`AgentScope`）。宿主同时常驻多个会话的 agent，
  模式、工具目录、系统提示都是**会话的属性**：`ctx.tools.visible(scope)`、
  `ctx.prompt.systemPrompt(cwd, scope)` 与各投影/提示段的回调都得把 `scope` 透传下去。
  写成全局量的话，用户点开另一个会话就会改掉后台那一轮的工具集与提示词——2026-10-28 那串
  「未知工具」就是这么来的（`src/plugins/presets.ts` 的 `bySession`）。
- **一轮之内工具目录只有一份**：`src/core/loop.ts` 在发请求时取一次快照（`requestTools`），
  执行按它解析名字。执行时再取一次，会在「请求与执行之间注册表变过」时把合法调用判成未知工具。
- **react-markdown 的 `components` 表必须是模块级常量**（`ui-shell/src/ui-primitives/markdown.tsx`）。
  表里的函数一旦写在渲染函数里，每帧都是新引用；react-markdown 把函数当元素类型交给 React，
  类型一变整棵子树就重挂——流式输出时表现为全篇代码块反复卸载重建（字号、行号各闪一遍）。
  `remarkPlugins` 数组同理，提到模块级。
- 文件结尾恰好一个换行。
- 提交用约定式格式：`feat:` / `fix:` / `chore:` / `docs:` / `refactor:` / `test:`，
  正文写「为什么」，中文。

## 11. 排错速查

| 症状 | 先看哪里 |
| --- | --- |
| 界面点了没反应 | 方法在不在 `INVOKABLE_METHODS`（§5 三步） |
| 控制台刷 `cannot get property "xxx" without inject` | 那是可选服务，读它的人要用 `ctx.get('xxx')` |
| 插件开关拨了没效果 | `plugins.json` 条目 + 内核是否热挂载失败（会话里会有一行说明） |
| 打包版没截图就退了 | `ELECTRON_RUN_AS_NODE` 没清；或单实例锁被已有实例占了 |
| 打包版行为和本机不一样 | `resources/dsc-core/lib` 是不是旧的（先 `pnpm run build` 再 `dist:dir`） |
| 队友不出现在侧栏 | 名册 `team/roster.json` 有没有那条记录；子智能体插件是不是开着 |
| 会话列表里冒出队友记录 | `sessions/.teammates` 的目录名被改了（点开头才会被跳过） |
| 模型看不见某个工具 | 插件是否启用；`description` 是否够明确；`parameters` 是否合法 JSON Schema |
| 重新打开会话后上下文又变长了 | 不该再出现：`Session.load` 读到 `summary` 记录时把之前累积的消息换成「摘要 + 末尾 `keep` 条」（`src/core/session.ts` 的 `case 'summary'`）。老日志没有 `keep` 字段时只接回摘要之后的记录，摘要之前的原文一样不读回来 |
| 网络断了却不重试 | 连接失败（`LlmError.retryable`，`src/core/llm.ts:199-205`）与 429 / 5xx 都会退避重试 2 次，判定在 `src/core/llm.ts:162-166`；流已开始或用户已取消则不重试 |
| 截图后 token 暴涨 | 看是否启用了旧截图裁剪（`computer-use` 插件的 `transformMessages`） |
| 流式输出时代码块抽搐／字号行号跳动 | `ui-shell/src/ui-primitives/markdown.tsx` 的 `components` 是否写成了内联箭头函数；代码块两态（纯文本 / 高亮）是否同一个 `pre.shiki > code > span.line` 骨架 |
| 流式时「回到底部」胶囊一闪一闪 | `ui-shell/src/plugins/transcript/follow.ts` 的跟随判定：`onScroll` 有没有把「内容变矮、浏览器夹 scrollTop」当成读者滚动（看 `pinnedHeight`）；`settle` 会不会在跟随态下按距离重判 |
| 工具回「未知工具：xxx」 | 先看这一轮的请求与执行是不是同一份目录（`src/core/loop.ts` 的 `requestTools` 快照）；再看模式投影有没有按会话算（`ctx.tools.visible()` 必须带 `sessionId`，否则你在看别的会话时，后台那一轮的工具集跟着换） |
| 切到别的会话后，后台那一轮的工具集／提示词变了 | 模式（预设）是不是又退回全局变量了：`src/plugins/presets.ts` 的 `bySession` 按会话 id 存，`dsc/session-open` 只登记被打开的那一个会话；投影与提示段的回调必须把 `scope` 传进去 |
| 写工作区外的文件被拒（沙箱） | 拒因里带当前档位与可写根清单；确有必要就在**同一次调用**里成对带上 `sandbox_permissions` 与 `justification`（照常弹审批卡），或把目录加进「设置 → 沙箱」的附加可写根 |
| 命令被沙箱当场拒 | 拒因写明命中规则（forbidden 前缀 / 网络开关关 / 越界写目标）；`/sandbox` 能看档位、强制执行等级与最近 3 次拒绝 |
| 定时任务没触发 | 宿主不常驻就不触发（重启后补投最近一次错过的）；`/schedule list` 看任务是否 enabled、`lastError` 写了什么、是否标了 blocked |
| `lsp` 工具回「没有数据」 | 按返回里的原因装对应语言服务器（typescript-language-server / pyright / rust-analyzer 等）；设置分区的状态按钮能看每个服务器的起停与 stderr 尾巴 |
| 浏览器起不来 | 「设置 → 浏览器」的 executablePath 填本机 Chrome/Edge 路径；必须用自建 profile（用户默认 profile 会被 Chrome 136+ 静默忽略调试端口），看当前标签页与关闭两个按钮可以直接验进程 |
| 模型新建的技能没进目录 | self-improve 产的草稿**默认停用**，去「技能」页手动启用；`/skills-ledger` 查每次变更，`rollback <id>` 可退回 |

## 12. 关键取值速查

改这些之前先确认设置界面对不对得上：能在界面改的一律走设置分区，不许在代码里另起一份。

**枚举**

| 名称 | 取值 | 位置 |
| --- | --- | --- |
| 权限模式 `ApprovalPolicy` | `readonly`（只读，写和执行一律拒）/ `auto-edit`（工作区内写放行，执行命令仍要审批）/ `full-access`（全部自动放行，灾难地板仍然拒）。旧的 `ai-review` 已由偏好迁移展开成「`full-access` + 审阅者 `auto-review`」（见下）。**按会话存**，不是进程级：A 会话切只读不影响 B 会话 | `src/contract/mode.ts:31`，判读在 `src/plugins/approval.ts`（沙箱边界第 4 层 → 权限模式 / 审阅者第 5 层），档位文案在 `approval.ts` |
| 审阅者 `ApprovalReviewer` | `user`（本人点卡，默认）/ `auto-review`（先给模型判官，判不出来再落人工卡）——**与权限模式正交**的一根轴，决定「要问的事先给谁看」；复核排在自动放行**之前** | `src/contract/mode.ts:45`，复核在 `src/plugins/approval.ts` 第 5 层内 |
| 沙箱后端不可用姿态 `SandboxOnUnavailable` | `degrade`（默认，降级为策略围栏继续）/ `fail-closed`（写与执行一律拒，读照常）；只对 `docker` / `windows-token` 生效 | `src/core/sandbox/policy.ts:58` |
| 思考强度 `EffortLevel` | `default` / `off` / `low` / `high` / `max` | `src/contract.ts:12` |
| 思考档位 `ThinkingLevel` | `off` / `low` / `high` / `max`（每个模型可只声明其中几档，`default` 不算模型能力） | `src/contract/mode.ts:14` |
| 档位字段 `ThinkingParam` | `thinking`（发 `thinking:{type}`，只有开关）/ `reasoning-effort`（发 `reasoning_effort`，线上值见 `EffortMap`）/ `none`（不发思考字段）。缺省 `thinking` | `src/contract/mode.ts:17`，映射在 `src/core/model-caps.ts:201` |
| 输入类型 `Modality` | `text`（恒含）/ `image`（贴图、computer-use 截图）/ `video`（只作声明，目前没有发视频的通路） | `src/contract/mode.ts:25` |
| 会话排序 `SessionSortKey` | `manual`（工作区按拖动顺序，没拖过就活动区置顶）/ `recent`（按最近写入）/ `created`（按创建时间） | `src/contract/task.ts:89` |
| 列表分组 `SessionGroupKey` | `workspace`（按工作区分组）/ `tree`（嵌套目录挂到最近的祖先工作区下）/ `flat`（不分组的单列表） | `src/contract/task.ts:89` |
| 归档显隐 `ArchivedFilter` | `hide`（默认，只看活动区）/ `show`（两区并成一份列表）/ `only`（只看归档区） | `src/contract/task.ts:89` |
| 队友审批 `TeammateApproval` | `forbid`（不允许）/ `foreground`（仅前台子允许）/ `ask`（允许并标注），从严到松按 `forbid < foreground < ask` 比较 | `src/plugins/subagent.ts:75` |

**默认值与硬编码数值**

| 数值 | 值 | 出处 |
| --- | --- | --- |
| 压缩保留的最近消息条数 | 缺省 20 条，夹在 5~200；可配 `compact.keepRecent`，设置「上下文压缩」分区就能改 | `src/plugins/compact.ts:38-43`、`src/core/compact.ts:27` |
| 审批卡等多久没人答 | 缺省 300 秒，夹在 10 秒~1 小时；可配 `approval.approvalTimeoutMs`，每次弹卡现读。**没人能应答时不等这个值**：没有 `interactive` 服务（tui / host-stdio 登记）且本进程不是终端直连时，直接按拒处理并写明理由 | `src/plugins/approval.ts:42-56`、`:116-128` |
| 模型一次最多问几题 / 每题几个选项 | 缺省 3 题 / 每题 4 项，都夹在 1~8；可配 `ask.maxQuestions` / `ask.maxOptions` | `src/plugins/ask.ts` |
| 提问卡等多久算没人答 | 缺省 900 秒（15 分钟），夹在 10 秒~1 小时；可配 `ask.waitMs`，每次挂卡现读。等满了卡片撤掉、模型拿到「用户没有回答」的实话接着走。**等人的这段时间不算 PTC 脚本的时限**（工具声明 `waitsForHuman`，`plugins/ptc.ts` 的停表只认它） | `src/plugins/ask.ts`、`src/plugins/ptc.ts` |
| 会话目标缺省轮次上限 / 一次放宽几轮 | 缺省 24 轮 / 8 轮，夹在 1~256 / 1~64；可配 `goal.defaultMaxRounds` / `goal.extendRoundsBy`，设置「会话目标」分区就能改；256 这个硬顶不可配 | `src/plugins/goal.ts:44`、`src/core/goal.ts:30` |
| 说明书（AGENTS.md）字符预算 | 缺省 20000，夹在 4000~200000；可配 `prompt.instructionBudget` | `src/plugins/prompt.ts`、`src/core/prompt.ts:37` |
| 快照推送节流 | 缺省 80 ms，夹在 16 ms~1 秒；可配 `host-stdio.snapshotThrottleMs` | `src/plugins/host-stdio.ts` |
| LLM 连接超时 / 流空闲超时 | 缺省 30 s / 180 s（流空闲：这么久一个字节都没到就判服务端挂起）；可用 `DSC_LLM_CONNECT_TIMEOUT_MS` / `DSC_LLM_STREAM_IDLE_MS` 覆盖（毫秒，夹在 1 秒~10 分钟，每次调用现读）。端点连不上时默认要等 30 s × 3 次重试 ≈ 90 s 才把失败浮上来，网络差的把它调小（如 8000） | `src/core/llm.ts` 的 `readTimeoutMs` |
| 自动压缩触发线 | 缺省为模型上下文窗口的 80%，夹在 50%~95%；可配 `compact.autoCompactPercent`，设置「上下文压缩」分区就能改 | `src/plugins/compact.ts:40`、`:63` |
| 压缩摘要的锚点索引预算 | 缺省 6000 字符，夹在 1000~20000；可配 `compact.anchorBudgetChars` | `src/core/compact-anchors.ts:32`、`src/plugins/compact.ts:46` |
| 压缩摘要的用户原话预算 | 缺省 8000 字符，夹在 1000~40000；可配 `compact.userQuoteBudgetChars` | `src/core/compact-anchors.ts:35`、`src/plugins/compact.ts:47` |
| 灾难地板的命令长度上限 | 缺省 4000 字符，夹在 100~100000；更长的命令按「看不清要跑什么」拒；可配 `approval-floor.maxCommandLength` | `src/core/approval-floor.ts:34`、`:116` |
| 灾难地板的熔断 | 连续被地板拒 5 次（1~100）后冷却 60000 毫秒（0~3600000），缺省开着；可配 `approval-floor.circuitBreakerThreshold` / `circuitBreakerCooldownMs` / `circuitBreakerEnabled` | `src/core/approval-floor.ts:35-36`、`:117-119` |
| 「只读命令」的判据 | 不止「第一个词在只读名单里」：① 引号外的 `>`（`2>&1` 不算）算写盘，整段不算只读；② `node`/`python`/`perl` 这类解释器一律不算只读，python 只有 `-m pytest`/`-m unittest`/`-m json.tool` 例外；③ `env` 会被剥掉再看真正的命令；④ `find` 带 `-delete`/`-exec`/`-fprint` 不算；⑤ `sed` 的 `e`/`w`/`-i` 与 `awk` 的 `system(`/`popen(`/`>` 不算。只有 ① 是可配的（走白名单），其余是安全不变量 | `src/core/command-policy.ts:299-320`、`:506-563` |
| 大输出溢出阈值与预览 | 缺省超过 4000 字符就落盘（200~4000000），预览留前 30 行（1~500），续读一次 200 行（1~2000）；可配 `spill.thresholdChars` / `keepLines` / `readChunkLines` | `src/core/spill.ts:31-39`、`:65-73` |
| 溢出的落盘与清理 | 单文件上限 1048576 字节（4096~268435456）、按 mtime 保留 7 天（1~3650）、目录总量上限 67108864 字节（65536~8589934592，超了从最旧的删）、目录 `~/.dsc/spill/`；可配 `spill.maxBytes` / `retentionDays` / `maxTotalBytes` / `dir` | `src/core/spill.ts:31-39`、`:65-73` |
| 会话检索返回几条 | 缺省 20 条，夹在 1~200；可配 `session-search.defaultLimit` | `src/core/session-index.ts:70` |
| 会话检索的片段与回填 | 命中片段 160 字符（40~2000）、回填每批 25 个文件（1~500）、单文件大小上限 8 MiB（4096~256 MiB，超了只记指纹）、索引目录 `~/.dsc/cache`；可配 `session-search.snippetLength` / `backfillBatch` / `maxFileBytes` / `indexDir` | `src/core/session-index.ts:51-56`、`:62-72` |
| 生命周期钩子缺省超时 | 缺省 10000 毫秒，夹在 500~120000；钩子最多 50 条、单条命令 1000 字符、matcher 120 字符；可配 `lifecycle-hooks.timeoutMs` | `src/core/hooks.ts:53`、`src/core/lifecycle-hooks.ts:168-170`、`:190-196` |
| MCP 的调用与重连 | 单次调用超时 60000 毫秒、握手 20000 毫秒（都夹在 1000~600000）；重连退避 1000→30000 毫秒、连续失败 5 次放弃（1~50）；清单里没写 `defaultRisk` 的 server 缺省按 `exec` 算；可配 `mcp.*` | `src/plugins/mcp.ts:53-62`、`:65-70` |
| 工具渐进披露 | 一次检索最多 5 条（1~20），档位缺省 2（1 = 只撤 MCP、2 = 再按 `deferRules` 撤、3 = 除 `keepTools` 外全撤）；可配 `tool-search.searchLimit` / `tier` | `src/core/tool-search.ts:24-29`、`:54-60` |
| 历史里超长工具结果怎么切 | 超过 8192 字符切掉中间、留头 4096 + 尾 1024，中间写一句「省了多少字符、原文还在日志里」；**最近 4 条不动**（刚跑完就切等于逼模型重跑）。同一条消息永远切成同一段——前缀缓存只在它第一次越线那一轮失效一次 | `src/core/tool-result-prune.ts` 的 `DEFAULT_TOOL_RESULT_PRUNE`，投影挂在 `src/plugins/prompt.ts` 的 `tool-result-prune`（order 560） |
| 右侧栏最宽多少 | 配置上限 820px，实际还受「窗口宽 − 侧栏宽 − 正文保底 480px」约束：拖到极限是右栏停住、正文不再被压扁；窗口缩放时同样按这条夹回去（只夹内存，不改用户存档的宽度） | `ui-shell/src/ui-dockkit/dock.tsx` 的 `dockDragLimit`、`ui-shell/src/ui-layout/app.tsx` 的 resize 夹取、`ui-shell/src/legacy/views.css` 的 `.thread-main` min-width |
| 模型请求重试 | 最多 3 次，退避 500ms × 2^(n-1)；可重试的是连接失败（`LlmError.retryable`，一个字节都没收到时）与 HTTP 429 / 5xx | `src/core/llm.ts:152`、`:162-166` |
| 同时在干的队友上限 | 4（收工的不占额度） | `src/plugins/subagent.ts:68` |
| 队友派活层数 | 1（只有 Lead 能派），0 = 彻底不派 | `src/plugins/subagent.ts:69` |
| 队友审批默认 | `forbid` | `src/plugins/subagent.ts:70` |
| 名册里最多留几条收工记录 | 12（`MAX_LISTED_FINISHED`） | `src/plugins/subagent.ts` |
| 截图最长边 | 1568 px，JPEG 质量 80 | `src/plugins/computer-use.ts:49-51` |
| 动作之间等待 | 120 ms | `src/plugins/computer-use.ts:52` |
| 距上次截屏允许的动作数 | 12，超了强制要求先看一眼 | `src/plugins/computer-use.ts:53` |
| 应用白名单 | 空串 = 不限 | `src/plugins/computer-use.ts:54` |
| 看屏免审批 | 默认关 | `src/plugins/computer-use.ts:56` |
| 最近工作目录记忆条数 | 12 | `desktop/electron/main/index.ts:146` |
| 技能市场清单缓存 | 1 小时，落在 `~/.dsc/cache/` | `src/core/market.ts:10` |
| 截图识别标记 | 工具结果文字里含「屏幕物理分辨率」才认定是自己截的图，不误伤别的插件带的图 | `src/plugins/computer-use.ts:72` |
| 沙箱默认档 | workspace-write：可写根 = 会话 cwd + 沙箱私有临时目录，附加根默认空、网络默认关。这个值只是**新会话默认**（plugins.json 的 `sandbox.mode`）；每个会话自己的档位存在会话 `permissions` 状态里 | `src/core/sandbox/policy.ts:54-55`、`src/core/permission-scope.ts` |
| 沙箱后端不可用姿态 | `degrade`（默认，降级为策略围栏继续，=旧行为）/ `fail-closed`（写与执行类一律拒、读照常，拒因规则名 `backend-unavailable`）；只对 `docker` / `windows-token` 生效，`policy` 后端的 `partial` 是预期状态、不触发 | `src/core/sandbox/policy.ts:58` |
| 沙箱升权 | `sandbox_permissions` + `sandbox_scope`（`once` 默认 / `session`）+ `justification` **成对校验**（只给 scope 或半截 → 按拒处理）；`workspace-write` = 留在沙箱内、把这次目标并进可写根后**重判**，`danger-full-access` = 这一次跳过沙箱判定；「本会话允许」只对「留在沙箱内」这一类给会话档（命令类与出沙箱档只给这一次） | `src/core/tools/sandbox-args.ts`、`src/plugins/sandbox.ts`（`grantSession` / `sessionGrants`） |
| 沙箱越界的两条路 | **能问的**（`outside-writable-roots` / `mode-read-only`）沙箱只 defer，审批是最后一道，用户点「这一次允许」就执行（对齐 dsh 的 read-only + ask）；**不能问的**（NT 命名空间 / ADS / 短名 / 解析失败 / 受保护名 / 只读子路径 / 网络开关 / 后端 fail-closed）保持硬拒。审批缺场时沙箱自己硬拒，不会变成无人把关 | `src/plugins/sandbox.ts`（`ASKABLE_RULES`）、`src/plugins/approval.ts`（第 4 层 `sandbox.check`） |
| 审批裁决顺序 | 硬地板 → 说明书类文件 → 已给授权 → **沙箱边界** → 权限模式 / 审阅者 → 人工卡。沙箱越界跳过所有自动放行（含完全访问），只给「这一次」；AI 复核排在自动放行之前，所以「完全访问 + AI 复核」每次调用都过判官 | `src/plugins/approval.ts:494-660` |
| 出厂权限预设 | `read-only` / `workspace`（默认）/ `full-access` / `auto-review`（沙箱 + 权限模式 + 审阅者三合一，取值对齐 dsh：只读 = read-only + auto-edit + user，工作区 = workspace-write + auto-edit + user，完全访问 = danger-full-access + full-access + user，AI 复核 = danger-full-access + full-access + auto-review）；三根旋钮拼不出预设时读作 `custom`（推导状态，能停留、不能选） | `src/core/permission-presets.ts`、`src/plugins/permission-presets.ts` |
| 权限三项的存储 | **按会话**存在 jsonl 的 `state` 条目 `permissions`：`{ sandbox, policy, reviewer }`，三项都可为 `null`（没钉过）。读取时缺哪项补哪项默认值并写回（钉住），此后改默认值不影响它；切换 / 恢复 / 分叉会话各带各的。子代理审批按派它的父会话归属 | `src/core/permission-scope.ts`、`src/core/session.ts`（`SessionStateMap.permissions`） |
| 新会话默认权限 | 偏好 `defaultPermissionPreset`（空串 = 按单旋钮默认）优先；否则 `defaultPolicy` / `defaultReviewer` + 沙箱默认档。设置里「设为新会话默认」只写这几项，**绝不动当前会话** | `src/plugins/permission-presets.ts`（`setDefault`）、`src/plugins/settings.ts` |
| 旧工具结果清理时机 | `round`（默认）：同一轮内只算一次清理计划，之后每步复用，请求前缀不因新工具结果而改；`request`：每次请求重算（旧行为，省上下文但前缀常失效）。配置键 `microcompact.refresh`，设置 → 旧工具结果清理 | `src/core/microcompact.ts`（`planMicrocompact` / `applyMicrocompactPlan` / `roundKeyOf`）、`src/plugins/microcompact.ts` |
| 旧工具结果清理门槛 | 计划能清掉的字符占整段提示词不足 **25%** 就一条都不清（0–80 可配，配置键 `microcompact.minFreePercent`）。理由：命中的缓存 token 只按约 1/10 价收，清 1 token 只省 1/10 的钱；清理点一动，从那儿往后整段前缀按全价重读。实测一次 11.9k 字符的清理让下一次请求多付 32k 未命中，比例只有 24%——正是这道门槛该拦的形状。队友汇报（`<teammate-report`）算程序注入，不再触发「新一轮」重算 | `src/core/microcompact.ts`（`planWorthApplying` / `isSyntheticUserMessage`）、`src/plugins/microcompact.ts` |
| 转录的会话归属 | `transcript.emit / system / plan` 的最后一个参数是归属会话 id：带了又不是当前查看的会话，整条丢掉（连快照失效都不做）；不传 = 全局提示（启动横幅、插件加载失败这类照写）。PTC 脚本内部的 `tool/call` / `tool/result`、压缩通知、文件更改预览、钩子留言、队友汇报回执都带各自的会话 id | `src/services/types.ts`（`TranscriptService`）、`src/plugins/transcript.ts`（`owned`）、`src/plugins/ptc.ts` |
| 钩子脚本的健康状态 | 批准状态多一档 `missing`：命令里写了脚本路径、文件却不在，就停跑并写明缺哪个文件。以前 `scriptFileOf` 只认存在的文件，文件没了等于跳过漂移检查、被当成「已批准」，跑到 `node` 那一步才以「退出码 1」失败；现在还会把 stderr 首行写进拦截理由（`Cannot find module` 这类） | `src/core/hooks.ts`（`scriptTokenOf` / `trustOf` / `judgeScriptRun`）、`src/plugins/hooks.ts` |
| 队友轮次预算 | 默认**不限**（插件设置「轮次上限」= 0，配置键 `subagent.maxTurns`）；填了就与角色文件的 `max-turns` 取更小的那个，角色写 0 也当不限。设限时最后一轮收走工具表、先补一句「直接给结论」，并把汇报推迟到这一轮跑完，避免半截汇报抢跑 | `src/plugins/subagent.ts`（`effectiveMaxTurns` / `finalRoundPending` / `settle`）、`src/core/agent-roles.ts` |
| AI 复核的输入 | 判官除了工具名、参数、工作目录，还带上**这一轮用户的原话**（最后一条真人 user 消息，跳过环境快照 / 清单提醒 / 钩子产出 / 队友汇报 / 压缩摘要，截 500 字）；判官自己那次请求的用量也按会话记账 | `src/plugins/approval.ts`（`lastUserWords` / `aiReview`） |
| 命令输出截断 | bash 超预算时留**头 60% + 尾 40%**，中间写明清掉多少字符、怎么看全（缩范围重跑或调大「命令输出封顶」）。只留头会把编译错误、测试断言这些「最后才打印」的原因丢掉 | `src/core/tools/bash.ts`（`truncateBashOutput`） |
| 模型与思考档位 | 按会话存在 `model` 状态条目（`{ provider, model, effort }`）。请求路由走 `ctx.llm.routeForSession(session)`，后台 agent / 压缩 / 起标题 / 审批判官 / 子代理各用自己那条；用量日志的 `provider/model` 也按发起会话记。新建会话没记过时沿用「上一次选的那一组」，恢复老会话没有记录时按配置默认 | `src/plugins/llm.ts`、`src/plugins/agent.ts`、`src/plugins/compact.ts` |
| 协作模式 | 按会话存在 `mode` 状态条目；守卫按本次调用的 `sessionId/sessionPath` 取那一档（后台会话在计划模式跑，不会因为你在看执行模式就被放行）；系统提示段的模式条款同样按 `scope.sessionId` 取 | `src/plugins/mode.ts`、`src/services/types.ts`（`ModeService.modeFor`） |
| 分支钮读数（输入框上方） | 快照面 `surfaces.git` = `repo` / `branch` / `detached` / `dirtyFileCount`（计数含未跟踪、只看会话 cwd 之内）；节奏 12s / 30s / 60s 三档 + 事件催拍（回合收工、换会话、写类 git op 落盘）；**没人读快照就不跑 git**（CLI / TUI 会话零开销） | `src/plugins/git.ts`、`src/core/git-exec.ts` |
| git 切 / 建分支 | `dock` 的写类 op（`git-checkout` / `git-branch-create`，**过审批**，卡片文案在 `DOCK_WRITE_LABEL`），执行用 `git switch --no-guess`（避开 `checkout <名字>` 的分支/路径歧义）；分支清单是读类 op `git-branches`（界面通道直接放行，当前分支排第一） | `src/core/dock-ops.ts`、`src/plugins/desktop-dock.ts` |
| 宿主方法调用的超时 | 默认 30 秒；**会挂起等人的方法**（写类 dock op = 过审批卡，卡自己等 5 分钟）给 5 分半——不然用户还在读卡，页面先报「调用宿主方法超时」 | `ui-shell/src/ui-layout/host-channel.ts`（`DEFAULT_INVOKE_TIMEOUT_MS` / `HUMAN_WAIT_TIMEOUT_MS`） |
| schedule 最小间隔 | `every` 下限 60 秒 | `src/core/schedule/rule.ts:26` |
| schedule catch-up 窗口 | 一次性 120 秒；循环取半周期夹在 120 秒 ~ 2 小时，超窗只跑一次不补积压 | `src/core/schedule/rule.ts:29-35` |
| lsp idle 回收 | 600 秒（设置可调，下限 30 秒） | `src/core/lsp/client.ts:22` |
| lsp 结果上限 | 默认 100 条（可配 1~1000）+ 16000 字符双上限 | `src/plugins/lsp.ts:71-76` |
| browser 快照与缓冲 | 快照默认 15000 字符按行截断（不切碎元素）；控制台环形 200 条 | `src/plugins/browser.ts:79,84` |
| browser profile 清理 | 整树 taskkill 后等 300ms 再删自建 profile | `src/core/cdp/launch.ts:288,444` |
| self-improve 复盘触发 | 本轮工具迭代数 ≥ 12（对齐 hermes 用迭代数不用轮数） | `src/plugins/self-improve.ts:115` |
| self-improve 技能草稿 | description ≤60 字符（超了拒收不截断）；老化 14 天 stale / 30 天归档 | `src/core/learnings/skill-write.ts:61,866` |

**队友的叫停与续跑**：`subagent` 的 `interrupt` 与 `stop` 都只停当前这一轮，队友**留在名册里**
（对齐 dsh 的 `interrupt_agent`：之后能用 `send_message` 接着聊）；真正清掉走界面的「移除」
（`TeamService.remove`，删记录与运行记录并 `dispose` 会话）。传话之后会重新挂一次汇报：
把 `awaitReport.minRound` 记成「当前轮数 + 1」，`settle` 里等模型又说过一句（或直接失败）才回，
`lastReportedRound` 防同一轮重复回（2026-10-27 修；探针 `scripts/subagent-resume-test.mjs`）。

**写/执行类不留持久授权**：一次审批只管这一次，`approval` 服务不跨回合记住「上次同意过」。

## 13. 模块速查

### 内核装配顺序

`createKernel()` 依次挂 34 个内核插件：`llm` → `session` → `guards` → `surfaces` → `waiting` → `approval` → `tools` → `tools-default` → `transcript` → `commands` → `skills` → `prompt` → `mode` → `presets` → `ptc` → `settings` → `image-diet` → `permission-presets` → `hooks` → `compact` → `microcompact` → `session-title` → `todo` → `plan` → `ask` → `agent` → `goal` → `memory` → `runtime` → `webserver` → `desktop-dock` → `git` → `plugin-manager` → `runtime-api`；末尾把十八个官方可开关插件登记进热挂载表（`registerBuiltinMount`），再按 `plugins.json` 的条目决定本次挂不挂（`src/host/kernel.ts`）。
这个顺序里有两处是必须的，不只是好看：`approval` 早于 `mode`，因为换档广播 `dsc/mode-changed` 而审批要听（审批卡上得写当前档位）；`transcript` 早于 `plan`，因为恢复会话时要先把会话流清空，计划卡那条条目才不会被清掉。
官方可开关插件之间还有一条硬约束：`tool-search` 必须排在 `mcp` 之后，否则它 apply 时 `ctx.get('mcp')` 是 `undefined`，MCP 工具的 schema 永远不会被撤下。

**自检脚本同进程起多个内核时要先停再验**：命令补全面（`src/plugins/commands.ts` 的模块级 `extraSpecs`）与插件元数据一样是进程级共享——不先停掉前面的内核，后起内核的 `specs()` 会看见前几份注册，验「关掉后消失」全是假阳性。cordis 的 `Context` 本身没有 dispose，fiber 在 `ctx.fiber` 上，停整棵内核是 `await ctx.fiber.dispose()`（m5 集成自检踩过这个坑）。
注意 `desktop-dock` 与 `plugin-manager` 不显示在插件中心的「运行内核」清单里。
把 `tools-default` 剔掉就得到一个只有对话、没有工具的 harness（`src/plugins/tools-default.ts:3`）。

### core 层

| 模块 | 该知道的 |
| --- | --- |
| `config.ts` | 合成运行期路由表：`config.yaml` + 凭据 + `config.json` 覆盖。`apiKeyEnv` 取不到值的端点整条不注册（`:74-76`）；默认路由指向不存在的端点时退回第一个可用组合（`:131-142`）。上下文窗口缺省 128000、输出上限缺省 8192（`:85-86`）。每个模型的能力字段过 `readModelCaps()` 归一化 |
| `model-caps.ts` | 模型能力（思考档位 / 档位走哪个字段 / 输入模态）的**唯一**来源：默认值、YAML 容错解析（认 `vision`、`photo`、`图片`、旧字段 `vision: true`）、档位 → 请求字段映射 `effortToWire()`（`:201`）。切模型时越界的档位由 `clampEffort()`（`:184`）退回 `default`；界面文案（`THINKING_LEVEL_LABELS`、`MODALITY_LABELS`、`EFFORT_WIRE_HINT`）也在这里，渲染层不另抄一份 |
| `config-store.ts` | 设置界面写 `config.yaml` / `credentials.yaml` 的**唯一**入口。端点名要匹配 `/^[a-z0-9][a-z0-9_-]{0,40}$/`（`:137`）；不写 `apiKeyEnv` 时按端点名推导成 `<名字大写>_API_KEY`；草稿的能力字段在 `validateDraft()`（`:156`）过枚举，缺省字段由 `capsOf()` 补，能力字段只在偏离缺省时写进 YAML（`:186`）；覆盖前会先存一份 `config.yaml.bak`，**YAML 注释会在这一步丢掉**（`:44`） |
| `migrate.ts` | 一次性搬 dsh 的配置，只读 dsh。目标已存在且没给 `force` 就直接返回（`:107`）。只收 `api: openai-completions` 的端点（`:78`） |
| `llm.ts` | 手写 SSE 解析：只认 `data:` 行，单行 JSON 解析失败就跳过。思考增量字段是 `delta.reasoning_content`，重放给模型时原样回传（空串不回传）。工具调用按 `delta.tool_calls[].index` 拼，`arguments` 用 `+=` 续接，最后按 index 排序。最多 3 次尝试，退避 500ms、1000ms。**协议适配器**：这份实现就是内置 `openai-completions` 适配器（`LlmAdapter`），别的协议由插件经 `ctx.llm.registerAdapter` 注册，端点配置 `api` 字段选择。请求头**不无条件加**：只有归因头命中门控的端点才多带两行（见下一行） |
| `request-attribution.ts` | 请求归因头（自标识 + 端点点名要的会话头）的纯逻辑。门控 `isOpenCodeGoBaseUrl()` 认的是**端点事实**——host 是 `opencode.ai` 或其子域、path 规范化后正好 `/zen/go/v1`（不认 provider id，那是用户随手起的名字）；命中才补 `user-agent`（`pneuma/<版本>`）与 `x-opencode-session`（值 = 会话 id；非法/超长/空一律**省略这个头**而不是照发——一个换行就能让 `fetch` 抛异常）。会话 id 由 `src/plugins/llm.ts` 的派发口兜底、四个调用方各自填自己那条会话 |
| `connection-test.ts` | 端点连接测试（设置 → 模型「测试连接」）：固定两条探针消息（system + user `hi`）、无历史无工具、输出预算 16、走与正常对话**同一条**链路（同协议适配器、同一份归因头），**流正常收尾即算通**（正文为空也算）。超时（20 秒）与「端点回了错」分开说；失败折成 `{ ok:false, error }` 不往外抛（点一次按钮不该弹两次错）。`pickProbeModel()` 定测哪个模型：显式给的 > 默认端点那份默认模型 > 清单第一个 |
| `session.ts` | 列表只读每个文件前 8 行 + mtime（`:463-472`），所以列表页别指望读到深处的内容。目录名把 `\\`、`/`、`:` 换成 `-`（`:34-36`） |
| `session-meta.ts` | `sessions/meta.json` 用 uuid 当键，所以归档挪文件不会丢状态（`:7`）。`version` 不是 1 就整表当空（`:53`） |
| `events.ts` | `CoreEvent` 九个变体，是 core 唯一对外通道（`:10-22`） |
| `compact.ts` | 见 §12 |
| `compact-anchors.ts` | 摘要的机械加固件：锚点索引（正则抽 PR 号 / commit / 分支 / 文件 / 报错 / 链接）、用户原话逐字引用、细节找回指针。全是纯函数，可以脱离模型单独断言 |
| `approval-floor.ts` | 灾难地板的判定：结构不可验证 → 灾难命令 → 用户 deny 黑名单 → 危险模式 → 命令白名单 → 无人值守，逐层给结论。配置读不通时守卫照样挂载却一律拒（挂不上等于链上没有地板，是 fail-open）。**只判「拒」或「不拒」**：命中白名单也只 `defer`，由 `approvalFloor` 服务把结论交给审批层免卡放行——地板自己 `pass` 会把 order 20 / 25 的安全钩子一并跳掉 |
| `spill.ts` | 溢出落盘：建文件（目录 0700、文件 0600）、按整行截断并在文件末尾写明第几行没落盘、生成预览与续读写法、按 mtime 与目录总量扫目录 |
| `sandbox/` | 沙箱纯逻辑：`policy`（路径规范化 + 可写根/受保护名/NT 前缀判定，**按每次调用的 cwd 算根**，解析失败保守拒）、`execpolicy`（命令前缀 allow/prompt/forbidden，写目标与网络命令识别，内层脚本再拆一层）、`backends`（docker 探测与执行体替换） |
| `schedule/` | 定时任务：`rule`（六种选择器 + 时区/DST）、`store`（tasks.json 原子替换 + runs.jsonl 台账 + pendingSlot）、`runner`（自重排 setTimeout + catch-up + pre-dispatch 校验）。**先落盘推进 nextRunAt 再投递** |
| `lsp/` | 语言服务器客户端：`framing`（Content-Length 分帧，别照抄 mcp.ts 的换行分帧）、`uri`（先解码成路径再比内外）、`servers`（内置表 + marker 找根 + PATHEXT）、`client`（握手/串行队列/idle 回收/破键退避）。挂着的请求结算用本地 settled 闸门——先清表再 settle 会让请求永不落地 |
| `cdp/` | 浏览器 CDP 底座：`transport`（id 配对 + **按 sessionId 路由** + 事件订阅）、`launch`（探测/参数串/DevToolsActivePort/整树 taskkill）、`snapshot`（无障碍树文本化 + ref 代际）、`actions`（Input/DOM/Runtime 动作） |
| `learnings/` | 自我改进：`store`（候选 jsonl 状态机）、`ledger`（技能变更台账与回滚）、`skill-write`（SKILL.md 硬校验 + 威胁扫描 + read-before-write + 老化）。读会话状态一律过 `normalizeLearningsState` 收口 |
| `tools/command-runner.ts` | 命令执行器缝：bash 在 spawn 前问注册表，容器后端换执行体用；无注册者时行为不变 |
| `tools/sandbox-args.ts` | 一次性升权参数的 schema 与解析：`sandbox_permissions` + `justification` 必须成对，只给半截按拒处理 |
| `session-index.ts` | 会话检索的旁路倒排索引：中文按 1-gram + 2-gram（所以「内存」这种 2 字词能命中），英文按整词小写；按 mtime + size 增量维护，落 `cache/session-index.json`，版本对不上就整表重建 |
| `mcp.ts` | MCP 客户端底座：stdio 与 streamable-http 两种传输上的 JSON-RPC、`mcp__服务器__工具` 命名、子进程环境白名单筛选、Windows 上按 PATH + PATHEXT 解析启动命令 |
| `tool-search.ts` | 工具渐进披露的纯逻辑：分词（中文按相邻两字）、手写 BM25 索引、延后判定（read 一律不许撤）、配置校验 |
| `lifecycle-hooks.ts` | codex 十二事件的钩子引擎：事件能力清单（wired / partial / unwired 与理由）、codex 形态配置的解析、跑外部命令、按失败方向给裁决 |
| `approval.ts` | 只有审批通道**接口**，判读在 `src/plugins/approval.ts` |
| `tools/` | `bash` 缺省 30 秒、最多 120 秒，输出超 8000 字符截断（累积到 16000 就不再收）——三个值都由 tools-default 插件配置下发（`bashTimeoutMs` / `bashMaxTimeoutMs` / `bashOutputChars`，设置分区「工具预算」可改），代码里的常量只是缺省。Windows 缺省走 `powershell -NoProfile -Command`（`-NoProfile` + UTF-8 输出前置 + 末尾补 `exit $LASTEXITCODE` 带回原生命令退出码），超时和取消都收进程树。**执行器可在「设置 → 终端环境」里换**（2026-10-30）：`bashShell` 存在 `plugins.json` 的 tools-default 条目里，取 `powershell` / `pwsh` / `gitbash` / `wsl` / `sh` / `auto`；四档折成四套 spawn 参数（见 `core/tools/bash.ts` 的 `shellPlan`），工具说明与环境快照里的终端名跟着换，审批地板的结构扫描也按同一条口径切 PowerShell / POSIX 语法（`core/terminal-env.ts` 的 `shellFlavor`）。`wsl` 会用 `-d <发行版>` 钉住探测时挑的那只（跳过 `docker-desktop` 这类没有 bash 的管理发行版）。`read` 单次缺省 2000 行（`tools-default.readLineLimit`）。`glob` / `grep` **边遍历边匹配**：按 `.gitignore`（从 git 根逐层读到搜索根，子目录的规则在进入它时生效，`!` 否定按「后出现的赢」）加内置大目录表（`node_modules`、`.git`、`dist`、`build`、`coverage`、`__pycache__`、`.venv`、`site-packages` 等）跳过，命中够 `limit` 就停，截断时明说「还有更多」；不再有「先收 1 万 / 2 万条再过滤」的全局额度——那会让 `.venv` 吃光额度、把真实结果挤成「无匹配」。`grep` 另外跳过 1 MiB 以上的文件。**没有目录白名单**——路径只按会话工作目录解析 |
| `skills.ts` | 只认顶层 `<目录>/SKILL.md` 与顶层 `<名字>.md`，不递归（`:165-178`）。`name` 要 kebab-case，非法就退回文件名并记一条问题 |
| `market.ts` | 缓存 1 小时、拉取超时 15 秒、浏览并发 6、附属文件最多 40 个。GitHub 匿名限额低，403/422 会提示设 `GITHUB_TOKEN` |
| `prefs.ts` | 偏好文件读坏了按默认返回，不崩（`:89-91`）。`closeToTray` 默认 true |
| `version.ts` | 版本号从包名 `pneuma`（兼容旧名 `dsc-tui`）的 `package.json` 往上找（`:12-13`、`:23`）。**改包名要同步 `PACKAGE_NAMES`**，否则「关于」分区显示 `0.0.0` |

### 工作目录（cwd）是谁的

**目录是会话自己的数据**（`Session.meta.cwd`，落进 jsonl 的 meta 行），不是宿主进程的状态。
这条线决定了「换目录要不要重启宿主」：

| 谁 | 读的是哪个目录 |
| --- | --- |
| 会话出生目录 | `SessionService.open(filePath?, cwd?)` 的 `cwd` → 没给时退到**当前会话的目录**，再退宿主启动目录（`src/plugins/session.ts`）。界面那侧是 `newSessionIn(cwd)`：在指定目录里开一条会话，**不重启宿主、不重载窗口** |
| 工具 / 沙箱围栏 / git 面 / 轮尾 diff | `core/loop.ts` 的 `get cwd()` = `session.meta.cwd`（每次调用传进 `ToolContext`） |
| 指令文件（AGENTS.md）、记忆 / learnings、项目技能、hooks 执行目录 | 会话目录（`prompt.instructionFiles(cwd)` / `memory.workspaceKey(cwd)` / `skills.skillRoots(cwd)` …），调用方传的是会话 cwd |
| dock 文件树 / 终端 / 预览 / git 页签 | 会话目录（`plugins/desktop-dock.ts` 的 `baseCwd()`） |
| 模型常驻终端（`terminal` 工具） | 会话目录（`core/tools/bash.ts` 的 `table.open(ctx.sessionId, ctx.cwd)`） |
| MCP stdio server 起进程 | 配置里的 `cwd` → 否则当前会话目录（`core/mcp.ts` 的 `spawnStdio(server, fallbackCwd)`） |
| 审批卡的路径基准 | 请求自带的 `cwd` → 否则当前会话目录（`plugins/approval.ts` 的 `baseCwd()`），**不再 `process.cwd()`** |
| LSP 命令解析 / 外部插件源相对路径 | 会话目录 / config.yaml 所在目录（`core/lsp/manager.ts` 的 `baseCwd()`、`host/kernel.ts`） |
| 宿主进程自己的 cwd（`process.cwd()`） | **只剩兜底**：没有会话时的 MCP/LSP/终端、以及「上次用的工作区」这一个记忆点（`desktop.json` 的 `lastCwd`，由界面经原生 op `rememberCwd` 记账） |

原生桥那条「切工作目录」（`switchCwd` / `chooseDirectory` → 宿主重启 + 整页重载）**留着但插件壳
不再调用**：它的能力等价于「在那个目录里开一条会话」，却要付一次重载的代价（旧渲染层删除前它是唯一调用方，现在没有消费方）。

### 检查更新与就地更新（谁在哪一半）

同一件事分两半，**分界线是「够不够得着 Electron」**：

| 那一半 | 住哪 | 负责 |
| --- | --- | --- |
| 问 + 比 + 挑 | `src/core/update-check.ts` | 拉更新源（GitHub Releases API）、比版本、从发布资产里挑安装器（`pickInstaller`）。零副作用，宿主与主进程共用同一份 |
| 排期 + 下载 + 装 | `desktop/electron/main/update.ts` | 现读 `settings.json` 的 `updateCheck` 排期；下载安装器（进度推 `update-progress`）→ `shell.openPath` 起安装程序 → 退出应用 |

为什么这么切：下载要落文件、装要起进程、装完要退出应用，三件都只有主进程做得来；把「检查」
留一半在宿主、一半在主进程，两边各存一份状态迟早对不上。所以**宿主侧只剩两个消费者**：
设置「关于」那颗按钮（回执 `kind:'update'` 时界面给「立即更新」）与 `/update` 命令（只打印）。

界面那侧：品牌行（`Pneuma` 右边）的更新按钮 `ui-shell/src/ui-layout/update-button.tsx` **只在
`status === 'available'` 时渲染**；挂载时 `checkUpdate` 问一次当前值、再订阅 `update-status`
（**两件都要**——事件是「之后的变化」，错过开机那一次就再也没有了）。浏览器页签与远程页里没有
原生桥，整块不渲染。

`desktop.json` 里记 `lastUpdateCheckAt` / `lastUpdateVersion`：前者给 `daily` 档算间隔，后者让
开窗瞬间就把按钮画出来（不必等网络）。安装器落在 `userData/updates/`，**不自动清理**（安装程序
可能正在跑），同版本文件名固定，下次下载直接覆盖。

### 审批判定顺序（`src/plugins/approval.ts:126-152`）

只有 `risk !== 'read'` 的工具进审批（`src/core/loop.ts:198`）。判读顺序：

1. `readonly` → 直接拒；
2. `full-access` → 直接放行；
3. `auto-edit` → 三个条件同时成立才自动放行：工具名是 `write` 或 `edit`、参数里取得到路径
   （按 `file_path`→`path`→`target`→`file` 顺序找）、路径落在会话工作目录内；否则弹人工卡；
4. 未知模式 → 弹人工卡。

**另有一层（第 5.5 层，与上面的档位正交）——审阅者**：`auto-review` 时，**每一次走到弹卡
这一步的事都先给模型判官看一眼**（`maxTokens: 200`、思考关掉，只要 ALLOW 或 DENY）：判放行就
直接过、判高风险或判不出来才落人工卡；`user`（默认）则直接弹卡。复核跑在自动放行**之前**，
所以「`full-access` + `auto-review`」与旧的 `ai-review` 档**逐字等价**——谁也不自动放行，全过模型。

**审批有超时**：挂起的审批等 `approval.approvalTimeoutMs`（缺省 300 秒，夹在 10 秒~1 小时，
每次弹卡现读），到点按拒绝结算（`src/plugins/approval.ts:172`）；本轮被中断也按拒绝结算。
被拒时循环会补一条 tool 消息「用户拒绝了这次工具调用。」，因为协议要求每个工具调用都有
对应的 tool 消息，否则下一轮直接 400（`src/core/loop.ts:203-207`）。

### 快照投影（`src/adapter/transcript.ts`）

- `delta` 只进「直播尾」，不进定稿表；`message` 才是定稿信号。定稿条目 id 从 1 递增，
  直播尾条目用**负 id**（`-(位置+1)`）避免撞号（`:51-59`）。
- 工具卡状态就四个：`running` / `done` / `failed` / `rejected`（`src/contract/mode.ts:17`），
  结果文字超 1500 字符截断（`:27`）。
- 状态灯优先级：有挂起审批 → `awaiting-approval`，否则在回合内且working → `working`，
  回合内不 working → `thinking`，其余 `idle`（`src/plugins/transcript.ts:74-81`）。
  0.6.50 起「有挂起审批」只数**当前查看会话**的卡（`approval.pendingView` 按
  `ctx.session.current().filePath` 过滤，后台会话的卡不串进当前视图）；后台会话的灯由
  `dsc/agent-status` 事件喂 `backgroundStates`，agent 切走 busy 会话时按
  `approval.pendingFor(path)` 重发对应状态（挂着卡发 `awaiting-approval`，否则 `working`），
  不再把「等你批准」盖成「还在跑」。
- **跨进程推的是全量快照，缺省 80 ms 节流**（可配 `host-stdio.snapshotThrottleMs`），没有 diff 协议；
  renderer 侧必须走 `onSnapshot`，代理对象的 `getSnapshot()` 会直接抛错（`bridge.ts:97-100`）。

### dock 的两侧分工

| 侧 | 管什么 | 护栏 |
| --- | --- | --- |
| `src/plugins/desktop-dock.ts` | 终端会话、工作区文件读写、git | 路径必须在宿主工作目录内；读文件超 512KB 返回 `tooLarge`；git 全部 `execFile` 固定子命令 + 参数净化（拒 `\0`、拒以 `-` 开头的注入）；默认超时 15 秒 |
| `desktop/electron/main/dock.ts` | 内置浏览器视图 | `contextIsolation: true`、`nodeIntegration: false`；弹窗一律 deny 并把新窗口 URL 就地加载；只允许 `http`/`https` |

dock 的操作名：`term-spawn` / `term-input` / `term-kill` / `fs-list` / `fs-read` /
`git-status` / `git-branches` / `git-stage` / `git-unstage` / `git-commit` / `git-checkout` /
`git-branch-create` / `git-log` / `git-diff`，未知的直接抛「dock 未知操作：xxx」。分档与
审批口径见 `src/core/dock-ops.ts`（读类直接放行；`git-stage` / `git-unstage` / `git-commit` /
`git-checkout` / `git-branch-create` 五个写类**过审批**）。终端是管道模式（没有 tty），
所以全屏程序跑不了。git 的执行与 porcelain 解析在 `src/core/git-exec.ts`（desktop-dock 与
`git` 插件共用一份）；当前分支与改动计数由 `src/plugins/git.ts` 登记成快照面 `surfaces.git`
（输入框上那颗分支钮读它）。

`Dock.tsx` 四个 tab（terminal / browser / files / git），宽度夹在 300~820，双击复位 420；
shell 候选 5 个，选中的存 renderer 的 `localStorage['dsc.dockShell']`。

**关掉整块栏最后一张页签才是收起侧栏**（`ui-shell/src/ui-dockkit/dock-model.ts` 的 `closeTab`）：
以前格被清空只补一张新 guide，画出来一模一样，用户点「开始」旁边的 ✕ 就像没反应。
判断口径是「关掉的这张是不是整块栏的最后一张」——是就收起（guide 的 ✕ 因此有反应），
不是就只补门面、栏不动。**不能判「还剩不剩非门面页签」**：那样「旁问」+「开始」两张
开着时关掉「旁问」，旁边那张「开始」会被一起收走（2026-10-28 报障）。程序性关闭
（桌面端 `browser-tab-close-request` 那条）走同一个函数，关掉最后一张时也一起收起。

### 面板尺寸与收起状态存哪

存在 renderer 的 `localStorage`、而不是 `~/.dsc/settings.json` 的用户状态，都是「这个窗口在
这台机器上摆成什么样」这一类，跟跨机器的用户偏好（外观、会话排序）分开：

| localStorage 键 | 管什么 | 夹取范围 / 默认 |
| --- | --- | --- |
| `dsc.dockShell` | dock 终端用哪个 shell | 5 个白名单值 |
| `dsc.dockWidth` | 右侧 dock 宽 | 300~820，双击复位 420 |
| `dsc.sidebarWidth` | 左侧侧栏宽 | 200~420，默认取样式表的 `--dsc-sidebar-w` |
| `dsc.sidebarRail` | 侧栏是否收成 56px 图标窄栏（`Ctrl+B` 切） | `'1'` / `'0'` |
| `dsc.threadWidth` | 中间正文列宽 | 480 ~（可用宽 − 80），默认取样式表的 `--dsc-thread-max`（96ch） |

拖拽逻辑在壳自己的 `ui-shell/src/ui-layout/` 里（从旧渲染层的 `panels.ts` 搬来）：Pointer Capture 攥住指针
（拖出窗口外再回来还接着拖），移动按 `requestAnimationFrame` 合并，取消就退回原宽。
**拖动中只改根元素上的 CSS 变量**（`--dsc-sidebar-w`、`--dsc-thread-max`），松手才写状态和
localStorage——每帧 setState 会重渲染整棵对话树。复位（双击）就是撤掉行内变量，让 `:root`
里那份默认值自己回来，JS 里不抄第二份默认数字。正文列宽写一个变量就够，是因为正文、审批卡、
输入区三处读的都是它。

### 主题色怎么送到原生窗口控件

Windows 的最小化/最大化/关闭三个按钮由系统画，样式表够不到它，所以主题切换时要多走一跳 IPC：

1. `tokens.css` 里的 `--dsc-chrome-bar` / `--dsc-chrome-symbol` 给出两个**不透明**颜色：
   底色就是顶栏透出来的 `--dsc-bg-page`，图标色把顶栏图标用的那 74% 次要文字色压平到页面
   底色上（系统那侧不接受 alpha，半透明颜色交过去会被压成错色）。
2. `appearance.ts` 的 `applyAppearance` 每次落完 `data-theme` 就调一次 `pushWindowChrome()`：
   用一个隐藏探针让浏览器把 `var(--dsc-chrome-*)` 算成实际颜色（同一份 `color-mix()`，内核会
   写成 `rgb()` 或 `color(srgb …)`，两种都要认），转成 `#rrggbb` 后经 `dsc:set-window-chrome`
   发给主进程；同一次外观里两个值没变就不重发。
3. 主进程收到后调 `setTitleBarOverlay` 改控件条、`setBackgroundColor` 改窗口底色。
   只收 `#rrggbb`，其它格式直接拒收。

### 启动这几秒：过渡页、失败页、首帧底色

一次冷启动的时间线（打包版实测，机器一般）：窗口创建约 0.5 秒 → 过渡页画出、窗口显示约 0.9 秒 →
宿主报出界面地址约 1.8 秒 → 壳首帧约 2.2 秒 → 占位淡出。这四步里只有一次可见的「换画面」。

- **窗口先隐着**（`show: false`），页面画出第一帧（`ready-to-show`）才上屏，所以点击快捷方式到
  看见东西之间没有白底板；
- **过渡页**是主进程用 data URL 造的一页（`splashHtml`）：品牌字 + 一条来回跑的进度条，
  底色与强调色跟着主题走。它不再是那张「界面还没构建出来」的兜底页——那页现在只在真失败时出现；
- **失败页只有三种触发**（`failureHtml`）：界面产物目录不存在、等 15 秒宿主仍未报地址、
  宿主启动途中退出（带退出码）。判过失败之后不再接宿主的界面地址：产物缺失时宿主照样报地址，
  但伺服的是 404，会把提示页顶成一张白底 404；
- **换文档不闪白**：壳的 `index.html` 里有一段内联脚本，按地址上的 `theme` 参数先落
  `data-theme` 与画布底色，CSS 到位之前就是对的颜色；同一页的 `#boot-splash` 是过渡页的
  「同款占位」，换文档后由 `main.tsx` 在首帧之后淡出 160ms 再删——把「换文档」和「第二批插件
  装上来」这两跳都盖过去。界面脚本没起来时，占位 8 秒后自己让开，不挡错误提示。

另外：`~/.dsc/settings.json` 里的 `ui.themeMode` 由主进程在开窗前读一遍（`system` 按系统深浅
解析），所以浅色 / 米白主题的用户开窗时不会先看见一块深色；`localStorage` 的镜像按源隔离，宿主每次
换端口就等于换一份空存储，指望它兜住首帧是不行的（`loadCachedAppearance` 因此优先用地址上那份）。

自检截图（`DSC_DESKTOP_SHOT`）不加载过渡页：截图钩子挂在 `did-finish-load` 上，需要一份可预测的
首个文档。启动期那几行日志带 `+NNNms` 前缀（`bootNote`），排查启动慢时直接看时序。

**开窗那一帧的颜色**（`desktop/electron/main/index.ts` 的 `THEME_PAINT`）：主进程在创建窗口之前
自己读一遍 `~/.dsc/settings.json` 的 `ui.themeMode`（`system` 按系统深浅解析），按深 / 浅 / 米白
三套值给窗口底色、控件条和启动页上色。壳仍会在外观生效时推一次真颜色，两边算的是同一套令牌，
所以看不见跳色——以前只有一份深色的 `DARK_CHROME`，选浅色的人每次开窗都先黑一下。

**出厂主题是 claude（暖米白）**（2026-10-30 从 dark 改过来）。默认值一共三处，改一处必须改全：
`src/core/prefs.ts` 的 `readPrefs`（真源，宿主回读走它）、`ui-shell/src/ui-layout/appearance.ts` 的
`DEFAULT_APPEARANCE` 与 `normalizeTheme`（宿主还没回读、或 localStorage 镜像为空时的那一帧）、
`desktop/electron/main/index.ts` 的 `readUiTheme` 兜底（没 `settings.json` 时的首帧底色）。
已经存过 `settings.json` 的用户不受影响：读档优先，默认值只服务于"从没选过"的情况。

启动期还有两处跟颜色有关的细节：窗口用 `show: false` 创建，等页面画出第一帧（`ready-to-show`）
才上屏，不给人看白底板；壳的 `ui-shell/index.html` 里有一段内联引导脚本，按地址上的 `theme`
参数先把画布底色铺上，CSS 到位之前也不闪白。

顺带一条颜色纪律：`styles.css` 里不再出现颜色字面量，只剩 6 行是故意留的（品牌渐变 logo
和它的白字、彩底上的白色图标、开关的白滑块、两处深色遮罩）。要更重或更轻的语义色就用
`color-mix(in srgb, var(--dsc-*) N%, transparent)` 现调，不要再抄一份十六进制。

### 浏览器底线（界面壳要跑在别人的内核上）

桌面窗口那侧永远是新的 Electron，但**同一份壳产物还要伺服给手机**（远程页 `remote-web`），
对面的内核可能比桌面旧好几年。2026-10-14 的手机报障就是撞在这条线上：侧栏与浮层点开是
透明的、跟会话叠在一起、文字全一个白度——根因是那个内核**不认 `color-mix()`**
（页面里留下的另一条报错 `AbortSignal.timeout is not a function` 把版本钉在 2022 年前后，
而 `color-mix()` 要 Chromium 111）。

三条规矩，新代码照这个走：

1. **别用「太新」的标准方法**。禁用清单（要就加进 `ui-shell/src/ui-primitives/compat.ts`）：
   `AbortSignal.timeout` / `AbortSignal.any`、`Array.prototype.findLast` / `findLastIndex`、
   `toSorted` / `toReversed` / `with`、`structuredClone`、`Object.groupBy`、
   `Promise.withResolvers`。`?.`/`??`、`String.replaceAll`、`Array.prototype.at`、
   `Intl.Segmenter`（在用的地方自带 `typeof` 兜底）算在底线之内。
   `scripts/ui-legacy-compat-test.mjs` 扫源码把这条钉住（带负向验证）。
2. **`color-mix()` 的兜底是生成物**：`ui-shell/src/legacy-color-fallback.css`，由
   `node ui-shell/scripts/build-color-fallback.mjs` 从 `tokens.css` 算出实色（预乘 alpha，
   与浏览器同算法），包在 `@supports not (color: color-mix(...))` 里，入口在 `styles.css`
   **之后**引入（同特异性靠源码序压过令牌）。**改了 `tokens.css` 就要重跑生成器**——
   `scripts/ui-color-fallback-test.mjs` 逐字节比对，忘了重跑会红。
3. **`inset` 简写**（Chromium 87）在整屏遮罩上要有四方向的兜底：`styles.css` 里那条
   `@supports not (inset: 0)` 点了五张遮罩（`.dsc-overlay` / `.menu-backdrop` / `.pop-mask` /
   `.git-dialog-backdrop` / `.overlay`）。遮罩失灵不是难看，是**点得到底下的东西**。

窄屏（手机）那一档的口径写在 `ui-shell/src/styles.css` 的「窄屏」一节
（`@media (max-width: 860px)` 与 `(max-width: 560px)` 两条），2026-10-15 的手机报障后是：

1. **左侧栏在手机上整条不给**（`[data-rail='1']` 时 `display: none`）——原来那条 56px
   窄栏上的六颗导航（展开/新会话/技能/插件/工作目录/设置）只剩两颗，挂进顶栏：
   **「会话」在左上角**（拉出侧栏抽屉，会话列表/搜索/新建会话都在里面）、
   **「插件」在右上角**（插件中心整页）。抽屉是浮层（`max-width: 86vw`）＋ 一层
   `.sidebar-scrim` 遮罩，**点遮罩收回**；抽屉页脚那颗「设置」也藏掉（手机上的设置页版式
   没适配）。判定口径：CSS 两条媒体查询 + `app.tsx` 的 `NARROW_QUERY`（同一个数，
   首帧懒量一次，别等 `matchMedia` 的 change 事件——重载后才跨档的路径靠不住）。
2. **页签行在手机档整行不给**：不画「对话 / 轨迹」那两颗（那 36px 让给正文）。轨迹页还有
   三个入口（会话右键菜单、工具卡药丸两处），切过去得有回头路，所以只在轨迹页上留一颗
   「← 对话」返回钮。
3. **整页模式（技能 / 插件中心）在手机档多一条「页头带」**（`.page-strip`）：桌面侧栏常驻、
   页里那颗「插件」钮一直看得见，再点一次就回对话；手机档顶栏被整页换掉了，进页之后连开会话
   抽屉的入口都没了（那颗「会话」也在顶栏里），**回不来**。页头带就是那条常驻侧栏的手机替身：
   左「← 对话」、中页名、右「会话」（这个按钮开抽屉，抽屉里那两颗「技能 / 插件」是另一个入口）。
   同时：窄屏下**进整页会自动收起抽屉**（`if (narrow && page !== null) setSidebarCollapsed(true)`）——
   否则整页开在抽屉 + 遮罩后面，看着像「点了没反应」。
4. **停靠区整块不给**（`.dock` / `.dock-toggle`），顶栏的「在资源管理器中打开」组
   （`.ws-open`）也藏掉——它们都要原生桥，浏览器里点了只会弹错。
5. **输入区**：文字区最小高 44（`--dsc-input-box-h`，桌面 40）；底栏固定两行——
   第一行 `+ 权限 模式`，第二行 `模型 档位 … 发送`（`flex-basis: 100%` 把右组钉在第二行，
   发送键 `margin-left: auto` 贴本行右缘）；两行都收矮（行距 4、底栏内距 2/8/6、发送键 32）。
   **权限 / 模式 / 档位三颗的浮层改成「贴住输入卡片」的一块**（锚点 `model-anchor-sheet` →
   `position: static`，面板 `left/right: 8px` + `width: auto`）：它们原来锚在自己那颗 chip 上，
   chip 排在行中间时 300/320px 的面板会探出屏幕左缘。那条规则的选择器是 4 个类
   （`.composer .composer-bar .model-anchor-sheet > .model-pop`）——legacy 里
   `.composer-bar .bar-left .model-pop.policy-pop` 也是 4 个类，靠 styles.css 在 views.css
   之后取胜；模型那颗不挂这个类（它有自己一套窄面板 + 悬浮飞出）。
   状态栏的悬浮卡与正文列把手藏掉（它们参与横向溢出，390px 下会把文档撑到 431px）。

### 命令与补全（`src/core/commands-completion.ts` + `src/plugins/commands.ts`）

命令表、补全与唯一前缀展开的**单一真源是 `src/core/commands-completion.ts`**——它是顶层
零 node 依赖的纯模块，渲染层（经 `@dsc/runtime/core/commands-completion.js` alias）、TUI
与插件三方共用。渲染层 import 链上任何一个模块顶层碰 node 内置模块，vite externalize
代理一求值就把整个渲染进程炸成白屏（0.6.26 踩的，见 development-log 阶段 44 与 memory）。
内置命令 23 条（`src/core/commands-completion.ts`，从 :35 起）
（`src/core/commands-completion.ts:35-61`）；`/review` 的 handler 在 `src/plugins/commands.ts`
（收集工作区未提交改动组装审查轮，git 收集在 `src/core/git-info.ts`）。插件注册的命令进
`extraSpecs`。输入 `/ne` 按 Enter 会展开成 `/new`（唯一前缀）。`/effort` 保留着但只回
一句「已移除」（`src/plugins/commands.ts:118`）。
