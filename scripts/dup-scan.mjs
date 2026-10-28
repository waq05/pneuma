#!/usr/bin/env node
/**
 * 函数体重复扫描：同名不同名的短函数，只要**逐字相同**（归一化空白与注释后）就成一组。
 *
 * 这套扫描是 2026-10-28 全仓审查的主力工具——十四批整改里收掉的 40 组重复，
 * 绝大多数是它先扫出来的。当时它是一段每用一次手敲一遍的临时脚本，扫描范围写死成
 * `src` 与 `ui-shell/src`，于是 `remote-web` 与（当时还没删的）旧渲染层从来没被扫过。
 * 现在收成正经工具，范围由命令行给。
 *
 * 它只看两件事：
 *   1. 花括号块，且按行数算不超过 `--max-lines`（默认 10）；
 *   2. 归一化之后逐字相同。
 *
 * 所以「扫不出」不等于「没有重复」：写法不同、语义相同的它认不出来；超过 10 行的
 * 长函数不进来（重复率的分母因此偏小，绝对值只用于前后对比）。
 *
 * 用法：
 *   node scripts/dup-scan.mjs                     # 默认扫 src 与 ui-shell/src
 *   node scripts/dup-scan.mjs remote-web/src      # 扫指定目录
 *   node scripts/dup-scan.mjs --max-lines 20 src  # 放宽到 20 行
 *   node scripts/dup-scan.mjs --strict            # 有重复就退出码 1（给门禁用）
 *
 * @module dsc/scripts/dup-scan
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 这些目录不进扫描：编译产物、依赖、构建缓存。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'lib', '.git', 'build', 'runtime-staging', '.tmp-build', '.tmp-check'])

const args = process.argv.slice(2)
const maxLinesIdx = args.indexOf('--max-lines')
const maxLines = maxLinesIdx === -1 ? 10 : Number(args[maxLinesIdx + 1])
const strict = args.includes('--strict')
const dirs = args.filter((arg, i) => !arg.startsWith('--') && i !== maxLinesIdx + 1)
const targets = dirs.length > 0 ? dirs : ['src', 'ui-shell/src']

/** 递归收集 .ts / .tsx。 */
function collect(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, out)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

/** 去掉注释与行首缩进，多个空白压成一个。 */
function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
}

/** 逐个文件切出「花括号块」，只留行数在范围内的。 */
function blocksOf(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const found = []
  let depth = 0
  let startLine = 0
  let startOffset = 0
  let isFunctionBody = false
  let inString = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString !== null) {
      if (ch === '\\') i += 1
      else if (ch === inString) inString = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch
      continue
    }
    if (ch === '{') {
      if (depth === 0) {
        startOffset = i
        startLine = text.slice(0, i).split('\n').length
        // 只认「函数体」：花括号前面（跳过空白）必须是 `)` 或 `=>`。
        // 不设这一道，JSX 片段、对象字面量、模板里的块都会进来，噪声盖住真重复。
        const before = text.slice(0, i).replace(/\s+$/, '')
        isFunctionBody = before.endsWith(')') || before.endsWith('=>')
      }
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const body = text.slice(startOffset, i + 1)
        const lineCount = body.split('\n').length
        // 太短（一两行）与太长（超出上限）都不算候选：两行以内多是就地判空。
        if (isFunctionBody && lineCount >= 3 && lineCount <= maxLines) {
          found.push({ file, line: startLine, text: normalize(body), lines: lineCount })
        }
      }
    }
  }
  return found
}

const files = targets.flatMap((dir) => collect(resolve(root, dir)))
const groups = new Map()
for (const file of files) {
  for (const block of blocksOf(file)) {
    if (block.text.length === 0) continue
    const list = groups.get(block.text) ?? []
    list.push(block)
    groups.set(block.text, list)
  }
}

const dups = [...groups.values()].filter((list) => list.length > 1).sort((a, b) => b.length - a.length)
const total = files.length
let dupLines = 0
for (const list of dups) dupLines += list[0].lines * (list.length - 1)

console.log(`扫描目录：${targets.join(', ')}`)
console.log(`文件：${String(total)}　候选块：${String([...groups.values()].reduce((n, l) => n + l.length, 0))}　重复组：${String(dups.length)}　多出的行数：${String(dupLines)}`)

for (const list of dups) {
  console.log(`\n—— ${String(list.length)} 份，${String(list[0].lines)} 行/份`)
  for (const block of list) {
    console.log(`   ${relative(root, block.file).split('\\').join('/')}:${String(block.line)}`)
  }
}

if (strict && dups.length > 0) process.exit(1)
