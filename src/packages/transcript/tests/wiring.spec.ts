/**
 * transcript 插件的装配面测试：事件驱动（后台状态、压缩、上下文用量、通知、计划、会话打开）、
 * 快照组装（turnState、跨会话状态、队友子代理卡、费用估算）、收件箱拆面与服务方法。
 *
 * 假 ctx + 最小会话替身；`DSC_HOME` 指到临时目录（会话打开会读用量日志，不能读真实的）。
 *
 * @module @pneuma/transcript/tests/wiring
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

const home = createTempDir('dsc-transcript-wiring-')

interface TranscriptServiceLike {
  emit(event: Record<string, unknown>, owner?: string): void
  system(text: string, level?: string, command?: boolean, owner?: string): void
  plan(view: Record<string, unknown>, owner?: string): void
  replayHistory(...args: unknown[]): boolean
  subscribe(listener: () => void): () => void
  touch(): void
  seedContextUsage(used: number): void
  seedCostBuckets(buckets: ReadonlyMap<string, unknown>): void
  getSnapshot(): {
    entries: Array<Record<string, unknown>>
    status: Record<string, unknown>
    sessionStates: Record<string, string>
    subagents: Array<{ sessionPath: string; state: string }>
    queued?: Array<Record<string, unknown>>
    notices?: Array<Record<string, unknown>>
  }
}

let transcriptPlugin: typeof import('../index.js')['transcriptPlugin']

beforeAll(async () => {
  process.env['DSC_HOME'] = home
  ;({ transcriptPlugin } = await import('../index.js'))
})

/** 一次装配的夹具。 */
function mount(options: { pendingApproval?: unknown; provider?: string; team?: unknown[] } = {}) {
  const session = {
    messages: [] as Array<Record<string, unknown>>,
    toolErrors: new Map<string, string>(),
    fileChanges: new Map<string, unknown>(),
    presentations: new Map<string, unknown>(),
    notices: () => [] as unknown[],
    marks: () => [] as unknown[],
    asyncInbox: () => [
      { origin: 'notice', text: '机器通知' },
      { origin: 'user', text: '排队一', images: ['a.png'], files: [{ path: '/tmp/f' }] },
      { origin: 'user', text: '排队二' },
    ],
    meta: { id: 'sess-1', cwd: '/tmp/work' },
    filePath: '/tmp/sess-1.jsonl',
  }
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const provided = new Map<string, unknown>()
  const ctx = {
    on: (name: string, handler: (...args: unknown[]) => void) => {
      handlers.set(name, handler)
    },
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
    },
    get: (name: string) => (name === 'team' ? (options.team === undefined ? undefined : { list: () => options.team }) : undefined),
    session: { current: () => session, sessions: [], loading: false },
    llm: { provider: options.provider ?? 'test', model: 'test-model', effort: 'medium', contextWindow: 128_000 },
    surfaces: { build: () => ({ pendingApproval: options.pendingApproval ?? null }) },
  }
  transcriptPlugin.apply(ctx as unknown as Context, {})
  const service = provided.get('transcript') as TranscriptServiceLike
  return { session, handlers, service }
}

describe('事件驱动：后台状态、压缩、上下文用量与会话归属过滤', () => {
  test('后台 agent 状态：working 记下、idle 变「已完成未读」，当前会话的不进后台表', () => {
    const { handlers, service } = mount()
    const status = handlers.get('dsc/agent-status')!
    status({ path: '/tmp/other.jsonl', state: 'working' } as never)
    let snapshot = service.getSnapshot()
    expect(snapshot.sessionStates['/tmp/other.jsonl']).toBe('working')

    status({ path: '/tmp/other.jsonl', state: 'idle' } as never)
    snapshot = service.getSnapshot()
    expect(snapshot.sessionStates['/tmp/other.jsonl']).toBe('just-finished')

    // 当前查看的会话收工：不留在后台状态表（它的状态由 turnState 推导）。
    status({ path: '/tmp/sess-1.jsonl', state: 'working' } as never)
    status({ path: '/tmp/sess-1.jsonl', state: 'idle' } as never)
    snapshot = service.getSnapshot()
    expect(snapshot.sessionStates['/tmp/sess-1.jsonl']).toBeUndefined()

    // 没有历史的路径收到 idle：只是删一条不存在的记录，不产生 just-finished。
    status({ path: '/tmp/never.jsonl', state: 'idle' } as never)
    expect(service.getSnapshot().sessionStates['/tmp/never.jsonl']).toBeUndefined()
  })

  test('压缩状态：开始写开始时刻，结束清掉；别的会话的读数不串台', () => {
    const { handlers, service } = mount()
    handlers.get('dsc/compacting')!(true, '/tmp/sess-1.jsonl' as never)
    expect(typeof service.getSnapshot().status['compactingSince']).toBe('number')

    // 其它会话的用量读数：不覆盖当前会话。
    const before = service.getSnapshot().status['contextUsed']
    handlers.get('dsc/context-used')!(999, '/tmp/other.jsonl' as never)
    expect(service.getSnapshot().status['contextUsed']).toBe(before)
    handlers.get('dsc/context-used')!(1234, '/tmp/sess-1.jsonl' as never)
    expect(service.getSnapshot().status['contextUsed']).toBe(1234)

    handlers.get('dsc/compacting')!(false, '/tmp/sess-1.jsonl' as never)
    expect(service.getSnapshot().status['compactingSince']).toBeUndefined()
  })

  test('通知与计划：别的会话的丢弃，当前会话的进转录；compaction 类别打压缩标记', () => {
    const { handlers, service } = mount()
    handlers.get('dsc/notice')!('别的会话', undefined, '/tmp/other.jsonl' as never)
    handlers.get('dsc/notice')!('当前会话', 'compaction', '/tmp/sess-1.jsonl' as never)
    const systems = service.getSnapshot().entries.filter((entry) => entry['kind'] === 'system')
    expect(systems.some((entry) => String(entry['text']).includes('当前会话'))).toBe(true)
    expect(systems.some((entry) => String(entry['text']).includes('别的会话'))).toBe(false)
    expect(systems.some((entry) => String(entry['text']).includes('当前会话') && entry['compaction'] !== undefined)).toBe(true)

    const plan = { file: '/tmp/work/.dsc/plans/p.md', title: '计划标题', text: '# 标题', decision: 'pending' }
    handlers.get('dsc/plan')!(plan, '/tmp/other.jsonl' as never)
    expect(service.getSnapshot().entries.some((entry) => entry['kind'] === 'plan')).toBe(false)
    handlers.get('dsc/plan')!(plan, '/tmp/sess-1.jsonl' as never)
    expect(service.getSnapshot().entries.some((entry) => entry['kind'] === 'plan')).toBe(true)
  })
})

describe('会话打开：新会话写提示行、队友卡按名册种回、用量与费用回填', () => {
  test('新会话（没有 filePath）：写一条「新会话 xxx（模型 …）」的 system 行', () => {
    const { handlers, service } = mount()
    handlers.get('dsc/session-open')!({} as never)
    const text = service
      .getSnapshot()
      .entries.filter((entry) => entry['kind'] === 'system')
      .map((entry) => String(entry['text']))
      .join('\n')
    expect(text).toContain('新会话 sess-1')
    expect(text).toContain('test/test-model')
  })

  test('名册里在干活的队友种成子代理卡（只种当前会话的）', () => {
    const mate = {
      name: '队友甲',
      role: 'reviewer',
      task: '看代码',
      state: 'working',
      sessionId: 'sess-1',
      mode: 'continuable',
      rounds: 2,
      startedAt: 1,
      file: '/tmp/mate.jsonl',
    }
    const otherMate = { ...mate, name: '队友乙', sessionId: 'other-sess', file: '/tmp/other-mate.jsonl' }
    const { handlers, service } = mount({ team: [mate, otherMate, { ...mate, name: '闲的', state: 'idle' }] })
    handlers.get('dsc/session-open')!({} as never)
    const entries = service.getSnapshot().entries.filter((entry) => entry['kind'] === 'subagent')
    expect(entries).toHaveLength(1)
    expect((entries[0]?.['sub'] as Record<string, unknown>)['name']).toBe('队友甲')
  })

  test('恢复已有会话：从用量日志回填上下文占用与费用桶，并按名册把状态点画到快照里', () => {
    // 造两份用量日志：一份有当前会话的用量（含缓存明细与模型名），一份是别的会话。
    const usageDir = join(home, 'usage')
    mkdirSync(usageDir, { recursive: true })
    writeFileSync(
      join(usageDir, 'usage.jsonl'),
      [
        JSON.stringify({ t: Date.now(), i: 1200, o: 100, sid: 'sess-1', model: 'deepseek-v4-flash', ch: 300, cm: 900 }),
        JSON.stringify({ t: Date.now(), i: 5, o: 5, sid: 'other-sess', model: 'deepseek-v4-flash' }),
      ].join('\n'),
      'utf8',
    )
    const mate = {
      name: '队友甲',
      role: 'reviewer',
      task: '看代码',
      state: 'working',
      sessionId: 'sess-1',
      mode: 'continuable',
      rounds: 1,
      startedAt: 1,
      file: '/tmp/mate.jsonl',
    }
    const { session, handlers, service } = mount({ team: [mate], provider: 'deepseek' })
    session.messages.push({ role: 'user', content: '你好', ts: 1 })
    handlers.get('dsc/session-open')!({ filePath: '/tmp/sess-1.jsonl' } as never)

    const snapshot = service.getSnapshot()
    expect(snapshot.status['contextUsed']).toBe(1200)
    expect(snapshot.status['cost']).toBeDefined()
    // 队友的路径在跨会话状态表与 subagents 清单里；当前会话派出的那条进 subagents。
    expect(snapshot.sessionStates['/tmp/mate.jsonl']).toBe('working')
    expect(snapshot.subagents).toStrictEqual([{ sessionPath: '/tmp/mate.jsonl', state: 'working' }])
  })
})

describe('服务面：emit / system / plan 的归属过滤、订阅、回填与快照组装', () => {
  test('别名会话的事件与写入被丢掉；当前会话的照常进转录', () => {
    const { service } = mount()
    service.system('别名会话的提示', undefined, undefined, 'other-sess')
    service.emit({ type: 'message', text: '别名会话的消息' } as never, 'other-sess')
    expect(service.getSnapshot().entries).toHaveLength(0)

    service.system('当前会话的提示')
    service.emit({ type: 'message', text: '当前会话的消息' } as never)
    const entries = service.getSnapshot().entries
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(service.getSnapshot().entries.some((entry) => entry['kind'] === 'text')).toBe(true)
  })

  test('plan / replayHistory / subscribe / touch / seed 方法都接在真转录上', () => {
    const { service } = mount()
    service.plan({ file: '/tmp/p.md', title: '标题', text: '# 标题', decision: 'pending' })
    expect(service.getSnapshot().entries.some((entry) => entry['kind'] === 'plan')).toBe(true)

    // replayHistory 返回「有没有变化」；空历史重放不改变条目。
    expect(service.replayHistory([], new Map(), new Map(), new Map(), [], [])).toBe(false)

    let notified = 0
    const off = service.subscribe(() => {
      notified += 1
    })
    service.touch()
    expect(notified).toBe(1)
    off()
    service.touch()
    expect(notified).toBe(1)

    service.seedContextUsage(777)
    expect(service.getSnapshot().status['contextUsed']).toBe(777)
    service.seedCostBuckets(new Map([['deepseek-v4-flash', { peak: { hit: 1, miss: 2, output: 3 }, idle: { hit: 0, miss: 0, output: 0 } }]]))
    expect(service.getSnapshot().status['cost']).toBeUndefined()
  })

  test('快照：审批卡挂着时 turnState 是 awaiting-approval；收件箱拆成队列条与通知条', () => {
    const { service } = mount({ pendingApproval: { id: 'a' } })
    const snapshot = service.getSnapshot()
    expect(snapshot.status['turnState']).toBe('awaiting-approval')
    expect(snapshot.sessionStates['/tmp/sess-1.jsonl']).toBe('awaiting-approval')
    expect(snapshot.queued?.map((item) => item['text'])).toStrictEqual(['排队一', '排队二'])
    expect(snapshot.notices?.map((item) => item['text'])).toStrictEqual(['机器通知'])
    // 队列条的 index 是它在收件箱里的原始位置（拆面不重新发号）。
    expect(snapshot.queued?.map((item) => item['index'])).toStrictEqual([1, 2])
    expect(snapshot.notices?.map((item) => item['index'])).toStrictEqual([0])
    // 图片与文件只在非空时才带上。
    expect(snapshot.queued?.[0]?.['images']).toStrictEqual(['a.png'])
    expect(snapshot.queued?.[1]?.['images']).toBeUndefined()
    // 会话进度：一问一答各一条，turns=1、steps=1。
    expect(snapshot.status['progress']).toStrictEqual({ turns: 0, steps: 0 })
  })

  test('快照缓存：同一份快照引用稳定，事件来了才失效', () => {
    const { handlers, service } = mount()
    const first = service.getSnapshot()
    expect(service.getSnapshot()).toBe(first)
    handlers.get('dsc/changed')!({} as never)
    expect(service.getSnapshot()).not.toBe(first)
  })
})
