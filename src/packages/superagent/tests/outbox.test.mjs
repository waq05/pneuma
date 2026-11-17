/**
 * @pneuma/superagent 出站投递的包级测试，转写自上游 `tests/outbox.spec.ts`（2 条用例）：
 *   1. 处理暂停时消息停在 `pending`，恢复后才发出去；
 *   2. 来源没装时消息留待重试，kind 注册后按首次退避（5 秒）发出去。
 *
 * 上游这两条跑在一整套 `startRuntime()` 夹具上，还用假飞书 CLI 断言「命令行里出现了消息正文」。
 * 这里换成同样的接线、更小的宿主：真 `Store`（临时目录 sqlite，收条表、生成列、`behind` 全是真
 * 实现）、真 `Effects`、真 `HealthBoard`、真 `Outbox`，只把 `SourceRegistry` 与 `Commands` 换成
 * 对象字面量——本文件要证的是 Outbox 自己的「落收条 → 排 reply 效果 → 暂停 / 重试 / 发送 →
 * 结状态」链路，不是 CLI 解析或来源配置（那两块分别由 commands 与 source-registry 的测试负责）。
 * 上游断言假 CLI 收到了正文，这里断言假 registry 的 `send` 收到了同一条消息。
 *
 * 时钟注入给 `Effects`：5 秒退避直接拨表，不用假定时器，也不真等。全程临时目录，不碰 `~/.dsc`。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/outbox
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const { Store } = await import('../../../../lib/packages/superagent/app/store.js')
const { Effects } = await import('../../../../lib/packages/superagent/app/effects.js')
const { Outbox } = await import('../../../../lib/packages/superagent/app/outbox.js')
const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

/** 每个用例一个临时目录，`after` 统一删。 */
const roots = []

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})

/**
 * 造一套 Outbox 宿主：真库 / 真队列 / 真健康板，假来源注册表。
 *
 * @param options - `paused` 指定初始暂停状态
 */
function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-outbox-'))
  roots.push(dir)
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  const board = new HealthBoard()
  let clock = Date.parse('2026-09-09T00:00:00Z')
  let paused = options.paused ?? false
  const effects = new Effects(store, board, () => clock)
  const installed = new Map()
  /** 假 registry 记录「发出去的消息」，对应上游断言的假飞书 CLI 调用参数。 */
  const sent = []
  const sources = {
    instance: (source) => installed.get(source),
    channelAllowed: () => true,
    send: async (message) => { sent.push(message); return 'sent' },
  }
  const outbox = new Outbox({ store, effects, sources, commands: {}, paused: () => paused })
  effects.start()
  return {
    outbox,
    store,
    board,
    effects,
    sent,
    /** 让某个来源的 kind「已安装且启用」；`Outbox` 只读 `enabled`。 */
    register(source) { installed.set(source, { id: source, kind: source, enabled: true, config: {} }) },
    /** 切换处理暂停态：暂停时 reply 效果的并发上限是 0。 */
    pause(value) { paused = value },
    /** 拨动假时钟。 */
    advance(ms) { clock += ms },
    /** 上游的 `runtime.sendReplies()`：等 reply 效果排空。 */
    sendReplies() { return outbox.sent() },
    /** 关库；目录由 `after` 删。 */
    cleanup() { store.close() },
  }
}

test('处理暂停时消息停在 pending，恢复后发出去', async () => {
  const h = setup({ paused: true })
  try {
    h.register('feishu')
    h.outbox.send({ id: 'held', channel: { source: 'feishu', thread: 'feishu:1', address: {} }, text: '已合并。', kind: 'notice' })
    await h.sendReplies()
    assert.deepEqual([h.outbox.status('held'), h.sent.length], ['pending', 0], '暂停时既不发送也不结状态')
    assert.equal(h.board.all.reply?.state, 'ready', '有等待行但没失败，体检项就绪')
    h.pause(false)
    await h.sendReplies()
    assert.equal(h.outbox.status('held'), 'sent', '恢复后结状态')
    assert.ok(h.sent.some((message) => message.text === '已合并。'), '发出去的是同一条消息')
    passed += 1
  } finally {
    h.cleanup()
  }
})

test('来源没装时消息等待；kind 注册后按 5 秒退避重试发出去', async () => {
  const h = setup()
  try {
    h.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
    await h.sendReplies()
    assert.deepEqual([h.outbox.status('waiting'), h.board.all.reply?.state], ['pending', 'ready'], '来源没装：留待重试，体检就绪')
    h.register('probe')
    h.advance(5000)
    await h.sendReplies()
    assert.deepEqual([h.outbox.status('waiting'), h.sent.map((message) => message.id)], ['sent', ['waiting']], '5 秒后重试并发出')
    passed += 1
  } finally {
    h.cleanup()
  }
})
