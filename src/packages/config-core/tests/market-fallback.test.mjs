/**
 * 技能市场「旧缓存回退 + 抓取总预算」的包级测试。
 *
 * 钉两件事（用户 2026-11-17 报「点市场转很久、还报超时红条」）：
 *   1. 先成功抓过一次、之后源返回 500 时，browseMarketSource 要交**上一次的条目**，
 *      而不是抛错——TTL 只决定要不要联网，不决定失败后还能不能用；
 *   2. 盘上完全没有缓存时源失败**必须抛错**——不能拿空数组冒充「这个源没东西」。
 *   3. 回退时通过 `onFallback` 把失败原因交给调用方（skills 插件据此写进结果的
 *      `error` 做「显示的是上次缓存」软提示）。
 *
 * 另外补两条：TTL 过期后失败同样回退（证明回退不看 TTL）；总预算会收紧单请求超时
 * （证明 budgetMs 真的接到了 fetch 上，而不是只写了个常量）。
 *
 * 全程离线：本地起一个回环 http server 当市场源，不联网、不碰真实 `~/.dsc`。
 * HOME / USERPROFILE / DSC_HOME 在 import 产物**之前**指向临时目录，因为 market.js
 * 在模块加载时就把 `CACHE_DIR`（= DSC_HOME/cache）算好了。跑完删临时目录。
 *
 * 单独跑：node src/packages/config-core/tests/market-fallback.test.mjs
 * 前置：pnpm run build（本测试 import 的是 lib/ 下的编译产物）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// ── 先隔离 HOME，再 import 产物：CACHE_DIR 是模块加载时算的 ──
const box = mkdtempSync(join(tmpdir(), 'dsc-market-fallback-'))
process.env.HOME = box
process.env.USERPROFILE = box
process.env.DSC_HOME = join(box, '.dsc')
const CACHE_DIR = join(box, '.dsc', 'cache')

const { browseMarketSource } = await import(
  new URL('../../../../lib/node_modules/@pneuma/config-core/market.js', import.meta.url).href
)

let passed = 0

/** 源的行为：ok = 正常给索引；fail = 500；hang = 永不回包（用来验总预算）。 */
let mode = 'ok'

const INDEX_ITEM = {
  name: 'fallback-skill',
  description: '旧缓存里的自检技能',
  path: 'fallback-skill/SKILL.md',
}

/** 本地市场源：任何 `.json` 路径都回同一份索引，正文不需要（浏览阶段只读索引）。 */
const server = createServer((req, res) => {
  if (mode === 'hang') return // 故意不回包：让预算超时来中止
  if (mode === 'fail') {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('boom')
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname.endsWith('.json')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ skills: [INDEX_ITEM] }))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('没有这个文件')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const base = `http://127.0.0.1:${String(port)}`

/** 盘上这份源的缓存文件（只有一个时直接取）。 */
function cacheFiles() {
  if (!existsSync(CACHE_DIR)) return []
  return readdirSync(CACHE_DIR).filter((name) => name.startsWith('market-') && name.endsWith('.json'))
}

test('第一次抓取成功：条目进结果，也落盘缓存', async () => {
  const source = { name: '本地兜底源', url: `${base}/index.json` }
  const entries = await browseMarketSource(source, { refresh: true })
  assert.equal(entries.length, 1, '第一次应该拿到 1 条')
  assert.equal(entries[0].name, 'fallback-skill')
  assert.equal(entries[0].description, '旧缓存里的自检技能')
  const files = cacheFiles()
  assert.equal(files.length, 1, `缓存应该落盘一份，实际 ${String(files.length)} 份`)
  passed += 1
})

test('联网失败回退旧缓存：第二次源 500，refresh 也拿回第一次的条目而不是抛错', async () => {
  const source = { name: '本地兜底源', url: `${base}/index.json` }
  mode = 'fail'
  const entries = await browseMarketSource(source, { refresh: true })
  assert.equal(entries.length, 1, '回退结果不能是空列表')
  assert.equal(entries[0].name, 'fallback-skill', '回退的必须是上次抓到的条目')
  assert.equal(entries[0].description, '旧缓存里的自检技能')
  passed += 1
})

test('回退不受 1 小时 TTL 限制：缓存过期后失败仍交旧条目', async () => {
  const source = { name: '本地兜底源', url: `${base}/index.json` }
  // 把缓存时间改成 2 小时前：新鲜度判定必然过期，非 refresh 调用会尝试联网
  const files = cacheFiles()
  assert.equal(files.length, 1)
  const file = join(CACHE_DIR, files[0])
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...doc, at: Date.now() - 2 * 60 * 60 * 1000 }), 'utf8')
  mode = 'fail'
  const entries = await browseMarketSource(source)
  assert.equal(entries.length, 1, 'TTL 过期 + 联网失败仍应回退旧条目')
  assert.equal(entries[0].name, 'fallback-skill')
  passed += 1
})

test('回退旧缓存时通过 onFallback 告知原因：界面才能提示「显示的是上次缓存」', async () => {
  const source = { name: '本地兜底源', url: `${base}/index.json` }
  mode = 'fail'
  const reasons = []
  const entries = await browseMarketSource(source, {
    refresh: true,
    onFallback: (reason) => reasons.push(reason),
  })
  assert.equal(entries.length, 1, '回调不能改变回退结果')
  assert.equal(entries[0].name, 'fallback-skill')
  assert.equal(reasons.length, 1, `回退一次只通知一次，实际 ${String(reasons.length)} 次`)
  assert.ok(
    reasons[0].includes('500'),
    `原因里要带原始失败信息（HTTP 500），实际：${String(reasons[0])}`,
  )
  passed += 1
})

test('完全没有缓存时源失败必须抛错：不静默返回空数组', async () => {
  // 换一个路径 = 换一个缓存键，保证这个源从没成功过
  const source = { name: '无缓存源', url: `${base}/broken.json` }
  mode = 'fail'
  await assert.rejects(
    () => browseMarketSource(source, { refresh: true }),
    /500/,
    '没有旧缓存时必须把错误抛出来，不能返回 []',
  )
  passed += 1
})

test('总预算收紧单请求超时：budgetMs 小的时候不会干等 15 秒', async () => {
  mode = 'hang'
  const source = { name: '慢源', url: `${base}/slow.json` }
  const startedAt = Date.now()
  await assert.rejects(
    () => browseMarketSource(source, { refresh: true, budgetMs: 300 }),
    '没预算了应当中止请求并抛错（盘上也没有这份源的缓存）',
  )
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 3_000, `应当按 budgetMs 中止，实际等了 ${String(elapsed)}ms（FETCH_TIMEOUT_MS 是 15 秒）`)
  passed += 1
})

after(async () => {
  server.closeAllConnections?.()
  await new Promise((done) => server.close(() => done()))
  rmSync(box, { recursive: true, force: true })
  console.log(`通过 ${String(passed)} 项`)
})
