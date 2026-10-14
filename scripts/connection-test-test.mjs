/**
 * 「测试连接」直测（2026-10-14 用户要的：模型配置里加一颗测试连接的按钮）。
 *
 * 这颗按钮回答的问题只有一个：**现在拿这个端点发一条消息会不会失败**。所以它不是
 * 「再查一次 /models」（那是隔壁「拉取清单」，只证明地址可达），而是走与正常对话
 * 同一条链路真发一次最小请求——探针消息固定两条（system + user `hi`）、无历史无工具、
 * 输出预算压到很小，端点要的请求头与协议适配器都照走。
 *
 * 断言六层（前四层用**假 stream**，一个字节都不出网）：
 *   1. 探针请求形状：两条消息、无工具无历史、预算小、路由里的思考字段原样带；
 *   2. 成功路径：流正常收尾即 ok（正文为空也算通）、回话摘要压平截断、信号传下去了；
 *   3. 失败路径：端点报错折成 `ok:false + 一句话`、超时说得清是「没等到」而不是「端点拒了」；
 *   4. 挑模型的口径：显式给的 > 默认端点那份默认模型 > 清单第一个；
 *   5. 接线钉（源码）：界面白名单与实参规格、宿主清单、运行时透传、旧桥、卡片上的按钮与结果行；
 *   6. **真端到端**：真内核 + 本地假端点，从设置服务一路走到线上请求（看它真发了什么）。
 *
 * 用法：pnpm run build && node scripts/connection-test-test.mjs
 *
 * @module dsc/scripts/connection-test-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// config 模块在 import 时就固定了 ~/.dsc 路径：临时 HOME 必须先于一切 lib 导入
const home = mkdtempSync(join(tmpdir(), 'dsc-conn-test-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const {
  CONNECTION_PROBE_MESSAGES,
  CONNECTION_PROBE_MAX_TOKENS,
  CONNECTION_PROBE_TIMEOUT_MS,
  connectionProbeRequest,
  clipReply,
  pickProbeModel,
  testConnection,
} = await import('../lib/core/connection-test.js')
const { UI_METHODS, UI_ARG_SPECS } = await import('../lib/core/ui-methods.js')
const { INVOKABLE_METHODS } = await import('../lib/core/host-methods.js')
const { createKernel } = await import('../lib/host/kernel.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const route = { api: 'openai-completions', baseUrl: 'https://api.example.com', apiKey: 'sk-secret', model: 'm-1' }

console.log('测试连接电池：模型配置里那颗按钮')

// ── 1. 探针请求形状 ───────────────────────────────────────────────────────────
console.log('\n[1] 探针请求：固定的两条、不掺会话')
{
  const request = connectionProbeRequest(route)
  check('messages 恰好两条', Array.isArray(request.messages) && request.messages.length === 2, JSON.stringify(request.messages))
  check('顺序是 system 在前、user 在后', request.messages[0]?.role === 'system' && request.messages[1]?.role === 'user')
  check('user 只发一句 hi（探针不掺会话内容）', request.messages[1]?.content === 'hi', String(request.messages[1]?.content))
  check('带 system 且它是最前一条（中间冒 system 会被网关判 400）', request.messages[0]?.content !== '' && request.messages.every((m, i) => m.role !== 'system' || i === 0))
  check('不带工具目录', request.tools === undefined)
  check('不带 signal（由 testConnection 自己接）', request.signal === undefined)
  check(`输出预算压得很小（${String(CONNECTION_PROBE_MAX_TOKENS)}）`, request.maxTokens === CONNECTION_PROBE_MAX_TOKENS && CONNECTION_PROBE_MAX_TOKENS <= 32)
  check('baseUrl / apiKey / model 照路由原样带（测的就是这个端点）',
    request.baseUrl === route.baseUrl && request.apiKey === route.apiKey && request.model === route.model)
  check('路由声明了思考字段就照带（测试走的必须是平时那条路）',
    connectionProbeRequest({ ...route, thinking: 'disabled' }).thinking === 'disabled' &&
      connectionProbeRequest({ ...route, reasoningEffort: 'high' }).reasoningEffort === 'high')
  check('路由没声明就不多发字段', connectionProbeRequest(route).thinking === undefined && connectionProbeRequest(route).reasoningEffort === undefined)
  check('messages 是副本（改返回值不会污染常量）',
    (() => {
      const one = connectionProbeRequest(route)
      one.messages.push({ role: 'user', content: 'x' })
      return connectionProbeRequest(route).messages.length === 2 && CONNECTION_PROBE_MESSAGES.length === 2
    })())
  check('截止时间是个「按钮等得起」的值（不超过 30 秒）', CONNECTION_PROBE_TIMEOUT_MS <= 30_000, String(CONNECTION_PROBE_TIMEOUT_MS))
}

console.log('\n[1] 回话摘要')
{
  check('换行压平 + 去首尾空白', clipReply('  好\n的\n ') === '好 的', clipReply('  好\n的\n '))
  check('超长截断（带省略号）', clipReply('啊'.repeat(200)).length === 81 && clipReply('啊'.repeat(200)).endsWith('…'))
  check('空回话就是空串（不编一句）', clipReply('') === '' && clipReply('   ') === '')
}

// ── 2. 成功路径 ───────────────────────────────────────────────────────────────
console.log('\n[2] 成功：流正常收尾即通')
{
  let seen = null
  const stream = (api, request, handlers) => {
    seen = { api, request, handlers }
    return Promise.resolve({ text: 'ok', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' })
  }
  const outcome = await testConnection(route, stream)
  check('ok = true', outcome.ok === true, JSON.stringify(outcome))
  check('带回话摘要', outcome.reply === 'ok', JSON.stringify(outcome.reply))
  check('带耗时（毫秒，非负）', typeof outcome.ms === 'number' && outcome.ms >= 0, String(outcome.ms))
  check('失败字段为空', outcome.error === undefined)
  check('按路由声明的协议派发（适配器照走）', seen.api === route.api, String(seen.api))
  check('传下去的请求就是探针请求', seen.request.messages.length === 2 && seen.request.model === route.model)
  check('挂上了信号且此刻没被中止', seen.request.signal instanceof AbortSignal && seen.request.signal.aborted === false)
  check('给适配器留了 onDelta（流式链路要它）', typeof seen.handlers.onDelta === 'function')

  // 正文为空也算通：预算压得很小时模型常常来不及吐字，但「路能走完」已经证明了要证的事
  const empty = await testConnection(route, () => Promise.resolve({ text: '', reasoning: '', toolCalls: [], usage: null, finishReason: 'length' }))
  check('正文为空但流收尾 → 仍算通，reply 是空串', empty.ok === true && empty.reply === '', JSON.stringify(empty))
}

// ── 3. 失败路径 ───────────────────────────────────────────────────────────────
console.log('\n[3] 失败：折成一句话，不往外抛')
{
  const boom = await testConnection(route, () => Promise.reject(new Error('HTTP 401：invalid api key')))
  check('端点报错 → ok:false（点一次按钮不该弹两次错）', boom.ok === false, JSON.stringify(boom))
  check('原因带「连接失败：」前缀且保留了端点原文', boom.error?.startsWith('连接失败：') === true && boom.error?.includes('HTTP 401') === true, String(boom.error))
  check('失败也报耗时与空回话', typeof boom.ms === 'number' && boom.reply === '')

  // 挂住的端点：不能把按钮永远转下去，超时按「我们自己按停的」说
  const hanging = (_api, request) =>
    new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => {
        reject(new Error('aborted'))
      }, { once: true })
    })
  const started = Date.now()
  const timedOut = await testConnection(route, hanging, 300)
  const elapsed = Date.now() - started
  check('超时 → ok:false', timedOut.ok === false, JSON.stringify(timedOut))
  check('超时说的是「超时」而不是端点拒了（两种毛病分开说）', timedOut.error?.startsWith('超时：') === true, String(timedOut.error))
  check('到点就收（没有一直等下去）', elapsed < 3000, `${String(elapsed)}ms`)
  check('超时也报耗时', timedOut.ms >= 0)
}

// ── 4. 测哪个模型 ─────────────────────────────────────────────────────────────
console.log('\n[4] 挑模型：显式 > 平时用的那个 > 第一个')
{
  const models = [{ id: 'm-a' }, { id: 'm-b' }]
  const defaults = { provider: 'go', model: 'm-b' }
  check('显式点名优先', pickProbeModel('go', models, 'm-a', defaults) === 'm-a')
  check('显式名去空白', pickProbeModel('go', models, '  m-a  ', defaults) === 'm-a')
  check('没点名时：这个端点就是默认端点，取它配的默认模型（用户多半在问这条路由）', pickProbeModel('go', models, undefined, defaults) === 'm-b')
  check('默认端点是别人 → 取清单第一个', pickProbeModel('other', models, undefined, defaults) === 'm-a')
  check('默认模型不在这个端点里 → 取清单第一个', pickProbeModel('go', models, undefined, { provider: 'go', model: 'm-zzz' }) === 'm-a')
  check('空清单 → 空串（调用方据此报「还没有模型」）', pickProbeModel('go', [], undefined, defaults) === '')
  check('点名了一个清单里没有的 → 照原名返回（让 routeTo 去报那个更准的错）', pickProbeModel('go', models, 'm-nope', defaults) === 'm-nope')
  check('空串点名按没点名算', pickProbeModel('go', models, '   ', defaults) === 'm-b')
}

// ── 5. 接线：从界面点下去到宿主发出去，每一站都在 ──────────────────────────────
console.log('\n[5] 接线钉（源码）')
{
  const uiMethods = read('src/core/ui-methods.ts')
  const hostMethods = read('src/core/host-methods.ts')
  const settings = read('src/plugins/settings.ts')
  const runtime = read('src/plugins/runtime.ts')
  const bridge = read('desktop/src/renderer/bridge.ts')
  const contract = read('src/contract.ts')
  const models = read('ui-shell/src/plugins/settings/models.tsx')
  const views = read('ui-shell/src/legacy/views.css')

  check('界面白名单放了它（放行的理由写在文件头的注释里）', UI_METHODS.includes('testConnection'))
  check('实参规格：端点名（MAX_NAME 字符串）+ 可选的模型名',
    UI_ARG_SPECS.testConnection?.length === 2 && UI_ARG_SPECS.testConnection[0]?.shape.kind === 'string' && UI_ARG_SPECS.testConnection[1]?.optional === true,
    JSON.stringify(UI_ARG_SPECS.testConnection))
  check('宿主协议清单也加了（漏一个桌面 tsc 就红）', INVOKABLE_METHODS.includes('testConnection'))
  check('契约上有这个方法（类型层也就是界面那侧编不过就红）', /testConnection\(provider: string, model\?: string\): Promise<ConnectionTestView>/.test(contract))
  check('契约声明「请求本身失败不 reject」（界面不弹两次错）', /请求本身失败\*\*不\*\* reject/.test(contract))
  check('宿主实现：端点不存在就抛（页面因此指不了别处）', /if \(entry === undefined\) throw new Error\(`没有这个端点：\$\{provider\}`\)/.test(settings))
  check('宿主实现：没 key 先说清是「还没配 key」而不是等 401', settings.includes('还没有可用的 API key'))
  check('宿主实现：没模型也先说清', settings.includes('还没有模型：先用「拉取清单」'))
  check('宿主实现：档位取「默认」（测的是「能不能通」，不是某个思考档）', settings.includes("routeTo(provider, pick, 'default')"))
  check('宿主实现：经 llm 服务派发（同一份归因头与协议适配器）', settings.includes('ctx.llm.stream(api, request, handlers)'))
  check('宿主实现：用 pickProbeModel 挑模型', settings.includes('pickProbeModel(provider, entry.models, model'))
  check('宿主实现：结果里带上是哪个模型', settings.includes('return { ...outcome, model: pick }'))
  check('运行时透传到设置服务', /async testConnection\(provider, model\) \{\s*return ctx\.settings\.testConnection\(provider, model\)/.test(runtime))
  check('旧桌面版的桥也有这一站（RuntimeProxy 是 keyof DscRuntime 的映射）', bridge.includes("testConnection: (provider, model) => call<ConnectionTestView>('testConnection', provider, model)"))
  check('界面：测试钮挂在**具体模型**后面（不是卡片那排动作里）', models.includes('data-probe-model={model.id}') && models.includes('props.onProbe(model.id)'))
  check('界面：模型那一格把芯片、测试钮、结论点收在一起', models.includes('<span className="model-slot" key={model.id}>'))
  check('界面：一次只转一个模型（按「端点/模型」记忙碌态）', models.includes('new Set(current).add(key)') && models.includes("next.delete(key)"))
  check('界面：走的是界面通道（不是原生桥——浏览器里也能点）', models.includes(".invoke<ConnectionTestView>('testConnection', [provider, model])"))
  check('界面：结论就地留在那个模型后面（成功与失败都留）', models.includes('new Map(current).set(key, result)'))
  check('界面：reject 也算结论留下来（连请求都没发出去的那种）', models.includes("{ ok: false, model, ms: 0, reply: '', error: text(error) }"))
  check('界面：结论点带成功/失败标记 + 读数进悬浮说明', models.includes("probe-badge${result.ok ? ' ok' : ' bad'}") && models.includes("data-probe={result.ok ? 'ok' : 'fail'}") && models.includes('data-tip={probeTip(result)}'))
  // 用户 2026-10-14 追加的两条：按钮挪到模型后面 + 只留图标（名字进悬浮说明）
  check('界面：动作排**只画图标**（名字在悬浮说明里）',
    /<IconKey size=\{14\} \/>\s*<\/button>/.test(models) &&
      /<IconRefresh size=\{14\} \/>\s*<\/button>/.test(models) &&
      /<IconEdit size=\{14\} \/>\s*<\/button>/.test(models) &&
      /<IconTrash size=\{14\} \/>\s*<\/button>/.test(models))
  check('界面：那四颗钮的名字都进了 data-tip（悬停才出）',
    models.includes('拉取清单 · 从端点拉取线上可用模型清单') &&
      models.includes('data-tip="编辑这个端点"') &&
      models.includes('data-tip="删除这个端点"') &&
      models.includes("'密钥已配置' : '填写密钥'"))
  check('界面：旧的带字动作按钮已经不画了（拉取中… / 编辑 / 删除 这些字不再出现在按钮里）',
    !models.includes("'拉取中…' : '拉取清单'") && !models.includes('<IconEdit size={13} /> 编辑') && !models.includes('<IconTrash size={13} /> 删除'))
  check('界面：模型后面那颗钮没密钥/正在测时按不动', models.includes('disabled={!usable || busy}'))
  check('界面：卡片级那条结论行已经撤了（结论跟着模型走）', !models.includes('provider-probe') && !views.includes('.provider-probe'))
  check('样式：图标钮 24px 见方（只留图标时命中区不能跟着变小）+ 悬停换底色用令牌',
    /\.icon-btn\s*\{[^}]*width: 24px;[^}]*height: 24px;/.test(views) && /\.icon-btn:hover:not\(:disabled\)\s*\{[^}]*var\(--dsc-control-hover-bg\)/.test(views))
  check('样式：模型后面那颗测试钮更小更淡（一排芯片挂一串亮 Bolt 会很吵）',
    /\.model-probe\s*\{[^}]*width: 20px;/.test(views) && /\.model-probe\s*\{[^}]*var\(--dsc-text-quaternary\)/.test(views))
  check('样式：成功绿、失败红都用令牌（没有硬编码色值）',
    /\.probe-badge\.ok\s*\{[^}]*var\(--dsc-green\)/.test(views) &&
      /\.probe-badge\.bad\s*\{[^}]*var\(--dsc-red\)/.test(views) &&
      !/\.(icon-btn|model-probe|probe-badge|model-slot)[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/.test(views))
}

// ── 6. 真端到端：真内核 + 本地假端点 ──────────────────────────────────────────
console.log('\n[6] 真端到端：从设置服务走到线上请求')
const wire = []
const sse = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n` +
  'data: [DONE]\n\n'
const site = await (async () => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      wire.push({
        url: req.url,
        authorization: req.headers.authorization ?? '',
        body: JSON.parse(body === '' ? '{}' : body),
      })
      // 钥匙不对就照真端点那样回 401：验「端点回了错」这条路的端到端
      if ((req.headers.authorization ?? '') === 'Bearer bad-key') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"invalid api key"}}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse('ok'))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: () => {
      // 先掐掉还挂着的 keep-alive 连接（fetch/undici 会留池子；不掐的话 close 与
      // 套接字关闭会撞在 libuv 里，进程带着 127 退出，电池就把「全过」读成失败）
      server.closeAllConnections?.()
      return new Promise((resolve) => {
        server.close(resolve)
      })
    },
  }
})()

const modelOf = (id) => ({
  id,
  name: id,
  contextWindow: 100_000,
  maxTokens: 500,
  modalities: ['text'],
  thinkingLevels: [],
  thinkingParam: 'none',
  effortMap: {},
})
const providerOf = (name, apiKey) => ({
  name,
  displayName: name,
  baseUrl: site.baseUrl,
  apiKey,
  models: [modelOf('m-1'), modelOf('m-2')],
})
const ctx = await createKernel({
  config: {
    providers: {
      local: providerOf('local', 'good-key'),
      bad: providerOf('bad', 'bad-key'),
      empty: { ...providerOf('empty', 'good-key'), models: [] },
    },
    defaultProvider: 'local',
    defaultModel: 'm-2',
  },
  resumeSessionPath: null,
})

{
  const out = await ctx.settings.testConnection('local')
  check('真发一次：通了', out.ok === true, JSON.stringify(out))
  check('带回话摘要', out.reply === 'ok', JSON.stringify(out.reply))
  check('耗时是正数', out.ms > 0, String(out.ms))
  check('测的是这个端点平时用的那个模型（默认模型 m-2）', out.model === 'm-2', out.model)
  const sent = wire.at(-1)
  check('请求打到 /chat/completions', sent.url === '/chat/completions', String(sent.url))
  check('带上这个端点的 key（取宿主那份配置，页面指不了别处）', sent.authorization === 'Bearer good-key')
  check(
    '线上就两条消息（system + hi）',
    sent.body.messages?.length === 2 && sent.body.messages[0]?.role === 'system' && sent.body.messages[1]?.content === 'hi',
    JSON.stringify(sent.body.messages),
  )
  check('不带工具目录', sent.body.tools === undefined)
  check(`输出预算压到 ${String(CONNECTION_PROBE_MAX_TOKENS)}`, sent.body.max_tokens === CONNECTION_PROBE_MAX_TOKENS, String(sent.body.max_tokens))
  check('点名指定模型就测指定的那个', (await ctx.settings.testConnection('local', 'm-1')).model === 'm-1')

  const refused = await ctx.settings.testConnection('bad')
  check('端点回 401 → ok:false，并把端点原文带出来', refused.ok === false && refused.error?.includes('401') === true, JSON.stringify(refused))

  let missing = ''
  await ctx.settings.testConnection('nope').catch((error) => {
    missing = error.message
  })
  check('不存在的端点 → 抛错（页面因此拿它当不了「任意地址」）', missing.includes('没有这个端点'), missing)

  let noModel = ''
  await ctx.settings.testConnection('empty').catch((error) => {
    noModel = error.message
  })
  check('端点没有模型 → 抛错并说清先拉清单 / 加模型', noModel.includes('还没有模型'), noModel)
}

ctx.emit('dsc/exit')

console.log('')
if (failures === 0) {
  console.log('测试连接电池：全部通过')
} else {
  console.log(`测试连接电池：${failures} 条失败`)
}
await site.close()
// 退出码交给 process.exitCode，另挂一个 unref 的看门狗只负责「还有别的句柄没放手时别僵住」
// （直接 process.exit 会和内核自己的收尾撞在 libuv 上，进程带 127 退出）。
process.exitCode = failures === 0 ? 0 : 1
if (failures > 0) setTimeout(() => process.exit(1), 500).unref()
