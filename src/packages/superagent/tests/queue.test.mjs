/**
 * @pneuma/superagent 遗留队列迁移与通知合并的包级测试，转写自上游 `tests/queue.spec.ts`。
 *
 * 上游 spec 的 import 头只有 `./fixtures/host.ts`（起真 Runtime），测两件事：
 *   1. schema 10 库里的旧主会话队列（relay 队列、取消订阅结果、Prompt / 设置通知）在打开库时迁进统一 effect 队列，
 *      真投递出去，旧 KV 键清掉；
 *   2. 主会话收不了通知时，连续两次暂停/恢复只留最新一条，恢复后只注入一次。
 * 映射到本仓：第 1 条落在 `app/migration.ts` 的 `queueEarlierWork`（`migrateTo11` 的一段，schema 10 → 11），
 * 第 2 条落在 `app/settings.ts` 的 `pause` + `app/notices.ts` 的 `settingsNotice` + `app/effects.ts` 的合并。
 * 上游断言 `runtime.health.notice` 总格的那半句在新树没有对应物，由 `health.test.mjs` 的 kind 级投影覆盖，这里不重复。
 *
 * 假件只有 `sessions.notify` / `sessions.delivery` 的桥（照 `app/sessions.ts:356-361` 的三行实现）与 notice 处理器；
 * `Store`、`Effects`、`Settings`、`HealthBoard` 全是真的，数据落在 tmpdir 的临时库里，不碰 `~/.dsc`。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/queue
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const { Store } = await import('../../../../lib/packages/superagent/app/store.js')
const { Effects } = await import('../../../../lib/packages/superagent/app/effects.js')
const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')
const { Settings } = await import('../../../../lib/packages/superagent/app/settings.js')
const { KV } = await import('../../../../lib/packages/superagent/kv.js')
const { OLDEST_SCHEMA } = await import('../../../../lib/packages/superagent/app/migration.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')
const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

/** 整个文件共用一个临时根：`~/.dsc` 一次都不碰。 */
const sharedRoot = mkdtempSync(join(tmpdir(), 'superagent-queue-'))
after(() => {
  rmSync(sharedRoot, { recursive: true, force: true })
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一个用例一个临时目录。 */
function tempDir(label) {
  return mkdtempSync(join(sharedRoot, `${label}-`))
}

/**
 * 造一个最后一个 schema 10 版本形状的库：先按当前形状建库，再把版本号写回 10 并塞进遗留 KV。
 * 表结构保持当前形状（遗留 `outbox.sent` 列的迁移由 `migration.test.mjs` 负责，不在这里重复）。
 */
function legacyDatabase(label, legacy) {
  const dir = tempDir(label)
  const path = join(dir, 'orchestrator.sqlite')
  new Store(path).close()
  const db = new DatabaseSync(path)
  const set = (key, value) => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
  set('schema', OLDEST_SCHEMA)
  for (const [key, value] of Object.entries(legacy)) set(key, value)
  db.close()
  return { dir, path }
}

// ── 1. 遗留队列迁移（上游用例 1）───────────────────────────────────────────

test('迁移把 schema 10 的 relay、取消订阅、Prompt 与设置通知排进 effect 队列并投递出去，旧键清掉', async () => {
  const { dir, path } = legacyDatabase('earlier-work', {
    'relay-queue': [{ id: 'report:old', text: JSON.stringify({ kind: 'worker_report', ticket_id: 't1', state: 'ready' }) }],
    'subscription-results': ['github:7'],
    'prompt-notification': 3,
    'settings-notification': 5,
  })
  const store = new Store(path)
  // 迁移写 effect 行时用的是真钟（`Date.now()`），所以这里也拿真钟当基线的假时钟，否则到点判定永远不到。
  const effects = new Effects(store, new HealthBoard(), () => Date.now())
  const steered = []
  const notices = []
  effects.handle('relay', async ({ text }, requestId) => { steered.push({ requestId, text: JSON.parse(text) }) }, { ordered: true })
  effects.handle('notice', async ({ value }, name) => { notices.push({ name, value }) }, { ordered: true })
  effects.start()
  try {
    await effects.idle()
    assert.deepEqual(steered, [{ requestId: 'report:old', text: { kind: 'worker_report', ticket_id: 't1', state: 'ready' } }],
      'relay 队列按原 id 与原文投递')
    assert.deepEqual(notices, [
      { name: 'subscription:github:7', value: { subscription_changes: [{ thread: 'github:7', removed: true }] } },
      { name: 'prompts', value: { prompt_config_saved: 3, effect: 'next-request', read: 'prompts/3' } },
      { name: 'settings', value: { settings_saved: true, read: 'settings' } },
    ], '三类通知按「取消订阅 → Prompt → 设置」的顺序各排一条')
    assert.equal(effects.pending('relay') || effects.pending('notice'), false, '投递完队列里没有残留')
    for (const name of [KV.queues.relays, KV.queues.unsubscribed, KV.queues.prompts, KV.queues.settings]) {
      assert.equal(store.get(name), undefined, `旧键 ${String(name)} 迁移后删掉`)
    }
    passed += 1
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 2. 主会话收不了时只留最新一条设置通知（上游用例 2）─────────────────────

test('主会话收不了通知时，暂停与恢复只留最新一条，恢复后只注入一次', async () => {
  const dir = tempDir('settings-notice')
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse({}))
  const board = new HealthBoard()
  let clock = Date.parse('2026-09-09T00:00:00Z')
  const effects = new Effects(store, board, () => clock)
  const injected = []
  let injectFails = true
  effects.handle('notice', async ({ value, summary }, name) => {
    if (injectFails) throw new Error('session busy')
    injected.push({ name, value, summary })
  }, { ordered: true })
  effects.start()
  // 与 `app/sessions.ts:356-361` 同形的桥：notify 入队、delivery 等一轮后看还在不在。
  const sessions = {
    notify: (name, value, summary) => effects.enqueue('notice', name, { value, summary }),
    delivery: async (name) => { await effects.idle('notice'); return effects.pending('notice', name) ? 'pending' : 'injected' },
  }
  const controller = new AbortController()
  const settings = new Settings({ store, sources: new SourceRegistry(() => store.settings()), engine: { policyChanged() {} }, health: board,
    context: {}, lifetime: controller.signal, sessions, sourceHost: {}, requestPass() {},
    setup: { configured: () => true, checkAccounts: async () => {}, blockCommands: async () => {}, restart: () => {} } })
  try {
    assert.deepEqual(await settings.pause(true, 'panel'), { paused: true })
    assert.equal((await settings.pause(false, 'panel')).paused, false)
    assert.equal(effects.pending('notice', 'settings:pause'), true, '收不了时只留一条待投递的通知')
    assert.deepEqual(injected, [], '两次暂停都没能注入')
    injectFails = false
    clock += 2000
    await effects.idle('notice')
    assert.deepEqual(injected, [{
      name: 'settings:pause',
      value: { settings_saved: 'pause', changed: ['paused'], read: 'settings/pause' },
      summary: 'Settings saved: pause',
    }], '恢复后只注入一次，内容是最后一次保存的那条')
    assert.equal(effects.pending('notice', 'settings:pause'), false)
    passed += 1
  } finally {
    controller.abort()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
