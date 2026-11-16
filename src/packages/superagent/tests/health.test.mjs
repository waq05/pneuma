/**
 * @pneuma/superagent 组件体检投影的包级测试，转写自上游 `tests/health.spec.ts`。
 *
 * 上游 spec 的 import 头是 `../src/infra/commands.ts` 与 `./fixtures/host.ts`（起真 Runtime），它测的并不是
 * `infra/health.ts` 的板子本身，而是「effect 连续失败三次后，那个 kind 的体检格变 error；成功一次后恢复；
 * 各 kind 互不干扰」。本仓对应的新树是 `app/effects.ts` 的 kind 级体检投影（`FAILURES_BEFORE_ERROR` +
 * `report` / `failed`），板子用真的 `infra/health.ts`：
 *   - 板子的单写者 / 释放语义已由 `infra-health.test.mjs` 覆盖，这里不重复；
 *   - `app/retry-health.ts`（模型预算重试投影）已由 `retry-health.test.mjs` 覆盖，这里也不重复。
 *
 * 与上游的一处映射差异：上游断言里的 `runtime: { state: 'ready' }` 是 Runtime 自己报的总格；本仓新树没有这格，
 * 总状态由 `host/health.ts` 从 `runtime.health` 汇总给 `/doctor`，**该断言跳过**，并在用例名里写明。
 *
 * 假件只有时钟与三个 kind 的处理器；`Store`、`Effects`、`HealthBoard` 全是真的，数据落在 tmpdir 的临时库里，
 * 不碰 `~/.dsc`。这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/health
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const { Store } = await import('../../../../lib/packages/superagent/app/store.js')
const { Effects, FAILURES_BEFORE_ERROR } = await import('../../../../lib/packages/superagent/app/effects.js')
const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

/** 整个文件共用一个临时根：`~/.dsc` 一次都不碰。 */
const sharedRoot = mkdtempSync(join(tmpdir(), 'superagent-health-'))
after(() => {
  rmSync(sharedRoot, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 起始假时钟：退避靠拨表瞬移，不真等。 */
const EPOCH = Date.parse('2026-09-09T00:00:00Z')
const iso = (ms) => new Date(ms).toISOString()

/**
 * 一套：临时库 + 真健康板 + 真 Effects（可注入假时钟）；`start()` 已调用。
 *
 * @param label - 目录名后缀，失败时能看出是哪条用例
 * @param handlers - `{ kind: run }`；limit / retry / ordered 用默认值
 */
function setup(label, handlers = {}) {
  const dir = mkdtempSync(join(sharedRoot, `${label}-`))
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  const board = new HealthBoard()
  let clock = EPOCH
  const effects = new Effects(store, board, () => clock)
  effects.start()
  for (const [kind, run] of Object.entries(handlers)) effects.handle(kind, run, kind === 'relay' || kind === 'notice' ? { ordered: true } : {})
  return {
    store,
    board,
    effects,
    /** 拨动假时钟（毫秒）。 */
    advance(ms) { clock += ms },
    /** 等当前能跑的 effect 跑完。 */
    idle: () => effects.idle(),
    /** 关库并删目录。 */
    cleanup() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * 让 `kind` 的行连续失败到体检格报错（三次失败）。
 * @returns 最后一次失败后的时钟位置
 */
async function failThrice(h, kind) {
  await h.idle()
  h.advance(2000)
  await h.idle()
  h.advance(4000)
  await h.idle()
}

// ── 1. kind 登记：每个 effect kind 在板子上占自己一格 ───────────────────────

test('每个 effect kind 登记后都在板子上占一格，初始是「Nothing waiting」', () => {
  const h = setup('claim', { relay: async () => {}, notice: async () => {}, reply: async () => {} })
  try {
    assert.deepEqual(Object.keys(h.board.all), ['relay', 'notice', 'reply'], '三个 kind 各占一格，互不覆盖')
    for (const [name, entry] of Object.entries(h.board.all)) {
      assert.deepEqual(entry, { state: 'ready', detail: 'Nothing waiting', at: iso(EPOCH) }, `${name} 登记时没有等着的行`)
    }
    passed += 1
  } finally {
    h.cleanup()
  }
})

// ── 2. 连续失败三次报错、成功一次后恢复（上游用例 1 的 relay 语义）─────────

test('连续失败三次后该 kind 报 error，成功一次后回到 ready 与「Nothing waiting」', async () => {
  assert.equal(FAILURES_BEFORE_ERROR, 3, '报错门槛是三次')
  let fail = 3
  const h = setup('relay-error', { relay: async () => { if (fail > 0) { fail -= 1; throw new Error('session busy') } } })
  try {
    h.effects.enqueue('relay', 'r1', { text: '{"kind":"note"}' })
    await h.idle()
    assert.deepEqual([h.board.all.relay?.state, h.board.all.relay?.detail],
      ['ready', `1 waiting since ${iso(EPOCH)}`], '失败一次还没到三次：仍报就绪，detail 说还有一条在等')
    await failThrice(h)
    assert.equal(h.board.all.relay?.state, 'error', '第三次失败起报 error')
    assert.match(h.board.all.relay?.detail ?? '', /session busy/, 'error 的 detail 带最后一条失败原文')
    h.advance(8000)
    await h.idle()
    assert.deepEqual([h.board.all.relay?.state, h.board.all.relay?.detail], ['ready', 'Nothing waiting'], '成功一次后恢复')
    assert.equal(h.effects.pending('relay'), false, '恢复后队列里也没有残留')
    passed += 1
  } finally {
    h.cleanup()
  }
})

// ── 3. 各 kind 的体检互不干扰（上游用例 2：relay 与 reply）──────────────────

test('一个 kind 报错期间另一个 kind 照样恢复，两边的 error 与 detail 各说各的', async () => {
  let relayDown = true, replyFails = 3
  const h = setup('isolation', {
    relay: async () => { if (relayDown) throw new Error('master gone') },
    reply: async () => { if (replyFails > 0) { replyFails -= 1; throw new Error('internal error (2200)') } },
  })
  try {
    h.effects.enqueue('relay', 'r2', { text: '{"kind":"note"}' })
    h.effects.enqueue('reply', 'stuck', {})
    await failThrice(h)
    assert.deepEqual([h.board.all.relay?.state, h.board.all.reply?.state], ['error', 'error'], '两个 kind 各自连续失败三次')
    assert.match(h.board.all.relay?.detail ?? '', /master gone/)
    assert.match(h.board.all.reply?.detail ?? '', /2200/)

    // reply 恢复：relay 的 error 保持。
    replyFails = 0
    h.advance(8000)
    await h.idle()
    assert.deepEqual([h.board.all.relay?.state, h.board.all.reply?.state], ['error', 'ready'], 'reply 恢复不改 relay 的格子')

    // relay 再失败一次也仍是 error；随后放开 relay，两边都恢复。
    h.advance(32_000)
    await h.idle()
    assert.equal(h.board.all.relay?.state, 'error', 'relay 一直失败：格子保持 error')
    relayDown = false
    h.advance(32_000)
    await h.idle()
    assert.deepEqual([h.board.all.relay?.state, h.board.all.relay?.detail, h.board.all.reply?.state], ['ready', 'Nothing waiting', 'ready'],
      'relay 恢复后两边都就绪')
    passed += 1
  } finally {
    h.cleanup()
  }
})
