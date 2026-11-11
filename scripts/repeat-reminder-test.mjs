/**
 * 重复调用提醒的真值表自检（纯逻辑，不启内核、不起桌面）。
 *
 * 被测的是 `src/core/repeat-reminder.ts` 那三个纯函数——投影本体在 `packages/agent`，
 * 真机那半边的验收在 `desktop/shots/_verify-repeat-reminder.mjs`。这里只钉「什么算重复、
 * 哪一跳提醒、文本长什么样」，因为这几条全是阈值与规范化口径，靠读代码最容易看走眼。
 *
 * 覆盖（缺一条就等于这条守卫没被验证）：
 *   1. 同一工具同参数连续 2 次不提醒、第 3 次提醒、第 4 次不提醒、第 5 次提醒、第 8 次提醒、
 *      第 9 次不提醒（只在跨过阈值的那一次提醒，不是从第 3 次起每步都提醒）；
 *   2. 换参数清零、换工具清零、中间插一条用户消息清零；
 *   3. 键序不同的同参数算重复（`{"a":1,"b":2}` 与 `{"b":2,"a":1}`）；
 *   4. 阈值可配（传 `[2]` 时第 2 次就提醒；传空数组永不提醒）；
 *   5. 参数预览超长被截断、且**截断不影响判定**（第 500 字之后才不同的两份参数算不同）；
 *   6. 提醒文本没有硬编码在构建函数里（文案只在 `REPEAT_REMINDER_TEXTS` 一处，可整份替换）；
 *   7. 追加是「末尾另起一条 user 消息」、不提醒时原样返回同一个数组、重复投影幂等。
 *
 * 用法：pnpm run build && node scripts/repeat-reminder-test.mjs
 *
 * @module dsc/scripts/repeat-reminder-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const {
  DEFAULT_ARGUMENTS_PREVIEW_CHARS,
  DEFAULT_REPEAT_THRESHOLDS,
  REPEAT_REMINDER_TEXTS,
  appendRepeatReminder,
  countRepeatedTail,
  normalizeToolArguments,
  planRepeatReminder,
} = await import('../lib/core/repeat-reminder.js')

let failures = 0
const checks = []
/**
 * 记一条断言。
 * @param {string} label 判据的人话描述
 * @param {boolean} condition 判据成立吗
 * @param {string} [extra] 失败时附上的实测值
 */
const check = (label, condition, extra = '') => {
  checks.push(label)
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

/** 汉字范围（与 `scripts/ui-locale-test.mjs` 同一套判据）。 */
const CJK = /[\u4e00-\u9fff]/

/** 一条带工具调用的 assistant 消息（参数按对象给，序列化成模型那种 JSON 文本）。 */
let callSeq = 0
const assistantCall = (name, args) => {
  callSeq += 1
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `call_${String(callSeq)}`,
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      },
    ],
  }
}

/** 一条工具结果（每个调用后面都跟着它，形状与真会话一致）。 */
const toolResult = (text = 'ok') => ({ role: 'tool', content: text, tool_call_id: `call_${String(callSeq)}` })

/**
 * 造一段「连着用同一份参数调 n 次」的历史：一条用户消息 + n 组（调用 + 结果）。
 * @param {number} n 连续次数
 * @param {{ name?: string, args?: unknown }} [shape] 换工具 / 换参数时用
 */
const history = (n, shape = {}) => {
  const name = shape.name ?? 'read'
  const args = shape.args ?? { path: 'README.md' }
  const out = [{ role: 'user', content: '把这件事办完。' }]
  for (let index = 0; index < n; index += 1) {
    out.push(assistantCall(name, args), toolResult())
  }
  return out
}

console.log('[1] 阈值真值表：默认只在第 3 / 5 / 8 次提醒')
{
  check('默认阈值就是 [3, 5, 8]', JSON.stringify(DEFAULT_REPEAT_THRESHOLDS) === '[3,5,8]', JSON.stringify(DEFAULT_REPEAT_THRESHOLDS))
  const expected = new Map([
    [1, false],
    [2, false],
    [3, true],
    [4, false],
    [5, true],
    [6, false],
    [7, false],
    [8, true],
    [9, false],
    [10, false],
  ])
  for (const [times, wanted] of expected) {
    const plan = planRepeatReminder(history(times))
    check(
      `连续 ${String(times)} 次 → ${wanted ? '提醒' : '不提醒'}`,
      plan.remind === wanted,
      `实际 remind=${String(plan.remind)} count=${String(plan.count)} tier=${String(plan.tier)}`,
    )
    check(`连续 ${String(times)} 次：数出来的次数对得上`, plan.count === times, String(plan.count))
  }
  // 档位：第 3 次是第一档（温和），第 5、8 次是后续档（详细）。
  const third = planRepeatReminder(history(3))
  const fifth = planRepeatReminder(history(5))
  const eighth = planRepeatReminder(history(8))
  check('第 3 次命中第 1 档', third.tier === 1, String(third.tier))
  check('第 5 次命中第 2 档', fifth.tier === 2, String(fifth.tier))
  check('第 8 次命中第 3 档', eighth.tier === 3, String(eighth.tier))
  check('第一档是温和文案（与默认字典逐字节相同）', third.text === REPEAT_REMINDER_TEXTS.gentle, third.text)
  check('后续档是详细文案（含工具名与连续次数）', fifth.text.includes('read') && fifth.text.includes('连续调用了 5 次'), fifth.text)
  check('后续档也把第 8 次的次数写出来', eighth.text.includes('连续调用了 8 次'), eighth.text)
  check('第一档不贴参数（温和）', !third.text.includes('README.md'), third.text)
  check('详细档贴了参数', fifth.text.includes('README.md'), fifth.text)
}

console.log('[2] 清零：换参数 / 换工具 / 中间插一条用户消息')
{
  const switched = [...history(3), assistantCall('read', { path: 'OTHER.md' }), toolResult()]
  const plan = planRepeatReminder(switched)
  check('第 4 次换了参数 → 计数清零，不提醒', plan.remind === false && plan.count === 1, `remind=${String(plan.remind)} count=${String(plan.count)}`)

  const otherTool = [...history(3), assistantCall('grep', { path: 'README.md' }), toolResult()]
  const byTool = planRepeatReminder(otherTool)
  check('第 4 次换了工具 → 计数清零，不提醒', byTool.remind === false && byTool.count === 1, `remind=${String(byTool.remind)} count=${String(byTool.count)}`)

  const interrupted = [...history(3), { role: 'user', content: '等一下，先别调了。' }, assistantCall('read', { path: 'README.md' }), toolResult()]
  const byUser = planRepeatReminder(interrupted)
  check('中间插了一条用户消息 → 计数清零，不提醒', byUser.remind === false && byUser.count === 1, `remind=${String(byUser.remind)} count=${String(byUser.count)}`)

  // 换参数之后重新攒到 3 次，照样提醒（清零不是「一次就再也提醒不了」）。
  const again = [...history(3), ...history(0), assistantCall('read', { path: 'OTHER.md' }), toolResult()]
  again.push(assistantCall('read', { path: 'OTHER.md' }), toolResult())
  again.push(assistantCall('read', { path: 'OTHER.md' }), toolResult())
  check('换参数后重新连续 3 次 → 又提醒', planRepeatReminder(again).remind === true)
}

console.log('[3] 规范化：键序不同的同参数算同一份')
{
  const reordered = [
    { role: 'user', content: '办完。' },
    assistantCall('read', '{"path":"README.md","offset":1}'),
    toolResult(),
    assistantCall('read', '{"offset":1,"path":"README.md"}'),
    toolResult(),
    assistantCall('read', '{"offset":1,"path":"README.md"}'),
    toolResult(),
  ]
  const plan = planRepeatReminder(reordered)
  check('两份只有键序不同的参数算重复（连续 3 次 → 提醒）', plan.remind === true, `count=${String(plan.count)}`)
  check('键序规范化后的串是同一个', normalizeToolArguments('{"b":2,"a":1}') === normalizeToolArguments('{"a":1,"b":2}'))
  check('规范化结果按 key 升序', normalizeToolArguments('{"b":2,"a":1}') === '{"a":1,"b":2}', normalizeToolArguments('{"b":2,"a":1}'))
  check('嵌套对象的键也排序', normalizeToolArguments('{"x":{"b":1,"a":2}}') === '{"x":{"a":2,"b":1}}')
  check('数组保序（顺序是值的一部分）', normalizeToolArguments('{"a":[2,1]}') !== normalizeToolArguments('{"a":[1,2]}'))
  check('空参数规范化为空串', normalizeToolArguments('') === '' && normalizeToolArguments(undefined) === '')
  check('坏 JSON 退回 trim 后的原文', normalizeToolArguments('  {half  ') === '{half')
  check('数值等价写法归一（1.0 与 1 同一份）', normalizeToolArguments('{"a":1.0}') === normalizeToolArguments('{"a":1}'))
}

console.log('[4] 阈值可配')
{
  check('传 [2]：连续 2 次就提醒', planRepeatReminder(history(2), { thresholds: [2] }).remind === true)
  check('传 [2]：连续 3 次不提醒（只命中等于阈值的那些次）', planRepeatReminder(history(3), { thresholds: [2] }).remind === false)
  check('传 [2,4]：第 4 次命中第 2 档', planRepeatReminder(history(4), { thresholds: [2, 4] }).tier === 2)
  check('阈值乱序也按升序判档位', planRepeatReminder(history(4), { thresholds: [4, 2] }).tier === 2)
  check('重复阈值去重后不撞档', planRepeatReminder(history(2), { thresholds: [2, 2, 5] }).tier === 1)
  check('传空数组：永不提醒', planRepeatReminder(history(8), { thresholds: [] }).remind === false)
  check('阈值小于 1 的丢掉（不会第 1 次就提醒）', planRepeatReminder(history(1), { thresholds: [0, -3] }).remind === false)
}

console.log('[5] 参数预览：超长被截断，但判定用完整参数')
{
  // 800 个 x 的参数：JSON 是 `{"padding":"<800 个 x>"}`，前 12 个字符是固定的键名部分。
  const longArgs = { padding: 'x'.repeat(800) }
  /** 一段文本里出现了几个 x（预览截到第几个字符，靠它算得精确）。 */
  const xCount = (text) => (text.match(/x/g) ?? []).length
  const detailed = planRepeatReminder(history(5, { args: longArgs }))
  check('默认预览上限是 500 字', DEFAULT_ARGUMENTS_PREVIEW_CHARS === 500, String(DEFAULT_ARGUMENTS_PREVIEW_CHARS))
  check('默认档只留前 500 字（键名占 12 字 → 488 个 x）', xCount(detailed.text) === 488, String(xCount(detailed.text)))
  check('被截断的预览带省略号（看得出没给全）', detailed.text.includes('…'))
  check('截断之后正文显著短于完整参数', detailed.text.length < 800, String(detailed.text.length))

  const short = planRepeatReminder(history(5, { args: longArgs }), { argumentsPreviewChars: 20 })
  check('预览上限可配（配成 20 → 只剩 8 个 x）', xCount(short.text) === 8, String(xCount(short.text)))
  const wide = planRepeatReminder(history(5, { args: longArgs }), { argumentsPreviewChars: 2000 })
  check('配大之后能看全（2000 字上限 → 800 个 x 一个不少）', xCount(wide.text) === 800, String(xCount(wide.text)))
  check('没截断就不加省略号', !wide.text.includes('…'))

  // 判定不受截断影响：两份参数只在第 600 字之后不同 → 是两次不同的调用，计数清零。
  const nearlySame = [
    { role: 'user', content: '办完。' },
    assistantCall('read', { padding: 'y'.repeat(600) + 'A' }),
    toolResult(),
    assistantCall('read', { padding: 'y'.repeat(600) + 'B' }),
    toolResult(),
  ]
  const plan = planRepeatReminder(nearlySame)
  check('第 500 字之后才不同的两份参数算不同（判定用完整串）', plan.count === 1 && plan.remind === false, `count=${String(plan.count)}`)
}

console.log('[6] 文案不在构建函数里：只有 REPEAT_REMINDER_TEXTS 一处，可整份替换')
{
  const english = { gentle: 'gentle reminder', detailed: 'tool {tool} repeated {count} times, limit {limit}: {args}' }
  const plan = planRepeatReminder(history(5), { texts: english })
  check(
    '换一份字典之后输出里没有默认中文（构建函数不夹带文案）',
    plan.text === 'tool read repeated 5 times, limit 500: {"path":"README.md"}',
    plan.text,
  )
  check('第一档也走字典', planRepeatReminder(history(3), { texts: english }).text === 'gentle reminder')

  // 源码层：剥掉注释之后，中文只该出现在 REPEAT_REMINDER_TEXTS 那个对象字面量里。
  const file = fileURLToPath(new URL('../src/core/repeat-reminder.ts', import.meta.url))
  const source = readFileSync(file, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const start = code.indexOf('export const REPEAT_REMINDER_TEXTS')
  const end = code.indexOf('\n}', start)
  check('源码里找得到 REPEAT_REMINDER_TEXTS', start >= 0 && end > start, `${String(start)}..${String(end)}`)
  const outside = start >= 0 && end > start ? code.slice(0, start) + code.slice(end + 2) : code
  const strayLines = outside.split('\n').filter((line) => CJK.test(line))
  check(
    '构建函数里没有中文字面量（文案只在常量对象一处）',
    strayLines.length === 0,
    JSON.stringify(strayLines.slice(0, 3)),
  )
}

console.log('[7] 追加：末尾另起一条 user 消息，不提醒时原样返回，重复投影幂等')
{
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: '办完。' }]
  const quiet = planRepeatReminder(history(2))
  check('不提醒时 append 原样返回同一个数组', appendRepeatReminder(messages, quiet) === messages)

  const loud = planRepeatReminder(history(3))
  const appended = appendRepeatReminder(messages, loud)
  check('提醒时返回新数组', appended !== messages)
  check('提醒只多一条', appended.length === messages.length + 1, String(appended.length))
  check('多出来的那条是 user 角色', appended[appended.length - 1].role === 'user')
  check('正文就是 plan 的文本（没拼进上一条）', appended[appended.length - 1].content === loud.text)
  check('上一条消息一个字没动', appended[1] === messages[1] && messages[1].content === '办完。')
  check('重复投影幂等（末尾已经在了就不再追加）', appendRepeatReminder(appended, loud) === appended)
}

console.log('[8] 尾部没有工具调用时什么都不做')
{
  check('空历史不提醒', planRepeatReminder([]).remind === false)
  check('只有用户消息不提醒', planRepeatReminder([{ role: 'user', content: '你好' }]).remind === false)
  check('没有工具调用的 assistant 不提醒', planRepeatReminder([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你的？' },
  ]).remind === false)
  check('尾部没有工具调用时 count 是 0', countRepeatedTail([{ role: 'user', content: '你好' }]) === null)
  // 一条 assistant 里并行发两个同样的调用：它们本来就是挨着的两次调用。
  const parallel = [
    { role: 'user', content: '办完。' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
        { id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
      ],
    },
    { role: 'tool', content: 'ok', tool_call_id: 'call_a' },
    { role: 'tool', content: 'ok', tool_call_id: 'call_b' },
  ]
  check('同一条 assistant 里的两个同参调用算连续 2 次', countRepeatedTail(parallel)?.count === 2, String(countRepeatedTail(parallel)?.count))
}

console.log('')
console.log(`共 ${String(checks.length)} 条断言，失败 ${String(failures)} 条`)
process.exit(failures === 0 ? 0 : 1)
