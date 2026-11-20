/**
 * `app/store-read.ts` 的包级覆盖测试：视图、工具与来源轮询用的只读查询。
 *
 * 为什么这些查询值得逐条钉：它们全都跑在 SQLite 的 JSON 生成列与半开区间比较上，
 * 写错时不会抛错，而是「界面第一次翻页就漏一行」「被过滤的触发也算进流量计数」
 * 「相邻两条取到了 CI」这类静默错。每条断言读的都是**迁完之后真实查出来的行**，
 * 不用假件替代查询本身。
 *
 * 夹具直接经 `Store` 的公开写口落库（`triggers` / `threads` / `decisions` / `receipts`），
 * 只有 `effect` 表没有对应写口时才走一句参数化 SQL；临时目录用 `createTempDir()`，
 * 全程不碰真实的 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/app-store-read
 */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Decision, Thread, Trigger } from '../core/index.js'
import { Store } from '../app/store.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

/** 一条触发；`threads` 默认落在 `source:thread` 上。 */
function trigger(id: string, source: string, at: string, over: Partial<Trigger> = {}): Trigger {
  return {
    id, source, threads: [{ source, id: 'thread' }], actor: { source, id: 'actor' }, human: true,
    at, text: id, meta: {}, ...over,
  }
}

/** 一条线程；默认不订阅任何工单。 */
function thread(source: string, id: string, over: Partial<Thread> = {}): Thread {
  return { key: `${source}:${id}`, ref: { source, id }, createdAt: '2026-01-01T00:00:00.000Z', subscriptions: [], correlated: [], pending: [], meta: {}, ...over }
}

/** 一条判定；默认 ignore。 */
function decision(id: string, threadKey: string, triggerIds: string[], at: string, kind: Decision['kind'] = 'ignore'): Decision {
  return { id, evalId: `eval-${id}`, threadKey, triggerIds, policyVersion: 'v1', at, kind, reason: [], strength: 'explicit' }
}

describe('app/store-read', () => {
  let dir: string
  let store: Store

  beforeEach(() => {
    dir = createTempDir('dsc-sa-read-')
    store = new Store(join(dir, 'orchestrator.sqlite'))
  })
  afterEach(() => { store.close() })

  it('recentTriggers 按到达顺序（rowid）新在前，可 offset/limit', () => {
    store.triggers.save(trigger('t1', 'feishu', '2026-10-01T00:00:01.000Z'))
    store.triggers.save(trigger('t2', 'feishu', '2026-10-01T00:00:02.000Z'))
    store.triggers.save(trigger('t3', 'feishu', '2026-10-01T00:00:03.000Z'))
    // 到达顺序与 at 顺序故意相反：证明排序用 rowid 不用时间戳。
    store.triggers.save(trigger('t4', 'feishu', '2026-09-30T00:00:00.000Z'))
    expect(store.read.recentTriggers().map(item => item.id)).toEqual(['t4', 't3', 't2', 't1'])
    expect(store.read.recentTriggers(1, 2).map(item => item.id)).toEqual(['t3', 't2'])
    expect(store.read.recentTriggers(0, 0)).toEqual([])
  })

  it('triggerStats 按来源统计窗口内的接收/过滤条数与最后到达时间', () => {
    store.triggers.save(trigger('old', 'feishu', '2026-09-01T00:00:00.000Z'))
    store.triggers.save(trigger('kept', 'feishu', '2026-09-23T00:00:00.000Z'))
    store.triggers.save(trigger('dropped', 'feishu', '2026-09-23T01:00:00.000Z'))
    store.triggers.saveDisposition('dropped', { filtered: { code: 'chat_not_allowed' }, fanout: [], at: '' })
    store.triggers.save(trigger('gh', 'github', '2026-09-22T00:00:00.000Z'))
    const stats = store.read.triggerStats('2026-09-22T12:00:00.000Z')
    expect(stats).toEqual({
      feishu: { received: 2, filtered: 1, lastAt: '2026-09-23T01:00:00.000Z' },
      github: { received: 0, filtered: 0, lastAt: '2026-09-22T00:00:00.000Z' },
    })
    // 空库：没有来源就一个键都没有，不是一条零值记录。
    store.db.exec('DELETE FROM trigger; DELETE FROM disposition')
    expect(store.read.triggerStats('2026-01-01T00:00:00.000Z')).toEqual({})
  })

  it('flow 只数窗口内、未被来源过滤掉的判定，accept/reopen 分别计数', () => {
    store.triggers.save(trigger('a', 'feishu', '2026-09-23T00:00:00.000Z'))
    store.triggers.save(trigger('b', 'feishu', '2026-09-23T01:00:00.000Z'))
    store.triggers.save(trigger('c', 'feishu', '2026-09-23T02:00:00.000Z'))
    // 被来源过滤的触发不会进判定，所以它没有 decision：这一条验的是 judged 的过滤条件本身。
    store.triggers.saveDisposition('c', { filtered: { code: 'chat_not_allowed' }, fanout: [], at: '' })
    store.decisions.save(decision('d1', 'feishu:thread', ['a'], '2026-09-23T00:00:00.000Z', 'accept'))
    store.decisions.save(decision('d2', 'feishu:thread', ['b'], '2026-09-23T01:00:00.000Z', 'reopen'))
    expect(store.read.flow('2026-09-22T00:00:00.000Z')).toEqual({ judged: 2, accepted: 2 })
    expect(store.read.flow('2026-09-23T00:30:00.000Z')).toEqual({ judged: 1, accepted: 1 })
    expect(store.read.flow('2026-09-24T00:00:00.000Z')).toEqual({ judged: 0, accepted: 0 })
  })

  it('triggers 按来源与被过滤筛选，多取一行判 more', () => {
    store.triggers.save(trigger('a', 'feishu', '2026-09-23T00:00:00.000Z'))
    store.triggers.save(trigger('b', 'feishu', '2026-09-23T01:00:00.000Z'))
    store.triggers.save(trigger('c', 'github', '2026-09-23T02:00:00.000Z'))
    store.triggers.saveDisposition('b', { filtered: { code: 'chat_not_allowed' }, fanout: [], at: '' })
    expect(store.read.triggers({}).items.map(item => item.id)).toEqual(['c', 'b', 'a'])
    expect(store.read.triggers({}).more).toBe(false)
    const page = store.read.triggers({ source: 'feishu' }, 0, 1)
    expect(page.items.map(item => item.id)).toEqual(['b'])
    expect(page.more).toBe(true)
    expect(store.read.triggers({ filtered: true }).items.map(item => item.id)).toEqual(['b'])
    // 来源过滤与「取 limit+1」同时生效：第二页不能再出现第一页的行。
    expect(store.read.triggers({ source: 'feishu' }, 1, 1).items.map(item => item.id)).toEqual(['a'])
  })

  it('threadTriggers 取最近 limit 条后翻成旧到新，before/through 控制边界', () => {
    for (const n of [1, 2, 3, 4]) store.triggers.save(trigger(`t${n}`, 'github', `2026-09-23T00:00:0${n}.000Z`))
    expect(store.read.threadTriggers('github:thread').map(item => item.id)).toEqual(['t1', 't2', 't3', 't4'])
    expect(store.read.threadTriggers('github:thread', 2).map(item => item.id)).toEqual(['t3', 't4'])
    // 不含 before 那一行。
    expect(store.read.threadTriggers('github:thread', 50, { at: '2026-09-23T00:00:03.000Z', id: 't3' }).map(item => item.id)).toEqual(['t1', 't2'])
    // through=true 时含它。
    expect(store.read.threadTriggers('github:thread', 50, { at: '2026-09-23T00:00:03.000Z', id: 't3' }, true).map(item => item.id)).toEqual(['t1', 't2', 't3'])
    expect(store.read.threadTriggers('github:other')).toEqual([])
  })

  it('threadPage 按时间倒序分页', () => {
    for (const n of [1, 2, 3]) store.triggers.save(trigger(`t${n}`, 'github', `2026-09-23T00:00:0${n}.000Z`))
    expect(store.read.threadPage('github:thread', 0, 2).map(item => item.id)).toEqual(['t3', 't2'])
    expect(store.read.threadPage('github:thread', 2, 2).map(item => item.id)).toEqual(['t1'])
  })

  it('neighbours 取前后最近的非 CI 触发，边界外没有就缺键', () => {
    store.triggers.save(trigger('before', 'github', '2026-09-23T00:00:01.000Z'))
    store.triggers.save(trigger('ci', 'github', '2026-09-23T00:00:02.000Z', { human: false, meta: { ci: true } }))
    store.triggers.save(trigger('after', 'github', '2026-09-23T00:00:04.000Z'))
    const middle = store.read.neighbours('github:thread', '2026-09-23T00:00:03.000Z', 'x')
    expect(middle.before?.id).toBe('before')
    expect(middle.after?.id).toBe('after')
    expect(store.read.neighbours('github:thread', '2026-09-23T00:00:00.000Z', 'x')).toEqual({ after: expect.objectContaining({ id: 'before' }) })
    expect(store.read.neighbours('github:thread', '2026-09-23T00:00:09.000Z', 'x')).toEqual({ before: expect.objectContaining({ id: 'after' }) })
    expect(store.read.neighbours('github:none', '2026-09-23T00:00:03.000Z', 'x')).toEqual({})
  })

  it('firstTrigger 取线程上最早一条，humanOnly 只看人类触发', () => {
    const base = { threads: [{ source: 'github', id: 'thread' }], actor: { source: 'github', id: 'x' } }
    store.triggers.save(trigger('ci', 'github', '2026-09-23T00:00:01.000Z', { ...base, human: false, meta: { ci: true } } as Partial<Trigger>))
    store.triggers.save(trigger('person', 'github', '2026-09-23T00:00:02.000Z', base as Partial<Trigger>))
    expect(store.read.firstTrigger('github:thread')?.id).toBe('ci')
    expect(store.read.firstTrigger('github:thread', true)?.id).toBe('person')
    expect(store.read.firstTrigger('github:none')).toBeUndefined()
  })

  it('search 按 id / url 前缀 / messageId / 正文字面匹配，% 与 _ 不当通配符', () => {
    store.db.exec('DELETE FROM trigger')
    store.triggers.save(trigger('exact', 'feishu', '2026-09-23T00:00:01.000Z', { text: 'plain' }))
    store.triggers.save(trigger('url', 'feishu', '2026-09-23T00:00:02.000Z', { text: 'see link', url: 'https://github.com/acme/widgets/pull/7', meta: {} }))
    store.triggers.save(trigger('mid', 'feishu', '2026-09-23T00:00:03.000Z', { text: 'm', meta: { messageId: 'om_42' } }))
    store.triggers.save(trigger('pct', 'feishu', '2026-09-23T00:00:04.000Z', { text: 'grew 50% today' }))
    store.triggers.save(trigger('under', 'feishu', '2026-09-23T00:00:05.000Z', { text: 'see a_b' }))
    expect(store.read.search('exact').map(item => item.id)).toEqual(['exact'])
    expect(store.read.search('https://github.com/acme').map(item => item.id)).toEqual(['url'])
    expect(store.read.search('om_42').map(item => item.id)).toEqual(['mid'])
    expect(store.read.search('50%').map(item => item.id)).toEqual(['pct'])
    expect(store.read.search('a_b').map(item => item.id)).toEqual(['under'])
    // 字面量 '%' 不能当通配符：搜 '50%' 不该把 'grew 500' 也捞出来。
    store.triggers.save(trigger('five', 'feishu', '2026-09-23T00:00:06.000Z', { text: 'grew 500 today' }))
    expect(store.read.search('50%').map(item => item.id)).toEqual(['pct'])
    expect(store.read.search('nothing-matches')).toEqual([])
  })

  it('recentDecisions / decisions / decisionsOfKinds 三种读口', () => {
    store.triggers.save(trigger('a', 'github', '2026-09-23T00:00:00.000Z'))
    store.triggers.save(trigger('b', 'github', '2026-09-23T01:00:00.000Z'))
    store.decisions.save(decision('d1', 'github:thread', ['a'], '2026-09-23T00:00:00.000Z', 'ignore'))
    store.decisions.save(decision('d2', 'github:thread', ['b'], '2026-09-23T01:00:00.000Z', 'accept'))
    store.decisions.save(decision('d3', 'github:thread', ['a'], '2026-09-23T02:00:00.000Z', 'stop'))
    expect(store.read.recentDecisions().map(item => item.id)).toEqual(['d3', 'd2', 'd1'])
    expect(store.read.recentDecisions(1, 1).map(item => item.id)).toEqual(['d2'])
    const all = store.read.decisions({ kinds: [], since: '' }, 0, 50)
    expect(all.items.map(item => item.id)).toEqual(['d3', 'd2', 'd1'])
    expect(all.more).toBe(false)
    // kinds 过滤 + since 按关联触发的到达时间算：d3 关联的 a 在窗口外，只剩 d2。
    const accepted = store.read.decisions({ kinds: ['accept', 'stop'], since: '2026-09-23T00:30:00.000Z' }, 0, 1)
    expect(accepted.items.map(item => item.id)).toEqual(['d2'])
    expect(accepted.more).toBe(false)
    // 窗口放到最早：d2 与 d3 都在，limit=1 才 more。
    const both = store.read.decisions({ kinds: ['accept', 'stop'], since: '2026-09-22T00:00:00.000Z' }, 0, 1)
    expect(both.items.map(item => item.id)).toEqual(['d3'])
    expect(both.more).toBe(true)
    expect(store.read.decisionsOfKinds(['accept', 'reopen']).map(item => item.id)).toEqual(['d2'])
    expect(store.read.decisionsOfKinds(['accept'], 0)).toEqual([])
  })

  it('failingReplies 只取 reply 效果失败过的收据，带连续失败次数与最后错误', () => {
    const message = (id: string) => ({ id, channel: { source: 'feishu', thread: 'oc_1:om_1', address: { chat: 'oc_1' } }, text: `text ${id}`, kind: 'reply' as const, ticketId: 'ticket-1' })
    expect(store.receipts.add(message('m1'))).toBe(true)
    expect(store.receipts.add(message('m2'))).toBe(true)
    const effect = store.db.prepare('INSERT INTO effect (kind, key, value, seq, attempts, error, due, since) VALUES (?,?,?,?,?,?,?,?)')
    effect.run('reply', 'm1', '{}', 2, 3, 'timeout', '9999', '')
    effect.run('reply', 'm2', '{}', 1, 0, '', '9999', '')
    effect.run('acknowledgement', 'm2', '{}', 0, 2, 'nope', '9999', '')
    const failing = store.read.failingReplies()
    expect(failing.map(item => [item.id, item.attempts, item.error])).toEqual([['m1', 3, 'timeout']])
    expect(failing[0]?.status).toBe('pending')
    expect(failing[0]?.ticketId).toBe('ticket-1')
  })

  it('droppedReplies / droppedSince 按丢弃时间倒序与时间窗计数', () => {
    const message = (id: string) => ({ id, channel: { source: 'feishu', thread: 'oc_1:om_1', address: { chat: 'oc_1' } }, text: id, kind: 'reply' as const })
    store.receipts.add(message('kept'))
    store.receipts.add(message('gone'))
    store.receipts.settle(message('gone'), 'channelGone')
    store.receipts.add(message('ignored'))
    store.receipts.settle(message('ignored'), 'channelIgnored')
    const dropped = store.read.droppedReplies()
    expect(dropped.map(item => item.id).sort()).toEqual(['gone', 'ignored'])
    expect(dropped.every(item => item.dropped.reason === 'channelGone' || item.dropped.reason === 'channelIgnored')).toBe(true)
    expect(store.read.droppedReplies(1).length).toBe(1)
    expect(store.read.droppedSince('2000-01-01T00:00:00.000Z')).toBe(2)
    expect(store.read.droppedSince('2999-01-01T00:00:00.000Z')).toBe(0)
  })

  it('subscribedThreads 只列有订阅的线程，可按来源过滤', () => {
    store.threads.save(thread('github', '1', { subscriptions: ['ticket-1'] }))
    store.threads.save(thread('github', '2'))
    store.threads.save(thread('feishu', 'oc:om', { subscriptions: ['ticket-2'] }))
    expect(store.read.subscribedThreads().map(item => item.key)).toEqual(['github:1', 'feishu:oc:om'])
    expect(store.read.subscribedThreads('github').map(item => item.key)).toEqual(['github:1'])
    expect(store.read.subscribedThreads('slack')).toEqual([])
  })
})
