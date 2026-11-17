/**
 * 正文字号 / 正文与代码字体落地到 DOM 的确定性测试。
 *
 * 为什么要有这一条：字号的真源从「倍率」改成「px」之后，壳这一端有两处只能靠人盯——
 *   1. `--dsc-font-scale` 必须由 `fontScaleFromTextSizePx(px)` 算出来。壳里再留一份
 *      夹取逻辑，就会出现「设置页写 16px、界面按老口径画 15px」的偏差；
 *   2. 字体为空时必须 `removeProperty`，**不能写空串**。`tokens.css` 里那两条是
 *      `var(--dsc-font-text, 内置栈), 内置栈`，而自定义属性「存在但为空」时 `var()`
 *      不会走兜底，整条 `font-family` 语法非法被浏览器丢掉——界面静默退回浏览器默认字体，
 *      没有任何报错。这一条写空串也照样"看起来正常"，只能靠断言兜住。
 *
 * 跑法：node scripts/ui-font-apply-test.mjs（纯 Node，不需要 Electron）
 *
 * 真行为怎么跑起来的：`appearance.ts` 只 import 两个包面（`@dsc/ui-core` 的契约函数、
 * `@dsc/ui-primitives` 的原生桥与读色），Node 不认 `ui-shell/tsconfig.json` 的 paths。
 * 所以用 `module.registerHooks` 把这两个裸名指到 `data:` 桩上——`@dsc/ui-core` 那份桩
 * 原样再导出真的 `src/contract/fonts.ts`（被测的归一函数就是生产那份），原生桥那份桩
 * 只说「桥不在」（`applyAppearance` 立即空操作）。DOM 用记录用的假 `document`。
 *
 * @module dsc/scripts/ui-font-apply-test
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
/** 读仓库里的源文件（接线断言用；真行为走下面的动态 import）。 */
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

const stub = (source) => `data:text/javascript,${encodeURIComponent(source)}`
/** `@dsc/ui-core` 的桩：只把真契约原样转出去，归一逻辑仍是生产那一份。 */
const coreStub = stub(`export * from ${JSON.stringify(pathToFileURL(`${root}src/contract/fonts.ts`).href)}`)
/** `@dsc/ui-primitives` 的桩：原生桥缺席 + 读不到颜色（`applyAppearance` 里两段都成空操作）。 */
const primitivesStub = stub(
  'export const getHostNative = () => ({ available: false, invoke: () => Promise.resolve() })\n' +
    'export const readCssColor = () => null',
)
const aliases = { '@dsc/ui-core': coreStub, '@dsc/ui-primitives': primitivesStub }
registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = aliases[specifier]
    return target === undefined ? nextResolve(specifier, context) : { url: target, shortCircuit: true }
  },
})

// 假 DOM：只记 setProperty / removeProperty，够断言「写没写、写了什么」。
const writes = []
const rootElement = {
  dataset: {},
  style: {
    setProperty: (name, value) => {
      writes.push(['set', name, value])
    },
    removeProperty: (name) => {
      writes.push(['remove', name])
    },
  },
}
globalThis.document = { documentElement: rootElement }

// 外观镜像走 localStorage；窗口对象要在 import 之前摆好（模块求值时会读一次地址与 matchMedia）。
const store = new Map()
globalThis.window = { location: { search: '' } }
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    store.set(key, String(value))
  },
  removeItem: (key) => {
    store.delete(key)
  },
}

const { DEFAULT_APPEARANCE, applyAppearance, appearanceFromPrefs, loadCachedAppearance } = await import(
  pathToFileURL(`${root}src/packages/ui-runtime/ui/appearance.ts`).href
)
const { FONT_SIZE_PX_DEFAULT, fontScaleFromTextSizePx, normalizeFontList } = await import(
  pathToFileURL(`${root}src/contract/fonts.ts`).href
)

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

/** 清空写记录（每次 applyAppearance 之前调）。 */
function resetWrites() {
  writes.length = 0
}

/** 取一条自定义属性的声明文本（含多行值，到分号为止）；name 不带前导 `--`。 */
function cssVar(source, name) {
  const start = source.indexOf(`--${name}:`)
  if (start < 0) return ''
  return source.slice(start, source.indexOf(';', start))
}

console.log('\n[1] appearanceFromPrefs：px 是真源，老倍率只做迁移')
{
  const px = appearanceFromPrefs({ textSizePx: 16, textFontFamily: 'Noto Sans SC', codeFontFamily: 'Consolas' })
  check('textSizePx 原样带出', px.textSizePx === 16, String(px.textSizePx))
  check('正文族含空格时加引号', px.textFontFamily === '"Noto Sans SC"', px.textFontFamily)
  check('单族代码字体不带引号', px.codeFontFamily === 'Consolas', px.codeFontFamily)

  const legacyNumber = appearanceFromPrefs({ fontSize: 1.12 })
  check('只有老倍率 1.12 → 16px', legacyNumber.textSizePx === 16, String(legacyNumber.textSizePx))
  const legacyTier = appearanceFromPrefs({ fontSize: 'lg' })
  check("旧三档字符串 'lg' → 16px", legacyTier.textSizePx === 16, String(legacyTier.textSizePx))

  const empty = appearanceFromPrefs({})
  check('什么都没有 → 默认 14px', empty.textSizePx === FONT_SIZE_PX_DEFAULT, String(empty.textSizePx))
  check('字体缺键 → 空串（用内置栈）', empty.textFontFamily === '' && empty.codeFontFamily === '', JSON.stringify(empty))

  check('越界 px 夹到 22', appearanceFromPrefs({ textSizePx: 999 }).textSizePx === 22, String(appearanceFromPrefs({ textSizePx: 999 }).textSizePx))
  // 这一条要能区分「读 px」与「读老倍率」两条路：px 是坏值时走老倍率 1.35 → 19px；
  // 若误走默认档会得到 14px，两者不同才说明分叉方向对。
  const dirty = appearanceFromPrefs({ textSizePx: 'huge', fontSize: 1.35 })
  check('px 不是数字时退回老倍率（1.35 → 19px，默认档会给 14px）', dirty.textSizePx === 19, String(dirty.textSizePx))
  const dirtyFont = appearanceFromPrefs({ textFontFamily: 'Fira Code; }' })
  check('字体里的分号与花括号被剔掉', dirtyFont.textFontFamily === '"Fira Code"', dirtyFont.textFontFamily)
}

console.log('\n[2] applyAppearance：--dsc-font-scale 由 px 算出（不是自己夹的）')
{
  for (const px of [14, 12, 16, 22]) {
    resetWrites()
    applyAppearance({ ...DEFAULT_APPEARANCE, textSizePx: px })
    const written = writes.find((item) => item[0] === 'set' && item[1] === '--dsc-font-scale')
    const expected = String(fontScaleFromTextSizePx(px))
    check(`${String(px)}px → scale ${expected}`, written !== undefined && written[2] === expected, JSON.stringify(written))
  }
  resetWrites()
  applyAppearance({ ...DEFAULT_APPEARANCE, textSizePx: 16 })
  const written = writes.find((item) => item[0] === 'set' && item[1] === '--dsc-font-scale')
  check('16px 的倍率是字面量 1.1429（不是 1.14）', written !== undefined && written[2] === '1.1429', JSON.stringify(written))
}

console.log('\n[3] applyAppearance：字体为空必须删变量，非空才写')
{
  resetWrites()
  applyAppearance({ ...DEFAULT_APPEARANCE, textFontFamily: '', codeFontFamily: '' })
  const removed = writes.filter((item) => item[0] === 'remove').map((item) => item[1])
  check('正文变量空串 → removeProperty', removed.includes('--dsc-font-text'), JSON.stringify(writes))
  check('代码变量空串 → removeProperty', removed.includes('--dsc-font-code'), JSON.stringify(writes))
  const wroteEmpty = writes.some((item) => item[0] === 'set' && (item[2] === '' || item[2] === '""'))
  check('绝不把空串写进字体变量（否则整条 font-family 非法）', !wroteEmpty, JSON.stringify(writes))
  check('字体变量之外的设置照旧（data-theme 仍然写）', rootElement.dataset.theme === 'claude', JSON.stringify(rootElement.dataset))

  const fonts = appearanceFromPrefs({ textSizePx: 14, textFontFamily: 'Fira Code, Noto Sans SC', codeFontFamily: 'JetBrains Mono' })
  resetWrites()
  applyAppearance(fonts)
  const sets = writes.filter((item) => item[0] === 'set')
  const textSet = sets.find((item) => item[1] === '--dsc-font-text')
  const codeSet = sets.find((item) => item[1] === '--dsc-font-code')
  check('正文变量写的是归一后的列表', textSet !== undefined && textSet[2] === '"Fira Code", "Noto Sans SC"', JSON.stringify(textSet))
  check('代码变量写的是归一后的列表', codeSet !== undefined && codeSet[2] === '"JetBrains Mono"', JSON.stringify(codeSet))
  check('非空时不删变量', !writes.some((item) => item[0] === 'remove'), JSON.stringify(writes))
  check('归一结果与契约函数一致', textSet[2] === normalizeFontList('Fira Code, Noto Sans SC'), JSON.stringify(textSet))
}

console.log('\n[4] 镜像里只有老倍率时，首帧也按 px 落地')
{
  store.set('dsc.appearance', JSON.stringify({ themeMode: 'dark', fontSize: 'lg', density: 'compact' }))
  const cached = loadCachedAppearance()
  check("镜像 fontSize:'lg' → 16px", cached.textSizePx === 16, String(cached.textSizePx))
  check('镜像里的主题照旧生效', cached.themeMode === 'dark', cached.themeMode)
  check('镜像里没字体 → 空串', cached.textFontFamily === '' && cached.codeFontFamily === '', JSON.stringify(cached))
}

console.log('\n[5] tokens.css：用户变量在前、内置栈兜底、等宽栈垫了 CJK')
{
  const css = read('src/packages/ui-renderer/ui/styles/legacy/tokens.css')
  const ui = cssVar(css, 'dsc-font-ui')
  const uiDefault = cssVar(css, 'dsc-font-ui-default')
  const mono = cssVar(css, 'dsc-font-mono')
  const monoDefault = cssVar(css, 'dsc-font-mono-default')

  check('内置正文栈单独成 --dsc-font-ui-default', uiDefault.includes("'Segoe WPC'") && uiDefault.includes("'Microsoft YaHei'"), uiDefault.slice(0, 80))
  check('正文：用户变量排在默认栈之前', ui.indexOf('var(--dsc-font-text') >= 0 && ui.indexOf('var(--dsc-font-text') < ui.indexOf('var(--dsc-font-ui-default'), ui)
  check('正文：默认栈在用户变量后面兜底', (ui.match(/var\(--dsc-font-ui-default\)/g) ?? []).length >= 2, ui)

  check('内置等宽栈单独成 --dsc-font-mono-default', monoDefault.includes("'JetBrains Mono'"), monoDefault.slice(0, 80))
  check('等宽：用户变量排在默认栈之前', mono.indexOf('var(--dsc-font-code') >= 0 && mono.indexOf('var(--dsc-font-code') < mono.indexOf('var(--dsc-font-mono-default'), mono)
  // 注意用 lastIndexOf：`ui-monospace` 里也含 "monospace"，而真正的通用族是最后那个。
  const genericMono = monoDefault.lastIndexOf('monospace')
  check('等宽栈在 monospace 之前含中文无衬线（否则 Windows 中文落宋体）', monoDefault.includes("'Microsoft YaHei'") && monoDefault.indexOf("'Microsoft YaHei'") < genericMono, monoDefault)
  check('等宽栈的 CJK 兜底不止一种（Mac / Linux）', monoDefault.includes("'PingFang SC'") && monoDefault.includes("'Noto Sans SC'"), monoDefault)
  check('--dsc-font-kbd 没被牵连', cssVar(css, 'dsc-font-kbd').includes("'Segoe UI'"), cssVar(css, 'dsc-font-kbd'))
}

console.log('\n[6] 源码接线：壳里不再自己夹倍率，插件口认新字段')
{
  const source = read('src/packages/ui-runtime/ui/appearance.ts')
  check('--dsc-font-scale 由 fontScaleFromTextSizePx 计算', source.includes("setProperty('--dsc-font-scale', String(fontScaleFromTextSizePx(appearance.textSizePx))"), '')
  check('字体变量空串走 removeProperty', source.includes('root.style.removeProperty(name)'), '')
  check('本地 normalizeFontScale 已删', !source.includes('function normalizeFontScale'), '')
  // 旧断言是 `!source.includes('FONT_SCALE_MIN')`——这个常量已全仓不存在，永远成立，等于空转。
  // 换成「壳里不再出现倍率夹取的**代码**」：注释里提 0.85–1.35 是历史说明，不算，所以只查调用形态。
  check(
    '壳里不再有倍率夹取的代码（注释里的历史范围不算）',
    !/Math\.min\(\s*1\.35/.test(source) && !/Math\.max\(\s*0\.85/.test(source) && !source.includes('FONT_SCALE_MIN'),
    '',
  )
  check('老倍率只经 textSizePxFromLegacy 迁移', source.includes('textSizePxFromLegacy(prefs?.fontSize)'), '')

  const api = read('ui-shell/src/plugin-api.ts')
  check('AppearancePatch 新增 textSizePx', api.includes('textSizePx?: number'), '')
  check('AppearancePatch 新增两个字体字段', api.includes('textFontFamily?: string') && api.includes('codeFontFamily?: string'), '')
  check('fontSize 保留并标 @deprecated', api.includes('@deprecated') && api.includes('fontSize?: number'), '')
}

console.log(`\n${String(passed)}/${String(passed + failed)} 通过`)
process.exit(failed === 0 ? 0 : 1)
