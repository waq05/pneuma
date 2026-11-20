/**
 * `self-improve` 的磁盘失败分支覆盖（W14）。
 *
 * 这批缺口几乎全是「写不进去 / 读不出来」的兜底：原子写的 rename 失败、台账追加失败、
 * 候选清单改名失败、建技能目录失败、附属文件写失败、归档搬不动、使用台账写失败、老化
 * 归档失败，以及新 id 连续撞车的兜底。既有 spec 只跑正常路径，错误分支一条没走。
 *
 * 手法一律是**真文件系统造失败**，不 mock `node:fs`，且按平台各用一种确定性手段：
 *   - Windows：对只读文件 `rename` 会 EPERM → 驱动「先 unlink 临时文件再抛」的 catch；
 *   - POSIX：`rename` 只看目录权限、不看目标文件权限，只读挡不住，所以把目标路径占成
 *     目录（读它就是 EISDIR）或把 `.tmp` 路径占成目录（写它就是 EISDIR）——不依赖
 *     运行用户有没有 root 权限，确定性更强；
 *   - 两个平台都用：「把目标路径造成目录 / 把父目录造成普通文件」驱动
 *     `writeFileSync` / `mkdirSync` 失败；「把 `.archive` 造成文件」驱动归档失败与
 *     `archivedCount` 的 catch。
 *
 * `DSC_HOME` 在 import 之前指进 mkdtemp 临时目录（路径常量在模块求值时算定），不碰真实 `~/.dsc`。
 *
 * @module dsc/packages/self-improve/tests/w14-disk-errors
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'

// ── 受控的 randomUUID：驱动 newId 连续撞车的兜底 ──────────────────────────

const random = vi.hoisted(() => ({ value: null as null | string }))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomUUID: () => random.value ?? actual.randomUUID(),
  }
})

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14-self-'))
process.env['DSC_HOME'] = HOME
process.env['HOME'] = HOME
process.env['USERPROFILE'] = HOME

const sw = await import('../skill-write.js')
const ld = await import('../ledger.js')
const st = await import('../store.js')

const SKILLS = join(HOME, 'skills')
const DAY = 24 * 60 * 60 * 1000

afterAll(() => {
  random.value = null
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(() => {
  random.value = null
  rmSync(SKILLS, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })
  for (const file of ['skills.json', join('learnings', 'x')]) rmSync(join(HOME, file), { recursive: true, force: true })
  mkdirSync(SKILLS, { recursive: true })
})

/** 一份合法 SKILL.md。 */
function markdown(name: string, body = '按步骤做。'): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: "一句话说明"\nwhenToUse: "需要时"\n---\n\n${body}\n`
}

/** 直接放一份技能（不走 create）。 */
function seedSkill(name: string, body = '按步骤做。'): string {
  const dir = join(SKILLS, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), markdown(name, body), 'utf8')
  return dir
}

/** 直接写一份使用台账。 */
function seedUsage(skills: Record<string, unknown>): void {
  mkdirSync(SKILLS, { recursive: true })
  writeFileSync(join(SKILLS, '.usage.json'), JSON.stringify({ version: 1, skills }), 'utf8')
}

/** 把文件设成只读：Windows 上 rename 覆盖它会 EPERM。 */
function readonly(file: string): void {
  writeFileSync(file, '', { flag: 'a' })
  chmodSync(file, 0o444)
}

/**
 * 让台账写入失败（`createSkill` 走 notice、`appendLedger` 走抛错都靠它）。
 *
 * Windows：目标文件只读，`renameSync(tmp, 台账)` 覆盖时 EPERM。
 * POSIX：rename 只看目录权限，只读文件照覆盖；改成让台账路径被目录占着——
 * `appendLedger` 先 `readFileSync(台账)`（ledger.ts:100）就 EISDIR，一定写不进去，
 * 且不依赖运行用户是不是 root。
 */
function blockLedger(): void {
  if (process.platform === 'win32') readonly(ld.ledgerFile())
  else mkdirSync(ld.ledgerFile(), { recursive: true })
}

/**
 * 让「先写 `.tmp` 再 rename」的候选清单写失败。
 *
 * Windows：目标只读，rename 覆盖时 EPERM。
 * POSIX：只读挡不住 rename，所以把 `.tmp` 路径占成目录——`appendLines` / `writeAll`
 * 的 `writeFileSync(tmp, ...)` 直接 EISDIR，崩在写文件那一步（两边断言的都是「原样抛错」）。
 */
function blockAtomicWrite(file: string): void {
  if (process.platform === 'win32') chmodSync(file, 0o444)
  else mkdirSync(`${file}.tmp`, { recursive: true })
}

const usageRecord = (over: Record<string, unknown> = {}) => ({
  createdBy: 'agent',
  useCount: 1,
  patchCount: 0,
  createdAt: Date.now() - 50 * DAY,
  lastUsedAt: Date.now() - 40 * DAY,
  lastPatchedAt: null,
  state: 'stale',
  pinned: false,
  archivedAt: null,
  ...over,
})

describe('skill-write：原子写与安检验证的兜底', () => {
  test('createSkill：台账写失败不影响技能已写成的事实，回执里说明', () => {
    // 台账写不进去（平台各自的确定性手法见 blockLedger）：finishWrite 的 catch 接住。
    blockLedger()
    const result = sw.createSkill({
      name: 'ledger-broken',
      markdown: markdown('ledger-broken'),
      actor: 'model',
    })
    expect(result.ok).toBe(true)
    expect(result.entry).toBeNull()
    expect(result.notice).toContain('台账没写成')
  })
  test('atomicWriteText：目标是目录时 rename 失败，临时文件被清掉后原样抛错', () => {
    const target = join(HOME, 'atomic-target')
    mkdirSync(target, { recursive: true })
    expect(() => sw.atomicWriteText(target, 'x')).toThrow()
    expect(existsSync(`${target}.tmp`)).toBe(false)
  })

  test('scanSkillDir：不存在的目录直接当作没有威胁', () => {
    expect(sw.scanSkillDir(join(HOME, 'no-such-dir'))).toBe('')
  })

  test('writeUsage：usage 文件位置被目录占着时 rename 失败，抛错且不留临时文件', () => {
    mkdirSync(join(SKILLS, '.usage.json'), { recursive: true })
    expect(() => sw.writeUsage({ version: 1, skills: {} })).toThrow()
    expect(existsSync(join(SKILLS, '.usage.json.tmp'))).toBe(false)
  })

  test('createSkill：技能根被普通文件占着时，报「没能写进磁盘」', () => {
    rmSync(SKILLS, { recursive: true, force: true })
    writeFileSync(SKILLS, 'not a directory', 'utf8')
    try {
      const result = sw.createSkill({
        name: 'blocked-one',
        markdown: markdown('blocked-one'),
        actor: 'model',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('没能写进磁盘')
    } finally {
      rmSync(SKILLS, { force: true })
      mkdirSync(SKILLS, { recursive: true })
    }
  })

  test('createSkill：停用名单写不进去时，技能照样算写成，只是回执里说明', () => {
    mkdirSync(join(HOME, 'skills.json'), { recursive: true })
    try {
      const result = sw.createSkill({
        name: 'no-disabled-list',
        markdown: markdown('no-disabled-list'),
        actor: 'model',
      })
      expect(result.ok).toBe(true)
      expect(result.notice).toContain('停用名单没写成')
    } finally {
      rmSync(join(HOME, 'skills.json'), { recursive: true, force: true })
    }
  })

  test('patchSkill：SKILL.md 是目录时读不出来，返回失败原因', () => {
    const dir = join(SKILLS, 'patched')
    mkdirSync(join(dir, 'SKILL.md'), { recursive: true })
    const result = sw.patchSkill({
      name: 'patched',
      oldString: '按步骤做。',
      newString: '改一下。',
      actor: 'model',
      readConfirmed: true,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('技能读不出来')
  })

  test('patchSkill：临时文件名被目录占着时写不进去，返回失败原因', () => {
    seedSkill('patched-two')
    mkdirSync(join(SKILLS, 'patched-two', 'SKILL.md.tmp'), { recursive: true })
    const result = sw.patchSkill({
      name: 'patched-two',
      oldString: '按步骤做。',
      newString: '改一下。',
      actor: 'model',
      readConfirmed: true,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没能写进磁盘')
  })

  test('writeSkillFile：附属文件目录被普通文件占着时写不进去', () => {
    seedSkill('with-files')
    writeFileSync(join(SKILLS, 'with-files', 'references'), 'not a directory', 'utf8')
    const result = sw.writeSkillFile({
      name: 'with-files',
      filePath: 'references/example.md',
      content: '内容',
      actor: 'model',
      readConfirmed: true,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('附属文件没能写进磁盘')
  })
})

describe('skill-write：归档与老化整理的失败分支', () => {
  test('moveToArchive：归档区位置被文件占着时搬不动，回执写明原因', () => {
    seedSkill('movable')
    writeFileSync(join(SKILLS, '.archive'), 'not a directory', 'utf8')
    const moved = sw.moveToArchive('movable', Date.now())
    expect(moved.ok).toBe(false)
    expect(moved.error).toContain('搬进归档区失败')
    // 搬失败时技能目录还在。
    expect(existsSync(join(SKILLS, 'movable', 'SKILL.md'))).toBe(true)
  })

  test('curateSkills：已归档的技能跳过；搬不动的记为 skipped；archivedCount 读不动报 0', () => {
    seedSkill('already-archived')
    seedSkill('stale-one')
    const now = Date.now()
    seedUsage({
      'already-archived': usageRecord({
        state: 'archived',
        archivedAt: now - 10 * DAY,
      }),
      'stale-one': usageRecord({ lastUsedAt: now - 40 * DAY }),
    })
    writeFileSync(join(SKILLS, '.archive'), 'not a directory', 'utf8')

    const report = sw.curateSkills(now, {
      staleAfterDays: 14,
      archiveAfterDays: 30,
    })
    // 已经 archived 的不再搬；该搬的因为归档区坏掉进 skipped。
    expect(report.skipped).toContain('already-archived')
    expect(report.skipped).toContain('stale-one')
    expect(report.archived).toEqual([])
    // 归档区是文件：existsSync 为真、readdirSync 抛 ENOTDIR，兜底成 0。
    expect(sw.archivedCount()).toBe(0)
  })
})

describe('ledger：台账追加与回滚的失败分支', () => {
  test('appendLedger：台账写不进去时抛错，临时文件清掉', () => {
    blockLedger()
    expect(() =>
      ld.appendLedger({
        actor: 'model',
        action: 'patch',
        skill: 'x',
        beforeHash: 'a',
        afterHash: 'b',
      }),
    ).toThrow()
    expect(existsSync(`${ld.ledgerFile()}.tmp`)).toBe(false)
  })

  test('rollbackEntry：create 的回滚要整目录搬进归档区，归档区坏掉时报错', () => {
    seedSkill('created-one')
    const entry = ld.appendLedger({
      actor: 'model',
      action: 'create',
      skill: 'created-one',
      beforeHash: ld.EMPTY_HASH,
      afterHash: 'abc',
    })
    writeFileSync(join(SKILLS, '.archive'), 'not a directory', 'utf8')
    const result = ld.rollbackEntry(entry.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('搬进归档区失败')
  })
})

describe('store：候选清单的读坏行与写失败', () => {
  const cwd = join(HOME, 'work')
  const fileOf = () => st.candidatesFile(cwd)

  beforeEach(() => {
    rmSync(join(HOME, 'learnings'), { recursive: true, force: true })
    mkdirSync(cwd, { recursive: true })
  })

  test('坏行与非对象行被跳过，合法行照读', () => {
    mkdirSync(join(fileOf(), '..'), { recursive: true })
    writeFileSync(
      fileOf(),
      `{bad json}\nnull\n[1,2]\n${JSON.stringify({ id: 'good', text: '正文', kind: 'note', state: 'candidate' })}\n`,
      'utf8',
    )
    expect(st.readCandidates(cwd).map((item) => item.id)).toEqual(['good'])
  })

  test('候选清单文件位置是目录时读不出来，按空清单处理', () => {
    mkdirSync(fileOf(), { recursive: true })
    expect(st.readCandidates(cwd)).toEqual([])
  })

  test('recordCandidate：候选文件写不进去导致追加失败时原样抛错', () => {
    mkdirSync(join(fileOf(), '..'), { recursive: true })
    writeFileSync(fileOf(), '', 'utf8')
    blockAtomicWrite(fileOf())
    expect(() => st.recordCandidate(cwd, { kind: 'note', text: '记一条', turnRef: '' })).toThrow()
  })

  test('pruneCandidates：裁剪需要整份覆盖写，写不进去时抛错', () => {
    mkdirSync(join(fileOf(), '..'), { recursive: true })
    const stale = {
      id: 'old',
      ts: Date.now() - 100 * DAY,
      kind: 'note',
      text: '老候选',
      turnRef: '',
      hits: 0,
      state: 'candidate',
    }
    writeFileSync(fileOf(), `${JSON.stringify(stale)}\n`, 'utf8')
    blockAtomicWrite(fileOf())
    expect(() => st.pruneCandidates(cwd, { retentionDays: 1 }, Date.now())).toThrow()
  })

  test('newId：连续 8 次撞车后退回 12 位 id', () => {
    mkdirSync(join(fileOf(), '..'), { recursive: true })
    const occupied = {
      id: 'abcdefgh',
      ts: Date.now(),
      kind: 'note',
      text: '已存在',
      turnRef: '',
      hits: 0,
      state: 'candidate',
    }
    writeFileSync(fileOf(), `${JSON.stringify(occupied)}\n`, 'utf8')
    random.value = 'abcdefgh-0000-4000-8000-000000000000'
    const result = st.recordCandidate(cwd, {
      kind: 'note',
      text: '新一条',
      turnRef: '',
    })
    expect(result.error).toBe('')
    expect(result.candidate!.id).toHaveLength(12)
    expect(result.candidate!.id.startsWith('abcdefgh')).toBe(true)
    expect(readdirSync(join(HOME, 'learnings')).length).toBeGreaterThan(0)
  })
})
