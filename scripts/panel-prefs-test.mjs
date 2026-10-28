/**
 * 面板几何（侧栏宽 / 正文列宽 / 右侧栏宽 / 并排审查宽 / 侧栏收起）读档的确定性测试。
 *
 * 为什么要有这一条：这五项以前只写 localStorage，而宿主每次启动、每次切工作目录都会
 * 换一个端口，localStorage 按源隔离——换端口就是一份空存储，用户拖出来的宽度每次重开
 * 都回默认（2026-10-29 报障）。修法是把它们跟别的界面偏好一起落进 settings.json，
 * 这一条盯的就是「读档这一端」：好值读得回来、坏值被丢掉（丢掉 = 用样式表默认宽，
 * 不是夹成一个用户没选过的数）。
 *
 * 跑法：node scripts/panel-prefs-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/panel-prefs-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
/** 读仓库里的源文件（接线检查用；真行为用下面的动态 import 跑）。 */
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

// 先钉住 DSC_HOME，再动态 import：prefs 的 settings.json 路径是模块求值时算出来的。
const home = mkdtempSync(join(tmpdir(), 'dsc-panel-prefs-'))
process.env.DSC_HOME = home
const { DSC_SETTINGS_JSON, readPrefs } = await import('../lib/core/prefs.js')

let passed = 0
let failed = 0

/**
 * 记一条断言。
 *
 * @param {string} name 断言名（中文，报表里直接读）
 * @param {boolean} ok 是否通过
 * @param {string} detail 失败时附上的读数
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failed += 1
  console.log(`FAIL  ${name}${detail === '' ? '' : `  <- ${detail}`}`)
}

/**
 * 造一份 settings.json。
 *
 * @param {object} doc 文件内容
 */
function writeSettings(doc) {
  mkdirSync(dirname(DSC_SETTINGS_JSON), { recursive: true })
  writeFileSync(DSC_SETTINGS_JSON, JSON.stringify(doc), 'utf8')
}

console.log('\n[1] 没写过：出厂空表')
{
  writeSettings({})
  const widths = readPrefs().ui.panelWidths
  check('缺键读出空对象（各项用样式表默认宽）', JSON.stringify(widths) === '{}', JSON.stringify(widths))
}

console.log('\n[2] 好值原样读回')
{
  writeSettings({
    ui: { panelWidths: { sidebar: 300, thread: 720, dock: 480, diff: 520, collapsed: true } },
  })
  const widths = readPrefs().ui.panelWidths
  check('侧栏宽读回', widths.sidebar === 300, String(widths.sidebar))
  check('正文列宽读回', widths.thread === 720, String(widths.thread))
  check('右侧栏宽读回', widths.dock === 480, String(widths.dock))
  check('并排审查宽读回', widths.diff === 520, String(widths.diff))
  check('侧栏收起读回', widths.collapsed === true, String(widths.collapsed))
}

console.log('\n[3] 小数四舍五入（拖拽算出来的是浮点）')
{
  writeSettings({ ui: { panelWidths: { sidebar: 300.6, dock: 419.4 } } })
  const widths = readPrefs().ui.panelWidths
  check('301 ← 300.6', widths.sidebar === 301, String(widths.sidebar))
  check('419 ← 419.4', widths.dock === 419, String(widths.dock))
}

console.log('\n[4] 脏值丢掉，不夹取（夹出来的宽度用户没选过）')
{
  writeSettings({
    ui: {
      panelWidths: { sidebar: '320', thread: -5, dock: 0, diff: 99999, collapsed: 'yes' },
    },
  })
  const widths = readPrefs().ui.panelWidths
  check('字符串不当宽度', widths.sidebar === undefined, String(widths.sidebar))
  check('负数丢掉', widths.thread === undefined, String(widths.thread))
  check('0 丢掉', widths.dock === undefined, String(widths.dock))
  check('超上限丢掉', widths.diff === undefined, String(widths.diff))
  check('非布尔的收起态丢掉', widths.collapsed === undefined, String(widths.collapsed))
  check('整份脏值读成空对象', JSON.stringify(widths) === '{}', JSON.stringify(widths))
}

console.log('\n[5] 一项脏不影响别的项')
{
  writeSettings({ ui: { panelWidths: { sidebar: 260, thread: 'x', collapsed: false } } })
  const widths = readPrefs().ui.panelWidths
  check('好的留下来', widths.sidebar === 260, String(widths.sidebar))
  check('坏的那项不在', widths.thread === undefined, String(widths.thread))
  check('collapsed=false 也认得出来（不是"缺键"）', widths.collapsed === false, String(widths.collapsed))
}

console.log('\n[6] 接线检查（读这一端之外的三处）')
{
  const { readFileSync } = await import('node:fs')
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  check('契约里有 panelWidths 一项', read('src/contract/session.ts').includes('panelWidths: PanelWidthsView'))
  check(
    '写面板几何不发回执（不然拖一下弹一句"已保存工作区名字"）',
    read('src/plugins/runtime.ts').includes("patch.panelWidths !== undefined && Object.keys(patch).length === 1"),
  )
  const panels = read('ui-shell/src/ui-primitives/panels.ts')
  check(
    'localStorage 空着时先看地址里那份、再看宿主回读',
    panels.includes('const fromBoot = bootGeometry[hostKey]') && panels.includes('const fallback = remembered[hostKey]'),
  )
  check('落盘时把整份发给宿主（宿主是整键替换的补丁语义）', panels.includes('saver?.({ ...remembered } as PanelGeometry)'))
  check('启动时灌入宿主那份', read('ui-shell/src/ui-renderer/main.tsx').includes('primePanelGeometry(loaded?.panelWidths ?? {})'))
  check('渲染前就拿到（首帧不跳一下）', read('ui-shell/src/ui-renderer/main.tsx').includes('await within(prefs, 1500)'))
}


console.log('\n[7] 面板模块的真行为（假 localStorage + 假宿主）')
{
  // 面板模块只在函数里碰 localStorage，所以可以在 Node 里直接跑真实现。
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value))
    },
    removeItem: (key) => {
      store.delete(key)
    },
  }
  const panels = await import('../ui-shell/src/ui-primitives/panels.ts')
  const { PANEL_KEYS, primePanelGeometry, readStoredPx, readStoredFlag, setPanelGeometrySaver, writeStoredPx, writeStoredFlag } = panels

  const sent = []
  setPanelGeometrySaver((geometry) => sent.push(geometry))
  primePanelGeometry({ sidebar: 300, dock: 480, collapsed: true })
  check('localStorage 空着时读宿主那份（侧栏宽）', readStoredPx(PANEL_KEYS.sidebarWidth, 200, 420) === 300, String(readStoredPx(PANEL_KEYS.sidebarWidth, 200, 420)))
  check('localStorage 空着时读宿主那份（右侧栏宽）', readStoredPx(PANEL_KEYS.dockWidth, 300, 820) === 480, String(readStoredPx(PANEL_KEYS.dockWidth, 300, 820)))
  check('侧栏收起也读得回来', readStoredFlag(PANEL_KEYS.sidebarCollapsed) === true, String(readStoredFlag(PANEL_KEYS.sidebarCollapsed)))
  check('没存过的项仍是 null（用样式表默认）', readStoredPx(PANEL_KEYS.threadWidth, 480, 3200) === null, String(readStoredPx(PANEL_KEYS.threadWidth, 480, 3200)))

  writeStoredPx(PANEL_KEYS.sidebarWidth, 260)
  check('拖完同时写 localStorage', store.get(PANEL_KEYS.sidebarWidth) === '260', String(store.get(PANEL_KEYS.sidebarWidth)))
  check('拖完把整份几何发给宿主', sent.length === 1 && sent[0].sidebar === 260 && sent[0].dock === 480, JSON.stringify(sent))
  // 优先级要拿**两个不同的值**来测：以前写完之后 localStorage 与内存副本是同一个数，
  // 删掉任何一边这条断言都照样过，等于没测。
  primePanelGeometry({ sidebar: 300 })
  store.set(PANEL_KEYS.sidebarWidth, '260')
  check('同源内先读 localStorage（260）而不是宿主那份（300）', readStoredPx(PANEL_KEYS.sidebarWidth, 200, 420) === 260, String(readStoredPx(PANEL_KEYS.sidebarWidth, 200, 420)))
  store.delete(PANEL_KEYS.sidebarWidth)
  check('localStorage 没有时读宿主那份（300）', readStoredPx(PANEL_KEYS.sidebarWidth, 200, 420) === 300, String(readStoredPx(PANEL_KEYS.sidebarWidth, 200, 420)))

  writeStoredFlag(PANEL_KEYS.sidebarCollapsed, false)
  check('收起态翻回来也记（false 不是"缺键"）', sent.at(-1).collapsed === false && readStoredFlag(PANEL_KEYS.sidebarCollapsed) === false, JSON.stringify(sent.at(-1)))

  writeStoredPx(PANEL_KEYS.threadWidth, null)
  check('复位删键（回到默认宽）', !store.has(PANEL_KEYS.threadWidth) && sent.at(-1).thread === undefined, JSON.stringify(sent.at(-1)))

  store.set(PANEL_KEYS.dockWidth, 'wide')
  primePanelGeometry({ dock: 460 })
  check('localStorage 存坏了也回落到宿主那份', readStoredPx(PANEL_KEYS.dockWidth, 300, 820) === 460, String(readStoredPx(PANEL_KEYS.dockWidth, 300, 820)))
  store.delete(PANEL_KEYS.dockWidth)

  // 宿主存了脏值：读的时候照样按本面板的区间挡掉，不能因为"宿主说的"就放行。
  primePanelGeometry({ sidebar: 9999 })
  store.delete(PANEL_KEYS.sidebarWidth)
  check('宿主那份越界也不认', readStoredPx(PANEL_KEYS.sidebarWidth, 200, 420) === null, String(readStoredPx(PANEL_KEYS.sidebarWidth, 200, 420)))
}


console.log('\n[8] 地址里带过来的那份额外保险（宿主冷启动慢时用）')
{
  // 换一个模块实例：面板模块在求值时读一次地址，所以先把 window 摆好再 import。
  globalThis.window = { location: { search: '?theme=claude&panels=sidebar:340,dock:700,collapsed:1' } }
  const boot = await import('../ui-shell/src/ui-primitives/panels.ts?boot=1')
  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value))
    },
    removeItem: (key) => {
      store.delete(key)
    },
  }
  check('侧栏宽取地址里那份', boot.readStoredPx(boot.PANEL_KEYS.sidebarWidth, 200, 420) === 340, String(boot.readStoredPx(boot.PANEL_KEYS.sidebarWidth, 200, 420)))
  check('右侧栏宽取地址里那份', boot.readStoredPx(boot.PANEL_KEYS.dockWidth, 300, 820) === 700, String(boot.readStoredPx(boot.PANEL_KEYS.dockWidth, 300, 820)))
  check('collapsed:1 读成收起', boot.readStoredFlag(boot.PANEL_KEYS.sidebarCollapsed) === true, String(boot.readStoredFlag(boot.PANEL_KEYS.sidebarCollapsed)))
  boot.primePanelGeometry({ thread: 780 })
  check('地址里没有的项回落到宿主回读', boot.readStoredPx(boot.PANEL_KEYS.threadWidth, 480, 3200) === 780, String(boot.readStoredPx(boot.PANEL_KEYS.threadWidth, 480, 3200)))
  store.set(boot.PANEL_KEYS.sidebarWidth, '260')
  check('拖过之后 localStorage 压过地址里那份', boot.readStoredPx(boot.PANEL_KEYS.sidebarWidth, 200, 420) === 260, String(boot.readStoredPx(boot.PANEL_KEYS.sidebarWidth, 200, 420)))
  delete globalThis.window
  const main = read('desktop/electron/main/index.ts')
  check('主进程把几何拼进地址', main.includes('readPanelQuery()') && main.includes("parts.push(`${key}:${String(Math.round(px))}`)"), '')
}

console.log(`\n${String(passed)}/${String(passed + failed)} 通过`)
process.exit(failed === 0 ? 0 : 1)
