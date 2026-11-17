# superagent 交接

> 写于 2026-11-14，分支 `feat/pluginization`。
> 给下一个接手的会话：这页只写「现在是什么状态、还差什么、怎么验」，机制细节指向设计文档与源码。
> 文中 `commit` 短哈希都还在分支上，`git show <哈希>` 能回到那一刀。

## 1 一句话现状

补齐清单（含新增的 G9 共 25 项）：**21 项已补、1 项补了等价物（G1 换成候选收件箱）、
2 项设计决定不补（U3 / U6）、1 项等真账号（S5，用户已拍板暂缓）**。
另有**三层**有意没做的差异（B 表：常驻主会话、队友工具继承、手机档）——那是清单项内部的一层，
不占编号，别与上面 25 项的分母混起来。
第二轮（`c6c71545` 起的 7 刀）把上一轮遗留的三处「有单测但没跑过真链路」全部在真宿主走通，
并顺带补出三个设置面缺口（`evalMode` / `workerModel` / `workerBlockedCommands`，见 §2.1）。
剩下的是：B 表三层差异、S5 真账号验收（只能人做）。

## 2 已完成

### 2.1 第二轮（`c6c71545` 起的 7 刀）

| commit | 内容 |
| --- | --- |
| `c6c71545` | docs：backlog G2 状态行回填为已补（上一轮交接 §3-C 指出的文档不一致） |
| `5cd6e654` | **S4 拍板落地**（用户定：不进运行时依赖清单）：设置页 `feishuCli` help 与体检项 fix 写明装法（`npm install -g @larksuite/cli`）；设计文档 §16.8 与 backlog S4 回填 |
| `a4803cdd` | **查漏补缺**：对照原型 `dsh-superagent-prototype` 全量对照 78 个文件，发现并补上设置面两个缺口——`workerModel`（对齐上游 `executor.model`；执行器的 `WorkerModel` 路由早已备好、装配处写死 null）与 `workerBlockedCommands`（对齐上游 `executor.blockedCommands`；注入位早已有、装配处不传） |
| `7ed0f6b2` | docs：backlog 加 G9 条目；G8 补文案组织差异说明 |
| `e36cb6a9` | **G1 最后一环**：设置面补接单模式 `evalMode`（observe/auto/off）。此前 `defaultSettings` 把 `eval.mode` 写死 observe（P0 时代取舍），候选收件箱做出后配置面没跟上——`confirmInferred` 开了也没有候选进得去（非 auto 下降级成 would_accept） |
| `054e6d8b` | **D 表第一条验收**：`scripts/superagent-candidate-e2e-test.mjs`，候选收件箱全链路 22 条断言全绿（假 lark-cli 走产品的 `feishuCli` 口子 → 真飞书来源 → 真准入闸 inferred → 真判定器 → 候选落库 → 接单/忽略两颗钮 → 工单交付） |
| `546ae2c8` | **D 表第二三条验收**：`scripts/superagent-worker-e2e-test.mjs`，后台作业 + 子智能体真 worker 链路 19 条断言全绿（`run_in_background` → 等静默 → 作业完成唤醒 → `job_output` 读到；`subagent spawn` → 队友真回话 → 名册落盘 → 收队友） |

### 2.2 第三轮（`53ba3f26` 起的 3 刀，用户拍板「边缘小项也要补」）

| commit | 内容 |
| --- | --- |
| `53ba3f26` | 设置面补判定超时 `evalTimeoutSeconds`（30–600，默认 120；对齐上游 `eval.timeoutSeconds`）——defaultSettings 第四参，现读，下一拍生效 |
| `7683794f` | 体检项加第四项 `superagent/teammates`：`subagent` 插件启没启用（它默认关，不启用时收队友静默短路）；条目缺失或 disabled 都报 warn 并指路插件中心 |
| `8fa530e6` | 设置变更历史（对齐上游 `app/settings-history.ts`）：store schema v4 加 `settings_history` 表（一行一字段、写侧裁 30 条）；save 包装成「写盘且值真的变了才记」；快照面加 `settingsHistory?` 可选格；设置页底部「最近变更」块 |

### 2.3 上一轮（13 个 commit，`dd969c67` 起）

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

### 2.4 全部 25 项进度

`✅` 已补 / `🟡` 补了等价物（换了实现方式）/ `🧭` 设计决定不补 / `⏳` 等真账号（代码已就位）。

| 编号 | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| G1 | 常驻主会话编排器 | 🟡 | 换成候选收件箱：`093e1569` + `6c2d975e`（表）+ `861b2b3c`（指纹）。**没有造常驻主会话**，与上游的差别见 §3-B |
| G2 | 持久化 effect 队列 | ✅ | `effects.ts` 418 行已接进执行器与运行期（`runtime.ts:427/457/1134`、`executor.ts:858/871`）。状态行已随 `c6c71545` 回填 |
| G3 | 执行器后台任务 | ✅ | `44e98761`（`ctx.jobs`）+ `833c7fe5`（三件工具）+ `bf33da1b`（等静默） |
| G4 | 执行器 prepare 命令 | ✅ | 设置项 `prepareCommand` + 建树后执行，10 分钟超时，失败判 failed 不重试 |
| G5 | 执行器网络抖动重试 | ✅ | `transient()` 判据 + 回合内重试（3 次，15/30/60 秒退避，同一会话继续） |
| G6 | 执行器子智能体 | ✅ | `dd969c67`（会话登记）+ `8a0d08ff`（白名单、归属、收队友）。**队友不继承父会话工具**，见 §3-B |
| G7 | 报告语义补齐 | ✅ | `superagent_report` 工具（state / summary / question），报告经 `worker.reported` 覆盖回合默认 `ready` |
| G8 | 提示词外置 | ✅ | `prompts/worker.md` + 构建脚本拷两个落点 + 运行时读文件缓存 + 内置兜底 |
| S1 | GitHub 线程上下文 | ✅ | `runtime.threadContext()` 读窗口并渲染，判定器提示词加「上下文」一节；硬上限 15 秒 |
| S2 | GitHub 订阅线程轮询 | ✅ | `runtime.subscribedThreads()` + `source.pollThreads()`，每线程独立游标 |
| S3 | 飞书新群自动发现 | ✅ | `+chat-list` 每轮刷新群清单（补收侧）。真正卡住「@ 一次建不出工单」的是 S6 |
| S6 | 飞书来源没进准入表 | ✅ | 补 `feishuAllowed` + 登记 + `scope` 分支。**待真账号验收** |
| S4 | `lark-cli` 打包 | ✅ | 已拍板（2026-11-14）：不进运行时依赖清单；设置页与体检项写明装法 `npm install -g @larksuite/cli`（`5cd6e654`） |
| S5 | 真账号验收 | ⏳ | GitHub / 飞书都要真账号，只能人做。用户已拍板暂缓 |
| U1 | 停用界面包时复位页面 | ✅ | `ui-sessions` 对任意整页判断「启动图里还有没有人报名」 |
| U2 | 详情页转录自动刷新 | ✅ | `working` / `idle` 时每 5 秒静默重读，已结束与等人档位不轮询 |
| U3 | `branch` / `changedFiles` | 🧭 | 不是移植缺口（上游没有这两个字段）。`branch` 零成本可补，`changedFiles` 要单独立项 |
| U4 | 概览页 | ✅ | 四页签 + 三格计数 + 最近动态 + 空态（本轮又加了「待确认」块） |
| U5 | 来源页 | ✅ | 契约加 `SuperagentSourceView` / `sources?`，概览页底部显示两来源轮询状态 |
| U6 | 手机档 | 🧭 | 是「整页」范式的代价，不是漏做，见 §3-B |
| O1 | 安装向导 | ✅ | 仓库路径为空时快照面返回 `problem.code = 'repo_missing'`，界面画黄条不挡页面 |
| O2 | 机器校验 | ✅ | 体检项 `superagent/dependencies`：git 与 lark-cli 各跑一次 `--version`，缺失记 `warn` |
| O3 | 构建与测试门禁 | ✅ | `scripts/superagent-e2e-test.mjs`，24 条断言，落 `check-core` |
| O4 | 崩溃恢复：出站消息 | ✅ | outbox `state` 列 + `claimOutbox` / `finishOutbox` + 开库把残留 `sending` 改回 `pending` |
| G9 | worker 模型与禁令名单 | ✅ | 第二轮查漏补出：设置面 `workerModel`（空=跟随选路）与 `workerBlockedCommands`（只进系统提示词）；上游的 worker-bin shim 强制层在 DSC 无对应物（`a4803cdd`） |

### 2.5 backlog 里的逐项做法

每项的「上游怎么做 / 补的话动哪 / 验收 / 值得补吗」在 [`backlog.md`](backlog.md)，本表只给状态与证据。

## 3 未完成清单

### A 等真账号（代码侧已就位，用户已拍板暂缓）

| 项 | 缺什么 | 为什么不是我们的活 |
| --- | --- | --- |
| **S5 真账号验收** | GitHub 仓库 + `GITHUB_TOKEN`；飞书自建应用 + 5 个 IM 权限 + 长连接订阅 | 只能人操作账号。离线侧：包级用例 15 + 6 + 10 + 9 条已跑通；候选收件箱链路已有假 CLI 全链路 e2e 覆盖 |

### B 有意没做的一层（不是漏项，是设计差异）

| 项 | 上游怎么做 | 我们怎么做 | 要补的代价 |
| --- | --- | --- | --- |
| **G1 常驻主会话** | 主会话的模型替人点头（`orchestrator_eval_decide`） | 候选落进 `candidate` 表，**人点按钮** | 要新建隐藏会话 + 工具可见性隔离；`tools.project` 只能做减法，做不了「只给某类会话加工具」 |
| **G6 队友工具交集** | 孙代理继承 worker 的工具与权限（`app/sessions.ts:303-312`） | 队友工牌来自角色文件，不继承父会话 | 要改共用包 `subagent` 的工具挑选逻辑，影响所有会话 |
| **U6 手机档** | — | 侧栏收起、56px 窄栏不出现、整页顶掉对话区 | 是 §8.5「整页」范式的代价；要改就得重选界面范式 |

### C 查漏时确认的边缘差异（第二轮定性 6 项，第三轮按用户拍板补掉 3 项）

对照原型 `D:\code\dsh-superagent-prototype` 全量对照 78 个源文件（`src/app` 32 + `src/core` 18 + `src/sources` 15 + 顶层）：

| 项 | 结果 |
| --- | --- |
| `app/settings-history` + `app/versions` | **已补（第三轮 `8fa530e6`）**：按 DSC 逐字段保存裁成一行一字段，快照面 + 设置页「最近变更」块 |
| `eval.timeoutSeconds` 可配 | **已补（第三轮 `53ba3f26`）**：设置面 `evalTimeoutSeconds`（30–600，默认 120） |
| subagent 未启用的体检提醒 | **已补（第三轮 `7683794f`）**：体检项 `superagent/teammates`（order 103） |
| `app/cache` / `app/links` / `app/resources` | 不补：LRU 缓存 + 飞书链接解析 + `orchestrator_read` 分页资源，全是常驻主会话的工具面，依附 G1 有意不做的那一半；DSC 用工单文本 + 判定器 `threadContext`（S1）替代 |
| `app/skill-files` 的两个内置 SKILL.md | 不补：教 worker 用 `orchestrator_read` 读源头，依附 G1；「读到 ≠ 被授权」的礼仪在 DSC 由准入闸强制 |
| prompts 15 个文件按角色拼装 | 不补：文案组织差异，并入 `worker.md` 定稿（设计文档 §6.2.1）；orchestrator / dispatch / admission 三段依附 G1 |
| 上游 save 时校验角色模型（`resolveRoleModel` 抛 `modelUnavailable`） | 不补：填错 provider 时 worker 请求在 `routeFor` 当场抛错（回合失败，可归因），判定器退回同步规则；两级兜底都不炸宿主 |

### D 第二轮已清空

上一轮的三条「有单测但没跑过真链路」全部验完（见 §2.1 的 `054e6d8b` / `546ae2c8`），探针永久留在
`scripts/`（`superagent-candidate-e2e-test.mjs` 22 条、`superagent-worker-e2e-test.mjs` 19 条，都进 `check-core` 门禁）。

## 4 接手必须知道的六个机制

1. **worker 会话是「幽灵会话」**：执行器自己 `Session.create`（`executor.ts:1086`），紧接着 `attachSession`（`:1097`），不进 `ctx.agent` 的常驻名册。靠 `attach` / `detach` 让内核认得它。`hasAgent` 与 `followup` **仍然只认常驻名册**——别顺手把它们改成查 `attached`，那会导致「对一个没有 MiniAgent 的会话调 followup」。
2. **候选收件箱只在 `auto` 模式下有内容**：`assessmentOutcome` 在 `mode !== 'auto'` 时把推断强度的 accept 降成 `ignore`（`core/policy.ts` 的 `observed` 分支）。默认设置是 `observe`。第二轮补了 `evalMode` 设置字段（`e36cb6a9`）后这个模式**可调了**，但默认仍是 `observe`——「开了 `confirmInferred` 却什么都没有」先看判定模式。
3. **等作业静默是轮询**：`settleBackground` 每 `backgroundPollMs`（默认 500ms）查一次 `ctx.jobs.running`。没走事件，因为作业表只提供查询。要改事件得先给 `JobTable` 加订阅。
4. **子智能体查不到父会话就抛错**：`subagent/index.ts` 的 `subagentTool().run` 不再回落 `ctx.session.current()`。回落会把队友派到用户正看着的会话名下（名册、额度、任务板全错）。这条是**故意**的，别改回去。
5. **`confirmInferred` 默认关**：判定器在构造时就定了形状，改它要重开宿主（与 `assessorModel` 同一条取舍）。`evalMode` 走 `settings()` 回调现读，改完下一拍生效，不必重启。
6. **`subagent` 插件默认关**：收队友（`ctx.get('team')`）与 spawn 都要求它启用；不启用时执行器那一支静默短路（`hostFromContext` 拿到 undefined），派工照常。e2e 验队友链路要在 `plugins.json` 里显式启用它（`546ae2c8` 的探针就是这么做的）。

## 5 门禁（在第三轮最后一次源码改动 `8fa530e6` 上跑过）

```sh
pnpm run build                     # exit 0，79 个功能包
node scripts/package-tests.mjs     # 91 包 / 121 用例 / 693 断言 / 0 失败
pnpm run check:ui                  # 79/79
pnpm run check:plugin              # 换包 e2e 17 PASS / 0 FAIL
node scripts/check-core.mjs        # 124/125（816.7s / 841.6s 两次）——唯一失败每次不同，见下
node scripts/superagent-e2e-test.mjs           # 24/24
node scripts/superagent-candidate-e2e-test.mjs # 22/22（复跑稳定）
node scripts/superagent-worker-e2e-test.mjs    # 19/19（复跑稳定）
```

**check-core 的那 1 条失败与本轮无关，但「是哪一条」每次不同**：

- 本轮实测两次：一次是 libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
  （某条脚本在输出完全部 PASS 之后、进程退出时崩），一次是 `session-picker-mouse-test.mjs`
  的 TUI 选择器用例整串挂（「选择器打开且带全量条数」往下全 FAIL）。
- 这两条**单跑都绿**：`sandbox-win-token-test.mjs` 86 通过 / 0 失败（含那条 conin 用例）、
  `session-picker-mouse-test.mjs` 全 PASS。
- 上一轮在同一分支上 check-core 是 **123/123 全绿**（898.6s）。

定性：TUI / 终端 / pty 层在「当前会话的终端环境」下的浮动失败，与 superagent 包零交集
（本轮改动面 = superagent 包 + locale + 文档 + 三条 e2e 探针）。

**别把某一次的具体失败名当成结论**——第一次看到的是 conin，第二次就换成了 TUI 选择器。
**判断方法**：看失败段里 `── <file> ──` 的文件名，再单跑它
（`node --import ./scripts/_i18n-alias.mjs scripts/<file>`）。单跑绿就是环境浮动，不要顺着
失败信息去改那块的代码。

单跑某条探针要走 `--import` 钩子（否则界面模块的 `@dsc/ui` 别名解析不了）：

```sh
node --import ./scripts/_i18n-alias.mjs scripts/<name>-test.mjs
```

## 6 环境注意

- **跑 `pwsh` 工具会在仓库根生成 `Microsoft/Windows/PowerShell/ModuleAnalysisCache`**。这是 PowerShell 的模块分析缓存，不是项目产物，删掉即可（`Remove-Item -Recurse -Force D:\dsc\Microsoft`）。每次跑完 `git status` 看到它别当成自己产生的。
- 工作区里 `docs/development.md` 的 3 行改动、`docs/superagent/shots/`、`docs/superagent/space-demo.html` **不是本轮产生的**，别顺手提交。
- `node --test` 默认 spawn 子进程会 EPERM（沙箱），单文件跑要加 `--test-isolation=none`；多文件同进程会串 `DSC_HOME`，整包用 `scripts/package-tests.mjs`。

## 7 建议的接手顺序

1. **没有待办的功能缺口了**。第二轮把上一轮的 D 表三条全部走通、查漏补出的设置面缺口全部补上。
2. S5 真账号验收等用户提供账号（拍板过暂缓）；B 表三项别再动，除非用户明确要换架构。
3. §C 表的边缘差异若用户想补，按「单独立项」做（settings-history 最有内容，其余都是 minutes 级）。

## 8 相关文档

| 文档 | 看什么 |
| --- | --- |
| [`backlog.md`](backlog.md) | 25 项补齐清单（含 G9），每项有现状 / 补法 / 验收 |
| [`../superagent-design.md`](../superagent-design.md) | §11 与上游差异表；§15 第 11 步实施记录 |
| [`../../src/packages/superagent/README.md`](../../src/packages/superagent/README.md) | 宿主包现状：五处装配面、工作链路、Known Limitations |
| [`../../src/packages/ui-superagent/README.md`](../../src/packages/ui-superagent/README.md) | 界面包四页签，「待确认」块怎么接 |
