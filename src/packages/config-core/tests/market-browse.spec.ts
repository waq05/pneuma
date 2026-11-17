/**
 * 技能市场的浏览面（`packages/config-core/market.ts`）：四类源的取数与缓存。
 *
 * 网络全用假 `fetch`：这里钉的是「地址怎么拼、响应怎么收窄、坏数据怎么跳过」，
 * 真联网归集成层。缓存落 `~/.dsc/cache/`，所以先换临时 HOME 再动态 import——
 * 与 hooks 的批准名单同一个理由（路径在 import 期算定）。
 *
 * @module dsc/packages/config-core/tests/market-browse.spec
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../../tests/harness.js'

const home = tempHome('dsc-market-browse-')
// 缓存目录由 dscPath() 在 import 期算定；先换 HOME，再动态 import。
mkdirSync(join(home.home, '.dsc'), { recursive: true })

type MarketModule = typeof import('../market.js')
let market: MarketModule

beforeAll(async () => {
  market = await import('../market.js')
})

afterAll(() => {
  home.restore()
})

type Reply = { status?: number; statusText?: string; body?: unknown; raw?: string }
type Handler = (url: string, init: RequestInit) => Reply | undefined

const originalFetch = globalThis.fetch
let calls: Array<{ url: string; init: RequestInit }> = []

/** 装一个按 URL 路由的假 fetch：没配路由就抛错（漏配比静默 200 好查）。 */
function installFetch(handler: Handler): void {
  calls = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const reply = handler(url, init ?? {})
    if (reply === undefined) throw new Error(`测试没配这条 URL：${url}`)
    const status = reply.status ?? 200
    const payload = reply.raw ?? JSON.stringify(reply.body ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: reply.statusText ?? (status === 200 ? 'OK' : 'ERR'),
      arrayBuffer: async () => new TextEncoder().encode(payload).buffer,
      json: async () => JSON.parse(payload) as unknown,
    } as unknown as Response
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
})

const clawhub = { name: 'ClawHub', url: 'https://clawhub.ai/api/v1/skills?sort=downloads' }
const skillsSh = { name: 'skills.sh', url: 'https://skills.sh/api/search' }

describe('ClawHub：榜单条目与 zip 安装地址', () => {
  test('字段逐个收窄；缺 slug/owner 的跳过；描述按 summary→displayName→占位', async () => {
    installFetch(() => ({
      body: {
        items: [
          {
            slug: 'pdf',
            ownerHandle: 'alice',
            summary: '处理 PDF',
            latestVersion: { version: '1.2' },
            stats: { downloads: 10, installs: 'nope', stars: 3 },
          },
          { slug: 'img', ownerHandle: 'bob', summary: '', displayName: '图片工具', latestVersion: null, stats: null },
          { slug: 'no-owner' },
          'bad-item',
        ],
      },
    }))
    const entries = await market.browseMarketSource(clawhub)
    expect(calls[0]!.url).toBe('https://clawhub.ai/api/v1/skills?sort=downloads')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      name: 'pdf',
      description: '处理 PDF',
      version: '1.2',
      kind: 'zip',
      mainFile: 'SKILL.md',
      stats: { downloads: 10, installs: undefined, stars: 3 },
    })
    expect(entries[0]!.root).toBe('https://clawhub.ai/api/v1/skills/pdf/install?owner=alice&version=1.2')
    expect(entries[1]).toMatchObject({ name: 'img', description: '图片工具', version: undefined, kind: 'zip' })
    expect(entries[1]!.root).toBe('https://clawhub.ai/api/v1/skills/img/install?owner=bob')
    expect(entries[1]!.stats).toEqual({ downloads: undefined, installs: undefined, stars: undefined })
  })

  test('命中缓存不再联网；refresh 强制重拉；缓存坏了就重拉', async () => {
    // 换一个源地址：上面的用例已经把默认榜单写进缓存了。
    const source = { name: 'ClawHub', url: 'https://clawhub.ai/api/v1/skills?sort=stars&limit=5' }
    installFetch(() => ({ body: { items: [{ slug: 'one', ownerHandle: 'o' }] } }))
    await market.browseMarketSource(source)
    const afterFirst = calls.length
    expect(afterFirst).toBe(1)
    expect(calls[0]!.url).toBe(source.url)

    await market.browseMarketSource(source)
    expect(calls.length).toBe(afterFirst)

    await market.browseMarketSource(source, { refresh: true })
    expect(calls.length).toBe(afterFirst + 1)

    // 把缓存都写坏：下一次读缓存失败，应重新联网而不是直接报错。
    const cacheDir = join(home.home, '.dsc', 'cache')
    for (const name of readdirSync(cacheDir)) writeFileSync(join(cacheDir, name), '{坏掉的', 'utf8')
    const entries = await market.browseMarketSource(source)
    expect(entries).toHaveLength(1)
    expect(calls.length).toBe(afterFirst + 2)
  })
})

describe('skills.sh：只做搜索，缓存键带关键词', () => {
  test('关键词少于 2 字直接说清楚；命中结果按 repo/技能名收窄', async () => {
    installFetch(() => ({ body: { skills: [] } }))
    await expect(market.browseMarketSource(skillsSh, { query: 'p' })).rejects.toThrow(/至少 2 个字符/)
    expect(calls).toHaveLength(0)

    installFetch(() => ({
      body: {
        skills: [
          { skillId: 'pdf-x', source: 'o/r', installs: 1234 },
          { skillId: 'plain', source: 'a/b' },
          { skillId: '', source: 'x/y' },
          { skillId: 'no-repo', source: '' },
          null,
        ],
      },
    }))
    const entries = await market.browseMarketSource(skillsSh, { query: 'pdf' })
    expect(calls[0]!.url).toContain('q=pdf')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ name: 'pdf-x', kind: 'repo-dir', root: 'o/r', mainFile: 'pdf-x' })
    expect(entries[0]!.description).toContain('1,234 次安装')
    expect(entries[1]!.description).toContain('a/b 里的技能')

    // 换关键词是另一次查询（缓存键不同），不是命中上一条。
    await market.browseMarketSource(skillsSh, { query: 'word' })
    expect(calls).toHaveLength(2)
  })
})

describe('索引 JSON：数组 / {skills} / {items} 三种形状', () => {
  const source = { name: 'index', url: 'https://example.com/skills/index.json' }

  test('flat 与 dir 各按路径判定；坏条目跳过；files 只留字符串', async () => {
    installFetch(() => ({
      body: {
        skills: [
          { name: 'a', path: 'a.md', description: 'd', version: '1', files: ['x', 'y', 3] },
          { name: 'pkg', path: 'pkg', description: 'p' },
          { name: '默认' },
          { name: '' },
          42,
        ],
      },
    }))
    const entries = await market.browseMarketSource(source)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({
      name: 'a',
      kind: 'flat',
      root: 'https://example.com/skills',
      mainFile: 'a.md',
      description: 'd',
      version: '1',
      files: ['x', 'y'],
    })
    expect(entries[1]).toMatchObject({ name: 'pkg', kind: 'dir', mainFile: 'pkg' })
    expect(entries[2]).toMatchObject({ name: '默认', kind: 'flat', mainFile: 'SKILL.md' })
  })

  test('裸数组与 {items} 都认；找不到数组给明确错误', async () => {
    installFetch(() => ({ body: [{ name: 'arr', path: 'arr.md' }] }))
    expect(await market.browseMarketSource({ name: 'i', url: 'https://ex.com/a.json' })).toHaveLength(1)

    installFetch(() => ({ body: { items: [{ name: 'it', path: 'it.md' }] } }))
    expect(await market.browseMarketSource({ name: 'i', url: 'https://ex.com/b.json' })).toHaveLength(1)

    installFetch(() => ({ body: { nope: [] } }))
    await expect(market.browseMarketSource({ name: 'i', url: 'https://ex.com/c.json' })).rejects.toThrow(
      /索引里找不到 skills 数组/,
    )
  })
})

describe('GitHub 目录：trees 列目录 + raw 补描述', () => {
  function ghSource(ref: string, dir: string): { name: string; url: string } {
    return { name: 'gh', url: `https://github.com/o/r/tree/${ref}/${dir}` }
  }

  /** 一个 ref + dir 的假后端：trees 给固定结构，raw 交给调用方决定。 */
  function ghHandler(ref: string, dir: string, raw: (url: string) => Reply | undefined): Handler {
    const trees = `https://api.github.com/repos/o/r/git/trees/${ref}?recursive=1`
    return (url) => {
      if (url === trees) {
        return {
          body: {
            tree: [
              { path: `${dir}/foo/SKILL.md`, type: 'blob' },
              { path: `${dir}/foo/ref.md`, type: 'blob' },
              { path: `${dir}/foo`, type: 'tree' },
              { path: `${dir}/flat.md`, type: 'blob' },
              { path: `${dir}/README.md`, type: 'blob' },
            ],
          },
        }
      }
      if (url.startsWith(`https://raw.githubusercontent.com/o/r/${ref}/`)) return raw(url)
      return undefined
    }
  }

  test('目录包与散装 md 分开收；frontmatter 补描述；raw 失败保留占位', async () => {
    installFetch(
      ghHandler('main', 'skills', (url) =>
        url.endsWith('/skills/foo/SKILL.md')
          ? { raw: '---\ndescription: 处理 PDF\nwhen-to-use: 导出时\n---\n正文' }
          : undefined,
      ),
    )
    const entries = await market.browseMarketSource(ghSource('main', 'skills'))
    expect(entries.map((entry) => entry.name).sort()).toEqual(['flat', 'foo'])

    const dir = entries.find((entry) => entry.name === 'foo')!
    expect(dir).toMatchObject({
      kind: 'dir',
      root: 'skills/foo',
      mainFile: 'SKILL.md',
      description: '处理 PDF · 何时用：导出时',
      rawBase: 'https://raw.githubusercontent.com/o/r/main',
    })
    expect(dir.files).toEqual(['ref.md'])

    // flat.md 的 raw 没配 → 取不到描述，保留占位而不是整次浏览失败。
    const flat = entries.find((entry) => entry.name === 'flat')!
    expect(flat).toMatchObject({ kind: 'flat', mainFile: 'flat.md', description: '未提供描述，安装后本地解析' })
  })

  test('GitHub API 403/422 提示配置 token；其它状态与非法源各有明确错误', async () => {
    installFetch(() => ({ status: 403, statusText: 'Forbidden' }))
    await expect(market.browseMarketSource(ghSource('dev', 'skills'))).rejects.toThrow(/GITHUB_TOKEN/)

    installFetch(() => ({ status: 422, statusText: 'Unprocessable' }))
    await expect(market.browseMarketSource(ghSource('quad', 'skills'))).rejects.toThrow(/GITHUB_TOKEN/)

    installFetch(() => ({ status: 500, statusText: 'Server Error' }))
    await expect(market.browseMarketSource(ghSource('quint', 'skills'))).rejects.toThrow(/GitHub API 500/)

    installFetch(() => ({ body: {} }))
    await expect(market.browseMarketSource({ name: 'x', url: 'https://example.com/not-github' })).rejects.toThrow(
      /既不是 GitHub 目录链接/,
    )
  })

  test('有 GITHUB_TOKEN 就带上 authorization（没有就不带）', async () => {
    installFetch(ghHandler('feat', 'skills', () => ({ raw: '---\ndescription: d\n---' })))
    await market.browseMarketSource(ghSource('feat', 'skills'))
    const treesCall = () => calls.find((call) => call.url.includes('/git/trees/'))!
    expect((treesCall().init.headers as Record<string, string>).authorization).toBeUndefined()

    process.env.GITHUB_TOKEN = 'tok-1'
    // 换一个 ref/dir 绕开缓存。
    installFetch(ghHandler('feat2', 'other', () => ({ raw: '---\ndescription: d\n---' })))
    await market.browseMarketSource(ghSource('feat2', 'other'))
    expect((treesCall().init.headers as Record<string, string>).authorization).toBe('Bearer tok-1')
  })
})
