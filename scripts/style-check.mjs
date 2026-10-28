/**
 * 排版闸门：不引第三方格式化工具，只查「一旦破掉就是纯噪声」的四条。
 *
 * ## 为什么不上 Prettier / ESLint
 *
 * 这份代码库 448 个源文件、14.7 万行全是手写排版，格式本来就统一（2026-10-28 全仓审查
 * 实测：0 处制表符缩进、0 行行尾空白、0 个 BOM）。整仓跑一次 Prettier 会重排七成文件，
 * git blame 全部作废；退一步「只查改动的文件」也不行——改一个老文件里的一行，Prettier
 * 会把同文件里几十处没动过的排版一起报出来，逼着人顺手重排，diff 就更没法看了。
 *
 * 所以这里只钉四条硬规则，剩下的（换行位置、对齐）交给人。真要大改格式，那是单独一批
 * 活，得带着「blame 作废」的代价一起评估，不该混在功能提交里。
 *
 * ## 查什么
 *
 * 硬失败：
 *   1. 行首缩进里有制表符——tab 宽度随编辑器变，同一段代码在两台机器上对不齐；
 *   2. 行尾空白——看不见，diff 里却是实打实的一行改动；
 *   3. 文件开头的 BOM——`node` 读 .mjs 会把 BOM 当代码，首行直接语法错；
 *   4. 同一文件里混用 CRLF 与 LF——同一行在不同工具里算两行，合并必冲突。
 *
 * 只警告不失败：整篇都是 CRLF 的文件。这是检出配置留下的（`core.autocrlf=true`），
 * `.gitattributes` 已经把行尾钉成 LF，但历史文件要等下一次 `git add --renormalize .`
 * 才归位；在那之前拦下来只会挡住所有人。
 *
 * ## 用法
 *
 *   node scripts/style-check.mjs                  # 全仓
 *   node scripts/style-check.mjs --changed        # 只看本次改动（CI 与提交前用）
 *   node scripts/style-check.mjs src/core/loop.ts # 点名几个文件
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const ROOT = process.cwd()

/** 扫这些目录；不在这里的（docs / README）不查——markdown 的行尾两空格是硬换行。 */
const SCAN_DIRS = ['src', 'ui-shell/src', 'desktop/src', 'remote-web/src', 'scripts', '.github']

/** 查这些扩展名；其余（图片、字体、lock）是二进制或机器生成，不查。 */
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.css', '.json', '.yml', '.yaml', '.ps1', '.html'])

/** 这些目录名不进去：依赖、构建产物、审查用的临时快照。 */
const SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'build', 'out', '.git'])

const args = process.argv.slice(2)
const changedOnly = args.includes('--changed')
const named = args.filter((arg) => !arg.startsWith('--'))

/** 走一遍目录，收出要查的文件（相对仓库根的路径）。 */
function walk(dir, out) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) {
      // 点开头的目录一律不进去：.git / .github 之外的（.mimosa 运行时账本、
      // .remote-e2e-home 这类自检用的临时 HOME）都是产物，不是源码。
      if (entry.name !== '.github' && entry.name.startsWith('.')) continue
      if (SKIP_DIRS.has(entry.name)) continue
      walk(rel, out)
    } else if (EXTS.has(extname(entry.name))) {
      out.push(rel)
    }
  }
}

/**
 * 本次改动的文件：已暂存 + 未暂存 + 未跟踪，过滤掉删除与不查的扩展名。
 *
 * 拿不到改动清单时（git 不在 PATH、或者跑在拦子进程的沙箱里）返回 null，由调用方
 * 退回全仓检查——宁可多查一会儿，也不要因为拿不到清单就直接绿。
 */
function changedFiles() {
  const git = (argv) => {
    try {
      return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' }).split('\n')
    } catch (error) {
      console.error(`读不出改动清单（${error instanceof Error ? error.message : String(error)}），改为全仓检查。`)
      return null
    }
  }
  const tracked = git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'])
  if (tracked === null) return null
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
  if (untracked === null) return null
  return [...tracked, ...untracked].filter((line) => line !== '' && EXTS.has(extname(line)))
}

/** 逐条查一个文件，返回 { hard: [...], crlf: 布尔 }。 */
function inspect(rel) {
  const abs = join(ROOT, rel)
  const hard = []
  const buf = readFileSync(abs)
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) hard.push({ line: 1, text: '文件开头有 BOM' })
  const source = buf.toString('utf8')
  const crlf = (source.match(/\r\n/g) ?? []).length
  const lf = (source.match(/\n/g) ?? []).length
  // lf 是「所有换行数」（含 CRLF 里的那个），两者相减才是孤立的 LF。
  const loneLf = lf - crlf
  if (crlf > 0 && loneLf > 0) hard.push({ line: 1, text: `行尾混用：${String(crlf)} 处 CRLF、${String(loneLf)} 处 LF` })
  const lines = source.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]
    if (/^[ \t]*\t/.test(text)) hard.push({ line: index + 1, text: '缩进里有制表符' })
    if (/[ \t]+$/.test(text)) hard.push({ line: index + 1, text: '行尾有空白' })
  }
  if (source.length > 0 && !source.endsWith('\n')) hard.push({ line: lines.length, text: '文件末尾缺换行' })
  return { hard, crlfOnly: crlf > 0 && loneLf === 0 }
}

/** 全仓：走一遍 SCAN_DIRS 收文件。 */
function allFiles() {
  const out = []
  for (const dir of SCAN_DIRS) walk(dir, out)
  return out
}

// changed 为 null 表示没拿到改动清单（或没开 --changed），走全仓。
const changed = changedOnly ? changedFiles() : null
const targets = named.length > 0
  ? named.map((file) => relative(ROOT, join(ROOT, file)).split('\\').join('/'))
  : changed ?? allFiles()

const scopes = [...new Set(targets)].filter((rel) => existsSync(join(ROOT, rel))).sort()

let hardCount = 0
let crlfCount = 0
let printed = 0
for (const rel of scopes) {
  const { hard, crlfOnly } = inspect(rel)
  if (crlfOnly) crlfCount += 1
  if (hard.length === 0) continue
  hardCount += hard.length
  if (printed >= 40) continue
  console.log(`\n${rel}`)
  for (const item of hard.slice(0, 8)) {
    printed += 1
    console.log(`  ${String(item.line)}: ${item.text}`)
  }
  if (hard.length > 8) console.log(`  …另有 ${String(hard.length - 8)} 处`)
}

if (hardCount > 0) {
  console.log(`\n✗ 排版闸门：${String(scopes.length)} 个文件里查出 ${String(hardCount)} 处问题（上面列了前 40 条）`)
  process.exit(1)
}
console.log(`✓ 排版闸门：${String(scopes.length)} 个文件全部通过`)
if (crlfCount > 0) {
  console.log(`  提示：其中 ${String(crlfCount)} 个文件整篇是 CRLF（旧检出留下）。`.concat(
    '\n  .gitattributes 已把行尾钉成 LF，跑一次 git add --renormalize . 即可归位。',
  ))
}
