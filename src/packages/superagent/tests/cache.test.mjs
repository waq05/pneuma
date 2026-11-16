/**
 * @pneuma/superagent 文本缓存的包级测试：LRU 顺序、按 UTF-16 码元数的容量上限、超限时「刚写进去的那条」不淘汰。
 *
 * 为什么这些要单独钉：这个缓存给 `orchestrator_read` 的分页快照和飞书消息链接用，判错都不报错，
 * 只会悄悄多留一条（内存涨）或提前丢一条（模型刚读过的分页又得重读）。三条断言分别钉住
 * 「读一次算用过」「重写按新值重新占位」「单条自己超限时只留它」。
 *
 * 被测模块没 import，也不碰 `~/.dsc`；这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/cache
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { TextCache } = await import('../../../../lib/packages/superagent/app/cache.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

test('超出上限先丢最久没用过的：读一次就算用过', () => {
  const cache = new TextCache(10)
  cache.set('a', 'aaaa'); cache.set('b', 'bbbb')
  assert.equal(cache.get('a'), 'aaaa', '读得到刚写进去的两条')
  cache.set('c', 'cccc')
  // 读 `a` 让 `b` 变成最久没用的那一条，于是被挤掉。
  assert.deepEqual([...cache.entries()], [['a', 'aaaa'], ['c', 'cccc']])
  passed += 1
})

test('重写已有的键：旧值占的额度先退回，这个键排到最末', () => {
  const cache = new TextCache(10)
  cache.set('a', 'aaaa'); cache.set('b', 'bbbb')
  cache.get('a')
  cache.set('c', 'cccc')
  // 此时顺序是 `a -> c`；把 `a` 改短再写一次，它应该排到最后。
  cache.set('a', 'a')
  assert.deepEqual([...cache.entries()], [['c', 'cccc'], ['a', 'a']])
  assert.equal(cache.get('c'), 'cccc', '容量没超，`c` 不该被挤掉')
  passed += 1
})

test('单条自己就超上限：只留这一条，之前挤掉的键读不到', () => {
  const cache = new TextCache(10)
  cache.set('a', 'aaaa'); cache.set('b', 'bbbb')
  cache.get('a')
  cache.set('c', 'cccc')
  cache.set('a', 'a')
  const big = 'x'.repeat(20)
  cache.set('big', big)
  assert.deepEqual([...cache.entries()], [['big', big]], '超限的那条本身仍保留，其余全部让位')
  assert.equal(cache.get('c'), undefined)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), undefined)
  passed += 1
})
