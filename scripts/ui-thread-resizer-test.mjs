/**
 * 正文列宽那条拖拽条（`ui-shell/src/ui-primitives/thread-resizer.tsx` + `panels.ts`）的探针。
 *
 * 三组断言：
 *
 *   1. **纯逻辑**（`panels.ts`，Node 类型擦除直读；`localStorage` / `getComputedStyle` /
 *      `document` 三个 DOM 面用桩顶上——这几个函数本来就把 DOM 当环境，值得单独钉的是夹取数学
 *      与落盘语义）；
 *   2. **CSS 契约**：空态正文列必须撑满列宽（`width: 100%`）、把手几何（列缘外 24px、12px 热区、
 *      窄窗口的 `min()` 兜底）与 `--dsc-thread-max` 的消费者没被换掉；
 *   3. **量算契约**：`measure()` 量的是 `.chat-inner` 的真实矩形——所以那条 `width: 100%` 是它的
 *      前提，改一处必须动另一处。这一组把「空态下把手压在输入框上、怎么拖都不动」钉在结构上。
 *
 * 用户报障与实机对照（1440×900，把开场便条改短成用户那台机器的样子）：
 *
 *   | | 列宽 | colStart | 左把手 x | 与输入框（x 572..1105） |
 *   | --- | --- | --- | --- | --- |
 *   | 修前（无 width:100%） | 370 | 396 | 597 | **落在框里** |
 *   | 修后（width:100%） | 533 = 76ch | 315 | 516 | 离框左缘 44px |
 *
 * 空态下 `.chat-inner` 是 `margin: 0 auto` 的 flex 子项：欢迎语比 76ch 窄时它按内容宽收缩
 * （auto 外边距抢在 `align-items: stretch` 之前把余量吃光），于是 ① 宽度不再由
 * `--dsc-thread-max` 决定——拖动改的正是这个变量，列不动、把手也不动（「卡住」）；
 * ② 量算量到的是「内容边」而不是列缘——两条把手落在版心，高亮条横穿整格高度压进输入框。
 *
 * 运行：node scripts/ui-thread-resizer-test.mjs（读的是源码与样式表，不需要先编译）
 *
 * @module dsc/scripts/ui-thread-resizer-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
}

// ── [1] 纯逻辑：夹取数学与落盘语义（panels.ts）────────────────────────────────
console.log('[1] 面板尺寸的纯逻辑（panels.ts）')
{
  // 三个 DOM 面用桩顶上：panels.ts 只在函数体里摸它们，模块加载不需要。
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  const rootVars = new Map()
  globalThis.document = {
    documentElement: {
      style: {
        setProperty: (name, value) => rootVars.set(name, String(value)),
        removeProperty: (name) => rootVars.delete(name),
      },
    },
  }
  /** 样式表读数的桩：默认一律空串（走 fallback），要哪根就给哪根。 */
  let styleVars = {}
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => styleVars[name] ?? '',
  })

  const panels = await import(new URL('../ui-shell/src/ui-primitives/panels.ts', import.meta.url).href)

  check('夹取区间是常量（侧栏 200–420）', panels.SIDEBAR_MIN === 200 && panels.SIDEBAR_MAX === 420)
  check(
    '正文列下限 480px、两侧预算 80px',
    panels.THREAD_MIN === 480 && panels.THREAD_EDGE_BUDGET === 80,
    `${String(panels.THREAD_MIN)} / ${String(panels.THREAD_EDGE_BUDGET)}`,
  )
  check(
    '停靠面板三档与桌面渲染层同一组数字',
    panels.DOCK_MIN_WIDTH === 300 && panels.DOCK_MAX_WIDTH === 820 && panels.DOCK_DEFAULT_WIDTH === 420,
  )
  check('存档读回的天花板挡脏值（3200）', panels.STORED_MAX === 3200)
  check(
    'localStorage 键与桌面渲染层同名（切界面时宽度延续）',
    panels.PANEL_KEYS.threadWidth === 'dsc.threadWidth' &&
      panels.PANEL_KEYS.sidebarWidth === 'dsc.sidebarWidth' &&
      panels.PANEL_KEYS.dockWidth === 'dsc.dockWidth',
    JSON.stringify(panels.PANEL_KEYS),
  )

  // 轨道宽 = 回合刻度条 + 滚动条：拖宽上限要扣掉它，否则正文会伸到刻度条底下
  styleVars = { '--dsc-jump-lane': '36px', '--dsc-scrollbar-w': '5px' }
  check('右缘轨道宽 = 刻度条 36 + 滚动条 5', panels.readRightRailPx() === 41, String(panels.readRightRailPx()))
  styleVars = { '--dsc-jump-lane': '40px', '--dsc-scrollbar-w': '8px' }
  check('轨道宽从样式表现读（tokens.css 改了这里跟着变）', panels.readRightRailPx() === 48, String(panels.readRightRailPx()))
  styleVars = {}
  check('读不到时落回 36 + 5', panels.readRightRailPx() === 41)
  check('侧栏默认宽读不到时是 237', panels.readSidebarDefaultPx() === 237)
  styleVars = { '--dsc-sidebar-w': '300px' }
  check('侧栏默认宽读得到时用读到的', panels.readSidebarDefaultPx() === 300)

  check('没存过 → null', panels.readStoredPx('k', 200, 420) === null)
  panels.writeStoredPx('k', 300)
  check('存了 300，区间内读得回来', panels.readStoredPx('k', 200, 420) === 300)
  check('越界当没有（存坏了不该把面板挤没）', panels.readStoredPx('k', 400, 420) === null)
  store.set('bad', 'abc')
  check('非数字当没有', panels.readStoredPx('bad', 0, 100) === null)
  panels.writeStoredPx('k', null)
  check('传 null = 复位（删键，回到样式表默认）', store.has('k') === false)

  check('开关缺省是关', panels.readStoredFlag('flag') === false)
  panels.writeStoredFlag('flag', true)
  check('开关写 1 读回 true', panels.readStoredFlag('flag') === true && store.get('flag') === '1')
  panels.writeStoredFlag('flag', false)
  check('开关写 0 读回 false（不是「没存过」）', panels.readStoredFlag('flag') === false && store.get('flag') === '0')

  panels.setRootVar('--dsc-x', '12px')
  check('写根变量', rootVars.get('--dsc-x') === '12px')
  panels.setRootVar('--dsc-x', null)
  check('传 null = 撤掉行内值（回样式表）', rootVars.has('--dsc-x') === false)

  // 拖动路径的算术：宽度 = 基准 + 方向 × 位移。方向常量在调用处（app.tsx / thread-resizer.tsx），
  // 这里钉它导出的那两组：面板下限/上限是夹取函数唯一的输入。
  const clamp = (px, min, max) => Math.min(max, Math.max(min, px))
  check('夹取：下越界抬到 480、上越界压到上限', clamp(100, panels.THREAD_MIN, 1100) === 480 && clamp(2000, panels.THREAD_MIN, 1100) === 1100)
}

// ── [2] CSS 契约：空态列宽 + 把手几何 ────────────────────────────────────────
console.log('[2] 样式表里的几何契约')
{
  const shellCss = read('ui-shell/src/styles.css')
  const views = read('ui-shell/src/legacy/views.css')
  const legacy_ = views

  // 空态正文列：必须撑满列宽（这是「拖动有效 / 量算准」的前提）
  const emptyInner = /\.thread-main-empty \.chat-inner \{[^}]*width: 100%[^}]*\}/.exec(shellCss)
  check('空态正文列有 width: 100%（宽度交还给 --dsc-thread-max）', emptyInner !== null, emptyInner?.[0])
  check(
    '这条规则带上了原委（收缩到内容宽 → 拖不动 / 量错）',
    /收缩到内容宽|卡住|内容边/.test(
      shellCss.slice(Math.max(0, shellCss.indexOf('.thread-main-empty .chat-inner { width') - 900), shellCss.indexOf('.thread-main-empty .chat-inner { width')),
    ),
  )
  // 触发条件本身还在（说明这条 width 是补丁而不是替代品）
  check(
    '空态那两格仍是 flex 列（触发条件没被删掉）',
    /\.thread-main-empty \.chat,\s*\n\.thread-main-empty \.chat-inner \{[^}]*display: flex[^}]*flex-direction: column/.test(shellCss),
  )
  // 与它配对的那条 legacy 规则：auto 外边距居中 + max-width 说了算
  check(
    'legacy 的 .chat-inner 仍是 margin: 0 auto + max-width: var(--dsc-thread-max)',
    /\.chat-inner \{[^}]*margin: 0 auto;[^}]*max-width: var\(--dsc-thread-max\)/.test(legacy_),
  )

  // 把手几何
  check('.thread-handle 是 12px 热区、col-resize、独占一档 z', /\.thread-handle \{[^}]*cursor: col-resize;[^}]*width: 12px;[^}]*z-index: var\(--dsc-z-handle\)/.test(legacy_))
  check(
    '左把手内缘落在列左缘外 24px（translateX(-100%) 后 left 是右缘）',
    /\.thread-handle\[data-side='left'\] \{[^}]*left: calc\(var\(--dsc-thread-col-start, 50%\) - 24px\);[^}]*transform: translateX\(-100%\)/.test(legacy_),
  )
  check(
    '右把手内缘落在列右缘外 24px',
    /\.thread-handle\[data-side='right'\] \{[^}]*left: calc\(var\(--dsc-thread-col-end, 50%\) \+ 24px\)/.test(legacy_),
  )
  check(
    '窄窗口下热区自己收窄（min() 兜底，不会越到隔壁去）',
    (legacy_.match(/width: min\(12px, calc\(/g) ?? []).length === 2,
    String((legacy_.match(/width: min\(12px, calc\(/g) ?? []).length),
  )
  check('高亮条是 2px 竖条、静息透明', /\.thread-handle::after \{[^}]*width: 2px/.test(legacy_) && /\.thread-handle::after \{[^}]*opacity: 0/.test(legacy_))
  check('hover 与拖动才亮', /\.thread-handle:hover::after,\s*\n\.thread-handle\[data-dragging\]::after \{\s*\n\s*opacity: 1/.test(legacy_))

  // --dsc-thread-max 的消费者：正文列与输入区（两处同宽才是「对齐」）
  const consumers = (read('ui-shell/src/legacy/views.css') + shellCss).match(/max-width: var\(--dsc-thread-max\)/g) ?? []
  check('正文列与输入区都读 --dsc-thread-max（≥2 处）', consumers.length >= 2, String(consumers.length))
  check('输入区的同宽规则打在槽条目里面的元素上', /\.composer-zone > \.slot-entry > \* \{[^}]*max-width: var\(--dsc-thread-max\)/.test(shellCss))
  check('令牌表里 --dsc-thread-max 有定义（76ch）', /--dsc-thread-max: 76ch;/.test(read('ui-shell/src/legacy/tokens.css')))

  // 幽灵令牌：新加的规则里的 var 都必须在 tokens.css 里定义过（拼错会静默透明）
  const block = emptyInner?.[0] ?? ''
  const tokens = read('ui-shell/src/legacy/tokens.css')
  const ghost = [...block.matchAll(/var\((--dsc-[a-z0-9-]+)/g)]
    .map((match) => match[1])
    .filter((token) => !tokens.includes(`${token}:`))
  check('空态这条规则里没有幽灵令牌', ghost.length === 0, ghost.join('、'))
}

// ── [3] 量算契约：量的是 .chat-inner 的真实矩形 ──────────────────────────────
console.log('[3] 量算契约（thread-resizer.tsx 与 app.tsx 的接线）')
{
  const resizer = read('ui-shell/src/ui-primitives/thread-resizer.tsx')
  const app = read('ui-shell/src/ui-layout/app.tsx')

  check('两缘写进 --dsc-thread-col-start / -end 两个变量', resizer.includes("COL_START_VAR = '--dsc-thread-col-start'") && resizer.includes("COL_END_VAR = '--dsc-thread-col-end'"))
  check('量的是 .chat-inner 的 getBoundingClientRect（不是自己重算居中）', resizer.includes("zone.querySelector<HTMLElement>('.chat-inner')") && resizer.includes('getBoundingClientRect()'))
  check(
    '三路重量：ResizeObserver + 根样式 MutationObserver + window resize',
    resizer.includes('new ResizeObserver(measure)') &&
      resizer.includes("attributeFilter: ['style']") &&
      resizer.includes("window.addEventListener('resize', measure)"),
  )
  check('挂载当帧先量一次（useLayoutEffect）', /useLayoutEffect\(\(\) => \{\s*\n\s*measure\(\)/.test(resizer))
  check('拖动中每帧改变量 + 重量（把手与列缘同帧对齐）', /setRootVar\('--dsc-thread-max'[\s\S]{0,80}?measure\(\)/.test(resizer))
  check('左把手 sign = -2、右把手 sign = 2（一次位移换两倍宽度）', resizer.includes('{ ...shared, sign: -2, onCommit: props.onCommit }') && resizer.includes('{ ...shared, sign: 2, onCommit: props.onCommit }'))
  check('高亮条跟着鼠标竖向位置走', resizer.includes('trackPointerY: true'))
  check('松手才落盘（onCommit 传给 useWidthDrag）', (resizer.match(/onCommit: props\.onCommit/g) ?? []).length === 2)
  check('侧栏那条的 sign = 1（与正文两侧不同口径）', /sidebarDrag = useWidthDrag\(\{\s*\n\s*sign: 1,/.test(app))
  check('存档在启动时铺上 --dsc-thread-max（拖动路径之外的那一半）', app.includes("setRootVar('--dsc-thread-max'"))
  check('两条把手挂在 .thread-zone 里（正文列之外那一层）', app.includes('<ThreadResizer width={threadWidth} onCommit={commitThreadWidth} onReset={resetThreadWidth} />'))
  check('双击复位 = 删存档（回 76ch）', resizer.includes('onDoubleClick={props.onReset}') && app.includes('writeStoredPx(PANEL_KEYS.threadWidth, null)'))
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条失败`)
process.exit(failures === 0 ? 0 : 1)
