/**
 * self-improve 的分支补充测试：台账回滚的四种失败、候选清单的坏行/裁剪、草稿解析的降级。
 *
 * 全部落临时 HOME：`DSC_HOME` 在任何 import 之前指走，真实 `~/.dsc` 一个字节都不碰。
 * 只补既有 spec 没走的失败/默认值分支，不重复主路径。
 *
 * @module dsc/packages/self-improve/tests/branches-extra
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-self-improve-branches-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

const ld = await import('../ledger.js')
const store = await import('../store.js')
const mod = await import('../index.js')

const skillsDir = join(process.env.DSC_HOME, 'skills')

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** 造一个技能目录，返回 SKILL.md 原文。 */
function writeSkill(name: string, text = `# ${name}\n`): string {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(join(skillsDir, name, 'SKILL.md'), text, 'utf8')
  return text
}

/** 直接往候选清单写若干行。 */
function writeCandidates(cwd: string, lines: unknown[]): void {
  const file = store.candidatesFile(cwd)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
}

const CWD = join(home, 'workspace')
mkdirSync(CWD, { recursive: true })

// ── ledger ───────────────────────────────────────────────────────────────────

test('ledger 小函数：缺文件指纹为空、无副本给 null、副本复制失败给空串、显示文案带副本与备注', () => {
  expect(ld.hashFileOf(join(home, 'nope.txt'))).toBe(ld.EMPTY_HASH)
  expect(ld.backupPathOf({ skill: 'x' })).toBeNull()
  expect(ld.backupPathOf({ skill: 'x', backup: '' })).toBeNull()
  expect(ld.backupPathOf({ skill: 'x', backup: 'SKILL.md.bak.1' })).toBe(join(skillsDir, 'x', 'SKILL.md.bak.1'))

  const source = join(home, 'source.txt')
  writeFileSync(source, 'x', 'utf8')
  const backup = ld.copyToBackup(source, 1_700_000_000_000)
  expect(backup).toMatch(/^source\.txt\.bak\.1700000000$/)
  expect(existsSync(join(home, backup))).toBe(true)
  expect(ld.copyToBackup(join(home, 'missing', 'x'), 1)).toBe('')

  const entry = {
    id: 'abc12345',
    ts: 0,
    actor: 'user' as const,
    action: 'patch' as const,
    skill: 'demo',
    beforeHash: 'a',
    afterHash: 'b',
    backup: 'SKILL.md.bak.1',
    note: '手工改回',
  }
  expect(ld.formatLedgerEntry(entry)).toContain('副本 SKILL.md.bak.1')
  expect(ld.formatLedgerEntry(entry)).toContain('手工改回')
  expect(ld.formatLedgerEntry({ ...entry, backup: undefined, note: undefined })).not.toContain('副本')
  expect(ld.ledgerSize()).toBeGreaterThanOrEqual(0)
  expect(ld.findLedgerEntry('不存在')).toBeUndefined()
  expect(ld.lastChangeOf('不存在')).toBeUndefined()
})

test('appendLedger/readLedger：默认 id 与时间、坏行跳过、新记录在前、limit<=0 取全部', () => {
  const first = ld.appendLedger({
    actor: 'user',
    action: 'create',
    skill: 'ledger-a',
    beforeHash: ld.EMPTY_HASH,
    afterHash: 'h1',
    ts: 1_000,
  })
  expect(first.id).toMatch(/^[0-9a-f]{8}$/)
  const second = ld.appendLedger({
    actor: 'model',
    action: 'patch',
    skill: 'ledger-b',
    beforeHash: 'h1',
    afterHash: 'h2',
    ts: 2_000,
  })
  expect(second.id).toMatch(/^[0-9a-f]{8}$/)

  // 追加几条坏行：不是 JSON、数组、缺 id、未知 action、ts 非数字。
  writeFileSync(
    ld.ledgerFile(),
    `${readFileSync(ld.ledgerFile(), 'utf8')}坏行\n[]\n${JSON.stringify({ skill: 'x', action: 'create' })}\n${JSON.stringify({ id: 'z', skill: 'x', action: 'nope' })}\n${JSON.stringify({ id: 'y', skill: 'x', action: 'create', ts: 'bad', actor: 'other' })}\n`,
    'utf8',
  )
  const all = ld.readLedger()
  expect(all.map((item) => item.id)).toEqual([second.id, first.id, 'y'])
  expect(all[2]).toMatchObject({ ts: 0, actor: 'user' })
  expect(ld.readLedger(1)).toHaveLength(1)
  expect(ld.readLedger(0)).toHaveLength(3)
  expect(ld.readLedger(-1)).toHaveLength(3)
})

test('rollbackEntry：副本缺失/指纹不符/没有可恢复语义各有明确错误', () => {
  const missing = ld.rollbackEntry('没有这条')
  expect(missing).toMatchObject({ ok: false })
  expect(missing.error).toContain('台账里没有 id')

  const skill = 'rollback-probe'
  writeSkill(skill, '现在的内容')
  const backupName = 'SKILL.md.bak.42'

  // 台账记了副本，但盘上副本已经不在。
  const gone = ld.appendLedger({
    actor: 'user',
    action: 'patch',
    skill,
    beforeHash: ld.hashText('旧内容'),
    afterHash: ld.hashText('现在的内容'),
    backup: backupName,
  })
  expect(ld.rollbackEntry(gone.id)).toMatchObject({ ok: false })
  expect(ld.rollbackEntry(gone.id).error).toContain('没有可用的副本')

  // 副本在，但内容与台账的改前指纹对不上。
  writeFileSync(join(skillsDir, skill, backupName), '不是旧内容', 'utf8')
  const wrong = ld.rollbackEntry(gone.id)
  expect(wrong.ok).toBe(false)
  expect(wrong.error).toContain('对不上')

  // 旧版 archive 只记了空指纹：认不出是哪一份。
  const archiveEmpty = ld.appendLedger({
    actor: 'user',
    action: 'archive',
    skill,
    beforeHash: ld.EMPTY_HASH,
    afterHash: ld.EMPTY_HASH,
  })
  expect(ld.rollbackEntry(archiveEmpty.id).error).toContain('没有改前指纹')
})

test('rollbackEntry：create 且目录还在时整目录搬进归档区；目录没了就明说没得回滚', () => {
  const skill = 'created-probe'
  writeSkill(skill, '建出来的')
  const entry = ld.appendLedger({
    actor: 'model',
    action: 'create',
    skill,
    beforeHash: ld.EMPTY_HASH,
    afterHash: ld.hashText('建出来的'),
  })
  const result = ld.rollbackEntry(entry.id, 1_700_000_000_000)
  expect(result.ok).toBe(true)
  expect(result.notice).toContain('整个目录搬进归档区')
  expect(existsSync(join(skillsDir, skill))).toBe(false)
  const archived = join(skillsDir, '.archive', `${skill}-1700000000-rollback`)
  expect(existsSync(join(archived, 'SKILL.md'))).toBe(true)

  const again = ld.appendLedger({
    actor: 'model',
    action: 'create',
    skill: 'never-existed',
    beforeHash: ld.EMPTY_HASH,
    afterHash: 'x',
  })
  expect(ld.rollbackEntry(again.id).error).toContain('已经不在了')
})

// ── store ────────────────────────────────────────────────────────────────────

test('normalizeLearningsState / workspaceKeyOf：坏形状回落默认值，空 slug 用 root', () => {
  expect(store.normalizeLearningsState(null)).toEqual(store.EMPTY_LEARNINGS_STATE)
  expect(store.normalizeLearningsState([1, 2])).toEqual(store.EMPTY_LEARNINGS_STATE)
  expect(
    store.normalizeLearningsState({
      lastReviewedTurn: 'not-a-number',
      pluginInitiated: 'true',
      readSkills: ['a', '', 3, null, 'b'],
      createdSkills: 'nope',
    }),
  ).toEqual({
    lastReviewedTurn: -1,
    pluginInitiated: false,
    readSkills: ['a', 'b'],
    createdSkills: [],
  })
  expect(store.workspaceKeyOf('C:\\')).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/)
  expect(store.workspaceKeyOf('D:\\a\\b')).toBe(store.workspaceKeyOf('d:/a/b/'))
})

test('readCandidates：坏行/缺字段/未知 kind 或 state 跳过，同 id 最后一条生效', () => {
  writeCandidates(CWD, [
    { id: 'a', ts: 10, kind: 'note', text: '旧', state: 'candidate' },
    '坏行',
    [],
    { id: '', kind: 'note', text: 'x', state: 'candidate' },
    { id: 'b', kind: 'note', text: '', state: 'candidate' },
    { id: 'c', kind: 'unknown', text: 'x', state: 'candidate' },
    { id: 'd', kind: 'note', text: 'x', state: 'unknown' },
    { id: 'e', kind: 'note', text: 'x', state: 'candidate', ts: 'bad', hits: -1, turnRef: 3 },
    { id: 'a', ts: 20, kind: 'note', text: '新', state: 'promoted' },
  ])
  const list = store.readCandidates(CWD)
  expect(list.map((item) => item.id)).toEqual(['a', 'e'])
  expect(list[0]).toMatchObject({ text: '新', state: 'promoted' })
  expect(list[1]).toMatchObject({ ts: 0, hits: 0, turnRef: '' })
})

test('pruneCandidates：按条数裁最老（同毫秒按 id），非法选项夹到最小；recordCandidate 去重与截断', () => {
  writeCandidates(CWD, [
    { id: 'old1', ts: 1_000, kind: 'note', text: '1', state: 'candidate' },
    { id: 'old2', ts: 2_000, kind: 'note', text: '2', state: 'candidate' },
    { id: 'same-b', ts: 3_000, kind: 'note', text: '3', state: 'candidate' },
    { id: 'same-a', ts: 3_000, kind: 'note', text: '4', state: 'candidate' },
  ])
  const pruned = store.pruneCandidates(CWD, { retentionDays: 365, maxEntries: 2 }, 10_000)
  expect(pruned.result).toEqual({ removed: 2, kept: 2 })
  expect(pruned.candidates.map((item) => item.id)).toEqual(['same-a', 'same-b'])

  // retentionDays 非法回落 30 天，maxEntries 0 夹到 1。
  const clamped = store.pruneCandidates(CWD, { retentionDays: Number.NaN, maxEntries: 0 }, 10_000)
  expect(clamped.result.kept).toBe(1)

  expect(store.recordCandidate(CWD, { kind: 'note', text: '   ', turnRef: '' })).toMatchObject({
    candidate: null,
    error: expect.stringContaining('空的'),
  })
  const longText = 'x'.repeat(2_500)
  const long = store.recordCandidate(CWD, { kind: 'note', text: longText, turnRef: 't1' }, {}, 20_000)
  expect(long.candidate?.text.endsWith('…')).toBe(true)
  expect(long.candidate?.text).toHaveLength(2_001)

  const deduped = store.recordCandidate(CWD, { kind: 'note', text: longText, turnRef: 't2' }, {}, 21_000)
  expect(deduped.deduped).toBe(true)
  expect(deduped.candidate?.hits).toBe(1)

  expect(store.setCandidateState(CWD, 'nope', 'dropped')).toMatchObject({ ok: false })
  const id = deduped.candidate?.id ?? ''
  const same = store.setCandidateState(CWD, id, 'candidate')
  expect(same.ok).toBe(true)
  expect(same.candidate?.state).toBe('candidate')
})

test('formatCandidate：序号补零、超长截断加省略号', () => {
  const candidate = {
    id: 'abc',
    ts: 0,
    kind: 'note' as const,
    text: '很长的正文'.repeat(20),
    turnRef: '',
    hits: 3,
    state: 'candidate' as const,
  }
  const text = store.formatCandidate(candidate, 0)
  expect(text).toContain('#01 [abc] note · candidate · 命中3')
  expect(text).toContain('…')
  expect(store.formatCandidate(candidate)).not.toContain('#01')
})

// ── index 纯函数 ─────────────────────────────────────────────────────────────

test('parseDraftAnswer：空输出/坏 JSON/缺字段/别名与描述超限', () => {
  expect(mod.parseDraftAnswer('```json\n```')).toEqual({ kind: 'invalid', error: '这一轮没有输出任何内容' })
  expect(mod.parseDraftAnswer('NONE')).toEqual({ kind: 'none' })
  expect(mod.parseDraftAnswer('{"a":1}').kind).toBe('invalid')
  expect(mod.parseDraftAnswer('{"name":""}').kind).toBe('invalid')

  const aliased = mod.parseDraftAnswer(
    '说明先放一行\n{"name":"alias","description":"d","when_to_use":"提交前","body":"# 正文"}',
  )
  expect(aliased.kind).toBe('draft')
  if (aliased.kind === 'draft') {
    expect(aliased.draft.whenToUse).toBe('提交前')
    expect(aliased.draft.content).toBe('# 正文')
  }

  expect(mod.parseDraftAnswer('{"name":"x","description":"很长的描述","content":"c"}', 2).kind).toBe('invalid')
  const missingName = mod.parseDraftAnswer(
    JSON.stringify({ action: 'patch', old_string: 'a', new_string: 'b', reason: 'r' }),
  )
  expect(missingName.kind).toBe('invalid')
  expect(missingName.kind === 'invalid' ? missingName.error : '').toContain('name')
})

test('autoCurateOnce：节流挡下、无变化不出声、只有归档也通知', () => {
  const calls = { curate: 0, saved: 0, announced: 0, changed: 0 }
  const deps = {
    enabled: true,
    now: 10_000,
    lastRunAt: 0,
    curate: () => {
      calls.curate += 1
      return { stale: [], archived: [], skipped: [], total: 0 }
    },
    saveLastRunAt: () => {
      calls.saved += 1
    },
    announce: () => {
      calls.announced += 1
    },
    changed: () => {
      calls.changed += 1
    },
  }
  const quiet = mod.autoCurateOnce(deps as never)
  expect(quiet).toMatchObject({ ran: true, text: '' })
  expect(calls).toEqual({ curate: 1, saved: 1, announced: 0, changed: 0 })

  const throttled = mod.autoCurateOnce({ ...deps, lastRunAt: 9_000 } as never)
  expect(throttled.ran).toBe(false)
  expect(calls.curate).toBe(1)

  const archivedOnly = mod.autoCurateOnce({
    ...deps,
    lastRunAt: -1,
    curate: () => ({ stale: [], archived: ['a'], skipped: [], total: 1 }),
  } as never)
  expect(archivedOnly.text).toContain('搬进归档区')
  expect(calls.announced).toBe(1)
})
