/**
 * 「停用一个界面插件之后，界面上不许留残骸」的真机驱动（Electron 主进程，隐藏窗口）。
 *
 * 2026-11-06 报障：停用「旁问（界面）」之后，右侧栏开始页的旁问卡与已经开着的旁问页签都还在。
 * 这一条走用户的真实路径，把 6 个会往右侧栏报名页签的插件挨个停用一遍：
 *
 *   ask（旁问）、preview（预览）、files（文件 + Git）、terminal（终端）、browser（浏览器）、
 *   plugins（插件中心整页，验侧栏那颗导航钮）。
 *
 * status（后台活输出）与 team（子智能体）的页签要真有后台作业 / 队友才开得出来，真机上
 * 没有这个前置条件；它们的页签清理由 `ui-plugin-disable-test.mjs` 的产物级总闸覆盖，
 * 这里只验「停用后不留可见入口」。
 *
 * 读数与截图走环境变量：DSC_DISABLE_RESULT / DSC_DISABLE_BEFORE / DSC_DISABLE_AFTER /
 * DSC_DISABLE_PALETTE。
 *
 * 用法：electron scripts/_ui-plugin-disable-main.cjs <带令牌的入口地址>
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')

const entryUrl = process.argv[2]
const resultPath = String(process.env['DSC_DISABLE_RESULT'] || '')
const shotBefore = String(process.env['DSC_DISABLE_BEFORE'] || '')
const shotAfter = String(process.env['DSC_DISABLE_AFTER'] || '')
const shotPalette = String(process.env['DSC_DISABLE_PALETTE'] || '')
const shotEnd = String(process.env['DSC_DISABLE_END'] || '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function writeResult(value) {
  if (resultPath === '') return
  try {
    mkdirSync(dirname(resultPath), { recursive: true })
    writeFileSync(resultPath, JSON.stringify(value, null, 2) + '\n', 'utf8')
  } catch {}
}

app.disableHardwareAcceleration()
if (typeof process.env['DSC_DISABLE_USER_DATA'] === 'string' && process.env['DSC_DISABLE_USER_DATA'] !== '') {
  app.setPath('userData', process.env['DSC_DISABLE_USER_DATA'])
}

const inPage = (win, body) => win.webContents.executeJavaScript('(async () => { ' + body + ' })()')

async function waitFor(win, expression, timeoutMs, label) {
  const startedAt = Date.now()
  for (;;) {
    if (await win.webContents.executeJavaScript(expression)) return true
    if (Date.now() - startedAt > timeoutMs) throw new Error('等不到：' + label)
    await sleep(150)
  }
}

async function shoot(win, path) {
  if (path === '') return
  win.show()
  await sleep(500)
  const image = await win.capturePage()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, image.toPNG())
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

  const chips = () => inPage(win, "return Array.from(document.querySelectorAll('.dock-chip-label')).map((el) => el.textContent.trim())")
  const cards = () => inPage(win, "return Array.from(document.querySelectorAll('.dock-guide-title')).map((el) => el.textContent.trim())")
  const navs = () => inPage(win, "return Array.from(document.querySelectorAll('.sidebar-nav .nav-item')).map((el) => String(el.textContent).trim())")

  /** 点开始页上某张入口卡（按文字找）；找不到返回 false。 */
  const clickCard = (text) =>
    inPage(
      win,
      'const c = Array.from(document.querySelectorAll(".dock-guide-entry")).find((el) => String(el.textContent).includes(' +
        JSON.stringify(text) +
        ')); if (c === undefined) return false; c.click(); return true;',
    )

  /** 进插件中心（侧栏「插件」整页），并把各段折叠的尾巴都展开。 */
  const openPlugins = async () => {
    await inPage(win, 'const nav = Array.from(document.querySelectorAll(".sidebar-nav .nav-item")).find((el) => String(el.textContent).includes("插件")); if (nav) nav.click(); return true;')
    await waitFor(win, "document.querySelector('.plugins') !== null", 15000, '插件中心')
    // 行是异步取回来的（listPlugins）：等第一行真出现再谈展开，否则下面找不到「展开其余」。
    await waitFor(win, 'document.querySelector("[data-plugin]") !== null', 15000, '插件清单的行')
    // 六段各有一颗「展开其余」：每次重新查一颗「还写着展开」的再点（点完 React 会换掉节点，
    // 抓着旧引用连点会点到已经脱离文档的那份，后面的段永远展不开）。
    for (let round = 0; round < 10; round += 1) {
      const clicked = await inPage(win, 'const b = Array.from(document.querySelectorAll(".plugin-more")).find((el) => String(el.textContent).includes("展开")); if (b === undefined) return false; b.click(); return true;')
      if (clicked !== true) break
      await sleep(150)
    }
  }

  /** 再点一次「插件」回对话页（顶栏与命令面板这时才回来）。 */
  const leavePlugins = async () => {
    await inPage(win, 'const nav = Array.from(document.querySelectorAll(".sidebar-nav .nav-item")).find((el) => String(el.textContent).includes("插件")); if (nav) nav.click(); return true;')
    await sleep(600)
  }

  /** 扳一个插件行的开关，等页面把它卸掉（boot 账本翻成 removed/failed）。 */
  const disable = async (key) => {
    await waitFor(win, 'document.querySelector(\'[data-plugin="' + key + '"]\') !== null', 15000, key + ' 那一行')
    const on = await inPage(win, 'const b = document.querySelector(\'[data-plugin="' + key + '"] .switch\'); return b === null ? "none" : b.getAttribute("aria-checked")')
    await inPage(win, 'const b = document.querySelector(\'[data-plugin="' + key + '"] .switch\'); if (b) b.click(); return true')
    const gone = await waitFor(
      win,
      '(() => { const st = window.__DSC_UI_BOOT_STATE__; const row = st && st.plugins ? st.plugins[' +
        JSON.stringify(key.slice(3)) +
        '] : undefined; return row !== undefined && (row.state === "removed" || row.state === "failed"); })()',
      20000,
      key + ' 被页面卸掉',
    ).catch(() => false)
    return { on, gone }
  }

  /** 打开命令面板并搜一个词，返回结果行的标签（面板开不出来时给 null）。 */
  const palette = async (query) => {
    await inPage(win, 'window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })); return true')
    await sleep(450)
    const opened = await inPage(win, 'if (document.querySelector(".palette") !== null) return "hotkey"; const s = document.querySelector(".topbar-search"); if (s) { s.click(); await new Promise((r) => setTimeout(r, 450)); } return document.querySelector(".palette") !== null ? "button" : null')
    if (opened === null) return { opened, rows: null, empty: null }
    const result = await inPage(
      win,
      'const input = document.querySelector(".palette-search input"); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; setter.call(input, ' +
        JSON.stringify(query) +
        '); input.dispatchEvent(new Event("input", { bubbles: true })); await new Promise((r) => setTimeout(r, 400)); return { rows: Array.from(document.querySelectorAll(".palette-row .palette-label")).map((el) => el.textContent.trim()), empty: document.querySelector(".palette-empty") !== null };',
    )
    return { opened, rows: result.rows, empty: result.empty }
  }

  const closePalette = () => inPage(win, 'const c = document.querySelector(".palette-close"); if (c) c.click(); await new Promise((r) => setTimeout(r, 200)); return true')

  try {
    await win.loadURL(entryUrl)
    await waitFor(win, "document.querySelector('.composer') !== null", 60000, '壳的输入框')
    await waitFor(win, 'Boolean(window.__DSC_UI_BOOT_STATE__ && window.__DSC_UI_BOOT_STATE__.plugins["ask"] && window.__DSC_UI_BOOT_STATE__.plugins["ask"].state === "loaded")', 60000, '旁问插件装上')
    // 打开右侧栏（顶栏那颗 .dock-toggle）：默认布局就是「开始」页。
    out.opened = await inPage(win, 'const t = document.querySelector(".dock-toggle"); if (t === null) return false; t.click(); return true')
    await waitFor(win, "document.querySelector('.dock-guide') !== null", 15000, '右侧栏开始页')
    out.initial = { cards: await cards(), chips: await chips(), nav: await navs() }
    await shoot(win, shotBefore)

    // ── 1. 旁问：卡片 → 页签 → 停用 → 两样都消失，命令面板也搜不到 -----------------
    out.ask = { cardsBefore: await cards() }
    out.ask.openedTab = await clickCard('旁问')
    await waitFor(win, "document.querySelector('.ask') !== null", 10000, '旁问页签体')
    out.ask.chipsBefore = await chips()
    await openPlugins()
    out.ask.toggle = await disable('ui-ask')
    await leavePlugins()
    await waitFor(win, "document.querySelector('.ask') === null", 10000, '旁问页签体消失')
    out.ask.chipsAfter = await chips()
    out.ask.cardsAfter = await cards()
    out.ask.bodyGone = await inPage(win, 'return document.querySelector(".ask") === null')
    // 验收要的那张「停用后开始页」：这时候其余四张卡还在，正好说明只清掉了旁问这一种。
    await shoot(win, shotAfter)
    out.ask.palette = await palette('旁问')
    await shoot(win, shotPalette)
    await closePalette()

    // ── 2. 预览 + 文件：先开文件树，点一个文件开预览；两个插件分别停用 ----------------
    out.files = { opened: await clickCard('工作区文件') }
    await waitFor(win, "document.querySelector('[data-tree-entry=\"file\"]') !== null", 20000, '文件树里的一行文件')
    out.files.chipsBefore = await chips()
    out.preview = {}
    out.preview.label = await inPage(win, 'const row = document.querySelector(\'[data-tree-entry="file"] .file-name\'); return row === null ? "" : String(row.textContent).trim()')
    await inPage(win, 'const row = document.querySelector(\'[data-tree-entry="file"]\'); if (row) row.click(); return true')
    await waitFor(win, 'document.querySelectorAll(".dock-chip-label").length >= 2', 10000, '预览页签')
    out.preview.chipsBefore = await chips()
    await openPlugins()
    out.preview.toggle = await disable('ui-preview')
    await leavePlugins()
    await sleep(500)
    out.preview.chipsAfter = await chips()
    out.preview.previewBodyGone = await inPage(win, 'return document.querySelector(".file-preview-head") === null')
    out.preview.filesStillThere = await inPage(win, 'return document.querySelector(".files-pane") !== null')

    await openPlugins()
    out.files.toggle = await disable('ui-files')
    await leavePlugins()
    await sleep(500)
    out.files.chipsAfter = await chips()
    out.files.bodyGone = await inPage(win, 'return document.querySelector(".files-pane") === null')
    out.files.cardsAfter = await cards()

    // ── 3. 终端 ------------------------------------------------------------------
    out.terminal = { opened: await clickCard('新建终端') }
    await waitFor(win, 'Array.from(document.querySelectorAll(".dock-chip-label")).some((el) => el.textContent.trim() === "终端")', 15000, '终端页签')
    out.terminal.chipsBefore = await chips()
    await openPlugins()
    out.terminal.toggle = await disable('ui-terminal')
    await leavePlugins()
    await sleep(500)
    out.terminal.chipsAfter = await chips()
    out.terminal.bodyGone = await inPage(win, 'return document.querySelector(".term-pane") === null && document.querySelector(".shell-term-empty") === null && document.querySelector(".xterm") === null')

    // ── 4. 浏览器 ----------------------------------------------------------------
    out.browser = { opened: await clickCard('浏览器') }
    await waitFor(win, 'Array.from(document.querySelectorAll(".dock-chip-label")).some((el) => el.textContent.trim() === "浏览器")', 15000, '浏览器页签')
    out.browser.chipsBefore = await chips()
    await openPlugins()
    out.browser.toggle = await disable('ui-browser')
    await leavePlugins()
    await sleep(500)
    out.browser.chipsAfter = await chips()
    out.browser.bodyGone = await inPage(win, 'return document.querySelector(".browser-pane") === null && document.querySelector(".shell-term-empty") === null')

    // ── 5. 插件中心整页：停用后侧栏那颗钮要消失，主区回到对话页（不是空白） ------------
    out.plugins = { navBefore: await navs() }
    await openPlugins()
    out.plugins.toggle = await disable('ui-plugins') // 页面自己会被卸掉，随后不能再用 leavePlugins
    await sleep(1200)
    out.plugins.navAfter = await navs()
    out.plugins.pageGone = await inPage(win, 'return document.querySelector(".plugins") === null')
    out.plugins.chatBack = await inPage(win, 'return document.querySelector(".composer") !== null && document.querySelector(".chat-wrap, .chat, .thread-main") !== null')
    out.plugins.blank = await inPage(win, 'const main = document.querySelector(".thread-main, .chat-wrap, main"); return main === null ? true : String(main.textContent).trim().length === 0')
    // 六个都停用之后的开屏状态（面板类插件全关时开始页只剩罗盘，这是诚实的样子）。
    out.final = { cards: await cards(), chips: await chips(), nav: await navs() }
    await shoot(win, shotEnd)
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error)
  }
  writeResult(out)
  app.exit(0)
})
