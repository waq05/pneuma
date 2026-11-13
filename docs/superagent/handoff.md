# superagent 交接

> 写于 2026-11-14，分支 `feat/pluginization`，HEAD `2c0374ef`。
> 给下一个接手的会话：这页只写「现在是什么状态、还差什么、怎么验」，机制细节指向设计文档与源码。

## 1 一句话现状

上游 dsh-superagent 的移植在 **G1 / G3 / G6 三块补完后**，代码侧没有已知缺口，五道门禁全绿。
剩下的是：两项等用户拍板、一层有意没做的差异、一处文档与代码不一致、三处「有单测但没跑过真链路」。

## 2 已完成

### 2.1 本轮（13 个 commit，HEAD 往前数）

| commit | 内容 |
| --- | --- |
| `dd969c67` | **地基**：`AgentService` 加 `attach` / `detach`（`src/services/types.ts`、`src/packages/agent/index.ts`）。worker 会话是执行器自己 `Session.create` 造的，不在常驻名册，`sessionById(workerId)` 原先查不到——`subagent` 认父会话、作业通知认归属都断在这里 |
| `44e98761` | G3：`tools-default` 把 `JobTable` 包成 `ctx.jobs`（`createJobsService`，`src/packages/tools-default/bash.ts`） |
| `833c7fe5` | G3：worker 工具目录加 `job_output` / `job_list` / `job_kill` |
| `bf33da1b` | G3：`turn/end` 后等作业静默（`awaitBackground` / `settleBackground` / `killBackgroundJobs`，`src/packages/superagent/adapters/executor.ts`） |
| `8a0d08ff` | G6：worker 白名单加 `subagent`；父会话查不到就抛错不回落；`TeamService.stopBySession` |
| `6c2d975e` | G1：schema v3 加 `candidate` 表（`src/packages/superagent/adapters/store.ts`） |
| `093e1569` | G1：`holdCandidate` 出口 + 契约 `candidates` 格 + 界面「待确认」块 + 两个宿主方法 |
| `28f96fa2` | 文档回填（本清单、设计文档 §11 / §15、两份 README） |
| `861b2b3c` | G1：候选进出算进 `service.pulseOf` 指纹 |
| `ca4a75e8` | 测试：`subagent-context-test.mjs` 补 `ToolContext.sessionId` |
| `e2645264` | 测试：`ui-superagent` 钉住「待确认」两颗钮只回传 id |
| `5ca94c44` | 修既有 flaky：名册用例等过一个 mtime 窗口 |
| `2c0374ef` | 修既有 flaky：常驻多 agent 用例把 A 的回合拖到 2 秒 |

### 2.2 更早的 17 项

清单与逐项做法在 [`backlog.md`](backlog.md)。G2 / G4 / G5 / G7 / G8、S1 / S2 / S3 / S6、
U1 / U2 / U4 / U5、O1 / O2 / O3 / O4 都已补。

## 3 未完成清单

### A 等用户拍板（代码侧做不了）

| 项 | 缺什么 | 为什么不是我们的活 |
| --- | --- | --- |
| **S4 `lark-cli` 打包** | 定它进不进运行时依赖清单；定了之后设置页给一条可操作提示 | 是分发策略，不是代码能力。现在没装 CLI 时不启动来源、记一行日志、不影响其余部分 |
| **S5 真账号验收** | GitHub 仓库 + `GITHUB_TOKEN`；飞书自建应用 + 5 个 IM 权限 + 长连接订阅 | 只能人操作账号。离线用例 15 + 6 + 10 + 9 条已跑通 |

### B 有意没做的一层（不是漏项，是设计差异）

| 项 | 上游怎么做 | 我们怎么做 | 要补的代价 |
| --- | --- | --- | --- |
| **G1 常驻主会话** | 主会话的模型替人点头（`orchestrator_eval_decide`） | 候选落进 `candidate` 表，**人点按钮** | 要新建隐藏会话 + 工具可见性隔离；`tools.project` 只能做减法，做不了「只给某类会话加工具」 |
| **G6 队友工具交集** | 孙代理继承 worker 的工具与权限（`app/sessions.ts:303-312`） | 队友工牌来自角色文件，不继承父会话 | 要改共用包 `subagent` 的工具挑选逻辑，影响所有会话 |
| **U6 手机档** | — | 侧栏收起、56px 窄栏不出现、整页顶掉对话区 | 是 §8.5「整页」范式的代价；要改就得重选界面范式 |

### C 文档与代码不一致（**接手后先修这一条**）

**`backlog.md` 里 G2 的状态行写着「未补」，实际已补。**证据：

- `src/packages/superagent/adapters/effects.ts` 418 行，`EffectQueue` 照上游 `app/effects.ts` 移植
- `runtime.ts:427` `new EffectQueue(store)`、`:457` `effects.start()`、`:1134` `effects.drain()`
- `executor.ts:858` `effects.enqueue('launch', …)`、`:871` `effects.enqueue('delivery', …)`

这只是回填漏了，不是代码没做。修 `backlog.md` 的 G2 行即可，**别去重写 `effects.ts`**。

### D 有单测但没跑过真链路

| 项 | 已验到什么程度 | 还差什么 |
| --- | --- | --- |
| **候选收件箱全链路** | 挂起（`assessor.test.mjs` 三条）、表读写（`store.test.mjs`）、快照面（`surface.test.mjs`）、界面按钮（`pages.test.mjs`） | 没在真宿主里走「发布一条推断候选 → 概览页看到 → 点接单 → 工单开跑」。需要一个假模型端点返回 `accept` 且强度 `inferred`，`eval.mode = auto`，`confirmInferred = true` |
| **后台作业 30 分钟上限** | 执行器用假 jobs 表测过（注入 `backgroundLimitMs: 60`）；`JobTable` 真实现的 `list`/`running`/`wait`/`kill` 用真子进程测过（`tools-default.test.mjs`） | 没在真 worker 里跑过完整一轮「起作业 → 回合结束 → 作业结束 → 唤醒」。30 分钟本身只是常量，注入小值等价 |
| **子智能体在 worker 里** | worker 白名单有 `subagent`（`executor.test.mjs`）；父会话查不到抛错（`subagent.test.mjs`）；停工单收队友（`executor.test.mjs`） | 没在真 worker 里起过队友。要验得让假模型在 worker 回合里调一次 `subagent(action=spawn)` |

## 4 接手必须知道的五个机制

1. **worker 会话是「幽灵会话」**：执行器自己 `Session.create`（`executor.ts:1086`），紧接着 `attachSession`（`:1097`），不进 `ctx.agent` 的常驻名册。靠 `attach` / `detach` 让内核认得它。`hasAgent` 与 `followup` **仍然只认常驻名册**——别顺手把它们改成查 `attached`，那会导致「对一个没有 MiniAgent 的会话调 followup」。
2. **候选收件箱只在 `auto` 模式下有内容**：`assessmentOutcome` 在 `mode !== 'auto'` 时把推断强度的 accept 降成 `ignore`（`core/policy.ts` 的 `observed` 分支）。默认设置是 `observe`。所以「开了 `confirmInferred` 却什么都没有」不是 bug。
3. **等作业静默是轮询**：`settleBackground` 每 `backgroundPollMs`（默认 500ms）查一次 `ctx.jobs.running`。没走事件，因为作业表只提供查询。要改事件得先给 `JobTable` 加订阅。
4. **子智能体查不到父会话就抛错**：`subagent/index.ts` 的 `subagentTool().run` 不再回落 `ctx.session.current()`。回落会把队友派到用户正看着的会话名下（名册、额度、任务板全错）。这条是**故意**的，别改回去。
5. **`confirmInferred` 默认关**：判定器在构造时就定了形状，改它要重开宿主（与 `assessorModel` 同一条取舍）。

## 5 门禁（在 HEAD `2c0374ef` 上跑过）

```sh
pnpm run build                     # exit 0，79 个功能包
node scripts/package-tests.mjs     # 91 包 / 121 用例 / 691 断言 / 0 失败
pnpm run check:plugin              # 换包 e2e 17 PASS / 0 FAIL
node scripts/check-core.mjs        # 123/123（898.6s，exit 0）
node scripts/superagent-e2e-test.mjs  # 24/24
```

单跑某条探针要走 `--import` 钩子（否则界面模块的 `@dsc/ui` 别名解析不了）：

```sh
node --import ./scripts/_i18n-alias.mjs scripts/<name>-test.mjs
```

## 6 环境注意

- **跑 `pwsh` 工具会在仓库根生成 `Microsoft/Windows/PowerShell/ModuleAnalysisCache`**。这是 PowerShell 的模块分析缓存，不是项目产物，删掉即可（`Remove-Item -Recurse -Force D:\dsc\Microsoft`）。每次跑完 `git status` 看到它别当成自己产生的。
- 工作区里 `docs/development.md` 的 3 行改动、`docs/superagent/shots/`、`docs/superagent/space-demo.html` **不是本轮产生的**，别顺手提交。
- `node --test` 默认 spawn 子进程会 EPERM（沙箱），单文件跑要加 `--test-isolation=none`；多文件同进程会串 `DSC_HOME`，整包用 `scripts/package-tests.mjs`。

## 7 建议的接手顺序

1. **修 `backlog.md` 的 G2 状态行**（5 分钟，纯文档）。
2. **补 D 表里第一条：候选收件箱全链路**（最有价值——这是唯一「新增的对外能力」还没在真宿主里走通）。
3. 补 D 表第二、三条（后台作业与子智能体在真 worker 里）——可以合并成一条 e2e 用例。
4. A 表两项去问用户；B 表三项别再动，除非用户明确要换架构。

## 8 相关文档

| 文档 | 看什么 |
| --- | --- |
| [`backlog.md`](backlog.md) | 24 项补齐清单，每项有现状 / 补法 / 验收 |
| [`../superagent-design.md`](../superagent-design.md) | §11 与上游差异表；§15 第 11 步实施记录 |
| [`../../src/packages/superagent/README.md`](../../src/packages/superagent/README.md) | 宿主包现状：五处装配面、工作链路、Known Limitations |
| [`../../src/packages/ui-superagent/README.md`](../../src/packages/ui-superagent/README.md) | 界面包四页签，「待确认」块怎么接 |
