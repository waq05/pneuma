/**
 * @pneuma/checkpoint 的包级测试：影子仓库的路径口径 + 一次真的 pre/post 快照。
 *
 * 为什么用真 git：这个包的难点不在函数形状，而在「隔离」——`GIT_DIR` / `GIT_WORK_TREE` /
 * `GIT_INDEX_FILE` 指错一个，快照就会写进用户的 `.git`。只有真跑一遍 git，才验得到
 * 「工作区里没有多出 .git」「node_modules 没被收进来」这两条。
 *
 * 隔离：临时 HOME + 临时 DSC_HOME，真实 ~/.dsc 一个字节都不动。
 * 依赖构建产物：`pnpm run build` 之后跑；git 不可用时打印 SKIP 并正常退出。
 *
 * @module @pneuma/checkpoint/tests
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-test-'))
process.env.DSC_HOME = join(home, '.dsc')
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(process.env.DSC_HOME, { recursive: true })

const { bumpTurn, ensureRepo, excludePatterns, listSnapshots, readLedger, recordTurnLedger, repoSizeMB, shadowRoot, snapshot } =
  await import(new URL('../../../../lib/packages/checkpoint/shadow.js', import.meta.url).href)

let passed = 0

/** 一条断言：过了就计数（包级测试闸只读最后那行「通过 N」当断言数）。 */
const ok = (condition, message) => {
  assert.ok(condition, message)
  passed += 1
}

/** git 不在时集成部分整体跳过（纯函数部分照跑）。 */
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

test('shadowRoot：同一路径的不同写法折成同一个键', () => {
  ok(shadowRoot('D:\\a\\b') === shadowRoot('D:/a/b/'), '反斜杠与正斜杠、结尾斜杠应当同键')
  ok(shadowRoot('D:\\a\\b') !== shadowRoot('D:\\a\\c'), '不同目录应当不同键')
})

test('shadowRoot：仓库落在 DSC_HOME 下，不在工作区里', () => {
  const root = shadowRoot('D:\\a\\b')
  ok(root.startsWith(resolve(process.env.DSC_HOME)), `仓库根应在 DSC_HOME 下：${root}`)
  ok(root.includes(join('checkpoints')), '仓库根应在 checkpoints 目录下')
})

test('集成：pre/post 两张快照、内容可回看、用户 .git 不受影响', { skip: !gitAvailable ? 'git 不可用' : false }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'checkpoint-ws-'))
  const cwd = join(base, 'ws')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'a.txt'), 'first\n', 'utf8')
  // node_modules 必须被 info/exclude 挡住：不然一次快照就把整个依赖树收进来。
  mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'pkg', 'index.js'), 'ignored\n', 'utf8')
  try {
    const repo = await ensureRepo(cwd)
    ok(existsSync(join(repo.repo, 'HEAD')), '影子仓库应当建起来')

    const pre = await snapshot(cwd, 'pre', 'turn 1 pre')
    ok(pre.ok === true, `pre 快照应当成功：${pre.error ?? ''}`)

    writeFileSync(join(cwd, 'a.txt'), 'second\n', 'utf8')
    const post = await snapshot(cwd, 'post', 'turn 1 post')
    ok(post.ok === true, `post 快照应当成功：${post.error ?? ''}`)

    const entries = await listSnapshots(cwd, 10)
    ok(entries.length === 2, `应当列出两张快照，实际 ${entries.length}`)
    const preEntry = entries.find((entry) => entry.label === 'pre')
    ok(preEntry !== undefined && preEntry.turn === 1, 'pre 快照应当标在第 1 回合')

    const shown = spawnSync('git', ['--git-dir', repo.repo, 'show', `${preEntry.tag}:a.txt`], {
      encoding: 'utf8',
    })
    ok(shown.status === 0 && shown.stdout.trim() === 'first', `pre 的内容应当是第一次写的：${shown.stdout}`)

    const tree = spawnSync('git', ['--git-dir', repo.repo, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    })
    ok(tree.status === 0 && !tree.stdout.includes('node_modules'), 'node_modules 应当被 exclude 排除')

    // 这一条是整包的安全边界：工作区里本来没有 .git，跑完也不许有。
    ok(!existsSync(join(cwd, '.git')), '用户工作区里不应当出现 .git')
    ok(relative(cwd, repo.repo).startsWith('..'), '影子仓库不应当落在工作区内部')

    const size = await repoSizeMB(cwd)
    ok(Number.isFinite(size) && size >= 0, `占用应当是一个非负数：${size}`)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('excludePatterns：dist-*/ 在、dist*/ 不在（distribution/、dists/ 是正常源码目录）', () => {
  const patterns = excludePatterns('D:\\ws')
  ok(patterns.includes('dist/'), 'dist/ 仍要排除')
  ok(patterns.includes('dist-*/'), 'dist-next/ 这类并行构建目录仍要排除')
  ok(!patterns.includes('dist*/'), 'dist*/ 会连 distribution/、dists/ 一起排除，不许出现')
  // 需求里的三条点名断言：distribution/、dists/ 不在任何排除模式里，dist-next/ 在。
  const distEntries = patterns.filter((pattern) => pattern.startsWith('dist'))
  ok(distEntries.join('|') === 'dist/|dist-*/', `dist 条目应当只有 dist/ 与 dist-*/：${distEntries.join(' / ')}`)
})

test('集成：dist-*/ 只挡并行构建目录，distribution/ 与 dists/ 照常进快照', { skip: !gitAvailable ? 'git 不可用' : false }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'checkpoint-dist-'))
  const cwd = join(base, 'ws')
  mkdirSync(join(cwd, 'distribution'), { recursive: true })
  mkdirSync(join(cwd, 'dists'), { recursive: true })
  mkdirSync(join(cwd, 'dist-next'), { recursive: true })
  writeFileSync(join(cwd, 'distribution', 'index.ts'), 'export {}\n', 'utf8')
  writeFileSync(join(cwd, 'dists', 'core.ts'), 'export {}\n', 'utf8')
  writeFileSync(join(cwd, 'dist-next', 'app.asar'), 'packed\n', 'utf8')
  try {
    const repo = await ensureRepo(cwd)
    const shot = await snapshot(cwd, 'pre', 'dist dirs')
    ok(shot.ok === true, `快照应当成功：${shot.error ?? ''}`)
    const tree = spawnSync('git', ['--git-dir', repo.repo, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    })
    ok(tree.status === 0, `ls-tree 应当成功：${tree.stderr}`)
    ok(tree.stdout.includes('distribution/index.ts'), 'distribution/ 是源码目录，必须进快照')
    ok(tree.stdout.includes('dists/core.ts'), 'dists/ 是源码目录，必须进快照')
    ok(!tree.stdout.includes('dist-next/app.asar'), 'dist-next/ 是并行构建目录，不该进快照')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('集成：超大文件进了 info/exclude 且活过多次 ensureRepo，也不进快照', { skip: !gitAvailable ? 'git 不可用' : false }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'checkpoint-big-'))
  const cwd = join(base, 'ws')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 0x41))
  writeFileSync(join(cwd, 'small.txt'), 'small\n', 'utf8')
  try {
    const repo = await ensureRepo(cwd)
    const excludeFile = join(repo.repo, 'info', 'exclude')
    const excludeLines = () => readFileSync(excludeFile, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    ok(excludeLines().includes('/big.bin'), `6MB 文件的排除行应当写进 info/exclude：${excludeLines().join(' | ')}`)
    // `bumpTurn()` → `snapshot()` 会连着调两次 ensureRepo：第二次不能把追加的超大文件行冲掉。
    await ensureRepo(cwd)
    ok(excludeLines().includes('/big.bin'), '第二次 ensureRepo 之后排除行必须还在')
    await ensureRepo(cwd)
    ok(excludeLines().includes('/big.bin'), '第三次 ensureRepo 之后排除行也必须还在')

    const shot = await snapshot(cwd, 'pre', 'oversize')
    ok(shot.ok === true, `快照应当成功：${shot.error ?? ''}`)
    const tree = spawnSync('git', ['--git-dir', repo.repo, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    })
    ok(tree.status === 0, `ls-tree 应当成功：${tree.stderr}`)
    ok(!tree.stdout.includes('big.bin'), '超 5MB 的文件不该进快照')
    ok(tree.stdout.includes('small.txt'), '小文件照常进快照')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('集成：写者账本记下每回合动了哪些文件', { skip: !gitAvailable ? 'git 不可用' : false }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-ledger-'))
  try {
    const cwd = join(base, 'ws')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'a.txt'), 'one\n', 'utf8')
    await bumpTurn(cwd)
    ok((await snapshot(cwd, 'pre', 'turn 1 pre')).ok === true, '回合 1 的 pre 快照应当成功')
    writeFileSync(join(cwd, 'a.txt'), 'two\n', 'utf8')
    writeFileSync(join(cwd, 'b.txt'), 'new\n', 'utf8')
    ok((await snapshot(cwd, 'post', 'turn 1 post')).ok === true, '回合 1 的 post 快照应当成功')
    const first = await recordTurnLedger(cwd, 1)
    ok(first === 2, `第 1 回合应当记两条（改 a.txt、新增 b.txt），实际 ${String(first)}`)
    const turn1 = readLedger(cwd, 1)
    ok(turn1.some((row) => row.path === 'a.txt' && row.action === 'modify'), 'a.txt 记成 modify')
    ok(turn1.some((row) => row.path === 'b.txt' && row.action === 'add'), 'b.txt 记成 add')

    await bumpTurn(cwd)
    ok((await snapshot(cwd, 'pre', 'turn 2 pre')).ok === true, '回合 2 的 pre 快照应当成功')
    rmSync(join(cwd, 'b.txt'), { force: true })
    ok((await snapshot(cwd, 'post', 'turn 2 post')).ok === true, '回合 2 的 post 快照应当成功')
    const second = await recordTurnLedger(cwd, 2)
    ok(second === 1, `第 2 回合应当记一条（删 b.txt），实际 ${String(second)}`)
    ok(readLedger(cwd, 2).some((row) => row.path === 'b.txt' && row.action === 'delete'), 'b.txt 记成 delete')
    // 按回合过滤：第 1 回合的两条不该混进第 2 回合
    ok(readLedger(cwd, 2).length === 1, 'readLedger(turn) 只返回那一回合')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

after(() => {
  rmSync(home, { recursive: true, force: true })
  console.log(`通过 ${String(passed)} 项`)
})
