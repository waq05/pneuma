/**
 * 真机探针的共用小工具（零外部依赖 / ESM / 直接接 `ws`+CDP+`Runtime.evaluate` 的写法）。
 *
 * 为什么要有它：`desktop/shots/` 里那批 `_verify-*` 各写一遍「起假端点 → 起 Electron →
 * 连 CDP → 等页面 → 打印 → exit(0)」。前面几步抄来抄去还好，最后一步抄坏了就成了空转：
 * 页面没打开、历史没加载、采样全是 0，探针照样打印一大堆再 `exit(0)`，谁也不知道它没测。
 * 所以这里只收三样东西：
 *
 *   1. **断言账本**：`assert` 累加、「不中断」，`finish` 按失败数决定退出码；
 *   2. **等场景**：`requireScene` 等页面真的到「能测的状态」，等不到就记一条失败并让调用方
 *      早点收尾——治的就是「会话没打开却 exit 0」；
 *   3. **样板**：隔离 HOME、假端点、起桌面、连 CDP、截图，写成可传参的小函数，别再各抄一份。
 *
 * 它不是框架：没有注册表、没有钩子、没有配置文件。探针该自己写的判据，一条都不能少。
 *
 * @module desktop/shots/_probe-kit
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 等一会儿。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ────────────────────────── 断言账本 ────────────────────────── */

const ledger = { passed: 0, failed: 0, results: [] }

/**
 * 记一条断言。失败时当场打印（带 detail），但**不中断**——整条探针跑完再统一报账，
 * 这样一次运行能看到所有坏点，而不是只看到第一个。
 *
 * @param {string} name 判据的人话描述（写成「应当是什么」，不要写「检查 X」）
 * @param {boolean} condition 判据成立吗
 * @param {string} [detail] 失败时附上的实测值
 * @returns {boolean} condition
 */
export function assert(name, condition, detail = '') {
  const ok = condition === true
  ledger.results.push({ name, ok, detail })
  if (ok) {
    ledger.passed += 1
    process.stdout.write(`  ok   ${name}${detail === '' ? '' : `（${detail}）`}\n`)
  } else {
    ledger.failed += 1
    process.stdout.write(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}\n`)
  }
  return ok
}

/** 当前账本（只读快照）。 */
export function counts() {
  return { passed: ledger.passed, failed: ledger.failed, total: ledger.passed + ledger.failed }
}

/**
 * 结账：打印 `通过 N / 失败 M`，失败数不为 0 就退 1。
 * @param {string} title 探针名（例如 `_verify-stream-caret`）
 */
export function finish(title) {
  const { passed, failed, total } = counts()
  process.stdout.write(`\n[${title}] 通过 ${String(passed)} / 失败 ${String(failed)}（共 ${String(total)} 条断言）\n`)
  if (failed > 0) {
    process.stdout.write(`[${title}] 失败明细：\n`)
    for (const item of ledger.results) {
      if (item.ok) continue
      process.stdout.write(`  - ${item.name}${item.detail === '' ? '' : `：${item.detail}`}\n`)
    }
  }
  process.exit(failed === 0 ? 0 : 1)
}

/* ────────────────────────── 等页面到位 ────────────────────────── */

/**
 * 在页面里反复求值 `script`，直到它返回 `{ ok: true }`（或布尔 true）为止。
 *
 * `script` 里可以直接 `await`（外面套了 async IIFE），返回值会 `returnByValue` 带回来。
 * 超时不抛错：返回 `{ ok: false, elapsedMs, last }`，由调用方决定怎么记账。
 *
 * @param {(expression: string) => Promise<any>} evaluate CDP 求值器
 * @param {string} script 页面脚本，返回 `{ ok: boolean, ...事实 }`
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, elapsedMs: number, last: any }>}
 */
export async function pollPage(evaluate, script, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20000
  const intervalMs = opts.intervalMs ?? 250
  const started = Date.now()
  let last = null
  for (;;) {
    let result = null
    try {
      result = await evaluate(script)
    } catch (error) {
      last = { error: String(error) }
      result = null
    }
    if (result !== null && result !== undefined) {
      last = result
      if (result === true || result.ok === true) return { ok: true, elapsedMs: Date.now() - started, last }
    }
    if (Date.now() - started > timeoutMs) return { ok: false, elapsedMs: Date.now() - started, last }
    await sleep(intervalMs)
  }
}

/**
 * 等场景：等到页面真的到了「能测的状态」。等不到就**记一条失败**并返回 `ok: false`，
 * 让调用方立刻 `finish()`——绝不静默继续（那是 `_verify-*` 假绿的根源）。
 *
 * @param {(expression: string) => Promise<any>} evaluate
 * @param {{ name: string, script: string, timeoutMs?: number, intervalMs?: number, detail?: string }} opts
 *   `name` 是「等到了什么」的人话描述；`script` 返回 `{ ok, ...事实 }`，事实会进失败明细。
 * @returns {Promise<{ ok: boolean, facts: any }>}
 */
export async function requireScene(evaluate, opts) {
  const result = await pollPage(evaluate, opts.script, opts)
  if (result.ok) {
    process.stdout.write(`  ok   场景到位：${opts.name}（${String(result.elapsedMs)}ms）\n`)
    ledger.results.push({ name: `场景：${opts.name}`, ok: true, detail: '' })
    ledger.passed += 1
    return { ok: true, facts: result.last }
  }
  const detail = (opts.detail === undefined ? '' : opts.detail)
    + `等 ${String(Math.round((opts.timeoutMs ?? 20000) / 1000))}s 没等到；最后读到 ${JSON.stringify(result.last)?.slice(0, 400) ?? 'null'}`
  assert(`场景：${opts.name}`, false, detail)
  return { ok: false, facts: result.last }
}

/* ────────────────────────── 假端点 ────────────────────────── */

/**
 * 起一个假模型端点（`desktop/shots/*-fake-llm.mjs`），等端口能连上。
 *
 * @param {{ shots: string, file: string, port: number, env?: Record<string, string>, args?: string[] }} opts
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, stop: () => void }>}
 */
export async function startFakeLlm(opts) {
  const args = [join(opts.shots, opts.file), String(opts.port), ...(opts.args ?? [])]
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: 'ignore',
  })
  const ready = await waitForPort(opts.port, 8000)
  if (!ready) process.stdout.write(`[probe-kit] 假端点 ${opts.file} 没起来（端口 ${String(opts.port)}）\n`)
  return {
    child,
    stop() { try { child.kill() } catch {} },
  }
}

/**
 * 等某个本机端口能接受连接（用来确认假端点真的起来了，而不是盲等 800ms）。
 * @param {number} port
 * @param {number} [timeoutMs]
 */
export async function waitForPort(port, timeoutMs = 8000) {
  const started = Date.now()
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`)
      // 任何响应都说明端口有人接了；404 也算
      if (response.status >= 0) return true
    } catch {}
    if (Date.now() - started > timeoutMs) return false
    await sleep(150)
  }
}

/* ────────────────────────── 隔离 HOME ────────────────────────── */

/**
 * 建一套隔离 HOME（`DSC_HOME` / `USERPROFILE` / Electron user-data 全在这里面）。
 * 全程不碰真实 `~/.dsc`。
 *
 * @param {{ shots: string, name: string, dirs?: string[], config?: string, settings?: object | string }} opts
 * @returns {{ home: string, dsc: string, userData: string, work: string, cleanup: () => void }}
 */
export function makeHome(opts) {
  const home = join(opts.shots, opts.name)
  const dsc = join(home, '.dsc')
  const userData = join(home, 'electron-userdata')
  const work = join(home, 'work')
  rmSync(home, { recursive: true, force: true })
  for (const rel of ['.dsc', 'electron-userdata', 'work', ...(opts.dirs ?? []).map((dir) => `.dsc/${dir}`)]) {
    mkdirSync(join(home, rel), { recursive: true })
  }
  // Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置：目录不存在会直接崩。
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
  if (opts.config !== undefined) writeFileSync(join(dsc, 'config.yaml'), opts.config)
  if (opts.settings !== undefined) {
    writeFileSync(join(dsc, 'settings.json'), typeof opts.settings === 'string' ? opts.settings : JSON.stringify(opts.settings))
  }
  return {
    home,
    dsc,
    userData,
    work,
    cleanup() { rmSync(home, { recursive: true, force: true }) },
  }
}

/* ────────────────────────── 启桌面 + 连 CDP ────────────────────────── */

/**
 * 起桌面产物（`desktop/out/main/index.js`）。`DSC_PROBE_EXE` 有值时改起打包好的 exe。
 *
 * @param {{ root: string, home: string, dsc: string, userData: string, debugPort: number,
 *           extraEnv?: Record<string, string>, exe?: string }} opts
 * @returns {{ child: import('node:child_process').ChildProcess, log: () => string, stop: () => void }}
 */
export function launchDesktop(opts) {
  const env = {
    ...process.env,
    DSC_HOME: opts.dsc,
    USERPROFILE: opts.home,
    HOME: opts.home,
    DSC_FAKE_KEY: 'sk-selfcheck-fake',
    DSC_DESKTOP_USER_DATA: opts.userData,
    ...(opts.extraEnv ?? {}),
  }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = opts.exe ?? process.env.DSC_PROBE_EXE
  // 窗口被挡在后面时 Chromium 会把定时器压到 1Hz、并停掉 rAF——探针于是「采样只有几十帧、
  // 跟随一次都没跑」，看起来像产品坏了。这三条开关把后台节流整个关掉。
  const throttling = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ]
  const child = exe === undefined || exe === ''
    ? spawn(join(opts.root, 'desktop/node_modules/electron/dist/electron.exe'), [
      join(opts.root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + String(opts.debugPort),
      ...throttling,
    ], { cwd: join(opts.root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(exe, ['--remote-debugging-port=' + String(opts.debugPort), ...throttling], {
      cwd: join(opts.root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'],
    })
  let log = ''
  child.stdout?.on('data', (chunk) => { log += String(chunk) })
  child.stderr?.on('data', (chunk) => { log += String(chunk) })
  return {
    child,
    log: () => log,
    stop() { try { child.kill() } catch {} },
  }
}

/**
 * 连上桌面窗口的 CDP（页面 target），返回求值 / 截图 / 关闭三件套。
 *
 * @param {{ port: number, log?: string | (() => string), timeoutMs?: number, page?: boolean }} opts
 * @returns {Promise<{ ws: WebSocket, send: Function, evaluate: Function, shot: Function, close: Function }>}
 */
export async function connectCdp(opts) {
  const log = typeof opts.log === 'function' ? opts.log : () => String(opts.log ?? '')
  const timeoutMs = opts.timeoutMs ?? 60000
  const started = Date.now()
  let candidate = null
  for (;;) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + String(opts.port) + '/json/list')).json()
      const pages = (list ?? []).filter((item) => item.type === 'page')
      candidate = pages.find((item) => String(item.url).startsWith('http')) ?? null
      if (candidate !== null) break
    } catch {}
    if (Date.now() - started > timeoutMs) break
    await sleep(500)
  }
  if (candidate === null) throw new Error('connect failed: ' + log().slice(-800))

  const ws = new WebSocket(candidate.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(String(event.data))
      const waiter = pending.get(message.id)
      if (waiter === undefined) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
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
  if (opts.page !== false) await send('Page.enable')
  // 让页面当自己在前台：窗口被挡住时 Chromium 会降频定时器、停 rAF，采样帧数会掉到个位。
  try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch {}

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: '(async () => { ' + expression + ' })()',
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800))
    return result.result?.value
  }
  const shot = async (path) => {
    const data = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(data.data, 'base64'))
  }
  return { ws, send, evaluate, shot, close() { try { ws.close() } catch {} } }
}

/**
 * 给探针收尾用：关假端点、关桌面、删临时 HOME。**不**退出进程（`finish` 才退出）。
 *
 * @param {Array<{ stop?: () => void, close?: () => void, cleanup?: () => void } | null | undefined>} handles
 */
export function teardown(handles) {
  for (const handle of handles) {
    if (handle === null || handle === undefined) continue
    try { handle.close?.() } catch {}
    try { handle.stop?.() } catch {}
    try { handle.cleanup?.() } catch {}
  }
}
