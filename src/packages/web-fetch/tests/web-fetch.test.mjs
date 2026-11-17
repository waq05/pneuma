/**
 * web-fetch 包级测试：插件对象、地址规则、HTML 转换与深度护栏，以及真跑一遍抓取路径
 * （本机临时 HTTP 服务，不碰外网）。读 lib/ 产物，先 pnpm run build。
 * 单独跑：node src/packages/web-fetch/tests/web-fetch.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 先把家目录隔离掉再 import 产物：插件会读 `<DSC_HOME>/plugins.json` 里的 maxChars / timeoutSec，
// 不隔离就跟着本机配置飘。`DSC_HOME` 是 `core/path-policy.ts` 在模块加载时读的，晚一步设就没用。
const home = mkdtempSync(join(tmpdir(), 'pneuma-web-fetch-'))
process.env['DSC_HOME'] = home
writeFileSync(
  join(home, 'plugins.json'),
  JSON.stringify({ version: 2, entries: [{ file: 'web-fetch', disabled: false, config: { maxChars: 5_000, timeoutSec: 20 } }] }),
  'utf8',
)

const { webFetchPlugin } = await import(new URL('../../../../lib/packages/web-fetch/index.js', import.meta.url).href)
const http = await import(new URL('../../../../lib/packages/web-fetch/http.js', import.meta.url).href)
const html = await import(new URL('../../../../lib/packages/web-fetch/html.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
/** 异步版：抓取路径要真的走一遍网络栈。 */
const checkAsync = async (label, fn) => {
  try {
    await fn()
    pass += 1
    console.log(`PASS  ${label}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${label} → ${error.message}`)
  }
}

// ── 插件形状 ────────────────────────────────────────────────────────────────
check('插件对象：名字与它依赖的三个服务', () => {
  assert.equal(webFetchPlugin.name, 'web-fetch')
  assert.deepEqual([...webFetchPlugin.inject], ['tools', 'prompt', 'settings'])
  assert.equal(typeof webFetchPlugin.apply, 'function')
})
check('工具叫 web_fetch，风险等级是只读，声明了可并发', () => {
  assert.match(source, /name: 'web_fetch'/)
  assert.match(source, /risk: 'read'/)
  assert.match(source, /isConcurrencySafe: \(\) => true/)
})
check('schema 根是 object，必填只有 url', () => {
  assert.match(source, /type: 'object'/)
  assert.match(source, /required: \['url'\]/)
})
check('提示词里写明了「别在终端里 curl」以及原因是 Schannel', () => {
  assert.match(source, /不要在终端里用 curl/)
  assert.match(source, /SEC_E_NO_CREDENTIALS/)
})
check('结果交给界面一张 web 抓取卡', () => {
  assert.match(source, /kind: 'fetch'/)
  assert.match(source, /statusCode: page\.statusCode/)
})

// ── 地址规则（http.ts）────────────────────────────────────────────────────
check('只收 http/https：file: 与 javascript: 都拒绝', () => {
  assert.throws(() => http.parseFetchUrl('file:///C:/Windows/win.ini'), /只支持 http 与 https/)
  assert.throws(() => http.parseFetchUrl('javascript:alert(1)'), /只支持 http 与 https/)
})
check('地址里带账号密码就拒绝', () => {
  assert.throws(() => http.parseFetchUrl('https://user:pw@example.com/'), /带账号密码/)
})
check('空地址与超长地址都拒绝', () => {
  assert.throws(() => http.parseFetchUrl('   '), /不能为空/)
  assert.throws(() => http.parseFetchUrl(`https://example.com/${'a'.repeat(2100)}`), /地址太长/)
})
check('正常地址解析成 URL', () => {
  const url = http.parseFetchUrl('https://example.com/a?b=1')
  assert.equal(url.hostname, 'example.com')
  assert.equal(url.pathname, '/a')
})
check('同源判定看协议 + 主机 + 端口', () => {
  const base = new URL('https://example.com/x')
  assert.equal(http.isSameOrigin(new URL('https://example.com/y'), base), true)
  assert.equal(http.isSameOrigin(new URL('http://example.com/y'), base), false)
  assert.equal(http.isSameOrigin(new URL('https://other.com/y'), base), false)
  assert.equal(http.isSameOrigin(new URL('https://example.com:8443/y'), base), false)
})
check('内容类型分档：html / json 能读，pdf 与图片不行', () => {
  assert.equal(http.classifyContentType('text/html; charset=utf-8'), 'html')
  assert.equal(http.classifyContentType('application/xhtml+xml'), 'html')
  assert.equal(http.classifyContentType('text/plain'), 'text')
  assert.equal(http.classifyContentType('application/json'), 'text')
  assert.equal(http.classifyContentType('application/pdf'), undefined)
  assert.equal(http.classifyContentType('image/png'), undefined)
  assert.equal(http.classifyContentType(null), undefined)
})
check('charset 从 Content-Type 里取出来', () => {
  assert.equal(http.parseCharset('text/html; charset="GBK"'), 'gbk')
  assert.equal(http.parseCharset('text/html'), undefined)
})

// ── HTML 转换（html.ts）───────────────────────────────────────────────────
check('标题与列表转成 Markdown', () => {
  const { text } = html.renderBody('html', '<h1>标题</h1><ul><li>甲</li><li>乙</li></ul>', 10_000)
  assert.match(text, /^# 标题/m)
  // turndown 的列表项是「-」加三个空格（CommonMark 允许 1~4 个），所以这里按「- +任意空格」判。
  assert.match(text, /^- +甲/m)
  assert.match(text, /^- +乙/m)
})
check('script / style / display:none 整块丢掉', () => {
  const { text } = html.renderBody(
    'html',
    '<body><script>alert(1)</script><style>a{}</style><p>看得见</p><div style="display: none">看不见</div></body>',
    10_000,
  )
  assert.match(text, /看得见/)
  assert.doesNotMatch(text, /alert\(1\)/)
  assert.doesNotMatch(text, /看不见/)
})
check('表格转成 GFM 表格，含分隔行', () => {
  const { text } = html.renderBody(
    'html',
    '<table><thead><tr><th>名</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>',
    10_000,
  )
  assert.match(text, /\| 名 +\| 值 +\|/)
  assert.match(text, /\| --- +\| --- +\|/)
})
check('纯文本档原样通过，不再转义', () => {
  const { text, sourceTruncated } = html.renderBody('text', 'a < b\n*c*', 10_000)
  assert.equal(text, 'a < b\n*c*')
  assert.equal(sourceTruncated, false)
})
check('源超上限时切短并标记 sourceTruncated', () => {
  const { text, sourceTruncated } = html.renderBody('text', 'x'.repeat(50), 10)
  assert.equal(text.length, 10)
  assert.equal(sourceTruncated, true)
})
check('嵌套很浅的 HTML 不触发护栏，几千层的触发', () => {
  assert.equal(html.exceedsConversionDepth('<div><div><p>ok</p></div></div>'), false)
  assert.equal(html.exceedsConversionDepth('<div>'.repeat(600) + '</div>'.repeat(600)), true)
})
check('自闭合标签不涨嵌套深度（一万个 br 也不过护栏）', () => {
  assert.equal(html.exceedsConversionDepth('<br>'.repeat(10_000)), false)
})
check('越过深度护栏就不转换，只回一句省略说明', () => {
  const { text } = html.renderBody('html', '<div>'.repeat(600) + '正文' + '</div>'.repeat(600), 100_000)
  assert.match(text, /没能安全转换/)
})

// ── 抓取路径（本机临时服务，不打外网）─────────────────────────────────────
// 为什么用真 HTTP 服务而不是假 fetch：同源重定向、字节封顶、Content-Type 分档、截断标记
// 这几条全都长在 fetch/Response 的真实行为上——假对象只能验「我调了它」，验不了「它怎么回来」。
const longHtml =
  '<!doctype html><html><body><h1>长页面</h1><p>' + '这是一段足够长的正文。'.repeat(600) + '</p></body></html>'
const server = createServer((req, res) => {
  if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(longHtml)
    return
  }
  if (req.url === '/binary') {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
    return
  }
  if (req.url === '/hop') {
    // 同源重定向：应当自动跟到 /ok
    res.writeHead(302, { location: '/ok' })
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('纯文本正文')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const captured = {}
webFetchPlugin.apply({
  tools: { register: (entry) => { captured.tool = entry; return () => {} } },
  prompt: { register: () => () => {} },
  settings: { registerSection: () => () => {} },
  emit: () => {},
  effect: (fn) => fn(),
})
const run = (url) => captured.tool.run({ url }, { signal: new AbortController().signal })

await checkAsync('apply 之后工具就叫 web_fetch，参数字段只有 url', () => {
  assert.equal(captured.tool.name, 'web_fetch')
  assert.deepEqual(Object.keys(captured.tool.parameters.properties), ['url'])
})

await checkAsync('纯文本页：正文原样回来，卡片记下 200 与最终地址', async () => {
  const out = await run(`${base}/ok`)
  assert.match(out.text, /纯文本正文/)
  assert.equal(out.presentation.result.statusCode, 200)
  assert.equal(out.presentation.result.kind, 'fetch')
  assert.ok(out.presentation.result.url.endsWith('/ok'), out.presentation.result.url)
})

await checkAsync('同源 302 自动跟到目标页', async () => {
  const out = await run(`${base}/hop`)
  assert.match(out.text, /纯文本正文/)
  assert.ok(out.presentation.result.url.endsWith('/ok'), out.presentation.result.url)
})

await checkAsync('超长页面：卡片 truncated 为真，正文末尾有截断说明', async () => {
  const out = await run(`${base}/big`)
  assert.equal(out.presentation.result.truncated, true)
  assert.match(out.text, /正文到上限被切断了/)
  // 上限 5000 字 + 抬头与尾注，总长不该离谱地超出去
  assert.ok(out.text.length < 5_600, `文本长度 ${out.text.length}`)
})

await checkAsync('图片这类二进制：明确报「不是能读的网页」', async () => {
  await assert.rejects(() => run(`${base}/binary`), /不是能读的网页或文本/)
})

server.close()
rmSync(home, { recursive: true, force: true })

console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
