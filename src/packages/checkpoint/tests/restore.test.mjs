/**
 * @pneuma/checkpoint 的还原测试：把工作区退回某回合之前，同时保住用户手改的部分。
 *
 * 为什么必须真跑 git：这一块的判定全压在两份真实的快照树上（A = pre、M = post）与
 * `git merge-file` 的真实行为上。用假的树或假的合并器，验不到「同一文件不同区域能合、
 * 同一段冲突一个字节都不写」这两条——它们恰是还原敢不敢上线的分界。
 *
 * 隔离：临时 HOME + 临时 DSC_HOME，每个用例一个临时工作区，真实 ~/.dsc 一个字节都不动。
 * 依赖构建产物：`pnpm run build` 之后跑；git 不可用时整组打印 SKIP 并正常退出。
 *
 * @module @pneuma/checkpoint/tests/restore
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-restore-'))
process.env.DSC_HOME = join(home, '.dsc')
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(process.env.DSC_HOME, { recursive: true })

const { bumpTurn, listSnapshots, restoreTurn, snapshot } = await import(
  new URL('../../../../lib/packages/checkpoint/shadow.js', import.meta.url).href
)

let passed = 0

/** 一条断言：过了就计数（包级测试闸只读最后那行「通过 N」当断言数）。 */
const ok = (condition, message) => {
  assert.ok(condition, message)
  passed += 1
}

/** git 不在时集成部分整体跳过。 */
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
const skip = !gitAvailable ? 'git 不可用' : false

/** 造一个临时工作区（文件内容按 `{ 相对路径: 文本 }` 写进去）。 */
function makeWorkspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-restore-ws-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return root
}

/** 跑一个真回合：pre 快照 → 模型改文件 → post 快照，返回回合号。 */
async function runTurn(cwd, edit) {
  const turn = await bumpTurn(cwd)
  const pre = await snapshot(cwd, 'pre', `turn ${turn} pre`)
  assert.ok(pre.ok === true, `pre 快照失败：${pre.error ?? ''}`)
  edit()
  const post = await snapshot(cwd, 'post', `turn ${turn} post`)
  assert.ok(post.ok === true, `post 快照失败：${post.error ?? ''}`)
  return turn
}

/** 内容指纹：只比字节，不比时间。 */
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 在临时工作区里跑一条 git（造「用户自己的仓库」用）。 */
const gitIn = (cwd, args) =>
  spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })

test('还原：模型改 A 文件、用户改 B 文件 → A 回旧值、B 保留手改', { skip }, async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a-old\n', 'b.txt': 'b-old\n' })
  try {
    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'a.txt'), 'a-model\n', 'utf8')
    })
    writeFileSync(join(cwd, 'b.txt'), 'b-user\n', 'utf8')

    const result = await restoreTurn(cwd, turn)
    ok(result.ok === true, `还原应当成功：${result.error ?? ''}`)
    ok(result.conflicts.length === 0, `不该有冲突：${result.conflicts.join('、')}`)
    ok(result.changed === 1, `模型只改过 1 处，实际 ${result.changed}`)
    ok(result.written === 1, `写回应当 1 处，实际 ${result.written}`)
    ok(readFileSync(join(cwd, 'a.txt'), 'utf8') === 'a-old\n', '模型改的文件应当回到旧内容')
    ok(readFileSync(join(cwd, 'b.txt'), 'utf8') === 'b-user\n', '用户手改的文件应当原样保留')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('还原：同一文件不同区域（模型改第 1 行、用户改第 5 行）→ 两边各自保留', { skip }, async () => {
  const lines = ['line1', 'line2', 'line3', 'line4', 'line5']
  const cwd = makeWorkspace({ 'mix.txt': `${lines.join('\n')}\n` })
  try {
    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'mix.txt'), `${['line1 model', ...lines.slice(1)].join('\n')}\n`, 'utf8')
    })
    // 用户改第 5 行：与模型改的第 1 行隔开，三方合并应当干净。
    writeFileSync(
      join(cwd, 'mix.txt'),
      `${['line1 model', ...lines.slice(1, 4), 'line5 user'].join('\n')}\n`,
      'utf8',
    )

    const result = await restoreTurn(cwd, turn)
    ok(result.ok === true, `还原应当成功：${result.error ?? ''}`)
    ok(result.conflicts.length === 0, `不该有冲突：${result.conflicts.join('、')}`)
    const text = readFileSync(join(cwd, 'mix.txt'), 'utf8')
    ok(text.split('\n')[0] === 'line1', `第 1 行应当回到旧值，实际 ${JSON.stringify(text.split('\n')[0])}`)
    ok(text.split('\n')[4] === 'line5 user', `第 5 行应当保留用户值，实际 ${JSON.stringify(text.split('\n')[4])}`)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('还原：同一段两边都改 → 冲突，盘上 hash 与 mtime 都不变', { skip }, async () => {
  const cwd = makeWorkspace({ 'same.txt': 'head\nbase\n', 'clean.txt': 'clean-old\n' })
  try {
    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'same.txt'), 'head\nmodel\n', 'utf8')
      // 这一份用户没动过：没有冲突时它本该被写回旧值；有冲突时它也不许被写。
      writeFileSync(join(cwd, 'clean.txt'), 'clean-model\n', 'utf8')
    })
    writeFileSync(join(cwd, 'same.txt'), 'head\nuser\n', 'utf8')
    const file = join(cwd, 'same.txt')
    const beforeSha = sha(file)
    const beforeMtime = statSync(file).mtimeMs

    const result = await restoreTurn(cwd, turn)
    ok(result.ok === true, `判定应当算完：${result.error ?? ''}`)
    ok(result.changed === 2, `模型改过 2 处，实际 ${result.changed}`)
    ok(result.conflicts.length === 1, `应当报 1 处冲突，实际 ${result.conflicts.length}`)
    ok(result.conflicts[0] === 'same.txt', `冲突清单应当是 same.txt，实际 ${result.conflicts.join('、')}`)
    ok(result.written === 0, `有冲突时一处都不许写，实际写了 ${result.written}`)
    ok(sha(file) === beforeSha, '有冲突时文件内容不许变')
    ok(statSync(file).mtimeMs === beforeMtime, '有冲突时文件 mtime 不许变')
    ok(readFileSync(file, 'utf8') === 'head\nuser\n', '用户手改应当原样留着')
    ok(readFileSync(join(cwd, 'clean.txt'), 'utf8') === 'clean-model\n', '有冲突时连没有争议的文件也不许写')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('还原：模型新建的文件 → 还原后被删除', { skip }, async () => {
  const cwd = makeWorkspace({ 'keep.txt': 'keep\n' })
  try {
    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'created.txt'), 'model made this\n', 'utf8')
    })
    const result = await restoreTurn(cwd, turn)
    ok(result.ok === true, `还原应当成功：${result.error ?? ''}`)
    ok(result.conflicts.length === 0, `不该有冲突：${result.conflicts.join('、')}`)
    ok(!existsSync(join(cwd, 'created.txt')), '模型新建的文件应当被删除')
    ok(readFileSync(join(cwd, 'keep.txt'), 'utf8') === 'keep\n', '没被模型碰过的文件不许动')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('还原：模型删除的文件 → 还原后恢复', { skip }, async () => {
  const cwd = makeWorkspace({ 'gone.txt': 'bring me back\n' })
  try {
    const turn = await runTurn(cwd, () => {
      rmSync(join(cwd, 'gone.txt'), { force: true })
    })
    const result = await restoreTurn(cwd, turn)
    ok(result.ok === true, `还原应当成功：${result.error ?? ''}`)
    ok(result.conflicts.length === 0, `不该有冲突：${result.conflicts.join('、')}`)
    ok(existsSync(join(cwd, 'gone.txt')), '模型删除的文件应当被恢复')
    ok(readFileSync(join(cwd, 'gone.txt'), 'utf8') === 'bring me back\n', '恢复的内容应当是删除前那一份')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('还原：二进制文件在用户没动过时整文件写回旧内容', { skip }, async () => {
  const before = Buffer.from([0x00, 0x01, 0x02, 0xff])
  const after = Buffer.from([0x00, 0x09, 0x09, 0xfe])
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-restore-bin-'))
  const file = join(root, 'blob.bin')
  writeFileSync(file, before)
  try {
    const turn = await runTurn(root, () => {
      writeFileSync(file, after)
    })
    const result = await restoreTurn(root, turn)
    ok(result.ok === true, `还原应当成功：${result.error ?? ''}`)
    ok(result.written === 1, `应当写回 1 处，实际 ${result.written}`)
    ok(readFileSync(file).equals(before), '二进制文件应当按字节写回旧内容')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('还原：不碰用户自己的 .git（前后 git status --porcelain 一致）', { skip }, async () => {
  const cwd = makeWorkspace({ 'keep.txt': 'base\n', 'scratch/a.txt': 'a-old\n', 'scratch/b.txt': 'b-old\n' })
  try {
    const init = gitIn(cwd, ['init'])
    ok(init.status === 0, `git init 应当成功：${init.stderr}`)
    // 用户仓库只认 keep.txt；scratch/ 走 .git/info/exclude（影子仓库读不到它，照常拍进去）。
    mkdirSync(join(cwd, '.git', 'info'), { recursive: true })
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'scratch/\n', 'utf8')
    const added = gitIn(cwd, ['add', 'keep.txt'])
    ok(added.status === 0, `git add 应当成功：${added.stderr}`)
    const commit = gitIn(cwd, ['commit', '-m', 'init'])
    ok(commit.status === 0, `git commit 应当成功：${commit.stderr}`)
    // 一个稳定的未跟踪文件：让「status 一致」不是「空对空」。
    writeFileSync(join(cwd, 'dirty.txt'), 'not committed\n', 'utf8')
    const before = gitIn(cwd, ['status', '--porcelain']).stdout
    ok(before.includes('dirty.txt'), `造现场失败，status 里应当有 dirty.txt：${JSON.stringify(before)}`)

    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'scratch', 'a.txt'), 'a-model\n', 'utf8')
    })
    writeFileSync(join(cwd, 'scratch', 'b.txt'), 'b-user\n', 'utf8')

    const result = await restoreTurn(cwd, turn)
    ok(result.ok === true, `还原应当成功：${result.error ?? ''}`)
    ok(readFileSync(join(cwd, 'scratch', 'a.txt'), 'utf8') === 'a-old\n', '模型改的文件应当回到旧内容')
    ok(readFileSync(join(cwd, 'scratch', 'b.txt'), 'utf8') === 'b-user\n', '用户手改应当保留')
    const after = gitIn(cwd, ['status', '--porcelain']).stdout
    ok(after === before, `用户仓库的 status 应当一字不差：\n前 ${JSON.stringify(before)}\n后 ${JSON.stringify(after)}`)
    ok(!existsSync(join(cwd, '.git', 'index.lock')), '不应当留下用户仓库的 index.lock')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('还原：还原前那张 manual-restore 快照真的存在', { skip }, async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a-old\n' })
  try {
    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'a.txt'), 'a-model\n', 'utf8')
    })
    const result = await restoreTurn(cwd, turn)
    ok(result.ok === true, `还原应当成功：${result.error ?? ''}`)
    ok(typeof result.safetyTag === 'string', '还原应当报出安全快照的标签')
    ok(result.safetyTag.startsWith('dsc/manual-restore-'), `标签形状不对：${result.safetyTag}`)

    const entries = await listSnapshots(cwd, 20)
    const manual = entries.filter((entry) => entry.label === 'manual')
    ok(manual.length === 1, `应当有 1 张还原前快照，实际 ${manual.length}`)
    ok(manual[0].tag === result.safetyTag, `列表里的标签应当是 ${result.safetyTag}，实际 ${manual[0].tag}`)
    ok(entries.some((entry) => entry.label === 'pre' && entry.turn === turn), '回合快照应当还在列表里')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('还原：回合号不存在 → 说清楚并列出最近可用的回合', { skip }, async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a-old\n' })
  try {
    await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'a.txt'), 'a-model\n', 'utf8')
    })
    const result = await restoreTurn(cwd, 9)
    ok(result.ok === false, '不存在的回合号不该算成功')
    ok(result.error === 'missing', `错误码应当是 missing，实际 ${String(result.error)}`)
    ok(result.available.includes(1), `可用回合里应当有 1，实际 ${result.available.join('、')}`)
    ok(result.available.length <= 5, `最多列 5 个回合，实际 ${result.available.length}`)
    ok(readFileSync(join(cwd, 'a.txt'), 'utf8') === 'a-model\n', '判不了就一个字都不许写')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

after(() => {
  rmSync(home, { recursive: true, force: true })
  console.log(`通过 ${String(passed)} 项`)
})
