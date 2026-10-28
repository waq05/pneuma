/**
 * cordis 装配探针的浏览器侧（Electron 主进程，隐藏窗口）。
 *
 * 只做一件事：把「插件装配换到 cordis」这件事在真 Chromium 里量一遍——
 *   1. 首帧落定后读启动账本：statusbar 那条是不是 via='cordis'、fiber 是不是 2（生效）；
 *   2. 数状态栏那段在 DOM 里画了几份（多于一份 = 卸载没干净，两条纤维同时占着槽）；
 *   3. 往 statusbar 的产物 bundle 尾巴上追加一枚标记（不改源码，产物是构建物），
 *      等宿主换代 → 壳换装，再数一遍：标记出现（新代码真跑了）、段数仍是 1。
 *
 * 为什么改产物而不是源码：这条探针要能在工作区有别人在途改动时跑（源码是别人的），
 * 而产物（lib/ui/plugins/*）是构建物、跑完写回原字节。
 *
 * 用法：electron scripts/_ui-cordis-main.cjs <带令牌的入口地址>
 *   目标产物、截图路径、读数文件走环境变量（DSC_CORDIS_BUNDLE / _SHOT / _RESULT_FILE）——
 *   electron.exe 的命令行只能带入口地址一个位置参数，多带一个就退出 127。
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')
const { randomBytes } = require('node:crypto')

const entryUrl = process.argv[2]
// 目标产物与截图路径走环境变量：Electron 的 argv 只留入口地址（多带位置参数会让它
// 直接退出，退出码 127，实测过）。
const bundlePath = String(process.env['DSC_CORDIS_BUNDLE'] || '')
const shotPath = String(process.env['DSC_CORDIS_SHOT'] || '')
if (typeof entryUrl !== 'string' || entryUrl === '') {
  process.stderr.write('[cordis-probe] 缺少入口地址\n')
  app.exit(2)
}

/** 兜底：主进程里任何一处抛错都落到读数文件，别让「退出码 -1 + 无声」这种形状出现。 */
const crashFile = String(process.env['DSC_CORDIS_RESULT_FILE'] || '')
/** 阶段打点（排查「没有任何输出」这类形状：写到 <读数文件>.stage）。 */
const stage = (name) => {
  if (crashFile === '') return
  try {
    mkdirSync(dirname(crashFile), { recursive: true })
    writeFileSync(crashFile + '.stage', name + ' @' + String(Date.now()) + '\n', 'utf8')
  } catch {}
}
stage('module-loaded')
const writeCrash = (stage, error) => {
  if (crashFile === '') return
  try {
    mkdirSync(dirname(crashFile), { recursive: true })
    writeFileSync(crashFile, JSON.stringify({ error: String(error), stage }, null, 2), 'utf8')
  } catch {}
}
process.on('uncaughtException', (error) => {
  writeCrash('uncaught', error && error.stack ? error.stack : error)
  app.exit(3)
})
process.on('unhandledRejection', (error) => {
  writeCrash('unhandledRejection', error && error.stack ? error.stack : error)
  app.exit(3)
})

try {
  app.disableHardwareAcceleration()
  if (typeof process.env['DSC_CORDIS_USER_DATA'] === 'string' && process.env['DSC_CORDIS_USER_DATA'] !== '') {
    app.setPath('userData', process.env['DSC_CORDIS_USER_DATA'])
  }
} catch (error) {
  writeCrash('setup', error && error.stack ? error.stack : error)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PROBE = `(() => {
  const state = globalThis.__DSC_UI_BOOT_STATE__ ?? null
  const rows = {}
  for (const [id, row] of Object.entries((state && state.plugins) || {})) {
    rows[id] = { state: row.state, via: row.via ?? null, fiber: row.fiber ?? null, error: row.error ?? null, rev: row.rev }
  }
  const bar = document.querySelector('[data-slot="shell.statusbar"]')
  const attrOf = (sel) => (document.querySelector(sel) === null ? null : document.querySelector(sel).getAttribute('data-services'))
  return {
    settled: Object.values(rows).every((r) => r.state === 'loaded' || r.state === 'failed' || r.state === 'removed'),
    rows,
    batches: ((state && state.batches) || []).map((b) => ({ phase: b.phase, state: b.state })),
    statusbarEntries: document.querySelectorAll('.slot-entry[data-slot="shell.statusbar"]').length,
    statusbarText: bar === null ? null : String(bar.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    faults: [...document.querySelectorAll('[data-fault]')].map((el) => el.getAttribute('data-fault')),
    syncFailures: [...document.querySelectorAll('[data-sync-failure]')].map((el) => el.textContent),
    services: attrOf('[data-services]'),
    channel: attrOf('[data-channel]'),
    hmrMark: document.documentElement.dataset['cordisHmr'] ?? null,
    diagnostics: document.querySelector('details.diagnostics') !== null,
    bodyText: String(document.body ? document.body.innerText : '').slice(0, 600),
    bootErrorText: [...document.querySelectorAll('*')].filter((el) => /取启动清单|失败|错误/.test(el.textContent || '') && el.children.length === 0).map((el) => (el.textContent || '').slice(0, 200)).slice(0, 6),
    cookie: String(document.cookie || ''),
    // 诊断区每行的装配路径读数（data-plugin-via）：只有 ?diag=1 时那几行才渲染，
    // 所以这里恒返回空数组，除非探针带 diag 参数跑（DSC_CORDIS_DIAG=1）。
    viaAttrs: [...document.querySelectorAll('[data-plugin-via]')].map((el) => el.getAttribute('data-plugin-via')),
    fiberAttrs: [...document.querySelectorAll('[data-plugin-fiber]')].map((el) => el.getAttribute('data-plugin-fiber')),
    diagText: document.querySelector('details.diagnostics') === null ? null : String(document.querySelector('details.diagnostics').textContent).replace(/\s+/g, ' ').trim().slice(0, 1500),
    entryCount: document.querySelectorAll('[data-entry]').length,
    // 组合包示例（examples/plugin-two-halves）的界面半会带这个标记：不在内置清单里，
    // 用它的个数证明「一个包两半」那条通路真的把界面画出来了（见 ui-two-halves-e2e.mjs）。
    twoHalves: document.querySelectorAll('[data-two-halves]').length,
  }
})()`

async function waitSettled(win, timeoutMs) {
  const startedAt = Date.now()
  for (;;) {
    const probe = await win.webContents.executeJavaScript(PROBE)
    if (probe.settled) return probe
    if (Date.now() - startedAt > timeoutMs) return probe
    await sleep(200)
  }
}

async function waitMark(win, timeoutMs) {
  const startedAt = Date.now()
  for (;;) {
    const probe = await win.webContents.executeJavaScript(PROBE)
    if (probe.hmrMark !== null && probe.rows['statusbar'] && probe.rows['statusbar'].state === 'loaded') return probe
    if (Date.now() - startedAt > timeoutMs) return probe
    await sleep(200)
  }
}

stage('whenReady-pending')
app.whenReady().then(async () => {
  stage('whenReady')
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } })
  const result = { steps: [], console: [] }
  try {
    win.webContents.on('console-message', (...args) => {
      const first = args[0]
      if (first && typeof first === 'object' && 'message' in first) {
        if (first.level === 'error' || first.level === 'warning') {
          result.console.push({ level: first.level, message: String(first.message).slice(0, 300) })
        }
        return
      }
      if (args[1] === 3 || args[1] === 2) result.console.push({ level: args[1], message: String(args[2]).slice(0, 300) })
    })
    stage('loadURL')
    await win.loadURL(entryUrl)
    // 令牌换 Cookie 的那一跳是 303 到 `/`，查询参数会被丢掉——所以要开诊断区得**再跳一次**，
    // 这次靠已经种下的 Cookie（自检脚本也是这个两步走法）。
    if (String(process.env['DSC_CORDIS_DIAG'] || '') === '1') {
      const origin = new URL(entryUrl).origin
      await win.loadURL(origin + '/?diag=1')
      stage('diag-loaded')
    }
    stage('loaded')
    const base = await waitSettled(win, 40000)
    // 页内网络自检：/api/boot 与一条 bundle 请求各打一次，看宿主到底答不答。
    base.net = await win.webContents.executeJavaScript(`(async () => {
      const out = {}
      for (const url of ['/api/boot', '/plugins/??rev=1']) {
        const startedAt = Date.now()
        try {
          const response = await fetch(url, { headers: { accept: '*/*' } })
          out[url] = { status: response.status, ms: Date.now() - startedAt }
        } catch (error) {
          out[url] = { error: String(error), ms: Date.now() - startedAt }
        }
      }
      return out
    })()`)
    stage('settled')
    result.steps.push({ label: '首帧落定', probe: base })

    if (typeof bundlePath === 'string' && bundlePath !== '') {
      const nonce = randomBytes(4).toString('hex')
      const original = readFileSync(bundlePath)
      const marker = Buffer.from('\n;document.documentElement.dataset[\'cordisHmr\']=' + JSON.stringify(nonce) + ';\n', 'utf8')
      writeFileSync(bundlePath, Buffer.concat([original, marker]))
      try {
        const swapped = await waitMark(win, 40000)
        result.steps.push({ label: '换装（cordis 卸旧装新）', probe: swapped, nonce })
      } finally {
        writeFileSync(bundlePath, original)
      }
      await sleep(2500)
      const finalProbe = await waitSettled(win, 30000)
      result.steps.push({ label: '还原轮', probe: finalProbe })
    }

    if (typeof shotPath === 'string' && shotPath !== '') {
      const image = await win.capturePage()
      mkdirSync(dirname(shotPath), { recursive: true })
      writeFileSync(shotPath, image.toPNG())
      result.shot = shotPath
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  // 读数同时落文件：Windows 上 Electron 主进程的 stdout 在管道里不可靠（实测达到率 0），
  // 文件是唯一稳的通道；stdout 那一行留给交互式手动跑。
  const resultPath = String(process.env['DSC_CORDIS_RESULT_FILE'] || '')
  if (resultPath !== '') {
    try {
      mkdirSync(dirname(resultPath), { recursive: true })
      writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8')
    } catch (error) {
      process.stderr.write('[cordis-probe] 写读数失败：' + String(error) + '\n')
    }
  }
  process.stdout.write('PROBE_RESULT ' + JSON.stringify(result) + '\n')
  app.exit(0)
})
