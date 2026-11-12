/**
 * 两个新设置项的**组合矩阵**探针（2026-11-06）：四档过程折叠 × 两种 foldedReplies ×
 * 两种 collapseTiming = 16 格，逐格断言「藏了哪些下标」与「哪一轮默认展开」。
 *
 * 口径（改动落在 `src/packages/ui-transcript/ui/round-fold.tsx`）：
 *   - `foldedReplies` 决定**正文算不算过程**：all 档里范围内的正文不进 `fold.hidden`，
 *     留在屏幕上；final 档里它跟着思考与工具一起藏。这一轮最后一条正文始终在范围之外。
 *   - `collapseTiming` 决定**最新一轮的默认展开态**：next-input 下它默认摊着，其余照旧收起
 *     （`turnDefaultOpen`；参考 dsh 的 turnProcessOpen，见 ChatNodeSeat.tsx:61-72）。
 *   - 四档只影响「整轮折不折」：verbose 档 foldTurns=false，于是它不画总开关、也不藏任何行
 *     （渲染体 `render.tsx` 的 inFold 先看 foldable）；其余三档的隐藏集合完全相同。
 *
 * 这里跑的是产品源码里的纯函数（`buildRoundFolds` / `processFoldPolicy` /
 * `turnDefaultOpen`），不是复制一份规则；只有「渲染层怎么用这两个返回值」那两行用源码钉。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-fold-combo-test.mjs
 *
 * @module dsc/scripts/ui-fold-combo-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const STUB = new URL('./_ui-probe-stub.mjs', import.meta.url).href
const ROUND_FOLD = new URL('../src/packages/ui-transcript/ui/round-fold.tsx', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@dsc/ui' || specifier === '@dsc/ui-primitives') return { url: STUB, shortCircuit: true }
    if (specifier.startsWith('.') && !/\.[a-z0-9]+$/i.test(specifier) && typeof context.parentURL === 'string') {
      for (const ext of ['.ts', '.tsx', '.json']) {
        const candidate = new URL(specifier + ext, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url !== ROUND_FOLD) return next(url, context)
    const fileName = fileURLToPath(url)
    const out = ts.transpileModule(readFileSync(fileName, 'utf8'), {
      fileName,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    })
    return { format: 'module', source: out.outputText, shortCircuit: true }
  },
})

const { buildRoundFolds, processFoldPolicy, turnDefaultOpen } = await import(ROUND_FOLD)

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
const sorted = (set) => [...set].sort((left, right) => left - right)
const listOf = (set) => JSON.stringify(sorted(set))

/** 造条目的工具（与别的探针同一套形状：kind + 正 id，工具带 call）。 */
let seq = 0
const entry = (kind, extra = {}) => ({ kind, id: (seq += 1), ...extra })
const text = (body) => entry('text', { text: body })
const think = (body) => entry('thinking', { text: body })
const tool = (name) => entry('tool', { call: { callId: 'c' + seq, name, argsText: '{"path":"a.ts"}', status: 'done' } })

/**
 * 两轮的样张（两个档位都要用同一份，才好逐格对比）：
 *   第 1 轮：题面 → 阶段性正文 → 思考 → 工具 → 最终回答；
 *   第 2 轮：题面 → 思考 → 工具（没有正文）。
 */
const entries = [
  entry('user', { text: '第一问' }),
  text('先读了一遍配置，日志级别是 info。'),
  think('想一想怎么改。'),
  tool('read'),
  text('改好了。'),
  entry('user', { text: '第二问' }),
  think('再想一下。'),
  tool('bash'),
]
const rounds = [
  { index: 0, startIndex: 0, endIndex: 4, startTs: 1, endTs: 2, answered: true },
  { index: 1, startIndex: 5, endIndex: 7, startTs: 3, endTs: 4, answered: true },
]
const LAST = rounds.length - 1

/** 一档一档跑：返回两轮的「渲染层实际会藏的下标」与默认展开态。 */
const runCombo = (fold, foldedReplies, collapseTiming) => {
  const folds = buildRoundFolds(entries, rounds, { foldTurns: processFoldPolicy(fold).foldTurns, live: false, lastRoundIndex: LAST, foldedReplies })
  const rowOf = (roundIndex) => {
    const value = folds.get(roundIndex)
    // 渲染体 inFold 的口径：这一档允许整轮折叠（foldable）才藏；verbose 档一个都不藏。
    return {
      hidden: value.foldable ? sorted(value.hidden) : [],
      raw: listOf(value.hidden),
      hasContent: value.hasContent,
      foldable: value.foldable,
      latest: value.latest,
      defaultOpen: turnDefaultOpen(collapseTiming, value.latest),
      // 总开关行画不画（render.tsx 的 showFoldRow：可折的档位 + 已经收尾的轮）。
      row: value.foldable,
    }
  }
  return { first: rowOf(0), second: rowOf(1) }
}

console.log('[1] 16 格矩阵：foldedReplies 只管正文，四档只管折不折')
{
  const folds = ['compact', 'standard', 'detailed', 'verbose']
  const replies = ['all', 'final']
  const timings = ['completion', 'next-input']
  /** 期望：all 档范围内正文不进集合，final 档进；两份样张的静态范围与这些下标无关。 */
  const expectedHidden = {
    all: { first: [2, 3], second: [6, 7] },
    final: { first: [1, 2, 3], second: [6, 7] },
  }
  let cells = 0
  for (const fold of folds) {
    for (const foldedReplies of replies) {
      for (const collapseTiming of timings) {
        cells += 1
        const label = fold + '/' + foldedReplies + '/' + collapseTiming
        const got = runCombo(fold, foldedReplies, collapseTiming)
        const foldable = processFoldPolicy(fold).foldTurns
        // 隐藏集合：只有 verbose 档是空的（它不折整轮），其余三档按 foldedReplies 走。
        const wantFirst = foldable ? expectedHidden[foldedReplies].first : []
        const wantSecond = foldable ? expectedHidden[foldedReplies].second : []
        check(label + ' · 第 1 轮藏的下标', JSON.stringify(got.first.hidden) === JSON.stringify(wantFirst), JSON.stringify(got.first.hidden) + ' 期望 ' + JSON.stringify(wantFirst))
        check(label + ' · 第 2 轮藏的下标', JSON.stringify(got.second.hidden) === JSON.stringify(wantSecond), JSON.stringify(got.second.hidden) + ' 期望 ' + JSON.stringify(wantSecond))
        // 默认展开：只有「最新一轮 + next-input」为真。verbose 档不画总开关、整轮摊着，
        // 这个兜底值用不上，但纯函数照样按时机算（口径单一，渲染层才不用再分一份）。
        check(label + ' · 第 2 轮默认展开', got.second.defaultOpen === (collapseTiming === 'next-input'), JSON.stringify(got.second.defaultOpen))
        check(label + ' · 第 1 轮不会默认展开', got.first.defaultOpen === false, JSON.stringify(got.first.defaultOpen))
        // 总开关行：可折的档位才画；最终回答（第 1 轮下标 4）永远不在集合里。
        check(label + ' · 总开关行按档位画', got.first.row === foldable && got.second.row === foldable, JSON.stringify({ first: got.first.row, second: got.second.row }))
        check(label + ' · 最终回答不进隐藏集合', !got.first.hidden.includes(4), JSON.stringify(got.first.hidden))
      }
    }
  }
  check('矩阵跑满 16 格', cells === 16, String(cells))
}

console.log('[2] 跨格对比：两个设置项各自改变了自己该改变的那一格')
{
  // 同一档、同一时机，只换 foldedReplies：藏的下标必须变（正文那一格）。
  const allStandard = runCombo('standard', 'all', 'completion')
  const finalStandard = runCombo('standard', 'final', 'completion')
  check('all → final：第 1 轮多藏了那句阶段性正文（下标 1）', !allStandard.first.hidden.includes(1) && finalStandard.first.hidden.includes(1), JSON.stringify({ all: allStandard.first.hidden, final: finalStandard.first.hidden }))
  check('两个档位藏的行数正好差 1（只影响正文，不影响思考与工具）', finalStandard.first.hidden.length === allStandard.first.hidden.length + 1, JSON.stringify({ all: allStandard.first.hidden.length, final: finalStandard.first.hidden.length }))
  check('第 2 轮没有正文，两档的集合完全相同', JSON.stringify(allStandard.second.hidden) === JSON.stringify(finalStandard.second.hidden))

  // 同一档、同一回复档位，只换 collapseTiming：藏的下标一个都不变，只有默认展开态变。
  const completion = runCombo('detailed', 'all', 'completion')
  const nextInput = runCombo('detailed', 'all', 'next-input')
  check('completion → next-input：藏的下标一个没变', JSON.stringify(completion.first.hidden) === JSON.stringify(nextInput.first.hidden) && JSON.stringify(completion.second.hidden) === JSON.stringify(nextInput.second.hidden))
  check('completion → next-input：最新一轮从收起翻成展开', completion.second.defaultOpen === false && nextInput.second.defaultOpen === true)
  check('历史轮两种时机都收起（它不再是最后一轮）', completion.first.defaultOpen === false && nextInput.first.defaultOpen === false)
}

console.log('[3] 源码钉：渲染层确实按这两个返回值走')
{
  const render = readFileSync(new URL('../src/packages/ui-transcript/ui/render.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  check('藏不藏查集合（不再按 startIndex..endIndex 区间判）', /const inFold = \(row: Row\): boolean =>\s*\n\s*fold !== undefined && fold\.foldable && fold\.hidden\.has\(row\.at\)/.test(render))
  check('默认展开来自 turnDefaultOpen(collapseTiming, latest)', /turnDefaultOpen\(foldPrefs\.collapseTiming, fold\?\.latest === true\)/.test(render))
  check('兜底只交给 foldMemory.open（用户手点过的存档仍优先）', /const turnOpen = foldMemory\.open\(turnKey, defaultOpen\)/.test(render))
  check('留在外面的正文不进 .turn-process（否则收起时被一起缩掉）', /else middle\.push\(\{ node: seatRow\(row, false\), fold: false \}\)/.test(render))
  check('过程区按段落包层（每段各缩各的）', /if \(block\.fold\) \{\s*\n\s*segment\.push\(block\.node\)/.test(render) && /flushSegment\(\)\s*\n\s*foldBlocks\.push\(block\.node\)/.test(render))

  const ui = readFileSync(new URL('../src/packages/ui-transcript/ui/ui.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const seats = readFileSync(new URL('../src/packages/ui-transcript/ui/fold-seats.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  /** 这些片段在同一段源码里按顺序出现吗（少一条、顺序反了都算假）。 */
  const inOrder = (text, ...needles) => {
    let previous = -1
    for (const needle of needles) {
      const at = text.indexOf(needle, previous + 1)
      if (at <= previous) return false
      previous = at
    }
    return true
  }
  check('界面侧读 value[\'collapseTiming\']', /collapseTiming: value\['collapseTiming'\] === 'next-input' \? 'next-input' : 'completion'/.test(ui))
  check('界面侧读 value[\'foldedReplies\']', /foldedReplies: value\['foldedReplies'\] === 'final' \? 'final' : 'all'/.test(ui))
  check('预算器拿到 foldedReplies', /foldedReplies: prefs\.foldedReplies/.test(ui))
  // 2026-11-10 改口径（对齐 dsh）：复位不挂在「轮收尾」上，只挂在「这一轮从展开变成收起」
  // 那一拍——参考实现在整轮被折叠隐藏、且隐藏动画进行中时才推进 disclosureReset
  // （ChatNodeSeat.tsx:122-131）。旧断言钉的 `reset(settled)` / `reopened` 已经删掉。
  // 2026-11-11 复位权从**父级**下放到**元素自己**。
  // 2026-11-12 第三次修：阶段组那段「从展开变收起」的布局效果删了（它永远只会空转——
  // 等到真提交时 `openRef` 已被 `turnHidden` 置假）。现在关组只有 `turnHidden` 一处入口，
  // 由 `useSearchableHidden` 在 hidden **真的挂上**那一刻调，有无 FoldScope 都一样。
  check(
    '整轮收起不靠父级复位：关组只有 turnHidden 一处入口，hidden 真挂上才调',
    // ① 父级那套复位没了；`clearPrefixes` 只剩「同一轮改完重答」那一条路（不是全文件禁用）。
    !ui.includes('collapsedRounds')
      && !ui.includes('clearPrefixes(entering)')
      && (ui.match(/foldMemory\.clearPrefixes\(/g) ?? []).length === 1
      && !/foldMemory\.reset\(settled\)/.test(ui)
      // ② 唯一入口：turnHidden 作为 useSearchableHidden 的第四参（有无 scope 都传），
      //    里面依次关组、抹组内行存档、推复位代次。
      && seats.includes('useSearchableHidden(props.turnCollapsed, revealTurn, scope?.transition, turnHidden)')
      && inOrder(
        seats,
        'const turnHidden = useStableCallback((): void => {',
        'closeGroup()',
        'props.onTurnHidden()',
        'resetSource.bump()',
      )
      // ③ onHidden 只在真挂上 hidden 的分支里调：夹在 setAttribute('hidden') 之后、
      //    removeAttribute('hidden') 之前。挪到分支外（展开那一拍也调）会被这条抓住。
      && (() => {
        const setAt = seats.indexOf("element.setAttribute('hidden', 'until-found')")
        const hiddenAt = seats.indexOf('onHidden?.()', setAt)
        const removeAt = seats.indexOf("element.removeAttribute('hidden')")
        return setAt >= 0 && hiddenAt > setAt && (removeAt < 0 || hiddenAt < removeAt)
      })()
      // ④ 关组只有一处调用：加回第二个入口（哪怕改名）就红。
      && (seats.match(/closeGroup\(\)/g) ?? []).length === 1
      // ⑤ 旧判据不能回流：那段布局效果连同 `wasTurnCollapsed` / `entering` / `hiding` 一起删了。
      && !seats.includes('wasTurnCollapsed')
      && !seats.includes('const entering')
      && !/const hiding = [\s\S]{0,120}?props\.turnCollapsed/.test(seats),
  )
  check(
    'next-input 的「上一轮不再是最后一轮」仍抹存档（换成独立 effect 处理）',
    /if \(prefs\.collapseTiming !== 'next-input'\) return/.test(ui) && /foldMemory\.clear\(\[turnFoldKey\(sessionId, previous\)\]\)/.test(ui),
  )
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
if (failures !== 0) process.exitCode = 1
