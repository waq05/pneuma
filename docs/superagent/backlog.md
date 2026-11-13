# superagent 补齐清单

> **这份文件记什么**：上游 dsh-superagent 有、当前 DSC 版没有的能力；当前代码自己在文件头或 README 里
> 声明的限制；还没验证过的项。
>
> **不记什么**：设计文档 §1.2 与 §11.4 明确不做的（个人微信、多仓库、多用户、权限分级、QQ/企微）。
> 那些是决定，不是缺口。
>
> **怎么用**：每项一个编号，做完就把「状态」改成 `已补` 并写 commit 短哈希。编号不复用、不重排——
> 别处的注释可能已经引用了它。

## 0 速览

| 组 | 项数 | 一句话 |
| --- | --- | --- |
| 1 领域能力 | 8 | 编排器、副作用队列、执行器的后台任务与准备命令、报告语义 |
| 2 通道与来源 | 5 | GitHub 两处上下文、飞书发现、lark-cli 打包、真账号验收 |
| 3 界面 | 6 | 停用复位、转录刷新、空字段、概览与来源页 |
| 4 运维与验证 | 4 | 安装向导、机器校验、构建门禁、崩溃恢复的边角 |
| 5 故意丢弃 | — | 列在这里是为了让后人别当漏项捡回来 |

---

## 1 领域能力

### G1 常驻主会话编排器

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | 常驻主会话当编排器，`MasterAssessor` 把候选卡片投给它，它调工具判定（`app/assessment.ts:104`）；`prompts/orchestrator.md` 定义它的角色 |
| 当前怎么样 | 没有主会话。P0 用同步规则（`adapters/assessor.ts`），P2 用一次性问答（`adapters/assessor-model.ts`） |
| 补的话动哪 | 需要一个新的「常驻会话」概念，DSC 目前没有；或把卡片做成界面上的「待确认」条目，人点一下调 `superagentPublish` |
| 验收 | 一条 `inferred` 强度的候选，能在界面上看到卡片、点确认后建成工单 |
| 状态 | **不做（架构不兼容）**，理由见下 |
| 值得补吗 | **不建议**。上游的主会话是「常驻编排会话」，DSC 没有这个概念；做等价物只有两条路，都错位：<br>① 借用用户会话——每来一条候选就往用户正在聊的会话里插一张卡片，还要注册 `orchestrator_eval*` 三个全局工具，所有会话都能看到；<br>② 新建隐藏会话——要一个常驻模型会话加工具可见性隔离，等于新造一套架构，不是移植。<br>当前「同步规则 + 可选一次性问答」已经覆盖了 P0 的明确请求与 P2 的推断判定；缺的只是「人在卡片上点确认」这一步，那一步可以等界面有「待确认」列表时用 `superagentPublish` 补，不必先造主会话。 |

### G2 持久化 effect 队列

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | `effect` 表 + 6 种 kind（`assessment` / `launch` / `delivery` / `relay` / `notice` / `reply`），写事务里入队、提交后调度，带并发上限、指数退避、健康上报（`app/effects.ts`） |
| 当前怎么样 | `effect` 表建了但**一次不读写**（`adapters/store.ts:56`）。派工走执行器内存队列，通知直接写 `outbox`，2 秒泵推进 |
| 缺的后果 | 进程崩在「已入队、还没派工」那一刻，这批活丢；上游不会丢 |
| 补的话动哪 | `adapters/` 加 `effects.ts`，`Engine` 侧改成入队；`runtime.pump()` 改成 `effects.drain()` |
| 验收 | 派工前硬杀宿主，重启后那张工单仍在队列里并被执行，`git log` 有提交 |
| 状态 | 未补 |
| 值得补吗 | **建议补**。这是与上游最大的架构差异，也是崩溃丢活的根因。但改动面大（引擎写事务与调度器的边界），要单独一轮做 |

### G3 执行器的后台任务（回合结束后继续跑）

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | worker 回合结束后，后台任务最多再跑 30 分钟（`BACKGROUND_LIMIT_MS`），跑完再报 `waiting`；关闭时等 10 秒（`SHUTDOWN_STOP_MS`） |
| 当前怎么样 | 没有。`turn/end` 一到就记 `ready`，worker 结束 |
| 缺的后果 | 长任务（跑一整轮测试、装依赖）不能跨回合续跑；要么一轮跑完，要么超时被取消 |
| 补的话动哪 | `adapters/executor.ts` 的 `launch()`：接 `MiniAgent` 的后台任务事件；`stop()` 加等待窗口 |
| 验收 | 一张单在 worker 回合结束后仍有子进程在跑，且工单阶段显示「空闲」而不是「已完成」 |
| 状态 | 未补 |
| 值得补吗 | **按需**。取决于 DSC 的 `MiniAgent` 是否暴露后台任务；不暴露就只能等内核先支持 |

### G4 执行器的 prepare 命令（工作区准备）

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | 每张工单派工前跑一段 prepare 命令（装依赖之类），10 分钟超时（`PREPARE_TIMEOUT_MS`），失败即判 `failed` 不自动重试 |
| 当前怎么样 | 没有。`ensureWorktree` 建完树直接开跑 |
| 缺的后果 | 需要 `pnpm install` 才能跑测试的仓库，worker 第一步就得自己装，装不完就超时 |
| 补的话动哪 | `adapters/worktree.ts` 建树之后、`executor.launch()` 之前加一步；设置里加 `prepareCommand` 字段 |
| 验收 | 设一条 `echo prepared > .prepared`，派工后工作树里有这个文件 |
| 状态 | **已补**：设置项 `prepareCommand` + 建树后执行（10 分钟超时，失败判 failed 不重试，准备阶段可停） |
| 值得补吗 | **建议补**。成本低（一个设置字段 + 一次 `spawnSync`），收益是省掉 worker 的安装时间 |

### G5 执行器的网络抖动重试

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | `transient()` 识别 `ECONNRESET` / `429` / `5xx` 等，重试 3 次、15 秒退避（`TRANSIENT_TRIES` / `TRANSIENT_BACKOFF_MS`） |
| 当前怎么样 | 没有。`turn/end` 带 error 就直接记 `failed` |
| 缺的后果 | 模型端点抖一下，工单直接失败，要人 `/sa retry` |
| 补的话动哪 | `adapters/executor.ts` 的回合错误处理；错误分类可以直接搬上游的 `PASSING` 正则 |
| 验收 | 假模型端点前两次返回 500、第三次正常，工单最终 `ready` |
| 状态 | **已补**：`transient()` 判据 + 回合内重试（3 次，15/30/60 秒退避，同一会话继续） |
| 值得补吗 | **建议补**。用户能感觉到的失败率，成本只有几十行 |

### G6 执行器的子智能体

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | worker 可以起子智能体并行干活，`stopSubagents` 统一收 |
| 当前怎么样 | 没有。worker 只有自己的工具 |
| 缺的后果 | 大任务不能拆并行；只能串行做 |
| 补的话动哪 | 依赖 DSC 内核是否提供子智能体能力（`src/packages/subagent` 的宿主服务）；本包只能接 |
| 验收 | 一张单里 worker 起两个子任务并行跑，报告里能看到两个的结果 |
| 状态 | 未补 |
| 值得补吗 | **不建议单独做**。等内核的子智能体接口稳定再接 |

### G7 报告语义补齐（`blocked` / `waiting` / `progress` / `dropped`）

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | 执行器能产出 `waiting`（回合结束但后台还在跑）、`blocked`（提问等人）；core 的 `ReportState` 六种全用上 |
| 当前怎么样 | core 定义六种（`core/model.ts` 的 `ReportState`），执行器只产 `ready` / `failed`（`adapters/executor.ts:213` / `:219` / `:617`） |
| 缺的后果 | worker 在正文里提的问题被并进摘要、工单按 `ready` 收尾；要让人回话只能等超时转 `failed` |
| 补的话动哪 | `adapters/executor.ts` 的 `buildReport`：识别模型输出里的提问（需要约定格式，比如最后一段以「问题：」开头） |
| 验收 | worker 输出一段带提问的正文，工单阶段变「需要你处理」，摘要里能看到问题 |
| 状态 | **已补**：照上游做成**工具**而不是解析文本——`superagent_report`（state / summary / question），全局注册但用 `tools.project` 从主会话目录减掉；工具报的状态经 `worker.reported` 覆盖回合默认的 `ready` |
| 值得补吗 | **建议补**。这是「人机协作」的核心语义，现在等于只有「干完了 / 干挂了」两态 |

### G8 提示词外置

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | `prompts/` 15 个 md（`worker.md` / `orchestrator.md` / `handoff.md` / `team/*` 等），运行时加载 |
| 当前怎么样 | 内联在 `adapters/executor.ts:238-268` 的模板字符串里 |
| 缺的后果 | 改提示词要改代码、重新构建；用户不能按仓库调整 |
| 补的话动哪 | `src/packages/superagent/prompts/*.md` + 构建时拷进 `lib/`；`buildWorkerPrompt` 改成读文件 |
| 验收 | 改 md 文件、不重新构建，下一张工单的会话里就是新提示词 |
| 状态 | **已补**：`prompts/worker.md` + 构建脚本拷两个落点 + 运行时读文件缓存 + 内置兜底（源码树直接跑测试时产物可能还没拷） |
| 值得补吗 | **按需**。提示词还在高频调整期时，外置收益大；稳定后内联反而少一个文件依赖 |

---

## 2 通道与来源

### S1 GitHub：线程上下文（`githubThreadContext`）

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | 把 issue / PR 的对话上下文拼成评估用的上下文，给判定器看 |
| 当前怎么样 | 没搬（设计文档 §16.1 说明：DSC 没有 `ThreadContext` 端口） |
| 缺的后果 | 判定器只看单条消息，不看前后文；「这条评论是在回答上一个问题」这种语境丢了 |
| 补的话动哪 | `adapters/github/read.ts` 已有 thread 读法，缺的是把它接进判定提示词 |
| 验收 | 一条回复型评论能带着父消息一起进判定提示词 |
| 状态 | **已补**：`threadWindow` 与上游逐行同构，`runtime.threadContext()` 读窗口并渲染，判定器提示词加「上下文」一节（没有上下文时整节不出现）。硬上限 15 秒——判定器同步等它，10 页 × 30 秒会把 Eval 截止时间压穿 |
| 值得补吗 | **按需**。开了模型判定器之后才有意义 |

### S2 GitHub：订阅线程轮询（`pollThreads`）

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | 定期看「工单订阅了哪些线程」有没有新消息 |
| 当前怎么样 | 没搬（设计文档 §16.1：需要「工单清单」与「订阅了哪些线程」两个出口） |
| 缺的后果 | 工单订阅的 PR 有新评论时，工单不会收到（只有 PR 合并会经 `threadClosed` 报进来） |
| 补的话动哪 | `runtime.ts` 加一个「列订阅」的只读出口；`adapters/github/source.ts` 加 `pollThreads` |
| 验收 | 工单跟着一个 PR，PR 上有人评论，工单的会话里出现这条评论 |
| 状态 | **已补**：`runtime.subscribedThreads()` + `source.pollThreads()`，每线程独立游标、读成功才推进；首拍起点用「本拍开始」（拿不到线程创建时刻，从头读会把老对话灌成新事件） |
| 值得补吗 | **建议补**。现在「工单跟着 PR」只跟到合并，中间对话全漏 |

### S3 飞书：新群与私聊的自动发现

| 项 | 内容 |
| --- | --- |
| 上游怎么做 | 长连接收事件，新群、私聊自动进来 |
| 当前怎么样 | 轮询设置里点名的群（`feishuChats`），私聊要单独开 `feishuDirect`；秒级延迟做不到 |
| 缺的后果 | 机器人被拉进新群不响应；消息延迟最多一个轮询周期 |
| 补的话动哪 | 要么保留 `lark-cli` 的长连接能力（上游用 `lark-cli` 的事件订阅），要么加一个「群清单同步」 |
| 验收 | 新建一个群、把机器人拉进去、@ 一次，能建出工单 |
| 状态 | **已补（补收侧）**：`+chat-list` 每轮刷新群清单，开机后新出现的群并进补收；实时消息本来就走长连接（`event consume im.message.receive_v1`）。**发现不是瓶颈**——真正卡住「@ 一次建不出工单」的是 S6 |
| 值得补吗 | **按需**。取决于 `lark-cli` 是否支持长连接 |

### S6 飞书来源没进准入表（已修，发现的真 bug）

| 项 | 内容 |
| --- | --- |
| 症状 | 飞书消息收得到、工单一张也建不出来，宿主日志里只有 `not_a_member` |
| 根因 | `defaultSettings` 只登记了 `manual` 与 `github` 两个来源的 `policy.sources`，飞书从未登记；`superagentScope` 也没有飞书分支，落到 `manualScope` 后判 `source_not_connected`。核心准入闸只认 `policy.sources[source].allowed` 里的精确 id，没有通配 |
| 修法 | 按 GitHub 同构补一条链路：`adapters/settings.ts` 加 `FEISHU_SOURCE` / `FeishuAccount` / `normalizeFeishuAccount`；`adapters/scope.ts` 加飞书分支；`index.ts` 加设置项 `feishuAllowed`（逗号分隔 `open_id`）并传进 `defaultSettings` / `superagentScope` |
| 验收 | 填一个 `ou_` 开头的 open_id，飞书里 @ 机器人一次，建出工单 |
| 状态 | **已修（待真账号验收）** |
| 值得补吗 | 这不是「补」，是修 bug：修之前飞书来源整个不可用 |

### S4 `lark-cli` 的打包

| 项 | 内容 |
| --- | --- |
| 现状 | 飞书来源依赖机器上有 `lark-cli`；没有就只记一行日志、不启动，不报错、不影响其余部分 |
| 缺的后果 | 用户装了插件、配了群，但没装 CLI，症状是「飞书来源没启动：找不到 CLI」 |
| 补的话动哪 | 定它要不要进运行时依赖清单；定了之后在设置页给一条可操作的提示 |
| 验收 | 一台没装 CLI 的机器上，设置页明确说「装 lark-cli，或用 xxx 命令」 |
| 状态 | 未定（设计文档 §16.8 标为「用户决定」） |

### S5 真账号验收

| 项 | 内容 |
| --- | --- |
| 缺什么 | GitHub：仓库 + `GITHUB_TOKEN`，`@` 一次要真的产出 PR；飞书：自建应用 + 5 个 IM 权限 + 长连接订阅 |
| 当前怎么样 | 代码侧就位，离线用例 15 + 6 + 10 + 9 条跑通 |
| 为什么没做 | 只能人来操作账号 |
| 验收 | 真仓库里 `@` 机器人一次，出现一条 PR，评论回写到 issue 里 |
| 状态 | 未做（设计文档 §16.8 标为「用户决定」） |

---

## 3 界面

### U1 停用界面包时复位页面

| 项 | 内容 |
| --- | --- |
| 现状 | 正停在 Super Agent 页上停用 `ui-superagent`，主区会剩一片空白，点一条会话才能回来 |
| 原因 | 只有 `plugins` 一页有特判（`ui-sessions/ui/ui.tsx:211-214`） |
| 补的话动哪 | `ui-superagent/index.ts` 的 `apply` 里补一条「停用即 `setShellPage(null)`」 |
| 验收 | 停在 Super Agent 页、在插件中心停用它，主区回到会话页 |
| 状态 | **已补**：改成通用判据——`ui-sessions` 对**任意**整页判断「启动图里还有没有人报名」，停用即复位（原来只给 `plugins` 写了特判） |
| 值得补吗 | **建议补**。一条清理就够，属于「停用后不留副作用」的承诺 |

### U2 详情页转录自动刷新

| 项 | 内容 |
| --- | --- |
| 现状 | 执行会话时间线要手动点刷新才看得到新条目；只有工单阶段变了才自动重读整页 |
| 补的话动哪 | 详情页加一个轮询（读 `superagentPeekSession`），或让泵推一次「转录变了」 |
| 验收 | 详情页开着不动，worker 写新条目后几秒内自己出现 |
| 状态 | 未补 |
| 值得补吗 | **按需**。轮询会给宿主加读压力 |

### U3 补 `branch` / `changedFiles` 两个字段

| 项 | 内容 |
| --- | --- |
| 现状 | 契约里有这两个字段（`src/contract/runtime.ts` 的 `SuperagentTicketView`），宿主不填，界面不显示。**上游没有对应物**：上游的 `Execution` 只有 `{ name, directory, assignment }`（`src/core/model.ts`），没有 branch，也没有改动清单——这两个字段是 DSC 契约自己留的 |
| 补的话动哪 | branch：`runtime.list()` 里按 `worktreeNameOf(ticket)` 算出 `agent/<name>`（纯函数，零成本）；changedFiles：要读工作树的 git，同步读太慢，得加缓存或改异步 |
| 验收 | 详情页出现「分支：agent/xxx」；改动清单能列出文件与 +/− 行数 |
| 状态 | **不是移植缺口**。branch 可低成本补；changedFiles 属于新增功能（上游没有），要单独立项评估 |
| 值得补吗 | branch **建议补**（零成本）；changedFiles **按需**（要读 git + 缓存，收益是详情页多一行） |

### U4 概览页

| 项 | 内容 |
| --- | --- |
| 上游有 | `client/overview.tsx`：跨工单的概览（在跑几张、卡住几张、最近动态） |
| 当前怎么样 | 只有工单页三组 + 侧栏徽标数字 |
| 补的话动哪 | `ui-superagent/ui/` 加一页；数据从 `surfaces.superagent.counts` 与 `recent` 取 |
| 验收 | 打开能看到「需要你 2 / 进行中 1 / 已完成 5」与最近 5 条动态 |
| 状态 | **已补**：四页签（概览 / 发布 / 工单 / 设置），概览页是三格计数 + 最近动态 + 零工单空态。上游的四段只搬了两段：待办清单与工单页重复，问题清单 / 24h 流量 / 执行器负载在快照面没有对应字段 |
| 值得补吗 | **按需**。工单页已经能看出这三组，概览是锦上添花 |

### U5 来源页（GitHub / 飞书的连接状态与游标）

| 项 | 内容 |
| --- | --- |
| 上游有 | `client/source.tsx`：每个来源的轮询状态、上次拉取时刻、错误 |
| 当前怎么样 | 只有飞书在体检项里有一格；GitHub 的状态只在宿主日志里 |
| 补的话动哪 | 快照面加 `sources` 字段；界面加一页或一个折叠区 |
| 验收 | GitHub 令牌过期时，界面上能看到「上次成功 3 分钟前，错误：401」 |
| 状态 | **已补**：契约加 `SuperagentSourceView` / `SuperagentSurface.sources?`，概览页底部一块显示两个来源的轮询状态。文案是「上次轮询」不是「上次成功」——适配器在轮询开始时写 `lastPollAt`、失败也更新。来源状态变化不主动推快照（注释已写明） |
| 值得补吗 | **建议补**。现在来源挂了只有日志，用户查不到 |

### U6 手机档与整页范式的已知代价

| 项 | 内容 |
| --- | --- |
| 现状 | 手机档侧栏默认收起，要拉抽屉才看得见入口；56px 窄栏里不出现；整页会顶掉对话区，不能边看工单边聊 |
| 这是不是缺口 | 是范式选择（§8.5 的「整页」方案）的代价，不是漏做 |
| 补的话动哪 | 要改成侧栏抽屉或分栏，属于界面范式的重选 |
| 状态 | 不补（设计决定） |

---

## 4 运维与验证

### O1 安装向导（`setup.ts` / `SETUP.md` 的等价物）

| 项 | 内容 |
| --- | --- |
| 上游有 | `SETUP.md` + `app/setup.ts`：一条一条问用户，把 GitHub / 飞书 / 仓库路径配齐 |
| 当前怎么样 | 只有设置页的几个字段，没有引导；用户不知道「repoPath 是必填、不填发不了单」 |
| 补的话动哪 | 设置页加一段「第一次使用」引导，或 `apply` 时检测到 `repoPath` 为空就提示一次 |
| 验收 | 全新装好、打开 Super Agent 页，能看到「先填仓库路径」的可点引导 |
| 状态 | **已补（待统一验证）**：快照面在 `ready: true` 但 `repoPath` 为空时返回 `problem.code = 'repo_missing'`，界面在页签下方画一条黄底警告，不挡页面 |
| 值得补吗 | **建议补**。现在第一次用的人一定会卡在「发布后没反应」 |

### O2 机器校验（`deployment.ts` 的等价物）

| 项 | 内容 |
| --- | --- |
| 上游有 | 检查 `git` / `gh` / `tmux` / `python3` / `lark-cli` 版本，缺什么列什么 |
| 当前怎么样 | 缺依赖只在日志里说一句；`lark-cli` 缺了不报错 |
| 补的话动哪 | 体检项里加一项「依赖」：`git --version`、`lark-cli --version` 各跑一次 |
| 验收 | 体检页能看到「git 2.55 ✓ / lark-cli 未安装 ✗」 |
| 状态 | **已补（待统一验证）**：新增体检项 `superagent/dependencies`，git 与 lark-cli 各跑一次 `--version`，缺失记 `warn` 不阻塞启动 |
| 值得补吗 | **按需**。体检项已经有 orchestrator 与飞书两项，加依赖项成本低 |

### O3 构建与测试门禁

| 项 | 内容 |
| --- | --- |
| 现状 | 包内有 19 个 `tests/*.test.mjs`（`scripts/package-tests.mjs` 自动跑）+ 界面 2 个；`pnpm run build` / `check:plugin` 覆盖 |
| 缺什么 | 没有 Super Agent 专属的「全链路」门禁脚本（真模型、真 worktree 那种，现在只有 `scripts/_sa-resume-e2e.mjs`，下划线前缀不进测试电池） |
| 补的话动哪 | 把 `_sa-resume-e2e.mjs` 改造成可入电池的探针，或新增一条「发单 → 改文件 → 提交」的假模型用例 |
| 验收 | `node scripts/check-core.mjs superagent-e2e-test.mjs` exit 0 |
| 状态 | **已补（待统一构建验证）**：`scripts/superagent-e2e-test.mjs`，假模型端点 + 真宿主 / 真工具 / 真 worktree / 真 git，24 条断言。落 `check-core`（文件名以 `-test.mjs` 结尾即自动发现），**不是** `package-tests`——那闸只扫包内 `tests/`，把起宿主的用例塞进去会破坏分工 |
| 值得补吗 | **建议补**。现在「发一单真的改出东西」只有人工跑过，没有自动化回归 |

### O4 崩溃恢复的边角：出站消息那一批

| 项 | 内容 |
| --- | --- |
| 现状 | `drainOutbox` 一次取走最多 50 行，发完之前只在内存；崩在中间会丢未发的几条（设计文档 §16.5「已知代价」） |
| 补的话动哪 | 给 `outbox` 加一列 `state`（`pending` / `sending` / `sent`），取走改成标记而不是删除 |
| 验收 | 发到一半硬杀，重启后剩下的消息仍会发出 |
| 状态 | **已补**：`state` 列 + `claimOutbox` 认领 + `finishOutbox` 删行 + 开库时把残留 `sending` 改回 `pending`；迁移 v1→v2（建表语句保持 v1 形状，列只由 ALTER 加） |
| 值得补吗 | **按需**。需要一次迁移；不补的代价是「极少数消息丢失」，且不会重复发（有幂等键） |

---

## 5 故意丢弃、不建议补回来的

列在这里，是为了让后人看到「这不是漏了」：

| 上游 | 为什么不补 |
| --- | --- |
| `app/http.ts`、`app/api.ts`、`app/resources.ts` | DSH 的面板 HTTP 与部署校验；DSC 用快照面 + 白名单方法，再开一套 HTTP 就是两套权限边界 |
| `app/migration.ts` | 从旧 DSH 版本迁数据；DSC 没有旧数据 |
| `app/cache.ts`、`app/versions.ts`、`app/settings-history.ts`、`app/skill-files.ts`、`app/retry-health.ts` | 都是 DSH 面板的配套设施，没有对应入口 |
| `client/**` 26 个文件 | DSH 客户端界面；DSC 的界面壳是另一套，逐文件搬过来不能跑 |
| `prompts/team/*`、`handoff*.md` | 主会话与 worker 之间的多角色交接；当前没有主会话，这些提示词没有接收方 |
| `skills/dsh-superagent-*` | 给 DSH 的模型技能，DSC 的技能体系不同 |

---

## 附：怎么验证这份清单没写漏

1. 对照上游文件树，逐个目录问「这个文件当前有没有对应物」：
   ```sh
   Get-ChildItem -Recurse D:\code\dsh-superagent-prototype\src -File -Include *.ts
   ```
2. 对照当前包的 `Known Limitations` 段落（各文件头 + `README.md`），看有没有没进本清单的。
3. 对照 `docs/superagent-design.md` 的 §11（与上游差异）、§15（实施记录）、§16（P2 记录）。
