/**
 * 老内核调色板兜底的探针：`ui-shell/src/legacy-color-fallback.css` 是不是**跟着 tokens.css 走**。
 *
 * 背景（2026-10-14 手机报障）：令牌体系几乎全部由 `color-mix()` 算出，而手机上的老 WebView
 * 不认这个函数——解析期整条声明被丢掉，于是侧栏/浮层底色变透明、文字全是一个白度。
 * 兜底那份 CSS 由 `ui-shell/scripts/build-color-fallback.mjs` 按 tokens.css 的公式算出来，
 * 这个探针就是它的闸门：**算出来必须与入库的那份逐字节一致**（改了 tokens.css 忘了重跑 → 红）。
 *
 * 六段：
 *   [1] 漂移门：生成器跑一遍 == 入库文件（含主题块结构）
 *   [2] 覆盖门：依赖 color-mix 的令牌一个都不许漏（漏了就是那块界面在手机上没颜色）
 *   [3] 值形状：兜底值里不许再出现 `var()` / `color-mix()`（老内核同样算不出来）
 *   [4] 混色算法：已知值对表 + **预乘**那条（与透明混合不许压暗）
 *   [5] 主题门：浅色块与深色块必须不同（浅色重放要是静默回落到深色，两段会长得一样）
 *   [6] 接线：入口在 styles.css 之后引入它（同特异性靠源码序压过令牌）+ 产物里带这块
 *
 * 运行：node scripts/ui-color-fallback-test.mjs
 *
 * @module dsc/scripts/ui-color-fallback-test
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const generator = await import(new URL('../ui-shell/scripts/build-color-fallback.mjs', import.meta.url).href)
const {
  TOKENS_PATH,
  OUT_PATH,
  buildFallbackCss,
  parseRules,
  collectTokens,
  fallbackDecls,
  pickDependent,
  mixColors,
  formatColor,
  parseColor,
  evaluate,
  makeResolver,
} = generator

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')
const flat = (text) => text.replace(/\r\n/g, '\n')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

const tokensCss = readFileSync(TOKENS_PATH, 'utf8')
const committed = readFileSync(OUT_PATH, 'utf8')
const built = buildFallbackCss(tokensCss)

console.log('[1] 漂移门：生成器与入库文件一致')
{
  check('入库文件与刚算出来的逐字节一致（改了 tokens.css 要重跑生成器）', flat(committed) === flat(built.css), '重跑：node ui-shell/scripts/build-color-fallback.mjs')
  check('产物带 @supports 外壳（认得 color-mix 的内核整块不生效）', flat(committed).includes('@supports not (color: color-mix(in srgb, red, blue))'))
  check('深色块与浅色块都在', flat(committed).includes('  :root {') && flat(committed).includes("  :root[data-theme='light'] {"))
  check('声明数非零（深色/浅色各一批）', built.counts[0] > 20 && built.counts[1] > 20, JSON.stringify(built.counts))
}

console.log('[2] 覆盖门：依赖 color-mix 的令牌一个不漏')
{
  const rules = parseRules(tokensCss.replace(/\/\*[\s\S]*?\*\//g, ''))
  const dark = collectTokens(rules, { 'data-theme': 'dark', 'data-density': 'standard' }, false)
  const light = collectTokens(rules, { 'data-theme': 'light', 'data-density': 'standard' }, false)
  for (const [label, tokens] of [['深色', dark], ['浅色', light]]) {
    const dependent = pickDependent(tokens)
    const decls = fallbackDecls(tokens)
    check(`${label}：每个依赖 color-mix 的令牌都兜住了（${String(dependent.size)} 个）`, decls.length === dependent.size, `${String(decls.length)}/${String(dependent.size)}`)
  }
  // 负向：真要漏一个必须能被这条抓到——把一条声明人为删掉，数量就不等了。
  const tampered = new Map(dark)
  tampered.delete('--dsc-bg-side')
  const keptButEmpty = fallbackDecls(tampered).length
  check('负向：少一个令牌，覆盖门会红', keptButEmpty === fallbackDecls(dark).length - 1, String(keptButEmpty))
}

console.log('[3] 值形状：兜底值里不许再有 var() / color-mix()')
{
  const blocks = [...flat(committed).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].replace(/\s+/g, ' ').trim()])
  const dirty = blocks.filter(([, value]) => value.includes('var(') || value.includes('color-mix('))
  check('没有一条兜底值还引用 var()/color-mix()', dirty.length === 0, JSON.stringify(dirty.slice(0, 3)))
  const colorish = blocks.filter(([name]) => /^--dsc-(bg|text|stroke|fill|row|control|scrim|selection|diff|inline|scrollbar|accent|chrome|composer)/.test(name) && !/shadow/.test(name))
  const badColor = colorish.filter(([, value]) => parseColor(value) === null)
  check('颜色类兜底值都是实色（rgb()/rgba()/transparent）', badColor.length === 0, JSON.stringify(badColor.slice(0, 3)))
  const alphas = colorish.map(([, value]) => parseColor(value)).filter((c) => c !== null)
  check('alpha 都在 0..1', alphas.every((c) => c.a >= 0 && c.a <= 1))
}

console.log('[4] 混色算法：已知值 + 预乘')
{
  const white = parseColor('#ffffff')
  const black = parseColor('#000000')
  const clear = parseColor('transparent')
  check('50/50 黑白 → 128', formatColor(mixColors(white, null, black, null)) === 'rgb(128 128 128)', formatColor(mixColors(white, null, black, null)))
  // 省略的那一边按 `100% - 已给的` 补：白 25% + 黑（补 75%）→ 25% 白 = 64。
  check('一边给了百分比，另一边按 100%-x 补', formatColor(mixColors(white, 25, black, null)) === 'rgb(64 64 64)', formatColor(mixColors(white, 25, black, null)))
  // 预乘：与透明混合只降 alpha，不该把颜色本身压暗（非预乘会算出 rgb(128 128 128 / 0.5)）。
  check('与透明 50/50 → 白 50% 透明（预乘，不压暗）', formatColor(mixColors(white, null, clear, null)) === 'rgb(255 255 255 / 0.5)', formatColor(mixColors(white, null, clear, null)))
  check('深灰 96% + 透明 → 原色 0.96', formatColor(mixColors(parseColor('#2c2c2e'), 96, clear, null)) === 'rgb(44 44 46 / 0.96)', formatColor(mixColors(parseColor('#2c2c2e'), 96, clear, null)))
  check('全透明（0%）→ transparent', formatColor(mixColors(black, 0, clear, null)) === 'transparent', formatColor(mixColors(black, 0, clear, null)))
  // 嵌套 + var 求值：拿真令牌试一条（填充色 = 品牌蓝 0% 混 文字色 12% 透明）
  const rules = parseRules(tokensCss.replace(/\/\*[\s\S]*?\*\//g, ''))
  const dark = collectTokens(rules, { 'data-theme': 'dark', 'data-density': 'standard' }, false)
  const resolveVar = makeResolver(dark)
  check('嵌套 color-mix + var() 求值（--dsc-fill-primary）', resolveVar('--dsc-fill-primary') === 'rgb(249 250 251 / 0.12)', String(resolveVar('--dsc-fill-primary')))
  check('currentColor 用文字主色顶上（--dsc-stroke-float）', resolveVar('--dsc-stroke-float') === 'rgb(249 250 251 / 0.03)', String(resolveVar('--dsc-stroke-float')))
  check('var() 到另一个 color-mix 令牌也跟着算（--dsc-chrome-bar）', resolveVar('--dsc-chrome-bar') === 'rgb(21 21 23)', String(resolveVar('--dsc-chrome-bar')))
  // 阴影简写：长度照抄、只有颜色被换掉
  const shadow = resolveVar('--dsc-shadow-xs')
  check('阴影简写里只换颜色', shadow === '0 1px 2px rgb(0 0 0 / 0.05)', String(shadow))
  // 认不出的东西要如实返回 null，不许猜一个颜色出来
  check('求不出来的返回 null（不瞎猜）', evaluate('color-mix(in oklab, red, blue)', { rawTokens: new Map(), resolveVar: () => null }) === null)
}

console.log('[5] 主题门：浅色块必须与深色块不同')
{
  const body = flat(committed)
  const darkBlock = /:root \{([\s\S]*?)\n  \}/.exec(body)[1]
  const lightBlock = /:root\[data-theme='light'\] \{([\s\S]*?)\n  \}/.exec(body)[1]
  check('两段不是同一份（浅色重放没静默回落成深色）', darkBlock !== lightBlock)
  check('深色侧栏底色 rgb(27 27 28)', darkBlock.includes('--dsc-bg-side: rgb(27 27 28);'))
  check('浅色侧栏底色 rgb(243 247 255)', lightBlock.includes('--dsc-bg-side: rgb(243 247 255);'))
  check('浅色文字主色带 0.94 alpha（不是深色那支的纯白）', lightBlock.includes('--dsc-text-primary: rgb(23 23 26 / 0.94);'))
  // 浅色独有的那几条（只在浅色块里被 color-mix 覆盖）也要在
  check('浅色独有的 --dsc-composer-fill 也在', lightBlock.includes('--dsc-composer-fill: rgb(253 253 253 / 0.88);'))
}

console.log('[6] 接线：引入次序 + 产物')
{
  const entry = flat(read('ui-shell/src/ui-renderer/main.tsx'))
  const stylesAt = entry.indexOf("import '../styles.css'")
  const fallbackAt = entry.indexOf("import '../legacy-color-fallback.css'")
  check('入口引入了兜底 CSS', fallbackAt !== -1)
  check('它排在 styles.css 之后（同特异性靠源码序赢）', stylesAt !== -1 && fallbackAt > stylesAt, `styles=${String(stylesAt)} fallback=${String(fallbackAt)}`)
  check('它排在 tokens.css 之后', entry.indexOf("import '../legacy/tokens.css'") < fallbackAt)
  const assetsDir = `${root}lib/ui/assets`
  if (existsSync(assetsDir)) {
    const cssFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.css'))
    const hasBlock = cssFiles.some((f) => /@supports not \(color: color-mix\(in srgb,red,blue\)\)/.test(readFileSync(`${assetsDir}/${f}`, 'utf8')))
    check('构建产物里带着这块兜底（跑过壳构建）', cssFiles.length === 0 || hasBlock, cssFiles.join(','))
  } else {
    console.log('  --  产物目录不在，跳过产物门')
  }
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
