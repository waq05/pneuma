/**
 * 任务板（`core/team-board.ts`）的动作分支补齐：release / block / unblock / assign
 * 四条动作、各自的拒绝条件、任务数上限、未知动作、信箱读失败兜底。
 *
 * `TEAM_ROOT` 在 import 期由 `DSC_HOME` 定死，所以先指临时目录再动态 import；
 * 每个用例用不同 sessionId，互不干扰。
 *
 * @module dsc/core/w12-team-board-extra.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'

const home = createTempDir('dsc-w12-team-home-')
const previous = {
  DSC_HOME: process.env['DSC_HOME'],
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
}
process.env['DSC_HOME'] = home
process.env['HOME'] = home
process.env['USERPROFILE'] = home

type TeamBoardModule = typeof import('./team-board.js')
let team: TeamBoardModule

beforeAll(async () => {
  team = await import('./team-board.js')
})

afterAll(() => {
  for (const key of ['DSC_HOME', 'HOME', 'USERPROFILE'] as const) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** 建一个任务并返回它。 */
function create(sessionId: string): ReturnType<TeamBoardModule['boardCreate']> {
  return team.boardCreate(sessionId, { subject: '覆盖率补齐', description: '写 spec' })
}

describe('release', () => {
  test('认领后释放：owner 清空、状态回 pending、活动留痕', () => {
    const session = 'sess-release'
    const { task } = create(session)
    const claimed = team.boardUpdate(session, task.id, 1, 'claim', { owner: 'alice' })
    expect(claimed.task.status).toBe('in_progress')
    const released = team.boardUpdate(session, task.id, 2, 'release')
    expect(released.task.owner).toBeNull()
    expect(released.task.status).toBe('pending')
    expect(released.board.activity[0]!.text).toContain('释放')
  })

  test('已完成的任务不能 release', () => {
    const session = 'sess-release-done'
    const { task } = create(session)
    team.boardUpdate(session, task.id, 1, 'claim', { owner: 'alice' })
    team.boardUpdate(session, task.id, 2, 'complete')
    expect(() => team.boardUpdate(session, task.id, 3, 'release')).toThrow(/已经完成了/)
  })
})

describe('block / unblock', () => {
  test('标记卡住要带原因；解除时原因可省略；重复解除报错', () => {
    const session = 'sess-block'
    const { task } = create(session)
    team.boardUpdate(session, task.id, 1, 'claim', { owner: 'alice' })
    expect(() => team.boardUpdate(session, task.id, 2, 'block', { text: '   ' })).toThrow(/block 要带上 text/)
    const blocked = team.boardUpdate(session, task.id, 2, 'block', { text: '等上游合并' })
    expect(blocked.task.blockedReason).toBe('等上游合并')
    expect(blocked.task.notes[0]!.text).toContain('[卡住]')

    const unblocked = team.boardUpdate(session, task.id, 3, 'unblock')
    expect(unblocked.task.blockedReason).toBeNull()
    expect(unblocked.task.notes[0]!.text).toContain('阻塞已解除')
    expect(() => team.boardUpdate(session, task.id, 4, 'unblock')).toThrow(/没有被标记卡住/)
  })

  test('解除时带原因会写进进展', () => {
    const session = 'sess-unblock-why'
    const { task } = create(session)
    team.boardUpdate(session, task.id, 1, 'block', { text: '等 CI' })
    const unblocked = team.boardUpdate(session, task.id, 2, 'unblock', { text: 'CI 绿了' })
    expect(unblocked.task.notes[0]!.text).toContain('[解除] CI 绿了')
  })
})

describe('assign', () => {
  test('绑定、解绑；不带 assignee 字段报错', () => {
    const session = 'sess-assign'
    const { task } = create(session)
    expect(() => team.boardUpdate(session, task.id, 1, 'assign')).toThrow(/assign 要带上 assignee/)
    const bound = team.boardUpdate(session, task.id, 1, 'assign', { assignee: ' bob ' })
    expect(bound.task.assignee).toBe('bob')
    const unbound = team.boardUpdate(session, task.id, 2, 'assign', { assignee: null })
    expect(unbound.task.assignee).toBeNull()
    const cleared = team.boardUpdate(session, task.id, 3, 'assign', { assignee: '  ' })
    expect(cleared.task.assignee).toBeNull()
  })
})

describe('上限与未知动作', () => {
  test('任务板满 256 条后拒绝新建', () => {
    const session = 'sess-max'
    const boardsDir = join(home, 'team', 'boards')
    mkdirSync(boardsDir, { recursive: true })
    const tasks = Array.from({ length: 256 }, (_, index) => ({ id: `t${String(index + 1)}` }))
    writeFileSync(team.boardFile(session), JSON.stringify({ revision: 0, tasks, activity: [] }), 'utf8')
    expect(() => team.boardCreate(session, { subject: '再来一条' })).toThrow(/达到上限 256/)
  })

  test('未知动作直接被拒', () => {
    const session = 'sess-unknown'
    const { task } = create(session)
    expect(() => team.boardUpdate(session, task.id, 1, 'explode' as never)).toThrow(/未知动作/)
  })
})

describe('信箱', () => {
  test('信箱文件读不动（这里用同名目录占位）：返回空数组而不是抛', () => {
    mkdirSync(join(home, 'team', 'inbox'), { recursive: true })
    mkdirSync(join(home, 'team', 'inbox', 'w12-blocked.jsonl'), { recursive: true })
    expect(team.inboxRead('w12-blocked')).toEqual([])
  })
})
