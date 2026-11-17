# 跨批次证据（主控取证，2026-11-09）

> 状态：已归档（2026-11-17）：2026-11-09 一次性审查报告；14 条 P0 已全部修复（见同目录 FIXES.md）。

这些是全仓层面的机械取证，作为各批次报告的交叉核对依据。每条都给出复现口径或行号；
未核对完的放在文末「待核实」。

## 1. `core → packages` 转发垫片：58 个，只有 3 个还被源码用

`src/core/` 下有 58 个文件的内容只有一行：

```ts
export * from '../packages/<包>/<文件>.js'
```

用「解析 import 说明符 → 落到真实文件」的口径统计（覆盖 `src`、`scripts`、`ui-shell/src`、
`desktop/electron`、`remote-web/src`，`lib` 与 `node_modules` 不计），结果是：

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 仍被源码引用 | 3 | `src/core/approval.ts`、`src/core/mcp.ts`、`src/core/memory.ts` |
| 只被 `scripts/*.mjs` 经 `lib/core/...` 引用 | 16 | 测试还在走旧路径 |
| 完全没人引用 | 39 | 连测试都不用 |

按位置再拆一层：**顶层 `src/core/*.ts` 18 个，子目录 40 个**（cdp 7、lsp 7、ops 3、
sandbox 17、learnings 3、tools 3）。批次 02 报的「18 个」是**顶层**口径（其正则
`^export \* from '../packages/` 只匹配一级 `../`），与本表的 58 个不矛盾；两边的
引用分类可以逐条对上：顶层 18 = 3 个源码引用 + 9 个测试引用 + 6 个零引用，
子目录 40 = 7 个测试引用 + 33 个零引用。

被源码引用的三处：

- `src/services/types.ts:16` → `../core/approval.js`（类型）
- `src/services/types.ts:20` → `../core/memory.js`（类型）
- `src/packages/lsp/manager.ts:16` → `../../core/mcp.js`（运行时函数 `buildChildEnv`）

问题不在「多几个文件」，而在方向：`services`（契约层）与 `lsp`（功能包）都在经由
`core` 这个名义上的底层去够 `packages`，依赖箭头是反的。同时 39 个死文件让 `src/core`
看起来仍然「拥有」这些实现，读代码的人会先读错文件。

处置建议（不在本轮改）：

1. 39 个零引用垫片直接删；
2. 16 个测试改 import 到 `lib/packages/<包>/...`，再删垫片；
3. 3 处源码引用按「类型进契约、函数进真正的共用层」重定向：
   - `ApprovalRequest/ApprovalDecision/ApprovalHandler`、memory 的几组类型 → `src/contract/`；
   - `buildChildEnv` → 抽到 `src/core/` 里一个真正的进程环境模块（mcp 与 lsp 共用），
     或者让 lsp 直接依赖 `@pneuma/mcp` 并把依赖写进 `inject`/包清单。

## 2. 已知 import 环（文件级，实测）

| # | 环 | 证据 |
| --- | --- | --- |
| 1 | `plugin-loader` ⇄ `plugin-watch` | `core/plugin-loader.ts:1446` → `./plugin-watch.js`；`core/plugin-watch.ts:44/455/494` → `./plugin-loader.js` |
| 2 | `git-info` ⇄ `services/types` | `core/git-info.ts:22` → `../services/types.js`；`services/types.ts:26` → `../core/git-info.js` |
| 3 | `self-improve/ledger` ⇄ `self-improve/skill-write` | `ledger.ts:20` → `./skill-write.js`；`skill-write.ts:30` → `./ledger.js` |
| 4 | `lsp/client` ⇄ `lsp/normalize` | `client.ts:37` → `./normalize.js`；`normalize.ts:14` → `./client.js` |
| 5 | `ui-boot/boot` ⇄ `ui-boot/hmr` | `boot.ts:87` → `./hmr`；`hmr.ts:25` → `./boot` |
| 6 | `ui-transcript` 工具卡簇（`ui.tsx` / `render.tsx` / `rows/tool-row.tsx` / `tool-card/factory.tsx` / `subagent-flow.tsx`） | `rows/tool-row.tsx:15` → `../tool-card/factory`，工厂侧再回指上层 |

环本身不一定立刻出错（类型导入会被擦除、函数用延迟调用），但它让「谁先初始化」变成运气，
也给打包/热更埋雷。第 6 条正是「旧工具卡当 fallback、新 Factory 当主路」的产物。

## 3. 重复实现（已抽样核对，不是同名巧合）

| 逻辑 | 位置 A | 位置 B | 差异 |
| --- | --- | --- | --- |
| 代用户输入文本前的密钥拦截 | `browser/index.ts:747` | `computer-use/index.ts:417`、`dock-browser/index.ts:553` | 桌面那份多一条 `classifyCommand` 灾难命令判定，网页两份没有；提示文案三份各写一遍 |
| 短暂 ID 显示 | `todo/todo.ts:46`、`commands/index.ts:591` | `tui/app/SessionPicker.tsx:153`、`AgentOverlay.tsx:33`、`ApprovalCard.tsx:41`、`StatusBar.tsx:52` | 6 份，TUI 与宿主各一套 |
| 时长格式化 | `ui-primitives/ui/time.ts:51`（ms） | `ui-status/ui/status-model.ts:190`（ms）、`core/schedule/rule.ts:706`（秒） | 同单位的两份可直接合一；秒那份语义不同 |
| PowerShell 执行 | `computer-use/desktop-control.ts:277` | `sandbox/win/doctor.ts:243`、`sandbox/win/setup.ts:367` | 三份返回形状不同（string / {code,stdout,stderr}） |
| 主题默认值与枚举 | `core/prefs.ts:382`、`core/prefs.ts:150` | `ui-runtime/ui/appearance.ts:65`、`:96` | 默认主题 `claude` 与 `THEME_MODES` 各存两份；另有 `desktop/electron/main/index.ts` 的 `readUiTheme` 与 `packages/runtime/index.ts:599` 的 patch 分支 |
| 工具卡骨架 | `ui-transcript/ui/rows/tool-row.tsx`（旧卡） | `ui-transcript/ui/tool-card/factory.tsx`（新 Factory） | 两文件非空行重合度约 56%；旧卡作为「Factory 没注册时的保险丝」保留 |
| 每包一份 `readConfig` | 18 个包各一份（如 `compact/index.ts:111`、`mcp/index.ts:116`、`goal/index.ts:51`） | — | 骨架相同（`resolvePluginConfig` + `clamp`），字段各异；属可收敛的样板，不是错 |

## 4. 上帝模块（按行数，`src/packages` 前 15）

| 行数 | 文件 |
| --- | --- |
| 2310 | `src/packages/ui-status/ui/ui.tsx` |
| 2039 | `src/packages/ui-sessions/ui/ui.tsx` |
| 1936 | `src/packages/ui-settings/ui/models.tsx` |
| 1864 | `src/packages/tui/app/App.tsx` |
| 1544 | `src/packages/approval/index.ts` |
| 1527 | `src/packages/subagent/index.ts` |
| 1522 | `src/packages/computer-use/desktop-control.ts` |
| 1475 | `src/packages/browser/index.ts` |
| 1308 | `src/packages/ui-plugins/ui/ui.tsx` |
| 1296 | `src/packages/ui-layout/ui/app.tsx` |
| 1283 | `src/packages/ui-settings/ui/ui.tsx` |
| 1205 | `src/packages/ui-composer/ui/ui.tsx` |
| 1195 | `src/packages/remote/index.ts` |
| 1146 | `src/packages/hooks/index.ts` |
| 1142 | `src/packages/tools-default/bash.ts` |

`src/core` 前 5：`plugin-loader.ts` 1987、`ui-bundles.ts` 1780、`session.ts` 1686、
`plugin-watch.ts` 1002、`llm.ts` 888。

行数不是罪证；这里只作为「优先拆哪几个」的排序依据，具体职责是否过载看各批次报告。

## 5. 包间直接依赖（不含 `@pneuma/runtime/*`，即不经运行时别名）

```
browser -> cdp (7)            dock-browser -> cdp (6)
hooks -> session-core (4)     subagent -> session-core (3)
compact -> session-core (2)   permission-presets -> permission-core (2)
ui-renderer -> ui-boot (2)    agent/approval/commands/microcompact/mode/plan/prompt -> session-core
approval/sandbox/settings -> permission-core
plugin-manager/presets/skills/runtime-api -> config-core
runtime -> commands-core      commands -> commands-core
tui -> ui-core (5) / commands-core (1)
```

除 `lsp -> mcp`（藏在 `core/mcp` 垫片后面）外，这张图是单向的，没有包与包的环。
这说明「耦合重」主要不在包间横向依赖，而在：核心层与包层的双向垫片、包内上帝模块、
以及同一份 UI 状态被多个包各自推导。

## 6. 多会话假设的机械统计

全仓 `ctx.session.current()` 共 **164 处，分布在 32 个包**：

```
19 transcript   16 sandbox    14 self-improve  13 hooks
13 llm          13 subagent   11 approval      8 mode
6 compact       5 plan        4 memory         4 permission-presets
4 presets       3 commands    3 goal           3 schedule
3 todo          3 tools-default  2 agent       2 ask
2 lsp           2 ops         2 session-search 1 git
1 mcp           1 microcompact 1 prompt        1 remote
1 runtime       1 session-title 1 skills       1 spill
```

判断口径：界面与「当前视图」读 `current()` 合理；工具执行、后台任务、定时投递必须用
调用方 `ToolContext.sessionId/sessionPath`。P0-6（`waiting.any`）与 P0-7（`todo`/`goal`
写当前会话）就落在后一类里。

## 7. 门禁盲区：规则写了，检查看不到

`docs/plugin-model.md:358`（包标准硬项 6）写的是「core → 包禁止（含 `import type`）」，
`scripts/plugin-standard-check.mjs:578-580` 也确实扫了 `src/core`。但扫描器
`scripts/plugin-dep-graph.mjs:30-34` 的四条正则只认 `@pneuma/<包>` 说明符：

```js
/(?:^|\s)(?:import|export)\b[^\n]*?from\s*['"](@pneuma\/[^'"]+)['"]/g
/\bimport\s*\(\s*['"](@pneuma\/[^'"]+)['"]/g
/^\s*import\s+['"](@pneuma\/[^'"]+)['"]/gm
/\brequire\s*\(\s*['"](@pneuma\/[^'"]+)['"]/g
```

58 个垫片全部用**相对路径**（`export * from '../packages/...'`），一条都匹配不上，所以全绿。
同理：

- `src/packages/lsp/manager.ts:16` 用 `../../core/mcp.js` 绕到功能包 `mcp`——
  功能包 → 功能包（`lsp`、`mcp` 都是 feature），按硬项 6 应红，但说明符是相对路径，漏过；
- `src/services/types.ts:16/20` 用 `../core/approval.js`、`../core/memory.js` 绕到功能包，
  而扫描范围只有 `src/core`，`src/services` 根本不在扫描面内。

结论：不是没有规矩，是规矩的检查只认一种写法。把相对路径跨层也纳入判据（或在 CI 里加一条
「`src/core` 下不允许出现 `../packages/`」的字面扫描），这批债才会被挡住。

## 8. 待核实

- 39 个零引用垫片是否被动态 `import()` 模板串或构建脚本按路径字符串引用（已扫过
  `src`/`scripts`/`desktop/electron`/`remote-web/src`，未发现；`lib/` 是构建产物，不计）。
- `typedTextBlockReason` 三份是否应统一：网页侧不做命令策略判定是有意还是漏了，需要产品口径。
- `ui-status`、`ui-sessions`、`ui-settings/models` 三个 2k 行文件的具体职责切分见批次 04/05。
