# 覆盖率 90% 计划（2026-11-16 审计后）

> 用户目标：**整体行覆盖率 ≥ 90%**，不再往后拖。
> 这份文件只回答三件事：现在差多少、按什么口径算、分几批补。
> 现有体系见 [testing-handoff.md](testing-handoff.md)；欠账见 [testing-backlog.md](testing-backlog.md)。

## 1 现在差多少（实测，不是估算）

命令（**全五 project**，2026-11-16 定案口径）：

```sh
pnpm test:coverage
# = vitest run --coverage --project unit --project integration --project ui --project snapshot --project tui
```

结果：`coverage/coverage-summary.json`（412 文件 / 5,179 条，exit 0）

| 指标 | 数值 |
| --- | --- |
| 报告内可执行行 | **46,627** |
| 已覆盖行 | **21,245** |
| 行覆盖率 | **45.56%** |
| 到 90% 还需新覆盖 | **+20,719 行**（允许剩余 4,663 行未覆盖） |
| 0% 文件 | 78 个 / 4,657 行 |

按目录（未覆盖行降序；完整表在 `coverage/coverage-summary.json`）：

| 区域 | 行数 | 已覆盖 | 未覆盖 |
| --- | ---: | ---: | ---: |
| `src/core` | 9,364 | 68.1% | 2,990 |
| `sandbox` | 2,426 | 26.5% | 1,782 |
| `superagent` | 3,399 | 61.3% | 1,316 |
| `ui-composer` | 1,380 | 15.4% | 1,167 |
| `lsp` | 1,014 | 9.2% | 921 |
| `ui-primitives` | 1,670 | 48.3% | 864 |
| `self-improve` | 1,124 | 31.6% | 769 |
| `ui-transcript` | 2,895 | 75.1% | 720 |
| `cdp` | 744 | 16.9% | 618 |
| `ui-status` | 679 | 9.0% | 618 |
| `ui-settings` | 1,127 | 53.5% | 524 |
| `remote` | 695 | 26.8% | 509 |
| `browser` | 557 | 11.1% | 495 |
| `hooks` | 523 | 9.2% | 475 |
| `ui-boot` | 474 | 0% | 474 |
| `subagent` | 596 | 22.8% | 460 |
| `ui-sessions` | 732 | 37.3% | 459 |
| `tools-default` | 847 | 46.0% | 457 |

单文件最大的缺口：`ui-status/ui/ui.tsx`（0%，618）、`ui-composer/ui/ui.tsx`（0%，360）、
`ui-boot/ui/boot.ts`（0%，316）、`ui-plugins/ui/ui.tsx`（0%，243）、`ui-prompt/ui/ui.tsx`（0%，238）、
`ui-composer/ui/model-controls.tsx`（0%，209）、`ui-skills/ui/ui.tsx`（0%，209）、
`ui-composer/ui/attachments.ts`（0%，191）、`lsp/manager.ts`（166）、`checkpoint/index.ts`（165）。
0% 文件集中在 ui 半边与 lsp/checkpoint 的入口文件——先导入、再补行为，是最便宜的一批。

### 1.1 W1 第一批进度（2026-11-16 晚，全五实测）

同一命令、同一口径，补完 W1 第一批（core 的 schedule / dsh-compat / spill / usage-log / team-board /
config-store + sandbox 的 review / net-proxy / execpolicy / plugin-wiring / win 纯函数面）后重测：

| 指标 | W1 前 | W1 第一批后 | 增量 |
| --- | ---: | ---: | ---: |
| 已覆盖行 / 可执行行 | 21,245 / 46,627 | **22,893 / 46,646** | **+1,648 行（+3.51 点）** |
| lines | 45.56% | **49.07%** | +3.51 |
| branches | 37.07% | **40.23%** | +3.16 |
| functions | 41.81% | **44.58%** | +2.77 |
| statements | 43.52% | **46.89%** | +3.37 |
| `src/core` lines | 68.07% | **79.89%** | +11.82 |
| `src/packages/sandbox` lines | 26.5% | **48.51%** | +22.0 |
| 0% 文件 | 78 | **77** | −1 |

跑法：`pnpm test:coverage`，423 文件通过 / 1 skip，exit 0；基线已抬到 49.0 / 40.2 / 44.5 / 46.8
（`src/core` 79.8 / 68.8 / 80.2 / 76.1）。

**W1 仍未达标**：本批目标 ~4,770 行，实际 +1,648（约 35%）。剩余缺口按未覆盖行排：

| 模块 | 未覆盖行 | 行覆盖 | 备注 |
| --- | ---: | ---: | --- |
| `core/schedule/runner.ts` | 269 | 15.1% | 已测纯函数，运行循环 / 投递 / 失败阶梯未覆盖 |
| `sandbox/win/runner-entry.ts` | 271 | 32.3% | 子进程入口，需 built 或子进程层驱动 |
| `core/plugin-loader.ts` | 209 | 66.3% | 目录扫描 / 坏清单 / 去重分支 |
| `packages/schedule/index.ts` | 226 | 1.7% | 命令与存储接线 |
| `sandbox/index.ts` | 177 | 57.3% | 装配面，依赖真后端 |
| 其余 core/sandbox | ~700 | — | policy / backends / 分页读取等 |

下一批继续 W1：runner 运行循环、plugin-loader、schedule 包接线、sandbox index/backends，
目标再 +2,000 行（全局 lines ≈ 53%）。

### 1.2 W1 收尾（2026-11-16 晚，第二/三批，全五实测）

第二批补了 runner 运行循环、session-bridge、plugin-watch、ui-bundles、plugin-loader 与五个
原先没有 spec 的小模块（child-env / secrets / lockfile / migrate / resolve-hook）；
第三批补了 `packages/schedule` 的装配面。同口径重测：

| 指标 | W1 前 | 第一轮后 | **W1 收尾** | W1 净增 |
| --- | ---: | ---: | ---: | ---: |
| 已覆盖行 / 可执行行 | 21,245 / 46,627 | 22,893 / 46,646 | **23,745 / 46,646** | **+2,500 行（+5.34 点）** |
| lines | 45.56% | 49.07% | **50.90%** | +5.34 |
| branches | 37.07% | 40.23% | **41.98%** | +4.91 |
| functions | 41.81% | 44.58% | **45.82%** | +4.01 |
| statements | 43.52% | 46.89% | **48.72%** | +5.20 |
| `src/core` lines | 68.07% | 79.89% | **86.75%** | +18.68 |
| `src/packages/sandbox` lines | 26.5% | 48.51% | **48.51%** | +22.0 |
| 0% 文件 | 78 | 77 | **77** | −1 |

跑法：`pnpm test:coverage`，434 文件通过 / 1 skip，exit 0；基线抬到
50.9 / 41.9 / 45.8 / 48.7（`src/core` 86.7 / 74.9 / 86.1 / 83.0）。

新增 spec（本阶段合计 143 条）：`core/schedule/runner-loop`（39）、`dsh-compat/session-bridge`（12）、
`plugin-watch`（17）、`ui-bundles`（24）、`child-env`+`secrets`+`lockfile`+`migrate`+`resolve-hook`
（26）、`plugin-loader`（11）、`packages/schedule/index`（14）。

**W1 收口判定（D42）**：本批原目标 ~4,770 行，实得 +2,500 行（52%），未达标；但**可测面已经打完**
——`src/core` 从 68% 抬到 86.75%，剩余 core 缺口是 session.ts 的长尾分支与 command-policy 的
既有 spec 未覆盖分支。真正剩下的大块是 `sandbox/win/runner-entry.ts`（271 行，导入即跑 main，
必须在子进程层验；built 层测不到它的运行分支）与 `sandbox/index.ts` 的后端装配分支
（需要真 Docker / 受限令牌才能走到的路径）。这两块不硬凑单测，按 D42 挪到 W6 的
「带理由的排除 + 替代验证」或后续 Windows 集成层。W2 起转向 0% 的界面/外部面。

### 1.3 W2 首轮（2026-11-16，进行中）

先把「纯决策面 / 协议面」打完，再碰装配层。新增 5 个 spec、68 条：

| spec | 条数 | 钉住的行为 |
| --- | ---: | --- |
| `packages/lsp/tests/protocol.spec.ts` | 29 | Content-Length 分帧（半包/粘包/超限）、URI↔路径、Location/hover/diagnostics 归一、行位移 LCS、服务器解析合并 |
| `packages/config-core/tests/market.spec.ts` | 6 | ClawHub/skills.sh 源识别、榜单/搜索地址、GitHub tree、市场视图 |
| `packages/self-improve/tests/draft.spec.ts` | 10 | 草稿回答解析（新建/修订/NONE/非法）、整理节流与一次整理的边界 |
| `packages/ui-composer/ui/attachments.spec.ts` | 12 | 类型判定/名字兜底、XHR 上传协议、20 张预算与帧裁剪 |
| `packages/approval/tests/review.spec.ts` | 11 | 判官 JSON 收口（白名单/矛盾/重复字段）、改动前预览的 diff 推演 |

实测：**24,053 / 46,646 = 51.56%**（W1 收尾 23,745 / 50.90，+308 行 / +0.66 点）；
branches 42.75 / functions 46.45 / statements 49.42；`src/core` 保持 86.75 / 74.91 / 86.17 / 83.07。
跑法 `pnpm test:coverage`，439 文件通过 / 1 skip、5,568 用例通过 / 5 skip、exit 0；基线抬到
51.5 / 42.6 / 46.4 / 49.3（`src/core` 不动）。首轮收益小是因为挑的是小文件；W2 剩余量在
`ui-status/ui.tsx`（618）、`browser/index.ts`（495）、`subagent/index.ts`（439）、`remote/index.ts`（429）、
`self-improve/index.ts`（414）、`hooks/index.ts`（342）、`lsp/client.ts`（277）、`tools-default/bash.ts`（262）、
`session-core/hooks.ts`（258）、`config-core/market.ts`（257）这些装配/长尾文件，下一批按此顺序推进。

### 1.4 W2 中点（2026-11-16，第二批 12 个 spec / 165 条）

第二批专挑「有缝可注入」的装配层与纯文件层：真子进程、假 socket、假 fetch、假 ctx、
临时 HOME，把每条链路的行为钉住，而不是只调一遍不断言。

| spec | 条数 | 钉住的行为 |
| --- | ---: | --- |
| `session-core/tests/hooks.spec.ts` | 34 | 配置读写坏条目/上限/缓存、规则匹配与正则退化、批准名单四态、三套脚本结论写法、fail-closed 各分支、真子进程（stdin/超时/打断/截断） |
| `tools-default/tests/bash-jobs.spec.ts` | 15 | JobTable 真作业生命周期与游标（output 推进 / peek 不推）、TerminalTable 真会话读写、工具面文案、shellPlan 五档 |
| `config-core/tests/market-browse.spec.ts` | 8 | 四类源取数（ClawHub/skills.sh/索引/GitHub trees+raw）、缓存命中/refresh/写坏重拉、403 提示 token |
| `lsp/tests/client.spec.ts` + `manager.spec.ts` | 18 | 假 LSP 服务器往返：握手/四查询/推拉诊断/编码拒绝/超时/退出/反向请求；池化、串行、破键、idle 回收 |
| `self-improve/tests/skill-write.spec.ts` | 20 | 校验/渲染/安检/建改附/归档/read-before-write/使用台账/老化整理 |
| `cdp/tests/launch.spec.ts` + `transport.spec.ts` + `actions-flow.spec.ts` | 37 | 浏览器探测与端点等待、CDP 命令/事件/session 路由/断线、ref 复核与点击输入求值上传 |
| `ui-boot/ui/boot.spec.ts` + `ui-primitives/ui/completion-sound.spec.ts` | 14 | 启动图/批次规范化/工厂物化与 rev 缓存/样式认领；14 种提示音的信号链 |
| `ui-skills/ui/ui.spec.tsx` + `ui-plugins/ui/ui.spec.tsx` | 15 | 技能页分组/筛选/启停/市场安装/源编辑；插件页分组展开/详情/信任确认/组合包启停/读失败 |

实测：**25,824 / 46,646 = 55.36%**（W2 首轮 24,053 / 51.56，+1,771 行 / +3.80 点）；
branches 45.80 / functions 49.81 / statements 53.05；`src/core` 86.81 / 74.97 / 86.24 / 83.13。
跑法 `pnpm test:coverage`，450 文件通过 / 1 skip、5,714 用例通过 / 5 skip、exit 0；
基线抬到 55.3 / 45.8 / 49.8 / 53.0（`src/core` 86.8 / 74.9 / 86.2 / 83.1）。0% 文件从 75 降到 72。

W2 尚未吃掉的大块（都已定位，下一批继续）：`ui-status/ui.tsx`（618）、`browser/index.ts`（495）、
`subagent/index.ts`（439）、`remote/index.ts`（429）、`self-improve/index.ts`（414，skill-write 已覆盖）、
`ui-sessions/ui/ui.tsx`（408）、`approval/index.ts`（385）、`ui-composer/ui/ui.tsx`（360）、
`hooks/index.ts`（342）、`desktop-dock/index.ts`（295）、`ui-prompt/ui/ui.tsx`（238）、
`lsp/index.ts`（227）。其中界面页（ui-sessions / ui-composer / ui-prompt / ui-status）复用
「槽位登记 + RuntimeProvider + 假宿主通道」这一套（见 `ui-skills` / `ui-plugins` 两个 spec）。

**W2 中点复盘**：第二批 165 条换来 +1,771 行，单条约 10.7 行；「注入缝」是决定性因素——
LSP/CDP/作业表都有现成注入点（假 socket、假服务器、socketFactory），而 `browser`、`remote`、
`approval` 的 apply 把依赖写死在闭包里，只能靠 `vi.mock` 或假 ctx 硬撬，ROI 明显更低。
剩余界面页按同一套假通道推进；装配层留到排除台账前再评估。

### 1.5 W3 中点（2026-11-16，第三批 7 个 spec / 69 条）

界面页批量。前端高频面统一走「槽位登记收组件 + `RuntimeProvider` + 假宿主通道」；
hooks 与 MCP 用假 ctx / 真 node 子进程补装配面与协议面。

| spec | 条数 | 钉住的行为 |
| --- | ---: | --- |
| `ui-skills/ui/ui.spec.tsx` + `ui-plugins/ui/ui.spec.tsx` | 15 | 技能页分组/筛选/启停/市场安装/源编辑；插件页分组展开/详情/信任确认/组合包启停/读失败（§1.4 已列，提交晚于 W2 实测，实际计入本轮） |
| `ui-sessions/ui/sidebar-actions.spec.tsx` | 9 | 新建/打开/跳页、搜索与 Esc、视图菜单偏好、Ctrl+Alt+R 改名、Ctrl+Shift+A 归档、空态与刷新故障 |
| `ui-prompt/ui/prompt-cards.spec.tsx` | 13 | 审批卡三档范围/硬线/快捷键 y/s/a/n/Esc/打字目标守卫/失败/差异；计划批准与驳回；问答单条/批量/跳过/失败；空态；CardBoundary 隔离 |
| `ui-status/ui/ui.spec.tsx` | 4 | 壳层锚点与假 ResizeObserver、团队板空态、胶囊自动模式、目标/待办/计划展开、模式菜单写偏好、分区折叠、无数据不出胶囊 |
| `ui-composer/ui/composer.spec.tsx` | 6 | 空输入禁发、按钮与回车发送、Shift+Enter 换行、`/` 命令派发、失败保留正文、审批锁、运行中停止 |
| `packages/hooks/tests/wiring.spec.ts` | 10 | 守卫链两档与观察者两档、deny 落审计、ask 叫审批卡、脚本 exit 2、post-tool 异步审计、设置读写与动作、`/hooks`、投影与服务 |
| `packages/mcp/tests/connection.spec.ts` | 12 | stdio 握手与版本校验、工具翻页与坏项丢弃、调用/资源/提示模板归并、JSON-RPC 错误、elicitation 双向、能力缺省、超时 |

实测：**27,449 / 46,646 = 58.84%**（W2 中点 25,824 / 55.36，+1,625 行 / +3.48 点）；
branches 49.03 / functions 54.12 / statements 56.29；`src/core` 86.88 / 75.01 / 86.36 / 83.19。
跑法 `pnpm test:coverage`，459 文件（458 通过 / 1 skip）、5,788 用例（5,783 通过 / 5 skip）、exit 0；
基线抬到 58.8 / 49.0 / 54.1 / 56.2（`src/core` 86.8 / 75.0 / 86.3 / 83.1）。
0% 文件从 72 降到 31（3,847 → 1,660 行）——上一批的点状小文件基本清空，剩下的是整包未碰的大件。

同批另写了 `lsp/tests/wiring.spec.ts`（8 条，装配面），提交晚于本次实测，不计入 58.84。

**W3 中点复盘**：69 条换来 +1,625 行，单条约 23.6 行，是 W2（10.7）的两倍多——界面页一次渲染
能把组件的分支成片点亮。但距 W3 目标（~4,600 行）仍差约 3,000 行，且最大几块（`browser` 495、
`subagent` 439、`remote` 429）依赖写死在 apply 闭包里，需要 `vi.mock` 或注入缝。下一批按缺口排序：
`browser`、`subagent`、`remote`、`self-improve/index`（414，纯文件面已备好）、`approval`（385）、
`ui-sessions` 剩余（359）、`ui-status` 剩余（299）、`desktop-dock`（295）。

## 2 口径已定案（D40/B47）

2026-11-16 实测：全五 project 跑法 lines 45.56 / branches 37.07 / functions 41.81 / statements 43.52，
`src/core` lines 68.07，全部通过旧阈值。三面口径只有 33.8%、core 34.2，四项全红——旧基线注释里的
「三面口径」是错的，数值实际来自全五跑法。现已：

1. `test:coverage` 显式列出五个 project，不再依赖默认值；
2. `coverage-baseline.json` 按本次实测值重录（lines 45.5 / branches 37.0 / functions 41.8 / statements 43.5；
   src/core 68.0 / 57.7 / 68.3 / 64.7），阈值再减 0.5 作噪声余量；
3. 90% 判据：**lines ≥ 90** 硬线；branches / functions / statements ≥ 80 且只升不降。
   逐目录门每批抬一次，防止大文件补贴小文件。

## 3 六批推进（每批约 +10 个全局百分点）

每一批的退出条件相同：新增覆盖 ≥ 4,600 行、全局 lines 至少 +8 个点、该批涉及的目录门已抬、
新增 spec 都做过反向验证（改产品 → 红 → 还原 → 绿）。

| 批 | 主攻 | 预计新覆盖 | 落点 |
| --- | --- | ---: | --- |
| **W1 core + sandbox** | core 剩余（loader / plugin-watch / ui-bundles / schedule / session）、`sandbox`（含 `win/runner-entry` 子进程） | ~4,770 | unit + integration；**已收口（D42）：+2,500 行，45.56→50.90%，core 86.75%**；runner-entry 与 sandbox 真后端分支挪 W6 |
| **W2 外部面与工具** | `superagent`、`ui-composer`、`lsp`、`hooks`、`config-core`、`tools-default` | ~4,660 | unit + integration + ui（0% 文件优先） |
| **W3 前端高频面** | `ui-primitives`、`self-improve`、`ui-status`、`ui-settings`、`ui-boot`、`ui-superagent`、`ui-sessions`、`ui-core` | ~4,600 | ui（jsdom + RTL） |
| **W4 会话与浏览器面** | `ui-transcript`、`cdp`、`remote`、`browser`、`subagent`、`approval`、`computer-use`、`session-core`、`mcp`、`ui-dockkit` | ~4,600 | ui + integration + 子进程 |
| **W5 长尾 UI 与宿主** | `desktop-dock`、`ui-trace`、`dock-browser`、`tool-search`、`memory`、`ui-layout`、`ui-team`、`ui-palette`、`ui-terminal` 等 | ~4,600 | ui + integration |
| **W6 剩余与排除台账** | 剩余零散包；确属不可测的写排除理由并逐条反向验证替代覆盖 | ~4,500 | 混合；只允许「带理由的排除」补差 |

**W6 之后的硬判据**：`coverage-summary.json` 的 total lines ≥ 90.0，且没有新的 0% 文件（除排除台账里的）。

## 4 不允许的做法（防止把 90% 变成数字游戏）

1. 不写「调用一次、不断言」的凑数测试。每条至少钉一个可证伪的行为（返回值、落盘、请求体、DOM、退出码）。
2. 不靠 `/* v8 ignore */` 刷数。确要排除（平台专属、子进程入口、生成物）必须在
   `docs/testing-coverage-exclusions.md` 写「文件 + 理由 + 替代验证」，并像 DSH 一样**每条 ignore 带理由**。
3. 不把 integration/tui 的覆盖算进「三面」再报一个更好看的数。口径只有一套，写进 `coverage-baseline.json` 的 note。
4. 每批结束先跑 `pnpm test`（unit/ui/tui）与对应层的定向用例，再跑覆盖率；
   覆盖率红了先修测试，不许先降门槛。

## 5 与剩余非覆盖率任务的关系

顺序按「先把除覆盖率以外的任务做完」：

1. 本轮审计已修：B40（e2e 6 红归零）、`collapse-prefs` 全量钩子超时。
2. 待做（非覆盖率）：CI 接 e2e / snapshot / coverage；会话回放录制；C3 PTY；B31/B32 产物层；
   B37-R CSS→真 Chromium；文档漂移订正。见 [testing-backlog.md](testing-backlog.md) 第五节。
3. 以上闭环后启动 W1；每批单独提交、单独抬基线。
