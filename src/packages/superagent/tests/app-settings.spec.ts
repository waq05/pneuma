/**
 * `app/settings.ts` 的补盲：块模型、乐观并发、来源策略同步与显示名刷新。
 *
 * 用真 `Store`（临时库）+ 真 `SourceRegistry`（注册 feishu / github 与一个只为本文件造的 demo kind），
 * 只把宿主能力（Setup 检查、会话通知、引擎回调、cordis llm）换成可等待 / 可计数的假件。
 *
 * @module dsc/packages/superagent/tests/app-settings
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { Settings, SettingsConflict } from '../app/settings.js'
import type { Settings as SettingsValue } from '../core/policy.js'
import { SettingsSchema } from '../core/policy.js'
import { UserError } from '../core/index.js'
import { KV } from '../kv.js'
import { Store } from '../app/store.js'
import { HealthBoard } from '../infra/health.js'
import { SourceRegistry } from '../sources/registry.js'
import type { SourceKind } from '../sources/kind.js'
import { feishuKind } from '../sources/feishu.js'
import { githubKind } from '../sources/github.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) { const run = cleanups.pop()!; run() }
  vi.useRealTimers()
})

/** 一个「稍后兑现」的 promise：把异步检查卡在中间用。 */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(settle => { resolve = settle })
  return { promise, resolve }
}

const zh = (text: string) => ({ zh: text, en: text })

/** 演示来源：带一个可同步的策略段，sync 的行为由用例逐次设定。 */
function demoKindOf(state: { impl: () => Promise<unknown> }) {
  const policy = z.object({ allowed: z.array(z.object({ id: z.string() }).strict()).default([]),
    syncChat: z.string().default('') }).strict()
  return {
    kind: 'demo',
    title: zh('演示'),
    description: zh('演示来源'),
    // 一个 setup 字段都没有：改它的 config 不会触发 Setup 重启。
    schema: z.object({ tag: z.string().default('') }).strict(),
    fields: [],
    health: ['demo'],
    policy: {
      schema: policy,
      fields: [],
      explicit: zh('点名'),
      sync: { label: zh('同步'), ready: (part: { syncChat: string }) => part.syncChat !== '',
        run: async () => state.impl() },
    },
  } as unknown as SourceKind
}

interface HostOptions {
  settings?: Record<string, unknown>
  configured?: boolean
  delivery?: string
  routeTo?: (provider: string, model: string, effort: string) => void
  checkAccounts?: (block: string) => Promise<void>
}

/** 一套真库 + 真注册表；宿主能力用假件，`close()` 收尾。 */
function fixture(options: HostOptions = {}) {
  const directory = createTempDir('dsc-settings-')
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse(options.settings ?? {}))
  const board = new HealthBoard()
  const registry = new SourceRegistry(() => store.settings(), board)
  registry.register(feishuKind)
  registry.register(githubKind)
  const syncState = { impl: async (): Promise<unknown> => ({ allowed: [], syncChat: '' }) }
  registry.register(demoKindOf(syncState))
  const controller = new AbortController()
  const calls = {
    notify: [] as unknown[][], delivery: [] as string[], restart: 0, blockCommands: [] as string[][],
    requestPass: 0, policyChanged: [] as unknown[][], routeTo: [] as string[][], checkAccounts: [] as string[],
  }
  const setup = {
    configured: () => options.configured ?? true,
    checkAccounts: async (block: string) => { calls.checkAccounts.push(block); await options.checkAccounts?.(block) },
    blockCommands: async (blocked: string[]) => { calls.blockCommands.push([...blocked]) },
    restart: () => { calls.restart += 1 },
  }
  const host = {
    store,
    sources: registry,
    engine: { policyChanged: (...args: unknown[]) => { calls.policyChanged.push(args) } },
    health: board,
    context: { llm: { routeTo: (provider: string, model: string, effort: string) => {
      calls.routeTo.push([provider, model, effort])
      options.routeTo?.(provider, model, effort)
    } } },
    lifetime: controller.signal,
    sessions: {
      notify: (...args: unknown[]) => { calls.notify.push(args) },
      delivery: async (name: string) => { calls.delivery.push(name); return options.delivery ?? 'injected' },
    },
    sourceHost: {},
    setup,
    requestPass: () => { calls.requestPass += 1 },
  }
  const settings = new Settings(host as never)
  cleanups.push(() => { controller.abort(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const rev = (block: Parameters<Store['blockRevision']>[0]) => store.blockRevision(block)
  return { settings, host, store, board, calls, registry, settingsOf: () => store.settings(), rev, stop: () => controller.abort() }
}

/** 带 feishu / github / demo 三个实例与一条规则的初始设置。 */
const baseSettings = {
  sources: {
    feishu: { enabled: true, config: { cli: 'lark-cli' } },
    github: { enabled: true, config: { cli: 'gh', repository: 'acme/widget' } },
    demo: { enabled: true, config: { tag: 'a' } },
    ghost: { enabled: false, config: {} },
  },
  policy: {
    rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' }],
    sources: { demo: { allowed: [{ id: 'ou_alice' }], syncChat: 'oc_1' } },
  },
}

describe('current / view / block', () => {
  test('view 给四块的版本、规则摘要与允许人数、来源实例的开关与安装状态', () => {
    const f = fixture({ settings: baseSettings })
    const view = f.settings.view()
    expect(view.revision).toBe(1)
    expect(view.pause).toStrictEqual({ revision: 0, value: { paused: false } })
    expect(view.eval).toStrictEqual({ revision: 0, value: f.settingsOf().eval })
    expect(view.executor).toStrictEqual({ revision: 0, value: f.settingsOf().executor })
    expect(view.policy).toStrictEqual({ revision: 0, rules: [{ id: 'copy', name: 'Copy', enabled: true }],
      allowed: { demo: 1 }, read: 'settings/policy' })
    // 已安装的 kind 三行 + 设置里存了但没装的孤儿实例一行。
    expect(view.sources.map(item => [item.id, item.installed, item.enabled])).toStrictEqual([
      ['demo', true, true], ['feishu', true, true], ['github', true, true], ['ghost', false, false],
    ])
    expect(view.sources.find(item => item.id === 'demo')!.read).toBe('settings/source:demo')
    expect(view.sources.find(item => item.id === 'demo')!.revision).toBe(0)
  })

  test('block 按块取值；pause / policy / eval / executor / source:<id>，未知块抛 unknownBlock', () => {
    const f = fixture({ settings: baseSettings })
    const settings = f.settingsOf()
    expect(f.settings.block('pause')).toStrictEqual({ block: 'pause', revision: 0, value: { paused: false } })
    expect(f.settings.block('policy').value).toStrictEqual(settings.policy)
    expect(f.settings.block('eval').value).toStrictEqual(settings.eval)
    expect(f.settings.block('executor').value).toStrictEqual(settings.executor)
    expect(f.settings.block('source:demo')).toStrictEqual({ block: 'source:demo', revision: 0,
      value: { enabled: true, config: { tag: 'a' } } })
    expect(f.settings.block('source:ghost').value).toStrictEqual({ enabled: false, config: {} })
    expect(() => f.settings.block('source:missing')).toThrow(UserError)
    expect(() => f.settings.block('nope')).toThrow(/Unknown settings block/)
    expect(f.settings.current()).toStrictEqual(settings)
  })
})

describe('save：乐观并发与守卫', () => {
  test('版本号过期先拒绝，一个字节都不写', async () => {
    const f = fixture({ settings: baseSettings })
    const before = f.store.settingsHistory(10).length
    await expect(f.settings.save('eval', f.settingsOf().eval, 99, 'panel')).rejects.toBeInstanceOf(SettingsConflict)
    expect(f.store.settingsHistory(10).length).toBe(before)
  })

  test('未知块与没装的来源分别按 unknownBlock / sourceNotInstalled 拒绝', async () => {
    const f = fixture({ settings: baseSettings })
    await expect(f.settings.save('nope' as never, {}, 0, 'panel')).rejects.toMatchObject({ code: 'unknownBlock' })
    await expect(f.settings.save('source:missing', { enabled: true, config: {} }, 0, 'panel'))
      .rejects.toMatchObject({ code: 'sourceNotInstalled' })
  })

  test('值没变的保存不记新版本，但仍回投递状态并通知主会话', async () => {
    const f = fixture({ settings: baseSettings })
    const saved = await f.settings.save('eval', f.settingsOf().eval, f.rev('eval'), 'panel')
    expect(saved).toStrictEqual({ saved: true, revision: 0, policy_changed: false, restarting: false, context_delivery: 'injected' })
    expect(f.calls.delivery).toStrictEqual(['settings:eval'])
    // 没有真实变化：不写版本、也不发设置保存通知（只有非 no-op 路径才发）。
    expect(f.calls.notify).toStrictEqual([])
    expect(f.store.settingsHistory(10)).toHaveLength(1)
  })

  test('eval 换模型先经 llm.routeTo 校验；不支持的努力档位与路由失败都报 modelUnavailable', async () => {
    const f = fixture({ settings: baseSettings })
    const evalConfig = f.settings.block('eval').value as SettingsValue['eval']
    const saved = await f.settings.save('eval', { ...evalConfig, model: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
      f.rev('eval'), 'panel')
    expect(saved.saved).toBe(true)
    expect(f.calls.routeTo).toStrictEqual([['p', 'm', 'high']])
    await expect(f.settings.save('eval', { ...evalConfig, model: { provider: 'p', model: 'm2', reasoningEffort: 'extreme' } },
      f.rev('eval'), 'panel')).rejects.toMatchObject({ code: 'modelUnavailable' })
    const broken = fixture({ settings: baseSettings, routeTo: () => { throw new Error('no such endpoint') } })
    await expect(broken.settings.save('eval', { ...evalConfig, model: { provider: 'p', model: 'm3' } },
      broken.rev('eval'), 'panel')).rejects.toMatchObject({ code: 'modelUnavailable' })
  })

  test('executor 只有面板能改执行环境；改 blockedCommands 会立即重写命令 shim', async () => {
    const f = fixture({ settings: baseSettings })
    const executor = f.settings.block('executor').value as SettingsValue['executor']
    await expect(f.settings.save('executor', { ...executor, directory: '/elsewhere' }, f.rev('executor'), 'tool'))
      .rejects.toMatchObject({ code: 'panelOnlyEnvironment' })
    const saved = await f.settings.save('executor', { ...executor, blockedCommands: ['rm', 'curl'] }, f.rev('executor'), 'panel')
    expect(saved.saved).toBe(true)
    expect(f.calls.blockCommands).toStrictEqual([['rm', 'curl']])
    // setup 已就绪且这次没改 setup 字段：不需要重启，直接排一拍。
    expect(saved.restarting).toBe(false)
    expect(f.calls.requestPass).toBe(1)
  })

  test('来源账号只有面板能改；改 setup 字段先过账号检查，再重启而不是立即排拍', async () => {
    const f = fixture({ settings: baseSettings })
    const before = f.settings.block('source:feishu').value as { enabled: boolean; config: Record<string, unknown> }
    // tool 来源改 cli：先被 panelOnlyAccounts 挡住，账号检查都不跑。
    await expect(f.settings.save('source:feishu', { ...before, config: { cli: 'other-lark' } }, 0, 'tool'))
      .rejects.toMatchObject({ code: 'panelOnlyAccounts' })
    expect(f.calls.checkAccounts).toStrictEqual([])
    const saved = await f.settings.save('source:feishu', { ...before, config: { cli: 'other-lark' } }, 0, 'panel')
    expect(f.calls.checkAccounts).toStrictEqual(['source:feishu'])
    expect(saved).toMatchObject({ saved: true, restarting: true, context_delivery: 'pending' })
    expect(f.calls.restart).toBe(1)
    // 重启中不排拍。
    expect(f.calls.requestPass).toBe(0)
  })

  test('账号检查期间同一个块被另一次保存改过：拒绝这次保存，一点都没留下', async () => {
    const f = fixture({ settings: baseSettings })
    const gate = deferred()
    let calls = 0
    // 第一次检查卡住，第二次直接放行。
    f.host.setup.checkAccounts = async (block: string) => {
      calls += 1
      f.calls.checkAccounts.push(block)
      if (calls === 1) await gate.promise
    }
    const value = f.settings.block('source:feishu').value as { enabled: boolean; config: Record<string, unknown> }
    const moved = f.settings.save('source:feishu', { ...value, config: { cli: 'first' } }, 0, 'panel')
    // 第二次保存同一块：检查立即放行，先落盘。
    await f.settings.save('source:feishu', { ...value, config: { cli: 'second' } }, 0, 'panel')
    gate.resolve()
    await expect(moved).rejects.toBeInstanceOf(SettingsConflict)
    expect((f.store.settings().sources.feishu!.config as { cli: string }).cli).toBe('second')
  })

  test('setup 尚未就绪时，任何保存都把重启挂起；tool 来源的保存不通知主会话', async () => {
    const f = fixture({ settings: baseSettings, configured: false })
    const evalConfig = f.settings.block('eval').value as SettingsValue['eval']
    const saved = await f.settings.save('eval', { ...evalConfig, timeoutSeconds: 300 }, f.rev('eval'), 'tool')
    expect(saved).toMatchObject({ restarting: true, context_delivery: 'pending' })
    expect(f.calls.restart).toBe(1)
    expect(f.calls.notify).toStrictEqual([])
  })

  test('Policy 变化时通知受影响工单并排一拍；来源同步来的保存不通知', async () => {
    const f = fixture({ settings: baseSettings })
    const ticket = { id: 'ticket-1', title: 'Fix typo', mandate: { strength: 'explicit', basis: { via: 'addressed', source: 'demo' },
      actor: { source: 'demo', id: 'ou_alice' }, scope: 'x', policyVersion: 'v' }, channels: [], assignments: [], inputs: [],
      undelivered: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      origin: { triggerId: 't', triggerIds: ['t'] }, decisionId: 'd' } as never
    f.store.tickets.save(ticket)
    const policy = f.settings.block('policy').value as SettingsValue['policy']
    const saved = await f.settings.save('policy', { ...policy, rules: [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs.' }] },
      f.rev('policy'), 'panel')
    expect(saved.policy_changed).toBe(true)
    expect(f.calls.policyChanged).toHaveLength(1)
    // 发起人还在名单里，规则又是新加的：没有工单受影响。
    expect(f.calls.policyChanged[0]![2]).toBeInstanceOf(Map)
    expect(f.calls.notify).toHaveLength(1)
    expect(f.settings.block('policy').value).toMatchObject({ rules: [{ id: 'docs' }] })
  })
})

describe('pause', () => {
  test('状态没变就什么都不记；变了才记版本、通知并排一拍；tool 来源不通知', async () => {
    const f = fixture({ settings: baseSettings })
    expect(await f.settings.pause(false, 'panel')).toStrictEqual({ paused: false })
    expect([f.rev('pause'), f.calls.notify.length, f.calls.delivery.length]).toStrictEqual([0, 0, 0])
    expect(await f.settings.pause(true, 'panel')).toStrictEqual({ paused: true })
    expect(f.settingsOf().paused).toBe(true)
    expect([f.rev('pause'), f.calls.notify.length, f.calls.delivery.length]).toStrictEqual([1, 1, 1])
    expect(f.calls.requestPass).toBe(1)
    expect(await f.settings.pause(false, 'tool')).toStrictEqual({ paused: false })
    expect(f.calls.notify).toHaveLength(1)
    expect(f.settingsOf().paused).toBe(false)
  })
})

describe('syncable / sync', () => {
  test('setup 没就绪时一个都同步不了；就绪后只列已装、启用且此刻可同步的来源', () => {
    const off = fixture({ settings: baseSettings, configured: false })
    expect(off.settings.syncable()).toStrictEqual([])
    const f = fixture({ settings: baseSettings })
    expect(f.settings.syncable()).toStrictEqual(['demo'])
    // 关掉来源、或清掉同步目标，就不再可同步。
    const disabled = fixture({ settings: { ...baseSettings, sources: { ...baseSettings.sources, demo: { enabled: false, config: {} } } } })
    expect(disabled.settings.syncable()).toStrictEqual([])
    const unset = fixture({ settings: { ...baseSettings, policy: { rules: [], sources: { demo: { allowed: [], syncChat: '' } } } } })
    expect(unset.settings.syncable()).toStrictEqual([])
    // github 没有策略同步，不可同步。
    expect(f.settings.syncable()).not.toContain('github')
  })

  test('同步成功：名单有变就存一版 policy 并回报 ready；名单没变只回报 ready', async () => {
    const f = fixture({ settings: baseSettings })
    const revisions = () => f.store.settingsHistory(10).length
    const before = revisions()
    const gate = deferred()
    f.registry.kind('demo')!.policy!.sync!.run = async () => { await gate.promise
      return { allowed: [{ id: 'ou_alice' }, { id: 'ou_bob' }], syncChat: 'oc_1' } }
    const syncing = f.settings.sync('demo')
    gate.resolve()
    await expect(syncing).resolves.toStrictEqual({ allowed: [{ id: 'ou_alice' }, { id: 'ou_bob' }], syncChat: 'oc_1' })
    expect(revisions()).toBe(before + 1)
    expect(f.store.settings().policy.sources.demo!.allowed).toStrictEqual([{ id: 'ou_alice' }, { id: 'ou_bob' }])
    expect(f.board.all['sync:demo']).toMatchObject({ state: 'ready', detail: '2 allowed' })
    // 第二次同步出来的名单与库里一样：不再存新版本。
    const stable = revisions()
    await f.settings.sync('demo')
    expect(revisions()).toBe(stable)
    expect(f.board.all['sync:demo']!.state).toBe('ready')
  })

  test('同步期间 Policy 被另一次保存改过：报冲突、健康项记错、改动照样留着', async () => {
    const f = fixture({ settings: baseSettings })
    const gate = deferred()
    f.registry.kind('demo')!.policy!.sync!.run = async () => { await gate.promise
      return { allowed: [{ id: 'ou_bob' }], syncChat: 'oc_1' } }
    const syncing = f.settings.sync('demo')
    const policy = f.store.settings().policy
    await f.settings.save('policy', { ...policy, rules: [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs.' }] },
      f.rev('policy'), 'panel')
    gate.resolve()
    await expect(syncing).rejects.toBeInstanceOf(SettingsConflict)
    expect(f.board.all['sync:demo']).toMatchObject({ state: 'error' })
    expect(f.board.all['sync:demo']!.detail).toContain('Policy changed during synchronization')
    expect(f.store.settings().policy.rules.map(rule => rule.id)).toStrictEqual(['docs'])
    expect(f.store.settings().policy.sources.demo!.allowed).toStrictEqual([{ id: 'ou_alice' }])
  })

  test('不能同步的来源报 nothingToSync；同步失败记健康项并按 1 分钟起、翻倍退避重试', async () => {
    const f = fixture({ settings: baseSettings })
    await expect(f.settings.sync('github')).rejects.toMatchObject({ code: 'nothingToSync' })
    vi.useFakeTimers()
    let calls = 0
    f.registry.kind('demo')!.policy!.sync!.run = async () => {
      calls += 1
      if (calls < 3) throw new Error('network down')
      return { allowed: [], syncChat: 'oc_1' }
    }
    await expect(f.settings.sync('demo')).rejects.toThrow('network down')
    expect(f.board.all['sync:demo']).toMatchObject({ state: 'error' })
    expect(f.board.all['sync:demo']!.detail).toContain('network down')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(3)
    expect(f.board.all['sync:demo']!.state).toBe('ready')
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls).toBe(3)
  })

  test('结束时清掉挂起的重试计时器，不再有残留任务', async () => {
    const f = fixture({ settings: baseSettings })
    vi.useFakeTimers()
    f.registry.kind('demo')!.policy!.sync!.run = async () => { throw new Error('down') }
    await expect(f.settings.sync('demo')).rejects.toThrow('down')
    expect(vi.getTimerCount()).toBe(1)
    // abort 监听器清掉挂起的重试计时器。
    f.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('refreshLabels', () => {
  test('没有显示名刷新能力报 noLabels；有的话只回新增名字，按字典序', async () => {
    const f = fixture({ settings: baseSettings })
    const fakeSources = {
      instance: (id: string) => id === 'demo' ? { kind: 'demo' } : undefined,
      kind: (id: string) => id === 'demo' ? { refreshLabels: async () => ({ oc_1: 'One', oc_2: 'Two', oc_0: 'Zeta' }) } : undefined,
    }
    const settings = new Settings({ ...f.host, sources: fakeSources } as never)
    f.store.set(KV.sources.labels('demo'), { oc_1: 'Old' })
    await expect(settings.refreshLabels('missing')).rejects.toMatchObject({ code: 'noLabels' })
    const added = await settings.refreshLabels('demo')
    expect(added).toStrictEqual({ added: ['Two', 'Zeta'] })
  })
})
