/**
 * 消息流渲染的三条报障修复的确定性探针（0.6.67 第三轮）：
 *
 *   ① **组员被渲染两次**：一轮里除组头以外的组员，既在组体里铺一遍、又在外面单独铺
 *      一遍——用户看到「已写入文件 2 项」下面跟着两条一模一样的思考栏。修法是把
 *      「哪条行归哪儿」搬成纯函数 `seatPlan`（`process-groups.ts`），本探针断言它的
 *      不变量：**每条行恰好出现一次**。
 *   ③ **思考完毕闪屏折叠**：直播尾的思考行原来被强制展开（`live || …`），定稿后换成
 *      正 id 的新条目 → React key 变 → 重挂 → 按默认档位算成收起 → 用户眼前那段摊开的
 *      思考整体收拢。参考实现（dsh 的 ReasoningRow）从不这么做：推理行一律以收起态
 *      起步，running 只改折叠行右边那句预览的取法。
 *   ④ **编辑卡的展开体摊原始 JSON 参数**：write / edit 的正文（content / old / new）
 *      缩在 JSON 字符串里全是 `\n` 转义。参考实现（dsh 的 FileMutationRow）对这两个工具
 *      只画 diff；壳照同一口径分流——正文走 diff 块，其余字段走参数表。
 *
 * 五段：
 *   [1] 纯逻辑：`seatPlan`（每条行恰好一次 / 组员不单独出 / 组内顺序 / 空表 / 组头位置）
 *   [2] 纯逻辑：`toolArgFields`（会改文件的工具分流 + 正文字段剔除 + 半截参数的降级）
 *   [3] 形态钉：ui.tsx 的 seatPlan 消费点、ThinkRow 不再强制展开、factory 的 diff/参数表
 *   [4] 漂移钉：参数表的字段名与宿主工具真定义对得上（`src/core/tools/fs-tools.ts`）
 *   [5] 开合动画（0.6.69 起；第④阶段 2026-11-11 改成逐行）：过程区包一层 + `fold-motion.ts`
 *       逐行量高归零 + `hidden` 由元素自己末帧提交（首次见到同步提交）；组体那一层仍走 `max-height`
 *   [6] 悬停预览的收卡口径（0.6.69 第五轮）：出卡 500ms 照参考实现，**收卡 1s 是壳侧有意分道**，
 *       且卡片自己挂着 mouseleave（只挂 keep 会让卡粘住不走）
 *   [8] 收起态的结果与失败数（对照 codex 的活动流）：工具卡摊 3 行结果尾巴、
 *       组头报失败条数——两条都是「不点开也能读到结果」的同一件事
 *   [7] 分轮口径单点 + internal 条目不再另起一轮（右侧刻度条 `.jump-rail` 错位 / 多刻度报障）：
 *       座位切分与轮元信息同源（rounds.ts 的 `splitRounds`）、steering 不另起一轮、
 *       internal 从不另起一轮（有轮就并进、没轮进 leading，都不增刻度；2026-11 用户报障，
 *       与 dsh 给非人来源一枚刻度的做法有意不同）、internal 题面预览不出现原文
 *   [13] 已发送消息的贴图也收进浮层（2026-11-02）：可编辑行与只读出口都从 `<a>` 换成
 *       `<button className="entry-shot">`，点开共用同一个 `ImageLightbox`，不再另开窗口
 *
 * 运行：node scripts/ui-transcript-render-test.mjs
 *
 * @module dsc/scripts/ui-transcript-render-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readPluginSource, resolveUiHalf } from './_check-runner.mjs'

// 界面半的新旧根由 resolveUiHalf 判：transcript 已搬进宿主包，旧根那条只剩兜底。
const UI = resolveUiHalf('transcript')

const groups = await import(
  new URL('../' + UI + '/process-groups.ts', import.meta.url).href
)
const args = await import(new URL('../src/packages/ui-primitives/ui/tool-args.ts', import.meta.url).href)
const { seatPlan, groupSteps } = groups
const { toolArgFields, MUTATION_CONTENT_FIELDS } = args
const roundsMod = await import(
  new URL('../' + UI + '/rounds.ts', import.meta.url).href
)
const { splitRounds, roundInfos, teammateReportLabel, internalLabel } = roundsMod

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 造一条条目（探针只喂 kind 与分组用得着的字段）。 */
const entry = (kind, extra = {}) => ({ kind, id: Math.floor(Math.random() * 100000) + 1, ...extra })

console.log('[1] seatPlan：每条行恰好出现一次')
{
  // 一轮：[user, thinking, tool, text, thinking, tool]
  // 2026-11-07 起思考与工具一起进组（回到 dsh 的分组口径）：定稿正文是唯一的边界，
  // 所以这里是两个各装「一条思考 + 一次调用」的组，外加一条独立的正文档位。
  const entries = [
    entry('user', { text: '题面' }),
    entry('thinking', { text: '想一' }),
    entry('tool', { call: { callId: 'a', name: 'read', argsText: '{}', status: 'done' } }),
    entry('text', { text: '第一段答' }),
    entry('thinking', { text: '想二' }),
    entry('tool', { call: { callId: 'b', name: 'write', argsText: '{}', status: 'done' } }),
  ]
  const rounds = [{ index: 0, startIndex: 0, endIndex: 5, startTs: 1, endTs: 2, answered: true }]
  const grouping = groupSteps(entries, rounds, () => false)
  check('分组器切出两个组', grouping.groups.length === 2, String(grouping.groups.length))
  check('每组装着思考与工具两条', grouping.groups.every((group) => group.size === 2 && group.members.length === 2))
  check('思考行也在组里（不再是组外的独立行）', grouping.at.has(1) && grouping.at.has(4), JSON.stringify([...grouping.at.keys()]))

  const ats = entries.map((_, index) => index).slice(1)
  const items = seatPlan(ats, grouping)
  const seen = []
  for (const item of items) {
    if (item.kind === 'group') seen.push(...item.members)
    else seen.push(item.at)
  }
  check('每条行恰好出现一次（0.6.67 的重复就是这么来的）', seen.length === ats.length && new Set(seen).size === ats.length, JSON.stringify(seen))
  check('顺序与出现顺序一致', JSON.stringify(seen) === JSON.stringify([...seen].sort((a, b) => a - b)))
  check('两个组块 + 一条单独行（正文）', items.filter((item) => item.kind === 'group').length === 2 && items.filter((item) => item.kind === 'row').length === 1)
  check('单独成行的是正文，思考不再单列', items.filter((item) => item.kind === 'row').every((item) => item.at === 3))
  check('组员绝不出现在 row 项里（组体铺过就不再单独铺）', items.filter((item) => item.kind === 'row').every((item) => !grouping.at.has(item.at)))
  check('组块带全成员（升序）', items.filter((item) => item.kind === 'group').every((item) => JSON.stringify(item.members) === JSON.stringify([...item.members].sort((a, b) => a - b))))
  check('空表进空表出', seatPlan([], grouping).length === 0)
  // detailed 档的「运行中那一轮」：settledOnly 跳过它，于是一组都不成——全出 row 项
  const running = groupSteps(entries, rounds, () => true, true)
  check('没有分组的轮（detailed 档的运行中轮）全出 row 项', running.groups.length === 0 && seatPlan(ats, running).every((item) => item.kind === 'row'))

  // 单条组也画组头（2026-11-07 撤掉 10-31 的放平）：一条思考 + 一次调用就是一个完整阶段，
  // 放平会把这层结构摊回平铺——那正是用户报障时看到的画面。
  const single = groupSteps(
    [
      entry('user', { text: '题面' }),
      entry('thinking', { text: '想' }),
      entry('tool', { call: { callId: 'a', name: 'read', argsText: '{}', status: 'done' } }),
    ],
    [{ index: 0, startIndex: 0, endIndex: 2, startTs: 1, endTs: 2, answered: true }],
    () => false,
  )
  check('一条思考 + 一次调用就是一个组（不再拆散）', single.groups.length === 1 && single.groups[0].members.join(',') === '1,2')

  // system 是边界：它自己不进组，也不许被组员区间连带收进去（那是「错误提示被折叠」的来源）。
  const withSystem = groupSteps(
    [
      entry('user', { text: '题面' }),
      entry('tool', { call: { callId: 'a', name: 'read', argsText: '{}', status: 'done' } }),
      entry('system', { text: '出错了' }),
      entry('tool', { call: { callId: 'b', name: 'read', argsText: '{}', status: 'done' } }),
    ],
    [{ index: 0, startIndex: 0, endIndex: 3, startTs: 1, endTs: 2, answered: true }],
    () => false,
  )
  check('system 不进组，且把前后的工具切成两组', withSystem.groups.length === 2 && withSystem.groups.every((group) => group.members.length === 1))
  const systemSeat = seatPlan([1, 2, 3], withSystem)
  check('system 行原样留在座位里（不被折叠吞掉）', systemSeat.some((item) => item.kind === 'row' && item.at === 2))
}

console.log('[2] toolArgFields：会改文件的工具走参数表')
{
  const write = toolArgFields('write', JSON.stringify({ path: 'a.md', justification: '因为', content: '# 标题\n正文' }))
  check('write 认成会改文件的工具', write.mutating === true)
  check('正文（content）不进参数表', !write.fields.some((field) => field.key === 'content') && write.omitted.includes('content'), JSON.stringify(write.omitted))
  check('其余字段按原序进表', write.fields.map((field) => field.key).join(',') === 'path,justification', write.fields.map((field) => field.key).join(','))
  check('值压成一行（正文之外的字段不留换行）', write.fields.every((field) => !field.value.includes('\n')))

  const edit = toolArgFields('edit', JSON.stringify({ path: 'a.ts', old: '一', new: '二' }))
  check('edit 的 old / new 都剔出去', edit.omitted.includes('old') && edit.omitted.includes('new') && edit.fields.length === 1)

  const mcp = toolArgFields('str_replace_editor', JSON.stringify({ path: 'a.ts', old_str: 'x', new_str: 'y', file_text: 'z' }))
  check('别家的写文件工具同样分流（str_replace_editor）', mcp.mutating === true && mcp.fields.length === 1)

  const bash = toolArgFields('bash', JSON.stringify({ command: 'ls' }))
  check('非文件工具不分流（照旧摊参数 JSON）', bash.mutating === false && bash.fields.length === 0)

  const half = toolArgFields('write', '{"path":"a.md","cont')
  check('半截参数（流式中）仍报 mutating、但参数表为空', half.mutating === true && half.fields.length === 0)
  const notObject = toolArgFields('write', '[1,2]')
  check('参数不是对象也照上面那条降级', notObject.mutating === true && notObject.fields.length === 0)

  const values = toolArgFields('write', JSON.stringify({ path: 'a.md', flags: [1, 2], meta: { a: 1 }, content: 'x' }))
  check('对象/数组的值压成一行 JSON', values.fields.some((field) => field.key === 'flags' && field.value === '[1,2]'))
  check('正文之外的字段一个不丢', values.fields.length === 3)
}

console.log('[3] 形态钉（ui.tsx / factory.tsx / status 的催拍）')
{
  const ui = readPluginSource(UI)
  const factory = read(UI + '/tool-card/factory.tsx')
  const pgs = read(UI + '/process-groups.ts')
  const status = read('src/packages/ui-status/ui/ui.tsx')

  // 「按 kind 切座位」的判据只在 rounds.ts（分轮真值），渲染体（render.tsx）里不许再出现。
  const renderSrc = read(UI + '/render.tsx')
  check('排布走纯函数 seatPlan（规则不在渲染体里）', renderSrc.includes('for (const item of seatPlan(') && !/kind === 'user'/.test(renderSrc))
  check('process-groups.ts 的 seatPlan 是纯逻辑（不引 React）', !/from 'react'/.test(pgs) && pgs.includes('export function seatPlan('))

  // 「不该出现」的断言先剥注释：修法自己的注释里就引着旧写法，不剥会自己打脸。
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  // 2026-10-29：「默认展开」改成由 useFoldState 负责（设置一改老行跟着变，手动调过的不动）。
  // 2026-11-10：直播尾改成**固定收起起步**（对齐 dsh 的 use-disclosure：初值恒收起），
  // 设置只在定稿后参与——跑动中自动摊开会让内容每口 delta 都重播一次高度动画。
  check(
    '③ 直播尾不再强制展开（直播收起起步、定稿才认设置档）',
    uiCode.includes('useFoldState(storeKey, !live && prefs.reasoningOpen)') && !uiCode.includes('readFold(storeKey, live ||'),
  )
  check('③ 直播的「还活着」由扫光/摘要/小圈承载（三样都在）', ui.includes('data-shimmer={live ? summary : undefined}') && ui.includes('think-status') && ui.includes('think-sr'))

  check('④ 展开体按「有没有 diff」分流参数', factory.includes('const paramsAsFields = patch !== null && argView.mutating'))
  check('④ 会改文件的工具渲染字段表（.arg-fields）', factory.includes('className="args arg-fields"') && factory.includes('argView.fields.map('))
  check('④ 没有 diff 时仍摊原始 JSON（不丢信息）', factory.includes('<div className="args">{prettyJson(call.argsText)}</div>'))
  check('④ 落地后的 diff 由 bodyExtra 的 fallback 接手（轨迹页也看得到）', factory.includes("useFactorySlot('bodyExtra', IntendedBody)") && factory.includes("data-tc-change=\"\""))
  // dsh 插件的 diff 卡片：数据早就在 `presentation.result` 上，但展开体只认 `call.change`，
  // 于是「卡上有数据、画不出来」。两条一起钉：解析出补丁，并且并进展开体的同一个入口。
  check('④ dsh 的 diff 卡片并进展开体（不只用来分流参数表）', factory.includes('const dshPatch = dshPatchOf(call.presentation)') && factory.includes('change={call.change ?? dshPatch}'))

  check('⑤ git 轮询效果吃 gitNudge（自增即重拍）', status.includes('}, [channel, gitNudge])') && status.includes('lastGitPollRef.current = startedAt'))
  check('⑤ 换工作区催拍（会话路径 / 工作目录）', status.includes('}, [sessionPathKey, cwdKey, nudgeGit])'))
  check('⑤ 回合收工催拍（dsh 的 turn/end 同款）', status.includes("if (was !== 'idle' && turnState === 'idle') nudgeGit()"))
  check('⑤ 催拍有间隔下限（一拍刚跑过就不重拍）', status.includes('GIT_NUDGE_FLOOR_MS') && status.includes('Date.now() - lastGitPollRef.current < GIT_NUDGE_FLOOR_MS'))
}

console.log('[3b] 行的稳定身份（2026-11-10：直播 → 定稿不换键）')
{
  const shared = read(UI + '/shared.ts')
  const renderSrc = read(UI + '/render.tsx')
  const uiSrc = read(UI + '/ui.tsx')
  const pgsSrc = read(UI + '/process-groups.ts')
  const foldState = read(UI + '/fold-state.ts')
  const seatsSrc = read(UI + '/fold-seats.tsx')
  const views = read('src/packages/ui-renderer/ui/styles/legacy/views.css')

  // 为什么钉这一条：直播条目的 id 是按「第几个直播段」发的负数、定稿又换正数，拿它当身份
  // 会让展开态在「新工具进来 / 这段定稿」时被下一行借走——报障原话是「收起旧的、展开新的」。
  check('Row 带稳定身份字段（轮内第几条同类型条目）', shared.includes('stable: string') && shared.includes('export function buildSeats('))
  check('buildSeats 真的算稳定身份（同类型序号 + 工具优先 callId）', shared.includes('stableOf(') && shared.includes('nextOrdinal(') && shared.includes(':call:'))
  check('keyOf 用稳定身份，不再用 entry.id', shared.includes('return `${sessionKey}|${row.stable}`') && !shared.includes('String(row.entry.id)'))
  // 2026-11-10 改形状：thinking 分支的存档键从「JSX 属性里内联」提成了局部常量
  // （`transcript.node` 槽的兜底拆分要求把每个分支整理成一支），值没变——钉的仍是
  // `row.stable` 这个取法，两种写法都算数。
  check(
    '思考行的存档键用 row.stable',
    /(?:storeKey=\{|const storeKey = )`\$\{sessionId \?\? ''\}:\$\{row\.stable\}`/.test(renderSrc),
  )
  check('工具卡的存档键不再用 row.at', !renderSrc.includes('${sessionId ?? \'\'}:${String(row.at)}') && renderSrc.includes('const storeKey = `${sessionId ?? \'\'}:${row.stable}`'))
  check('阶段组的键由首行稳定身份派生', renderSrc.includes('stepGroupFoldKey(sessionId, first?.stable') && foldState.includes('export function stepGroupFoldKey(sessionId: string | null, headStable: string)'))
  // 2026-11-11 第二次修：整轮收起时**不再由父级统一复位**里层的展开态（旧结构里那段
  // 「从展开变收起就按轮前缀清存档」的副作用删了：行级键根本不存在、组的键也盖不全，
  // 而且它不看焦点、不看这一层是不是真的在藏）。现在谁被藏谁自己关，判据是
  // 「已经挂上 hidden 或正在收起」（hiddenOrCollapsing），不是「应该收起」——
  // 焦点保护放行的那一层因此不会被跟着关掉。
  check(
    '整轮收起不靠父级复位（里层谁被藏谁自己关，判据 hiddenOrCollapsing）',
    // 父级那套整轮复位已经删干净；剩下的 clearPrefixes 只归「同一轮改完重答」那一条路。
    !uiSrc.includes('collapsedRounds')
      && !uiSrc.includes('foldMemory.reset(settled)')
      && (uiSrc.match(/foldMemory\.clearPrefixes\(/g) ?? []).length === 1
      // 替代它的路真的在：座位在「整轮真的进入收起那一拍」自己关，判据从 scope 取。
      && seatsSrc.includes('const entering = !wasTurnCollapsed.current && props.turnCollapsed')
      && seatsSrc.includes('scope.hiddenOrCollapsing(element)'),
  )
  check('运行中尾组一条也成组（对齐 dsh 首条即建组）', /if \(isRunning\(round\.index\)\) \{\s*flush\(false\)/.test(pgsSrc))
  // 注释里还留着「原来用 @starting-style」的解释，判据前先剥注释，免得自己打脸。
  const viewsCode = views.replace(/\/\*[\s\S]*?\*\//g, '')
  check('思考展开区不再做高度过渡（grid 0fr/1fr 与 @starting-style 都撤了）', !viewsCode.includes('@starting-style') && !/\.think-body \{[^}]*grid-template-rows/.test(viewsCode))
}

console.log('[4] 漂移钉：参数表的字段名与宿主工具真定义对得上')
{
  const fsTools = read('src/core/tools/fs-tools.ts')
  // write 的 required 是 path + content；edit 的 required 是 path + old + new
  check('宿主 write 的正文参数确实叫 content', /name: 'write'[\s\S]{0,400}?content: \{ type: 'string'/.test(fsTools))
  check('宿主 edit 的两个参数确实叫 old / new', /name: 'edit'[\s\S]{0,600}?old: \{ type: 'string'/.test(fsTools) && /name: 'edit'[\s\S]{0,900}?new: \{ type: 'string'/.test(fsTools))
  check('壳的表与宿主口径一致（write→content、edit→old+new）', MUTATION_CONTENT_FIELDS['write'].join(',') === 'content' && MUTATION_CONTENT_FIELDS['edit'].join(',') === 'old,new')
  check('两张表都覆盖 write / edit', ['write', 'edit'].every((name) => name in MUTATION_CONTENT_FIELDS))
}

console.log('[5] 整轮过程区的开合动画（0.6.69 第四轮报障）')
{
  const ui = readPluginSource(UI)
  const seats = read(UI + '/fold-seats.tsx')
  const css = read('src/packages/ui-renderer/ui/styles/legacy/views.css')
  const tokens = read('src/packages/ui-renderer/ui/styles/legacy/tokens.css')

  // 结构：过程区必须**包一层**才能整片一起动（平铺时收起的行不占位，flex gap 会留下一堆空档）。
  // 2026-11-06：foldedReplies=all 要留下中间那几段话，所以这一层改成**按段**包——
  // 连续的「要藏」行合成一段 .turn-process，留在屏幕上的正文不进任何一段。
  check(
    '过程区包进 .turn-process + .turn-process-body 两层（按段包，带 data-fold）',
    /<div className="turn-process" data-fold=\{collapsed \? 'closed' : 'open'\}/.test(ui) && ui.includes('<div className="turn-process-body">{segment}</div>'),
  )
  check('没有过程行时不画这一层（foldBlocks 为空就整块不画）', ui.includes('{foldBlocks.length === 0 ? null : <>{foldBlocks}</>}'))
  // 「藏不藏」查的是预算器给的集合，不是 start/end 区间：区间读数还在，但只当过程范围用。
  check('藏不藏查 fold.hidden 集合（区间只当读数）', /const inFold = \(row: Row\): boolean =>\s*\n\s*fold !== undefined && fold\.foldable && fold\.hidden\.has\(row\.at\)/.test(ui))
  // 2026-11-07 起不再有 keptReply 这个专门的判据：不折的行（留在外面的正文、写前预览卡、
  // 计划卡这类独立条目）统一走「fold: false 进 middle」，由分段循环原地夹住。
  check('不折的行走 fold: false 进 middle（不进 .turn-process、也不挪到队尾）', /else middle\.push\(\{ node: seatRow\(row, false\), fold: false \}\)/.test(ui) && !/afterBlocks\.push|\{afterBlocks\}/.test(ui))
  check('分段：连续的藏行攒进 segment，遇到留下的正文先 flush', /if \(block\.fold\) \{\s*\n\s*segment\.push\(block\.node\)/.test(ui) && /flushSegment\(\)\s*\n\s*foldBlocks\.push\(block\.node\)/.test(ui))
  // 折叠时机：最新一轮的兜底展开来自 turnDefaultOpen，用户手点过的存档仍优先。
  check('兜底默认态 = turnDefaultOpen(collapseTiming, latest)', /turnDefaultOpen\(foldPrefs\.collapseTiming, fold\?\.latest === true\)/.test(ui) && /foldMemory\.open\(turnKey, defaultOpen\)/.test(ui))

  // ── 第④阶段（2026-11-11）：高度动画从「整段 grid 裁剪」换成「逐行收起」──────────
  // 三条 grid 形态钉（原 :268 / :272 / :273）与三条猜时长钉（原 :277 / :279 / :280）
  // 必然失效：它们钉的那串字符已经不存在了。**钉的仍是同一件事**——收起有动画、
  // 时长取令牌、末帧才挂 hidden、组体那一层不接——只是载体从 CSS 换成 fold-motion.ts。
  const motion = read(UI + '/fold-motion.ts')
  // 2026-11-11 第二次修：`hidden` 的写入权从「父级遍历子节点写」改回「每个被隐藏元素自己写」。
  // 下面几条钉的是**顺序与归属**，所以先把要用到的函数体切出来再断言（整段源码里找子串
  // 会被同名变量蒙过去，例如 `commit()` 在三个分支里都出现）。
  // 从模块里切一个函数体：两格缩进的 `}` 收尾。切不到返回空串，下游断言全假。
  const bodyOf = (name) => {
    const at = motion.indexOf(`  function ${name}(`)
    if (at < 0) return ''
    const end = motion.indexOf('\n  }\n', at)
    return end < 0 ? '' : motion.slice(at, end)
  }
  const collapseBody = bodyOf('collapse')
  const flushBody = bodyOf('flush')
  const settleBody = bodyOf('settle')
  const finishBody = bodyOf('finish')
  /**
   * 这些片段在源码里按给定顺序出现吗（中间可以隔着注释与别的代码）。
   * 少一条就是假：不许靠 `indexOf` 的 -1 冒充「在前面」。
   */
  const inOrder = (text, ...needles) => {
    let previous = -1
    for (const needle of needles) {
      const at = text.indexOf(needle, previous + 1)
      if (at <= previous) return false
      previous = at
    }
    return true
  }
  check('逐行收起的模块在（fold-motion.ts 的 useTurnFoldMotion）', /export function useTurnFoldMotion\(/.test(motion))
  check(
    '每一行动三个值：高度 / 外边距 / 透明度（预量后归零，不做 auto 插值、不读 scrollHeight）',
    // collapse 里：预量 offsetHeight / 计算 marginTop，并把**实测值**写死成起始高度。
    inOrder(
      collapseBody,
      'const height = element.offsetHeight',
      'globalThis.getComputedStyle(element).marginTop',
      'style.height = `${String(height)}px`',
      'style.marginTop = `${String(marginTop)}px`',
    )
      // flush 里：三个值一起归零（高度 → 外边距 → 透明度）。
      && inOrder(flushBody, "style.height = '0px'", "style.marginTop = '0px'", "style.opacity = '0'")
      // 不做 auto 插值、也不读行自己的 scrollHeight（scrollHeight 只允许出现在视口强制回流那一句）。
      && !motion.includes("style.height = 'auto'")
      && !/element\.scrollHeight/.test(motion),
  )
  check(
    '每帧顺序：先写行的 box（预量 + 强制回流）→ 开批次 → 每帧 frame() → 收工 end()',
    // 1) 行的 box：实测高度写死 → 登记 → 排微任务（顺序反了就是「auto → 0」的跳变）。
    inOrder(
      collapseBody,
      'const height = element.offsetHeight',
      'style.height = `${String(height)}px`',
      'waiting.set(element, { element, commit, height, marginTop })',
      'schedule()',
    )
      // 2) 强制回流 → 在布局没变的那一刻开批次 → 再归零 → 批次里每帧先 frame() 再判跑完没有。
      && inOrder(
        flushBody,
        'void (viewport.scroller?.scrollHeight ?? 0)',
        'viewport.beginBatch({ moving, durationMs: total + COMMIT_TAIL_MS })',
        "style.height = '0px'",
        'next.batch?.frame()',
      )
      && inOrder(flushBody, 'next.batch?.frame()', 'if (performance.now() >= next.deadline)')
      // 3) 收工：先清中间状态，最后才 end() 把窗口关掉。
      && inOrder(finishBody, 'if (run === target) run = null', 'target.batch?.end()'),
  )
  check(
    '批次的开窗只由 motion 一处：viewport 不再监听 data-fold 翻面（不留两套开窗信号）',
    motion.includes('viewport.beginBatch(') && !/observeFolds|FOLD_ATTR/.test(read(UI + '/viewport.ts')),
  )
  check(
    'hidden 只在末帧提交，三个入口共用一个 finish()（transitionend / 批次末帧 / 超时兜底），判定是批次级的',
    motion.includes('function finish(target: Run): void {')
      && inOrder(finishBody, 'if (target.done) return', 'target.batch?.end()')
      // 入口一：transitionend —— 只认高度那一条，且元素还在这一批里，才走 settle。
      // settle 只记账、不提交（见下一条），真正的判定在整批收工那一次。
      && inOrder(
        flushBody,
        "if (event.target !== element || event.propertyName !== 'height') return",
        'if (next.items.get(element) !== item) return',
        'settle(next, item)',
      )
      // 最后一个元素收完 → 整批收工（不是单个元素自己提交完就算）。
      && settleBody.includes('if (target.items.size === 0) finish(target)')
      // 入口二：批次跑到末帧。
      && inOrder(flushBody, 'if (performance.now() >= next.deadline) {', 'finish(next)')
      // 入口三：过渡被合成器丢掉时的超时兜底。
      && inOrder(flushBody, 'window.setTimeout(() => {', 'finish(next)')
      // 提交动作只剩两处：`finish` 的无焦点分支（整批一次提交完，含超时兜底带进来的）
      // 与 `prefers-reduced-motion` 的降级分支。**`settle` 不再提交**——2026-11-12 起
      // 元素收完只记账，所以这里是 2 不是 3，别再改回 3 去「补一处」。
      && (motion.match(/item\.commit\(\)/g) ?? []).length === 2
      // 批次判定骨架，顺序就是语义（2026-11-12）：先把这一批凑齐（已收完记账的 +
      // 超时兜底还没收完的），再一次性看焦点——有焦点只放行那一层、整批一个 hidden
      // 都不挂；没焦点才逐层提交；两条路最后都把内联值还回去。
      && inOrder(
        finishBody,
        'const items = [...target.settled, ...target.items.values()]',
        'target.items.clear()',
        'const focused = items.find(holdsFocus)',
        'focused.commit.reveal()',
        'if (item.element.isConnected) item.commit()',
        'for (const item of items) clearElement(item.element)',
      ),
  )
  check(
    '收完只记账，不在 settle 里逐元素提交（顺序依赖不许回来）',
    // 元素收完（transitionend）只入账、停监听、摘批次；提交与放行的判定归整批收工那次。
    // 这里出现 `item.commit()` 就是「谁先收完谁先关」，同批兄弟层又会出现
    // 「整轮展开、靠前的组却被关掉并写进存档」。
    inOrder(
      settleBody,
      'if (!target.items.delete(item.element)) return',
      'target.settled.push(item)',
      'if (target.items.size === 0) finish(target)',
    )
      && !settleBody.includes('item.commit()')
      // 记账到收工之间也算「在藏」：不算的话，这段窗口里一次重渲染会把它重新交给
      // collapse，量到 0 高就当场提交——顺序依赖从另一条路又回来。
      && inOrder(
        bodyOf('hiddenOrCollapsing'),
        'if (run.items.has(element)) return true',
        'return run.settled.some(',
      ),
  )
  check('系统说「少动」时不进动画、同步提交 hidden', /if \(prefersReducedMotion\(\)\) \{/.test(motion) && /'\(prefers-reduced-motion: reduce\)'/.test(motion))
  // 只查这两条规则自己（`grid-template-rows` 在别处还有用处：七段数码管、别的折叠层）。
  const turnProcessRule = /\.turn-process \{([^}]*)\}/.exec(css)?.[1] ?? ''
  const turnProcessBodyRule = /\.turn-process-body \{([^}]*)\}/.exec(css)?.[1] ?? ''
  check('`.turn-process` 退回普通容器：不再 grid-template-rows、不再裁剪', turnProcessRule.includes('display: block') && !/grid-template-rows|overflow/.test(turnProcessRule), turnProcessRule.trim())
  check('`.turn-process-body` 不再限高裁剪、透明度过渡一并退役', turnProcessBodyRule.includes('gap: calc(3px') && !/min-height|overflow|transition: opacity/.test(turnProcessBodyRule), turnProcessBodyRule.trim())
  check('收起态不写 display:none（元素与 data-fold 留着，只退役动画）', !/\.turn-process\[data-fold='closed'\] \{[\s\S]{0,160}display: none/.test(css))
  check('留一格 0 高 flex 项会多算座位 gap，用负 margin 抵掉', /\.turn-process\[data-fold='closed'\] \{[\s\S]{0,200}margin-top: calc\(-1 \* var\(--dsc-stack-gap\)\)/.test(css))
  check('时长取令牌：motion 从 viewport 的 readSlowMs 读，模块里没有写死毫秒', /import \{ readSlowMs/.test(motion) && /const total = readSlowMs\(\)/.test(motion) && !/\b(?:const|let)\s+\w+\s*=\s*(?:180|200)\b/.test(motion))
  check('三段比例照参考实现（淡出 44% / 高度延迟 31% / 高度跑 69%）', motion.includes('70 / 160') && motion.includes('50 / 160'))
  check('--dsc-dur-slow 两份声明都还在（旧默认值 + 现行设计覆盖，有意保留）', tokens.includes('--dsc-dur-slow: 180ms') && read('src/packages/ui-renderer/ui/styles/styles.css').includes('--dsc-dur-slow: 200ms'))

  // 收起方向要「内容还在、行自己先收」：摘 / 挂 hidden 的时刻归 motion 判，钩子不自己抢先。
  // 工作区按 LF 存，但别写跨行字面量——跨行一律 `\s*\n\s*`，换行风格变了也不会假红。
  check('猜时长的兜底已删（fold-seats 里没有 foldHideDelayMs，也没有「延时挂 hidden」的定时器）', !seats.includes('foldHideDelayMs') && !/setTimeout\(\(\) => \{\s*\n\s*element\.setAttribute/.test(seats))
  // 展开方向（hidden === false）不排批次、不等末帧：先停掉这个元素自己的动画，再立刻提交。
  // 这两句必须紧挨着、且顺序不能反（先 commit 再 cancel 会留下一个没人清的批次）。
  const transitionAt = motion.indexOf('const transition: HiddenTransition = (element, hidden, commit) => {')
  const transitionBody = transitionAt < 0 ? '' : motion.slice(transitionAt, motion.indexOf('\n  }\n', transitionAt))
  check(
    '展开方向不延迟（放行要立刻看得见）',
    transitionBody.includes('if (hidden) {')
      && inOrder(transitionBody, 'cancelMotion(element)', 'commit()')
      && !/commit\(\)\s*\n\s*cancelMotion\(element\)/.test(transitionBody),
  )
  // 提交权在元素自己手里（2026-11-11 第二次修）：父级不再遍历子节点写 hidden，
  // 替代它的路是「scope 里带 transition → 座位从 context 取 → 元素在自己的布局效果里提交」。
  const render = read(UI + '/render.tsx')
  check(
    'hidden 的提交权交给 motion：两层座位从 context 取 transition，父级不再遍历子节点写 hidden',
    // 旧结构那套「父级遍历子节点、统一 commitHidden」已经不存在。
    !/commitHidden/.test(motion)
      && seats.includes('export const FoldScopeContext = createContext<FoldScope | undefined>(undefined)')
      && render.includes('<FoldScopeContext.Provider value={foldMotion}>')
      // 两个座位（行 / 阶段组外层）各取一次，没有第三处。
      && (seats.match(/useContext\(FoldScopeContext\)/g) ?? []).length === 2
      && (seats.match(/scope\?\.transition/g) ?? []).length === 2
      // 写 hidden 属性这一句在 fold-seats（元素自己的布局效果里），motion 一个字都不碰属性。
      && seats.includes("element.setAttribute('hidden', 'until-found')")
      && !motion.includes("setAttribute('hidden'")
      // 不传 transition 的层（前导行 / 团队页签 / 组体）走同步提交，没有动画可等。
      && inOrder(seats, 'if (transition === undefined) commit()', 'else transition(element, hidden, commit)')
      // motion 也不再收 reveal 了：整轮折叠只需要 collapsed 与 viewport。
      && render.includes('useTurnFoldMotion({ collapsed, viewport })'),
  )
  check('组体（max-height 那一层）不传 transition：内容留在文档里，本来就平滑', /const bodyRef = useSearchableHidden\(!props\.open, revealGroup\)/.test(seats))
  check('焦点在里层、或被查找命中时的放行照旧（Ctrl+F 与键盘都不受影响）', seats.includes('element.contains(element.ownerDocument.activeElement)') && seats.includes("element.addEventListener('beforematch', reveal)"))
  check('系统说「少动」时整轮收起那套也不进动画（降级块里有 .entry-row / .step-seat）', /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,700}\.entry-row,\s*\n\s*\.step-seat \{/.test(css))
  check('.entry-row[hidden] 仍是 display:none（末帧提交的落点，删了 until-found 就不生效）', /\.entry-row\[hidden\] \{\s*\n\s*display: none;/.test(css))
  check('.step-body[hidden] 仍是 max-height: 0 + overflow: hidden（组体那一层不走 motion）', /\.step-body\[hidden\] \{[\s\S]{0,160}max-height: 0;/.test(css))
  check('焦点在里层、或被查找命中时的放行照旧（Ctrl+F 与键盘都不受影响）', seats.includes('element.contains(element.ownerDocument.activeElement)') && seats.includes("element.addEventListener('beforematch', reveal)"))

  // 阶段组那一级：收起态本来就是 max-height: 0（内容留文档里），补一条过渡即可。
  // 窗口从「400 字符」改成「整条规则内」（[^}]*）：2026-10-30 的栅格改造在规则头上加了
  // 缩进三件套，按字符距离找 transition 会假红。
  check('组体的一级开合也走过渡（两头都是 max-height 的确定值）', /\.step-body \{[^}]*transition: max-height var\(--dsc-dur-slow\) var\(--dsc-ease\);/.test(css))

  // 降级：base.css 那条全局 reduced-motion 把过渡压成瞬时
  check('系统说「少动」时全站过渡归零（base.css 兜底，不用逐组件再写）', /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}transition-duration: 0\.01ms !important/.test(read('src/packages/ui-renderer/ui/styles/legacy/base.css')))
  check('参考实现的做法在注释里留了档（dsh 只转箭头 / zcode 高度关键帧）', css.includes('dsh') && css.includes('zcode'))
}

console.log('[6] 悬停预览的收卡口径（0.6.69 第五轮报障：鼠标移出预览 1s 才收）')
{
  const ui = readPluginSource(UI)
  const hook = read('src/packages/ui-primitives/ui/hover-delay.ts')

  // 出卡节奏照参考实现（500ms），收卡是壳侧有意的 1s——旧渲染层那份仍 100ms（冻结不动）
  check('出卡仍是 500ms', hook.includes('const HOVER_DELAY_MS = 500'))
  check('收卡是 1s', hook.includes('const HOVER_CLOSE_MS = 1000'))
  check('为什么分道写在注释里（不然下次有人「对齐」回去）', hook.includes('为什么收卡不是参考实现的 100ms'))

  // 卡片自己要有离开事件：只挂 onMouseEnter 会让卡永远粘住（行上的 mouseleave 早烧掉了）
  check('预览卡挂着 onMouseEnter（keep）+ onMouseLeave（disarm）', /className="hover-preview"[\s\S]{0,140}onMouseEnter=\{onKeep\}[\s\S]{0,60}onMouseLeave=\{onLeave\}/.test(ui))
  check('卡片收 onLeave 这个 prop', /onLeave: \(\) => void/.test(ui) && ui.includes('onLeave={hoverDelay.disarm}'))
  check('disarm 就是「起收卡倒计时」那一条（行上移开与出卡共用同一条）', hook.includes('closeRef.current = window.setTimeout(() => setHover(null), HOVER_CLOSE_MS)'))
  check('卡会粘住这件事在注释里留了档', ui.includes('永远粘住'))
}

console.log('[7] 分轮口径单点 + internal 条目对齐 dsh（0.6.67 右侧刻度条错位 / 多刻度）')
{
  const ui = readPluginSource(UI)
  const timing = read(UI + '/timing.ts')
  const css = read('src/packages/ui-renderer/ui/styles/legacy/views.css')
  const cardCss = read('src/packages/ui-renderer/ui/styles/styles.css')
  const triggerSrc = read('src/packages/ui-transcript/ui/rows/trigger-row.tsx')
  const userRowSrc = read('src/packages/ui-transcript/ui/rows/user-row.tsx')
  const renderSrc = read(UI + '/render.tsx')
  // 「不该出现」的断言先剥注释：修法的注释里就引着旧写法 / roundInfos，不剥会自己打脸。
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  let seq = 0
  const e = (kind, extra = {}) => ({ kind, id: (seq += 1), ...extra })
  // 宿主 subagent 插件（src/packages/subagent/index.ts:517）造出来的队友汇报正文形状。
  const teammateBody =
    '<teammate-report from="mate-1" role="coder" state="已完成">\n派给它的任务：改个 bug\n它的汇报：\n搞定了\n</teammate-report>'

  // ── ① 座位切分与轮元信息同源：steering 归入当前轮、不另起座位，两边下标一一对应 ──
  const steer = [
    e('user', { text: 'A', ts: 1 }),
    e('text', { text: 'r1', ts: 2 }),
    e('user', { text: '插一句话', steering: true, ts: 3 }),
    e('text', { text: 'r2', ts: 4 }),
    e('user', { text: 'B', ts: 5 }),
    e('text', { text: 'r3', ts: 6 }),
  ]
  const split = splitRounds(steer)
  const infos = roundInfos(steer)
  check(
    '① steering 不另起一轮（插话那条并进当前轮：2 轮，round0 覆盖 0..3）',
    split.rounds.length === 2 && split.rounds[0].startIndex === 0 && split.rounds[0].endIndex === 3,
    JSON.stringify(split.rounds),
  )
  check(
    '① 座位数 = 轮数，且 round 序号 / 开轮下标逐项一一对应',
    split.seats.length === infos.length &&
      split.seats.every((seat, i) => seat.round === infos[i].index && seat.round === i && seat.indices[0] === infos[i].startIndex),
    JSON.stringify(split.seats),
  )
  check(
    '① 对同一 entries 两边（splitRounds 的轮 / roundInfos）逐项相同（一份真值）',
    JSON.stringify(infos) === JSON.stringify(split.rounds),
  )
  const covered = [...split.leading, ...split.seats.flatMap((seat) => seat.indices)]
  check(
    '① 前导 + 座位恰好覆盖每条一次且升序（座位是连续切片）',
    covered.length === steer.length && covered.every((at, i) => at === i),
    JSON.stringify(covered),
  )
  check(
    '① 座位末下标 = 下一轮开轮条目之前（不越界、不留缝）',
    split.seats.every((seat, i) => {
      const next = split.seats[i + 1]
      const stop = next === undefined ? steer.length - 1 : next.indices[0] - 1
      return seat.indices.at(-1) === stop
    }),
  )
  // roundInfos 现在住在 timing.ts 里（整个插件都读得到），「不再另算一份」只能按函数体判。
  // 2026-11-10：buildSeats 搬进 shared.ts 并给每行算稳定身份（Row.stable），函数体变长，
  // 截取窗口跟着放宽；判据本身不变——分轮只走 splitRounds，不自己按 kind 切。
  const buildSeatsBody = uiCode.slice(uiCode.indexOf('function buildSeats'), uiCode.indexOf('function buildSeats') + 2600)
  check(
    "① buildSeats 走 splitRounds（不再自己按 kind==='user' 切座位）",
    buildSeatsBody.includes('const split = splitRounds(all)') && buildSeatsBody.includes('split.seats.map((seat) =>')
    && !buildSeatsBody.includes('roundInfos('),
  )
  check(
    "① timing.ts 转出 rounds.ts 的 roundInfos（旧的分轮循环已撤，不留第二份判据）",
    timing.includes("from './rounds'") && timing.includes('export { roundInfos, type RoundInfo }') && !timing.includes('current = {'),
  )

  // ── ② internal 从不另起一轮：有轮就并进当前轮，没轮就归 leading（两种都不增刻度） ──
  const midSteer = [
    e('user', { text: 'A', ts: 1 }),
    e('text', { text: 'r1', ts: 2 }),
    e('user', { text: teammateBody, steering: true, internal: true, ts: 3 }),
    e('text', { text: 'r2', ts: 4 }),
  ]
  const endInternal = [
    e('user', { text: 'A', ts: 1 }),
    e('text', { text: 'r1', ts: 2 }),
    e('user', { text: teammateBody, internal: true, ts: 3 }),
    e('text', { text: 'r2', ts: 4 }),
  ]
  const leadInternal = [
    e('system', { text: '开场提示', ts: 1 }),
    e('user', { text: '后台作业 job-1 成功完成。', internal: true, ts: 2 }),
    e('user', { text: 'A', ts: 3 }),
    e('text', { text: 'r1', ts: 4 }),
  ]
  const mid = splitRounds(midSteer)
  const end = splitRounds(endInternal)
  const lead = splitRounds(leadInternal)
  check(
    '② 回合中途并进本轮的 internal（steering+internal）不增刻度：仍 1 轮 1 座位',
    mid.rounds.length === 1 && mid.seats.length === 1 && mid.seats[0].indices.length === 4,
    JSON.stringify(mid.seats),
  )
  check(
    '② 收尾出账的 internal（非 steering）不开新轮、并进上一轮：仍 1 轮 1 座位，round0 覆盖 0..3',
    end.rounds.length === 1 &&
      end.seats.length === 1 &&
      end.rounds[0].startIndex === 0 &&
      end.rounds[0].endIndex === 3 &&
      end.seats[0].indices.join(',') === '0,1,2,3',
    JSON.stringify(end.rounds),
  )
  check(
    '② 并进上一轮时 endTs 跟着推进（internal 之后还有条目就用后者的时刻）',
    end.rounds[0].endTs === 4,
    JSON.stringify(end.rounds[0]),
  )
  const endTail = splitRounds(endInternal.slice(0, 3))
  check(
    '② internal 是本轮最后一条时也算进 endTs（「用时」仍是整轮墙钟）',
    endTail.rounds.length === 1 && endTail.rounds[0].endIndex === 2 && endTail.rounds[0].endTs === 3,
    JSON.stringify(endTail.rounds),
  )
  check(
    '② 会话第一条就是通知：不造空轮、归 leading 开场段，座位接缝不错位',
    lead.rounds.length === 1 &&
      lead.rounds[0].startIndex === 2 &&
      lead.seats.length === 1 &&
      lead.seats[0].indices.join(',') === '2,3' &&
      lead.leading.join(',') === '0,1',
    JSON.stringify({ rounds: lead.rounds, seats: lead.seats, leading: lead.leading }),
  )

  // ── ③ internal 的题面预览不出现原文：给一句人话（队友名 / 状态从 body 头解出来） ──
  check(
    '③ 队友汇报的人话标签带队友名、不含原文',
    teammateReportLabel(teammateBody) === '队友 mate-1 汇报了运行结果' && !teammateReportLabel(teammateBody).includes('<teammate-report'),
    teammateReportLabel(teammateBody),
  )
  check(
    '③ 头里认不出队友名时也绝不回原文（兜底一句通用话）',
    teammateReportLabel('<teammate-report role="x">乱</teammate-report>').includes('队友') &&
      !teammateReportLabel('<teammate-report role="x">乱</teammate-report>').includes('<teammate-report'),
  )
  check('③ 状态进文案（state="已失败" → 失败了）', teammateReportLabel('<teammate-report from="mate-2" state="已失败">x').includes('失败了'))
  check(
    '③ 刻度题面预览：internal 走人话标签，不取原文（悬停卡不会出现 <teammate-report）',
    /user\.internal === true\s*\?\s*internalLabel\(user\.text\)/.test(ui),
  )
  check(
    '③ 唤醒卡带队友名、保留 data-internal="1"（标题走 internalLabel，不写死类别词）',
    triggerSrc.includes('data-internal="1"') &&
      triggerSrc.includes('internalLabel(entry.text)') &&
      !triggerSrc.includes('子任务状态更新') &&
      internalLabel(teammateBody).includes('队友 mate-1'),
  )
  check(
    '③ 对话页把 internal 条目交给唤醒卡（不再画 .entry-system 灰行）',
    userRowSrc.includes('if (entry.internal === true) return <TriggerRow entry={entry} />') &&
      !userRowSrc.includes('className="entry-system"'),
  )
  check(
    '③ 唤醒卡样式在 styles.css（.trigger-card），旧的灰行选择器已删',
    cardCss.includes('.trigger-card') && !css.includes(".entry-system[data-internal='1']"),
  )
  check(
    '③ 唤醒卡默认收起、头行可点、原文按 pre 原样排（对照 dsh 的 TurnTriggerNodeView）',
    triggerSrc.includes('useState(false)') &&
      triggerSrc.includes('aria-expanded={open}') &&
      triggerSrc.includes('<pre className="trigger-text">'),
  )

  // ── ⑨ 不上屏的条目不占座位（2026-11-08 报障：组头下面一片白，才轮到通知行）──
  // 空盒子不占高度，但过程区是 gap: 3px 的 flex 列，它照样吃一个缝：一轮改五个文件＝
  // 十条 changes/turnDiff 就叠出 27px 的空白。判据在行渲染之前，不是靠 CSS 藏。
  {
    const showsMod = await import(new URL('../' + UI + '/row-shows.ts', import.meta.url).href)
    const { rowShows } = showsMod
    check(
      '⑨ 改动明细（changes / turnDiff）不出座位',
      !rowShows(e('changes', { file: {} })) && !rowShows(e('turnDiff', { files: [] })),
    )
    check(
      '⑨ 正常收尾的 turn-end 不出座位，中断 / 跑挂的照出',
      !rowShows(e('turn-end', { reason: 'completed' })) &&
        rowShows(e('turn-end', { reason: 'aborted' })) &&
        rowShows(e('turn-end', { reason: 'failed' })),
    )
    check('⑨ 空白正文不出座位，真正文照出', !rowShows(e('text', { text: ' \n ' })) && rowShows(e('text', { text: '有字' })))
    check('⑨ 用户消息 / 工具 / 思考 / 通知一律照出', ['user', 'tool', 'thinking', 'system', 'model-retry'].every((kind) => rowShows(e(kind, { text: 'x' }))))
    check(
      '⑨ 座位真的跳过它（render.tsx 两处都判 rowShows）',
      renderSrc.includes('if (!rowShows(row.entry)) return null') && renderSrc.includes('if (!rowShows(row.entry)) continue'),
    )
  }

  // ── ④ 老回归闸（段 [1]「每条行恰好出现一次」）对新的分轮产物仍然成立 ──
  {
    const ats = mid.seats[0].indices.slice(1)
    const grouping = groupSteps(midSteer, mid.rounds, () => false)
    const seen = []
    for (const item of seatPlan(ats, grouping)) {
      if (item.kind === 'group') seen.push(...item.members)
      else seen.push(item.at)
    }
    check(
      '④ 新分轮产物喂进 seatPlan 后每条行仍恰好一次（段 [1] 回归闸不放水）',
      seen.length === ats.length && new Set(seen).size === ats.length,
      JSON.stringify(seen),
    )
  }
}


console.log('[8] 收起态的结果与失败数（对照 codex 的活动流）')
{
  const tailMod = await import(
    new URL('../' + UI + '/tool-card/result-tail.ts', import.meta.url).href
  )
  const { resultTail, RESULT_TAIL_LINES } = tailMod
  const factory = read(UI + '/tool-card/factory.tsx')
  const row = read(UI + '/step-group-row.tsx')
  const css = read('src/packages/ui-renderer/ui/styles/styles.css')
  // 组体的缩进与竖线 2026-10-30 并进了 legacy/views.css（同一选择器原来分在两份样式表里）。
  const viewsCss = read('src/packages/ui-renderer/ui/styles/legacy/views.css')

  // ── 纯逻辑：收起态不再摊结果行，只数「点开还能看到几行」 ──
  //    2026-10-27 用户报「工具调用在折叠状态时占用面积太大，只占一行就行」，
  //    三行预览（照 codex 的 DETAIL_PREVIEW_LINES）让每张卡从一行变四行。
  const six = ['1', '2', '3', '4', '5', '6'].join('\n')
  const tail = resultTail(six)
  check('收起态一行都不摊', RESULT_TAIL_LINES === 0 && tail.lines.length === 0, JSON.stringify(tail))
  check('隐藏行数 = 全部非空行', tail.hidden === 6, String(tail.hidden))
  check('末尾空行不算进读数', resultTail('a\nb\n\n\n')?.hidden === 2)
  check('中间的空白行不算进读数（只数真内容）', resultTail('a\n\n\nb\n\nc')?.hidden === 3)
  check('结果为空 / 没回来时连读数都不给', resultTail('') === null && resultTail('   \n') === null && resultTail(undefined) === null)
  check('单行结果也只留读数（仍不摊预览）', resultTail('只有一行')?.hidden === 1 && resultTail('只有一行')?.lines.length === 0)

  // ── 分组器：失败数只算 failed，不把「用户拒绝审批」算进来 ──
  const entries = [
    { kind: 'user', id: 1, text: '题面', ts: 1 },
    { kind: 'thinking', id: 2, text: '想' },
    { kind: 'tool', id: 3, call: { callId: 'a', name: 'bash', argsText: '{}', status: 'failed' } },
    { kind: 'tool', id: 4, call: { callId: 'b', name: 'read', argsText: '{}', status: 'done' } },
    { kind: 'tool', id: 5, call: { callId: 'c', name: 'bash', argsText: '{}', status: 'rejected' } },
    { kind: 'text', id: 6, text: '答完', ts: 9 },
  ]
  const rounds = [{ index: 0, startIndex: 0, endIndex: 5, startTs: 1, endTs: 9, answered: true }]
  const grouping = groupSteps(entries, rounds, () => false)
  check('组头失败数只算 failed（rejected 是用户拒绝，不是跑挂）', grouping.groups[0].failures === 1, JSON.stringify(grouping.groups[0].failures))

  // ── 渲染与样式的接线 ──
  check('组头把失败数画出来（data-step-failures）', row.includes('step-fold-fail') && row.includes('data-step-failures={props.group.failures}'))
  check('失败数也进开合提示（不点开就知道里面有没有坑）', row.includes("t('transcript.group.failNote', { count: props.group.failures })"))
  check('工具卡收起态不再渲染结果尾巴（只留头行）', factory.includes('resultTail(call.resultText)') && !factory.includes('className="tool-tail"'))
  check('展开态 / 轨迹页照旧不重复摊', factory.includes("bodyOpen || variant !== 'chat' || running ? null : resultTail"))
  check('被截断的行数写在头行（tc-more）', factory.includes('tc-more') && factory.includes('tail.hidden > 0'))
  check('结果尾巴的样式也删干净了（不留死规则）', !/\.tool-tail(-line|-text|-gutter)?\s*\{/.test(css))
  // 2026-10-30 起缩进改由令牌驱动（--proc-indent / --proc-pad），竖线提到 stroke-1：
  // 写死的 9px 与 stroke-2 正是「三列各走各的轴、竖线在截图里看不见」的来源。
  // 口径见 docs/ui-design.md §15；逐条断言在 scripts/ui-process-grid-test.mjs。
  check('组体缩进 + 竖线（层级在版面上看得见）', /\.step-body \{[^}]*border-left: 1px solid var\(--dsc-stroke-1\)[^}]*margin-left: var\(--proc-pad\)[^}]*padding-left: calc\(var\(--proc-indent\)/.test(viewsCss))
  check('组体的缩进只剩一处（styles.css 里没有第二份 .step-body）', !/\.step-body\s*\{/.test(css))
  check('失败数在窄屏也不隐藏（它是读数，不是装饰）', !/\.step-fold-fail[^{}]*\{[^}]*display: none/.test(css))
}

console.log('[8b] 独立行原地摆，不被兜底挪到一轮末尾（2026-11-07 报障）')
{
  // 报障原话：「任务中的更改文件一直堆积在底部，没有保持原位」。写前预览卡是 system 条目，
  // 原来 pushRow 有个 else 分支把这些「不折、也不是留在屏幕上的正文」的行丢进 afterBlocks，
  // 而 afterBlocks 在整段过程区之后才渲染——一次编辑一张卡，十几张摞在轮尾。
  // 现在独立行也进 middle（fold: false），由分段循环把它们原地夹在几段过程之间。
  const renderSrc = read(UI + '/render.tsx')
  check('没有 afterBlocks 这条兜底队尾的出路', !/afterBlocks\.push|\{afterBlocks\}/.test(renderSrc) && !renderSrc.includes('const afterBlocks'))
  check('不折的行走原地摆放（fold: false 进 middle）', renderSrc.includes('else middle.push({ node: seatRow(row, false), fold: false })'))
  check('分段循环照旧把非折块原地接上（flushSegment 后再 push）', /flushSegment\(\)\s*\n\s*foldBlocks\.push\(block\.node\)/.test(renderSrc))
}

console.log('[9] 轮尾「已编辑 N 个文件」卡只在一轮收口之后出现')
{
  // 报障现场（2026-11-01）：一轮还在跑，转圈下面先挂出一份只算了一半的清单，
  // 点「审查」看到的是半截改动。判据只认 ChatView 给的 running（turnState + 最后一轮）。
  const renderSrc = read(UI + '/render.tsx')
  check(
    '① 卡在 running 成立时不画（收口才上屏）',
    /running \? null : <ChangesCard rows=\{seat\.rows\} cwd=\{cwd\} \/>/.test(renderSrc),
  )
  // 为什么不能用 roundFold 的 running：它含「这一轮没答完」，被中断的旧轮永远成立，
  // 那些轮改过的文件就再也点不到「审查」了。
  check(
    '② 不拿 roundFold 的 running 当判据（中断过的旧轮它的卡还在）',
    !/foldRunning \? null : <ChangesCard/.test(renderSrc)
      && renderSrc.includes('/** 这一轮还在跑（只有最后一轮会跑）：轮尾的时刻与用量此时不画。 */'),
  )
}

console.log('[10] 流式光标那根竖条（2026-11-02 报障：正文左下角多出一根浅棕色短竖条）')
{
  // 现场：`.live::after { content: '▍' }` 挂在**块级容器**上（`.entry-text.live` 整段正文、
  // `.think-block.live` 整条思考行），容器里最后一块是 markdown 的 `<p>`，行内伪元素排不进
  // 上一行，被摆到下一行行首按容器左缘对齐——用户看到的就是那根 6×25 的浅棕色竖条。
  // 修法是删掉光标本身（不是挪位置）：直播信号还有思考行的转圈与扫光，正文在长高。
  const css = read('src/packages/ui-renderer/ui/styles/legacy/views.css')
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  check('光标规则已删（不再有 content 是方块字符的那条）', !code.includes('▍'))
  check('连带 blink 关键帧一起删（不留只被它用的死规则）', !/@keyframes\s+blink\s*\{/.test(code))
  check('也没留下空壳的 .live 规则（那条 position: relative 只为光标存在）', !/^\.live\s*\{/m.test(code))
  const think = read(UI + '/rows/think-row.tsx')
  check('直播信号还在：思考行那颗转圈（.think-spin）', /\.think-spin \{/.test(code) && think.includes('think-spin'))
  check('删的理由与「别加回来」留在注释里', css.includes('流式直播尾光标：2026-11-02 删掉，别加回来'))
}

console.log('[11] 轮尾的复制 / 分叉：停下之后、鼠标压在输出上才现（2026-11-02 报障）')
{
  // 报障现场：这一轮还在输出，轮尾已经挂着「复制 / 分叉」——复制拿到半截回答、分叉分出
  // 半截会话；停下之后两颗钮又常驻，长会话里每轮后面都拖着一排按钮。
  // 两段判据：跑动中由组件不渲染（running），停下后由样式默认透明、悬浮输出才提到 1。
  const foot = read(UI + '/rows/foot.tsx')
  const css = read('src/packages/ui-renderer/ui/styles/legacy/views.css')
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')

  check('跑动中不画复制（不再是「留着但没意义」）', /const copy = !props\.running && /.test(foot))
  check('跑动中不画分叉（不再是置灰占位）', /const fork = !props\.running && /.test(foot))
  check('分叉那颗不再挂 disabled（已经渲染不出来了，留着就是死属性）', !/disabled=\{props\.running\}/.test(foot))
  // 2026-11-03：用量（.round-tokens）与时刻（.round-clock）也并进同一条规则——它们
  // 常驻同样把每一轮后面拖成一行小字；分隔点（.round-sep）一起，免得剩个孤零零的「·」。
  const footHidden = /\.round-foot \.round-act,([\s\S]{0,220}?)opacity: 0;/.exec(code)
  check(
    '默认透明是两颗钮 + 用量/时刻一起（同一条规则）',
    footHidden !== null &&
      ['.round-foot .user-act', '.round-foot .round-tokens', '.round-foot .round-sep', '.round-foot .round-clock'].every(
        (sel) => footHidden[1].includes(sel),
      ),
  )
  check(
    '悬浮这一轮的「非首块」才现（首块是用户自己的提问，压在上面不该弹）',
    /\.turn-seat > \*:not\(:first-child\):hover ~ \.round-foot \.round-act/.test(code),
  )
  check('压在页脚自己那一行上也现（按钮就在那行里，否则点不到）', /\.turn-seat > \.round-foot:hover \.round-act/.test(code))
  check('键盘焦点进这一轮也现（Tab 走得到两颗钮）', /\.turn-seat:focus-within > \.round-foot \.round-act/.test(code))
  check('用 opacity 不用 display/visibility（后者会让按钮不可聚焦）', !/\.round-foot \.round-act[^{]*\{[^}]*display: none/.test(code))
  check(
    '系统说「少动」时淡入也关掉（两颗钮 + 用量/时刻都在那条规则里）',
    /prefers-reduced-motion: reduce\) \{[\s\S]{0,300}\.round-foot \.round-clock \{\s*\n\s*transition: none;/.test(code),
  )
}

console.log('[12] 机器投递的消息画成唤醒卡，不是用户气泡（2026-11-02 报障：后台作业通知冒成气泡）')
{
  // 判据在宿主三处（落库 / 事件 / 重放），界面这一侧只认 `internal` 并给一句话标签。
  // 逐条断言的实测在 scripts/notice-origin-test.mjs（21 项）；这一节钉的是「界面没有绕开它」。
  const userRow = read(UI + '/rows/user-row.tsx')
  // 2026-11-08：灰行换成一张可展开的小卡（对照 dsh 的 TurnTriggerNodeView）。
  const triggerRow = read(UI + '/rows/trigger-row.tsx')
  const uiSrc = read(UI + '/ui.tsx')
  const rounds = read(UI + '/rounds.ts')
  const adapter = read('src/adapter/transcript.ts')
  const session = read('src/core/session.ts')
  const loop = read('src/packages/session-core/loop.ts')
  const llm = read('src/core/llm.ts')

  check(
    '内部行按类型给标签（不再一律说「子任务汇报」）',
    userRow.includes('<TriggerRow entry={entry} />') &&
      triggerRow.includes('internalLabel(entry.text)') &&
      triggerRow.includes('{label}'),
  )
  check('刻度条悬停卡与触发行共用同一句', uiSrc.includes("? internalLabel(user.text)"))
  check('标签函数认得队友汇报 / 后台作业 / 其它三种', ['teammateReportLabel(text)', "'transcript.internal.jobFailed'", "'transcript.internal.runtimeNotice'"].every((piece) => rounds.includes(piece)))
  check('适配器：前缀命中 **或** origin === notice', /event\.origin === 'notice'/.test(adapter) && adapter.includes('startsWith(TEAMMATE_REPORT_OPEN)'))
  check('落库：机器投递才写 origin（人打的字不写）', /appendUser\([^)]*origin: InboxOrigin = 'user'/.test(session) && /origin === 'notice' \? \{ origin \}/.test(session))
  check('出账两条路都把来源带上（空闲直落 + 收件箱出账）', (loop.match(/appendUser\([^)]*origin\)/g) ?? []).length === 2)
  check('重放认得 origin（否则重开旧会话又变气泡）', /message\.origin === 'notice' \? \{ origin: message\.origin \}/.test(adapter))
  check('请求侧把 origin 剥掉（协议里没这一项）', /delete wire\.origin/.test(llm))
}

console.log('[13] 已发送消息里的贴图也开浮层（可编辑行 + 只读出口，同一套）')
{
  const userRow = read(UI + '/rows/user-row.tsx')
  const css = read('src/packages/ui-renderer/ui/styles/styles.css')
  const viewsCss = read('src/packages/ui-renderer/ui/styles/legacy/views.css')

  // 「不该出现」的断言先剥注释：文件头就引着旧写法（`<a target="_blank">`），不剥会自己打脸。
  const code = userRow.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  // 两份气泡（可编辑行 / 只读出口）都得改到：按钮、点击写 zoom、根节点挂浮层，每样都是两份。
  check(
    '两处贴图都是 <button className="entry-shot">（可编辑行与只读出口各一份）',
    (code.match(/className="entry-shot"/g) ?? []).length === 2,
    String((code.match(/className="entry-shot"/g) ?? []).length),
  )
  check(
    '两处点击都写 setZoom（不是只挂了一个按钮）',
    (code.match(/onClick=\{\(\) => \{\s*setZoom\(url\)/g) ?? []).length === 2,
    String((code.match(/onClick=\{\(\) => \{\s*setZoom\(url\)/g) ?? []).length),
  )
  check(
    '两处都渲染同一个 ImageLightbox（src 取 zoom）',
    (code.match(/<ImageLightbox src=\{zoom\}/g) ?? []).length === 2,
    String((code.match(/<ImageLightbox src=\{zoom\}/g) ?? []).length),
  )
  check(
    '两处各有自己的 zoom 状态（只读出口不是借来的）',
    (code.match(/const \[zoom, setZoom\] = useState<string \| null>\(null\)/g) ?? []).length === 2,
  )
  check('ImageLightbox 从 @dsc/ui-primitives 取（跟壳里其它基元一个口径）', /import \{[^}]*ImageLightbox[^}]*\} from '@dsc\/ui-primitives'/.test(userRow))

  // 负向：贴图不再是链接。文件卡的下载链接是另一回事，只钉「贴图那条 a」和 target 的条数。
  check('贴图不再是 <a href={url}>', !code.includes('href={url}'))
  check(
    '贴图不再另开窗口（target="_blank" 只剩文件下载卡那一条）',
    (code.match(/target="_blank"/g) ?? []).length === 1,
    String((code.match(/target="_blank"/g) ?? []).length),
  )

  // 样式：点击面与浮层观感（132×96 的展示框没被顺手改掉）。
  check('CSS 里 .entry-shot 是 zoom-in 的点击面', /\.entry-shot \{[\s\S]{0,200}cursor: zoom-in/.test(css))
  check('CSS 里图片不接事件（整格都是点击面）', /\.entry-shot img \{\s*\n\s*pointer-events: none/.test(css))
  check('既有的 132×96 展示框没动（.entry-user-images img 仍是 contain）', /\.entry-user-images img \{[^}]*width: 132px;[^}]*height: 96px;[^}]*object-fit: contain;/.test(viewsCss))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
