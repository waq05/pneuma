/**
 * 界面文案的本地化闸：界面半与宿主半都不许再有硬编码的中文文案。
 *
 * 为什么要有这条闸：本地化最容易停在「做了一半」——设置页译了、设置页里点开的确认框没译；
 * 主界面译了、错误提示没译；界面译了、宿主拼好交给界面的设置面没译。人眼扫不出来，
 * 用户一换英文就撞见一半中文。判据落成机器能判的三件事：
 *
 *   1. **源码里没有中文串**（注释不算，console.* 与 throw 里的开发面文案不算）；
 *   2. **每个包的两份字典键集相同**，英文值里没有汉字，中文值非空；
 *   3. **每个 t('key') 的键都在本包字典里**（写错键不会静默显示键名）。
 *
 * 两半各有一套「哪些字算界面文案」的判法：
 *
 *   - **界面半**（`src/packages/<包>/ui/`）：字符串字面量、模板串、JSX 文本全算——
 *     那一层除了文案没有别的中文。
 *   - **宿主半**（设置分区的对象字面量）：只算 `title` / `subtitle` / `label` / `help` /
 *     `tip` / `placeholder` / `text` / `description` 这八个键。同一份文件里的工具说明、
 *     日志、报错是**给模型与开发者**的，翻了反而坏事，所以只认「长得像设置分区」的
 *     对象字面量（同时有 `id` 与 `fields` 两个键——分区必须这两个，工具说明是
 *     `name` / `description`，不会撞）。
 *
 * 中文原文是语义真源（locale/ui.zh.json），英文是译本（ui.en.json）；缺译时运行期回落
 * 中文，但**闸门要求两条都在**——「缺了就当没译」在运行期是宽容，在提交前是漏。
 *
 * 跑法：node scripts/ui-locale-test.mjs（check:ui 自动收录）
 * 单包排查：node scripts/ui-locale-test.mjs --package settings
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'src', 'packages')

/** 汉字范围：只判常用区（扩展区里的生僻字不拿来当文案）。 */
const CJK = /[\u4e00-\u9fff]/

/** 只出现在界面文案里的七个键（工具 Schema 不用它们，出现中文就是漏译）。 */
const PLAIN_KEYS = new Set(['title', 'subtitle', 'label', 'help', 'tip', 'placeholder', 'text'])

/** 只查这一批包；给了 --package 就只看它。 */
const only = process.argv.includes('--package') ? process.argv[process.argv.indexOf('--package') + 1] : null

/** 这一包要不要查。 */
function wanted(name) {
  if (only !== null) return name === only
  return true
}

/** 递归列源码。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    // 测试文件不算产品文案：P3 渲染批把断言里的中文（预期值、describe 名）写进了
    // ui/**/*.spec.tsx，它们不是「界面里会出现的话」。排除口径与 d.ts 同一层。
    else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.includes('.spec.')
    ) {
      out.push(path)
    }
  }
  return out
}

/** 宿主半的源码：包根下除 `ui/`（另一半）、`tests/`、`locale/` 之外的 .ts。 */
function hostFilesOf(packageDir) {
  const out = []
  for (const entry of readdirSync(packageDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'ui' || entry.name === 'tests' || entry.name === 'locale' || entry.name === 'node_modules') continue
      walk(join(packageDir, entry.name), out)
    } else if (/\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !entry.name.includes('.spec.')) {
      out.push(join(packageDir, entry.name))
    }
  }
  return out
}

/** 一份源码的语法树（界面半走 TSX，宿主半走 TS）。 */
function parse(file) {
  const source = readFileSync(file, 'utf8')
  return {
    source,
    sf: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
    lines: source.split('\n'),
  }
}

/** 行尾写了 `i18n-keep` 的算协议文案（宿主写进来的中文值，翻了就对不上）。 */
function keptLine(lines, line) {
  return /\/\/.*i18n-keep/.test(lines[line] ?? '')
}

let kept = 0

/**
 * 从一份界面半源码里挑出「给用户看的」中文字串。
 *
 * 不做文本正则：字符串里的转义、模板串的 ${}、JSX 文本与属性值差别太大，正则一定漏。
 * 用语法树只看四种节点，顺带把 console.* 与 throw 整棵子树跳过——那是开发面的话，
 * 跟着界面语言切换反而让日志更难搜。
 *
 * @param file - 源码路径
 * @returns { line, text }[]
 */
function userFacingStrings(file) {
  const { sf, lines } = parse(file)
  const found = []
  const push = (node, text) => {
    if (!CJK.test(text)) return
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    if (keptLine(lines, line)) {
      kept += 1
      return
    }
    found.push({ line: line + 1, text: text.trim().slice(0, 60) })
  }
  const visit = (node) => {
    // 开发面：console.*(...) 与 throw 里的文案不算界面文案。
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression
      if (ts.isIdentifier(target) && target.text === 'console') return
    }
    if (ts.isThrowStatement(node)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) push(node, node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) push(node, node.text)
    else if (ts.isJsxText(node)) push(node, node.text)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/**
 * 这个对象字面量是不是「设置字段」：有 `label` 或 `key`，或者本身是分区（`id` + `fields`）。
 *
 * 为什么 `description` 要单独判：工具参数的 JSON Schema 也用 `description`，那是给模型看的，
 * 翻了等于改提示词。设置字段从来不用 `description` 而用 `label`/`help`，分区才用
 * `description`——所以只有落在「字段形」对象里的 `description` 才算界面文案。
 *
 * @param node - 候选的父对象
 */
function isFieldObject(node) {
  const names = new Set()
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) names.add(property.name.text)
  }
  return names.has('label') || names.has('key') || (names.has('id') && names.has('fields'))
}

/**
 * 从一份宿主半源码里挑出设置面里的中文字串。
 *
 * 判据只有两条，但划得很准：
 *   - `title` / `subtitle` / `label` / `help` / `tip` / `placeholder` / `text` 这七个键
 *     只出现在界面文案里（工具 Schema 不用它们），出现中文就是漏译；
 *   - `description` 两边都会用，只有落在「字段形」对象里才算界面文案。
 *
 * 同一份文件里的工具说明、日志、报错因此不会误报。
 *
 * @param file - 源码路径
 * @returns { line, text }[]
 */
function hostSectionStrings(file) {
  const { sf, lines } = parse(file)
  const found = []
  const push = (node, text) => {
    if (!CJK.test(text)) return
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    if (keptLine(lines, line)) {
      kept += 1
      return
    }
    found.push({ line: line + 1, text: text.trim().slice(0, 60) })
  }
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : ''
      const value = node.initializer
      // `save` / `action` 的返回值原样显示在设置页上（保存失败的红字、按完按钮的结果），
      // 也是界面文案；它们不是「键: 值」的形状，得单独认。
      if (name === 'save' || name === 'action') {
        const inHandler = (child) => {
          if (ts.isReturnStatement(child) && child.expression !== undefined) {
            const expression = child.expression
            if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) push(expression, expression.text)
            else if (ts.isTemplateExpression(expression)) {
              push(expression.head, expression.head.text)
              for (const span of expression.templateSpans) push(span.literal, span.literal.text)
            }
          }
          ts.forEachChild(child, inHandler)
        }
        inHandler(value)
      }
      const wanted = PLAIN_KEYS.has(name) || (name === 'description' && ts.isObjectLiteralExpression(node.parent) && isFieldObject(node.parent))
      if (wanted) {
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) push(value, value.text)
        else if (ts.isTemplateExpression(value)) {
          push(value.head, value.head.text)
          for (const span of value.templateSpans) push(span.literal, span.literal.text)
        }
      }
      ts.forEachChild(node, visit)
      return
    }
    if (ts.isThrowStatement(node)) return
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** 这一包用到的 t('key') 键（含 t('key', {...}) 的写法）。 */
function usedKeys(file) {
  const { sf } = parse(file)
  const keys = []
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 't' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      keys.push({ key: node.arguments[0].text, line: line + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return keys
}

/** 读一份字典；不存在给 null，坏 JSON 当场抛（坏文件比缺文件更难查）。 */
function readDict(file, label) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(label + ' 不是对象')
    return parsed
  } catch (error) {
    throw new Error(file + ' 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)))
  }
}

const problems = []
const fail = (message) => problems.push(message)

let scannedUi = 0
let scannedHost = 0
let hardcoded = 0
let keyCount = 0
let callCount = 0

for (const name of readdirSync(packagesDir).sort()) {
  if (!wanted(name)) continue
  const packageDir = join(packagesDir, name)

  const uiDir = join(packageDir, 'ui')
  let uiFiles = []
  try {
    statSync(uiDir)
    uiFiles = walk(uiDir)
  } catch {
    uiFiles = []
  }
  // 宿主半：声明过设置分区的文件才算（同一份文件里的工具说明不是界面文案）。
  const hostFiles = []
  if (uiFiles.length === 0) {
    for (const file of hostFilesOf(packageDir)) {
      if (!readFileSync(file, 'utf8').includes('registerSection')) continue
      hostFiles.push(file)
    }
  }
  if (uiFiles.length === 0 && hostFiles.length === 0) continue

  if (uiFiles.length > 0) scannedUi += 1
  else scannedHost += 1

  const hostHits = []
  for (const file of hostFiles) for (const hit of hostSectionStrings(file)) hostHits.push({ ...hit, file })

  // 1. 源码里的中文
  for (const file of uiFiles) {
    for (const hit of userFacingStrings(file)) {
      hardcoded += 1
      fail(relative(root, file).split('\\').join('/') + ':' + String(hit.line) + ' 还有硬编码文案「' + hit.text + '」')
    }
  }
  for (const hit of hostHits) {
    hardcoded += 1
    fail(relative(root, hit.file).split('\\').join('/') + ':' + String(hit.line) + ' 设置分区的文案还是硬编码「' + hit.text + '」')
  }

  // 2. 字典
  const zh = readDict(join(packageDir, 'locale', 'ui.zh.json'), name + ' 的中文字典')
  const en = readDict(join(packageDir, 'locale', 'ui.en.json'), name + ' 的英文字典')

  // 3. 用到的键
  const files = [...uiFiles, ...hostFiles]
  const used = []
  for (const file of files) for (const hit of usedKeys(file)) used.push({ ...hit, file })
  callCount += used.length

  if (zh === null && en === null) {
    if (uiFiles.length > 0 || hostHits.length > 0 || used.length > 0) {
      fail(name + '：要取词却没有 locale/ui.zh.json / ui.en.json')
    }
    continue
  }
  if (zh === null) {
    fail(name + '：有 locale/ui.en.json 却没有 ui.zh.json（中文是原文，不能缺）')
    continue
  }
  if (en === null) {
    fail(name + '：有 locale/ui.zh.json 却没有 ui.en.json')
    continue
  }
  keyCount += Object.keys(zh).length
  const zhKeys = Object.keys(zh)
  const enKeys = Object.keys(en)
  for (const key of zhKeys) {
    const zhValue = zh[key]
    if (typeof zhValue !== 'string' || zhValue.trim() === '') fail(name + '：ui.zh.json 的 ' + key + ' 不是非空字符串')
    if (!(key in en)) fail(name + '：ui.en.json 缺键 ' + key)
  }
  for (const key of enKeys) {
    if (!(key in zh)) fail(name + '：ui.en.json 多出键 ' + key + '（中文里没有）')
    const value = en[key]
    if (typeof value !== 'string' || value.trim() === '') fail(name + '：ui.en.json 的 ' + key + ' 不是非空字符串')
    else if (CJK.test(value)) fail(name + '：ui.en.json 的 ' + key + ' 还是中文「' + value.slice(0, 40) + '」')
  }
  for (const hit of used) {
    if (!(hit.key in zh)) fail(relative(root, hit.file).split('\\').join('/') + ':' + String(hit.line) + ' 用的键 ' + hit.key + ' 不在 ui.zh.json 里')
  }
  // 字典里没人用的键：不是错，但会让人以为改一行就生效——报出来由人删。
  const usedSet = new Set(used.map((hit) => hit.key))
  const unused = zhKeys.filter((key) => !usedSet.has(key))
  if (unused.length > 0) fail(name + '：ui.zh.json 有 ' + String(unused.length) + ' 个没人用的键（' + unused.slice(0, 5).join('、') + '）')
}

console.log('')
console.log(
  '界面文案本地化：' + String(scannedUi + scannedHost) + ' 个包（' + String(scannedUi) + ' 个界面半 / ' + String(scannedHost) + ' 个宿主半） / ' +
    String(hardcoded) + ' 条硬编码文案 / ' + String(kept) + ' 条协议豁免 / ' + String(keyCount) + ' 个键 / ' + String(callCount) + ' 处 t()',
)
if (problems.length === 0) {
  console.log('全部通过')
  process.exit(0)
}
for (const problem of problems.slice(0, 60)) console.log('FAIL  ' + problem)
if (problems.length > 60) console.log('… 还有 ' + String(problems.length - 60) + ' 条')
console.log(String(problems.length) + ' 条问题')
process.exit(1)
