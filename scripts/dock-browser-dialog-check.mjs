/**
 * P0-13 探针：`alert()` / `confirm()` 弹出来之后，这条链要能自己说清楚、能处理。
 *
 * 钉七件事：
 *   1. 契约把 `Page.javascriptDialogOpening/Closed` 放进事件白名单，动作表里有 `dialog`；
 *   2. `Opening` 到达后状态被记下来（快照结果顶部出现「有弹窗待处理」）；
 *   3. `dialog action=dialogAction=dismiss` 真的发 `Page.handleJavaScriptDialog{accept:false}`，
 *      处理完提示消失；`accept` 能把 `promptText`（或弹窗自带默认值）带过去；
 *   4. `Closed` 到达后状态清空，快照不再提示；
 *   5. 没弹窗时调 `dialog` 报一句人话，不是挂到超时；
 *   6. 超时那一条：25 秒到了会自动 dismiss，并且**在结果里说明**（下一次快照顶部带出原因）；
 *   7. 兜底定时器每条视图一个，关掉视图/停在超时都不会漏。
 *
 * 定时器用假时钟接管（插件里是裸 `setTimeout(...)` 调用，跑的是全局那份），
 * 所以 25 秒的路径在探针里是同步走完的，不靠真等。
 *
 * 与 `dock-browser-look-check.mjs` 同一套「直读 src」的加载钩子：探针要能拦住构建前的改动。
 *
 * @module dsc/scripts/dock-browser-dialog-check
 */
import { existsSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// readConfig 会读 ~/.dsc/plugins.json：换成临时 HOME，真实 profile 一个字节都不动。
const home = mkdtempSync(join(tmpdir(), 'dsc-dock-dialog-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(join(home, '.dsc'), { recursive: true })

/** `@pneuma/runtime/x` → `src/x`；`@pneuma/<id>/x.js` → `src/packages/<id>/x.ts`。 */
function mapSpecifier(specifier, parentUrl) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const base = new URL(specifier, parentUrl)
    const asTs = base.href.replace(/\.js$/, '.ts')
    if (existsSync(fileURLToPath(asTs))) return asTs
    return null
  }
  if (!specifier.startsWith('@pneuma/')) return null
  const rest = specifier.slice('@pneuma/'.length)
  const relative = rest.startsWith('runtime/') ? `src/${rest.slice('runtime/'.length)}` : `src/packages/${rest}`
  const base = join(root, relative)
  const candidates = /\.js$/.test(base)
    ? [base.replace(/\.js$/, '.ts'), base]
    : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
  for (const candidate of candidates) if (existsSync(candidate)) return pathToFileURL(candidate).href
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = mapSpecifier(specifier, context.parentURL ?? pathToFileURL(join(root, 'x.js')).href)
    return mapped === null ? nextResolve(specifier, context) : { url: mapped, shortCircuit: true }
  },
  load(url, context, nextLoad) {
    if (!/\.tsx?$/.test(new URL(url).pathname)) return nextLoad(url, context)
    const file = fileURLToPath(url)
    const output = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        verbatimModuleSyntax: false,
      },
    })
    return { format: 'module', source: output.outputText, shortCircuit: true }
  },
})

const { dockBrowserPlugin } = await import(pathToFileURL(join(root, 'src/packages/dock-browser/index.ts')).href)
const { DOCK_ACTIONS, DOCK_CDP_EVENTS, DOCK_CALL_TIMEOUT_MS } = await import(
  pathToFileURL(join(root, 'src/core/dock-browser.ts')).href
)
const HOST_BROWSER_SERVICE = 'hostBrowser'

let passed = 0
let failed = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${name}${detail === '' ? '' : `  <- ${detail}`}`)
}
/** 一节一个独立块：里面抛了记一条 FAIL 继续跑，别让探针在第一个缺口上崩掉。 */
const section = async (title, body) => {
  console.log(`\n${title}`)
  // 上一节留下的兜底定时器（比如只弹不处理的那些）不带到这一节来数。
  pendingTimers.clear()
  try {
    await body()
  } catch (error) {
    failed += 1
    console.log(`FAIL  这一段抛了：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

// ── 假时钟 ────────────────────────────────────────────────────────────────
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let timerSeq = 0
const pendingTimers = new Map()
globalThis.setTimeout = (callback, ms) => {
  const id = ++timerSeq
  pendingTimers.set(id, { callback, ms })
  return { id, unref() {} }
}
globalThis.clearTimeout = (handle) => {
  if (handle !== null && typeof handle === 'object' && typeof handle.id === 'number') pendingTimers.delete(handle.id)
}
/** 把当前挂着的定时器全放掉（模拟「时间到了」）。 */
const fireTimers = () => {
  const due = [...pendingTimers.values()]
  pendingTimers.clear()
  for (const timer of due) timer.callback()
}
const tick = () => new Promise((done) => realSetTimeout(done, 0))

/**
 * 造一条桩链路：事件订得上、命令记得下。
 *
 * `send` 只回两个动作要的两条应答（无障碍树、读文档状态），其余回空对象。
 */
function makeLink() {
  const sent = []
  const handlers = []
  const target = {
    sessionId: 'agent-1',
    async send(method, params) {
      sent.push({ method, params })
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { url: 'https://example.com/', title: '示例', readyState: 'complete' } } }
      }
      return {}
    },
    on: () => () => {},
  }
  return {
    sent,
    handlers,
    available: () => true,
    views: async () => [{ id: 'agent-1', url: 'https://example.com/', title: '示例', loading: false, visible: true }],
    open: async (url, viewId) => ({ viewId: viewId ?? 'agent-1', attached: true, url }),
    close: async () => {},
    call: async () => ({}),
    onEvent: (handler) => {
      handlers.push(handler)
      return () => {}
    },
    session: () => target,
  }
}

/** 用假 ctx 挂一次插件；`transcript` 收下所有系统提示。 */
function mount(link) {
  const tools = []
  const notes = []
  const ctx = {
    tools: {
      register: (entry) => {
        tools.push(entry)
        return () => {}
      },
    },
    settings: { registerSection: () => () => {} },
    effect: (execute) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    get: (name) => {
      if (name === HOST_BROWSER_SERVICE) return link
      if (name === 'transcript') return { system: (line) => notes.push(line) }
      return undefined
    },
  }
  // lookWithoutApproval 打开：这一节只验对话框，别把 P0-12 的档位混进来。
  const off = dockBrowserPlugin.apply(ctx, { lookWithoutApproval: true })
  const byName = (name) => tools.find((tool) => tool.name === name)
  return { tools, notes, look: byName('browser_dock_look'), act: byName('browser_dock'), off }
}

const call = { signal: new AbortController().signal }
/** 跑一次 look snapshot，返回它给模型看的文本。 */
const snapshotText = async (look) => {
  const out = await look.run({ action: 'snapshot', viewId: 'agent-1' }, call)
  return typeof out === 'string' ? out : String(out?.text ?? '')
}
/** 把一条 CDP 事件喂进插件（等于桌面侧推上来那条）。 */
const feed = (link, method, params) => {
  for (const handler of link.handlers) handler({ viewId: 'agent-1', method, params })
}
const dialogCalls = (sent) => sent.filter((item) => item.method === 'Page.handleJavaScriptDialog')
/** 跑一段 act，把人话报错抓出来。 */
const runAct = async (act, args) => {
  try {
    return { text: await act.run(args, call), error: null }
  } catch (error) {
    return { text: '', error: error instanceof Error ? error.message : String(error) }
  }
}

await section('[1] 契约：两条事件在白名单里，动作表里有 dialog', async () => {
  check(
    'Page.javascriptDialogOpening 在事件白名单里',
    DOCK_CDP_EVENTS.includes('Page.javascriptDialogOpening'),
    `白名单=${JSON.stringify([...DOCK_CDP_EVENTS])}`,
  )
  check(
    'Page.javascriptDialogClosed 在事件白名单里',
    DOCK_CDP_EVENTS.includes('Page.javascriptDialogClosed'),
    `白名单=${JSON.stringify([...DOCK_CDP_EVENTS])}`,
  )
  check('动作表里有 dialog', DOCK_ACTIONS.includes('dialog'), `动作表=${JSON.stringify([...DOCK_ACTIONS])}`)
  check(
    '超时预算是 25 秒那条',
    DOCK_CALL_TIMEOUT_MS === 25_000,
    `DOCK_CALL_TIMEOUT_MS=${String(DOCK_CALL_TIMEOUT_MS)}：这条就是桌面侧掐单条命令的预算，弹窗兜底沿用它，别另发明一个数`,
  )
})

await section('[2] Opening 到达：状态被记下，快照顶部提示', async () => {
  const link = makeLink()
  const { look } = mount(link)
  await snapshotText(look) // 第一次调用把事件订上
  check('事件订阅已经建立', link.handlers.length > 0, `handlers=${link.handlers.length}`)
  feed(link, 'Page.javascriptDialogOpening', { type: 'confirm', message: '确定删除这条记录吗？', defaultPrompt: '' })
  const text = await snapshotText(look)
  check(
    '快照结果里出现「弹窗待处理」的提示',
    text.includes('对话框') && text.includes('确定删除这条记录吗？'),
    `快照开头：${JSON.stringify(text.slice(0, 200))}——弹窗挂着时命令全被浏览器压住，模型看不到这条提示就只能等到超时`,
  )
  check(
    '提示在结果顶部（不是埋在无障碍树后面）',
    text.includes('对话框') && text.indexOf('对话框') < 400,
    `「对话框」出现在第 ${text.indexOf('对话框')} 个字符处：埋在大段树后面等于没提示`,
  )
  check(
    '提示里给出了处理入口（browser_dock action=dialog）',
    text.includes('browser_dock') && text.includes('dialog'),
    `快照开头：${JSON.stringify(text.slice(0, 200))}`,
  )
})

await section('[3] dialog 动作：dismiss 真的发命令，处理完提示消失', async () => {
  const link = makeLink()
  const { look, act } = mount(link)
  await snapshotText(look)
  feed(link, 'Page.javascriptDialogOpening', { type: 'confirm', message: '要退出吗？', defaultPrompt: '' })
  const { text } = await runAct(act, { action: 'dialog', viewId: 'agent-1', dialogAction: 'dismiss' })
  const calls = dialogCalls(link.sent)
  check(
    'dialog 动作发出 Page.handleJavaScriptDialog{accept:false}',
    calls.length === 1 && calls[0].params?.accept === false,
    `实际发出 ${JSON.stringify(calls)}：不发这条命令等于什么都没做，弹窗还挂着`,
  )
  check(
    '结果里说明了处理的是哪种对话框',
    text.includes('confirm') && text.includes('关掉'),
    `返回：${JSON.stringify(text.slice(0, 160))}`,
  )
  const after = await snapshotText(look)
  check(
    '处理完之后快照不再提示',
    !after.includes('等着处理'),
    `快照开头：${JSON.stringify(after.slice(0, 160))}——状态没清掉的话模型会反复处理同一个弹窗`,
  )
})

await section('[4] accept 把 promptText / 弹窗默认值带过去', async () => {
  const link = makeLink()
  const { look, act } = mount(link)
  await snapshotText(look)
  feed(link, 'Page.javascriptDialogOpening', { type: 'prompt', message: '新名字', defaultPrompt: '未命名' })
  await runAct(act, { action: 'dialog', viewId: 'agent-1', dialogAction: 'accept' })
  const calls = dialogCalls(link.sent)
  check(
    'accept 发出 accept:true 并带上 prompt 的默认值',
    calls.length === 1 && calls[0].params?.accept === true && calls[0].params?.promptText === '未命名',
    `实际 ${JSON.stringify(calls)}：prompt() 不给文本会用空串，把弹窗自带默认值丢掉等于替用户改了输入`,
  )
  feed(link, 'Page.javascriptDialogOpening', { type: 'prompt', message: '新名字', defaultPrompt: '未命名' })
  await runAct(act, { action: 'dialog', viewId: 'agent-1', dialogAction: 'accept', promptText: '季度报表' })
  const second = dialogCalls(link.sent)[1]
  check('显式 promptText 优先', second?.params?.promptText === '季度报表', `实际 ${JSON.stringify(second)}`)
})

await section('[5] Closed 到达：状态清空', async () => {
  const link = makeLink()
  const { look } = mount(link)
  await snapshotText(look)
  feed(link, 'Page.javascriptDialogOpening', { type: 'alert', message: '注意一下', defaultPrompt: '' })
  feed(link, 'Page.javascriptDialogClosed', { result: true, userGesture: true })
  const text = await snapshotText(look)
  check(
    'Closed 之后快照不再提示',
    !text.includes('等着处理'),
    `快照开头：${JSON.stringify(text.slice(0, 160))}——用户在界面上点了「确定」也走这条事件，不清掉等于一直误报`,
  )
})

await section('[6] 25 秒超时：自动 dismiss，并在结果里说明', async () => {
  const link = makeLink()
  const { look, notes } = mount(link)
  await snapshotText(look)
  feed(link, 'Page.javascriptDialogOpening', { type: 'confirm', message: '提交后不可撤销', defaultPrompt: '' })
  check('打开时挂了一个兜底定时器', pendingTimers.size === 1, `挂着的定时器 ${pendingTimers.size} 个`)
  for (const timer of pendingTimers.values()) {
    check('兜底定时器的时长就是 25 秒预算', timer.ms === DOCK_CALL_TIMEOUT_MS, `定时器 ${String(timer.ms)}ms`)
  }
  fireTimers()
  await tick()
  const calls = dialogCalls(link.sent)
  check(
    '超时后自动发出 dismiss',
    calls.length === 1 && calls[0].params?.accept === false,
    `实际 ${JSON.stringify(calls)}：不自动 dismiss 的话，这条视图从此每条命令都要等 25 秒才超时`,
  )
  check(
    '对话流里说明了「为什么被关掉」',
    notes.some((line) => line.includes('25') && line.includes('自动')),
    `transcript=${JSON.stringify(notes.slice(-1))}`,
  )
  const text = await snapshotText(look)
  check(
    '下一次快照把原因带出来（结果里有说明）',
    text.includes('自动') && text.includes('25') && text.includes('提交后不可撤销'),
    `快照开头：${JSON.stringify(text.slice(0, 220))}`,
  )
  check('说明只带一次（不重复刷屏）', !(await snapshotText(look)).includes('自动'), '同一条说明被反复带出，会挤掉真正的快照内容')
})

await section('[7] 没有弹窗时调 dialog：报一句人话，不挂到超时', async () => {
  const link = makeLink()
  const { look, act } = mount(link)
  await snapshotText(look)
  const { error } = await runAct(act, { action: 'dialog', viewId: 'agent-1', dialogAction: 'accept' })
  check(
    '没弹窗时抛一句人话',
    error !== null && error.includes('没有待处理') && !error.includes('\n    at '),
    `实际：${JSON.stringify(error)}`,
  )
  check('没有乱发 Page.handleJavaScriptDialog', dialogCalls(link.sent).length === 0, `实际 ${JSON.stringify(dialogCalls(link.sent))}`)
})

globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout
rmSync(home, { recursive: true, force: true })
console.log(`\nPASS ${passed} / FAIL ${failed}`)
if (failed > 0) process.exitCode = 1
