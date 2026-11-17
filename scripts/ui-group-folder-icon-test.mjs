/**
 * 工作区目录图标（文件夹 ↔ 三角）的回归探针。
 *
 * 报障原话：「工作区目录文件夹图标，点击展开或关闭后，一直是灰色三角，正常应该是
 * 文件夹图标变成展开的样式。」
 *
 * 根因：`views.css` 的设计是「文件夹图标常显，鼠标移上去整行换成实心三角箭头」，
 * 但换位的触发条件写成了 `:focus-within`。工作区行是 `<div role="button" tabIndex={0}>`
 * （`ui-sessions/ui/ui.tsx:1016-1017`），鼠标点一下它就会拿到焦点且不会自己丢，
 * 于是 `:focus-within` 永远成立 → 三角常显、文件夹图标被 `display: none` 藏掉，
 * 展开态该显示的「打开的文件夹」（`IconFolderOpenColor`）用户根本看不到。
 *
 * 判据全部落在源码文本上（不起浏览器、不打包）：
 *   1. 三角静息 `display: none`；`.arrow-open` 仍 `rotate(90deg)`；
 *   2. 显示三角的选择器只许出现 `:hover` 与 `:focus-visible`；
 *   3. 隐藏文件夹图标的选择器与第 2 条同源；
 *   4. TSX 里展开态渲染 `IconFolderOpenColor`、收起态渲染 `IconFolderColor`；
 *   5. 全仓（src/、ui-shell/、desktop/）除这份 CSS 没有第二处改这两个图标显隐的规则；
 *   6. 判据不能空转：把 `:focus-visible` 换回 `:focus-within` 的旧文本必须判红。
 *
 * 跑法：node scripts/ui-group-folder-icon-test.mjs
 *
 * @module dsc/scripts/ui-group-folder-icon-test
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CSS_PATH = join(root, 'src', 'packages', 'ui-renderer', 'ui', 'styles', 'legacy', 'views.css')
const TSX_PATH = join(root, 'src', 'packages', 'ui-sessions', 'ui', 'ui.tsx')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
    failures += 1
  }
}

// ── 解析工具 ────────────────────────────────────────────────────────────────────

/** 去掉注释：注释里出现的 `:focus-within` 不该算进选择器判据。 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 把 CSS 拆成「选择器 → 声明块」。
 *
 * 只匹配最内层规则（`([^{}]+)\{([^{}]*)\}`），所以 `@media{...}` 这类带嵌套的
 * at-rule 前奏会被跳过、里面的规则仍能单独取到——对本探针够用。
 */
const parseRules = (text) => {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  const src = stripComments(text)
  let match
  while ((match = re.exec(src)) !== null) {
    out.push({ selector: match[1].replace(/\s+/g, ' ').trim(), body: match[2].replace(/\s+/g, ' ') })
  }
  return out
}

/** 逗号分组拆成单条选择器，压掉多余空白。 */
const selectorParts = (selector) =>
  selector
    .split(',')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '')

/**
 * 取出「命中某个类名、且声明块里有 `display: 值`」的所有单条选择器。
 *
 * 按单条拆开而不是整组，是因为 `.shot-reveal .group-row .folder-chevron,
 * .shot-reveal .group-row > .row-actions { display: inline-flex }` 这种组合选择器
 * 里只有一半跟图标有关。
 */
const displayParts = (rules, className, value) => {
  const hits = []
  for (const rule of rules) {
    if (!rule.body.includes(`display: ${value}`)) continue
    for (const part of selectorParts(rule.selector)) {
      if (part.includes(className)) hits.push(part)
    }
  }
  return hits
}

/** 截图钩子（`?reveal=1`）常驻悬停态的规则，不参与交互判据。 */
const isShotHook = (part) => part.startsWith('.shot-reveal')

/**
 * 报障判据本体：`|` 分隔的「禁止出现的伪类」。
 *
 * `:focus-visible` 不能误伤——`(?!-)` 保证 `:focus` 后面跟 `-` 时不算裸 `:focus`。
 */
const FORBIDDEN_FOCUS = /:focus-within\b|:focus(?!-)/

/** 拿一组选择器，判断有没有出现禁止的焦点伪类；返回命中的那几条。 */
const forbiddenFocusParts = (parts) => parts.filter((part) => FORBIDDEN_FOCUS.test(part))

// ── 判据（纯函数：喂脏副本也能跑） ───────────────────────────────────────────────

/**
 * 对一份 CSS 文本 + 一份 TSX 文本跑全部文本判据。
 *
 * 抽成纯函数是为了第 6 条：同一个函数喂「旧文本」必须红，否则判据在空转。
 */
function evaluate(cssText, tsxText) {
  const results = []
  const add = (name, ok, detail = '') => results.push({ name, ok, detail })
  const rules = parseRules(cssText)

  // [1] 静息态：三角不显示，文件夹图标常显。
  const chevronRest = displayParts(rules, '.folder-chevron', 'none')
  add(
    '[1] 三角静息 display: none',
    chevronRest.length === 1 && chevronRest[0] === '.group-row .folder-chevron',
    JSON.stringify(chevronRest),
  )
  const iconRest = displayParts(rules, '.folder-icon', 'inline-flex')
  add(
    '[1] 文件夹图标静息 display: inline-flex（常显）',
    iconRest.includes('.group-row .folder-icon'),
    JSON.stringify(iconRest),
  )

  // [1] 展开态仍旋转 90°，悬停时能区分展开/收起。
  const openRules = rules.filter((rule) => selectorParts(rule.selector).includes('.group-row .folder-chevron svg.arrow-open'))
  add(
    '[1] .arrow-open 仍 rotate(90deg)',
    openRules.length === 1 && openRules[0].body.includes('transform: rotate(90deg)'),
    JSON.stringify(openRules.map((rule) => rule.body)),
  )

  // [2] 显示三角的那组选择器：只许 :hover 与 :focus-visible。
  const chevronShow = displayParts(rules, '.folder-chevron', 'inline-flex').filter((part) => !isShotHook(part))
  const badShow = forbiddenFocusParts(chevronShow)
  add(
    '[2] 显示三角的选择器不含 :focus-within / 裸 :focus',
    chevronShow.length > 0 && badShow.length === 0,
    JSON.stringify(badShow),
  )
  add(
    '[2] 显示三角的选择器同时含 :hover 与 :focus-visible',
    chevronShow.some((part) => part.includes(':hover')) &&
      chevronShow.some((part) => part.includes(':focus-visible')),
    JSON.stringify(chevronShow),
  )

  // [3] 隐藏文件夹图标的那组选择器与 [2] 同源。
  const iconHide = displayParts(rules, '.folder-icon', 'none').filter((part) => !isShotHook(part))
  const badHide = forbiddenFocusParts(iconHide)
  add(
    '[3] 隐藏文件夹图标的选择器不含 :focus-within / 裸 :focus',
    iconHide.length > 0 && badHide.length === 0,
    JSON.stringify(badHide),
  )
  // 「同源」比的是状态前缀（`:hover` / `:focus-visible`），不是类名本身。
  const statesOf = (parts, className) => parts.map((part) => part.split(className).join('').trim())
  const iconStates = statesOf(iconHide, '.folder-icon')
  const chevronStates = statesOf(chevronShow, '.folder-chevron')
  add(
    '[3] 隐藏图标的选择器与显示三角的选择器完全同源',
    iconStates.length === 2 && JSON.stringify(iconStates) === JSON.stringify(chevronStates),
    `图标=${JSON.stringify(iconStates)} 三角=${JSON.stringify(chevronStates)}`,
  )

  // [4] TSX 图标不许写反、不许只剩一个。
  const openInExpanded = /expanded\s*\?\s*<IconFolderOpenColor[\s\S]{0,80}?\/>\s*:\s*<IconFolderColor[\s\S]{0,40}?\/>/
  const closedInCollapsed = /(?:!expanded|expanded\s*===?\s*false)\s*\?\s*<IconFolderColor[\s\S]{0,80}?\/>\s*:\s*<IconFolderOpenColor[\s\S]{0,40}?\/>/
  add(
    '[4] 展开态渲染 IconFolderOpenColor、收起态渲染 IconFolderColor',
    openInExpanded.test(tsxText) || closedInCollapsed.test(tsxText),
    '两种写法都没匹配上',
  )
  add(
    '[4] folder-icon 与 folder-chevron 两个 span 都还在',
    tsxText.includes('className="folder-icon"') && tsxText.includes('className="folder-chevron"'),
  )
  add(
    '[4] 两个图标都还 import 着',
    /IconFolderColor/.test(tsxText) && /IconFolderOpenColor/.test(tsxText),
  )

  return results
}

// ── 跑真实源码 ──────────────────────────────────────────────────────────────────

const cssText = readFileSync(CSS_PATH, 'utf8')
const tsxText = readFileSync(TSX_PATH, 'utf8')

console.log('工作区目录图标（文件夹 ↔ 三角）回归探针')
console.log(`CSS: ${relative(root, CSS_PATH)}`)
console.log(`TSX: ${relative(root, TSX_PATH)}\n`)

console.log('── 文本判据 ──────────────────────────────────────────────────')
for (const result of evaluate(cssText, tsxText)) check(result.name, result.ok, result.detail)

// ── [5] 全仓没有第二处改这两个图标显隐的规则 ─────────────────────────────────────

console.log('\n── [5] 全仓唯一性 ────────────────────────────────────────────')

/**
 * 不进去的目录：依赖与构建产物。
 *
 * `_before-backup` 是 `desktop/shots` 里给截图脚本留的「改前快照」，`runtime-staging`
 * 是打包镜像；两者都不进运行时代码，也不在 `style-check` 的扫描面内。
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'lib', 'build', 'out', '.git', '_before-backup', 'runtime-staging'])

const walk = (dir, acc) => {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      walk(join(dir, entry.name), acc)
    } else if (extname(entry.name) === '.css') {
      acc.push(join(dir, entry.name))
    }
  }
  return acc
}

const scanRoots = ['src', 'ui-shell', 'desktop'].map((dir) => join(root, dir))
const cssFiles = scanRoots.flatMap((dir) => walk(dir, []))
const others = []
for (const file of cssFiles) {
  if (file === CSS_PATH) continue
  const rules = parseRules(readFileSync(file, 'utf8'))
  const hits = [
    ...displayParts(rules, '.folder-chevron', 'none'),
    ...displayParts(rules, '.folder-chevron', 'inline-flex'),
    ...displayParts(rules, '.folder-icon', 'none'),
    ...displayParts(rules, '.folder-icon', 'inline-flex'),
  ]
  if (hits.length > 0) others.push({ file: relative(root, file), hits })
}

check('[5] 扫描面非空（判据没有空转）', cssFiles.length > 0, `扫到 ${String(cssFiles.length)} 份 CSS`)
check(
  '[5] src/、ui-shell/、desktop/ 里没有第二处改这两个图标显隐的规则',
  others.length === 0,
  others.map((item) => `${item.file} → ${JSON.stringify(item.hits)}`).join('; '),
)

// ── [6] 脏副本必须红 ────────────────────────────────────────────────────────────

console.log('\n── [6] 脏副本必须红（防判据空转） ─────────────────────────────')

const dirtyCss = cssText.split(':focus-visible').join(':focus-within')
check('[6] 脏副本确实改到了（:focus-visible → :focus-within）', dirtyCss !== cssText)
const dirtyCssResults = evaluate(dirtyCss, tsxText)
const focusResult = dirtyCssResults.find((result) => result.name === '[2] 显示三角的选择器不含 :focus-within / 裸 :focus')
const hideResult = dirtyCssResults.find((result) => result.name === '[3] 隐藏文件夹图标的选择器不含 :focus-within / 裸 :focus')
check('[6] 旧 CSS（:focus-within）在判据 [2] 上判红', focusResult !== undefined && focusResult.ok === false)
check('[6] 旧 CSS（:focus-within）在判据 [3] 上判红', hideResult !== undefined && hideResult.ok === false)

const swappedTsx = tsxText
  .split('<IconFolderOpenColor size={15} /> : <IconFolderColor size={15} />')
  .join('<IconFolderColor size={15} /> : <IconFolderOpenColor size={15} />')
check('[6] 脏 TSX 确实改到了（两个图标对调）', swappedTsx !== tsxText)
const swappedResult = evaluate(cssText, swappedTsx).find(
  (result) => result.name === '[4] 展开态渲染 IconFolderOpenColor、收起态渲染 IconFolderColor',
)
check('[6] 图标写反的 TSX 在判据 [4] 上判红', swappedResult !== undefined && swappedResult.ok === false)

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条失败`)
process.exit(failures === 0 ? 0 : 1)
