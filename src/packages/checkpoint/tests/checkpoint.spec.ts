/**
 * @pneuma/checkpoint 的包级测试：影子仓库的路径口径 + 一次真的 pre/post 快照。
 *
 * 为什么用真 git：这个包的难点不在函数形状，而在「隔离」——`GIT_DIR` / `GIT_WORK_TREE` /
 * `GIT_INDEX_FILE` 指错一个，快照就会写进用户的 `.git`。只有真跑一遍 git，才验得到
 * 「工作区里没有多出 .git」「node_modules 没被收进来」这两条。
 *
 * 隔离：临时 HOME + 临时 DSC_HOME，真实 ~/.dsc 一个字节都不动。`path-policy` 在模块加载时
 * 读 `DSC_HOME`，所以必须先设环境变量、再动态 import 被测模块（静态 import 会被提到赋值之前）。
 * git 不可用时集成部分整体 skip，纯函数部分照跑。
 *
 * @module @pneuma/checkpoint/tests
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-spec-'))
/** 跑完要还原：同一次 vitest 运行里别的文件也可能读这三个变量。 */
const savedEnv = {
  DSC_HOME: process.env.DSC_HOME,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
}
process.env.DSC_HOME = join(home, '.dsc')
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(process.env.DSC_HOME, { recursive: true })

const { bumpTurn, ensureRepo, excludePatterns, listSnapshots, readLedger, recordTurnLedger, repoSizeMB, shadowRoot, snapshot } =
  await import('../shadow.js')

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(home, { recursive: true, force: true })
})

/** git 不在时集成部分整体跳过（纯函数部分照跑）。 */
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

test('shadowRoot：同一路径的不同写法折成同一个键', () => {
  // 同一路径的不同写法按平台给样本：Windows 用盘符 + 反斜杠，POSIX 用正斜杠与结尾斜杠。
  const dir = process.platform === 'win32' ? 'D:\\a\\b' : '/proj/a/b'
  const sameDir = process.platform === 'win32' ? 'D:/a/b/' : '/proj/a/b/'
  const otherDir = process.platform === 'win32' ? 'D:\\a\\c' : '/proj/a/c'
  expect(shadowRoot(dir), '反斜杠与正斜杠、结尾斜杠应当同键').toBe(shadowRoot(sameDir))
  expect(shadowRoot(dir), '不同目录应当不同键').not.toBe(shadowRoot(otherDir))
})

test('shadowRoot：仓库落在 DSC_HOME 下，不在工作区里', () => {
  const root = shadowRoot('D:\\a\\b')
  expect(root.startsWith(resolve(process.env.DSC_HOME ?? '')), `仓库根应在 DSC_HOME 下：${root}`).toBe(true)
  expect(root.includes(join('checkpoints'))).toBe(true)
})

test.skipIf(!gitAvailable)('集成：pre/post 两张快照、内容可回看、用户 .git 不受影响', async () => {
  const base = mkdtempSync(join(tmpdir(), 'checkpoint-ws-'))
  const cwd = join(base, 'ws')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'a.txt'), 'first\n', 'utf8')
  // node_modules 必须被 info/exclude 挡住：不然一次快照就把整个依赖树收进来。
  mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules', 'pkg', 'index.js'), 'ignored\n', 'utf8')
  try {
    const repo = await ensureRepo(cwd)
    expect(existsSync(join(repo.repo, 'HEAD')), '影子仓库应当建起来').toBe(true)

    const pre = await snapshot(cwd, 'pre', 'turn 1 pre')
    expect(pre.ok, `pre 快照应当成功：${pre.error ?? ''}`).toBe(true)

    writeFileSync(join(cwd, 'a.txt'), 'second\n', 'utf8')
    const post = await snapshot(cwd, 'post', 'turn 1 post')
    expect(post.ok, `post 快照应当成功：${post.error ?? ''}`).toBe(true)

    const entries = await listSnapshots(cwd, 10)
    expect(entries.length, `应当列出两张快照，实际 ${entries.length}`).toBe(2)
    const preEntry = entries.find((entry) => entry.label === 'pre')
    expect(preEntry !== undefined && preEntry.turn === 1).toBe(true)

    const shown = spawnSync('git', ['--git-dir', repo.repo, 'show', `${preEntry?.tag ?? ''}:a.txt`], { encoding: 'utf8' })
    expect(shown.status === 0 && shown.stdout.trim() === 'first', `pre 的内容应当是第一次写的：${shown.stdout}`).toBe(true)

    const tree = spawnSync('git', ['--git-dir', repo.repo, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' })
    expect(tree.status === 0 && !tree.stdout.includes('node_modules'), 'node_modules 应当被 exclude 排除').toBe(true)

    // 这一条是整包的安全边界：工作区里本来没有 .git，跑完也不许有。
    expect(existsSync(join(cwd, '.git')), '用户工作区里不应当出现 .git').toBe(false)
    expect(relative(cwd, repo.repo).startsWith('..'), '影子仓库不应当落在工作区内部').toBe(true)

    const size = await repoSizeMB(cwd)
    expect(Number.isFinite(size) && size >= 0, `占用应当是一个非负数：${size}`).toBe(true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}, 60_000)

test('excludePatterns：dist-*/ 在、dist*/ 不在（distribution/、dists/ 是正常源码目录）', () => {
  const patterns = excludePatterns('D:\\ws')
  expect(patterns.includes('dist/'), 'dist/ 仍要排除').toBe(true)
  expect(patterns.includes('dist-*/'), 'dist-next/ 这类并行构建目录仍要排除').toBe(true)
  expect(patterns.includes('dist*/'), 'dist*/ 会连 distribution/、dists/ 一起排除，不许出现').toBe(false)
  // 需求里的三条点名断言：distribution/、dists/ 不在任何排除模式里，dist-next/ 在。
  const distEntries = patterns.filter((pattern) => pattern.startsWith('dist'))
  expect(distEntries.join('|'), `dist 条目应当只有 dist/ 与 dist-*/：${distEntries.join(' / ')}`).toBe('dist/|dist-*/')
})

test.skipIf(!gitAvailable)('集成：dist-*/ 只挡并行构建目录，distribution/ 与 dists/ 照常进快照', async () => {
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
    expect(shot.ok, `快照应当成功：${shot.error ?? ''}`).toBe(true)
    const tree = spawnSync('git', ['--git-dir', repo.repo, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' })
    expect(tree.status, `ls-tree 应当成功：${tree.stderr}`).toBe(0)
    expect(tree.stdout.includes('distribution/index.ts'), 'distribution/ 是源码目录，必须进快照').toBe(true)
    expect(tree.stdout.includes('dists/core.ts'), 'dists/ 是源码目录，必须进快照').toBe(true)
    expect(tree.stdout.includes('dist-next/app.asar'), 'dist-next/ 是并行构建目录，不该进快照').toBe(false)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('集成：超大文件进了 info/exclude 且活过多次 ensureRepo，也不进快照', async () => {
  const base = mkdtempSync(join(tmpdir(), 'checkpoint-big-'))
  const cwd = join(base, 'ws')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 0x41))
  writeFileSync(join(cwd, 'small.txt'), 'small\n', 'utf8')
  try {
    const repo = await ensureRepo(cwd)
    const excludeFile = join(repo.repo, 'info', 'exclude')
    const excludeLines = (): string[] =>
      readFileSync(excludeFile, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line !== '')
    expect(excludeLines().includes('/big.bin'), `6MB 文件的排除行应当写进 info/exclude：${excludeLines().join(' | ')}`).toBe(true)
    // `bumpTurn()` → `snapshot()` 会连着调两次 ensureRepo：第二次不能把追加的超大文件行冲掉。
    await ensureRepo(cwd)
    expect(excludeLines().includes('/big.bin'), '第二次 ensureRepo 之后排除行必须还在').toBe(true)
    await ensureRepo(cwd)
    expect(excludeLines().includes('/big.bin'), '第三次 ensureRepo 之后排除行也必须还在').toBe(true)

    const shot = await snapshot(cwd, 'pre', 'oversize')
    expect(shot.ok, `快照应当成功：${shot.error ?? ''}`).toBe(true)
    const tree = spawnSync('git', ['--git-dir', repo.repo, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' })
    expect(tree.status, `ls-tree 应当成功：${tree.stderr}`).toBe(0)
    expect(tree.stdout.includes('big.bin'), '超 5MB 的文件不该进快照').toBe(false)
    expect(tree.stdout.includes('small.txt'), '小文件照常进快照').toBe(true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('集成：写者账本记下每回合动了哪些文件', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-ledger-'))
  try {
    const cwd = join(base, 'ws')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'a.txt'), 'one\n', 'utf8')
    await bumpTurn(cwd)
    expect((await snapshot(cwd, 'pre', 'turn 1 pre')).ok, '回合 1 的 pre 快照应当成功').toBe(true)
    writeFileSync(join(cwd, 'a.txt'), 'two\n', 'utf8')
    writeFileSync(join(cwd, 'b.txt'), 'new\n', 'utf8')
    expect((await snapshot(cwd, 'post', 'turn 1 post')).ok, '回合 1 的 post 快照应当成功').toBe(true)
    const first = await recordTurnLedger(cwd, 1)
    expect(first, `第 1 回合应当记两条（改 a.txt、新增 b.txt），实际 ${String(first)}`).toBe(2)
    const turn1 = readLedger(cwd, 1)
    expect(turn1.some((row) => row.path === 'a.txt' && row.action === 'modify'), 'a.txt 记成 modify').toBe(true)
    expect(turn1.some((row) => row.path === 'b.txt' && row.action === 'add'), 'b.txt 记成 add').toBe(true)

    await bumpTurn(cwd)
    expect((await snapshot(cwd, 'pre', 'turn 2 pre')).ok, '回合 2 的 pre 快照应当成功').toBe(true)
    rmSync(join(cwd, 'b.txt'), { force: true })
    expect((await snapshot(cwd, 'post', 'turn 2 post')).ok, '回合 2 的 post 快照应当成功').toBe(true)
    const second = await recordTurnLedger(cwd, 2)
    expect(second, `第 2 回合应当记一条（删 b.txt），实际 ${String(second)}`).toBe(1)
    expect(readLedger(cwd, 2).some((row) => row.path === 'b.txt' && row.action === 'delete'), 'b.txt 记成 delete').toBe(true)
    // 按回合过滤：第 1 回合的两条不该混进第 2 回合。
    expect(readLedger(cwd, 2).length, 'readLedger(turn) 只返回那一回合').toBe(1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}, 60_000)
