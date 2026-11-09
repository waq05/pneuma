# 批次 06：工具与安全

## 范围

实际读过的文件（全部按工作区现状；`git status --porcelain` 显示本批次源文件**均无未提交改动**，
在途改动只在 `docs/*`、`ui-shell/src/plugin-api.ts`、`src/packages/ui-*`，与本批次无交集；
`docs/code-review/` 目录本身是新增未跟踪）：

- 契约与策略：`src/core/tools.ts`(226)、`src/core/command-policy.ts`(703)、`src/core/path-policy.ts`(334)、
  `src/core/secrets.ts`(172)、`src/core/untrusted.ts`(57)、`src/core/tool-guards.ts`(156)、`src/core/spill.ts`(386)、
  `src/core/shell-quote.ts`(26)、`src/core/unified-diff.ts`(114)、`src/core/diff-text.ts`(前 30 行)
- `src/core/tools/`：`command-runner.ts`(135)、`sandbox-args.ts`(103)、`fs-tools.ts`(254)、`path-args.ts`(20)，
  以及四个一行垫片 `bash.ts` / `image-tool.ts` / `search-tools.ts` / `tool-result-prune.ts`
- `src/packages/tools/index.ts`(83)、`tools-default/`：`index.ts`(427)、`bash.ts`(1141)、`persistent-shell.ts`(269)、
  `search-tools.ts`(430)、`image-tool.ts`(62)
- `src/packages/sandbox/`：`index.ts`(1082)、`policy.ts`(679)、`execpolicy.ts`(525)
- `src/packages/approval/index.ts`(1543)、`approval-floor/index.ts`(273)、`approval-floor/approval-floor.ts`(958)
- `src/packages/permission-core/index.ts`(16)、`permission-core/permission-scope.ts`(163)、
  `permission-core/permission-presets.ts`(131)、`permission-presets/index.ts`(213)
- `src/packages/guards/index.ts`(33)、`hooks/index.ts`(1145)、`hooks/lifecycle-hooks.ts`(734)、
  `session-core/hooks.ts`(1010)、`session-core/modes.ts`(96-147)、`session-core/loop.ts`(580-780)
- `src/packages/ptc/index.ts`(407)、`spill/index.ts`(249)、`mode/index.ts`(60-149)、
  `subagent/index.ts`(470-640)、`ops/tools.ts`(495-650，只读对照)、`ui-transcript/ui/intended-diff.ts`(222，只读对照)

本轮只做静态阅读（read/grep/glob/只读 pwsh），未 build、未 install、未跑测试。

## 结论摘要

- **P0 3 条 / P1 10 条 / P2 7 条**（共 20 条）
- 三条最重要的话：
  1. **守卫链有两份**：队友（subagent）自己 `new ToolGuardRegistry()`，只挂 2 位守卫 + 1 个观察者，
     沙箱（order 8）、灾难地板（5）、安全钩子（20）、生命周期钩子（25）、溢出（50）对队友的工具调用全部不存在。
  2. **`grep` 工具绕过整套读禁名单**：`read` 调 `readBlockReason` 拒读 `.env`/`id_rsa`，`grep` 扫目录时一个文件一个文件直接读，
     没有任何路径判定，且它的 `risk: 'read'` 让审批守卫直接 defer —— 一条命令就能把凭据正文印进对话。
  3. **同一条命令有三套分类表、三个结论**：`git push --force` 在 `command-policy` 是「问人」（设计意图），
     在 `sandbox/execpolicy` 因为「要联网」默认**硬拒**（网络开关出厂是关的），用户永远看不到那张审批卡。

---

## approval

### [P1] 一次写调用的判定顺序里，「能不能写这个路径」被判了三次，其中两次用的不是同一份表

- 位置：`src/packages/session-core/loop.ts:665`、`src/packages/sandbox/index.ts:320`、`src/packages/approval/index.ts:1293`、`src/core/tools/fs-tools.ts:171`
- 现象：一次 `write` 从上到下要过 8 道，其中第 3、第 7.5、第 8 道都在回答同一个问题（这个路径许不许写），
  而且三处各用一套判据：沙箱守卫用 `checkWrite`（`sandbox/policy.ts:613`），审批层再调一次
  `sandbox.check()`（`sandbox/index.ts:972`）重做同一条判定，工具本体最后又调 `writeHardBlockReason`
  （`core/path-policy.ts:203`）。实际顺序：
  1. `loop.ts:664` `gateIdentity`（桥接工具换真名/真风险）→ `loop.ts:665` `guards.gate`
  2. order 5 `approval-floor`：`approval-floor.ts:700` `evaluate` → 写分支 `:712-720`（denyGlobs、unattended）
  3. order 8 `sandbox`：`sandbox/index.ts:282` → `:320` `writeVerdict` → `checkWrite`
  4. order 10 `mode`：`mode/index.ts:93` → `session-core/modes.ts:103-147`
  5. order 20 `hooks`：`hooks/index.ts:379`（命中 ask 时**自己**调 `ctx.approval.decide`，见下一条）
  6. order 25 `lifecycle-hooks` PreToolUse：`hooks/index.ts:452`
  7. order 30 `approval`：`tool-guards.ts:144` → `approval/index.ts:1203`
     （`:1241` 硬地板 → `:1255` 说明书 → `:1262` 会话授权 → `:1267` 前缀规则 → `:1281` 地板白名单 →
      `:1293` **第二次**沙箱判定 → `:1304` run_code 特例 → `:1317` 权限模式 → `:1345` 审阅者 →
      `:1406` `approvalDiffOf` → `:1407` `askHuman`）
  8. 工具本体：`fs-tools.ts:171` 硬拒 → `:173` 覆盖检查 → `:182` CAS → 落盘
  9. `loop.ts:712` `guards.observe`（遮红 10 → hooks 40/45 → spill 50）
- 证据：
  ```
  src/packages/approval/index.ts:1293        const fence = ctx.get('sandbox')?.check(target ?? undefined, command ?? undefined, cwd, request.sessionPath)
  src/packages/sandbox/index.ts:971-972      * 守卫里同一条判定已经做过一遍（order 8），这里再做一遍是刻意的——审批是
                                             * 自动放行的最后一道，它不能假设「沙箱一定已经判过」。
  src/core/tools/fs-tools.ts:171             const hard = writeHardBlockReason(file)
  ```
- 影响：三处表已经不一致（见 sandbox 节的 NT 前缀 / ADS / `~/.dsc` 控制文件三条对照）。改一处必然漏两处：
  例如给沙箱加一条受保护名，工具本体与审批硬地板不会跟着拦；反之亦然。第 7.5 道的注释自己承认这是「刻意重复」，
  但重复的是**判定**而不是**结论缓存**，所以任何新规则都要写两遍才生效。
- 建议：把「一个路径能不能写」收成一份 `WriteTargetVerdict`，由 sandbox 插件唯一实现并通过
  `SandboxService.check()` 暴露；守卫（order 8）与审批（第 4 层）都只**调它、不重算**，
  审批层拿守卫这一轮已经算过的结论（`gate` 的返回值里带 `detail`），工具本体只保留「硬拒」那一份纯函数。
- 置信度：高（三处调用点与实现全部读过）

### [P1] 安全钩子命中 ask 时自己弹审批卡，并用 `pass` 跳掉后面的生命周期钩子与审批层

- 位置：`src/packages/hooks/index.ts:423-434`、`src/packages/hooks/index.ts:452-485`、`src/core/tool-guards.ts:114`
- 现象：`hooks` 守卫（order 20）在规则命中 `ask` 时直接调 `ctx.approval.decide(...)`，人点「允许」后返回
  `{ action: 'pass' }`。`ToolGuardRegistry.gate` 见到 `pass` 立即返回，排在后面的 order 25
  `lifecycle-hooks` PreToolUse 与 order 30 `approval` 都不再被问一次。
- 证据：
  ```
  src/packages/hooks/index.ts:423            const decision = await ctx.approval.decide(
  src/packages/hooks/index.ts:433-434        // 人已经看过这一次了，别再让审批环节问第二遍。
                                             return { action: 'pass' }
  src/core/tool-guards.ts:114                if (verdict.action !== 'defer') return verdict
  ```
- 影响：两条后果。(1) 用户在 `lifecycle-hooks.json` 里配的 PreToolUse `deny` 规则，只要同时也命中了
  `hooks.json` 里一条 `ask` 规则并被批准，就**不执行**——同一个「工具动手前」的检查点被分成两套，
  谁先说话谁算。(2) 这次调用绕过了审批层的第 1/2/4 层（硬地板、说明书、沙箱围栏），因为 `decide` 传进去的
  只有 `toolName/argsSummary/args/cwd`，没有 `sessionId/sessionPath`，`sidOf()` 会退回「当前查看的会话」，
  后台会话的写操作会拿到**别的会话**的权限档位。
- 建议：钩子不要在守卫里自己弹卡。改成 `defer` 并把 `forceAskReason` 放进一个链上共享的 `input.forceAsk`，
  由 order 30 的审批守卫统一弹卡（它已经支持 `forceAskReason`，见 `approval/index.ts:1211-1212`）；
  若必须就地弹，至少补齐 `sessionId/sessionPath`。
- 置信度：高（`gate` 的短路语义与 `decide` 的 `sidOf` 回退都读过）

### [P1] 审批层「文件写类工具」只认 `write`/`edit`，ops 的六个写类工具在默认档每次都要弹卡

- 位置：`src/packages/approval/index.ts:104`、`src/packages/approval/index.ts:1331-1340`、`src/packages/approval/index.ts:1235-1238`、`src/packages/ops/tools.ts:426`
- 现象：`PATH_WRITE_TOOLS` 只有两个字面量，而 `DIFF_PREVIEW_TOOLS` 认八个。同一个判断（「这次是要写文件」）
  在同一个文件里写了两份名单，覆盖范围不同。后果：
  - `ops_write_file`（`risk: 'write'`、目标在工作区内）在默认「工作区可写」档**不**免卡（`writable` 为 false），
    而 `write` 免卡；
  - `ops_copy`/`ops_move` 的「本会话允许」拿不到 session 档（`sandboxSessionRoot` 要求 `PATH_WRITE_TOOLS.has(...)`）；
  - `grantKeyOf` 对 ops 系列退化成工具名，工作区内/外共用同一个授权键。
- 证据：
  ```
  src/packages/approval/index.ts:104          const PATH_WRITE_TOOLS = new Set(['write', 'edit'])
  src/packages/approval/index.ts:107-116      const DIFF_PREVIEW_TOOLS = new Set(['write','edit','ops_write_file','ops_edit_file','ops_replace','ops_copy','ops_move','ops_remove'])
  src/packages/approval/index.ts:1336         const writable = PATH_WRITE_TOOLS.has(request.toolName) && insideCwd && (fence?.allowed ?? true)
  ```
- 影响：用户装了 ops 插件（写类六个工具），默认档下一次写文件要弹一次卡，模型会以为「工作区可写」是假的，
  转而改用 `write`——工具的语义差别（修订锚、dryRun、不覆盖）全被绕过。
- 建议：把这两份名单合成一份带语义的声明（`{ writesPath: true, previewable: true }`），
  放进 `ToolEntry` 的契约位；审批层按契约判断，不再维护按名字的白名单。
- 置信度：高

### [P2] 升权请求的卡片理由被「沙箱越界」那一支抢走，`justification` 不上卡面正文

- 位置：`src/packages/approval/index.ts:1293-1294`、`:1371-1380`、`src/packages/sandbox/index.ts:330-331`
- 现象：模型带 `sandbox_permissions: 'danger-full-access'` 请求放宽时，沙箱守卫（order 8）直接 `defer` 放它过去
  （`:331`），但审批层随后算出的 `fence` 仍然是「越界」，于是 `baseReason` 走 `fenced` 那一支，
  卡面写「沙箱边界：…（允许这一次就破例执行）」，而不是「模型请求放宽沙箱：<理由>」。
- 证据：
  ```
  src/packages/approval/index.ts:1372-1373     fenced
                                              ? `沙箱边界：${firstSentence(fence?.reason ?? '这次调用越界')}…`
  src/packages/sandbox/index.ts:331             if (request.permission === 'danger-full-access') return { action: 'defer' }
  ```
- 影响：用户看到的是「它想越界」而不是「它申请越界并说明了原因」，`escalation.justification` 只落在结构化字段里，
  移动端窄卡片下面那行理由读不到，批准率/拒绝率都会失真。
- 建议：`baseReason` 的分支顺序改成 `escalation !== null` 优先于 `fenced`（两行位置对调）。
- 置信度：高

---

## approval-floor

### [P2] 地板自带第三张危险命令表（`POWER_HEADS`/`FORK_BOMB`/`SHELL_HEADS`），与 `command-policy` 的 `HARDLINE`/`DANGEROUS` 各管一段

- 位置：`src/packages/approval-floor/approval-floor.ts:413-441`、`src/core/command-policy.ts:247-332`、`src/packages/sandbox/execpolicy.ts:41-115`
- 现象：三处各有一张「危险命令表」，覆盖范围互不包含：`command-policy` 管 rm/format/diskpart/强推/删库，
  `approval-floor` 补关机/重启/fork 炸弹/`sh -c` 判不了，`sandbox/execpolicy` 又管 schtasks/reg/netsh/bcdedit/takeown/icacls。
  只有 `builtinDangerHit` 那一份是共享的（这点做得对，`approval-floor.ts:488` 直接调它）。
- 证据：
  ```
  src/packages/approval-floor/approval-floor.ts:413   const POWER_HEADS: Readonly<Record<string, (args: readonly string[]) => string | null>> = {
  src/packages/approval-floor/approval-floor.ts:431   const SHELL_HEADS = new Set(['sh','bash','zsh','dash','ksh','pwsh','powershell','cmd'])
  src/packages/sandbox/execpolicy.ts:41               const FORBIDDEN_RULES: readonly ExecRule[] = [
  ```
- 影响：加一条新的危险模式要知道该加在哪张表、以及那张表的结论是 ask 还是 deny。三张表里 `schtasks`
  同时出现在 `command-policy:322`（ask）与 `execpolicy:44`（forbidden），结论相反（见 sandbox 节第一条）。
- 建议：把「危险动作清单」收成一份带 `severity: ask|deny` 的表，三处都读它；`approval-floor` 只保留
  「结构判不清」（引号/括号/命令替换）这一类它独有的能力。
- 置信度：高

---

## sandbox

### [P0] 同一条命令三套结论：`git push --force` / `powershell -Command` / `cmd /c del` 各自被判成 ask、deny、defer

- 位置：`src/core/command-policy.ts:303`、`:322`、`src/packages/sandbox/execpolicy.ts:321`、`:480-489`、`:396-422`、
  `src/packages/sandbox/index.ts:273`、`src/packages/approval-floor/approval-floor.ts:506-513`
- 现象：三套分类器的分工写在注释里（`execpolicy.ts:4-9`：「一个是审批面、一个是围栏面」），但它们的**结论集合互相覆盖**，
  而链上的先后（地板 5 → 沙箱 8 → 审批 30）决定了谁的结论说了算。逐条对照：

  | 命令 | `classifyCommand`（审批面） | `evaluateCommand`（围栏面） | `approval-floor`（地板） | 实际结果 |
  | --- | --- | --- | --- | --- |
  | `git push --force` | ask（`command-policy.ts:303` force-push） | **forbidden**（`execpolicy.ts:321` 把 `push` 算网络；`:480-489` 网络开关关 → forbidden） | defer（`approval-floor.ts:772-776` 危险但交卡） | 沙箱直接拒，卡不弹 |
  | `powershell -Command "Get-Content .env"` | ask（头是 `powershell`，不在只读名单） | defer（`execpolicy.ts:412-422` 拆出内层，只读，无写目标 → prompt→`index.ts:273` 折成 PASS） | **deny**（`approval-floor.ts:506-513` 命中 `INLINE_FLAGS` 的 `-command` → 「判不出要跑什么」） | 地板直接拒，卡不弹 |
  | `cmd /c del x` | ask（头 `cmd`） | defer（内层 `del x`，写目标在工作区内） | **deny**（同上，`cmd` 在 `SHELL_HEADS` 里、`/c` 在 `INLINE_FLAGS` 里） | 地板直接拒，卡不弹 |
  | `schtasks /create /tn x /tr calc` | ask（`command-policy.ts:322` account-or-task） | **forbidden**（`execpolicy.ts:44-47`） | defer（危险，交卡） | 沙箱直接拒，卡不弹 |

- 证据：
  ```
  src/core/command-policy.ts:303        { name: 'force-push', re: /\bgit\s+push\b[^\n|;]*(--force\b|-f\b(?!or))|(--force-with-lease)/i, decision: 'ask', … }
  src/packages/sandbox/execpolicy.ts:321      git: new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule', 'archive']),
  src/packages/sandbox/index.ts:273           if (verdict.decision !== 'forbidden') return PASS
  ```
- 影响：`git push --force` 在出厂配置下（`sandbox/policy.ts:90` `networkAccess: false`）永远到不了审批卡，
  用户看到的是「沙箱拒绝：这一段要联网」——而设计文档、`/floor` 输出、审批卡文案全都说这条命令会「弹卡问人」。
  同理 `npm install`、`git clone`、`pip install` 都是「沙箱互斥、审批沉默」。用户想放宽只能去改网络开关，
  而那个开关不是为「我想推一次」设计的。**这一条我按 P0 计：同一份产品承诺在两个实现里给出相反结论。**
- 建议：二选一，别维持现状。(a) 围栏面只保留「写目标」这一半，把「网络」从 forbidden 降成 ask 交给审批卡；
  (b) 把三套表合并成一份 `CommandPolicyVerdict { decision, rule, reason, scope }`，沙箱只加 `fence` 位，
  审批只减 `ask` 位。无论哪条，`evaluateCommand` 的 `allow/prompt` 两档要么用起来、要么删掉（现在只有 forbidden 被消费）。
- 置信度：高（三条命令的判定路径逐行核对过）

### [P2] `evaluateCommand` 的三值结论只用了 `forbidden`，`allow`/`prompt` 与 `rule: 'default'` 是死分支

- 位置：`src/packages/sandbox/execpolicy.ts:507-524`、`src/packages/sandbox/index.ts:267-275`
- 证据：
  ```
  src/packages/sandbox/execpolicy.ts:518-524   return { decision: 'prompt', rule: 'default', reason: `没命中沙箱的放行规则…` }
  src/packages/sandbox/index.ts:273            if (verdict.decision !== 'forbidden') return PASS
  ```
- 现象与影响：`prompt`/`allow` 两条结论与它们的 `reason`（「没命中沙箱的放行规则，按默认交给审批卡」）
  在唯一调用方被折成 `PASS`（即 defer），谁都不会读到那句理由。`ALLOW_RULES`（`:118-126`）和
  `rule: 'allow-rule'` 同理只是摆设——真正的「只读放行」是 `command-policy` 的 `READONLY_HEADS` 在做。
  读代码的人会以为沙箱有一份 allow 白名单在起作用，其实没有。
- 建议：把 `ExecDecision` 收成 `'forbidden' | 'pass'`，删掉 `ALLOW_RULES` 与 `ruleUnfriendly` 那段 allow 判定；
  或者反过来，让沙箱的 allow 真的短路审批（那就得改 `index.ts:267-275`）。
- 置信度：高

### [P1] `core/path-policy.ts` 与 `sandbox/policy.ts` 是两套「路径许不许写」，同一条路径结论不一致

- 位置：`src/core/path-policy.ts:69`、`:72-79`、`:203-222`、`src/packages/sandbox/policy.ts:270`、`:279-293`、`:303-310`、`:431-453`
- 现象：两套并存，都在用：
  - `core/path-policy.ts`：被 `fs-tools`（`:98/:171/:227`）、`ops/tools`（`:48/:87`）、`image-tool`（`:45`）、
    `cdp/actions`（`:546`）、`sandbox/review`（`:215`）、`approval`（`:1242/:1255`）、`session-core/modes`（`:135`）用；
  - `sandbox/policy.ts`：被沙箱守卫（`index.ts:320`）、`check()`（`:972`）、`canWrite()`（`:959`）用。
  同一条路径的结论差异（逐条核对过）：

  | 路径 | `core/path-policy` 的写判定（`writeHardBlockReason` / `isProtectedInstruction`） | `sandbox/policy.checkWrite` | 差在哪 |
  | --- | --- | --- | --- |
  | `C:\proj\x\?\C:\Windows\a.txt` | 放行（`path-policy.ts:69` 的 `NT_NAMESPACE` 锚定在开头） | **拒** `nt-namespace`（`policy.ts:270` 判「任意位置」） | 正则锚点 |
  | `//?/C:/Windows/a.txt` | 放行（要求反斜杠） | **拒**（`policy.ts:282` 先把 `/` 换成 `\` 再判） | 分隔符归一 |
  | `C:\ws\ok.txt:hidden` | 放行 | **拒** `ads-stream`（`policy.ts:303-310`，core 没有这一条） | NTFS 数据流 |
  | `\\server\share\x` | 放行 | **拒** UNC（`policy.ts:289-291`） | UNC 前置判定 |
  | `~/.dsc/plugins.json` | 「必须当面确认」（`path-policy.ts:229-249`，走审批卡） | **硬拒** `protected-metadata`（`policy.ts:449-451`） | 一个要问、一个不许 |

- 证据：
  ```
  src/core/path-policy.ts:69        const NT_NAMESPACE = /^(\\\\[?.]\\|\\[?.]\\)/
  src/packages/sandbox/policy.ts:270 const NT_NAMESPACE = /\\\\[?.]\\|\\\?\?\\/i
  src/packages/sandbox/policy.ts:449 if (compareKey(absPath, win32).startsWith(`${home}\\`) && DSC_CONTROL_FILES.has(lowered)) {
  ```
- 影响：`approval/index.ts:5-8` 的设计写「路径护栏层：说明书类文件必须当面确认一次，不许任何自动档代劳」，
  但 `~/.dsc/plugins.json`、`policy.rules`、`config.yaml` 在沙箱那一层（order 8，早于审批 30）就被硬拒了，
  这张卡永远不会弹——用户以为「会问我一次」，实际得到的是「沙箱拒绝」。反过来，NT 前缀的中缀写法与 ADS
  从 `write`/`edit` 工具这条路进来时 `writeHardBlockReason` 放行，只剩沙箱那一层拦，而沙箱可以被
  `danger-full-access` 档整档关掉（`sandbox/index.ts:288` 直接 defer）——那时两套都不拦。
- 建议：形状判定（NT/ADS/UNC/8.3）只留一份，放在 `core/path-policy.ts` 并从 `sandbox/policy.ts` 调它；
  「受保护名」拆成两档显式声明：`hardDeny`（沙箱拒）与 `mustAsk`（审批必弹），别让两套名单各存一半。
- 置信度：高（五组对照逐条读过两个实现）

---

## permission-core / permission-presets

### [P2] 三项权限的写口有两条，`writePermissions` 与 `pinPermission` 只差一个「是否立刻落盘」

- 位置：`src/packages/permission-core/permission-scope.ts:98-109`、`:121-131`、`:140-149`
- 现象：同一个「把三项并进会话状态」的动作有两个实现，区别只在 `appendState`（落盘）与 `setState`（只记内存）。
  两者都各自算一遍 `before/after` 的合并与「有没有变」。
- 证据：
  ```
  src/packages/permission-core/permission-scope.ts:106   if (typeof session.appendState === 'function') session.appendState('permissions', after)
  src/packages/permission-core/permission-scope.ts:128   if (typeof session.setState === 'function') session.setState('permissions', after)
  ```
- 影响：`writePermissions` 有「值没变就不写」的短路，`pinPermission` 没有——语义差别靠调用方记住。
  将来加第四项权限（比如「网络」）要改两处合并逻辑，漏一处就出现「只改内存的路径少写一项」。
- 建议：合成一个 `mergePermissions(session, patch, mode: 'flush' | 'lazy')`，`pin` 只是一个薄封装。
- 置信度：高

---

## guards / tool-guards

### [P0] 守卫链有两份：队友自己新建 `ToolGuardRegistry`，只挂 2 位，沙箱/地板/钩子/溢出全缺

- 位置：`src/packages/subagent/index.ts:477-529`、`:622`、`src/packages/guards/index.ts:20-31`
- 现象：主会话的守卫链由 `guards` 插件唯一持有（`guards/index.ts:21`），但 subagent 为每个队友
  `new ToolGuardRegistry()` 另建一条，只注册 `teammate-mode`（order 5）+ `toolApprovalGuard`（order 30）
  + 一个 `redact` 观察者。全局链上的 order 5 `approval-floor`、8 `sandbox`、20 `hooks`、
  25 `lifecycle-hooks`、25 `file-review`、50 `spill` 在这条链上都不存在。队友的循环被直接塞进这条链（`:622`）。
- 证据：
  ```
  src/packages/subagent/index.ts:477       const guardsFor = (teammate: Teammate): ToolGuardRegistry => {
  src/packages/subagent/index.ts:478         const chain = new ToolGuardRegistry()
  src/packages/subagent/index.ts:527         chain.registerObserver({ id: 'redact', order: 10, observe: (_toolName, text) => redact(text) })
  ```
- 影响：用户在 `hooks.json` 里写的「本项目禁止碰 migrations/」对队友**完全不生效**；`approval-floor` 的
  deny 黑名单（`.env`、`id_rsa`、`/etc/passwd`）对队友不生效；队友的工具输出不溢出（不落盘、直接进它的上下文）。
  且这是「改 A 忘 B」的结构：以后往主链加第 9 位守卫，队友那条链不会自动获得。
- 建议：删掉 `guardsFor` 里的 `new ToolGuardRegistry()`，改成「在全局链前面插一位 `teammate-mode`」——
  即 `ctx.guards.register({ id: 'teammate-mode:<name>', order: 5, ... })`（以队友 id 键控、退出时退订），
  让队友与主会话共用同一条链；等级差（`APPROVAL_RANK`）保留在 `approve` 回调里。
- 置信度：高（注册点、消费点、被跳过的五位守卫全部核对过）

### [P2] `toolApprovalGuard` 把所有 `risk: 'read'` 直接 defer，读类工具因此没有任何守卫能拦

- 位置：`src/core/tool-guards.ts:148-149`
- 证据：
  ```
  src/core/tool-guards.ts:149        if (input.risk === 'read') return { action: 'defer' }
  ```
- 现象与影响：`defer` 是「我不拦，问下一位」，但主链上 order 30 之后没有守卫了，所以读类工具等于
  「只过前 5 位」。前 5 位里 `sandbox` 对 `risk: 'read'` 也直接 defer（`sandbox/index.ts:290`），
  `approval-floor` 也 defer（`approval-floor.ts:710`）——读类工具真正只剩 `mode`（计划/探索会 pass）
  与 `hooks`。这就是下一条 `grep` 绕过的结构原因。
- 建议：这一位不该按 risk 短路，而该按「审批层要不要管」；把 `risk === 'read'` 的短路交给审批层内部
  （它已经有 `谁能回答`、`权限档` 这些判断），守卫层保持「每一位都要被问到」。
- 置信度：高

---

## hooks

### [P1] 同一件事有两套钩子引擎：两个配置文件、两个开关、两套信任模型、两套进程执行原语

- 位置：`src/packages/hooks/index.ts:1-24`、`src/packages/hooks/lifecycle-hooks.ts:531-642`、`src/packages/session-core/hooks.ts:738-850`
- 现象：三个文件的关系是：
  - `session-core/hooks.ts`：dsc 自有钩子引擎（规则 + 脚本 + `hooks.json` + `hooks-trusted.json` 批准名单 +
    `judgeScriptRun` 裁决），被 `hooks/index.ts:28-55` 引用；
  - `hooks/lifecycle-hooks.ts`：codex 十四个事件（`lifecycle-hooks.ts:57-72`）、独立配置文件
    `lifecycle-hooks.json`（`:224`）、独立命令白名单（`:218`），**复用** `judgeScriptRun`（`:680-687` 包一层 `asJudgeScript`）；
  - `hooks/index.ts`：把上面两套挂到一条守卫链上（order 20 自有、order 25 PreToolUse、观察者 40/45），
    并把手写的事件接线写在两处（`:1090` 与 `:1108` 各注册一个 `dsc/session-open`，`:1098` 与 `:1117` 各注册一个 `dsc/turn-end`）。
  裁决表确实只有一份（`judgeScriptRun`，这点做得对），但**执行原语有两份**：
  `runHookScript`（`session-core/hooks.ts:738-850`）与 `runLifecycleCommand`（`lifecycle-hooks.ts:531-642`）
  是 110 行几乎逐字的重复——同一个 `shellOf()`、同一个 `scrubChildEnv`、同一个 SIGKILL + taskkill 整树、
  同一个 stdout 64KB 上限、同一个 `redact` 收尾。
- 证据：
  ```
  src/packages/session-core/hooks.ts:757        child = spawn(shell.file, [...shell.args, script.command], {
  src/packages/hooks/lifecycle-hooks.ts:550     child = spawn(shell.file, [...shell.args, command], {
  src/packages/session-core/hooks.ts:843        child.stdin?.write(`${JSON.stringify(payload)}\n`)
  src/packages/hooks/lifecycle-hooks.ts:635     child.stdin?.write(JSON.stringify(payload))
  ```
- 影响：唯一的**有意差异**是 stdin 结尾换行（codex 不发，dsc 发），这个差异藏在两份 110 行的副本里，
  没有注释说明、也没有测试钉住；另一个差异是 stderr 上限（`session-core/hooks.ts:834` 用了 `HOOK_STDOUT_MAX`
  即 64KB，`lifecycle-hooks.ts:626` 用 `HOOK_STDERR_MAX` 即 400）——看起来是笔误，改一处不知道另一处。
  用户侧同样是两套心智模型：脚本要不要批准、命令白名单在哪配，两个文件两个开关。
- 建议：把 `runLifecycleCommand` 删掉，改成 `runHookScript(scriptLike, payloadLike, cwd, signal, timeout)` 加一个
  `{ trailingNewline: boolean; stderrCap: number }` 选项；`lifecycle-hooks.ts` 只保留事件表 + 配置解析 + `asJudgeScript`。
  顺手把 `hooks/index.ts` 的两对 `ctx.on` 合成一对（一个 handler 里分派自有事件与 codex 事件），
  现在两处各写了一遍同样的会话归属过滤 `if (signal !== undefined && signal.sessionId !== ctx.session.current().meta.id) return`。
- 置信度：高

### [P1] 钩子脚本的 shell 与 bash 工具的 shell 不是同一个：`shellOf()` 只会 `cmd.exe`/`/bin/sh`

- 位置：`src/core/shell-quote.ts:22-26`、`src/packages/tools-default/bash.ts:326-354`、`src/packages/tools-default/bash.ts:402-431`、`src/packages/tools-default/persistent-shell.ts:76-96`
- 现象：「用哪个 shell 跑命令」有四份实现：bash 工具的 `shellPlan`（四档：powershell/pwsh/gitbash/wsl/sh）、
  同一文件里的 `spawnTerminalShell`（又一遍四档，参数不同：少了 `-NoLogo`、`sh` 档改用 `bash`）、
  `persistent-shell.ts` 的 `spawnPersistent`（第三遍四档，参数是 `-NoLogo -NoProfile -NonInteractive`）、
  以及 `shellOf()`（只认 `cmd.exe /d /s /c` 与 `/bin/sh -c`，完全忽略用户的终端设置）。
  两处钩子都走 `shellOf()`。
- 证据：
  ```
  src/core/shell-quote.ts:23-25        return process.platform === 'win32'
                                         ? { file: 'cmd.exe', args: ['/d', '/s', '/c'] }
                                         : { file: '/bin/sh', args: ['-c'] }
  src/packages/tools-default/bash.ts:337   if (choice === 'gitbash') return { file: resolveShellExecutable('gitbash'), args: ['--noprofile','--norc','-c', command], … }
  ```
- 影响：用户在设置里选了 Git Bash（`terminal-env` 设置分区，`tools-default/index.ts:322-397`），
  然后按 POSIX 语法写一条钩子脚本 `node guard.js --strict && echo ok`——bash 工具能用，钩子走 `cmd.exe /c`，
  `&&` 之外的 `$VAR`、单引号、管道重定向全是另一种语义，脚本静默跑歪或直接失败（而失败方向由 `failClosed`
  决定，可能是「一律拦」）。`shellOf()` 的注释（`shell-quote.ts:8-9`）还写着「两个跑钩子的模块各写了一份逐字相同的实现，
  合并到这里」——合并是合并了，但合并成了一版**不认识用户选择**的实现。
- 建议：`shellOf()` 改成读 `readShellChoice()` 并复用 `shellPlan` 的映射（把 `bash.ts` 里那两个函数抽到
  `core/terminal-env.ts` 旁边，命名 `resolveShellPlan(choice, command, cwd)`）；`persistent-shell` 的第三份也调它。
- 置信度：高

---

## ptc

### [P2] 外层 `run_code` 被审批特例放行，靠「脚本里的每次调用都会过守卫」这条前提——而这条前提在队友链上不成立

- 位置：`src/packages/approval/index.ts:1304-1314`、`src/packages/ptc/index.ts:260-272`、`src/packages/subagent/index.ts:477`
- 现象：PTC 本身没有绕过守卫（`ptc/index.ts:261` 每次 `sdk.xxx()` 都 `ctx.guards.gate`，这点核对过、是对的），
  但审批层为外层 `run_code` 开了一个免卡分支，理由是「脚本里调起的每一次工具都在 PTC 里逐个过守卫与审批」。
  如果这段脚本是队友写的，`ctx.guards` 指向的就是队友那条只有 2 位的链。
- 证据：
  ```
  src/packages/approval/index.ts:1312      autoLog('auto-allow', request, '外层 run_code 不单独审：脚本里的每次工具调用在 PTC 里逐个过守卫')
  src/packages/ptc/index.ts:262            ctx.guards.gate({
  ```
- 影响：P0 那条「队友链缺 5 位」会顺带把这条免卡理由变成假前提。修了队友链这条自然成立；不修则
  `run_code` 在队友会话里是「外层免卡 + 内层少 5 位守卫」。
- 建议：在 `ptc/index.ts` 的 `callTool` 里加一条断言：`ctx.guards.chain.length` 与主链一致，否则拒跑脚本
  （或者干脆把 PTC 的 `guards` 依赖改成主链服务，见 P0 的修法）。
- 置信度：中（依赖 P0 的修法，未逐条验证队友会话里 PTC 是否可用）

---

## tools-default（bash / shell / search / image）

### [P1] `bash.ts` 1141 行塞了 9 类职责，与 `command-runner`、`spill` 的边界只有注释在守

- 位置：`src/packages/tools-default/bash.ts`（整文件）、`src/core/tools/command-runner.ts:103-130`、`src/core/spill.ts:258-298`
- 现象：单文件承担的职责（按行段）：
  1. 预算与工具说明：`:24-38`、`:444-509`
  2. 进程树终止：`:50-86`（`killTree` / `terminateTree`，两档）
  3. 后台进程登记表：`:92-122`（`trackBackgroundChild` 等 5 个导出）
  4. spawn + 超时 + 取消 + 宽限 + 兜底：`:143-254`
  5. 输出截断：`:267-276`
  6. 编码探测（UTF-8/GBK）：`:279-306`
  7. shell 选择与 spawn 计划：`:326-354`（与 `:402-431` 重复一遍，见 hooks 节）
  8. 后台作业表 + 三件工具：`:581-837`
  9. 持久终端表 + 工具：`:903-1141`
  与 `command-runner` 的边界是清楚的（缝：`planCommand`/`finishCommand` 只改执行计划，不判定），
  与 `spill` 的边界**不清楚**（见下一条）。
- 证据：
  ```
  src/packages/tools-default/bash.ts:202   const truncated = truncateBashOutput(decodeShellOutput(Buffer.concat(chunks)), outputLimit)
  src/packages/tools-default/bash.ts:267   export function truncateBashOutput(output: string, outputLimit: number): string {
  ```
- 影响：`bash.ts` 是安全审计的收口点（文件头注释 `:511-515`、`:839-845` 明说「进程原语不出本文件」），
  但这个收口现在同时是「后台作业业务」「终端业务」「编码探测」「进程管理」四个模块的家。
  任何一处要单测都得起整张表；任何一处改动都要重读 1141 行。
- 建议：按「进程原语 / 作业表 / 终端表 / 工具定义」四分：
  `spawn-supervisor.ts`（2+4+5+6，导出 `spawnShell`/`killTree`/`truncateBashOutput`）、
  `job-table.ts`（3+8）、`terminal-table.ts`（9）、`bash.ts` 只留工具 schema 与 `shellPlan`。
  进程原语集中在第一份，安全审计面反而更小、更清楚。
- 置信度：高

### [P1] 输出预算散在五处，`bash` 与 `spill` 对同一份输出给出互相矛盾的说明

- 位置：`src/packages/tools-default/bash.ts:267-276`、`src/core/spill.ts:279`、`src/core/spill.ts:67-69`、`src/core/tools/fs-tools.ts:20`、`src/packages/tools-default/bash.ts:518`
- 现象：五个「输出能有多长」的阈值各写各的：bash `outputChars: 8000`（`:37`）、spill `thresholdChars: 4000`（`spill.ts:68`）、
  read `16000` 字符（`fs-tools.ts:20`）、后台作业 `100_000`（`bash.ts:518`）、终端 `100_000`（`:848`）。
  bash 先按 8000 截断（头 60% + 尾 40%），并把「完整输出不在结果里」写进标记；结果出到观察者链，
  spill 发现 8000 > 4000，把**已经截断过的**文本落盘，并回一句「完整输出已落盘」。
- 证据：
  ```
  src/packages/tools-default/bash.ts:274   `完整输出不在结果里：要看全就把命令范围缩小分段重跑，或把设置里「命令输出封顶」调大后重跑）`
  src/core/spill.ts:279                    const pointer = `[完整输出已落盘：${path}\n接着读：read(path="${path}", offset=…
  ```
- 影响：模型/用户拿到一段同时包含两句互斥说明的结果；按 spill 的指引去 `read` 那个文件，
  读到的还是缺中间那段的文本。`spill.ts:246-247` 的注释说「bash 的截断早就是头 60% + 尾 40%，这里对齐同一口径」——
  对齐的是**排版口径**，不是**数据完整性**，落盘文件里永远拿不到真正完整的那份。
- 建议：bash 不要在自己的结果上截断，改成「全文交给 spill」：`spill` 未挂载时 bash 才截断。
  最省事的实现是 bash 只保留一个「上限哨兵」（超过 `outputChars * 4` 才硬截），
  中等长度（4000–32000）一律原样交给观察者链，由 spill 决定落盘还是原样返回。
- 置信度：高

### [P0] `grep` 绕过整套读禁名单：能直接读 `.env` / `id_rsa` / `credentials.yaml`，且没有审批卡

- 位置：`src/packages/tools-default/search-tools.ts:373`、`:389-412`、`:419-425`、`src/core/path-policy.ts:169-200`、`src/core/tool-guards.ts:149`
- 现象：`read` 工具第一件事就是 `readBlockReason(file)`（`fs-tools.ts:98`、`image-tool.ts:45`），
  命中的名字（`.env` 家族、`id_rsa`、`credentials.yaml`、`.ssh`/`.aws`/`.gnupg` 目录、私钥扩展名，`path-policy.ts:33-66`）
  一律拒读。`grep` 与 `glob` 完全不调这个函数：`grep` 只做 `stat.size` 与 `\0` 二进制判断（`:396`、`:403`），
  然后 `fs.readFile(file,'utf8')` 全文扫（`:399`）。它的 `risk: 'read'` 又让审批守卫直接 defer
  （`tool-guards.ts:149`），沙箱对 read 也 defer（`sandbox/index.ts:290`），地板对 read 也 defer
  （`approval-floor.ts:710`）；`approval-floor` 的 deny 黑名单只看**根路径**（`:714` `denyHit([target], …)`），
  `path: "."` 时 `*.env` 这条 glob 永远命中不了。
- 证据：
  ```
  src/packages/tools-default/search-tools.ts:399    content = await fs.readFile(file, 'utf8')
  src/packages/tools-default/search-tools.ts:419-425  await walkFiles(root, rules, async (file) => { … return scan(file) })
  src/core/path-policy.ts:184                        if (READ_DENIED_BASENAMES.has(lowered)) {
  ```
- 影响：模型一条 `grep({ pattern: "KEY|SECRET", path: "." })` 就能把工作区里 `.env` 的键值行印进对话；
  `grep({ pattern: ".", path: "C:\\Users\\me\\.ssh" })` 能读 `id_rsa` 的正文行（PEM 首尾行不连续，
  `redact` 的 `pem` 规则需要 `BEGIN…END` 整块才命中，所以只返回中间几行时**不会被遮红**）。
  这是「读禁」这条控制唯一的活口，且不需要任何权限档位配合。
- 建议：`scan()` 里对每个文件先调 `readBlockReason(file)`（一个同步纯函数，开销是字符串比较，可忽略），
  命中就跳过并在结果里记一行「已跳过 N 个受保护文件」；`glob` 只列名字，可以在结果里标注但不阻塞。
  更彻底的做法是把「这个文件能不能读」下沉到 `walkFiles` 的 `visit` 回调，让所有遍历型工具自动继承。
- 置信度：高（`search-tools.ts` 全文读过，没有任何 `readBlockReason` 引用；`grep` 的 `risk` 与四位守卫的 defer 都核对过）

### [P1] `terminal send` 与极简档 `shell` 没有硬地板：`bash` 自己拦的灾难命令，从这两条路能跑

- 位置：`src/packages/tools-default/bash.ts:491-493`、`src/packages/tools-default/bash.ts:1042-1055`、`src/packages/tools-default/persistent-shell.ts:263-266`、`src/core/tools.ts:183`
- 现象：`bash` 在工具入口自己再判一次 `classifyCommand`，`deny` 直接抛错（`:492-493`，注释写「审批层被绕开（无头队友、脚本调用）也执行不了灾难命令」）。
  `terminal` 的 `send` 明确写着「写入前不判内容——判与放行都在工具层的守卫链上做」（`:1039-1040`），
  但守卫链的命令判定依赖 `input.command`，而 `command` 来自 `callFacts` 只认 `args.command`/`args.cmd`（`core/tools.ts:183`）；
  `terminal` 的参数是 `data`，`shell` 虽然用 `command` 却也没有自己的硬地板检查。
  于是：`terminal` 的 `send` 在任何档位下都不经过 `classifyCommand` 的 `HARDLINE`。
- 证据：
  ```
  src/packages/tools-default/bash.ts:492        const verdict = classifyCommand(args.command)
  src/packages/tools-default/bash.ts:1052       stdin.write(data)
  src/packages/tools-default/persistent-shell.ts:264  const command = String(args.command ?? '')
  ```
- 影响：`command-policy.ts:58` 把 `hardline` 定义为「任何权限模式都不许放行」，`approval/index.ts:1248-1251` 也照此实现。
  但在「完全访问」档（`full-access` 预设，`permission-presets.ts:76-83`）下，`terminal` 的 `risk` 是 `exec`、
  `command` 为空 → 地板 defer（`approval-floor.ts:712-713`）、审批第 5 层直接放行（`approval/index.ts:1332`）——
  模型只要先 `open` 再 `send("rm -rf /")`（或 `format C:`、`diskpart clean`），硬地板一次都不会被问到。
  极简档的 `shell` 工具同理（没有 bash 那一行自检）。
- 建议：硬地板不应该只长在 `bash` 一个工具的肚子里。两个改法：
  (a) 在 `ToolEntry` 上补 `commandFact(args): string | undefined`（`terminal` 返回 `args.action === 'send' ? args.data : undefined`），
  让 `callFacts` 不再靠猜参数名；
  (b) 在 `sandbox`/`approval` 守卫里对「有 shell 通道」的工具做兜底：发现 `risk === 'exec'` 且 `command === undefined`
  时，从 `args` 里挑所有字符串字段拼一份候选命令交给 `classifyCommand`（宁可误判也不漏判）。
  两个都要做：(a) 治本，(b) 治「新加一个 exec 工具忘了声明」。
- 置信度：高（`terminal`/`shell` 的参数名、`callFacts` 的取值键、四层守卫的 defer 分支全部核对过）

---

## tools / core/tools

### [P1] 六件套工具一半住在 `core/`：`fs-tools.ts` 是真实实现，`core/tools/*.ts` 的垫片方向是反的

- 位置：`src/core/tools/fs-tools.ts:1-254`、`src/core/tools/bash.ts:1`、`src/core/tools/search-tools.ts:1`、`src/core/tools/image-tool.ts:1`、`src/packages/tools-default/index.ts:14`、`src/packages/approval/index.ts:35`
- 现象：三者职责边界应该是「`core/tools.ts` = 契约、`packages/tools` = 注册表服务、`tools-default` = 实现与装配」。
  实际是：
  - `core/tools.ts`：`ToolEntry`/`callFacts`/`gateIdentity`/`argsSummary`（契约，226 行）——**这一层是对的**；
  - `packages/tools/index.ts`：只有一张 `Map` + 投影（83 行）——**这一层也是对的**；
  - 实现层被劈成两半：`bash`/`glob`/`grep`/`read_image` 在 `tools-default`（`index.ts:12-16` 注册），
    `read`/`write`/`edit` 却在 `core/tools/fs-tools.ts`，由 `tools-default` 反向 import（`index.ts:14`）；
  - 同时 `core/tools/bash.ts`、`image-tool.ts`、`search-tools.ts`、`tool-result-prune.ts` 是四个一行垫片
    （`export * from '../../packages/tools-default/…'`），全仓**零引用**（只有注释提到路径，已扫过 `src`/`scripts`/`ui-shell`/`desktop`）。
- 证据：
  ```
  src/packages/tools-default/index.ts:14   import { createReadTool, editTool, READ_DEFAULT_LINE_LIMIT, writeTool } from '@pneuma/runtime/core/tools/fs-tools.js'
  src/core/tools/bash.ts:1                 export * from '../../packages/tools-default/bash.js';
  ```
- 影响：读代码的人会先打开 `core/tools/bash.ts`（垫片，空的），再打开 `core/tools/fs-tools.ts`（真的），
  于是以为「工具都在 core」。更实际的问题是 `approval` 为了一个 `summarizeChange` 依赖了
  `core/tools/fs-tools.js`（`approval/index.ts:35`）——审批层直接依赖一个工具实现文件，
  工具一旦搬家（这正是插件化要做的事）审批就断。另外同一份契约在同一个包里出现两种说明符：
  `tools-default/bash.ts:13` 用 `'../../core/tools.js'`，`approval/index.ts:33` 用 `'@pneuma/runtime/core/tools.js'`。
- 建议：(1) 删掉四个零引用垫片（归入全局证据里那 58 个的一类，只是它们在子目录里，主控的口径没数到）；
  (2) 把 `fs-tools.ts` 搬进 `packages/tools-default/fs.ts`，`core/tools/` 只留 `path-args.ts` 与 `sandbox-args.ts`
  这类纯契约助手，或者把 `summarizeChange` 下沉到 `core/diff-text.ts` 旁边供两者共用；
  (3) 包内统一用说明符（要么全相对、要么全别名），别一半一半。
- 置信度：高（引用面已扫，垫片零引用）

---

## spill

### [P2] `core/spill.ts`(386) 与 `packages/spill/index.ts`(249) 的边界是干净的，但配置读两遍

- 位置：`src/core/spill.ts:67-127`、`src/packages/spill/index.ts:49`、`:96-176`
- 现象：核心是纯函数 + 配置解析（`readSpillConfig`），插件是观察者 + 设置分区。边界清楚，这点没问题。
  小问题是配置解析在核心、设置字段在插件，`SPILL_RANGES` 从核心导出给插件用（对），但插件还要自己再读一次
  `resolvePluginConfig` 之外的键名（`CONFIG_KEY = 'spill'` 在两边各写一遍：`core/spill.ts:24`、`packages/spill/index.ts:33`）。
- 建议：`CONFIG_KEY` 只留核心那一份并导出。属清理，不急。
- 置信度：高

---

## 专题问答（对应派单的 8 问）

**1. 命令分类是不是两套？** 是**三套**，各自被不同的人调用，结论互相覆盖（对照表见 sandbox 节 P0）：

| 分类器 | 调用方 | 结论集合 |
| --- | --- | --- |
| `command-policy.classifyCommand`（`core/command-policy.ts:539`） | `approval:1221`（唯一带 `activeRules()` 的调用）、`approval-floor:691/731/810`、`session-core/modes:99/141`、`mode:110`、`subagent:494`、`computer-use:422`、`tools-default/bash:492`（**后三个都没传 rules**） | allow/ask/deny + hardline |
| `sandbox/execpolicy.evaluateCommand`（`execpolicy.ts:457`） | 只有 `sandbox/index.ts:269`（守卫 order 8） | allow/prompt/forbidden（**只有 forbidden 被用**） |
| `approval-floor.evaluate`（`approval-floor.ts:700`） | 只有 `approval-floor/index.ts:71`（守卫 order 5） | deny/defer + layer |

三组对照：`git push --force`（policy ask / sandbox forbidden / floor defer）、`powershell -Command "…"`（ask / defer / deny）、
`cmd /c del x`（ask / defer / deny）、`schtasks /create`（ask / forbidden / defer）。
根因是「谁能拒」没有单一归属：`classifyCommand` 的 `deny` 只有 `HARDLINE`+用户 deny 规则，
而另外两家各自又造了一层 deny，谁也不读对方的 ask。

**2. 权限栈几层？** 四层半，其中两层重复判定（顺序见 approval 节第 1 条）：
`permission-core`（三项的会话读写，纯函数）→ `permission-presets`（三合一预设，只调两个 setter）
→ `approval`（裁决 + 卡片 + 审阅者）→ `approval-floor`（灾难地板，order 5）。矛盾点：
- 地板判「交卡」（defer）的命令，常被沙箱（order 8）先判成 forbidden 硬拒，卡不弹（4 条对照）；
- 地板判「deny」的 `powershell -Command`，`command-policy` 认为只是 ask；
- 审批层第 4 层又调一次 `sandbox.check()`，与 order 8 的守卫各判一遍，但 `check()` 不认识升权请求
  （`sandbox/index.ts:972-989` 没有 `readSandboxRequest`），所以升权卡的理由分支取错（approval 节 P2）。

**3. 路径判定两套？** 是，且都在用（对照表见 sandbox 节 P1）。`core/path-policy.ts` 管**读**（`readBlockReason`，
被 read/ops/image/cdp/review 用）+ 写硬拒 + 说明书必问；`sandbox/policy.ts` 管**写**（`checkWrite`，含 NT/ADS/UNC/
受保护名/可写根）。同一条路径两边结论不一致的有 5 组：NT 前缀中缀写法、`//?/` 正斜杠写法、NTFS 数据流、
UNC、`~/.dsc` 控制文件。

**4. tools 注册表三者的边界？** `core/tools.ts` = 契约（对的），`packages/tools` = 注册表服务（对的），
`tools-default` = 装配 + 预算 + 一半实现（另一半实现留在 `core/tools/fs-tools.ts`，见 tools 节 P1）。
同一工具的 schema/risk 没有定义两遍（`read/write/edit` 只有 `core/tools/fs-tools.ts` 一份，
`bash/glob/grep/read_image` 各一份），但有**同一份内容的两个副本**：`IMAGE_MIME` 表 + 6MB 上限
在 `fs-tools.ts:27-37` 与 `image-tool.ts:20-31` 逐字相同；`sandboxPermissionProperties` 是共享的（对的）。

**5. `bash.ts` 1141 行怎么拆？** 见 tools-default 节 P1（四分：进程原语 / 作业表 / 终端表 / 工具定义）。
与 `command-runner` 边界清楚，与 `spill` 边界不清（输出预算打架，见同节 P1）。

**6. hooks 三个文件什么关系？** `session-core/hooks.ts` = 引擎+裁决（一份），`lifecycle-hooks.ts` = codex 事件表+配置+执行原语（第二份执行原语），
`hooks/index.ts` = 装配+设置+事件接线（两对 `ctx.on` 各写一遍同样的过滤）。同一 codex 事件**没有**被两处各解析一遍
（事件分派确实只有 `hooks/index.ts:1090-1132` 一处），但**同一件事被两套配置和两套信任模型各管一遍**，
且 `runHookScript`/`runLifecycleCommand` 是 110 行重复（见 hooks 节 P1）。

**7. approval/index.ts 1543 行怎么分？** 三段：diff 预览 `:118-276`（159 行，`approvalDiffOf` 在 `:203`）、
AI 复核 `:278-701`（423 行，提示词 `:586-616`、历史构建 `:441-575`、协议解析 `:651-701`）、
插件与裁决 `:703-1543`（841 行，`decide` 单函数 `:1203-1423` 就 220 行）。
**diff 预览应该独立成 `approval-preview.ts`**：它已经是纯函数 + 一次读盘，与裁决逻辑零耦合；`call-meaning.ts`（336 行）
就是同一类东西被拆出去的先例。算法上它**没有**和 `core/unified-diff.ts` 重复（后者是 git diff 文本的解析器，
前者是「参数+盘上现值 → 写后全文 → hunk」的生成器，两者都最终落在 `core/diff-text.ts:121` 的 `diffLines`）。
真正的重复在**渲染层**：`ui-transcript/ui/intended-diff.ts:126-221` 又写了一遍同一个推演（含 ops_edit_file 的唯一匹配/不重叠规则）。

**8. guards 与 tool-guards？** 注册与执行只有一份（`core/tool-guards.ts` 的 `ToolGuardRegistry`，
`guards/index.ts` 只是挂成服务），但**实例有两份**：主会话一份（`guards/index.ts:21`）、
每个队友各一份（`subagent/index.ts:478`，见 P0）。`ptc` **没有**绕过守卫/审批：它每次 `sdk.xxx()`
都走 `ctx.guards.gate`（`ptc/index.ts:261`）与 `ctx.guards.observe`（`:299`），
只是它走的那条链可能是队友那条残缺的。

---

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
| --- | --- | --- | --- | --- |
| `bash` 工具实现 | `src/core/tools/bash.ts`（一行垫片） | `src/packages/tools-default/bash.ts` | 无源码引用（只被注释提到） | 删垫片 |
| `read_image` | `src/core/tools/image-tool.ts`（垫片） | `src/packages/tools-default/image-tool.ts` | 无 | 删垫片 |
| `glob`/`grep` | `src/core/tools/search-tools.ts`（垫片） | `src/packages/tools-default/search-tools.ts` | 无 | 删垫片 |
| 工具结果裁剪 | `src/core/tools/tool-result-prune.ts`（垫片） | 无对应新实现 | 无 | 直接删 |
| `read`/`write`/`edit` | `src/core/tools/fs-tools.ts`（**真实实现**，不是垫片） | 应在 `packages/tools-default/`，实际没有 | `tools-default/index.ts:14`、`approval/index.ts:35` | 搬家；`summarizeChange` 下沉到 `core/diff-text.ts` 旁 |
| 命令策略 | `src/core/command-policy.ts`（真实实现，无垫片） | 无 | 全部调用方 | 不搬，但统一说明符：`bash.ts:14` 用相对、`approval:44` 用别名 |
| 工具契约类型 | `src/core/tools.ts` | 无 | `tools/index.ts:16`（别名）、`bash.ts:13`（相对） | 契约留在 core，统一别名 |
| 钩子 | `session-core/hooks.ts`（`hooks.json`） | `hooks/lifecycle-hooks.ts`（`lifecycle-hooks.json`，codex 事件） | 两套都在跑，`hooks/index.ts` 同时挂 | 保留事件表，合并执行原语与信任模型 |
| 路径判定 | `core/path-policy.ts`（读 + 写硬拒 + 说明书） | `sandbox/policy.ts`（写 + 形状 + 受保护名） | 两套都在跑（见 P1） | 形状判定归一，受保护名分「硬拒/必问」两档 |
| 权限三项读写 | `core/permission-scope` 类名（注释里还这么叫） | `packages/permission-core/permission-scope.ts` | 无 | 改注释 |
| 改动预览 | `approval/index.ts:203` `approvalDiffOf`（宿主） | `ui-transcript/ui/intended-diff.ts:126`（渲染层） | 两套都在跑 | 抽 `approval-preview.ts` + 共享契约 |

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
| --- | --- | --- | --- | --- |
| 钩子子进程执行（110 行） | `session-core/hooks.ts:738-850` | `hooks/lifecycle-hooks.ts:531-642` | stdin 结尾换行（A 发、B 不发）；stderr 上限 A 用 64KB、B 用 400 字节 | 合并成一个 `runHookProcess(options)` |
| shell 选择（四份） | `tools-default/bash.ts:326-354` | `bash.ts:402-431`、`persistent-shell.ts:76-96`、`core/shell-quote.ts:22-26` | 四档映射重复；`shellOf` 完全不认用户选择 | 抽 `resolveShellPlan(choice, …)` 一份 |
| 「写后全文」推演 | `approval/index.ts:203-276`（+`:160-186` ops 编辑） | `ui-transcript/ui/intended-diff.ts:126-221`（+`:148-177` ops 编辑） | 同一套唯一匹配/不重叠规则写两遍；truncated 预算两边都是 800 | 抽 `approval-preview.ts`，宿主算好随卡片下发 |
| 路径形状判定 | `core/path-policy.ts:69-79` | `sandbox/policy.ts:270-310` | NT 正则锚点不同、B 多 ADS/UNC/正斜杠归一 | 归一到 core，sandbox 只调 |
| 凭据文件名名单 | `core/path-policy.ts:33-52`（读禁，含 `ui-secret`） | `sandbox/policy.ts:395-411`（写拒，含 `id_dsa`）+ `core/path-policy.ts:55-57`（读禁扩展名） | 三份名单覆盖不同：`ui-secret` 只在 A，`id_dsa` 只在 B，`.pem/.key` 在 B 与 C | 一份 `CREDENTIAL_NAMES` + 用途标记 |
| dsc 控制文件名 | `core/path-policy.ts:82-98`（必问） | `sandbox/policy.ts:414`（硬拒） | 名单几乎相同、处置相反 | 合并并显式写 severity |
| 写目标识别 | `core/tools.ts:171-186`（`callFacts` 认 5 个键） | `sandbox/execpolicy.ts:225-304`（`writeTargetsOf` 认命令词元） | 前者按参数名猜，后者按 shell 语法认；`ops_copy/move` 靠 `ops/tools.ts:507` 的 `gateAs` 打补丁 | 契约上加 `commandFact`/`writeTargetFact`，别让工具自己打补丁 |
| 图片 MIME 表 + 6MB 上限 | `core/tools/fs-tools.ts:27-37` | `tools-default/image-tool.ts:20-31` | 逐字相同 | 抽 `core/tools/image-types.ts` |
| 会话归属过滤 | `hooks/index.ts:1102` | `hooks/index.ts:1121` | 同一句 `signal.sessionId !== ctx.session.current().meta.id` 写两遍 | 两个 `ctx.on` 合成一个 |
| 「输出能有多长」 | `bash.ts:37`(8000) | `spill.ts:68`(4000)、`fs-tools.ts:20`(16000)、`bash.ts:518`(100000)、`bash.ts:848`(100000) | 五个阈值、五种截断文案 | 一份预算表 + 一个截断函数 |
| 危险命令表 | `core/command-policy.ts:247-332` | `approval-floor.ts:413-441`、`sandbox/execpolicy.ts:41-115` | 覆盖互补、结论互斥 | 一份带 severity 的表 |
| 权限三项合并 | `permission-scope.ts:98-109` | `permission-scope.ts:121-131` | 只差落盘时机 | `mergePermissions(session, patch, mode)` |

## 待核实

1. **`terminal` / `shell` 的硬地板绕过是否真的可达**：需要确认 `terminal` 工具在「完全访问」档下是否
   还要过沙箱守卫（`risk: 'exec'` + `command === undefined` → `sandbox/index.ts:268` 返 `PASS` → defer）。
   静态读下来是可达的，但没有实跑验证（本轮禁止跑测试）。
2. **`grep` 的 `redact` 兜底强度**：`sk-`/JWT/PEM 整块会被遮红（`secrets.ts:20-34`），但零散的行（
   `DATABASE_URL=postgres://...`、`id_rsa` 的 base64 中段）不在规则内。需要产品口径确认「跳过受保护文件」
   与「靠遮红兜」哪个是对的。
3. **队友会话里 PTC 是否可用**：`subagent` 的工具清单由角色文件给，`run_code` 是否进得去没验证；
   如果进得去，`ptc` 节 P2 的「外层免卡 + 内层少 5 位」就是活的风险。
4. **`sandbox.check()` 的第二次判定是否真有必要**：注释说是刻意重复，但 `check()` 不认升权请求
   （`sandbox/index.ts:972-989` 没有 `readSandboxRequest`），也与 `degradedFailClosed` 无关。
   如果确认可以复用 order 8 的结论，这里能删掉约 20 行并消灭一个不一致点。
5. **`core/tools/` 四个垫片是否被 `scripts/*.mjs` 经 `lib/core/tools/...` 引用**：本轮只扫了 `src`，
   全局证据里那 16 个「只被脚本引用」的垫片是否包含这四个，需要主控用同一口径再数一次
   （`core/tools/bash.ts` 这类子目录垫片可能被漏计）。
6. **`approval-floor` 的 deny 分支在「完全访问」档是否也生效**：静态读下来生效（守卫 order 5 不看权限档，
   `approval-floor/index.ts:12-13` 明说不认识协作模式），但没有实跑确认 `full-access` 预设下
   `terminal send` 与 `bash` 的差异。
7. **`HOOK_STDERR_MAX` 在 `session-core/hooks.ts:834` 用了 `HOOK_STDOUT_MAX` 是不是笔误**：
   上下文（`:626` 那份用 `HOOK_STDERR_MAX`）看像笔误，但 `:927`、`:959` 又各自 `.slice(0, HOOK_STDERR_MAX)`，
   可能是「先缓冲多一些、裁决时再截」的有意做法。需要原作者确认。
