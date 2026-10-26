/**
 * 「手机尺寸下的远程壳」探针（Electron 主进程，隐藏窗口 → 截图前显示）。
 *
 * 为什么要这条：移动端一直是单测（`ui-mobile-shell-test.mjs` 128 条断言跑的是纯逻辑），
 * 真浏览器在 390×844 下会不会横向溢出、插件装不装得上、槽位有没有坏，只有真跑一次才知道。
 *
 * 判据只有四件：装了几条、失败几条、槽位有没有故障、页面有没有横向溢出。
 * 环境变量：DSC_MOBILE_RESULT / DSC_MOBILE_SHOT / DSC_MOBILE_W / DSC_MOBILE_H / DSC_MOBILE_USER_DATA
 * 用法：electron scripts/_ui-mobile-main.cjs <带令牌的入口地址>
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')

const entryUrl = process.argv[2]
const resultPath = String(process.env['DSC_MOBILE_RESULT'] || '')
const shotPath = String(process.env['DSC_MOBILE_SHOT'] || '')
const width = Number(process.env['DSC_MOBILE_W'] || 390)
const height = Number(process.env['DSC_MOBILE_H'] || 844)

if (typeof entryUrl !== 'string' || entryUrl === '') {
  process.stderr.write('[mobile-probe] 缺少入口地址\n')
  app.exit(2)
}

const fail = (stage, error) => {
  try {
    if (resultPath !== '') {
      mkdirSync(dirname(resultPath), { recursive: true })
      writeFileSync(resultPath, JSON.stringify({ error: String(error && error.stack ? error.stack : error), stage }, null, 2), 'utf8')
    }
  } catch {}
  app.exit(3)
}
process.on('uncaughtException', (error) => fail('uncaught', error))
process.on('unhandledRejection', (error) => fail('unhandledRejection', error))

app.disableHardwareAcceleration()
if ((process.env['DSC_MOBILE_USER_DATA'] || '') !== '') {
  app.setPath('userData', String(process.env['DSC_MOBILE_USER_DATA']))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const inPage = (win, body) => win.webContents.executeJavaScript('(async () => { ' + body + ' })()', true)

async function waitFor(win, body, timeoutMs, label) {
  const startedAt = Date.now()
  for (;;) {
    if (await inPage(win, 'return !!(' + body + ')')) return
    if (Date.now() - startedAt > timeoutMs) throw new Error('等不到 ' + label)
    await sleep(250)
  }
}

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: { backgroundThrottling: false },
  })
  await win.loadURL(entryUrl)
  await waitFor(win, "document.querySelector('.composer') !== null", 90000, '壳的输入框')
  await sleep(1500)

  const probe = await inPage(
    win,
    'const state = globalThis.__DSC_UI_BOOT_STATE__ ?? null;' +
      ' const rows = state ? Object.entries(state.plugins) : [];' +
      ' const overflow = document.documentElement.scrollWidth - window.innerWidth;' +
      ' return {' +
      '   width: window.innerWidth,' +
      '   height: window.innerHeight,' +
      '   plugins: rows.length,' +
      '   loaded: rows.filter(([, row]) => row.state === "loaded").length,' +
      '   failed: rows.filter(([, row]) => row.state === "failed").map(([id]) => id),' +
      '   faults: (state && state.faults) ? state.faults.length : 0,' +
      '   overflow: Math.max(0, overflow),' +
      '   composer: document.querySelector(".composer") !== null,' +
      '   sidebarCollapsed: document.querySelector(".sidebar") === null,' +
      ' };',
  )

  // 截图前显示窗口：Windows 上隐藏窗口 capturePage 是空白帧（实测）。
  win.show()
  await sleep(900)
  if (shotPath !== '') {
    mkdirSync(dirname(shotPath), { recursive: true })
    writeFileSync(shotPath, (await win.webContents.capturePage()).toPNG())
  }
  win.hide()

  if (resultPath !== '') {
    mkdirSync(dirname(resultPath), { recursive: true })
    writeFileSync(resultPath, JSON.stringify({ probe }, null, 2), 'utf8')
  }
  app.exit(0)
}

main().catch((error) => fail('main', error))
