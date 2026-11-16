# 逐文件移植计划（对齐 dsh-superagent 源码）

本文是 [superagent-design.md](superagent-design.md) §17 之后的**重构计划**：把已经实现的部分按上游源码逐文件核对，凡「我们自己重写」的，改回对齐上游；未实现的部分也按同一口径补。

## 0 口径（两句）

1. **不依赖 DSH 的文件：逐字移植。** 只改 import 路径，逻辑一行不改；文件头列出全部改动点。
2. **依赖 DSH 的文件：原生重写。** 照上游同一个文件的模块边界、函数划分、判定顺序与语义，用 DSC 原生 API（MiniAgent / `Session` / `ctx.jobs` / `ctx.get('llm')` / RPC 白名单）实现。

**禁止写包装层**：不允许「上游文件原样留着 + 一层把 DSH 调用映射到 DSC 的胶水」。依赖 DSH 的模块就在 DSC 里写成原生模块，只是它的结构与语义必须对得上下游那一份。

### 0.1 目录口径：包内镜像上游 `src/` 结构

新移植的代码按上游路径**原样落位**在 `src/packages/superagent/` 下，不套 `adapters/` 前缀：

- 上游 `src/sources/kind.ts` → `src/packages/superagent/sources/kind.ts`
- 上游 `src/app/runtime.ts` → `src/packages/superagent/app/runtime.ts`
- 上游 `src/infra/text.ts` → `src/packages/superagent/infra/text.ts`
- 上游 `src/kv.ts`、`src/deployment.ts`、`src/setup.ts` → 包根同名文件

这样**除扩展名 `.js` 与两处路径外，import 行与上游逐字相同**，审查时 `diff` 上游文件与我们的文件只该有：文件头注释、`.js` 扩展名、`policy`/`limits` 两个路径（上游在 `src/` 根，本仓在 `core/`）。

旧实现（`index.ts`、`runtime.ts`、`service.ts`、`surface.ts`、`tools.ts`、`main-tools.ts`、`paths.ts`、`health.ts`、`commands.ts`、`adapters/**`）在切换批之前**原地不动**，与新树并存；切换批删旧树、把包入口接到新树。

**过渡缝**（新树里暂时借位的类型/函数，最终必须消掉）：

| 缝 | 位置 | 消除批次 |
| --- | --- | --- |
| `SourceAgent = unknown`（上游是 dsh 的 `Agent`） | `sources/host.ts` | P9-G/J |
| `Key`/`Family` 本地别名（上游在 `kv.ts`） | `sources/host.ts` | P9-C |
| `workerSessionId` 暂借旧 `adapters/executor.ts` | `app/cards.ts` 等 | P9-J |

---

## 1 全量分类（69 个非核心文件）

| 类别 | 文件数 | 行数 | 处置 |
| --- | --- | --- | --- |
| 不 import `@deepseek-ai/*` | 47 | 约 4,706 | **逐字移植** |
| import `@deepseek-ai/*` | 22 | 4,187 | **原生重写**（见 §2） |

上游核心 `src/core/` 15 文件 2,028 行已经在 `core/` 里逐字存在（`part.ts` 多 4 行），本计划不动。

---

## 2 依赖 DSH 的 22 个文件（原生重写清单）

### 2.1 只需换掉类型或一行 apply 的（6 个，改造量小）

| 上游文件 | 行数 | 依赖 | 改造要点 |
| --- | --- | --- | --- |
| `index.ts` | 26 | cordis, dsh-settings | 我们是 cordis 宿主，`apply` 结构照搬；插件注册换成 DSC 的 `ctx.provide` / `registerSection` |
| `sources/github.ts` | 457 | cordis | 只有 `apply` 一行是宿主；轮询、触发、解析全部逐字，`ctx.orchestrator.sources` 换成我们的注册表服务 |
| `sources/feishu.ts` | 137 | cordis | 同上 |
| `app/settings.ts` | 263 | cordis | 块模型照搬；`ctx.settings` 换成 DSC 的设置服务 |
| `app/setup.ts` | 96 | cordis | 部署检查照搬；`ctx` 换成我们的设置与来源注册表 |
| `sources/kind.ts` | 112 | dsh-agent | 只有图片读取的 `Agent` 类型；换成本仓的执行体类型 |

### 2.2 需要按 DSC 宿主原生重写的（16 个）

| 上游文件 | 行数 | DSH 依赖 | 上游职责 | DSC 原生对应物 |
| --- | --- | --- | --- | --- |
| `executor/dsh.ts` | 670 | agent, session | 派工、准备目录、投递、报告、停止、恢复 | `adapters/executor.ts`（已有实现，按上游结构重构） |
| `executor/background.ts` | 156 | agent, session | 回合结束后等后台作业静默、到点杀 | `ctx.jobs` + 我们现有的轮询实现 |
| `app/sessions.ts` | 348 | agent, session, llm, scope | 建会话、preset、路由、通知中继 | `Session.create` + 会话元数据 |
| `app/runtime.ts` | 252 | 11 个 DSH 包 | 装运行期：锁、泵、来源启停、权限预设 | 我们的 `runtime.ts`（已有），按上游结构重构 |
| `app/delivery.ts` | 83 | agent, session, persistence | 把触发投给会话、投递失败记账 | `followup` + 工单记账 |
| `app/role-models.ts` | 42 | agent, llm | 角色模型选择（主会话 / 执行者） | `ctx.get('llm')` + 设置里的模型名 |
| `app/assessment.ts` | 278 | agent | 用会话做判定：载入上下文、读消息、记结论 | 我们现有的 `assessor-model.ts`，按上游结构与提示词重构 |
| `app/resources.ts` | 303 | session | 给模型读资源（工单、消息、图片、文件）分页 | 我们的快照面 + `superagent_read` 资源（已有，按上游资源清单补齐） |
| `app/tools/main.ts` | 300 | agent | 主会话工具 | `main-tools.ts`（已有），按上游逐工具重构 |
| `app/tools/executor.ts` | 103 | （见工具层） | worker 工具 | `tools.ts`（已有），同上 |
| `app/http.ts` | 243 | webserver, controller | DSH 面板的 HTTP 服务 | **不移植**：DSC 走 `INVOKABLE_METHODS` + 快照面 |
| `app/api.ts` | 50 | session controller | 面板 API 的会话入口 | 我们的 RPC（`packages/runtime`） |
| `navigation.ts` | 21 | session controller | 从面板跳到某会话 | DSC 的会话导航（`ui-sessions`） |
| `app/context.ts` | 28 | session | 面板上下文 | 我们的插件上下文 |
| `deployment.ts` | 123 | subprocess, schemastery | 解析账号 / 仓库 / stateDir，跑检查命令 | 我们的设置读取 + `cli-run` |
| `infra/environment.ts` | 147 | subprocess | 执行环境变量 | 我们的执行器环境变量 |
| `sources/feishu-image.ts` | 52 | agent, attachment, llm | 读飞书图片给模型看 | 飞书 `image.ts` 已有；附件读取按 DSC 会话能力接 |

（表里 17 行：`app/tools/executor.ts` 本身不 import DSH，但它的宿主在 `main.ts` 的同一层，同批处理。）

---

## 3 我们现有文件 → 上游对应

| 我们现在的文件 | 行数 | 上游对应 | 处置 |
| --- | --- | --- | --- |
| `core/` 18 文件 | 2,302 | `src/core/` 15 + `admission`/`limits`/`policy` | 已逐字 ✔ |
| `main-tools.ts` | 1,243 | `app/tools/main.ts` + `app/resources.ts` + `app/cards.ts` + `app/prompts.ts` | 原生重写（按上游逐工具） |
| `tools.ts` | 615 | `app/tools/executor.ts` + `app/tools/tool.ts` | 逐字（tool.ts）+ 原生重写 |
| `adapters/executor.ts` | 1,599 | `executor/dsh.ts` + `background.ts` + `app/sessions.ts` | 原生重写 |
| `adapters/github/*` | 1,928 | `sources/github*.ts`（5 文件） | 逐字为主 |
| `adapters/feishu/*` | 1,773 | `sources/feishu*.ts`（5 文件） | 逐字为主 |
| `runtime.ts` | 1,151 | `app/runtime.ts` + `passes` + `delivery` + `cache` + `context` | 原生重写 |
| `adapters/effects.ts` | 391 | `app/effects.ts` | 逐字为主 |
| `adapters/dispatch.ts` + `outbox.ts` | 400 | `app/outbox.ts` + `app/delivery.ts` | 逐字 + 原生重写 |
| `adapters/notify.ts` | 135 | `app/notices.ts` | 逐字 |
| `adapters/assessor*.ts` | 471 | `app/assessment.ts` + `app/role-models.ts` | 原生重写 |
| `adapters/store.ts` + `repositories.ts` + `store-read.ts` | 1,214 | `app/store.ts` + `store-read.ts` + `migration.ts` | 原生重写（库结构换成上游 schema） |
| `surface.ts` | 192 | `app/views/*` | 逐字（视图装配） |
| `health.ts` | 395 | `infra/health.ts` + `app/retry-health.ts` | 逐字 |
| `adapters/settings.ts` | 136 | `deployment.ts` + `app/settings.ts` | 原生重写 |
| `adapters/scope.ts` | 54 | `sources/registry.ts` 的 `scope()` | 逐字（并入注册表） |
| `commands.ts` | 239 | `infra/commands.ts` | 逐字 + 原生 |
| `paths.ts` | 43 | `infra/paths.ts` + `deployment.ts` | 逐字 |
| `service.ts` | 216 | `app/api.ts` | 原生重写 |
| `index.ts` | 1,340 | `index.ts` + `cordis.patch.yml` | 原生重写 |
| `prompts/*.md` 2 卷 | 74 | `prompts/*.md` 15 个 | 逐字 |
| `ui-superagent/*` | 2,397 | `client/*` 3,939 行 | 原生重写（DSC 界面运行时） |
| `adapters/worktree.ts` | 268 | 无 | **本仓特有，保留** |
| `adapters/manual.ts` | 82 | 无 | **本仓特有，保留** |

---

## 4 批次清单（按依赖顺序）

统一验收：`pnpm run build && pnpm run build:ui && node scripts/style-check.mjs && pnpm run check:plugin`

| 批 | 内容 | 逐字 | 原生 | 依赖 | 风险 |
| --- | --- | --- | --- | --- | --- |
| **P9-A** | `sources/kind`、`registry`、`host`、`poll`、`admission-context` | 5 | 0 | 无 | 低 |
| **P9-B** | `infra/text`、`infra/health`、`infra/commands`、`infra/environment`、`setup`、`deployment`、`app/execution-environment` | 5 | 2 | 无 | 中 |
| **P9-B2** | `app/settings`、`app/setup`、`app/role-models`、`app/context`、`app/settings-history`（含设置契约补 `rows`/`fact`） | 2 | 3 | A、B | 中 |
| **P9-C** | `kv`、`app/store`、`app/store-read`、`app/versions`、`app/migration`（库结构 → 上游 schema 11 + 迁移链） | 3 | 2 | B | **最高（数据）** |
| **P9-E** | `app/runtime`、`app/effects`、`app/delivery`、`app/outbox`、`app/passes`、`app/retry-health`、`app/cache` | 4 | 3 | A、B2、C | 中 |
| **P9-F** | GitHub 来源包：`sources/github.ts` + 4 配套（删 `adapters/github/*`） | 4 | 1 | A、E | 中 |
| **P9-G** | 飞书包：`sources/feishu.ts` + 5 配套（删 `adapters/feishu/*`） | 4 | 2 | A、E | 中 |
| **P9-H** | `app/assessment`、`app/prompts`、`app/skill-files`、`prompts/` 15 个 md | 15 | 2 | B2、E | 中 |
| **P9-I** | `app/tools/tool`、`app/tools/main`、`app/tools/executor`、`app/resources`、`app/cards`、`app/notices`、`app/links` | 5 | 2 | E、H | 中 |
| **P9-J** | `executor/dsh`、`executor/background`、`app/sessions` | 0 | 3 | A、E、I | **高** |
| **P9-K** | `app/views/*`（7 文件 → 快照装配）、`app/http`、`app/api`、`client/locales.ts` 词条 | 7 | 2 | E | 中 |
| **P9-L** | 验收：webhook「只发不收」来源包（不改主包）+ 全链路 e2e + 设计文档收口 | — | — | 全部 | 低 |

### 4.1 推进顺序的理由

先把 `A → B → B2 → C` 做成「新地基」，再按 F/G（来源）、H/I（判定与工具）、J（执行器）、K（视图）替换我们现有的实现，L 收口。

但要**尽早验证**：P9-A/B/B2 完成后，先在**现有** store 与设置上用一个临时构造的 `Settings` 跑一个 webhook 来源包的纵向切片（不改主包任何文件），验证「设置页多一块、准入表多一行、出站接通、体检多一项」这条链路。切片不过就不要继续往下做 C。

### 4.2 实际推进波次（每波结束必须四道闸全绿）

上游模块之间是**类型级环依赖**（`kv` ↔ `store` ↔ `prompts` ↔ `github`），一次只落一个文件必然编译不过。因此按「一层能独立编译的闭包」切波，每波内部并行、波末统一对账：

| 波 | 内容 | 并行子代理 |
| --- | --- | --- |
| W1 | `sources/{kind,host,registry,poll}` | 1 |
| W2 | `infra/{text,health,commands,environment}`、`setup`、`deployment`、`app/execution-environment` | 1 |
| W3 | 旧树迁到镜像布局 + `kv`（3 处类型缝）+ `sources/admission-context` + 过渡缝对账 | 1 |
| W4 | GitHub 来源包 5 文件 ∥ 飞书来源包 6 文件 | 2 |
| W5 | `app/{effects,outbox,passes,retry-health,cache,cards,links,notices}` | 1~2 |
| W6 | `app/{prompts,skill-files,context,settings-history,source-context,settings,setup,role-models}` + `prompts/*.md` 15 个 | 2 |
| W7 | `kv` 去缝 + `app/{store,store-read,versions,migration}`（数据迁移，单独提交） | 1 |
| W8 | `app/{runtime,delivery,assessment,resources,tools/*,views/*}`、`executor/*`、`sessions` | 2~3 |
| W9 | 切换包入口：删旧树、`index.ts` 接新树、全量回归 | 1 |
| W10 | webhook「只发不收」纵向切片 + 面板词条 + 文档收口 | 1 |

**不移植**（本仓已有等价能力，或 DSC 不该有）：`infra/paths.ts`（本仓 `paths.ts` 由构建脚本注入包根）、`navigation.ts`（DSC 会话导航）、`app/http.ts`、`app/api.ts`（DSC 走 `INVOKABLE_METHODS` + 快照面）、`app/context.ts` 的 HTTP 部分。

---



1. **P9-C 数据迁移**是唯一碰用户已有库的一批：迁移前先复制库文件，测试覆盖「旧库 → 新库 → 旧功能仍可用」；迁移失败时插件拒绝启动并给可读原因，不做半迁移。
2. **P9-F / P9-G 会删掉 3,700 行现有适配器**：删前打 tag，每批单独提交，可按批回滚。
3. **P9-B2 动设置契约**（补 `rows` / `fact` 字段类型）：界面与内核同时编译，单独提交，不与其他批并行。
4. 每批由主协调者独立重跑四次验收命令并记录退出码；子代理只负责实现与自测。
