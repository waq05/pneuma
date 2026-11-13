/**
 * 重复调用提醒的真值表（迁自 `scripts/repeat-reminder-test.mjs`）。
 *
 * 被测的是 `core/repeat-reminder.ts` 那五个纯函数——投影本体在 `packages/agent`，
 * 真机那半边的验收在桌面截图脚本里。这里只钉「什么算重复、哪一跳提醒、文本长什么样」，
 * 因为这几条全是阈值与规范化口径，靠读代码最容易看走眼。
 *
 * 为什么放 unit 层：整份用例不读盘、不读环境变量、不起内核，被调函数是纯函数。
 * 探针里那套 `check()` + 计数打印换成了 `test()` + `expect`：红了直接念得出是哪条行为破了。
 *
 * ## 迁移时删掉的一条
 *
 * 原探针第 [6] 节末尾有一条**源码文本审计**：把 `src/core/repeat-reminder.ts` 的注释剥掉后，
 * 断言 `REPEAT_REMINDER_TEXTS` 对象字面量之外没有中文字面量。它测的是「文件里有没有这段
 * 文本」，不是「程序做什么」，按本批规矩不搬。它想守的语义（构建函数不夹带文案）已由
 * 本节「换一份字典之后输出里没有默认中文」两条行为用例覆盖；剩下那半是排版纪律，
 * 留给源码约定与 P7 收尾记录。
 *
 * @module dsc/core/repeat-reminder.spec
 */
import { describe, expect, test } from 'vitest'
import type { ChatMessage } from './llm.js'
import {
  DEFAULT_ARGUMENTS_PREVIEW_CHARS,
  DEFAULT_REPEAT_THRESHOLDS,
  REPEAT_REMINDER_TEXTS,
  appendRepeatReminder,
  countRepeatedTail,
  normalizeToolArguments,
  planRepeatReminder,
} from './repeat-reminder.js'

/** 一条带工具调用的 assistant；参数按对象给，序列化成模型那种 JSON 文本。 */
let callSeq = 0
const assistantCall = (name: string, args: unknown): ChatMessage => {
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

/** 一条工具结果：每个调用后面都跟着它，形状与真会话一致（role 是 tool，不是 assistant）。 */
const toolResult = (text = 'ok'): ChatMessage => ({ role: 'tool', content: text, tool_call_id: `call_${String(callSeq)}` })

/**
 * 造一段「连着用同一份参数调 n 次」的历史。
 *
 * 首条是用户消息：没有它，`countRepeatedTail` 会一路倒着数到数组头，测「插一条用户消息
 * 就清零」时反而分不清是用户消息拦住的还是数组头拦住的。
 */
const history = (n: number, shape: { name?: string; args?: unknown } = {}): ChatMessage[] => {
  const name = shape.name ?? 'read'
  const args = shape.args ?? { path: 'README.md' }
  const out: ChatMessage[] = [{ role: 'user', content: '把这件事办完。' }]
  for (let index = 0; index < n; index += 1) {
    out.push(assistantCall(name, args), toolResult())
  }
  return out
}

/** 一段文本里出现了几个 x（预览截到第几个字符，靠它算得精确）。 */
const xCount = (text: string): number => (text.match(/x/g) ?? []).length

describe('① 阈值真值表：默认只在第 3 / 5 / 8 次提醒', () => {
  test('默认阈值就是 [3, 5, 8]', () => {
    // 阈值是「只在跨过的那一次提醒」这条语义的唯一定义处：改成 [3] 或 [3,4,5] 都算行为变了。
    expect([...DEFAULT_REPEAT_THRESHOLDS]).toEqual([3, 5, 8])
  })

  // 每一档都单列一条用例：红的时候能念出「第 6 次居然提醒了」，而不是去猜循环里的下标。
  const table: Array<[number, boolean]> = [
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
  ]
  for (const [times, wanted] of table) {
    test(`连续 ${String(times)} 次 → ${wanted ? '提醒' : '不提醒'}`, () => {
      // 这条同时钉住「跨过阈值才提醒一次」：第 4 次、第 6、7、9、10 次都必须是 false，
      // 否则就是从第 3 次起每步都提醒（改之前那个缺陷的形状）。
      const plan = planRepeatReminder(history(times))
      expect(plan.remind).toBe(wanted)
      expect(plan.count).toBe(times)
    })
  }

  test('第 3 次命中第 1 档（温和），第 5 次第 2 档，第 8 次第 3 档', () => {
    // 档位决定用哪套文案；档位串档等于模型看到的话术错位。
    expect(planRepeatReminder(history(3)).tier).toBe(1)
    expect(planRepeatReminder(history(5)).tier).toBe(2)
    expect(planRepeatReminder(history(8)).tier).toBe(3)
  })

  test('第一档是温和文案（与默认字典逐字节相同）', () => {
    // 不贴参数是「温和」的定义：第 3 次就把 500 字参数贴给模型，等于提醒变噪声。
    const third = planRepeatReminder(history(3))
    expect(third.text).toBe(REPEAT_REMINDER_TEXTS.gentle)
    expect(third.text.includes('README.md')).toBe(false)
  })

  test('后续档是详细文案：含工具名、连续次数与参数预览', () => {
    const fifth = planRepeatReminder(history(5))
    expect(fifth.text.includes('read')).toBe(true)
    expect(fifth.text.includes('连续调用了 5 次')).toBe(true)
    expect(fifth.text.includes('README.md')).toBe(true)
  })

  test('第 8 次的详细文案写的是 8，不是第 5 次的 5', () => {
    // 次数是拍进正文的；坑在于缓存了上一档的文本，模型看到「5 次」而实际 8 次。
    expect(planRepeatReminder(history(8)).text.includes('连续调用了 8 次')).toBe(true)
  })
})

describe('② 清零：换参数 / 换工具 / 中间插一条用户消息', () => {
  test('第 4 次换了参数 → 计数清零，不提醒', () => {
    const switched = [...history(3), assistantCall('read', { path: 'OTHER.md' }), toolResult()]
    const plan = planRepeatReminder(switched)
    expect(plan.remind).toBe(false)
    expect(plan.count).toBe(1)
  })

  test('第 4 次换了工具 → 计数清零，不提醒', () => {
    // 工具名与参数一起构成「同一次调用」的键；只比参数会让 read/grep 同路径互相冒充。
    const otherTool = [...history(3), assistantCall('grep', { path: 'README.md' }), toolResult()]
    const plan = planRepeatReminder(otherTool)
    expect(plan.remind).toBe(false)
    expect(plan.count).toBe(1)
  })

  test('中间插了一条用户消息 → 计数清零，不提醒', () => {
    // 用户开口就是新的意图：不能因为前一轮攒的次数，在新意图的第一步就提醒。
    const interrupted = [
      ...history(3),
      { role: 'user', content: '等一下，先别调了。' } as ChatMessage,
      assistantCall('read', { path: 'README.md' }),
      toolResult(),
    ]
    const plan = planRepeatReminder(interrupted)
    expect(plan.remind).toBe(false)
    expect(plan.count).toBe(1)
  })

  test('换参数后重新连续 3 次 → 又提醒（清零不是「一次就再也提醒不了」）', () => {
    const again = [...history(3), assistantCall('read', { path: 'OTHER.md' }), toolResult()]
    again.push(assistantCall('read', { path: 'OTHER.md' }), toolResult())
    again.push(assistantCall('read', { path: 'OTHER.md' }), toolResult())
    expect(planRepeatReminder(again).remind).toBe(true)
  })
})

describe('③ 规范化：键序不同的同参数算同一份', () => {
  test('两份只有键序不同的参数算重复（连续 3 次 → 提醒）', () => {
    // 模型每次重写参数都可能换键序；不规范化就永远数不满，提醒形同虚设。
    const reordered: ChatMessage[] = [
      { role: 'user', content: '办完。' },
      assistantCall('read', '{"path":"README.md","offset":1}'),
      toolResult(),
      assistantCall('read', '{"offset":1,"path":"README.md"}'),
      toolResult(),
      assistantCall('read', '{"offset":1,"path":"README.md"}'),
      toolResult(),
    ]
    expect(planRepeatReminder(reordered).remind).toBe(true)
  })

  test('规范化结果按 key 升序', () => {
    expect(normalizeToolArguments('{"b":2,"a":1}')).toBe('{"a":1,"b":2}')
    expect(normalizeToolArguments('{"b":2,"a":1}')).toBe(normalizeToolArguments('{"a":1,"b":2}'))
  })

  test('嵌套对象的键也排序', () => {
    // 只排第一层的话，`{"x":{...}}` 这种常见形状（read 的区间、bash 的环境变量）永远对不上。
    expect(normalizeToolArguments('{"x":{"b":1,"a":2}}')).toBe('{"x":{"a":2,"b":1}}')
  })

  test('数组保序（顺序是值的一部分）', () => {
    expect(normalizeToolArguments('{"a":[2,1]}')).not.toBe(normalizeToolArguments('{"a":[1,2]}'))
  })

  test('空参数规范化为空串', () => {
    expect(normalizeToolArguments('')).toBe('')
    expect(normalizeToolArguments(undefined)).toBe('')
  })

  test('坏 JSON 退回 trim 后的原文（不抛、不吞）', () => {
    // 流中断时参数可能是半截 JSON；退回原文至少还能按「原文相同」判重复。
    expect(normalizeToolArguments('  {half  ')).toBe('{half')
  })

  test('数值等价写法归一（1.0 与 1 同一份）', () => {
    expect(normalizeToolArguments('{"a":1.0}')).toBe(normalizeToolArguments('{"a":1}'))
  })
})

describe('④ 阈值可配', () => {
  test('传 [2]：连续 2 次就提醒', () => {
    expect(planRepeatReminder(history(2), { thresholds: [2] }).remind).toBe(true)
  })

  test('传 [2]：连续 3 次不提醒（只命中等于阈值的那些次）', () => {
    // 「等于」而不是「大于等于」：否则传 [2] 会变成从第 2 次起每步都提醒。
    expect(planRepeatReminder(history(3), { thresholds: [2] }).remind).toBe(false)
  })

  test('传 [2,4]：第 4 次命中第 2 档', () => {
    expect(planRepeatReminder(history(4), { thresholds: [2, 4] }).tier).toBe(2)
  })

  test('阈值乱序也按升序判档位', () => {
    // 排序在读取处做，而不是要求调用方按顺序配：设置面是用户可写的。
    expect(planRepeatReminder(history(4), { thresholds: [4, 2] }).tier).toBe(2)
  })

  test('重复阈值去重后不撞档', () => {
    expect(planRepeatReminder(history(2), { thresholds: [2, 2, 5] }).tier).toBe(1)
  })

  test('传空数组：永不提醒', () => {
    expect(planRepeatReminder(history(8), { thresholds: [] }).remind).toBe(false)
  })

  test('阈值小于 1 的丢掉（不会第 1 次就提醒）', () => {
    expect(planRepeatReminder(history(1), { thresholds: [0, -3] }).remind).toBe(false)
  })
})

describe('⑤ 参数预览：超长被截断，但判定用完整参数', () => {
  /** 800 个 x 的参数：JSON 是 `{"padding":"<800 个 x>"}`，前 12 个字符是固定的键名部分。 */
  const longArgs = { padding: 'x'.repeat(800) }

  test('默认预览上限是 500 字', () => {
    expect(DEFAULT_ARGUMENTS_PREVIEW_CHARS).toBe(500)
  })

  test('默认档只留前 500 字（键名占 12 字 → 488 个 x）', () => {
    // 488 这个数是「截在 500 字符」的精确指纹：截成 400 或 512 都会变。
    const detailed = planRepeatReminder(history(5, { args: longArgs }))
    expect(xCount(detailed.text)).toBe(488)
  })

  test('被截断的预览带省略号（看得出没给全）', () => {
    expect(planRepeatReminder(history(5, { args: longArgs })).text.includes('…')).toBe(true)
  })

  test('截断之后正文显著短于完整参数', () => {
    expect(planRepeatReminder(history(5, { args: longArgs })).text.length < 800).toBe(true)
  })

  test('预览上限可配（配成 20 → 只剩 8 个 x）', () => {
    const short = planRepeatReminder(history(5, { args: longArgs }), { argumentsPreviewChars: 20 })
    expect(xCount(short.text)).toBe(8)
  })

  test('配大之后能看全（2000 字上限 → 800 个 x 一个不少，且没有省略号）', () => {
    const wide = planRepeatReminder(history(5, { args: longArgs }), { argumentsPreviewChars: 2000 })
    expect(xCount(wide.text)).toBe(800)
    expect(wide.text.includes('…')).toBe(false)
  })

  test('第 500 字之后才不同的两份参数算不同（判定用完整串）', () => {
    // 这条是「预览截断不能影响判定」的直接反例：如果拿截断后的预览当键，
    // 两份不同的调用会被当成同一份，提醒就会在错误的时机响。
    const nearlySame: ChatMessage[] = [
      { role: 'user', content: '办完。' },
      assistantCall('read', { padding: 'y'.repeat(600) + 'A' }),
      toolResult(),
      assistantCall('read', { padding: 'y'.repeat(600) + 'B' }),
      toolResult(),
    ]
    const plan = planRepeatReminder(nearlySame)
    expect(plan.count).toBe(1)
    expect(plan.remind).toBe(false)
  })
})

describe('⑥ 文案不在构建函数里：只有 REPEAT_REMINDER_TEXTS 一处，可整份替换', () => {
  /** 一份英文文案：完整替换之后，输出里不该再有任何默认中文。 */
  const english = { gentle: 'gentle reminder', detailed: 'tool {tool} repeated {count} times, limit {limit}: {args}' }

  test('换一份字典之后输出里没有默认中文（构建函数不夹带文案）', () => {
    const plan = planRepeatReminder(history(5), { texts: english })
    expect(plan.text).toBe('tool read repeated 5 times, limit 500: {"path":"README.md"}')
  })

  test('第一档也走字典', () => {
    expect(planRepeatReminder(history(3), { texts: english }).text).toBe('gentle reminder')
  })
})

describe('⑦ 追加：末尾另起一条 user 消息，不提醒时原样返回，重复投影幂等', () => {
  /** 一份再普通不过的请求体：system + 一句用户话。 */
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '办完。' },
  ]

  test('不提醒时 append 原样返回同一个数组', () => {
    // 同一引用是投影链的约定：没改就别造新数组，否则后续投影会误判「历史变了」。
    const quiet = planRepeatReminder(history(2))
    expect(appendRepeatReminder(messages, quiet)).toBe(messages)
  })

  test('提醒时返回新数组、只多一条、角色是 user、正文就是 plan 的文本', () => {
    const loud = planRepeatReminder(history(3))
    const appended = appendRepeatReminder(messages, loud)
    expect(appended).not.toBe(messages)
    expect(appended).toHaveLength(messages.length + 1)
    expect(appended[appended.length - 1]?.role).toBe('user')
    expect(appended[appended.length - 1]?.content).toBe(loud.text)
  })

  test('上一条消息一个字没动', () => {
    const appended = appendRepeatReminder(messages, planRepeatReminder(history(3)))
    expect(appended[1]).toBe(messages[1])
    expect(messages[1]?.content).toBe('办完。')
  })

  test('重复投影幂等（末尾已经在了就不再追加）', () => {
    const loud = planRepeatReminder(history(3))
    const appended = appendRepeatReminder(messages, loud)
    expect(appendRepeatReminder(appended, loud)).toBe(appended)
  })
})

describe('⑧ 尾部没有工具调用时什么都不做', () => {
  test('空历史不提醒', () => {
    expect(planRepeatReminder([]).remind).toBe(false)
  })

  test('只有用户消息不提醒', () => {
    expect(planRepeatReminder([{ role: 'user', content: '你好' }]).remind).toBe(false)
  })

  test('没有工具调用的 assistant 不提醒', () => {
    expect(
      planRepeatReminder([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你的？' },
      ]).remind,
    ).toBe(false)
  })

  test('尾部没有工具调用时 count 是 null（不是 0）', () => {
    // null 与 0 的区别是契约的一部分：0 会被读成「调了 0 次」，null 是「尾部没调用」。
    expect(countRepeatedTail([{ role: 'user', content: '你好' }])).toBeNull()
  })

  test('同一条 assistant 里的两个同参调用算连续 2 次', () => {
    // 并行发两个一样的调用，本来就是挨着的两次调用；漏掉这条会把 count 数成 1。
    const parallel: ChatMessage[] = [
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
    expect(countRepeatedTail(parallel)?.count).toBe(2)
  })
})
