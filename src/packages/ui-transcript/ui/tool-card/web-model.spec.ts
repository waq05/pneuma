/**
 * web_search / webfetch 工具卡的判据与双源解析（ui 层）。
 *
 * 来源：`scripts/ui-tool-web-test.mjs` 第 [1]–[3] 段（判据、链接判据、结构化卡片、文本兜底）
 * 与第 [4] 段的字典键。`web-model.ts` 零 import；文本兜底用的围栏是**真的**
 * `wrapUntrusted`（`src/core/untrusted.ts`，探针时代读的是它的编译产物），所以
 * 「围栏 / 宿主说明被剥掉」验的是产品行为，不是探针自己拼的字符串。
 * 原探针的装配 / 类名清单 / 「any 禁用」等源码钉不迁——归组件渲染批。
 *
 * @module dsc-ui-transcript/ui/tool-card/web-model.spec
 */
import { expect, test } from 'vitest'
import { wrapUntrusted } from '@pneuma/runtime/core/untrusted.js'
import en from '../../locale/ui.en.json'
import zh from '../../locale/ui.zh.json'
import { isHttpSource, webCallOf, webResultOf } from './web-model.js'

// ── 判据：名字 + 参数缺一不可 ────────────────────────────────────────────────

test('web_search + query → 一张搜索卡', () => {
  const call = webCallOf('web_search', JSON.stringify({ query: 'pneuma 工具卡' }))
  expect(call).toEqual({ kind: 'search', query: 'pneuma 工具卡' })
})

test('queries 数组取第一条（dsh 的参数形状）；query 与 queries 都在时 query 优先', () => {
  expect(webCallOf('web_search', JSON.stringify({ queries: ['第一条', '第二条'] }))).toEqual({
    kind: 'search',
    query: '第一条',
  })
  expect(webCallOf('web_search', '{"query":"a","queries":["b"]}')?.kind === 'search' &&
    (webCallOf('web_search', '{"query":"a","queries":["b"]}') as { query: string }).query).toBe('a')
})

test('web_search 没有 query / queries、query 空白、queries 空数组、queries 混坏值 → 都不是这张卡', () => {
  expect(webCallOf('web_search', '{"count":3}')).toBeNull()
  expect(webCallOf('web_search', '{"query":"   "}')).toBeNull()
  expect(webCallOf('web_search', '{"queries":[]}')).toBeNull()
  // 一条坏值整份不认：不留半条 query。
  expect(webCallOf('web_search', '{"queries":["a",""]}')).toBeNull()
})

test('webfetch + url → 一张抓取卡；web_fetch 同一形状也认', () => {
  expect(webCallOf('webfetch', '{"url":"https://example.com/a"}')).toEqual({
    kind: 'fetch',
    url: 'https://example.com/a',
  })
  expect(webCallOf('web_fetch', '{"url":"https://example.com"}')?.kind).toBe('fetch')
})

test('fetch 这个通用名不认（别家 MCP 工具常叫这个名，不一定抓网页）', () => {
  expect(webCallOf('fetch', '{"url":"https://example.com"}')).toBeNull()
})

test('webfetch 缺 url / url 空白 → 不是这张卡；名字与参数不匹配的都不要', () => {
  expect(webCallOf('webfetch', '{"url":"   "}')).toBeNull()
  expect(webCallOf('webfetch', '{"href":"https://example.com"}')).toBeNull()
  expect(webCallOf('web_search', '{"url":"https://example.com"}')).toBeNull()
  expect(webCallOf('webfetch', '{"query":"x"}')).toBeNull()
  expect(webCallOf('browser', '{"url":"https://example.com"}')).toBeNull()
})

test('半截 JSON 不抛；参数是数组 → 不是这张卡', () => {
  expect(webCallOf('web_search', '{"query":')).toBeNull()
  expect(webCallOf('web_search', '[]')).toBeNull()
  expect(webCallOf('webfetch', '[]')).toBeNull()
})

// ── 链接判据：只有 http(s) 能画成可点链接 ────────────────────────────────────

test('https / http 是外链', () => {
  expect(isHttpSource('https://a.example/x')).toBe(true)
  expect(isHttpSource('http://a.example')).toBe(true)
})

test('空串、javascript:、data:、裸域名都不是链接（点一下就是执行别人的脚本）', () => {
  expect(isHttpSource('')).toBe(false)
  expect(isHttpSource('javascript:alert(1)')).toBe(false)
  expect(isHttpSource('data:text/html,<script>')).toBe(false)
  expect(isHttpSource('a.example/x')).toBe(false)
})

// ── 结构化卡片 ───────────────────────────────────────────────────────────────

const searchCall = webCallOf('web_search', '{"query":"pneuma"}') as NonNullable<ReturnType<typeof webCallOf>>
const fetchCall = webCallOf('webfetch', '{"url":"https://example.com/a"}') as NonNullable<ReturnType<typeof webCallOf>>

/** 结果文本故意给一段**能解析**的清单：结构化数据在时它一个字都不该被读。 */
const TEXTISH = '1. 文本里的标题\nhttps://text.example/x\n文本摘要'

test('卡片数据在 → 走结构化分支（不解析文本），来源逐条带出', () => {
  const card = webResultOf(
    searchCall,
    {
      result: {
        card: 'web',
        kind: 'search',
        sources: [
          { title: '标题一', url: 'https://a.example/one', snippet: '摘要一' },
          { title: '标题二', url: 'https://b.example/two' },
        ],
        answer: '提供方给的整段摘要',
        truncated: true,
      },
    },
    TEXTISH,
  )
  expect(card?.kind).toBe('search')
  expect(card?.sources).toHaveLength(2)
  expect(card?.sources[0]?.url).toBe('https://a.example/one')
  expect(card?.sources[0]?.snippet).toBe('摘要一')
  expect(card?.sources[1]?.title).toBe('标题二')
  expect(card?.sources[1]?.snippet).toBeNull()
  expect(card?.answer).toBe('提供方给的整段摘要')
  expect(card?.truncated).toBe(true)
})

test('truncated 缺省 false；零来源也是合法的搜索卡（画「没有结果」）', () => {
  const none = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [] } }, undefined)
  expect(none?.truncated).toBe(false)
  expect(none?.kind).toBe('search')
  expect(none?.sources).toHaveLength(0)
})

test('没有 kind 时按形状推断：sources 是数组 → 搜索卡；url 是字符串 → 抓取卡', () => {
  const search = webResultOf(searchCall, { result: { card: 'web', sources: [{ url: 'https://a.example' }] } }, undefined)
  expect(search?.kind).toBe('search')
  const fetch = webResultOf(null, { result: { card: 'web', url: 'https://a.example' } }, undefined)
  expect(fetch?.kind).toBe('fetch')
})

test('坏一条就整份 null：url / title / snippet / sources / answer / truncated / 条目不合格都不猜', () => {
  expect(webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [{ url: 42 }] } }, undefined)).toBeNull()
  expect(webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [{ url: 'https://a', title: 7 }] } }, undefined)).toBeNull()
  expect(webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [{ url: 'https://a', snippet: {} }] } }, undefined)).toBeNull()
  expect(webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: 'x' } }, undefined)).toBeNull()
  expect(webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [], answer: 1 } }, undefined)).toBeNull()
  expect(webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [], truncated: 'yes' } }, undefined)).toBeNull()
  expect(webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: ['https://a'] } }, undefined)).toBeNull()
})

test('抓取卡：url + statusCode 带出，truncated 透传；statusCode 缺省 null', () => {
  const card = webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: 'https://example.com/a', statusCode: 404, truncated: true } }, undefined)
  expect(card?.kind).toBe('fetch')
  expect(card?.url).toBe('https://example.com/a')
  expect(card?.statusCode).toBe(404)
  expect(card?.truncated).toBe(true)
  const noStatus = webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: 'https://example.com/a' } }, undefined)
  expect(noStatus?.statusCode).toBeNull()
})

test('statusCode 小数 / 字符串 → 整份 null；抓取卡没有 url 或 url 空串 → 整份 null', () => {
  expect(webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: 'https://example.com/a', statusCode: 200.5 } }, undefined)).toBeNull()
  expect(webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: 'https://example.com/a', statusCode: '404' } }, undefined)).toBeNull()
  expect(webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', statusCode: 200 } }, undefined)).toBeNull()
  expect(webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: '', statusCode: 200 } }, undefined)).toBeNull()
})

test('空串标题 / 摘要按「没给」处理（渲染层退回用 URL 当标签）', () => {
  const card = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [{ url: 'https://a', title: '', snippet: '' }] } }, undefined)
  expect(card?.sources[0]?.title).toBeNull()
  expect(card?.sources[0]?.snippet).toBeNull()
})

test("card 不是 'web' → 不走结构化分支（回落文本解析）；presentation 缺席同样走文本", () => {
  const other = webResultOf(searchCall, { result: { card: 'diff', sources: [{ url: 'https://card.example/x' }] } }, TEXTISH)
  expect(other?.sources[0]?.url).toBe('https://text.example/x')
  expect(webResultOf(searchCall, { result: null }, TEXTISH)?.sources).toHaveLength(1)
  expect(webResultOf(searchCall, undefined, TEXTISH)?.sources).toHaveLength(1)
})

test('抓取卡没有卡片数据 → null（正文没有可解析的清单）；调用参数与卡片数据都没有 → null', () => {
  expect(webResultOf(fetchCall, undefined, 'Fetched https://example.com/a (HTTP 200)')).toBeNull()
  expect(webResultOf(null, undefined, TEXTISH)).toBeNull()
})

test('搜索卡结果为空（还在跑）→ null', () => {
  expect(webResultOf(searchCall, undefined, undefined)).toBeNull()
  expect(webResultOf(searchCall, undefined, '')).toBeNull()
})

// ── 文本兜底 ─────────────────────────────────────────────────────────────────

/** 宿主那段文本的正文（web-search 插件交来的编号清单形状）。 */
const BODY = [
  '搜索「pneuma」共 2 条结果（提供方 tavily）：',
  '1. 第一条标题',
  '   https://a.example/one',
  '   第一段摘要',
  '   第二段摘要',
  '2. 第二条标题',
  '   https://b.example/two',
  '   第二条的摘要',
].join('\n')

test('编号清单解析出 2 条来源，多行摘要压成一行', () => {
  const parsed = webResultOf(searchCall, undefined, wrapUntrusted('web-search', BODY))
  expect(parsed?.kind).toBe('search')
  expect(parsed?.sources).toHaveLength(2)
  expect(parsed?.sources[0]?.url).toBe('https://a.example/one')
  expect(parsed?.sources[0]?.title).toBe('第一条标题')
  expect(parsed?.sources[1]?.url).toBe('https://b.example/two')
  expect(parsed?.sources[1]?.title).toBe('第二条标题')
  expect(parsed?.sources[0]?.snippet).toBe('第一段摘要 第二段摘要')
  expect(parsed?.sources[0]?.snippet).not.toContain('\n')
  expect(parsed?.answer).toBeNull()
  expect(parsed?.truncated).toBe(false)
})

test('围栏、围栏里那句说明、宿主的抬头：都是宿主说明，一个字都没进 notes', () => {
  const parsed = webResultOf(searchCall, undefined, wrapUntrusted('web-search', BODY))
  const notes = parsed?.notes ?? []
  expect(notes).toHaveLength(0)
  expect(notes.some((note) => note.includes('external_content'))).toBe(false)
  expect(notes.some((note) => note.includes('以下内容由外部来源提供'))).toBe(false)
  expect(notes.some((note) => note.includes('条结果（提供方'))).toBe(false)
})

test('坏块（编号行下一行不是 URL）→ 整份 null；编号块后面没有 URL 行 → 整份 null', () => {
  const broken = webResultOf(searchCall, undefined, wrapUntrusted('web-search', BODY.replace('   https://b.example/two', '   第二条的摘要写在了这里')))
  expect(broken).toBeNull()
  expect(webResultOf(searchCall, undefined, '1. 只有标题')).toBeNull()
})

test('「没有搜到结果」→ 空来源的搜索卡，宿主原话走 notes', () => {
  // 宿主回的是没包围栏的一句原话。
  const none = webResultOf(searchCall, undefined, '「pneuma」没有搜到结果。换个更具体的关键词再试。')
  expect(none?.kind).toBe('search')
  expect(none?.sources).toHaveLength(0)
  expect(none?.notes).toHaveLength(1)
  expect(none?.notes[0]).toContain('没有搜到结果')
  expect(none?.truncated).toBe(false)
  expect(none?.answer).toBeNull()
})

test('报错散文、只有围栏没有清单 → null；CRLF、缩进三格也认；非 http(s) 的「链接」行不算来源', () => {
  expect(webResultOf(searchCall, undefined, 'HTTP 429：too many requests')).toBeNull()
  expect(webResultOf(searchCall, undefined, wrapUntrusted('web-search', '一段没有编号的网页文本'))).toBeNull()
  expect(webResultOf(searchCall, undefined, '1. 标题\r\nhttps://a.example\r\n摘要')?.sources).toHaveLength(1)
  expect(webResultOf(searchCall, undefined, '1. 标题\n      https://a.example\n摘要')?.sources[0]?.url).toBe('https://a.example')
  expect(webResultOf(searchCall, undefined, '1. 标题\njavascript:alert(1)')).toBeNull()
})

// ── 界面截断的三种落法（adapter/transcript.ts 的 RESULT_TEXT_LIMIT=1500） ────

const LIMIT = 1501
/** 把一段文本补到恰好 1501 字并以省略号收尾（模拟界面截断的形状）。 */
const padTo = (head: string): string => `${head}${'p'.repeat(Math.max(0, LIMIT - head.length - 1))}…`

test('切在链接中间：半截链接不画成来源，前面收好的留下，标「不完整」', () => {
  const text = padTo('1. 第一条\nhttps://a.example/one\n摘要\n2. 第二条\nhttps://b.example/')
  expect(text).toHaveLength(LIMIT)
  const parsed = webResultOf(searchCall, undefined, text)
  expect(parsed?.sources).toHaveLength(1)
  expect(parsed?.sources[0]?.url).toBe('https://a.example/one')
  expect(parsed?.truncated).toBe(true)
})

test('切在标题中间：丢最后那一块，前面的来源照留，标「不完整」', () => {
  const parsed = webResultOf(searchCall, undefined, padTo('1. 第一条\nhttps://a.example/one\n摘要\n2. 第二条的标题被切'))
  expect(parsed?.sources).toHaveLength(1)
  expect(parsed?.truncated).toBe(true)
})

test('切在摘要里：清单本身完整，来源都在，仍标「不完整」', () => {
  const parsed = webResultOf(searchCall, undefined, padTo('1. 第一条\nhttps://a.example/one\n摘要\n2. 第二条\nhttps://b.example/two\n第二条的摘要被切'))
  expect(parsed?.sources).toHaveLength(2)
  expect(parsed?.truncated).toBe(true)
})

test('反面对照：文本没被截、摘要自己以省略号结尾（提供方就爱这么截）→ 不算「不完整」', () => {
  const parsed = webResultOf(searchCall, undefined, '1. 标题\nhttps://a.example/one\n摘要结尾是一串省略号……')
  expect(parsed?.truncated).toBe(false)
  expect(parsed?.sources).toHaveLength(1)
})

// ── 本卡字典键（数据断言，正好 8 个） ────────────────────────────────────────

const WEB_KEYS = [
  'transcript.tool.webResultCount',
  'transcript.tool.webNoResult',
  'transcript.tool.webTruncated',
  'transcript.tool.webAnswer',
  'transcript.tool.webHttp',
  'transcript.tool.webContentTruncated',
  'transcript.tool.webSearching',
  'transcript.tool.webFetching',
] as const

test('web 卡的八个键两份字典都在（非空字符串，英文真译过）', () => {
  for (const key of WEB_KEYS) {
    expect(typeof zh[key] === 'string' && (zh[key] as string).trim() !== '', `zh 有 ${key}`).toBe(true)
    expect(typeof en[key] === 'string' && (en[key] as string).trim() !== '', `en 有 ${key}`).toBe(true)
    expect(/[\u4e00-\u9fff]/.test(String(en[key] ?? '')), `${key} 的英文里没有汉字`).toBe(false)
  }
})
