/**
 * 打包产物实机测试的共用壳：一个场景 = 一次全新的应用进程。
 *
 * 为什么要有它：`desktop/shots/` 里那批 `_verify-*` 各写一遍「隔离 HOME → 起应用 → 连 CDP →
 * 截图 → 杀进程」。打包产物这一批（2026-11-17）要跑六七个场景，再抄一遍就成了维护负担。
 *
 * 它只做四件事：
 *   1. 建一个一次性 HOME（`shots/_pkg-<id>-home`），写 `config.yaml` 指到本地假端点；
 *   2. 起 `desktop/dist/win-unpacked/Pneuma.exe`，开远程调试端口；
 *   3. 连上 CDP，给 `evaluate / send / shot / body` 四个小工具；
 *   4. 不管成败都把进程杀掉。
 *
 * 假端点按场景给：`fake.script` 是 SSE 分片列表，`fake.tool` 给一次工具调用。
 *
 * @module dsc/desktop/shots/pkg-harness
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = 'D:/dsc'
const SHOTS = join(ROOT, 'desktop/shots')
const EXE = join(ROOT, 'desktop/dist/win-unpacked/Pneuma.exe')
const BASE_API_PORT = 19_100
const BASE_DEBUG_PORT = 9_390

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个最简 OpenAI 兼容端点，按场景返回。返回 { url, calls, close } */
export function startFakeLlm({ port, script, tool }) {
  let calls = 0
  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-code', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake')
      return
    }
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        calls += 1
        const body = Buffer.concat(chunks).toString('utf8')
        const hasToolResult = /"tool"\s*:/.test(body) || /"role"\s*:\s*"tool"/.test(body)
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const emit = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n')
        const delta = (patch, finish = null) => emit({ choices: [{ delta: patch, finish_reason: finish }] })
        const done = () => {
          delta({}, 'stop')
          emit({ choices: [{ delta: {}, finish_reason: null }], usage: { prompt_tokens: 30, completion_tokens: 20 } })
          res.write('data: [DONE]\n\n')
          res.end()
        }
        // 第一次请求：给工具调用（如果场景要求）
        if (tool !== undefined && !hasToolResult) {
          delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool.name, arguments: '' } }] })
          delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.args) } }] })
          delta({}, 'tool_calls')
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        // 正常回复：思考 + 正文
        for (const part of script.reasoning ?? []) delta({ reasoning_content: part })
        for (const part of script.content ?? []) delta({ content: part })
        done()
      })()
    })
  })
  server.listen(port, '127.0.0.1')
  return { calls: () => calls, close: () => server.close() }
}

/**
 * 跑一个场景：全新 HOME、全新进程。
 * @param {{ id: string, fake?: { script?: any, tool?: any }, index?: number }} options
 * @param {(ctx: any) => Promise<void>} body
 */
export async function withApp(options, body) {
  const { id, fake = {}, index = 0 } = options
  const apiPort = BASE_API_PORT + index
  const debugPort = BASE_DEBUG_PORT + index
  // HOME 放系统临时目录（C 盘）而不是仓库里：探针里 DSC_HOME 就落在 HOME 下，而
  // 受限令牌后端要给可写根打完整性标签；这台机器的 D 盘目录不让设标签
  // （`icacls /setintegritylevel` 直接 Access is denied），落在仓库里会让每个
  // 沙箱用例都「打 ACL 失败」——那是探针位置的问题，不是产品的问题。
  // 真实用户的 %USERPROFILE% 也在 C 盘，放这里才跟线上同一条路。
  const home = join(tmpdir(), 'dsc-shots', '_pkg-' + id + '-home')
  const dsc = join(home, '.dsc')
  const out = join(SHOTS, 'out')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(join(dsc, 'sessions'), { recursive: true })
  mkdirSync(join(dsc, 'usage'), { recursive: true })
  mkdirSync(join(home, 'work'), { recursive: true })
  mkdirSync(out, { recursive: true })
  // 少数场景要先摆好沙箱临时根：全新 HOME 第一次调用 bash 时它不存在，见 2026-11-17 的验收记录。
  if (options.preCreate !== undefined) {
    for (const rel of options.preCreate) mkdirSync(join(dsc, rel), { recursive: true })
  }
  writeFileSync(join(dsc, 'config.yaml'), [
    'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
    '    displayName: 自检假端点',
    '    baseURL: http://127.0.0.1:' + String(apiPort) + '/v1',
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:', '      - id: fake-code', '        name: Fake Code',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'))

  const llm = startFakeLlm({ port: apiPort, script: fake.script ?? { content: ['好的。'] }, tool: fake.tool })
  const env = {
    ...process.env,
    DSC_HOME: dsc,
    USERPROFILE: home,
    HOME: home,
    DSC_FAKE_KEY: 'sk-selfcheck-fake',
    DSC_DESKTOP_USER_DATA: join(home, 'electron-userdata'),
  }
  delete env.ELECTRON_RUN_AS_NODE

  const app = spawn(EXE, ['--remote-debugging-port=' + String(debugPort), '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], {
    // 进程 cwd 仍是打包目录（工作区怎么定由应用自己算，别在这儿猜）。要换工作区请改这里，
    // 并且记住：受限令牌后端要给工作区打完整性标签，这台机器的 D 盘新建目录不让设标签。
    cwd: join(ROOT, 'desktop/dist/win-unpacked'),
    env,
    stdio: 'ignore',
  })

  let ws = null
  for (let i = 0; i < 100 && ws === null; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + String(debugPort) + '/json/list')).json()
      const page = (list ?? []).find((p) => p.type === 'page' && String(p.url).startsWith('http'))
      if (page !== undefined) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true })
          ws.addEventListener('error', reject, { once: true })
        })
      }
    } catch {}
    if (ws === null) await sleep(600)
  }
  if (ws === null) {
    try { app.kill() } catch {}
    llm.close()
    throw new Error('连不上 ' + id + '：CDP 没起来')
  }

  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(String(event.data))
      const waiter = pending.get(msg.id)
      if (waiter === undefined) return
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
    } catch {}
  })
  const send = (method, params) => {
    seq += 1
    const promise = new Promise((resolve, reject) => {
      pending.set(seq, { resolve, reject })
      ws.send(JSON.stringify({ id: seq, method, params }))
    })
    promise.catch(() => {})
    return promise
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1423, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: '(async () => { ' + expression + ' })()',
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
    return result.result?.value
  }

  const ctx = {
    id,
    home,
    dsc,
    evaluate,
    send,
    calls: llm.calls,
    body: () => evaluate('return document.body.innerText'),
    shot: async (file) => {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const path = join(out, file)
      writeFileSync(path, Buffer.from(shot.data, 'base64'))
      return path
    },
    waitScene: async (selector, timeoutMs = 20000) => evaluate(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      for (let i = 0; i < ${Math.ceil(timeoutMs / 200)}; i += 1) {
        if (document.querySelector(${JSON.stringify(selector)}) !== null) return true
        await wait(200)
      }
      return false
    `),
    type: async (text, { enter = true } = {}) => {
      await evaluate(`
        const el = document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]')
        if (el === null) return false
        el.focus()
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
          setter.call(el, ${JSON.stringify(text)})
          el.dispatchEvent(new Event('input', { bubbles: true }))
        } else {
          el.textContent = ${JSON.stringify(text)}
          el.dispatchEvent(new InputEvent('input', { bubbles: true }))
        }
        return true
      `)
      if (!enter) return
      const base = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r' }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      await send('Input.dispatchKeyEvent', { type: 'char', ...base })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    },
    waitText: async (needle, timeoutMs = 25000) => evaluate(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      for (let i = 0; i < ${Math.ceil(timeoutMs / 250)}; i += 1) {
        if (document.body.innerText.includes(${JSON.stringify(needle)})) return true
        await wait(250)
      }
      return false
    `),
    clickText: (label) => evaluate(`
      const hit = [...document.querySelectorAll('button, a, [role="button"], li')]
        .find((n) => (n.textContent ?? '').trim() === ${JSON.stringify(label)})
      if (hit === undefined) return false
      hit.click()
      return true
    `),
  }

  try {
    await ctx.waitScene('.welcome')
    await sleep(500)
    await body(ctx)
  } finally {
    try { app.kill() } catch {}
    try { llm.close() } catch {}
    await sleep(900)
  }
}
