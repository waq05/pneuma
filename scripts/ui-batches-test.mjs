/**
 * A2/A3 探针：启动分批（early/application）与 combo 批打包。
 *
 * 三组断言：
 *
 *   1. **组图**：`/api/boot` 带 `batches`，每个 entry 恰属一批、early 在前、批内顺序 =
 *      orderUiPlugins 之后的相对顺序；批 URL/rev 形状正确；改一个 `phase` 声明整图 rev 变；
 *      `/boot.js` 与 `/api/boot` 逐字节同源（同一个 buildBoot）。
 *   2. **combo 伺服**：批 URL 命中 200 且体 = 成员字节按序拼接；`content-length`/不可变缓存/
 *      HEAD 无体/非 GET 405 都照单资源；错 rev 与未通告的组合 404；多段 id（`@scope/name`）
 *      能进批、能伺服；换代后旧批地址仍 200（上一代保留）。
 *   3. **请求数**：16 个插件只需要 2 条批请求（≤3）；「批 → 单资源」回退的请求算术用
 *      `lib/ui/arrival.js` 的到达协议逐分支数死（传输失败 3 次 / 执行过没注册 2 次 /
 *      批已执行 1 次；同批其余条目不受影响、已执行的批绝不重放）。
 *
 * 用法：npx tsc -p tsconfig.json && node scripts/ui-batches-test.mjs
 *
 * @module dsc/scripts/ui-batches-test
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 HOME / DSC_HOME：第三方发现会扫 ~/.dsc/plugins，不隔离就会读到使用者真实的那份。
const home = mkdtempSync(join(tmpdir(), 'dsc-ui-batches-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
delete process.env.DSC_UI_SERVER
delete process.env.DSC_UI_ASSETS
delete process.env.DSC_UI_PORT
delete process.env.DSC_UI_HMR

const { UiArrivalLedger } = await import('../lib/ui/arrival.js')
const { uiComboBatchRev, uiComboBatchUrl } = await import('../lib/ui/manifest.js')
const { createUiServer } = await import('../lib/core/ui-server.js')
const { isUiComboRequest, resolveUiResourceRequest } = await import('../lib/core/ui-route.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${name}`)
    return
  }
  failures += 1
  console.error(`  FAIL  ${name}${detail === '' ? '' : `（${detail}）`}`)
}

const work = mkdtempSync(join(tmpdir(), 'dsc-ui-batches-'))
let treeSeq = 0

/** 造一棵临时目录树（探针不写真实 lib/ui 与 ~/.dsc 一个字节）。 */
function makeTree(name, files) {
  const dir = join(work, `${name}-${String(++treeSeq)}`)
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  return dir
}

/** 发一个 HTTP 请求（node:http，便于自定义 Host/Cookie）。 */
function http(method, port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 1. 组图：16 个插件的两批 ───────────────────────────────────────────────────
console.log('\n[1] 组图与批次')
const ids = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', '@scope/name']
const content = (id) => `module.exports={apply(){return ${JSON.stringify(id)}}}\n`
const files = {
  'manifest.json': JSON.stringify({
    version: 1,
    plugins: ids.map((id, index) => ({
      id,
      file: 'client.js',
      platform: 'web',
      ...(index < 6 ? { phase: 'early' } : {}),
    })),
  }),
}
for (const id of ids) files[`${id}/client.js`] = content(id)
const pluginsDir = makeTree('batches-plugins', files)
const assetsDir = makeTree('batches-assets', { 'index.html': '<!doctype html><html><body>壳</body></html>' })
const server = await createUiServer({ host: { name: 'Muse Code', version: 'test' }, assetsDir, pluginsDir, log: () => {} })
const port = server.port
const token = new URL(server.url).searchParams.get('token') ?? ''
const handshake = await http('GET', port, `/?token=${token}`)
const cookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]

const bootA = JSON.parse((await http('GET', port, '/api/boot', { cookie })).body)
check('16 个插件都在图里', bootA.entries.length === 16, String(bootA.entries.length))
check('批次是两个，early 在前', bootA.batches.length === 2
  && bootA.batches[0].phase === 'early' && bootA.batches[1].phase === 'application',
  JSON.stringify(bootA.batches.map((b) => b.phase)))
check('early 批正好是声明了 phase 的 6 个', bootA.batches[0].entries.length === 6, bootA.batches[0].entries.join(','))
{
  const covered = new Map()
  for (const batch of bootA.batches) for (const id of batch.entries) covered.set(id, (covered.get(id) ?? 0) + 1)
  check('每个 entry 恰属一个批', bootA.entries.every((entry) => covered.get(entry.id) === 1))
  const expectedEarly = bootA.entries.filter((entry) => bootA.batches[0].entries.includes(entry.id)).map((entry) => entry.id)
  check('批内顺序 = 图内相对顺序', JSON.stringify(expectedEarly) === JSON.stringify(bootA.batches[0].entries))
  const members = bootA.batches[1].entries.map((id) => ({ id, rev: bootA.entries.find((entry) => entry.id === id).rev }))
  check('application 批的 rev 是成员 rev 的派生', bootA.batches[1].rev === uiComboBatchRev(members), String(bootA.batches[1].rev))
  check('批 URL 形状是 plugins/??…&rev=', /^plugins\/\?\?(.+)&rev=[0-9a-f]{12}$/.test(bootA.batches[1].url), bootA.batches[1].url)
  check('批 URL 里每个成员都带 /client.js 后缀',
    bootA.batches[1].url.slice('plugins/??'.length).split('&rev=')[0].split(',').every((resource) => resource.endsWith('/client.js')))
  check('多段 id 在批里被单段编码', uiComboBatchUrl(['@scope/name'], 'x').includes('%40scope%2Fname'), uiComboBatchUrl(['@scope/name'], 'x'))
}
const bootB = JSON.parse((await http('GET', port, '/api/boot', { cookie })).body)
check('清单没变时整图 rev 稳定', bootB.rev === bootA.rev, `${bootA.rev} → ${bootB.rev}`)
const bootJs = await http('GET', port, '/boot.js', { cookie })
check('/boot.js 与 /api/boot 同源（同一份快照）', bootJs.body.includes(JSON.stringify(bootB).replace(/</g, '\\u003c')) || bootJs.body.includes(bootB.rev))

// ── 2. combo 伺服 ─────────────────────────────────────────────────────────────
console.log('\n[2] combo 伺服')
const earlyUrl = bootA.batches[0].url
const applicationUrl = bootA.batches[1].url
const earlyParts = bootA.batches[0].entries.map((id) => readFileSync(join(pluginsDir, id, 'client.js'), 'utf8'))
const earlyBody = earlyParts.join('\n')
{
  const combo = await http('GET', port, `/${earlyUrl}`, { cookie })
  check('批 URL 命中 200', combo.status === 200, String(combo.status))
  check('批体 = 成员字节按序拼接', combo.body === earlyBody, `${String(combo.body.length)} vs ${String(earlyBody.length)}`)
  check('批响应是 JS + 不可变缓存', String(combo.headers['content-type'] ?? '').startsWith('text/javascript')
    && String(combo.headers['cache-control'] ?? '').includes('immutable'))
  check('content-length 对', Number(combo.headers['content-length']) === Buffer.byteLength(earlyBody), String(combo.headers['content-length']))
  const head = await http('HEAD', port, `/${earlyUrl}`, { cookie })
  check('HEAD 复用头、无体', head.status === 200 && head.body === '' && head.headers['content-length'] === combo.headers['content-length'])
  const post = await http('POST', port, `/${earlyUrl}`, { cookie })
  check('批上非 GET/HEAD 405 带 Allow', post.status === 405 && String(post.headers['allow'] ?? '').includes('GET'), String(post.status))
  const badRev = await http('GET', port, `/${earlyUrl.replace(/rev=[0-9a-f]{12}$/, `rev=${'0'.repeat(12)}`)}`, { cookie })
  check('错 rev 的批地址 404（地址即内容）', badRev.status === 404, String(badRev.status))
  const reversed = bootA.batches[0].entries.slice().reverse()
  const reversedRev = uiComboBatchRev(reversed.map((id) => ({ id, rev: bootA.entries.find((entry) => entry.id === id).rev })))
  const unknown = await http('GET', port, `/${uiComboBatchUrl(reversed, reversedRev)}`, { cookie })
  check('未通告的组合 404（精确表，不解析）', unknown.status === 404, String(unknown.status))
  check('路由判定：批是 search 以 ?? 开头，不是 pathname 里有 ??', isUiComboRequest('/plugins/', '??a/client.js&rev=x')
    && !isUiComboRequest('/plugins/a/client.js', '?rev=x'))
  const unresolvedCombo = resolveUiResourceRequest('/plugins/', '??a/client.js&rev=abc', pluginsDir, 'GET')
  check('没有当前代 combo 表时组合 404（纯静态服务没有批）', unresolvedCombo.status === 404, String(unresolvedCombo.status))
}

// ── 3. 请求计数：16 个插件 ≤ 3 ────────────────────────────────────────────────
console.log('\n[3] 请求计数')
server.resetStats()
{
  // 模拟壳的首装：early 批一条 + application 批一条。
  const a = await http('GET', port, `/${earlyUrl}`, { cookie })
  const b = await http('GET', port, `/${applicationUrl}`, { cookie })
  const stats = server.stats()
  check('两条批请求覆盖 16 个插件（≤3）', a.status === 200 && b.status === 200 && stats.combo === 2 && stats.single === 0,
    JSON.stringify(stats))
  check('不需要任何单资源请求', stats.single === 0, JSON.stringify(stats))
  // 单资源回退目标仍然照常伺服（批失败的兜底）。
  const single = await http('GET', port, `/plugins/${encodeURIComponent('p10')}/client.js?rev=${bootA.entries.find((entry) => entry.id === 'p10').rev}`, { cookie })
  check('单资源 URL 仍可伺服（回退目标在）', single.status === 200 && single.body === content('p10'), String(single.status))
  check('单资源计数按 id 记（回退探针读数）', server.stats().single === 1 && server.stats().byId['p10'] === 1, JSON.stringify(server.stats()))
}

// ── 4. 到达协议：请求算术逐分支 ───────────────────────────────────────────────
console.log('\n[4] 批 → 单资源回退')
{
  // 4a. 批执行了但没注册 b（同批的 a 已注册）：绝不重放批，b 单独重取一次、其余照常。
  const table = {}
  const requests = []
  const host = {
    has: (id) => typeof table[id] === 'function',
    load: async (url) => {
      requests.push(url)
      if (url === 'batch') {
        table['a'] = () => {}
        return
      }
      if (url === 'single-b') {
        table['b'] = () => {}
        return
      }
      throw new Error(`404: ${url}`)
    },
  }
  const ledger = new UiArrivalLedger()
  await ledger.arrive({ id: 'a', preferred: 'batch', fallback: 'single-a' }, host)
  check('首批行让批执行：请求 = 批（1 次）', JSON.stringify(requests) === JSON.stringify(['batch']), requests.join(','))
  await ledger.arrive({ id: 'b', preferred: 'batch', fallback: 'single-b' }, host)
  check('批执行过、这条仍缺：跳过批 → 单资源恰 1 次（该行共 2 次）',
    JSON.stringify(requests) === JSON.stringify(['batch', 'single-b']), requests.join(','))
  check('同批已注册的条目照常可用（一个 id 缺不影响其余）', host.has('a') && host.has('b'))
  let chain = ''
  try {
    await ledger.arrive({ id: 'c', preferred: 'batch', fallback: 'single-c' }, host)
  } catch (error) {
    chain = error instanceof Error ? error.message : String(error)
  }
  check('缺的这条重取失败：报出整条原因链、批绝不再取',
    chain.includes('single-c') && requests.filter((url) => url === 'batch').length === 1, chain)

  // 4b. 传输失败：同 URL 重试一次 → 该行走单资源（3 次/每条缺行）；批请求只有 2 次（同 URL 共享在途）。
  const requests3 = []
  const table3 = {}
  const host3 = {
    has: (id) => typeof table3[id] === 'function',
    load: async (url) => {
      requests3.push(url)
      if (url === 'batch') throw new Error('ECONNRESET')
      if (url === 'single-x') {
        table3['x'] = () => {}
        return
      }
      if (url === 'single-y') {
        table3['y'] = () => {}
        return
      }
      throw new Error(`404: ${url}`)
    },
  }
  const ledger3 = new UiArrivalLedger()
  await ledger3.arrive({ id: 'x', preferred: 'batch', fallback: 'single-x' }, host3)
  check('传输失败：批×2（重试）+ 单资源×1 = 3 次', JSON.stringify(requests3) === JSON.stringify(['batch', 'batch', 'single-x']), requests3.join(','))
  await ledger3.arrive({ id: 'y', preferred: 'batch', fallback: 'single-y' }, host3)
  check('批已记失败：同批下一条只走单资源（1 次），批不再取',
    JSON.stringify(requests3.slice(3)) === JSON.stringify(['single-y']) && requests3.filter((url) => url === 'batch').length === 2,
    requests3.join(','))
}

// ── 5. 换代：旧批地址与旧单资源都留一代 ───────────────────────────────────────
console.log('\n[5] 换代与上一代')
{
  const oldRev = bootA.entries.find((entry) => entry.id === 'p01').rev
  const oldSingle = `plugins/${encodeURIComponent('p01')}/client.js?rev=${oldRev}`
  const oldEarlyUrl = earlyUrl
  writeFileSync(join(pluginsDir, 'p01', 'client.js'), 'module.exports={apply(){return "changed"}}\n')
  // 手工换文件不带清单指纹变化：换代要靠强制重收（宿主里这是 HMR 轮询决定的时刻）。
  server.refresh()
  const bootC = JSON.parse((await http('GET', port, '/api/boot', { cookie })).body)
  const newRev = bootC.entries.find((entry) => entry.id === 'p01').rev
  check('内容变了：该行 rev 变、early 批 rev 跟着变', newRev !== oldRev && bootC.batches[0].rev !== bootA.batches[0].rev,
    `${oldRev} → ${newRev}`)
  check('内容变了：整图 rev 变', bootC.rev !== bootA.rev)
  const oldSingleResp = await http('GET', port, `/${oldSingle}`, { cookie })
  check('旧单资源地址仍拿旧字节（上一代保留）', oldSingleResp.status === 200 && oldSingleResp.body.includes('"p01"') && !oldSingleResp.body.includes('changed'), String(oldSingleResp.status))
  const oldComboResp = await http('GET', port, `/${oldEarlyUrl}`, { cookie })
  check('旧批地址仍 200（上一代 combo 表）', oldComboResp.status === 200, String(oldComboResp.status))
  check('旧批体与当时逐字节一致', oldComboResp.body === earlyBody)
  const newComboResp = await http('GET', port, `/${bootC.batches[0].url}`, { cookie })
  check('新批地址拿新字节', newComboResp.status === 200 && newComboResp.body.includes('changed'), String(newComboResp.status))
}

// ── 6. phase 声明：坏值记问题、改声明整图 rev 变 ──────────────────────────────
console.log('\n[6] phase 声明')
{
  const manifestOf = (patch) => JSON.stringify({
    version: 1,
    plugins: ids.map((id, index) => ({
      id,
      file: 'client.js',
      platform: 'web',
      ...(index < 6 ? { phase: 'early' } : {}),
      ...(id === patch.id ? patch.value : {}),
    })),
  })
  const before = JSON.parse((await http('GET', port, '/api/boot', { cookie })).body)
  writeFileSync(join(pluginsDir, 'manifest.json'), manifestOf({ id: 'p07', value: { phase: 'later' } }))
  const bad = JSON.parse((await http('GET', port, '/api/boot', { cookie })).body)
  check('phase 坏值：该条仍在 entries（按 application 处理，不整条丢弃）', bad.entries.some((entry) => entry.id === 'p07'))
  check('phase 坏值：problems 里有一句人话', server.problems().some((line) => line.includes('p07') && line.includes('phase')), server.problems().join(' | '))
  check('phase 坏值不扰动整图 rev', bad.rev === before.rev, `${before.rev} → ${bad.rev}`)
  writeFileSync(join(pluginsDir, 'manifest.json'), manifestOf({ id: 'p07', value: { phase: 'early' } }))
  const moved = JSON.parse((await http('GET', port, '/api/boot', { cookie })).body)
  check('改一个 phase 声明：整图 rev 变', moved.rev !== before.rev, `${before.rev} → ${moved.rev}`)
  check('改 phase：p07 进了 early 批、application 批少一个', moved.batches[0].entries.includes('p07')
    && !moved.batches[1].entries.includes('p07'))
}

await server.close()
rmSync(work, { recursive: true, force: true })
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条断言失败`)
process.exit(failures === 0 ? 0 : 1)
