/**
 * @pneuma/superagent 的组件体检登记表包级测试：单写者、写、释放后写入失效、还回名字后可重新领。
 *
 * 为什么这些要单独钉：这块板子是运行时、Effects、Sessions、执行器、设置与来源注册表共用的。
 * 同名领两次如果只是悄悄覆盖，两块组件就会互相抹掉体检读数；释放之后 `set` 如果还能写，
 * 已经注销的 kind 会在面板上留一行幽灵状态。所以每条都断言「准不准」。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/infra-health
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 一格体检值的夹具。 */
const health = (state, detail = '') => ({ state, detail })

test('claim：领到就带初始值，可以改写，`all` 里能读到', () => {
  const board = new HealthBoard()
  const entry = board.claim('runtime', health('starting', 'booting'))
  assert.deepEqual(entry.get(), health('starting', 'booting'), '初始值随 claim 一起上任')
  entry.set(health('ready', 'ok'))
  assert.deepEqual(entry.get(), health('ready', 'ok'), 'set 之后 get 要读到新值')
  assert.deepEqual(board.all, { runtime: health('ready', 'ok') }, 'all 是这个板子的全部格子')
  passed += 1
})

test('claim：不传初始值时 get 是 undefined，`all` 里也没有这一格', () => {
  const board = new HealthBoard()
  const entry = board.claim('sources')
  assert.equal(entry.get(), undefined)
  assert.deepEqual(board.all, {}, '没报过体检的格子不该出现在 all 里')
  entry.set(health('error', 'poll failed'))
  assert.deepEqual(board.all, { sources: health('error', 'poll failed') })
  passed += 1
})

test('单写者：同名重复 claim 抛上游原话，且不动第一份读数', () => {
  const board = new HealthBoard()
  board.claim('effects', health('ready', 'first'))
  assert.throws(() => board.claim('effects', health('error', 'second')), {
    message: 'The health entry effects is reported by another part',
  })
  assert.deepEqual(board.all, { effects: health('ready', 'first') }, '被拒的 claim 不许改已有格子')
  passed += 1
})

test('release：还回名字与读数，之后的 set 变成 no-op', () => {
  const board = new HealthBoard()
  const entry = board.claim('executor', health('ready', 'running'))
  entry.release()
  assert.equal(entry.get(), undefined, '释放后读不到读数')
  assert.deepEqual(board.all, {}, '板子上也清掉了')
  entry.set(health('error', 'late write'))
  assert.deepEqual(board.all, {}, '释放后写入不生效，否则面板上会留幽灵状态')
  assert.equal(entry.get(), undefined)
  entry.release()
  assert.deepEqual(board.all, {}, '重复释放不抛错、不误删别人的格子')
  passed += 1
})

test('release：名字还回去以后可以重新领，重新领是全新的一格', () => {
  const board = new HealthBoard()
  const first = board.claim('settings', health('ready', 'old'))
  first.release()
  const second = board.claim('settings', health('starting', 'new'))
  assert.notEqual(second, first, '重新领要拿到新的句柄，旧句柄保持失效')
  first.set(health('error', 'stale'))
  assert.deepEqual(second.get(), health('starting', 'new'), '旧句柄写不进新格子')
  assert.throws(() => board.claim('settings'), /reported by another part/, '同一时刻仍只许一个写者')
  passed += 1
})

test('release：同名重新领之前，别的名字不受影响', () => {
  const board = new HealthBoard()
  const runtime = board.claim('runtime', health('ready', 'a'))
  const sources = board.claim('sources', health('ready', 'b'))
  sources.release()
  runtime.set(health('paused', 'c'))
  assert.deepEqual(board.all, { runtime: health('paused', 'c') }, '释放一格不许动另一格')
  passed += 1
})
