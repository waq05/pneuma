/**
 * 浮层锚定的浏览器侧探针（Electron 主进程，隐藏窗口）。
 *
 * 量三件事，都是「打开下拉之后」的终态：
 *   1. 浮层左缘对齐触发钮左缘、下缘与触发钮的间距等于 gap（±1px）；
 *   2. 浮层不窄于触发钮；
 *   3. 打开**当帧**就不是隐藏态（`visibility` 不是 hidden）——旧实现要等一次测量，
 *      这一条能把「先画在 0,0 再挪」的回归抓出来。
 *
 * 用法：electron scripts/_ui-anchor-main.cjs <带令牌的入口地址>
 *   读数文件与截图走环境变量（DSC_ANCHOR_RESULT / _SHOT）。
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')

const entryUrl = process.argv[2]
const resultPath = String(process.env['DSC_ANCHOR_RESULT'] || '')
const shotPath = String(process.env['DSC_ANCHOR_SHOT'] || '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function writeResult(value) {
  if (resultPath === '') return
  try {
    mkdirSync(dirname(resultPath), { recursive: true })
    writeFileSync(resultPath, JSON.stringify(value, null, 2), 'utf8')
  } catch {}
}

app.disableHardwareAcceleration()
if (typeof process.env['DSC_ANCHOR_USER_DATA'] === 'string' && process.env['DSC_ANCHOR_USER_DATA'] !== '') {
  app.setPath('userData', process.env['DSC_ANCHOR_USER_DATA'])
}

const inPage = (win, body) => win.webContents.executeJavaScript(`(async () => { ${body} })()`)

async function waitFor(win, expression, timeoutMs, label) {
  const startedAt = Date.now()
  for (;;) {
    if (await win.webContents.executeJavaScript(expression)) return
    if (Date.now() - startedAt > timeoutMs) throw new Error('等不到：' + label)
    await sleep(100)
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } })
  const out = { console: [] }
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    const level = first && typeof first === 'object' ? first.level : args[1]
    const message = first && typeof first === 'object' ? first.message : args[2]
    if (level === 'error' || level === 'warning' || level === 3 || level === 2) out.console.push(String(message).slice(0, 300))
  })
  try {
    await win.loadURL(entryUrl)
    await waitFor(win, "document.querySelector('.composer') !== null", 60000, '壳的输入框')
    // 设置窗由壳的全局事件打开（左栏那颗齿轮就是派发它）：直接派发，不依赖按钮位置。
    // 反复派发到浮层出现：插件是一条条装进来的，第一次派发可能还没人听。
    const opened = await inPage(win, [
      "const until = Date.now() + 30000;",
      "while (Date.now() < until) {",
      "  window.dispatchEvent(new CustomEvent('shell.settings.open'));",
      "  await new Promise((r) => setTimeout(r, 250));",
      "  if (document.querySelector('.settings') !== null) return true;",
      "}",
      "out.bodyText = String(document.body.innerText).slice(0, 400);",
      "return false;",
    ].join('\n'))
    if (opened !== true) throw new Error('派发 shell.settings.open 之后设置窗没出现')
    // 找一个带下拉的分区：逐页点导航，直到出现 .select-trigger。
    out.found = await inPage(win, [
      "const navs = Array.from(document.querySelectorAll('.settings-nav-item'));",
      "for (const nav of navs) {",
      "  nav.click();",
      "  await new Promise((r) => setTimeout(r, 220));",
      "  if (document.querySelector('.settings .select-trigger') !== null) return nav.textContent; ",
      "}",
      "return null;",
    ].join('\n'))
    if (out.found === null) throw new Error('设置里没有找到下拉（.select-trigger）')
    out.measure = await inPage(win, [
      "const trigger = Array.from(document.querySelectorAll('.settings .select-trigger')).find((el) => !el.disabled);",
      "if (trigger === undefined) return { error: '设置里没有可点的下拉' };",
      "trigger.click();",
      "await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));",
      "const pop = document.querySelector('.select-pop');",
      "if (pop === null) return { error: '没打开浮层' };",
      "const a = trigger.getBoundingClientRect();",
      "const b = pop.getBoundingClientRect();",
      "const anchorName = getComputedStyle(trigger).anchorName;",
      "const positionAnchor = getComputedStyle(pop).positionAnchor;",
      "const visibility = getComputedStyle(pop).visibility;",
      "const tryFallbacks = getComputedStyle(pop).positionTryFallbacks;",
      "trigger.click();",
      "return { trigger: { left: a.left, right: a.right, top: a.top, bottom: a.bottom, width: a.width }, pop: { left: b.left, top: b.top, width: b.width, height: b.height }, anchorName, positionAnchor, visibility, tryFallbacks, viewport: { w: window.innerWidth, h: window.innerHeight } };",
    ].join('\n'))
    // 第二段：单独验「下方放不下就翻上去」这条机制——在窗口底部粘一个锚点、配一个 120 高的浮层，
    // 用的就是 Select 那几条同样的 CSS 属性。为什么不在设置页里找：设置页里没有哪个下拉真的贴着
    // 窗口底边，硬凑会变成在测布局而不是在测翻向。
    out.flip = await inPage(win, [
      "const host = document.createElement('div');",
      "host.style.cssText = 'position:fixed;left:40px;bottom:8px;width:120px;height:24px;background:#ccc;z-index:99999';",
      "host.style.anchorName = '--dsc-flip-probe';",
      "const panel = document.createElement('div');",
      "panel.style.cssText = 'position:fixed;width:120px;height:120px;background:#eee;z-index:99999';",
      "panel.style.positionAnchor = '--dsc-flip-probe';",
      "panel.style.top = 'calc(anchor(bottom) + 4px)';",
      "panel.style.left = 'anchor(left)';",
      "panel.style.positionTryFallbacks = 'flip-block';",
      "document.body.appendChild(host);",
      "document.body.appendChild(panel);",
      "await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));",
      "const a = host.getBoundingClientRect();",
      "const b = panel.getBoundingClientRect();",
      "host.remove();",
      "panel.remove();",
      "return { trigger: { top: a.top, bottom: a.bottom }, pop: { top: b.top, bottom: b.bottom, height: b.height }, viewport: window.innerHeight };",
    ].join('\n'))
    if (shotPath !== '') {
      // 截图时把浮层重新打开：证据图要看得见「贴在哪」，只留读数看不出位置感。
      await inPage(win, [
        "const trigger = Array.from(document.querySelectorAll('.settings .select-trigger')).find((el) => !el.disabled);",
        "if (trigger !== null) trigger.click();",
        "await new Promise((r) => setTimeout(r, 120));",
        "return true;",
      ].join('\n'))
      win.show()
      await sleep(600)
      const image = await win.capturePage()
      mkdirSync(dirname(shotPath), { recursive: true })
      writeFileSync(shotPath, image.toPNG())
      out.shot = shotPath
    }
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error)
  }
  writeResult(out)
  app.exit(0)
})
