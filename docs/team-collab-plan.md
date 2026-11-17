# 智能体团队协作升级设计（T3）

> 状态：**已实施**（2026-11-17）。分支 `feat/agent-team-collab`（从 `dev` 拉出），
> 提交：`feat(team-board)` 任务板 v2 → `feat(subagent)` 消息/绑定/角色/提示词 → `feat(ui)` 展示。
> 验证：build exit 0、包测试 146/146（1807 断言）、check:ui 85/85。未做项见 §7。
> 需求来源：用户 2026-11-17 的三条要求——子代理能看到任务进展与队友进展；队友之间能直接交流；
> 能按真实开发团队分工（项目经理 / 架构师 / 开发者 / 测试 / 运维，不同提示词、工具、权限），
> 支持同角色多个子代理讨论、规划、并行开发同一任务并互相协调。

## 1 验收标准（做完怎么算成）

1. 任何队友（不只是 Lead）在自己的系统提示里能看到：板上全部任务、每条任务的负责人与最新进展、
   其他队友是谁/在干什么、最近一段时间发生了什么（谁认领/完成/写了什么进展）。
2. 队友之间可以互发消息（点对点 + 广播），消息落在 `~/.dsc/team/inbox/`，对方下一轮能看到；
   同时 Lead 的提示里能看到这些协作活动。
3. 内置角色扩展到一支能配合的团队：`pm`、`architect`、`developer`、`tester`、`ops`，
   外加原有 `explorer`/`writer`/`critic`/`reviewer`；每条角色带自己的提示词、工具白名单、
   审批档与默认轮次预算。
4. 任务板支持「进展记录」与「活动时间线」， teammate 与 Lead 都能追加；任务可以绑定到队友
   （spawn 时带 `task_id`，自动认领；收工成功自动结项）。
5. 界面：状态面板「共享任务」区能看到每条任务的最新进展与最近活动；队友面板能看到谁在做什么。
6. `pnpm run build`、`pnpm run check:plugin`、`pnpm run check:ui` 全绿，新增测试覆盖数据与提示词拼装。

## 2 现状盘点（已读代码，带行号）

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 任务板数据结构 | 三态 `pending/in_progress/completed` + CAS revision + 依赖 + 写作用域；无进展/活动字段 | `src/core/team-board.ts:48-78` |
| 任务板工具 | `create/list/get/claim/release/complete/reopen/set_dependencies/delete` | `src/packages/subagent/index.ts:1399-1471` |
| 板子提示段 | 只注入 Lead（`ctx.prompt.register('team', boardPromptText)`），列 id/状态/负责人 | `src/packages/subagent/index.ts:1501-1515` |
| 队友系统提示 | 角色 prompt + 环境事实 + 「你在团队里的位置」+ 工具白名单说明；**不含任务板与其他队友** | `src/packages/subagent/index.ts:742-763` |
| 队友工具表 | 角色白名单 + 协作工具放行；协作工具只有一个 `team_task` | `src/packages/subagent/index.ts:231-233、455-477` |
| 队友间交流 | 只有 Lead→队友：`subagent action=message` 写 inbox 并 followup；队友没有对等通道 | `src/packages/subagent/index.ts:1207-1227` |
| 信箱 | `~/.dsc/team/inbox/<名字>.jsonl`，只追加文本，无方向/已读概念 | `src/core/team-board.ts:327-362` |
| 名册/状态 | `roster.json` + `TeammateView`（name/role/state/task/rounds/currentTool） | `src/contract/plugin.ts:112-143` |
| 角色文件 | `~/.dsc/agents/*.md`，frontmatter 支持 tools/model/effort/max-turns/approval | `src/packages/subagent/agent-roles.ts:6-70` |
| 内置角色 | explorer / writer / critic / reviewer | `src/packages/subagent/agent-roles.ts:73-147` |
| 板子界面 | 状态面板「共享任务」区只读展示（`listTeamBoard`） | `src/packages/ui-status/ui/ui.tsx`（team 相关段） |
| 队友界面 | 名册 3 秒轮询 + 只读运行记录浮层；不能带话给别的队友 | `src/packages/ui-team/ui/ui.tsx`、README |

### 差距

1. **进展不可见**：板子只有三态，没有「做到哪一步、卡在哪」；提示词只给 Lead 一小段摘要，
   队友连板子长什么样都不知道，只能靠 Lead 在任务描述里转述。
2. **横向不通**：队友之间的所有信息都要经过 Lead（人或模型）转述，`maxDepth=1` 时连
   `subagent` 工具都没有，谈不上讨论与协调。
3. **角色单薄**：只有四个通用角色，没有项目经理/架构/测试/运维这类职责边界；
   权限只有「工具白名单 + 审批档」，没有按职责收口的默认值。

## 3 设计

### 3.1 任务板 v2：进展与活动时间线（数据面）

在 `TeamTask` 上增量加字段（老文件读档自动补默认值，不 bump version）：

```ts
interface TeamTaskNote { at: number; by: string; text: string }
interface TeamTask {
  // …原有字段…
  /** 进展记录，最多保留 20 条（新的在前，写档时截断）。 */
  notes: TeamTaskNote[]
  /** 卡住的原因；null = 没卡（不用 blocked 状态，保持三态状态机不变）。 */
  blockedReason: string | null
  /** 绑定的队友名（spawn 时带 task_id 自动填）；null = 未绑定。 */
  assignee: string | null
}
interface TeamActivity { at: number; by: string; taskId?: string; kind: 'create'|'claim'|'note'|'complete'|'release'|'message'; text: string }
interface TeamBoard {
  // …原有…
  /** 全板活动时间线，最多 200 条；队友和 Lead 都靠它看「别人刚做了什么」。 */
  activity: TeamActivity[]
}
```

- 写路径只用现有的 `boardUpdate`/`boardCreate`，继续 CAS；
- `readBoard` 对缺失字段补 `[]`/`null`，旧版本文件照常读；
- 新增 `BoardAction`：`note`（追加进展，顺带写 activity）、`block`（写 blockedReason + note）、
  `assign`（绑定队友，不改 status）。

### 3.2 工具面

1. `team_task` 增动作：
   - `note`：`{ id, text, expected_revision }` → 追加进展，返回最新版号；
   - `block` / `unblock`：写/清 blockedReason（`unblock` 同时追加一条进展）；
   - `activity`：`{ limit? }` 读最近活动（默认 20 条），供队友「看别人在干嘛」；
   - `list` 结果增加：负责人 + 最新一条进展摘要 + 队友绑定名。
2. 新工具 `team_message`（注册进 `COLLAB_TOOL_NAMES`，不受角色白名单限制）：
   - `send { to, text }`：点对点。`to` 为队友名或 `lead`；
   - `broadcast { text }`：发给同会话所有在队队友 + Lead；
   - `inbox { limit? }`：读自己最近收到的消息。
   - 投递：`inboxAppend`（带 `from` 署名）+ 目标在内存里就 `followup` 叫醒；目标不在队
     （收工/一次性）时如实说明「话写进了信箱但没人读」，与现有 `messageTeammate` 话术一致。
   - 防轰炸：每个队友每轮最多发 3 条 `team_message`（工具结果里报剩余额度），超出拒绝。
3. spawn 增加可选 `task_id`：认领该任务（未认领且 ready 才允许）；队友收工成功时若绑定任务
   仍在 `in_progress` 且负责人是自己，自动 `complete` 并追加终稿摘要进 notes。

### 3.3 提示词面

1. **队友系统提示**（`startTeammate` 的 `systemPrompt` 回调，每轮现读磁盘，天然最新）追加一段
   「团队协作」：当前队伍（名字/角色/状态/绑定任务）+ 任务板摘要（每条：id、状态、负责人、
   最新进展）+ 最近活动（10 条）+ 协作规则（认领前 list、进展用 note、问人用 team_message、
   别重复别人已做的事、写作用域重叠先协商）。
2. **Lead 板子提示段**（`boardPromptText`）扩展：同样列最新进展、最近活动、在队队友与绑定任务，
   并写清「派活时优先用 task_id 绑定」。
3. **Lead 分工协议**（写进 `subagent` 提示段）：按真实团队流程派活——PM 先确认需求与验收口径并
   拆任务上板；架构师出方案/契约；开发者按写作用域并行实现；测试独立验证；运维负责构建发布与
   环境检查；最后由 Lead 汇总并对用户交付。

### 3.4 角色体系（内置角色扩充）

| 角色 | 职责 | 工具白名单 | 审批 | 默认轮次 |
| --- | --- | --- | --- | --- |
| `pm` | 需求澄清、拆任务、盯进展、验收口径 | read, glob, grep（+team 协作工具） | forbid | 48 |
| `architect` | 方案与契约设计、技术评审 | read, glob, grep | forbid | 32 |
| `developer` | 落地实现 + 单测 | read, write, edit, glob, grep, bash | ask | 128 |
| `tester` | 独立验证、补测试、复现缺陷 | read, glob, grep, bash, write（仅测试文件约定） | ask | 64 |
| `ops` | 构建、发布、环境与运维检查 | read, bash, glob, grep | ask | 32 |
| explorer / critic / reviewer | 保持原样 | 只读 | forbid | 不限 / 16 / 64 |
| writer | 通用实现（保留兼容） | read, write, edit, glob, grep, bash | ask | 128 |

- 角色默认轮次进 T1 的 `roleTurns` 配置；角色文件仍可显式覆盖。
- PM 要能指挥人时，需要「允许层数」调到 2 且给 pm 角色白名单加 `subagent`；默认不开，
  作为「团队模式」在设置页提示（T3 一并加一个 `teamMode` 开关：打开=maxDepth 2 + 角色集
  推荐，不改 maxTeammates 的硬上限）。
- 同角色多实例：名字自动 `developer-1/2`；协作靠任务板 note 讨论 + `team_message` 广播，
  不引入额外「会议」概念（讨论记录留在板上可追溯，比易失消息可靠）。

### 3.5 界面

- 状态面板「共享任务」区：每条任务多一行「最新进展：…（谁·时间）」；底部加「最近活动」折叠区。
- 队友浮层：头部显示绑定任务 id；运行记录不变。
- 数据面仍走 `listTeamBoard` / `listTeammates`，契约只加字段（`TeamTaskView.notes/latestNote`、
  `TeammateView.taskId`）。

### 3.6 安全与边界

- 消息只写本机 `~/.dsc/team/`，不新增网络出口；单条 ≤ 8000 字沿用现有上限。
- 板子/消息都按会话隔离，`caller.sessionId` 决定归属，绝不回落「当前查看的会话」。
- 队友不能通过消息提权：审批仍走工牌 + 全局上限取更严；消息只是文本。
- 防无限互喷：每轮消息额度 + 活动时间线截断（200 条）+ notes 截断（每任务 20 条）。

## 4 实施分批

- **P0 数据与提示词**：team-board v2 字段/动作/迁移 → 队友提示注入板子快照与队伍名册 →
  Lead 提示段扩展 → spawn `task_id` 绑定与自动结项 → 单测。
- **P1 横向通道**：`team_message` 工具（send/broadcast/inbox + 额度）→ 投递与叫醒 →
  安全测试（收工目标、一次性目标、空消息、超长）。
- **P2 角色与界面**：五个新内置角色 + 团队模式开关 → 状态面板/队友浮层展示 → README/文档。

## 5 验证计划

- 单测：`src/core/team-board.ts` 的 notes/activity/CAS/迁移；subagent 包测试的提示词拼装与
  工具注册；ui-status/ui-team 的快照测试（若现有测试形态允许）。
- 集成：临时 HOME 下用 fake ctx 跑 apply，造两个队友 → 发消息 → 读 inbox/board → 断言。
- 命令：`pnpm run build`、`pnpm run check:plugin`、`pnpm run check:ui`（全部要求 exit 0）。

## 6 风险与待拍板

1. **消息会不会变成噪音**：广播只给在队队友，且活动时间线在提示里只取最近 10 条；如果实测仍吵，
   再加「静默模式」（只写板子不叫醒）。
2. **PM 指挥链**：默认 maxDepth=1 时 PM 不能派人，只能通过板子/消息协调；要不要默认团队模式
   （maxDepth=2）需要用户拍板——放开后递归风险由 `maxTeammates` 与轮次预算兜着。
3. **tester 越权写代码**：白名单给了 write 是为了补测试；靠提示词约定「只写测试文件」，
   强制执行需要新机制（按路径白名单），本版不做。

## 7 实施结果与未做项（2026-11-17）

已落地（与 §3 设计的对应关系）：

1. **任务板 v2**：TeamTask.notes（每任务 20 条）、lockedReason、ssignee；
   TeamBoard.activity（200 条，纯活动追加不动 revision）；读档兼容旧文件。
2. **工具面**：	eam_task 增加 
ote / block / unblock / assign / activity；
   新增 	eam_message（send / broadcast / inbox，每轮 3 条额度）。
3. **提示词**：队友系统提示每轮现读「队伍 + 板上任务摘要 + 最近活动 + 协作规则」；
   Lead 段补进展/活动/绑定与分工协议。
4. **任务绑定**：spawn 带 	ask_id 一并在 CAS 里认领并绑定，成功收工自动结项并写终稿摘要。
5. **角色**：新增 pm / architect / developer / tester / ops（提示词、工具白名单、审批档、
   默认轮次 48/32/128/64/32）；设置页新增「团队模式」开关（打开时 maxDepth 抬到 2）。
6. **界面**：共享任务区显示绑定队友、卡住原因、最新进展与条数，底部「最近活动」可折叠；
   子智能体行与只读运行记录头部显示绑定任务 id。

未做 / 已知限制：

- 界面只做了数据展示，没有截图走查（需要真实宿主跑一轮多队友协作才能看到有数据的版式）。
- 	eam_message 的端到端集成（真派两个队友互发、再看汉代账）没有做；单测覆盖了工具装配与提示词，
  但没跑真模型。
- PM 二层派活只在「团队模式」开关打开时可行（maxDepth 2）；默认仍是 1 层，PM 只能通过板子与消息协调。
- tester 的「只写测试文件」靠角色提示词约定，没有按路径强制的白名单机制。
- 队友→Lead 的 team_message 走现有汇报通道，不新增独立卡片；界面只在活动时间线里体现。
