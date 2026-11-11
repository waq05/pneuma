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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-test-'))
process.env.DSC_HOME = join(home, '.dsc')
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(process.env.DSC_HOME, { recursive: true })

const { ensureRepo, listSnapshots, repoSizeMB, shadowRoot, snapshot } = await import(
  new URL('../../../../lib/packages/checkpoint/shadow.js', import.meta.url).href
)

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

after(() => {
  rmSync(home, { recursive: true, force: true })
  console.log(`通过 ${String(passed)} 项`)
})
