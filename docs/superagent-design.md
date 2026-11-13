# superagent 接入 DSC：详细设计与开发规划

本文档是 [dsh-superagent](https://github.com/) 接入 Pneuma（numa）的落地设计。上游原型是一套跑在
DeepSeek Harness 上的「主动型编码智能体」，本文只讨论**移植到 DSC 之后长什么样、怎么建**。

读者是接手写代码的人（尤其是下一次坐在这儿的 AI 助手）。读之前先读
[development.md](development.md) 的第 4 节（装配）和第 5 节（契约），本文不重复那些约定。

| 想知道 | 去看 |
| --- | --- |
| 上游原型的领域模型 | 上游仓库 `docs/000-philosophy.md` ~ `docs/007-architecture.md`（P2 时另写一份概览） |
| 插件怎么写、能挂哪些点 | [plugin-development.md](plugin-development.md) |
| 界面契约与槽位 | [ui-design.md](ui-design.md) |
| 还没做的事（按项编号） | [superagent/backlog.md](superagent/backlog.md) |

---

## 0. 一页纸摘要

| 项 | 结论 |
| --- | --- |
| 形态 | 一个功能包 `src/packages/superagent/` + 一个界面包 `src/packages/ui-superagent/` |
| P0 入口 | **只有手动发布**：面板填表 → 建工单 → worker 在 worktree 里改代码 → 摘要回面板 |
| P0 不碰 | GitHub、飞书、任何外部账号、任何网络请求 |
| 存储 | `node:sqlite`，库文件 `<DSC_HOME>/superagent/orchestrator.sqlite` |
| 单实例 | `tryOsLock`，不用 `proper-lockfile` |
| 执行器 | `MiniAgent` + `Session.create`，每工单一个会话、一个 worktree |
| 编排器 | P0 是**代码调度器**（无模型）；P2 才加模型版 |
| 权限 | `workspace-write` + 无人值守审批策略，全部可配 |
| 内核改动 | **5 个文件约 200 行**（界面方法白名单），这是「界面完整」的必要代价 |
| 上游复用 | 约 3,100 行原样搬，2,300 行改造，3,200 行丢弃 |

---

## 1. 目标与范围

### 1.1 目标

1. 上游的领域逻辑（gate / Mandate / Ticket / Assignment / 副作用队列）**一行不改**地跑在 DSC 里。
2. 装完即用：不需要 GitHub 账号、飞书应用、任何凭据。
3. 可在插件中心停用；停用后不留后台进程、不占端口、不报错。
4. 不修改 `src/core/` 的既有行为——除第 8 节列出的白名单扩展。

### 1.2 非目标

- P0 不做外部来源（GitHub / 飞书 / QQ / 微信）。
- P0 不做多仓库、多用户、权限分级。
- 不追求与上游行为逐字节一致；凡是对不齐的地方在 §11 列明。
- 不做个人微信接入（官方无接口，第三方方案违反用户协议，见 §11.4）。

### 1.3 分期

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| **P0** | 手动发布 + 执行 + 完整界面 | 面板发一条任务，30 秒内进执行，产出本地分支与改动摘要 |
| **P1** | 恢复、并发、超时、保留策略、体检 | 杀宿主重启后工单自动接续，不重复建分支（第 9 步已验证） |
| **P2** | GitHub + 飞书（写完默认关）+ 模型版编排器 | fixture 测试跑通全链路；真账号下 @ 一次产出 PR |
| **P3** | 企业微信 webhook（只当 Channel）、QQ 官方机器人 | 按需 |

---

## 2. 总体架构

```
┌────────────────────────── DSC 宿主进程 ──────────────────────────┐
│ cordis Context                                                   │
│   llm  session  tools  guards  surfaces  settings  health  log    │
│                              │                                    │
│  ┌───────────────────────────▼────────────────────────────────┐  │
│  │ @pneuma/superagent                                         │  │
│  │                                                            │  │
│  │  ┌── 领域核心（纯 TS，零 DSC 依赖）──────────────────────┐   │  │
│  │  │  engine  gate(policy)  stage  intake  tickets        │   │  │
│  │  │  assignments  effects  outbox                        │   │  │
│  │  └───────────────────────┬──────────────────────────────┘   │  │
│  │                          │ ports                          │  │
│  │  ┌───────────────────────▼──────────────────────────────┐   │  │
│  │  │ 适配层                                                │   │  │
│  │  │  DscStore      node:sqlite + tryOsLock               │   │  │
│  │  │  ManualSource  面板发布 → Trigger                     │   │  │
│  │  │  Dispatcher    接单 / 派工 / 投递 / 收报告（代码）      │   │  │
│  │  │  DscExecutor   MiniAgent + Session.create            │   │  │
│  │  │  DscNotifier   结果写 outbox → 快照面                 │   │  │
│  │  └──────────────────────────────────────────────────────┘   │  │
│  │                                                            │  │
│  │  passes(2s) · commands · settings · surfaces · health      │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  worker MiniAgent × N（每工单：独立会话 + 独立 worktree）           │
└──────────────────────────────────────────────────────────────────┘

┌──────────── 界面进程（ui-shell）────────────┐
│ @pneuma/ui-superagent                       │
│  侧栏入口 · 发布页 · 工单页 · 详情页 · 设置页  │
│  数据来源：snapshot.surfaces.superagent      │
│  写操作：host.invoke('superagent*')          │
└─────────────────────────────────────────────┘
```

**为什么要分两个包**：宿主包与界面包的生命周期不同。界面包可以单独停用（用户不想要那块 UI 就关掉），
宿主照常干活；宿主包停用则整块消失。这也是 `ui-sessions` / `ui-status` 等 19 个界面单元的既有形态
（见 `src/packages/ui-sessions/package.json` 的 `pneuma.client`）。

---

## 3. 包结构

```
src/packages/superagent/
  package.json          # pneuma 段：order 3800 / toggleable / settingsSection
  cordis.patch.yml      # 一行，disabled: true
  index.ts              # 只做装配，不写逻辑
  core/                 # ← 从上游 core 与根目录搬，保持零 DSC 依赖
    model.ts            # 领域模型：纯类型与纯函数
    ports.ts            # 五个端口 + 事件表
    engine.ts           # 唯一事务入口
    policy.ts           # gate / 准入强度 / 重新校验（上游 src/policy.ts）
    admission.ts        # 准入默认值（policy 的 schema 依赖，上游在 src/ 根）
    limits.ts           # schema 边界（同上）
    evals.ts            # 评估编排（不调模型，见 §4.1）
    tickets.ts  assignments.ts  intake.ts  replies.ts  stage.ts
    memory.ts  part.ts  errors.ts  reasons.ts  ids.ts  index.ts
  adapters/
    store.ts            # node:sqlite，DDL 与迁移
    store-read.ts
    executor.ts         # MiniAgent 装配与工具集
    dispatcher.ts       # P0 编排器（代码）
    manual.ts           # 手动来源
    notify.ts           # 结果落 outbox → 快照面
    worktree.ts         # git worktree 建 / 清
  passes.ts             # 2 秒节拍
  commands.ts           # /sa 命令组
  settings.ts           # 设置分区
  surface.ts            # 快照面
  health.ts             # 体检项
  paths.ts              # <DSC_HOME>/superagent/* 的路径常量
```

```
src/packages/ui-superagent/
  package.json          # pneuma.client: { platform: 'pneuma', api: '^0.9.1' }
  cordis.patch.yml
  index.ts              # 宿主半：空 apply，只为进 Loader 拿开关
  locale/ui.zh.json     # 中文原文（语义真源）
  locale/ui.en.json     # 英文译本
  ui/
    ui.tsx              # 槽位注册与页面外壳
    publish.tsx         # 任务发布
    tickets.tsx         # 工单列表
    detail.tsx          # 工单详情
    settings.tsx        # 设置
    timeline.tsx        # 时间线组件
    diff.tsx            # 改动摘要
    state.ts            # 从 snapshot.surfaces.superagent 取数与轮询
```

**默认启用**：`cordis.patch.yml` 不写 `disabled`。其余 21 个界面包没有一个默认关着，界面单元是壳的
一部分；宿主包 `superagent` 才是默认关的（它一开就要建库、起节拍）。所以第一次装上时侧栏能看到入口，
但页面要显示「未启动：去插件中心打开 Super Agent」——这是第 7 步做页面时的硬要求，不能是空白页。

包目录放好后 `scripts/build-packages.mjs:56-60` 会自动发现，不需要改任何注册表。
新增包会让 `node scripts/plugin-inventory-check.mjs` 报红，确认无误后跑 `--write` 更新基线
（`docs/development.md:183-184`）。

---

## 4. 领域核心

### 4.1 搬运原则

`core/` 里的文件从上游**逐文件复制**，只改 import 路径（`.js` → `.ts`；上游用 `.js` 后缀，DSC 的
TS 配置允许 `.ts`，实测 `core/model.ts` 353 行只差这一处）。这些文件不 import 任何
DSC 模块，唯一的外部运行时依赖是 `zod`（`core/policy.ts:5`，上游 `src/policy.ts` 本来就用它）。

`zod` 目前只是根 `devDependencies`，但仓库里已有同样的用法（`src/packages/ui-core/tui-plugins.ts:19`、
`src/packages/ui-boot/ui/boot.ts:59`），所以这里**不动依赖、不动 lockfile**。等这个包真要发布时，
才需要把 `zod` 提成运行时依赖——记在 §13。

有一处**有意的语义改动**：`EngineOptions.now` 由可选改必填（`core/part.ts`），去掉 `new Date()` 兜底。
核心不许有时钟副作用，时钟由适配层传（`() => new Date().toISOString()`）。

以下文件**不搬**，原因写在括号里：

| 上游文件 | 处理 | 原因 |
| --- | --- | --- |
| `core/evals.ts`、`core/model.ts` | **原样搬**（原计划「改造」，已作废） | 原以为它们调模型；实测 0 处模型调用，`model.ts` 全是类型与纯函数，`evals.ts` 只 import core 内部模块。真正调模型的是 `app/prompts.ts` 与 `executor/dsh.ts` |
| `app/effects.ts`、`app/outbox.ts` | 在适配层重写 | 不在 `core/` 下，属应用层；DSC 版落在 `adapters/notify.ts`、`adapters/dispatch.ts`（发送泵）与 `runtime.pump()`（周期驱动）。**没有** `passes.ts` |
| `executor/dsh.ts`、`executor/background.ts` | 重写 | DSH Session 专有 |
| `app/migration.ts` | 丢弃 | 从旧 DSH 版本迁数据，我们没有旧数据 |
| `app/http.ts`、`app/api.ts`、`app/resources.ts` | 丢弃 | 面板 HTTP 与部署校验，DSC 无对应入口 |
| `client/**` | 丢弃 | DSH 客户端界面，我们用 DSC 的 |

### 4.2 端口（ports）

领域核心只认五个端口，与上游一致：

| 端口 | 职责 | 适配器 |
| --- | --- | --- |
| `Repositories` | 触发器 / 线程 / 工单 / 决定 / 派工 / outbox / effect / kv 的读写 | `adapters/store.ts` |
| `Policy` | 当前策略：规则、允许名单、接单模式、准入表 | `adapters/store.ts` + 设置 |
| `SourceScope` | 一条 Trigger 是否在监听范围内、是否算「收到全部消息」 | `adapters/manual.ts` |
| `Assessor` | 研判（P0 为空实现） | `adapters/assessor.ts`（P2） |
| `Executor` | 派工：起 worker、投递、取消 | `adapters/executor.ts` |
| `Outbox` | 对外消息的入队与投递 | `adapters/notify.ts` |

P0 的 `Assessor` 实现：

```ts
const noAssessor: Assessor = {
  async assess() { throw new Error('superagent: P0 没有研判器，只接受明确请求') },
}
```

因为手动发布全部是 `explicit` 强度，`policy.ts` 的 gate 会直接给出「可接单」，不会走到研判。

### 4.3 gate 的行为（P0 唯一用到的判定）

`gate()` 的输入是：发送者、是否 @ 了智能体、线程上有没有工单、准入表里这条接收范围的三个格子。
输出三档：`explicit` / `inferred` / `not admitted`。

P0 只有手动来源，判定恒定为：

- 发送者 = 操作者本人（`manual` 来源的允许名单只有他一个）；
- `addressed = 'mention'`（等价于「你直接跟它说话」）；
- 结果 `explicit`，任何接单模式下都放行。

**这条路径必须走 gate，不能跳过。** 否则将来接 GitHub 时会分裂出两套授权逻辑，而授权恰恰是这套系统
最不能出错的地方。

---

## 5. 数据模型

### 5.1 库文件

```
<DSC_HOME>/superagent/orchestrator.sqlite
<DSC_HOME>/superagent/orchestrator.lock
```

`<DSC_HOME>` 取 `ctx.settings.about().home`（`src/services/types.ts:1199`），默认 `~/.dsc`，
可用环境变量 `DSC_HOME` 改。

建库时：目录 `0700`、文件 `0600`，`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL`。

### 5.2 DDL

上游 `src/app/store.ts:64-87` 的 9 张表与 4 个索引，**逐字保留**：

```sql
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trigger_thread (
  thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
  PRIMARY KEY (thread, id));
CREATE TABLE IF NOT EXISTS effect (
  kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL, since TEXT NOT NULL,
  PRIMARY KEY (kind, key));

CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
```

在这 9 张之外另补 3 张（原文没有，本版的写入 API 需要落点；原表一张没删、一个字段没改）：

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS event_ticket_seq ON event(ticket, seq);
CREATE TABLE IF NOT EXISTS assignment (
  id TEXT PRIMARY KEY, ticket TEXT NOT NULL, agent TEXT NOT NULL,
  state TEXT NOT NULL, at TEXT NOT NULL, value TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS assignment_ticket ON assignment(ticket);
CREATE INDEX IF NOT EXISTS assignment_agent_state ON assignment(agent, state);
```

补这三张的理由：

- `meta`：本插件自己的运行期元数据（迁移水位、上次修复时间）。**不与上游 `kv` 合表**——
  将来谁清空 `kv` 做一次 reset，会顺手把这里的修复记录抹掉。
- `event`：工单事件流，只追加、按 `seq` 回放，界面「工单详情」的时间线读它（§8.1）。
  **不塞 `outbox`**——那是发完就删的待办，事件是账，要能一直读；合表就得加软删标记，
  队列越滚越慢。
- `assignment`：谁在替哪张工单干活，有独立生命周期（认领 / 释放 / 失败重派），
  且要按 agent 查「手上几张」。塞进 `ticket.value` 就只能全表扫、逐行 parse。

业务对象仍以 JSON 存 `value` 列。这是上游的取舍：表结构稳定，P1 加字段不用迁移。代价是
不能按字段查询——但查询面本来就只有「按 id」「按工单」「按到期时间」三种，索引够了。

### 5.3 版本与迁移

- 版本号存 `PRAGMA user_version`，当前 **1**（上游存 `kv['store.schema']` = 11）。
  为什么改：迁移框架要在「连表都可能是坏的」那一刻读出可信版本，而 `kv` 表本身很可能
  正是要修的东西；`user_version` 是 SQLite 自己的字段，读它不依赖任何表。
- 读到更高版本 → 拒绝打开，报 `store_version_too_new`，库保持原样；
- 读到更低版本 → 按版本号递增跑迁移；
- P0 迁移链为空，但**框架要留出来**：一张「版本 → 语句数组」的表，不是 if 链，
  否则 P2 加表时无处落脚。

### 5.4 单实例

`tryOsLock(<DSC_HOME>/superagent/orchestrator.lock)`（`src/core/os-lock.ts:265`）。
拿不到就报一条明确的错误并让插件停在「未启动」状态，不崩宿主。

上游用 `proper-lockfile`，这里换成 DSC 自己的跨平台锁（Windows 命名互斥量 / POSIX flock），
少一个原生依赖。

---

## 6. 适配层

### 6.1 store.ts

职责：把 `Repositories` 端口落到 SQLite 上。

```ts
export class DscStore implements Repositories {
  constructor(private readonly db: DatabaseSync) {}
  trigger = { get: (id) => this.row('trigger', id), put: (t) => this.put('trigger', t) }
  // …
  /** 事务：写回执 + 入队副作用必须同一个事务，见上游 app/outbox.ts:26-31 */
  atomic<T>(work: () => T): T
  /** 提交后执行的回调；抛错只上报，不影响已提交的事务 */
  afterCommit(work: () => void): void
}
```

关键约束（照抄上游语义，不能省）：

1. **入队副作用与写回执在同一个事务里**。否则崩在中间会出现「消息没发、账也没记」或反过来。
2. **副作用在提交之后才执行**（`effect` 表 + 2 秒泵），不在事务内调外部。
3. **`effect` 的 `generation` 字段**用来作废已被替换的排队项：同一 `(kind, key)` 只保留最新一代。

### 6.2 executor.ts

每个工单一个 worker：

```ts
export class DscExecutor implements Executor {
  async launch(ticket: Ticket): Promise<void> {
    const dir = join(workRoot, ticket.execution.name)
    await ensureWorktree(repoRoot, dir, branch)          // git worktree add
    const session = Session.create(dir, join(sessionRoot, ticket.id, `${randomUUID()}.jsonl`))
    const agent = new MiniAgent(workerDeps(ticket, session), session)
    this.agents.set(ticket.id, agent)
    agent.followup(taskTextOf(ticket))
  }
}
```

`workerDeps` 的六个必填项：

| deps 字段 | 实现 |
| --- | --- |
| `route()` | `ctx.llm.routeTo(设置里的 provider/model, effort)`；留空则 `ctx.llm.route()` |
| `systemPrompt()` | 角色说明 + 执行变量 + 交付要求（见 §6.2.1） |
| `tools()` | 从 `ctx.tools.list()` 里挑六件套：`bash` / `read` / `write` / `edit` / `glob` / `grep` |
| `guards` | 全局链 + 无人值守审批（§7） |
| `stream()` | `ctx.llm.stream(api, request, handlers)` |
| `emit()` | 收 `turn/end` → 记报告；收 `error` → 记失败 |

#### 6.2.1 worker 的系统提示词

三段，全部是稳定文本（不做每轮变化的注入，省 token 也省抖动）：

```
你是超级智能体的执行者，负责一个工单。工单在独立的工作目录里，改动不要越出这个目录。

<工单>
标题：{{title}}
要求：{{body}}
分支：{{branch}}
</工单>

<环境>
仓库：{{repo}}
工作目录：{{dir}}
可用命令：{{blockedCommands}}
</环境>

<交付要求>
1. 改完跑一次相关测试，把结果写进最后一段。
2. 最后一段必须包含：改了哪些文件（一行一个，带 +/− 行数）、测试结果、没做的事。
3. 不要开 PR，不要推远端。改在本地分支上就结束。
4. 有需要人拍板的事，直接说清楚问题和你的建议，然后停下。
</交付要求>
```

#### 6.2.2 会话与目录的落点

```
<DSC_HOME>/superagent/sessions/<ticket id>/<uuid>.jsonl
<DSC_HOME>/superagent/work/<ticket name>/
```

用 `Session.create(cwd, file)` 的显式路径（`src/core/session.ts:663`），**不用** `ctx.session.open`——
后者会切换用户当前看到的会话。worker 必须是后台的、不进侧栏的。

上游把 worker 会话放在 `sessions/.teammates` 这类点目录下（`src/core/session.ts:1604`），
我们放自己目录里，效果一样：会话列表扫不到，但路径校验仍认它是「自己家的日志」。

#### 6.2.3 worktree

```sh
git -C <repo> worktree add -b "agent/<ticket name>" <dir> <base ref>
```

- 仓库路径、起点分支都来自设置；
- 分支名固定 `agent/<ticket name>`，与上游一致（上游靠分支名把 PR 绑回工单，我们暂时不用，但保留格式）；
- 目录已存在就复用，不重复 `add`；
- 清理按钮做 `git worktree remove --force` + 删目录。

### 6.3 dispatcher.ts（P0 的编排器）

**它不是模型，是一段状态机代码。** 六个动作：

| 动作 | 触发条件 | 做什么 |
| --- | --- | --- |
| 接单 | 收到 `explicit` 的 Trigger 且线程上没有活工单 | 建 Ticket + Mandate，入队 `launch` |
| 派工 | 工单 `pending` 且有并发槽 | 建 worktree，起 worker |
| 投递 | 有未送达的 Input | `agent.followup(text)`，标已送达 |
| 收报告 | worker 报 `ready` / `blocked` / `failed` / `waiting` | 改工单状态，入队 `notice` |
| 收尾 | 报告 `ready` | 工单转 `ended`，保留目录，入队通知 |
| 兜底 | 2 秒泵 | 超时取消、崩溃恢复、重试投递 |

**为什么 P0 不需要模型**：所有输入都是用户自己写的话，不存在「这条评论算不算活」的判断。

P2 接 GitHub 后才需要模型版编排器，那时才会有「候选路由」「评估」「判断回复归属哪个工单」这些事。

### 6.4 notify.ts

P0 的「发消息」只有一个去处：面板。

- 工单的确认、结果、失败，都写 `outbox` 表；
- 2 秒泵把 `outbox` 里的待发项转成快照面上的「动态」条目；
- 失败重试沿用上游语义：5 秒起、翻倍、封顶 300 秒；同一工单同一会话严格保序。

P3 加企业微信群 webhook 时，只多一个 `send` 实现，不动其他部分。

---

## 7. 权限与安全

### 7.1 三道闸

| 闸 | 位置 | 作用 |
| --- | --- | --- |
| 沙箱 | 全局守卫链 order 8 | `workspace-write`，把写入关在 worktree 里 |
| 无人值守审批 | 本插件守卫链 order 29 | 需要人工批准的操作：放行或拒绝，绝不挂起 |
| 工单授权 | `gate()` | 这张工单允许做什么（范围） |

**为什么把审批放在 29**：5 是灾难地板、8 是沙箱、10 是模式闸门、20 是安全钩子、30 是审批卡。
放在 29 意味着前面四道都跑完了才轮到它，而它判 `pass` 只会跳过 order 30 的审批卡，不会跳过沙箱。

子智能体用的是同一个位置（`src/packages/subagent/index.ts:626-640`），理由相同。

### 7.2 无人值守策略

设置项三档：

| 档 | 行为 | 适用 |
| --- | --- | --- |
| `deny`（默认） | 需要批准的操作直接拒绝 | 保守，推荐先这样 |
| `allow` | 需要批准的操作直接放行 | 信任后的自动化 |
| `ask` | 挂审批卡等人 | 有人的时候 |

**默认 `deny` 是有意的**：P0 是「人在旁边用」的阶段，默认拒绝会让你更早发现「它想干什么」。

### 7.3 不照搬的地方

上游让 worker 以 `danger-full-access` 跑（`docs/006-deployment.md:19`），因为它要无人值守改代码。
我们不照搬：**worker 的 cwd 就是它自己的 worktree**，`workspace-write` 天然把写入关在里面。
放弃 DSC 现成的沙箱没有任何好处。

### 7.4 超出范围的行为

worker 仍可以用绝对路径执行程序、读取操作者的家目录。这是 DSC 沙箱的既有边界，不是本插件引入的。
需要更强隔离时用独立操作系统账号——上游也是这个结论（`docs/006-deployment.md:19`）。

---

## 8. 界面

### 8.1 P0 页面

| 页面 | 内容 | 数据来源 |
| --- | --- | --- |
| 侧栏入口 | 会话列表整块之后再一行「Super Agent」，右侧显示待处理数 | `snapshot.surfaces.superagent` |
| 任务发布 | 六字段表单 + 最近 5 条 + 一键重发 | `invoke('superagentPublish')` |
| 工单列表 | 三组：需要你处理 / 进行中 / 已完成 | 快照面 |
| 工单详情 | 时间线、改动文件、diff 摘要、执行会话只读转录、操作按钮 | 快照面 + `invoke` |
| 设置 | 仓库路径、并发上限、单工单超时（权限档与目录根 P1 再补） | `ctx.settings` 分区 |

### 8.2 快照面

**声明在 `src/contract/runtime.ts`，不靠模块增强。** 这一条探针推翻了原先的设想：

- `@pneuma/runtime/*` 落到 `src/*`（根 `tsconfig.json:18`），所以 `@pneuma/runtime/contract.js`
  解析到 `src/contract.ts`，而那个文件只做转出（`src/contract.ts:2`、`:17-27`），
  `interface RuntimeSurfaces` 的本体在 `src/contract/runtime.ts:245`；
- `declare module` 的合并只认词法相邻的声明，转出（re-export）不参与（`ui-shell/src/plugin-api.ts:53-58`）；
- 现有全部快照面（`git` / `policy` / `mode` / `permissionPresets`）也都集中声明在这一个文件里，
  `surfaces.register` 的签名就是 `register<K extends keyof RuntimeSurfaces>`（`src/packages/surfaces/index.ts:21`）。

所以加一个 `superagent: SuperagentSurface` 字段，与其它面同源。这本来就属于 §8.3 那五处里的第 1 处。

```ts
export interface SuperagentSurface {
  ready: boolean
  problem?: { code: string; detail: string }
  counts: { needsYou: number; running: number; done: number }
  tickets: SuperagentTicketView[]
  recent: { at: string; text: string }[]   // 面板动态
}
```

快照装配层会原样带出去（`src/packages/transcript/index.ts:383`），界面侧读
`snapshot.surfaces.superagent` 即可。

### 8.3 写操作：必须扩白名单

界面插件只能调 `UI_METHODS` 里的方法（`src/core/ui-methods.ts:91`），这是个静态数组，没有动态注册入口。
所以下面五个方法要加进去：

| 方法 | 参数 | 语义 |
| --- | --- | --- |
| `superagentPublish` | `{ title, body, base?: string }` | 发布任务，返回工单 id |
| `superagentStopTicket` | `{ id }` | 停止工单 |
| `superagentRetryTicket` | `{ id }` | 重试 |
| `superagentCleanWorktree` | `{ id }` | 清理工单目录 |
| `superagentPeekSession` | `{ id }` | 只读读执行会话转录 |

按 `docs/development.md:381-399` 的规矩，每个方法要走五处：

1. `src/contract/` 对应域文件加签名；
2. `src/packages/runtime/index.ts` 实现；
3. `src/core/host-methods.ts:25` 的 `INVOKABLE_METHODS` 加名字（这份清单已经从 `host-stdio` 搬进 core，
   `host-stdio/index.ts` 里现在 0 处）；
4. `src/core/ui-methods.ts` 的 `UI_METHODS` + `UI_ARG_SPECS` 加条目；
5. `src/packages/remote/types.ts` 的 `REMOTE_SHELL_METHODS`——只放读类（`superagentPeekSession`），
   写类留在电脑上。

**这是 P0 唯一的内核改动，约 200 行、5 个文件。** 之前口头说过「零内核改动」，在「界面做完整」这个
前提下不成立，以此为准。

`UI_ARG_SPECS` 要写全：个数、类型、长度上限、枚举。省略只能从尾部开始——`null`/`undefined` 占位会被
拒（`docs/development.md:388-392`）。

### 8.4 界面包的技术约束

- `package.json` 声明 `pneuma.client: { platform: 'pneuma', api: '^0.9.1' }`；
- 契约版本门禁是 **失败关闭** 的：`api` 不满足壳版本直接不进启动图；
- 文案不写死中文，`createT({ zh, en })` + 两份字典，中文是语义真源；
- 构建产物落 `lib/ui/plugins/ui-superagent/`，由 `pnpm run build:ui` 生成；
- 内置包不需要用户点「信任」，只有第三方目录插件才要。

### 8.5 侧栏入口用哪种范式（探针已定）

**结论：整页（甲）。** 面板挂 `shell.page` 槽，侧栏挂 `shell.sidebar` 槽，两个注册同属界面包，
停用即双双消失。理由：整页宽度够摊 diff；关闭就是再点一次侧栏行；零壳体改动。
乙（`ui-team` 的只读浮层）要靠 DOM 查询找挂载点（`ui-team/ui/ui.tsx:244`、`:303-310`），
整页模式、轨迹切换、换会话都会把那个元素换掉，而且它盖住输入区。丙（dock 页签）的定位
是只读伴读面（`ui-dockkit/ui/dock-model.ts:49-55`），塞发布表单与设置进去与定位冲突。

选择依据与全部行号见 `docs/superagent/spike-sidebar.md`。

四条已知限制，都写进 §13 风险表：

1. **不能落在「工作区目录」里面。** `shell.sidebar` 是 `list` 槽（`src/packages/ui-slots/ui/slots.ts:30`），
   注册进去的条目只能排在会话列表整块的前面或后面；分组行是 `ui-sessions` 自己的 JSX
   （`ui-sessions/ui/ui.tsx:1005`），那个包的 `apply` 是空的、不 `provide` 任何服务，
   它自己那条注册也没传 `children`（`ui-sessions/ui/ui.tsx:102`），所以没有子槽可挂。
   要精确进到某个工作区分组里，得改 `ui-sessions` 开一个子槽——P0 不做，P1 再谈。
2. **整页会顶掉对话。** 这是整页范式的固有代价，不是缺陷；点侧栏行或用返回可退回。
3. **停用插件后主区不复位。** 只有 `plugins` 那一页有特判（`ui-sessions/ui/ui.tsx:210-213`）。
   用户在 Super Agent 页上停用它，主区会剩空白，点一条会话才能回来。P0 接受，P1 在壳里加
   「当前页没有 provider 就回落到对话」的通用兜底。
4. **页内状态不能放 `useState`。** 整页模式退出时页条目会被卸载（`ui-layout/ui/app.tsx:477`、`:655-692`），
   当前页签要放模块级 `createSignal`，否则每次返回都跳回第一页。

### 8.6 手机与窄栏

手机档侧栏默认收起，要拉抽屉才看得见这一行；56px 窄栏里壳只硬编码了技能与插件两颗钮
（`ui-layout/ui/app.tsx:943-968`），插件注册的行在那里不出现。**P0 不做手机入口**。

---

## 9. 生命周期

### 9.1 启动

**实际做法是懒启动**（第 4 步定的，与最初设想不同）：`apply` 只注册设置分区与命令，
**不碰磁盘**；第一次用到运行期（敲 `/sa`、或泵第一次真正要跑）才拿锁、开库、跑迁移。
理由：插件默认关闭，但界面包默认开着，若 `apply` 就建库，会变成「装上就多一个目录和一把锁」，
而用户可能整个生命周期都不用这个功能。**代价**：第一次 `/sa` 会慢一下，且连库失败时
错误出现在命令的 notice 里，而不是启动日志里——两者都可接受，因为命令层的提示直接告诉
用户去看日志。

真正开库时按下面这个顺序：

```
1. tryOsLock 拿锁           → 失败则报告并停在 unstarted
2. 打开 / 建库、跑迁移       → 失败则报告并退出
3. 注册设置分区、命令、快照面、体检项
4. 起 2 秒泵
5. 恢复：扫未完成的 Assignment，重建 worker；已结束的不动
```

### 9.2 关闭

`ctx.effect` 的清理函数按相反顺序执行：

```
1. 停泵（clearInterval）
2. 取消所有在跑的 worker 回合（agent.cancel()）
3. 等 10 秒让后台作业收尾
4. 关库、放锁
```

### 9.3 崩溃恢复

库是唯一真相。重启后：

- `pending` 工单 → 重新派工；
- `running` 且没有对应 worker → 起新 Assignment，并把一条「上次中断了，先看工作树和 git 状态」
  的提示词作为第一条输入投给新 worker；
- 最新报告是 `failed` / `blocked`、且之后没有再收到人话的 → **保留原分配，不接续**：那是 worker
  交给人的结论（失败原因、要人拍板的问题），自动重跑会把结论盖掉，等人按 `/sa retry` 决定；
- `ended` 工单 → 不动，目录保留。

**接不接续由领域判**（`core/assignments.ts:83-92` 的 `interrupted`），适配层不另写一份判据：它只在
「最新报告是 `waiting` / `ready` / `blocked` / `failed`，且之后没有新输入投给 worker」时保留原分配，
其余一律换新分配。适配层再写一份更粗的规则（例如「报过 `failed` 就跳过」）会漏掉「报了失败、人又
说了一句、worker 正跑着」这个窗口，留下既不能接续、也不能重试的卡单。

为什么是「起新 Assignment」而不是「把会话接回来」：DSC 的 worker 是进程内的 MiniAgent，宿主一死
会话就没了。新分配的工作树与分支按工单 id 复用（`ensureWorktree` 幂等、`worktreeNameOf` 定名），
所以上一轮的改动都在，分支也不会重建。

### 9.4 超时

工单从建单到现在超过设置的上限（默认 30 分钟）→ `agent.cancel()`，工单记 `failed`、原因写
「超过 N 秒未完成，已取消」，面板能看到，人按 `/sa retry` 继续。

（判据落在工单的 `createdAt` 上，不是「单个回合」的时长：`runtime.ts` 的 `expireOverdue()` 每拍
拿 `now - createdAt` 比上限。想在回合级别计时，得先有回合开始的时刻，现在库里没有这个字段。）

**与最初设计不同（原写「工单报 `waiting`」）**，理由是 `waiting` 在这个适配器里没有出口：

- 执行器只产出 `ready` 与 `failed` 两种报告（`adapters/executor.ts:761-770`）。`waiting` /
  `blocked` 是上游 DSH 会话里「工人等人回话」的语义，DSC 这边没有对等的产出点；
- P0 没有回复通道：服务只露 publish / stop / retry / clean / peekSession，而 `canRetry` 只认
  `blocked` / `failed`（`core/stage.ts:24-26`）——报 `waiting` 的工单既没有人能推进，也不能
  `/sa retry`，等于晾死；
- `failed` 是唯一「停住了、人一按就能继续」的状态，与 §10「worker 回合报错 → 记 `failed`，
  可重试」同一口径。

等补上「把人的话投回执行器」的通道（P1.1 之后再排），才谈得上按上游语义报 `waiting`。

上游同类语义在 `docs/003-execution.md:35`（后台作业 30 分钟上限）。我们把这个上限移到回合级别，
因为 DSC 里没有「工单保持 slot」这套机制。

---

## 10. 错误处理

| 故障 | 行为 |
| --- | --- |
| 拿不到锁 | 插件停在未启动，面板显示原因，不崩宿主 |
| 库损坏 / 版本过高 | 拒绝启动，报文件路径，不尝试修复 |
| 建 worktree 失败（分支已存在、路径占用） | 工单标 `failed`，带上命令原文 |
| worker 启动失败 | 记 `failed`，可重试；瞬时错误自动重试三次 |
| worker 回合报错 | 记 `failed`，通知面板，可重试 |
| 投递失败 | 入 `effect` 表重试，5 秒起翻倍，封顶 300 秒 |
| 通知失败 | 同上 |
| 泵任务抛错 | 记日志，不中断下一轮 |

**共同原则**：任何单点故障都不拖垮整轮，也不崩宿主。上游在 `docs/003-execution.md:159` 写的是
「同一种工作连续失败三次才报系统问题」——我们沿用这个阈值。

---

## 11. 与上游的差异

| 项 | 上游 | 本设计 | 原因 |
| --- | --- | --- | --- |
| 编排器 | 模型会话 | 代码调度器 + **候选收件箱**（推断候选等人点头，`confirmInferred`） | P0 全是明确请求，不需要判断；P2 的推断候选不交给常驻会话，交给人 |
| 执行器 | DSH Session | MiniAgent + Session | DSC 没有 DSH Session |
| 执行器的后台任务 | `ctx.jobs` / `ctx.subagents` 服务，回合结束后 `untilQuiet` 等静默 | `ctx.jobs` 服务（`tools-default` 提供）+ 执行器自己等 | DSC 有作业表，只是原先没开口；子智能体走 `subagent` 包 |
| 权限 | `danger-full-access` | `workspace-write` | DSC 沙箱现成 |
| 锁 | `proper-lockfile` | `tryOsLock` | 少一个原生依赖 |
| 库版本载体 | `kv['store.schema']` = 11 | `PRAGMA user_version` = 3 | 库坏时也要读得出可信版本 |
| 表结构 | 9 张 | 9 张原样 + `event` / `assignment` / `meta` / `candidate` | 时间线、分配、运行期元数据、候选收件箱要有落点 |
| 面板 | 自带 HTTP API | 快照面 + 白名单方法 | DSC 无插件路由入口 |
| 副作用队列 | 持久化 `effect` 表，6 种 kind（`assessment` / `launch` / `delivery` / `relay` / `notice` / `reply`） | `effect` 表 + `launch` / `delivery` 两种 kind（G2） | 少一层调度器；`assessment` / `relay` / `notice` / `reply` 仍走直调 |
| 数据清理 | 无（自认无限增长） | P1 加保留策略 | 不能重复这个坑 |
| 超时语义 | 工单报 `waiting`，等人回话再续 | 报 `waiting`（后台作业跑过 30 分钟上限时），其余报 `failed` | G3 补齐后 `waiting` 有了第一个真实来源；「等人回话再续」仍靠 `/sa retry` |
| 崩溃恢复 | 执行器保住会话，隔断后重连 | 起新分配 + 恢复提示词 | DSC 的 worker 是进程内 MiniAgent，宿主一死会话就没了（§9.3） |
| 子智能体 | worker preset 里配 `tool-subagent`，孙代理继承 worker 的工具与权限 | worker 白名单加 `subagent`；队友工牌来自角色文件，不继承父会话 | DSC 的队友按角色文件冻结工牌，这是有意的设计差异 |

### 11.4 关于 QQ / 微信

- **QQ 官方机器人**：可以接，结构上与飞书同构（长连接收事件 + HTTP 发消息），做成 `kind: 'qq'`。
  成本在注册与审核，不在代码。
- **企业微信**：可以接，官方接口完整，但接收消息需要公网可达的回调地址。
- **企业微信群 webhook**：只能发不能收，可只当 Channel（结果通知），成本极低。
- **个人微信**：不做。官方无接口，第三方方案违反用户协议且封号风险高。

---

## 12. 开发规划

八步，每步都能独立验收。**前一步没验收通过，不开下一步。**（P1 的崩溃接续是第 9 步，记在 §15；
P2 的 GitHub、飞书、模型版编排器、出站发送记在 §16。）

### 第 1 步：包骨架（半天）

产出：

- `src/packages/superagent/{package.json,cordis.patch.yml,index.ts}`，`apply` 里只注册一条设置分区；
- `src/packages/ui-superagent/` 空壳，侧栏加一行静态文字；
- 跑通构建与安装。

验收：

```sh
pnpm run build
node scripts/plugin-inventory-check.mjs --write
# 启动宿主，插件中心能看到「Super Agent」，能停用；侧栏出现入口
```

同时完成 §8.5 的探针：确认侧栏入口用哪种方式打开整页。

### 第 2 步：存储层（1 天）

产出：`adapters/store.ts` + `adapters/store-read.ts` + 迁移框架 + 单实例锁。

验收：

```sh
node scripts/package-tests.mjs            # 新增用例进这个口
# 用例覆盖：建库幂等、版本过高拒绝、版本过低迁移、锁冲突报错、atomic 回滚
```

### 第 3 步：领域核心搬运（2 天）

产出：`core/**` + `policy.ts`，全部编译通过，gate 的行为与原版一致。

验收：

```sh
node scripts/package-tests.mjs
# 用例覆盖：准入表三档强度、接单模式 off/observe/auto、Mandate 重新校验
```

这一步的测试用例可以从上游 `tests/policy.spec.ts` 之类直接翻译，断言照抄。

### 第 4 步：手动来源 + 调度器（2 天）

产出：`adapters/manual.ts` + `adapters/dispatcher.ts` 的「接单」与「收尾」两段，
`/sa new` 与 `/sa list` 两条命令。

验收：

```sh
# 终端里 /sa new "改登录页文案 | 把错误提示改成中文"
# 期望：工单进 queued，/sa list 能看到，库里 ticket 表多一行
```

### 第 5 步：执行器（3 天）

产出：`adapters/executor.ts` + `worktree.ts`，真正能起 worker 改代码。

验收：

```sh
# 发一条「在 README 末尾加一行 XXX」
# 期望：worktree 建出来、worker 改完、工单 ended、文件里真有那一行
git -C <worktree> log --oneline -1
```

这一步是整个项目的分水岭：跑通说明 MiniAgent 装配对了。

### 第 6 步：通知与操作（1 天）

产出：`notify.ts`、完成后写 outbox、`/sa stop`、`/sa retry`、`/sa clean`。

验收：

```sh
# 发任务 → 看 /sa list 的状态变化 → /sa stop 后 worker 真的停
# /sa clean 后 worktree 目录消失、git worktree list 里也没有
```

### 第 7 步：界面（4 天）

产出：快照面 + 五个界面方法（含内核白名单五处改动）+ 界面包五页 + 两份字典。

验收：

```sh
pnpm run build:ui
node scripts/check-ui.mjs                 # 界面壳自检
node scripts/ui-package-plugin-test.mjs   # 界面插件发现/门禁/组图
# 桌面端手点：发布 → 看到工单 → 看详情 → 停止 → 清理
```

### 第 8 步：收尾（2 天）

产出：崩溃恢复、超时取消、保留策略、体检项、本文件回填「实际做法」。

验收：

```sh
pnpm run check:core
pnpm run check:plugin
# 手工：执行中 kill 宿主 → 重启 → 工单自动接续，分支没重复建
```

### 工期与顺序

| 步 | 内容 | 估时 | 依赖 |
| --- | --- | --- | --- |
| 1 | 包骨架 | 0.5 天 | — |
| 2 | 存储层 | 1 天 | 1 |
| 3 | 领域核心 | 2 天 | 2 |
| 4 | 手动来源 + 调度器 | 2 天 | 3 |
| 5 | 执行器 | 3 天 | 4 |
| 6 | 通知与操作 | 1 天 | 5 |
| 7 | 界面 | 4 天 | 5（可与 6 并行） |
| 8 | 收尾 | 2 天 | 6, 7 |

合计约 **15.5 个工作日**，其中第 5 步（执行器）和第 7 步（界面）是主要风险点。

### 每步的共同规矩

- 新增的包用例进 `scripts/package-tests.mjs` 的口，不另造测试入口（`docs/plugin-development.md` §7）；
- 改完跑对应验证面，不全量跑（`AGENTS.md` 第 5 节）；
- 每步结束更新本文件的「实际做法」一节，别让文档和代码分叉。

---

## 13. 风险清单

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 宿主退出即停 | 不能 7×24 | 桌面端常开；P3 再考虑守护进程 |
| worker 改坏代码 | 需要人评审 | worktree 隔离 + 默认不推远端 + 改动摘要 |
| 界面契约变更 | 界面包要跟着改 `api` 区间 | 跟壳版本同版，发版前跑 `build:ui` |
| 会话与 worktree 无限增长 | 磁盘占用 | P1 保留策略：结束 30 天后清理 |
| 模型成本 | 单工单可能十几轮 | P0 只有 worker 一层；设置里可指定便宜模型 |
| 上游行为漂移 | 移植后语义不一致 | 核心文件不改；差异逐条记在 §11 |
| 侧栏入口进不到工作区分组里 | 位置与最初设想不符 | P0 接受（排在会话列表之后）；P1 给 `ui-sessions` 开子槽（§8.5） |
| 停用插件后主区空白 | 用户以为界面坏了 | P0 接受；P1 在壳里加「当前页无 provider 就回落对话」的兜底 |
| 手机窄栏没有入口 | 手机上够不着 | P0 不做；P1 往 `shell.header` 报一颗钮（§8.6） |
| 整页顶掉对话 | 不能边看边说 | 整页范式的固有代价，接受 |
| `zod` 只是根 devDependency | 这个包真要发布时装不上 | 现在不改（改根 `package.json` 会让 `pnpm-lock.yaml` 的 importer 段变旧，`--frozen-lockfile` 会挂）；发布前再提成运行时依赖 |

---

## 14. 待定

| # | 问题 | 现状 |
| --- | --- | --- |
| 1 | 侧栏入口点开整页用哪个范式 | **已定**：整页 + 侧栏一行（§8.5，探针见 `docs/superagent/spike-sidebar.md`） |
| 2 | 并发默认几路 | **已定**：2，设置可改（1–16）。第 5 步起就按这个值跑，真机验过 |
| 3 | 工单目录默认留多久 | **已定**：会话目录 30 天（`runtime.sweep`，判据是 `ended.at`）；工作树不归它删，那是 `/sa clean` 的事 |
| 4 | 要不要给 worker 配 `subagent` 工具 | **仍待定**：P0/P1 都没给。给了等于允许它自己再派子代理，成本与并发都要重新算，P3 再评估 |
| 5 | 飞书来源走哪条路 | **已定**：保留 `lark-cli` 子进程（收发都走 CLI，不自己写一套 HTTP 客户端）。代价是它进运行时依赖，装不上这个来源就不启动；§16.5 / §16.6 已按这条路实现完 |
| 6 | 判定模型换掉后要不要重建运行期 | **已定**：要。模型名在装配时读一次，改完重开宿主；改一条设置就重建整个运行期（锁、泵、worker）代价太大，设置项 help 里写清了 |

---

## 15. 实施记录

### 第 1 步：包骨架（已完成）

| 项 | 实际做法 |
| --- | --- |
| 宿主包 | `src/packages/superagent/`，order 3800，`apply` 只注册设置分区，另声明 `inject: ['settings']` |
| 界面包 | `src/packages/ui-superagent/`，order 369（348–368 已被 21 个界面包占满），默认启用 |
| 侧栏范式 | 甲（整页），探针见 `docs/superagent/spike-sidebar.md` |

### 第 2 步：存储层（已完成）

`paths.ts` + `adapters/store.ts` + `adapters/store-read.ts`。12 张表 / 7 个索引，`PRAGMA user_version = 1`。
锁走 `tryOsLock`，`unsupported` 时退回 `O_EXCL` 文件锁。6 条用例全过。

### 第 3 步：领域核心（已完成）

上游 15 个文件 2,028 行 + `policy.ts` 242 行 → 本包 18 个文件 2,370 行。
唯一有意的语义改动：`EngineOptions.now` 由可选改必填。29 条用例，其中 28 条断言照抄上游
`tests/policy.spec.ts`（用例标题带上游行号）。

### 第 4 步：手动来源 + 调度器（已完成）

产出：`adapters/repositories.ts`（`Repositories` 端口接 SQLite）、`runtime.ts`（引擎装配）、
`adapters/{settings,assessor,executor,outbox,manual}.ts`、`commands.ts`（`/sa new`、`/sa list`）。

真验收（用构建产物跑完整命令链路，临时 `DSC_HOME`）：

```
/sa new 改登录页文案 | 把错误提示改成中文
  → 工单已建：改登录页文案（8f9a1c69b8ef69cc31486444faca780b）
/sa list
  → ID / 状态 / 标题
    8f9a1c69  待派工  改登录页文案
/sa（空参数）
  → 格式：/sa new 标题 | 正文，或 /sa list
库里 ticket 1 行、event 2 行
```

用例：`repositories` 9 条、`runtime` 6 条，全过。

两条关键实现约束（写给第 5 步的人）：

- `Assessor.request` 是在 `evaluateDue()` 的写事务里被回调的，**不许在里面同步调 `engine.decide`**，
  否则线程重入会破坏事务边界。判定必须排队，由泵 `drain()`。
- `PendingExecutor.start` 是空操作，工单停在 `working/queued`。第 5 步替换它时要接
  `assignmentStarted` / `report` 两个回调，否则工单永远不出队列。

### 第 5 步：执行器（已完成，真机跑过）

产出：`adapters/worktree.ts`（git worktree 三条路径）、`adapters/executor.ts`（`WorkerExecutor` + `MiniAgent`）、
`runtime.ts` / `index.ts` 的 `ctx` 装配。

**真机验收**（宿主 headless 模式 + stdio 协议，临时 `DSC_HOME` + 临时 git 仓库，真模型）：

```
invoke setSettingValue  ['superagent','repoPath',<临时仓库>]  → ok
invoke runCommand       ['/sa new 在 README 末尾加一行 SUPERAGENT-E2E | …']  → ok
[superagent] 工单 73873cea… 已在 …/worktrees/README-SUPERAGENT-E2E-73873cea 开工
             （分支 agent/README-SUPERAGENT-E2E-73873cea，新建）
[superagent] 工单 73873cea… 的 worker 已停止（completed）
工单最终状态 = ended(completed)
README.md 末行 = SUPERAGENT-E2E
```

这次真机跑出了三个只有实跑才知道的事：

1. **worker 改了文件但没提交**，`git log` 只有 `init`。已改 §6.2.1 的交付要求：必须
   `git add -A && git commit`，不提交等于没交付——工单的产出就是分支上的提交。
   **改完重跑真机验证过**：`git log` 变成 `c19d61a docs: 在 README.md 末尾追加一行 SUPERAGENT-E2E`。
2. **无人值守审批没有把 worker 卡住**：简单文件写入在 `workspace-write` 沙箱里不需要人批。
   §7.2 那条「三档只做了简化版」的残留风险，在这种情况下不显形。
3. 工作树名取的是**标题 slug + 工单 id 前 8 位**（`README-SUPERAGENT-E2E-73873cea`），
   因为 `slugOf` 会把全中文折成 `ticket`，不加后缀两张中文工单会撞同一分支。

### 第 6 步：通知与操作（已完成，真机跑过）

产出：`adapters/notify.ts`（结果入 outbox + 最近动态）、`runtime` 的 `stop` / `retry` / `clean`、
`/sa stop` / `/sa retry` / `/sa clean` 三条子命令（id 支持前缀匹配，歧义时要求贴长一点）。

**真机验收**（临时 `DSC_HOME` + 临时仓库 + 真模型）：

```
工单 06c8b1e2… 在 …/worktrees/ticket-06c8b1e2 开工（分支 agent/ticket-06c8b1e2）
/sa stop 06c8b1e2  → worker 已停止（stopped），工单 ended = true
/sa clean 06c8b1e2 → 工作树已清理
clean 后 worktrees = []，git worktree list 从 2 条回到 1 条（只剩主工作区）
```

用例：`notify` 7 条，全过。

`stop` 的顺序是硬要求：**先 `engine.stopTicket` 让领域收尾，再 `executor.stop`**。反过来 worker 的
收尾回调会撞上「工单已结束」。

### 第 7 步：界面（已完成，真窗口点过）

产出：快照面 + cordis 服务 + 五个可调方法（五处白名单全改）+ 界面四页（发布 / 工单 / 详情 / 设置）。

**真窗口验收**（`node scripts/_ui-shell-serve.mjs` 起隔离宿主，浏览器实际操作）：

| 截图 | 验证到的事 |
| --- | --- |
| `docs/assets/superagent/shot-01-home.png` | 侧栏出现「⚡ Super Agent」一行（会话列表整块之后，与 §8.5 一致） |
| `shot-02-panel.png` | 点开是整页，标题、三页签、空状态都对 |
| `shot-03-publish.png` | 发布表单（标题 / 起点分支 / 正文 / 最近动态） |
| `shot-04-ticket.png` | 从界面发布后自动进工单页，新工单在「进行中」并高亮 |
| `shot-05-detail.png` | 详情：状态、交付摘要、停止/重试/清理、执行会话时间线 |
| `shot-06-confirm.png` | 清理有二次确认，文案写明「删工作目录、分支与提交不删」 |

清理后核对：工作树目录 0 个、`git worktree list` 只剩主工作区、`agent/README-UI-E2E-2ad36aa9`
分支与提交 `c2c2862` 仍在——与确认框里的承诺一致。

**这一轮发现的两件事**：

1. **设置项不落盘**。`repoPath` 存在 `index.ts` 的闭包变量里，重启就回到空串。设置页能改、
   当前进程内生效，但重启后没了。这是第 1 步骨架留下的，归到第 8 步修（用 `writePluginConfig`）。
2. **设置页帮助文案过时**：「P0 骨架只占位……填了也不生效」是第 1 步写的，第 5 步起已经真的在用。
   已改。

### 第 8 步：收尾（已完成）

六项：

| 项 | 做法 |
| --- | --- |
| 设置落盘 | `resolvePluginConfig` / `writePluginConfig` 读写 `~/.dsc/plugins.json` 里 `file: "superagent"` 的 `config`；三个字段：`repoPath` / `maxWorkers`(1–16，默认 2) / `ticketTimeoutSeconds`(默认 1800，0 = 不限) |
| 崩溃恢复 | 启动时扫工单：最新 Assignment 是 `running` 但进程里没有 worker → 标 `failed` 并通知「用 /sa retry 重派」；`pending` → 重新入队；`ended` 一律不动（第 9 步已改成自动接续，见下一小节） |
| 超时取消 | 泵每轮检查，超过 `ticketTimeoutSeconds` 的 `running` 工单停 worker、转 `failed`。排队中的不参与（否则稍后那次派工会启动一张已判失败的工单）。口径见 §9.4 |
| 保留策略 | 启动跑一次、之后每 24 小时一次：只删**已结束超过 30 天**的会话目录；工作树不在范围内 |
| 体检项 | 扩展点叫 `health`（`src/packages/doctor/index.ts:144`）；登记 `superagent/orchestrator`：库可写、锁是否被占、running 工单数与其中无 worker 的个数 |
| 文档回填 | 即本节 |

**跨进程验收**（真起两次宿主，第一次写、第二次读）：

```
[run1] 写入 {"ok":true} {"ok":true}
[disk] superagent.config = {"repoPath":"/tmp/persist-repo","maxWorkers":3}
[run2] 读回 {"repoPath":"/tmp/persist-repo","maxWorkers":3,"ticketTimeoutSeconds":1800}
[PASS] 两个设置项都跨进程存活
```

新增用例 `recovery.test.mjs` 6 条：设置往返、running 无 worker → failed、pending 重新入队、
超时取消、sweep 只删超期、sweep 不动未超期。

### 第 9 步：P1 崩溃接续（已完成，真机跑过）

P1 的出口条件是「杀宿主重启后工单自动接续，不重复建分支」。第 8 步交付的是「判失败、等人
重试」，与 §9.3 不一致；这一步把代码对齐到设计。

产出：`runtime.recover()` 对「`running` 且没有 worker」的单改走 `engine.assignmentInterrupted`
（`core/assignments.ts:83-92`，上游本来就有，之前一直没接线）；`RecoveryReport.failed` 改名
`resumed`；通知文案改成「已自动接续」；体检项里那条修法提示同步改口。

**接不接续交给领域判，适配层不另写判据**。最初我在 `recover()` 里加了一条「报过 `failed` /
`blocked` 就跳过」，审查时用临时库复现出它的漏账：那张单会被留成 `running` 且没有 worker，
`stage` 报 `working`、`canRetry` 因为「失败之后来了人话」变 false，人既等不到接续也不能重试。
删掉这条粗判据后，领域只在「报告之后没人接话」时保留原分配，其余换新分配——这条判据的归属
写在 §9.3。

**真机验收**：`node scripts/_sa-resume-e2e.mjs`（新脚本，下划线前缀不进测试电池；临时 HOME、
临时 git 仓库、假模型端点、真宿主进程，通道走宿主 stdio 协议）：

```
PASS 宿主 A 被硬杀（进程已退出）
PASS 被杀的现场：最新分配还停在 running
PASS 重启后日志出现「启动恢复：N 张接续」
PASS 工单有两份分配（旧的 + 接续的）
PASS 旧分配的结束原因是宿主重启
PASS 恢复提示词出现在执行会话里（worker 真看到了）
PASS 工作树仍是 2 行（没有建第二棵）
PASS agent/* 分支仍只有一条（接续用同一分支）
PASS 工单自己跑完了（ended 有值）        → 21 项检查全过，exit 0
```

三件只有实跑才知道的事：

1. **工作树与分支天然复用**：`ensureWorktree` 同名树在就复用，分支名由工单 id 与标题算出来
   （`worktreeNameOf`），所以接续不需要额外写「别让分支重建」的逻辑——它本来就幂等。
2. **恢复提示词要当「新消息」投**：新分配是新会话，工单原文不会自动重发；`tickets.restart`
   把提示词塞进 `undelivered`，执行器派工时跟着工单一起发。会话记录里能验到这句话，所以
   「worker 真的收到了」是可证的，不靠日志口供。
3. **宿主硬杀后锁自己放开**：Windows 命名互斥量随进程消失，重启直接拿得到，不用清锁文件。
   （写这份用例时先按「锁锚点文件存在」断言过一次，跑出来是假失败——Windows 上压根不建
   那个文件，判据要落在库文件上。）

超时语义没有跟着改：见 §9.4，`waiting` 在本适配器里没有出口，保留 `failed`。

### 第 10 步：与上游对齐的补齐轮次（已完成）

第 9 步之后，`docs/superagent/backlog.md` 记下了「上游有而当前没有」的项。这一轮按编号
逐项补齐，每项先读上游原码、小步提交、跑门禁。

| 项 | 做了什么 | 与上游的差异 |
| --- | --- | --- |
| G2 持久化 effect 队列 | `adapters/effects.ts` 照上游 `app/effects.ts` 移植：`launch` / `delivery` 两种 kind，`seq` / `generation` / `attempts` / `due` 语义逐项对齐 | 上游 6 种 kind，这里只有 2 种——`assessment` / `relay` / `notice` 依赖主会话（G1 不做），`reply` 由发送泵承担 |
| G4 准备命令 | 设置项 `prepareCommand`，建树后执行、10 分钟超时、失败判 failed 不重试 | 上游跑在工单目录的父目录（目录由 prepare 建）；这里目录由 git worktree 建好，跑在树里 |
| G5 临时故障重试 | `transient()` 判据 + 3 次重试（15/30/60 秒），同一会话投「继续」 | 上游投完等 `whenIdle`；`MiniAgent` 没有可等待的 idle 事件，用 `retryPending` 标记让故障回合先不报 |
| G7 报告语义 | `superagent_report` 工具（state / summary / question），工具报的状态覆盖回合默认的 `ready` | 上游叫 `orchestrator_report`，另有 `question_for_trigger_id` / `pr_number` / `reply_to_trigger_id` 三个参数；DSC 没有对应链路，去掉了 |
| G8 提示词外置 | `prompts/worker.md` + 构建脚本拷两个落点 + 运行时读文件缓存 + 内置兜底 | 上游 15 个 md；这里只有 worker 一个（主会话提示词随 G1 不做） |
| S1 线程上下文 | `threadWindow` 逐行同构，`runtime.threadContext()` 读窗口，判定器提示词加一节 | 上游分页用游标，GitHub 是页码；行内 review 评论不在窗口里 |
| S2 订阅线程轮询 | `subscribedThreads()` + `source.pollThreads()`，每线程独立游标 | 首拍起点用「本拍开始」而不是 `thread.createdAt`（接口只交编号） |
| S3 飞书群发现 | `+chat-list` 每轮刷新，开机后新出现的群并进补收 | 上游靠长连接事件；补收侧这里只补「开机后出现的群」，不补历史 |
| S6 飞书准入 | 飞书来源接进 `policy.sources` + 设置项 `feishuAllowed` | 上游 SETUP 里让用户填名单；这里同样必须填，否则消息全判 `not_a_member` |
| O1 安装引导 | `repoPath` 为空时快照面返回 `repo_missing`，界面画一条不挡页面的警告 | 上游有完整的 `SETUP.md` 向导；这里只有一条提示 |
| O2 机器校验 | 体检项 `superagent/dependencies`：git / lark-cli 各跑一次 `--version` | 上游 `deployment.ts` 校验更多依赖 |
| O3 全链路门禁 | `scripts/superagent-e2e-test.mjs`：假模型 + 真宿主 / 工具 / worktree / git，24 条断言 | 上游没有等价探针 |
| O4 outbox 状态列 | `state`（pending / sending）+ `claimOutbox` + 开库时把残留 `sending` 改回 pending | 上游 `Effects` 管副作用、`Outbox` 只管入队；DSC 的发送泵自己带队列语义 |
| U1 停用复位 | `ui-sessions` 对任意整页判断「启动图里还有没有人报名」 | 上游没有这个界面 |
| U2 转录自动刷新 | 详情页在 `working` / `idle` 时每 5 秒静默重读 | 上游没有这个界面 |
| U4 概览页 | 四页签，概览是三格计数 + 最近动态 + 空态 | 上游 `overview.tsx` 四段；只搬了两段，其余在快照面没有字段 |
| U5 来源状态 | 契约加 `sources?`，概览页底部一块显示两个来源的轮询状态 | 上游 `source.tsx` 是完整设置卡；这里只做状态可见性 |

**没做的两项，理由写在清单里**：G1（常驻主会话编排器）——DSC 没有常驻编排会话，做等价物
要么污染用户会话、要么新造一套架构；G3 / G6（后台任务、子智能体）——依赖内核是否暴露对应能力。

**这一轮的验收**：

```
pnpm run build                     # exit 0
node scripts/package-tests.mjs     # 91 包 / 121 用例 / 688 断言 / 0 失败
node scripts/superagent-e2e-test.mjs  # 24/24 通过
pnpm run check:plugin              # exit 0
node scripts/check-core.mjs        # 123/123 通过
```

### 实施中修正的设计

| 原设计 | 实际 | 为什么 |
| --- | --- | --- |
| `core/` 有 `effects.ts` / `outbox.ts` | 没有，在适配层重写 | 上游这两个在 `app/` 下，不在 `core/` |
| `evals.ts` / `model.ts` 要「改造成 ctx.llm」 | 原样搬 | 实测 0 处模型调用，两者都是纯逻辑 |
| 快照面用模块增强、不改契约 | 改 `src/contract/runtime.ts` | 转出不参与 `declare module` 合并（§8.2） |
| 侧栏入口在「工作区目录下一行」 | 会话列表整块之后一行 | 现有壳没有分组内扩展点（§8.5） |
| 界面包 `disabled: true` | 默认启用 | 其余 21 个界面包都默认开；宿主包才是默认关的 |
| 宿主包设置文案直接写中文 | 走 `hostT(import.meta.dirname)` + `locale/ui.zh.json` / `ui.en.json` | `pnpm run check:ui` 的本地化门禁会抓硬编码，56 个包都是这么做的 |
| 命令输出文案也进 locale 字典 | 用中文字面量 | 本地化门禁只扫「含设置分区声明」的宿主文件，命令输出不在覆盖面；29 个宿主半都这么写 |
| `apply` 时拿锁建库 | 懒启动，第一次用到才开库 | 插件默认关、界面包默认开，装上不该凭空多一个目录和一把锁（§9.1） |

### 验收命令与退出码

```sh
pnpm run build                    # exit 0，79 个功能包
pnpm run build:ui                 # exit 0，22 份界面产物
pnpm run check:plugin             # exit 0
node scripts/package-tests.mjs    # exit 0，91 包 / 121 用例 / 691 断言 / 0 失败
node scripts/ui-switch-check.mjs  # exit 0，34 PASS / 0 FAIL
node scripts/plugin-standard-check.mjs  # exit 0，91 包 0 问题
node scripts/plugin-inventory-check.mjs # exit 0，78 插件 / 26 分区 / 22 界面单元
```

### 第 11 步：G1 / G3 / G6 移植（已完成）

补齐清单里原先标「不做」的三项。调查后发现 G3 与 G6 **不是「内核不给」，是「内核有、没开这个口」**：
DSC 的后台作业表与 `subagent` 包都已存在，缺的是三处接线。

**共同地基**：worker 会话是执行器自己 `Session.create` 造的，不进 `ctx.agent` 的常驻名册，
于是 `sessionById(workerId)` 查不到它——`subagent` 认父会话、作业通知认归属都靠这一查。
`AgentService` 加 `attach` / `detach`（只登记 `Session`，不登记 `MiniAgent`），执行器建会话后登记、关会话时摘掉。

| 项 | 实际做法 |
| --- | --- |
| G3 作业表开口 | `tools-default` 把 `JobTable` 包成 `ctx.jobs` 服务（`createJobsService`：`list` / `running` / `wait` / `kill`），形状照上游 `executor/background.ts:10-15` |
| G3 worker 工具 | `WORKER_TOOL_NAMES` 加 `job_output` / `job_list` / `job_kill` |
| G3 等静默 | `turn/end` 到达时查 `jobs.running(workerSessionId)`，有作业就不报交付；`settleBackground` 每 500ms 查一次，静默后唤醒 worker 去读输出，30 分钟到点杀掉并报 `waiting` |
| G3 停工单 | `terminate` 里 `killBackgroundJobs`，杀掉它还在跑的作业 |
| G6 工具面 | `WORKER_TOOL_NAMES` 加 `subagent` |
| G6 归属 | `subagent` 工具查不到父会话时**抛错**，不再回落 `ctx.session.current()`——回落会把队友派到用户正看着的会话名下 |
| G6 收队友 | `TeamService.stopBySession(sessionId)`，`terminate` 时调（对齐上游 `stopSubagents`） |
| G1 候选收件箱 | schema v3 加 `candidate` 表；`ModelAssessor` 加 `holdCandidate` 出口，`confirmInferred` 打开时 `auto` 模式的推断候选挂起；`SuperagentSurface` 加 `candidates` 格；概览页加「待确认」块；宿主加 `superagentAcceptCandidate` / `superagentIgnoreCandidate` |

**G1 只做了一半**：没造常驻主会话（上游靠主会话的模型替人点头，DSC 换成人点按钮）。
`assessmentOutcome` 在 `mode !== 'auto'` 时把推断强度的 accept 降成 `ignore`（`core/policy.ts` 的
`observed` 分支），所以候选收件箱只在「自动接单」模式下有内容；默认设置是 `observe`。

**没做的一层**：队友工具与 worker 白名单取交集。DSC 的队友工牌来自角色文件（有意设计），
不继承父会话；要改得动共用包的工具挑选逻辑，影响所有会话。

验收：`package-tests` 91 包 / 121 用例 / 691 断言 / 0 失败；`superagent-e2e-test.mjs` 24/24。

---

*本文档随实现更新。写完代码那一节，回来改「实际做法」。*

## 16. P2 实施记录（代码完成，待真账号验收）

### 16.1 GitHub 来源（已完成，离线用例 15 条 + 全链路 4 条）

从上游 `sources/github*.ts`（901 行）移植到 `adapters/github/` 八个文件、约 1450 行。

| 文件 | 职责 |
| --- | --- |
| `api.ts` | fetch 封装：路径锁在 `repos/<repository>/`、Bearer、Link 翻页、`GithubError.code` 带 HTTP 状态 |
| `state.ts` | 直接读写 `kv` 表存游标，键名照上游 `kv.ts:46-50` |
| `trigger.ts` | 纯函数：issue / PR / 评论 / review / CI → `Trigger`，含 `githubAddress` |
| `read.ts` | CI 快照（check-runs 跨页 + statuses 取最新）与对话读法 |
| `pull.ts` | 读 PR、结束报 `threadClosed`、`agentPull` / `ticketBranch` |
| `channel.ts` | 发评论、回 review 讨论、marker 去重、410 与 403+locked → `gone` |
| `poll.ts` | 5 秒回退、14 天视野取整点、ETag 复用条件 |
| `source.ts` | `createGithubSource(...) → { tick, status }`，另导出 `pollPullChecks` |

**换掉的只有「谁发请求」**：上游走 `gh` 子进程（`infra/commands.ts:68-98`），DSC 走内置 fetch。
三条边界原样保留，且都有用例钉住：路径不能越出本仓库（否则令牌能把别的仓库数据带出来）、
翻页只认 `api.github.com`（伪造的 `Link` 会把 `Authorization` 头带去别人的服务器）、
410 永久删除 / 404 可重试 / 304 静默 / 403+locked 永久不可回复。

**与上游一致的语义**（改一个字符就静默漏事件，所以逐字段做了快照断言）：`Trigger.id` 公式、
`meta` 形状、`human` / `addressed`、游标回退 5 秒与 14 天视野。

**没搬的三处**，原因都写在对应文件头：

- `githubThreadContext`：DSC 没有 `ThreadContext` 端口，评估侧要用 `read.ts` 的 thread 读法补；
- `claimPull` 与 PR 自动绑定：要 `tickets.open()` / `triggers.get()`，搬进来会让工单规则复制成两套；
- `pollTicketPulls` / `pollThreads`：需要「工单清单」与「订阅了哪些线程」两个出口，本适配器没有。

### 16.2 接线（已完成）

- `runtime.sourceBridge()` 只露三个动作（`receive` / `bindThread` / `threadClosed`）。把运行期
  整个交出去，来源就能绕过准入闸自己建单。
- `threadClosed(thread, outcome, at)` 的 `at` 原样透传：适配器带着 PR 的 `merged_at` 来报，
  丢掉这个时刻会把工单结束时间记成「现在」。
- 来源在泵上每 30 秒一拍、上一拍没回来就跳过。配额打满的症状是「突然一条评论都收不到」。
- 令牌只从环境变量读（默认 `GITHUB_TOKEN`），`plugins.json` 里只存变量名。

### 16.3 一处自己写错的防线（已拆）

第一次接线时我在 `scope.ts` 里读 `meta.repository` 做「仓库不符就拒」。但 `Trigger.meta` 与
上游逐字段一致，**里面没有仓库这个键**——读到的永远是空串，那道闸一次也没生效。

空的防线比没有防线更糟：它让人以为有保护。已删，并把仓库边界归到真正守它的地方：轮询器只
轮询一个仓库，`api.ts` 把路径限制在 `repos/<repository>/` 下。

### 16.4 模型版编排器（已完成，用例 10 条）

上游把候选卡片投给主会话、由主会话调工具判定（`app/assessment.ts:104`）。DSC 没有常驻主会话，
换成一次性问答：提示词进、JSON 出，判定结果仍经 `Engine.decide` 落库。

三个实现决定：

1. **先 `candidateDelivered` 再等模型**。这条是查实的隐患：核心的 Eval 截止时间只在候选
   「已投递」后才开始算（`core/evals.ts:43`），而 `ManualAssessor` 从不调它——今天不出事是因为
   泵每 2 秒把队列抽空，模型版一旦慢或挂住就永远不会过期（`core/evals.ts:60` 的重排与
   「判定器不可用」全靠这个截止时间）。
2. **判定整份交给核心校验**（`assessmentOutcome`，`core/policy.ts:52`），不自己写第二套。
   方向必须是对象（`core/policy.ts:30-35`），不是 `inbound` / `outbound` 这种词。
3. **模型输出不可信**：带围栏、少判一条规则、整个不是 JSON，都落成「这一条判不了」。

降级：`eval.model` 是 `nullable().default(null)`，不配模型时一次模型请求都不发，行为与 P0 逐字一致。
配了模型但宿主没接 `llm` 时退回同步规则，不抛错。

### 16.5 出站发送（已完成，用例 10 条）

`store.ts:449-454` 就写明 `drainOutbox` 是「取出即删，发失败的消息由发送方自己重新入队」，
但这一半一直没写：`outbox` 只有一个读者 `StoreNotifier.drain()`，它把行取走放进「最近动态」
就给界面看了，对面一个字也收不到。飞书群里 @ 一次，机器人从此不说话。

新增 `adapters/dispatch.ts` 的发送泵，每拍（`runtime.pump()`）取一批、逐条发：

1. **失败按原 id 写回队列**。id 就是幂等键（飞书的 `--idempotency-key`、GitHub 评论里那段
   `<!-- dsh-superagent:... -->` 标记），所以「至少一次」不会变成「贴两遍」。写回本身失败时
   （库被锁、正在停用）那条消息只剩内存里一份，下一拍先处理它——不留内存就是静默丢消息。
2. **退避只在内存**：5、10、20、40、80、160、300 秒，试满 8 次（约 10 分钟）丢弃并记日志。
   抖几分钟能自己好的，重试救得回来；抖一小时还不行（令牌过期、应用被停用）的靠重试也救不
   回来，丢掉并记日志更诚实。
3. **`manual` 通道只进最近动态**：那是 P0 的通知占位，没有可以回话的会话。来源没起来
   （飞书没配、GitHub 没令牌）是另一回事，按退避等，不会一上来就丢。

**已知代价（已修，O4）**：`drainOutbox` 原来是「取出即删」，一次取走最多 50 行、发完之前只活在
内存里，进程崩在这一批中间会丢未发的那几条。现在 `outbox` 有 `state` 列（`pending` / `sending`），
取行改成 `claimOutbox` 认领、发成功才 `finishOutbox` 删行，开库时把残留的 `sending` 改回 `pending`
（`adapters/store.ts` 的 `recoverSendingOutbox`）。重发是安全的：两个通道都按消息 id 做幂等。

一处顺手补的：`decodeOutboxItem` 遇到坏行会抛（不是 JSON，或能解析但缺 `id` / `kind`），而
`drainOutbox` 的「取出 + 删除」在同一个事务里——**一行坏数据会挡住所有回复**。发送泵读失败时
把这两种坏行删掉再试一次（`dispatch.ts` 的 `salvage`）。

接线：`RuntimeOptions.senders` 是 getter（两个来源都在运行期之后才建好），`index.ts` 把
`sendGithub` / `sendFeishu` 注册进去；`pump` 里发出去就走，不拖住超时判定与 Eval。
`StoreNotifier.drain()` 已撤掉，出站队列只剩发送泵一个读者。

### 16.6 飞书话题轮询（已完成，用例 6 条）

`FeishuThreads` 端口（`loops.ts:141`）一直在适配器里等着，运行期没实现，
`createFeishuSource` 拿到的一直是 `undefined`：按群补收在跑，按话题补收从来没跑过。

`runtime.feishuThreads()` 补上三个动作：

| 动作 | 判据 |
| --- | --- |
| `subscribed(source)` | 这个来源的话题；并且有活工单订阅着，或最近 14 天里有过消息（`POLL_HORIZON_MS`）。「活工单」是「行在、且没结束」——结束的订阅留在历史里，拿它当活就永远停不下来；查不到的 id 也不算活 |
| `latest(key)` | 走 `trigger_thread(thread, at)` 索引，按**发生时刻**取最新，不是最后写入的那条（补收读进来的历史消息带着过去的时间，两者顺序并不一致） |
| `patch(key, meta)` | 合并进 `Thread.meta`（`core/model.ts:177-181` 就是给来源放原生属性的那一格），`undefined` 表示删键 |

### 16.7 PR 接线有了用例（9 条）

`bindPulls`（认领智能体自己开的 PR）与 `pollPullCi`（看已关注 PR 的 CI）原来写在 `apply()` 的
闭包里，依赖 `ctx` / `store` / `runtime` 这些活对象，测试造不出来，等于一行断言都没有。这类
失败是静默的：认领不上不报错，症状只是「CI 一直没反应」「PR 合并了工单不结束」。

抽成 `adapters/github/bind.ts`：`bindAgentPulls` 只收五个小动作（读开着的 PR、列工单、机器人
身份、绑线程、记日志），判断仍交给核心的纯函数（`agentPull` / `ticketBranch`）与 `pullOf`；
`pollTicketChecks` 负责「哪些 PR 该看」与逐单容错。`index.ts` 两处只剩薄调用，行为不变。

### 16.8 仍然没做的

| 项 | 缺什么 | 谁决定 |
| --- | --- | --- |
| 真账号验收 | GitHub 要仓库 + `GITHUB_TOKEN`，`@` 一次要真的产出 PR；飞书要有可用的企业与应用（自建应用 + 5 个 IM 权限 + 长连接订阅）。这两条都只能人来做，代码侧已经就位 | 用户 |
| `lark-cli` 的打包 | **已定（2026-11-14）**：不进运行时依赖清单，用户自己装；设置页 `feishuCli` 的 help 与体检项 `superagent/dependencies` 的 fix 都写明装法（`npm install -g @larksuite/cli`，官方仓库 github.com/larksuite/cli）。装不上这个来源就不启动，不报错、不影响插件其余部分 | 已拍板 |

飞书那条路线的代价说清楚：轮询能替代「配置点名的群」的补收，替代不了「新群 / 私聊自动发现」
与秒级延迟（`feishu-loops.ts:71`、`feishu-channel.ts:23` 都是子进程调用）。

**已补的两处（更早一轮）**：

- **PR 的 CI 轮询**：`pollPullChecks` 由泵调用——每次 GitHub 轮询跑完后，对每张开着且
  `pullOf()` 有值的工单调一次（`index.ts` 的 `pollPullCi`）。
- **PR 自动绑定**：每拍读完事件流就读一次开着的 PR，按 `agentPull`（机器人自己开的、head 在
  本仓库）与 `ticketBranch`（分支末段等于工单短名）认领，线程 id 用 PR 号——与适配器报
  `threadClosed` 时用的 id 必须一致，否则工单永远等不到「PR 合并了」。顺序是「先认领、再看
  CI」，反了会白等一拍。
