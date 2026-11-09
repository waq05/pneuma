# 批次 07：智能体编排

> 分支 `feat/pluginization`，按 2026-11-09 工作区现状审查。
> **本批次审查的 16 个包与 2 个对照文件全部没有未提交改动**（`git status --porcelain` 的 30 个在途文件是 `src/packages/ui-*` 与 `docs/`）。两处例外：本报告引用的 `src/packages/ui-composer/ui/commands.ts`（未改动）与 `src/packages/ui-team/ui/ui.tsx`（**有未提交改动**，只作只读对照，不审其本体）。
> 只读审查：未修改任何源码，未跑 build / typecheck / 测试。

## 范围

逐行或按段通读：

- `src/packages/agent/index.ts`（360 行，全文）、`session-core/loop.ts`（816 行，全文）、`session-core/prompt.ts`（411 行，全文）
- `src/packages/subagent/index.ts`（1526 行，全文）、`subagent/agent-roles.ts`（仅读 import 面）
- `src/packages/goal/index.ts`（296）、`goal/goal.ts`（237）、`plan/index.ts`（224）、`mode/index.ts`（169）、`todo/index.ts`（240）、`todo/todo.ts`（252）、`waiting/index.ts`（44）
- `src/packages/commands/index.ts`（797）、`commands-core/commands-completion.ts`（263）
- `src/packages/skills/index.ts`（428）、`src/core/skills.ts`（266）、`self-improve/skill-write.ts`（1–600 精读，600–958 只读符号与引用）
- `src/packages/presets/index.ts`（271）、`permission-presets/index.ts`（213）
- `src/packages/prompt/index.ts`（329）、`prompt/tool-result-prune.ts`（83）
- `src/packages/memory/index.ts`（917）、`memory/memory.ts`（按段：295–375、650–760）、`memory/memory-eval.ts`（只读头注释与引用）
- `src/packages/self-improve/index.ts`（1110，按段：106–180、395–600、960–1090）
- `src/packages/image-diet/index.ts`（115）
- 对照：`src/core/team-board.ts`（362 全文）、`src/packages/microcompact/index.ts`（110–180）、`src/packages/transcript/index.ts`（175–215、313–328）、`src/packages/ui-composer/ui/commands.ts`（106 全文）、`src/packages/ui-team/ui/ui.tsx`（120–170、203–229）

全仓检索：`MiniAgent`、`ctx.session.current()`、`dsc/turn-end`、`registerProjection(`、`duringTask`、`memory-eval`、`core/learnings`、`runtime/core/(goal|todo|agent-roles|memory|microcompact|tool-result-prune)\.js`（排除 `node_modules`、`lib`）。

没读：`subagent/agent-roles.ts` 的实现细节（只核了导出名）、`self-improve/ledger.ts` 与 `store.ts` 全文、`memory-eval.ts` 全文（批次 02 已判）、`session-core/hooks.ts` 与 `modes.ts` 全文（只读被引用的 `modeSpec`）。

## 结论摘要

- **P0 2 条 / P1 12 条 / P2 10 条**（共 24 条）
- 最重要的三条：
  1. **「有卡挂着就别自动往下推」这条闸是进程级的，卡片却是按会话的**：`waiting.any` 只看任意一张卡在不在（`waiting/index.ts:29-40`），而 `approval` / `plan` / `ask` 三家都往这张表里塞「本进程里有没有卡」（`approval:1527`、`plan:150`、`ask:239`）。后台会话挂一张审批卡，用户正在看的那个会话的目标自动续跑就永久停摆；切换会话也不会自己恢复。
  2. **`todo` 与 `goal` 的工具不看调用方会话，直接写 `ctx.session.current()`**（`todo:113`、`goal:85`）。常驻多 agent 下后台/队友会话调一次 `todo_write`，清单会写进用户正在看的那条会话的 jsonl，而内存里那份 `TodoStore`（`todo:106`）是全进程一个。
  3. **`subagent/index.ts` 1526 行装了 14 件事**（派活、名册、汇报等待、续跑、一次性小工、事件转发、任务板、审查通道、设置分区……），而同一份「谁在队、什么状态」在宿主与壳里共有 5 份副本（内存 Map、`roster.json`、转录里的子代理卡、快照的 `subagents`、壳侧 3 秒轮询）。

## 问题直答

1. **ReAct 循环只有一份**：`MiniAgent` 在 `session-core/loop.ts:127`，构造点只有两处——`agent/index.ts:82`（主会话）与 `subagent/index.ts:590`（队友）。**循环归 `loop.ts`，会话管理归 `agent/index.ts`**：`agent` 是「会话 id → agent」注册表 + 事件扇出 + 空闲淘汰（`:57-63`、`:190-223`），不发请求、不跑工具。没有第二套「跑一轮」：`ptc` 只是工具执行器（`ptc/index.ts:284` 直接调 `entry.run`），`self-improve`（`:530`）、`goal`（`:240`）、`memory`（`:904`）、`schedule`（`:208`）都通过 `ctx.agent.followup` 借一轮，自己不起循环。唯一像「第二套」的是队友在 `emit` 里数轮次、掐轮、催结论的策略层（`subagent:624-682`），见 P2 那条。
2. **`subagent/index.ts` 1526 行 = 14 件事**（配置、名册、队友运行时、工具表与守卫链、`startTeammate`、收工汇报、`TeamService`、审查通道、`subagent` 工具、任务板工具/提示、工具重挂、设置分区、卸载、名字规则）。拆分边界见 P1 那条（4 个文件/包）。**名册/状态确实各存一份**：内存 Map（`:394`）、`roster.json`（`:323-391`）、转录子代理卡（`:709-731` + `transcript/index.ts:185-203`）、快照 `subagents`（`transcript:315-326`）、壳侧 3 秒轮询（`ui-team/ui/ui.tsx:210-226`）。
3. **五个小包确实都在重复四件套**（表在 P1 那条里，逐包给了行号）。抽「任务面插件骨架」**部分划算**：值得抽的是「设置分区样板」（约 290 行）与「读/写/夹配置」样板（约 120 行）；`surfaces.register` + `commands.register` 本身只有 1–2 行，抽了反而多一层跳转。代价是 `subagent` 的分区有 `groups`/`action`、`memory` 的 `values()` 要现算额度，工厂必须允许透传，否则这三个包得留特例。
4. **命令表一份**（`commands-core/commands-completion.ts:32-78`），**补全/唯一前缀/输入认领各两套**（宿主 `:145-163`、`:201-210`、`:225-247` vs 壳 `ui-composer/ui/commands.ts:48-54`、`:82-105`），**`duringTask` 判定两处**（真闸 `commands/index.ts:116-122`、置灰 `ui-composer:65-67`）。`/review` 的关系是清楚的、只有两条路：命令 handler（`commands:317-372`）→ `review.spawn`（`subagent:932-963`）→ 审查队友 → `deliverReview` 写回；派不出去回落主会话一轮（`commands:368`）。仓内**没有** `dsh_code_review` 这个工具（全仓 0 命中）。
5. **两套校验、一条名字规则抄两份**：宽松解析/装载在 `core/skills.ts:122-180`，严格校验在 `self-improve/skill-write.ts:98-153`；名字正则 `core/skills.ts:30` 与 `skill-write.ts:73` 是同一串字面量。**威胁扫描两套**：`memory/memory.ts:309-349` 与 `skill-write.ts:190-230`（第一条不可见字符集已经分叉）。**`core/skills.ts` 的角色是「真身」**（发现根、frontmatter 解析、启停状态），不是垫片；`packages/skills` 只是插件外壳 + 市场。
6. **两个「预设」被混用，且有实质穿透**：命令 `/preset`（`presets:245-269`）vs `/permission`（`commands:505-537`）；快照 `surfaces.preset` vs `surfaces.permissionPresets`；设置页自绘「模式（预设）」页（`ui-settings/ui/presets.tsx:2`）vs 通用分区里的「权限预设」下拉（`settings/index.ts:227-236`）。穿透在审计：`presets` 为了填 `mode`/`policy` 两个字段 `inject: ['approval','mode']`（`:83`、`:133-141`），`permission-presets` 为了填 `mode` 也 inject `mode`（`:74`、`:134-142`）。
7. **系统提示装配只有一份**：`session-core/prompt.ts:383-411`，唯一调用点 `prompt/index.ts:263-291`。段归属：模型信息段由 `prompt/index.ts:287` 拼（order 890）；AGENTS.md 段由 `session-core/prompt.ts:177-231` + `:403-404` 拼（并入 `# agentsMd` 块）；技能目录段由 `ctx.skills.catalogText()`（`prompt/index.ts:283`）交给 `session-core/prompt.ts:409`。`core/model-caps.ts` **不拼提示词**，它只声明能力（窗口/模态/思考档位），供 `llm` 判档位。唯一的第二套在队友那里（`subagent:602-616`）。
8. **两条链路确实重叠**：`memory/index.ts:878-909` 与 `self-improve/index.ts:559-582` 都是「读会话 → 判值得记 → `agent.followup` 起一轮复盘」，各自维护一个「这轮是我起的」标记（`memory:210` 布尔 vs `self-improve:561` 会话状态），互不相识。`core/memory-eval.ts` 垫片**没用了**：批次 02 已判「无引用、可删」（见 `02-plugin-runtime.md` 重复逻辑表第 18 行），本批次只补交叉引用。
9. **三条都在改请求体**：`image-diet`（order 550，`prompt/index.ts:208-215`）、`tool-result-prune`（560，`:194-197`）、`microcompact`（650，`microcompact/index.ts:119-162`），另有 `drop-images`（900，`:218-221`）。**顺序只由 `prompt/index.ts:129-132` 的排序保证**（order 相同按 id），依据是散在 6 处注释里的口述理由，没有探针钉住最终顺序。

## 按插件分节

### session-core/loop.ts（ReAct 循环的唯一归属）

#### [P2] 循环只有一份，但「一轮怎么跑」的策略另有一层叠在事件上

- 位置：`src/packages/session-core/loop.ts:333-403`（`runTurn`）、`612-691`（`executeToolCalls`）、`src/packages/subagent/index.ts:624-682`（`emit`）
- 现象：引擎只有一个，构造点只有两处（`agent/index.ts:82`、`subagent/index.ts:590`），`ptc` 只是工具执行器（`ptc/index.ts:284` 直接 `entry.run(...)`，不碰 `ctx.llm.stream`），`self-improve` 也不自带循环（`:530` 走 `ctx.agent.followup`）。但轮次计账、到点掐断、最后一轮收工具、催结论、判定「收工了」全写在队友的 `emit` 回调里——这是循环之上的第二层回合策略，用事件拼出来的状态机。
- 证据：

  `src/packages/subagent/index.ts:634-643`
  ```ts
              if (teammate.rounds >= budget) {
                if ((event.toolCalls?.length ?? 0) > 0) teammate.agent.cancel()
              } else if (teammate.rounds === budget - 1) {
                teammate.finalRoundPending = true
                teammate.agent.followup('下一轮是最后一次，直接给结论，不要再调工具', undefined, 'notice')
  ```

  `src/packages/session-core/loop.ts:181-183`
  ```ts
    get busy(): boolean {
      return this.turnActive || this.pendingTurn
    }
  ```
- 影响：循环的 `busy` / `pendingTurn` 与队友的 `rounds` / `finalRoundPending` / `awaitReport` 是两套「现在算不算干完了」的判据。要改「一轮的边界」，得同时改这两处；以后谁再写第二个消费者（比如给 `schedule` 或 `ops` 加轮次预算），就会长出第三套。
- 建议：把「轮次预算 + 到点收工具 + 催结论」做成 `AgentDeps` 的一个扩展点（`budget?: { maxRounds, onFinalRound }`），由循环在 `requestOnce` 前后统一判；`subagent` 只传参数，不在 `emit` 里数数。
- 置信度：高（两个文件全文读过）

### agent

#### [P2] `agent/index.ts` 360 行承担 5 类职责，事件扇出全塞在一个 `emit` 回调里

- 位置：`src/packages/agent/index.ts:103-161`（`emit`）、`272-285`（`deliverToDormant`）、`287-357`（`AgentService`）、`190-223`（收摊与空闲名册）
- 现象：一个文件同时是「会话 → agent 注册表」「事件扇出总线（dsh 桥、用量 JSONL、工具耗时 JSONL、回合起止广播、转录归属闸）」「休眠会话投递器」「空闲淘汰器」「服务门面」。`emit` 一个回调 59 行，里面并排 5 件互不相干的事。
- 证据：

  `src/packages/agent/index.ts:110-112`
  ```ts
            if (event.type === 'usage') {
              appendUsageRecord({
  ```

  `src/packages/agent/index.ts:158-160`
  ```ts
            if (active !== null && active.sessionId === session.meta.id) {
              ctx.transcript.emit(event, session.meta.id)
            }
  ```
- 影响：给事件加一个消费者（比如「工具耗时要按会话记」）就要动这个 59 行的回调；用量记账（`:110-135`）与工具耗时记账（`:138-142`）本来各是独立插件就能做的事，现在跟注册表挤在同一文件里。
- 建议：把 `usage` / `tool/result` 两条记账拆成 `usage-ledger` 小插件，只 `ctx.on('dsc/turn-event')`；`agent` 只留注册表 + 归属闸。
- 置信度：高（全文读过）

#### [P2] 「状态条目按 hash 去重」这套写法有两份

- 位置：`src/packages/agent/index.ts:39-43`（`noteSystemPrompt`）、`src/packages/prompt/index.ts:325-329`（`noteEnvFacts`）
- 现象：两处都是「sha256 前 16 位 → 跟会话状态里那条比 → 不一样才 appendState」，注释互相点名（「与 agent 插件的 system-prompt 条目同套做法」），但代码各写一份。
- 证据：

  `src/packages/agent/index.ts:40-42`
  ```ts
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
    if (session.state('system-prompt')?.hash === hash) return
    session.appendState('system-prompt', { hash, text })
  ```
- 影响：这是「模型可见 ⟺ 日志可重建」的落盘协议，两份实现意味着以后改指纹长度或加字段（比如带时间戳）要改两处，漏一处就出现「提示词变了但日志没记」。
- 建议：抽 `Session.appendStateIfChanged(key, text)`（hash 去重内置），两处都调。
- 置信度：高

### subagent

#### [P1] `subagent/index.ts` 1526 行装 14 项职责，是标准的上帝模块

- 位置：`src/packages/subagent/index.ts`（全文），关键分区：`300-320` 配置、`322-391` 名册持久化、`393-442` 队友运行时与 `settle`、`448-529` 工具表与守卫链、`531-732` `startTeammate`（含 MiniAgent 装配）、`745-810` 收工汇报、`812-915` `TeamService`、`917-1006` 审查通道、`1065-1182` `subagent` 工具参数处理、`1216-1337` 任务板工具、`1385-1514` 设置分区
- 现象：一个 `apply()` 里并排 14 件事，其中至少 4 件与「派活」没有直接关系：审查通道、共享任务板、侧栏服务、设置分区。文件里还有 3 个不同层级的「工具」概念（`subagent` / `team_task` / 给队友改写的 `subagent` 转发版 `toolsFor:460-469`）。
- 证据：

  `src/packages/subagent/index.ts:195-198`（一个 `Teammate` 接口里同时装运行业绩、UI 瀑布、等待者、预算状态）
  ```ts
    /** 输出瀑布的行池（最新在后，只留 8 行；正文行与工具结果首行都进）。 */
    outputLines: string[]
    /** 当前（或最后一把）工具，画内联卡的「当前工具行」。 */
    lastTool?: { name: string; status: 'running' | 'done' | 'failed' }
  ```

  `src/packages/subagent/index.ts:917-921`（审查通道就住在派活包里）
  ```ts
    // ── 只读代码审查通道（T45）─────────────────────────────────────────────
    // /review 的升级路径：派一个工牌被强制压到只读交集的队友
  ```
- 影响：任何一处要改（换名册格式、加一种队友状态、改审查任务书）都要在 1500 行里找位置，且改动会牵动无关的三块。角色文件格式（`agent-roles.ts`）与派活逻辑已经分家，说明拆分是可行的。
- 建议：按现有自然缝切成 4 个文件/包，边界如下：
  1. `team-runtime`（`393-442`、`531-732`、`745-810`）：队友本体、等待、汇报；只暴露 `start / waitForIdle / stop / message`
  2. `team-tools`（`1065-1214`、`1216-1337`）：两个工具的参数解析与中文错误文案，纯函数化（现在 `runSubagent` 直接摸 `teammates` Map）
  3. `review-channel`（`917-1006` + `core/git-info.ts:239-428`）：独立成 `packages/review`
  4. `team-ui`（`812-915` + `1385-1514`）：`TeamService` 与设置分区
- 置信度：高（全文读过）

#### [P1] 「谁在队、什么状态」有 5 份副本，失效逻辑分散

- 位置：`src/packages/subagent/index.ts:394`（内存 Map）、`323-391`（`~/.dsc/team/roster.json`）、`709-731`（`forwardSubagent` → 转录里的 `subagent` 卡）、`src/packages/transcript/index.ts:185-203`（切回会话时按 `team.list()` 重新种卡）、`315-326`（`RuntimeSnapshot.subagents` 给状态栏）、`src/packages/ui-team/ui/ui.tsx:207-228`（壳侧 3 秒轮询副本）
- 现象：同一份「队友名册」在宿主内存、磁盘 JSON、转录条目、快照、壳侧 store 各存一份。状态判定（僵尸 `working` 读作 `stopped`）只有一处实现（`:830`），但转录与壳各自拿到的是 `list()` 的投影，**它们看不见这个判定的来历**，只能照抄结果。
- 证据：

  `src/packages/subagent/index.ts:830`
  ```ts
              state: live !== undefined ? live.state : record.state === 'working' ? 'stopped' : record.state,
  ```

  `src/packages/transcript/index.ts:186-187`
  ```ts
        for (const mate of ctx.get('team')?.list() ?? []) {
          if (mate.state !== 'working' || mate.sessionId !== current.meta.id) continue
  ```
- 影响：改一次状态语义（比如加 `awaiting-input`）要同时改：`TeammateState`（`:132`）、`RosterRecord`（`:229-251`）、`TeammateView` 投影（`:824-841`）、转录种卡（`transcript:188-201`）、快照（`transcript:325`）、壳的 `STATE_LABEL`（`ui-team/ui/ui.tsx:74-77`）。漏一处就是「名册说在跑、卡片说收工」。
- 建议：让名册只有一份权威源（宿主的 `team.list()`），转录与快照只存 `name + 指针`，状态一律现问；壳侧轮询改成订阅 `dsc/changed`。同时把「僵尸 working → stopped」升成 `list()` 的契约字段 `stale: true`，让所有消费方读同一个判定。
- 置信度：高（6 处都读过）

#### [P1] 子代理的系统提示是另起一套装配，队友拿不到 AGENTS.md、技能目录与工具规范

- 位置：`src/packages/subagent/index.ts:602-616`（模板字符串直拼）、对照 `src/packages/session-core/prompt.ts:383-411`（`buildSystemPrompt`）、`src/packages/prompt/index.ts:282-291`
- 现象：主会话的系统提示走 `buildSystemPrompt`（identity / behavior / tool-rules / 插件段 / AGENTS.md / 技能目录 / 模型信息），队友的走一个模板字符串，只有「角色正文 + 环境事实 + 团队位置 + 授权说明」。所以队友读不到项目说明书，也看不到技能目录。
- 证据：

  `src/packages/subagent/index.ts:602-605`
  ```ts
          systemPrompt: () =>
            `${input.role.prompt}

  ${subagentEnvironmentText(input.parentSession.meta.cwd, teammate.badge.model ?? ctx.llm.model)}
  ```
- 影响：这是「同一个模型、两套提示词」的结构性分叉。用户在 AGENTS.md 里写的约定对队友不生效（`presets` 的极简档恰恰又是靠 `buildSystemPrompt` 的 `keep` 做减法，队友完全绕开这套机制）；以后提示词加段（比如新的安全叮嘱）默认只覆盖主会话。
- 建议：队友也走 `buildSystemPrompt`，用 `keep` 只留 identity + 角色段 + 指令文件（是否给 AGENTS.md 做成角色工牌字段 `instructions: boolean`）；环境事实继续用 `subagentEnvironmentText`，因为队友没有 `rewrite` 那条投影链。
- 置信度：高（两套装配都读过）

#### [P2] 收工汇报的投递文本有两份几乎重复的实现

- 位置：`src/packages/subagent/index.ts:757-810`（`reportHome`）、`966-989`（`deliverReview`）
- 现象：两处都在做「取最后一条非空 assistant 正文 → 判状态文案 → 包一层 XML 标记 → 按父会话是否在查看/常驻决定投递方式 → 再补一条 system 行」。差异只有包装标签（`<teammate-report>` vs `<review-findings>`）和取消状态的处理。
- 证据：

  `src/packages/subagent/index.ts:785-789`
  ```ts
      const parentResident = ctx.agent.hasAgent(teammate.parentSession.meta.id)
      if (config.notify === 'auto' && (live || parentResident)) {
        ctx.agent.followup(notice, undefined, teammate.parentSession.meta.id, 'notice')
  ```
  `src/packages/subagent/index.ts:983`
  ```ts
      teammate.parentSession.appendUser(notice)
  ```
- 影响：`deliverReview` 永远直接 `appendUser`（`:983`），不看父会话是否常驻、不看 `notify` 配置——审查结论总是「写文件等用户」，而队友汇报会「并进下一轮」。两条都叫「收工写回发起会话」，行为却不一样，用户看到的就是「审查结论要切回去才看得到」。
- 建议：抽 `deliverHome(session, markedText, line)` 一份，审查通道只传标签与文案；把 `deliverReview` 的投递策略显式对齐 `reportHome`（或把差异写成参数并注明理由）。
- 置信度：高

#### [P1] 审查通道与 `/review` 分散在三处，且账本住在 git 模块里

- 位置：`src/packages/commands/index.ts:317-372`（命令 handler）、`src/packages/subagent/index.ts:932-1006`（`spawnReviewer` / `deliverReview` / `ReviewService`）、`src/core/git-info.ts:78-428`（范围收集、diff 落盘、`reviewTaskText:239`、`ReviewJournal:307`、`reviewStatusText:416`）
- 现象：一个「代码审查」功能，入口在命令包、执行在派活包、取数与账本在 git 模块。`git-info.ts` 总共 511 行，其中 `78-428`（约 350 行）全是 `/review` 的事，与「git 信息收集」混在一个文件里。仓内没有第二个审查实现（也没有名为 `dsh_code_review` 或 `code_review` 的工具，全仓检索 0 命中），所以 `/review` 的关系是清楚的：命令 → `ctx.get('review').spawn` → 审查队友；派不出去时回落 `runtime.submit(reviewTaskText(...))`，两条路共用 `reviewTaskText` 这一份任务书（`git-info.ts:239`），这点是对的。
- 证据：

  `src/packages/commands/index.ts:355-357`
  ```ts
            const review = ctx.get('review')
            if (review !== undefined) {
              const spawned = review.spawn({ scope, focus: effectiveFocus })
  ```

  `src/core/git-info.ts:307`
  ```ts
  export class ReviewJournal {
  ```
- 影响：`ReviewJournal` 是「按会话记审查状态」的账本，与 git 无关；`git-info.ts` 同时被 `agent`（`snapshotGitStatus`）、`commands`（范围收集）、`subagent`（任务书 + 账本）三个包 import，任何一个包想改审查口径都会碰到 git 那一半。
- 建议：新建 `packages/review/`，把 `git-info.ts:78-428` 整体搬进去（`reviewScope` / `reviewTaskText` / `ReviewJournal` / `reviewStatusText`），`git-info.ts` 只留 `gitExec` / `branch` / 回合快照；`subagent` 的 `spawnReviewer` 也搬过去，让 `subagent` 只保留「派一个只读队友」这一件。
- 置信度：高

### goal / plan / todo / mode / waiting

#### [P0] `waiting.any` 是进程级判定，卡片是按会话的：后台一张卡钉死当前会话的目标续跑

- 位置：`src/packages/waiting/index.ts:29-40`、`src/packages/goal/index.ts:124`、`src/packages/plan/index.ts:150`、`src/packages/approval/index.ts:1527`、`src/packages/ask/index.ts:239`
- 现象：`waiting` 的设计目标是「每个卡自己登记我在等人，想往下推的人只问一句有没有人在等」；但三家登记的都是**进程级**的「我在等人」（`pendings.size > 0`），没有会话维度。`goal` 判「能不能续跑」时问的是 `ctx.waiting.any`，于是另一个会话（后台 agent）挂着的审批卡/计划卡会把当前会话的自续跑全部拦掉。
- 证据：

  `src/packages/waiting/index.ts:29-32`
  ```ts
      get any() {
        for (const [id, pending] of waiters) {
          try {
            if (pending()) return true
  ```

  `src/packages/goal/index.ts:123-124`
  ```ts
        // 有任何一张卡在等用户做决定就不许自动往下推：人的决定排在机器前面。
        if (ctx.waiting.any) return null
  ```
- 影响：常驻多 agent 之后这是常态路径——后台队友要授权（`approval` 挂卡），用户正在看的会话里目标跑到一半就停住，且 `takeGoalRound` 每次都返回 `null`，不报错、不提示，用户只能看到「目标不动了」。
- 建议：`WaitingService` 加会话维度：`register(id, pending)` 的 `pending` 回调返回 `{ sessionId, waiting }` 或直接注册 `pendingFor(sessionId)`；`goal` 改问 `ctx.waiting.anyFor(sessionId)`。三处登记各带上卡自己的会话归属（`plan` 的卡已经有 `sessionPath`，`:44`）。
- 置信度：高（三处登记与消费点全部读过）

#### [P0] `todo` / `goal` 的工具忽略调用方会话，把状态写进「用户正在看的那条」

- 位置：`src/packages/todo/index.ts:88`（`async run(args) {`）、`111-116`（`writeTodos` → `ctx.session.current().appendState`）、`132`；`src/packages/goal/index.ts:162`（`async run(args) {`）、`84-87`（`persist` → `ctx.session.current().appendState`）
- 现象：`MiniAgent` 调工具时把归属会话显式传进来了（`loop.ts:701-709` 的 `sessionId` / `sessionPath`），`plan` 也照着用了（`plan/index.ts:194` 传 `runCtx.sessionPath`），但 `todo` 与 `goal` 的工具签名根本不接第二个参数，落状态一律走 `ctx.session.current()`——那是「当前查看的会话」，不是「发起这次调用的会话」。
- 证据：

  `src/packages/todo/index.ts:111-113`
  ```ts
      const writeTodos = (list: readonly unknown[], merge: boolean) => {
        const result = todos.write(list, merge)
        ctx.session.current().appendState('todos', result.items)
  ```

  `src/packages/session-core/loop.ts:704-706`
  ```ts
            // 工具生成的后续产物（后台作业完成通知等）按会话归属投递（0.6.48）
            sessionId: this.session.meta.id,
            sessionPath: this.session.filePath,
  ```
- 影响：队友（工牌 `tools: null` 时拿全量工具）或后台 agent 调一次 `todo_write`，清单会被写进用户眼前那条会话的 jsonl；内存里那份 `TodoStore`（`todo:106`）又是全进程一个，于是两边的清单互相覆盖。`goal` 同理：后台会话建的目标记到别人的日志里，`dsc/turn-end` 的会话过滤（`goal:235`）又只推进当前会话，目标从此谁也不管。这与 `subagent` 里 2026-11-08 已修过的同类报障（`subagent:211-215`、`1222-1225` 的注释）是同一个坑，只是那两个包还没修。
- 建议：两个工具都改成 `run(args, runCtx)`，用 `ctx.get('agent')?.sessionById(runCtx.sessionId) ?? ctx.session.current()` 解析归属（照 `plan:81` 的写法）；`TodoStore` 改成按会话 id 的 Map（照 `presets:106` 的 `bySession`）。
- 置信度：高（代码路径确定；触发前提是后台/队友会话真的调用这两个工具，未跑运行验证）

#### [P1] 五个小包都在重复「状态读写 + 快照投影 + 命令入口 + 设置分区」四件套

- 位置与量（同一套骨架，逐个对号）：

  | 包 | 状态读写 | 快照投影 | 命令入口 | 设置分区 | `dsc/changed` |
  |---|---|---|---|---|---|
  | `goal` | `goal/index.ts:84-87` | `:139` | `:198-224` | `:250-292`（43 行） | `:76` |
  | `todo` | `:111-116` | `:144` | `:216-226` | `:170-214`（45 行） | `:110` |
  | `plan` | `:86-99` | `:149`、`:161-168` | 无 | 无 | `:64` |
  | `mode` | `:52` | `:120` | `:131-142` + `:145-166` | 无 | `:66` |
  | `presets` | `:127-148` | `:231` | `:245-269` | 无 | `:146` |
  | `waiting` | 只做登记（44 行） | — | — | — | — |

- 现象：四个包各自长出一个「`touch()` = `ctx.emit('dsc/changed')` + `surfaces.register` + `commands.register` + （可选）`settings.registerSection`」骨架；设置分区的样板（`fields()` / `values()` / `save()` 的 switch）在 `goal:250-292`、`todo:170-214`、`image-diet:39-111`、`subagent:1386-1514` 各写一遍，合计约 290 行；「读配置 + 夹取值 + 写盘 + 立刻重读」这套又写了一遍：`goal:51-70`、`subagent:300-320`、`memory:84-136`、`todo:46-55`+`153-156`、`self-improve:129-141`、`image-diet:36-37`，约 120 行。
- 证据：

  `src/packages/goal/index.ts:76`
  ```ts
      const touch = (): void => ctx.emit('dsc/changed')
  ```

  `src/packages/todo/index.ts:198-200`
  ```ts
        save: (key, value): string | void => {
          if (key === 'enabled') {
            applyReminder({ enabled: value === true || value === 'true' })
  ```
- 影响：加一个「任务面」功能（比如提醒、清单导出）要重抄一遍这四件套；改设置项的契约（`save` 返回字符串 vs `{ notice }`）要改 4 个包。现在 `save` 的返回就有两种写法（`goal:283` 返回 `string | void`，`subagent:1457` 同，`settings/index.ts:272-276` 返回 `{ notice }`）。
- 建议：**值得抽**，但只抽两处，别抽四件套整体：①`defineSettingsSection({ id, order, fields, clamp })` 一个工厂（吃掉 290 行里的大部分）；②`definePluginConfig(key, schema)` 统一读/写/夹取值（吃掉 120 行）。`surfaces.register` 与 `commands.register` 本身只有 1–2 行，抽了反而多一层。代价：`subagent` 的分区有 `groups` 与 `action`（`:1428-1436`、`:1499-1511`），`memory` 的 `values()` 要现算额度，工厂要允许 `values`/`action` 透传，否则这三个包得留特例——这是这套抽象的主要成本。
- 置信度：高（六处都读过）

#### [P1] 重启残留的「僵尸」计划卡无法应答，且永久把续跑钉死

- 位置：`src/packages/plan/index.ts:56-60`（`pendingStateOf` / `restored`）、`134-137`（`pendingPlan` 回落 `restored`）、`139-146`（`answerPlan` 只认活卡）、`150`（`waiting` 登记把 `restored` 算进去）
- 现象：进程重启后，会话状态里 `decision === 'pending'` 的计划会被读成 `restored`，界面照样画一张待批卡（`pendingPlan()` 回落 `restored`）；但点「批准」时 `answerPlan` 先找 `cardOfCurrent()`，僵尸卡不在 `pendings` 里，函数直接 `return`——按钮点了没反应。同时 `waiting.register` 把 `restored !== null` 当真，`goal` 的续跑被永久挡住（`goal:124`）。正常退出时 `dsc/exit` 会把卡收成 rejected（`:219-222`），所以只有崩溃/强杀之后才会留下这个状态。
- 证据：

  `src/packages/plan/index.ts:139-146`
  ```ts
        answerPlan(decision, feedback) {
          const card = cardOfCurrent()
          if (card === undefined) return
  ```

  `src/packages/plan/index.ts:150`
  ```ts
    ctx.effect(() => ctx.waiting.register('plan', () => pendings.size > 0 || restored !== null), 'plan: waiting.register')
  ```
- 影响：用户看到一张「等你批」的卡，点不动，也没有任何提示；这个会话的目标续跑从此不走，切走再切回才可能清掉（`dsc/session-open` 重算 `restored`，`:214`）。
- 建议：`answerPlan` 对僵尸卡走一条显式路径（在同一处理器里 `proposed.appendState('plan', {...restored, decision})` 并清 `restored`），或者干脆不画僵尸卡：把 `pendingPlan()` 退回只出活卡（`:136` 去掉 `?? restored`），把「上次崩溃时有一张没批的计划」改成会话流里的一行 system 提示。
- 置信度：高（三个函数全文读过；UI 侧只核到卡按 `surfaces.pendingPlan` 画，未读按钮 handler，见「待核实」）

#### [P1] 两个「预设」概念被混用：模式（人格+工具集+提示词）与权限预设（沙箱+权限+审阅者）

- 位置：`src/packages/presets/index.ts`（模式）、`src/packages/permission-presets/index.ts`（权限预设）、`src/packages/commands/index.ts:505-537`（`/permission`）、`src/packages/presets/index.ts:245-269`（`/preset`）、`src/packages/settings/index.ts:227-236`（设置「通用」里的权限预设下拉）、`src/packages/ui-settings/ui/presets.tsx:2`（设置「模式（预设）」页）
- 现象：同一套界面与命令里有两个都叫「预设」的东西。命令是两个（`/preset` 切模式、`/permission` 切权限预设），快照是两个面（`surfaces.preset`、`surfaces.permissionPresets`），设置页是两个入口（自绘页「模式（预设）」+ 通用分区里的「权限预设」下拉）。更实质的穿透在审计上：两个插件都为了写一条 `mode-change` 审计去 `inject` 对方的服务。
- 证据：

  `src/packages/presets/index.ts:133-141`
  ```ts
          audit({
            ts: Date.now(),
            kind: 'mode-change',
            reason: `模式（预设）→ ${specOf({ sessionId: session.meta.id }).label}`,
            mode: ctx.mode.mode,
            policy: ctx.approval.policy,
  ```

  `src/packages/permission-presets/index.ts:134-142`
  ```ts
        audit({
          ts: Date.now(),
          kind: 'mode-change',
          reason: `权限预设 → ${preset.label}（${preset.name}）`,
          mode: ctx.mode.mode,
          policy: before.policy,
  ```
- 影响：`presets` 的头注释明确写着「权限模式与协作模式各自是另外两根旋钮，这里一个都不碰」（`:12-13`），但 `inject` 里有 `approval` 与 `mode`（`:83`），只为了往审计里填两个字段。概念混用会直接伤到文案与入口：`/permission` 的提示里要专门解释「『readonly』是权限档位不是预设」（`commands:521-524`），这正说明用户会混。
- 建议：①术语上把 `presets` 那一套统一叫「模式」，命令保留 `/preset` 但别名 `/mode` 合并、弃用 `permissionPresets` 这个字面（命令改 `/permission-preset` 或并入 `/policy`）；②审计记录里加 `preset` 与 `permissionPreset` 两个独立字段，由 `audit` 的调用方各填自己那一半，`presets` 不再 inject `approval`/`mode`。
- 置信度：高（两个包全文 + 命令 + 设置入口都读过）

### commands / commands-core

#### [P1] 命令表只有一份，但补全、前缀展开、输入认领各写了两套；`duringTask` 判定也是两处

- 位置：表在 `src/packages/commands-core/commands-completion.ts:32-78`（单一真源），注册在 `src/packages/commands/index.ts:79-95`，界面读取在 `src/packages/runtime/index.ts:389-409`；补全与展开在 `commands-completion.ts:145-163`（`commandCompletions`）、`201-210`（`expandCommand`）、`225-247`（`inputClaimOf`）；壳侧另有一套 `src/packages/ui-composer/ui/commands.ts:48-54`（`filterCommands`）、`82-105`（`claimInput`）；`duringTask` 判定在 `commands/index.ts:116-122` 与 `ui-composer/ui/commands.ts:65-67`
- 现象：表本身没有第二份（这点做得对），但「怎么补全、怎么按唯一前缀展开、怎么认领输入」有两套代码；「回合中能不能跑」也是两处判——宿主真闸 + 壳的置灰提示。
- 证据：

  `src/packages/commands-core/commands-completion.ts:201-209`
  ```ts
  export function expandCommand(input: string): string {
    ...
    const matches = allSpecs().filter((command) => command.name.startsWith(name.toLowerCase()))
    return matches.length === 1 ? `/${matches[0].name}${rest}` : input
  ```

  `src/packages/ui-composer/ui/commands.ts:95-102`
  ```ts
    const prefix = commands.filter((command) => command.name.toLowerCase().startsWith(lower))
    ...
      (prefix.filter((command) => command.input !== undefined).length === 1
  ```
- 影响：两条路的判据现在等价（我用 `/rev`、`/review `、`/di HEAD` 三个例子逐条比过），但等价是靠注释维持的（`ui-composer:72-74` 原话「壳不能 import 宿主源码（两份产物各自打包），所以纯逻辑在这边留一份」）。下一版给命令加个新的输入形态（比如 `input: { multiple: true }`），改一处就能让壳与 TUI 行为分叉；`duringTask` 同理——壳判错只是置灰错，用户点下去仍被宿主拦，属于「不一致但不危险」。
- 建议：把「纯命令逻辑」下沉到一个零依赖包（现在 `commands-core` 已经是零 node 内置依赖，壳可以直接 import 它的产物，`/ui-shell` 与 `/tui` 都从同一个入口拿），删掉 `ui-composer/ui/commands.ts` 里的 `claimInput` 与 `filterCommands`，壳只保留「拿 `UiCommandView[]` 过来渲染」。若打包边界真的不允许，就必须有对照探针（现在没有；`ui-command-menu-test.mjs` 只测宿主那份）。
- 置信度：高（两份实现逐行读过并对比）

#### [P2] `commands/index.ts` 797 行：24 条命令的 handler 加一整段 `/review` 交互流

- 位置：`src/packages/commands/index.ts:128-707`（内置命令注册）、`223-315`（`/review` 的范围选择流：四档 + 追问 + 跳过语义）
- 现象：一个文件里 24 个 handler，其中 `/review` 一个命令就占 90 行（含一个自己 `new AbortController()` 的假信号、三种回落路径）。`/policy`、`/reviewer`、`/permission`、`/effort` 四条又在各自 handler 里重写「空参列清单 → 前缀匹配 → 0 或多于 1 个报错」这套。
- 证据：

  `src/packages/commands/index.ts:324-328`
  ```ts
          const signal = new AbortController().signal
          void (async () => {
            const ask = ctx.get('ask')
            let target: ReviewTarget | null
            if (focus !== '') {
  ```
- 影响：`/review` 的交互流与审查本身（`review-channel`）隔着两层服务调用，改交互要动命令包；四条旋钮命令的匹配逻辑重复四遍（`453-461`、`487-495`、`525-533`、`559-567`），下次加一条旋钮命令还得再抄一遍。
- 建议：把 `/review` 的交互流搬进新的 `packages/review`（与本批次 subagent 那条建议同一动作）；四条旋钮命令收成一个 `pickByPrefix(options, query)` 助手。
- 置信度：高

#### [P2] `HELP_TEXT` 与 `runCommand` 兼容导出只剩探针在用

- 位置：`src/packages/commands-core/commands-completion.ts:138-139`（`HELP_TEXT`）、`src/packages/commands/index.ts:709-734`（`serviceRef` + `runCommand`）
- 现象：`runCommand` 的注释说「包外还有调用方按这个名字派发」，实际产品代码已改成 `runtime.runCommand` → `ctx.commands.run`（`runtime/index.ts:386`）；仓内消费方是 4 个探针（`scripts/commands-battery-test.mjs:29`、`scripts/_tui-commands.mjs:11`、`scripts/memory-eval-test.mjs:260`、`src/packages/commands/tests/commands.test.mjs:7`）。`HELP_TEXT` 全仓 0 引用。
- 证据：

  `src/packages/commands/index.ts:720-733`
  ```ts
  let serviceRef: CommandService | null = null
  ...
  export function runCommand(
  ```
- 影响：`serviceRef` 是模块级单例，是第二份「当前注册表」指针（真正的表是 `ctx.commands`）；热替换后靠注释提醒别用，属于会过期的口头约定。
- 建议：删 `HELP_TEXT`；`runCommand` 若只为探针留着，改成探针直接 import `commandsPlugin` 起一个实例（`commands-battery-test.mjs` 已经这么做了），然后删掉 `serviceRef`。
- 置信度：高（全仓检索过 4 个消费点）

### skills

#### [P1] SKILL.md 的解析/名字规则在 core、硬校验在包内，同一件事两套规则

- 位置：`src/core/skills.ts:30`（`NAME_PATTERN`）、`148-180`（`loadSkillFile`：名字非法就退回文件名并记 `problem`，不拒绝）；`src/packages/self-improve/skill-write.ts:73`（又一份 `NAME_PATTERN`）、`98-106`（`validateSkillName`）、`115-153`（`validateSkillMarkdown`：description 超 60 字直接拒、必须有 `whenToUse`）
- 现象：`core/skills.ts` 是**真身**（发现、解析 frontmatter、启停状态都在这里，`packages/skills` 只是插件外壳 + 市场），它走「宽松」路线——文件坏了也要能列出来给人修。`self-improve/skill-write.ts` 走「严格」路线——写盘前一个字节都不许错。两条路线各自实现名字规则与 frontmatter 解析：严格的复用宽松的 `parseSkillMarkdown`（`skill-write.ts:128`），但名字规则抄了一份（`core/skills.ts:30` 与 `skill-write.ts:73` 现在字面相同）。
- 证据：

  `src/core/skills.ts:156-160`
  ```ts
    const legal = NAME_PATTERN.test(candidate)
    const name = legal ? candidate : fallbackName
    const nameProblem = legal
      ? undefined
      : `名字「${candidate}」不是 kebab-case（小写字母数字用短横线相连），按 ${fallbackName} 处理`
  ```

  `src/packages/self-improve/skill-write.ts:102-104`
  ```ts
    if (!NAME_PATTERN.test(trimmed)) {
      return `技能名「${trimmed}」不是 kebab-case（小写字母数字用短横线相连，例如 git-workflow）`
  ```
- 影响：`core/skills.ts` 还留在 core，意味着「插件化」在技能这一块只完成了外壳：业务包依赖宿主 core 的解析语义，而写入侧又另有一套更严的判定。同一份 SKILL.md，`/skills` 里显示为「按 git-workflow 处理（problem）」而 `skill_write` 直接报错拒绝——用户会以为两个功能对不上。加一条名字规则（比如允许下划线）要改两处。
- 建议：名字规则与 frontmatter 解析收进 `packages/skills`（core 那 245 行一起搬），并把「宽松校验」与「严格校验」做成同一个模块的两个入口（`parse(file)` / `assertWritable(draft)`），`skill-write` 只 import 后者。
- 置信度：高（两处全文读过）

#### [P1] 威胁扫描有两套规则表，第一条已经分叉

- 位置：`src/packages/memory/memory.ts:309-349`（`INVISIBLE` + `THREAT_RULES` + `scanThreat:357-365`）、`src/packages/self-improve/skill-write.ts:190-245`（`INVISIBLE` + `THREAT_RULES` + `scanSkillThreat:238-245`）
- 现象：同一件事（「这段文本会不会变成下一次的我的指令」）有两份规则表，结构完全一样（`label` + `pattern`，先 NFKC 归一，命中就返回中文理由），内容各管一半：
  - `memory` 独有：批量删文件（`rm -rf`）、凭据往外送、改 `MEMORY.md`（`:333`、`:336`、`:345`）
  - `skill-write` 独有：200 字符以上的 base64 载荷、编码载荷配执行（含 `Convert.FromBase64`）、绕过台账/安检（`:217`、`:220`、`:228`）
  - 第一条就已经分叉：`memory` 的不可见字符集不含 tag 字符，`skill-write` 含 `\u{E0000}-\u{E007F}`
- 证据：

  `src/packages/memory/memory.ts:310`
  ```ts
  const INVISIBLE = new RegExp('[\\u00AD\\u200B-\\u200F\\u2028\\u2029\\u2060-\\u2064\\uFEFF]', 'gu')
  ```

  `src/packages/self-improve/skill-write.ts:191`
  ```ts
  const INVISIBLE = new RegExp('[\\u00AD\\u200B-\\u200F\\u2028\\u2029\\u2060-\\u2064\\uFEFF\\u{E0000}-\\u{E007F}]', 'gu')
  ```
- 影响：这是安全判据，不是文案。写一条 tag 字符藏在记忆里能过 `memory` 的安检，同一句话写进技能会被拦；反过来 `skill_write` 不拦 `rm -rf`（注释说交给命令策略），可记忆里拦——同一个仓库对「危险」的定义有两个版本，谁都不知道以哪个为准。另外 `skill-write.ts:199` 的注释写着「自己实现一份，不 import 内核记忆那套私有规则」，等于把这个分叉写成了设计。
- 建议：抽 `core/threat-scan.ts`（或 `packages/guard-core`）：一张规则表 + 一个 `scan(text, { scope: 'memory' | 'skill' })` 的开关位，两处都调；规则表用「作用域」标注而不是复制。
- 置信度：高（两份规则表逐条对比过）

### prompt

#### [P2] 系统提示装配只有一份（答案：是），但「模型信息段」有两处、`model-caps` 不参与拼装

- 位置：`src/packages/session-core/prompt.ts:383-411`（`buildSystemPrompt`，唯一装配点）、`src/packages/prompt/index.ts:263-291`（`systemPrompt`，唯一调用点）；模型信息段 `prompt/index.ts:287`；AGENTS.md 段 `session-core/prompt.ts:177-231` + `403-404`；技能目录段 `prompt/index.ts:283` → `session-core/prompt.ts:409`；`src/core/model-caps.ts` 与服务端无关（只供 `llm` 判档位能力，`packages/llm/index.ts:13`）
- 现象：装配确实只有一份，段顺序集中在 `buildSystemPrompt` 的 `sections.push` 里（identity 0 / behavior 10 / tool-rules 20 / 插件段 / instructions 200 / skills 210 / model 890），插件通过 `prompt.register(order)` 与 `registerSkeletonFilter` 参与，没有第二条装配链。唯一的第二处「模型信息」是队友的系统提示里那句「你用的模型」（`session-core/prompt.ts:352`），由 `subagentEnvironmentText` 拼。
- 证据：

  `src/packages/prompt/index.ts:285-288`
  ```ts
          contributions: [
            ...service.sections(scope),
            { id: 'model', order: 890, text: `当前模型：${ctx.llm.model}（provider ${ctx.llm.provider}）` },
          ],
  ```
- 影响：装配面是干净的，问题只在队友那条旁路（见 subagent 那条 P1）。`model-caps` 被误认为「模型信息段」的来源，实际它只声明能力（窗口/模态/思考档位），这一点值得在文档里说清，否则下一个人会去那里找提示词。
- 建议：不改装配，只把 `session-core/prompt.ts` 头注释的段清单补一句「模型信息段由 prompt 插件注入（`index.ts:287`），`core/model-caps.ts` 只管能力声明」；队友改走 `buildSystemPrompt` 之后，「你用的模型」那句自然并进 890 段。
- 置信度：高

### self-improve / memory

#### [P1] 两条「读会话 → 判值得记 → 落盘」的链路互不相识，各自把对方的复盘轮当用户轮

- 位置：`src/packages/memory/index.ts:878-909`（`dsc/turn-end` → 复盘）、`memory:209-212`（`reviewing` / `wroteThisTurn` 标记）、`src/packages/self-improve/index.ts:559-582`（`handleTurnEnd` → 纠正捕获 + 复盘）、`self-improve:561-566`（`pluginInitiated` 标记）
- 现象：两个包都在 `dsc/turn-end` 上「读本轮会话 → 判有没有值得记的东西 → 用 `ctx.agent.followup(..., 'notice')` 起一轮模型复盘」。两边都遇到同一个问题「怎么知道自己这一轮是插件自己起的」，于是各写一套防递归标记：`memory` 用进程内 `let reviewing`，`self-improve` 用会话状态 `pluginInitiated`。两套标记互不可见——`memory` 发起的复盘轮结束时，`self-improve` 的 `handleTurnEnd` 看到的是 `pluginInitiated === false`，于是照常跑 `captureCorrections` 并按 `userTurnIndex` 推进；反过来也一样。
- 证据：

  `src/packages/memory/index.ts:889-891`
  ```ts
        if (reviewing) {
          reviewing = false
          return
        }
  ```

  `src/packages/self-improve/index.ts:561-563`
  ```ts
        if (state.pluginInitiated) {
          // 这一轮是插件自己发起的：先摘标记，再按它是什么轮次收尾（不做 L1/L2，避免自己复盘自己）
          const current = pending
  ```
- 影响：插件发起的轮次会被另一个插件算成「用户又说话了」：`memory` 的 `userTurns` 会因 `self-improve` 的复盘轮而加一（`:900-901`），到点又起一轮记忆复盘；`self-improve` 的 `lastReviewedTurn` 判据（`:547-548`）也会把对方的轮次当成用户轮。两边都用 `'notice'` 投递，日志里也分不出谁发起的。
- 建议：把「这一轮是谁发起的」升成会话级共享事实：`TurnSignal` 加 `initiator?: { plugin: string }`（`agent/index.ts:65-68` 的 `turnSignal` 就在构造它），两个包都按它跳过；或统一成 `ctx.get('agent').followup(text, { initiator: 'self-improve' })`。这比各自维护一个布尔值可靠。
- 置信度：高（两处 turn-end 处理全文读过）

#### [P1] `self-improve` 的 `dsc/turn-end` 监听不看会话归属，后台回合会在当前会话上跑

- 位置：`src/packages/self-improve/index.ts:582`
- 现象：`dsc/turn-end` 的载荷里带 `TurnSignal { sessionId, sessionPath }`（`agent/index.ts:65-68`、`:150`），`memory`（`:882`）、`goal`（`:235`）、`compact`（`:261`）、`session-title`（`:61`）都按它过滤。`self-improve` 的监听只接第一个参数，`handleTurnEnd` 内部所有读取都走 `ctx.session.current()`（`:440`、`:544`、`:572`），于是后台 agent 的回合结束时，它会在「用户正在看的那条会话」上跑纠正捕获、技能命中计数与复盘判定。
- 证据：

  `src/packages/self-improve/index.ts:582`
  ```ts
    disposers.push(ctx.on('dsc/turn-end', (reason) => { handleTurnEnd(reason) }))
  ```

  `src/packages/memory/index.ts:882`
  ```ts
      if (signal !== undefined && signal.sessionId !== ctx.session.current().meta.id) return
  ```
- 影响：后台会话（常驻多 agent 的常态）每收一轮，就可能给当前会话多记一条「纠正」候选或起一轮复盘；`turnReadSkillNames` 还会把当前会话的技能读取重复计一遍命中（`:573-577`），技能老化分级跟着失真。
- 建议：照 `memory:882` 加一行归属过滤；`handleTurnEnd` 改成接 `(reason, signal)` 并用 `ctx.agent.sessionById(signal.sessionId)` 取会话对象，别用 `current()`。
- 置信度：高（5 处监听对比过）

### image-diet

#### [P2] 三层都在改请求体里的图片/工具结果，顺序只靠一处排序，且没有活文档

- 位置：`src/packages/prompt/index.ts:129-132`（唯一排序点）、`:194-197`（`tool-result-prune`，order 560）、`:208-215`（`image-diet`，order 550）、`:218-221`（`drop-images`，order 900）、`src/packages/microcompact/index.ts:119-162`（order 650）、`src/packages/todo/index.ts:157-167`（order 800）、`src/packages/microcompact/index.ts:9`（注释只写了自己与 600/900 的关系）
- 现象：改请求体的层现在有 6 条：`fold-system` 500、`image-diet` 550、`tool-result-prune` 560、`env-facts` 600、`microcompact` 650、`todo-reminder` 800、`drop-images` 900。其中三条动的是「同一批工具结果/图片」：`image-diet` 把旧图换成占位、`tool-result-prune` 把超长工具结果切中间、`microcompact` 把旧工具结果换成占位。谁先谁后只由 `projectionChain()` 的排序（order 相同则按 id）决定，`prompt/index.ts` 里逐条写了理由（550 要在 600 前、560 要确定性），但没有任何测试锚点把「最终顺序」钉住。
- 证据：

  `src/packages/prompt/index.ts:129-132`
  ```ts
      const projectionChain = (): Array<[string, Projection]> =>
        [...projections.entries()].sort(([aId, a], [bId, b]) =>
          a.order === b.order ? aId.localeCompare(bId) : a.order - b.order,
        )
  ```

  `src/packages/prompt/index.ts:205-207`
  ```ts
      // 排在 env-facts（600）**之前**：env-facts 会往末尾追加一条 user 环境快照，而本投影
      // 按「最近几个用户回合」决定哪些图还留着——若落在它之后，那条合成快照会白占一格，
  ```
- 影响：给任何一层调 order 都会静默改变「模型实际看到的内容」，而顺序的依据是散落在 6 处注释里的口述理由。`tool-result-prune` 尤其隐蔽：它没有配置项、没有设置分区、在 `prompts` 的 README 里也只提了一句（`prompt/index.ts:187-193`），等于一条永远开着的隐藏层。
- 建议：把「投影顺序表」写成 `prompt/projections.md` 一张表（id / order / 动什么 / 为什么在这个位置），并在探针里加一条断言：注册完全部插件后，实际链顺序与表逐行相等。这样任何 order 改动都会红。
- 置信度：高（6 处注册点都读过）

#### [P2] `image-diet` 包只管设置界面，本体在 core；配置键字面量写了两处

- 位置：`src/packages/image-diet/index.ts:30`（`CONFIG_KEY = 'image-diet'`）、`src/packages/prompt/index.ts:37`（`IMAGE_DIET_CONFIG_KEY = 'image-diet'`）、`src/packages/image-diet/index.ts:34`（`inject: ['settings']`）
- 现象：包名叫 `image-diet`，但它只有 115 行，全部是设置分区；真正的卸载函数在 `src/core/image-diet.ts`（`pruneImages` / `readImageDietConfig` / `IMAGE_DIET_RANGES`），投影注册在 `prompt` 插件里（`:208-215`）。同一个配置键 `'image-diet'` 在两个包里各写一次字面量。
- 证据：

  `src/packages/prompt/index.ts:36-37`
  ```ts
  /** 图片卸载投影的配置键：投影登记在本文件，配置界面在 plugins/image-diet（同一个键）。 */
  const IMAGE_DIET_CONFIG_KEY = 'image-diet'
  ```
- 影响：改键名要改两处；「这个包做了什么」与包名不符（读代码的人会以为卸载逻辑在这里）。同理 `tool-result-prune` 在 `packages/prompt` 里、`microcompact` 有自己的包——三个同层的东西放在三个不同层级的目录里。
- 建议：`image-diet` 包要么把 `core/image-diet.ts` 搬进来、自己注册投影（与 `microcompact` 对齐），要么降级成 `prompt` 包里的一个设置分区并删包。配置键从 `IMAGE_DIET_RANGES` 所在模块导出常量，两处不再各写字面量。
- 置信度：高

### 横向：配置与 i18n 样板

#### [P2] 「读配置 → 夹取值 → 写盘 → 立刻重读」与 `hostT` 注释样板各抄了 6–8 份

- 位置：`goal:28-32`、`subagent:64-68`、`todo:27-31`、`memory:51-55`、`presets:40-44`、`permission-presets:34-38`、`image-diet:23-27`、`self-improve:99`（`hostT` 前都是同一段 6 行注释）；配置样板见上一条 P1 的清单
- 现象：27 个包用 `const t = hostT(import.meta.dirname)`，其中 8 份在批次范围内，每个前面都挂着同一段「设置面文案的取词器：语言来自 config.yaml 的 language:……」注释。
- 证据：

  `src/packages/goal/index.ts:28-32`
  ```ts
  /**
   * 设置面文案的取词器：语言来自 `config.yaml` 的 `language:`，字典是本包的
   * `locale/ui.zh.json` / `ui.en.json`（与界面半用同一份文件、同一条判定）。
   */
  const t = hostT(import.meta.dirname)
  ```
- 影响：主要是噪音（约 48 行同文注释），但它掩盖了一个真实问题：每个包都要自己保证 `locale/` 目录在旁边，`hostT` 的失败模式（目录缺失时回落键名）没人一处统一校验。
- 建议：`hostT` 内部把这段说明写成文档注释，包内只留一行；顺便在宿主启动时校验每个已挂载包的 `locale/` 是否存在，缺了报一条 `dsc/notice`。
- 置信度：高（8 处全文读过）

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
|---|---|---|---|---|
| 目标存储 | `src/core/goal.ts:1`（一行 `export *`） | `src/packages/goal/goal.ts` | **无人引用**（全仓 `*.ts/*.tsx/*.mjs/*.js` 检索只命中垫片自身与 `docs/`） | 删垫片 |
| 待办存储 | `src/core/todo.ts:1`（一行 `export *`） | `src/packages/todo/todo.ts` | **无人引用** | 删垫片 |
| 学习账本/技能写入/候选库 | `src/core/learnings/ledger.ts:1`、`skill-write.ts:1`、`store.ts:1`（三行 `export *`） | `src/packages/self-improve/{ledger,skill-write,store}.ts` | **无人引用**（只有三个文件自己的 `@module dsc/core/learnings/*` 注释还写着旧路径） | 删三个垫片；顺手改 `packages/self-improve/*.ts` 的 `@module` 名 |
| 团队角色文件 | `src/core/agent-roles.ts:1`（一行 `export *`） | `src/packages/subagent/agent-roles.ts` | `scripts/resident-agents-test.mjs:329`（`lib/core/agent-roles.js`） | 探针改成 `lib/packages/subagent/agent-roles.js` 后删垫片 |
| 记忆正文/账本 | `src/core/memory.ts:1`（一行 `export *`） | `src/packages/memory/memory.ts` | `scripts/memory-eval-test.mjs:241`、`scripts/memory-parity-test.mjs:88`（`lib/core/memory.js`） | 同上 |
| 微压缩 | `src/core/microcompact.ts:1`（一行 `export *`） | `src/packages/microcompact/microcompact.ts` | `scripts/context-pipeline-test.mjs:33`（`lib/core/microcompact.js`）、`scripts/microcompact-test.mjs:119`（直读 `src/core/microcompact.ts`） | 同上；注意第二条是直读 `src/`，改路径要一起改 |
| 工具结果修剪 | `src/core/tool-result-prune.ts:1`（一行 `export *`） | `src/packages/prompt/tool-result-prune.ts` | `scripts/context-segments-test.mjs:42`（`lib/core/tool-result-prune.js`） | 同上 |
| 记忆评估读数 | `src/core/memory-eval.ts:1`（一行 `export *`） | `src/packages/memory/memory-eval.ts` | `scripts/memory-eval-test.mjs:69` | **批次 02 已判**（`02-plugin-runtime.md` 第 18 行），此处只记一条交叉引用 |
| 斜杠命令派发 | `src/packages/commands/index.ts:728` 的 `runCommand` + `:720` 的 `serviceRef` | `ctx.commands.run`（`runtime/index.ts:386`） | 4 个探针：`scripts/commands-battery-test.mjs:29`、`scripts/_tui-commands.mjs:11`、`scripts/memory-eval-test.mjs:260`、`src/packages/commands/tests/commands.test.mjs:7` | 探针改成自己起实例后删 `serviceRef` |
| 技能发现/解析 | `src/core/skills.ts`（**真身，245 行**，不是垫片） | 外壳在 `src/packages/skills/index.ts` | `packages/skills/index.ts:16-25` 反向 import core；`scripts/skills-roots-test.mjs:22` 读 `lib/core/skills.js` | 本体搬进 `packages/skills`，core 留一行垫片给探针（或探针改路径） |

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
|---|---|---|---|---|
| 斜杠命令补全与输入认领 | `commands-core/commands-completion.ts:145-163`、`225-247` | `ui-composer/ui/commands.ts:48-54`、`82-105` | A 先 `expandCommand` 再兜底「要收输入的这批取唯一前缀」；B 走「精确 → 唯一前缀 → 要收输入的取唯一」。结论等价，靠注释维持 | 把 B 删掉，壳直接 import `commands-core` 的产物（它已零 node 内置依赖） |
| `duringTask` 判定 | `commands/index.ts:116-122`（真闸） | `ui-composer/ui/commands.ts:65-67`（置灰提示） | 判据同，数据源同（`listUiCommands` 带下来），但两处各写一次 | 保留（真闸必须在宿主），把壳那处标成纯展示并加探针对照 |
| `SKILL.md` 名字规则 | `core/skills.ts:30` | `self-improve/skill-write.ts:73` | 正则字面相同；A 宽松（退回文件名 + problem），B 严格（拒绝） | 一条 `validateSkillName` 共用，宽松/严格只差「怎么用返回值」 |
| `SKILL.md` 结构与字段校验 | `core/skills.ts:122-145`（解析）、`148-180`（装载） | `self-improve/skill-write.ts:115-153`（校验） | A 不要求 `whenToUse`、description 不设上限；B 要求 `whenToUse`、description ≤60 字 | 解析与断言同模块两入口 |
| 威胁扫描规则表 | `memory/memory.ts:309-349` | `self-improve/skill-write.ts:190-230` | 第一条不可见字符集已分叉；A 独有删文件/外送凭据/改 MEMORY.md，B 独有 base64 载荷/绕台账 | 抽 `core/threat-scan.ts` 一张表 + `scope` 开关 |
| 收工汇报投递 | `subagent/index.ts:757-810`（队友） | `subagent/index.ts:966-989`（审查） | 后者不看 `notify`、不看父会话是否常驻，一律 `appendUser` | 抽 `deliverHome()` |
| 「按 hash 去重写状态条目」 | `agent/index.ts:39-43`（`system-prompt`） | `prompt/index.ts:325-329`（`env-facts`） | 同算法、同长度、同语义 | `Session.appendStateIfChanged(key, text)` |
| 「插件自己起的一轮」标记 | `memory/index.ts:209-210`（`reviewing` 布尔） | `self-improve/index.ts:561-566`（`pluginInitiated` 会话状态） | 一个进程内、一个落状态；互不可见 | 升成 `TurnSignal.initiator` |
| 「取最后一条 assistant 正文 / 最后一条 user 正文」 | `core/transcript-text.ts`（正主） | 调用点：`subagent:413-416`（自己 fold 一遍）、`memory:774`、`self-improve:441-442`、`skill-write:27` | `subagent` 那段自己写了一遍「倒序找最后一条非空 assistant」，与正主重复 | `subagent` 改用 `lastAssistantText` |
| 设置分区样板（`fields`/`values`/`save`） | `goal:250-292` | `todo:170-214`、`image-diet:39-111`、`subagent:1386-1514` | 四份形状一致，`save` 返回类型有两种（`string \| void` vs `{ notice }`） | `defineSettingsSection()` 工厂，允许 `values`/`action` 透传 |
| 「读配置 → 夹取值 → 写盘 → 重读」 | `goal:51-70`、`subagent:300-320` | `memory:84-136`、`todo:46-55`+`153-156`、`self-improve:129-141`、`image-diet:36-37` | 每份各写一遍 `resolvePluginConfig` + `clamp` + `writePluginConfig` + 重读 | `definePluginConfig(key, schema)` |
| `mode-change` 审计的字段组装 | `mode/index.ts:54-62` | `presets/index.ts:133-141`、`permission-presets/index.ts:134-142` | 三处各填 `mode` / `policy` 的子集，字段不齐（`permission-presets` 填 `before.policy`，`presets` 填 `ctx.approval.policy`） | 审计格式收成一处，由调用方只传自己那一半 |
| 名册状态的「僵尸 working」判定 | `subagent/index.ts:830`（唯一实现） | 消费方：`transcript/index.ts:186-187`、`:319-325`、`ui-team/ui/ui.tsx:210-226` | 判定只在宿主一处，但三个消费方各自筛 `working`，看不见「僵尸已读作 stopped」 | `TeammateView` 加 `stale` 字段，消费方只读字段 |
| 「真人/机器发言」判据 | 见批次 01 重复逻辑清单第 1 行 | **新证据**：`self-improve/index.ts:173`（`SCHEDULED_MARK` 只认定时任务投递） | 这一份只认时序任务标记，不认队友汇报与审查结论，于是 `<review-findings>` 会被它当用户发言，`detectOrigin`（`:345-357`）随之返回 `model`，允许写技能库 | 并入批次 01 建议的那份谓词表 |

## 待核实

1. **后台/队友会话是否真的会调用 `todo_write` 与 `goal`**：P0 第 2 条的触发前提。取决于角色工牌（`tools: null` 时是全量），我没有跑运行验证，也不能跑测试。若实际从没有后台调用，这条降 P1。
2. **僵尸计划卡的按钮是否真的可点**：我确认了卡按 `surfaces.pendingPlan` 画（`ui-prompt/ui/ui.tsx:137-140`），但没读它的批准按钮 handler（`ui-prompt` 与 `ui-transcript` 不在本批次）。若按钮先判卡 id 是否存在再发请求，用户会看到「点了没反应」而不是「卡消失」。
3. **`self-improve` 的 `SCHEDULED_MARK` 与批次 01「真人发言判据」的关系**：我只对照了这一条正则，没有把全仓所有注入源（钩子产出、`lsp` 诊断注入、`schedule` 补投）都过一遍，所以只写成「新证据 + 交叉引用」。
4. **三层请求体投影的实际 token 收益**：`image-diet` 550、`tool-result-prune` 560、`microcompact` 650 的先后顺序对最终体积的影响，需量化才有说服力；本轮禁止跑测试，未测。
5. **`runCommand` / `serviceRef` 在发布产物里的消费方**：我只检索了仓内 `*.ts/*.tsx/*.mjs/*.js`，没查 `bin/`、`package.json` 的 `exports`、`desktop/` 打包脚本是否还按名字引用。
6. **`/review` 是否存在第三种入口**：用户问题里提到的 `dsh_code_review` 在仓内 0 命中（`code_review|codeReview` 全仓无匹配），我按「命令 + ReviewService」两条路写。若指的是 dsh 侧的同名工具，那属于兼容层（`dsh-compat`），不在本批次范围。
7. **`tools.project` 与 `tools.visible` 的两层可见性**：`presets` 用 `project` 做减法（`:215-229`），`agent` 调 `visible({ sessionId })`（`:101`），队友用 `toolsFor` 自己筛（`subagent:448-470`）——三条路径的先后与语义我只读了签名，没有把 `tools` 服务的实现读全（`packages/tools/index.ts` 不在本批次）。
