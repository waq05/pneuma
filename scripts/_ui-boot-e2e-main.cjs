/**
 * 「界面壳停用渲染器/骨架时画的是诊断页」探针的浏览器侧（Electron 主进程，隐藏窗口）。
 *
 * 只做一件事：打开宿主给的界面地址，等页面「落定」（骨架的 .app 出现，或者诊断页出现），
 * 把这几个读数带回来并截一张图：
 *   - .app 在不在、可见尺寸是多少（白屏判定：既没有 .app 也没有诊断文案）；
 *   - 页面文字里有没有「界面渲染器」/「界面布局」这两块诊断页的标题；
 *   - 注入的启动图（window.__DSC_BOOT__）里 entries / disabled 各是哪些 id，
 *     证明「开关真的被宿主认了」，而不是页面自己猜的；
 *   - 启动占位（#boot-splash）退场了没有——它盖在页面上时截图会看不出诊断页。
 *
 * 与 _ui-dsh-card-main.cjs 同一套约束：命令行只带入口地址一个位置参数，
 * 其余全部走环境变量（多带一个位置参数 electron 直接退出 127）。
 *
 * 环境变量：
 *   DSC_BOOT_RESULT    读数 JSON 的落盘路径
 *   DSC_BOOT_SHOT      截图 PNG 的落盘路径
 *   DSC_BOOT_LABEL     场景名（只进 stderr 的日志，方便看出是哪一段卡住）
 *   DSC_BOOT_USER_DATA Electron 的 userData（隔离，不碰真身）
 *
 * 用法：electron scripts/_ui-boot-e2e-main.cjs <带令牌的入口地址>
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')

const entryUrl = process.argv[2]
const resultPath = String(process.env['DSC_BOOT_RESULT'] || '')
const shotPath = String(process.env['DSC_BOOT_SHOT'] || '')
const label = String(process.env['DSC_BOOT_LABEL'] || 'boot')

if (typeof entryUrl !== 'string' || entryUrl === '') {
  process.stderr.write('[ui-boot] 缺少入口地址\n')
  app.exit(2)
}

/** 任何一处抛错都落到读数文件，别让「退出码 -1 + 无声」这种形状出现。 */
const fail = (stage, error) => {
  const text = error && error.stack ? error.stack : String(error)
  try {
    if (resultPath !== '') {
      mkdirSync(dirname(resultPath), { recursive: true })
      writeFileSync(resultPath, JSON.stringify({ error: text, stage }, null, 2) + '\n', 'utf8')
    }
  } catch {}
  app.exit(3)
}
process.on('uncaughtException', (error) => fail('uncaught', error))
process.on('unhandledRejection', (error) => fail('unhandledRejection', error))

app.disableHardwareAcceleration()
if (typeof process.env['DSC_BOOT_USER_DATA'] === 'string' && process.env['DSC_BOOT_USER_DATA'] !== '') {
  app.setPath('userData', process.env['DSC_BOOT_USER_DATA'])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一次读数：页面里所有要断言的字段都由它取，避免「取了两次、两次不一样」。 */
const PROBE = `(() => {
  const text = document.body ? String(document.body.innerText || '') : ''
  const graph = globalThis.__DSC_BOOT__ ?? null
  const bootState = globalThis.__DSC_UI_BOOT_STATE__ ?? null
  const root = document.getElementById('root')
  const appNode = document.querySelector('.app')
  const rect = appNode === null ? null : appNode.getBoundingClientRect()
  return {
    url: String(location.href),
    title: String(document.title || ''),
    ready: String(document.readyState),
    app: document.querySelectorAll('.app').length,
    appBox: rect === null ? null : { width: Math.round(rect.width), height: Math.round(rect.height) },
    splash: document.getElementById('boot-splash') !== null,
    rootChildren: root === null ? -1 : root.childElementCount,
    text: text.slice(0, 4000),
    hasRendererDiag: text.includes('界面渲染器'),
    hasLayoutDiag: text.includes('界面布局'),
    hasUiRenderer: text.includes('ui-renderer'),
    hasUiLayout: text.includes('ui-layout'),
    boot: graph === null ? null : {
      rev: graph.rev,
      entries: (graph.entries || []).map((entry) => entry.id),
      disabled: graph.disabled || [],
      host: graph.host || null,
      batches: (graph.batches || []).map((batch) => ({ phase: batch.phase, entries: batch.entries })),
    },
    bootPlugins: bootState === null ? null : Object.fromEntries(
      Object.entries(bootState.plugins || {}).map(([id, row]) => [id, row.state]),
    ),
    bootRequests: bootState === null ? null : (bootState.requests || []).length,
    firstFrameAt: bootState === null ? null : bootState.firstFrameAt,
  }
})()`

async function inPage(win, expression) {
  return win.webContents.executeJavaScript(expression, true)
}

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: { backgroundThrottling: false },
  })
  /** 页面控制台里 error/warn 的原话：白屏时这是唯一能说明「为什么」的线索。 */
  const consoleRows = []
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    if (first && typeof first === 'object' && 'message' in first) {
      if (first.level === 'error' || first.level === 'warning') {
        consoleRows.push({ level: String(first.level), message: String(first.message).slice(0, 400) })
      }
      return
    }
    if (args[1] === 3 || args[1] === 2) consoleRows.push({ level: String(args[1]), message: String(args[2]).slice(0, 400) })
  })

  await win.loadURL(entryUrl)
  const startedAt = Date.now()
  while (Date.now() - startedAt < 60000) {
    const ready = await inPage(win, 'document.readyState')
    if (ready === 'complete') break
    await sleep(150)
  }

  // 落定 = 骨架的 .app 出现了，或者任一诊断页的标题出现了。两者都没有就是白屏，
  // 继续等到超时，好把当时的页面状态原样带回去（而不是干等一个空结论）。
  let probe = null
  const settleStart = Date.now()
  for (;;) {
    probe = await inPage(win, PROBE)
    const settled = probe.app > 0 || probe.hasRendererDiag || probe.hasLayoutDiag
    if (settled || Date.now() - settleStart > 90000) break
    await sleep(250)
  }
  const settleMs = Date.now() - settleStart

  // 启动占位（#boot-splash）盖在上面时截图看不出下面是什么；等它退场，最多 20 秒。
  const splashStart = Date.now()
  while (probe !== null && probe.splash && Date.now() - splashStart < 20000) {
    await sleep(200)
    probe = await inPage(win, PROBE)
  }
  // 再等一小会儿让淡出动画与首批插件画完（截图给人看的，多这几百毫秒值得）。
  await sleep(600)
  probe = await inPage(win, PROBE)

  // 截图前把窗口真的显示出来：Windows 上隐藏窗口 capturePage 拿到的是空白帧（实测，
  // 与 _ui-dsh-card-main.cjs 同一条经验）。
  win.show()
  win.focus()
  await sleep(1200)
  probe = await inPage(win, PROBE)

  let shot = false
  if (shotPath !== '') {
    mkdirSync(dirname(shotPath), { recursive: true })
    const image = await win.webContents.capturePage()
    writeFileSync(shotPath, image.toPNG())
    shot = true
  }
  win.hide()

  if (resultPath !== '') {
    mkdirSync(dirname(resultPath), { recursive: true })
    writeFileSync(
      resultPath,
      JSON.stringify({ ok: true, label, entryUrl, settleMs, probe, console: consoleRows.slice(-20), shot }, null, 2),
      'utf8',
    )
  }
  app.exit(0)
}

main().catch((error) => fail('main', error))
