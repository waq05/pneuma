/**
 * `glob` / `grep` 的忽略与截断规则的单元测试（迁自 `scripts/search-ignore-test.mjs`）。
 *
 * ## 为什么钉这一张网
 *
 * 报障原话是「`.venv` 里每层目录的 README 都被 glob 返回」与「中文目录里明明有文件却
 * 说无匹配」。根因不是中文路径，而是两个叠加的毛病：遍历既不认 `.gitignore` 也不认
 * `.venv` 这类大目录，而且**先把文件收进数组再过滤**——几千个依赖文件把额度吃光，后面
 * 的文件根本没进过列表。所以这里四段分别钉：
 *
 *   1. 内置跳过表：`.venv` / `node_modules` / `__pycache__` 里的文件不出现，正常文件照常出现；
 *   2. `.gitignore`：目录规则、通配、`!` 否定都生效；
 *   3. 截断：够数就停，并且**说出来**（不能让「这就是全部」变成谎话）；
 *   4. 路径口径：中文目录、Windows 反斜杠、多段模式都能命中。
 *
 * ## 为什么用临时 HOME
 *
 * 工具在路径策略里会读 `DSC_HOME` 下的配置（凭据类文件的跳过规则），真 HOME 会让这条
 * 用例的结果取决于开发机上装了什么。`readBlockReason` 在 import 期就定下目录，所以先
 * `tempHome()` 再动态 import。
 *
 * ## 迁移差异
 *
 * 断言从 `check(name, cond, detail)` 换成 `test()` + `expect`，夹具与条数一一对应；
 * 原探针的 `detail` 参数只用于失败时打印现场，等价改成把实际值放进 `expect(...)` 的第二参。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ToolContext } from '../../../core/tools.js'
import { tempHome } from '../../../../tests/harness.js'

/** 临时主目录：路径策略与配置读它。 */
const home = tempHome('dsc-search-ignore-')

/** 一个临时工作区：所有文件都造在这里，grep/glob 的 cwd 指过来。 */
const root = await mkdtemp(join(tmpdir(), 'dsc-search-'))
/** 夹具里的两条阈值来自探针，改大改小都会让「够数就停」那条失去意义。 */
const ctx: ToolContext = {
  cwd: root,
  signal: new AbortController().signal,
  sessionId: 'search-ignore-spec',
  sessionPath: join(root, 'session.jsonl'),
}

type SearchModule = typeof import('../search-tools.js')
let search: SearchModule

/** 造一个文件（自动建父目录）。 */
async function write(rel: string, text = 'x'): Promise<void> {
  const file = join(root, rel)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, text, 'utf8')
}

/** glob 的输出（工具回的是带换行的一段文本）。 */
async function glob(pattern: string, extra: Record<string, unknown> = {}): Promise<string> {
  return String(await search.globTool.run({ pattern, ...extra }, ctx))
}

/** grep 的输出。 */
async function grep(pattern: string, extra: Record<string, unknown> = {}): Promise<string> {
  return String(await search.grepTool.run({ pattern, ...extra }, ctx))
}

beforeAll(async () => {
  search = await import('../search-tools.js')
  // [1] 的夹具：一个正常源码、一个 Python 入口，其余全在依赖 / 缓存目录里。
  await write('src/app.ts', 'const chromadb = 1\n')
  await write('main.py', 'chromadb\n')
  await write('.venv/Lib/site-packages/chromadb/README.md', 'chromadb\n')
  await write('node_modules/pkg/README.md', 'chromadb\n')
  await write('__pycache__/mod.cpython-312.pyc', 'chromadb\n')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  home.restore()
})

describe('① 内置跳过表：依赖 / 缓存目录不参与遍历', () => {
  test('.venv / node_modules 里的 md 不出现，且给出「无匹配」', async () => {
    const md = await glob('**/*.md')
    expect(md).not.toContain('.venv')
    expect(md).not.toContain('node_modules')
    expect(md.startsWith('（无匹配')).toBe(true)
  })

  test('正常文件照常出现（不因为跳过表把源码也跳掉）', async () => {
    const all = await glob('**', { limit: 100 })
    expect(all).toContain('src/app.ts')
    expect(all).toContain('main.py')
  })

  test('pyc 不出现', async () => {
    const all = await glob('**', { limit: 100 })
    expect(all).not.toContain('.pyc')
  })

  test('grep 也跳过这些目录，且能命中真实文件', async () => {
    const hits = await grep('chromadb')
    expect(hits).not.toContain('.venv')
    expect(hits).not.toContain('site-packages')
    expect(hits).toContain('main.py:1:')
  })
})

describe('② .gitignore：目录、通配、否定', () => {
  beforeAll(async () => {
    await write('.gitignore', ['*.log', 'secret/', '!keep.log', ''].join('\n'))
    await write('debug.log', 'noise\n')
    await write('keep.log', 'noise\n')
    await write('secret/token.txt', 'noise\n')
    await write('src/debug.log', 'noise\n')
  })

  test('*.log 按 .gitignore 忽略（含子目录里的那份）', async () => {
    const logs = await glob('**/*.log', { limit: 50 })
    expect(logs).not.toContain('debug.log')
    expect(logs).not.toContain('src/debug.log')
  })

  test('!keep.log 否定规则生效', async () => {
    const logs = await glob('**/*.log', { limit: 50 })
    expect(logs).toContain('keep.log')
  })

  test('目录规则整棵跳过（secret/ 里的文件不给）', async () => {
    expect((await glob('**/token.txt')).startsWith('（无匹配')).toBe(true)
  })

  test('名单外的文件不受影响', async () => {
    expect(await glob('**', { limit: 100 })).toContain('src/app.ts')
  })
})

describe('③ 截断：够数就停，并且说出来', () => {
  beforeAll(async () => {
    for (let index = 0; index < 30; index += 1) await write(`many/f${String(index).padStart(2, '0')}.txt`, 'x')
  })

  test('limit=5 时只给 5 条，并明确说还有更多', async () => {
    const few = await glob('many/*.txt', { limit: 5 })
    expect(few.split('\n').filter((line) => line.startsWith('many/'))).toHaveLength(5)
    expect(few).toContain('还有更多')
  })

  test('limit 够时不多说截断，条数正确', async () => {
    const exact = await glob('many/*.txt', { limit: 30 })
    expect(exact).not.toContain('还有更多')
    expect(exact.split('\n')).toHaveLength(30)
  })
})

describe('④ 路径口径：中文、反斜杠、多段', () => {
  beforeAll(async () => {
    await write('最终项目/Makefile', 'all:\n')
    await write('最终项目/pyproject.toml', '[project]\n')
  })

  test('中文目录 + 精确文件名命得中', async () => {
    expect(await glob('最终项目/Makefile')).toBe('最终项目/Makefile')
  })

  test('中文目录 + 段内通配命得中', async () => {
    expect(await glob('最终项目/*.toml')).toBe('最终项目/pyproject.toml')
  })

  test('模式里写反斜杠也认（Windows 用户的手感）', async () => {
    expect(await glob('最终项目\\Makefile')).toBe('最终项目/Makefile')
  })

  test('** 跨目录段命得中', async () => {
    expect(await glob('**/最终项目/*.toml')).toBe('最终项目/pyproject.toml')
  })

  test('花括号多选仍可用', async () => {
    expect(await glob('**/*.{toml,md}', { limit: 50 })).toContain('最终项目/pyproject.toml')
  })
})
