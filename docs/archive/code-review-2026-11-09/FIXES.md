# P0 修复记录：14 条 + 复审后二轮收口（2026-11-09）

> 状态：已归档（2026-11-17）：2026-11-09 一次性审查报告；14 条 P0 已全部修复（见同目录 FIXES.md）。

> 分支 `feat/pluginization`，基线 `752badb`（v0.9.1）。工作区里另有用户未提交的界面在途改动，
> 本次修复没有回退、没有覆盖它们。
>
> 做法固定三步：**先复核**（证明「输入 A → 执行 B → 错误结果 C」，证不出来就判误判、不改）、
> **再最小改动 + 一条探针**（探针必须能在纯 Node 下跑，修前 FAIL、修后 PASS）、
> **最后独立子代理复审**（只读，专门找「修完是否放宽了权限、是否只修了表面」）。
> 复审提出的硬条件一律再修一轮，不把问题留给下一批。

## 一、总览

| P0 | 复核结论 | 主要改动 | 定点探针 | 复审 |
| --- | --- | --- | --- | --- |
| P0-1 启动图丢 services | 成立 | `core/ui-manifest.ts` 补透传 | ui-boot-services 13 | 可收 |
| P0-2 patch config 没人读 | 成立 | `plugin-loader.ts` 三档优先级 + 热重挂 + 停用行登记 | plugin-config-enable 46 | 可收（二轮补生命周期） |
| P0-3 开关写两次盘 | 成立 | 持久化单点收在 `setPluginEnabledHot` | 同上（写盘计数） | 可收 |
| P0-4 两套启用判定 | 成立 | 统一走 `isPluginEnabled` / `canTogglePlugin` | 同上 | 可收 |
| P0-5 费用切回消失 | 成立 | `readSessionCostBuckets` + `seedCostBuckets`，会话打开与启动各回填一次 | session-cost-restore 32 | 可收（二轮补判官口径） |
| P0-6 全局挂卡钉死目标 | 成立 | `anyFor(owner)` + 三处登记按会话 + goal/schedule 按会话查 | waiting-session-scope 28 | 有条件可收 → 二轮补僵尸卡与四处入口 |
| P0-7 todo/goal 写错会话 | 成立（todo 更糟：原来根本不落盘） | 按 `ToolContext.sessionPath` 定位 + 按会话分表 | todo-session-scope 26 | 有条件可收 → 二轮补队友会话 |
| P0-8 队友自建守卫链 | 成立 | 共享 `ctx.guards` + `teammate-mode@9` + `teammate-approval@29` + 会话别名解析 | teammate-guard-chain 11、teammate-session-alias 32 | 有条件可收 → 二轮补 PTC/嵌套/取不到就拒 |
| P0-9 grep 绕过读禁 | 成立 | 所有读盘入口共用 `readBlockReason`；`edit` 一并堵 | grep-read-denylist 19 | 可收 |
| P0-10 命令三套分类 | 成立 | 共享「命令意图」+ 显式优先级 + 地板内联 fail-closed | command-intent-consistency 148 | 首轮发现放宽 → 修后二轮可收 |
| P0-11 预览旧 diff | 成立 | 补丁快照按页签 id 存，关页签/淘汰/换会话即失效 | dock-patch-invalidate 33 | 可收 → 二轮补跨会话误删与文件树入口 |
| P0-12 侧栏浏览器没眼睛 | 成立（报告两处细节不准） | look 恒注册、risk `read`、默认每次要人批 | dock-browser-look 28 | 可收 → 二轮补只读/计划档 |
| P0-13 dock 丢对话框事件 | 成立 | pendingDialog + `dialog` 动作 + 25 秒兜底 | dock-browser-dialog 22 | 可收 |
| P0-14 MCP npx 起不来 | 成立（真机复现） | 抽 `core/executable.ts`：带后缀优先、.cmd 才走 shell、含空格路径加引号 | mcp-command-resolve 15 | 可收 |

## 二、逐条要点

### P0-1 插件声明的 `services` 在组启动图时被丢掉
- 复核：字段在契约里真实存在（`core/ui-manifest.ts:64-112`），TUI 侧按它等提供者，Web 侧组图时漏搬，装载器读到空数组。
- 改动：`core/ui-manifest.ts:310` 补一行透传；`UiPluginEntry.services` 的注释补全语义。
- 探针：`scripts/ui-boot-services-check.mjs`（13 条，含 rev 覆盖声明）。

### P0-2 组合包 patch 的 `config:` 从未被读取
- 复核：patch 侧确实把 config 写到行上，挂载侧只传 inject/native/磁盘配置；仓库里没有内置使用者，但这是对外契约。
- 改动：
  - `plugin-loader.ts:1592-1607` 挂载按三档取值：**宿主直给 > patch 行 > plugins.json**，整块替换不深合并；
  - `plugin-registry.ts` 的 `resolvePluginConfig` 与挂载共用同一顺序（`registerRowConfig`），apply 收到的与 apply 里 resolve 到的逐键相同；
  - 热开关重挂不再丢 patch config；
  - 启动时就停用的行也登记一份行选项，启用时取得到。
- 行为变化：patch 给了的键，设置页改不动（要改改 patch）；patch 没给的键照常即改即生效。
- 探针：`scripts/plugin-config-enable-check.mjs`（46 条，真起 cordis root、真挂载、真点开关、临时 HOME）。

### P0-3 点一次开关写两遍 `plugins.json`
- 改动：持久化单点收在 `plugin-loader.ts` 的 `setPluginEnabledHot`；`packages/runtime/index.ts` 先用 `canTogglePlugin` 只判不写，第三方界面两条没有宿主光纤的分支各自写一次。
- 探针：同 P0-2，计数写盘 = 1。

### P0-4 「插件开没开」两套判定
- 改动：删掉 loader 里的精确 file 比对，统一走 `plugin-registry` 的 `isPluginEnabled`（认旧键别名、`defaultDisabled`、批版）；`listPluginInfos` 同口径；新增 `canTogglePlugin` 供调用方「只判不写」。

### P0-5 会话费用切走再切回就消失
- 复核：`clear()` 清空 `costBuckets`，重放不重放 usage，磁盘 `usage.jsonl` 有按模型的 token 与时间，价格表是模型级，够还原。
- 改动：`usage-log.ts` 新增 `readSessionCostBuckets`（按 1MiB 块扫、`"sid"` 预筛、按 model 分桶、按 t 判峰谷）；`adapter/transcript.ts` 新增 `seedCostBuckets`（整表替换 + 深拷贝，幂等）；`packages/transcript` 的 session-open 与 `host/startup.ts` 各回填一次。
- 口径：判官请求（`approval/index.ts:1114`）带 `k:'judge'`，回填跳过——它不走会话 loop，内存桶里本来就没有它。
- 探针：`scripts/session-cost-restore-check.mjs`（32 条，含切回不翻倍、判官行不计入）。

### P0-6 一张后台会话的审批卡钉死当前会话的目标
- 改动：
  - `waiting` 新增 `anyFor(owner)`，登记签名放宽成可带 owner；`any` 保留给粗口径界面；
  - approval / plan / ask 三处登记按会话算活卡；
  - goal 的 `takeGoalRound` 与 schedule 的投递只问自己那条会话；
  - 计划僵尸卡（上次进程留下的 pending）有终结路径：`settleRestored` 写回终态、`propose` 新计划时作废、`finish` / `dsc/exit` 清理；写盘成功后才清内存；
  - memory / self-improve / mcp / desktop-dock 四处审批入口补会话身份；
  - schedule 的闸从「整批」改成「逐任务按所属会话」。
- 探针：`scripts/waiting-session-scope-check.mjs`（28）、`scripts/plan-zombie-card-check.mjs`（30）、`scripts/schedule-session-gate-check.mjs`（13）。

### P0-7 `todo` / `goal` 写进「用户正在看的那条会话」
- 复核：goal 属实；todo 更糟——`writeTodos` 全仓零调用，工具只写内存，重启就丢。
- 改动：`sessionOf` 按 `ToolContext.sessionPath` 找会话（名册 → 按路径只读加载 → 最后才当前），todo/goal 按会话分表，todo 现在真的落盘。
- 队友场景：`Session.load(path, true, { lease: false })` 只读重放，不建文件、不抢写租约。
- 压缩时的「带过去」也按被压缩的那条会话取（不再把用户眼前那条的清单塞进后台摘要）。
- 探针：`scripts/todo-session-scope-check.mjs`（26）、`scripts/compact-carry-session-check.mjs`（20）。

### P0-8 队友自建守卫链，沙箱/地板/钩子对队友不生效
- 改动：
  - 删掉 `new ToolGuardRegistry()`，队友走共享 `ctx.guards`；
  - `teammate-mode@9`（在沙箱 8 之后，`pass` 不会跳过沙箱）保留父会话模式；`teammate-approval@29`（在主审批 30 之前）保留工牌等级、后台禁问、卡上署名；
  - 薄适配器把 sessionId/sessionPath 改写成人会话，并打 `teammate` 标记；
  - `Teammate.ownerSession` 派活时固化，父队友出队后嵌套队友仍指最上层；
  - `core/tool-guards.ts` 的 `gate()` 入口统一做会话别名解析，PTC 与 hooks 也吃到；
  - `core/guard-session.ts`：名册 → 按路径只读加载 → **取不到就拒/最严档**，绝不回落当前会话。沙箱拒绝、审批拒绝并说明会话已结束、模式按只读；
  - hooks 的 ask 补 `sessionId/sessionPath`；LSP 诊断改挂原始执行者。
- 探针：`scripts/teammate-guard-chain-check.mjs`（11）、`scripts/teammate-session-alias-check.mjs`（32）。

### P0-9 `grep` 绕过读禁名单
- 改动：`grep` 逐文件读盘前过 `readBlockReason`；单文件搜索整条报错，目录搜索跳过并计数说明；`edit` 同样先判（它的 `changes.baseline` 会回显原文）。
- 范围：`read` / `read_image` / `ops_*` 只读 / `grep` / `edit` 已收口；`glob` 只列名字不读内容。
- 附：`~/.dsc/plugins.json` / `hooks.json` / `hooks-trusted.json` 列入禁读（MCP 的 env 里有明文 token）。
- 探针：`scripts/grep-read-denylist-check.mjs`（19）。

### P0-10 同一条命令三套分类结论
- 复核：三套表确实各自为政；关键是地板把「内联脚本判不出」改成递归后，`bash -c "find / -delete"` 这类在完全访问档从硬拒变放行。
- 改动：
  - 新增 `core/command-intent.ts`：统一「程序名 / 一级子命令 / 内联脚本 / 联网 / 写目标」这组**事实**，三处各自保留结论档位；
  - 优先级写进模块注释：地板 5 → 沙箱 8 → 审批 30，前两道更严是有意的；围栏拒绝理由里带上审批面结论，用户能看出「卡为什么没弹」；
  - 地板内联递归加 fail-closed：内层必须「明确只读」或「写命令白名单 + 每个写目标都是字面量」，否则按判不出拒；空脚本仍拒；
  - 探针从 68 条扩到 148 条，删掉 30 条「同一函数自比」的恒真断言，新增完全访问档口径。
- 已知取舍：`bash -c "npm test"` 这类包装内的非白名单命令仍被拒（宁严勿松）；`bash -lc` 这类组合短开关仍认不出（与基线一致）。

### P0-11 文件改动快照只增不减
- 改动：补丁快照从「按文件路径」改成「按页签 id」，新增纯模块 `ui-dockkit/ui/patch-sources.ts`；`dock-state.ts` 在关页签、`PREVIEW_MAX` 淘汰、插件停用、换会话后按**全部会话布局**算活页签并清理；文件树/审查面板点开同一文件（不带 patch）时清掉复用页签的旧快照。
- 语义保留：`setDockFileView`（在途新功能：开预览页签并挂改动快照）行为不变。
- 探针：`scripts/dock-patch-invalidate-check.mjs`（33）。

### P0-12 侧栏浏览器默认没有快照入口
- 改动：`browser_dock_look` 恒注册、risk 恒 `read`；默认每次调用在工具内部请求一次人工审批（`forceAskReason`，跳过会话授权与自动档），同意才读；`lookWithoutApproval:true` 时不弹卡直读；免打扰模式直接拒、不弹卡。
- 行为变化：出厂多一个工具，每次「看一眼」会弹卡；`waitsForHuman` 让 PTC 等人的时间不计时限。
- 探针：`scripts/dock-browser-look-check.mjs`（28）。

### P0-13 侧栏浏览器把对话框事件放行后又丢掉
- 改动：补 `pendingDialog` 状态、`Page.javascriptDialogOpening/Closed` 处理、`dialog` 动作（accept/dismiss + promptText）、25 秒自动 dismiss + 说明、快照/导航结果顶部提示；页签关闭与插件停用时清定时器。
- 探针：`scripts/dock-browser-dialog-check.mjs`（22）。

### P0-14 Windows 上 MCP 的 `"command": "npx"` 起不来
- 复核（真机）：`where npx` 给出无后缀 bash 脚本与 `npx.cmd` 成对；无后缀 spawn 报 ENOENT，`.cmd` 直起报 EINVAL。
- 改动：新增 `core/executable.ts`（带 PATHEXT 后缀优先、POSIX 可执行位、只有 `.cmd/.bat` 才 `shell:true`、含空格路径加引号）；MCP 改用它；找不到命令给可读错误，不再盲交给 cmd 试。
- 探针：`scripts/mcp-command-resolve-check.mjs`（15，含真机 `npx -v` 端到端）。

## 三、复审后二轮收口（不计入 14 条，但都是「不修就等于没修」）

| 问题 | 来源 | 修法 |
| --- | --- | --- |
| 队友跑 PTC 时沙箱按「当前会话」判 | P0-8 复审 | 守卫链入口统一解析别名；`core/guard-session.ts` 取不到就拒/最严档 |
| 父队友出队后嵌套队友归属丢失 | P0-8 复审 | `Teammate.ownerSession` 派活时固化 |
| hooks 的确认卡落在当前会话 | P0-8 复审 | ask 传 `sessionId/sessionPath` |
| 计划僵尸卡永久停摆 | P0-6 复审 | `settleRestored` + 新计划作废 + 写盘顺序 |
| 四处审批入口不带会话 | P0-6 复审 | memory / self-improve / mcp / desktop-dock 补身份 |
| `anyFor` 不在契约里 | P0-6 复审 | 写进 `services/types.ts`，删 `declare module` |
| 压缩把用户眼前那条的清单塞进后台摘要 | P0-6 复审 | `carry(session)` |
| 停用行启用后丢 patch config | P0-2 复审 | 扫描时就登记行选项，启用时取 |
| 判官请求让费用回填虚高 | P0-5 复审 | usage 行 `k:'judge'`，回填跳过 |
| 切会话误删别的会话的快照 | P0-11 复审 | 活页签按全部会话布局算 |
| 文件树点开同一文件仍显示旧 diff | P0-11 复审 | 无 patch 打开时清复用页签的快照 |
| 定时任务闸仍是整批 | P0-6 复审 | 逐任务按所属会话 |
| MCP elicitation 卡记在建连会话 | P0-6/8 复审 | 每次工具调用刷新归属 |

## 四、门禁结果（本机 Windows，2026-11-09）

```
pnpm run typecheck            exit 0
pnpm --dir ui-shell typecheck exit 0
pnpm --dir desktop typecheck  exit 0
pnpm run build                exit 0（366 个桩 / 74 个功能包）
node scripts/check-p0.mjs     16/16 通过
pnpm run check:plugin        86 个包 / 461 条断言全过；换包 e2e 17/17
pnpm run check:ui            64/64
pnpm run check:core          107/107（约 724 秒）
pnpm run check:style         1284 个文件全部通过
pnpm run check:dsh           19 PASS / 0 FAIL
pnpm run check:remote        102/102
```

说明：
- `check:plugin` / `check:core` / `check:ui` 里有子进程捕获输出的用例，必须在**放宽沙箱**（允许管道）时跑；受限沙箱里会以 `spawn EPERM` 失败，那不是代码问题。
- `check:p0` 是本轮新增的定点门禁（16 条探针），不并入 `check:all`，用法见 `docs/development.md`。
- `ui-primitives/ui/icons.tsx` 原本有 13 处 LF 混在 CRLF 里（用户未提交的在途改动），只统一了行尾，没改内容。

## 五、遗留与取舍（没有在本轮做，写清楚免得下次重复讨论）

1. **`core/shell-quote.ts` 的 `\"` 对 cmd 无效**：MCP 服务器参数里带 `"` 时可能被 cmd 解析成第二条命令；参数来自用户自己的设置（不是模型可控），且改动会波及 LSP，建议单开一条并配 cmd 转义测试。
2. **`look` 每次调用都弹卡**：一次 `snapshot` 序列会连弹多张；「本会话允许」按钮对它不生效（`forceAskReason` 的设计）。若嫌烦，后续给审批加「只给 once」的选项。
3. **定时任务的旧任务没有 `sessionId`**：回落到当前会话；找不到当前会话时不挡，交给 preflight 判 blocked。
4. **历史 `usage.jsonl` 里的判官行没有标记**：回填仍会算进去（单次 0.02–0.09 元），文件滚动后自然消失。
5. **`foldSessionUsage`（用量卡）仍把判官行算进请求数与 token**：与费用口径不同，属产品选择，未改。
6. **分叉会话费用从 0 起算**：新 uuid 在盘上没有请求行，修复前也这样。
7. **守卫侧读盘开销**：归属会话被收摊后，每次判定同步读一遍会话 jsonl；MB 级长会话有感知，未加缓存（缓存会把权限档钉死）。
8. **未端到端实跑**：真桌面壳里的浏览器弹窗、真 MCP server 的 elicitation、真队友 + `run_code` 的组合；这些只有探针与读码证据。
9. **`registerBuiltinMount` 全仓无调用**：P0-2 改到的内置分支目前是死路径，没有删（属清理批次）。

## 六、怎么复验

```bash
pnpm run typecheck && pnpm --dir ui-shell run typecheck && pnpm --dir desktop typecheck
pnpm run build
pnpm run check:p0        # 16 条定点探针
pnpm run check:plugin
pnpm run check:ui
pnpm run check:core
pnpm run check:style
pnpm run check:dsh
```
