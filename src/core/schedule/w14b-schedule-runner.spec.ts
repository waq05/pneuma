/**
 * `core/schedule/runner.ts` 的缺口补齐：手动跑的卡闸、tick 内部出错、没排期的任务补算、
 * 端点读不到、投递后读不到当前会话、失败阶梯，以及定时器的分段/短延迟两路。
 *
 * 用真 `ScheduleStore`（临时目录）+ 固定时钟 + 假 deps；定时器那一组用 vitest 的假时钟驱动，
 * 不 sleep、不碰 `~/.dsc`、不发网络请求。
 *
 * @module dsc/core/schedule/w14b-schedule-runner.spec
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ScheduleRule } from './rule.js'
import { ScheduleRunner, TIMER_SLICE_MS, type ScheduleRunnerConfig, type ScheduleRunnerDeps } from './runner.js'
import { ScheduleStore, type ScheduleTask, type ScheduleTaskInput } from './store.js'

const NOW = Date.UTC(2026, 2, 9, 9, 30)
const CONFIG: ScheduleRunnerConfig = { enabled: true, timeZone: 'UTC', maxRunSeconds: 600 }

let root = ''
let store: ScheduleStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsc-w14b-runner-'))
  store = new ScheduleStore({ dir: join(root, 'schedule'), now: () => NOW })
  mkdirSync(store.dir, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

/** 假 deps：记录投递与提示；route / 凭据都是假值。 */
function makeDeps(overrides: Partial<ScheduleRunnerDeps> = {}) {
  const deliveries: Array<{ text: string; task: ScheduleTask; slot: number }> = []
  const notes: string[] = []
  const deps: ScheduleRunnerDeps = {
    store,
    config: () => CONFIG,
    route: () => ({ baseUrl: 'https://api.test/v1', apiKey: 'fake-key', model: 'test-model' }),
    deliver: (text, task, slot) => {
      deliveries.push({ text, task, slot })
    },
    waiting: () => false,
    sessionId: () => 's1',
    now: () => NOW,
    notice: (text) => notes.push(text),
    lastErrorText: () => '',
    ...overrides,
  }
  return { deps, deliveries, notes }
}

/** 每分钟一次、锚点在一小时前：宽限 120 秒，槽位落到过去就是到点/迟到/合并。 */
const EVERY: ScheduleRule = { kind: 'every', seconds: 60, anchorMs: NOW - 3_600_000 }

/** 建一条任务；默认目标会话 s1。 */
function createTask(overrides: Partial<ScheduleTaskInput> = {}): Promise<ScheduleTask> {
  return store.create({ title: 'T', prompt: '做事', rule: EVERY, timeZone: 'UTC', sessionId: 's1', ...overrides })
}

describe('fireNow：目标会话有卡片在等用户', () => {
  test('推迟到下一轮，不投递', async () => {
    const { deps, deliveries } = makeDeps({ waiting: () => true })
    const runner = new ScheduleRunner(deps)
    const task = await createTask()
    const text = await runner.fireNow(task.id.slice(0, 5))
    expect(text).toContain('卡片在等用户处理')
    expect(deliveries).toHaveLength(0)
    runner.stop()
  })
})

describe('tick：内部出错只记一行，不往外抛', () => {
  test('reload 抛错：tick 返回 false 并留一条提示', async () => {
    const broken = Object.create(store) as ScheduleStore
    broken.reload = () => {
      throw new Error('磁盘坏了')
    }
    const { deps, notes } = makeDeps({ store: broken })
    const runner = new ScheduleRunner(deps)
    expect(await runner.tick()).toBe(false)
    expect(notes.some((line) => line.includes('定时任务检查时出错'))).toBe(true)
    runner.stop()
  })
})

describe('processDue：没排期的任务先补算', () => {
  test('nextRunAt 为 null 的周期任务：算出来写回排期', async () => {
    const { deps } = makeDeps()
    const runner = new ScheduleRunner(deps)
    const task = await createTask()
    expect(store.get(task.id)?.nextRunAt).toBeNull()
    await runner.tick()
    expect(store.get(task.id)?.nextRunAt).toBeGreaterThan(NOW)
    runner.stop()
  })
})

describe('deliver 前的校验', () => {
  test('route 抛错：记 blocked 与原因，一次都不投', async () => {
    const { deps, deliveries } = makeDeps({
      route: () => {
        throw new Error('没有可用的模型端点')
      },
    })
    const runner = new ScheduleRunner(deps)
    const task = await createTask()
    await store.setNextRunAt(task.id, NOW)
    await runner.tick()
    expect(deliveries).toHaveLength(0)
    const saved = store.get(task.id)
    expect(saved?.lastStatus).toBe('blocked')
    expect(saved?.lastError).toContain('模型端点不可用')
    runner.stop()
  })

  test('投递后读不到当前会话：按空会话记账，不抛', async () => {
    let calls = 0
    const { deps, deliveries } = makeDeps({
      sessionId: () => {
        calls += 1
        // 第一次是卡闸、第二次是 preflight；投递完之后那次才读不到（会话刚关）。
        if (calls >= 3) throw new Error('会话已经关了')
        return 's1'
      },
    })
    const runner = new ScheduleRunner(deps)
    const task = await createTask({ sessionId: '' })
    await store.setNextRunAt(task.id, NOW)
    await runner.tick()
    expect(deliveries).toHaveLength(1)
    expect(store.get(task.id)?.lastStatus).toBe('ok')
    runner.stop()
  })
})

describe('noteTurnEnd：以错误收尾时排重试', () => {
  test('瞬时网络错：失败计数 +1（重试阶梯第 0 档）', async () => {
    const { deps } = makeDeps({ lastErrorText: () => 'read ECONNRESET' })
    const runner = new ScheduleRunner(deps)
    const task = await createTask()
    await store.setNextRunAt(task.id, NOW)
    await runner.tick()
    runner.noteTurnEnd('error')
    await vi.waitFor(() => {
      expect(store.get(task.id)?.failureStreak).toBe(1)
    })
    expect(store.get(task.id)?.lastStatus).toBe('failed')
    runner.stop()
  })
})

describe('定时器：分段唤醒与短延迟到点', () => {
  test('先按分段重排（sliced），再到点走 tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { deps } = makeDeps()
    const runner = new ScheduleRunner(deps)
    runner.start()
    await vi.advanceTimersByTimeAsync(0)
    // 没有任何任务：这一轮一定是「分段到点」，重排一次而不是惊动任务表。
    await vi.advanceTimersByTimeAsync(TIMER_SLICE_MS)

    // 放一条「一秒后到点」的任务，让下一次 arm 的延迟小于分段。
    const task = await createTask()
    await store.setNextRunAt(task.id, NOW + 1_000)
    await runner.checkNow()
    await vi.advanceTimersByTimeAsync(1_000)
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    expect(runner.hasLock).toBe(true)
    runner.stop()
  })
})
