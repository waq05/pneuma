# 生产级加固计划：Windows 沙箱 / 自我改进闭环 / 影子 git 回滚 / 欠项补齐

写在前面：这份文档是四项工程的**任务记录与验收底稿**，不是完成报告。每完成一个批次回来改状态；结论都要能落到 `文件:行号`，验收都要能落到命令。基线：分支 `feat/pluginization`，版本 0.9.1，Node 24.19，pnpm 10.15。

## 0. 共同要求（四项都适用）

用户明确要求**生产级，不许偷工减料**。落到这个仓库就是六条：

1. **happy path 之外必须有降级语义**：能力不可用时说清降级到什么程度，绝不假装成功（本仓库已有先例：`sandbox/index.ts:147` 的 `enforcement` 只有 `full` / `partial` 两值，降级必须写进系统提示）。
2. **失败可观测**：失败要有稳定错误码或 stderr 签名，能被探针断言（先例：`win/backend.ts:40` 的 `RUNNER_FAILURE_SIGNATURE`）。
3. **机器可判的验收**：每条能力至少一条 `node --test` 或 `scripts/*-test.mjs` 断言；跑不了真机的部分要写清为什么跑不了。
4. **不许静默 fail-open**：安全相关（沙箱、写技能、回滚）一律 fail-closed 或显式降级 + 提示，不允许"出错就当没这回事"。
5. **文档同批**：`docs/development.md` 写怎么改，`docs/development-log.md` 写为什么，包内 `README.md` 写用户可见变化，`docs/harness-benchmark-roadmap.md` 改差距状态。
6. **分批提交**：一批一次提交，可独立验收，提交信息写清为什么。

## 1. 任务一：Windows 操作系统级沙箱

### 1.1 为什么做

现在的沙箱是**策略围栏**：它拦 dsc 自己发起的工具调用，拦不住命令内部的任意写。`sandbox/README.md:17` 自己写着这句话。要真隔离，只能换执行体。

### 1.2 已经有的（核实过）

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| 三档档位 read-only / workspace-write / danger-full-access | `src/packages/sandbox/policy.ts` | 有 |
| 进程内策略围栏（路径白名单 + 受保护元数据 + 网络开关） | `src/packages/sandbox/policy.ts`、`index.ts:259` 起 | 有 |
| 命令前缀策略（allow / prompt / forbidden） | `src/packages/sandbox/execpolicy.ts` | 有 |
| docker 容器后端 | `src/packages/sandbox/backends.ts:167` | 有（可选） |
| **Windows 受限令牌后端**（koffi FFI） | `src/packages/sandbox/win/backend.ts:181` | 有 |
| 能力 SID + ACL 授权（WRITE_RESTRICTED pass-2 交集） | `src/packages/sandbox/win/acl.ts` | 有 |
| 专用离线账号 + WFP 防火墙 + 白名单代理（网络第二级） | `src/packages/sandbox/win/setup.ts`、`wfp.ts`、`net-proxy.ts` | 有 |
| 改动前 diff 预览 | `src/packages/sandbox/review.ts` | 有 |

结论：**不是从零做，是把已有实现补到生产级**。

### 1.3 已知缺口（核实过，按严重度排）

**A. 打包后可能直接失效（最高优先，待实测）**

- runner 用 `process.execPath` 当 node 起子进程（`win/backend.ts:313`）。桌面宿主是 Electron 的 `utilityProcess.fork`（`desktop/electron/main/protocol.ts:91`），此时 `process.execPath` 是 `electron.exe`；能不能当 node 用，取决于环境里有没有 `ELECTRON_RUN_AS_NODE=1`。
- 现在这条路径**靠环境继承**，`win/backend.ts:313` 里没有任何显式设置；全仓 `ELECTRON_RUN_AS_NODE` 只出现在 `src/headless.ts:3` 的注释和一堆截图脚本的 `Remove-Item` 里。`docs/development.md:96` 写着要这么做，代码里没落实。
- 结论：**不依赖继承，改成显式设置**（`DSC_NODE` 环境变量优先，否则给子进程置 `ELECTRON_RUN_AS_NODE=1`），并在 S1 里用打包件实跑一次验证。这条不修，其余加固都是空谈。

**B. 强制力本身的洞**

- 硬链接别名完全没处理，只在 `describe()` 里承认（`win/backend.ts:11`、`:346`）。
- 读不受限：`WRITE_RESTRICTED` 只管写（`win/token.ts:18`），守卫里 read 风险直接 defer（`index.ts:300`）。
- 网络无账号分支时只是 14 个代理环境变量（`win/backend.ts:49`），直连或裸 IP 绕得过；白名单代理也只在账号分支才起（`win/backend.ts:296`）。
- 长路径 >260 没处理：ACL 用普通路径调 API（`win/acl.ts:244`），`\\?\` 只在策略层拒。
- 与 codex 相比缺三项硬能力：deny-read ACE（codex `acl.rs:1014`、`deny_read_acl.rs:18`）、全程 no-reparse 打开目录与原子替换（codex `no_reparse_dir.rs:112`、`file_write.rs:123`）、可写根体检（标准用户可改？所有者可信？codex `acl.rs:248`、`:292`）。

**C. 生命周期与并发**

- 临时目录 ACE 只在 `dispose()` 回收（`win/backend.ts:319`），进程崩溃后没人扫尾，残留 ACE 会一直挂着。
- 授权在主线程同步跑、无超时（`win/backend.ts:178`），大树首次授权几十秒会卡住事件循环。
- setup 没有全局互斥（`win/setup.ts:285`），两个人同时点会并发建账号/装规则；也没有卸载函数（codex 有 `setup_mutex.rs:44`、`uninstall_windows.rs:22`）。
- runner 自身没有超时参数，全靠宿主 taskkill /T /F（`tools-default/bash.ts:50`）；`CreateProcessAsUser` 失败路径不 dispose 令牌（`runner-entry.ts:370`）。

**D. 验收与文档**

- 全仓**没有任何**真建受限令牌、真验 ACL 拒绝的自动化用例。`tests/sandbox.test.mjs` 只测策略纯函数，`scripts/sandbox-write-roots-test.mjs:8` 只算清单，`scripts/sandbox-parity-test.mjs:73` 只比源码字符串。
- `win/net-abi.ts:57` 引用的 `shots/win-net-setup-check.mjs` 不存在。

### 1.4 本轮补齐路线（六个批次，可独立验收）

| 批次 | 内容 | 验收 |
| --- | --- | --- |
| S1 打包与解释器 | 显式解析 node 解释器（`DSC_NODE` 环境变量优先，或给子进程置 `ELECTRON_RUN_AS_NODE=1`）；打包件实跑一次 runner | 打包版里跑 `sandbox-win-token-test` 的集成用例通过 |
| S2 可判定的验收 | 新增 `scripts/sandbox-win-token-test.mjs`：纯函数（参数解析、引号、路径包含）+ 一条「根外写被拒」集成用例（非管理员可跳过并报告 skipped）；修正失效引用 | 用例在非管理员下全绿，管理员下集成用例也绿 |
| S3 运行时健壮性 | runner 加 `--timeout`（`WaitForSingleObject` + `TerminateJobObject`）；失败分支补令牌 dispose；管道读端关闭 | 超时用例：命令跑 30 秒被 1 秒超时杀掉，退出码可辨 |
| S4 清扫与并发 | 启动时扫 `~/.dsc/sandbox/tmp` 残留能力 ACE 并回收；setup 命名互斥；新增卸载（清账号、防火墙、WFP、ACL） | 强杀 runner 后重启，残留 ACE 被清；并发两次 setup 只有一个生效 |
| S5 强制力补强 | 给可写根外目标加 deny-write / deny-delete ACE（codex 路子）；目录句柄 no-reparse 打开；`CreateHardLink` 指向根外时拒绝并给用例；内部路径统一 `\\?\` | 硬链接用例被拒；>260 长路径在根内可写、根外被拒 |
| S6 网络与上报 | 白名单代理从「账号分支专属」提到 windows-token 通用；无账号时必须报 `partial` 且系统提示写明「网络未强制」 | 无账号 + 开网：直连被代理拦住；enforcement 上报为 partial |

**默认档位不变**：仍是 `policy`（`policy.ts:88` 的 `DEFAULT_SANDBOX_CONFIG`）。要不要在 koffi 可用时自动升到 `windows-token`，见 §7 第 1 问。

### 1.5 验收断言（机器可判）

1. 写根之外写入被拒：runner 内写 `%TEMP%` 外路径 → 退出码非 0，且目标文件不存在。
2. 写根之内可写：runner 内写工作区文件 → 退出码 0，文件存在。
3. read-only 档：任何目录写入都失败，且工作区 ACL 没被改过（前后 ACL 指纹一致）。
4. 网络关：`Invoke-WebRequest` 失败；网络开且域名在白名单：通；不在白名单：不通。
5. 降级可见：把 koffi 拿掉 → `enforcement=partial`，系统提示与 `/sandbox` 都写明"未强制"。
6. 崩溃清理：runner 被强杀后，临时目录的能力 ACE 能被 `/sandbox` 或 doctor 检出并回收。
7. 并发：8 条命令同时跑，授权锁不互相踩，全部成功且无残留锁文件。

## 2. 任务二：自我改进闭环

### 2.1 环是什么

三环：**(a) 从经验里提炼技能草案** → **(b) 用的时候自我修订** → **(c) 长期不用就老化归档**。

### 2.2 已经有的（核实过，带行号）

- **整包默认关**（`self-improve/cordis.patch.yml:5`），要到设置里打开（分区 order 35，`index.ts:1048`）。
- 工具两个：`skill_write`（`:594`，risk=write）、`learning`（`:764`）；命令三个：`/learn`、`/learnings`、`/skills-ledger`（`:822`、`:836`、`:891`）。
- 唯一钩子 `dsc/turn-end`（`:590`）；`skill_write` 用守卫 order 29 跳过 order 30 的通用审批卡，自己走审批闸（`:706`、`:361`、`:644`）。
- 写入落 `~/.dsc/skills/<name>/SKILL.md`（`skill-write.ts:36`）：create 撞名拒（`:359`）、patch 必须唯一命中（`:436`）、改前 `.bak.<秒>` 备份（`:444`）、回滚走 `ledger.ts:219`。
- 账本字段 `id/ts/actor/action/skill/前后 hash/backup/note`（`ledger.ts:29`），落 `.ledger.jsonl`（`:64`）。
- **L1 纠正捕获**：候选落 `candidates.jsonl`，状态 `candidate → promoted / dropped`，保留 30 天 / 上限 200 条（`store.ts:55`），只有 `/learnings promote` 才生效。
- **L2 复盘**：`completed` 且工具迭代 ≥12 起一轮，模型回一行 JSON、插件落盘（`index.ts:550`、`:188`、`:464`）。
- **安全闸**：`pluginInitiated`、`.teammates/`、定时任务文本三类来源直接拒（`:345`），判不出按 model 走审批（`:357`）；技能正文不进系统提示，目录只列 name / description / whenToUse（`skills/index.ts:107`）。新建技能默认停用（`:380`）。

### 2.3 缺口（核实过）

- **(a) 提炼只覆盖一半**：纠正只进候选、要人 promote（`:428`、`:756`）；复盘只会 create——同类只回 `NONE`，撞名退候选（`:195`、`:471`），**没有"按段落修订"这条路**。
- **(b) 自修订完全没有触发**：`patch` / `write_file` 能力有（`skill-write.ts:422`、`:502`），但没有任何代码在出错后自动发起修订轮。另外 read-before-write 只认 `skill` 工具（`:599`），用 `/技能名` 注入的正文不算"读过"（`skills/index.ts:198`），这条挡板会误伤。
- **(c) 老化只有手动动作**：`curate` 要人手点（`:881`、`:1044`）；`stale` 标记没有后果，不过滤任何东西（`skills/index.ts:108`）；归档那条台账写的是空 hash，**归档之后回滚不了**（`skill-write.ts:919`）。
- **并发无锁**：`patch` 是读改写，两次并发会互相覆盖（`:422`）；同秒备份同名也会覆盖（`ledger.ts:294`）。
- **来源徽章缺失**：只有"发现根"一种分组（`contract/plugin.ts:224`），`created_by: agent` 写了不读（`skill-write.ts:180`），界面逐行徽章已被删（`ui-skills/ui/ui.tsx:621`）。
- **测试只钉装配与纯函数**：self-improve 6 条、skills 6 条、ui-skills 6 条；集成只有 `scripts/self-improve-single-approval-test.mjs`。**写盘、回滚、老化、并发四类断言一条都没有。**

### 2.4 补齐方案（按三环）

**(a) 提炼**
1. `store.ts` 加 `draftFromCorrections(cwd)`：按 `turnRef` 把同源的 correction 聚合成一份草稿。
2. 复盘提示词附上现有技能名，`parseDraftAnswer` 认 `action=patch`，同名已存在时走 patch 而不是退候选。

**(b) 自修订**
3. `LearningsState` 加 `pendingRevision{name,turnRef}`：读过某技能、随后这一轮报错，下一轮起修订轮，产出 `patch`，账本 note 写清原因。
4. `/技能名` 注入正文时发 `dsc/skill-read` 并记进 `readSkills`，修掉那条误伤的挡板。

**(c) 老化**
5. `session-open` 里 24 小时节流调一次 `curateSkills`，结果落 `.curated.json`；31 天未命中的 agent 技能进 `.archive`。
6. `buildCatalog` 过滤 stale / archived（`skills/index.ts:107`）；归档台账写真实 `beforeHash`（`skill-write.ts:910`），**归档后能回滚**。

**(d) 横切**
7. 写技能加进程内互斥（防读改写覆盖）；备份文件名带毫秒与序号，防同秒覆盖。
8. 界面补来源徽章（`agent_created` / `hub` / `bundled`）与修订历史（读账本）。

### 2.5 验收断言（机器可判）

1. 同一 `turnRef` 的 3 条 correction 聚合出 1 份通过 `validateSkillDraft` 的草稿。
2. 同名技能已存在时，复盘解析成 `patch`，不调 `createSkill`。
3. 读过技能后本轮报错，下一轮落 `patch`，账本 note 含原因。
4. `/技能名` 注入后 `readBeforeWriteCheck` 通过。
5. 31 天未命中的 agent 技能进 `.archive`，`buildCatalog` 里不再出现。
6. 归档条目带真实 `beforeHash`，回滚后正文与归档前逐字节一致。
7. 两条并发 `patch` 都落账本，最终正文等于两次修改的叠加（不是后写覆盖前写）。

## 3. 任务三：影子 git 文件级 checkpoint / rewind

### 3.1 要解决什么

模型改了工作区文件，用户想回到某个回合之前；模型改的还原，用户手改的保留。

### 3.2 现状（核实过）

- **对话级 rewind**：记录形状 `{type:'rewind', keep, ts}`（`core/session.ts:284`）；`rewindToUser` 截内存消息、清掉被丢段的 toolErrors / fileChanges / presentations，再追加一行 `rewind`（`session.ts:900`）；load 时截到第 keep 条用户消息之前（`session.ts:796`）。插件侧 `rewind()` 只做校验、改标题、发事件（`packages/session/index.ts:279`）。**全程不碰任何文件。**
- **文件级 pre-image 只在内存里活一个回合**：`FileChangeSummary.baseline`（`core/tools.ts:26`）由 write / edit 写盘前读原文带出（`core/tools/fs-tools.ts:177`、`:241`）；落盘与发事件前一律 `stripBaseline`（`tools.ts:37`、`session.ts:987`）。回合基线由 `recordTurnChange` 记、回合末 `takeTurnChanges` 整表清空（`session.ts:1006`）。
- **bash / sed 没有基线**：只有回合首尾的 git 差集（`session-core/loop.ts:755`、`core/git-info.ts:479`），基线靠 `git show HEAD:path`。
- **git 执行器不支持 env**：`execFile('git', args, {cwd})`（`core/git-exec.ts:18`），`GIT_DIR` / `GIT_WORK_TREE` 传不进去——影子仓库的第一道拦路虎。
- **全仓没有影子仓库**：`grep checkpoint|shadow|merge-file` 在 `src` 下零命中。
- **业界对照**：dsh 的 checkpoint 是**会话日志落盘屏障**（请求前 / 工具前 / step 边界 flush），不碰文件；dsh 的 write/edit 只把 before/after 算成展示 diff。codex 的 `TurnDiffTracker` 也只在内存维护 baseline（`codex-rs/core/src/turn_diff_tracker.rs:19`），它的 `ghost_snapshot` 已退成兼容位、undo 特性已移除，只剩 `git baseline` 仓库给内部目录用（`codex-rs/git-utils/src/baseline.rs:21`）。**文件级可回滚 + 保手改这件事，两家都没做，hermes 才是参照。**

### 3.3 设计（草案，动工前先过一轮评审）

- **布局**：每个工作区 `<cwd>/.dsc/checkpoints/shadow.git`，显式传 `GIT_DIR`、`GIT_WORK_TREE=<cwd>`、`GIT_INDEX_FILE`，绝不写 `<cwd>/.git`、不动用户 index；`.dsc` 先写进 `.git/info/exclude`（不改 tracked 文件）。先例：codex `baseline.rs:213` 用环境变量钉死这两者。
- **粒度**：首条基线提交（全量可达文件），此后每回合一条，ref 用 `refs/dsc/turns/<n>` 加 `refs/dsc/checkpoint`，提交信息 `dsc turn <n> <iso> <sessionId>`。
- **writer-ledger**：`<cwd>/.dsc/checkpoints/ledger.jsonl`，一行 `{ts,turn,callId,tool,path,actor,op,preHash,postHash,blob,bytes}`；`actor` 取 `model` / `user`，`user` 由"盘上 hash 既不等于 preHash 也不等于 postHash"推断出来。
- **回滚算法**：设 A = 回合起点版本、M = 回合末版本、C = 盘上现值。`C == M` 直接写 A；`C == A` 跳过；其余用 `git merge-file -p C M A` 把模型改动反向合到用户现状；有冲突就不写盘，列清单让人选。
- **降级**：git 不可用 → 只按 ledger 的 blob 还原模型独有文件，不自动合并；单文件 >10MB 或二进制 → 只记 hash 不存内容、回滚时整文件覆盖；库超配额（默认 200MB）停写并提示；一律剥掉继承的 `GIT_*` 变量。
- **接入点**：回合边界有 `dsc/turn-start` / `dsc/turn-end`（`services/types.ts:1713`，已有 6+ 订阅者）；但"写成功 + 改动清单"的 `tool/changes` 是内核内部事件（`loop.ts:810`、`core/events.ts:85`），插件收不到——**要新增一个插件可见的写操作事件**，否则只能在守卫里自己再读盘算 hash。

### 3.4 验收断言（机器可判）

1. 连改两回合后回滚到第 1 回合末，文件逐字节等于当时版本。
2. 同回合用户手改的**另一个**文件，回滚后 hash 不变。
3. 用户与模型改同一文件的不同区域，回滚后模型区域消失、用户区域保留。
4. 同区域冲突时返回冲突清单，盘上 hash 与 mtime 都不变。
5. 有 `.git` 的工作区：回滚前后 `git status --porcelain` 与 refs 列表完全一致。
6. 无 `.git` 的工作区同样能回滚，且 `.dsc` 不出现在未跟踪列表里。
7. 二进制回滚后 sha256 与 `.blobs` 存的相同。
8. 每次成功写操作在 `ledger.jsonl` 恰好一行，`callId` 与 `tool/changes` 一一对应。

## 4. 任务四：欠项补齐

| 欠项 | 现状 | 位置 |
| --- | --- | --- |
| 完整 PTY 终端 | 没有 PTY，全屏程序跑不了，长命令不能中途打断 | `tools-default/bash.ts:843`、`persistent-shell.ts:11` |
| npm 包形态插件安装 | 工具层只收单文件，真装包的能力只在 CLI | `plugin-manager/index.ts:86`、`cli/plugin-cli.ts:252` |
| 多工作区 / 异根 @ 补全 | 单根 DFS，跨卷直接拒 | `core/mention.ts:99`、`desktop-dock/index.ts:648` |

### 4.1 PTY（T48）

**现状**：前台命令一条一进程，`shellPlan` 折成 file+args（`tools-default/bash.ts:326`）→ `spawnShell`，stdin 直接关死（`:155`）；结束判定靠子进程 close，没有提示符事件（`:252`）；超时与取消是 SIGTERM / taskkill → 3 秒宽限 → 强杀（`:210`、`:47`）。后台作业复用同一 spawn，超时给 24 小时（`:384`）。`terminal` 工具是管道 stdin/stdout，靠哨兵行判完成（`persistent-shell.ts:99`）。界面那侧有 xterm + FitAddon，但只做前端重排（`ui-terminal/ui/ui.tsx:145`）。

**缺**：无 tty（全屏程序跑不了）；Ctrl+C 不能真中断；没有 resize，行列数到不了进程（`desktop-dock/index.ts:344`）；前台输出到最后才一次性解码（`:202`）；终端会话存内存，宿主重启就丢（`:904`）；编码靠 UTF-8 / GBK 猜（`:295`）。

**参考**：codex 自建 pty crate，Windows 手写 ConPTY 与 resize（`codex-rs/utils/pty/src/win/conpty.rs:40`）；dsh 用 `node-pty` 1.2 beta，懒加载 + `useConptyDll` + `resize` + Ctrl+C 写 `\x03` + `@xterm/headless` 判结束（`D:\deepseek-harness` 的 subprocess-local / terminal-bash）。

**方案**：

- **A 接 node-pty（推荐）**：原生依赖 + 按 Electron ABI 重建；收益是 resize / Ctrl+C / 全屏一次到位。风险：1.2 仍是 beta；受限令牌下 ConPTY 可能起不来（codex 也把 PTY 排除在作业对象外）。
- **B koffi 直调 `CreatePseudoConsole`**：零新原生包，但手写句柄、管道、进程属性约 600–900 行需自己维护；句柄泄漏与杀树都得自理。

**前置探针（必须先跑，不通过就不立项）**：在打包 Electron 运行时下 `require` node-pty，起一个 PTY 跑 `cmd /c echo hi`，在 `windows-token` 后端下再跑一次。跑不通就退 B 或推迟。

**验收**：`send("vim\n")` 后 `read` 含 `\x1b[` 且不再提示"跑不了"；新 resize 动作后 `stty size` / `RawUI.WindowSize` 随参数变；长命令发 `\x03` 后 5 秒内 `status=closed` 且退出码非 0；打包产物里 node-pty 的 `.node` 按 Electron ABI 可 `require`。

### 4.2 npm 包形态安装（T49）

**现状**：工具层只有 6 个 action（`plugin-manager/index.ts:54`）；`install` 只收 `.js` 绝对路径并复制（`:86`）；`install_remote` 只拉单个 `.js` 直链（`:127`）。市场只认 GitHub tree 与 JSON 索引、只收 `*.js`（`config-core/market.ts:607`），安装只写 `mainFile`（`:678`）。**真能装包的是 CLI**：在 profile 里跑 `pnpm add`（`cli/plugin-cli.ts:252`），再把 bundles 并进去（`:277`）；包目录取自 `node_modules/<name>`（`core/plugin-bundle.ts:383`）。插件中心只有文件选择器，没有包名输入框（`ui-plugins/ui/ui.tsx:305`）。

**方案**：

- **A 把 CLI 的 pnpm 路径升级成内核能力（推荐）**：tarball、integrity、lockfile、依赖树全免费，与 CLI 同一条路。代价是依赖 PATH 里的 pnpm（桌面端要自带 pnpm 或 corepack），且装包会跑构建脚本，必须走单独审批。
- **B 自研 tarball（照 codex）**：`npm pack --ignore-scripts` 到临时目录（codex `core-plugins/src/npm_source.rs:78`），自己解包校验。代价 400–600 行，还要自写 semver 与 node_modules 提升；收益是不依赖外部 pnpm。

**验收**：`add` 后 `dependencies` 与 `bundles` 同时含该包，`node_modules/<包名>/package.json` 存在；`file:./x.tgz` 装完能读出 patch 条数；`remove` 后两处都不含、目录消失；非法包名被正则拒（`plugin-cli.ts:204`）；构建脚本单独一次审批（照 dsh 的 `build-approval`）。

### 4.3 多工作区 / 异根 @（T50）

**现状**：`mention.ts` 只做定位、排序、插入，清单由 lister 注入（`core/mention.ts:32`）；`collectWorkspaceFiles` 单根 DFS，4000 文件 / 深度 6（`:99`）。TUI 拉一次缓存、root 固定 `.`（`tui/app/Composer.tsx:196`）。壳侧另写一份懒递归（500 文件 / 深度 4 / 60 秒 TTL，`ui-composer/ui/mention.ts:15`）。dock 的 `fs-list` 限会话 cwd，越界即拒（`desktop-dock/index.ts:378`），跨卷 `relative` 返回绝对路径直接拒（`:648`）。根集合只有 `recentCwds`（`core/native-bridge.ts:81`），没有工作区注册表。

**方案**：

- **A 根集合显式化（推荐，长期）**：meta 存 cwd 数组，候选带根前缀，`fs-list` 加 root 参数只放行已授权根；顺带解决跨盘、同名消歧、两套补全漂移（4000/6 对 500/4）。代价是要改会话契约与 dock 通道。
- **B 只做临时切根（`@D:/x` 列绝对根，约 100 行）**：不动契约，但候选与正文路径形态会分叉，chip 与工具读文件对不上。

**验收**：cwd 为 `D:\dsc` 时 @ 候选出现第二根下的文件，插入路径能被 `fs-read` 打开；两根同名 `README.md` 在候选里可区分；`fs-list` 传未授权根报"超出工作目录"、传第二根成功；`collectWorkspaceFiles` 只剩一处引用。

## 5. 明确不做

- 不做 Windows 之外的 OS 沙箱（本轮只 Windows，用户明确）。
- 不做 T53 对外 SDK / T54 SSH 远程执行（roadmap 写着"等真实需求"）。
- 不因为做沙箱就顺手改 PTC 的隔离模型（那是 T10，单独立项）。

## 6. 批次划分（每批可独立验收、独立提交）

| 批次 | 内容 | 门禁 |
| --- | --- | --- |
| B0 核查与文档 | 四路只读审查 + 本文档 + roadmap 差距表 | 文档评审通过 |
| S1 沙箱·解释器 | 显式 node 解释器（`DSC_NODE` 或 `ELECTRON_RUN_AS_NODE=1`），打包件实跑 runner | 打包态集成用例通过 |
| S2 沙箱·验收 | 新增 `scripts/sandbox-win-token-test.mjs`（纯函数 + 根外写集成用例），修失效引用 | 非管理员全绿、管理员集成绿 |
| S3 沙箱·健壮性 | runner `--timeout` + `TerminateJobObject`；失败分支令牌 dispose；管道收尾 | 超时与失败用例 |
| S4 沙箱·清扫并发 | 启动扫残留 ACE；setup 命名互斥；卸载函数 | 强杀重启后 ACE 已清；并发 setup 只有一个生效 |
| S5 沙箱·强制力 | deny-write / deny-delete ACE、目录 no-reparse、硬链接拒绝、`\\?\` 长路径 | 硬链接与长路径用例 |
| S6 沙箱·网络 | 白名单代理通用化；无账号时强制报 partial | 直连被拦 + enforcement 上报 |
| B3 自我改进·提炼与自修订 | 纠正按 `turnRef` 聚合出草稿；复盘认 `patch`；用错后自动起修订轮；`/技能名` 注入算读过 | 断言 1–4、7 |
| B4 自我改进·老化与归档 | 24h 节流 `curateSkills`；31 天未命中进 `.archive`；`buildCatalog` 过滤；归档台账写真实 `beforeHash` | 断言 5–6 |
| B5 自我改进·横切 | 写技能互斥、备份名带毫秒、来源徽章、修订历史界面、补集成测试 | 并发与界面用例 |
| B5 影子 git·骨架 | `git-exec` 支持 env、写操作事件、影子仓库与账本 | ledger 行数与写操作一一对应 |
| B6 影子 git·回滚 | 三方合并、冲突清单、降级 | §3.4 八条断言 |
| B7 PTY | 先跑 node-pty 探针；通过则接入并补 resize / Ctrl+C / 打包 | 探针 + 四条验收 |
| B8 npm 安装 | 复用 pnpm 路径升级为内核能力，带审批与回滚 | §4.2 验收 |
| B9 多根 @ | 根集合显式化，候选带根前缀，两套补全合一 | §4.3 验收 |
| B10 收口 | 全量门禁 + 独立审查 + 文档与路线图同步 | `check:all` 全绿 |

## 7. 已拍板的决定（2026-11-11）

1. **沙箱默认后端：C 方案**——默认就走 `windows-token` 真隔离；被拒时给一次升权卡（"这条命令想写 `~/.npm`，这次放行吗"）；设置里能退回 `policy`。同时把 `~/.npm`、`~/.cargo`、pip 缓存这类**只写缓存的目录**做成可选的默认白名单，否则装依赖就会炸。前置：S3（超时健壮）与 S4（清扫并发）先做完。
2. **网络第二级：接受首次弹一次 UAC**。用户可跳过；跳过就明确报 `partial`，并在系统提示里写"网络未强制"。
3. **自我改进：保持整包默认关**，要用户到设置里打开。
4. **自修订：只在"读过某技能、随后这一轮报错"时自动起一轮修订**，产出 `patch` 并记原因；不做定时主动复盘。
5. **PTY：先跑探针，通过就接 `node-pty`**。探针验三件事：打包 Electron 下能 `require`、`windows-token` 后端下 PTY 能起、resize 生效。过不了就退 `koffi` 手写或推迟。
6. **npm 安装：复用 CLI 已有的 `pnpm` 路径**，把它升级成内核能力；桌面端要自带 `pnpm` 或 corepack。

### 由上述决定带来的额外改动

- 沙箱要新增两块：**越界拒因的"人话翻译"**（把 `ACCESS_DENIED` 翻成"这条命令想写 X，不在允许范围内"）与**缓存目录白名单**。
- 沙箱的后端默认值要从 `policy` 改成 `windows-token`，并且探测失败时要能平滑回落到 `policy` 而不是直接报错。
- PTY 的探针脚本要在 S1 之后、B7 之前单独跑一次，结论写进本文档。

## 8. 环境事实（核对过）

- 分支 `feat/pluginization`，版本 0.9.1 → 桌面端同版本。
- Node v24.19.0，pnpm 10.15.0。
- `sandbox/win/` 共约 3000 行，`self-improve/` 约 2500 行，均已在 0.9.x 提交过（`git log` 可查）。
- 参考源码：codex 在 `D:\codex\codex\codex-rs`，dsh 在 `D:\deepseek-harness`。
