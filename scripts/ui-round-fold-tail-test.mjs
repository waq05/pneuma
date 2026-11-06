/**
 * 整轮折叠的「藏哪些行」探针（2026-11-06 报障的缺陷一；同日改成下标集合）。
 *
 * 报障现场：总开关「用时 36 秒」箭头朝下（收起态），下面却还挂着 4 条思考行和一条
 * 「进行中」的命令行。根因在 `round-fold.tsx` 的 `buildRoundFolds`：它把**这一轮最后一条
 * 定稿正文**当最终回答，折叠区间停在它之前；正文之后的过程行于是掉在区间外面，永远不藏。
 *
 * 修后的口径（2026-11-06 第二版，foldedReplies 落地）：
 *   - 过程范围照旧由 startIndex / endIndex 报出来（终点取「这一轮最后一个过程条目」）；
 *   - **藏不藏**改看 `fold.hidden` 这个下标集合：
 *       · foldedReplies='final'：范围里除了独立条目（计划卡 / system / 轮尾）全藏；
 *       · foldedReplies='all'：范围内的正文**不进集合**（有正文的助手步骤留在屏幕上），
 *         思考与工具照旧藏——于是集合被正文切成几段，正是「中间留几段话在外面」；
 *   - 这一轮最后一条正文始终在范围之外（endLimit 的规则），一个字都不藏。
 *
 * 怎么跑 `round-fold.tsx`：`buildRoundFolds` 是纯计算，Node 能直接跑；但那个文件是 .tsx
 * （Node 的类型剥离不认 JSX），且它从 `@dsc/ui` 取一个图标。所以这里做两件事——
 * 用仓库自带的 typescript 在 load 钩子里现转一次 JSX（跑的是同一份源码，不是复制品），
 * 并把 `@dsc/ui` 指到一个只转出取词器、图标给空实现的桩（见 `_ui-probe-stub.mjs`）。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-round-fold-tail-test.mjs
 *
 * @module dsc/scripts/ui-round-fold-tail-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const STUB = new URL('./_ui-probe-stub.mjs', import.meta.url).href
const ROUND_FOLD = new URL('../src/packages/ui-transcript/ui/round-fold.tsx', import.meta.url).href

registerHooks({
  /** `@dsc/ui` 让给探针桩：取词器照旧是产品实现，图标给空组件（这里只调纯函数）。 */
  resolve(specifier, context, next) {
    if (specifier === '@dsc/ui' || specifier === '@dsc/ui-primitives') return { url: STUB, shortCircuit: true }
    // 源码里写的是 vite 能解析的免扩展名相对路径（'./timing'、'./fold-state'）：
    // Node 的解析器不补 .ts，这里按同样的顺序补一次。
    if (specifier.startsWith('.') && !/\.[a-z0-9]+$/i.test(specifier) && typeof context.parentURL === 'string') {
      for (const ext of ['.ts', '.tsx', '.json']) {
        const candidate = new URL(specifier + ext, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
      }
    }
    return next(specifier, context)
  },
  /** 只有这一个 .tsx 需要现转：转出来的模块 URL 不变，里面的相对 import 照常解析。 */
  load(url, context, next) {
    if (url !== ROUND_FOLD) return next(url, context)
    const fileName = fileURLToPath(url)
    const out = ts.transpileModule(readFileSync(fileName, 'utf8'), {
      fileName,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    })
    return { format: 'module', source: out.outputText, shortCircuit: true }
  },
})

const { buildRoundFolds, turnDefaultOpen } = await import(ROUND_FOLD)

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log('  ok  ' + name)
  } else {
    failures += 1
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  <- ' + detail))
  }
}
/** 集合按下标升序打印/比对：Set 的插入顺序在这里等价于升序，但断言不该依赖它。 */
const sorted = (set) => [...set].sort((left, right) => left - right)
const listOf = (set) => JSON.stringify(sorted(set))

/** 造一条条目：id 给正数（定稿），过程行用 kind 区分。 */
let seq = 0
const entry = (kind, extra = {}) => ({ kind, id: (seq += 1), ...extra })
const text = (body) => entry('text', { text: body })
const think = (body) => entry('thinking', { text: body })
const tool = (name, status) => entry('tool', { call: { callId: 'c' + seq, name, argsText: '{"command":"pnpm build"}', status } })
/** 一轮：从 0 开始，到 entries.length - 1 结束（这些用例都只有一轮）。 */
const oneRound = (entries) => [{ index: 0, startIndex: 0, endIndex: entries.length - 1, startTs: 1, endTs: 2, answered: true }]
/** 跑一次预算器，取第 0 轮（默认 foldedReplies=all；要 final 就显式传）。 */
const foldOf = (entries, options = {}) =>
  buildRoundFolds(entries, oneRound(entries), { foldTurns: true, live: false, lastRoundIndex: 0, ...options }).get(0)

console.log('[1] 正文 → 4 条思考 → 1 条 running 工具（报障现场）')
{
  const entries = [
    entry('user', { text: '帮我改一下折叠' }),
    text('先说改法：过程整组收起，只留一行总开关。'),
    think('思考一：先看区间是怎么算的。'),
    think('思考二：终点取的是最后一条正文。'),
    think('思考三：正文之后的工具就漏在外面了。'),
    think('思考四：改成取最后一个过程条目。'),
    tool('bash', 'running'),
  ]
  const runningAt = entries.length - 1
  const final = foldOf(entries, { foldedReplies: 'final' })
  check('过程范围算得出来（hasContent 由隐藏集合决定）', final.hasContent === true)
  check(
    '范围终点 = 那条 running 工具的下标（正文之后的过程行不再漏在外面）',
    final.endIndex === runningAt,
    'endIndex=' + String(final.endIndex) + ' 期望 ' + String(runningAt),
  )
  check('final：running 工具在隐藏集合里', final.hidden.has(runningAt), listOf(final.hidden))
  check(
    'final：那条阶段性正文也在集合里（它后面还有过程，跟着一起收起）',
    final.hidden.has(1),
    listOf(final.hidden),
  )
  check('final：集合 = 范围里除用户消息外的每一条', listOf(final.hidden) === JSON.stringify([1, 2, 3, 4, 5, 6]), listOf(final.hidden))
  check('用户消息永远不在集合里', !final.hidden.has(0))
  check('整轮可折（没有 interrupted / error 标记）', final.foldable === true && final.running === false && final.blocked === false)

  // 同一份内容换成 all：正文留在外面，思考与工具照旧藏。
  const all = foldOf(entries, { foldedReplies: 'all' })
  check('all：那条阶段性正文不进集合（有正文的助手步骤不算过程）', !all.hidden.has(1), listOf(all.hidden))
  check('all：思考与工具仍在集合里', [2, 3, 4, 5, 6].every((at) => all.hidden.has(at)), listOf(all.hidden))
  check('all：范围读数不变（startIndex / endIndex 还是过程区那一段）', all.startIndex === 1 && all.endIndex === runningAt, JSON.stringify({ start: all.startIndex, end: all.endIndex }))
  check('all 与 final 的隐藏集合确实不同（这条档位真的有效）', listOf(all.hidden) !== listOf(final.hidden))
}

console.log('[2] 过程 → 正文结尾（最终回答不许被藏）')
{
  const entries = [entry('user', { text: '问一句' }), think('先想一下。'), tool('read', 'done'), text('最终回答：计划卡不折叠。')]
  const answerAt = entries.length - 1
  const final = foldOf(entries, { foldedReplies: 'final' })
  check('范围终点停在最后一条过程条目上', final.endIndex === answerAt - 1, String(final.endIndex))
  check('最终正文不在隐藏集合里', !final.hidden.has(answerAt), listOf(final.hidden))
  check('final：集合 = 那两条过程行', listOf(final.hidden) === JSON.stringify([1, 2]), listOf(final.hidden))
  const all = foldOf(entries, { foldedReplies: 'all' })
  check('all：这一轮本来就没夹正文，集合与 final 相同', listOf(all.hidden) === listOf(final.hidden), listOf(all.hidden))
}

console.log('[3] 同一轮里夹了两段正文 + 一条正文后面紧跟工具调用')
{
  // 一轮 [user, thinking, text1, text2]：text2 是最后一条正文，text1 是阶段性正文。
  const entries = [entry('user', { text: '问' }), think('想'), text('阶段交代'), text('最终回答')]
  const final = foldOf(entries, { foldedReplies: 'final' })
  check('final：终点仍是最终回答之前那一条', final.endIndex === 2, String(final.endIndex))
  check('final：阶段性正文被藏、最终回答不藏', final.hidden.has(2) && !final.hidden.has(3), listOf(final.hidden))
  const all = foldOf(entries, { foldedReplies: 'all' })
  check('all：阶段性正文留在屏幕上', !all.hidden.has(2), listOf(all.hidden))
  check('all：思考照旧藏', all.hidden.has(1), listOf(all.hidden))

  // 整轮只有一条正文、没有任何过程行：all 档没什么可藏，开关画成不可点。
  const onlyText = [entry('user', { text: '问' }), text('答')]
  const emptyAll = foldOf(onlyText, { foldedReplies: 'all' })
  check('all：只有正文时隐藏集合为空、hasContent 为假', emptyAll.hidden.size === 0 && emptyAll.hasContent === false, JSON.stringify({ hidden: listOf(emptyAll.hidden), hasContent: emptyAll.hasContent }))
  const emptyFinal = foldOf(onlyText, { foldedReplies: 'final' })
  // 一条正文的轮里，它就是最终回答（endLimit 停在它之前），所以两档都没得藏——旧行为不变。
  check('final：只有正文时同样没什么可藏（那一句就是最终回答）', emptyFinal.hidden.size === 0 && emptyFinal.hasContent === false, listOf(emptyFinal.hidden))

  // 整轮没有正文（问答中途中断）：整轮都是过程，终点就是最后一条。
  const noAnswer = [entry('user', { text: '问' }), think('想'), tool('read', 'running'), think('再想')]
  const tail = foldOf(noAnswer, { foldedReplies: 'all' })
  check('没有定稿正文时整轮都是过程（终点 = 轮末）', tail.startIndex === 1 && tail.endIndex === 3, JSON.stringify({ start: tail.startIndex, end: tail.endIndex }))
  check('没有定稿正文时 all 档也全藏', listOf(tail.hidden) === JSON.stringify([1, 2, 3]), listOf(tail.hidden))
}

console.log('[4] 正文把隐藏集合切成两段（all 档的结构性变化）')
{
  const entries = [
    entry('user', { text: '跑一圈' }),
    tool('read', 'done'),
    text('先读到了配置，里面的日志级别是 info。'),
    tool('bash', 'done'),
  ]
  const all = foldOf(entries, { foldedReplies: 'all' })
  check('all：两条工具在集合里、中间那句正文不在', all.hidden.has(1) && !all.hidden.has(2) && all.hidden.has(3), listOf(all.hidden))
  check('all：集合不是一段连续区间（这正是区间模型表达不了的那种形状）', sorted(all.hidden).join(',') !== '1,2,3', listOf(all.hidden))
  const final = foldOf(entries, { foldedReplies: 'final' })
  check('final：同一轮全藏（正文跟着过程一起消失）', listOf(final.hidden) === JSON.stringify([1, 2, 3]), listOf(final.hidden))
  check('两档的 endIndex 一致（范围读数与档位无关）', all.endIndex === final.endIndex && all.startIndex === final.startIndex)
}

console.log('[5] 多轮互不干扰 + 最新一轮的默认展开（collapseTiming）')
{
  const entries = [
    entry('user', { text: '第一问' }),
    think('一想'),
    tool('read', 'done'),
    text('第一答'),
    entry('user', { text: '第二问' }),
    text('第二答的一半'),
    think('二想'),
    tool('bash', 'running'),
  ]
  const rounds = [
    { index: 0, startIndex: 0, endIndex: 3, startTs: 1, endTs: 2, answered: true },
    { index: 1, startIndex: 4, endIndex: 7, startTs: 3, endTs: 4, answered: true },
  ]
  const folds = buildRoundFolds(entries, rounds, { foldTurns: true, live: false, lastRoundIndex: 1, foldedReplies: 'final' })
  const first = folds.get(0)
  const second = folds.get(1)
  check('第 1 轮：最终正文结尾，集合只含两条过程行', listOf(first.hidden) === JSON.stringify([1, 2]), listOf(first.hidden))
  check('第 2 轮：正文之后还有过程，集合到 running 工具', listOf(second.hidden) === JSON.stringify([5, 6, 7]), listOf(second.hidden))
  check('两轮的集合不越界到对方', [...first.hidden].every((at) => at < 4) && [...second.hidden].every((at) => at > 3))
  check('只有最后一轮带 latest 标记', first.latest === false && second.latest === true)
  check('completion：两轮的默认态都是收起', turnDefaultOpen('completion', first.latest) === false && turnDefaultOpen('completion', second.latest) === false)
  check('next-input：最新一轮默认展开、其余照旧收起', turnDefaultOpen('next-input', second.latest) === true && turnDefaultOpen('next-input', first.latest) === false)
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
if (failures !== 0) process.exitCode = 1
