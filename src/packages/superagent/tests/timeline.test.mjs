/**
 * @pneuma/superagent 线程时间线分页、相邻查找与时间戳归一的包级测试，转写自上游 `tests/timeline.spec.ts`。
 *
 * 上游 spec 的 import 头：`Engine`（`../src/core/index.ts`）、`Store`（`../src/app/store.ts`）、`threadDetail`
 * （`../src/app/views/threads.ts`）、`SettingsSchema` / `settingsPolicy`（`../src/policy.ts`）、`githubKind` /
 * `githubLink` / `SourceRegistry`（`../src/sources/*`）。映射到本仓：
 *   - `Engine` → `core/engine.ts`（经 `core/index.ts` 转出）；
 *   - `Store.read.neighbours` / `threadTriggers` → `app/store-read.ts`；
 *   - `threadDetail` → `app/views/threads.ts`；
 *   - `SettingsSchema` / `settingsPolicy` → `core/policy.ts`；
 *   - `githubKind` / `githubLink` / `SourceRegistry` → `sources/github.ts` / `sources/github-channel.ts` / `sources/registry.ts`。
 *
 * 4 条用例逐条有对应物，没有跳过的。为什么值得钉：分页游标与时间归一判错都不抛错——同一秒的两条 Trigger
 * 会在下一页重复出现或整条消失，GitHub 写整秒的时间会让「定位到某条评论」多带或少带相邻一句。
 *
 * 假件只有 `assessor` / `executor` / `outbox` 三个端口（与上游 spec 的 `engine()` 同形，时间线不经过它们）；
 * `Store`、`SourceRegistry`、`githubKind`、`SettingsSchema` 全是真的，数据落在 tmpdir 的临时库里。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/timeline
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, test } from 'node:test'

const { Engine } = await import('../../../../lib/packages/superagent/core/index.js')
const { Store } = await import('../../../../lib/packages/superagent/app/store.js')
const { threadDetail } = await import('../../../../lib/packages/superagent/app/views/threads.js')
const { SettingsSchema, settingsPolicy } = await import('../../../../lib/packages/superagent/core/policy.js')
const { githubKind } = await import('../../../../lib/packages/superagent/sources/github.js')
const { githubLink } = await import('../../../../lib/packages/superagent/sources/github-channel.js')
const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具（照上游 spec）──────────────────────────────────────────────────────

/** 临时库：每个用例一个，收尾关库并删目录。 */
let directory
let store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-timeline-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const sources = new SourceRegistry(() => SettingsSchema.parse({}))
sources.register(githubKind)

/** 视图宿主：`links` 只按来源给 URL。 */
const host = () => ({ store, sources, links: (channel) => githubLink(channel.address, {}) })

/** 真 Engine：只把三个端口换成不干事的假件，其余全真。 */
const engine = () => new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(SettingsSchema.parse({}), sources),
  assessor: { request: () => {} }, executor: { start: async () => {}, deliver: async () => {}, stop: async () => {} },
  outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, now: () => '2026-10-01T00:00:02.000Z' })

/** 一条 GitHub 评论 Trigger。 */
const comment = (id, at) => ({ id, source: 'github', threads: [{ source: 'github', id: '7' }], actor: { source: 'github', id: 'alice' },
  human: true, at, text: `comment ${id}`, meta: {} })

/** 存一个 `github:7` 线程。 */
const saveThread = () => store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: '', subscriptions: [],
  correlated: [], pending: [], meta: {} })

/** 时间线里每条 Trigger 的 id。 */
const ids = (detail) => detail.timeline.map(item => item.id)

// ── 用例 ────────────────────────────────────────────────────────────────────

test('按时间再按 id 分页：与上一页最旧一条同秒的 Trigger 出现在下一页', () => {
  saveThread()
  for (const item of [comment('a', '2026-10-01T00:00:00.000Z'), comment('b', '2026-10-01T00:00:01.000Z'), comment('c', '2026-10-01T00:00:01.000Z')]) store.triggers.save(item)
  const first = threadDetail(host(), 'github:7', undefined, 1)
  const second = threadDetail(host(), 'github:7', first.earlier, 1)
  const third = threadDetail(host(), 'github:7', second.earlier, 1)
  assert.deepEqual([ids(first), ids(second), ids(third), third.earlier], [['c'], ['b'], ['a'], null])
  // 只有时间戳的旧游标仍然从那个时间之前翻页。
  assert.deepEqual(ids(threadDetail(host(), 'github:7', '2026-10-01T00:00:01.000Z', 5)), ['a'])
  passed += 1
})

test('定位到一条 GitHub 评论时把那条评论带在页里，尽管 GitHub 把时间写成整秒', () => {
  // 按字典序，`...:00Z` 排在 `...:00.001Z` 之后，除非先归一成毫秒形式。
  const taking = engine()
  for (const item of [comment('old', '2026-10-01T00:00:00Z'), comment('new', '2026-10-01T00:00:00.500Z'), comment('newest', '2026-10-01T00:00:01Z')]) {
    taking.receive(item)
  }
  assert.deepEqual(ids(threadDetail(host(), 'github:7', undefined, 50, 'old')), ['old'])
  assert.deepEqual(ids(threadDetail(host(), 'github:7', undefined, 50, 'new')), ['old', 'new'])
  passed += 1
})

test('在同秒的多条 Trigger 里找出某条之前与之后最近的两条', () => {
  for (const item of [comment('a', '2026-10-01T00:00:01.000Z'), comment('b', '2026-10-01T00:00:01.000Z'), comment('c', '2026-10-01T00:00:01.000Z')]) store.triggers.save(item)
  const around = store.read.neighbours('github:7', '2026-10-01T00:00:01.000Z', 'b')
  assert.deepEqual([around.before?.id, around.after?.id], ['a', 'c'])
  passed += 1
})

test('收到的每条 Trigger 都按存储时刻的同一形式保存', () => {
  engine().receive(comment('raw', '2026-10-01T08:00:00+08:00'))
  assert.equal(store.triggers.get('raw')?.at, '2026-10-01T00:00:00.000Z')
  assert.deepEqual(store.read.threadTriggers('github:7').map(item => item.at), ['2026-10-01T00:00:00.000Z'])
  passed += 1
})
