/**
 * 调度循环（`core/schedule/runner.ts` 的 `ScheduleRunner`）：拿锁、补投、catch-up、
 * preflight、投递记账、回合对账、状态描述。
 *
 * 与 `runner.spec.ts` 的分工：那个文件钉纯决策函数，这个文件钉「决策怎么落到 store 与投递上」。
 * 用真 `ScheduleStore`（临时目录）+ 注入的固定时钟与假 deps：不 sleep、不碰 `~/.dsc`、
 * 不发任何网络请求；`deliver` 只是收集参数，投递成功与否由测试自己制造。
 *
 * @module dsc/core/schedule/runner-loop.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ScheduleRule } from './rule.js'
import {
  isProcessAlive,
  ScheduleRunner,
  scheduleLimitsNote,
  type ScheduleRunnerConfig,
  type ScheduleRunnerDeps,
} from './runner.js'
import { ScheduleStore, type ScheduleTask, type ScheduleTaskInput } from './store.js'

/** 2026-03-09 09:30 UTC。 */
const NOW = Date.UTC(2026, 2, 9, 9, 30)
const CONFIG: ScheduleRunnerConfig = { enabled: true, timeZone: 'UTC', maxRunSeconds: 600 }

let root = ''
let store: ScheduleStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsc-runner-loop-'))
  store = new ScheduleStore({ dir: join(root, 'schedule'), now: () => NOW })
  mkdirSync(store.dir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 假 deps：记录投递与提示；route/凭据都是假值。 */
function makeDeps(overrides: Partial<ScheduleRunnerDeps> = {}) {
  const deliveries: Array<{ text: string; task: ScheduleTask; slot: number }> = []
  const notes: string[] = []
  const waitingCalls: string[] = []
  const deps: ScheduleRunnerDeps = {
    store,
    config: () => CONFIG,
    route: () => ({ baseUrl: 'https://api.test/v1', apiKey: 'fake-key', model: 'test-model' }),
    deliver: (text, task, slot) => {
      deliveries.push({ text, task, slot })
    },
    waiting: (sessionId) => {
      waitingCalls.push(sessionId)
      return false
    },
    sessionId: () => 's1',
    now: () => NOW,
    notice: (text) => notes.push(text),
    lastErrorText: () => '',
    ...overrides,
  }
  return { deps, deliveries, notes, waitingCalls }
}

/** 建一条任务；默认目标会话 s1。 */
function createTask(rule: ScheduleRule, overrides: Partial<ScheduleTaskInput> = {}): Promise<ScheduleTask> {
  return store.create({ title: 'T', prompt: '做事', rule, timeZone: 'UTC', sessionId: 's1', ...overrides })
}

/** 每分钟一次、锚点在一小时前：宽限 120 秒，槽位落到过去就是到点/迟到/合并。 */
const EVERY: ScheduleRule = { kind: 'every', seconds: 60, anchorMs: NOW - 3_600_000 }

describe('调度锁', () => {
  test('start 拿锁、stop 放锁并删掉自己的锁文件', () => {
    const { deps } = makeDeps()
    const runner = new ScheduleRunner(deps)
    runner.start()
    expect(runner.hasLock).toBe(true)
    expect(existsSync(store.lockFile)).toBe(true)
    runner.stop()
    expect(runner.hasLock).toBe(false)
    expect(existsSync(store.lockFile)).toBe(false)
  })

  test('锁的主人还活着：本进程只读，tick / checkNow / fireNow 都不动手', async () => {
    writeFileSync(store.lockFile, JSON.stringify({ pid: process.pid, birth: 0 }), 'utf8')
    const fake = makeDeps()
    const runner = new ScheduleRunner(fake.deps)

    expect(await runner.tick()).toBe(false)
    expect(fake.notes.some((line) => line.includes('只读，不推进也不投递'))).toBe(true)
    expect(await runner.checkNow()).toContain('另一个 Pneuma 进程正握着调度锁')
    expect(await runner.fireNow('sched-')).toContain('本进程只读')
    expect(runner.hasLock).toBe(false)
  })

  test('锁的主人已经不在了：接管并重写锁，提示只报一次', async () => {
    writeFileSync(store.lockFile, JSON.stringify({ pid: 999_999_999, birth: 1 }), 'utf8')
    const fake = makeDeps()
    const runner = new ScheduleRunner(fake.deps)

    expect(await runner.tick()).toBe(false)
    expect(runner.hasLock).toBe(true)
    const written = JSON.parse(readFileSync(store.lockFile, 'utf8')) as { pid: number; birth: number }
    expect(written.pid).toBe(process.pid)
    expect(fake.notes.filter((line) => line.includes('已经不在了')).length).toBe(1)

    await runner.tick()
    expect(fake.notes.filter((line) => line.includes('已经不在了')).length).toBe(1)
  })

  test('坏锁文件按没有锁处理：直接重写，不抛错', async () => {
    writeFileSync(store.lockFile, '{bad', 'utf8')
    const fake = makeDeps()
    const runner = new ScheduleRunner(fake.deps)
    expect(await runner.tick()).toBe(false)
    expect(runner.hasLock).toBe(true)
    expect(() => JSON.parse(readFileSync(store.lockFile, 'utf8'))).not.toThrow()
  })

  test('目录建不出来：只读这一轮并提示，没有锁', async () => {
    writeFileSync(join(root, 'blocked'), 'x', 'utf8')
    const badStore = new ScheduleStore({ dir: join(root, 'blocked'), now: () => NOW })
    const fake = makeDeps({ store: badStore })
    const runner = new ScheduleRunner(fake.deps)

    expect(await runner.tick()).toBe(false)
    expect(runner.hasLock).toBe(false)
    expect(fake.notes.some((line) => line.includes('写调度锁失败'))).toBe(true)
  })

  test('stop 不删别人的锁文件', () => {
    writeFileSync(store.lockFile, JSON.stringify({ pid: process.pid, birth: 0 }), 'utf8')
    const runner = new ScheduleRunner(makeDeps().deps)
    void runner.tick()
    runner.stop()
    expect(existsSync(store.lockFile)).toBe(true)
  })

  test('isProcessAlive：非法 pid 假、自己的 pid 真', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(999_999_999)).toBe(false)
  })
})

describe('到点处理', () => {
  test('准点投递：文案带定时标记、槽位推走、台账落 ok', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps()

    expect(await new ScheduleRunner(fake.deps).tick()).toBe(true)

    expect(fake.deliveries).toHaveLength(1)
    expect(fake.deliveries[0]!.text).toContain('【定时任务触发】')
    expect(fake.deliveries[0]!.text).toContain('不是用户此刻发出的指令')
    const after = store.get(task.id)!
    expect(after.pendingSlot).toBeNull()
    expect(after.lastStatus).toBe('ok')
    expect(after.nextRunAt).toBeGreaterThan(NOW)
    expect(store.recentRuns(1)[0]).toMatchObject({ id: task.id, status: 'ok', detail: 'due' })
  })

  test('超宽限：积压合并成一次、排期快进到现在之后，并留一句提示', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 10 * 60_000)
    const fake = makeDeps()

    expect(await new ScheduleRunner(fake.deps).tick()).toBe(true)

    expect(fake.deliveries).toHaveLength(1)
    expect(fake.deliveries[0]!.text).toContain('错过的几次已合并成这一次')
    expect(store.get(task.id)!.nextRunAt).toBeGreaterThan(NOW)
    expect(fake.notes.some((line) => line.includes('合并成这一次'))).toBe(true)
  })

  test('一次性任务超宽限：不投、记 skipped 并停用', async () => {
    const task = await createTask({ kind: 'at', atMs: NOW - 10 * 60_000 })
    await store.setNextRunAt(task.id, NOW - 10 * 60_000)
    const fake = makeDeps()

    expect(await new ScheduleRunner(fake.deps).tick()).toBe(true)

    expect(fake.deliveries).toHaveLength(0)
    const after = store.get(task.id)!
    expect(after.enabled).toBe(false)
    expect(after.lastStatus).toBe('skipped')
    expect(store.recentRuns(1)[0]).toMatchObject({ status: 'skipped' })
    expect(fake.notes.some((line) => line.includes('不补跑'))).toBe(true)
  })

  test('过期的一次性任务：算不出下一次就停用并记 done', async () => {
    const task = await createTask({ kind: 'at', atMs: NOW - 60_000 })
    const fake = makeDeps()

    expect(await new ScheduleRunner(fake.deps).tick()).toBe(true)

    expect(fake.deliveries).toHaveLength(0)
    const after = store.get(task.id)!
    expect(after.enabled).toBe(false)
    expect(after.lastStatus).toBe('done')
    expect(store.recentRuns(1)[0]!.detail).toContain('已经过期')
    expect(fake.notes.some((line) => line.includes('自动停用'))).toBe(true)
  })

  test('目标会话挂着卡：这一轮不投，下一轮再看见它', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({ waiting: () => true })

    expect(await new ScheduleRunner(fake.deps).tick()).toBe(false)

    expect(fake.deliveries).toHaveLength(0)
    expect(store.get(task.id)!.pendingSlot).toBeNull()
    expect(store.get(task.id)!.nextRunAt).toBe(NOW - 30_000)
    expect(fake.notes.some((line) => line.includes('推迟到下一轮'))).toBe(true)
  })

  test('卡闸问的是任务自己的会话：别的会话有卡不挡这条', async () => {
    const task = await createTask(EVERY, { sessionId: 's2' })
    await store.setNextRunAt(task.id, NOW - 30_000)
    const calls: string[] = []
    const fake = makeDeps({
      waiting: (id) => {
        calls.push(id)
        return id === 's1'
      },
    })

    expect(await new ScheduleRunner(fake.deps).tick()).toBe(true)
    expect(calls).toEqual(['s2'])
    expect(fake.deliveries).toHaveLength(1)
  })

  test('任务没存 sessionId：卡闸回落到当前会话', async () => {
    const task = await createTask(EVERY, { sessionId: '' })
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps()

    await new ScheduleRunner(fake.deps).tick()
    expect(fake.waitingCalls).toContain('s1')
  })

  test('停用过的任务不再处理', async () => {
    const task = await createTask(EVERY, { enabled: false })
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps()
    expect(await new ScheduleRunner(fake.deps).tick()).toBe(false)
    expect(fake.deliveries).toHaveLength(0)
  })
})

describe('悬空槽位补投', () => {
  test('推进了却没投出去的那一次补投一次，文案是 recovered', async () => {
    const task = await createTask(EVERY)
    await store.beginSlot(task.id, NOW - 5_000, NOW + 60_000)
    const fake = makeDeps()

    expect(await new ScheduleRunner(fake.deps).tick()).toBe(true)

    expect(fake.deliveries).toHaveLength(1)
    expect(fake.deliveries[0]!.text).toContain('补投')
    const after = store.get(task.id)!
    expect(after.pendingSlot).toBeNull()
    expect(after.lastStatus).toBe('ok')
  })

  test('补投也会被目标会话的卡挡住，并汇总成一句提示', async () => {
    const task = await createTask(EVERY)
    await store.beginSlot(task.id, NOW - 5_000, NOW + 60_000)
    const fake = makeDeps({ waiting: () => true })

    expect(await new ScheduleRunner(fake.deps).tick()).toBe(false)
    expect(fake.deliveries).toHaveLength(0)
    expect(store.get(task.id)!.pendingSlot).toBe(NOW - 5_000)
    expect(fake.notes.some((line) => line.includes('补投推迟到下一轮'))).toBe(true)
  })
})

describe('preflight：投不出去时一次模型请求都不发', () => {
  test('当前没有打开的会话：blocked 并写清原因', async () => {
    const task = await createTask(EVERY, { sessionId: '' })
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({ sessionId: () => '' })

    expect(await new ScheduleRunner(fake.deps).tick()).toBe(true)

    expect(fake.deliveries).toHaveLength(0)
    const after = store.get(task.id)!
    expect(after.lastStatus).toBe('blocked')
    expect(after.lastError).toContain('当前没有打开的会话')
    expect(store.recentRuns(1)[0]!.status).toBe('blocked')
    expect(fake.notes.some((line) => line.includes('暂时投不出去'))).toBe(true)
  })

  test('读当前会话就抛错：原因里带原文', async () => {
    const task = await createTask(EVERY, { sessionId: '' })
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({
      sessionId: () => {
        throw new Error('会话表还没就绪')
      },
    })

    await new ScheduleRunner(fake.deps).tick()
    expect(store.get(task.id)!.lastError).toContain('读不到当前会话')
    expect(store.get(task.id)!.lastError).toContain('会话表还没就绪')
  })

  test('端点 baseUrl 为空：拒因说清字段，不调 deliver', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({ route: () => ({ baseUrl: '', apiKey: 'fake-key', model: 'm' }) })

    await new ScheduleRunner(fake.deps).tick()
    expect(store.get(task.id)!.lastError).toContain('baseUrl 或 model 是空的')
    expect(fake.deliveries).toHaveLength(0)
  })

  test('凭据为空：拒因不带 key 原文', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({ route: () => ({ baseUrl: 'https://api.test', apiKey: '', model: 'm' }) })

    await new ScheduleRunner(fake.deps).tick()
    const reason = store.get(task.id)!.lastError ?? ''
    expect(reason).toContain('没有可解析的凭据')
    expect(reason).not.toContain('fake-key')
  })

  test('沙箱不许写数据目录：拒因带目录和越界原因', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({ canWriteDir: () => ({ allowed: false, reason: '只读档位' }) })

    await new ScheduleRunner(fake.deps).tick()
    const reason = store.get(task.id)!.lastError ?? ''
    expect(reason).toContain(store.dir)
    expect(reason).toContain('只读档位')
  })

  test('一次性任务投不出去也把槽位用掉并停用', async () => {
    const task = await createTask({ kind: 'at', atMs: NOW - 30_000 })
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({ route: () => ({ baseUrl: '', apiKey: '', model: '' }) })

    await new ScheduleRunner(fake.deps).tick()
    const after = store.get(task.id)!
    expect(after.lastStatus).toBe('blocked')
    expect(after.nextRunAt).toBeNull()
    expect(after.enabled).toBe(false)
  })
})

describe('投递失败记账', () => {
  test('deliver 抛瞬时网络错：写 failed、排到第一档重试', async () => {
    // 用小时级规则：自然排期（一小时后）比重试阶梯晚，阶梯才会插队。
    const task = await createTask({ kind: 'every', seconds: 3_600, anchorMs: NOW - 3_600_000 })
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({
      deliver: () => {
        throw new Error('read ECONNRESET')
      },
    })

    await new ScheduleRunner(fake.deps).tick()

    const after = store.get(task.id)!
    expect(after.lastStatus).toBe('failed')
    expect(after.lastError).toContain('ECONNRESET')
    expect(after.failureStreak).toBe(1)
    expect(after.nextRunAt).toBe(NOW + 5 * 60_000)
    expect(fake.notes.some((line) => line.includes('投递失败'))).toBe(true)
  })

  test('deliver 抛配额错：状态 blocked，停到恢复点之后', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({
      deliver: () => {
        throw new Error('HTTP 429 rate limit, retry after 120s')
      },
    })

    await new ScheduleRunner(fake.deps).tick()

    const after = store.get(task.id)!
    expect(after.lastStatus).toBe('blocked')
    expect(after.nextRunAt).toBe(NOW + 120_000 + 60_000)
  })
})

describe('fireNow / checkNow', () => {
  test('手动跑一次：文案是 manual，周期任务的定时排期不动', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW + 60_000)
    const fake = makeDeps()
    const runner = new ScheduleRunner(fake.deps)

    const text = await runner.fireNow(task.id.slice(0, 10))

    expect(text).toContain('已把「T」立即投给模型')
    expect(text).toContain('定时排期不动')
    expect(fake.deliveries).toHaveLength(1)
    expect(fake.deliveries[0]!.text).toContain('手动点「立即跑一次」')
    expect(store.get(task.id)!.nextRunAt).toBe(NOW + 60_000)
    expect(store.get(task.id)!.enabled).toBe(true)
  })

  test('一次性任务手动跑掉就算用过：停用且不再有排期', async () => {
    const task = await createTask({ kind: 'at', atMs: NOW + 60_000 })
    const fake = makeDeps()
    const runner = new ScheduleRunner(fake.deps)

    const text = await runner.fireNow(task.id)

    expect(text).not.toContain('定时排期不动')
    expect(store.get(task.id)!.enabled).toBe(false)
    expect(store.get(task.id)!.nextRunAt).toBeNull()
  })

  test('前缀匹配不到 / 匹配到多条：抛错说清楚', async () => {
    const fake = makeDeps()
    const runner = new ScheduleRunner(fake.deps)
    await expect(runner.fireNow('nope')).rejects.toThrow(/没有匹配/)

    await createTask(EVERY, { title: 'A' })
    await createTask(EVERY, { title: 'B' })
    await expect(runner.fireNow('sched-')).rejects.toThrow(/匹配到 2 条/)
  })

  test('总开关关着：checkNow / fireNow 都只回一句话，不投递', async () => {
    const task = await createTask(EVERY)
    const fake = makeDeps({ config: () => ({ ...CONFIG, enabled: false }) })
    const runner = new ScheduleRunner(fake.deps)

    expect(await runner.checkNow()).toContain('总开关是关着的')
    expect(await runner.fireNow(task.id)).toContain('总开关是关着的')
    expect(fake.deliveries).toHaveLength(0)
  })

  test('checkNow 开着：跑一轮并回一句现状', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW + 60_000)
    const fake = makeDeps()
    const runner = new ScheduleRunner(fake.deps)

    const text = await runner.checkNow()
    expect(text).toContain('1 条任务（1 条启用）')
    expect(text).toContain('本进程在调度')
    expect(text).toContain('下一次唤醒')
    runner.stop()
  })
})

describe('回合结束对账', () => {
  test('completed：清掉失败计数并把状态收回 ok', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const runner = new ScheduleRunner(makeDeps().deps)
    await runner.tick()
    await store.endSlot(task.id, { status: 'failed', error: '上一次错了', failureStreak: 2 })

    runner.noteTurnEnd('completed', 's1')
    // endSlot 是 async void（非 await 路径），让出事件循环再断言。
    await new Promise((resolve) => setTimeout(resolve, 20))

    const after = store.get(task.id)!
    expect(after.lastStatus).toBe('ok')
    expect(after.failureStreak).toBe(0)
    expect(after.lastError).toBeNull()
  })

  test('aborted：配对但不动账；同一条会话不会被记第二次', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const runner = new ScheduleRunner(makeDeps().deps)
    await runner.tick()
    await store.endSlot(task.id, { status: 'failed', error: 'x', failureStreak: 1 })

    runner.noteTurnEnd('aborted', 's1')
    expect(store.get(task.id)!.lastStatus).toBe('failed')
    expect(store.get(task.id)!.failureStreak).toBe(1)

    // 投递已经被 aborted 那次取走，再来一次 completed 不该凭空改动账目。
    await store.endSlot(task.id, { status: 'failed', error: 'x', failureStreak: 2 })
    runner.noteTurnEnd('completed', 's1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.get(task.id)!.failureStreak).toBe(2)
  })

  test('别的会话的 turn-end 不记到这条投递头上', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const runner = new ScheduleRunner(makeDeps().deps)
    await runner.tick()
    await store.endSlot(task.id, { status: 'failed', error: 'x', failureStreak: 1 })

    runner.noteTurnEnd('completed', 'other-session')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.get(task.id)!.failureStreak).toBe(1)

    runner.noteTurnEnd('completed', 's1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.get(task.id)!.failureStreak).toBe(0)
  })

  test('error：按原文分类（配额 → blocked），提示条带原因', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps({ lastErrorText: () => 'HTTP 429 quota exceeded' })
    const runner = new ScheduleRunner(fake.deps)
    await runner.tick()

    runner.noteTurnEnd('error', 's1')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(store.get(task.id)!.lastStatus).toBe('blocked')
    expect(store.get(task.id)!.lastError).toContain('quota exceeded')
    expect(fake.notes.some((line) => line.includes('这一轮没跑成'))).toBe(true)
  })

  test('error 但读不到原文：用默认文案，按「其它错误」记账', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW - 30_000)
    const fake = makeDeps()
    const runner = new ScheduleRunner(fake.deps)
    await runner.tick()

    runner.noteTurnEnd('error', 's1')
    await new Promise((resolve) => setTimeout(resolve, 30))

    const after = store.get(task.id)!
    expect(after.lastStatus).toBe('failed')
    expect(after.failureStreak).toBe(0)
    expect(fake.notes.some((line) => line.includes('模型端点报错'))).toBe(true)
  })

  test('没有投递在等：noteTurnEnd 什么都不做', () => {
    const runner = new ScheduleRunner(makeDeps().deps)
    expect(() => runner.noteTurnEnd('completed', 's1')).not.toThrow()
    expect(() => runner.noteTurnEnd('completed')).not.toThrow()
  })
})

describe('describeState / 限制说明', () => {
  test('空表：只读提示与没有排期', () => {
    const runner = new ScheduleRunner(makeDeps().deps)
    const text = runner.describeState()
    expect(text).toContain('0 条任务')
    expect(text).toContain('本进程只读')
    expect(text).toContain('没有排到将来的任务')
  })

  test('有任务与待补投槽位：数字与提示都在', async () => {
    const task = await createTask(EVERY)
    await store.setNextRunAt(task.id, NOW + 60_000)
    const runner = new ScheduleRunner(makeDeps().deps)
    await runner.tick()
    // tick 会先补投悬空槽位；这里在 tick 之后再制造一个，专门看描述里的「待补投」。
    await store.beginSlot(task.id, NOW - 5_000, NOW + 60_000)

    const text = runner.describeState()
    expect(text).toContain('1 条任务（1 条启用）')
    expect(text).toContain('本进程在调度')
    expect(text).toContain('1 个槽位待补投')
  })

  test('scheduleLimitsNote 写明宿主不常驻就不触发', () => {
    const text = scheduleLimitsNote()
    expect(text).toContain('宿主不常驻就不触发')
    expect(text).toContain('至多补一次')
  })
})
