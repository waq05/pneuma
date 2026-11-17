/**
 * 启动分批（early / application）与 combo 批打包：组图、combo 伺服、请求数、
 * 到达协议、换代保留、phase 声明（迁自 `scripts/ui-batches-test.mjs`）。
 *
 * ## 被测的是什么
 *
 * 1. **组图**：`/api/boot` 带 `batches`，每个 entry 恰属一批、early 在前、批内顺序 =
 *    `orderUiPlugins` 之后的相对顺序；批 URL/rev 形状正确（`uiComboBatchRev` 是成员 rev
 *    的派生、多段 id 被单段编码）；清单没变整图 rev 稳定；`/boot.js` 与 `/api/boot` 同源。
 * 2. **combo 伺服**：批 URL 命中 200 且体 = 成员字节按序拼接；JS + 不可变缓存；
 *    content-length 对；HEAD 无体；非 GET/HEAD 405 带 Allow；错 rev 与未通告的组合 404
 *    （精确表，不解析）；`isUiComboRequest` 认 search 以 `??` 开头；纯静态服务没有批 → 404。
 * 3. **请求数**：16 个插件只需要 2 条批请求；单资源回退目标仍可伺服且按 id 计数
 *    （`server.stats()` / `resetStats()`）。
 * 4. **到达协议**（`UiArrivalLedger`）：批执行过但这条缺 → 跳过批单独重取恰 1 次、
 *    同批其余条目照常、批绝不重放；缺的重取失败报整条原因链；传输失败同 URL 重试一次
 *    （批 ×2 共享在途）→ 该行走单资源；批已记失败后同批下一条直接走单资源。
 * 5. **换代**：内容变了该行 rev 变、early 批 rev 跟着变、整图 rev 变；旧单资源与旧批地址
 *    都留一代（字节逐位一致）；新地址拿新字节。
 * 6. **phase 声明**：坏值按 application 处理（不整条丢弃）、problems 有人话、不扰动整图
 *    rev；改一个 phase 声明整图 rev 变、成员挪批。
 *
 * ## 落位与隔离
 *
 * 真服务（`createUiServer`，端口 0）；夹具在临时目录（16 个插件 + 根清单）；临时 HOME 由
 * setup 给。`DSC_UI_HMR` 显式删掉（别让开发机的热更开关改轮询口径）。
 *
 * @module dsc/tests/integration/ui-batches
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { UiArrivalLedger } from '@pneuma/ui-core/arrival.js'
import { uiComboBatchRev, uiComboBatchUrl } from '@pneuma/runtime/core/ui-manifest.js'
import { createUiServer, type UiServerHandle } from '@pneuma/runtime/core/ui-server.js'
import { isUiComboRequest, resolveUiResourceRequest } from '@pneuma/runtime/core/ui-route.js'

/** 夹具总目录；失败现场留着翻，成功时 afterAll 删。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-batches-'))

// 探针同款：环境里带了这几个变量会把基线改掉。
delete process.env.DSC_UI_SERVER
delete process.env.DSC_UI_ASSETS
delete process.env.DSC_UI_PORT
delete process.env.DSC_UI_HMR

afterAll(() => {
  try {
    rmSync(WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})

/** 造一棵临时目录树。 */
function makeTree(name: string, files: Record<string, string>): string {
  const dir = join(WORK, name)
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  return dir
}

/** 一条 HTTP 响应的读数。 */
interface HttpResult {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** 发一个 HTTP 请求（node:http，便于自定义 Host/Cookie）。 */
function http(method: string, port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

interface BootGraph {
  rev: string
  entries: Array<{ id: string; rev: string; url: string }>
  batches: Array<{ phase: string; url?: string; rev?: string; entries: string[] }>
}

/** 16 个插件的两批（early 6 个 + application 10 个，含一个多段 id）。 */
const IDS = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', '@scope/name']
const content = (id: string): string => `module.exports={apply(){return ${JSON.stringify(id)}}}\n`

// ── 1. 组图与批次（共享一个真服务，整文件复用） ────────────────────────────────
describe('组图、combo 伺服与换代（真服务）', () => {
  let server: UiServerHandle
  let cookie = ''
  let pluginsDir = ''
  let bootA: BootGraph
  let earlyBody = ''

  beforeAll(async () => {
    const files: Record<string, string> = {
      'manifest.json': JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: IDS.map((id, index) => ({
          id,
          file: 'client.js',
          platform: 'web',
          ...(index < 6 ? { phase: 'early' } : {}),
        })),
      }),
    }
    for (const id of IDS) files[`${id}/client.js`] = content(id)
    pluginsDir = makeTree('batches-plugins', files)
    const assetsDir = makeTree('batches-assets', { 'index.html': '<!doctype html><html><body>壳</body></html>' })
    server = await createUiServer({ host: { name: 'Pneuma', version: 'test' }, assetsDir, pluginsDir, log: () => {} })
    const token = new URL(server.url).searchParams.get('token') ?? ''
    const handshake = await http('GET', server.port, `/?token=${token}`)
    cookie = String(handshake.headers['set-cookie']?.[0] ?? '').split(';')[0]
    bootA = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as BootGraph
    const earlyParts = (bootA.batches[0]?.entries ?? []).map((id) => readFileSync(join(pluginsDir, id, 'client.js'), 'utf8'))
    earlyBody = earlyParts.join('\n')
  })

  afterAll(async () => {
    await server.close()
  })

  // ── 1. 组图 ────────────────────────────────────────────────────────────────
  test('16 个插件都在图里', () => {
    expect(bootA.entries.length).toBe(16)
  })

  test('批次是两个，early 在前', () => {
    expect(bootA.batches.length).toBe(2)
    expect(bootA.batches[0]?.phase).toBe('early')
    expect(bootA.batches[1]?.phase).toBe('application')
  })

  test('early 批正好是声明了 phase 的 6 个', () => {
    expect(bootA.batches[0]?.entries.length).toBe(6)
  })

  test('每个 entry 恰属一个批', () => {
    const covered = new Map<string, number>()
    for (const batch of bootA.batches) {
      for (const id of batch.entries) covered.set(id, (covered.get(id) ?? 0) + 1)
    }
    expect(bootA.entries.every((entry) => covered.get(entry.id) === 1)).toBe(true)
  })

  test('批内顺序 = 图内相对顺序', () => {
    const expectedEarly = bootA.entries
      .filter((entry) => (bootA.batches[0]?.entries ?? []).includes(entry.id))
      .map((entry) => entry.id)
    expect(expectedEarly).toEqual(bootA.batches[0]?.entries ?? [])
  })

  test('application 批的 rev 是成员 rev 的派生', () => {
    const members = (bootA.batches[1]?.entries ?? []).map((id) => ({
      id,
      rev: bootA.entries.find((entry) => entry.id === id)?.rev ?? '',
    }))
    expect(bootA.batches[1]?.rev).toBe(uiComboBatchRev(members))
  })

  test('批 URL 形状是 plugins/??…&rev=，每个成员带 /client.js 后缀', () => {
    const url = bootA.batches[1]?.url ?? ''
    expect(/^plugins\/\?\?(.+)&rev=[0-9a-f]{12}$/.test(url), url).toBe(true)
    const members = url.slice('plugins/??'.length).split('&rev=')[0]?.split(',') ?? []
    expect(members.every((resource) => resource.endsWith('/client.js')), url).toBe(true)
  })

  test('多段 id 在批里被单段编码', () => {
    expect(uiComboBatchUrl(['@scope/name'], 'x')).toContain('%40scope%2Fname')
  })

  test('清单没变时整图 rev 稳定', async () => {
    const bootB = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as BootGraph
    expect(bootB.rev).toBe(bootA.rev)
  })

  test('/boot.js 与 /api/boot 同源（同一份快照）', async () => {
    const bootJs = await http('GET', server.port, '/boot.js', { cookie })
    expect(bootJs.body.includes(JSON.stringify(bootA).replace(/</g, '\\u003c')) || bootJs.body.includes(bootA.rev)).toBe(true)
  })

  // ── 2. combo 伺服 ──────────────────────────────────────────────────────────
  test('批 URL 命中 200 且体 = 成员字节按序拼接', async () => {
    const earlyUrl = bootA.batches[0]?.url ?? ''
    const combo = await http('GET', server.port, `/${earlyUrl}`, { cookie })
    expect(combo.status).toBe(200)
    expect(combo.body).toBe(earlyBody)
  })

  test('批响应是 JS + 不可变缓存，content-length 对', async () => {
    const earlyUrl = bootA.batches[0]?.url ?? ''
    const combo = await http('GET', server.port, `/${earlyUrl}`, { cookie })
    expect(String(combo.headers['content-type'] ?? '')).toMatch(/^text\/javascript/)
    expect(String(combo.headers['cache-control'] ?? '')).toContain('immutable')
    expect(Number(combo.headers['content-length'])).toBe(Buffer.byteLength(earlyBody))
  })

  test('HEAD 复用头、无体；批上非 GET/HEAD 405 带 Allow', async () => {
    const earlyUrl = bootA.batches[0]?.url ?? ''
    const head = await http('HEAD', server.port, `/${earlyUrl}`, { cookie })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    const post = await http('POST', server.port, `/${earlyUrl}`, { cookie })
    expect(post.status).toBe(405)
    expect(String(post.headers['allow'] ?? '')).toContain('GET')
  })

  test('错 rev 的批地址 404（地址即内容）', async () => {
    const earlyUrl = bootA.batches[0]?.url ?? ''
    const badRev = await http('GET', server.port, `/${earlyUrl.replace(/rev=[0-9a-f]{12}$/, `rev=${'0'.repeat(12)}`)}`, { cookie })
    expect(badRev.status).toBe(404)
  })

  test('未通告的组合 404（精确表，不解析）', async () => {
    const reversed = [...(bootA.batches[0]?.entries ?? [])].reverse()
    const reversedRev = uiComboBatchRev(
      reversed.map((id) => ({ id, rev: bootA.entries.find((entry) => entry.id === id)?.rev ?? '' })),
    )
    const unknown = await http('GET', server.port, `/${uiComboBatchUrl(reversed, reversedRev)}`, { cookie })
    expect(unknown.status).toBe(404)
  })

  test('路由判定：批是 search 以 ?? 开头，不是 pathname 里有 ??', () => {
    expect(isUiComboRequest('/plugins/', '??a/client.js&rev=x')).toBe(true)
    expect(isUiComboRequest('/plugins/a/client.js', '?rev=x')).toBe(false)
  })

  test('没有当前代 combo 表时组合 404（纯静态服务没有批）', () => {
    expect(resolveUiResourceRequest('/plugins/', '??a/client.js&rev=abc', pluginsDir, 'GET').status).toBe(404)
  })

  // ── 3. 请求计数 ────────────────────────────────────────────────────────────
  test('两条批请求覆盖 16 个插件（≤3），不需要任何单资源请求', async () => {
    server.resetStats()
    const earlyUrl = bootA.batches[0]?.url ?? ''
    const applicationUrl = bootA.batches[1]?.url ?? ''
    const a = await http('GET', server.port, `/${earlyUrl}`, { cookie })
    const b = await http('GET', server.port, `/${applicationUrl}`, { cookie })
    const stats = server.stats()
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(stats.combo === 2 && stats.single === 0, JSON.stringify(stats)).toBe(true)
  })

  test('单资源 URL 仍可伺服（回退目标在），计数按 id 记', async () => {
    const p10Rev = bootA.entries.find((entry) => entry.id === 'p10')?.rev ?? ''
    const single = await http('GET', server.port, `/plugins/${encodeURIComponent('p10')}/client.js?rev=${p10Rev}`, { cookie })
    expect(single.status).toBe(200)
    expect(single.body).toBe(content('p10'))
    const stats = server.stats()
    expect(stats.single === 1 && stats.byId['p10'] === 1, JSON.stringify(stats)).toBe(true)
  })

  // ── 5. 换代：旧批地址与旧单资源都留一代 ────────────────────────────────────
  test('换代：该行 rev 变、early 批 rev 跟着变、整图 rev 变', async () => {
    const oldRev = bootA.entries.find((entry) => entry.id === 'p01')?.rev ?? ''
    writeFileSync(join(pluginsDir, 'p01', 'client.js'), 'module.exports={apply(){return "changed"}}\n')
    // 手工换文件不带清单指纹变化：换代要靠强制重收（宿主里这是 HMR 轮询决定的时刻）。
    server.refresh()
    const bootC = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as BootGraph
    const newRev = bootC.entries.find((entry) => entry.id === 'p01')?.rev ?? ''
    expect(newRev !== oldRev && bootC.batches[0]?.rev !== bootA.batches[0]?.rev, `${oldRev} → ${newRev}`).toBe(true)
    expect(bootC.rev !== bootA.rev).toBe(true)
    factsHolder.bootC = bootC
    factsHolder.oldRev = oldRev
    factsHolder.earlyBody = earlyBody
    factsHolder.earlyUrl = bootA.batches[0]?.url ?? ''
  })

  test('旧单资源地址仍拿旧字节；旧批地址仍 200 且体与当时逐字节一致；新批地址拿新字节', async () => {
    const bootC = factsHolder.bootC as BootGraph
    const oldRev = factsHolder.oldRev as string
    const oldSingle = `plugins/${encodeURIComponent('p01')}/client.js?rev=${oldRev}`
    const oldSingleResp = await http('GET', server.port, `/${oldSingle}`, { cookie })
    expect(oldSingleResp.status).toBe(200)
    expect(oldSingleResp.body.includes('"p01"')).toBe(true)
    expect(oldSingleResp.body.includes('changed')).toBe(false)
    const oldComboResp = await http('GET', server.port, `/${factsHolder.earlyUrl as string}`, { cookie })
    expect(oldComboResp.status).toBe(200)
    expect(oldComboResp.body).toBe(factsHolder.earlyBody as string)
    const newComboResp = await http('GET', server.port, `/${bootC.batches[0]?.url ?? ''}`, { cookie })
    expect(newComboResp.status).toBe(200)
    expect(newComboResp.body).toContain('changed')
  })

  // ── 6. phase 声明 ──────────────────────────────────────────────────────────
  test('phase 坏值：该条仍在 entries（按 application 处理）、problems 有句人话、不扰动整图 rev', async () => {
    const manifestOf = (patch: { id: string; value?: Record<string, unknown> }): string =>
      JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: IDS.map((id, index) => ({
          id,
          file: 'client.js',
          platform: 'web',
          ...(index < 6 ? { phase: 'early' } : {}),
          ...(id === patch.id ? (patch.value ?? {}) : {}),
        })),
      })
    const before = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as BootGraph
    writeFileSync(join(pluginsDir, 'manifest.json'), manifestOf({ id: 'p07', value: { phase: 'later' } }))
    const bad = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as BootGraph
    expect(bad.entries.some((entry) => entry.id === 'p07')).toBe(true)
    expect(server.problems().some((line) => line.includes('p07') && line.includes('phase')), server.problems().join(' | ')).toBe(true)
    expect(bad.rev).toBe(before.rev)
  })

  test('改一个 phase 声明：整图 rev 变，p07 进 early 批、application 批少一个', async () => {
    const manifestOf = (patch: { id: string; value?: Record<string, unknown> }): string =>
      JSON.stringify({
        version: 1,
        apiVersion: '2.0.0',
        plugins: IDS.map((id, index) => ({
          id,
          file: 'client.js',
          platform: 'web',
          ...(index < 6 ? { phase: 'early' } : {}),
          ...(id === patch.id ? (patch.value ?? {}) : {}),
        })),
      })
    const before = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as BootGraph
    writeFileSync(join(pluginsDir, 'manifest.json'), manifestOf({ id: 'p07', value: { phase: 'early' } }))
    const moved = JSON.parse((await http('GET', server.port, '/api/boot', { cookie })).body) as BootGraph
    expect(moved.rev !== before.rev, `${before.rev} → ${moved.rev}`).toBe(true)
    expect(moved.batches[0]?.entries.includes('p07') && !moved.batches[1]?.entries.includes('p07')).toBe(true)
  })
})

/** 换代测试的跨用例读数（beforeAll 之外的段间状态）。 */
const factsHolder: Record<string, unknown> = {}

// ── 4. 到达协议：请求算术逐分支 ───────────────────────────────────────────────
describe('批 → 单资源回退（UiArrivalLedger）', () => {
  test('首批行让批执行：请求 = 批（1 次）', async () => {
    const table: Record<string, unknown> = {}
    const requests: string[] = []
    const host = {
      has: (id: string): boolean => typeof table[id] === 'function',
      load: async (url: string): Promise<void> => {
        requests.push(url)
        if (url === 'batch') {
          table['a'] = (): void => {}
          return
        }
        if (url === 'single-b') {
          table['b'] = (): void => {}
          return
        }
        throw new Error(`404: ${url}`)
      },
    }
    const ledger = new UiArrivalLedger()
    await ledger.arrive({ id: 'a', preferred: 'batch', fallback: 'single-a' }, host)
    expect(requests).toEqual(['batch'])

    await ledger.arrive({ id: 'b', preferred: 'batch', fallback: 'single-b' }, host)
    expect(requests).toEqual(['batch', 'single-b'])
    expect(host.has('a') && host.has('b'), '同批已注册的条目照常可用（一个 id 缺不影响其余）').toBe(true)

    let chain = ''
    try {
      await ledger.arrive({ id: 'c', preferred: 'batch', fallback: 'single-c' }, host)
    } catch (error) {
      chain = error instanceof Error ? error.message : String(error)
    }
    expect(chain.includes('single-c') && requests.filter((url) => url === 'batch').length === 1, chain).toBe(true)
  })

  test('传输失败：批×2（重试）+ 单资源×1 = 3 次；批已记失败后同批下一条只走单资源', async () => {
    const requests: string[] = []
    const table: Record<string, unknown> = {}
    const host = {
      has: (id: string): boolean => typeof table[id] === 'function',
      load: async (url: string): Promise<void> => {
        requests.push(url)
        if (url === 'batch') throw new Error('ECONNRESET')
        if (url === 'single-x') {
          table['x'] = (): void => {}
          return
        }
        if (url === 'single-y') {
          table['y'] = (): void => {}
          return
        }
        throw new Error(`404: ${url}`)
      },
    }
    const ledger = new UiArrivalLedger()
    await ledger.arrive({ id: 'x', preferred: 'batch', fallback: 'single-x' }, host)
    expect(requests).toEqual(['batch', 'batch', 'single-x'])
    await ledger.arrive({ id: 'y', preferred: 'batch', fallback: 'single-y' }, host)
    expect(requests.slice(3)).toEqual(['single-y'])
    expect(requests.filter((url) => url === 'batch').length).toBe(2)
  })
})
