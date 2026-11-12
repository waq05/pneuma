process.on('unhandledRejection', () => {})

/**
 * 正文列宽拖拽的真机探针（2026-11-10 报障：会话区大小拖不动，只有输入框在变；2026-11-11 修活）。
 *
 * ## 量的是三件事
 *
 *   G 初始几何：`.thread-main` / `.chat-inner` / `.composer-zone` / `.composer` 的左右缘，
 *     根上 `--dsc-thread-max` 与 `--dsc-thread-user-max` 的取值，正文列与输入框是否同宽。
 *   H 两条拖拽条：`.thread-handle` 的矩形、计算样式（宽/opacity/pointer-events），
 *     以及**矩形中心点上真正接住鼠标的元素是谁**（elementFromPoint）。
 *   I 拖动一遍（左把手向外 200px）：拖完再量一次，看正文列宽与输入框宽各变了多少。
 *
 * ## 修了什么（修之前它是空转）
 *
 * 旧版把三段读数都打印出来了，然后 `process.exit(0)`：拖得动拖不动一样绿。现在每条都配判据：
 *
 *   1. **把手真能接鼠标**：左右各一个 `.thread-handle`，`pointer-events: auto`、opacity 1，
 *      宽 12px，且矩形中心点上 `elementFromPoint` 命中的元素属于把手本体（旧报障就是「拖不动」）；
 *   2. **列宽本来是被限住的**：`--dsc-thread-user-max` 为空、`--dsc-thread-max` 是 `ch` 单位，
 *      正文列宽 < 会话区宽（还有得拖）；
 *   3. **拖就变宽**：左把手向外拖 200px 之后，`.chat-inner` 宽增加 ≥ 150px（实测 +400：列居中，
 *      一边挪 200 是两边一起撑开）；
 *   4. **正文行跟着变宽**：`.entry-text` 增加 ≥ 150px（只改输入框不改正文，正是报障描述的那一半）；
 *   5. **输入框也一起变宽**：`.composer` 增加 ≥ 150px，且拖完与正文行同宽（差 ≤ 8px）；
 *   6. **窗口没被拉宽**：`window.innerWidth` 不变（±1px）；
 *   7. **选择落进令牌**：拖完 `--dsc-thread-user-max` 有值，且等于 `--dsc-thread-max`。
 *
 * ## 纵向：把手只铺会话区（2026-11-12 报障）
 *
 * 报障原话：「这个拖动会话区大小的竖条，不要低于输入框的上沿」。旧样式里把手是
 * `top:0; bottom:0`（铺满整个 `.thread-zone`），而那一层下半截就是输入卡片与状态栏，
 * 于是列缘外那条高亮竖条画到了输入框旁边，看着像输入框的边框。现在底边停在 `.composer`
 * 上沿，距离由 ThreadResizer 量出来写进 `--dsc-thread-handle-bottom`。这一段补的判据：
 *
 *   V1 变量量出来了，且等于「层底到输入框上沿」；
 *   V2 把手底边不越过输入框上沿（报障那条本身）；
 *   V3 底边贴着输入框上沿（差 ≤ 2px，不是缩得太高、留出一大段空白）；
 *   V4 顶边仍在正文区顶上（会话区整段还能拖）；
 *   V5 把手还有足够长度（≥ 200px，不是被压成一条抓不住）；
 *   V6 拖动时高亮落点是被夹过的百分比（10%~90%），不会整条落到盒子外；
 *   V7 高亮竖条的化开区（上下各 36px）也压在输入框上沿之上。
 *
 * 产物：`_thread-handle-bottom.png`（把手底边 + 输入框上沿那一段的裁剪截图，拖动中拍的，
 * 高亮竖条贴着底边亮着）。
 *
 * ## 负向自检
 *
 * `PROBE_MUTATE=dead`：给 `.thread-handle` 加 `pointer-events: none`（复刻「拖不动」），
 * 判据 1 与「拖动生效」那几条当场红。
 *
 * `PROBE_MUTATE=full`：把 `.thread-handle` 的 `bottom` 压回 0（复刻 2026-11-12 报障的铺满整层），
 * V2 / V3 当场红。
 *
 * 运行：node desktop/shots/_verify-thread-drag.mjs
 *      PROBE_SIZE=2396x1527 node desktop/shots/_verify-thread-drag.mjs   # 复现报障时的窗口尺寸
 * 产物：`_thread-before.png` / `_thread-after.png`
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  assert, connectCdp, finish, launchDesktop, makeHome, requireScene, sleep, startFakeLlm, teardown,
} from './_probe-kit.mjs'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const fakePort = 18991
const debugPort = 9367
const sessionId = 'thread-demo'

const home = makeHome({
  shots,
  name: '_verify-thread-home',
  dirs: ['sessions/demo', 'usage'],
  config: [
    'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
    '    displayName: 自检假端点',
    `    baseURL: http://127.0.0.1:${String(fakePort)}/v1`,
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:', '      - id: fake-code', '        name: Fake Code',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'),
})

const now = Date.now()
const file = join(home.dsc, 'sessions', 'demo', `${sessionId}.jsonl`)
writeFileSync(file, [
  { type: 'meta', id: sessionId, cwd: root, createdAt: now - 120000 },
  { type: 'user', text: '这是一段测试正文，看看列宽拖不拖得动。', ts: now - 110000 },
  {
    type: 'assistant',
    text: '好，这一段够长了吗？再补一句，让正文列有内容可以量宽度。',
    reasoning: '',
    ts: now - 100000,
  },
].map((line) => JSON.stringify(line)).join('\n') + '\n')

const fake = await startFakeLlm({
  shots,
  file: '_verify-code-fake-llm.mjs',
  port: fakePort,
  env: { DSC_FAKE_KEY: 'sk-selfcheck-fake' },
})
const desktop = launchDesktop({
  root,
  home: home.home,
  dsc: home.dsc,
  userData: home.userData,
  debugPort,
  extraEnv: { DSC_RESUME_SESSION: file, DSC_NO_EXTERNAL_OPEN: '1' },
})

/** 一段通用的几何量测脚本。 */
const GEOMETRY = `
  const rectOf = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    return { left: Math.round(rect.left), right: Math.round(rect.right), w: Math.round(rect.width) }
  }
  const varOf = (node, name) => node === null ? null : getComputedStyle(node).getPropertyValue(name).trim()
  const rootNode = document.documentElement
  const inner = document.querySelector('.chat-inner')
  const composer = document.querySelector('.composer')
  return {
    win: { w: window.innerWidth, h: window.innerHeight },
    thread: rectOf('.thread-main'),
    inner: rectOf('.chat-inner'),
    zone: rectOf('.composer-zone'),
    composer: rectOf('.composer'),
    entryText: rectOf('.entry-text'),
    vars: {
      rootMax: varOf(rootNode, '--dsc-thread-max'),
      rootUser: varOf(rootNode, '--dsc-thread-user-max'),
      innerMax: varOf(inner, '--dsc-thread-max'),
      composerMax: varOf(composer, '--dsc-thread-max'),
    },
  }
`

const HANDLES = `
  const handles = [...document.querySelectorAll('.thread-handle')].map((node) => {
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const cx = Math.round(rect.left + rect.width / 2)
    const cy = Math.round(rect.top + rect.height / 2)
    const hit = document.elementFromPoint(cx, cy)
    return {
      side: node.getAttribute('data-side'),
      rect: { left: Math.round(rect.left), top: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height), cx, cy },
      style: { opacity: style.opacity, pointerEvents: style.pointerEvents, cursor: style.cursor, zIndex: style.zIndex },
      hit: hit === null ? null : (hit.className || hit.tagName).toString().slice(0, 60),
      isHandle: hit !== null && hit.closest('.thread-handle') !== null,
    }
  })
  return { count: handles.length, handles }
`

let cdp = null
try {
  cdp = await connectCdp({ port: debugPort, log: desktop.log })
  const { evaluate, send: cdpSend } = cdp

  // 复现报障时的窗口尺寸：PROBE_SIZE=2396x1527 node ...
  const probeSize = process.env.PROBE_SIZE
  if (probeSize !== undefined && probeSize !== '') {
    const [width, height] = probeSize.split('x').map(Number)
    await cdpSend('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await sleep(900)
  }

  const booted = await requireScene(evaluate, {
    name: '会话打开且拖拽把手在 DOM 里',
    timeoutMs: 40000,
    script: `
      return {
        ok: document.querySelector('.composer textarea') !== null
          && document.querySelector('.chat-inner .entry-row') !== null
          && document.querySelectorAll('.thread-handle').length === 2,
        rows: document.querySelectorAll('.chat-inner .entry-row').length,
        handles: document.querySelectorAll('.thread-handle').length,
      }
    `,
  })
  if (!booted.ok) {
    teardown([{ close: () => cdp?.close() }, desktop, fake, home])
    finish('_verify-thread-drag')
  }
  await sleep(900)

  // 负向自检：把「拖不动」注入回去（把手不接鼠标）。
  if (process.env.PROBE_MUTATE === 'dead') {
    await evaluate(`
      const style = document.createElement('style')
      style.textContent = '.thread-handle { pointer-events: none !important; }'
      document.head.appendChild(style)
      await new Promise((r) => setTimeout(r, 300))
      return true
    `)
    console.log('负向自检：.thread-handle 已改成 pointer-events: none（应当拖不动）')
  }

  // 负向自检：把「铺满整层」注入回去（复刻 2026-11-12 报障），V2/V3 应当当场红。
  if (process.env.PROBE_MUTATE === 'full') {
    await evaluate(`
      const style = document.createElement('style')
      style.textContent = '.thread-handle { bottom: 0 !important; }'
      document.head.appendChild(style)
      await new Promise((r) => setTimeout(r, 300))
      return true
    `)
    console.log('负向自检：.thread-handle 已改回 bottom: 0（把手应当越过输入框上沿）')
  }

  const before = await evaluate(GEOMETRY)
  const handleInfo = await evaluate(HANDLES)
  console.log('G-before', JSON.stringify(before))
  console.log('H-handles', JSON.stringify(handleInfo))
  const shotBefore = await cdpSend('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, '_thread-before.png'), Buffer.from(shotBefore.data, 'base64'))

  const handles = handleInfo.handles ?? []
  const left = handles.find((item) => item.side === 'left')
  const right = handles.find((item) => item.side === 'right')
  assert('左右两条把手都在，且都能接住鼠标（pointer-events 不是 none）',
    handles.length === 2 && left !== undefined && right !== undefined
    && handles.every((item) => item.style.pointerEvents === 'auto' && item.isHandle === true),
    JSON.stringify(handles.map((item) => ({ side: item.side, hit: item.hit, pe: item.style.pointerEvents, isHandle: item.isHandle }))))
  assert('把手看得见（opacity 1、宽 12px）',
    handles.every((item) => Number(item.style.opacity) === 1 && item.rect.w === 12),
    JSON.stringify(handles.map((item) => ({ side: item.side, opacity: item.style.opacity, w: item.rect.w }))))

  assert('初始列宽是被限住的：还没选过宽度（--dsc-thread-user-max 为空）',
    before.vars.rootUser === '', `--dsc-thread-user-max=${JSON.stringify(before.vars.rootUser)}`)
  assert('初始列宽按 ch 令牌算，且比会话区窄（还有得拖）',
    /ch$/.test(String(before.vars.rootMax)) && before.inner !== null && before.thread !== null
    && before.inner.w < before.thread.w - 100,
    `--dsc-thread-max=${String(before.vars.rootMax)} inner=${String(before.inner?.w)} thread=${String(before.thread?.w)}`)

  /* ── I：拖左把手向外 200px ── */
  if (left === undefined) {
    assert('拖拽：找到左把手', false, '没有左把手，跳过拖动')
  } else {
    const x0 = left.rect.cx
    const y0 = left.rect.cy
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 })
    await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 10; step += 1) {
      await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 - step * 20, y: y0, button: 'left', buttons: 1 })
      await sleep(40)
    }
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 - 200, y: y0, button: 'left', clickCount: 1 })
    await sleep(800)

    const after = await evaluate(GEOMETRY)
    console.log('I-after', JSON.stringify(after))
    const delta = {
      inner: (after.inner?.w ?? 0) - (before.inner?.w ?? 0),
      entryText: (after.entryText?.w ?? 0) - (before.entryText?.w ?? 0),
      composer: (after.composer?.w ?? 0) - (before.composer?.w ?? 0),
      window: after.win.w - before.win.w,
      rootUser: after.vars.rootUser,
    }
    console.log('I-delta', JSON.stringify(delta))

    assert('拖动生效：正文列宽增加 ≥ 150px（报障时这里是 0）', delta.inner >= 150, `+${String(delta.inner)}px`)
    assert('正文行跟着变宽 ≥ 150px（只改输入框不改正文就是报障那一半）',
      delta.entryText >= 150, `+${String(delta.entryText)}px`)
    assert('输入框也一起变宽 ≥ 150px', delta.composer >= 150, `+${String(delta.composer)}px`)
    assert('拖完正文列与输入框同宽（列 = .chat-inner，差 ≤ 8px）',
      after.inner !== null && after.composer !== null
      && Math.abs(after.inner.w - after.composer.w) <= 8,
      `inner=${String(after.inner?.w)} composer=${String(after.composer?.w)}`)
    assert('拖动没把窗口拉宽（只改列宽）', Math.abs(delta.window) <= 1, `窗口变化 ${String(delta.window)}px`)
    assert('用户的选择落进了令牌：--dsc-thread-user-max 有值且等于 --dsc-thread-max',
      after.vars.rootUser !== '' && after.vars.rootUser === after.vars.rootMax,
      `user=${JSON.stringify(after.vars.rootUser)} max=${JSON.stringify(after.vars.rootMax)}`)

    const shotAfter = await cdpSend('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(shots, '_thread-after.png'), Buffer.from(shotAfter.data, 'base64'))
    assert('两张几何截图都落盘了',
      (shotBefore.data ?? '').length > 1000 && (shotAfter.data ?? '').length > 1000,
      `${String((shotBefore.data ?? '').length)} / ${String((shotAfter.data ?? '').length)} 字节`)
  }

  /* ── V：把手纵向只铺会话区（底边停在输入框上沿） ── */
  const vertical = await evaluate(`
    const handle = document.querySelector('.thread-handle[data-side="left"]')
    const composer = document.querySelector('.composer')
    const zone = document.querySelector('.thread-zone')
    const chat = document.querySelector('.chat')
    if (handle === null || composer === null || zone === null) return { ok: false }
    const h = handle.getBoundingClientRect()
    const c = composer.getBoundingClientRect()
    const z = zone.getBoundingClientRect()
    const chatBox = chat === null ? null : chat.getBoundingClientRect()
    return {
      ok: true,
      cx: Math.round(h.left + h.width / 2),
      handle: { top: Math.round(h.top), bottom: Math.round(h.bottom), h: Math.round(h.height) },
      composerTop: Math.round(c.top),
      composerLeft: Math.round(c.left),
      composerW: Math.round(c.width),
      chatTop: chatBox === null ? null : Math.round(chatBox.top),
      bottomVar: zone.style.getPropertyValue('--dsc-thread-handle-bottom').trim(),
      expectVar: Math.round(z.bottom - c.top),
    }
  `)
  console.log('V-geometry', JSON.stringify(vertical))
  const vOk = vertical.ok === true
  const vHandle = vertical.handle ?? { top: 0, bottom: 0, h: 0 }
  assert('V1 底边距离是量出来的：--dsc-thread-handle-bottom = 层底到输入框上沿',
    vOk && vertical.bottomVar === `${String(vertical.expectVar)}px`,
    `var=${JSON.stringify(vertical.bottomVar)} 期望=${String(vertical.expectVar)}px`)
  assert('V2 把手底边不越过输入框上沿（报障那条）',
    vOk && vHandle.bottom <= vertical.composerTop + 1,
    `handleBottom=${String(vHandle.bottom)} composerTop=${String(vertical.composerTop)}`)
  assert('V3 底边贴着输入框上沿（差 ≤ 2px，没有缩出一段空白）',
    vOk && Math.abs(vertical.composerTop - vHandle.bottom) <= 2,
    `差 ${String(Math.abs(vertical.composerTop - vHandle.bottom))}px`)
  assert('V4 顶边仍在正文区顶上（会话区整段还能拖）',
    vOk && vertical.chatTop !== null && Math.abs(vHandle.top - vertical.chatTop) <= 1,
    `handleTop=${String(vHandle.top)} chatTop=${String(vertical.chatTop)}`)
  assert('V5 把手还够长（≥ 200px，没被压成一条抓不住）', vOk && vHandle.h >= 200,
    `高 ${String(vHandle.h)}px`)
  assert('V7 高亮竖条的化开区（上下各 36px）也压在输入框上沿之上',
    vOk && vHandle.h * 0.9 + 36 <= vHandle.h,
    `0.9×${String(vHandle.h)}+36 = ${String(Math.round(vHandle.h * 0.9 + 36))} vs ${String(vHandle.h)}`)

  /* 拖动中拍一张：指针按在会把热区拖到的最下沿（输入框里面），看高亮竖条停在哪。 */
  if (vOk) {
    const pillX = vertical.cx
    const pillY0 = Math.round((vHandle.top + vHandle.bottom) / 2)
    const pillY1 = vertical.composerTop + 40
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pillX, y: pillY0 })
    await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: pillX, y: pillY0, button: 'left', clickCount: 1 })
    await sleep(80)
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pillX, y: pillY1, button: 'left', buttons: 1 })
    await sleep(260)
    const pill = await evaluate(`
      const handle = document.querySelector('.thread-handle[data-side="left"]')
      if (handle === null) return { ok: false }
      const h = handle.getBoundingClientRect()
      return {
        ok: true,
        y: handle.style.getPropertyValue('--dsc-handle-y').trim(),
        h: Math.round(h.height),
      }
    `)
    console.log('V-pill', JSON.stringify(pill))
    const pctValue = Number.parseFloat(String(pill.y).replace('%', ''))
    assert('V6 拖动时高亮落点夹在热区里侧（10%~90% 的百分比，不会整条落到盒子外）',
      pill.ok === true && /%$/.test(String(pill.y)) && pctValue >= 10 && pctValue <= 90,
      JSON.stringify(pill.y))

    const clip = {
      x: Math.max(0, vertical.composerLeft - 130),
      y: Math.max(0, vHandle.bottom - 200),
      width: Math.min(620, vertical.composerW + 170),
      height: 360,
      scale: 1,
    }
    const shotPlain = await cdpSend('Page.captureScreenshot', { format: 'png', clip })
    writeFileSync(join(shots, '_thread-handle-bottom.png'), Buffer.from(shotPlain.data, 'base64'))
    // 第二张只给「把手盒子」描一圈虚线，方便肉眼核对底边与输入框上沿对齐（仅截图用，不留痕）。
    await evaluate(`
      const style = document.createElement('style')
      style.setAttribute('data-probe-annotate', '1')
      style.textContent = '.thread-handle { outline: 1px dashed #e5484d !important; background: rgb(229 72 77 / 0.06) !important; }'
      document.head.appendChild(style)
      await new Promise((r) => setTimeout(r, 120))
      return true
    `)
    const shotMarked = await cdpSend('Page.captureScreenshot', { format: 'png', clip })
    writeFileSync(join(shots, '_thread-handle-bottom-marked.png'), Buffer.from(shotMarked.data, 'base64'))
    await evaluate(`
      const node = document.querySelector('style[data-probe-annotate="1"]')
      if (node !== null) node.remove()
      return true
    `)
    await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pillX, y: pillY1, button: 'left', clickCount: 1 })
    await sleep(200)
    assert('V8 两张裁剪截图都落盘了（原样 + 描边）',
      (shotPlain.data ?? '').length > 1000 && (shotMarked.data ?? '').length > 1000,
      `${String((shotPlain.data ?? '').length)} / ${String((shotMarked.data ?? '').length)} 字节`)
  }
} finally {
  if (process.env.PROBE_KEEP_HOME === '1') home.cleanup = () => {}
  teardown([{ close: () => cdp?.close() }, desktop, fake, home])
  await sleep(300)
}

finish('_verify-thread-drag')
