/**
 * web 专用工具卡的探针（差距清单 S4 的第三批：`web_search` / `webfetch`）。
 *
 * 这张卡换掉的是「参数表 + 结果尾巴」那一脸：头行一枚读数（`3 条结果` / `HTTP 404`），展开体是
 * 来源清单（可点标题 + 摘要）或一条抓取链接。两条数据来源分开验：
 *
 *   1. **结构化卡片**（`presentation.result`，宿主按 dsh 的 `web` 卡词汇交来的）—— 优先；
 *   2. **文本兜底**（老会话、别家只回文本的搜索工具）—— 解析宿主管家那段编号清单。
 *
 * 验法与 `ui-tool-views-test.mjs` 同一条路子，但这一批两边都更结实：
 *   - **真代码**：`web-model.ts` 是纯函数、零 import，Node 的类型擦除直接载入（不是复刻）；
 *     文本兜底用的围栏也是**真的** `wrapUntrusted`（`lib/core/untrusted.js`，由 `src/core/untrusted.ts`
 *     编译而来），所以「围栏/宿主说明被剥掉」验的是产品行为，不是探针自己拼的字符串；
 *   - **源码钉**：`web-view.tsx` 是 TSX，Node 载不动 JSX，只能读源码钉类名、外链口径与导出面。
 *
 * 四节：
 *   [1] 判据：名字 + 参数（`query` / `queries` / `url`）缺一不可，半截 JSON 不抛
 *   [2] 结构化卡片：字段校验（坏一条整份 null）、档位推断、默认值
 *   [3] 文本兜底：编号清单解析、多行摘要压平、围栏与宿主说明剥掉、坏块整份 null、「没搜到」
 *   [4] 装配与本地化：外链口径、导出面、模型零 import、8 个字典键、代码里没有硬编码中文
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/ui-tool-web-test.mjs
 * （`check:ui` 自动收录，`scripts/check-ui.mjs` 会给每条探针加同一个 `--import`）
 *
 * @module dsc/scripts/ui-tool-web-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

/** 界面半的落点：transcript 在宿主包里（`src/packages/ui-transcript/ui`）。 */
const TOOL_CARD = 'src/packages/ui-transcript/ui/tool-card'
const WEB_MODEL = `${TOOL_CARD}/web-model.ts`
const WEB_VIEW = `${TOOL_CARD}/web-view.tsx`
const ZH = 'src/packages/ui-transcript/locale/ui.zh.json'
const EN = 'src/packages/ui-transcript/locale/ui.en.json'

const zh = JSON.parse(read(ZH))
const en = JSON.parse(read(EN))

let passed = 0
let failures = 0
/** 记一条。`detail` 只在失败时打出来，省得整页都是数值。 */
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

/** 源码压成一行：跨行断句的判据也读得出来（格式化不改变判据）。 */
const flat = (src) => src.replace(/\s+/g, ' ')

/**
 * 一份源码里还剩多少汉字（剥掉注释与正则字面量之后）。
 *
 * 为什么这么剥：本仓的界面文案必须走字典（`scripts/ui-locale-test.mjs` 钉着），唯一允许写汉字的
 * 地方是**正则字面量**——`web-model.ts` 里那几条匹配的是宿主写进结果里的抬头、围栏与「没搜到」
 * 那句话，那些字不是界面文案、也不能翻译（`bash-view.tsx` 的 `/退出码 (\d+)/` 是先例）。
 */
const linesWithChinese = (rel) => {
  const hits = []
  // 先把块注释整段抹成空格（保留换行数，行号才对得上），再逐行剥行注释与正则字面量。
  const source = read(rel).replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  source.split('\n').forEach((line, index) => {
    const stripped = line
      .replace(/\/\/.*$/, '')
      .replace(/\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\])+\/[a-z]*/g, '')
    if (/[\u4e00-\u9fff]/.test(stripped)) hits.push(`${String(index + 1)}: ${line.trim().slice(0, 60)}`)
  })
  return hits
}

/** 用到的 `t('key')` 键（只认本卡两个文件里的调用）。 */
const usedKeysOf = (files) => {
  const keys = new Set()
  for (const rel of files) {
    for (const hit of read(rel).matchAll(/\bt\('([^']+)'/g)) keys.add(hit[1])
  }
  return keys
}

// ── [1] 判据 ─────────────────────────────────────────────────────────────────
const { webCallOf, webResultOf } = await import(new URL(`../${WEB_MODEL}`, import.meta.url).href)
console.log('[1] 判据：名字 + 参数缺一不可（query / queries / url），半截 JSON 不抛')

{
  const search = webCallOf('web_search', JSON.stringify({ query: 'pneuma 工具卡' }))
  check('web_search + query → 一张搜索卡', search !== null && search.kind === 'search' && search.query === 'pneuma 工具卡', search)
  const queries = webCallOf('web_search', JSON.stringify({ queries: ['第一条', '第二条'] }))
  check('queries 数组取第一条（dsh 的参数形状）', queries !== null && queries.kind === 'search' && queries.query === '第一条', queries)
  check('query 与 queries 都在时 query 优先', webCallOf('web_search', '{"query":"a","queries":["b"]}')?.query === 'a')
  check('web_search 没有 query / queries → 不是这张卡（只有名字不够）', webCallOf('web_search', '{"count":3}') === null)
  check('query 是空白 → 不是这张卡', webCallOf('web_search', '{"query":"   "}') === null)
  check('queries 是空数组 → 不是这张卡', webCallOf('web_search', '{"queries":[]}') === null)
  check('queries 里有一条坏值 → 整份不认（不留半条 query）', webCallOf('web_search', '{"queries":["a",""]}') === null)
  const fetchCall = webCallOf('webfetch', JSON.stringify({ url: 'https://example.com/a' }))
  check('webfetch + url → 一张抓取卡', fetchCall !== null && fetchCall.kind === 'fetch' && fetchCall.url === 'https://example.com/a', fetchCall)
  check('web_fetch 同一个形状也认（dsh 那一侧的抓取名）', webCallOf('web_fetch', '{"url":"https://example.com"}')?.kind === 'fetch')
  // 通用名 `fetch` **不认**：别家 MCP 工具常叫这个名，碰巧带个 url 参数不一定是抓网页。
  check('fetch 这个通用名不认（可能不是抓网页的工具）', webCallOf('fetch', '{"url":"https://example.com"}') === null)
  check('webfetch 的 url 是空串 → 不是这张卡', webCallOf('webfetch', '{"url":"   "}') === null)
  check('webfetch 没有 url → 不是这张卡', webCallOf('webfetch', '{"href":"https://example.com"}') === null)
  check('web_search 带 url（名字与参数不匹配）→ 不是这张卡', webCallOf('web_search', '{"url":"https://example.com"}') === null)
  check('webfetch 带 query（名字与参数不匹配）→ 不是这张卡', webCallOf('webfetch', '{"query":"x"}') === null)
  check('名字不是这两档 → 不是这张卡', webCallOf('browser', '{"url":"https://example.com"}') === null)
  check('半截 JSON（流式参数）→ 不抛，判成不是这张卡', webCallOf('web_search', '{"query":') === null)
  check('参数是数组 → 不是这张卡', webCallOf('web_search', '[]') === null && webCallOf('webfetch', '[]') === null)

  // 模型侧的导出面：装配（`factory.tsx`）按这五个名字调用，改名字就装不上。
  const model = read(WEB_MODEL)
  check('模型导出 webCallOf / webResultOf', model.includes('export function webCallOf(') && model.includes('export function webResultOf('))
  check('模型导出 WebCall / WebSource / WebResult 三个类型', model.includes('export type WebCall') && model.includes('export interface WebSource') && model.includes('export type WebResult'))
  // 链接判据只有一处实现（模型），渲染体必须复用它——两处各写一条正则，迟早「解析认了、渲染不认」。
  check('模型导出 isHttpSource（链接判据的唯一实现）', model.includes('export function isHttpSource('))
  check('渲染体从模型取这个判据，不再自带一份正则', read(WEB_VIEW).includes("import { isHttpSource") && !read(WEB_VIEW).includes('/^https?:\\/\\/'))
}

// ── [1b] 链接判据 ───────────────────────────────────────────────────────────
console.log('[1b] 链接判据：只有 http(s) 能画成可点链接（外部输入什么协议都可能）')

{
  const { isHttpSource } = await import(new URL(`../${WEB_MODEL}`, import.meta.url).href)
  check('https 是外链', isHttpSource('https://a.example/x') === true)
  check('http 也是外链', isHttpSource('http://a.example') === true)
  check('空串不是链接', isHttpSource('') === false)
  check('javascript: 不是链接（点一下就是执行别人的脚本）', isHttpSource('javascript:alert(1)') === false)
  check('data: 不是链接', isHttpSource('data:text/html,<script>') === false)
  check('裸域名不是链接（缺协议）', isHttpSource('a.example/x') === false)
}

// ── [2] 结构化卡片 ───────────────────────────────────────────────────────────
console.log('[2] 结构化卡片：字段校验（坏一条整份 null）、档位推断、默认值')

{
  const searchCall = webCallOf('web_search', '{"query":"pneuma"}')
  const searchCard = {
    call: { card: 'web', query: 'pneuma' },
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
  }
  // 结果文本故意给一段**能解析**的清单：结构化数据在时它一个字都不该被读。
  const textish = '1. 文本里的标题\nhttps://text.example/x\n文本摘要'
  const card = webResultOf(searchCall, searchCard, textish)
  check('卡片数据在 → 走结构化分支（不解析文本）', card !== null && card.kind === 'search', card)
  check('来源条数是清单长度', card?.sources.length === 2, card?.sources.length)
  check('第一来源的 url 原样带出来', card?.sources[0]?.url === 'https://a.example/one', card?.sources[0])
  check('第一来源的 snippet 原样带出来', card?.sources[0]?.snippet === '摘要一', card?.sources[0])
  check('没给 title / snippet 的来源落成 null', card?.sources[1]?.title === '标题二' && card?.sources[1]?.snippet === null, card?.sources[1])
  check('answer 透传', card?.answer === '提供方给的整段摘要', card?.answer)
  check('truncated 透传', card?.truncated === true)

  const noTruncated = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [] } }, undefined)
  check('truncated 缺省 false', noTruncated?.truncated === false, noTruncated?.truncated)
  check('零来源也是合法的搜索卡（画「没有结果」）', noTruncated?.kind === 'search' && noTruncated.sources.length === 0)

  const inferred = webResultOf(searchCall, { result: { card: 'web', sources: [{ url: 'https://a.example' }] } }, undefined)
  check('没有 kind 时按形状推断：sources 是数组 → 搜索卡', inferred?.kind === 'search', inferred)
  const inferredFetch = webResultOf(null, { result: { card: 'web', url: 'https://a.example' } }, undefined)
  check('没有 kind 时按形状推断：url 是字符串 → 抓取卡（调用参数可以缺席）', inferredFetch?.kind === 'fetch', inferredFetch)

  // 坏一条就整份 null：一份自己都说不清的清单，序号与条目对应不上，画出来比不画更坏。
  const badUrl = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [{ url: 42 }] } }, undefined)
  check('sources 里 url 不是字符串 → 整份 null', badUrl === null, badUrl)
  const badTitle = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [{ url: 'https://a', title: 7 }] } }, undefined)
  check('title 给了非字符串 → 整份 null（不许猜成「没标题」）', badTitle === null, badTitle)
  const badSnippet = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [{ url: 'https://a', snippet: {} }] } }, undefined)
  check('snippet 给了非字符串 → 整份 null', badSnippet === null, badSnippet)
  const badSources = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: 'x' } }, undefined)
  check('sources 不是数组 → 整份 null', badSources === null, badSources)
  const badAnswer = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [], answer: 1 } }, undefined)
  check('answer 给了非字符串 → 整份 null', badAnswer === null, badAnswer)
  const badTruncated = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [], truncated: 'yes' } }, undefined)
  check('truncated 不是布尔 → 整份 null', badTruncated === null, badTruncated)
  const badItem = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: ['https://a'] } }, undefined)
  check('sources 里某项不是对象 → 整份 null', badItem === null, badItem)

  const fetchCall = webCallOf('webfetch', '{"url":"https://example.com/a"}')
  const fetchCard = webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: 'https://example.com/a', statusCode: 404, truncated: true } }, undefined)
  check('抓取卡：url + statusCode 带出来', fetchCard?.kind === 'fetch' && fetchCard.url === 'https://example.com/a' && fetchCard.statusCode === 404, fetchCard)
  check('抓取卡：truncated 透传', fetchCard?.truncated === true)
  const noStatus = webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: 'https://example.com/a' } }, undefined)
  check('statusCode 缺省 null（不是每家提供方都给）', noStatus?.kind === 'fetch' && noStatus.statusCode === null, noStatus)
  const fraction = webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: 'https://example.com/a', statusCode: 200.5 } }, undefined)
  check('statusCode 是小数 → 整份 null', fraction === null, fraction)
  const stringStatus = webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: 'https://example.com/a', statusCode: '404' } }, undefined)
  check('statusCode 是字符串 → 整份 null', stringStatus === null, stringStatus)
  const badFetchUrl = webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', statusCode: 200 } }, undefined)
  check('抓取卡没有 url → 整份 null', badFetchUrl === null, badFetchUrl)
  const emptyFetchUrl = webResultOf(fetchCall, { result: { card: 'web', kind: 'fetch', url: '', statusCode: 200 } }, undefined)
  check('抓取卡的 url 是空串 → 整份 null（没有链接就没有卡）', emptyFetchUrl === null, emptyFetchUrl)

  // 空串标题 / 摘要按「没给」处理：否则渲染层会画出一个没有文字的链接。
  const emptyTitle = webResultOf(searchCall, { result: { card: 'web', kind: 'search', sources: [{ url: 'https://a', title: '', snippet: '' }] } }, undefined)
  check('title / snippet 是空串 → 落成 null（渲染层退回用 URL 当标签）', emptyTitle?.sources[0]?.title === null && emptyTitle?.sources[0]?.snippet === null, emptyTitle?.sources[0])

  // card 不是 'web'：本模型不接手，搜索卡回落到文本解析。
  const other = webResultOf(searchCall, { result: { card: 'diff', sources: [{ url: 'https://card.example/x' }] } }, textish)
  check("card 不是 'web' → 不走结构化分支（回落文本解析）", other?.sources[0]?.url === 'https://text.example/x', other?.sources[0])
  const noResultField = webResultOf(searchCall, { result: null }, textish)
  check('presentation.result 不是对象 → 当作没有卡片数据', noResultField?.sources.length === 1, noResultField)
  const noPres = webResultOf(searchCall, undefined, textish)
  check('没有 presentation → 也走文本解析', noPres?.sources.length === 1, noPres)

  // 抓取没有可解析的文本结构：没有卡片数据就 null，不猜。
  check('抓取卡没有卡片数据 → null（正文没有可解析的清单）', webResultOf(fetchCall, undefined, 'Fetched https://example.com/a (HTTP 200)') === null)
  check('调用参数与卡片数据都没有 → null', webResultOf(null, undefined, textish) === null)
  check('搜索卡结果为空（还在跑）→ null', webResultOf(searchCall, undefined, undefined) === null && webResultOf(searchCall, undefined, '') === null)
}

// ── [3] 文本兜底 ─────────────────────────────────────────────────────────────
console.log('[3] 文本兜底：编号清单解析、多行摘要压平、围栏剥掉、坏块整份 null、「没搜到」')

{
  // 真的围栏：`src/core/untrusted.ts:34-43` 的编译产物。
  const { wrapUntrusted } = await import(new URL('../lib/core/untrusted.js', import.meta.url).href)
  const searchCall = webCallOf('web_search', '{"query":"pneuma"}')
  // 宿主那段文本的正文（`packages/web-search/index.ts:235-238` 的形状）。
  const body = [
    '搜索「pneuma」共 2 条结果（提供方 tavily）：',
    '1. 第一条标题',
    '   https://a.example/one',
    '   第一段摘要',
    '   第二段摘要',
    '2. 第二条标题',
    '   https://b.example/two',
    '   第二条的摘要',
  ].join('\n')
  const text = wrapUntrusted('web-search', body)
  const parsed = webResultOf(searchCall, undefined, text)
  check('解析出 2 条来源', parsed?.kind === 'search' && parsed.sources.length === 2, parsed?.sources?.length)
  check('第一条的 url 与标题', parsed?.sources[0]?.url === 'https://a.example/one' && parsed?.sources[0]?.title === '第一条标题', parsed?.sources?.[0])
  check('第二条的 url 与标题', parsed?.sources[1]?.url === 'https://b.example/two' && parsed?.sources[1]?.title === '第二条标题', parsed?.sources?.[1])
  check('多行摘要被压成一行', parsed?.sources[0]?.snippet === '第一段摘要 第二段摘要', parsed?.sources?.[0]?.snippet)
  check('摘要里没有换行（每条来源只占两行）', !String(parsed?.sources[0]?.snippet ?? '').includes('\n'))
  check('文本兜底不编答案（文本里没有这一项）', parsed?.answer === null)
  check('文本兜底不编截断（文本里没有这个信号）', parsed?.truncated === false)
  // 围栏、围栏里那句说明、宿主的「共 N 条结果」抬头：都是宿主说明，不许进 notes。
  const notes = parsed?.notes ?? []
  check('围栏与宿主说明一个字都没进 notes', notes.length === 0, notes)
  check('notes 里没有围栏标签', !notes.some((note) => note.includes('external_content')))
  check('notes 里没有那句「以下内容由外部来源提供」', !notes.some((note) => note.includes('以下内容由外部来源提供')))
  check('notes 里没有宿主的「共 N 条结果」抬头', !notes.some((note) => note.includes('条结果（提供方')))

  // 坏块：编号行下一行不是 URL → 整份放弃（不画半张错的清单）。
  const brokenBody = body.replace('   https://b.example/two', '   第二条的摘要写在了这里')
  const broken = webResultOf(searchCall, undefined, wrapUntrusted('web-search', brokenBody))
  check('坏块（编号行下一行不是 URL）→ 整份 null', broken === null, broken)
  // 最后一个块缺 URL（文本在编号行后截断）同样整份放弃。
  const cut = webResultOf(searchCall, undefined, '1. 只有标题')
  check('编号块后面没有 URL 行 → 整份 null', cut === null, cut)

  // 「没有搜到」：宿主回的是**没包围栏**的一句原话（`packages/web-search/index.ts:231`）。
  const none = webResultOf(searchCall, undefined, '「pneuma」没有搜到结果。换个更具体的关键词再试。')
  check('「没有搜到结果」→ 空来源的搜索卡（不是空卡、也不是 null）', none?.kind === 'search' && none.sources.length === 0, none)
  check('「没有搜到结果」走 notes，留宿主原话', none?.notes.length === 1 && none.notes[0].includes('没有搜到结果'), none?.notes)
  check('「没有搜到结果」那张卡不编截断 / 答案', none?.truncated === false && none?.answer === null)

  // 认不出的文本：既不回落成「0 条结果」，也不当来源。
  check('报错散文 → null（回落通用卡，原文还在）', webResultOf(searchCall, undefined, 'HTTP 429：too many requests') === null)
  check('只有围栏、里面没有清单 → null', webResultOf(searchCall, undefined, wrapUntrusted('web-search', '一段没有编号的网页文本')) === null)
  check('CRLF 也能解析', webResultOf(searchCall, undefined, '1. 标题\r\nhttps://a.example\r\n摘要')?.sources.length === 1)
  check('编号行下一行前有空白也认（宿主缩进三格）', webResultOf(searchCall, undefined, '1. 标题\n      https://a.example\n摘要')?.sources[0]?.url === 'https://a.example')
  check('非 http(s) 的「链接」行不算来源（整份 null）', webResultOf(searchCall, undefined, '1. 标题\njavascript:alert(1)') === null)

  /*
   * 界面侧结果文本被截断（`adapter/transcript.ts:49` 的 RESULT_TEXT_LIMIT=1500，超出时截到
   * 1500 再补一个省略号，总长 1501）。老会话没有卡片数据、只能解析这段文本时，切点会落在
   * 任意位置——这几条钉住三种落法，以及「摘要自己以省略号结尾」不能误判成截断。
   */
  const LIMIT = 1501
  /** 把一段文本补到恰好 1501 字并以省略号收尾（模拟界面截断的形状）。 */
  const padTo = (head) => `${head}${'p'.repeat(Math.max(0, LIMIT - head.length - 1))}…`

  // 切在链接中间：半截链接不许画成来源，但前面收好的那条要留下，并标「不完整」。
  const cutInUrl = padTo('1. 第一条\nhttps://a.example/one\n摘要\n2. 第二条\nhttps://b.example/')
  check('截断样本长度正好 1501（模拟界面截断的形）', cutInUrl.length === LIMIT, cutInUrl.length)
  const cutUrl = webResultOf(searchCall, undefined, cutInUrl)
  check('切在链接中间 → 半截链接不画成来源', cutUrl?.sources.length === 1 && cutUrl.sources[0]?.url === 'https://a.example/one', cutUrl?.sources)
  check('切在链接中间 → 标「不完整」', cutUrl?.truncated === true, cutUrl?.truncated)

  // 切在标题中间：这一块没有链接，丢掉它、留下前面的。
  const cutInTitle = padTo('1. 第一条\nhttps://a.example/one\n摘要\n2. 第二条的标题被切')
  const cutTitle = webResultOf(searchCall, undefined, cutInTitle)
  check('切在标题中间 → 丢最后那一块，前面的来源照留', cutTitle?.sources.length === 1, cutTitle?.sources)
  check('切在标题中间 → 标「不完整」', cutTitle?.truncated === true, cutTitle?.truncated)

  // 切在摘要里：清单本身是完整的，来源都在，仍标「不完整」（后面还有没有下一条无从得知）。
  const cutInSnippet = padTo('1. 第一条\nhttps://a.example/one\n摘要\n2. 第二条\nhttps://b.example/two\n第二条的摘要被切')
  const cutSnippet = webResultOf(searchCall, undefined, cutInSnippet)
  check('切在摘要里 → 两条来源都在', cutSnippet?.sources.length === 2, cutSnippet?.sources)
  check('切在摘要里 → 也标「不完整」', cutSnippet?.truncated === true, cutSnippet?.truncated)

  // 反面对照：**没被截**的文本，摘要自己以省略号结尾（提供方就爱这么截）不该被当成截断。
  const shortEllipsis = '1. 标题\nhttps://a.example/one\n摘要结尾是一串省略号……'
  const short = webResultOf(searchCall, undefined, shortEllipsis)
  check('摘要以省略号结尾但文本没被截 → 不是「不完整」', short?.truncated === false, short?.truncated)
  check('摘要以省略号结尾但文本没被截 → 来源照常解析', short?.sources.length === 1, short?.sources)
}

// ── [4] 装配与本地化（源码钉）────────────────────────────────────────────────
console.log('[4] 装配与本地化：外链口径、导出面、模型零 import、8 个字典键、代码里没有硬编码中文')

{
  const view = read(WEB_VIEW)
  const viewFlat = flat(view)
  const model = read(WEB_MODEL)
  const viewCode = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  check('视图导出 WebCount / WebBody（装配按这两个名字调用）', view.includes('export function WebCount(') && view.includes('export function WebBody('))
  check('外链是 rel="noreferrer noopener" + 新窗口', viewFlat.includes('target="_blank" rel="noreferrer noopener"'))
  check('不是 http(s) 就画成 span（绝不画成可点链接）', viewFlat.includes('return <span className="tc-web-link">{label}</span>'))
  check('头行读数按两档分别说（条数 / HTTP）', view.includes("t('transcript.tool.webResultCount'") && view.includes("t('transcript.tool.webHttp'"))
  check('零来源单独一句「没有结果」', view.includes("t('transcript.tool.webNoResult')"))
  check('搜索 / 抓取两档的占位分开说', view.includes("t('transcript.tool.webSearching')") && view.includes("t('transcript.tool.webFetching')"))
  check('截断说明两档分开说', view.includes("t('transcript.tool.webTruncated'") && view.includes("t('transcript.tool.webContentTruncated')"))
  check('摘要段有取词（webAnswer 的落点）', view.includes("t('transcript.tool.webAnswer')"))
  check('还在跑才画占位（call.status === running）', viewCode.includes("call.status !== 'running'"))
  check('认不出结果时摊原文，不留空壳（tc-web-raw）', viewCode.includes('call.resultText') && viewCode.includes('<pre className="tc-web-raw">{raw}</pre>'))
  check('没有任何 any / as unknown as', !/\bany\b/.test(viewCode) && !viewCode.includes('as unknown as') && !model.includes('as unknown as'))

  // 类名只许用主控照它写 CSS 的那几个（写错名字就等于没样式）。
  const ALLOWED = new Set([
    'tc-web-count',
    'tc-web',
    'tc-web-answer',
    'tc-web-sources',
    'tc-web-source',
    'tc-web-link',
    'tc-web-snippet',
    'tc-web-fetch',
    'tc-web-status',
    'tc-web-note',
    // 卡片数据坏了、文本兜底也放弃时摊原文的那一格（与 read 卡的 .tc-read-raw 同一档）。
    'tc-web-raw',
  ])
  const classes = [...view.matchAll(/className="([^"]+)"/g)].map((hit) => hit[1])
  const unknown = classes.filter((name) => !ALLOWED.has(name))
  check('类名只用清单里的 11 个', classes.length > 0 && unknown.length === 0, unknown)

  check('模型零 import（探针用 Node 直接载入跑真代码）', model.match(/^import /gm) === null, model.match(/^import .*$/gm))
  check('模型没有 export default', !model.includes('export default') && !view.includes('export default'))

  /*
   * 数据面：这张卡的结构化来源是 `web_search` 自己交出来的（`packages/web-search/index.ts`）。
   * 真机探针只能走「手写一份卡片数据 + 重放」——真搜索要 API key 与外网——所以这里钉住
   * 「插件真的会写这个槽、形状对得上、字段过了脱敏」三件事，缺一样界面就退回解析文本。
   */
  const plugin = read('src/packages/web-search/index.ts')
  check('插件会返回 presentation（不是只有 text）', plugin.includes('presentation: {') && plugin.includes("card: 'web'"))
  check('卡片数据带 sources 与 truncated（界面读的两个字段）', plugin.includes('sources: hits.map(') && plugin.includes('truncated: hits.length >= current.maxResults'))
  check('卡片里的每个外部字段都过脱敏（不经过工具结果那条观察者链）', plugin.includes("import { redact } from '@pneuma/runtime/core/secrets.js'") && plugin.includes('title: redact(hit.title)') && plugin.includes('url: redact(hit.url)') && plugin.includes('snippet: redact(hit.snippet)'))

  // 字典：主控已写进两份字典，这里只钉「8 个键都在、都非空、英文里没有汉字、视图全都用到」。
  const KEYS = [
    'transcript.tool.webResultCount',
    'transcript.tool.webNoResult',
    'transcript.tool.webTruncated',
    'transcript.tool.webAnswer',
    'transcript.tool.webHttp',
    'transcript.tool.webContentTruncated',
    'transcript.tool.webSearching',
    'transcript.tool.webFetching',
  ]
  for (const key of KEYS) {
    check(`字典里有 ${key}（中文非空）`, typeof zh[key] === 'string' && zh[key].trim() !== '')
    check(`字典里有 ${key}（英文非空）`, typeof en[key] === 'string' && en[key].trim() !== '')
  }
  const cjkInEn = KEYS.filter((key) => /[\u4e00-\u9fff]/.test(String(en[key] ?? '')))
  check('英文值里没有汉字', cjkInEn.length === 0, cjkInEn)
  // `ui-locale-test.mjs` 会把「没人用的键」判成失败，所以 8 个键必须全在视图里有调用。
  const used = [...usedKeysOf([WEB_VIEW])].filter((key) => key.startsWith('transcript.tool.web'))
  check('视图用到的键正好是这 8 个（不多不少）', used.length === KEYS.length && KEYS.every((key) => used.includes(key)), used)

  // 代码里没有硬编码中文：注释与正则字面量除外（后者匹配的是宿主写进结果里的中文标记）。
  const hits = linesWithChinese(WEB_VIEW)
  check('web-view.tsx 里没有硬编码中文（注释与正则除外）', hits.length === 0, hits.slice(0, 3).join(' / '))
  const modelHits = linesWithChinese(WEB_MODEL)
  check('web-model.ts 里的中文只活在注释与正则里', modelHits.length === 0, modelHits.slice(0, 3).join(' / '))
  // 正则里那几条中文是宿主写进结果里的标记：钉住「它们还在」（删了解析就静默失效，卡片全都回落原文）。
  check('「没搜到」与围栏说明的解析规则还在', model.includes('没有搜到结果') && model.includes('以下内容由外部来源提供'))
}

const total = passed + failures
console.log('')
console.log(failures === 0 ? `全部通过（${String(total)} 项）` : `${String(failures)} 项失败 / ${String(total)} 项`)
process.exit(failures === 0 ? 0 : 1)
