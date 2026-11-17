/**
 * 整轮折叠对「请求侧两张账单卡」的口径探针（2026-11-17）。
 *
 * 报障：一轮收起来之后，系统提示卡（⚙）和上下文注入卡（⊕）还挂在「已完成」下面。
 * 根因不是渲染漏了，是 `TURN_INDEPENDENT` 把这两个 kind 钉成了「整轮收起也不许藏」。
 * 改口径后它们跟着整轮一起收——本探针钉住三件事：
 *   1. 过程区**区间**覆盖这两张卡（只把它们从独立表里删掉是不够的：区间不覆盖时
 *      `hidden` 里根本不会出现它们，收起照样收不掉）；
 *   2. 两张卡进了 `hidden`，最终回答仍然一个字都不藏；
 *   3. `system` 通知（错误 / 中断 / 恢复会话）**没有**被这次改动带下水。
 *
 * 怎么跑 `round-fold.tsx`：与 `ui-round-fold-tail-test.mjs` 同一套办法——`buildRoundFolds`
 * 是纯计算，Node 能直接跑；文件是 .tsx，所以在 load 钩子里用仓库自带的 typescript 现转一次
 * JSX，并把 `@dsc/ui` 指向只转出取词器的桩（见 `_ui-probe-stub.mjs`）。跑的是同一份源码。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-round-fold-cards-test.mjs
 *
 * @module dsc/scripts/ui-round-fold-cards-test
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
const sorted = (set) => [...set].sort((left, right) => left - right)
const listOf = (set) => JSON.stringify(sorted(set))

let seq = 0
const entry = (kind, extra = {}) => ({ kind, id: (seq += 1), ...extra })
const text = (body) => entry('text', { text: body })
const think = (body) => entry('thinking', { text: body })
const tool = (name, status) => entry('tool', { call: { callId: 'c' + seq, name, argsText: '{"command":"pnpm build"}', status } })
/** 两个请求侧账单卡的形状（折叠只认 kind / id，字段照契约给个最小实例）。 */
const promptCard = () => entry('system-prompt', { prompt: { hash: 'h', chars: 6000, sections: [], model: 'm' }, after: 1 })
const injectionCard = () => entry('context-injection', { parts: [{ kind: 'env-facts', source: 'env-facts', where: 'user-tail', chars: 300 }], count: 1, after: 1 })
const oneRound = (entries) => [{ index: 0, startIndex: 0, endIndex: entries.length - 1, startTs: 1, endTs: 2, answered: true }]
const foldOf = (entries, options = {}) =>
  buildRoundFolds(entries, oneRound(entries), { foldTurns: true, live: false, lastRoundIndex: 0, foldedReplies: 'final', ...options }).get(0)

console.log('[1] 报障现场：两张卡在轮首，后面是思考 → 工具 → 最终回答')
{
  const entries = [
    entry('user', { text: '搜一下天津天气' }),
    promptCard(),
    injectionCard(),
    think('先看网络能不能通'),
    tool('bash', 'done'),
    text('天津今天 5~10℃，烟霾。'),
  ]
  // 下标：0 用户 / 1 提示卡 / 2 注入卡 / 3 思考 / 4 工具 / 5 最终回答
  const fold = foldOf(entries)
  check('过程区起点就是系统提示卡（区间覆盖到它）', fold.startIndex === 1, String(fold.startIndex))
  check('过程区终点是最后一条工具（回答之后没有过程行）', fold.endIndex === 4, String(fold.endIndex))
  check('两张卡都在 hidden 里', fold.hidden.has(1) && fold.hidden.has(2), listOf(fold.hidden))
  check('思考与工具照旧藏', fold.hidden.has(3) && fold.hidden.has(4))
  check('最终回答一个字都不藏', !fold.hidden.has(5), listOf(fold.hidden))
  check('有内容可折（总开关可点）', fold.hasContent === true)
}

console.log('[2] 只有两张卡 + 一句回答：卡要能收，回答留着')
{
  const entries = [
    entry('user', { text: '你好' }),
    promptCard(),
    injectionCard(),
    text('你好，兄弟。'),
  ]
  const fold = foldOf(entries)
  check('起点是提示卡', fold.startIndex === 1, String(fold.startIndex))
  check('两张卡都藏', fold.hidden.has(1) && fold.hidden.has(2), listOf(fold.hidden))
  check('回答不藏', !fold.hidden.has(3), listOf(fold.hidden))
  check('这时总开关是可点的（不是「没内容可折」）', fold.hasContent === true)
}

console.log('[3] 轮中途再来一张注入卡（多步轮每一步都重发）：同样进 hidden')
{
  const entries = [
    entry('user', { text: '改一下折叠' }),
    promptCard(),
    think('先读代码'),
    tool('read', 'done'),
    injectionCard(),
    think('再改'),
    tool('edit', 'done'),
    text('改好了。'),
  ]
  const fold = foldOf(entries)
  check('轮首与轮中的两张卡都在 hidden 里', fold.hidden.has(1) && fold.hidden.has(4), listOf(fold.hidden))
  check('两次工具都在 hidden 里', fold.hidden.has(3) && fold.hidden.has(6))
  check('最终回答不藏', !fold.hidden.has(7))
}

console.log('[4] 反回归：system 通知仍然不藏（错误 / 中断 / 恢复会话）')
{
  const entries = [
    entry('user', { text: '跑个命令' }),
    promptCard(),
    think('准备跑'),
    entry('system', { text: '这一轮被中断' }),
    tool('bash', 'failed'),
  ]
  const fold = foldOf(entries)
  check('system 通知不进 hidden', !fold.hidden.has(3), listOf(fold.hidden))
  check('提示卡与工具仍然藏', fold.hidden.has(1) && fold.hidden.has(4), listOf(fold.hidden))
}

console.log('[5] 反回归：没有这两张卡的普通轮，行为不变')
{
  const entries = [
    entry('user', { text: '跑个命令' }),
    think('准备跑'),
    tool('bash', 'done'),
    text('跑完了。'),
  ]
  const fold = foldOf(entries)
  check('区间照旧是思考→工具', fold.startIndex === 1 && fold.endIndex === 2, `${String(fold.startIndex)}/${String(fold.endIndex)}`)
  check('隐藏集合照旧', listOf(fold.hidden) === '[1,2]', listOf(fold.hidden))
}

console.log(`\n通过 ${String(passed)}/${String(passed + failures)}`)
if (failures > 0) process.exit(1)
