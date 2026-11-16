/**
 * @pneuma/superagent 准入上下文的包级测试：线程窗口的截断与省略计数、缺源时不编邻居、分页只读到上限、
 * 没有话题时回退到群消息且命令调用顺序确定。
 *
 * 为什么这些要单独钉：`admissionContext` 给准入评估喂「有界」上下文，判错不抛错，只会悄悄多读几页
 * （把本该省下的读取变成成本），或用编出来的邻居骗模型。窗口规则是「前 5 条 + 源消息两侧各 5 条」，
 * 省略数只描述本次读到的快照，不冒充完整历史。
 *
 * 假的只有 Commands：对象字面量按调用顺序吐回包好的 lark 响应，并记下每次 argv——被测模块只通过
 * `commands.lark` 取数，所以不必起真子进程。SourceRegistry、feishuKind、SettingsSchema 都用真的，
 * 这样「设置里的 readPageSize 是否真的传到底层命令」也在断言范围内。这里 import 的是 `lib/` 的构建
 * 产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/admission-context
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { admissionContext, threadWindow } = await import('../../../../lib/packages/superagent/sources/admission-context.js')
const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')
const { feishuKind } = await import('../../../../lib/packages/superagent/sources/feishu.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一条线程消息（窗口只认 id；其余字段原样带走）。 */
const message = (index) => ({ id: `om_${index}`, from: 'ou_user', at: String(index), text: `Message ${index}` })

/** 同一条消息在飞书话题页里的样子。 */
const listed = (index) => ({
  message_id: `om_${index}`, chat_id: 'oc_chat', content: `Message ${index}`, msg_type: 'text',
  sender: { id: 'ou_user', sender_type: 'user' }, create_time: String(index),
})

/**
 * 假 Commands：按预设顺序返回 lark 响应，并记下每次 argv。
 * 被测模块只调 `lark`，所以这里不需要真执行任何命令。
 */
function fakeCommands(...responses) {
  const calls = []
  return {
    calls,
    async lark(args) {
      calls.push(args)
      if (responses.length === 0) throw new Error(`unexpected lark call: ${JSON.stringify(args)}`)
      return responses.shift()
    },
  }
}

/** 造一个注册了真 feishuKind 的来源注册表；`sources` 传进真 SettingsSchema。 */
function registryWith(sources = {}) {
  const registry = new SourceRegistry(() => SettingsSchema.parse({ sources }))
  registry.register(feishuKind)
  return registry
}

// ── 1. 纯窗口函数 ───────────────────────────────────────────────────────────

test('窗口取线程开头 5 条 + 源消息两侧各 5 条，内部缺口与尾部省略数如实记', () => {
  const result = threadWindow(Array.from({ length: 40 }, (_, i) => message(i)), 'om_25')
  assert.deepEqual(result.entries.map((item) => item.position), [1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
  assert.equal(result.entries[5].omitted_before, 15, '开头 5 条与源消息窗口之间隔了 15 条')
  assert.equal(result.omitted_after, 9)
  assert.equal(result.source_found, true)
  passed += 1
})

test('重叠窗口去重；源消息不在本次快照里时不编邻居', () => {
  const messages = Array.from({ length: 12 }, (_, i) => message(i))
  assert.deepEqual(threadWindow(messages, 'om_3').entries.map((item) => item.position), [1, 2, 3, 4, 5, 6, 7, 8, 9],
    '源消息靠前时，两个窗口重合，位置不能出现两遍')
  const absent = threadWindow(messages, 'om_absent')
  assert.equal(absent.source_found, false)
  assert.equal(absent.loaded_messages, 12)
  assert.equal(absent.omitted_after, 7, '没找到源消息：只留开头 5 条，尾部省略数照样算')
  assert.deepEqual(absent.entries.map((item) => item.position), [1, 2, 3, 4, 5], '不凭空补出源消息附近的条目')
  passed += 1
})

// ── 2. 分页：规则是「最多 maxPages 页」，不是「宣称完整」────────────────────

test('只读到 maxPages 页：complete=false 且带上下一页游标，loaded_messages 只算读到的', async () => {
  const commands = fakeCommands(
    { items: [{ message_id: 'om_9', chat_id: 'oc_chat', thread_id: 'omt_thread' }] },
    { thread_id: 'omt_thread', messages: [listed(0), listed(1)], has_more: true, page_token: 'next' },
  )
  const trigger = {
    id: 'event', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_chat:om_9' }],
    actor: { source: 'feishu', id: 'ou_user' }, human: true, text: 'Trigger', at: '',
    meta: { chatId: 'oc_chat', messageId: 'om_9', direct: false, mentioned: false },
  }
  const sources = registryWith({ feishu: { enabled: true, config: { readPageSize: 2 } } })
  const result = await admissionContext(sources.threadContext(trigger), commands, 1)
  assert.equal(result.complete, false, '只读了 1 页，不能宣称完整')
  assert.equal(result.next, 'next')
  assert.equal(result.window.loaded_messages, 2)
  assert.equal(result.window.source_found, false, '源消息 om_9 不在读到的两页里')
  assert.equal(commands.calls.length, 2, '一次读源消息、一次读话题页')
  const pageArgs = commands.calls[1]
  assert.equal(pageArgs.includes('--page-size'), true)
  assert.equal(pageArgs[pageArgs.indexOf('--page-size') + 1], '2', '设置里的 readPageSize 要真的传到底层命令')
  passed += 1
})

// ── 3. 没有话题：回退到源消息之前的 5 条群消息，并声明读的是群 ──────────────

test('消息不在话题里时取它之前的 5 条群消息，status 声明 chat_neighbours', async () => {
  const at = Date.parse('2026-09-11T12:00:00Z')
  const item = (n) => ({
    message_id: `om_${n}`, chat_id: 'oc_chat', create_time: String(at + n * 1000),
    sender: { id: 'ou_user', sender_type: 'user' }, body: { content: JSON.stringify({ text: `message ${n}` }) },
  })
  const commands = fakeCommands(
    { items: [{ message_id: 'om_0', chat_id: 'oc_chat' }] },
    { items: [0, -1, -2, -3, -4, -5].map(item), has_more: true, page_token: 'older' },
  )
  const trigger = {
    id: 'event', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_chat:om_0' }],
    actor: { source: 'feishu', id: 'ou_user' }, human: true, text: 'message 0', at: new Date(at).toISOString(),
    meta: { chatId: 'oc_chat', messageId: 'om_0', direct: false, mentioned: false },
  }
  const sources = registryWith()
  const result = await admissionContext(sources.threadContext(trigger), commands, 3)
  assert.equal(result.status, 'chat_neighbours')
  assert.equal(result.complete, true, '回退读的是一页有界群消息，没有可续游标')
  assert.equal(result.window.source_found, true)
  assert.equal(result.window.loaded_messages, 6)
  assert.deepEqual(result.messages.map((entry) => entry.id), [-5, -4, -3, -2, -1, 0].map((n) => `om_${n}`),
    '按时间旧到新排列，源消息在最后')
  assert.equal(commands.calls.length, 2, '一次读源消息、一次读群历史，不额外翻页')
  passed += 1
})
