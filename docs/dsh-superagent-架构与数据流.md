# dsh-superagent 架构图与数据流图

<!-- docs-check:ignore-file: 整篇描述上游原型仓库 D:\code\dsh-superagent-prototype，文中 文件:行号 都是相对那个仓库根，本仓没有这些文件，属整篇外来内容 -->

> 阅读对象：`D:\code\dsh-superagent-prototype`（研究原型，单提交）。
> 本文的图用 Mermaid 语法书写，需要支持 Mermaid 的查看器（VS Code + Markdown Preview Mermaid、Typora、GitHub、Obsidian 均可）。当前 DSH Web 面板不渲染 Mermaid。
> 文中 `文件:行号` 都是相对仓库根目录的定位。

---

## 图 1 · 部署图：谁跑在哪

一句话：**一个 DSH profile、一个进程、一个 SQLite 文件、一个独占锁**；Agent 用独立 GitHub 账号和独立飞书机器人身份对外说话。

```mermaid
flowchart TB
  subgraph PEOPLE["人"]
    P1["同事：GitHub Issue / PR 评论"]
    P2["同事：飞书群 / 私聊"]
    P3["操作员：浏览器面板"]
  end

  subgraph MACHINE["一台机器（以操作员 OS 用户运行）"]
    subgraph DSH["DSH profile: superagent（单进程）"]
      WEB["Web 服务<br/>127.0.0.1:3082"]
      PLUG["bundle: dsh-superagent<br/>主插件 + 面板 + 2 个 Source 插件"]
      MS["主 Session<br/>preset: dsh-superagent-router"]
      WS["执行器 Session<br/>preset: dsh-superagent-worker"]
    end
    subgraph STATE["stateDir（proper-lockfile 独占）"]
      DB[("orchestrator.sqlite")]
      BIN["worker-bin<br/>gh / lark-cli 包装脚本"]
      GIT["worker-gitconfig<br/>git 凭据助手"]
      WORK["work/&lt;ticket 短名&gt;/"]
    end
    AGH["Agent 的 GitHub 账号<br/>gh-agent"]
    ABOT["飞书机器人<br/>lark-bot"]
  end

  GH["github.com API"]
  FS["飞书开放平台 API"]

  P1 --> GH
  P2 --> FS
  P3 --> WEB
  WEB --> PLUG
  PLUG --> MS
  PLUG --> WS
  PLUG --> DB
  PLUG --> WORK
  AGH --> GH
  ABOT --> FS
  BIN --> AGH
  BIN --> ABOT
  GIT --> AGH
  PLUG --> BIN
```

关键落点：

- bundle 插入三个插件、两个 preset：`cordis.patch.yml:4`、`:20`、`:125`
- 状态目录加锁、开库：`src/app/runtime.ts:91-98`
- 命令包装与 git 配置由 setup 写入：`docs/006-deployment.md:222-227`
- **注意**：这些包装只是默认值，不是安全边界；worker 以 `danger-full-access` 跑，能用绝对路径绕过（`docs/006-deployment.md:19`）。

---

## 图 2 · 组件架构图：进程内的零件怎么连

一句话：`Runtime` 是组合根，`Engine` 是唯一领域写入口，所有外部动作都经**端口（ports）**入队、由适配器在事务提交后执行。

```mermaid
flowchart TB
  subgraph ENTRY["入口"]
    SRC["Source 插件<br/>github-watch / feishu-watch"]
    TOOL["Session 工具<br/>主 14 个 / 执行器 6 个"]
    HTTP["HTTP 路由<br/>/orchestrator/api"]
    PPL["面板点击<br/>stop / retry / requeue"]
  end

  subgraph APP["应用层 src/app"]
    RT["Runtime<br/>组合根 + 启停"]
    PA["Passes<br/>每 2 秒一轮"]
    EF["Effects<br/>持久副作用队列"]
    OB["Outbox<br/>出站回执"]
    SE["Sessions<br/>两角色的 Session 管理"]
    AS["MasterAssessor<br/>研判"]
    EX["DshExecutor<br/>派工 + worker slot"]
    CFG["Settings / Prompts / Setup"]
    NT["Notices<br/>事件转消息"]
    VW["views<br/>只读查询"]
  end

  subgraph CORE["领域层 src/core（无 IO、无外部依赖）"]
    EN["Engine<br/>唯一写入口，同步事务"]
    PARTS["Intake · Evals · Tickets<br/>Assignments · Replies"]
    POL["Policy<br/>gate / revalidate"]
    MDL["model + stage<br/>类型 + 阶段判定"]
  end

  subgraph INFRA["基础设施"]
    STORE[("Store → SQLite")]
    HB["HealthBoard"]
    CMD["Commands<br/>gh / lark-cli / git"]
    SREG["SourceRegistry<br/>SourceScope 实现"]
  end

  subgraph DSHAG["DSH Agent 运行时"]
    MA["主 Session"]
    WA["执行器 Session"]
  end

  SRC --> PA
  TOOL --> EN
  HTTP --> VW
  HTTP --> EN
  PPL --> EN
  PA --> EN
  RT --> PA
  RT --> EF
  RT --> SE
  EN --> PARTS
  EN --> POL
  EN --> MDL
  EN -->|Repositories| STORE
  EN -->|SourceScope| SREG
  EN -->|Assessor| AS
  EN -->|Executor| EX
  EN -->|Outbox| OB
  AS -->|enqueue assessment| EF
  EX -->|enqueue launch / delivery| EF
  SE -->|enqueue relay / notice| EF
  OB -->|enqueue reply| EF
  EF --> AS
  EF --> EX
  EF --> SE
  EF --> OB
  EF --> STORE
  SE --> MA
  SE --> WA
  AS -->|steer 卡片| MA
  EX --> WA
  WA -->|report / ack / handback| EN
  OB --> CMD
  CMD --> SRC
  HB --- RT
  HB --- EF
```

关键落点：

- 装配顺序与依赖注入：`src/app/runtime.ts:96-166`
- Engine 的 5 个内部部件与单向依赖：`src/core/engine.ts:24-38`、`docs/007-architecture.md:52-60`
- 角色接口收窄（调用者只拿到自己的 `Pick`）：`src/core/engine.ts:261-270`
- 端口定义：`src/core/ports.ts:17-83`

---

## 图 3 · 分层依赖图：谁能 import 谁

一句话：**领域层不碰世界，来源层不碰应用层，面板只拿类型**。这是全仓库最硬的纪律。

```mermaid
flowchart BT
  L1["src/core<br/>领域模型 + Engine<br/>只允许 Node 的哈希，无 IO"]
  L2["src/sources<br/>SourceKind 协议 + 两个实现<br/>不 import src/app"]
  L3["src/executor · src/infra<br/>DSH 执行器、CLI、环境、健康"]
  L4["src/app<br/>组合根、Store、Effects、Sessions、HTTP、views"]
  L5["src/client<br/>面板 React<br/>只 import 类型 + 少量纯值"]
  L6["src/policy.ts · src/admission.ts · src/limits.ts<br/>src/setup.ts · src/navigation.ts<br/>两边共用的纯值"]

  L2 --> L1
  L3 --> L1
  L4 --> L1
  L4 --> L2
  L4 --> L3
  L5 --> L6
  L6 --> L1
```

规则写在 `docs/007-architecture.md:257-259`。配套的「一个状态一个写者」表在 `:259-271`：Trigger/Thread/Ticket/Decision/Assignment 只有 Engine 写，Settings 只有 Settings 写，回执只有 Outbox 写。

---

## 图 4 · 数据流（上）：一条 Trigger 进来之后

一句话：**先过滤、再去重、然后落盘并扇出；只有「没有执行器认领」的 Trigger 才进入 Eval。**

```mermaid
flowchart TB
  A["Source 收到原始事件<br/>GitHub 轮询 / 飞书事件"] --> B{"在监听范围内？<br/>SourceScope.scope"}
  B -->|否| B1["记 filtered + 原因码<br/>不入领域"]
  B -->|是| C{"Trigger id 已存在？"}
  C -->|是| C1["返回 duplicate<br/>幂等，不重复接单"]
  C -->|否| D["落盘 Trigger<br/>写 disposition / Thread / Correlation"]
  D --> E["扇出：投给订阅该 Thread 的 Ticket<br/>作为 Input，唤醒执行器"]
  E --> F{"有执行器认领？<br/>followupOwners"}
  F -->|有，且是人发的消息| F1["到此为止<br/>由该 Ticket 的执行器自己判断"]
  F -->|无| G["入该 Thread 的 Eval 队列<br/>同 Thread 同时只跑一个"]
  G --> H["2 秒一轮的 pass<br/>Engine.evaluateDue"]
  H --> I["Eval 开始<br/>gate 判强度"]
  I --> J{"闸门结果"}
  J -->|"拒绝<br/>not_a_member / no_mention / admission_ignored"| J1["Decision = ignore<br/>带原因码落盘"]
  J -->|"explicit 明确请求"| K["卡片 steer 进主 Session<br/>直接路由"]
  J -->|"inferred 推断候选"| L["assessment effect<br/>主 Session 调 orchestrator_eval 研判"]
  K --> M["orchestrator_route<br/>accept / attach / stop / ignore"]
  L --> N["orchestrator_eval_decide<br/>逐条规则打分 + 三事实判定"]
  N --> O{"assessmentOutcome<br/>auto 模式且命中规则？"}
  O -->|否，observe 模式| O1["记 ignore，标注 would accept"]
  O -->|是| M
  M --> P["Engine.decide<br/>accept 时一次性创建：<br/>Ticket + Mandate + Subscription<br/>+ 首个 Assignment + 确认回复"]
```

关键落点：

- 过滤与去重、扇出、入队：`Intake.receive`，`src/core/intake.ts:19-62`；判断「是否还有执行器认领」在 `:58`
- 闸门：`gate()`，`src/policy.ts:191-211`；强度三档的完整表在 `docs/002-authorization.md:48-52`
- 研判转结论：`assessmentOutcome()`，`src/policy.ts:40`；`admitsInferred` 在 `:212`
- 一轮 pass：`Passes.pumpOnce`，`src/app/passes.ts:63-68`

---

## 图 5 · 数据流（下）：接单之后，结果怎么回到人

一句话：**worker 只写领域事实，主 Session 只负责把话送到原来的对话，出站统一走 Outbox 回执 + 重试。**

```mermaid
flowchart TB
  A["launch effect 触发<br/>DshExecutor"] --> B["跑 prepare 命令<br/>git worktree add 等"]
  B --> C["建 Session worker-&lt;id&gt;<br/>建目录 work/&lt;短名&gt;"]
  C --> D["投递 assignment<br/>原文 Trigger 卡片 + 执行变量"]
  D --> E["worker 干活：<br/>读仓库、改代码、跑检查"]
  E --> F["orchestrator_report progress<br/>带 pr_number"]
  F --> G["Engine.report<br/>bindThread 绑定 PR 的 Thread"]
  G --> H["GitHub Source 轮询<br/>发现 PR / CI / 评论"]
  H --> I["作为 Trigger 再进来<br/>扇出到该 Ticket = 后续 Input"]
  I --> J["delivery effect<br/>把 Input 投进 worker Session"]
  J --> K["worker 读到后回报 inputsRead<br/>下一轮继续"]

  E --> L{"报告状态"}
  L -->|progress| L1["留在 Ticket 内部<br/>不发消息给人"]
  L -->|ready| L2["Ticket 进入 等人 review"]
  L -->|blocked / failed| L3["挂起，等人处理<br/>自动输入被挡住"]
  L -->|dropped| L4["直接结束，不发消息"]
  L2 --> M["notice / relay effect<br/>steer 进主 Session"]
  M --> N["主 Session 调 orchestrator_reply<br/>purpose = result / attention"]
  N --> O["Outbox.send<br/>事务内：写回执 + 入队 reply effect"]
  O --> P["reply effect 按序发送<br/>同 Ticket 同会话排队"]
  P --> Q["Source Channel：<br/>GitHub 评论 / 飞书话题回复"]
  Q --> R["人收到一句话结果 + PR 链接"]

  G --> S["PR merged / closed<br/>Source 报 threadClosed"]
  S --> T{"followsDone？<br/>它开的 PR 全关了"}
  T -->|是| U["Ticket 结束<br/>merged / closed"]
  U --> V["pullEndNotices<br/>给 IM 会话发最后一条"]
  U --> W["保留 Subscription<br/>人再评论可原授权恢复"]
```

关键落点：

- 报告与结束判定：`Engine.report` 的注释写清了 `ready`/`dropped`/`followsDone` 三种结局，`src/core/engine.ts:230-239`
- 回执与发送原子性：`Outbox.send` 在同一个事务里写回执并入队，`src/app/outbox.ts:26-31`；「同一 Ticket 同一会话必须排队」在 `:44-45`
- 回复目的四分法：`acknowledgement` / `answer` / `result` / `attention`，`src/core/ports.ts:72`
- 结束通知：`pullEndNotices`，在 Runtime 的 `emit` 里挂接，`src/app/runtime.ts:148-152`

---

## 图 6 · 时序图：一次「@agent 改个按钮」到 PR 合并

把图 4 和图 5 压成一条时间线，标了每一步的触发源。

```mermaid
sequenceDiagram
  autonumber
  actor H as 人
  participant GH as GitHub
  participant SRC as GitHub Source
  participant PA as Passes
  participant EN as Engine
  participant MS as 主 Session
  participant EX as DshExecutor
  participant WS as 执行器 Session
  participant OB as Outbox

  H->>GH: 评论 "@agent 把保存按钮文案改成 Save"
  GH-->>SRC: 约 1 分钟后轮询到通知
  SRC->>PA: receive(trigger)
  PA->>EN: Engine.receive
  EN->>EN: 存 Trigger/Thread/Disposition，入 Eval 队列
  PA->>EN: evaluateDue()
  EN->>EN: gate 判为 explicit（名单内 + 已 @）
  EN->>MS: assessment effect，卡片 steer 进当前回合
  MS->>EN: orchestrator_route(accept, 一句确认)
  EN->>OB: 确认消息
  EN->>EX: launch effect（Ticket + Mandate + Assignment 已建）
  OB->>GH: 在原评论下回复确认
  EX->>EX: prepare 命令，建 Session 与目录
  EX->>WS: 投递 assignment（原文 + 执行变量）
  WS->>EN: orchestrator_report progress + pr_number
  EN->>EN: bindThread(PR 的 Thread)
  WS->>EN: orchestrator_report ready
  EN->>MS: relay 报告
  MS->>OB: orchestrator_reply(result)
  OB->>GH: 评论 "PR #123 可 review"
  GH-->>SRC: PR 被合并
  SRC->>EN: threadClosed(merged)
  EN->>EN: followsDone，Ticket 结束
  EN->>OB: 结束通知（仅 IM 会话需要）
```

时间尺度参考：轮询 1 分钟、pass 2 秒、出站重试从 5 秒翻倍到 300 秒（`docs/003-execution.md:177`、`docs/007-architecture.md:174-179`）。

---

## 图 7 · Ticket 状态机

一句话：**状态不是执行器上报的，而是从「最新 Assignment 的报告 + 有没有等人的东西」推导出来的**（`ticketStage`，`src/core/stage.ts:9-21`）。判定顺序从上往下，第一个命中为准。

```mermaid
stateDiagram-v2
  [*] --> Queued: accept 创建
  state "排队（working/queued）" as Queued
  state "执行中（working）" as Working
  state "空闲（idle）" as Idle
  state "等人审阅（person/review）" as Review
  state "等人回答（person/answer）" as Answer
  state "受阻（person/blocked）" as Blocked
  state "失败（person/failed）" as Failed
  state "投递失败（person/delivery）" as Delivery
  state "已结束" as Ended

  Queued --> Working: launch 拿到 worker slot
  Working --> Idle: 回合结束，报 waiting
  Idle --> Working: 订阅线程来了新 Trigger
  Working --> Review: report ready
  Working --> Answer: report 带结构化问题
  Working --> Blocked: report blocked
  Working --> Failed: report failed
  Working --> Delivery: Input 投递失败
  Delivery --> Working: 重试或新 Assignment
  Answer --> Working: 人回了消息
  Review --> Working: 人要求继续
  Blocked --> Working: 人的消息到达
  Failed --> Working: 人的消息到达
  Blocked --> Working: 面板点重试
  Failed --> Working: 面板点重试
  Review --> Ended: PR 全部关闭
  Working --> Ended: report dropped
  Idle --> Ended: PR 全部关闭
  Working --> Ended: 人喊停（撤销 Mandate）
  Idle --> Ended: 人喊停（撤销 Mandate）
  Ended --> Working: 人的消息到达且 Mandate 仍成立
  Ended --> [*]: 人喊停后不再恢复
```

两个容易看错的点：

- **「等人 review」不等于「等人回答」**：前者是 `ready` 报告，后者是有结构化问题（`attention`）。
- **已结束的 Ticket 保留 Subscription**：人再评论可以**用原授权直接恢复**，不需要重新走 Eval；但被「人喊停」的除外（`docs/002-authorization.md:127-129`）。

---

## 图 8 · 写路径：一条命令怎么落库、副作用怎么出去

这是整套架构最关键的一张，也是它和其他 Agent 项目最大的区别：**事务里只写库和入队，绝不发网络请求**。

```mermaid
flowchart LR
  A["命令入口<br/>receive / decide / report / attach ..."] --> B["Store.atomic<br/>一个同步事务"]
  B --> C["写 7 张表<br/>trigger / disposition / trigger_thread<br/>thread / ticket / decision / outbox"]
  B --> D["Effects.enqueue<br/>同事务写入 effect 表"]
  C --> E["commit"]
  D --> E
  E --> F["afterCommit 回调<br/>如取消 worker turn"]
  E --> G["Effects 轮询到期行<br/>按 kind 独立并发与退避"]
  G --> H["assessment → MasterAssessor<br/>launch / delivery → DshExecutor<br/>relay / notice → Sessions<br/>reply → Outbox → Source Channel"]
  H --> I["外部副作用发生"]
  I --> J["通过事实方法回报 Engine<br/>assignmentStarted / inputsDelivered<br/>report / deliveryFailed"]
  J --> B
```

关键落点：

- 事务边界与「端口在事务内入队、适配器在提交后执行」：`docs/007-architecture.md:166-170`
- 六种 effect 的并发上限与重试表：`docs/007-architecture.md:174-179`
- 命令命名规范：请求用祈使句（`stopTicket`），适配器事实用过去式（`assignmentStarted`），`docs/007-architecture.md:272`

---

## 三句话收尾

1. **架构上是六边形**：`Engine` 在中心，`Repositories / Policy / SourceScope / Assessor / Executor / Outbox` 六个端口朝外，所有外部世界的东西都挂在端口上（`src/core/ports.ts:105-134`）。
2. **数据流是两条**：一条「事件进来 → 判要不要干」（图 4），一条「授权出去 → 干完回话」（图 5）；两条只在 `Ticket` 这一个对象上会合。
3. **可靠性靠「先存后做」**：每个外部动作在事务里先落一行 effect 或回执，提交后才执行，失败按 kind 退避重试（图 8）。所以进程崩了，活还在。
