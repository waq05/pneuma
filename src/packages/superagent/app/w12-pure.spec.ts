/**
 * 覆盖补齐（W12）：app 层轻依赖模块。
 *
 * 范围：views/text、cache、versions、passes、retry-health、role-models、context、skill-files。
 * 夹具：纯函数直接调用；`Versions` 用内存 KV 假件；`Passes` / `RetryHealth` / `role-models` 用手写宿主假件。
 * 所有断言都钉「投影/判定给出的值」，不钉函数不崩。
 *
 * @module @pneuma/superagent/app
 */
import { describe, expect, test, vi } from 'vitest'
import type { BridgeEvent } from '../../../core/dsh-compat/session-bridge.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@pneuma/runtime/core/session.js'
import type { Health } from '../sources/host.js'
import type { Store } from './store.js'
import type { Family, Key } from '../kv.js'
import { TextCache } from './cache.js'
import { attribute, markdown, plain, preview, readable } from './views/text.js'
import { Versions } from './versions.js'
import { Passes, type PassesHost } from './passes.js'
import { RetryHealth, type RetryHealthEvent } from './retry-health.js'
import { initializeRoleModel, resolveRoleModel } from './role-models.js'
import { promptFile } from './skill-files.js'
import { autoMergeThreshold, guides, handoffPolicy, sourceSkills, teamDefaults, transcriptEntry } from './context.js'

// ── views/text ───────────────────────────────────────────────────────────────

describe('views/text：把来源正文清成界面能直接显示的样子', () => {
  test('plain 去 HTML（含实体编码的标签）、去注释、解码实体、图片与链接降级成文本', () => {
    const text = '<div>Hello <b>there</b></div> &lt;script&gt;alert(1)&lt;/script&gt; <!-- note --> ![shot](https://x/y.png) [Image: diagram]'
    expect(plain(text)).toBe('Hello there alert(1) [image] [image]')
    expect(plain('[the docs](https://example.com) and `code` &amp; more')).toBe('the docs and code & more')
  })

  test('plain(lines=true) 保留列表符号、压掉行内多空格与 3 个以上空行', () => {
    const text = '# Title\n\n- one\n* two\n\n\n\nend'
    // 列表正则的 `^\s*` 会跨行吃掉标题与列表之间的空行，真实输出没有这一行空行。
    expect(plain(text, true)).toBe('Title\n• one\n• two\n\nend')
    expect(plain(text, false)).toBe('Title one two end')
  })

  test('markdown 保留换行与星号，只去 HTML 和图片', () => {
    expect(markdown('**Fix** <div>x</div>\n\n- one ![i](u)')).toBe('**Fix** x\n\n- one [image]')
  })

  test('readable 把 JSON 展成键值行，带 label 前缀；不是 JSON 就原样返回', () => {
    expect(readable('note: {"a":1,"b":[1,2]}')).toBe('note\na: 1\nb: 1, 2')
    // 全由标量组成的数组内联成一行；数组里还有对象时逐项列。
    expect(readable('[1,2,3]')).toBe('1, 2, 3')
    expect(readable('[{"a":1},{"b":2}]')).toBe('- 1\n- 2')
    expect(readable('{"outer":{"inner":"x"},"list":[{"k":"v"}]}')).toBe('outer:\ninner: x\nlist:\n- v')
    expect(readable('{"a":null,"b":true}')).toBe('a: \nb: true')
    expect(readable('{not json')).toBe('{not json')
    expect(readable('plain text')).toBe('plain text')
  })

  test('preview 先 readable 再 plain，按长度截断', () => {
    expect(preview('{"a":"x"}', 3)).toBe('a: ')
    expect(preview('a  b   c')).toBe('a b c')
  })

  test('attribute 只认非空字符串', () => {
    expect(attribute('x')).toBe('x')
    expect(attribute('')).toBeUndefined()
    expect(attribute(1)).toBeUndefined()
    expect(attribute(undefined)).toBeUndefined()
  })
})

// ── cache ────────────────────────────────────────────────────────────────────

describe('TextCache：按总长度封顶的 LRU', () => {
  test('命中会把条目提到最近使用；超限时淘汰最旧的，最后插入的永远保留', () => {
    const cache = new TextCache(5)
    cache.set('a', '1111')
    cache.set('b', '2')
    expect([...cache.entries()].map(([key]) => key)).toEqual(['a', 'b'])
    // 命中 a 后 a 变成最新，插入 c 时被淘汰的是 b。
    expect(cache.get('a')).toBe('1111')
    expect([...cache.entries()].map(([key]) => key)).toEqual(['b', 'a'])
    cache.set('c', '333')
    // 腾空间要腾够：b 与 a 都被淘汰，只留刚插入的 c。
    expect([...cache.entries()].map(([key]) => key)).toEqual(['c'])
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeUndefined()
  })

  test('覆盖写同一 key 不会重复计长度；单条超过总上限也保留', () => {
    const cache = new TextCache(6)
    cache.set('a', '12345')
    cache.set('b', '67890')
    expect([...cache.entries()].map(([key]) => key)).toEqual(['b'])
    cache.set('b', 'x')
    expect(cache.get('b')).toBe('x')
    const tiny = new TextCache(1)
    tiny.set('only', 'longer than one')
    expect([...tiny.entries()].map(([key]) => key)).toEqual(['only'])
    expect(tiny.get('missing')).toBeUndefined()
  })
})

// ── versions ─────────────────────────────────────────────────────────────────

describe('Versions：编号快照 + 当前指针', () => {
  /** 内存 KV：只实现 Versions 用到的四个方法。 */
  function memoryStore() {
    const kv = new Map<string, unknown>()
    const store = {
      get: (name: string) => kv.get(name),
      set: (name: string, value: unknown) => { kv.set(name, value) },
      keys: (family: string | { prefix: string }) =>
        [...kv.keys()].filter(name => name.startsWith(typeof family === 'string' ? family : (family as { prefix: string }).prefix)),
      atomic: <T>(work: () => T): T => work(),
    } as unknown as Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>
    return { kv, store }
  }
  interface Record { revision: number; text: string }
  const pointer = 'versions-pointer' as Key<number>
  const family = Object.assign((revision: number) => `versions:${revision}`, { prefix: 'versions:' }) as unknown as Family<Record,
    [revision: number]>

  test('首次保存前 revision 为 0、current 为空；保存后指针前进并可回读历史', () => {
    const { store } = memoryStore()
    const versions = new Versions<Record>(store, pointer, family)
    expect(versions.revision()).toBe(0)
    expect(versions.current()).toBeUndefined()
    expect(versions.get(1)).toBeUndefined()

    const first = versions.save(revision => ({ revision, text: 'one' }))
    expect(first).toEqual({ revision: 1, text: 'one' })
    expect(versions.revision()).toBe(1)
    expect(versions.current()).toEqual({ revision: 1, text: 'one' })

    const second = versions.save(revision => ({ revision, text: 'two' }))
    expect(second.revision).toBe(2)
    expect(versions.revision()).toBe(2)
    expect(versions.list().map(item => item.text)).toEqual(['two', 'one'])
    expect(versions.list(1).map(item => item.text)).toEqual(['two'])
  })

  test('keep 只存快照不推进指针', () => {
    const { store } = memoryStore()
    const versions = new Versions<Record>(store, pointer, family)
    versions.keep({ revision: 0, text: 'builtin' })
    expect(versions.revision()).toBe(0)
    expect(versions.current()).toBeUndefined()
    expect(versions.get(0)).toEqual({ revision: 0, text: 'builtin' })
    const saved = versions.save(revision => ({ revision, text: 'next' }))
    expect(saved.revision).toBe(1)
    expect(versions.list().map(item => item.text)).toEqual(['next', 'builtin'])
  })
})

// ── passes ───────────────────────────────────────────────────────────────────

describe('Passes：定时/按需编排轮次', () => {
  /** 轮次宿主假件：记录 kick/evaluateDue 次数，可控 configured/closing。 */
  function host(overrides: Partial<{ configured: boolean; closing: boolean; aborted: boolean }> = {}) {
    const state = { configured: overrides.configured ?? true, closing: overrides.closing ?? false }
    const controller = new AbortController()
    if (overrides.aborted) controller.abort()
    const entry: { value?: Health } = {}
    let kicks = 0, evaluates = 0
    const effects = {
      kick: () => { kicks += 1; if (kickHook) kickHook() },
      idle: async () => { awaitsIdle += 1 },
    }
    let kickHook: (() => void) | undefined
    let awaitsIdle = 0
    const engine = {
      receive: (trigger: unknown) => receiveResult,
      evaluateDue: () => { evaluates += 1 },
    }
    let receiveResult: 'stored' | 'filtered' = 'stored'
    const health = {
      get: () => entry.value,
      set: (value: Health) => { entry.value = value },
      release: () => {},
    }
    const passesHost: PassesHost = {
      engine: engine as unknown as PassesHost['engine'],
      effects: effects as unknown as PassesHost['effects'],
      health,
      lifetime: controller.signal,
      configured: () => state.configured,
      closing: () => state.closing,
    }
    return {
      passesHost, state, controller, entry,
      effects, engine, health,
      counts: () => ({ kicks, evaluates, idles: awaitsIdle }),
      setReceive: (value: 'stored' | 'filtered') => { receiveResult = value },
      onKick: (hook: () => void) => { kickHook = hook },
      reset: () => { kicks = 0; evaluates = 0; awaitsIdle = 0 },
    }
  }

  test('receive 在停止中抛错；返回 stored 时立刻排一轮，其它结果不排', () => {
    const harness = host()
    const passes = new Passes(harness.passesHost)
    expect(passes.receive({} as never)).toBe('stored')
    expect(harness.counts().kicks).toBe(1)

    harness.reset()
    harness.setReceive('filtered')
    expect(passes.receive({} as never)).toBe('filtered')
    expect(harness.counts().kicks).toBe(0)

    harness.state.closing = true
    expect(() => passes.receive({} as never)).toThrow('Orchestrator is stopping')
  })

  test('pump 在未配置或停止时什么都不做', async () => {
    const harness = host({ configured: false })
    const passes = new Passes(harness.passesHost)
    await passes.pump()
    expect(harness.counts().kicks).toBe(0)

    const closing = host({ closing: true })
    await new Passes(closing.passesHost).pump()
    expect(closing.counts().kicks).toBe(0)
  })

  test('一轮先推 Effects 再推进 Engine；kick 之后若开始停止就不再评估', async () => {
    const harness = host()
    const passes = new Passes(harness.passesHost)
    await passes.pump()
    expect(harness.counts()).toMatchObject({ kicks: 1, evaluates: 1 })

    harness.reset()
    harness.onKick(() => { harness.state.closing = true })
    await new Passes(harness.passesHost).pump()
    expect(harness.counts()).toMatchObject({ kicks: 1, evaluates: 0 })
  })

  test('一轮成功后清掉上一轮的错误；停止后失败不改体检项', async () => {
    const harness = host()
    harness.entry.value = { state: 'error', detail: 'old' }
    const passes = new Passes(harness.passesHost)
    passes.request()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.entry.value).toEqual({ state: 'ready', detail: 'Orchestrator is ready', at: expect.any(String) })

    const abortHarness = host({ aborted: true })
    abortHarness.entry.value = { state: 'error', detail: 'keep me' }
    new Passes(abortHarness.passesHost).request()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(abortHarness.entry.value).toEqual({ state: 'error', detail: 'keep me' })
  })

  test('一轮抛错写进体检项；并发调用合并成后续一轮', async () => {
    const failing = host()
    failing.effects.kick = () => { throw new Error('boom') }
    new Passes(failing.passesHost).request()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(failing.entry.value).toMatchObject({ state: 'error' })
    expect(String(failing.entry.value?.detail)).toContain('A pass failed: Error: boom')

    const merged = host()
    const passes = new Passes(merged.passesHost)
    await Promise.all([passes.pump(), passes.pump()])
    expect(merged.counts().kicks).toBe(2)
    expect(merged.counts().evaluates).toBe(2)
  })

  test('idle 等到 Effects 也空；stop 后定时器不再排轮次', async () => {
    vi.useFakeTimers()
    try {
      const harness = host()
      const passes = new Passes(harness.passesHost)
      passes.start()
      await vi.advanceTimersByTimeAsync(2000)
      expect(harness.counts().kicks).toBe(1)
      await passes.idle()
      expect(harness.counts().idles).toBeGreaterThan(0)
      await passes.stop()
      await vi.advanceTimersByTimeAsync(6000)
      expect(harness.counts().kicks).toBe(1)
      // stopped 之后再 start 不装定时器。
      passes.start()
      await vi.advanceTimersByTimeAsync(2000)
      expect(harness.counts().kicks).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── retry-health ─────────────────────────────────────────────────────────────

describe('RetryHealth：从会话事件流里认出模型预算重试', () => {
  const at = Date.UTC(2026, 0, 1, 0, 0, 0)
  const event = (type: string, seq: number, data: unknown, time = at): RetryHealthEvent => ({ type, seq, time, data })
  const retry = (seq: number, data: Record<string, unknown> = {}, time = at) => event('llm/retry', seq, {
    turn: 1, step: 0, retryId: 'r1', provider: 'deepseek', retry: 1, failure: { type: 'budget_exceeded' }, ...data,
  }, time)

  test('预算失败的三种写法都认：结构化 type、JSON 正文、纯文本', () => {
    const health = new RetryHealth()
    health.observe('s1', event('turn/start', 1, { turn: 1 }))
    health.observe('s1', retry(2, { failure: { type: 'budget_exceeded' } }))
    expect(health.get('s1')).toMatchObject({ provider: 'deepseek', attempts: 1 })
    expect(health.list()).toHaveLength(1)

    const json = new RetryHealth()
    json.observe('s2', event('turn/start', 1, { turn: 1 }))
    json.observe('s2', retry(2, { failure: { message: 'oops {"error":{"code":"budget_exceeded"}}' } }))
    expect(json.get('s2')).toMatchObject({ sessionId: 's2', attempts: 1 })

    const text = new RetryHealth()
    text.observe('s3', event('turn/start', 1, { turn: 1 }))
    text.observe('s3', retry(2, { failure: { message: 'Budget has been exceeded.' } }))
    expect(text.get('s3')).toMatchObject({ attempts: 1 })

    const nested = new RetryHealth()
    nested.observe('s4', event('turn/start', 1, { turn: 1 }))
    nested.observe('s4', retry(2, { failure: { message: 'Error: {"error":{"type":"budget_exceeded"}}' } }))
    expect(nested.get('s4')?.attempts).toBe(1)
  })

  test('认证、限流、上下文类失败不算预算重试；attempts 只增不减，since 保留首次时间', () => {
    const health = new RetryHealth()
    health.observe('s', event('turn/start', 1, { turn: 1 }))
    health.observe('s', retry(2, { failure: { status: 429 } }))
    expect(health.get('s')).toBeUndefined()
    health.observe('s', retry(3, { retry: 2 }))
    expect(health.get('s')).toMatchObject({ attempts: 2, provider: 'deepseek' })
    const first = health.get('s')!
    health.observe('s', retry(4, { retry: 2 }, at + 1000))
    expect(health.get('s')).toEqual(first)
    health.observe('s', retry(5, { retry: 3 }, at + 2000))
    expect(health.get('s')).toMatchObject({ attempts: 3, since: first.since, lastAt: new Date(at + 2000).toISOString() })
  })

  test('模型消息正常回来即视为恢复；回合结束清空状态', () => {
    const health = new RetryHealth()
    health.observe('s', event('turn/start', 1, { turn: 1 }))
    health.observe('s', retry(2))
    health.observe('s', event('assistant/message', 3, { turn: 1, step: 0, message: { source: { kind: 'model', provider: 'deepseek' } } }))
    expect(health.get('s')).toBeUndefined()

    // 恢复过（settled）之后，同一回合里的后续重试不再被当成活动状态；新回合才重新开始记。
    health.observe('s', retry(4, { retryId: 'r2', retry: 1 }))
    expect(health.get('s')).toBeUndefined()
    health.observe('s', event('turn/start', 5, { turn: 2 }))
    health.observe('s', retry(6, { turn: 2, retryId: 'r2', retry: 1 }))
    expect(health.get('s')).toBeDefined()
    health.observe('s', event('turn/end', 7, { turn: 2 }))
    expect(health.get('s')).toBeUndefined()
    expect(health.list()).toEqual([])
  })

  test('乱序/非法事件被忽略：seq 回退、时间不可用、未知类型、step 回退', () => {
    const health = new RetryHealth()
    const observe = (value: RetryHealthEvent) => health.observe('s', value)
    observe(event('turn/start', 1, { turn: 1 }))
    observe(event('turn/start', 0, { turn: 1 }))
    observe({ type: 'turn/start', seq: 1.5, time: at, data: { turn: 1 } })
    observe({ type: 'turn/start', seq: 2, time: Number.NaN, data: { turn: 1 } })
    observe(event('unknown', 3, { turn: 1 }))
    observe(event('turn/start', 4, { turn: 0 }))
    expect(health.get('s')).toBeUndefined()
    observe(retry(5))
    expect(health.get('s')?.attempts).toBe(1)
    // step 回退不覆盖已有状态；llm/retry-started 不清状态。
    observe(event('llm/retry-started', 6, { turn: 1, step: 0 }))
    observe(retry(7, { retry: 5 }))
    expect(health.get('s')?.attempts).toBe(5)
    observe(retry(8, { step: -1 }))
    expect(health.get('s')?.attempts).toBe(5)
  })

  test('非预算失败清掉活动状态；provider 不合规记成 unknown；clear 与 restore', () => {
    const health = new RetryHealth()
    health.observe('s', event('turn/start', 1, { turn: 1 }))
    health.observe('s', retry(2, { failure: { status: 401 } }))
    expect(health.get('s')).toBeUndefined()

    health.observe('s', retry(3, { provider: 'bad provider!', retry: 1 }))
    expect(health.get('s')).toMatchObject({ provider: 'unknown' })
    health.clear('s')
    expect(health.get('s')).toBeUndefined()

    health.restore('s', [event('turn/start', 1, { turn: 1 }), retry(2)])
    expect(health.get('s')).toMatchObject({ attempts: 1 })
    health.restore('s', [])
    expect(health.get('s')).toBeUndefined()
    health.clear('missing')
  })
})

// ── role-models ──────────────────────────────────────────────────────────────

describe('role-models：校验并种入按角色配置的模型', () => {
  const ctx = (calls: unknown[][]) => ({ llm: { routeTo: (...args: unknown[]) => { calls.push(args) } } }) as unknown as Context
  const session = (options: { messages?: unknown[]; model?: unknown } = {}) => {
    const appended: unknown[] = []
    const value = {
      messages: options.messages ?? [],
      state: (name: string) => (name === 'model' ? options.model : undefined),
      appendState: (name: string, state: unknown) => { appended.push([name, state]) },
    }
    return { session: value as unknown as Session, appended }
  }

  test('合法配置组装成路由；思考强度缺省为 default，非法值抛错', () => {
    const calls: unknown[][] = []
    expect(resolveRoleModel(ctx(calls), { provider: 'deepseek', model: 'v4' })).toEqual({ provider: 'deepseek', model: 'v4' })
    expect(calls).toEqual([['deepseek', 'v4', 'default']])
    expect(resolveRoleModel(ctx(calls), { provider: 'deepseek', model: 'v4', reasoningEffort: 'high' })).toEqual({
      provider: 'deepseek', model: 'v4', reasoningEffort: 'high' })
    expect(() => resolveRoleModel(ctx(calls), { provider: 'deepseek', model: 'v4', reasoningEffort: 'turbo' }))
      .toThrow('Unknown reasoning effort "turbo"')
  })

  test('新会话才种模型：已有消息、已有选择、或没配置都跳过', () => {
    const fresh = session()
    initializeRoleModel(fresh.session, { provider: 'deepseek', model: 'v4' })
    expect(fresh.appended).toEqual([['model', { provider: 'deepseek', model: 'v4' }]])

    const withEffort = session()
    initializeRoleModel(withEffort.session, { provider: 'deepseek', model: 'v4', reasoningEffort: 'max' })
    expect(withEffort.appended).toEqual([['model', { provider: 'deepseek', model: 'v4', effort: 'max' }]])

    const spoken = session({ messages: [{}] })
    initializeRoleModel(spoken.session, { provider: 'deepseek', model: 'v4' })
    expect(spoken.appended).toEqual([])

    const chosen = session({ model: {} })
    initializeRoleModel(chosen.session, { provider: 'deepseek', model: 'v4' })
    expect(chosen.appended).toEqual([])

    const none = session()
    initializeRoleModel(none.session, null)
    expect(none.appended).toEqual([])
  })
})

// ── context / skill-files ────────────────────────────────────────────────────

describe('context：提示词段落来自打包文件，转录投影只留消息本体', () => {
  test('内置段落都是非空文本，handoff 两角色拼的是共享段 + 各自段', () => {
    for (const value of [guides.subscriptions, guides.replies, guides.dispatch, guides.work, teamDefaults.communication,
      teamDefaults.scope, teamDefaults.delivery, sourceSkills.feishu, sourceSkills.github]) {
      expect(typeof value).toBe('string')
      expect(value.trim().length).toBeGreaterThan(0)
    }
    expect(handoffPolicy('worker')).toBe(`${handoffPolicy('orchestrator').split('\n')[0]}\n${handoffPolicy('worker').split('\n')[1]}`)
    expect(autoMergeThreshold(20)).toBe('it changes fewer than 20 lines (additions plus deletions);')
    expect(promptFile('shared')).not.toContain('\r')
  })

  test('transcriptEntry 保留三种消息事件、剔掉 reasoning 块，其它事件返回 undefined', () => {
    const blocks = [{ type: 'text', text: 'hi' }, { type: 'reasoning', text: 'secret' }]
    const user = { type: 'user/message', data: { role: 'user', content: blocks } } as unknown as BridgeEvent
    expect(transcriptEntry(user)).toEqual({ type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })

    const assistant = { type: 'assistant/message', data: { message: { role: 'assistant', content: blocks } } } as unknown as BridgeEvent
    expect(transcriptEntry(assistant)).toEqual({ type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })

    const tool = { type: 'tool/result', data: { message: { role: 'tool', content: blocks } } } as unknown as BridgeEvent
    expect(transcriptEntry(tool)).toEqual({ type: 'tool/result', message: { role: 'tool', content: [{ type: 'text', text: 'hi' }] } })

    expect(transcriptEntry({ type: 'step/start', data: {} } as unknown as BridgeEvent)).toBeUndefined()
  })
})
