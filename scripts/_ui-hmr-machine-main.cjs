/**
 * 真机热更走查的浏览器侧驱动（Electron 主进程；由 `scripts/ui-hmr-machine.mjs` 拉起）。
 *
 * 为什么要有这么一个「自己写的浏览器」：仓库里没有 playwright/puppeteer，而热更的壳侧行为
 * 只能在真 Chromium 里看——它要的是 React 真的重挂、`<script src>` 真的重取、SSE 真的推帧。
 * Electron 是仓库里现成的真浏览器（桌面端就是它），于是借它跑一个**不显示**的窗口：
 * 只做三件事——加载宿主伺服的那份页面、按命令读页内读数、按命令退出。
 *
 * 通道为什么是**回环 TCP** 而不是 stdin：Windows 上 Electron 主进程读不到父进程给的
 * stdin 管道（实测：stdout 的 ready 到得了，stdin 的行永远不来）。所以命令走一条本机
 * TCP 连接——驱动自己起服务、绑 0 号端口，把实际端口随 ready 打在 stdout 上。
 *
 * 协议（一行一条 JSON；stdout 只发 ready 这类单向下行，命令与回复都走 TCP）：
 *   {"id":1,"cmd":"describe"}                         → 账本 + DOM 探针读数
 *   {"id":2,"cmd":"graph"}                            → 页内 fetch('/api/boot')（宿主当下那一份图）
 *   {"id":3,"cmd":"mark","value":"..."}               → 在页里放一枚哨兵（刷新就丢，用来证明没刷新）
 *   {"id":4,"cmd":"wait-boot","timeoutMs":30000}      → 等到所有批落定、所有插件停止 pending/loading
 *   {"id":5,"cmd":"wait-change","plugin":"statusbar","from":"abc","timeoutMs":25000}
 *                                                     → 等到该插件"已装上且 rev 不再是 from"
 *   {"id":6,"cmd":"shot","file":"..."}                → 抓一张窗口图（证据，不做断言）
 *   {"id":7,"cmd":"quit"}
 * 回复：{"type":"result","id":N,"ok":true,"value":...} / {"ok":false,"error":"..."}；
 * 页面里的 console 消息作为 {"type":"console",...} 单独一行（CSP 报错就在那儿现形）。
 *
 * 用法：electron scripts/_ui-hmr-machine-main.cjs <带令牌的入口地址>
 *   DSC_UI_HMR_USER_DATA=<目录> 指定 Electron 的 userData（默认临时目录，互不打扰）
 *
 * @module dsc/scripts/_ui-hmr-machine-main
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:net')
const { resolve: resolvePath } = require('node:path')

const entryUrl = process.argv[2]
if (typeof entryUrl !== 'string' || entryUrl === '') {
  process.stderr.write('[hmr-machine] 缺少入口地址\n')
  app.exit(2)
}

// 隐藏窗口 + 关硬件加速：自检机器上少一组变量（GPU 合成不成时 capturePage 会挂）。
app.disableHardwareAcceleration()
if (typeof process.env['DSC_UI_HMR_USER_DATA'] === 'string' && process.env['DSC_UI_HMR_USER_DATA'] !== '') {
  // userData 必须是临时的：默认那份与用户自己的 Electron 应用共享，并行跑会互相踩。
  app.setPath('userData', process.env['DSC_UI_HMR_USER_DATA'])
}

/** 单向的下行（stdout）：ready / 日志。命令与回复走 TCP。 */
const note = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** 页内读数：启动账本 + DOM 上的探针属性（一次 executeJavaScript 全拿回来）。 */
const DESCRIBE = `(() => {
  const state = globalThis.__DSC_UI_BOOT_STATE__ ?? null
  const plugins = {}
  if (state !== null) {
    for (const [id, row] of Object.entries(state.plugins)) {
      plugins[id] = {
        state: row.state,
        rev: row.rev,
        phase: row.phase,
        attempts: row.attempts,
        error: row.error ?? null,
      }
    }
  }
  const attr = (selector, name) => {
    const el = document.querySelector(selector)
    return el === null ? null : el.getAttribute(name)
  }
  return {
    url: location.href,
    boot: state === null ? null : {
      rev: state.rev,
      startedAt: state.startedAt,
      firstFrameAt: state.firstFrameAt,
      host: state.host,
      batches: state.batches.map((b) => ({
        phase: b.phase,
        state: b.state,
        entries: b.entries.length,
        doneAt: b.doneAt ?? null,
      })),
      plugins,
      requests: state.requests.map((r) => ({ kind: r.kind, id: r.id, ok: r.ok, at: r.at })),
    },
    timeOrigin: globalThis.performance ? globalThis.performance.timeOrigin : null,
    sentinel: Object.prototype.hasOwnProperty.call(globalThis, '__hmrSentinel') ? globalThis.__hmrSentinel : null,
    probe: document.documentElement.getAttribute('data-hmr-probe'),
    syncFailures: [...document.querySelectorAll('[data-sync-failure]')].map((el) => el.getAttribute('data-sync-failure')),
    // 失败原因整句带回来（诊断区那几行 li 的文本就是「失败：…」）：红的时候不用再猜。
    failedRows: [...document.querySelectorAll('li[data-plugin]')].filter((el) => !el.classList.contains('ok')).map((el) => el.textContent),
    syncFailureText: [...document.querySelectorAll('[data-sync-failure]')].map((el) => el.textContent),
    faults: [...document.querySelectorAll('[data-fault]')].map((el) => el.getAttribute('data-fault')),
    batches: [...document.querySelectorAll('[data-batch]')].map((el) => ({
      phase: el.getAttribute('data-batch'),
      state: el.getAttribute('data-batch-state'),
      loaded: el.getAttribute('data-batch-loaded'),
      rev: el.getAttribute('data-batch-rev'),
    })),
    services: attr('[data-services]', 'data-services'),
    channel: attr('[data-channel]', 'data-channel'),
    native: attr('[data-native]', 'data-native'),
    diagnostics: document.querySelector('details.diagnostics') !== null,
    pluginRows: [...document.querySelectorAll('[data-plugin]')].map((el) => el.getAttribute('data-plugin')),
    rootChildren: document.getElementById('root') === null ? 0 : document.getElementById('root').childElementCount,
    // 以下几条只在页面没起来时有用（空壳/没凭据/脚本没执行都靠它们区分）。
    title: document.title,
    readyState: document.readyState,
    hasRoot: document.getElementById('root') !== null,
    scripts: [...document.scripts].map((el) => el.getAttribute('src') ?? 'inline').slice(0, 8),
    bodyText: (document.body === null ? '' : document.body.innerText).slice(0, 200),
  }
})()`

/** 页内 fetch 一份宿主当下的启动图（HMR 换代之后「宿主那边这一行现在是什么 rev」的读面）。 */
const READ_GRAPH = `fetch('/api/boot', { headers: { accept: 'application/json' } })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status)))
  .then((graph) => ({
    rev: graph.rev,
    revs: Object.fromEntries(graph.entries.map((entry) => [entry.id, entry.rev])),
    entries: graph.entries.map((entry) => entry.id),
    batches: (graph.batches ?? []).map((batch) => ({ phase: batch.phase, entries: batch.entries.length })),
  }))`

/** 等所有批落定、所有插件不再 pending/loading。 */
const waitBoot = (timeoutMs) => `(async () => {
  const startedAt = Date.now()
  for (;;) {
    const state = globalThis.__DSC_UI_BOOT_STATE__ ?? null
    if (state !== null) {
      const rows = Object.values(state.plugins)
      const settled = rows.every((row) => row.state === 'loaded' || row.state === 'failed' || row.state === 'removed')
        && state.batches.every((b) => b.state === 'done' || b.state === 'failed')
      if (settled) {
        const failed = Object.entries(state.plugins).filter(([, row]) => row.state !== 'loaded').map(([id]) => id)
        return { ok: failed.length === 0, waitedMs: Date.now() - startedAt, loaded: rows.length - failed.length, failed }
      }
    }
    if (Date.now() - startedAt > ${timeoutMs}) {
      return {
        ok: false,
        waitedMs: Date.now() - startedAt,
        error: '等启动落定超时',
        state: state === null ? null : Object.fromEntries(Object.entries(state.plugins).map(([id, row]) => [id, row.state])),
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
})()`

/** 等一条插件的换代：已装上 + rev 不再是 from。 */
const waitChange = (plugin, from, timeoutMs) => `(async () => {
  const startedAt = Date.now()
  for (;;) {
    const state = globalThis.__DSC_UI_BOOT_STATE__ ?? null
    const row = state === null ? undefined : state.plugins[${JSON.stringify(plugin)}]
    if (row !== undefined && row.state === 'loaded' && row.rev !== ${JSON.stringify(from)}) {
      return { ok: true, waitedMs: Date.now() - startedAt, rev: row.rev, state: row.state }
    }
    if (Date.now() - startedAt > ${timeoutMs}) {
      return {
        ok: false,
        waitedMs: Date.now() - startedAt,
        rev: row === undefined ? null : row.rev,
        state: row === undefined ? null : row.state,
        error: row === undefined ? null : (row.error ?? null),
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
})()`

let win = null
let quitting = false
/** 命令通道（回环 TCP）：连上来的那条连接。 */
let commandSocket = null
/** 连接建立之前攒下的页面 console 消息，连上即冲出去。 */
const consoleBacklog = []

/** 一行 JSON 写进命令通道（没连上就攒在 backlog 里，只对 console 有意义）。 */
const down = (message) => {
  const line = `${JSON.stringify(message)}\n`
  if (commandSocket === null) {
    if (message.type === 'console') {
      consoleBacklog.push(message)
      if (consoleBacklog.length > 200) consoleBacklog.shift()
    } else {
      note(message)
    }
    return
  }
  commandSocket.write(line)
}

/** 逐条处理命令；每条回一行结果（id 对得上）。 */
async function handle(command) {
  const id = command.id
  const reply = (value) => {
    down({ type: 'result', id, ok: true, value })
  }
  try {
    if (win === null || win.isDestroyed()) throw new Error('窗口不在了')
    if (command.cmd === 'describe') {
      reply(await win.webContents.executeJavaScript(DESCRIBE))
      return
    }
    if (command.cmd === 'graph') {
      reply(await win.webContents.executeJavaScript(READ_GRAPH))
      return
    }
    if (command.cmd === 'mark') {
      await win.webContents.executeJavaScript(`globalThis.__hmrSentinel = ${JSON.stringify(command.value)}; true`)
      reply(true)
      return
    }
    if (command.cmd === 'wait-boot') {
      reply(await win.webContents.executeJavaScript(waitBoot(Number(command.timeoutMs ?? 30000))))
      return
    }
    if (command.cmd === 'wait-change') {
      reply(await win.webContents.executeJavaScript(waitChange(String(command.plugin), String(command.from ?? ''), Number(command.timeoutMs ?? 25000))))
      return
    }
    if (command.cmd === 'shot') {
      const image = await win.webContents.capturePage()
      mkdirSync(resolvePath(command.file, '..'), { recursive: true })
      writeFileSync(command.file, image.toPNG())
      reply({ file: command.file, empty: image.isEmpty() })
      return
    }
    if (command.cmd === 'quit') {
      reply(true)
      quitting = true
      setTimeout(() => {
        app.exit(0)
      }, 50)
      return
    }
    throw new Error(`不认识的命令：${String(command.cmd)}`)
  } catch (error) {
    down({ type: 'result', id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** 起命令服务（绑 0 号端口，实际端口随 ready 打出去）。 */
function startCommandServer() {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((socket) => {
      commandSocket = socket
      socket.setEncoding('utf8')
      for (const message of consoleBacklog) socket.write(`${JSON.stringify(message)}\n`)
      consoleBacklog.length = 0
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk
        for (;;) {
          const index = buffer.indexOf('\n')
          if (index < 0) break
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line === '') continue
          let command
          try {
            command = JSON.parse(line)
          } catch {
            down({ type: 'bad-command', line })
            continue
          }
          void handle(command)
        }
      })
      socket.on('close', () => {
        if (commandSocket === socket) commandSocket = null
      })
      socket.on('error', () => {
        // 对端断开：走查侧的事，不必在这里处理
      })
    })
    server.once('error', rejectServer)
    server.listen(0, '127.0.0.1', () => {
      resolveServer(server)
    })
  })
}

async function main() {
  win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      // 隐藏窗口默认会被节流：rIC 与 SSE 都可能被压住，热更就走不动了。
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.webContents.on('console-message', (...args) => {
    // 新老签名都接：新的是 (event{level,message})，老的是 (event, level, message, ...)。
    const first = args[0]
    const modern = first !== null && typeof first === 'object' && 'message' in first
    const message = modern ? first.message : args[2]
    const level = modern ? first.level : args[1]
    if (typeof message === 'string' && message !== '') down({ type: 'console', level: String(level ?? ''), message })
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    down({ type: 'gone', reason: details.reason, exitCode: details.exitCode })
  })
  win.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    down({ type: 'fail-load', code, description, url: validatedUrl })
  })

  // 先走一次带令牌的入口（换 Cookie，服务端 303 到 /），再按 ?diag=1 重开：
  // 诊断区只在带 diag 的那一份页面里渲染，而它的 DOM 属性就是本走查的读面之一。
  const origin = new URL(entryUrl).origin
  await win.loadURL(entryUrl)
  await win.loadURL(`${origin}/?diag=1`)

  const server = await startCommandServer()
  const address = server.address()
  note({ type: 'ready', url: win.webContents.getURL(), port: typeof address === 'object' && address !== null ? address.port : 0 })
}

app.on('window-all-closed', () => {
  if (!quitting) app.exit(0)
})

// BrowserWindow 必须在 app ready 之后建（早建会抛 "Cannot create BrowserWindow before app is ready"）。
app
  .whenReady()
  .then(() => main())
  .catch((error) => {
    process.stderr.write(`[hmr-machine] 驱动启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    app.exit(1)
  })
