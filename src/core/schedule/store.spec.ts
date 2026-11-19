/**
 * 定时任务存储（`core/schedule/store.ts`）：任务 CRUD、磁盘往返、损坏兜底、至多一次的槽位协议。
 *
 * 每条用例用自己的临时目录与注入时钟——不读真实 `~/.dsc`，也不依赖本机时间。
 * 最关键的协议是 `beginSlot` → 投递 → `endSlot`：先落盘「这个槽位已经用掉」，崩在中途
 * 也不会重投；`pendingSlot` 是重启后补一次的唯一线索。
 *
 * @module dsc/core/schedule/store.spec
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ScheduleRule } from './rule.js'
import { normalizeTask, ScheduleStore, type ScheduleRun, type ScheduleTaskInput } from './store.js'

const DAILY: ScheduleRule = { kind: 'daily', hour: 9, minute: 30 }

let dir = ''
let now = 0

function makeStore(options: { runLimit?: number; historyLimit?: number } = {}): ScheduleStore {
  return new ScheduleStore({ dir, now: () => now, ...options })
}

function input(overrides: Partial<ScheduleTaskInput> = {}): ScheduleTaskInput {
  return {
    title: '每日站会提醒',
    prompt: '汇总昨天的提交。',
    rule: DAILY,
    timeZone: 'UTC',
    createdBy: 'user',
    sessionId: 's1',
    ...overrides,
  }
}

/** 一条最小台账。 */
function run(id: string, slot: number, overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return { at: slot, id, title: 't', slot, status: 'ok', detail: '', ...overrides }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsc-sched-store-'))
  now = Date.UTC(2026, 2, 9, 9, 0)
})

afterEach(() => {
  // 临时目录留给失败排查；每个用例自己新建，不互相影响。
})

describe('create / list / get / findByPrefix', () => {
  test('create 落一份完整任务，返回值是副本', async () => {
    const store = makeStore()
    const task = await store.create(input())
    expect(task.id).toMatch(/^sched-/)
    expect(task).toMatchObject({
      title: '每日站会提醒',
      enabled: true,
      nextRunAt: null,
      lastStatus: 'never',
      failureStreak: 0,
      pendingSlot: null,
      createdAt: now,
    })
    task.title = '改副本'
    expect(store.get(task.id)?.title).toBe('每日站会提醒')
    expect(store.list()).toHaveLength(1)
  })

  test('findByPrefix：唯一前缀命中，歧义/没有都报可读原因', async () => {
    const store = makeStore()
    const first = await store.create(input({ title: 'A' }))
    await store.create(input({ title: 'B' }))
    const prefix = first.id.slice(0, 10)
    const unique = store.findByPrefix(prefix + 'zzz')
    expect(unique.ok).toBe(false)

    const exact = store.findByPrefix(first.id)
    expect(exact).toEqual({ ok: true, task: expect.objectContaining({ id: first.id }) })

    const ambiguous = store.findByPrefix('sched-')
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) expect(ambiguous.error).toContain('2 条任务')
  })

  test('磁盘往返：新 store 读得回同一份任务', async () => {
    const store = makeStore()
    const created = await store.create(input())
    await store.setNextRunAt(created.id, now + 86_400_000)

    const reopened = makeStore()
    const loaded = reopened.load()
    expect(loaded.problem).toBeNull()
    expect(loaded.tasks).toHaveLength(1)
    expect(loaded.tasks[0]).toMatchObject({ id: created.id, nextRunAt: now + 86_400_000 })
  })
})

describe('update / remove', () => {
  test('update 改规则或时区都清掉排期，让 runner 重算', async () => {
    const store = makeStore()
    const task = await store.create(input())
    await store.setNextRunAt(task.id, 123)
    await store.beginSlot(task.id, 456, 789)

    const updated = await store.update(task.id, { rule: { kind: 'every', seconds: 600, anchorMs: now } })
    expect(updated).toMatchObject({ nextRunAt: null, pendingSlot: null, rule: { kind: 'every' } })

    await store.setNextRunAt(task.id, 111)
    const zoned = await store.update(task.id, { timeZone: 'Asia/Shanghai' })
    expect(zoned).toMatchObject({ nextRunAt: null, pendingSlot: null, timeZone: 'Asia/Shanghai' })
  })

  test('update 标题 trim；不存在的 id 返回 null', async () => {
    const store = makeStore()
    const task = await store.create(input())
    expect((await store.update(task.id, { title: '  新标题  ' }))?.title).toBe('新标题')
    expect(await store.update('nope', { title: 'x' })).toBeNull()
  })

  test('remove：真删返回 true，重复删返回 false', async () => {
    const store = makeStore()
    const task = await store.create(input())
    expect(await store.remove(task.id)).toBe(true)
    expect(await store.remove(task.id)).toBe(false)
    expect(store.list()).toHaveLength(0)
  })
})

describe('槽位协议：beginSlot 先落盘，endSlot 记账', () => {
  test('beginSlot 把 next 推走并留下 pendingSlot；endSlot 成功清零', async () => {
    const store = makeStore()
    const task = await store.create(input())
    const begun = await store.beginSlot(task.id, now, now + 86_400_000)
    expect(begun).toMatchObject({ nextRunAt: now + 86_400_000, pendingSlot: now, lastRunAt: now, lastStatus: 'running' })
    expect(store.pendingTasks().map((item) => item.id)).toEqual([task.id])

    const ended = await store.endSlot(task.id, { status: 'ok', delivered: true })
    expect(ended).toMatchObject({ pendingSlot: null, lastStatus: 'ok', failureStreak: 0, lastError: null })
    expect(ended?.deliveryHistory).toEqual([now])
    expect(store.pendingTasks()).toHaveLength(0)
  })

  test('失败累加 streak，成功清零；显式 failureStreak 优先', async () => {
    const store = makeStore()
    const task = await store.create(input())
    const first = await store.endSlot(task.id, { status: 'failed', error: 'ECONNRESET' })
    expect(first).toMatchObject({ failureStreak: 1, lastError: 'ECONNRESET' })
    const second = await store.endSlot(task.id, { status: 'failed', error: '再次失败' })
    expect(second?.failureStreak).toBe(2)
    const reset = await store.endSlot(task.id, { status: 'ok' })
    expect(reset?.failureStreak).toBe(0)
    const explicit = await store.endSlot(task.id, { status: 'blocked', failureStreak: 7, nextRunAt: 999 })
    expect(explicit).toMatchObject({ failureStreak: 7, nextRunAt: 999, lastStatus: 'blocked' })
  })

  test('endSlot 不传 nextRunAt 就不动排期', async () => {
    const store = makeStore()
    const task = await store.create(input())
    await store.setNextRunAt(task.id, 500)
    const ended = await store.endSlot(task.id, { status: 'skipped' })
    expect(ended?.nextRunAt).toBe(500)
  })

  test('beginSlot / endSlot 对不存在的 id 返回 null', async () => {
    const store = makeStore()
    expect(await store.beginSlot('nope', 1, 2)).toBeNull()
    expect(await store.endSlot('nope', { status: 'ok' })).toBeNull()
  })
})

describe('台账与历史裁剪', () => {
  test('appendRun / recentRuns：新的在前，坏行跳过', async () => {
    const store = makeStore()
    await store.appendRun(run('r1', 1))
    await store.appendRun(run('r2', 2, { status: 'failed' }))
    writeFileSync(store.runsFile, `${readFileSync(store.runsFile, 'utf8')}{半截\n`, 'utf8')

    const runs = store.recentRuns(10)
    expect(runs.map((run) => run.id)).toEqual(['r2', 'r1'])
  })

  test('runLimit：超过上限只留最近几条', async () => {
    const store = makeStore({ runLimit: 3 })
    for (let index = 0; index < 6; index += 1) {
      await store.appendRun(run(`r${String(index)}`, index))
    }
    const runs = store.recentRuns(10)
    expect(runs.map((run) => run.id)).toEqual(['r5', 'r4', 'r3'])
  })

  test('deliveryHistory 按条数裁剪', async () => {
    const store = makeStore({ historyLimit: 3 })
    const task = await store.create(input())
    for (let index = 0; index < 5; index += 1) {
      now = Date.UTC(2026, 2, 9, 9, index)
      await store.endSlot(task.id, { status: 'ok', delivered: true })
    }
    expect(store.get(task.id)?.deliveryHistory).toHaveLength(3)
  })

  test('setLimits 参数不合法时不动', async () => {
    const store = makeStore({ runLimit: 10, historyLimit: 10 })
    store.setLimits({ runLimit: 0, historyLimit: -1 })
    // 没有公开 getter，用行为验证：写 11 条仍只留 10 条。
    for (let index = 0; index < 11; index += 1) {
      await store.appendRun(run(`r${String(index)}`, index))
    }
    expect(store.recentRuns(20)).toHaveLength(10)
  })
})

describe('损坏兜底与 normalizeTask', () => {
  test('坏 JSON：备份 .corrupt，按空清单继续并给出 problem', () => {
    const store = makeStore()
    writeFileSync(store.tasksFile, '{不是 json', 'utf8')
    const loaded = store.load()
    expect(loaded.tasks).toEqual([])
    expect(loaded.problem).toContain('不是合法 JSON')
    expect(existsSync(`${store.tasksFile}.corrupt`)).toBe(true)
    expect(readFileSync(`${store.tasksFile}.corrupt`, 'utf8')).toBe('{不是 json')
  })

  test('结构不认识与坏条目：跳过并记账', () => {
    const store = makeStore()
    writeFileSync(store.tasksFile, JSON.stringify({ hello: 1 }), 'utf8')
    expect(store.load().problem).toContain('结构不认识')

    writeFileSync(
      store.tasksFile,
      JSON.stringify({
        tasks: [
          { id: 'ok', title: '好的', prompt: '做事', timeZone: 'UTC', rule: DAILY, enabled: true },
          { id: 'bad-tz', title: '坏时区', prompt: 'x', timeZone: 'Mars/Base', rule: DAILY },
          { id: 'bad-rule', title: '坏规则', prompt: 'x', timeZone: 'UTC', rule: { kind: 'every', seconds: 10, anchorMs: 1 } },
        ],
      }),
      'utf8',
    )
    const loaded = store.load()
    expect(loaded.tasks.map((task) => task.id)).toEqual(['ok'])
    expect(loaded.problem).toContain('跳过')
  })

  test('同 id 只留最后一条（手改复制粘贴）', () => {
    const store = makeStore()
    writeFileSync(
      store.tasksFile,
      JSON.stringify([
        { id: 'dup', title: '旧', prompt: 'x', timeZone: 'UTC', rule: DAILY },
        { id: 'dup', title: '新', prompt: 'x', timeZone: 'UTC', rule: DAILY },
      ]),
      'utf8',
    )
    const loaded = store.load()
    expect(loaded.tasks).toHaveLength(1)
    expect(loaded.tasks[0]?.title).toBe('新')
  })

  test('normalizeTask：字段类型收敛与默认值', () => {
    expect(normalizeTask(null)).toBeNull()
    expect(normalizeTask({ id: '', title: 't', prompt: 'p', timeZone: 'UTC', rule: DAILY })).toBeNull()
    expect(normalizeTask({ id: 'a', title: '  ', prompt: 'p', timeZone: 'UTC', rule: DAILY })).toBeNull()
    expect(normalizeTask({ id: 'a', title: 't', prompt: '', timeZone: 'UTC', rule: DAILY })).toBeNull()

    const task = normalizeTask({
      id: 'a',
      title: '  t  ',
      prompt: 'p',
      timeZone: 'UTC',
      rule: DAILY,
      lastStatus: 'weird',
      failureStreak: -3,
      nextRunAt: 1.6,
      deliveryHistory: [1, Number.NaN, '2', 3.4],
      createdBy: '',
    })
    expect(task).toMatchObject({
      id: 'a',
      title: 't',
      lastStatus: 'never',
      failureStreak: 0,
      nextRunAt: 2,
      createdBy: 'user',
      deliveryHistory: [1, 3],
    })
  })

  test('备份文件已存在时不覆盖（保留第一次的现场）', () => {
    const store = makeStore()
    writeFileSync(`${store.tasksFile}.corrupt`, 'first', 'utf8')
    writeFileSync(store.tasksFile, '{bad', 'utf8')
    store.load()
    expect(readFileSync(`${store.tasksFile}.corrupt`, 'utf8')).toBe('first')
  })
})
