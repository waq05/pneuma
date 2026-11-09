# 批次 01：内核底座与会话链路

> 分支 `feat/pluginization`，按 2026-11-09 工作区现状审查。
> **本批次审查的文件全部没有未提交改动**（`git status --porcelain` 的 30 个在途文件都在 `src/packages/ui-*` 与 `docs/`，不属本批次）。
> 只读审查：未修改任何源码，未跑 build / typecheck / 测试。

## 范围

实际读过（逐行或按段通读）：

- `src/core/session.ts`（1685 行，全文）、`session-meta.ts`（113）、`events.ts`（145）、`token-estimate.ts`（118）、`usage-log.ts`（409）、`compact-anchors.ts`（339）
- `src/adapter/transcript.ts`（937 行，全文）
- `src/contract.ts` + `src/contract/{transcript,usage,session,snapshot,runtime}.ts`
- `src/services/types.ts`（按段：1–300、680–810、1255–1374，其余只做符号检索）
- `src/core/tools.ts`（1–95，用于对齐 `FileChangeSummary`）
- `src/packages/session/index.ts`、`session-search/index.ts`、`session-search/session-index.ts`、`session-title/index.ts`、`transcript/index.ts`、`compact/index.ts`、`session-core/compact.ts`、`microcompact/index.ts`、`microcompact/microcompact.ts`
- 调用方抽样（不审查其本体）：`packages/session-core/loop.ts`（300–479）、`ui-transcript/ui/{rounds.ts,ui.tsx}`、`core/dsh-compat/session-bridge.ts`（仅 grep 命中行）
- 全仓引用检索：`core/session-export|session-index|surface-registry`、`@pneuma/runtime/core/*`、`adapter/transcript.js`（排除 `node_modules`、`lib`）

没读：`session-core/hooks.ts`（1010 行）、`prompt.ts`、`modes.ts`、`contract/{approval,mode,plugin,settings,task}.ts`（与本题六个问题无关，未展开）。

## 结论摘要

- **P0 1 条 / P1 9 条 / P2 9 条**（共 19 条）
- 最重要的三条：
  1. **「第几条用户消息」有三套判据**：`core/session.ts` 的 `isHumanUserMessage` 只数人打的字，而 `readUserMessages` / `forkSession` 只认行首前缀、把机器通知与队友汇报都当用户消息数。分叉菜单与「编辑并重发」对同一条会话算出不同的轮号，已经在错切。
  2. **会话费用只有内存一份状态**：`Transcript.clear()` 把 `costBuckets` 清零，重放明确不恢复 usage，切走再切回同一会话，状态栏费用整段消失；磁盘上的 `usage.jsonl` 按会话记着 token，却没有任何回填路径。
  3. **`Session` 是实打实的上帝对象**：类体 748 行承担 13 类职责，`SessionStateMap` 直接在核心里内建了 12 种插件状态形状，核心认识每个功能点，改一个功能就得改核心文件。

## 按插件分节

### core/session.ts

#### [P1] `Session` 承担 13 类职责，模块再叠加 5 类会话库职责，是上帝对象

- 位置：`src/core/session.ts:461-1208`（类体）、`src/core/session.ts:1234-1685`（模块级会话库）、`src/core/session.ts:234-302`（`SessionStateMap`）
- 现象：一个类同时是「jsonl 写入器 + 协议消息编解码器 + 插件状态总线 + 收件箱 + 提示日志 + 工具派生状态表 + 回合 diff 记账 + 崩溃修复 + 压缩落点 + 写租约持有者 + 损坏文件抢救 + rewind 引擎 + 会话库管理器」。逐项对号：

  | # | 职责 | 行号 |
  |---|---|---|
  | 1 | jsonl 追加写、meta 首行补写、写入流错误自愈 | 466-469、1166-1207 |
  | 2 | 协议消息编解码（`userContent` / `buildFromLog`） | 110-133、584-743 |
  | 3 | 插件状态总线（`state`/`appendState`/`setState`） | 529、977-1005 |
  | 4 | 未落盘状态缓冲（`pendingState` / `deferredState`） | 480、489、1166-1192 |
  | 5 | 收件箱（入箱/编辑/删除/提前/按来源出账） | 90-97、1014-1105 |
  | 6 | note / notice 日志 | 530-533、1108-1144 |
  | 7 | 工具派生旁路（错误、改动、卡片） | 501-515、871-876 |
  | 8 | 回合 diff 基线记账 | 516-524、896-921 |
  | 9 | 中断回合修复（合成工具结果） | 930-949 |
  | 10 | 压缩落点（`replaceWithSummary`） | 960-970 |
  | 11 | rewind（内存截断 + 落一条 rewind 记录） | 787-809 |
  | 12 | 损坏 meta 抢救 | 352-402 |
  | 13 | 写租约 / 跨进程互斥 | 335-343、573-581、1146-1155 |
  | 14 | 会话库：扫盘、列表缓存、归档/恢复/删除/回收站、分叉、last-session 指针 | 1215-1685 |

- 证据：
  ```
  14: import type { ApprovalPolicy, ApprovalReviewer, CollaborationMode, EffortLevel, GoalSnapshot, PlanHistoryItem, PlanView, SandboxMode, TodoItemView, ToolPresentationView } from '../contract.js'
  22: import { REVIEW_FINDINGS_OPEN, TEAMMATE_REPORT_OPEN } from './team-board.js'
  239:   permissions: { sandbox: SandboxMode | null; policy: ApprovalPolicy | null; reviewer: ApprovalReviewer | null }
  301:   'async-inbox': { items: AsyncInboxItem[] }
  ```
  `SessionStateMap` 里 12 条状态（239 permissions / 241 mode / 246 preset / 248 todos / 250 plan / 258 plans / 266 goal / 271 model / 278 learnings / 284 system-prompt / 289 env-facts / 301 async-inbox）各自属于不同插件，但形状全写在核心。
- 影响：任一功能加一个状态字段、改一次收件箱语义、换一次压缩落点格式，都要动这个 1685 行的文件；`agent`/`compact`/`mode`/`plan`/`goal` 等 12 个包同时依赖它的内部形状，任何一次签名调整都是全仓连锁。新人要改「会话怎么存」时无法只读一个模块。
- 建议：按已有接缝拆三刀，一次一刀、每刀可独立验收——(1) `SessionLog`（1+2+12 纯磁盘格式与重放）；(2) `SessionStateStore`（3+4，把 `SessionStateMap` 挪到各自的声明合并文件，核心只保留 `unknown` 槽位）；(3) `SessionLibrary`（14，独立成 `core/session-library.ts`，`Session` 不再 export 扫盘/归档/分叉函数）。收件箱（5）是当前最活跃的一块，建议单独抽 `core/session-inbox.ts`。
- 置信度：高（全文读过，职责逐项对号）

#### [P1] 「人打的用户消息」判据两套，分叉菜单与编辑重发对同一会话算出不同轮号

- 位置：`src/core/session.ts:430-438`（严格判据）、`src/core/session.ts:1652`（`readUserMessages`）、`src/core/session.ts:1620`（`forkSession`）、`src/core/session.ts:1594`（`applyRewinds`）、调用侧 `src/packages/ui-transcript/ui/ui.tsx:448`
- 现象：同一份日志里有两种「第几条用户消息」：`isHumanUserMessage` 排除 `origin: 'notice'` 与队友汇报/审查结论前缀，`readUserMessages` 与 `forkSession` 只认 `{"type":"user"` 行首前缀，把后台作业通知、队友汇报都算成用户消息。分叉菜单列出来的条目因此比界面上的轮次多，选「第 3 条」分叉出来的位置和界面上第 3 轮对不上。
- 证据：
  ```
  430: function isHumanUserMessage(message: ChatMessage): boolean {
  432:   if (message.origin === 'notice') return false
  437:   return !text.startsWith(TEAMMATE_REPORT_OPEN) && !text.startsWith(REVIEW_FINDINGS_OPEN)

  1652:     if (!line.startsWith('{"type":"user"')) continue      // readUserMessages
  1620:     if (!lines[index].startsWith('{"type":"user"')) continue  // forkSession

  ui.tsx:448: const keep = all.slice(0, at).filter((item) => item.kind === 'user' && item.internal !== true).length
  ```
- 影响：机器通知已经常态化（后台作业完成、定时补投、队友汇报）。只要会话里出现过一条通知，分叉菜单的序号就整体偏移，用户按菜单选轮次会切在错误位置；反过来，任何把 `origin: 'notice'` 判据改一处忘另一处的新需求，都会让「编辑并重发」和「分叉」对同一条会话给出两个答案。
- 建议：把判据收成一份纯函数（`isHumanUserMessage(message)` 用于协议消息、`isHumanUserRecord(line)` 用于原始行，两者共用一个谓词表），让 `readUserMessages` / `forkSession` / `applyRewinds` / `cutIndexBeforeUser` 全部走它；分叉菜单与 rewind 的 `keep` 必须同源。
- 置信度：高（四条路径逐条读过；分叉菜单与 rewind 的 `keep` 由同一份 UI 数据算出，已核对）

#### [P1] 同一份 jsonl 的行级解析在本模块写了四遍，另有一份在 session-search

- 位置：`src/core/session.ts:352-402`（`salvageMeta`）、`1400-1420`（`readSessionFileUncached` 的抢救分支）、`1569-1600`（`applyRewinds`）、`1363-1371`（`hasConversation`）
- 现象：同一份 jsonl 的行级解析逻辑在四处各写一遍，各自只认自己关心的几种记录类型，且各自的容错策略不同（有的 `continue`、有的判前缀、有的 `JSON.parse` 后跳过）。`hasConversation` 用字符串前缀判断「有没有对话」，`readSessionFileUncached` 用 `head.find(startsWith('{"type":"user"'))` 取标题，`salvageMeta` 只认 `tool.changes` 与 `state.payload.file` 两类路径。
- 证据：
  ```
  1289:   return lines.some((line) => line.startsWith('{"type":"user"') || line.startsWith('{"type":"assistant"'))
  1380:       const derived = head.find((line) => line.startsWith('{"type":"user"'))
  1407:         if (title === undefined && parsed.type === 'user' && typeof parsed.text === 'string' && parsed.text !== '') {
  ```
- 影响：`SessionRecord` 加一种记录（历史上已经加过 rewind / note / notice 三种），这五处都要人肉同步一次；漏掉一处不会报错，只会让那条会话在列表里少一行、或标题推不出来。
- 建议：写一个 `parseRecordLine(line): SessionRecord | null` 与 `scanRecords(lines, visit)` 两个小函数放在本模块顶部，四处替换为调用；`hasConversation` 改成 `scanRecords` 的早期退出。
- 置信度：高（四段都读过）

#### [P1] 会话列表扫盘有两套实现、两套缓存，键与失效口径都不同

- 位置：`src/core/session.ts:1264-1279`（`scanSessions`）+ `1305-1322`（`sessionRowCache`）与 `src/packages/session-search/session-index.ts:760-769`（`scanTargets`）+ `906-952`（`save` 落 `~/.dsc/cache/session-index.json`）
- 现象：两套代码各自 `readdirSync` 同一批目录、各自按 mtime+size 判失效、各自解析 meta 行。第一套的缓存键是 `path + 侧栏属性`（`1315`），第二套的键只是 `path`（`482` `this.files`），持久化到 JSON；第一套只扫活动区，第二套按开关扫活动区/归档区/回收站/队友区；第一套取标题走 sidecar 三级展示链，第二套根本不读 sidecar。
- 证据：
  ```
  session.ts:1315:   const key = `${filePath}\u0000${sidecar?.title ?? ''}\u0000${sidecar?.autoTitle ?? ''}\u0000${String(sidecar?.pinnedAt ?? '')}`
  session.ts:1317:   if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.item

  session-index.ts:762:     this.addRoot(sessionsRoot(), 'active', true, targets)
  session-index.ts:860:       if (item['type'] === 'meta') {
  session-index.ts:861:         if (typeof item['id'] === 'string') entry.sessionId = item['id']
  ```
- 影响：`~/.dsc/sessions` 下的同一批文件每次「侧栏刷新」与「搜索一次」各被完整读一遍（两套实现都是整份 `readFileSync`）。新增一种会话目录（比如将来的「共享会话区」）要改两处；任何一侧的失效判据变化（例如改成 mtime 精度、或加 inode）都会让两条路径的「哪条会话是最新的」出现分叉。
- 建议：抽 `core/session-scan.ts`，导出 `scanSessionFiles(roots, options): ScanTarget[]`（只负责列文件 + mtime/size）与 `readHead(file): { meta, firstUserText }`；`scanSessions` 与 `SessionIndex.scanTargets` 都改成它的调用方，各自的缓存留在各自插件里（列表行缓存留在 core，倒排索引留在 session-search）。
- 置信度：高（两套实现都读过；`lib/` 与 `node_modules` 已排除）

#### [P2] 未使用的 import

- 位置：`src/core/session-meta.ts:12`、`src/core/usage-log.ts:20`、`src/core/usage-log.ts:21`
- 现象：三个 `node:` 内置模块的 import 在文件里一次都没用到；`usage-log.ts` 的路径全部走 `dscPath()`，`session-meta.ts` 的注释（44-47 行）还专门解释了「不复用 sessionsRoot」。
- 证据：
  ```
  session-meta.ts:12: import { homedir } from 'node:os'
  usage-log.ts:20:   import { homedir } from 'node:os'
  usage-log.ts:21:   import { join } from 'node:path'
  ```
- 影响：让「路径全仓只有一处拼」的约定在阅读时失真——读者会以为这两个模块自己拼家目录。
- 建议：删掉这三个 import（`session-meta.ts:13` 的 `join` 同样未使用）。
- 置信度：高（`Select-String '\bhomedir\b|\bjoin\('` 仅命中 import 行）

### adapter/transcript.ts

#### [P0] 会话费用只有内存一份状态，切走再切回就整段消失

- 位置：`src/adapter/transcript.ts:186-192`（`compactionCount` 旁的计费字段）、`288`（`clear()` 清零）、`803-828`（`usage` 累加）、`src/packages/transcript/index.ts:331-337`、`src/core/usage-log.ts:399-409`
- 现象：状态栏的「本会话费用」唯一数据源是 `Transcript.costBuckets`（内存）。`clear()` 每次打开会话都把它换成空 Map；`replayHistory` 明确不重放 usage，`session-open` 只回填了 `contextUsed`（`transcript/index.ts:229-230`），没有回填费用。于是切到别的会话再切回来、或者重启宿主打开一条老会话，`estimateSessionCostCny` 拿到空桶返回 `undefined`，`status.cost` 整个字段缺席，状态栏那一格直接不画。
- 证据：
  ```
  transcript.ts:288:     this.costBuckets = new Map()
  transcript.ts:825:     const buckets = this.costBuckets.get(event.model ?? '') ?? emptyCostBuckets()
  transcript.ts:827:     this.costBuckets.set(event.model ?? '', buckets)

  transcript/index.ts:229:         const usage = readSessionUsage(current.meta.id)
  transcript/index.ts:230:         if (usage !== null) transcript.seedContextUsage(usage.lastInputTokens)

  pricing.ts:172:   if (tokens <= 0) return undefined
  ```
- 影响：用户看到的是「切一下会话，费用没了」。这类状态一旦出现两份（内存累计 vs 磁盘 `usage.jsonl`），第二次修（比如给费用加回填）必然要同时改 `clear()`、`session-open`、`seedContextUsage` 三处，改漏一处的表现是「有时有、有时没有」——比全没有更难查。
- 建议：二选一，不要并存——(1) 在 `session-open` 里照 `contextUsed` 的做法用 `usage.jsonl` 按会话回填 `costBuckets`（`foldSessionUsage` 已经按 `sid` 折叠过，缺的只是「按模型分桶」这一列）；或 (2) 把 `cost` 从快照的 transcript 段挪到 `SessionUsageView`（磁盘权威），`Transcript` 只管实时增量。推荐 (2)：费用本来就是磁盘账，与 `lastInputTokens` 同源。
- 置信度：高（`clear()`、`session-open`、`pricing` 的空桶返回三处都核对过；UI 侧只确认 `StatusBar.tsx:208` 读 `status.cost`，未审查 UI 是否有另一条补充路径 → 见待核实）

#### [P1] `packages/transcript` 用 `new Transcript()` 影子重放来做「内容有没有变」，同一状态算两遍

- 位置：`src/packages/transcript/index.ts:156-171`（`replayIsRedundant`）、`src/packages/transcript/index.ts:403-430`（`sameEntries` / `shape`）
- 现象：每次 `session-open` 都新建一个完整 `Transcript`，把当前会话的全部消息重放一遍，再和现有条目做 JSON 字符串比对，只为回答「要不要重建」。日志越长这次影子重放越贵（N 条消息 × 一次 reduce，含工具配对、改动缝合、notice 插位）。
- 证据：
  ```
  159:       const probe = new Transcript()
  160:       probe.replayHistory(
  167:       return sameEntries(
  168:         probe.entries.filter((entry) => entry.kind !== 'system' && entry.kind !== 'subagent'),
  169:         transcript.entries.filter((entry) => entry.kind !== 'system' && entry.kind !== 'subagent'),
  ```
- 影响：同一次打开会话，真实路径与影子路径各算一遍条目；`shape()` 靠「删字段再 JSON.stringify」来抹平那些重放造不出来的量（`startedAt`/`durationMs`/`usage`），每加一个现场测出来的字段就得回来补一次 `delete`，漏了的表现是「打开同一会话每次都整表重建」（折叠态与直播尾被抹掉）。同时 `turnDiff`、`plan` 这类重放不产出的条目会让比对永远判 false，优化在最需要它的长会话里失效。
- 建议：不做影子重放。给 `Session` 落一个「历史版本号」（最后一次 rewind / summary / 追加消息的序号），`session-open` 时比它而不是比条目；或者把 `Transcript` 的条目直接当缓存键（`messages.length + 最后一条 ts`）做粗判。
- 置信度：高（两段都读过；`turnDiff`/`plan` 不在 `replayHistory` 的产出里，已核对 `reduce` 分支与 `replayHistory` 的 switch）

#### [P2] 重放 `turn-error` 时条目用的是「现在」的时间戳

- 位置：`src/adapter/transcript.ts:239-252`（`system()` 硬取 `Date.now()`）、`845-847`（`error` 分支走 `system()`）、`406-408`（重放时带 `notice.ts`）
- 现象：实时与重放都经 `case 'error'` → `this.system(...)`，而 `system()` 不走 `stamp()`，时间戳直接 `Date.now()`。重放时 `this.eventTs` 明明是这条 notice 的历史时刻，却被忽略。
- 证据：
  ```
  245:       ts: Date.now(),
  847:         this.system(`错误：${event.message}`, false, 'error')

  406:     for (const notice of trailing) {
  407:       changed = this.reduce(noticeEvent(notice), notice.ts ?? null) || changed
  ```
- 影响：重开一个几天前的失败会话，那条错误提示会显示成「刚刚」；整轮用时统计也会把这条算进当前时刻。与本文件反复强调的「绝不拿现在冒充历史时刻」口径冲突。
- 建议：`system()` 增加可选 `ts` 参数（缺省 `Date.now()`），`case 'error'` 传 `this.eventTs`；`compaction` 落点同理。
- 置信度：高（两个分支都读过）

### packages/transcript

#### [P1] 「轮数」实现与契约注释口径不一致，机器通知被算成一整轮

- 位置：`src/packages/transcript/index.ts:56-69`（`sessionProgress`）、`src/contract/runtime.ts:46-52`（契约口径）
- 现象：契约写「轮数 = 用户消息数（压缩摘要不算）」，实现只排除 `SUMMARY_BANNER` 前缀，`origin: 'notice'` 的机器唤醒与 `<teammate-report>` 汇报照样 `turns += 1`。界面侧的分轮（`ui-transcript/ui/rounds.ts:111`）明确不给 `internal` 条目开新轮，于是同一个会话在状态栏与对话页是两个轮数。
- 证据：
  ```
  transcript/index.ts:65:     if (contentText(message.content).startsWith(SUMMARY_BANNER)) continue
  transcript/index.ts:66:     turns += 1

  contract/runtime.ts:47:    * 会话进度：轮数 = 用户消息数（压缩摘要不算），步数 = 助手消息数（每次模型调用一步）。
  rounds.ts:111:         if (entry.internal === true) return
  ```
- 影响：后台作业通知、队友汇报都会把「N 轮」往上顶；用户对照对话页数轮次永远对不上。这与 core 侧的三套判据是同一个病根（见下「重复逻辑清单」），修一处不修另一处会继续漂。
- 建议：`sessionProgress` 改用与 `rounds.ts` 同一个谓词（`internal` 的判据应该由 adapter 统一算好并挂在消息上，或者抽 `core/human-message.ts` 供两端共用）；契约注释同步改准。
- 置信度：高（三处判据都读过）

### packages/session

#### [P1] `refresh()` 一次重扫全部会话文件，且与 session-search 并行各扫一遍

- 位置：`src/packages/session/index.ts:128-159`
- 现象：`refresh()` 把活动区与归档区各扫一遍（`listSessions()` + `listArchivedSessions()`），后者还顺手 `sweepTrash()`。注释里已经记着「界面每点一次会话就会 `refreshSessions` 重扫一次」这个历史包袱，core 侧用 `sessionRowCache` 缓冲，但每次仍然要 `statSync` 每个文件（`session.ts:1311`）并 `readFileSync` 整份（缓存未命中时）。
- 证据：
  ```
  134:           const listed = [
  135:             ...listSessions().map((item) => toSummary(item)),
  136:             ...listArchivedSessions().map((item) => toSummary(item, item.archivedAt ?? item.updatedAt)),
  137:           ]
  ```
- 影响：会话上百条时，每次点会话都是几百次 stat + 若干次整文件读；同时 session-search 的 `sync()` 也在扫同一批文件。两个插件互相不知道对方刚扫过，磁盘 IO 翻倍。
- 建议：给 `SessionService.refresh()` 加最小重扫间隔（例如 2 秒内的重复调用合并成一次）或改成事件驱动（`dsc/session-open` 只更新当前行、目录变化时再全扫）；长期看与 session-search 共用上文的 `scanSessionFiles`。
- 置信度：中（`refresh` 全文读过；实际调用频率只看了 `ui.tsx` 的 `channel.invoke('refreshSessions')` 若干处，未统计完整）

#### [P2] 标题派生逻辑散落四处，长度上限各不相同

- 位置：`src/core/session.ts:1385`、`src/core/session.ts:1408`、`src/packages/session/index.ts:314`、`src/packages/session-title/index.ts:46`
- 现象：「首条用户消息压成一行、截断、当标题」写了四遍：core 列表投影两处 `slice(0, 60)`，session 插件 rewind 时一处 `slice(0, 60)`，session-title 的模型标题清洗 `slice(0, 40)`。
- 证据：
  ```
  session.ts:1385:           ? (JSON.parse(derived) as { text: string }).text.replace(/\s+/g, ' ').trim().slice(0, 60)
  session/index.ts:314:           const derived = text === undefined ? '' : text.replace(/\s+/g, ' ').trim().slice(0, 60)
  session-title/index.ts:46:   .slice(0, TITLE_CHARS)   // TITLE_CHARS = 40
  ```
- 影响：改名、自动标题、首条消息三条展示链的截断口径不同，同一句话在侧栏、分叉菜单（`readUserMessages` 用小 50，见 `session.ts:1655`）里长度不一。
- 建议：抽 `core/session-title-text.ts` 的 `deriveTitle(text, max = 60)`，四处调用；分叉菜单的 50 也走它。
- 置信度：高（四处逐条读过）

### packages/session-search

#### [P1] `SessionSearchHit` / `SessionSearchOptions` 与包内 `SessionIndexHit` / `SessionIndexSearchOptions` 字段逐条重复

- 位置：`src/services/types.ts:1262-1295` 与 `src/packages/session-search/session-index.ts:76-111`
- 现象：服务契约里的 7 个字段与包内类型一字不差（含 `fuzzy?: true` 的注释也在两处各写一遍），只差名字。插件 `service.search` 直接把索引的返回类型当服务返回类型用，靠结构兼容过关。
- 证据：
  ```
  types.ts:1279:   fuzzy?: true
  session-index.ts:95:   fuzzy?: true
  types.ts:1262: export interface SessionSearchHit {
  session-index.ts:76: export interface SessionIndexHit {
  ```
- 影响：加一个「命中来源（user/assistant/tool）」或改 `ts` 可空性，要改两处；改一处不会报错（结构兼容），只会让服务契约说谎。
- 建议：`session-index.ts` 直接 `import type { SessionSearchHit as SessionIndexHit, SessionSearchOptions as SessionIndexSearchOptions } from '../../services/types.js'`（或反向让 types 转出包内定义），只留一处定义。
- 置信度：高（两侧全文读过）

### packages/compact

#### [P1] 「上下文占用」三个数三套算法：自动压缩看一份、状态栏看另一份

- 位置：`src/packages/compact/index.ts:305-309`（`check` 用 `estimateTokens(session.messages)`）、`248-253`（`reportContextUsed` 加上 system + tools）、`src/packages/session-core/loop.ts:435-440`（真实请求用 `estimateRequestSegments`）
- 现象：同一个「现在占了多少 token」有三次计算，口径各不同：自动压缩判定**不含**系统提示词与工具定义；压缩完成后的回填**含**这两项；界面进度条的分段按真实请求算（也含）。于是「压缩阈值」与「进度条读数」之间固定差一个「系统提示词 + 工具 schema」的量。
- 证据：
  ```
  compact/index.ts:308:         let used = estimateTokens(session.messages)
  compact/index.ts:309:         if (used <= threshold) return
  compact/index.ts:251:         estimateTokens(target.messages) + estimateTextTokens(system) + estimateTextTokens(JSON.stringify(tools))
  loop.ts:439:         segments: estimateRequestSegments(messages, describeToolSchema(this.requestTools)),
  ```
- 影响：工具目录大的会话（几十个工具）里，自动压缩会明显晚触发；用户看到进度条已经 85%，却要等 `estimateTokens(messages)` 单独冲过阈值才压。两处都是估算，但它们给的是两个不同的估算——排查「为什么没自动压」时要先分辨是哪一个数在说话。
- 建议：定义一个 `estimateRequestTokens(messages, system, tools)`（内部复用 `estimateRequestSegments` 的六段求和），`check` / `reportContextUsed` / `describe` 全走它；`estimateTokens` 只保留给「纯消息体积」这一个用途并改名（如 `estimateMessagesTokens`）避免再被误用。
- 置信度：高（三处都读过）

#### [P2] 没压成也播「已自动压缩历史」

- 位置：`src/packages/compact/index.ts:339-346`
- 现象：`compacted === false`（本轮 outcome 是 `noop`，历史太短或整段都是工具结果）时，仍发「上下文接近模型上限，已自动压缩历史」，只是不带 `compaction` 类别。用户读到的是一句假话。
- 证据：
  ```
  343:         if (!compacted) {
  344:           ctx.emit('dsc/notice', '上下文接近模型上限，已自动压缩历史', undefined, session.filePath)
  345:           return
  346:         }
  ```
- 影响：用户在「什么都没压」的情况下被告知压过了；配合上一条（阈值口径偏差），这条提示是最容易被当成 bug 上报的那种。
- 建议：文案改成「上下文接近模型上限，但这段历史没有可压缩的内容」；或直接不发（安静）。
- 置信度：高（分支完整读过）

### packages/microcompact

#### [P2] 「程序塞进来的 user 消息」判据与 core 的判据不是一套

- 位置：`src/packages/microcompact/microcompact.ts:202-210`
- 现象：这里认四种注入（TODO 提醒、env 快照、hook、`<teammate-report>`），不认 `origin: 'notice'`，也不认 `<review-findings>`；而 `core/session.ts:430-438` 认 `origin` + 队友汇报 + 审查结论，不认 TODO/env/hook。
- 证据：
  ```
  microcompact.ts:204:   const text = typeof message.content === 'string' ? message.content : ''
  microcompact.ts:205:   if (text === TODO_REMINDER_TEXT) return true
  microcompact.ts:207:   if (text.startsWith('<external_content source="hook:')) return true
  microcompact.ts:208:   if (text.startsWith('<teammate-report ')) return true
  ```
- 影响：后台作业完成通知（`origin: 'notice'`，正文无固定前缀）会被这里当成真人发言，`roundKeyOf` 因它翻一轮、冻结的清理计划重算 → 前缀缓存多断一次；而 `content` 是数组的消息直接返回 `false`（`204`），带图的通知一律算真人。
- 建议：与上一条「真人发言判据」合并解决：adapter/转录层给消息算一个 `synthetic` 标记，microcompact 只读标记，不再自己看文本。
- 置信度：高（函数全文读过）

### session-core

#### [P2] `estimateTokens` 与 `estimateRequestSegments` 两套消息体估算并存

- 位置：`src/packages/session-core/compact.ts:155-172`、`src/core/token-estimate.ts:74-118`
- 现象：`core/token-estimate.ts` 的模块注释写「全仓库唯一一份」估算口径，但它只提供分段版（含 `Math.ceil`、按角色归段、工具 schema 单列），压缩链路真正用的是 session-core 里另一个 `estimateTokens`（逐条累加、图像按 1000、自己再 `Math.ceil`）。两者对同一条消息的算法一致，但结构不同、一个不管 schema 一个不管总量。
- 证据：
  ```
  compact.ts:164:         tokens += part.type === 'text' ? estimateTextTokens(part.text) : 1_000
  compact.ts:171:   return Math.ceil(tokens)
  token-estimate.ts:116:     schema: Math.ceil(estimateTextTokens(toolSchema)),
  ```
- 影响：拍照的会话里，压缩判定把每张图算 1000 token，而 `drop-images` 投影可能已经把图剥掉——判定用的是「原图体积」、实际发的是「无图体积」，压缩在图文会话里会提前触发。这是估算口径没跟着投影链走的后果，也是同一个概念两份实现必然踩的坑。
- 建议：`estimateTokens` 挪进 `core/token-estimate.ts` 并注明「按投影前的消息算」，或接受一个「已投影的消息」入参；压缩判定改用投影后的消息（loop 的 `rewrite` 已经能给出那份）。
- 置信度：中（估算两处已核对；「投影后体积」这条只读了 `loop.ts:428-439` 与 `drop-images` 的名字，未读该投影实现）

### contract 与 services/types.ts

#### [P2] 同一形状定义两遍，其中一处多出一个可空字段

- 位置：`src/core/tools.ts:13-31` / `79-86` 与 `src/contract/transcript.ts:327-340` / `86-93`、`318-324`
- 现象：`FileChangeSummary` ↔ `ChangedFileView`、`ToolPresentation` ↔ `ToolPresentationView`、`DiffHunk` ↔ `DiffHunkView` 是三对镜像类型。前者多 `baseline?: string`（内存专用），后者没有；`ToolPresentation.call` 是 `unknown`，镜像版是 `{ card: string } & Record<string, unknown>`。adapter 在两份之间做了一次无校验断言。
- 证据：
  ```
  tools.ts:30:   baseline?: string
  contract/transcript.ts:335:   hunks: DiffHunkView[]

  tools.ts:81:   call?: unknown
  contract/transcript.ts:88:   call?: { card: string } & Record<string, unknown>
  adapter/transcript.ts:792:             call: { ...owner.call, presentation: event.presentation as ToolPresentationView },
  ```
- 影响：`as` 断言是唯一把两份形状缝起来的东西——给 `ToolPresentation` 加字段时，`ToolPresentationView` 不跟着加也不会报错，界面静默收不到；`baseline` 忘 `stripBaseline` 就会把改前全文写进 jsonl/快照（`session.ts:874` 与 `stripBaseline` 就是为这个加的防线）。
- 建议：`ChangedFileView = Omit<FileChangeSummary, 'baseline'>`、`ToolPresentationView` 直接从 `ToolPresentation` 派生（`{ call?: { card: string } & Record<string, unknown> }` 可以用交叉类型约束），删掉镜像定义与 `as`。
- 置信度：高（三对类型都读过）

#### [P2] 跨会话运行状态两套词表

- 位置：`src/services/types.ts:106-111`（`AgentStatusPayload.state`）与 `src/contract/snapshot.ts:20-26`（`SessionRunState`）
- 现象：事件负载用 `'working' | 'awaiting-approval' | 'idle'`，快照面用 `'working' | 'awaiting-approval' | 'just-finished'`。中间靠 `packages/transcript/index.ts:94-105` 手写翻译（`idle` → 删除或 `just-finished`）。
- 证据：
  ```
  types.ts:110:   state: 'working' | 'awaiting-approval' | 'idle'
  snapshot.ts:26: export type SessionRunState = 'working' | 'awaiting-approval' | 'just-finished'
  transcript/index.ts:98:         if (previous !== undefined && path !== ctx.session.current().filePath) {
  transcript/index.ts:99:           backgroundStates.set(path, 'just-finished')
  ```
- 影响：`just-finished` 是转录层自己造的语义，事件生产方（agent/approval）不知道它存在；加第四种状态（比如「等计划评审」）要同时改两套联合类型 + 一处翻译。
- 建议：`SessionRunState` 增加 `'idle'` 作为事件侧值，或把 `just-finished` 明确写成转录层的派生视图类型 `DerivedRunState = SessionRunState | 'just-finished'`，让「谁定义了什么」在类型上说得清。
- 置信度：高（两侧与翻译处都读过）

#### [P2] 契约注释与实现口径不符：`SessionSummary.updatedAt` 不是文件 mtime

- 位置：`src/contract/session.ts:17-18` 与 `src/core/session.ts:1221-1222`、`1345-1360`
- 现象：契约说 `updatedAt` 是「最后一次写入日志的时间（文件 mtime）」，实现是「最后一条带 `ts` 的记录」，且专门为**不**用 mtime 写过一大段理由（2026-11-03 报障「点一下会话时间就变刚刚」）。
- 证据：
  ```
  contract/session.ts:17:   /** 最后一次写入日志的时间（文件 mtime），「按最近使用」排序的键。 */
  session.ts:1221:   /** 最后一步的时刻：最后一条带 `ts` 的对话记录；老日志没有 ts 时回落文件 mtime。 */
  ```
- 影响：任何按契约注释去 `stat` 文件实现排序/缓存的人都会引入「点开就变刚刚」这个已经被修过的 bug；这是注释反向指导错误实现的那类风险。
- 建议：改契约注释为「最后一条带 ts 的对话记录时刻，老日志回落 mtime」。
- 置信度：高（两处全文读过，与 `lastActivityAt` 实现一致）

## 旧/新双路径清单

| 能力 | 旧路径 | 新路径 | 谁还在用旧路径 | 处置建议 |
|---|---|---|---|---|
| 会话存档（Markdown 导出） | `src/core/session-export.ts:1`（一行 `export *`） | `src/packages/commands/session-export.ts` | **无人引用**（全仓 `*.ts/*.tsx/*.mjs/*.js` 检索仅命中文件自身与模块注释） | 删除垫片。功能本体由 `packages/commands/index.ts:32` 直接 import，不经过 core |
| 会话全文索引 | `src/core/session-index.ts:1`（一行 `export *`） | `src/packages/session-search/session-index.ts` | 只有 `scripts/session-index-fuzzy-test.mjs:61`（`import('../lib/core/session-index.js')`） | 垫片留给测试，或把测试改成直接 import 包内路径后删除垫片；建议后者（垫片是 core→packages 反向依赖的入口） |
| 界面片段注册表 | `src/core/surface-registry.ts:1`（一行 `export *`） | `src/packages/surfaces/surface-registry.ts` | **无人引用** | 删除垫片；`packages/surfaces/index.ts:11` 已直接 import 本体 |
| 会话类与列表 | `@pneuma/runtime/core/session.js`（落 `src/core/session.ts`） | 无对应新路径（`packages/session` 只 provide 服务，不导出 `Session`） | 12 个包 import 旧路径：`agent:22`、`approval:37-38`、`microcompact:32`、`compact:29`、`mode:24`、`permission-presets:30`、`llm:17`、`session-title:17`、`session-core/loop:25`、`subagent:42`、`sandbox:45`、`presets:21`、`prompt:30`、`transcript:20`（共 14 处） | 不是「重复实现」，是**没有新路径**：`Session` 仍是核心类。要么承认它是核心并删掉「插件化」期望，要么按 P1 第一条拆成 `SessionLog`/`SessionStateStore`/`SessionInbox` 三个小模块后再谈路径 |
| 错误文本格式化 | `@pneuma/runtime/adapter/transcript.js:935-937`（`export { errText } from '../core/err-text.js'`） | `src/core/err-text.ts`（真身） | 7 个插件为了 `errText` 去 import adapter 层：`compact:27`、`agent:29`、`session:31`、`memory:17`、`host-stdio:25`、`prompt:24`、`session-search:16`、`runtime:10` | 让这 8 处直接 import `core/err-text.js`，删掉 adapter 的转出；这一条同时消掉「功能插件依赖 adapter 层」的分层违规 |

## 重复逻辑清单

| 逻辑 | 位置 A | 位置 B | 差异 | 抽取建议 |
|---|---|---|---|---|
| 「真人发言」判据 | `core/session.ts:430-438`（origin notice + 队友汇报 + 审查结论） | `microcompact/microcompact.ts:202-210`（TODO/env/hook/队友汇报，不看 origin）；`adapter/transcript.ts:576-579`（前缀 + origin）；`packages/transcript/index.ts:65`（只排除摘要）；`ui-transcript/ui/rounds.ts:111`（读 `internal` 标记） | 五份判据各认一部分注入源，结论互相矛盾 | 抽 `core/human-message.ts` 一份谓词表；adapter 在折叠时算出 `internal`/`synthetic` 标记挂到消息上，其余四处只读标记 |
| 「第几条用户消息」计数 | `core/session.ts:450-458`（严格，用于 rewind） | `core/session.ts:1652`（`readUserMessages`，前缀版）；`core/session.ts:1620`（`forkSession`，前缀版）；`core/session.ts:1594`（`applyRewinds`，重写一遍同一谓词） | 严格版排除机器消息，前缀版全算，`applyRewinds` 又把严格版手抄成行级版本 | 同上一条的产物：一个 `countHumanUserRecords(lines, keep)` 同时服务四条路径 |
| 会话文件扫盘 + mtime/size 失效 | `core/session.ts:1264-1322` | `session-search/session-index.ts:760-819`、`741-744` | 缓存键不同（path+sidecar vs path）、作用域不同（活动区 vs 四个区）、一份在内存一份落 JSON | 抽 `core/session-scan.ts` 的 `scanSessionFiles` + `readHead`，两处都调 |
| jsonl 行级解析 | `core/session.ts:596-717`（`buildFromLog`） | `core/session.ts:1403-1420`（抢救）、`core/session.ts:1573-1597`（`applyRewinds`）、`session-search/session-index.ts:849-880`（建索引） | 四种各自只认自己关心的类型，容错策略不同；索引侧还自己判 `ts` 回落 | `parseRecordLine` / `scanRecords` 一份，索引侧复用 |
| 标题派生 | `core/session.ts:1385`、`1408`（60 字） | `packages/session/index.ts:314`（60 字）；`session-title/index.ts:46`（40 字）；`core/session.ts:1655`（分叉菜单 50 字） | 长度与清洗强度不同 | `deriveTitle(text, max)` 一份 |
| 上下文 token 估算 | `session-core/compact.ts:155-172`（`estimateTokens`，逐条累加） | `core/token-estimate.ts:74-118`（`estimateRequestSegments`，按角色分段 + schema） | 一个含 schema、一个不含；图像口径不同；都带 `Math.ceil` | `core/token-estimate.ts` 加 `estimateRequestTokens(messages, system, tools)`，压缩判定与 `reportContextUsed` 改用它 |
| 压缩预算/裁剪 | `session-core/compact.ts:236-272`（`safeCut`/`selectCut`，按 token 留尾） | `microcompact/microcompact.ts:61-90`（按条数留最近 N 条工具结果）；`session-core/compact.ts:73-121`（`pruneRegion` 截工具结果） | 三处都在决定「哪些旧内容可以丢」，判据分别是 token 预算、条数、字符预算 | 不必合并（三者目的不同：折摘要 / 请求体投影 / 摘要输入瘦身），但应共享一个「工具结果体积」的度量函数（现在 `pruneRegion` 用 `length`、microcompact 用 `estimateTextTokens`） |
| 费用/用量累计 | `adapter/transcript.ts:803-828`（内存 `usage`/`turnUsage`/`costBuckets`） | `core/usage-log.ts:324-393`（磁盘 `foldSessionUsage`）+ `146-286`（`aggregateUsage`） | 内存版按会话生命周期、磁盘版按文件；内存版切会话即丢，磁盘版无「按模型分桶的会话级费用」 | 见 P0 第二条：费用以磁盘为准，transcript 只保留实时增量 |
| 「会话状态」词表 | `services/types.ts:110`（含 `idle`） | `contract/snapshot.ts:26`（含 `just-finished`） | 事件侧与视图侧各一套，中间手写翻译 | 见 P2：明确派生类型 |
| 镜像数据类型 | `core/tools.ts:13-31`、`79-86`；`core/diff-text.ts`（`DiffHunk`） | `contract/transcript.ts:327-340`、`86-93`、`318-324` | 前者多 `baseline`，`ToolPresentation` 更宽；靠 `as` 缝合 | `Omit<FileChangeSummary,'baseline'>` 派生 |
| 检索命中类型 | `session-search/session-index.ts:76-111` | `services/types.ts:1262-1295` | 字段完全一致，只差名字 | 只留一处定义 |

## 待核实

1. **费用是否真的没有 UI 侧补充路径**：`StatusBar.tsx:208` 只读 `status.cost`，`ui-statusbar/ui/ui.tsx:133` 有 `useSessionUsage(...)`（走 IPC 读 `usage.jsonl`）。我未读 `ui-statusbar` 与壳的 `useSessionUsage` 实现，无法断定「切会话后费用消失」是否被这条路径兜住——若兜住了，P0 第二条降为 P2（两份账并存但主显示走磁盘）。
2. **`dsh-compat/session-bridge.ts` 反复 `listSessions()`**（351、386、394、415 行）：它在 `session/read`、`session/list` 等 dsh 协议方法里每次全扫。属别的批次范围，我只记录调用关系，未审查是否缓存。
3. **`replayIsRedundant` 的实际命中率**：结论依赖「重放产出条目 = 现有条目」这个前提；`turnDiff`、`plan`、重放不产出的 system 行都会让它判 false。我没有写脚本验证真实会话上的命中率（禁止跑测试），只做了静态推断。
4. **`SessionIndex` 与 `listSessions` 对归档区/回收站的可见性规则**是否一致：`scanSessions` 跳过点开头目录（`.archived`、`.teammates`、`.trash` 都不进活动列表），`SessionIndex.scanTargets` 用开关单独收。如果开关全开，搜索能命中回收站里的会话（`zone: 'hidden'`），而列表永远看不到——用户可能搜到一条点不开的记录。未验证 `includeHiddenDirs` 的默认值与 UI 文案是否说清。
5. **`core/session-export.ts` 与 `core/surface-registry.ts` 是否被动态引用**：检索覆盖 `*.ts/*.tsx/*.mjs/*.js` 并排除 `node_modules`/`lib`，但没查 `package.json` 的 `exports`、`bin/dsc.js` 的 `require`、以及构建脚本 `scripts/build-runtime-package.mjs` 是否把 `core/*` 整目录转发。若是整目录转发，垫片在发布产物里就有存在理由（但仓内仍无消费方）。
6. **`SessionStateMap` 的声明合并**是否已有人用（`declare module '../core/session.js'`）：我只读了形状与注释，未全仓检索声明合并的实际使用点，因此「12 个内建状态是否都能挪出去」只能算方向性建议。
