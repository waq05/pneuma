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
 *   [5] 开合动画（0.6.69）：过程区包一层 + grid-template-rows 0fr↔1fr + 收起延迟挂 hidden
 *   [6] 悬停预览的收卡口径（0.6.69 第五轮）：出卡 500ms 照参考实现，**收卡 1s 是壳侧有意分道**，
 *       且卡片自己挂着 mouseleave（只挂 keep 会让卡粘住不走）
 *   [8] 收起态的结果与失败数（对照 codex 的活动流）：工具卡摊 3 行结果尾巴、
 *       组头报失败条数——两条都是「不点开也能读到结果」的同一件事
 *   [7] 分轮口径单点 + internal 条目对齐 dsh（右侧刻度条 `.jump-rail` 错位 / 多刻度报障）：
 *       座位切分与轮元信息同源（rounds.ts 的 `splitRounds`）、steering 不另起一轮、
 *       回合中途并进的 internal 不增刻度而回合收尾的增一枚、internal 题面预览不出现原文
 *   [13] 已发送消息的贴图也收进浮层（2026-11-02）：可编辑行与只读出口都从 `<a>` 换成
 *       `<button className="entry-shot">`，点开共用同一个 `ImageLightbox`，不再另开窗口
 *
 * 运行：node scripts/ui-transcript-render-test.mjs
 *
 * @module dsc/scripts/ui-transcript-render-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readPluginSource } from './_check-runner.mjs'

const groups = await import(
  new URL('../ui-shell/src/plugins/transcript/process-groups.ts', import.meta.url).href
)
const args = await import(new URL('../ui-shell/src/ui-primitives/tool-args.ts', import.meta.url).href)
const { seatPlan, groupSteps, needsGroupHeader } = groups
const { toolArgFields, MUTATION_CONTENT_FIELDS } = args
const roundsMod = await import(
  new URL('../ui-shell/src/plugins/transcript/rounds.ts', import.meta.url).href
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
  // 2026-10-30 起只有工具进组、思考行是组外的同级行（对齐 dsh 的版式），所以这里是两个
  // 各装一条工具的组，外加两条独立的思考行与一条正文。
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
  check('每组只装工具调用（思考不进组）', grouping.groups.every((group) => group.size === 1))
  check('思考行不在任何组的成员区间里', !grouping.at.has(1) && !grouping.at.has(4), JSON.stringify([...grouping.at.keys()]))

  const ats = entries.map((_, index) => index).slice(1)
  const items = seatPlan(ats, grouping)
  const seen = []
  for (const item of items) {
    if (item.kind === 'group') seen.push(...item.members)
    else seen.push(item.at)
  }
  check('每条行恰好出现一次（0.6.67 的重复就是这么来的）', seen.length === ats.length && new Set(seen).size === ats.length, JSON.stringify(seen))
  check('顺序与出现顺序一致', JSON.stringify(seen) === JSON.stringify([...seen].sort((a, b) => a - b)))
  check('两个组块 + 三条单独行（思考 ×2 + 正文 ×1）', items.filter((item) => item.kind === 'group').length === 2 && items.filter((item) => item.kind === 'row').length === 3)
  check('思考行进 row 项（与组头同级渲染）', items.filter((item) => item.kind === 'row').some((item) => item.at === 1) && items.filter((item) => item.kind === 'row').some((item) => item.at === 4))
  check('组员绝不出现在 row 项里（组体铺过就不再单独铺）', items.filter((item) => item.kind === 'row').every((item) => !grouping.at.has(item.at)))
  check('组块带全成员（升序）', items.filter((item) => item.kind === 'group').every((item) => JSON.stringify(item.members) === JSON.stringify([...item.members].sort((a, b) => a - b))))
  check('空表进空表出', seatPlan([], grouping).length === 0)
  // detailed 档的「运行中那一轮」：settledOnly 跳过它，于是一组都不成——全出 row 项
  const running = groupSteps(entries, rounds, () => true, true)
  check('没有分组的轮（detailed 档的运行中轮）全出 row 项', running.groups.length === 0 && seatPlan(ats, running).every((item) => item.kind === 'row'))

  // 单条组不画组头（2026-10-31）：分组器照样切出这一组，但渲染层要把它放平成一行。
  check('单条组判为「不必画组头」', needsGroupHeader(grouping.groups[0]) === false && grouping.groups[0].size === 1)
  const twoTools = groupSteps(
    [
      entry('user', { text: '题面' }),
      entry('tool', { call: { callId: 'a', name: 'read', argsText: '{}', status: 'done' } }),
      entry('tool', { call: { callId: 'b', name: 'read', argsText: '{}', status: 'done' } }),
    ],
    [{ index: 0, startIndex: 0, endIndex: 2, startTs: 1, endTs: 2, answered: true }],
    () => false,
  )
  check('两条同行工具照旧成组（层级只在真压缩时出现）', twoTools.groups.length === 1 && twoTools.groups[0].size === 2 && needsGroupHeader(twoTools.groups[0]) === true)
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
  const ui = readPluginSource('ui-shell/src/plugins/transcript')
  const factory = read('ui-shell/src/plugins/transcript/tool-card/factory.tsx')
  const pgs = read('ui-shell/src/plugins/transcript/process-groups.ts')
  const status = read('ui-shell/src/plugins/status/ui.tsx')

  // 「按 kind 切座位」的判据只在 rounds.ts（分轮真值），渲染体（render.tsx）里不许再出现。
  const renderSrc = read('ui-shell/src/plugins/transcript/render.tsx')
  check('排布走纯函数 seatPlan（规则不在渲染体里）', renderSrc.includes('for (const item of seatPlan(') && !/kind === 'user'/.test(renderSrc))
  check('process-groups.ts 的 seatPlan 是纯逻辑（不引 React）', !/from 'react'/.test(pgs) && pgs.includes('export function seatPlan('))

  // 「不该出现」的断言先剥注释：修法自己的注释里就引着旧写法，不剥会自己打脸。
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  // 2026-10-29：「默认展开」改成由 useFoldState 负责（设置一改老行跟着变，手动调过的不动），
  // 这里钉的是「初值只认用户的档位」这条语义，写法换成钩子，断言跟着换。
  check(
    '③ 直播尾不再强制展开（展开态只认用户的档位）',
    uiCode.includes('useFoldState(storeKey, prefs.reasoningOpen)') && !uiCode.includes('readFold(storeKey, live ||'),
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
  const ui = readPluginSource('ui-shell/src/plugins/transcript')
  const seats = read('ui-shell/src/plugins/transcript/fold-seats.tsx')
  const css = read('ui-shell/src/legacy/views.css')
  const tokens = read('ui-shell/src/legacy/tokens.css')

  // 结构：过程区必须**包一层**才能整片一起动（平铺时收起的行不占位，flex gap 会留下一堆空档）
  check('过程区包进 .turn-process + .turn-process-body 两层', /<div className="turn-process" data-fold=\{collapsed \? 'closed' : 'open'\}>/.test(ui) && ui.includes('<div className="turn-process-body">{processBlocks}</div>'))
  check('没有过程行时不画这一层（不可折的档位连开关行都没有）', ui.includes('{processBlocks.length === 0 ? null : ('))

  // CSS：高度动画走 grid-template-rows 0fr↔1fr（不预先量高度），内层 min-height:0 + overflow:hidden
  check('高度动画是 grid-template-rows 的两头（0fr ↔ 1fr）', /\.turn-process \{[\s\S]{0,200}grid-template-rows: 1fr/.test(css) && /\.turn-process\[data-fold='closed'\] \{[\s\S]{0,120}grid-template-rows: 0fr/.test(css))
  check('内层给了 min-height: 0 + overflow: hidden（否则 0fr 会被内容顶开）', /\.turn-process-body \{[\s\S]{0,200}min-height: 0;[\s\S]{0,120}overflow: hidden;/.test(css))
  check('收起态留的是 0 高盒子而不是 display:none（收起方向才有内容撑住高度）', !/\.turn-process\[data-fold='closed'\] \{[\s\S]{0,160}display: none/.test(css))
  check('留一格 0 高 flex 项会多算座位 gap，用负 margin 抵掉', /\.turn-process\[data-fold='closed'\] \{[\s\S]{0,200}margin-top: calc\(-1 \* var\(--dsc-stack-gap\)\)/.test(css))
  check('内容随高度一起淡入淡出（zcode 的「高度关键帧 + fade」那一对）', /\.turn-process-body \{[\s\S]{0,320}transition: opacity/.test(css) && /\.turn-process\[data-fold='closed'\] \.turn-process-body \{\s*\n\s*opacity: 0/.test(css))
  check('时长取令牌 --dsc-dur-slow（不写死毫秒）', /\.turn-process \{[\s\S]{0,260}grid-template-rows var\(--dsc-dur-slow\) var\(--dsc-ease\)/.test(css))

  // 收起方向要「内容还在、格子先收」：挂 hidden 得晚于动画跑完
  // 工作区是 CRLF：跨行匹配一律 `\s*\n\s*`（写成字面 `\n` 会在 CRLF 工作区上假红）。
  check('收起时延迟挂 hidden（挂早了内容当场没，两边都是 0 高，动画等于没有）', seats.includes('const timer = globalThis.setTimeout(() => {') && /element\.setAttribute\('hidden', 'until-found'\)\s*\n\s*\}, delay\)/.test(seats))
  check('展开方向不延迟（放行要立刻看得见）', /if \(!hidden\) \{\s*\n\s*element\.removeAttribute\('hidden'\)/.test(seats))
  check('延迟时长与 CSS 同源（现读 --dsc-dur-slow，不各写一份）', seats.includes("getPropertyValue('--dsc-dur-slow')") && tokens.includes('--dsc-dur-slow: 180ms'))
  check('延迟只给「display:none 那一层」：过程行与阶段组的座位', (seats.match(/delayMs: foldHideDelayMs\(\)/g) ?? []).length === 2)
  check('组体（max-height 那一层）不延迟：内容留在文档里，本来就平滑', /const bodyRef = useSearchableHidden\(!props\.open, revealGroup\)/.test(seats))
  check('焦点在里层、或被查找命中时的放行照旧（Ctrl+F 与键盘都不受影响）', seats.includes('element.contains(element.ownerDocument.activeElement)') && seats.includes("element.addEventListener('beforematch', reveal)"))

  // 阶段组那一级：收起态本来就是 max-height: 0（内容留文档里），补一条过渡即可。
  // 窗口从「400 字符」改成「整条规则内」（[^}]*）：2026-10-30 的栅格改造在规则头上加了
  // 缩进三件套，按字符距离找 transition 会假红。
  check('组体的一级开合也走过渡（两头都是 max-height 的确定值）', /\.step-body \{[^}]*transition: max-height var\(--dsc-dur-slow\) var\(--dsc-ease\);/.test(css))

  // 降级：base.css 那条全局 reduced-motion 把过渡压成瞬时
  check('系统说「少动」时全站过渡归零（base.css 兜底，不用逐组件再写）', /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}transition-duration: 0\.01ms !important/.test(read('ui-shell/src/legacy/base.css')))
  check('参考实现的做法在注释里留了档（dsh 只转箭头 / zcode 高度关键帧）', css.includes('dsh') && css.includes('zcode'))
}

console.log('[6] 悬停预览的收卡口径（0.6.69 第五轮报障：鼠标移出预览 1s 才收）')
{
  const ui = readPluginSource('ui-shell/src/plugins/transcript')
  const hook = read('ui-shell/src/ui-primitives/hover-delay.ts')

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
  const ui = readPluginSource('ui-shell/src/plugins/transcript')
  const timing = read('ui-shell/src/plugins/transcript/timing.ts')
  const css = read('ui-shell/src/legacy/views.css')
  // 「不该出现」的断言先剥注释：修法的注释里就引着旧写法 / roundInfos，不剥会自己打脸。
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  let seq = 0
  const e = (kind, extra = {}) => ({ kind, id: (seq += 1), ...extra })
  // 宿主 subagent 插件（src/plugins/subagent.ts:517）造出来的队友汇报正文形状。
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
  const buildSeatsBody = uiCode.slice(uiCode.indexOf('function buildSeats'), uiCode.indexOf('function buildSeats') + 600)
  check(
    "① buildSeats 走 splitRounds（不再自己按 kind==='user' 切座位）",
    buildSeatsBody.includes('const split = splitRounds(all)') && buildSeatsBody.includes('split.seats.map((seat) => ({ round: seat.round') && !buildSeatsBody.includes('roundInfos('),
  )
  check(
    "① timing.ts 转出 rounds.ts 的 roundInfos（旧的分轮循环已撤，不留第二份判据）",
    timing.includes("from './rounds'") && timing.includes('export { roundInfos, type RoundInfo }') && !timing.includes('current = {'),
  )

  // ── ② 两种 internal：回合中途并进本轮（steering）不增刻度；回合收尾出账（非 steering）增一枚 ──
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
  const mid = splitRounds(midSteer)
  const end = splitRounds(endInternal)
  check(
    '② 回合中途并进本轮的 internal（steering+internal）不增刻度：仍 1 轮 1 座位',
    mid.rounds.length === 1 && mid.seats.length === 1 && mid.seats[0].indices.length === 4,
    JSON.stringify(mid.seats),
  )
  check(
    '② 回合收尾出账的 internal（非 steering，宿主置了 pendingTurn）增一枚刻度：2 轮 2 座位',
    end.rounds.length === 2 && end.seats.length === 2 && end.rounds[1].startIndex === 2,
    JSON.stringify(end.rounds),
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
    '③ 对话里的触发行带队友名、保留 data-internal="1"（不再写死「子任务状态更新」）',
    /data-internal="1"[\s\S]{0,200}internalLabel\(entry\.text\)/.test(ui) &&
      !ui.includes('子任务状态更新') &&
      internalLabel(teammateBody).includes('队友 mate-1'),
  )
  check('③ 触发行样式落在 legacy/views.css（.entry-system[data-internal=\'1\']）', css.includes(".entry-system[data-internal='1']"))

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
    new URL('../ui-shell/src/plugins/transcript/tool-card/result-tail.ts', import.meta.url).href
  )
  const { resultTail, RESULT_TAIL_LINES } = tailMod
  const factory = read('ui-shell/src/plugins/transcript/tool-card/factory.tsx')
  const row = read('ui-shell/src/plugins/transcript/step-group-row.tsx')
  const css = read('ui-shell/src/styles.css')
  // 组体的缩进与竖线 2026-10-30 并进了 legacy/views.css（同一选择器原来分在两份样式表里）。
  const viewsCss = read('ui-shell/src/legacy/views.css')

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
  check('失败数也进开合提示（不点开就知道里面有没有坑）', row.includes('其中 ${String(props.group.failures)} 项失败'))
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

console.log('[9] 轮尾「已编辑 N 个文件」卡只在一轮收口之后出现')
{
  // 报障现场（2026-11-01）：一轮还在跑，转圈下面先挂出一份只算了一半的清单，
  // 点「审查」看到的是半截改动。判据只认 ChatView 给的 running（turnState + 最后一轮）。
  const renderSrc = read('ui-shell/src/plugins/transcript/render.tsx')
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
  const css = read('ui-shell/src/legacy/views.css')
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  check('光标规则已删（不再有 content 是方块字符的那条）', !code.includes('▍'))
  check('连带 blink 关键帧一起删（不留只被它用的死规则）', !/@keyframes\s+blink\s*\{/.test(code))
  check('也没留下空壳的 .live 规则（那条 position: relative 只为光标存在）', !/^\.live\s*\{/m.test(code))
  const think = read('ui-shell/src/plugins/transcript/rows/think-row.tsx')
  check('直播信号还在：思考行那颗转圈（.think-spin）', /\.think-spin \{/.test(code) && think.includes('think-spin'))
  check('删的理由与「别加回来」留在注释里', css.includes('流式直播尾光标：2026-11-02 删掉，别加回来'))
}

console.log('[11] 轮尾的复制 / 分叉：停下之后、鼠标压在输出上才现（2026-11-02 报障）')
{
  // 报障现场：这一轮还在输出，轮尾已经挂着「复制 / 分叉」——复制拿到半截回答、分叉分出
  // 半截会话；停下之后两颗钮又常驻，长会话里每轮后面都拖着一排按钮。
  // 两段判据：跑动中由组件不渲染（running），停下后由样式默认透明、悬浮输出才提到 1。
  const foot = read('ui-shell/src/plugins/transcript/rows/foot.tsx')
  const css = read('ui-shell/src/legacy/views.css')
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')

  check('跑动中不画复制（不再是「留着但没意义」）', /const copy = !props\.running && /.test(foot))
  check('跑动中不画分叉（不再是置灰占位）', /const fork = !props\.running && /.test(foot))
  check('分叉那颗不再挂 disabled（已经渲染不出来了，留着就是死属性）', !/disabled=\{props\.running\}/.test(foot))
  check(
    '默认透明是两颗钮一起（复制 .round-act / 分叉 .user-act 同一条规则）',
    /\.round-foot \.round-act,\s*\n\.round-foot \.user-act \{\s*\n\s*opacity: 0;/.test(code),
  )
  check(
    '悬浮这一轮的「非首块」才现（首块是用户自己的提问，压在上面不该弹）',
    /\.turn-seat > \*:not\(:first-child\):hover ~ \.round-foot \.round-act/.test(code),
  )
  check('压在页脚自己那一行上也现（按钮就在那行里，否则点不到）', /\.turn-seat > \.round-foot:hover \.round-act/.test(code))
  check('键盘焦点进这一轮也现（Tab 走得到两颗钮）', /\.turn-seat:focus-within > \.round-foot \.round-act/.test(code))
  check('用 opacity 不用 display/visibility（后者会让按钮不可聚焦）', !/\.round-foot \.round-act[^{]*\{[^}]*display: none/.test(code))
  check('系统说「少动」时淡入也关掉', /prefers-reduced-motion: reduce\) \{[\s\S]{0,200}\.round-foot \.round-act,[\s\S]{0,120}\.round-foot \.user-act \{\s*\n\s*transition: none;/.test(code))
}

console.log('[12] 机器投递的消息画成触发行，不是用户气泡（2026-11-02 报障：后台作业通知冒成气泡）')
{
  // 判据在宿主三处（落库 / 事件 / 重放），界面这一侧只认 `internal` 并给一句话标签。
  // 逐条断言的实测在 scripts/notice-origin-test.mjs（21 项）；这一节钉的是「界面没有绕开它」。
  const userRow = read('ui-shell/src/plugins/transcript/rows/user-row.tsx')
  const uiSrc = read('ui-shell/src/plugins/transcript/ui.tsx')
  const rounds = read('ui-shell/src/plugins/transcript/rounds.ts')
  const adapter = read('src/adapter/transcript.ts')
  const session = read('src/core/session.ts')
  const loop = read('src/core/loop.ts')
  const llm = read('src/core/llm.ts')

  check('内部行按类型给标签（不再一律说「子任务汇报」）', userRow.includes('{internalLabel(entry.text)}'))
  check('刻度条悬停卡与触发行共用同一句', uiSrc.includes("? internalLabel(user.text)"))
  check('标签函数认得队友汇报 / 后台作业 / 其它三种', ['teammateReportLabel(text)', '后台作业', "'运行时通知'"].every((piece) => rounds.includes(piece)))
  check('适配器：前缀命中 **或** origin === notice', /event\.origin === 'notice'/.test(adapter) && adapter.includes('startsWith(TEAMMATE_REPORT_OPEN)'))
  check('落库：机器投递才写 origin（人打的字不写）', /appendUser\([^)]*origin: InboxOrigin = 'user'/.test(session) && /origin === 'notice' \? \{ origin \}/.test(session))
  check('出账两条路都把来源带上（空闲直落 + 收件箱出账）', (loop.match(/appendUser\([^)]*origin\)/g) ?? []).length === 2)
  check('重放认得 origin（否则重开旧会话又变气泡）', /message\.origin === 'notice' \? \{ origin: message\.origin \}/.test(adapter))
  check('请求侧把 origin 剥掉（协议里没这一项）', /delete wire\.origin/.test(llm))
}

console.log('[13] 已发送消息里的贴图也开浮层（可编辑行 + 只读出口，同一套）')
{
  const userRow = read('ui-shell/src/plugins/transcript/rows/user-row.tsx')
  const css = read('ui-shell/src/styles.css')
  const viewsCss = read('ui-shell/src/legacy/views.css')

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
