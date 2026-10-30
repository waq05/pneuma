/**
 * glob / grep 的两条真问题（2026-10-30）：**看不见 `.gitignore`** 与**静默截断**。
 *
 * 报障原话：`.gitignore:3` 写了 `.venv/`，但 `glob` 用 `**` 加 `*.md` 仍返回几十条
 * `site-packages` 下每层目录的 README.md；`glob` 查 `group4/最终项目/Makefile` 明明文件存在却「无匹配」。
 *
 * 查下来根因不是中文路径，是两个叠加的毛病：
 *   1. 遍历不认 `.gitignore`、也不认 `.venv` 这类大目录；
 *   2. 遍历先把文件收进数组（上限 10000 / 20000）再过滤——`.venv` 一次就是几千个文件，
 *      额度被它吃光，后面的文件根本没进过列表，于是「无匹配」看起来像「文件不存在」。
 *
 * 探针分四段：
 *   [1] 内置跳过表：`.venv` / `node_modules` / `__pycache__` 里的文件不出现，正常文件照常出现；
 *   [2] `.gitignore`：目录规则、通配、`!` 否定都生效；
 *   [3] 截断：够数就停并且**说出来**（不再假装这就是全部）；
 *   [4] 路径口径：中文目录、Windows 反斜杠、多段模式都能命中。
 *
 * 跑法：先 `pnpm run build`，再 `node scripts/search-ignore-test.mjs`。
 *
 * @module dsc/scripts/search-ignore-test
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const search = await import('../lib/core/tools/search-tools.js')

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsc-search-'))
const ctx = { cwd: root, signal: new AbortController().signal }
const write = async (rel, text = 'x') => {
  const file = join(root, rel)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, text, 'utf8')
}
const glob = async (pattern, extra = {}) => String(await search.globTool.run({ pattern, ...extra }, ctx))
const grep = async (pattern, extra = {}) => String(await search.grepTool.run({ pattern, ...extra }, ctx))

try {
  console.log('[1] 内置跳过表：依赖/缓存目录不参与遍历')
  await write('src/app.ts', 'const chromadb = 1\n')
  await write('main.py', 'chromadb\n')
  await write('.venv/Lib/site-packages/chromadb/README.md', 'chromadb\n')
  await write('node_modules/pkg/README.md', 'chromadb\n')
  await write('__pycache__/mod.cpython-312.pyc', 'chromadb\n')
  {
    const md = await glob('**/*.md')
    check('.venv 里的 md 不出现', !md.includes('.venv'), md)
    check('node_modules 里的 md 不出现', !md.includes('node_modules'), md)
    check('没有可命中的 md 时给「无匹配」', md.startsWith('（无匹配'), md)

    const all = await glob('**', { limit: 100 })
    check('正常文件照常出现', all.includes('src/app.ts') && all.includes('main.py'), all)
    check('pyc 不出现', !all.includes('.pyc'), all)

    const hits = await grep('chromadb')
    check('grep 也跳过这些目录', !hits.includes('.venv') && !hits.includes('site-packages'), hits)
    check('grep 命中真实文件', hits.includes('main.py:1:'), hits)
  }

  console.log('[2] .gitignore：目录、通配、否定')
  await write('.gitignore', ['*.log', 'secret/', '!keep.log', ''].join('\n'))
  await write('debug.log', 'noise\n')
  await write('keep.log', 'noise\n')
  await write('secret/token.txt', 'noise\n')
  await write('src/debug.log', 'noise\n')
  {
    const logs = await glob('**/*.log', { limit: 50 })
    check('*.log 按 gitignore 忽略', !logs.includes('debug.log') && !logs.includes('src/debug.log'), logs)
    check('!keep.log 否定规则生效', logs.includes('keep.log'), logs)
    const secret = await glob('**/token.txt')
    check('目录规则整棵跳过', secret.startsWith('（无匹配'), secret)
    const all = await glob('**', { limit: 100 })
    check('名单外的文件不受影响', all.includes('src/app.ts'), all)
  }

  console.log('[3] 截断：够数就停，并且说出来')
  for (let i = 0; i < 30; i += 1) await write(`many/f${String(i).padStart(2, '0')}.txt`, 'x')
  {
    const few = await glob('many/*.txt', { limit: 5 })
    const lines = few.split('\n')
    check('只给 limit 条', lines.filter((line) => line.startsWith('many/')).length === 5, few)
    check('明确说还有更多', few.includes('还有更多'), few)
    const exact = await glob('many/*.txt', { limit: 30 })
    check('没超上限时不提截断', !exact.includes('还有更多'), exact)
    check('没超上限时条数正确', exact.split('\n').length === 30, String(exact.split('\n').length))
  }

  console.log('[4] 路径口径：中文、反斜杠、多段')
  await write('最终项目/Makefile', 'all:\n')
  await write('最终项目/pyproject.toml', '[project]\n')
  {
    const make = await glob('最终项目/Makefile')
    check('中文目录 + 精确文件名命得中', make === '最终项目/Makefile', make)
    const toml = await glob('最终项目/*.toml')
    check('中文目录 + 段内通配命得中', toml === '最终项目/pyproject.toml', toml)
    const backslash = await glob('最终项目\\Makefile')
    check('模式里写反斜杠也认', backslash === '最终项目/Makefile', backslash)
    const multi = await glob('**/最终项目/*.toml')
    check('** 跨目录段命得中', multi === '最终项目/pyproject.toml', multi)
    const shares = await glob('**/*.{toml,md}', { limit: 50 })
    check('花括号多选仍可用', shares.includes('最终项目/pyproject.toml'), shares)
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? `全部通过（${String(passed)} 项）` : `${String(failures)} 项失败（通过 ${String(passed)} 项）`)
process.exit(failures === 0 ? 0 : 1)
