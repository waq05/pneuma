/**
 * @ 补全多工作区 / 异根的自检（T50）。
 *
 * 钉四件事：
 *   1. `collectWorkspaceFiles([a, b])` 一次遍历多个根：每个条目带正确的 `root`，
 *      总条数不超过 WALK_MAX_FILES，既有忽略项（node_modules 等）仍然生效；
 *   2. 主根（第一个）候选是相对路径，第二根是绝对路径（工具能直接打开）；
 *   3. 两个根里有同名文件时，`label` 能区分（第二根带 `<根名>/` 前缀）；
 *   4. 传字符串（单根）时行为与旧版一致：相对路径、无根名前缀。
 *
 * 另外补一条同名根目录的退化规则：两个根都叫 `proj` 时，前缀退成 `父目录名-proj`。
 *
 * 跑法：pnpm run build && node scripts/mention-multi-root-test.mjs
 *
 * @module dsc/scripts/mention-multi-root-test
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { collectWorkspaceFiles, WALK_MAX_FILES } from '../lib/core/mention.js'

let passed = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${label}`)
  } else {
    console.log(`  FAIL ${label}${extra === '' ? '' : `（${extra}）`}`)
    process.exitCode = 1
  }
}

/** 造一个临时根，按 `{相对路径: 内容}` 落文件；`name` 是根目录自己的名字。 */
function makeRoot(base, files, name = 'root') {
  const root = join(base, name)
  mkdirSync(root, { recursive: true })
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text, 'utf8')
  }
  return root
}

const work = mkdtempSync(join(tmpdir(), 'dsc-mention-roots-'))

try {
  // ---- 1) 两个根：各自 DFS，root 字段正确，忽略项仍生效 ----
  const a = makeRoot(join(work, 'a'), {
    'README.md': '# a\n',
    'src/a.ts': 'export {}\n',
    'node_modules/ignored.js': 'module.exports = 1\n',
    '.hidden/skip.ts': 'export {}\n',
  })
  const b = makeRoot(join(work, 'b'), {
    'README.md': '# b\n',
    'docs/b.md': '# b docs\n',
  })

  const roots = [a, b]
  const entries = await collectWorkspaceFiles(roots)
  check('多根遍历返回条目', Array.isArray(entries) && entries.length > 0, `length=${String(entries?.length)}`)
  check(
    '总条数不超过 WALK_MAX_FILES',
    entries.length <= WALK_MAX_FILES,
    `${String(entries.length)} > ${String(WALK_MAX_FILES)}`,
  )

  const rootOf = new Map(entries.map((entry) => [entry.path, resolve(entry.root)]))
  const aEntries = entries.filter((entry) => resolve(entry.root) === resolve(a))
  const bEntries = entries.filter((entry) => resolve(entry.root) === resolve(b))
  check('两个根各自有条目', aEntries.length === 2 && bEntries.length === 2, `a=${aEntries.length} b=${bEntries.length}`)
  check(
    '主根的 root 字段是第一根',
    aEntries.every((entry) => resolve(entry.root) === resolve(a)),
  )
  check(
    '第二根的 root 字段是第二根',
    bEntries.every((entry) => resolve(entry.root) === resolve(b)),
  )
  check('node_modules 仍被跳过', entries.every((entry) => !entry.path.includes('node_modules')))
  check('点开头目录仍被跳过', entries.every((entry) => !entry.path.includes('.hidden')))
  check('相对路径条目能反查到所属根', rootOf.get('src/a.ts') === resolve(a))

  // ---- 2) 插入路径：主根相对、第二根绝对 ----
  const aReadme = entries.find((entry) => resolve(entry.root) === resolve(a) && entry.path.endsWith('README.md'))
  const bReadme = entries.find((entry) => resolve(entry.root) === resolve(b) && entry.path.endsWith('README.md'))
  check('主根候选是相对路径', aReadme !== undefined && aReadme.path === 'README.md', aReadme?.path)
  check('第二根候选是绝对路径', bReadme !== undefined && bReadme.path === join(b, 'README.md'), bReadme?.path)
  check(
    '第二根的绝对路径从盘符/根开始',
    bReadme !== undefined && resolve(bReadme.path) === resolve(join(b, 'README.md')),
  )

  // ---- 3) 同名文件 label 可区分 ----
  check('两个根都有 README.md', aReadme !== undefined && bReadme !== undefined)
  check('同名文件 label 不同', aReadme?.label !== bReadme?.label, `${aReadme?.label} / ${bReadme?.label}`)
  check('第二根 label 带根目录名前缀', bReadme?.label === `${basename(b)}/README.md`, bReadme?.label)
  check('主根 label 就是相对路径', aReadme?.label === 'README.md', aReadme?.label)

  // ---- 4) 传字符串（单根）：与旧版一致，相对路径、无根名前缀 ----
  const single = await collectWorkspaceFiles(a)
  const singlePaths = single.map((entry) => entry.path).sort()
  assert.deepEqual(singlePaths, ['README.md', 'src/a.ts'])
  check('单根传字符串：条目仍是相对路径', single.every((entry) => !entry.path.includes(basename(a))))
  check('单根传字符串：label 等于路径', single.every((entry) => entry.label === entry.path))
  check('单根传字符串：root 是该根绝对路径', single.every((entry) => resolve(entry.root) === resolve(a)))

  // 旧签名（lister 在第一位）仍返回字符串数组，行为与 2026-10 版一致。
  const previousCwd = process.cwd()
  process.chdir(a)
  try {
    const lister = async (dir) => ({
      entries: readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory() })),
    })
    const legacy = await collectWorkspaceFiles(lister, '.')
    assert.equal(typeof legacy[0], 'string')
    assert.deepEqual([...legacy].sort(), ['README.md', 'src/a.ts'])
    check('旧签名仍返回相对路径字符串数组', true)
  } finally {
    process.chdir(previousCwd)
  }

  // ---- 5) 同名根目录：前缀退化成 父目录名-根名 ----
  const sameA = makeRoot(join(work, 'same-a'), { 'same.txt': 'a\n' }, 'proj')
  const sameB = makeRoot(join(work, 'same-b'), { 'same.txt': 'b\n' }, 'proj')
  // 主根必须另有其根：前两个非主根同名，才会触发「父目录名-根目录名」的退化。
  const collided = await collectWorkspaceFiles([a, sameA, sameB])
  const sameLabels = collided.filter((entry) => entry.path.endsWith('same.txt')).map((entry) => entry.label)
  check(
    '同名根目录的 label 带父目录名',
    sameLabels.includes(`same-a-proj/same.txt`) && sameLabels.includes(`same-b-proj/same.txt`),
    sameLabels.join(' / '),
  )
  // ---- 6) 多根共享 4000 上限（注入 lister，不真的造 4000 个文件） ----
  const floodRoots = [join(work, 'flood-a'), join(work, 'flood-b')]
  const flood = await collectWorkspaceFiles(floodRoots, {
    lister: async () => ({
      entries: Array.from({ length: 2500 }, (_, index) => ({ name: `f${index}.ts`, dir: false })),
    }),
  })
  check('多根共享 WALK_MAX_FILES 上限', flood.length === WALK_MAX_FILES, `length=${String(flood.length)}`)
  const floodMain = flood.filter((entry) => resolve(entry.root) === resolve(floodRoots[0])).length
  check(
    '第一根吃满后第二根只补到上限',
    floodMain === 2500 && flood.length - floodMain === WALK_MAX_FILES - 2500,
    `first=${String(floodMain)} second=${String(flood.length - floodMain)}`,
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`通过 ${String(passed)} 项`)
process.exit(process.exitCode ?? 0)
