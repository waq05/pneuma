/**
 * 整轮折叠的「区间终点」探针（2026-11-06 报障的缺陷一）。
 *
 * 报障现场：总开关「用时 36 秒」箭头朝下（收起态），下面却还挂着 4 条思考行和一条
 * 「进行中」的命令行。根因在 `round-fold.tsx` 的 `buildRoundFolds`：它把**这一轮最后一条
 * 定稿正文**当最终回答，折叠区间停在它之前；正文之后的过程行于是掉在区间外面，永远不藏。
 *
 * 修后的口径：区间终点取「这一轮最后一个过程条目（thinking / tool）」。
 *   - 正文之后还有过程行 ⇒ 那条正文只是过程中的一句交代，终点取最后那条过程行，
 *     中间夹着的阶段性正文跟着整轮一起收起；
 *   - 正文之后没有任何过程行 ⇒ 与旧口径**逐字相同**：终点停在最后那条正文之前，正文不被藏。
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

const { buildRoundFolds } = await import(ROUND_FOLD)

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

/** 造一条条目：id 给正数（定稿），过程行用 kind 区分。 */
let seq = 0
const entry = (kind, extra = {}) => ({ kind, id: (seq += 1), ...extra })
const text = (body) => entry('text', { text: body })
const think = (body) => entry('thinking', { text: body })
const tool = (name, status) => entry('tool', { call: { callId: 'c' + seq, name, argsText: '{"command":"pnpm build"}', status } })
/** 一轮：从 0 开始，到 entries.length - 1 结束（这些用例都只有一轮）。 */
const oneRound = (entries) => [{ index: 0, startIndex: 0, endIndex: entries.length - 1, startTs: 1, endTs: 2, answered: true }]
/** 跑一次预算器，取第 0 轮。 */
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
  const fold = foldOf(entries)
  const runningAt = entries.length - 1
  check('这一轮算得出过程区', fold.hasContent === true)
  check(
    '区间终点 = 那条 running 工具的下标（正文之后的过程行不再漏在区间外）',
    fold.endIndex === runningAt,
    'endIndex=' + String(fold.endIndex) + ' 期望 ' + String(runningAt),
  )
  check(
    '区间覆盖到 running 工具（inProcessOf 判据：start <= at <= end）',
    fold.startIndex <= runningAt && runningAt <= fold.endIndex,
    JSON.stringify({ start: fold.startIndex, end: fold.endIndex }),
  )
  check('区间从那条阶段性正文起（它的后面还有过程，所以算过程）', fold.startIndex === 1, String(fold.startIndex))
  check('整轮可折（没有 interrupted / error 标记）', fold.foldable === true && fold.running === false && fold.blocked === false)
}

console.log('[2] 过程 → 正文结尾（最终回答不许被藏）')
{
  const entries = [
    entry('user', { text: '问一句' }),
    think('先想一下。'),
    tool('read', 'done'),
    text('最终回答：计划卡不折叠。'),
  ]
  const fold = foldOf(entries)
  const answerAt = entries.length - 1
  check('区间终点停在最后一条过程条目上', fold.endIndex === answerAt - 1, String(fold.endIndex))
  check(
    '最终正文不在区间里（at > endIndex）',
    fold.endIndex < answerAt,
    JSON.stringify({ start: fold.startIndex, end: fold.endIndex, answer: answerAt }),
  )
  check('区间起点是第一条过程条目', fold.startIndex === 1, String(fold.startIndex))
}

console.log('[3] 与旧口径逐字一致：正文之后没有任何过程行')
{
  // 一轮 [user, thinking, text1, text2]：最后一条正文是 text2，text1 是阶段性正文。
  const entries = [entry('user', { text: '问' }), think('想'), text('阶段交代'), text('最终回答')]
  const fold = foldOf(entries)
  check('终点仍是最终回答之前那一条', fold.endIndex === 2, String(fold.endIndex))
  check('最终回答（下标 3）不在区间里', fold.endIndex < 3)

  // 整轮只有一条正文：没有过程内容，开关不可点（旧行为）。
  const onlyText = [entry('user', { text: '问' }), text('答')]
  const empty = foldOf(onlyText)
  check('没有过程行时区间为空、hasContent 为假', empty.hasContent === false && empty.startIndex === -1 && empty.endIndex === -1, JSON.stringify(empty))

  // 整轮没有正文（问答中途中断）：整轮都是过程，终点就是最后一条。
  const noAnswer = [entry('user', { text: '问' }), think('想'), tool('read', 'running'), think('再想')]
  const tail = foldOf(noAnswer)
  check('没有定稿正文时整轮都是过程（终点 = 轮末）', tail.startIndex === 1 && tail.endIndex === 3, JSON.stringify({ start: tail.startIndex, end: tail.endIndex }))
}

console.log('[4] 多轮互不干扰')
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
  const folds = buildRoundFolds(entries, [
    { index: 0, startIndex: 0, endIndex: 3, startTs: 1, endTs: 2, answered: true },
    { index: 1, startIndex: 4, endIndex: 7, startTs: 3, endTs: 4, answered: true },
  ], { foldTurns: true, live: false, lastRoundIndex: 1 })
  const first = folds.get(0)
  const second = folds.get(1)
  check('第 1 轮：正文结尾、区间不含正文', first.startIndex === 1 && first.endIndex === 2, JSON.stringify(first))
  check('第 2 轮：正文之后还有过程，区间到 running 工具', second.startIndex === 5 && second.endIndex === 7, JSON.stringify(second))
  check('两轮的区间不越界到对方', first.endIndex < 4 && second.startIndex > 3)
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
if (failures !== 0) process.exitCode = 1
