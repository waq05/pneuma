/**
 * `app/api.ts` 的补盲：面板快照、发布、停止 / 重试、回答、清理目录、只读转录与指纹。
 *
 * 用真 `Store`（临时库）+ 真 `Session`（转录），把运行期的其余成员（引擎、来源、会话管理器、
 * 进出拍）换成对象字面量假件。`DSC_HOME` 指向临时目录并在用例结束后还原。
 *
 * @module dsc/packages/superagent/tests/app-api
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { ANSWER_MAX_CHARS, PanelApi, TICKET_FILTERS, THREAD_FILTERS, createApi } from '../app/api.js'
import { Store } from '../app/store.js'
import { SettingsSchema } from '../core/policy.js'
import { threadKey } from '../core/index.js'
import { Session } from '@pneuma/runtime/core/session.js'
import { workerSessionId } from '../executor/dsh.js'
import { sessionsDir } from '../paths.js'

const AT = '2026-01-01T00:00:00.000Z'
const TICKET = 'ticket-a'
const originalHome = process.env['DSC_HOME']
const cleanups: (() => void)[] = []

beforeEach(() => {
  process.env['DSC_HOME'] = createTempDir('dsc-api-home-')
})
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  if (originalHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = originalHome
})

/** 让视图 / 卡片能渲染的最小工单。 */
function ticketOf(id: string, over: Record<string, unknown> = {}): unknown {
  return {
    id, title: 'Fix typo', decisionId: 'decision-1',
    mandate: { strength: 'explicit', policyVersion: 'v', scope: 'Fix typo', basis: { via: 'addressed', source: 'github', addressed: 'mention' },
      actor: { source: 'github', id: 'bob' } },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] }, ...over,
  }
}

/** 一套真库 + 假运行期；`receive` / `configured` / `setupProblem` 由用例配置。 */
function fixture(options: {
  tickets?: unknown[]
  receive?: (trigger: { id: string; threads: unknown[] }) => string
  configured?: boolean
  setupProblem?: { code: string; detail: string }
  paused?: boolean
  threads?: unknown[]
  settingsVersions?: ((store: Store) => void) | undefined
} = {}) {
  const directory = createTempDir('dsc-api-')
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse({ paused: options.paused ?? false }))
  for (const ticket of options.tickets ?? []) store.tickets.save(ticket as never)
  for (const thread of options.threads ?? []) store.threads.save(thread as never)
  options.settingsVersions?.(store)
  const calls = { stop: [] as string[], retry: [] as string[], pump: 0, received: [] as unknown[] }
  const runtime = {
    store,
    machine: { stateDir: directory },
    sources: { instance: (id: string) => ({ enabled: id === 'github' }) },
    health: { github: { at: AT, state: 'error', detail: 'boom' }, feishu: { at: AT, state: 'ready' } },
    links: () => () => ({ url: 'https://example.test/x', label: { zh: '链接', en: 'link' } }),
    setupProblem: options.setupProblem,
    configured: () => options.configured ?? true,
    receive: (trigger: { id: string; threads: unknown[] }) => {
      calls.received.push(trigger)
      return options.receive?.(trigger) ?? 'stored'
    },
    pump: async () => { calls.pump += 1 },
    idle: async () => {},
    masterId: 'master-session',
    sessions: { whenIdle: async () => {} },
    engine: {
      stopTicket: (id: string) => { calls.stop.push(id) },
      retryTicket: (id: string) => { calls.retry.push(id); return { id } },
    },
  }
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  const api = new PanelApi(runtime as never)
  return { api, runtime, store, calls, directory }
}

describe('快照面', () => {
  test('计数按阶段分三类；工单行映射阶段 / 摘要 / 问题；最近动态来自已结束工单', () => {
    const f = fixture({
      tickets: [
        ticketOf('ticket-answer', { attention: { id: 'a', question: 'Which branch?' } }),
        ticketOf('ticket-queued'),
        ticketOf('ticket-done', { ended: { at: '2026-01-01T00:00:02.000Z', by: 'human', outcome: 'completed' },
          assignments: [{ id: 'a1', state: 'ended', createdAt: AT, report: { state: 'ready', summary: 'All done.\nSecond line', at: AT } }] }),
        ticketOf('ticket-closed', { ended: { at: '2026-01-01T00:00:01.000Z', by: 'executor', outcome: 'closed' } }),
      ],
    })
    const surface = f.api.surface()
    expect(surface.ready).toBe(true)
    expect(surface.counts).toStrictEqual({ needsYou: 1, running: 1, done: 2 })
    const rows = surface.tickets
    expect(rows.map(row => [row.id, row.stage.stage]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toStrictEqual([['ticket-answer', 'person'], ['ticket-closed', 'ended'], ['ticket-done', 'ended'], ['ticket-queued', 'working']])
    expect(rows.find(row => row.id === 'ticket-answer')).toMatchObject({ stage: { action: 'answer' }, question: 'Which branch?' })
    expect(rows.find(row => row.id === 'ticket-queued')).toMatchObject({ stage: { stage: 'working', action: 'queued' } })
    // 最近动态最旧在前、上限 20，未知结局原样用 outcome。
    expect(surface.recent.map(item => item.at)).toStrictEqual(['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z'])
    expect(surface.recent.map(item => item.text)).toStrictEqual([
      '工单「Fix typo」已关闭',
      '工单「Fix typo」已完成：All done. Second line',
    ])
  })

  test('来源状态读健康项：错误带 detail，没时刻不带 lastPollAt；setup 问题进 problem；最近变更来自设置历史', () => {
    const f = fixture({
      setupProblem: { code: 'cliMissing', detail: 'gh not found' },
      settingsVersions: store => {
        const base = store.settings()
        store.saveSettings(SettingsSchema.parse({ ...base, eval: { ...base.eval, mode: 'auto' } }),
          { source: 'panel', block: 'eval', policyVersion: 'v', policyChanged: false, notified: [] })
      },
    })
    const surface = f.api.surface()
    expect(surface.problem).toStrictEqual({ code: 'cliMissing', detail: 'gh not found' })
    expect(surface.sources).toStrictEqual([
      { id: 'github', enabled: true, lastPollAt: AT, lastError: 'boom' },
      { id: 'feishu', enabled: false, lastPollAt: AT },
    ])
    // 两版相邻：mode observe → auto 一行。
    expect(surface.settingsHistory).toStrictEqual([{ version: 1, at: surface.settingsHistory![0]!.at, key: 'eval.mode',
      from: 'observe', to: 'auto' }])
  })

  test('读库失败时降级成不可用 + 原因，而不是把异常抛给每一帧', () => {
    const broken = { store: { settings: () => { throw new Error('database is locked') } } }
    const api = new PanelApi(broken as never)
    expect(api.surface()).toStrictEqual({
      ready: false,
      problem: { code: 'store_unavailable', detail: 'database is locked' },
      counts: { needsYou: 0, running: 0, done: 0 }, tickets: [], recent: [],
    })
  })

  test('pulse 只取人看得见的几项，变化会改指纹', () => {
    const f = fixture({ tickets: [ticketOf('ticket-1')] })
    const first = f.api.pulse()
    expect(first).toBe(`true||{"needsYou":0,"running":1,"done":0}|ticket-1:working:queued:|github:true:${AT}:boom|feishu:false:${AT}:`)
    f.store.tickets.save(ticketOf('ticket-2', { ended: { at: AT, by: 'human', outcome: 'stopped' } }) as never)
    expect(f.api.pulse()).not.toBe(first)
    expect(createApi(f.runtime as never)).toBeInstanceOf(PanelApi)
  })
})

describe('发布', () => {
  test('标题为空 / 没配置 / 暂停 / 没入库都先拒绝，且不产生触发器', async () => {
    const unconfigured = fixture({ configured: false, setupProblem: { code: 'repositoryUnset', detail: 'no repository' } })
    await expect(unconfigured.api.publish({ title: '  ', body: '' })).rejects.toThrow(/标题不能为空/)
    await expect(unconfigured.api.publish({ title: 'Fix typo', body: '' })).rejects.toThrow(/还没完成部署检查/)
    const paused = fixture({ paused: true })
    await expect(paused.api.publish({ title: 'Fix typo', body: '' })).rejects.toThrow(/处理已暂停/)
    const duplicate = fixture({ receive: () => 'duplicate' })
    await expect(duplicate.api.publish({ title: 'Fix typo', body: 'fix it' })).rejects.toThrow(/需求没入库（duplicate）/)
    expect(duplicate.calls.received).toHaveLength(1)
  })

  test('发布成功返回工单 id；正文缺省等于标题；第一次发布把 operator 补进 manual 名单', async () => {
    const f = fixture({
      receive: trigger => {
        const key = threadKey(trigger.threads[0] as never)
        f.store.decisions.save({ id: 'decision-1', evalId: 'e', threadKey: key, triggerIds: [trigger.id], policyVersion: 'v',
          at: AT, kind: 'accept', reason: [{ code: 'explicitRouted' }], strength: 'explicit', ticketId: TICKET } as never)
        f.store.tickets.save(ticketOf(TICKET) as never)
        return 'stored'
      },
    })
    expect(await f.api.publish({ title: 'Fix typo', body: '' })).toBe(TICKET)
    const trigger = f.calls.received[0] as { text: string; meta: { title: string }; source: string; human: boolean }
    expect([trigger.source, trigger.human, trigger.text, trigger.meta.title]).toStrictEqual(['manual', true, 'Fix typo', 'Fix typo'])
    // 第一次发布前把 operator 写进 manual 名单；第二次不再重复写。
    expect(f.store.settings().policy.sources['manual']!.allowed).toStrictEqual([{ id: 'operator' }])
    const revisions = f.store.settingsHistory(10).length
    expect(await f.api.publish({ title: 'Fix typo', body: 'again' })).toBe(TICKET)
    expect(f.store.settingsHistory(10).length).toBe(revisions)
  })

  test('判定为不接单时抛出原因；一直没有判定则超时并带触发器 id', async () => {
    const ignored = fixture({
      receive: trigger => {
        f2.store.decisions.save({ id: 'decision-1', evalId: 'e', threadKey: threadKey(trigger.threads[0] as never),
          triggerIds: [trigger.id], policyVersion: 'v', at: AT, kind: 'ignore', reason: [{ code: 'noAdmissible' }], strength: 'inferred' } as never)
        return 'stored'
      },
    })
    const f2 = ignored
    await expect(ignored.api.publish({ title: 'Fix typo', body: 'x' })).rejects.toThrow(/没有接单：No admissible trigger/)

    vi.useFakeTimers()
    const silent = fixture({ receive: () => 'stored' })
    const pending = silent.api.publish({ title: 'Fix typo', body: 'x' })
    // 先挂上断言，免得推进时钟时那次拒绝短暂无人接。
    const assertion = expect(pending).rejects.toThrow(/判定超时/)
    // 120 秒判定上限 + 100ms 复查间隔：把时钟推过去，循环自然退出。
    await vi.advanceTimersByTimeAsync(121_000)
    await assertion
    vi.useRealTimers()
  })
})

describe('停止 / 重试 / 回答', () => {
  test('stop 与 retry 走引擎并各跑一拍；空 id 拒绝', async () => {
    const f = fixture()
    await expect(f.api.stop('  ')).rejects.toThrow('要给一个工单 id')
    await f.api.stop(' ticket-a ')
    await f.api.retry('ticket-a')
    expect([f.calls.stop, f.calls.retry, f.calls.pump]).toStrictEqual([['ticket-a'], ['ticket-a'], 2])
  })

  test('回答：空 / 太长 / 没这张单 / 已结束 / 没有可回话线程分别拒绝', async () => {
    const live = fixture({ tickets: [ticketOf(TICKET)] })
    await expect(live.api.answer({ ticketId: TICKET, text: '  ' })).rejects.toThrow('回答不能为空')
    await expect(live.api.answer({ ticketId: TICKET, text: 'x'.repeat(ANSWER_MAX_CHARS + 1) })).rejects.toThrow(/回答太长/)
    await expect(live.api.answer({ ticketId: 'missing', text: 'hi' })).rejects.toThrow(/没有这张工单/)
    const ended = fixture({ tickets: [ticketOf(TICKET, { ended: { at: AT, by: 'human', outcome: 'stopped' } })] })
    await expect(ended.api.answer({ ticketId: TICKET, text: 'hi' })).rejects.toThrow(/这张工单已经结束/)
    await expect(live.api.answer({ ticketId: TICKET, text: 'hi' })).rejects.toThrow(/没有可回话的线程/)
  })

  test('回答落到最近的订阅线程；重复 / 被过滤 / 成功三种结果分别处理', async () => {
    const thread = { key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: AT, subscriptions: [TICKET], correlated: [], pending: [], meta: {} }
    const older = { ...thread, key: 'github:0', ref: { source: 'github', id: '0' }, createdAt: '2025-12-31T00:00:00.000Z', lastAt: AT }
    const f = fixture({ tickets: [ticketOf(TICKET)], threads: [thread, older] })
    await f.api.answer({ ticketId: TICKET, text: '  Use the main branch.  ' })
    const trigger = f.calls.received[0] as { source: string; threads: { id: string }[]; text: string; meta: Record<string, unknown> }
    expect(trigger.threads).toStrictEqual([{ source: 'github', id: '1' }])
    expect([trigger.text, trigger.meta['ticketId']]).toStrictEqual(['Use the main branch.', TICKET])
    expect(f.calls.pump).toBe(1)
    const duplicate = fixture({ tickets: [ticketOf(TICKET)], threads: [thread], receive: () => 'duplicate' })
    await expect(duplicate.api.answer({ ticketId: TICKET, text: 'hi' })).rejects.toThrow(/这条回答重复了/)
    const filtered = fixture({ tickets: [ticketOf(TICKET)], threads: [thread], receive: () => 'filtered' })
    await expect(filtered.api.answer({ ticketId: TICKET, text: 'hi' })).rejects.toThrow(/准入闸没放行/)
  })
})

describe('清理执行目录', () => {
  test('没结束 / 没目录 / 越界都拒绝；根下目录才删', async () => {
    const f = fixture()
    await expect(f.api.clean('')).rejects.toThrow('要给一个工单 id')
    await expect(f.api.clean('missing')).rejects.toThrow(/没有这张工单/)
    f.store.tickets.save(ticketOf('open-ticket') as never)
    await expect(f.api.clean('open-ticket')).rejects.toThrow(/还没结束/)
    f.store.tickets.save(ticketOf('no-dir', { ended: { at: AT, by: 'human', outcome: 'stopped' } }) as never)
    await expect(f.api.clean('no-dir')).rejects.toThrow(/没有执行目录/)
    // 执行根默认是 <stateDir>/work；指到根外的目录一律拒绝。
    f.store.tickets.save(ticketOf('outside', { ended: { at: AT, by: 'human', outcome: 'stopped' },
      execution: { name: 'outside', directory: join(f.directory, 'elsewhere'), assignment: '' } }) as never)
    await expect(f.api.clean('outside')).rejects.toThrow(/执行目录不在工单目录根下/)
    // 根下的目录删掉，连同里面的文件。
    const inside = join(f.directory, 'work', 'fix-typo')
    mkdirSync(inside, { recursive: true })
    writeFileSync(join(inside, 'file.txt'), 'x')
    f.store.tickets.save(ticketOf('inside', { ended: { at: AT, by: 'human', outcome: 'completed' },
      execution: { name: 'fix-typo', directory: inside, assignment: '' } }) as never)
    await f.api.clean('inside')
    expect(existsSync(inside)).toBe(false)
  })
})

describe('peekSession', () => {
  test('没有会话日志就报错；有的话只读重放出转录条目', async () => {
    const f = fixture({ tickets: [ticketOf(TICKET)] })
    await expect(f.api.peekSession(TICKET)).rejects.toThrow(/还没有执行会话/)
    const file = join(sessionsDir(TICKET), `${workerSessionId(TICKET)}.jsonl`)
    mkdirSync(join(sessionsDir(TICKET)), { recursive: true })
    const session = Session.create(f.directory, file, { id: workerSessionId(TICKET) })
    session.appendUser('Fix the typo')
    session.appendAssistant('On it.', '', [])
    session.close()
    // 日志走的是写入流：`close()` 只 `end()` 流，内容稍后才真正到位。CI 的 Windows runner
    // 上就撞到过「文件先出现、头行后到」，直接读会报「会话文件头损坏」。这里不去读文件
    // （流没关时读盘在 Windows 上可能抛），直接按**最终行为**重试 `peekSession`。
    const entries = await vi.waitFor(async () => {
      const got = await f.api.peekSession(TICKET)
      expect(got.some((entry) => entry.kind === 'user')).toBe(true)
      expect(got.some((entry) => entry.kind === 'text')).toBe(true)
      return got
    }, { timeout: 10_000, interval: 50 })
    expect(entries.length).toBeGreaterThan(0)
  }, 20_000)
})

describe('导出的常量', () => {
  test('筛选值、回答上限与上游一致', () => {
    expect(TICKET_FILTERS).toStrictEqual(['open', 'person', 'working', 'idle', 'ended'])
    expect(THREAD_FILTERS.length).toBeGreaterThan(0)
    expect(ANSWER_MAX_CHARS).toBe(4000)
  })
})
