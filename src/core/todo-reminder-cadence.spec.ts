/**
 * todo 节流提醒的**注入节流台账**（迁自 `scripts/todo-reminder-cadence-test.mjs` 的纯逻辑段）。
 *
 * ## 这份台账为什么存在（缺陷现场）
 *
 * 提醒是「每 N 轮一次」，不是「越过 N 轮之后每一跳都补」。`appendTodoReminder` 的幂等判据
 * 查「历史里有没有这条提醒」，而提醒是投影注入、不落历史（`core/todo-reminder.ts` 文件头写了
 * 为什么刻意不落）。于是「距上次写清单已 ≥ N 轮」一旦成立，之后每一跳都满足，**每一跳都再
 * 补一次同一句提醒**：12 轮跑下来实际只需要 1 条，却发了 4 条。
 *
 * 修法是把判据从「历史里有没有」换成「本轮 − 上次注入的轮 ≥ everyRounds」，并按会话记账。
 * 这一层全在轮号上，差一就整段红，所以单独一张网。
 *
 * ## 迁移时删掉的一条
 *
 * 原探针第 [6] 节是五条**源码文本断言**：`packages/todo/index.ts` 里「import 了台账模块、
 * 构造了台账、`due` 在 `appendTodoReminder` 之前、`mark` 在「没补就原样返回」之后」。
 * 三条顺序断言按本批规矩不搬（测的是文件里的字符位置）。它们想守的语义——「投影真的在用
 * 台账，且只在真注入时记账」——由同批迁进 integration 的 18 轮端到端用例逐条钉住：
 * 拆掉台账，那一段会从「只注入 2 次」变成「第 10..19 次每跳一条」，当场红。
 *
 * @module dsc/core/todo-reminder-cadence.spec
 */
import { beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage } from './llm.js'
import { TodoReminderCadence, countRounds } from './todo-reminder-cadence.js'
import { TODO_REMINDER_TEXT, appendTodoReminder } from './todo-reminder.js'

const userMsg = (text: string): ChatMessage => ({ role: 'user', content: text })
const assistantMsg = (text: string): ChatMessage => ({ role: 'assistant', content: text })
const todoWriteMsg = (): ChatMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'todo_write', arguments: '{}' } }],
})
const toolResultMsg = (): ChatMessage => ({ role: 'tool', content: '清单已更新（1/1 完成）', tool_call_id: 'c1' })

/**
 * 造一份「正好第 round 轮」的请求：开场写了 todo_write（那条 assistant 自己算 1 轮），
 * 之后每轮一条 assistant，于是 `countRounds` 恰好等于 round。
 *
 * 用这个而不是「写完之后再接 n 条」：本文件的判据全在轮号上，差一就整段红。
 */
function historyAtRound(round: number): ChatMessage[] {
  const messages: ChatMessage[] = [userMsg('第一步'), todoWriteMsg(), toolResultMsg()]
  for (let index = 0; index < round - 1; index += 1) messages.push(assistantMsg(`第 ${String(index + 1)} 轮`))
  return messages
}

/** 提醒是否在这份消息里（与投影的正文逐字比较）。 */
const hasReminder = (messages: readonly ChatMessage[]): boolean =>
  messages.some((message) => message.role === 'user' && message.content === TODO_REMINDER_TEXT)

/**
 * 复刻投影那两步（`due` → 试注入 → 真补了才 `mark`），返回这一跳的结论与是否真的补了。
 *
 * 端到端那一段用的是真内核；这个函数只把「同一轮重复投影」这类边界钉死。
 */
function projectOnce(
  cadence: TodoReminderCadence,
  sessionId: string,
  messages: ChatMessage[],
  everyRounds: number,
): { injected: boolean; out: ChatMessage[] } {
  if (!cadence.due(sessionId, countRounds(messages), everyRounds)) return { injected: false, out: messages }
  const out = appendTodoReminder(messages, { enabled: true, everyRounds, hasOpenTodos: true })
  if (out === messages) return { injected: false, out }
  cadence.mark(sessionId, countRounds(messages))
  return { injected: true, out }
}

describe('① 轮号：一轮 = 一条 assistant 消息', () => {
  test('3 轮 = 3', () => {
    expect(countRounds(historyAtRound(3))).toBe(3)
  })

  test('空历史是第 0 轮', () => {
    expect(countRounds([])).toBe(0)
  })

  test('user / tool 不算轮', () => {
    // 只数 assistant：user 是这一轮的开头（还没答），tool 是这一步的中间产物。
    // 按 user 数会让工具密集的回合提前喷提醒；按 tool 数会在工具往返里反复触发。
    expect(countRounds([userMsg('a'), toolResultMsg(), userMsg('b')])).toBe(0)
  })

  test('todo_write 自己那条 assistant 算一轮', () => {
    expect(countRounds([userMsg('a'), todoWriteMsg(), toolResultMsg()])).toBe(1)
  })

  test('环境快照那条 user 不算轮', () => {
    // env 快照是投影追加的 user 消息，正文固定；它若算轮，每份请求都会凭空多一轮。
    expect(countRounds([...historyAtRound(3), userMsg('当前这轮'), userMsg('环境事实：…')])).toBe(3)
  })
})

describe('② 台账：首次必注入、之后每 everyRounds 轮一次', () => {
  const every = 8
  let cadence: TodoReminderCadence

  // 这一节按时间顺序走同一条台账，用 beforeAll 而不是每条自建：
  // 「首次记账 → 中间几轮沉下去 → 到点又响」本身就是一条状态机，拆开就验不到推进。
  beforeAll(() => {
    cadence = new TodoReminderCadence()
  })

  test('① 台账空 → 首次注入（due 为 true）', () => {
    expect(cadence.due('s1', 0, every)).toBe(true)
  })

  test('① 首次：真的往请求末尾补了一条', () => {
    // 第 9 轮（0 基第 9 条 assistant）真的补上了，于是记账。
    const injected = projectOnce(cadence, 's1', historyAtRound(9), every)
    expect(injected.injected).toBe(true)
    expect(hasReminder(injected.out)).toBe(true)
  })

  test('首次注入的那一轮就是现在这一轮（同一轮重复投影仍然 due）', () => {
    // invariant 二次派生会把同一轮投影两遍；第二遍若给 false，两遍产物就不一致、当场报错。
    expect(cadence.due('s1', 9, every)).toBe(true)
  })

  test('② 第 10..16 轮不注入（N+1..N+everyRounds−1 全 false）', () => {
    const blocked: boolean[] = []
    for (let round = 10; round <= 16; round += 1) blocked.push(cadence.due('s1', round, every))
    expect(blocked.every((value) => value === false)).toBe(true)
  })

  test('② 第 12 轮投影一次：没有补提醒', () => {
    const skipped = projectOnce(cadence, 's1', historyAtRound(12), every)
    expect(skipped.injected).toBe(false)
    expect(hasReminder(skipped.out)).toBe(false)
  })

  test('③ 第 16 轮仍然不注入（差一轮也不行）', () => {
    expect(cadence.due('s1', 16, every)).toBe(false)
  })

  test('③ 第 17 轮（9+8）又该注入，且真的又补了一条', () => {
    expect(cadence.due('s1', 17, every)).toBe(true)
    const again = projectOnce(cadence, 's1', historyAtRound(17), every)
    expect(again.injected).toBe(true)
    expect(hasReminder(again.out)).toBe(true)
  })

  test('③ 记完账之后立刻又沉下去（第 18 轮不注入）', () => {
    expect(cadence.due('s1', 18, every)).toBe(false)
  })
})

describe('③ everyRounds 可配（含 0 / 负数 / 小数）', () => {
  test('everyRounds=3：+1 不注入、+2 不注入、+3 注入', () => {
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 100)
    expect(cadence.due('s1', 101, 3)).toBe(false)
    expect(cadence.due('s1', 102, 3)).toBe(false)
    expect(cadence.due('s1', 103, 3)).toBe(true)
  })

  test('everyRounds=1：下一轮就注入', () => {
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 100)
    expect(cadence.due('s1', 101, 1)).toBe(true)
  })

  test('everyRounds=0 夹到 1（下一轮就注入，不是永远不注入）', () => {
    // 配置面是用户可写的；不夹取时 `round - last >= 0` 会让「刚提醒过」也成立。
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 100)
    expect(cadence.due('s1', 101, 0)).toBe(true)
  })

  test('everyRounds 为负数同样夹到 1', () => {
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 100)
    expect(cadence.due('s1', 101, -5)).toBe(true)
  })

  test('everyRounds=2.9 向下取整成 2：+1 不注入、+2 注入', () => {
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 100)
    expect(cadence.due('s1', 101, 2.9)).toBe(false)
    expect(cadence.due('s1', 102, 2.9)).toBe(true)
  })
})

describe('④ 两个会话互不影响 / 换会话重新开始', () => {
  test('⑤ s1 刚提醒过（第 10 轮不注入）、s2 自己那一轮还早（第 4 轮不注入）', () => {
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 9)
    cadence.mark('s2', 3)
    expect(cadence.due('s1', 10, 8)).toBe(false)
    expect(cadence.due('s2', 4, 8)).toBe(false)
  })

  test('⑤ s2 到点照样注入（3+8=11），且不影响 s1 的账', () => {
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 9)
    cadence.mark('s2', 3)
    expect(cadence.due('s2', 11, 8)).toBe(true)
    expect(cadence.due('s1', 11, 8)).toBe(false)
  })

  test('⑥ 新会话 id（台账里没有）→ 首次必注入', () => {
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 9)
    expect(cadence.due('s3', 11, 8)).toBe(true)
  })

  test('⑥ 新会话即使轮号很大也照样注入（是「这一条会话」没记过）', () => {
    // 反例：若按「全局上一次注入轮号」记账，切到一条老会话（轮号 500）会被判成刚提醒过，
    // 于是那条会话永远收不到提醒。
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 9)
    expect(cadence.due('s4', 500, 8)).toBe(true)
  })
})

describe('⑤ 边角：轮号倒退、同一轮重复投影、同一轮真的重试', () => {
  test('压缩后轮号倒退（100 → 20）→ 台账失效，当首次', () => {
    // 压缩把历史换成摘要，轮号不在同一条数轴上了；不改判会把之后几十轮全挡住。
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 100)
    expect(cadence.due('s1', 20, 8)).toBe(true)
  })

  test('倒退之后再记账，回到正常周期', () => {
    const cadence = new TodoReminderCadence()
    cadence.mark('s1', 100)
    expect(cadence.due('s1', 20, 8)).toBe(true)
    cadence.mark('s1', 20)
    expect(cadence.due('s1', 21, 8)).toBe(false)
  })

  test('同一轮重复投影：两遍都补提醒、产物逐字节相同', () => {
    // invariant 的二次派生要求同一份输入跑两遍结论与产物一致；不一致就报「对不上」。
    const cadence = new TodoReminderCadence()
    const history = historyAtRound(9)
    const first = projectOnce(cadence, 's1', history, 8)
    const second = projectOnce(cadence, 's1', history, 8)
    expect(first.injected).toBe(true)
    expect(second.injected).toBe(true)
    expect(JSON.stringify(first.out)).toBe(JSON.stringify(second.out))
  })

  test('同一轮重试（轮号不变）仍然 due，之后下一轮照常沉下去', () => {
    // 流中断后整轮重试：模型第二次看到的请求必须和第一次一样，否则「重试」等于换了问题。
    const cadence = new TodoReminderCadence()
    const first = projectOnce(cadence, 's1', historyAtRound(9), 8)
    expect(first.injected).toBe(true)
    expect(cadence.due('s1', 9, 8)).toBe(true)
    expect(cadence.due('s1', 10, 8)).toBe(false)
  })
})
