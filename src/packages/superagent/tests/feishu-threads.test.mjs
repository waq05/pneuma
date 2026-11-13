/**
 * @pneuma/superagent 的「飞书话题轮询端口」测试：离线、不联网、不读用户真实的 `~/.dsc`。
 *
 * 六条用例，每条钉一件「改错了只会静默漏消息」的判断：
 *   1. `subscribed` 只给这个来源的话题（GitHub 的话题不能混进来）；
 *   2. 14 天视野：最近有消息的在里面，静了两周的出去；
 *   3. 有活工单订阅着的话题，即使静了两周也还要轮询；
 *   4. 订阅它的工单都结束了 → 不再轮询（结束的订阅会留在历史里，拿它当活就永远停不下来）；
 *   5. `latest` 给的是「按发生时刻最新」的那条，不是最后写入的那条；陌生话题给 `undefined`；
 *   6. `patch` 合并属性、`undefined` 删键、陌生话题不抛也不新建。
 *
 * 话题与 Trigger 由测试直接写进库（`StoreRepositories`），因为这几条判断读的就是库里的形状；
 * 时钟由 `now` 注入，库在 `tmpdir()` 下的临时 `DSC_HOME` 里。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/feishu-threads
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// 必须在 import lib/ 之前把 DSC_HOME 指到临时目录，否则会读走开发者真实的 ~/.dsc。
const home = mkdtempSync(join(tmpdir(), 'superagent-threads-home-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { StoreRepositories } = await import('../../../../lib/packages/superagent/adapters/repositories.js')
const { SuperagentRuntime } = await import('../../../../lib/packages/superagent/runtime.js')

/** 固定「现在」：2026-09-10，于是 14 天视野的边界是 2026-08-27。 */
const AT = '2026-09-10T00:00:00.000Z'
const RECENT = '2026-09-09T00:00:00.000Z'
const OLD = '2026-08-01T00:00:00.000Z'

const roots = [home]

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
})

/** 一个用例一份临时根目录、一个库、一个运行期；用完按「运行期 → 库」的顺序关。 */
async function withRuntime(work) {
  const root = mkdtempSync(join(tmpdir(), 'superagent-threads-'))
  roots.push(root)
  process.env['DSC_HOME'] = root
  const store = openStore()
  const runtime = new SuperagentRuntime(store, { now: () => AT, log: () => {} })
  try {
    return await work({ runtime, store, repos: new StoreRepositories(store.handle) })
  } finally {
    runtime.close()
    store.close()
  }
}

/** 一条话题；只填轮询判断要用的字段。 */
const thread = (source, id, at, extra = {}) => ({
  key: `${source}:${id}`,
  ref: { source, id },
  createdAt: OLD,
  lastAt: at,
  subscriptions: [],
  correlated: [],
  pending: [],
  meta: {},
  ...extra,
})

/** 一条 Trigger：`latestOn` 只读 index 里的 (thread, id, at)，其余字段是装配形状用的。 */
const trigger = (id, key, at) => ({
  id,
  source: key.slice(0, key.indexOf(':')),
  threads: [{ source: key.slice(0, key.indexOf(':')), id: key.slice(key.indexOf(':') + 1) }],
  actor: { id: 'ou_1' },
  human: true,
  addressed: 'mention',
  at,
  text: '帮我把登录页的文案改一下',
  meta: { chatId: 'oc_1', messageId: 'om_1' },
})

test('1. subscribed：只给这个来源的话题', async () => {
  await withRuntime(async ({ runtime, repos }) => {
    repos.threads.save(thread('feishu', 'oc_1:om_1', RECENT))
    repos.threads.save(thread('github', '12', RECENT))
    const topics = runtime.feishuThreads().subscribed('feishu')
    assert.deepEqual(topics.map((item) => item.key), ['feishu:oc_1:om_1'])
  })
})

test('2. 14 天视野：静了两周的话题出去', async () => {
  await withRuntime(async ({ runtime, repos }) => {
    repos.threads.save(thread('feishu', 'oc_1:om_1', RECENT))
    repos.threads.save(thread('feishu', 'oc_1:om_2', OLD))
    const topics = runtime.feishuThreads().subscribed('feishu')
    assert.deepEqual(topics.map((item) => item.key), ['feishu:oc_1:om_1'])
  })
})

test('3. 有活工单订阅着：静了两周也还要轮询', async () => {
  await withRuntime(async ({ runtime, repos }) => {
    const ticketId = runtime.publish({ title: '改登录页文案', body: '把提示改成中文' })
    // 先确认 publish 真建出了工单：这条用例区分不了「活工单」与「悬空 id」，就白写了。
    assert.ok(repos.tickets.get(ticketId), '前提：publish 要真的建出一张工单')
    repos.threads.save(thread('feishu', 'oc_1:om_1', OLD, { subscriptions: [ticketId] }))
    // 对照：订阅的是一个查不到的 id，不算活，静了两周就该出去。
    repos.threads.save(thread('feishu', 'oc_1:om_2', OLD, { subscriptions: ['ticket-does-not-exist'] }))
    const topics = runtime.feishuThreads().subscribed('feishu')
    assert.deepEqual(topics.map((item) => item.key), ['feishu:oc_1:om_1'])
  })
})

test('4. 订阅的工单都结束了：不再轮询', async () => {
  await withRuntime(async ({ runtime, repos }) => {
    const ticketId = runtime.publish({ title: '改登录页文案', body: '把提示改成中文' })
    runtime.stop(ticketId)
    repos.threads.save(thread('feishu', 'oc_1:om_1', OLD, { subscriptions: [ticketId] }))
    const topics = runtime.feishuThreads().subscribed('feishu')
    assert.deepEqual(topics.map((item) => item.key), [])
  })
})

test('5. latest：按发生时刻取最新，不是最后写入的', async () => {
  await withRuntime(async ({ runtime, repos }) => {
    const key = 'feishu:oc_1:om_1'
    // 先写新的、再写旧的：写入顺序与发生顺序相反，正好检验排序用的是 at 而不是 rowid。
    repos.triggers.save(trigger('trig-new', key, '2026-09-02T00:00:00.000Z'))
    repos.triggers.save(trigger('trig-old', key, '2026-09-01T00:00:00.000Z'))
    const port = runtime.feishuThreads()
    assert.equal(port.latest(key)?.id, 'trig-new')
    assert.equal(port.latest('feishu:oc_9:om_9'), undefined, '陌生话题给 undefined，不编一个')
  })
})

test('6. patch：合并属性，undefined 删键，陌生话题不抛', async () => {
  await withRuntime(async ({ runtime, repos }) => {
    const key = 'feishu:oc_1:om_1'
    repos.threads.save(thread('feishu', 'oc_1:om_1', RECENT, { meta: { threadId: 'omt_1', pollError: '503' } }))
    const port = runtime.feishuThreads()
    port.patch(key, { pollError: undefined, threadId: 'omt_2', chatId: 'oc_1' })

    const saved = repos.threads.get(key)
    assert.deepEqual(saved.meta, { threadId: 'omt_2', chatId: 'oc_1' }, '删掉的键不该留下，别的键不能丢')
    assert.equal(saved.lastAt, RECENT, '整行回写不能把话题自己的字段冲掉')

    port.patch('feishu:oc_9:om_9', { threadId: 'omt_9' })
    assert.equal(repos.threads.get('feishu:oc_9:om_9'), undefined, '陌生话题不该被凭空建出来')
  })
})
