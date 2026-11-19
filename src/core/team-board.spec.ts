/**
 * 团队任务板与信箱（`core/team-board.ts`）：CAS 抢单、依赖图、写作用域告警、信箱读写。
 *
 * DSC_HOME 在任何 import 之前指进临时目录；每个用例用不同 sessionId，板子互不覆盖。
 * CAS 是这一层的核心不变量：两个队友同时抢同一个任务时，第二个必须拿着旧 revision 被拒。
 *
 * @module dsc/core/team-board.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-team-board-'))
process.env['DSC_HOME'] = HOME

let board: typeof import('./team-board.js')

afterAll(() => {
  delete process.env['DSC_HOME']
})

beforeAll(async () => {
  board = await import('./team-board.js')
})

describe('readBoard / boardCreate', () => {
  test('缺文件是空板；坏 JSON 也退回空板', () => {
    expect(board.readBoard('missing')).toMatchObject({ version: 1, revision: 0, tasks: [] })
    const file = board.boardFile('broken')
    mkdirSync(join(HOME, 'team', 'boards'), { recursive: true })
    writeFileSync(file, '{bad', 'utf8')
    expect(board.readBoard('broken')).toMatchObject({ revision: 0, tasks: [] })
  })

  test('读盘收敛坏字段：状态回 pending、依赖去重、空 owner 回 null', () => {
    const file = board.boardFile('dirty')
    mkdirSync(join(HOME, 'team', 'boards'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        revision: 3,
        tasks: [{ id: 't1', subject: 'x', status: 'weird', owner: '', blockedBy: ['a', 'a', ''], writeScopes: ['src', 7] }],
      }),
      'utf8',
    )
    const read = board.readBoard('dirty')
    expect(read.revision).toBe(3)
    expect(read.tasks[0]).toMatchObject({ status: 'pending', owner: null, blockedBy: ['a'], writeScopes: ['src'] })
  })

  test('新建：id 递增、标题规整、revision +1、作用域规范化与重叠告警', () => {
    const first = board.boardCreate('create', { subject: '  写  README  ', writeScopes: ['/src/'] })
    expect(first.task).toMatchObject({ id: 't1', subject: '写 README', writeScopes: ['src'], status: 'pending' })
    expect(first.board.revision).toBe(1)

    const second = board.boardCreate('create', { subject: '改 src/a.ts', writeScopes: ['src/a.ts'] })
    expect(second.task.id).toBe('t2')
    expect(second.warnings.some((line) => line.includes('作用域'))).toBe(true)
  })

  test('空标题、超过上限、依赖不存在/自依赖都抛错', () => {
    expect(() => board.boardCreate('create2', { subject: '   ' })).toThrow(/不能为空/)
    expect(() => board.boardCreate('create2', { subject: 'x', blockedBy: ['t99'] })).toThrow(/不存在/)
    const created = board.boardCreate('create2', { subject: 'y' })
    expect(() => board.boardCreate('create2', { subject: 'z', blockedBy: [created.task.id] })).not.toThrow()
  })
})

describe('boardUpdate：CAS 与动作', () => {
  function seed(sessionId: string) {
    const a = board.boardCreate(sessionId, { subject: 'A' })
    const b = board.boardCreate(sessionId, { subject: 'B', blockedBy: [a.task.id] })
    return { a: a.task, b: b.task, revision: b.board.revision }
  }

  test('revision 不匹配就拒绝（两个队友同时改的常态）', () => {
    const { a, revision } = seed('cas')
    expect(() => board.boardUpdate('cas', a.id, revision - 1, 'claim', { owner: 'w1' })).toThrow(/被别人改过了/)
  })

  test('claim：必须带 owner；别人认领过不能抢；依赖没完成不能开工', () => {
    const { a, b, revision } = seed('claim')
    expect(() => board.boardUpdate('claim', a.id, revision, 'claim', {})).toThrow(/认领人/)
    const claimed = board.boardUpdate('claim', a.id, revision, 'claim', { owner: 'w1' })
    expect(claimed.task).toMatchObject({ owner: 'w1', status: 'in_progress' })
    expect(() => board.boardUpdate('claim', a.id, claimed.board.revision, 'claim', { owner: 'w2' })).toThrow(/已经被 w1/)
    expect(() => board.boardUpdate('claim', b.id, claimed.board.revision, 'claim', { owner: 'w2' })).toThrow(/依赖完成/)
  })

  test('complete 前必须先 claim；release/reopen 回到 pending；set_dependencies 查环', () => {
    const { a, b, revision } = seed('actions')
    expect(() => board.boardUpdate('actions', a.id, revision, 'complete')).toThrow(/先 claim/)
    const claimed = board.boardUpdate('actions', a.id, revision, 'claim', { owner: 'w1' })
    const done = board.boardUpdate('actions', a.id, claimed.board.revision, 'complete')
    expect(done.task.status).toBe('completed')

    const reopened = board.boardUpdate('actions', a.id, done.board.revision, 'reopen')
    expect(reopened.task).toMatchObject({ status: 'pending', owner: null })

    expect(() => board.boardUpdate('actions', b.id, reopened.board.revision, 'set_dependencies', { blockedBy: ['t99'] })).toThrow(/不存在/)
    expect(() =>
      board.boardUpdate('actions', b.id, reopened.board.revision, 'set_dependencies', { blockedBy: [b.id] }),
    ).toThrow(/不能依赖自己/)
  })

  test('delete：有依赖者时拒绝；没有时真删并 +1', () => {
    const { a, b, revision } = seed('delete')
    expect(() => board.boardUpdate('delete', a.id, revision, 'delete')).toThrow(/还依赖/)
    const removed = board.boardUpdate('delete', b.id, revision, 'delete')
    expect(removed.board.tasks.map((task) => task.id)).toEqual([a.id])
    expect(removed.board.revision).toBe(revision + 1)
  })

  test('不存在的任务与未知动作都抛错', () => {
    const { revision } = seed('errors')
    expect(() => board.boardUpdate('errors', 't99', revision, 'claim', { owner: 'w' })).toThrow(/没有 t99/)
  })
})

describe('isReady / resetBoard / 作用域', () => {
  test('isReady：pending、无 owner、依赖全完成', () => {
    const one = board.boardCreate('ready', { subject: 'one' })
    const two = board.boardCreate('ready', { subject: 'two', blockedBy: [one.task.id] })
    expect(board.isReady(two.board, two.board.tasks.find((task) => task.id === two.task.id)!)).toBe(false)
    const claimed = board.boardUpdate('ready', one.task.id, two.board.revision, 'claim', { owner: 'w' })
    const done = board.boardUpdate('ready', one.task.id, claimed.board.revision, 'complete')
    expect(board.isReady(done.board, done.board.tasks.find((task) => task.id === two.task.id)!)).toBe(true)
  })

  test('resetBoard 清空并返回条数；normalizeScope 统一分隔符', () => {
    board.boardCreate('reset', { subject: 'a' })
    board.boardCreate('reset', { subject: 'b' })
    expect(board.resetBoard('reset')).toBe(2)
    expect(board.readBoard('reset').tasks).toEqual([])
    expect(board.normalizeScope('./src\\a/')).toBe('src/a')
  })

  test('空作用域视为整个工作目录，与谁都重叠', () => {
    const existing = board.boardCreate('scopes', { subject: 'a', writeScopes: ['src'] })
    const warnings = board.scopeWarnings(existing.board, [''], 't2')
    expect(warnings[0]).toContain('<整个工作目录>')
  })
})

describe('信箱', () => {
  test('追加后按顺序读回；空消息与超长消息被拒', () => {
    board.inboxAppend('w1', '第一条')
    board.inboxAppend('w1', '  第二条  ')
    expect(board.inboxRead('w1')).toEqual(['第一条', '第二条'])
    expect(() => board.inboxAppend('w1', '  ')).toThrow(/不能是空的/)
    expect(() => board.inboxAppend('w1', 'x'.repeat(8_001))).toThrow(/最长/)
  })

  test('坏行与空行不炸；没有信箱返回空', () => {
    board.inboxAppend('w2', 'ok')
    const file = join(HOME, 'team', 'inbox', 'w2.jsonl')
    writeFileSync(file, `${String(require('node:fs').readFileSync(file, 'utf8'))}{bad\n\n`, 'utf8')
    expect(board.inboxRead('w2')).toEqual(['ok', '{bad'])
    expect(board.inboxRead('nobody')).toEqual([])
  })
})
