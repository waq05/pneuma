/**
 * 旁问（side ask）探针：只读契约、消息组装、界面入口、产物接线。
 *
 * 四段：
 *   [1] 纯逻辑：选区整理（最短/折叠/截断）与浮钮位置（右下、越界回收、底部翻页）；
 *   [2] 宿主：buildSideAskMessages 的引用围栏与截断、sideAskOnce 不带 tools / 预算封顶 /
 *       增量拼接 / 取消回「已停止」；
 *   [3] 界面通道：sideAsk / sideAskCancel 在白名单里、实参规格拦得住空票据与超长问题；
 *   [4] 接线：runtime 用 ctx.llm.route() + stream 发、插件注册了页签与两条动作、
 *       dock 认得 ask 这一种 kind、产物里真有 ask 插件。
 *
 * 跑法：pnpm run build && pnpm build:ui && node scripts/ui-side-ask-test.mjs
 *
 * @module dsc/scripts/ui-side-ask-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log('  ok  ' + name)
  else {
    failures += 1
    console.log('FAIL  ' + name + (detail === '' ? '' : '：' + detail))
  }
}

const select = await import(new URL('../ui-shell/src/plugins/ask/select.ts', import.meta.url).href)
const sideAsk = await import(new URL('../src/core/side-ask.ts', import.meta.url).href)
const uiMethods = await import(new URL('../lib/core/ui-methods.js', import.meta.url).href)

console.log('[1] 选区整理与浮钮位置')
{
  const { normalizeSelection, anchorOf, MIN_SELECTION_CHARS, MAX_SELECTION_CHARS } = select
  check('太短的返回 null', normalizeSelection('abc') === null)
  check('刚好到阈值就收', normalizeSelection('abcd') === 'abcd' && MIN_SELECTION_CHARS === 4)
  check('保留换行、只压每行内的空格', normalizeSelection('  ab\n  cd  ') === 'ab\ncd')
  check('连续空行压成一个', normalizeSelection('a\n\n\n\nb') === 'a\n\nb')
  check('代码缩进被抹平但结构还在', normalizeSelection('    const a = 1\n      const b = 2') === 'const a = 1\nconst b = 2')
  const long = 'x'.repeat(MAX_SELECTION_CHARS + 50)
  const clipped = normalizeSelection(long)
  check('超长截断并加省略号', clipped !== null && clipped.length === MAX_SELECTION_CHARS + 1 && clipped.endsWith('…'))
  check('全空白返回 null', normalizeSelection('   \n  ') === null)

  const view = { width: 1280, height: 800 }
  const mid = anchorOf({ left: 200, top: 100, right: 300, bottom: 120 }, view)
  check('默认贴选区右下角', mid.left === 300 - select.BUBBLE_W && mid.top === 120 + select.ANCHOR_GAP)
  const rightEdge = anchorOf({ left: 1200, top: 100, right: 1279, bottom: 120 }, view)
  check('贴右缘时往回收（不出视口）', rightEdge.left === view.width - select.BUBBLE_W - select.ANCHOR_GAP)
  const bottom = anchorOf({ left: 10, top: 760, right: 100, bottom: 790 }, view)
  check('贴底边时翻到选区上方', bottom.top === 760 - select.BUBBLE_H - select.ANCHOR_GAP)
  const topEdge = anchorOf({ left: 10, top: 0, right: 100, bottom: 795 }, view)
  check('上下都放不下时夹在顶部安全区', topEdge.top >= select.ANCHOR_GAP)
}

console.log('[2] 宿主：消息组装与只读调用')
{
  const messages = sideAsk.buildSideAskMessages('这是什么？', 'const a = 1')
  check('两条消息：system 在最前', messages.length === 2 && messages[0].role === 'system')
  check('引用块在问题前面（带围栏）', messages[1].content.includes('````') && messages[1].content.indexOf('const a = 1') < messages[1].content.indexOf('这是什么？'))
  check('没有引用时只有问题', sideAsk.buildSideAskMessages('只问一句').at(1).content === '只问一句')
  check('引用超长按上限截断', sideAsk.buildSideAskMessages('q', 'y'.repeat(sideAsk.SIDE_ASK_MAX_QUOTE + 100)).at(1).content.includes('引用过长'))
  check('提示词写明不执行工具', sideAsk.SIDE_ASK_SYSTEM.includes('不执行工具'))

  // 假派发口：记下请求，吐两段增量。
  const seen = []
  const stream = async (api, request, handlers) => {
    seen.push({ api, request })
    handlers.onDelta('text', '你')
    handlers.onDelta('reasoning', '思考中')
    handlers.onDelta('text', '好')
    return { text: '你好' }
  }
  const route = { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', maxTokens: 8000, temperature: 0.3 }
  const outcome = await sideAsk.sideAskOnce({ route, stream, question: '问', quote: '引', signal: new AbortController().signal })
  check('只拼正文增量（reasoning 不混进答案）', outcome.text === '你好', outcome.text)
  check('回包带模型名', outcome.model === 'm')
  const sent = seen[0].request
  check('请求不带 tools（只读的硬保证）', sent.tools === undefined)
  check('输出预算封顶 1200', sent.maxTokens === sideAsk.SIDE_ASK_MAX_TOKENS)
  check('思考档与温度照路由带', sent.temperature === 0.3)

  // 取消：signal 先 aborted，派发口抛错 → 回「已停止」而不是炸。
  const controller = new AbortController()
  controller.abort()
  const failing = async () => {
    throw new Error('aborted')
  }
  const stopped = await sideAsk.sideAskOnce({ route, stream: failing, question: '问', signal: controller.signal })
  check('取消后返回 stopped 而不是抛', stopped.stopped === true && stopped.text === '')

  // 适配器可能「abort 时正常收尾」：信号已中止就该报 stopped，而不是 done。
  const halfController = new AbortController()
  const halfStream = async (api, request, handlers) => {
    handlers.onDelta('text', '半截')
    halfController.abort()
    return { text: '半截' }
  }
  const half = await sideAsk.sideAskOnce({ route, stream: halfStream, question: '问', signal: halfController.signal })
  check('流正常收尾但信号已中止 → stopped', half.stopped === true && half.text === '半截')

  // 真错误照旧抛：不能把「网络挂了」也说成「已停止」。
  let threw = false
  try {
    await sideAsk.sideAskOnce({ route, stream: failing, question: '问', signal: new AbortController().signal })
  } catch {
    threw = true
  }
  check('未取消时的错误原样抛出', threw)
}

console.log('[3] 界面通道：白名单与实参规格')
{
  const methods = uiMethods.UI_METHODS
  check('sideAsk 在界面白名单', methods.includes('sideAsk'))
  check('sideAskCancel 在界面白名单', methods.includes('sideAskCancel'))
  check('sideAsk 在协议白名单（否则运行时被拒）', read('src/core/host-methods.ts').includes("'sideAsk'"))
  const ok = uiMethods.validateUiArgs('sideAsk', ['问一句', '引一段', 'ticket-1', 'local', 'm-1'])
  check('正常实参放行', ok.ok === true)
  check('缺票据被拒', uiMethods.validateUiArgs('sideAsk', ['问一句']).ok === false)
  check('缺模型两参被拒', uiMethods.validateUiArgs('sideAsk', ['q', '', 't-1']).ok === false)
  check('超长问题被拒', uiMethods.validateUiArgs('sideAsk', ['x'.repeat(5000), '', 't-1', '', '']).ok === false)
  check('超长引用被拒', uiMethods.validateUiArgs('sideAsk', ['q', 'x'.repeat(9000), 't-1', '', '']).ok === false)
  check('超长取消票据被拒', uiMethods.validateUiArgs('sideAskCancel', ['x'.repeat(65)]).ok === false)
  check('空引用传空串放行（界面永远传字符串）', uiMethods.validateUiArgs('sideAsk', ['q', '', 't-1', '', '']).ok === true)
  check('中间的 undefined 被拒（省略只能从尾部）', uiMethods.validateUiArgs('sideAsk', ['q', undefined, 't-1', '', '']).ok === false)
  check('模型两参为「跟随主会话」时空串也放行', uiMethods.validateUiArgs('sideAsk', ['q', '', 't-1', '', '']).ok === true)
}

console.log('[4] 接线与产物')
{
  const runtime = read('src/plugins/runtime.ts')
  check('runtime 走同一条派发口', runtime.includes('ctx.llm.stream(api, request, handlers)'))
  check('runtime 支持指定模型（空串则跟随主会话）', runtime.includes("ctx.llm.routeTo(provider, model, 'default')") && runtime.includes('ctx.llm.route()'))
  check('runtime 把增量经事件发出去', runtime.includes("ctx.emit('dsc/side-ask-chunk', { id: requestId, delta })"))
  check('runtime 维护取消票据表', runtime.includes('const sideAsks = new Map<string, AbortController>()'))
  const plugin = read('ui-shell/src/plugins/ask/ui.tsx')
  check('插件注册 ask 页签（keepMounted）', plugin.includes("kind: 'ask'") && plugin.includes('keepMounted: true'))
  check('两条命令面板动作', plugin.includes("id: 'ask.open'") && plugin.includes("id: 'ask.selection'"))
  check('快捷键 Ctrl+Shift+K', plugin.includes("event.key.toLowerCase() !== 'k'") && plugin.includes('event.shiftKey'))
  check('浮钮只在正文里浮（.chat）', plugin.includes("host.closest('.chat')"))
  check('dock 认得 ask 这一种 kind', read('ui-shell/src/ui-dockkit/dock-model.ts').includes("| 'ask'") && read('ui-shell/src/ui-dockkit/dock.tsx').includes("ask: { title: '旁问'"))
  const built = join(root, 'lib/ui/plugins/ask/client.js')
  check('产物里有 ask 插件', existsSync(built))
  if (existsSync(built)) {
    const client = readFileSync(built, 'utf8')
    check('产物含引用 chip 与发送', client.includes('ask-quote-chip') && client.includes('ask-send'))
    // 2.0 起「谁是插件」由产物目录自己的 bundle.json 说，中央清单只写壳契约版本。
    const bundle = JSON.parse(read('lib/ui/plugins/ask/bundle.json'))
    check('ask 的产物自述在位（apiVersion + 载体）', typeof bundle.apiVersion === 'string'
      && Array.isArray(bundle.platforms) && bundle.platforms.includes('web'), JSON.stringify(bundle))
  }
}

console.log('[5] 流式与模型选择')
{
  const events = read('src/core/ui-events.ts')
  const webserver = read('src/plugins/webserver.ts')
  const channel = read('ui-shell/src/ui-layout/host-channel.ts')
  const api = read('ui-shell/src/plugin-api.ts')
  const store = read('ui-shell/src/plugins/ask/store.ts')
  const plugin = read('ui-shell/src/plugins/ask/ui.tsx')
  const sessions = read('ui-shell/src/plugins/sessions/ui.tsx')

  check('通道另有 ask 事件（与 plugins 同级，不进帧 hub）', events.includes("writeEvent(res, 'ask', data)") && events.includes("subscribe((chunk) => {"))
  check('webserver 把 dsc/side-ask-chunk 转成 ask 帧', webserver.includes("ctx.on('dsc/side-ask-chunk'") && webserver.includes('ask: {'))
  check('客户端订阅 event: ask', channel.includes("es.addEventListener('ask'") && channel.includes('onAsk(listener)'))
  check('插件 API 只暴露 useAskStream（不必认识 SSE）', api.includes('useAskStream') && api.includes('export type { AskChunk }'))
  check('store 支持追加增量', store.includes('export function appendAnswer('))
  check('页签接上增量流', plugin.includes('useAskStream((chunk) => {') && plugin.includes('appendAnswer(sessionId, chunk.id, chunk.delta)'))
  check('答案流式渲染（光标 + 停止）', plugin.includes('className="ask-caret"') && plugin.includes('正在回答…'))
  check('模型选择器（跟随主会话 + listModels）', plugin.includes("invoke<ModelChoice[]>('listModels')") && plugin.includes('跟随主会话'))
  check('选中的模型随请求发出（第 4、5 个实参）', plugin.includes("choice?.provider ?? ''") && plugin.includes("choice?.model ?? ''"))
  check('选择记在 localStorage', plugin.includes('window.localStorage.setItem(ASK_MODEL_KEY'))
  // 2026-10-26 第二轮：鼠标入口搬到右侧栏自己的「开始」页（它开的就是右边那张页签）。
  const dock = read('ui-shell/src/ui-dockkit/dock.tsx')
  check('右侧栏「开始」页有旁问入口', /kind: 'ask', title: '旁问'/.test(dock) && dock.includes("{entry.kind === 'ask' && <IconSpark size={17} />}"))
  check('这颗卡带得出快捷键（Ctrl + Shift + K）', dock.includes("'Ctrl + Shift + K'"))
  check('左侧栏不再重复一颗（它与「技能/插件」整页入口不同类）', !sessions.includes('ask-entry') && !sessions.includes('data-nav="ask"'))
  check('页脚也不再重复一颗', !sessions.includes('row row-btn ask-entry'))
  check('插件不再监听那个没人发的事件（入口全在插件自己手里）', !plugin.includes("addEventListener('shell.ask.open'"))

  // 悬停背景必须仍垫着不透明底色：--dsc-control-hover-bg 是 8% 叠加色，单独当背景
  // 会让按钮变半透明、下层正文透出来（2026-10-26 实测）。
  const css = read('ui-shell/src/styles.css')
  const hoverRule = /\.ask-sel-btn:hover\s*\{([^}]*)\}/.exec(css)
  check('浮钮悬停仍叠在弹层底色上（不会变透明）', hoverRule !== null && hoverRule[1].includes('var(--dsc-bg-popover)'), hoverRule === null ? '没找到 :hover 规则' : hoverRule[1].replace(/\s+/g, ' '))
  check('浮钮悬停不靠 opacity 做提亮', hoverRule !== null && !/opacity/.test(hoverRule[1]))
}
if (failures === 0) console.log('\n全部通过')
else console.log('\n' + String(failures) + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
