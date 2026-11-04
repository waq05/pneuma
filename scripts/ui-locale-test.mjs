/**
 * 界面文案的本地化闸：src/packages/<包>/ui/ 里不许再有硬编码的中文文案。
 *
 * 为什么要有这条闸：本地化最容易停在「做了一半」——设置页译了、设置页里点开的确认框没译；
 * 主界面译了、错误提示没译。人眼扫不出来，用户一换英文就撞见一半中文。判据落成机器能判的
 * 三件事：
 *
 *   1. **源码里没有中文串**（注释不算，console.* 与 throw 里的开发面文案不算）；
 *   2. **每个包的两份字典键集相同**，英文值里没有汉字，中文值非空；
 *   3. **每个 t('key') 的键都在本包字典里**（写错键不会静默显示键名）。
 *
 * 中文原文是语义真源（locale/ui.zh.json），英文是译本（ui.en.json）；缺译时运行期回落
 * 中文，但**闸门要求两条都在**——「缺了就当没译」在运行期是宽容，在提交前是漏。
 *
 * 跑法：node scripts/ui-locale-test.mjs（check:ui 自动收录）
 * 单包排查：node scripts/ui-locale-test.mjs --package ui-settings
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'src', 'packages')

/** 汉字范围：只判常用区（扩展区里的生僻字不拿来当文案）。 */
const CJK = /[\u4e00-\u9fff]/

/** 只查这一批包；给了 --package 就只看它。 */
const only = process.argv.includes('--package') ? process.argv[process.argv.indexOf('--package') + 1] : null

/** 这一包要不要查。 */
function wanted(name) {
  if (only !== null) return name === only
  return name.startsWith('ui-')
}

/** 递归列源码。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

/**
 * 从一份源码里挑出「给用户看的」中文字串。
 *
 * 不做文本正则：字符串里的转义、模板串的 ${}、JSX 文本与属性值差别太大，正则一定漏。
 * 用语法树只看四种节点，顺带把 console.* 与 throw 整棵子树跳过——那是开发面的话，
 * 跟着界面语言切换反而让日志更难搜。
 *
 * @param file - 源码路径
 * @returns { line, text }[]
 */
function userFacingStrings(file) {
  const source = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found = []
  const lines = source.split('\n')
  const push = (node, text) => {
    if (!CJK.test(text)) return
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    // 协议字面量：行尾写 `i18n-keep` 的不算界面文案（宿主写进来的中文值，翻了就对不上）。
    // 这不是人情口子——每一处都要在同一行或上一行写清为什么，评审时一眼能看见；
    // 汇总里也会报出「豁免 N 条」，免得它悄悄长大。
    if (/\/\/.*i18n-keep/.test(lines[line] ?? '')) {
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

/** 这一包用到的 t('key') 键（含 t('key', {...}) 的写法）。 */
function usedKeys(file) {
  const source = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
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

let scanned = 0
let hardcoded = 0
let kept = 0
let keyCount = 0
let callCount = 0

for (const name of readdirSync(packagesDir).sort()) {
  if (!wanted(name)) continue
  const uiDir = join(packagesDir, name, 'ui')
  try {
    statSync(uiDir)
  } catch {
    continue
  }
  scanned += 1
  const files = walk(uiDir)

  // 1. 源码里的中文
  for (const file of files) {
    for (const hit of userFacingStrings(file)) {
      hardcoded += 1
      fail(relative(root, file).split('\\').join('/') + ':' + String(hit.line) + ' 还有硬编码文案「' + hit.text + '」')
    }
  }

  // 2. 字典
  const zhFile = join(packagesDir, name, 'locale', 'ui.zh.json')
  const enFile = join(packagesDir, name, 'locale', 'ui.en.json')
  const zh = readDict(zhFile, name + ' 的中文字典')
  const en = readDict(enFile, name + ' 的英文字典')

  // 3. 用到的键
  const used = []
  for (const file of files) for (const hit of usedKeys(file)) used.push({ ...hit, file })
  callCount += used.length

  if (zh === null && en === null) {
    if (used.length > 0) fail(name + '：用了 ' + String(used.length) + ' 次 t()，但没有 locale/ui.zh.json / ui.en.json')
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
console.log('界面文案本地化：' + String(scanned) + ' 个包 / ' + String(hardcoded) + ' 条硬编码文案 / ' + String(kept) + ' 条协议豁免 / ' + String(keyCount) + ' 个键 / ' + String(callCount) + ' 处 t()')
if (problems.length === 0) {
  console.log('全部通过')
  process.exit(0)
}
for (const problem of problems.slice(0, 60)) console.log('FAIL  ' + problem)
if (problems.length > 60) console.log('… 还有 ' + String(problems.length - 60) + ' 条')
console.log(String(problems.length) + ' 条问题')
process.exit(1)
