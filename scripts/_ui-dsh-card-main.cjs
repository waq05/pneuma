/**
 * 「dsh 插件的 diff 卡」真机探针的浏览器侧（Electron 主进程，隐藏窗口）。
 *
 * 只做一件事：在一段真对话里让 dsh 兼容层的工具真的跑一次，然后把它的工具卡
 * 展开、把展开体里那块 diff 读出来，并截一张图。
 *
 * 为什么要真跑：卡片数据是**宿主按 callId 缝回工具卡**的（presentation.result），
 * 中间要过协议、事件流、适配器三跳；只测纯函数证明不了「界面上真的画出来了」。
 *
 * 与 _ui-cordis-main.cjs 同一套约束：命令行只带入口地址一个位置参数，
 * 截图/读数走环境变量（多带一个位置参数 electron 直接退出 127）。
 *
 * 环境变量：
 *   DSC_CARD_RESULT   读数 JSON 的落盘路径
 *   DSC_CARD_SHOT     截图 PNG 的落盘路径
 *   DSC_CARD_QUESTION 提交给宿主的那句话
 *   DSC_CARD_EXPECT   结果里应出现的一句话（证明真跑了，不只是卡出来了）
 *   DSC_CARD_USER_DATA Electron 的 userData（隔离，不碰真身）
 *
 * 用法：electron scripts/_ui-dsh-card-main.cjs <带令牌的入口地址>
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { dirname } = require('node:path')

const entryUrl = process.argv[2]
const resultPath = String(process.env['DSC_CARD_RESULT'] || '')
const shotPath = String(process.env['DSC_CARD_SHOT'] || '')
const question = String(process.env['DSC_CARD_QUESTION'] || '写一条备注')
const expectText = String(process.env['DSC_CARD_EXPECT'] || '')

if (typeof entryUrl !== 'string' || entryUrl === '') {
  process.stderr.write('[dsh-card] 缺少入口地址\n')
  app.exit(2)
}

/** 任何一处抛错都落到读数文件，别让「退出码 -1 + 无声」这种形状出现。 */
const fail = (stage, error) => {
  const text = error && error.stack ? error.stack : String(error)
  try {
    if (resultPath !== '') {
      mkdirSync(dirname(resultPath), { recursive: true })
      writeFileSync(resultPath, JSON.stringify({ error: text, stage }, null, 2), 'utf8')
    }
  } catch {}
  app.exit(3)
}
process.on('uncaughtException', (error) => fail('uncaught', error))
process.on('unhandledRejection', (error) => fail('unhandledRejection', error))

app.disableHardwareAcceleration()
if (typeof process.env['DSC_CARD_USER_DATA'] === 'string' && process.env['DSC_CARD_USER_DATA'] !== '') {
  app.setPath('userData', process.env['DSC_CARD_USER_DATA'])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 在页面里跑一段 JS（等 promise 结果）。 */
async function inPage(win, body) {
  return win.webContents.executeJavaScript('(async () => { ' + body + ' })()', true)
}

async function waitFor(win, body, timeoutMs, label) {
  const startedAt = Date.now()
  for (;;) {
    const ok = await inPage(win, 'return !!(' + body + ')')
    if (ok) return true
    if (Date.now() - startedAt > timeoutMs) throw new Error('等不到 ' + label)
    await sleep(250)
  }
}

async function main() {
  await app.whenReady()
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    show: false,
    webPreferences: { backgroundThrottling: false },
  })
  await win.loadURL(entryUrl)
  await waitFor(win, "document.readyState === 'complete'", 30000, '页面加载完')
  await waitFor(win, "document.querySelector('.composer') !== null", 60000, '壳的输入框')

  const submitted = await inPage(
    win,
    'const res = await fetch("/api/invoke", {' +
      ' method: "POST",' +
      ' headers: { "content-type": "application/json" },' +
      ' body: JSON.stringify({ method: "submit", args: [' + JSON.stringify(question) + ', null] }),' +
      ' });' +
      ' const json = await res.json().catch(() => ({}));' +
      ' return json && json.ok === true;',
  )
  if (!submitted) throw new Error('提交这一轮失败')

  // 等那张卡出现、并且这一轮跑完（卡不再是 running）。
  await waitFor(win, "document.querySelector('.tool-card') !== null", 120000, '工具卡出现')
  await waitFor(win, "document.querySelector('.tool-card.status-running') === null", 120000, '工具跑完')
  // 工具名不一定画在卡上（头上是中文动词），所以按结果的投影文字认这一次真的跑到了。
  if (expectText !== '') {
    try {
      await waitFor(
        win,
        // 用 textContent 而不是 innerText：收起/折叠的行在 innerText 里会被跳过，
        // 而「结果到了」这件事与折叠无关。
        "(document.body.textContent || '').includes(" + JSON.stringify(expectText) + ')',
        60000,
        '结果文字 ' + expectText,
      )
    } catch (error) {
      // 等不到就把页面上有什么写进读数：没有这一份，「为什么没出现」只能靠猜。
      const dump = await inPage(
        win,
        'return {' +
          ' text: (document.body.innerText || "").slice(-2500),' +
          ' cards: Array.from(document.querySelectorAll(".tool-card")).map((c) => c.className + " | " + (c.textContent || "").slice(0, 200)),' +
          ' entries: document.querySelectorAll(".entry").length,' +
          ' };',
      )
      if (resultPath !== '') {
        mkdirSync(dirname(resultPath), { recursive: true })
        // 写到旁支文件：fail() 还会往正牌读数里写一条错误摘要，别互相覆盖。
        writeFileSync(resultPath + '.dump.json', JSON.stringify({ error: String(error && error.message), dump }, null, 2), 'utf8')
      }
      throw error
    }
  }

  // 展开：卡默认可能是收起的，diff 在展开体里。
  const probe = await inPage(
    win,
    'const cards = Array.from(document.querySelectorAll(".tool-card"));' +
      ' const target = cards[cards.length - 1];' +
      ' if (!target) return { cards: 0 };' +
      ' const head = target.querySelector(".tool-head");' +
      ' if (!target.classList.contains("open") && head) head.click();' +
      ' await new Promise((r) => setTimeout(r, 500));' +
      ' const own = (sel) => Array.from(target.querySelectorAll(sel));' +
      ' const textOf = (node) => (node === null ? "" : (node.textContent || "").trim());' +
      ' return {' +
      '   cards: cards.length,' +
      '   opened: target.classList.contains("open"),' +
      '   head: textOf(target.querySelector(".tool-head")),' +
      '   status: target.className,' +
      '   hasChangeBlock: target.querySelector("[data-tc-change]") !== null,' +
      '   hasDiffBody: target.querySelector(".diff-body") !== null,' +
      '   added: textOf(target.querySelector(".changes-added")),' +
      '   removed: textOf(target.querySelector(".changes-removed")),' +
      '   diffAdded: own(".diff-line.diff-add").length,' +
      '   diffRemoved: own(".diff-line.diff-del").length,' +
      '   diffLines: own(".diff-line").map(textOf).slice(0, 12),' +
      '   resultText: textOf(target.querySelector(".result")),' +
      ' };',
  )

  // 截图前先把窗口**真的显示出来**：Windows 上隐藏窗口 capturePage 拿到的是空白帧（实测），
  // 而且隐藏状态下布局不完整（量到的 rect 高 0），展开与滚动都得在显示之后做。
  win.show()
  win.focus()
  await sleep(1200)
  const shotProbe = await inPage(
    win,
    // 阶段组默认收起：组体在 DOM 里但不可见，图上看不到那张卡。所以截图前先把
    // 收着的组头点开（data-open 没写就是收着），再把卡滚进视野。
    // 三层显隐从外向内：整轮（.turn-fold，收起时 .step-seat 直接 display:none）→
    // 阶段组（.step-fold）→ 工具卡自己。三处都得点开，卡才会真的出现在画面上。
    'const turns = Array.from(document.querySelectorAll(".turn-fold"));' +
      ' for (const t of turns) { if (t.getAttribute("aria-expanded") === "false") t.click(); }' +
      ' await new Promise((r) => setTimeout(r, 250));' +
      ' const groups = Array.from(document.querySelectorAll(".step-fold"));' +
      ' for (const g of groups) { if (!g.hasAttribute("data-open")) g.click(); }' +
      ' await new Promise((r) => setTimeout(r, 250));' +
      ' const cards = Array.from(document.querySelectorAll(".tool-card"));' +
      ' const last = cards[cards.length - 1];' +
      ' if (last) {' +
      '   const head = last.querySelector(".tool-head");' +
      '   if (!last.classList.contains("open") && head) head.click();' +
      '   last.scrollIntoView({ block: "center" });' +
      ' }' +
      ' await new Promise((r) => setTimeout(r, 400));' +
      ' const rect = last ? last.getBoundingClientRect() : null;' +
      ' const chain = [];' +
      ' for (let node = last; node && node.nodeType === 1; node = node.parentElement) {' +
      '   const style = getComputedStyle(node);' +
      '   chain.push(node.className + " | display=" + style.display + " h=" + Math.round(node.getBoundingClientRect().height));' +
      '   if (chain.length > 8) break;' +
      ' }' +
      ' return { groups: groups.length, rect: rect === null ? null : { top: Math.round(rect.top), height: Math.round(rect.height) }, opened: last ? last.classList.contains("open") : false, chain };',
  )
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
    writeFileSync(resultPath, JSON.stringify({ probe, shotProbe, shot }, null, 2), 'utf8')
  }
  app.exit(0)
}

main().catch((error) => fail('main', error))
