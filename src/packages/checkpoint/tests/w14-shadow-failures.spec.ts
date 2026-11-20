/**
 * checkpoint 影子仓库补测（W14）：补 `shadow.ts` 未覆盖的失败分支与特殊文件分支。
 *
 * 覆盖目标（对照 W14 缺口清单）：
 * - 快照：影子仓库 index 损坏时 `git add -A` 失败必须报错（不能把旧索引再提交一遍）；
 * - 快照：提交成功但打标签失败时的兜底错误；
 * - 还原：磁盘上同一路径变成目录（`diskState` 的 `other`）、快照里是符号链接（冲突）、
 *   超过 10MB 的文本两边都改（冲突）、工作区路径不是目录（外层兜底返回错误）；
 * - 写者账本：标签不存在时 `recordTurnLedger` 吞错返回 0。
 *
 * 为什么必须真跑 git：这些判定全压在真实快照树与真实 git 命令的失败面上，假树验不到。
 * 为什么符号链接用「注入快照条目 + 目录联接」而不是真建文件符号链接：
 * 本机/Windows CI 未开开发者模式时 `fs.symlinkSync('file')` 直接 EPERM，但还原的真实场景是
 * 「快照在别的机器（`core.symlinks=true`）上拍的，拿到这台机器还原」——用 `git update-index`
 * 往快照树里注入一条 mode 120000 的条目，再用无需特权的目录联接（junction）造出盘上的
 * 链接状态，复核的正是 `shadow.ts` 里同一段判定，没有绕过被测代码。
 *
 * 隔离：临时 HOME + 临时 DSC_HOME，每个用例一个临时工作区；`path-policy` 在模块加载时读
 * `DSC_HOME`，所以先设环境再动态 import。git 不可用时整组 skip（与 `restore.spec.ts` 同口径）。
 *
 * @module @pneuma/checkpoint/tests/w14-shadow-failures
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-w14-spec-'))
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

const { bumpTurn, recordTurnLedger, restoreTurn, shadowRepoPath, snapshot } = await import('../shadow.js')

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(home, { recursive: true, force: true })
})

/** git 不在时整组跳过（与既有 restore.spec.ts 同一判据）。 */
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

/** 造一个临时工作区（文件内容按 `{ 相对路径: 文本 }` 写进去）。 */
function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-w14-ws-'))
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

/** 影子仓库的 git 环境（与 `shadow.ts` 的 shadowEnv 同一组变量，外加提交身份）。 */
function shadowEnvOf(cwd: string, indexFile: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: shadowRepoPath(cwd),
    GIT_WORK_TREE: resolve(cwd),
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: 'dsc',
    GIT_AUTHOR_EMAIL: 'dsc@local',
    GIT_COMMITTER_NAME: 'dsc',
    GIT_COMMITTER_EMAIL: 'dsc@local',
  }
}

/** 在影子仓库里跑一条 git，失败直接抛（测试脚手架，不是被测代码）。 */
function shadowGitOf(cwd: string, env: NodeJS.ProcessEnv, args: string[], input?: string): string {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: resolve(cwd),
    env,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  })
  if (result.status !== 0) throw new Error(`脚手架 git ${args.join(' ')} 失败：${result.stderr}`)
  return String(result.stdout)
}

/**
 * 把第 `turn` 回合的 post 标签改写成「pre 的整棵树 + 一条 mode 120000 的符号链接」，
 * 模拟「快照在 `core.symlinks=true` 的机器上拍的」这一真实跨机场景。
 */
function injectLinkIntoPost(cwd: string, turn: number, relPath: string, target: string): void {
  const env = shadowEnvOf(cwd, join(home, `inject-index-${String(turn)}-${String(Date.now())}`))
  const preTag = `dsc/turn-${String(turn)}-pre`
  const postTag = `dsc/turn-${String(turn)}-post`
  shadowGitOf(cwd, env, ['read-tree', preTag])
  const blob = shadowGitOf(cwd, env, ['hash-object', '-w', '--stdin'], target).trim()
  shadowGitOf(cwd, env, ['update-index', '--add', '--cacheinfo', `120000,${blob},${relPath}`])
  const tree = shadowGitOf(cwd, env, ['write-tree']).trim()
  const parent = shadowGitOf(cwd, env, ['rev-parse', `${postTag}^{commit}`]).trim()
  const commit = shadowGitOf(cwd, env, ['commit-tree', tree, '-p', parent, '-m', '注入符号链接条目']).trim()
  shadowGitOf(cwd, env, ['update-ref', `refs/tags/${postTag}`, commit])
}

/** 在盘上造一个无需特权的目录链接（Windows 用 junction，POSIX 用目录符号链接）。 */
function makeDirLink(target: string, linkPath: string): void {
  symlinkSync(resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

test.skipIf(!gitAvailable)(
  '快照：影子仓库 index 损坏时 add 失败要报错，不静默提交旧索引',
  async () => {
    const cwd = makeWorkspace({ 'a.txt': 'a\n' })
    try {
      const turn = await bumpTurn(cwd)
      expect((await snapshot(cwd, 'pre', 'turn 1 pre')).ok).toBe(true)
      // 弄坏影子仓库的 index：下一次 `git add -A` 必然失败。
      writeFileSync(join(shadowRepoPath(cwd), 'index'), 'not a git index\n', 'utf8')
      expect(await bumpTurn(cwd)).toBe(turn + 1)
      const result = await snapshot(cwd, 'pre', 'turn 2 pre')
      expect(result.ok).toBe(false)
      expect(result.error, '失败原因要指出是 add 失败').toContain('git add -A 失败')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  },
  60_000,
)

test.skipIf(!gitAvailable)(
  '快照：提交失败（分支锁被占）时返回错误，不假装成功',
  async () => {
    const cwd = makeWorkspace({ 'a.txt': 'a\n' })
    try {
      await bumpTurn(cwd)
      expect((await snapshot(cwd, 'pre', 'turn 1 pre')).ok).toBe(true)
      const turn = await bumpTurn(cwd)
      // 用目录占住当前分支的引用锁：`git add` 能过，`git commit` 必然失败。
      const repo = shadowRepoPath(cwd)
      const head = readFileSync(join(repo, 'HEAD'), 'utf8')
        .trim()
        .replace(/^ref:\s*/, '')
      mkdirSync(join(repo, `${head}.lock`), { recursive: true })
      const result = await snapshot(cwd, 'pre', `turn ${String(turn)} pre`)
      expect(result.ok).toBe(false)
      expect(result.error ?? '', '兜底错误不能是空的').not.toBe('')
      expect(result.error ?? '', '这一条不是 add 失败，而是提交失败').not.toContain('git add -A 失败')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  },
  60_000,
)

test.skipIf(!gitAvailable)(
  '还原：盘上同一路径变成目录 → 记为 other 并判冲突，一个文件都不写',
  async () => {
    const cwd = makeWorkspace({ 'gone.txt': 'v1\n', 'keep.txt': 'k\n' })
    try {
      const turn = await runTurn(cwd, () => {
        unlinkSync(join(cwd, 'gone.txt'))
        writeFileSync(join(cwd, 'keep.txt'), 'k-model\n', 'utf8')
      })
      // 用户在模型删掉之后又在同一路径建了个目录：roadblock 不是普通文件。
      mkdirSync(join(cwd, 'gone.txt'))
      const result = await restoreTurn(cwd, turn)
      expect(result.ok, `判定应当算完：${result.error ?? ''}`).toBe(true)
      expect(result.conflicts).toContain('gone.txt')
      expect(result.written, '有冲突时一处都不许写').toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  },
  60_000,
)

test.skipIf(!gitAvailable)(
  '还原：快照里是符号链接 + 盘上是链接 → 不做三方合并，报符号链接冲突',
  async () => {
    const cwd = makeWorkspace({ 'switch.txt': 'old\n' })
    const targetDir = mkdtempSync(join(tmpdir(), 'checkpoint-w14-link-target-'))
    try {
      const turn = await bumpTurn(cwd)
      expect((await snapshot(cwd, 'pre', `turn ${turn} pre`)).ok).toBe(true)
      // 模拟「模型把这个文件改成了符号链接」：post 快照树里注入一条 120000 条目。
      writeFileSync(join(cwd, 'switch.txt'), 'old\n', 'utf8')
      const post = await snapshot(cwd, 'post', `turn ${turn} post`)
      expect(post.ok, `post 快照失败：${post.error ?? ''}`).toBe(true)
      injectLinkIntoPost(cwd, turn, 'switch.txt', 'some/other-target')

      // 盘上：删掉普通文件，换成目录链接（junction 不需要开发者模式）。
      unlinkSync(join(cwd, 'switch.txt'))
      makeDirLink(targetDir, join(cwd, 'switch.txt'))

      const result = await restoreTurn(cwd, turn)
      expect(result.ok, `判定应当算完：${result.error ?? ''}`).toBe(true)
      expect(result.conflicts).toContain('switch.txt')
      const decision = result.decisions.find((item) => item.path === 'switch.txt')
      expect(decision?.reason, '原因要写清是符号链接不做合并').toBe('符号链接不做合并')
      expect(result.written, '有冲突时一处都不许写').toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(targetDir, { recursive: true, force: true })
    }
  },
  60_000,
)

test.skipIf(!gitAvailable)(
  '还原：盘上那份文本超过 10MB 且两边都改 → 不做文本合并，报超限冲突',
  async () => {
    // 快照自身的上限是 5MB（更大的文件不进快照），所以 A / M 都在 5MB 以下；
    // 用户手改之后盘上那份 11MB，`disk.size` 超过 MAX_MERGE_BYTES（10MB）。
    const base = 'x'.repeat(4 * 1024 * 1024)
    const cwd = makeWorkspace({ 'big.txt': base })
    try {
      const turn = await runTurn(cwd, () => {
        writeFileSync(join(cwd, 'big.txt'), `${base}y`, 'utf8')
      })
      // 用户也改这一份且超过 10MB：内容与 A、M 都不同，才有资格进三方合并的候选。
      writeFileSync(join(cwd, 'big.txt'), `${base}${'z'.repeat(8 * 1024 * 1024)}`, 'utf8')
      const result = await restoreTurn(cwd, turn)
      expect(result.ok, `判定应当算完：${result.error ?? ''}`).toBe(true)
      expect(result.conflicts).toContain('big.txt')
      const decision = result.decisions.find((item) => item.path === 'big.txt')
      expect(decision?.reason, '原因要写清是体积超限').toBe('超过 10MB，不做文本合并')
      expect(result.written, '有冲突时一处都不许写').toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  },
  120_000,
)

test.skipIf(!gitAvailable)('还原：工作区路径不是目录 → 外层兜底返回错误而不是抛异常', async () => {
  const fakeCwd = join(home, 'w14-not-a-directory.txt')
  writeFileSync(fakeCwd, 'i am a file\n', 'utf8')
  const result = await restoreTurn(fakeCwd, 1)
  expect(result.ok).toBe(false)
  expect(typeof result.error).toBe('string')
  expect(result.error ?? '').not.toBe('')
})

test.skipIf(!gitAvailable)(
  '写者账本：回合标签不存在时吞错返回 0',
  async () => {
    const cwd = makeWorkspace({ 'a.txt': 'a\n' })
    try {
      // 仓库还没建过、标签也不存在：`git diff` 必然失败，账本按「记不上」处理。
      expect(await recordTurnLedger(cwd, 7)).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  },
  60_000,
)
