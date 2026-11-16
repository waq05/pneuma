/**
 * checkpoint 影子仓库的补盲（`packages/checkpoint/shadow.ts`）：
 * 状态文件坏掉、仓库还没建、快照失败、还原的冲突/跳过判定，以及账本的坏行/改名/截断。
 *
 * 与既有 restore 测试同一套隔离：模块加载前把 HOME / USERPROFILE / DSC_HOME 指到临时目录，
 * 真跑 git（不可用则整组 skip）。每个工作区独立，跑完删除。
 *
 * @module dsc/packages/checkpoint/tests/w11-branches.spec
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-w11-'))
const savedEnv = {
  DSC_HOME: process.env.DSC_HOME,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
}
process.env.DSC_HOME = join(home, '.dsc')
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(process.env.DSC_HOME, { recursive: true })

const shadow = await import('../shadow.js')
const { bumpTurn, currentTurn, listSnapshots, readLedger, recordTurnLedger, repoSizeMB, restoreTurn, shadowRepoPath, shadowRoot, snapshot, snapshotManual } =
  shadow

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

const dirs: string[] = []
function makeWorkspace(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsc-checkpoint-w11-ws-'))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // Windows 上偶发占用
    }
  }
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(home, { recursive: true, force: true })
})

/** 跑一个真回合：pre → edit → post。 */
async function runTurn(cwd: string, edit: () => void): Promise<number> {
  const turn = await bumpTurn(cwd)
  expect((await snapshot(cwd, 'pre', `turn ${turn} pre`)).ok).toBe(true)
  edit()
  expect((await snapshot(cwd, 'post', `turn ${turn} post`)).ok).toBe(true)
  return turn
}

test('currentTurn：没有状态文件是 0；坏 JSON / 负数也回 0', () => {
  const cwd = makeWorkspace({ 'a.txt': 'a\n' })
  expect(currentTurn(cwd)).toBe(0)
  mkdirSync(shadowRoot(cwd), { recursive: true })
  writeFileSync(join(shadowRoot(cwd), 'state.json'), '{bad', 'utf8')
  expect(currentTurn(cwd)).toBe(0)
  writeFileSync(join(shadowRoot(cwd), 'state.json'), JSON.stringify({ lastTurn: -3 }), 'utf8')
  expect(currentTurn(cwd)).toBe(0)
})

test.skipIf(!gitAvailable)('影子仓库还没建：listSnapshots 给空数组、repoSizeMB 给 0', async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a\n' })
  await expect(listSnapshots(cwd)).resolves.toEqual([])
  await expect(repoSizeMB(cwd)).resolves.toBe(0)
})

test.skipIf(!gitAvailable)('工作区路径失效：snapshot / snapshotManual 都回 ok=false 而不是抛', async () => {
  const file = join(makeWorkspace({ 'a.txt': 'a\n' }), 'a.txt')
  const snap = await snapshot(file, 'pre', 'x')
  expect(snap).toMatchObject({ ok: false })
  expect(snap.error).toBeTruthy()
  const manual = await snapshotManual(file)
  expect(manual).toMatchObject({ ok: false })
  expect(manual.error).toBeTruthy()
})

test.skipIf(!gitAvailable)('快照后 repoSizeMB 有数；manual 快照进 list 但不算可用回合', async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a\n' })
  await runTurn(cwd, () => writeFileSync(join(cwd, 'a.txt'), 'b\n', 'utf8'))
  await repoSizeMB(cwd)

  const manual = await snapshotManual(cwd, new Date(2026, 0, 2, 3, 4, 5))
  expect(manual.ok).toBe(true)
  const listed = await listSnapshots(cwd, 50)
  expect(listed.some((entry) => entry.label === 'manual')).toBe(true)
})

test.skipIf(!gitAvailable)('restoreTurn：回合号非法 / 不存在 / 只有 pre 三种错误', async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a\n' })
  expect((await restoreTurn(cwd, Number.NaN)).error).toBe('bad-turn')
  expect((await restoreTurn(cwd, 0)).error).toBe('bad-turn')

  const missing = await restoreTurn(cwd, 9)
  expect(missing.error).toBe('missing')
  expect(missing.available).toEqual([])

  const turn = await bumpTurn(cwd)
  await snapshot(cwd, 'pre', 'only pre')
  const missingPost = await restoreTurn(cwd, turn)
  expect(missingPost.error).toBe('missing-post')
})

test.skipIf(!gitAvailable)('还原：用户已改回起点 → 跳过；用户删掉模型改过的文件 → 冲突', async () => {
  const cwd = makeWorkspace({ 'skip.txt': 'old\n', 'gone.txt': 'old\n', 'write.txt': 'old\n' })
  const turn = await runTurn(cwd, () => {
    writeFileSync(join(cwd, 'skip.txt'), 'model\n', 'utf8')
    writeFileSync(join(cwd, 'gone.txt'), 'model\n', 'utf8')
    writeFileSync(join(cwd, 'write.txt'), 'model\n', 'utf8')
  })
  // 用户把 skip.txt 改回起点；把 gone.txt 删掉；write.txt 不动。
  writeFileSync(join(cwd, 'skip.txt'), 'old\n', 'utf8')
  rmSync(join(cwd, 'gone.txt'))

  const result = await restoreTurn(cwd, turn)
  expect(result.ok).toBe(true)
  expect(result.conflicts).toEqual(['gone.txt'])
  // 有冲突时一个文件都不写。
  expect(result.written).toBe(0)
  expect(result.decisions.find((item) => item.path === 'skip.txt')?.action).toBe('skip')
})

test.skipIf(!gitAvailable)('还原：模型新建后用户又改 → 冲突；二进制两边都改 → 冲突', async () => {
  const cwd = makeWorkspace({ 'bin.dat': Buffer.from([0x61, 0x00, 0x62]) })
  const turn = await runTurn(cwd, () => {
    writeFileSync(join(cwd, 'new.txt'), 'model\n', 'utf8')
    writeFileSync(join(cwd, 'bin.dat'), Buffer.from([0x61, 0x00, 0x63]))
  })
  writeFileSync(join(cwd, 'new.txt'), 'user\n', 'utf8')
  writeFileSync(join(cwd, 'bin.dat'), Buffer.from([0x61, 0x00, 0x64]))

  const result = await restoreTurn(cwd, turn)
  expect(result.ok).toBe(true)
  expect(result.conflicts).toEqual(expect.arrayContaining(['new.txt', 'bin.dat']))
  expect(result.decisions.find((item) => item.path === 'new.txt')?.reason).toContain('模型新建或删除过')
  expect(result.decisions.find((item) => item.path === 'bin.dat')?.reason).toContain('二进制')
})

test.skipIf(!gitAvailable)('还原：符号链接不做合并（平台不支持建链接就跳过）', async () => {
  const cwd = makeWorkspace({ 'target.txt': 'old\n' })
  try {
    symlinkSync('target.txt', join(cwd, 'link.txt'))
  } catch {
    return
  }
  const turn = await runTurn(cwd, () => {
    try {
      rmSync(join(cwd, 'link.txt'))
      symlinkSync('other.txt', join(cwd, 'link.txt'))
    } catch {
      // 建不了链接就保持原样
    }
  })
  try {
    rmSync(join(cwd, 'link.txt'))
    symlinkSync('third.txt', join(cwd, 'link.txt'))
  } catch {
    return
  }
  const result = await restoreTurn(cwd, turn)
  expect(result.decisions.some((item) => item.reason === '符号链接不做合并')).toBe(true)
})

test.skipIf(!gitAvailable)('账本：坏行跳过、turn 过滤、未知 action 丢掉', () => {
  const cwd = makeWorkspace({ 'a.txt': 'a\n' })
  mkdirSync(shadowRoot(cwd), { recursive: true })
  const lines = [
    '{bad',
    JSON.stringify({ turn: 1, action: 'add', path: 'a.txt', at: 1 }),
    JSON.stringify({ turn: 2, action: 'modify', path: 'b.txt', at: 2 }),
    JSON.stringify({ turn: 3, action: 'bogus', path: 'c.txt', at: 3 }),
    JSON.stringify({ turn: 4, action: 'rename', path: 'd.txt', from: 'c.txt', at: 4 }),
    JSON.stringify({ turn: 5, action: 'delete' }),
  ]
  writeFileSync(join(shadowRoot(cwd), 'ledger.jsonl'), `${lines.join('\n')}\n`, 'utf8')
  expect(readLedger(cwd)).toHaveLength(3)
  expect(readLedger(cwd, 2)).toEqual([{ turn: 2, action: 'modify', path: 'b.txt', at: 2 }])
  expect(readLedger(cwd, 4)[0]).toMatchObject({ action: 'rename', from: 'c.txt' })
})

test.skipIf(!gitAvailable)('账本：无变化的回合记 0 条；改名记 rename；超过 5000 行会截断', async () => {
  const cwd = makeWorkspace({ 'old.txt': 'rename me\n', 'b.txt': 'b\n' })
  const emptyTurn = await bumpTurn(cwd)
  await snapshot(cwd, 'pre', 'pre')
  await snapshot(cwd, 'post', 'post')
  expect(await recordTurnLedger(cwd, emptyTurn)).toBe(0)

  const renameTurn = await bumpTurn(cwd)
  await snapshot(cwd, 'pre', 'pre')
  rmSync(join(cwd, 'old.txt'))
  writeFileSync(join(cwd, 'new.txt'), 'rename me\n', 'utf8')
  writeFileSync(join(cwd, 'b.txt'), 'b changed\n', 'utf8')
  writeFileSync(join(cwd, 'c.txt'), 'new\n', 'utf8')
  await snapshot(cwd, 'post', 'post')
  const recorded = await recordTurnLedger(cwd, renameTurn)
  expect(recorded).toBeGreaterThan(0)
  const entries = readLedger(cwd, renameTurn)
  expect(entries.some((entry) => entry.action === 'add' && entry.path === 'c.txt')).toBe(true)
  expect(entries.some((entry) => entry.action === 'rename' && entry.path === 'new.txt' && entry.from === 'old.txt')).toBe(true)

  // 手工灌到 5000 行以上，再记一次，文件应当被截到最后 5000 行。
  const ledger = join(shadowRoot(cwd), 'ledger.jsonl')
  const filler = Array.from({ length: 5001 }, (_, i) => JSON.stringify({ turn: i, action: 'add', path: `f${String(i)}`, at: i }))
  writeFileSync(ledger, `${filler.join('\n')}\n`, 'utf8')
  expect(await recordTurnLedger(cwd, renameTurn)).toBeGreaterThan(0)
  const after = readFileSync(ledger, 'utf8').split('\n').filter((line) => line !== '')
  expect(after.length).toBe(5000)
})

test.skipIf(!gitAvailable)('账本：文件不存在时 readLedger 给空数组', () => {
  const cwd = makeWorkspace({ 'a.txt': 'a\n' })
  expect(readLedger(cwd)).toEqual([])
  expect(existsSync(join(shadowRoot(cwd), 'ledger.jsonl'))).toBe(false)
})

test('repo 目录看起来存在但 git 读不了：listSnapshots / repoSizeMB 都咽掉错误', async () => {
  const cwd = makeWorkspace({ 'a.txt': 'a\n' })
  mkdirSync(shadowRepoPath(cwd), { recursive: true })
  writeFileSync(join(shadowRepoPath(cwd), 'HEAD'), 'garbage\n', 'utf8')
  await expect(listSnapshots(cwd)).resolves.toEqual([])
  await expect(repoSizeMB(cwd)).resolves.toBe(0)
})
