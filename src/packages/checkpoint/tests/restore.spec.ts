/**
 * @pneuma/checkpoint 的还原测试：把工作区退回某回合之前，同时保住用户手改的部分。
 *
 * 为什么必须真跑 git：这一块的判定全压在两份真实的快照树上（A = pre、M = post）与
 * `git merge-file` 的真实行为上。用假的树或假的合并器，验不到「同一文件不同区域能合、
 * 同一段冲突一个字节都不写」这两条——它们恰是还原敢不敢上线的分界。
 *
 * 隔离：临时 HOME + 临时 DSC_HOME，每个用例一个临时工作区，真实 ~/.dsc 一个字节都不动。
 * `path-policy` 在模块加载时读 `DSC_HOME`，所以先设环境再动态 import；git 不可用时整组 skip。
 *
 * @module @pneuma/checkpoint/tests/restore
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-restore-spec-'))
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

const { bumpTurn, listSnapshots, restoreTurn, snapshot } = await import('../shadow.js')

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(home, { recursive: true, force: true })
})

/** git 不在时整组跳过。 */
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

/** 造一个临时工作区（文件内容按 `{ 相对路径: 文本 }` 写进去）。 */
function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-restore-ws-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return root
}

/** 跑一个真回合：pre 快照 → 模型改文件 → post 快照，返回回合号。 */
async function runTurn(cwd: string, edit: () => void): Promise<number> {
  const turn = await bumpTurn(cwd)
  const pre = await snapshot(cwd, 'pre', `turn ${turn} pre`)
  expect(pre.ok, `pre 快照失败：${pre.error ?? ''}`).toBe(true)
  edit()
  const post = await snapshot(cwd, 'post', `turn ${turn} post`)
  expect(post.ok, `post 快照失败：${post.error ?? ''}`).toBe(true)
  return turn
}

/** 内容指纹：只比字节，不比时间。 */
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 在临时工作区里跑一条 git（造「用户自己的仓库」用）。 */
const gitIn = (cwd: string, args: string[]) =>
  spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })

test.skipIf(!gitAvailable)('还原：模型改 A 文件、用户改 B 文件 → A 回旧值、B 保留手改', async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a-old\n', 'b.txt': 'b-old\n' })
  try {
    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'a.txt'), 'a-model\n', 'utf8')
    })
    writeFileSync(join(cwd, 'b.txt'), 'b-user\n', 'utf8')

    const result = await restoreTurn(cwd, turn)
    expect(result.ok, `还原应当成功：${result.error ?? ''}`).toBe(true)
    expect(result.conflicts.length, `不该有冲突：${result.conflicts.join('、')}`).toBe(0)
    expect(result.changed, `模型只改过 1 处，实际 ${String(result.changed)}`).toBe(1)
    expect(result.written, `写回应当 1 处，实际 ${String(result.written)}`).toBe(1)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8'), '模型改的文件应当回到旧内容').toBe('a-old\n')
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8'), '用户手改的文件应当原样保留').toBe('b-user\n')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('还原：同一文件不同区域（模型改第 1 行、用户改第 5 行）→ 两边各自保留', async () => {
  const lines = ['line1', 'line2', 'line3', 'line4', 'line5']
  const cwd = makeWorkspace({ 'mix.txt': `${lines.join('\n')}\n` })
  try {
    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'mix.txt'), `${['line1 model', ...lines.slice(1)].join('\n')}\n`, 'utf8')
    })
    // 用户改第 5 行：与模型改的第 1 行隔开，三方合并应当干净。
    writeFileSync(join(cwd, 'mix.txt'), `${['line1 model', ...lines.slice(1, 4), 'line5 user'].join('\n')}\n`, 'utf8')

    const result = await restoreTurn(cwd, turn)
    expect(result.ok, `还原应当成功：${result.error ?? ''}`).toBe(true)
    expect(result.conflicts.length, `不该有冲突：${result.conflicts.join('、')}`).toBe(0)
    const text = readFileSync(join(cwd, 'mix.txt'), 'utf8').split('\n')
    expect(text[0], `第 1 行应当回到旧值，实际 ${JSON.stringify(text[0])}`).toBe('line1')
    expect(text[4], `第 5 行应当保留用户值，实际 ${JSON.stringify(text[4])}`).toBe('line5 user')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('还原：同一段两边都改 → 冲突，盘上 hash 与 mtime 都不变', async () => {
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
    expect(result.ok, `判定应当算完：${result.error ?? ''}`).toBe(true)
    expect(result.changed, `模型改过 2 处，实际 ${String(result.changed)}`).toBe(2)
    expect(result.conflicts.length, `应当报 1 处冲突，实际 ${String(result.conflicts.length)}`).toBe(1)
    expect(result.conflicts[0], `冲突清单应当是 same.txt，实际 ${result.conflicts.join('、')}`).toBe('same.txt')
    expect(result.written, `有冲突时一处都不许写，实际写了 ${String(result.written)}`).toBe(0)
    expect(sha(file), '有冲突时文件内容不许变').toBe(beforeSha)
    expect(statSync(file).mtimeMs, '有冲突时文件 mtime 不许变').toBe(beforeMtime)
    expect(readFileSync(file, 'utf8'), '用户手改应当原样留着').toBe('head\nuser\n')
    expect(readFileSync(join(cwd, 'clean.txt'), 'utf8'), '有冲突时连没有争议的文件也不许写').toBe('clean-model\n')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('还原：模型新建的文件 → 还原后被删除', async () => {
  const cwd = makeWorkspace({ 'keep.txt': 'keep\n' })
  try {
    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'created.txt'), 'model made this\n', 'utf8')
    })
    const result = await restoreTurn(cwd, turn)
    expect(result.ok, `还原应当成功：${result.error ?? ''}`).toBe(true)
    expect(result.conflicts.length, `不该有冲突：${result.conflicts.join('、')}`).toBe(0)
    expect(existsSync(join(cwd, 'created.txt')), '模型新建的文件应当被删除').toBe(false)
    expect(readFileSync(join(cwd, 'keep.txt'), 'utf8'), '没被模型碰过的文件不许动').toBe('keep\n')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('还原：模型删除的文件 → 还原后恢复', async () => {
  const cwd = makeWorkspace({ 'gone.txt': 'bring me back\n' })
  try {
    const turn = await runTurn(cwd, () => {
      rmSync(join(cwd, 'gone.txt'), { force: true })
    })
    const result = await restoreTurn(cwd, turn)
    expect(result.ok, `还原应当成功：${result.error ?? ''}`).toBe(true)
    expect(result.conflicts.length, `不该有冲突：${result.conflicts.join('、')}`).toBe(0)
    expect(existsSync(join(cwd, 'gone.txt')), '模型删除的文件应当被恢复').toBe(true)
    expect(readFileSync(join(cwd, 'gone.txt'), 'utf8'), '恢复的内容应当是删除前那一份').toBe('bring me back\n')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('还原：二进制文件在用户没动过时整文件写回旧内容', async () => {
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
    expect(result.ok, `还原应当成功：${result.error ?? ''}`).toBe(true)
    expect(result.written, `应当写回 1 处，实际 ${String(result.written)}`).toBe(1)
    expect(readFileSync(file).equals(before), '二进制文件应当按字节写回旧内容').toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('还原：不碰用户自己的 .git（前后 git status --porcelain 一致）', async () => {
  const cwd = makeWorkspace({ 'keep.txt': 'base\n', 'scratch/a.txt': 'a-old\n', 'scratch/b.txt': 'b-old\n' })
  try {
    const init = gitIn(cwd, ['init'])
    expect(init.status, `git init 应当成功：${init.stderr}`).toBe(0)
    // 用户仓库只认 keep.txt；scratch/ 走 .git/info/exclude（影子仓库读不到它，照常拍进去）。
    mkdirSync(join(cwd, '.git', 'info'), { recursive: true })
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'scratch/\n', 'utf8')
    const added = gitIn(cwd, ['add', 'keep.txt'])
    expect(added.status, `git add 应当成功：${added.stderr}`).toBe(0)
    const commit = gitIn(cwd, ['commit', '-m', 'init'])
    expect(commit.status, `git commit 应当成功：${commit.stderr}`).toBe(0)
    // 一个稳定的未跟踪文件：让「status 一致」不是「空对空」。
    writeFileSync(join(cwd, 'dirty.txt'), 'not committed\n', 'utf8')
    const before = gitIn(cwd, ['status', '--porcelain']).stdout
    expect(before.includes('dirty.txt'), `造现场失败，status 里应当有 dirty.txt：${JSON.stringify(before)}`).toBe(true)

    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'scratch', 'a.txt'), 'a-model\n', 'utf8')
    })
    writeFileSync(join(cwd, 'scratch', 'b.txt'), 'b-user\n', 'utf8')

    const result = await restoreTurn(cwd, turn)
    expect(result.ok, `还原应当成功：${result.error ?? ''}`).toBe(true)
    expect(readFileSync(join(cwd, 'scratch', 'a.txt'), 'utf8'), '模型改的文件应当回到旧内容').toBe('a-old\n')
    expect(readFileSync(join(cwd, 'scratch', 'b.txt'), 'utf8'), '用户手改应当保留').toBe('b-user\n')
    const after = gitIn(cwd, ['status', '--porcelain']).stdout
    expect(after, `用户仓库的 status 应当一字不差：\n前 ${JSON.stringify(before)}\n后 ${JSON.stringify(after)}`).toBe(before)
    expect(existsSync(join(cwd, '.git', 'index.lock')), '不应当留下用户仓库的 index.lock').toBe(false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('还原：还原前那张 manual-restore 快照真的存在', async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a-old\n' })
  try {
    const turn = await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'a.txt'), 'a-model\n', 'utf8')
    })
    const result = await restoreTurn(cwd, turn)
    expect(result.ok, `还原应当成功：${result.error ?? ''}`).toBe(true)
    expect(typeof result.safetyTag, '还原应当报出安全快照的标签').toBe('string')
    expect(result.safetyTag?.startsWith('dsc/manual-restore-'), `标签形状不对：${String(result.safetyTag)}`).toBe(true)

    const entries = await listSnapshots(cwd, 20)
    const manual = entries.filter((entry) => entry.label === 'manual')
    expect(manual.length, `应当有 1 张还原前快照，实际 ${String(manual.length)}`).toBe(1)
    expect(manual[0]?.tag, `列表里的标签应当是 ${String(result.safetyTag)}`).toBe(result.safetyTag)
    expect(entries.some((entry) => entry.label === 'pre' && entry.turn === turn), '回合快照应当还在列表里').toBe(true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!gitAvailable)('还原：回合号不存在 → 说清楚并列出最近可用的回合', async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a-old\n' })
  try {
    await runTurn(cwd, () => {
      writeFileSync(join(cwd, 'a.txt'), 'a-model\n', 'utf8')
    })
    const result = await restoreTurn(cwd, 9)
    expect(result.ok, '不存在的回合号不该算成功').toBe(false)
    expect(result.error, `错误码应当是 missing，实际 ${String(result.error)}`).toBe('missing')
    expect(result.available.includes(1), `可用回合里应当有 1，实际 ${result.available.join('、')}`).toBe(true)
    expect(result.available.length, `最多列 5 个回合，实际 ${String(result.available.length)}`).toBeLessThanOrEqual(5)
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8'), '判不了就一个字都不许写').toBe('a-model\n')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 60_000)
