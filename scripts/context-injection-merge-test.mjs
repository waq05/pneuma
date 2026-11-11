/**
 * 上下文注入卡的合并规则（适配层 `context/injected` 分支）的确定性探针。
 *
 * 要守的现象（2026-11-11 报障）：一次多步回合里，每一步请求都会重报一次注入清单，
 * 而清单会在 A（环境快照 + 模式 + 沙箱）与 B（A 再多一条重复调用提醒）之间交替。
 * 修之前是「跟最近一条注入卡比」——A 出现时最近那条是 B，必然不等，于是每一跳都新长
 * 一张卡，16 步的回合落 8 张几乎一样的卡（现场实测见 `_verify-repeat-reminder.mjs`）。
 *
 * 修后的口径：
 *   1. 只在**这一轮**里找同 `parts` 的卡片，找到就刷新时刻、次数 +1（不新建）；
 *   2. 轮与轮之间不合并（`user` / `turn-end` 是边界；正文与工具行不是边界）；
 *   3. 次数 `count` 是记账读数，不参与「条目内容是否变了」的判等；
 *   4. 空清单照旧不建条目——那只是这一轮什么都没注入。
 *
 * 为什么要先 build：本探针 import 的是编译产物 `lib/`（adapter 与 transcript 插件都是 TS，
 * 且按 NodeNext 写 `.js` 说明符，node 自带的类型擦除解析不了）。与 `trace-data-test.mjs`
 * 同一条规矩。
 *
 * 运行：pnpm build && node scripts/context-injection-merge-test.mjs
 *
 * @module dsc/scripts/context-injection-merge-test
 */
import { Transcript } from '../lib/adapter/transcript.js'
import { sameEntries } from '../lib/packages/transcript/index.js'

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  if (condition === true) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${name}${detail === '' ? '' : `  <- ${detail}`}`)
}

/** 注入清单 A：环境快照 + 模式 + 沙箱（三类的组合）。 */
const A = [
  { kind: 'env-facts', source: 'env-facts', where: 'user-tail', chars: 908, preview: '环境事实' },
  { kind: 'mode', source: 'mode', where: 'system', chars: 85, preview: '当前模式' },
  { kind: 'sandbox', source: 'sandbox', where: 'system', chars: 445, preview: '沙箱档位' },
]
/** 注入清单 B：A 再多一条重复调用提醒（这就是现场 A / B 交替的来源）。 */
const B = [...A, { kind: 'repeat-reminder', source: 'repeat-reminder', where: 'user-tail', chars: 42, preview: '提醒' }]

/** 一类注入卡（只挑渲染要用的字段，方便断言）。 */
const cards = (transcript) =>
  transcript.entries
    .filter((entry) => entry.kind === 'context-injection')
    .map((entry) => ({ parts: entry.parts, count: entry.count ?? 1, id: entry.id, ts: entry.ts }))

/**
 * 走一步真实回合的条目顺序：提示卡 → 注入卡 → 正文 → 工具调用 → 工具结果。
 *
 * 为什么中间要夹工具行：现场就是这样（`loop.ts` 每跳发一次请求，两次请求之间必然有上一次
 * 的助手消息与工具结果）。合并判据若把工具行当轮界，每跳都会断开——这是必须钉住的形状。
 */
const step = (transcript, parts, callId, ts) => {
  transcript.reduce({ type: 'prompt/used', prompt: { hash: 'h1', chars: 4400, sections: [] } }, ts)
  transcript.reduce({ type: 'context/injected', parts }, ts)
  transcript.reduce({ type: 'delta', kind: 'text', text: '读文件。' }, ts)
  transcript.reduce({ type: 'message', text: '读文件。', reasoning: '' }, ts)
  transcript.reduce({ type: 'tool/call', callId, name: 'read', args: '{}' }, ts)
  transcript.reduce({ type: 'tool/result', callId, text: 'ok' }, ts)
}

console.log('上下文注入卡合并测试')

// ── ① 同一轮里 A、A、A（中间隔着工具行）→ 一张卡，次数 3 ──────────────────────
{
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: '开始' }, 1000)
  step(transcript, A, 'c1', 1010)
  const firstId = cards(transcript)[0]?.id
  step(transcript, A, 'c2', 1020)
  step(transcript, A, 'c3', 1030)
  const list = cards(transcript)
  check('① A、A、A 只留 1 张卡（工具行不打断这一轮）', list.length === 1, JSON.stringify(list.map((card) => card.parts.length)))
  check('① 次数累加到 3', list[0]?.count === 3, String(list[0]?.count))
  check('① 时刻刷新到最后一次出现（条目 ts = 1030）', list[0]?.ts === 1030, String(list[0]?.ts))
  check('① id 不换（React key 稳定，展开态不重置）', list[0]?.id === firstId, `${String(firstId)} -> ${String(list[0]?.id)}`)
}

// ── ② 同一轮里 A、B、A → 两张卡：A 两次、B 一次 ──────────────────────────────
{
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: '开始' }, 2000)
  step(transcript, A, 'c1', 2010)
  step(transcript, B, 'c2', 2020)
  step(transcript, A, 'c3', 2030)
  const list = cards(transcript)
  check('② A、B、A 留 2 张卡（A 被 B 隔开也要并回同一张 A）', list.length === 2, JSON.stringify(list.map((card) => card.parts.length)))
  check('② 第一条是 A、次数 2', list[0]?.parts.length === 3 && list[0]?.count === 2, JSON.stringify(list[0]))
  check('② 第二条是 B、只出现一次（次数缺省 1）', list[1]?.parts.length === 4 && list[1]?.count === 1, JSON.stringify(list[1]))
  check('② 卡片顺序按首次出现（A 在 B 前面）', list.map((card) => card.parts.length).join(',') === '3,4')
}

// ── ③ 跨轮不合并：中间隔一条 user（新一轮的起点）→ 两张卡 ─────────────────────
{
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: '第一轮' }, 3000)
  step(transcript, A, 'c1', 3010)
  step(transcript, A, 'c2', 3020)
  transcript.reduce({ type: 'turn/end', reason: 'completed' }, 3030)
  transcript.reduce({ type: 'user', text: '第二轮' }, 3040)
  step(transcript, A, 'c3', 3050)
  const list = cards(transcript)
  check('③ 跨轮不合并（同样的 parts 也各留一张）', list.length === 2, JSON.stringify(list.map((card) => card.count)))
  check('③ 上一轮那张次数仍是 2（没被下一轮 +1）', list[0]?.count === 2, String(list[0]?.count))
  check('③ 下一轮那张从 1 重新数', list[1]?.count === 1, String(list[1]?.count))
}

// ── ④ 现场形态：16 步、两轮、A / B 交替 → 4 张卡（修前是 8 张）───────────────
{
  const transcript = new Transcript()
  const reminderAt = new Set([4, 6, 9, 16])
  transcript.reduce({ type: 'user', text: '第一轮' }, 4000)
  for (let index = 1; index <= 10; index += 1) {
    step(transcript, reminderAt.has(index) ? B : A, `c${String(index)}`, 4000 + index)
  }
  transcript.reduce({ type: 'turn/end', reason: 'completed' }, 4011)
  transcript.reduce({ type: 'user', text: '第二轮' }, 4020)
  for (let index = 11; index <= 16; index += 1) {
    step(transcript, reminderAt.has(index) ? B : A, `c${String(index)}`, 4020 + index)
  }
  const list = cards(transcript)
  check('④ 16 步两轮只落 4 张卡（每轮 A / B 各一张）', list.length === 4, JSON.stringify(list.map((card) => `${String(card.parts.length)}x${String(card.count)}`)))
  check('④ 次数分别是 7 / 3 / 5 / 1（每一轮 10 步与 6 步的实测值）',
    list.map((card) => card.count).join(',') === '7,3,5,1', JSON.stringify(list.map((card) => card.count)))
}

// ── ④b 提醒正文不同就是不同的组合，不许合并 ───────────────────────────────────
// 现场探针第一轮的三条提醒正文并不相同：第 4 跳温和版、第 6 跳「连续调用了 5 次」、
// 第 9 跳「连续调用了 8 次」。合并判据只认同 `parts`，所以真机是 6 张（不是 4 张）——
// 这不是漏并，是三条不同的注入内容各留了一张；把它们并掉会让读者以为模型只收到过一种提醒。
{
  const once = (preview) => ({
    kind: 'repeat-reminder',
    source: 'repeat-reminder',
    where: 'user-tail',
    chars: 84,
    preview,
  })
  const B5 = [...A, once('（提醒：工具 read 已经用完全相同的参数连续调用了 5 次。')]
  const B8 = [...A, once('（提醒：工具 read 已经用完全相同的参数连续调用了 8 次。')]
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: '开始' }, 4500)
  step(transcript, A, 'c1', 4510)
  step(transcript, B5, 'c2', 4520)
  step(transcript, B8, 'c3', 4530)
  const list = cards(transcript)
  check('④b 提醒正文不同的三条注入落 3 张卡（内容不同，不许并）', list.length === 3, JSON.stringify(list.map((card) => card.parts.length)))
  check('④b 三张的次数都是 1（没有互相 +1）', list.every((card) => card.count === 1), JSON.stringify(list.map((card) => card.count)))
}

// ── ⑤ count 不进内容判等，但 parts 变了要判得出来 ─────────────────────────────
{
  const live = [{ kind: 'context-injection', id: 1, parts: A, count: 6, ts: 1000 }]
  const replayed = [{ kind: 'context-injection', id: 1, parts: A, count: 1, ts: 2000 }]
  check('⑤ count 不同仍判内容相同（重复打开会话不整表重建）', sameEntries(live, replayed) === true)
  const changed = [{ kind: 'context-injection', id: 1, parts: B, count: 1, ts: 2000 }]
  check('⑤ parts 变了就判内容不同（这条不是恒真）', sameEntries(live, changed) === false)
  const extra = [...replayed, { kind: 'context-injection', id: 2, parts: B, count: 1, ts: 2000 }]
  check('⑤ 条目数不同判内容不同（判等没有放松成长度也忽略）', sameEntries(live, extra) === false)
}

// ── ⑥ 空清单照旧不建条目 ─────────────────────────────────────────────────────
{
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: '开始' }, 5000)
  const before = transcript.entries.length
  const changed = transcript.reduce({ type: 'context/injected', parts: [] }, 5010)
  check('⑥ 空清单 reduce 返回 false（没有可见变化）', changed === false, String(changed))
  check('⑥ 空清单不建条目（条目数不变）', transcript.entries.length === before, `${String(before)} -> ${String(transcript.entries.length)}`)
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failed)}`)
process.exit(failed === 0 ? 0 : 1)
