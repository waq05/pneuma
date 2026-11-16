/**
 * 技能/插件市场安装链的分支补充测试：`market.ts` 里浏览阶段没有覆盖的安装与插件市场。
 *
 * 全部用假 `fetch` 与临时 HOME（缓存/落盘都隔离）：
 *   - 插件市场：索引 JSON 的三种形状、GitHub tree 的过滤与错误状态；
 *   - 技能安装：flat/dir/zip/repo-dir 四条落盘路径，以及「目标已存在、主文件超限、
 *     包里没有 SKILL.md、下载地址缺失、zip 路径穿越/压缩法不支持」这些拒绝分支。
 *
 * @module dsc/packages/config-core/tests/market-branches
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'
import { tempHome } from '../../../../tests/harness.js'

const home = tempHome('dsc-market-branches-')
mkdirSync(join(home.home, '.dsc'), { recursive: true })

const market = await import('../market.js')
type MarketEntry = Awaited<ReturnType<typeof market.browseMarketSource>>[number]

afterAll(() => home.restore())

interface Reply {
  status?: number
  statusText?: string
  body?: unknown
  raw?: string
  bytes?: Uint8Array
}
type Handler = (url: string, init: RequestInit) => Reply | undefined

const originalFetch = globalThis.fetch
let calls: Array<{ url: string; init: RequestInit }> = []

function installFetch(handler: Handler): void {
  calls = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const reply = handler(url, init ?? {})
    if (reply === undefined) throw new Error(`测试没配这条 URL：${url}`)
    const status = reply.status ?? 200
    const raw = reply.raw ?? JSON.stringify(reply.body ?? {})
    const bytes = reply.bytes ?? new TextEncoder().encode(raw)
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: reply.statusText ?? (status === 200 ? 'OK' : 'ERR'),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      json: async () => JSON.parse(raw) as unknown,
    } as unknown as Response
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

const tmpDirs: string[] = []
function destDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-market-dest-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** 造一个 stored（method 0）zip；用于走 readZip 的中央目录解析。 */
function storedZip(files: Array<{ path: string; text: string }>, method = 0): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const data = Buffer.from(file.text, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x0403_4b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x0201_4b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x0605_4b50, 0)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, centralBuf, eocd]))
}

// ── 插件市场 ─────────────────────────────────────────────────────────────────

test('插件市场索引：数组/{plugins}/{items} 都认，坏条目与 .js 过滤', async () => {
  const source = { name: 'index', url: 'https://ex.com/plugins/index.json' }
  installFetch(() => ({
    body: [
      { name: 'alpha' },
      { name: 'beta', file: 'sub/beta.js', description: 'B', version: '1' },
      { name: 'gamma', file: 'gamma.txt' },
      { name: '' },
      'bad',
      { name: ' alpha ' },
    ],
  }))
  const entries = await market.browsePluginMarketSource(source)
  expect(entries.map((entry) => entry.name)).toEqual(['alpha', 'beta', 'alpha'])
  expect(entries[0]).toMatchObject({
    kind: 'flat',
    mainFile: 'alpha.js',
    description: '',
    source: 'index',
  })
  expect(entries[1]).toMatchObject({ mainFile: 'beta.js', description: 'B', version: '1' })
  expect(entries[1]!.root).toBe('https://ex.com/plugins/sub')

  installFetch(() => ({ body: { plugins: [{ name: 'p' }] } }))
  expect(await market.browsePluginMarketSource({ ...source, url: 'https://ex.com/a/index.json' })).toHaveLength(1)
  installFetch(() => ({ body: { items: [{ name: 'i' }] } }))
  expect(await market.browsePluginMarketSource({ ...source, url: 'https://ex.com/b/index.json' })).toHaveLength(1)
  installFetch(() => ({ body: { nope: [] } }))
  await expect(market.browsePluginMarketSource({ ...source, url: 'https://ex.com/c/index.json' })).rejects.toThrow(
    /找不到 plugins 数组/,
  )
})

test('插件市场 GitHub：前缀/大小/非 .js 过滤；403/422 与其他状态、非法源各有错误', async () => {
  const source = { name: 'gh', url: 'https://github.com/o/r/tree/main/plugins' }
  installFetch((url) => {
    if (!url.includes('/git/trees/')) return undefined
    return {
      body: {
        tree: [
          { path: 'plugins/a.js', type: 'blob', size: 10 },
          { path: 'plugins/b.js', type: 'blob', size: 2_000_000 },
          { path: 'plugins/sub/c.js', type: 'blob' },
          { path: 'plugins/readme.md', type: 'blob' },
          { path: 'other/d.js', type: 'blob' },
          { path: 'plugins/dir', type: 'tree' },
        ],
      },
    }
  })
  expect((await market.browsePluginMarketSource(source)).map((entry) => entry.name)).toEqual(['a', 'c'])

  installFetch(() => ({ status: 403, statusText: 'Forbidden' }))
  await expect(market.browsePluginMarketSource(source)).rejects.toThrow(/GITHUB_TOKEN/)
  installFetch(() => ({ status: 422, statusText: 'Unprocessable' }))
  await expect(market.browsePluginMarketSource(source)).rejects.toThrow(/GITHUB_TOKEN/)
  installFetch(() => ({ status: 500, statusText: 'Server Error' }))
  await expect(market.browsePluginMarketSource(source)).rejects.toThrow(/GitHub API 500/)
  installFetch(() => ({ body: {} }))
  await expect(
    market.browsePluginMarketSource({ name: 'x', url: 'https://example.com/not-github' }),
  ).rejects.toThrow(/既不是 GitHub 目录链接/)
})

test('installPluginMarketEntry：落盘用 mainFile 的 basename；超过 1.5MB 拒绝', async () => {
  const dir = destDir()
  installFetch(() => ({ raw: '// plugin' }))
  const target = await market.installPluginMarketEntry(
    { name: 'p', description: '', source: 's', kind: 'flat', root: 'https://ex.com/plugins', mainFile: 'sub/p.js', files: [] },
    dir,
  )
  expect(target).toBe(join(dir, 'p.js'))
  expect(readFileSync(target, 'utf8')).toBe('// plugin')

  installFetch(() => ({ bytes: new Uint8Array(1_500_001) }))
  await expect(
    market.installPluginMarketEntry(
      { name: 'big', description: '', source: 's', kind: 'flat', root: 'https://ex.com', mainFile: 'big.js', files: [] },
      destDir(),
    ),
  ).rejects.toThrow(/超过 1\.5 MB|超过/)
})

// ── 技能安装 ─────────────────────────────────────────────────────────────────

const entryOf = (patch: Partial<MarketEntry>): MarketEntry => ({
  name: 'demo',
  description: '',
  source: 's',
  kind: 'flat',
  root: 'https://ex.com/demo',
  mainFile: 'SKILL.md',
  files: [],
  ...patch,
})

test('installMarketEntry：目标已存在先拒；flat 成功；主文件超限报清楚', async () => {
  const existing = destDir()
  writeFileSync(join(existing, 'demo.md'), 'old', 'utf8')
  await expect(market.installMarketEntry(entryOf({ kind: 'flat' }), existing)).rejects.toThrow(/本地已有 demo/)

  const dir = destDir()
  installFetch((url) => (url.endsWith('/demo.md') ? { raw: '# 技能' } : undefined))
  const written = await market.installMarketEntry(entryOf({ mainFile: 'demo.md' }), dir)
  expect(written).toEqual({ target: join(dir, 'demo.md'), files: 1 })
  expect(readFileSync(join(dir, 'demo.md'), 'utf8')).toBe('# 技能')

  installFetch(() => ({ bytes: new Uint8Array(1_500_001) }))
  await expect(market.installMarketEntry(entryOf({ name: 'huge' }), destDir())).rejects.toThrow(/拉取 SKILL\.md 失败/)
})

test('installMarketEntry：dir 的附属文件取不到不阻塞；目录包正文与附件落盘', async () => {
  const dir = destDir()
  installFetch((url) => {
    if (url.endsWith('/SKILL.md')) return { raw: '# 正文' }
    if (url.endsWith('/ref.md')) throw new Error('这一份取不到')
    return { raw: 'extra' }
  })
  const result = await market.installMarketEntry(
    entryOf({ name: 'pkg', kind: 'dir', root: 'pkg', rawBase: 'https://raw.example/o/r/main', files: ['ref.md', 'templates/t.md'] }),
    dir,
  )
  expect(result).toEqual({ target: join(dir, 'pkg'), files: 2 })
  expect(readFileSync(join(dir, 'pkg', 'SKILL.md'), 'utf8')).toBe('# 正文')
  // templates/t.md 的 raw 返回了内容，写盘成功；ref.md 抛错被吞掉。
  expect(existsSync(join(dir, 'pkg', 'templates', 't.md'))).toBe(true)
  expect(existsSync(join(dir, 'pkg', 'ref.md'))).toBe(false)
})

test('zip 安装：换下载地址、解包写入；缺下载地址/坏 zip/路径穿越/压缩法不支持都拒绝', async () => {
  const zip = storedZip([
    { path: 'SKILL.md', text: '# zip 技能' },
    { path: 'refs/a.md', text: 'A' },
    { path: 'empty/', text: '' },
  ])
  const root = 'https://clawhub.ai/api/v1/skills/demo/install'
  installFetch((url) => {
    if (url === root) return { body: { ok: true, archive: { downloadUrl: 'https://cdn.example/demo.zip' } } }
    if (url === 'https://cdn.example/demo.zip') return { bytes: zip }
    return undefined
  })
  const dir = destDir()
  expect(await market.installMarketEntry(entryOf({ name: 'zipped', kind: 'zip', root }), dir)).toEqual({
    target: join(dir, 'zipped'),
    files: 2,
  })
  expect(readFileSync(join(dir, 'zipped', 'SKILL.md'), 'utf8')).toBe('# zip 技能')
  expect(readFileSync(join(dir, 'zipped', 'refs', 'a.md'), 'utf8')).toBe('A')

  installFetch(() => ({ body: { ok: false } }))
  await expect(
    market.installMarketEntry(entryOf({ name: 'gone', kind: 'zip', root }), destDir()),
  ).rejects.toThrow(/没有给出下载地址/)

  installFetch((url) => {
    if (url.endsWith('/install')) return { body: { ok: true, archive: { downloadUrl: 'https://cdn.example/bad.zip' } } }
    return { raw: '不是 zip' }
  })
  await expect(
    market.installMarketEntry(entryOf({ name: 'bad', kind: 'zip', root: 'https://x.example/install' }), destDir()),
  ).rejects.toThrow(/不是 zip/)

  installFetch((url) => {
    if (url.endsWith('/install')) return { body: { ok: true, archive: { downloadUrl: 'https://cdn.example/evil.zip' } } }
    return { bytes: storedZip([{ path: '../evil/SKILL.md', text: 'x' }]) }
  })
  await expect(
    market.installMarketEntry(entryOf({ name: 'evil', kind: 'zip', root: 'https://y.example/install' }), destDir()),
  ).rejects.toThrow(/不安全的路径/)

  installFetch((url) => {
    if (url.endsWith('/install')) return { body: { ok: true, archive: { downloadUrl: 'https://cdn.example/method.zip' } } }
    return { bytes: storedZip([{ path: 'SKILL.md', text: 'x' }], 99) }
  })
  await expect(
    market.installMarketEntry(entryOf({ name: 'method', kind: 'zip', root: 'https://z.example/install' }), destDir()),
  ).rejects.toThrow(/不支持的压缩法/)
})

test('repo-dir 安装：按仓库树定位 SKILL.md 再走 raw；仓库地址认不出/API 失败/找不到主文件各有错误', async () => {
  const api = 'https://api.github.com/repos/o/r/git/trees/HEAD?recursive=1'
  installFetch((url) => {
    if (url === api) {
      return {
        body: {
          tree: [
            { path: 'skills/foo/SKILL.md', type: 'blob' },
            { path: 'skills/foo/ref.md', type: 'blob' },
            { path: 'skills/foo/deep/x.md', type: 'blob' },
            { path: 'other/y.md', type: 'blob' },
          ],
        },
      }
    }
    if (url.startsWith('https://raw.githubusercontent.com/o/r/HEAD/skills/foo/')) return { raw: `内容 ${url}` }
    return undefined
  })
  const dir = destDir()
  const result = await market.installMarketEntry(
    entryOf({ name: 'foo', kind: 'repo-dir', root: 'o/r', mainFile: 'skills/foo' }),
    dir,
  )
  expect(result.files).toBe(3)
  expect(readFileSync(join(dir, 'foo', 'SKILL.md'), 'utf8')).toContain('skills/foo/SKILL.md')
  expect(existsSync(join(dir, 'foo', 'ref.md'))).toBe(true)

  await expect(
    market.installMarketEntry(entryOf({ name: 'bad', kind: 'repo-dir', root: 'no-slash' }), destDir()),
  ).rejects.toThrow(/仓库地址认不出/)
})

test('repo-dir 安装：API 非 2xx 与树里没有 SKILL.md 都给出可照做的错误', async () => {
  const api = 'https://api.github.com/repos/o/r2/git/trees/HEAD?recursive=1'
  installFetch(() => ({ status: 404, statusText: 'Not Found' }))
  await expect(
    market.installMarketEntry(entryOf({ name: 'x', kind: 'repo-dir', root: 'o/r2', mainFile: 'skills/x' }), destDir()),
  ).rejects.toThrow(/GitHub API 404/)

  installFetch((url) => (url === api ? { body: { tree: [{ path: 'skills/other/SKILL.md', type: 'blob' }] } } : undefined))
  await expect(
    market.installMarketEntry(entryOf({ name: 'x', kind: 'repo-dir', root: 'o/r2', mainFile: 'skills/x' }), destDir()),
  ).rejects.toThrow(/找不到 skills\/x\/SKILL\.md/)
})
