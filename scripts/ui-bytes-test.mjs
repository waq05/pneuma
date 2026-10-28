/**
 * 字节读数探针：宿主与壳各一份 `formatBytes`，两份必须逐字同实现、同输出。
 *
 * 为什么要有这条：这个函数在 2026-10-28 之前有五份拷贝（附件、暂存清理、输入区附件、
 * 对话流附件行、文件树），单位与小数位各不相同——文件树给 `512B`、输入区给 `1.2 MB`、
 * 暂存清理给 `1536 字节`。合并时把实现拆成「宿主一份 + 壳一份」，是因为**分层不许互相
 * import**（壳只经 `@dsc/ui*` 拿宿主的类型，不拿运行期实现）。两份实现一旦漂移，用户会在
 * 同一个界面上看到两种写法，所以这里逐字比对函数体，并逐档比对输出。
 *
 * 三段：
 *   1. **函数体逐字相同**（剔注释、压空白后比对）；
 *   2. **输出逐档相同**（两侧真跑一遍同样的样本，含 0 / 负数 / NaN 三个边界）；
 *   3. **没有第三份拷贝**（全仓 `function formatBytes` 只许两处）。
 *
 * 运行：node scripts/ui-bytes-test.mjs
 *
 * @module dsc/scripts/ui-bytes-test
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const CORE = 'src/core/bytes.ts'
const SHELL = 'ui-shell/src/ui-primitives/sizes.ts'

const coreModel = await import(new URL('../' + CORE, import.meta.url).href)
const shellModel = await import(new URL('../' + SHELL, import.meta.url).href)

let total = 0
let failures = 0
const check = (name, condition, detail) => {
  total += 1
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 抠出 `export function formatBytes` 的函数体，去掉注释与空白，用于逐字比对。 */
const bodyOf = (source) => {
  const start = source.indexOf('export function formatBytes')
  if (start === -1) return null
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return null
}
const normalize = (body) =>
  body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')

console.log('[1] 两份实现逐字相同')
{
  const coreBody = bodyOf(read(CORE))
  const shellBody = bodyOf(read(SHELL))
  check('宿主那份找得到 formatBytes', coreBody !== null)
  check('壳里那份找得到 formatBytes', shellBody !== null)
  check('函数体逐字相同（剔注释与空白后）', coreBody !== null && shellBody !== null && normalize(coreBody) === normalize(shellBody),
    coreBody !== null && shellBody !== null ? `宿主:\n${normalize(coreBody)}\n---\n壳:\n${normalize(shellBody)}` : '')
}

console.log('[2] 输出逐档相同（两侧真跑）')
{
  const samples = [0, 1, 999, 1023, 1024, 1536, 10 * 1024, 1024 * 1024, 10 * 1024 * 1024, 1024 * 1024 * 1024, 1.5 * 1024 * 1024 * 1024, -1, Number.NaN, Number.POSITIVE_INFINITY]
  const differ = samples.filter((value) => coreModel.formatBytes(value) !== shellModel.formatBytes(value))
  check('两侧对全部样本给出同一串', differ.length === 0, differ.map((value) => `${String(value)}: ${coreModel.formatBytes(value)} ≠ ${shellModel.formatBytes(value)}`).join('；'))

  // 逐档钉住格式本身：换了实现也要维持这套写法。
  const cases = [
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [10 * 1024, '10 KB'],
    [1024 * 1024, '1 MB'],
    [10 * 1024 * 1024, '10 MB'],
    [1.5 * 1024 * 1024, '1.5 MB'],
    [1024 * 1024 * 1024, '1 GB'],
    [1.5 * 1024 * 1024 * 1024, '1.5 GB'],
  ]
  for (const [bytes, expected] of cases) {
    check(`${String(bytes)} 字节 → ${expected}`, coreModel.formatBytes(bytes) === expected, coreModel.formatBytes(bytes))
  }
  check('负数给破折号（不显示 -1 B）', coreModel.formatBytes(-1) === '—', coreModel.formatBytes(-1))
  check('NaN / Infinity 给破折号（界面上不出现 NaN）', coreModel.formatBytes(Number.NaN) === '—' && coreModel.formatBytes(Number.POSITIVE_INFINITY) === '—')
}

console.log('[3] 没有第三份拷贝')
{
  const found = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (['node_modules', 'lib', 'dist', 'build', 'out'].includes(entry.name) || entry.name.startsWith('.')) continue
        walk(join(dir, entry.name))
      } else if (['.ts', '.tsx'].includes(extname(entry.name))) {
        const source = readFileSync(join(dir, entry.name), 'utf8')
        if (/function formatBytes\s*\(/.test(source)) found.push(relative(root, join(dir, entry.name)).split('\\').join('/'))
      }
    }
  }
  for (const dir of ['src', 'ui-shell/src', 'desktop/electron', 'remote-web/src']) walk(join(root, dir))
  check('全仓只有这两份实现', found.length === 2 && found.includes(CORE) && found.includes(SHELL), found.join(', '))
  // 界面侧不许再出现「按 size 格式化」的另一套名字。
  const legacy = ['src/plugins/spill.ts', 'ui-shell/src/plugins/composer/attachments.ts', 'ui-shell/src/plugins/transcript/rows/user-row.tsx'].filter((rel) => /function format(Size|Bytes)\s*\(/.test(read(rel)))
  check('三个曾经的拷贝点都不再自带实现', legacy.length === 0, legacy.join(', '))
}

console.log('')
console.log(`通过 ${String(total - failures)}/${String(total)}`)
process.exit(failures === 0 ? 0 : 1)
