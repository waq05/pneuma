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

### 1.6 W4–W8 大批次（2026-11-16，24 个 spec 批次 / 952 条）

这一轮把「装配层 + 长尾 UI + 小包」一次铺开，八条线并行、逐批验收（定向跑 → 产品 diff 为空 → 反验证
记录 → 单独提交）。覆盖的主面：

| 批次 | 条数 | 主攻 |
| --- | ---: | --- |
| approval + runtime | 43 | 自动裁决全分支、人工卡/升权、AI 复核；runtime 服务契约与插件中心 |
| self-improve + tool-search | 46 | skill_write/learning/命令/回合事件；三维桥接与检索/转调 |
| remote + desktop-dock + dock-browser | 64 | 真 HTTP/WS 配对取票、真 git 状态/分支/diff、CDP dock 动作与敏感闸门 |
| subagent + memory | 48 | 派活/回收/传话/审查；记忆读写/去重/复盘/`/memory` |
| ui-settings + ui-superagent | 75 | 模型页增删改与连接测试；超级代理六页与设置 |
| checkpoint + hmr + css + home-paths | 41 | 回合快照/还原命令、HMR 对账、CSS 颜色归一、dsh 家目录映射 |
| ui-sessions + ui-status | 54 | 分组/右键菜单/工作区/拖拽；摘要链/折叠桶/任务板/输出页签 |
| ui-boot + ui-composer | 40 | `createBootSession` 队列/失败重试；模型、附件、命令面板、插话 |
| browser | 47 | 地址闸门、ref 复核、对话框、iframe、下载、设置 |
| superagent + settings + mcp | 41 | 编排库/体检/`/sa`；内置分区与更新；能力工具/重连/schema 撤挂 |
| computer-use + sandbox token | 44 | 脚本生成与 PowerShell 生命周期；SID/ACE/限制令牌 |
| ui-files + palette + terminal | 29 | 变更面板/文件树；命令面板；终端 dock |
| ui-preview + renderer + layout + actions + tasks | 31 | 五个零覆盖小页 |
| sandbox + Windows setup | 50 | 后端降级/守卫/`/sandbox`；防火墙脚本与提权安装 |
| approval-floor + session-search | 44 | 命令结构/熔断/白名单；索引落盘/增量/切词 |
| tui App | 36 | 三卡键盘、全局键、浮层、会话选择器 |
| bash + plugin-cli | 49 | 真跑短命令/超时/截断/后台；add/remove/list/builds |
| ui-core + ui-team | 29 | 槽位表全语义；团队页/阅读器/发话 |
| ui-plugins + ui-prompt | 30 | 外部卡/信任/配置；提示卡归属/快捷键/多题向导 |
| ui-dockkit + ui-trace | 25 | 停靠/拖拽/分屏；轨迹轮次/搜索/检查器 |
| hooks + config-core + lsp | 27 | 脚本信任/外部钩子；预设 CRUD；诊断归属/退出 |
| ui-layout | 29 | 九槽骨架/页签/侧栏/手机档/诊断 |
| ui-settings 主界面 + ui-boot main | 22 | 分区路由/保存回执；五种启动诊断 |

实测：**36,043 / 46,646 = 77.26%**（W3 中点 27,449 / 58.84，+8,594 行 / +18.42 点）；
branches 65.52 / functions 73.73 / statements 74.19；`src/core` 88.15 / 76.32 / 88.62 / 84.49。
跑法 `pnpm test:coverage`，511 文件（510 通过 / 1 skip）、6,740 用例（6,735 通过 / 5 skip）、exit 0；
基线抬到 77.2 / 65.5 / 73.7 / 74.1（`src/core` 88.1 / 76.3 / 88.6 / 84.4）。
0% 文件从 31 降到 7（101 行），只剩 `superagent/core/replies.ts`、`superagent/adapters/store-read.ts`、
`dsh-compat/credentials.ts` 等点状小件。

同批还清了 **232 个 spec 类型错误**（CI 的 `verify.yml` 会跑 `typecheck:spec`）：根因多是假对象
`satisfies` 不完整、`MaybePromise` 未 await、交叉类型把参数推成 `never`；统一用真实契约类型与
窄化修正，零 `@ts-ignore`，测试条数不变。全量跑同时暴露两处测试基建脆弱点并修复：重模块
`beforeAll` 的 5s 钩子超时、Windows 子进程占目录导致 `rmSync` EPERM（`42334d93` 与 lsp manager 修复）。

**W4–W8 复盘**：界面页单条收益仍最高（20–30 行），装配层 `vi.mock` 一次能点亮整条工具链；
近零覆盖的小插件包（goal/agent/ptc/llm/presets 等）是下一批最便宜的增量。距 90% 还差 5,939 行，
下一波按包缺口榜切分：superagent 1,106、sandbox 824、ui-transcript 720、ui-composer 483、
ui-primitives 434、computer-use 344、ui-settings 313、tools-default 251，以及一批 1k 行内的近零小包。

**本轮发现的产品问题**（各批提交正文有 `file:line`，均未修）：最重要三条是
`ui-terminal/ui/ui.tsx:228` 的 spawn effect 依赖每次新建的 native，启动失败会无限重试；
`tui/app/App.tsx:1257` 的 hardline 审批卡键盘仍可放行（与 `ApprovalCard.tsx:157` 矛盾）；
`ui-settings/ui/models.tsx:230` 的重复模型 id 校验漏了 `seen.add`，永远不触发。

### 1.7 W9（2026-11-16，8 条线 / 321 条）

W9 按 W4–W8 的包级缺口榜切分，八条线并行；重点从「大页面」转向「近零小包 + 残部分支」。

| 线 | 条数 | 主攻 |
| --- | ---: | --- |
| superagent 残部 | 35 | replies 确认/结果/问答、store-read 游标与坏行、health 两库体检 |
| goal/agent/ptc/llm/presets | 36 | 五个近零包的工具/命令/设置/回合投影（原先 1.5–21% 行覆盖） |
| plugin-manager/permission-presets/ask/prompt/session | 55 | 插件启停/安装、预设切换、问答卡与超时、提示段与预算、会话生命周期 |
| ops/doctor/commands/host-stdio/ui-runtime | 51 | worker 与 render、五类体检、斜杠命令、宿主桥、runtime 通道 |
| ui-transcript | 30 | 检索/读取/待办/重试/附件/编辑/子代理/改动卡/刻度条 |
| ui-composer + ui-settings | 52 | 排队条/通知条/模型菜单/@ 提及；模式/归档/用量/手机连接 |
| ui-primitives + ui-ask + ui-sessions | 39 | 时间路径/Toast/Confirm/Select/Diff/Code/markdown；问答流；列表菜单 |
| sandbox + computer-use | 43 | doctor 六项、装配 fail-closed、桌面控制闸门与审计 |

实测：**38,888 / 46,646 = 83.36%**（W4–W8 36,043 / 77.26，+2,845 行 / +6.10 点）；
statements 80.19 / functions 81.39 **已过 80 门**；branches 71.10 仍是短板；
`src/core` 88.91 / 77.01 / 89.88 / 85.33。536 文件（535 过 / 1 skip）、7,081 用例（7,076 过 / 5 skip）、exit 0；
基线抬到 83.3 / 71.1 / 81.3 / 80.1（`src/core` 88.9 / 77.0 / 89.8 / 85.3）。0% 文件 7 → 4（19 行）。

**W9 复盘与分支债**：距 90% 还差 3,094 行，但 branches 差 8.9 点（约 3,594 个分支）才是真正的难点；
行覆盖高的文件里仍藏着大量未走条件。分支缺口榜前几名：`computer-use/desktop-control.ts` 317、
`ui-status/ui.tsx` 231、`superagent/core/tickets.ts` 198（行仅 34.65%）、`core/plugin-loader.ts` 189、
`ui-sessions/ui.tsx` 172、`approval/index.ts` 157、`sandbox/win/runner-entry.ts` 157、
`subagent/index.ts` 152、`ui-dockkit/dock-model.ts` 152。下一波按「行缺口 + 分支缺口」双榜切分，
每条线都要求补错误路径/默认值/坏输入分支，不能只铺主路径。
`runner-entry.ts` 已确认不可黑盒测（顶层无条件 `main()`、真 Windows 令牌/CreateProcessAsUserW/ConPTY、
宿主只探测 lib 产物），进入排除台账候选。

### 1.8 W10 + W11 收口（2026-11-16 深夜–17 凌晨，15 批测试 / 1,080 条）：硬门通过

W10/W11 按 W9 定下的「行缺口 + 分支缺口」双榜切分，15 批并行子代理（提交 ef9612e7…00abc11a）。

| 波 | 批数 | 条数 | 主攻 |
| --- | ---: | ---: | --- |
| **W10**（8 批） | 8 | 506 | computer-use+ui-primitives 70、sandbox ACL 60、ui-transcript viewport/intended-diff 39、ui-status/sessions/dockkit/trace 70、core/session-core/dsh-compat 长尾 84、tools-default/skills/todo/compact 42、cdp/self-improve/approval/remote/config-core 48、superagent tickets/evals/model+adapters 93 |
| **W11**（7 条线） | 7 | 574 | ui-transcript fold-motion 35、remote/subagent/mcp/commands/memory/hooks 54、sandbox backend 112、ui-status/sessions/skills/slots/statusbar/preview 69、superagent 分配/飞书循环 81、primitives/composer/settings/browser/bash/cdp 137、lsp/dsh-compat/cli/checkpoint/desktop-dock/approval/self-improve 86 |

实测（第八次全量，2026-11-17，exit 0）：**42,960 / 46,646 = lines 92.09**；**branches 81.85**（33,056/40,384）；
functions 89.70 / statements 89.68。**四项全部过门**（lines ≥ 90、branches/functions/statements ≥ 80）；
`src/core` 92.43 / 81.56 / 93.34 / 89.26。590 文件过 / 1 skip、8,156 用例过 / 5 skip、0 失败。
相对 W9（83.36 / 71.10）**+8.73 行 / +10.75 分支**，56 个 spec 文件、+28,829 行测试代码；
0% 文件 4 → 2（`ui-layout` 两个各 1 行的纯重导出）。基线抬到 92.0 / 81.8 / 89.7 / 89.6
（`src/core` 92.4 / 81.5 / 93.3 / 89.2）。**不需要排除台账**：runner-entry.ts 保持为已论证的债，不排除。

**阶段内测试基建修复**：`9d0e117e` manager 收尾钩子显式 15s（unit 项目内联 `hookTimeout: 5_000`
优先于 CLI 旗标，vitest.config.ts:160）；`83fafd4d` 快照 05 钉死页面时钟——热力图网格按「今天」回溯
（heatmap.ts:92-106），`usage.heat.cells`/`dom.elements` 跨午夜每天 +1 必红，驱动新增
`DSC_DOM_BOOT_SCRIPT`（`addScriptToEvaluateOnNewDocument` + reload）让场景把页面 `Date` 钉死，
种子同锚固定，计数守卫保留原值。

**复盘（偏离与教训）**：

1. **第六次全量作废（45 红）**：W11-F 子代理的反验证 `git checkout --` 在 build 之后刷新了产品文件
   mtime，防假绿守卫（tests/harness.ts:990）拦下全部 bootKernel 集成用例。教训：**阶段收尾的全量
   必须等所有子代理停笔并核对 `find src -newermt <build 时刻>` 为空再跑**，只等文件内容稳定不够。
2. **第七次全量 1 红**：快照 05 跨午夜暴露 golden 日期依赖——之前所有全量都发生在 11-16 当天，
   日期敏感计数从未被测过。修法见 83fafd4d；这条说明「快照类 golden 要审一遍时间锚」，同类页面
   （归档、终端界面）本次核对无日期依赖。
3. **子代理在 Coordinator 提交后仍在增量写盘**：00f2e611 提交的是 W11-F 中间态，终态经其报告
   补交（083c8d14 + 00abc11a）。派活时给子代理的验收命令应含「提交前自查 spec 文件 mtime 停止变化」。

**剩余债（有意不补，带理由）**：`approval/index.ts` 深层决策 ~33 行（需完整内核 harness）；
`resolve-hook` resolve 回调 ~86 行（Vitest 下动态 import 不走 `module.registerHooks`，只钉护栏）；
`ui-layout` 2 个 1 行 0% 文件（纯重导出）。runner-entry.ts（271 行 / 157 分支）维持 §1.7 论证，
integration 层 `win-token.int.spec.ts` 已覆盖真实令牌路径。

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

## 6 2026-11-20 W12 补测：superagent 新树与 UI

**告警**：11/20 凌晨夜跑（run 44645459805）覆盖率门红，lines 82.03% 对阈值 91.5%。原因不是代码变坏，是口径漂移：`coverage-baseline.json` 的 92.09% 是 2026-11-17 01:02 的实测值，此后 `dev` 又合进来 163 个源文件、21,622 行原始代码（`src/packages/superagent` 103 文件 11,832 行最大，其次是 `subagent` 1,711、`ui-superagent` 975、`web-fetch` 784）。这批新树的测试多半是 `node:test` 的 `*.test.mjs`（由 `check:plugin` 跑）与探针，vitest 的 v8 覆盖率量不到它们。

**补测**：按未覆盖行数把 586 个文件切成 8 块，8 个子代理并行补 `*.spec.ts(x)`（只新增测试，产品代码一行未改），新增 100+ 个 spec、约 1,250 条用例。实测（`pnpm run test:coverage:run`，Windows 本机）：

| 指标 | 补测前 | 补测后 | 阈值（基线 − 0.5） |
| --- | --- | --- | --- |
| lines | 82.37% | **93.86%** | 91.5 |
| branches | 70.59% | **83.45%** | 81.3 |
| functions | 75.21% | **91.00%** | 89.2 |
| statements | 78.95% | **91.42%** | 89.1 |
| `src/core/**` lines | 92.43% | **95.06%** | 91.9 |

阈值一条没动：原基线现在四项全过，所以 `coverage-baseline.json` 保持 11/17 的值（抬基线按政策要单独复核，留到下一轮）。基线口径仍是「全五 project」。

**剩余缺口（下一批，登记到 [testing-backlog.md](testing-backlog.md) B60）**：`superagent/subagent/index.ts` 的队友生成/复活/名册序列化分支约 150 行；`ui-settings` / `ui-plugins` / `ui-skills` / `ui-transcript` 几个超大组件约 500 行；`remote` / `tools-default/bash` / `lsp` 需要真子进程或真协议对端约 180 行；`sandbox/win/**` 只有 Windows 能量到，CI（Ubuntu）天然不计。

**同一夜跑里另外两处红灯，同批修掉**：
- probe job：`readme-test` 的 H2 期望清单漏了 0.9.2 新增的「界面」；`settings-embed-slot-test` 把 ✓/✗ 条数写死 3（Linux 只认 2 个 shell）；`superagent-candidate-e2e` 要读 `lib/ui/plugins`，而 CI 把它排在内核自检之前跑（顺序已调）。
- `check:plugin`：依赖方向判据把 spec 里的跨包 import 也判红（16 条假红；判据改为只管发布代码，见 development.md 包依赖方向门禁）；`plugin-inventory` 快照还停在 `^0.9.1`，按 0.9.2 重录。

### W13（2026-11-20 同日第二轮）

第一轮后仍有约 1,700 行缺口，按文件切成 5 块再补一轮（只新增测试）：superagent 剩余（`subagent/index.ts` 队友生成/名册、`app/sessions` 真回合闭包）、ui 大组件（`ui-settings`/`ui-plugins`/`ui-skills`/`ui-ask`/`model-controls` 等）、需要真对端的 sys 两批（`remote`/`skills`/`memory`/`self-improve/ledger`/`dock-browser` 与 `core` 的 git-info/ui-events/ui-server/ui-bundles/os-lock/`bash.ts`）、零散小组件。

实测（全五 project，Windows 本机）：lines **95.65%**、branches **85.07%**、functions **93.07%**、statements **93.18%**，`src/core/**` lines **96.78%**——原基线阈值仍全部通过。`src/packages/sandbox/win/**`（271 行）不补：只有 Windows 能量到，CI 跑 Ubuntu 天然不计。

本地全量跑仍有 5 条既有 flake（`lsp` 真子进程超时 4 条 + `tests/harness.int.spec.ts` runCli 1 条），单跑全绿，与新增测试无关；CI Ubuntu 上同一批用例一直是绿的。
