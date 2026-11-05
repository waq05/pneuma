/**
 * 功能走查的浏览器侧（Electron 主进程，隐藏窗口）：按一份「步骤清单」逐步点、逐步断言、逐步截图。
 *
 * 为什么用 Electron 而不是 Playwright：仓库里没有 Playwright（也不值得为走查引一个浏览器下载），
 * 而桌面端本来就是 Electron，`_ui-boot-e2e-main.cjs` / `_ui-dsh-card-main.cjs` 已经把
 * 「起窗口 → 等落定 → 截图」这条路走通了。这里只是把「只读一次」换成「按清单做 N 步」。
 *
 * 步骤是纯数据（JSON），由 `scripts/ui-sweep.mjs` 生成：
 *   { name, click?, text?, type?, key?, js?, wait?, expect?, shot? }
 *
 *   - click / type 的 `text` 是**可见文字**匹配（按 innerText 精确或包含），比 CSS 稳；
 *     给了 `selector` 就直接用 CSS。
 *   - expect 是一段在页面里求值的表达式，返回真值即通过；失败时连同当时的候选文字一起记下来。
 *   - shot 是截图名（落在 DSC_SWEEP_SHOTS 下，扩展名 .png）。
 *
 * 环境变量：DSC_SWEEP_STEPS / DSC_SWEEP_OUT / DSC_SWEEP_SHOTS / DSC_SWEEP_USER_DATA。
 * 用法：electron scripts/_ui-sweep-main.cjs <带令牌的入口地址>
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const entryUrl = process.argv[2]
const stepsPath = String(process.env['DSC_SWEEP_STEPS'] || '')
const outPath = String(process.env['DSC_SWEEP_OUT'] || '')
const shotsDir = String(process.env['DSC_SWEEP_SHOTS'] || '')

if (typeof entryUrl !== 'string' || entryUrl === '' || stepsPath === '' || outPath === '') {
  process.stderr.write('[ui-sweep] 缺入口地址或步骤清单\n')
  app.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 页面里可用的几个小工具：点、填、按键、找元素。函数源码交给 executeJavaScript 求值。 */
const HELPERS = `
globalThis.__sweep = {
  byText: (text, tag) => {
    const nodes = [...document.querySelectorAll(tag || 'button, [role=button], a, summary, [role=tab], [role=menuitem], label, div, span')]
    const exact = nodes.filter((node) => (node.innerText || '').trim() === text)
    if (exact.length > 0) return exact[0]
    const loose = nodes.filter((node) => (node.innerText || '').includes(text))
    // 取最深的那个：包含关系的父节点也命中，点父节点不一定触发按钮。
    loose.sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)
    return loose[0] || null
  },
  clickText: (text, tag) => {
    const node = globalThis.__sweep.byText(text, tag)
    if (node === null) throw new Error('找不到文字：' + text)
    const target = node.closest('button, [role=button], a, summary, [role=tab], [role=menuitem], label') || node
    target.click()
    return true
  },
  clickSel: (selector) => {
    const node = document.querySelector(selector)
    if (node === null) throw new Error('找不到元素：' + selector)
    node.click()
    return true
  },
  setValue: (selector, value) => {
    const node = document.querySelector(selector)
    if (node === null) throw new Error('找不到输入框：' + selector)
    node.focus()
    if (node.isContentEditable) {
      node.textContent = value
    } else {
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value)
    }
    node.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  },
  key: (target, init) => {
    const node = target === null ? document.activeElement || document.body : (typeof target === 'string' ? document.querySelector(target) : target)
    if (node === null) throw new Error('按键找不到目标')
    for (const type of ['keydown', 'keypress', 'keyup']) {
      node.dispatchEvent(new KeyboardEvent(type, Object.assign({ bubbles: true, cancelable: true }, init)))
    }
    return true
  },
}
true`

const fail = (stage, error) => {
  const text = error && error.stack ? error.stack : String(error)
  try {
    writeFileSync(outPath, JSON.stringify({ error: text, stage }, null, 2) + '\n', 'utf8')
  } catch {}
  app.exit(3)
}
process.on('uncaughtException', (error) => fail('uncaught', error))
process.on('unhandledRejection', (error) => fail('unhandledRejection', error))

app.disableHardwareAcceleration()
if (typeof process.env['DSC_SWEEP_USER_DATA'] === 'string' && process.env['DSC_SWEEP_USER_DATA'] !== '') {
  app.setPath('userData', process.env['DSC_SWEEP_USER_DATA'])
}

async function main() {
  const steps = JSON.parse(readFileSync(stepsPath, 'utf8'))
  await app.whenReady()
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { backgroundThrottling: false },
  })
  const consoleRows = []
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    if (first && typeof first === 'object' && 'message' in first) {
      if (first.level === 'error') consoleRows.push(String(first.message).slice(0, 300))
      return
    }
    if (args[1] === 3) consoleRows.push(String(args[2]).slice(0, 300))
  })

  await win.loadURL(entryUrl)
  const inPage = (expression) => win.webContents.executeJavaScript(expression, true)

  // 落定：.app 出现，或诊断页出现（哪种都继续跑，步骤里的断言会说话）。
  const settled = Date.now()
  for (;;) {
    const probe = await inPage('({ app: document.querySelectorAll(".app").length, splash: document.getElementById("boot-splash") !== null, diag: /界面渲染器|界面布局/.test(document.body ? document.body.innerText : "") })')
    if ((probe.app > 0 && !probe.splash) || probe.diag || Date.now() - settled > 60000) break
    await sleep(200)
  }
  await sleep(800)
  await inPage(HELPERS)

  const results = []
  for (const step of steps) {
    const row = { name: step.name, ok: null, detail: '' }
    try {
      if (step.click !== undefined) await inPage('globalThis.__sweep.clickSel(' + JSON.stringify(step.click) + ')')
      if (step.clickText !== undefined) await inPage('globalThis.__sweep.clickText(' + JSON.stringify(step.clickText) + ',' + JSON.stringify(step.tag || '') + ')')
      if (step.type !== undefined) await inPage('globalThis.__sweep.setValue(' + JSON.stringify(step.type) + ',' + JSON.stringify(step.text || '') + ')')
      if (step.key !== undefined) await inPage('globalThis.__sweep.key(' + JSON.stringify(step.target || null) + ',' + JSON.stringify(step.key) + ')')
      if (step.js !== undefined) await inPage(step.js)
      await sleep(step.wait === undefined ? 350 : step.wait)
      if (step.expect !== undefined) {
        const value = await inPage(step.expect)
        row.ok = Boolean(value)
        if (!row.ok) {
          const text = await inPage('(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").slice(0, 400)')
          row.detail = '期望不成立；当前页面文字：' + text
          // 断言失败时多带一份现场（谁还在、谁停了）：走查的失败大多要看着这份现场才能判。
          if (step.probe !== undefined) {
            try {
              row.detail += ' | 现场：' + JSON.stringify(await inPage(step.probe)).slice(0, 600)
            } catch (error) {
              row.detail += ' | 现场取不到：' + String(error).slice(0, 200)
            }
          }
        }
      } else {
        row.ok = true
      }
      if (step.shot !== undefined && shotsDir !== '') {
        mkdirSync(shotsDir, { recursive: true })
        // Windows 上隐藏窗口 capturePage 拿到空白帧：截图前把窗口显示出来。
        win.show()
        win.focus()
        await sleep(450)
        const image = await win.webContents.capturePage()
        writeFileSync(join(shotsDir, step.shot + '.png'), image.toPNG())
        row.shot = join(shotsDir, step.shot + '.png')
      }
    } catch (error) {
      row.ok = false
      row.detail = error && error.message ? error.message : String(error)
    }
    results.push(row)
    process.stdout.write((row.ok ? 'PASS ' : 'FAIL ') + row.name + (row.ok ? '' : ' — ' + row.detail.slice(0, 600)) + '\n')
  }

  const pass = results.filter((row) => row.ok).length
  writeFileSync(outPath, JSON.stringify({ total: results.length, pass, fail: results.length - pass, results, console: consoleRows }, null, 2) + '\n', 'utf8')
  await sleep(200)
  app.exit(pass === results.length ? 0 : 1)
}

main()
