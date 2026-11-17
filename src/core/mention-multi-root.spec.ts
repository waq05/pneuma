/**
 * `@` 补全多工作区 / 异根遍历的单元测试（迁自 `scripts/mention-multi-root-test.mjs`）。
 *
 * ## 为什么值得单开一份
 *
 * 补全候选清单同时是**授权集合**的输入：列错一条用户打不开，列重一条候选里出现两个
 * 同一个文件的不同写法。多根改造之后最容易漂的是三件事——label 撞车、嵌套根重复遍历、
 * 巨根把后面的根饿死（总预算 4000 条是共享的）。所以这里按「真盘两根基数 → 插入路径
 * 口径 → label 消歧 → 旧签名兼容 → 预算分配」逐段钉。
 *
 * ## 与 `mention.spec.ts` 的分工
 *
 * 那份用注入的假目录树钉纯算法（旧签名、深度上限、失败层跳过、撞名前缀）；这份钉**真盘
 * 遍历**与多根预算分配——注入 lister 看得出「问了哪些目录」，看不出「真实文件系统里
 * 点开头目录与 node_modules 会不会被漏跳」。两份合起来才算覆盖，重的是口径不是断言。
 *
 * ## 迁移时改了两处
 *
 * - 旧签名那一段原探针用 `process.chdir(a)` 再传 `'.'`。unit 层是线程池，`chdir` 是
 *   **进程级**副作用，会串到同进程里并行跑的别的 spec；改成传绝对根（同一分支、同一个
 *   `prefix` 拼法），`'.'` 那一支已由 `mention.spec.ts` 的旧签名用例覆盖。
 * - 断言从 `check(name, cond)` 逐条换成 `test()` + `expect`，条数不变。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { WALK_MAX_FILES, collectWorkspaceFiles } from './mention.js'
import type { CollectWorkspaceFilesOptions, DirLister, WorkspaceFileEntry } from './mention.js'

/** 所有夹具的老巢；`afterAll` 整个删掉。 */
const work = mkdtempSync(join(tmpdir(), 'dsc-mention-roots-'))

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

/** 造一个临时根，按 `{相对路径: 内容}` 落文件；`name` 是根目录自己的名字。 */
function makeRoot(base: string, files: Record<string, string>, name = 'root'): string {
  const root = join(base, name)
  mkdirSync(root, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text, 'utf8')
  }
  return root
}

/** 一个注入用的列举器：每个目录都给同样的一批文件（预算用例专用）。 */
function floodLister(count: number): DirLister {
  return async () => ({
    entries: Array.from({ length: count }, (_, index) => ({ name: `f${String(index)}.ts`, dir: false })),
  })
}

/**
 * 收多根清单并把返回值窄成「条目数组」。
 *
 * `collectWorkspaceFiles` 的返回类型是 `string[] | WorkspaceFileEntry[]`：旧签名（lister 在
 * 第一位）回字符串，新签名回条目。夹具里传的一律是根，所以这里只做类型窄化，
 * 不做任何运行时转换——窄错了测试会直接在断言处红。
 */
async function entriesOf(
  roots: string | readonly string[],
  options: CollectWorkspaceFilesOptions = {},
): Promise<WorkspaceFileEntry[]> {
  return (await collectWorkspaceFiles(roots, options)) as WorkspaceFileEntry[]
}

/** 两个根：主根 `alpha`（带 node_modules / 点开头目录）、第二根 `beta`。 */
const alpha = makeRoot(
  join(work, 'a'),
  {
    'README.md': '# a\n',
    'src/a.ts': 'export {}\n',
    'node_modules/ignored.js': 'module.exports = 1\n',
    '.hidden/skip.ts': 'export {}\n',
  },
  'alpha',
)
const beta = makeRoot(
  join(work, 'b'),
  {
    'README.md': '# b\n',
    'docs/b.md': '# b docs\n',
  },
  'beta',
)

describe('① 两个根：各自 DFS、root 字段正确、忽略项仍生效', () => {
  test('多根遍历返回条目', async () => {
    const entries = await entriesOf([alpha, beta])
    expect(Array.isArray(entries)).toBe(true)
    expect(entries.length).toBeGreaterThan(0)
  })

  test('总条数不超过 WALK_MAX_FILES', async () => {
    const entries = await entriesOf([alpha, beta])
    expect(entries.length).toBeLessThanOrEqual(WALK_MAX_FILES)
  })

  test('两个根各自有条目，且 root 字段各指各的根', async () => {
    const entries = await entriesOf([alpha, beta])
    const fromAlpha = entries.filter((entry) => resolve(entry.root) === resolve(alpha))
    const fromBeta = entries.filter((entry) => resolve(entry.root) === resolve(beta))
    expect(fromAlpha).toHaveLength(2)
    expect(fromBeta).toHaveLength(2)
  })

  test('node_modules 仍被跳过（真盘上也不出现）', async () => {
    const entries = await entriesOf([alpha, beta])
    expect(entries.every((entry) => !entry.path.includes('node_modules'))).toBe(true)
  })

  test('点开头目录仍被跳过', async () => {
    const entries = await entriesOf([alpha, beta])
    expect(entries.every((entry) => !entry.path.includes('.hidden'))).toBe(true)
  })

  test('相对路径条目能反查到所属根', async () => {
    const entries = await entriesOf([alpha, beta])
    const found = entries.find((entry) => entry.path === 'src/a.ts')
    expect(found?.root).toBe(resolve(alpha))
  })
})

describe('② 插入路径口径：主根相对、第二根绝对', () => {
  /** 两个根里各自的 README 条目（label / path 断言的素材）。 */
  async function readmes(): Promise<{ main?: { path: string; label: string }; extra?: { path: string; label: string } }> {
    const entries = await entriesOf([alpha, beta])
    return {
      main: entries.find((entry) => resolve(entry.root) === resolve(alpha) && entry.path.endsWith('README.md')),
      extra: entries.find((entry) => resolve(entry.root) === resolve(beta) && entry.path.endsWith('README.md')),
    }
  }

  test('主根候选是相对路径（与改造前逐字一致）', async () => {
    expect((await readmes()).main?.path).toBe('README.md')
  })

  test('第二根候选是绝对路径（工具要能直接打开）', async () => {
    expect((await readmes()).extra?.path).toBe(join(beta, 'README.md'))
  })

  test('第二根的绝对路径能 resolve 回原文件', async () => {
    const extra = (await readmes()).extra
    expect(extra === undefined ? undefined : resolve(extra.path)).toBe(resolve(join(beta, 'README.md')))
  })
})

describe('③ 同名文件 label 可区分', () => {
  test('两个根都有 README.md，label 不同', async () => {
    const entries = await entriesOf([alpha, beta])
    const main = entries.find((entry) => resolve(entry.root) === resolve(alpha) && entry.path.endsWith('README.md'))
    const extra = entries.find((entry) => resolve(entry.root) === resolve(beta) && entry.path.endsWith('README.md'))
    expect(main?.label).toBe('README.md')
    expect(extra?.label).toBe(`${basename(beta)}/README.md`)
    expect(main?.label).not.toBe(extra?.label)
  })
})

describe('④ 传字符串（单根）与旧签名：与改造前一致', () => {
  test('单根传字符串：条目仍是相对路径、label 等于路径、root 是绝对根', async () => {
    const single = await entriesOf(alpha)
    const paths = single.map((entry) => entry.path).sort()
    expect(paths).toEqual(['README.md', 'src/a.ts'])
    expect(single.every((entry) => entry.label === entry.path)).toBe(true)
    expect(single.every((entry) => resolve(entry.root) === resolve(alpha))).toBe(true)
  })

  test('旧签名（lister 在第一位）仍返回路径字符串数组', async () => {
    const lister: DirLister = async (dir) => ({
      entries: readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() })),
    })
    const legacy = await collectWorkspaceFiles(lister, alpha)
    const paths = legacy.map((item) => String(item).replace(/\\/g, '/'))
    expect(legacy.every((item) => typeof item === 'string')).toBe(true)
    // 旧签名把根当路径前缀拼上去：两条都落在 `<根>/…` 下面，且相对片段仍是相对根的那一份。
    expect(paths.some((item) => item.endsWith('/README.md'))).toBe(true)
    expect(paths.some((item) => item.endsWith('/src/a.ts'))).toBe(true)
  })
})

describe('⑤ 根目录同名：前缀退成 父目录名-根名', () => {
  test('两个额外根都叫 proj 时，label 带父目录名', async () => {
    const sameA = makeRoot(join(work, 'same-a'), { 'same.txt': 'a\n' }, 'proj')
    const sameB = makeRoot(join(work, 'same-b'), { 'same.txt': 'b\n' }, 'proj')
    // 主根必须另有其根：前两个非主根同名，才会触发「父目录名-根目录名」的退化。
    const collided = await entriesOf([alpha, sameA, sameB])
    const labels = collided.filter((entry) => entry.path.endsWith('same.txt')).map((entry) => entry.label)
    expect(labels).toContain('same-a-proj/same.txt')
    expect(labels).toContain('same-b-proj/same.txt')
  })

  test('主根顶层目录与额外根同名时 label 不撞车', async () => {
    const labelMain = makeRoot(
      join(work, 'label-main'),
      {
        'proj/readme.md': 'main\n',
        'main.txt': 'm\n',
      },
      'label-main',
    )
    const labelExtra = makeRoot(join(work, 'label-extra'), { 'readme.md': 'extra\n' }, 'proj')
    const entries = await entriesOf([labelMain, labelExtra])
    const mainProj = entries.find((entry) => resolve(entry.root) === resolve(labelMain) && entry.path === 'proj/readme.md')
    const extraProj = entries.find((entry) => resolve(entry.root) === resolve(labelExtra))
    expect(mainProj?.label).not.toBe(extraProj?.label)
    // 撞名时额外根退成 父目录名-根名 前缀。
    expect(extraProj?.label).toBe('label-extra-proj/readme.md')
  })
})

describe('⑥ 根互相嵌套：同一批文件只列一次', () => {
  test('被包含的根被丢掉，文件只列一次且全属外层根', async () => {
    const outer = makeRoot(join(work, 'nest-outer'), { 'outer.txt': 'o\n', 'sub/inner.txt': 'i\n' }, 'nest-outer')
    const nested = await entriesOf([outer, join(outer, 'sub')])
    expect(nested).toHaveLength(2)
    expect(nested.every((entry) => resolve(entry.root) === resolve(outer))).toBe(true)
  })

  test('主根被额外根包住时仍是两个根各一份，父根不重复列主根子树', async () => {
    const outer = makeRoot(join(work, 'nest-outer-2'), { 'outer.txt': 'o\n', 'sub/inner.txt': 'i\n' }, 'nest-outer-2')
    const inner = join(outer, 'sub')
    const reversed = await entriesOf([inner, outer])
    expect(reversed).toHaveLength(2)
    expect(reversed.some((entry) => entry.path === 'inner.txt' && resolve(entry.root) === resolve(inner))).toBe(true)
    expect(reversed.some((entry) => entry.path === join(outer, 'outer.txt'))).toBe(true)
    expect(reversed.some((entry) => entry.path === join(outer, 'sub', 'inner.txt'))).toBe(false)
  })
})

describe('⑦ 多根共享 4000 上限 + 每根最小配额', () => {
  test('多根共享 WALK_MAX_FILES 上限', async () => {
    const flood = await entriesOf([join(work, 'flood-a'), join(work, 'flood-b')], { lister: floodLister(2500) })
    expect(flood).toHaveLength(WALK_MAX_FILES)
  })

  test('第一根吃满后第二根只补到上限（不是各给 4000）', async () => {
    const roots = [join(work, 'flood-a'), join(work, 'flood-b')]
    const flood = await entriesOf(roots, { lister: floodLister(2500) })
    const first = flood.filter((entry) => resolve(entry.root) === resolve(roots[0]!)).length
    expect(first).toBe(2500)
    expect(flood.length - first).toBe(WALK_MAX_FILES - 2500)
  })

  test('巨根不能把后面的根饿死：每根都至少有 200 条候选', async () => {
    const roots = ['quota-a', 'quota-b', 'quota-c'].map((name) => join(work, name))
    const quota = await entriesOf(roots, { lister: floodLister(3000) })
    const perRoot = roots.map((root) => quota.filter((entry) => resolve(entry.root) === resolve(root)).length)
    expect(perRoot.every((count) => count >= 200)).toBe(true)
    expect(quota).toHaveLength(WALK_MAX_FILES)
  })
})
