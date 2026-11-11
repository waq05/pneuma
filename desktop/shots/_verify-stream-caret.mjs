process.on('unhandledRejection', () => {})

/**
 * 流式光标（那根浅棕色竖条）的真机探针（2026-11-02 报障，2026-11-11 修活）。
 *
 * ## 报障现场
 *
 * 正文左下角多出一根 6×25 的浅棕色短竖条。原因是 `.live::after { content: '▍' }`
 * 挂在块级容器上，行内伪元素被挤到下一行行首。修法是把光标删掉（见
 * `ui-shell/src/legacy/views.css` 里那一段注释）。
 *
 * 真宿主 + 真界面壳（CDP 驱动），假端点先吐思考再吐正文，界面于是有「直播中的思考行 +
 * 直播中的正文」；随后扫对话区 DOM，把 `.live` 的 `::after` 连同所有「宽 ≤ 10px、
 * 高 12–80px」的元素打出来。
 *
 * ## 修了什么（修之前它是空转）
 *
 * 旧版头注释 `:14-15` 明写「验收口径：两个 `.live` 的 `::after` 都必须是 `content: "none"`」，
 * 但正文里只有一句 `console.log('scan', …)`（`:211`），既不判定也不退出——量出什么都是绿的。
 * 现在把那条口径拆成可判的几条：
 *
 *   1. **现场**：直播中至少 2 个 `.live`（思考行 + 正文行），且其中一段文字长度 > 0；
 *   2. **光标没回来**：每个 `.live` 的 `::after` 的 `content` 是 `none` / `normal`；
 *   3. **没有第二种画法**：全页取强调色的伪元素为 0（这条兜住 `.live::before` 之类换个位置画）；
 *   4. **没有残留窄条**：对话区里「宽 ≤ 10px、高 10–80px」的元素，没有一个取强调色；
 *   5. **正文行没被伪元素挤宽/挤高**：直播正文行的宽在版心内，高度不超过 4 行（一根竖条会把
 *      行高顶成 25px 那种异常值）。
 *
 * ## 负向自检（证明它真会红）
 *
 * `PROBE_MUTATE=caret node desktop/shots/_verify-stream-caret.mjs` 会把当年那根光标注入回去
 * （`content: '▍'` + 强调色），第 2/3/4 条当场红。
 *
 * 运行：node desktop/shots/_verify-stream-caret.mjs（依赖桌面产物 desktop/out/）
 * 产物：desktop/shots/_verify-stream-caret.png
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assert, finish, launchDesktop, connectCdp, makeHome, requireScene, sleep,
  startFakeLlm, teardown,
} from './_probe-kit.mjs'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const fakePort = 18980
const debugPort = 9341

const fake = await startFakeLlm({
  shots,
  file: '_verify-stream-caret-fake-llm.mjs',
  port: fakePort,
  env: { DSC_FAKE_KEY: 'sk-selfcheck-fake' },
})
const home = makeHome({
  shots,
  name: '_verify-caret-home',
  dirs: ['sessions', 'usage'],
  config: [
    'default:', '  provider: fake', '  model: fake-bar', 'providers:', '  fake:',
    '    displayName: 自检假端点',
    `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:', '      - id: fake-bar', '        name: Fake Bar',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'),
})
const desktop = launchDesktop({
  root, home: home.home, dsc: home.dsc, userData: home.userData, debugPort,
})

let cdp = null
try {
  cdp = await connectCdp({ port: debugPort, log: desktop.log })
  const { evaluate, send } = cdp

  const scene = await requireScene(evaluate, {
    name: '输入框上屏（启动图退场）',
    timeoutMs: 30000,
    script: `
      const ready = document.querySelector('.composer textarea') !== null
      const splash = document.getElementById('boot-splash') !== null
      return { ok: ready && !splash, ready, splash }
    `,
  })
  if (!scene.ok) {
    teardown([{ close: () => cdp?.close() }, desktop, fake, home])
    finish('_verify-stream-caret')
  }

  const started = await evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const input = document.querySelector('.composer textarea')
    if (input === null) return { error: 'no textarea' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, '把后端改成 CRLF 行尾，顺便看看循环导入。')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(120)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    return { sent: true }
  `)
  assert('消息发出去了（消息没发出去后面量的是空页面）', started?.sent === true, JSON.stringify(started))

  // 等到「直播中的思考行 + 直播中的正文」同时在场：这才是报障的那一态。
  const liveScene = await requireScene(evaluate, {
    name: '两段都在直播（.think-block.live + .entry-text.live 同时在场）',
    timeoutMs: 25000,
    intervalMs: 200,
    script: `
      const think = document.querySelector('.think-block.live')
      const text = document.querySelector('.entry-text.live')
      const thinkLen = think === null ? 0 : (think.textContent ?? '').trim().length
      const textLen = text === null ? 0 : (text.textContent ?? '').trim().length
      return { ok: think !== null && text !== null && thinkLen > 0 && textLen > 0, thinkLen, textLen }
    `,
  })

  // 负向自检：把当年那根光标注入回去（PROBE_MUTATE=caret），用来证明下面几条真的会红。
  const mutated = process.env.PROBE_MUTATE === 'caret'
  if (mutated) {
    await evaluate(`
      const style = document.createElement('style')
      style.id = 'probe-mutate-caret'
      style.textContent = '.live::after { content: ' + JSON.stringify('▍') + '; color: var(--dsc-accent); }'
      document.head.appendChild(style)
      await new Promise((r) => setTimeout(r, 300))
      return true
    `)
    console.log('负向自检：已把 .live::after { content: "▍" } 注入回去（这一轮应当红）')
  }

  // 再等一拍，让采样落在稳定的一帧上（假端点故意不回 finish，界面会一直停在这一态）。
  await sleep(1200)

  const scan = await evaluate(`
    const accentHost = document.createElement('span')
    accentHost.style.color = 'var(--dsc-accent)'
    accentHost.style.backgroundColor = 'var(--dsc-accent)'
    document.body.appendChild(accentHost)
    const accentStyle = getComputedStyle(accentHost)
    const accentColor = accentStyle.color
    const accentBg = accentStyle.backgroundColor
    accentHost.remove()
    // 计算色有两种序列化：老式 rgb(1, 2, 3) 与新式 color(srgb 0.1 0.2 0.3 / 0.5)。
    // 只比前三个通道（alpha 不算），统一换算到 0–255 再比。
    const channels = (value) => {
      const numbers = String(value).match(/-?[0-9.]+/g) ?? []
      const raw = numbers.map(Number)
      const srgb = String(value).includes('srgb')
      const rgb = raw.slice(0, 3).map((n) => (srgb ? n * 255 : n))
      return rgb.length === 3 && rgb.every((n) => Number.isFinite(n)) ? rgb : null
    }
    const accent = channels(accentColor)
    const isAccent = (value) => {
      const parsed = channels(value)
      if (parsed === null || accent === null) return false
      return parsed.every((channel, index) => Math.abs(channel - accent[index]) <= 3)
    }
    const path = (el) => {
      const parts = []
      let node = el
      let depth = 0
      while (node !== null && node.nodeType === 1 && depth < 5) {
        let part = node.tagName.toLowerCase()
        if (node.id !== '') part += '#' + node.id
        const cls = (node.getAttribute('class') ?? '').trim()
        if (cls !== '') part += '.' + cls.split(/\\s+/).join('.')
        parts.unshift(part)
        node = node.parentElement
        depth += 1
      }
      return parts.join(' > ')
    }
    const describe = (el, pseudo) => {
      const rect = el.getBoundingClientRect()
      const cs = getComputedStyle(el, pseudo ?? null)
      return {
        path: path(el) + (pseudo ?? ''),
        w: Math.round(rect.width * 100) / 100,
        h: Math.round(rect.height * 100) / 100,
        left: Math.round(rect.left * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
        bg: cs.backgroundColor,
        color: cs.color,
        content: cs.content,
        accent: isAccent(cs.color) || isAccent(cs.backgroundColor),
        text: (el.textContent ?? '').slice(0, 24),
      }
    }
    const chat = document.querySelector('.chat')
    const narrow = []
    for (const el of document.querySelectorAll('.chat *')) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 10 || rect.width < 1 || rect.height < 10 || rect.height > 80) continue
      const info = describe(el, null)
      // 文字字形（例如注入标记那个 ⊕）宽度也窄，但它有可见文本、底色透明——光标没有文本。
      info.hasText = (el.textContent ?? '').trim().length > 0
      narrow.push(info)
    }
    // 伪元素单独看：content 不是 none/normal 的，取强调色的就是「换了个地方画光标」。
    const pseudos = []
    for (const el of document.querySelectorAll('.chat *')) {
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo)
        if (cs.content === 'none' || cs.content === 'normal') continue
        const info = describe(el, pseudo)
        if (!info.accent) continue
        pseudos.push(info)
      }
    }
    const liveCaret = []
    for (const el of document.querySelectorAll('.live')) {
      liveCaret.push({ ...describe(el, '::after'), hostW: Math.round(el.getBoundingClientRect().width) })
    }
    const textRow = document.querySelector('.entry-text.live')
    const textStyle = textRow === null ? null : getComputedStyle(textRow)
    return {
      accentColor, chatW: Math.round(chat?.getBoundingClientRect().width ?? 0),
      narrow, pseudos, liveCaret,
      liveText: textRow === null ? null : {
        w: Math.round(textRow.getBoundingClientRect().width),
        h: Math.round(textRow.getBoundingClientRect().height),
        lineHeight: textStyle === null ? null : textStyle.lineHeight,
        fontSize: textStyle === null ? null : textStyle.fontSize,
      },
    }
  `)

  console.log('corner', JSON.stringify({
    accentColor: scan.accentColor,
    chatW: scan.chatW,
    live: scan.liveCaret.map((item) => ({ path: item.path, content: item.content, accent: item.accent })),
    pseudos: scan.pseudos.length,
    narrow: scan.narrow.map((item) => ({ path: item.path, w: item.w, h: item.h, hasText: item.hasText, accent: item.accent })),
    liveText: scan.liveText,
  }, null, 1))

  const carets = scan.liveCaret ?? []
  const badContent = carets.filter((item) => item.content !== 'none' && item.content !== 'normal')
  const accentPseudos = scan.pseudos ?? []
  const accentBars = (scan.narrow ?? []).filter((item) => item.accent === true && item.hasText !== true)

  assert('现场：量到至少 2 个 .live（思考行 + 正文行同时直播）', carets.length >= 2, `实测 ${String(carets.length)} 个`)
  assert(
    '判据 1：每个 .live 的 ::after 都是 content: none（旧 bug 是 "▍"）',
    badContent.length === 0,
    badContent.length === 0 ? '' : JSON.stringify(badContent.map((item) => ({ path: item.path, content: item.content }))),
  )
  assert(
    '判据 2：全页没有取强调色的伪元素（挡住「换个位置再画一根」）',
    accentPseudos.length === 0,
    accentPseudos.length === 0 ? '' : JSON.stringify(accentPseudos.map((item) => item.path)),
  )
  assert(
    '判据 3：对话区没有取强调色的窄条（6×25 那种残留）',
    accentBars.length === 0,
    accentBars.length === 0 ? '' : JSON.stringify(accentBars.map((item) => ({ path: item.path, w: item.w, h: item.h }))),
  )
  const textRow = scan.liveText
  assert(
    '判据 4：直播正文行在版心内、不是被伪元素顶高的异物',
    textRow !== null && textRow.w > 200 && textRow.w <= scan.chatW + 2 && textRow.h <= 200,
    JSON.stringify(textRow),
  )

  const png = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, '_verify-stream-caret.png'), Buffer.from(png.data, 'base64'))
  assert('截图落盘（正文下方的空白处没有竖条，可目检）', (png.data ?? '').length > 1000, `${String((png.data ?? '').length)} 字节`)
} finally {
  if (process.env.PROBE_KEEP_HOME === '1') home.cleanup = () => {}
  teardown([{ close: () => cdp?.close() }, desktop, fake, home])
  await sleep(300)
}

finish('_verify-stream-caret')
