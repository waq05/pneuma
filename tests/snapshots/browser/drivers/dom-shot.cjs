/**
 * 浏览器 DOM 快照的通用 CDP 驱动（Electron 主进程）。
 *
 * 为什么是「真 Electron + 远程调试端口」而不是在主进程里 `executeJavaScript`：
 * 快照要钉的是**页面在真 Chromium 里渲染出来的 DOM 文本**，不是主进程视角的执行结果。
 * 走 `--remote-debugging-port` 之后，动作（点击 / 按键 / 等待选择器）与读数（`innerText`
 * / `location.hash` / 元素计数）全部经 CDP 下发，和一次真实用户操作后的页面是同一份。
 *
 * ## 契约
 *
 * `electron dom-shot.cjs <带令牌的界面地址>`，其余全部走环境变量（照
 * `scripts/_ui-anchor-main.cjs` 的约定：多一个位置参数 Electron 会以 127 退出）：
 *
 * | 变量 | 作用 |
 * | --- | --- |
 * | `DSC_DOM_RESULT` | 读数 JSON 落盘路径（必须） |
 * | `DSC_DOM_CDP_PORT` | 远程调试端口（测试进程用 `freePort()` 挑，避免撞车） |
 * | `DSC_DOM_USER_DATA` | 隔离的 Electron userData |
 * | `DSC_DOM_ACTIONS` | 动作 JSON 数组（见下） |
 * | `DSC_DOM_COUNTS` | 计数 JSON 数组：`[{ "name": "sessions", "selector": ".sess-item" }]` |
 * | `DSC_DOM_WIDTH` / `DSC_DOM_HEIGHT` | 窗口尺寸（窄屏场景靠它进 `max-width: 860px`） |
 * | `DSC_DOM_BOOT` | 首帧选择器（缺省 `.app`） |
 * | `DSC_DOM_SETTLE_MS` | 动作跑完后的静置时间（缺省 1200ms） |
 *
 * 动作类型：
 *
 * - `wait`：等选择器出现（`timeoutMs` 可选）
 * - `click`：点选择器命中的第一个；带 `text` 时只点文本包含它的那个
 * - `eval`：在页面里跑一段表达式（打开设置/命令面板这类经 window 事件走的入口）
 * - `key`：`Input.dispatchKeyEvent`（`key` / `code` / `modifiers`）
 * - `sleep`：`ms`
 * - `scroll`：把选择器命中的元素滚到 `top`（缺省滚到底）
 *
 * ## 读数为什么只有文本与计数
 *
 * 像素跨机器必抖：字体、缩放、GPU 都会让同一份 DOM 差出几个像素。DOM 文本与元素计数
 * 只随产品改动变，跨机器逐字节一致——所以这份驱动的产物**不是截图**。
 *
 * @module dsc/tests/snapshots/browser/drivers/dom-shot
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const { mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')
const WebSocket = require('ws')

const entryUrl = process.argv[2]
const resultPath = String(process.env['DSC_DOM_RESULT'] || '')
const cdpPort = String(process.env['DSC_DOM_CDP_PORT'] || '')
const userData = String(process.env['DSC_DOM_USER_DATA'] || '')
const actions = parseJsonEnv('DSC_DOM_ACTIONS', [])
const countSpec = parseJsonEnv('DSC_DOM_COUNTS', [])
const width = Number(process.env['DSC_DOM_WIDTH'] || 1280)
const height = Number(process.env['DSC_DOM_HEIGHT'] || 860)
const bootSelector = String(process.env['DSC_DOM_BOOT'] || '.app')
const settleMs = Number(process.env['DSC_DOM_SETTLE_MS'] || 1200)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 环境变量里的 JSON：解析失败直接抛——静默给默认值等于让场景悄悄跑错面。 */
function parseJsonEnv(name, fallback) {
  const raw = String(process.env[name] || '')
  if (raw === '') return fallback
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${name} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 读数落盘：结果路径是契约的一部分，没给就只靠退出码，调用方看不到任何东西。 */
function writeResult(value) {
  if (resultPath === '') return
  mkdirSync(dirname(resultPath), { recursive: true })
  writeFileSync(resultPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 等远程调试端口把目标列出来。Electron 起 DevTools 服务器有几百毫秒的迟滞。 */
function listTargets() {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${cdpPort}/json/list`, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.on('error', reject)
    request.setTimeout(2_000, () => request.destroy(new Error('调试端口没响应')))
  })
}

/** 找到我们自己的页面目标（排除 devtools 自身与空白页）。 */
async function pageTarget(timeoutMs) {
  const startedAt = Date.now()
  let lastError = null
  for (;;) {
    try {
      const targets = await listTargets()
      const page = targets.find(
        (target) =>
          target !== null &&
          typeof target === 'object' &&
          target.type === 'page' &&
          typeof target.webSocketDebuggerUrl === 'string' &&
          !String(target.url || '').startsWith('devtools://'),
      )
      if (page !== undefined) return page
    } catch (error) {
      lastError = error
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等不到页面目标（${String(timeoutMs)}ms）${lastError === null ? '' : `：${lastError.message}`}`)
    }
    await sleep(150)
  }
}

/** 渲染进程的控制台/异常：失败时一并带回，省得再开一次 DevTools。 */
const consoleEvents = []

/** 一条最小的 CDP 会话：请求/应答按 id 配对，事件进 `consoleEvents`。 */
function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
    const pending = new Map()
    let seq = 0
    ws.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const type = String(message.params?.type ?? '')
        if (type === 'error' || type === 'warning') {
          const text = (message.params?.args ?? [])
            .map((arg) => (arg?.value === undefined ? (arg?.description ?? '') : String(arg.value)))
            .join(' ')
          consoleEvents.push(`[${type}] ${text}`.slice(0, 500))
        }
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params?.exceptionDetails
        consoleEvents.push(`[exception] ${String(detail?.text ?? '')} ${String(detail?.exception?.description ?? '')}`.slice(0, 500))
        return
      }
      const hit = pending.get(message.id)
      if (hit === undefined) return
      pending.delete(message.id)
      if (message.error !== undefined) hit.reject(new Error(JSON.stringify(message.error)))
      else hit.resolve(message.result)
    })
    ws.once('error', reject)
    ws.once('open', () => {
      const send = (method, params = {}) =>
        new Promise((ok, bad) => {
          const id = ++seq
          pending.set(id, { resolve: ok, reject: bad })
          ws.send(JSON.stringify({ id, method, params }))
        })
      /**
       * 页面侧求值。`awaitPromise` 让动作里的 `await sleep()` 成立；`returnByValue`
       * 让对象直接回来而不是句柄（句柄会随页面导航失效）。
       */
      const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        })
        if (result.exceptionDetails !== undefined) {
          const text = result.exceptionDetails.text ?? '页面求值异常'
          const detail = result.exceptionDetails.exception?.description ?? ''
          throw new Error(`${text}${detail === '' ? '' : `：${detail}`}`)
        }
        return result.result?.value
      }
      resolve({ ws, send, evaluate })
    })
  })
}

/** 轮询一个页面表达式直到为真。 */
async function waitFor(cdp, expression, timeoutMs, label) {
  const startedAt = Date.now()
  for (;;) {
    if ((await cdp.evaluate(expression)) === true) return
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等不到：${label}`)
    await sleep(100)
  }
}

/** 动作在页面里的实现：返回 true 表示这一步真的做到了。 */
function actionExpression(action) {
  switch (action.type) {
    case 'wait':
      return `document.querySelector(${JSON.stringify(action.selector)}) !== null`
    case 'click': {
      const text = action.text === undefined ? null : String(action.text)
      return [
        '(() => {',
        `  const nodes = [...document.querySelectorAll(${JSON.stringify(action.selector)})];`,
        `  const text = ${JSON.stringify(text)};`,
        '  const hit = text === null ? nodes[0] : nodes.find((node) => (node.textContent ?? "").includes(text));',
        '  if (hit === undefined) return false;',
        '  hit.scrollIntoView({ block: "center", inline: "nearest" });',
        '  hit.click();',
        '  return true;',
        '})()',
      ].join('\n')
    }
    case 'eval':
      return `(async () => { ${String(action.expression ?? '')} })()`
    case 'scroll': {
      const top = action.top === undefined ? 'el.scrollHeight' : String(Number(action.top))
      return [
        '(() => {',
        `  const el = document.querySelector(${JSON.stringify(action.selector)});`,
        '  if (el === null) return false;',
        `  el.scrollTop = ${top};`,
        '  return true;',
        '})()',
      ].join('\n')
    }
    default:
      return null
  }
}

/** 按键：走 CDP 的 Input 域（与真实键盘同一条输入管线）。 */
async function dispatchKey(cdp, action) {
  const key = String(action.key ?? '')
  if (key === '') throw new Error('key 动作缺 key')
  const code = String(action.code ?? key)
  const modifiers = Number(action.modifiers ?? 0)
  const base = { key, code, modifiers, windowsVirtualKeyCode: Number(action.windowsVirtualKeyCode ?? 0) }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/** 动作跑完后等页面不再变：连续两拍文本一致才算稳。 */
async function settle(cdp) {
  await sleep(settleMs)
  let previous = null
  for (let round = 0; round < 40; round += 1) {
    const text = await cdp.evaluate('document.body.innerText')
    if (text === previous) return
    previous = text
    await sleep(150)
  }
}

/** 最终读数：整页文本 + hash + 关键 DOM 计数。 */
async function snapshot(cdp) {
  const counts = {}
  for (const spec of countSpec) {
    const name = String(spec.name ?? spec.selector)
    const selector = String(spec.selector ?? '')
    counts[name] = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
  }
  counts['dom.elements'] = await cdp.evaluate('document.querySelectorAll("*").length')
  counts['dom.buttons'] = await cdp.evaluate('document.querySelectorAll("button").length')
  counts['dom.inputs'] = await cdp.evaluate('document.querySelectorAll("input, textarea, select").length')
  return cdp.evaluate(`({
    url: location.href,
    hash: location.hash,
    pathname: location.pathname,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    counts: ${JSON.stringify(counts)},
    text: document.body.innerText,
  })`).then((value) => ({ ...value, console: consoleEvents.slice(-12) }))
}

app.disableHardwareAcceleration()
if (userData !== '') app.setPath('userData', userData)
if (cdpPort !== '') {
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort)
  // 本机回环来源默认被拒，放开才允许 ws 升级（只是调试端口，只绑 127.0.0.1）。
  app.commandLine.appendSwitch('remote-allow-origins', '*')
}

app.whenReady().then(async () => {
  const out = { error: undefined }
  let window = null
  let cdp = null
  try {
    if (entryUrl === undefined || entryUrl === '') throw new Error('缺界面地址（process.argv[2]）')
    if (cdpPort === '') throw new Error('缺 DSC_DOM_CDP_PORT')
    window = new BrowserWindow({
      width: Number.isFinite(width) && width > 0 ? width : 1280,
      height: Number.isFinite(height) && height > 0 ? height : 860,
      show: false,
      webPreferences: { backgroundThrottling: false },
    })
    await window.loadURL(entryUrl)
    const target = await pageTarget(60_000)
    cdp = await connect(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    // 等壳把第一帧挂上：比 `readyState` 更贴近「界面真的能操作了」。
    await waitFor(cdp, `document.querySelector(${JSON.stringify(bootSelector)}) !== null`, 60_000, `首帧选择器 ${bootSelector}`)

    for (const action of actions) {
      if (action === null || typeof action !== 'object') throw new Error(`动作形状不对：${JSON.stringify(action)}`)
      if (action.type === 'key') {
        await dispatchKey(cdp, action)
        continue
      }
      if (action.type === 'sleep') {
        await sleep(Number(action.ms ?? 300))
        continue
      }
      const expression = actionExpression(action)
      if (expression === null) throw new Error(`不认识的动作：${JSON.stringify(action.type)}`)
      if (action.type === 'wait' || action.type === 'click') {
        // wait 与 click 都要**轮询**：插件是分批装进来的，eval 之后设置/面板不会同帧出现。
        // click 的表达式带副作用，轮询只在第一次命中时点一下（命中即返回 true，waitFor 收工）。
        const label = `动作 ${JSON.stringify(action)}`
        await waitFor(cdp, expression, Number(action.timeoutMs ?? 20_000), label)
      } else {
        const ok = await cdp.evaluate(expression)
        if (ok !== true) throw new Error(`动作没做到：${JSON.stringify(action)}`)
      }
      if (action.settleMs !== undefined) await sleep(Number(action.settleMs))
    }

    await settle(cdp)
    const shot = await snapshot(cdp)
    Object.assign(out, shot)
  } catch (error) {
    out.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    // 失败也要把现场带回来：只报「等不到选择器」等于让下一个人重跑一遍才知道 DOM 长什么样。
    if (cdp !== null) {
      try {
        Object.assign(out, await snapshot(cdp))
      } catch {
        // 页面已经崩了，保留原始错误
      }
    }
  } finally {
    try {
      cdp?.ws.close()
    } catch {
      // 已经关了
    }
    writeResult(out)
    // 读数文件是契约：即便场景失败也以 0 退出，让调用方拿到 JSON 里的原始错误（而不是一个裸退出码）。
    app.exit(0)
  }
})
