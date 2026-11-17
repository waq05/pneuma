/**
 * web-search 的**请求面**探针：key 到底有没有进请求头、DeepSeek 那条路发的是什么、没配 key 时工具还在不在场。
 *
 * 为什么单独一个文件：隔壁 `web-search.test.mjs` 只对源码做形状断言（工具名、schema、必填项），
 * 那种断言挡不住「参数算好了却没往下传」——2026-11-17 就是这么坏的：key 取出来了、鉴权头也
 * 拼好了，可 `search()` 里写死了空头，于是每次搜索都是 401，报错长得像「提供方挂了」。
 * 这里用假 ctx + 假 fetch 把工具真跑一遍，看请求头与请求体里到底有什么。
 *
 * 读 lib/ 产物，先 `pnpm run build`。单独跑：node src/packages/web-search/tests/web-search-request.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须先隔离家目录再 import 产物：`DSC_HOME` 是 `core/path-policy.ts` 在模块加载时读的，
// 晚一步设就还是去读用户真实的 ~/.dsc，测试会跟着本机配置飘（凭据库也在这条路上）。
const home = mkdtempSync(join(tmpdir(), 'pneuma-web-search-'))
process.env['DSC_HOME'] = home
process.env['PNEUMA_TEST_DEEPSEEK_KEY'] = 'ds-key-789'
const pluginsFile = join(home, 'plugins.json')

/** 写一份最小的插件条目树（只放 web-search 一行）。 */
function writePlugins(config) {
  writeFileSync(pluginsFile, JSON.stringify({ version: 2, entries: [{ file: 'web-search', disabled: false, config }] }), 'utf8')
}

writePlugins({ provider: 'tavily', apiKey: 'test-key-123', maxResults: 3 })

const { webSearchPlugin } = await import(new URL('../../../../lib/packages/web-search/index.js', import.meta.url).href)

/** 假 ctx：只实现 apply 会碰的四个面；effect 立刻执行，好让工具真的挂上。 */
function makeCtx() {
  const captured = { tool: null, prompt: null, section: null, notices: [] }
  const ctx = {
    tools: {
      register: (entry) => {
        captured.tool = entry
        return () => {}
      },
    },
    prompt: {
      register: (_name, fn) => {
        captured.prompt = fn
        return () => {}
      },
    },
    settings: {
      registerSection: (spec) => {
        captured.section = spec
        return () => {}
      },
    },
    emit: (event, text) => {
      captured.notices.push({ event, text })
    },
    effect: (fn) => fn(),
  }
  return { ctx, captured }
}

/** 顶掉全局 fetch，记下每次请求的地址、头与请求体。 */
function stubFetch(payload) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: init?.headers ?? {},
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const TAVILY_BODY = {
  results: [
    { title: '甲标题', url: 'https://a.example/one', content: '甲的摘要' },
    { title: '乙标题', url: 'https://b.example/two', content: '乙的摘要' },
  ],
}
const SERPER_BODY = { organic: [{ title: '丙标题', link: 'https://c.example/three', snippet: '丙的摘要' }] }
/** 照实抓的一份 DeepSeek Messages 回复：结果块夹在两段正文中间，第一条 URL 重复出现一次。 */
const DEEPSEEK_BODY = {
  content: [
    { type: 'text', text: '这段是模型自己写的总结，不该被当成搜索结果' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Pneuma' } },
    {
      type: 'web_search_tool_result',
      content: [
        { type: 'web_search_result', title: '丁标题', url: 'https://d.example/four', snippet: '丁的摘要', page_age: '2026-11-01', encrypted_content: 'xxx' },
        { type: 'web_search_result', title: '丁标题（同一条）', url: 'https://d.example/four', snippet: '重复的摘要' },
        { type: 'web_search_result', title: '戊标题', url: 'https://e.example/five', snippet: '戊的摘要' },
      ],
    },
    { type: 'text', text: '收尾正文' },
  ],
}

let pass = 0
let fail = 0
async function check(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`PASS  ${label}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${label} → ${error.message}`)
  }
}

const signal = () => new AbortController().signal

// ── 第三方服务那条路（tavily / serper）────────────────────────────────────
{
  const { ctx, captured } = makeCtx()
  webSearchPlugin.apply(ctx)
  const fake = stubFetch(TAVILY_BODY)

  await check('配了 key：工具一定在场', () => {
    assert.ok(captured.tool !== null, 'apply 之后 tools.register 没被调用')
    assert.equal(captured.tool.name, 'web_search')
  })

  await check('tavily 的请求头里带 Bearer key（这条是 401 那次修复的核心）', async () => {
    await captured.tool.run({ query: 'pneuma' }, { signal: signal() })
    assert.equal(fake.calls.length, 1, `应该只发一次请求，实际 ${fake.calls.length} 次`)
    assert.match(fake.calls[0].url, /api\.tavily\.com\/search/)
    assert.equal(fake.calls[0].headers.authorization, 'Bearer test-key-123')
  })

  await check('结果按「编号 + 标题 + 链接 + 摘要」排版，并包上不可信围栏', async () => {
    const out = await captured.tool.run({ query: 'pneuma' }, { signal: signal() })
    assert.match(out.text, /<external_content source="web-search">/)
    assert.match(out.text, /共 2 条结果/)
    assert.match(out.text, /1\. 甲标题/)
  })

  await check('界面卡片拿到两条来源（含 title / url / snippet）', async () => {
    const out = await captured.tool.run({ query: 'pneuma' }, { signal: signal() })
    const card = out.presentation.result
    assert.equal(card.card, 'web')
    assert.equal(card.kind, 'search')
    assert.equal(card.sources.length, 2)
    assert.deepEqual(card.sources[0], { title: '甲标题', url: 'https://a.example/one', snippet: '甲的摘要' })
  })

  await check('tavily 专有的 includeDomains 直通到请求体', async () => {
    const before = fake.calls.length
    await captured.tool.run({ query: 'pneuma', includeDomains: ['example.com'] }, { signal: signal() })
    assert.equal(fake.calls.length, before + 1)
    assert.deepEqual(fake.calls[before].body.include_domains, ['example.com'])
  })

  await check('切到 serper：鉴权头换成 X-API-KEY', async () => {
    writePlugins({ provider: 'serper', apiKey: 'serper-key-456', maxResults: 3 })
    const serper = stubFetch(SERPER_BODY)
    const out = await captured.tool.run({ query: 'pneuma' }, { signal: signal() })
    serper.restore()
    assert.match(serper.calls[0].url, /google\.serper\.dev/)
    assert.equal(serper.calls[0].headers['X-API-KEY'], 'serper-key-456')
    assert.equal(serper.calls[0].headers.authorization, undefined)
    assert.match(out.text, /1\. 丙标题/)
  })

  fake.restore()
}

// ── DeepSeek 原生搜索那条路 ────────────────────────────────────────────────
{
  writePlugins({ provider: 'deepseek', apiKeyEnv: 'PNEUMA_TEST_DEEPSEEK_KEY', maxResults: 5 })
  const { ctx, captured } = makeCtx()
  webSearchPlugin.apply(ctx)
  const fake = stubFetch(DEEPSEEK_BODY)

  await check('deepseek：打到 Anthropic 兼容的 /messages，两个鉴权头都带', async () => {
    await captured.tool.run({ query: 'pneuma' }, { signal: signal() })
    const call = fake.calls.at(-1)
    assert.equal(call.url, 'https://api.deepseek.com/anthropic/v1/messages')
    assert.equal(call.headers['x-api-key'], 'ds-key-789')
    assert.equal(call.headers.authorization, 'Bearer ds-key-789')
    assert.equal(call.headers['anthropic-version'], '2023-06-01')
  })

  await check('deepseek：请求体挂的是原生 web_search 服务端工具，推理关掉', async () => {
    const body = fake.calls.at(-1).body
    assert.equal(body.model, 'deepseek-v4-flash')
    assert.equal(body.tools[0].type, 'web_search_20250305')
    assert.equal(body.tools[0].name, 'web_search')
    assert.equal(body.tools[0].max_uses, 1)
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.match(body.messages[0].content[0].text, /pneuma/)
  })

  await check('deepseek：结果从 web_search_tool_result 里收，同一条 URL 只留一次', async () => {
    const out = await captured.tool.run({ query: 'pneuma' }, { signal: signal() })
    const card = out.presentation.result
    assert.equal(card.sources.length, 2, `应收到 2 条（去重后），实际 ${card.sources.length} 条`)
    assert.deepEqual(card.sources[0], { title: '丁标题', url: 'https://d.example/four', snippet: '丁的摘要' })
    assert.equal(card.sources[1].url, 'https://e.example/five')
  })

  await check('deepseek：模型那段总结不进搜索结果（只交真链接）', async () => {
    const out = await captured.tool.run({ query: 'pneuma' }, { signal: signal() })
    assert.doesNotMatch(out.text, /这段是模型自己写的总结/)
    assert.doesNotMatch(out.text, /收尾正文/)
  })

  await check('deepseek：回复里没有结果块就明说「没触发」，不拿正文冒充', async () => {
    const noTool = stubFetch({ content: [{ type: 'text', text: '我没搜，直接编了一段' }] })
    await assert.rejects(
      () => captured.tool.run({ query: 'pneuma' }, { signal: signal() }),
      /没触发联网搜索/,
    )
    noTool.restore()
  })

  await check('deepseek：maxResults 到顶就停（不再多收）', async () => {
    writePlugins({ provider: 'deepseek', apiKeyEnv: 'PNEUMA_TEST_DEEPSEEK_KEY', maxResults: 1 })
    const out = await captured.tool.run({ query: 'pneuma' }, { signal: signal() })
    assert.equal(out.presentation.result.sources.length, 1)
    writePlugins({ provider: 'deepseek', apiKeyEnv: 'PNEUMA_TEST_DEEPSEEK_KEY', maxResults: 5 })
  })

  fake.restore()
}

// ── 没 key 的那条路 ────────────────────────────────────────────────────────
{
  writePlugins({ provider: 'tavily', maxResults: 3 })
  const { ctx, captured } = makeCtx()
  webSearchPlugin.apply(ctx)
  const fake = stubFetch(TAVILY_BODY)

  await check('没配 key：工具照样在场（不再悄悄消失）', () => {
    assert.ok(captured.tool !== null, '没 key 时 tools.register 没被调用——模型会退回去用 curl')
  })

  await check('没配 key：调用回一句能照做的错，提到 DeepSeek、插件中心与替代方案', async () => {
    await assert.rejects(
      () => captured.tool.run({ query: 'pneuma' }, { signal: signal() }),
      (error) => {
        assert.match(error.message, /还没配可用的 key/)
        assert.match(error.message, /DEEPSEEK_API_KEY/)
        assert.match(error.message, /插件中心/)
        assert.match(error.message, /SEC_E_NO_CREDENTIALS/)
        return true
      },
    )
    assert.equal(fake.calls.length, 0, '没 key 时不该发任何请求')
  })

  await check('没配 key：提示词仍在场（它照样知道有搜索这回事）', () => {
    assert.equal(typeof captured.prompt, 'function')
    assert.match(captured.prompt(), /web_search/)
  })

  await check('没配 key：启动时发一条告知去哪填的 notice', () => {
    assert.ok(captured.notices.length >= 1, '一条 notice 都没有')
    assert.match(captured.notices[0].text, /DEEPSEEK_API_KEY/)
  })

  await check('设置分区仍在：id、四项通用字段、三项 DeepSeek 字段与测试按钮都在', () => {
    assert.equal(captured.section.id, 'web-search')
    const keys = captured.section.fields().map((field) => field.key ?? field.action)
    assert.deepEqual(keys, [
      'provider',
      'apiKeyEnv',
      'apiKey',
      'maxResults',
      'deepseekBaseUrl',
      'deepseekModel',
      'deepseekMaxUses',
      'test',
    ])
  })

  await check('默认提供方是 DeepSeek（新装用户不用另申请第三方服务）', () => {
    writePlugins({})
    // 空白条目树要重新 apply 一次：分区里的 values() 读的是 apply 时快照的 config。
    const fresh = makeCtx()
    webSearchPlugin.apply(fresh.ctx)
    const values = fresh.captured.section.values()
    assert.equal(values.provider, 'deepseek')
    assert.equal(values.deepseekBaseUrl, 'https://api.deepseek.com/anthropic/v1')
    assert.equal(values.deepseekModel, 'deepseek-v4-flash')
    assert.equal(values.deepseekMaxUses, 1)
  })

  fake.restore()
}

rmSync(home, { recursive: true, force: true })

console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
