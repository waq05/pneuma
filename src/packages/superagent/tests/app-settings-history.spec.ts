/**
 * `app/settings-history.ts` 的补盲：逐版设置快照之间的结构化差异。
 *
 * 用真 `Store`（临时库）+ 真 `SourceRegistry`（注册 feishu / github 两个真 kind），只搭真判据；
 * 「历史版本被裁剪 / revision 断号 / 来源 schema 变了导致旧版本解析失败」这三条用假 Store 直接喂历史。
 *
 * @module dsc/packages/superagent/tests/app-settings-history
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { policyHistory } from '../app/settings-history.js'
import { SettingsSchema } from '../core/policy.js'
import type { Store, SettingsVersion } from '../app/store.js'
import { Store as RealStore } from '../app/store.js'
import { HealthBoard } from '../infra/health.js'
import { SourceRegistry } from '../sources/registry.js'
import { feishuKind } from '../sources/feishu.js'
import { githubKind } from '../sources/github.js'

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

/** 一套真库 + 真注册表；来源 kind 的 schema 用来解析历史版本里的 config / policy 段。 */
function fixture() {
  const directory = createTempDir('dsc-settings-history-')
  const store = new RealStore(join(directory, 'orchestrator.sqlite'))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(feishuKind)
  sources.register(githubKind)
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, sources }
}

/** 存一版设置（`source: 'panel'`），返回这一版的 revision。 */
const save = (store: Store, settings: ReturnType<typeof SettingsSchema.parse>, extra: Partial<SettingsVersion> = {}) => {
  store.saveSettings(settings, { source: 'panel', policyVersion: 'v', policyChanged: false, notified: [], ...extra })
  return store.settingsHistory(1)[0]!.revision
}

/** 差异行摊平成 `[code, field/source, 关键值]`，方便逐条断言。 */
const rows = (changes: { code: string; field?: string; source?: string; part?: true; from?: unknown; to?: unknown; items?: string[]; name?: string }[] | null) =>
  (changes ?? []).map(item => ({ code: item.code, ...(item.field === undefined ? {} : { field: item.field }),
    ...(item.source === undefined ? {} : { source: item.source }), ...(item.part === undefined ? {} : { part: item.part }),
    ...(item.from === undefined ? {} : { from: item.from }), ...(item.to === undefined ? {} : { to: item.to }),
    ...(item.items === undefined ? {} : { items: item.items }), ...(item.name === undefined ? {} : { name: item.name }) }))

describe('policyHistory：真实设置快照的逐版差异', () => {
  test('规则增删改名、启停与指令变化各出一行；旧版比新版少一条规则算 ruleAdded', () => {
    const { store, sources } = fixture()
    const base = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' }] } })
    save(store, base)
    const next = SettingsSchema.parse({ policy: { rules: [
      { id: 'copy', name: 'Copywriting', enabled: false, instruction: 'Fix wording.' },
      { id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs.' },
    ] } })
    save(store, next)
    const [newest] = policyHistory(store, sources, 'v').items
    expect(rows(newest!.changes)).toStrictEqual([
      { code: 'ruleRenamed', from: 'Copy', to: 'Copywriting' },
      { code: 'ruleInstruction', name: 'Copywriting' },
      { code: 'ruleDisabled', name: 'Copywriting' },
      { code: 'ruleAdded', name: 'Docs' },
    ])
    // 反过来（删掉一条规则）算 ruleRemoved。
    save(store, base)
    const removed = policyHistory(store, sources, 'v').items[0]!
    expect(rows(removed.changes).some(item => item.code === 'ruleRemoved' && item.name === 'Docs')).toBe(true)
  })

  test('来源的开关键、标量字段、行集合的增删改、准入表变化各出一行；行名优先取第二列', () => {
    const { store, sources } = fixture()
    const base = SettingsSchema.parse({
      sources: { feishu: { enabled: true, config: { chats: [{ chatId: 'oc_1', listen: 'mentions' }], otherChats: 'none' } } },
      policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } },
    })
    save(store, base)
    const next = SettingsSchema.parse({
      sources: { feishu: { enabled: false, config: { chats: [
        { chatId: 'oc_1', listen: 'all' },
        { chatId: 'oc_2', listen: 'mentions' },
      ], otherChats: 'mentions' } }, github: { enabled: true, config: {} } },
      policy: { sources: {
        feishu: { allowed: [{ id: 'ou_alice', name: 'Alicia' }, { id: 'ou_bob', name: 'Bob' }], syncChat: 'oc_1' },
        github: { allowed: [{ id: 'alice' }] },
      } },
    })
    save(store, next)
    const changes = rows(policyHistory(store, sources, 'v').items[0]!.changes)
    // 来源开关：feishu 关了；github 是新出现的实例（默认 enabled true，与「没有」相同，所以不算开关键）。
    expect(changes).toContainEqual({ code: 'sourceDisabled', source: 'feishu' })
    // 配置里的行字段：oc_1 的 listen 改了、oc_2 新增（行名取第二列，所以是 listen 的值）。
    expect(changes).toContainEqual({ code: 'sourceRowsChanged', source: 'feishu', field: 'chats', items: ['all'] })
    expect(changes).toContainEqual({ code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['mentions'] })
    expect(changes).toContainEqual({ code: 'sourceField', source: 'feishu', field: 'otherChats', from: 'none', to: 'mentions' })
    // 策略段：allowed 行新增（名字优先），syncChat 标量变化；准入表整表变化只报一行。
    expect(changes).toContainEqual({ code: 'sourceRowsAdded', source: 'feishu', part: true, field: 'allowed', items: ['Bob'] })
    expect(changes).toContainEqual({ code: 'sourceField', source: 'feishu', part: true, field: 'syncChat', from: '', to: 'oc_1' })
    expect(changes).toContainEqual({ code: 'sourceRowsAdded', source: 'github', part: true, field: 'allowed', items: ['alice'] })
    // 删掉一行：反向保存一次看 sourceRowsRemoved。
    save(store, SettingsSchema.parse({ ...base, sources: { feishu: { enabled: true, config: { chats: [] } } }, policy: { sources: {} } }))
    const removedRows = rows(policyHistory(store, sources, 'v').items[0]!.changes)
    expect(removedRows).toContainEqual({ code: 'sourceRowsRemoved', source: 'feishu', field: 'chats', items: ['all', 'mentions'] })  })

  test('准入表变化汇总成 sourceAdmission；eval / executor / pause 的每个标量各一行', () => {
    const { store, sources } = fixture()
    const base = SettingsSchema.parse({ sources: { github: { enabled: true, config: {} } },
      policy: { sources: { github: { allowed: [], admission: {} } } } })
    save(store, base)
    const next = SettingsSchema.parse({
      paused: true,
      sources: { github: { enabled: true, config: {} } },
      eval: { mode: 'auto', timeoutSeconds: 300, model: { provider: 'p', model: 'm1', reasoningEffort: 'high' } },
      executor: { maxWorkers: 9, directory: '/tmp/work', prepare: 'npm ci', blockedCommands: ['rm', 'curl'],
        model: { provider: 'p', model: 'm2' } },
      policy: { sources: { github: { allowed: [], admission: { comments: { unlistedUnaddressed: 'inferred' } } } } },
    })
    save(store, next)
    const changes = rows(policyHistory(store, sources, 'v').items[0]!.changes)
    expect(changes).toContainEqual({ code: 'sourceAdmission', source: 'github', part: true })
    expect(changes).toContainEqual({ code: 'mode', from: 'observe', to: 'auto' })
    expect(changes).toContainEqual({ code: 'timeout', from: 120, to: 300 })
    expect(changes).toContainEqual({ code: 'evalModel' })
    expect(changes).toContainEqual({ code: 'executorModel' })
    expect(changes).toContainEqual({ code: 'maxWorkers', from: 3, to: 9 })
    expect(changes).toContainEqual({ code: 'paused' })
    expect(changes).toContainEqual({ code: 'executionDirectory', from: '', to: '/tmp/work' })
    expect(changes).toContainEqual({ code: 'prepareCommand' })
    expect(changes).toContainEqual({ code: 'blockedCommands', from: '', to: 'rm curl' })
    // 恢复处理：paused=false 时报 resumed。
    save(store, SettingsSchema.parse({ ...next, paused: false }))
    expect(rows(policyHistory(store, sources, 'v').items[0]!.changes)).toContainEqual({ code: 'resumed' })
  })

  test('最新一版没有前一版、断号的历史、以及被裁剪的最旧一版，changes 都是 null', () => {
    const { store, sources } = fixture()
    save(store, SettingsSchema.parse({ eval: { mode: 'auto' } }))
    const history = policyHistory(store, sources, 'v')
    expect(history.items).toHaveLength(1)
    expect(history.items[0]!.changes).toBeNull()
    expect(history.current).toBe(1)
    expect(history.policyVersion).toBe('v')
  })

  test('notified 里的工单 id 换成标题，查不到就回 id；相邻版本才比差异', () => {
    const { store, sources } = fixture()
    const ticket = { id: 'ticket-1', title: 'Fix typo' } as never
    store.tickets.save(ticket)
    save(store, SettingsSchema.parse({ eval: { mode: 'auto' } }), { notified: ['ticket-1', 'missing'] })
    save(store, SettingsSchema.parse({ eval: { mode: 'off' } }), { notified: ['ticket-1'] })
    const items = policyHistory(store, sources, 'v').items
    expect(items[0]!.notified).toStrictEqual([{ id: 'ticket-1', title: 'Fix typo' }])
    expect(items[1]!.notified).toStrictEqual([{ id: 'ticket-1', title: 'Fix typo' }, { id: 'missing', title: 'missing' }])
    expect(rows(items[0]!.changes)).toContainEqual({ code: 'mode', from: 'auto', to: 'off' })
  })
})

describe('policyHistory：假 Store 的边界', () => {
  /** 只有 policyHistory 用到的三个成员的 Store 假件。 */
  function fakeStore(versions: SettingsVersion[]): Store {
    return {
      settingsHistory: (limit: number) => versions.slice(0, limit),
      get: () => 7,
      tickets: { get: (id: string) => id === 'ticket-1' ? { id, title: 'Fix typo' } : undefined },
    } as unknown as Store
  }

  test('历史版本按当前来源 schema 解析失败时，这一版的 changes 降级成 null，不抛错', () => {
    const settings = (config: unknown) => SettingsSchema.parse({ sources: { feishu: { enabled: true, config } } })
    const versions: SettingsVersion[] = [
      { revision: 2, savedAt: 'b', source: 'panel', policyVersion: 'v', policyChanged: false, notified: [], settings: settings({}) },
      // 旧版本里 chats 的形状当前 schema 不认：`sourceChanges` 的 fill 抛错，changesOf 兜住。
      { revision: 1, savedAt: 'a', source: 'panel', policyVersion: 'v', policyChanged: false, notified: [], settings: settings({ chats: 'not-an-array' }) },
    ]
    const history = policyHistory(fakeStore(versions), { kind: () => feishuKind } as unknown as SourceRegistry, 'v')
    expect(history.items.map(item => item.changes)).toStrictEqual([null, null])
  })

  test('断号（相邻两版 revision 差 > 1）不计算差异', () => {
    const versions: SettingsVersion[] = [
      { revision: 9, savedAt: 'b', source: 'panel', policyVersion: 'v', policyChanged: false, notified: [], settings: SettingsSchema.parse({}) },
      { revision: 5, savedAt: 'a', source: 'panel', policyVersion: 'v', policyChanged: false, notified: [], settings: SettingsSchema.parse({}) },
    ]
    const history = policyHistory(fakeStore(versions), { kind: () => undefined } as unknown as SourceRegistry, 'v')
    expect(history.items.map(item => item.changes)).toStrictEqual([null, null])
  })
})
