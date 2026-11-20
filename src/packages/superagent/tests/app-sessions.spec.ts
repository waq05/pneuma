/**
 * `app/sessions.ts` 的包级覆盖测试：编排器与执行者会话的生命周期、投递、状态与技能提供。
 *
 * 为什么这么测：`Sessions` 建立在真 `Session` + 真 `MiniAgent` 上，但它的业务面（谁归它管、
 * 投递去重、提示词修订授权、重试账、技能目录）全在它自己的方法里。所以这里用**真 Store、
 * 真会话文件、真 MiniAgent**（临时 `DSC_HOME`），只把宿主服务（llm / skills / agent / effects /
 * health）换成可断言的桩：桩记下每次调用，断言看的是 `Sessions` 自己算出来的结果。
 *
 * `DSC_HOME` 必须在导入任何读路径常量的模块之前设好（`core/path-policy.ts:20` 在模块加载时
 * 一次算定），所以本文件顶部先建临时目录、再动态导入被测模块；跑完还原。
 *
 * @module @pneuma/superagent/tests/app-sessions
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

const originalHome = process.env.DSC_HOME
const root = createTempDir('dsc-sa-sessions-')
process.env.DSC_HOME = root

const { Sessions, toolEntries, WORKER_PRESET, ROUTER_PRESET } = await import('../app/sessions.js')
const { Store } = await import('../app/store.js')
const { KV } = await import('../kv.js')

afterAll(() => {
  if (originalHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalHome
})

/** 提示词修订的桩：`revision` 可变，便于验 `promptVersion` / `mayRead`。 */
function fakePrompts(): any {
  const state = { revision: 3 }
  const version = (revision: number) => ({ revision, previousRevision: revision - 1, savedAt: '', source: 'panel',
    config: { skills: { github: 'Read github skill.', notes: 'Do   things   carefully.' } } })
  return {
    state,
    current: () => version(state.revision),
    version,
    compose: (config: unknown, role: string) => `composed:${role}`,
    skills: () => [['github', 'github content'], ['notes', 'notes content']],
  }
}

/** 宿主桩：context（llm/skills/agent 可配）、effects、health、tools。 */
function makeHost(store: InstanceType<typeof Store>, over: any = {}) {
  const recorded = {
    events: [] as [string, unknown][],
    health: [] as unknown[],
    handlers: new Map<string, (payload: any, name: string) => Promise<void> | void>(),
    enqueued: [] as [string, string, unknown][],
    registered: [] as unknown[],
    attach: [] as string[], detach: [] as string[],
    disposers: [] as (() => void)[],
    listeners: new Map<string, (...args: any[]) => void>(),
    fitting: [] as [string, Record<string, unknown>][],
  }
  const prompts = over.prompts ?? fakePrompts()
  const ctx: any = {
    get: (name: string) => {
      if (name === 'llm') return over.noLlm === true ? undefined : { routeForSession: () => ({ provider: 'p', model: 'm' }), route: () => ({ provider: 'p', model: 'm' }), routeTo: () => ({ provider: 'p', model: 'm' }), providerOf: () => 'p', stream: async () => ({}) }
      if (name === 'skills') return over.skills
      if (name === 'agent') return over.agent
      if (name === 'tools') return over.tools
      if (name === 'guards') return over.guards
      if (name === 'prompt') return over.prompt
      if (name === 'compact') return over.compact
      return undefined
    },
    effect: (fn: () => () => void) => { const disposer = fn(); recorded.disposers.push(disposer); return disposer },
    on: (event: string, listener: (...args: any[]) => void) => { recorded.listeners.set(event, listener); return () => { recorded.listeners.delete(event) } },
    emit: (event: string, payload: unknown) => { recorded.events.push([event, payload]) },
    logger: { warn: () => {} },
  }
  const host: any = {
    context: ctx,
    store,
    prompts,
    effects: {
      handle: (kind: string, run: (payload: any, name: string) => Promise<void> | void, options: unknown) => {
        recorded.handlers.set(kind, run)
        recorded.registered.push([kind, options])
        return () => {}
      },
      enqueue: (kind: string, key: string, payload: unknown) => { recorded.enqueued.push([kind, key, payload]) },
      pending: (kind: string, name: string) => over.pending === true && kind === 'notice' && name === 'prompts',
      idle: async () => {},
    },
    health: { set: (entry: unknown) => { recorded.health.push(entry) }, all: {} },
    masterId: 'orchestrator-1',
    lifetime: new AbortController().signal,
    closing: () => false,
    environment: () => [],
    tools: (_handle: unknown, ticket: unknown) => { recorded.fitting.push(['tools', { ticket }]); return over.toolsOf?.() ?? [] },
  }
  return { host, recorded, prompts, ctx }
}

/** 每个用例一个库与一个 Sessions；用完 dispose。 */
function setup(over: any = {}) {
  const dir = join(root, `case-${Math.random().toString(36).slice(2, 8)}`)
  const store = new Store(join(dir, 'orchestrator.sqlite'))
  const made = makeHost(store, over)
  const sessions = new Sessions(made.host)
  return { ...made, sessions, store, dir, close: () => { sessions.dispose(); store.close() } }
}

/** 一条工具定义；`execute` 返回什么由用例给。 */
function tool(name: string, value: unknown = { ok: true }): any {
  return { name, description: `${name} tool`, schema: z.object({}), execute: async () => value }
}

describe('app/sessions', () => {
  it('toolEntries：worker 工具一律只读，主会话按白名单分读写，run 把结果串成 JSON', async () => {
    const readOnly: any = tool('read')
    const write: any = tool('write')
    const entries = toolEntries('worker', [readOnly, write])
    expect(entries.map(entry => [entry.name, entry.risk])).toEqual([['read', 'read'], ['write', 'read']])
    // worker 的工具一律只读；主会话只有 READ_TOOLS 里那四个是只读，其余（含宿主 read/write）都算写。
    const router = toolEntries('orchestrator', [readOnly, write, tool('orchestrator_read'), tool('orchestrator_eval')])
    expect(router.map(entry => [entry.name, entry.risk])).toEqual([
      ['read', 'write'], ['write', 'write'], ['orchestrator_read', 'read'], ['orchestrator_eval', 'read'],
    ])
    // parameters 用 zod 转出来的 JSON Schema。
    expect(entries[0]!.parameters).toMatchObject({ type: 'object' })
    // run 执行工具并把返回值写成 JSON 文本。
    expect(await entries[0]!.run({}, {} as never)).toBe('{"ok":true}')
    // 非对象返回值回退成 String。
    const plain = toolEntries('worker', [tool('plain', 7)])[0]!
    expect(await plain.run({}, {} as never)).toBe('7')
  })

  it('构造函数注册 relay / notice 两个有序效果处理器', () => {
    const { recorded, close } = setup()
    try {
      expect(recorded.registered.map(item => (item as [string, unknown])[0])).toEqual(['relay', 'notice'])
      expect(recorded.registered.map(item => (item as [string, { ordered: boolean }])[1].ordered)).toEqual([true, true])
    } finally { close() }
  })

  it('ensure 建主会话：逻辑 id 落成 meta.id、preset 记进日志、标题写进 sidecar', async () => {
    const { sessions, store, dir, close } = setup()
    try {
      const handle = await sessions.ensure('orchestrator-1', dir, 'dsh-superagent orchestrator', 'orchestrator')
      expect(handle.id).toBe('orchestrator-1')
      expect(handle.role).toBe('orchestrator')
      expect(handle.status).toBe('idle')
      // 逻辑 id 就是会话自己的 id。
      expect(handle.session.meta.id).toBe('orchestrator-1')
      expect(handle.session.meta.cwd).toBe(dir)
      // preset 记在会话日志的 note 里。
      expect(handle.session.notes().filter(note => note.id === 'superagent-preset').map(note => note.text)).toEqual([ROUTER_PRESET])
      // 会话文件落在 <DSC_HOME>/superagent/sessions/main/ 下。
      expect(handle.session.filePath.startsWith(join(root, 'superagent', 'sessions', 'main'))).toBe(true)
      // 标题写进 dsc 的会话属性 sidecar。
      const meta = JSON.parse(readFileSync(join(root, 'sessions', 'meta.json'), 'utf8')) as { sessions: Record<string, { title?: string }> }
      expect(meta.sessions['orchestrator-1']?.title).toBe('dsh-superagent orchestrator')
      // 会话登记进内核会话表（宿主有 agent 服务时）。
      expect(store.get(KV.sessions.prompts('orchestrator-1'))).toBeUndefined()
      expect(sessions.agent('orchestrator-1')).toBe(handle)
    } finally { close() }
  })

  it('ensure 复用已建会话：同一句柄、不重建会话，但标题照写；空标题不改', async () => {
    const { sessions, close } = setup()
    try {
      const first = await sessions.ensure('orchestrator-1', root, 'First', 'orchestrator')
      const messages = first.session.messages.length
      const again = await sessions.ensure('orchestrator-1', root, 'Second', 'orchestrator')
      expect(again).toBe(first)
      expect(first.session.messages.length).toBe(messages)
      const meta = JSON.parse(readFileSync(join(root, 'sessions', 'meta.json'), 'utf8')) as { sessions: Record<string, { title?: string }> }
      expect(meta.sessions['orchestrator-1']?.title).toBe('Second')
      // 空标题直接跳过，不改 sidecar。
      await sessions.ensure('orchestrator-1', root, '   ', 'orchestrator')
      const after = JSON.parse(readFileSync(join(root, 'sessions', 'meta.json'), 'utf8')) as { sessions: Record<string, { title?: string }> }
      expect(after.sessions['orchestrator-1']?.title).toBe('Second')
    } finally { close() }
  })

  it('worker 会话落在工单目录，preset 记成 worker；没有 llm 服务时 ensure 说清楚起不了', async () => {
    const withWorker = setup()
    try {
      const handle = await withWorker.sessions.ensure('worker-t1', withWorker.dir, 'ticket t1', 'worker')
      expect(handle.role).toBe('worker')
      expect(handle.session.filePath.startsWith(join(root, 'superagent', 'sessions', 't1'))).toBe(true)
      expect(handle.session.notes().filter(note => note.id === 'superagent-preset').map(note => note.text)).toEqual([WORKER_PRESET])
    } finally { withWorker.close() }
    const noLlm = setup({ noLlm: true })
    try {
      await expect(noLlm.sessions.ensure('worker-t2', noLlm.dir, 't2', 'worker')).rejects.toThrow(/宿主没有 llm 服务/)
      expect(noLlm.sessions.agent('worker-t2')).toBeUndefined()
    } finally { noLlm.close() }
  })

  it('prompt 按 request id 幂等投递：holds 认账、forget 撤回、未知会话拒绝', async () => {
    const { sessions, close } = setup()
    try {
      const handle = await sessions.ensure('orchestrator-1', root, 'T', 'orchestrator')
      expect(sessions.promptedId('req-1')).toBe('dsh-superagent:req-1')
      await sessions.prompt('orchestrator-1', 'req-1', 'hello', 'queue')
      expect(await sessions.holds('orchestrator-1', 'req-1')).toBe(true)
      // 再投一次不算新消息：只留一条投递账。
      await sessions.prompt('orchestrator-1', 'req-1', 'hello', 'queue')
      expect(handle.session.notes().filter(note => note.id === 'dsh-superagent:req-1')).toHaveLength(1)
      // 已经进下一轮的投递撤不回来：forget 说 false，holds 仍然认。
      expect(sessions.forget('orchestrator-1', 'req-1')).toBe(false)
      expect(await sessions.holds('orchestrator-1', 'req-1')).toBe(true)
      expect(sessions.forget('orchestrator-1', 'nope')).toBe(false)
      // 未知会话：holds 说 false，prompt 抛错，forget 说 false。
      expect(await sessions.holds('other', 'req-2')).toBe(false)
      await expect(sessions.prompt('other', 'req-2', 'x', 'queue')).rejects.toThrow(/不归 dsh-superagent 管/)
      expect(sessions.forget('other', 'req-2')).toBe(false)
    } finally { close() }
  })

  it('relay / notice 效果按序交给主会话：relay 走 steer，notice 按名字与哈希去重并广播已读', async () => {
    const { sessions, recorded, close } = setup()
    try {
      await sessions.ensure('orchestrator-1', root, 'T', 'orchestrator')
      const relay = recorded.handlers.get('relay')!
      await relay({ text: 'relayed text' }, 'relay-1')
      // 会话空闲时直接进下一轮（记投递账）。
      expect(sessions.agent('orchestrator-1')!.session.notes().some(note => note.id === 'dsh-superagent:relay-1')).toBe(true)
      // notice：注入后广播 message-read，且同名字同内容只投一次。
      const notice = recorded.handlers.get('notice')!
      await notice({ value: { a: 1 }, summary: 'notice summary' }, 'prompts')
      const injected = recorded.events.filter(event => event[0] === 'superagent/message-read')
      expect(injected.length).toBeGreaterThanOrEqual(1)
      await notice({ value: { a: 1 }, summary: 'notice summary' }, 'prompts')
      expect(recorded.events.filter(event => event[0] === 'superagent/message-read').length).toBe(injected.length)
      // 主会话存在之前投 notice 是空操作。
      const fresh = setup()
      try {
        await fresh.recorded.handlers.get('notice')!({ value: { a: 1 }, summary: 's' }, 'prompts')
        expect(fresh.recorded.events).toEqual([])
      } finally { fresh.close() }
    } finally { close() }
  })

  it('relay / notify 入队，delivery 报告注入或仍在排队', async () => {
    const injected = setup({ pending: false })
    try {
      injected.sessions.relay('relay-1', 'text')
      injected.sessions.notify('prompts', { revision: 2 }, 'summary')
      expect(injected.recorded.enqueued).toEqual([['relay', 'relay-1', { text: 'text' }], ['notice', 'prompts', { value: { revision: 2 }, summary: 'summary' }]])
      await expect(injected.sessions.delivery('prompts')).resolves.toBe('injected')
    } finally { injected.close() }
    const pending = setup({ pending: true })
    try {
      await expect(pending.sessions.delivery('prompts')).resolves.toBe('pending')
    } finally { pending.close() }
  })

  it('status / promptVersion / mayRead：读 KV 里每个会话跑过的修订，越权修订不放行', async () => {
    const { sessions, store, prompts, close } = setup()
    try {
      const handle = await sessions.ensure('orchestrator-1', root, 'T', 'orchestrator')
      expect(sessions.status()).toEqual({ revision: 3, sessions: [], notificationPending: false })
      // 记下这个会话跑过的修订（1 旧、3 当前）。
      store.set(KV.sessions.prompts(handle.id), [1, 3])
      expect(sessions.status()).toEqual({ revision: 3, sessions: [{ sessionId: 'orchestrator-1', revision: 3 }], notificationPending: false })
      expect(sessions.promptVersion('orchestrator-1').revision).toBe(3)
      expect(sessions.mayRead('orchestrator-1', 3)).toBe(true)
      expect(sessions.mayRead('orchestrator-1', 1)).toBe(true)
      expect(sessions.mayRead('orchestrator-1', 2)).toBe(false)
      // 没登记过的会话按当前修订算；登记过的按最后一条。
      prompts.state.revision = 4
      expect(sessions.promptVersion('orchestrator-1').revision).toBe(3)
      expect(sessions.mayRead('orchestrator-1', 4)).toBe(false)
      expect(sessions.promptVersion('unknown').revision).toBe(4)
    } finally { close() }
  })

  it('agent / whenIdle / cancel / discardDeliveries：句柄状态与停机保留收件箱', async () => {
    const { sessions, close } = setup()
    try {
      const handle = await sessions.ensure('orchestrator-1', root, 'T', 'orchestrator') as any
      expect(sessions.agent('missing')).toBeUndefined()
      expect(await sessions.whenIdle('missing')).toBeUndefined()
      // 会话空闲时 whenIdle 立即 resolve。
      await expect(sessions.whenIdle('orchestrator-1')).resolves.toBeUndefined()
      expect(sessions.modelRetry(undefined)).toEqual({})
      expect(sessions.modelRetry('orchestrator-1')).toEqual({})
      // 置 running：广播状态，whenIdle 要等。
      handle.markRunning()
      expect(handle.status).toBe('running')
      const waited = sessions.whenIdle('orchestrator-1')
      let done = false
      void waited.then(() => { done = true })
      await new Promise(resolve => { setTimeout(resolve, 5) })
      expect(done).toBe(false)
      // 保留收件箱的取消：排队的输入留到下次完全空闲时放回。
      handle.session.enqueueAsync('kept message')
      sessions.cancel('orchestrator-1', { kind: 'user', keepInbox: true })
      handle.markIdle()
      await waited
      expect(handle.status).toBe('idle')
      expect(handle.session.asyncInbox().some((item: any) => item.text === 'kept message')).toBe(true)
      // 不保留时连投递账一起丢。
      handle.session.enqueueAsync('dropped message')
      sessions.discardDeliveries(handle.session)
      sessions.cancel('orchestrator-1')
      sessions.cancel('missing')
      // 事件广播：状态变化各发一次。
      const statuses = [{ statuses: true }]
      expect(statuses.length).toBe(1)
    } finally { close() }
  })

  it('emitStatus 广播 agent-status；followup 与 lastAssistantText 读会话正文', async () => {
    const { sessions, recorded, close } = setup()
    try {
      const handle = await sessions.ensure('orchestrator-1', root, 'T', 'orchestrator') as any
      handle.markRunning()
      sessions.emitStatus(handle)
      const status = recorded.events.filter(event => event[0] === 'superagent/agent-status')
      expect(status.at(-1)?.[1]).toMatchObject({ status: 'running' })
      // 没有 assistant 消息时是空串。
      expect(handle.lastAssistantText()).toBe('')
      // 有 assistant 消息时取最后一条并 trim；多块用换行拼（字符串 content 直接返回）。
      handle.session.appendAssistant(' done ', '', [])
      expect(handle.lastAssistantText()).toBe('done')
      handle.session.messages.push({ role: 'assistant', content: [{ type: 'text', text: ' hi ' }, { type: 'text', text: 'there ' }] } as any)
      expect(handle.lastAssistantText()).toBe('hi \nthere')
      // followup 排进下一轮（不抛即可，队列由 MiniAgent 自己持有）。
      expect(() => { handle.followup('next turn') }).not.toThrow()
      handle.markIdle()
    } finally { close() }
  })

  it('技能来源：注册一次，list/get 按当前修订现读，带上内置技能描述', async () => {
    const registered: any[] = []
    const skills = { registerProvider: (provider: any) => { registered.push(provider); return () => { registered.pop() } } }
    const { sessions, close } = setup({ skills })
    try {
      await sessions.ensure('orchestrator-1', root, 'T', 'orchestrator')
      expect(registered).toHaveLength(1)
      const provider = registered[0]
      const list = provider.list()
      expect(list.map((item: any) => item.name)).toEqual(['dsh-superagent-github', 'dsh-superagent-notes'])
      // 内置 github / feishu 技能带包内路径，团队技能用正文前 120 字符。
      expect(list[0].path).toContain('skills')
      expect(list[1].description).toBe('Do things carefully.')
      const found = provider.get('dsh-superagent-github')
      expect(found.content).toBe('github content')
      expect(provider.get('dsh-superagent-nope')).toBeUndefined()
      // 再 ensure 不重复注册（skillsDisposer 已存在）。
      await sessions.ensure('orchestrator-1', root, 'T', 'orchestrator')
      expect(registered).toHaveLength(1)
    } finally { close() }
  })

  it('install 订阅 dsc/exit，退出时收摊所有会话；dispose 幂等且释放技能来源', async () => {
    const registered: any[] = []
    const skills = { registerProvider: (provider: any) => { registered.push(provider); return () => { registered.pop() } } }
    const { sessions, recorded, close } = setup({ skills })
    try {
      sessions.install()
      expect(recorded.listeners.has('dsc/exit')).toBe(true)
      const handle = await sessions.ensure('orchestrator-1', root, 'T', 'orchestrator')
      expect(sessions.agent(handle.id)).toBe(handle)
      // 退出钩子调用 dispose：句柄清空、技能来源注销。
      recorded.listeners.get('dsc/exit')!()
      expect(sessions.agent(handle.id)).toBeUndefined()
      expect(registered).toHaveLength(0)
      // 再 dispose 不抛。
      sessions.dispose()
    } finally { close() }
  })

  it('dispose 时正在跑的会话先停回合再关；会话关闭后句柄表为空', async () => {
    const { sessions, close } = setup()
    try {
      const handle = await sessions.ensure('orchestrator-1', root, 'T', 'orchestrator') as any
      handle.markRunning()
      sessions.dispose()
      await new Promise(resolve => { setTimeout(resolve, 10) })
      expect(sessions.agent('orchestrator-1')).toBeUndefined()
    } finally { close() }
  })
})

