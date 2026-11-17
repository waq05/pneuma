/**
 * 工作区目录图标（文件夹 ↔ 三角）的真机复验（2026-11-17 报障）。
 *
 * 报障原话：「工作区目录文件夹图标，点击展开或关闭后，一直是灰色三角，正常应该是
 * 文件夹图标变成展开的样式。」
 *
 * 为什么必须真机：纯 Node 探针只读源码文本，证明不了「鼠标点过之后 computed 成什么」。
 * 病灶就是鼠标点击之后焦点留在行上——工作区行是 `<div role="button" tabIndex={0}>`
 * （`ui-sessions/ui/ui.tsx:1016-1017`），点一下它拿到焦点且不会自己丢；旧的
 * `:focus-within` 于是恒真，三角常显、「打开的文件夹」永远被藏掉。换成
 * `:focus-visible` 之后，鼠标点击不算「键盘可见焦点」，这一行才回到设计里的样子。
 *
 * 必须用 CDP 的 `Input.dispatchMouseEvent` 发**真鼠标事件**：程序化 `.click()` 不会把
 * 焦点留在行上，复现不了这个 bug（`_verify-new-session-row.mjs` 同款写法）。
 *
 * 判据（每条都要能在报告里读成人话）：
 *   1. 侧栏那一行工作区鼠标真点一下、指针移开之后：`.folder-icon` 的 computed `display`
 *      不是 `none`，`.folder-chevron` 是 `none`（回到文件夹图标，而不是常驻三角）；
 *   2. 点完这一组是展开的（`aria-expanded="true"`），图标是打开态——按 DOM 结构判：
 *      `IconFolderOpenColor` 的 svg 三个子节点 `rect / rect / path`；
 *   3. 再点一次收起：仍是文件夹图标（`display` 不是 `none`），换成收起态（两个 `rect`）；
 *   4. 悬停（`mouseMoved`）时三角出现、文件夹图标被顶掉——这是设计里的换位，**不能判红**；
 *   5. 键盘 `Tab` 到工作区行时三角仍出现（`:focus-visible` 的键盘面不能丢）；
 *   6. 防判据空转：同一次运行里注入旧规则 `.group-row:focus-within .folder-icon{display:none}`，
 *      判据 1 必须变红；删掉注入后必须变绿。
 *
 * 另附一条便宜的真机读数据：点开/收起不改变组间顺序（组间排序的完整判据在
 * `scripts/ui-sidebar-order-test.mjs`，那条跑的是真实 `grouping.ts`）。
 *
 * 运行：node desktop/shots/_verify-sidebar-group-icons.mjs
 * 打包装的产物：DSC_PROBE_EXE=...\Pneuma.exe node desktop/shots/_verify-sidebar-group-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assert,
  connectCdp,
  finish,
  launchDesktop,
  makeHome,
  pollPage,
  requireScene,
  sleep,
  teardown,
} from './_probe-kit.mjs'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const outDir = join(shots, 'out')
const debugPort = 9381
const TITLE = '_verify-sidebar-group-icons'

mkdirSync(outDir, { recursive: true })

/**
 * 隔离 HOME 放系统临时目录（不放仓库里）：D 盘新建目录设不了完整性标签，
 * Electron 会假红。`makeHome` 会 `rm -rf` 这个目录再重建。
 */
const home = makeHome({
  shots: join(tmpdir(), 'dsc-sidebar-group-icons'),
  name: 'home',
  dirs: ['sessions', 'usage'],
  config: [
    'default:', '  provider: fake', '  model: fake-icons', 'providers:', '  fake:',
    '    displayName: 自检假端点',
    '    baseURL: http://127.0.0.1:18998/v1',
    '    apiKeyEnv: DSC_FAKE_KEY',
    '    models:', '      - id: fake-icons', '        name: Fake Icons',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'),
})

/** 与 `src/core/session.ts` 的 slugCwd 同一口径（种子文件要落在会话自己会写的那条路上）。 */
const slugCwd = (cwd) => cwd.replace(/[\\/:]+/g, '-')

const workA = join(home.work, 'alpha')
const workB = join(home.work, 'beta')
const workC = join(home.work, 'gamma')
for (const dir of [workA, workB, workC]) mkdirSync(dir, { recursive: true })

/**
 * 种子：三个工作区，`createdAt` 依次更晚。manual 档的组间顺序按「组内最早一条
 * `createdAt`」倒序，所以期望从上到下是 gamma / beta / alpha（gamma 最近才出现）。
 */
const now = Date.now()
const seed = (id, cwd, text, ageMs) => {
  const dir = join(home.dsc, 'sessions', slugCwd(cwd))
  mkdirSync(dir, { recursive: true })
  const createdAt = now - ageMs
  const lines = [
    { type: 'meta', id, cwd, createdAt },
    { type: 'user', text, ts: createdAt + 1000 },
    { type: 'assistant', text: `收到，这是 ${id}`, reasoning: '', ts: createdAt + 2000 },
  ]
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
}
seed('alpha-1', workA, 'alpha 里最老的会话', 3 * 3600_000)
seed('beta-1', workB, 'beta 里的会话', 2 * 3600_000)
seed('gamma-1', workC, 'gamma 里最新的会话', 1 * 3600_000)

// ── 起桌面 + 连 CDP ────────────────────────────────────────────────────────────
const desktop = launchDesktop({
  root,
  home: home.home,
  dsc: home.dsc,
  userData: home.userData,
  debugPort,
  // 首帧就把侧栏拉到 320px：默认 237px 也够，但宽一点取行内坐标更稳。
  extraEnv: { DSC_UI_QUERY: 'panels=sidebar:320' },
})

let cdp = null
try {
  cdp = await connectCdp({ port: debugPort, log: desktop.log })
} catch (error) {
  process.stdout.write(`FAIL 连不上 CDP：${String(error)}\n--- 宿主日志尾 ---\n${desktop.log().slice(-1500)}\n`)
  teardown([{ stop: desktop.stop }, { cleanup: home.cleanup }])
  process.exit(1)
}
const { send, evaluate, shot } = cdp

// ── 页面读数 / 鼠标 / 键盘小工具 ────────────────────────────────────────────────

/**
 * 读侧栏所有工作区行的现场。
 *
 * 每一行都带 `:hover` / `:focus-within` / `:focus-visible` 三个真值（`matches()` 直接问
 * 浏览器算出来的结果），失败时一眼能看出是「鼠标还停着」还是「焦点留在行上」。
 */
const readRows = () =>
  evaluate(`
    const rows = [...document.querySelectorAll('.sidebar .group-row')]
    return rows.map((row) => {
      const icon = row.querySelector('.folder-icon')
      const chevron = row.querySelector('.folder-chevron')
      const iconSvg = icon === null ? null : icon.querySelector('svg')
      const chevronSvg = chevron === null ? null : chevron.querySelector('svg')
      const box = row.getBoundingClientRect()
      return {
        dir: (row.querySelector('.dir')?.textContent ?? '').trim(),
        expanded: row.getAttribute('aria-expanded'),
        iconDisplay: icon === null ? 'missing' : getComputedStyle(icon).display,
        chevronDisplay: chevron === null ? 'missing' : getComputedStyle(chevron).display,
        iconChildren: iconSvg === null ? null : [...iconSvg.children].map((el) => el.tagName.toLowerCase()),
        chevronRotated: chevronSvg === null ? null : chevronSvg.classList.contains('arrow-open'),
        hover: row.matches(':hover'),
        focusWithin: row.matches(':focus-within'),
        focusVisible: row.matches(':focus-visible'),
        focused: document.activeElement === row,
        box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      }
    })
  `)

const rowOf = (rows, dir) => rows.find((row) => row.dir === dir) ?? null

/** 行内点击点：左侧 40%（别落在行尾按钮区）。 */
const rowPoint = (dir) =>
  evaluate(`
    const row = [...document.querySelectorAll('.sidebar .group-row')]
      .find((item) => ((item.querySelector('.dir')?.textContent ?? '').trim()) === ${JSON.stringify(dir)})
    if (row === undefined) return null
    const box = row.getBoundingClientRect()
    if (box.width < 40 || box.height < 8) return null
    return { x: Math.round(box.left + Math.min(box.width * 0.4, 64)), y: Math.round(box.top + box.height / 2) }
  `)

const mouseMove = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })

/** 真鼠标点击：按下 + 抬起（不移动，避免被当成拖拽）。 */
const mouseClick = async (x, y) => {
  await mouseMove(x, y)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

/** 把指针挪到正文区（离开侧栏），Hover 才会退掉。 */
const parkMouse = async () => {
  const at = await evaluate('return { x: Math.round(window.innerWidth * 0.72), y: Math.round(window.innerHeight * 0.45) }')
  await mouseMove(at.x, at.y)
}

/** 等某一行的悬停状态变成想要的值（等条件，不等时长）。 */
const waitHover = (dir, want) =>
  pollPage(
    evaluate,
    `
    const row = [...document.querySelectorAll('.sidebar .group-row')]
      .find((item) => ((item.querySelector('.dir')?.textContent ?? '').trim()) === ${JSON.stringify(dir)})
    return { ok: row !== undefined && row.matches(':hover') === ${want ? 'true' : 'false'}, hover: row === undefined ? null : row.matches(':hover') }
  `,
    { timeoutMs: 5000, intervalMs: 60 },
  )

/** 等某一行的展开真值（React 提交之后 attr 才翻面）。 */
const waitExpanded = (dir, want) =>
  pollPage(
    evaluate,
    `
    const row = [...document.querySelectorAll('.sidebar .group-row')]
      .find((item) => ((item.querySelector('.dir')?.textContent ?? '').trim()) === ${JSON.stringify(dir)})
    return { ok: row !== undefined && row.getAttribute('aria-expanded') === '${want ? 'true' : 'false'}', expanded: row === undefined ? null : row.getAttribute('aria-expanded') }
  `,
    { timeoutMs: 8000, intervalMs: 80 },
  )

/** 按一次 Tab（Chromium 在 rawKeyDown 上做焦点遍历，Playwright 同款）。 */
const pressTab = async () => {
  const event = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
}

// ── 场景：侧栏画出三行工作区 ─────────────────────────────────────────────────────
const scene = await requireScene(evaluate, {
  name: '侧栏画出 3 个工作区行（alpha / beta / gamma）且都有文件夹图标',
  timeoutMs: 90000,
  intervalMs: 300,
  script: `
    const rows = [...document.querySelectorAll('.sidebar .group-row')]
    const names = rows.map((row) => ((row.querySelector('.dir')?.textContent ?? '').trim()))
    const laidOut = rows.every((row) => {
      const box = row.getBoundingClientRect()
      return box.width > 40 && box.height > 8
    })
    const hasIcon = rows.every((row) => row.querySelector('.folder-icon') !== null && row.querySelector('.folder-chevron') !== null)
    const wanted = ['alpha', 'beta', 'gamma'].every((name) => names.includes(name))
    return { ok: rows.length >= 3 && laidOut && hasIcon && wanted, count: rows.length, names, laidOut, hasIcon }
  `,
})
if (!scene.ok) {
  process.stdout.write(`\n--- 宿主日志尾 ---\n${desktop.log().slice(-1500)}\n`)
  teardown([{ close: cdp.close }, { stop: desktop.stop }, { cleanup: home.cleanup }])
  finish(TITLE)
}

const initial = await readRows()
process.stdout.write(`\n起始侧栏：${JSON.stringify(initial.map((row) => ({ dir: row.dir, expanded: row.expanded, icon: row.iconDisplay, chevron: row.chevronDisplay })))}\n`)
/**
 * 起始顺序：当前工作区那组（宿主 cwd，跑种子时还没有会话）按设计置顶，种子三组
 * 按「首次出现时间」倒序。这里只钉种子三组的相对顺序——置顶那组叫什么取决于
 * 宿主 cwd，不该写死进判据。
 */
assert(
  '三个种子工作区按首次出现时间倒序（gamma → beta → alpha）',
  JSON.stringify(initial.map((row) => row.dir).filter((dir) => ['alpha', 'beta', 'gamma'].includes(dir)))
    === JSON.stringify(['gamma', 'beta', 'alpha']),
  JSON.stringify(initial.map((row) => row.dir)),
)

/**
 * 目标行：默认只有「当前工作区」展开，宿主 cwd 是 D:\dsc\desktop，不在这三个种子目录里
 * （`isDefaultExpanded` 见 `ui-sessions/ui/ui.tsx:1594-1597`），所以三组应当都收着。
 * 取 beta（中间那一行）；万一它不是收着的，退而取第一行收着的组，并把原因打进报告。
 */
let targetDir = 'beta'
if (rowOf(initial, targetDir)?.expanded !== 'false') {
  const fallback = initial.find((row) => row.expanded === 'false')
  if (fallback !== undefined) {
    process.stdout.write(`注意：beta 起始不是收起态（aria-expanded=${String(rowOf(initial, targetDir)?.expanded)}），改点 ${fallback.dir}\n`)
    targetDir = fallback.dir
  }
}
const targetStart = rowOf(initial, targetDir)
assert(
  `目标行「${targetDir}」起始是收起态（点一下应当展开）`,
  targetStart !== null && targetStart.expanded === 'false',
  JSON.stringify(targetStart),
)

// ── 判据 1、2：鼠标真点一下 → 文件夹图标 + 打开态 ───────────────────────────────
process.stdout.write('\n[判据 1/2] 鼠标真点一下工作区行，然后指针移开\n')
const point = await rowPoint(targetDir)
assert('取得到目标行的点击坐标（行有实际尺寸）', point !== null, JSON.stringify(point))

if (point !== null) {
  await mouseClick(point.x, point.y)
  await parkMouse()
  const hovered = await waitHover(targetDir, false)
  assert('指针移开之后这一行不再是 :hover（判据 1 不会被悬停态蒙混）', hovered.ok, JSON.stringify(hovered.last))
  const expanded = await waitExpanded(targetDir, true)
  assert('点一下之后这一组真的展开了（aria-expanded=true）', expanded.ok, JSON.stringify(expanded.last))

  const afterClick = await readRows()
  const clicked = rowOf(afterClick, targetDir)
  process.stdout.write(`  点后读数：${JSON.stringify(clicked)}\n`)

  assert(
    '[1] 点完文件夹图标可见（.folder-icon display 不是 none）',
    clicked !== null && clicked.iconDisplay !== 'none' && clicked.iconDisplay !== 'missing',
    `display=${String(clicked?.iconDisplay)}`,
  )
  assert(
    '[1] 点完三角被收起来（.folder-chevron display 是 none）',
    clicked !== null && clicked.chevronDisplay === 'none',
    `display=${String(clicked?.chevronDisplay)}`,
  )
  assert(
    '[2] 展开态用的是「打开的文件夹」图标（svg 三个子节点 rect/rect/path）',
    clicked !== null && JSON.stringify(clicked.iconChildren) === JSON.stringify(['rect', 'rect', 'path']),
    JSON.stringify(clicked?.iconChildren),
  )
  assert(
    '[2] 这一行此刻是 aria-expanded="true"',
    clicked !== null && clicked.expanded === 'true',
    String(clicked?.expanded),
  )
  if (clicked !== null) {
    await shot(join(outDir, 'sidebar-group-icons-1-clicked.png'))
    process.stdout.write(`  截图：${join(outDir, 'sidebar-group-icons-1-clicked.png')}\n`)
  }

  // ── 判据 3：再点一次收起 → 仍是文件夹图标，换成收起态 ─────────────────────────
  process.stdout.write('\n[判据 3] 再点一次收起\n')
  await mouseClick(point.x, point.y)
  await parkMouse()
  await waitHover(targetDir, false)
  const collapsed = await waitExpanded(targetDir, false)
  assert('再点一次之后这一组真的收起了（aria-expanded=false）', collapsed.ok, JSON.stringify(collapsed.last))

  const afterCollapse = await readRows()
  const shut = rowOf(afterCollapse, targetDir)
  process.stdout.write(`  收起后读数：${JSON.stringify(shut)}\n`)
  assert(
    '[3] 收起后仍是文件夹图标（display 不是 none）',
    shut !== null && shut.iconDisplay !== 'none' && shut.iconDisplay !== 'missing',
    `display=${String(shut?.iconDisplay)}`,
  )
  assert(
    '[3] 收起后换成收起态图标（svg 两个子节点 rect/rect）',
    shut !== null && JSON.stringify(shut.iconChildren) === JSON.stringify(['rect', 'rect']),
    JSON.stringify(shut?.iconChildren),
  )
  assert(
    '[3] 收起后三角仍是 none（没有常驻）',
    shut !== null && shut.chevronDisplay === 'none',
    `display=${String(shut?.chevronDisplay)}`,
  )

  // ── 判据 6（防空转）：注入旧规则，判据 1 必须红 ────────────────────────────────
  process.stdout.write('\n[判据 6 · 防空转] 注入旧的 :focus-within 规则，判据 1 必须变红\n')
  const focusState = await readRows()
  const focusRow = rowOf(focusState, targetDir)
  assert(
    '注入前：这一行仍是「鼠标点过、焦点还在行上、但不算键盘焦点」的状态',
    focusRow !== null && focusRow.focused === true && focusRow.focusWithin === true && focusRow.focusVisible === false && focusRow.hover === false,
    JSON.stringify({ focused: focusRow?.focused, focusWithin: focusRow?.focusWithin, focusVisible: focusRow?.focusVisible, hover: focusRow?.hover }),
  )
  assert(
    '注入前：判据 1 是绿的（文件夹图标可见）',
    focusRow !== null && focusRow.iconDisplay !== 'none',
    `display=${String(focusRow?.iconDisplay)}`,
  )

  await evaluate(`
    const style = document.createElement('style')
    style.id = 'probe-old-focus-within'
    style.textContent = '.group-row:focus-within .folder-icon { display: none }'
    document.head.appendChild(style)
    return document.getElementById('probe-old-focus-within') !== null
  `)
  const injected = rowOf(await readRows(), targetDir)
  assert(
    '[6] 注入旧规则后判据 1 确实变红（文件夹图标 display 变成 none）',
    injected !== null && injected.iconDisplay === 'none',
    `display=${String(injected?.iconDisplay)}`,
  )

  const removed = await evaluate(`
    document.getElementById('probe-old-focus-within')?.remove()
    return document.getElementById('probe-old-focus-within') === null
  `)
  const restored = rowOf(await readRows(), targetDir)
  assert(
    '[6] 删掉注入节点后判据 1 回到绿（display 不是 none）',
    removed === true && restored !== null && restored.iconDisplay !== 'none',
    `removed=${String(removed)} display=${String(restored?.iconDisplay)}`,
  )

  // ── 判据 4：悬停 → 三角出现、文件夹图标被顶掉（设计如此，判绿）─────────────────
  process.stdout.write('\n[判据 4] 悬停：三角换位（设计如此，不能判红）\n')
  await mouseMove(point.x, point.y)
  const hoveredNow = await waitHover(targetDir, true)
  assert('悬停确实生效（这一行 :hover 为真）', hoveredNow.ok, JSON.stringify(hoveredNow.last))
  const afterHover = await readRows()
  const hoverRow = rowOf(afterHover, targetDir)
  process.stdout.write(`  悬停读数：${JSON.stringify(hoverRow)}\n`)
  assert(
    '[4] 悬停时三角出现（.folder-chevron display 不是 none）',
    hoverRow !== null && hoverRow.chevronDisplay !== 'none' && hoverRow.chevronDisplay !== 'missing',
    `display=${String(hoverRow?.chevronDisplay)}`,
  )
  assert(
    '[4] 悬停时文件夹图标被顶掉（.folder-icon display 是 none）',
    hoverRow !== null && hoverRow.iconDisplay === 'none',
    `display=${String(hoverRow?.iconDisplay)}`,
  )
  await shot(join(outDir, 'sidebar-group-icons-2-hover.png'))
  process.stdout.write(`  截图：${join(outDir, 'sidebar-group-icons-2-hover.png')}\n`)

  // ── 判据 5：键盘 Tab 到工作区行 → 三角仍出现（:focus-visible 不能丢）───────────
  process.stdout.write('\n[判据 5] 键盘 Tab 到工作区行\n')
  await parkMouse()
  await waitHover(targetDir, false)
  await evaluate(`
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    return document.activeElement === null || document.activeElement === document.body
  `)

  let focusInfo = null
  for (let step = 0; step < 80; step += 1) {
    await pressTab()
    await sleep(40)
    focusInfo = await evaluate(`
      const active = document.activeElement
      if (active === null) return { tag: 'null', className: '', isGroupRow: false }
      return {
        tag: active.tagName.toLowerCase(),
        className: String(active.className ?? ''),
        isGroupRow: active.classList?.contains('group-row') === true,
        dir: (active.querySelector?.('.dir')?.textContent ?? '').trim(),
        focusVisible: active.matches(':focus-visible'),
      }
    `)
    if (focusInfo !== null && focusInfo.isGroupRow) break
  }
  process.stdout.write(`  焦点落点：${JSON.stringify(focusInfo)}\n`)
  assert(
    '[5] Tab 能把焦点落到某个工作区行上',
    focusInfo !== null && focusInfo.isGroupRow === true,
    JSON.stringify(focusInfo),
  )
  assert(
    '[5] 这个焦点是键盘可见焦点（:focus-visible 为真）',
    focusInfo !== null && focusInfo.focusVisible === true,
    String(focusInfo?.focusVisible),
  )

  const afterKeys = await readRows()
  const keyRow = afterKeys.find((row) => row.focused === true) ?? null
  process.stdout.write(`  键盘焦点行读数：${JSON.stringify(keyRow)}\n`)
  assert(
    '[5] 键盘焦点落在工作区行时三角仍出现（display 不是 none）',
    keyRow !== null && keyRow.chevronDisplay !== 'none' && keyRow.chevronDisplay !== 'missing',
    `display=${String(keyRow?.chevronDisplay)}`,
  )
  assert(
    '[5] 键盘焦点下文件夹图标被三角顶掉（display 是 none）',
    keyRow !== null && keyRow.iconDisplay === 'none',
    `display=${String(keyRow?.iconDisplay)}`,
  )
  await shot(join(outDir, 'sidebar-group-icons-3-keyboard.png'))
  process.stdout.write(`  截图：${join(outDir, 'sidebar-group-icons-3-keyboard.png')}\n`)

  // ── 附带读数：点开/收起不改变组间顺序 ──────────────────────────────────────────
  const finalRows = await readRows()
  assert(
    '点开/收起工作区不改变组间顺序',
    JSON.stringify(finalRows.map((row) => row.dir)) === JSON.stringify(initial.map((row) => row.dir)),
    `起始 ${JSON.stringify(initial.map((row) => row.dir))} 现在 ${JSON.stringify(finalRows.map((row) => row.dir))}`,
  )
}

// ── 收尾 ───────────────────────────────────────────────────────────────────────
teardown([{ close: cdp.close }, { stop: desktop.stop }, { cleanup: home.cleanup }])
finish(TITLE)
