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
 *   [7] 分轮口径单点 + internal 条目对齐 dsh（右侧刻度条 `.jump-rail` 错位 / 多刻度报障）：
 *       座位切分与轮元信息同源（rounds.ts 的 `splitRounds`）、steering 不另起一轮、
 *       回合中途并进的 internal 不增刻度而回合收尾的增一枚、internal 题面预览不出现原文
 *
 * 运行：node scripts/ui-transcript-render-test.mjs
 *
 * @module dsc/scripts/ui-transcript-render-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const groups = await import(
  new URL('../ui-shell/src/plugins/transcript/process-groups.ts', import.meta.url).href
)
const args = await import(new URL('../ui-shell/src/ui-primitives/tool-args.ts', import.meta.url).href)
const { seatPlan, groupSteps } = groups
const { toolArgFields, MUTATION_CONTENT_FIELDS } = args
const roundsMod = await import(
  new URL('../ui-shell/src/plugins/transcript/rounds.ts', import.meta.url).href
)
const { splitRounds, roundInfos, teammateReportLabel } = roundsMod

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
  // 一轮：[user, thinking, tool, text, thinking, tool]——两个组各 2 员，正文把两组切开
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
  check('两组各两员', grouping.groups.every((group) => group.size === 2))

  const ats = entries.map((_, index) => index).slice(1)
  const items = seatPlan(ats, grouping)
  const seen = []
  for (const item of items) {
    if (item.kind === 'group') seen.push(...item.members)
    else seen.push(item.at)
  }
  check('每条行恰好出现一次（0.6.67 的重复就是这么来的）', seen.length === ats.length && new Set(seen).size === ats.length, JSON.stringify(seen))
  check('顺序与出现顺序一致', JSON.stringify(seen) === JSON.stringify([...seen].sort((a, b) => a - b)))
  check('两个组块（正文那条单独出）', items.filter((item) => item.kind === 'group').length === 2 && items.filter((item) => item.kind === 'row').length === 1)
  check('组员绝不出现在 row 项里（组体铺过就不再单独铺）', items.filter((item) => item.kind === 'row').every((item) => !grouping.at.has(item.at)))
  check('组块带全成员（升序）', items.filter((item) => item.kind === 'group').every((item) => JSON.stringify(item.members) === JSON.stringify([...item.members].sort((a, b) => a - b))))
  check('空表进空表出', seatPlan([], grouping).length === 0)
  // detailed 档的「运行中那一轮」：settledOnly 跳过它，于是一组都不成——全出 row 项
  const running = groupSteps(entries, rounds, () => true, true)
  check('没有分组的轮（detailed 档的运行中轮）全出 row 项', running.groups.length === 0 && seatPlan(ats, running).every((item) => item.kind === 'row'))
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
  const ui = read('ui-shell/src/plugins/transcript/ui.tsx')
  const factory = read('ui-shell/src/plugins/transcript/tool-card/factory.tsx')
  const pgs = read('ui-shell/src/plugins/transcript/process-groups.ts')
  const status = read('ui-shell/src/plugins/status/ui.tsx')

  check('ui.tsx 的排布走纯函数 seatPlan（规则不在渲染体里）', ui.includes('for (const item of seatPlan(') && ui.includes("import { groupSteps, seatPlan,"))
  check('process-groups.ts 的 seatPlan 是纯逻辑（不引 React）', !/from 'react'/.test(pgs) && pgs.includes('export function seatPlan('))

  // 「不该出现」的断言先剥注释：修法自己的注释里就引着旧写法，不剥会自己打脸。
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  check('③ 直播尾不再强制展开（readFold 的默认值只有用户的档位）', uiCode.includes('readFold(storeKey, prefs.reasoningOpen)') && !uiCode.includes('readFold(storeKey, live ||'))
  check('③ 直播的「还活着」由扫光/摘要/小圈承载（三样都在）', ui.includes('data-shimmer={live ? summary : undefined}') && ui.includes('think-status') && ui.includes('think-sr'))

  check('④ 展开体按「有没有 diff」分流参数', factory.includes('const paramsAsFields = patch !== null && argView.mutating'))
  check('④ 会改文件的工具渲染字段表（.arg-fields）', factory.includes('className="args arg-fields"') && factory.includes('argView.fields.map('))
  check('④ 没有 diff 时仍摊原始 JSON（不丢信息）', factory.includes('<div className="args">{prettyJson(call.argsText)}</div>'))
  check('④ 落地后的 diff 由 bodyExtra 的 fallback 接手（轨迹页也看得到）', factory.includes("useFactorySlot('bodyExtra', IntendedBody)") && factory.includes("data-tc-change=\"\""))

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
  const ui = read('ui-shell/src/plugins/transcript/ui.tsx')
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

  // 阶段组那一级：收起态本来就是 max-height: 0（内容留文档里），补一条过渡即可
  check('组体的一级开合也走过渡（两头都是 max-height 的确定值）', /\.step-body \{[\s\S]{0,400}transition: max-height var\(--dsc-dur-slow\) var\(--dsc-ease\);/.test(css))

  // 降级：base.css 那条全局 reduced-motion 把过渡压成瞬时
  check('系统说「少动」时全站过渡归零（base.css 兜底，不用逐组件再写）', /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,300}transition-duration: 0\.01ms !important/.test(read('ui-shell/src/legacy/base.css')))
  check('参考实现的做法在注释里留了档（dsh 只转箭头 / zcode 高度关键帧）', css.includes('dsh') && css.includes('zcode'))
}

console.log('[6] 悬停预览的收卡口径（0.6.69 第五轮报障：鼠标移出预览 1s 才收）')
{
  const ui = read('ui-shell/src/plugins/transcript/ui.tsx')
  const hook = read('ui-shell/src/ui-primitives/hover-delay.ts')
  const legacy = read('desktop/src/renderer/hover-delay.ts')

  // 出卡节奏照参考实现（500ms），收卡是壳侧有意的 1s——旧渲染层那份仍 100ms（冻结不动）
  check('出卡仍是 500ms', hook.includes('const HOVER_DELAY_MS = 500'))
  check('收卡是 1s', hook.includes('const HOVER_CLOSE_MS = 1000'))
  check('旧渲染层那份不动（还是 100ms，改的只在壳侧）', legacy.includes('const HOVER_CLOSE_MS = 100'))
  check('为什么分道写在注释里（不然下次有人「对齐」回去）', hook.includes('为什么收卡不是参考实现的 100ms'))

  // 卡片自己要有离开事件：只挂 onMouseEnter 会让卡永远粘住（行上的 mouseleave 早烧掉了）
  check('预览卡挂着 onMouseEnter（keep）+ onMouseLeave（disarm）', /className="hover-preview"[\s\S]{0,140}onMouseEnter=\{onKeep\}[\s\S]{0,60}onMouseLeave=\{onLeave\}/.test(ui))
  check('卡片收 onLeave 这个 prop', /onLeave: \(\) => void/.test(ui) && ui.includes('onLeave={hoverDelay.disarm}'))
  check('disarm 就是「起收卡倒计时」那一条（行上移开与出卡共用同一条）', hook.includes('closeRef.current = window.setTimeout(() => setHover(null), HOVER_CLOSE_MS)'))
  check('卡会粘住这件事在注释里留了档', ui.includes('永远粘住'))
}

console.log('[7] 分轮口径单点 + internal 条目对齐 dsh（0.6.67 右侧刻度条错位 / 多刻度）')
{
  const ui = read('ui-shell/src/plugins/transcript/ui.tsx')
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
  check(
    "① buildSeats 走 splitRounds（不再自己按 kind==='user' 切座位）",
    uiCode.includes('const split = splitRounds(all)') && uiCode.includes('split.seats.map((seat) => ({ round: seat.round') && !uiCode.includes('roundInfos('),
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
    /user\.internal === true\s*\?\s*teammateReportLabel\(user\.text\)/.test(ui),
  )
  check(
    '③ 对话里的触发行带队友名、保留 data-internal="1"（不再写死「子任务状态更新」）',
    /data-internal="1"[\s\S]{0,200}teammateReportLabel\(entry\.text\)/.test(ui) && !ui.includes('子任务状态更新'),
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

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
