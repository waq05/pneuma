/**
 * runtime 插件装配面（`packages/runtime/index.ts`）：把各服务织成 `ui` 契约。
 *
 * 假 ctx 只负责记录转发；设置读写、命令派发、旁问、可选服务缺失/存在的分支都直接跑。
 * 热启停的落盘与挂载在 `core/plugin-loader` 里，这里用替身钉「runtime 只转发、不重复写盘」；
 * 第三方 / 组合包界面半的判定走真实实现（临时 HOME 下铺夹具）。
 *
 * @module dsc/packages/runtime/tests/wiring.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-runtime-wiring-'))
process.env['DSC_HOME'] = HOME
process.env['DSC_PROFILE'] = 'test'

const PLUGINS_DIR = join(HOME, 'plugins')
const PROFILE_DIR = join(HOME, 'profiles', 'test')

/** 热启停替身：runtime 自己不该写盘，落盘与挂载归 loader。 */
const hot = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; enabled: boolean }>,
  result: { ok: true } as { ok: boolean; problem?: string },
}))

vi.mock('@pneuma/runtime/core/plugin-loader.js', () => ({
  setPluginEnabledHot: async (file: string, enabled: boolean) => {
    hot.calls.push({ file, enabled })
    return hot.result
  },
}))

type RuntimeIndex = typeof import('../index.js')
let runtimePlugin: RuntimeIndex['runtimePlugin']
let registerPluginMeta: (meta: Record<string, unknown>) => void

beforeAll(async () => {
  runtimePlugin = (await import('../index.js')).runtimePlugin
  registerPluginMeta = (await import('@pneuma/runtime/core/plugin-registry.js')).registerPluginMeta as never
  registerPluginMeta({ file: 'core-kernel', name: '运行内核', description: '', source: 'builtin' })
  registerPluginMeta({ file: 'demo-plugin', name: '示例插件', description: '', source: 'external' })
})

beforeEach(() => {
  hot.calls.length = 0
  hot.result = { ok: true }
  mkdirSync(PLUGINS_DIR, { recursive: true })
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
  // 第三方界面插件夹具：isThirdPartyUiEntry 只看 <root>/<name>/ui/client.js 在不在。
  mkdirSync(join(PLUGINS_DIR, 'tp', 'ui'), { recursive: true })
  writeFileSync(join(PLUGINS_DIR, 'tp', 'plugin.json'), JSON.stringify({ api: '^1.0.0' }), 'utf8')
  writeFileSync(join(PLUGINS_DIR, 'tp', 'ui', 'client.js'), 'export {}\n', 'utf8')
  // 组合包界面半夹具：package.json 的 pneuma.client + exports["./client"]。
  const pkgDir = join(PROFILE_DIR, 'node_modules', 'pkg-ui')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: 'pkg-ui',
      version: '1.0.0',
      pneuma: { client: { platform: 'pneuma', api: '^1.0.0' } },
      exports: { './client': './client.js' },
    }),
    'utf8',
  )
  writeFileSync(join(pkgDir, 'client.js'), 'export {}\n', 'utf8')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  delete process.env['DSC_PROFILE']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // EPERM：临时目录交给系统清。
  }
})

interface Harness {
  service: Record<string, (...args: never[]) => unknown> & Record<string, unknown>
  events: Array<{ event: string; args: unknown[] }>
  optional: Map<string, unknown>
  transcript: Record<string, ReturnType<typeof vi.fn>>
  agent: Record<string, ReturnType<typeof vi.fn>>
  session: Record<string, ReturnType<typeof vi.fn>>
  llm: Record<string, ReturnType<typeof vi.fn> | string>
  settings: Record<string, ReturnType<typeof vi.fn>>
  commands: Record<string, ReturnType<typeof vi.fn>>
  skills: Record<string, ReturnType<typeof vi.fn>>
  approval: Record<string, ReturnType<typeof vi.fn>>
  presets: Record<string, ReturnType<typeof vi.fn>>
  permissionPresets: Record<string, ReturnType<typeof vi.fn>>
  triggers: Record<string, ReturnType<typeof vi.fn>>
  writes: Record<string, unknown[][]>
  prefs: { ui: Record<string, unknown> }
  snapshot: Record<string, unknown>
}

/** 假 ctx：所有服务直接挂在上下文上；可选服务放进 map 供 ctx.get 查。 */
function fakeCtx(): Harness {
  const events: Array<{ event: string; args: unknown[] }> = []
  const optional = new Map<string, unknown>()
  const writes: Record<string, unknown[][]> = {}
  const write = (key: string, ...args: unknown[]): void => {
    ;(writes[key] ??= []).push(args)
  }
  let provided: unknown
  const snapshot = { sessionStates: {}, queued: [] }
  const prefs: { ui: Record<string, unknown> } = { ui: { sessionSort: 'recent' } }

  const transcript = {
    subscribe: vi.fn((listener: unknown) => {
      write('subscribe', listener)
      return () => write('unsubscribe')
    }),
    getSnapshot: vi.fn(() => {
      write('getSnapshot')
      return snapshot
    }),
    system: vi.fn((...args: unknown[]) => write('system', ...args)),
    touch: vi.fn(() => write('touch')),
  }
  const agent = {
    followup: vi.fn((...args: unknown[]) => write('followup', ...args)),
    interrupt: vi.fn((...args: unknown[]) => write('interrupt', ...args)),
    editQueued: vi.fn(() => true),
    removeQueued: vi.fn(() => false),
    steerQueued: vi.fn(() => true),
  }
  const session = {
    current: vi.fn(() => ({ meta: { id: 's1', cwd: 'C:/repo' }, filePath: 'C:/repo/s.jsonl' })),
    open: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    archive: vi.fn(async () => ({ ok: true, notice: '已归档' })),
    archived: vi.fn(() => ({ sessions: [], trashDir: 'C:/trash', count: 0 })),
    restore: vi.fn(() => ({ ok: true, notice: '已恢复' })),
    purge: vi.fn(async () => ({ ok: true, notice: '已删除' })),
    rename: vi.fn(async () => ({ ok: true, notice: '已改名' })),
    setPinned: vi.fn(async () => ({ ok: true, notice: '已置顶' })),
    userMessages: vi.fn(() => ['第一条', '第二条']),
    fork: vi.fn(() => ({ ok: true, path: 'C:/fork.jsonl' })),
    rewind: vi.fn(() => ({ ok: true, notice: '已回退' })),
  }
  const compact = { run: vi.fn(async () => undefined) }
  const llm: Harness['llm'] = {
    provider: 'fake-provider',
    model: 'model-a',
    parseModelRef: vi.fn((ref: string) => ({ provider: 'p', model: ref })),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    listModels: vi.fn(() => [{ value: 'p/m', provider: 'p', model: 'm' }]),
    route: vi.fn(() => ({ api: 'api', baseUrl: '', apiKey: '', model: 'm' })),
    routeTo: vi.fn((provider: string, model: string) => ({ api: 'api', baseUrl: '', apiKey: '', model, provider })),
    stream: vi.fn(async (_api: unknown, _request: unknown, handlers: { onDelta?: (kind: string, text: string) => void }) => {
      handlers.onDelta?.('text', 'hel')
      return { text: 'hello', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
    }),
  }
  const settings = {
    prefs: vi.fn(() => ({ ...prefs, ui: prefs.ui })),
    setPrefs: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(prefs, patch)
      if (patch['ui'] !== undefined) prefs.ui = { ...prefs.ui, ...(patch['ui'] as Record<string, unknown>) }
    }),
    sections: vi.fn(() => [{ id: 'general' }]),
    values: vi.fn(async (id: string) => ({ id, a: 1 })),
    save: vi.fn(async (id: string, key: string, value: unknown) => ({ ok: true, notice: `${id}.${key}=${String(value)}` })),
    action: vi.fn(async (id: string, action: string) => ({ ok: true, notice: `${id}:${action}` })),
    modelConfig: vi.fn(() => ({ providers: [] })),
    saveProvider: vi.fn(async () => ({ ok: true, notice: '已保存端点' })),
    discoverModels: vi.fn(async () => ['m1', 'm2']),
    testConnection: vi.fn(async () => ({ ok: true })),
    removeProvider: vi.fn(async () => ({ ok: true, notice: '已删除端点' })),
    setProviderKey: vi.fn(async () => ({ ok: true, notice: '已保存密钥' })),
    setDefaultModel: vi.fn(async () => ({ ok: true, notice: '已设默认模型' })),
    setConfigFile: vi.fn(async () => ({ ok: true, notice: '已切换配置' })),
  }
  const commands = {
    run: vi.fn(async (input: unknown, _runtime: unknown, ui: { notice: (text: string) => void; shell?: boolean }) => {
      write('commandRun', input, ui.shell ?? false)
      ui.notice(`跑了 ${String(input)}`)
      return 'command-result'
    }),
  }
  const skills = {
    list: vi.fn(() => [{ name: 'skill-a' }]),
    read: vi.fn(async (name: string) => ({ ok: true, name, text: '正文' })),
    setEnabled: vi.fn((name: string, enabled: boolean) => ({ ok: true, notice: `${name}:${String(enabled)}` })),
    browseMarket: vi.fn(async (source: string, _all: boolean, query?: string) => ({ source, query })),
    installMarketSkill: vi.fn(async () => ({ ok: true, notice: '已安装' })),
  }
  const approval = {
    setPolicy: vi.fn(),
    setReviewer: vi.fn(),
    answer: vi.fn(),
  }
  const presets = {
    surface: vi.fn(() => ({ current: 'build', options: [] })),
    read: vi.fn((name: string) => `preset:${name}`),
    use: vi.fn((name: string) => `已使用 ${name}`),
    save: vi.fn(() => '已保存预设'),
    remove: vi.fn(() => '已删除预设'),
    setDefault: vi.fn(() => '已设为默认'),
  }
  const permissionPresets = {
    surface: vi.fn(() => ({ current: 'safe', options: [] })),
    use: vi.fn((name: string) => `已使用权限预设 ${name}`),
    setDefault: vi.fn(() => '已设为默认权限预设'),
  }
  const triggers = {
    clearTodos: vi.fn(),
    answerQuestion: vi.fn(),
    answerPlan: vi.fn(),
    goalAction: vi.fn(async () => ({ ok: true })),
    dock: vi.fn(async () => ({ ok: true })),
    setMode: vi.fn(),
  }

  const ctx = {
    transcript,
    agent,
    session,
    compact,
    llm,
    settings,
    commands,
    skills,
    approval,
    presets,
    permissionPresets,
    tools: {
      list: vi.fn(() => [
        { name: 'bash', risk: 'exec', description: '跑命令', parameters: {}, presets: ['build'] },
        { name: 'read', risk: 'read', description: '读文件', parameters: {} },
      ]),
    },
    mode: { setMode: triggers.setMode },
    todo: { clearTodos: triggers.clearTodos },
    ask: { answerQuestion: triggers.answerQuestion },
    plan: { answerPlan: triggers.answerPlan },
    goal: { goalAction: triggers.goalAction },
    dock: { handle: triggers.dock },
    get(name: string) {
      return optional.get(name)
    },
    emit(event: string, ...args: unknown[]) {
      events.push({ event, args })
    },
    provide(name: string, value: unknown) {
      if (name === 'ui') provided = value
    },
  }

  runtimePlugin.apply?.(ctx as never)
  return {
    service: provided as Harness['service'],
    events,
    optional,
    transcript,
    agent,
    session,
    llm,
    settings,
    commands,
    skills,
    approval,
    presets,
    permissionPresets,
    triggers,
    writes,
    prefs,
    snapshot,
  }
}

describe('装配与基础转发', () => {
  test('provide ui；快照 / 订阅 / 提交 / 打断 / 排队编辑与切换会话都转发', async () => {
    const h = fakeCtx()
    expect(runtimePlugin.name).toBe('ui-runtime')
    expect(h.service).toBeTruthy()

    const listener = (): void => undefined
    const unsubscribe = (h.service.subscribe as (fn: () => void) => () => void)(listener)
    expect(h.transcript.subscribe).toHaveBeenCalledWith(listener)
    unsubscribe()
    expect(h.writes['unsubscribe']).toHaveLength(1)

    expect(h.service.getSnapshot()).toBe(h.snapshot)
    h.service.submit('你好', ['img'], [{ path: 'a.txt' }] as never)
    expect(h.agent.followup).toHaveBeenCalledWith('你好', ['img'], undefined, 'user', [{ path: 'a.txt' }])

    h.service.interrupt()
    expect(h.agent.interrupt).toHaveBeenCalled()
    expect(h.service.editQueued(1, '改')).toBe(true)
    expect(h.agent.editQueued).toHaveBeenCalledWith(1, '改')
    expect(h.service.removeQueued(2)).toBe(false)
    expect(h.service.steerQueued(3)).toBe(true)

    await h.service.openSession('C:/s.jsonl')
    expect(h.session.open).toHaveBeenCalledWith('C:/s.jsonl')
    await h.service.newSessionIn('C:/repo2')
    expect(h.session.open).toHaveBeenCalledWith(undefined, 'C:/repo2')
    await h.service.compact()
    expect((h.service as never as { compact: unknown }).compact).toBeDefined()
  })

  test('setModel：成功写一行回执；失败把原因写进正文；总是 touch', async () => {
    const h = fakeCtx()
    await h.service.setModel('p/model-x')
    expect(h.llm.parseModelRef).toHaveBeenCalledWith('p/model-x')
    expect(h.llm.setModel).toHaveBeenCalledWith('p', 'p/model-x')
    expect(h.writes['system']?.some((args) => String(args[0]).includes('模型切换为 fake-provider/model-a'))).toBe(true)
    expect(h.transcript.touch).toHaveBeenCalled()

    ;(h.llm.setModel as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('没有这个模型')
    })
    await h.service.setModel('p/nope')
    expect(h.writes['system']?.some((args) => String(args[0]).includes('没有这个模型'))).toBe(true)
  })

  test('setEffort：普通档写回执，quiet 不写；失败写原因并提前返回', async () => {
    const h = fakeCtx()
    await h.service.setEffort('low' as never)
    expect(h.llm.setEffort).toHaveBeenCalledWith('low')
    expect(h.writes['system']?.some((args) => String(args[0]).includes('思考强度设为「低」'))).toBe(true)

    const before = h.writes['system']?.length ?? 0
    await h.service.setEffort('max' as never, true)
    expect(h.writes['system']?.length ?? 0).toBe(before)
    expect(h.transcript.touch).toHaveBeenCalled()

    ;(h.llm.setEffort as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('这个模型不支持思考档')
    })
    await h.service.setEffort('high' as never)
    expect(h.writes['system']?.some((args) => String(args[0]).includes('这个模型不支持思考档'))).toBe(true)
  })
})

describe('插件中心', () => {
  test('listPlugins 读注册表；setPluginEnabled 的内核档拒绝、热启停成功/失败各有文案', async () => {
    const h = fakeCtx()
    const plugins = h.service.listPlugins() as Array<{ file: string; name: string }>
    expect(plugins.some((item) => item.file === 'core-kernel')).toBe(true)
    expect(plugins.some((item) => item.file === 'demo-plugin')).toBe(true)

    await h.service.setPluginEnabled('core-kernel', false)
    expect(hot.calls).toHaveLength(0)
    expect(h.writes['system']?.some((args) => String(args[0]).includes('不能停用'))).toBe(true)

    await h.service.setPluginEnabled('demo-plugin', true)
    expect(hot.calls).toEqual([{ file: 'demo-plugin', enabled: true }])
    expect(h.events.some((item) => item.event === 'dsc/ui-plugins-changed')).toBe(true)
    expect(h.writes['system']?.some((args) => String(args[0]).includes('已启用插件「示例插件」'))).toBe(true)

    hot.result = { ok: false, problem: '挂载炸了' }
    await h.service.setPluginEnabled('demo-plugin', true)
    expect(h.writes['system']?.some((args) => String(args[0]).includes('没能启用') && String(args[0]).includes('挂载炸了'))).toBe(
      true,
    )
  })

  test('第三方界面插件与组合包界面半：只落盘、发换图事件，不走热挂载', async () => {
    const h = fakeCtx()
    await h.service.setPluginEnabled('tp/ui/client.js', true)
    expect(hot.calls).toHaveLength(0)
    expect(h.writes['system']?.some((args) => String(args[0]).includes('第三方界面插件「tp」'))).toBe(true)
    expect(h.events.some((item) => item.event === 'dsc/ui-plugins-changed')).toBe(true)
    const saved = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
      entries: Array<{ file: string; disabled: boolean }>
    }
    expect(saved.entries.find((entry) => entry.file === 'tp/ui/client.js')?.disabled).toBe(false)

    await h.service.setPluginEnabled('pkg-ui/client', true)
    expect(h.writes['system']?.some((args) => String(args[0]).includes('组合包的界面半「pkg-ui」'))).toBe(true)
  })

  test('listUiTrust 列出第三方与组合包；setUiTrust 对非法名 / 缺夹具给出失败原因', () => {
    const h = fakeCtx()
    const rows = h.service.listUiTrust() as Array<{ name: string }>
    expect(rows.some((row) => row.name === 'tp')).toBe(true)
    expect(rows.some((row) => row.name === 'pkg-ui')).toBe(true)

    expect(h.service.setUiTrust('bad/name')).toMatchObject({ ok: false })
    expect(h.service.setUiTrust('missing')).toMatchObject({ ok: false })
    // 清单没有 apiVersion 时门禁失败关闭——这一条钉的是「失败不推帧」。
    expect(h.service.setUiTrust('tp')).toMatchObject({ ok: false })
    expect(h.events.some((item) => item.event === 'dsc/ui-graph-dirty')).toBe(false)
  })
})

describe('可选服务：队友、后台作业、Super Agent', () => {
  test('服务不在时给空清单或明确的拒绝原因', async () => {
    const h = fakeCtx()
    expect(h.service.listTeammates()).toEqual([])
    expect(h.service.listTeamBoard()).toEqual({ revision: 0, tasks: [] })
    await expect(h.service.stopTeammate('a')).rejects.toThrow('子智能体插件没开')
    await expect(h.service.messageTeammate('a', 'x')).rejects.toThrow('子智能体插件没开')
    await expect(h.service.removeTeammate('a')).rejects.toThrow('子智能体插件没开')
    await expect(h.service.peekTranscript('C:/t.jsonl')).rejects.toThrow('子智能体插件没开')
    await expect(h.service.stopBackground('job-1')).rejects.toThrow('后台作业表不在')
    await expect(h.service.readBackground('job-1')).rejects.toThrow('后台作业表不在')
    await expect(h.service.superagentPublish({})).rejects.toThrow('Super Agent 插件没开')
    await expect(h.service.superagentStopTicket('t')).rejects.toThrow('Super Agent 插件没开')
    await expect(h.service.superagentRetryTicket('t')).rejects.toThrow('Super Agent 插件没开')
    await expect(h.service.superagentCleanWorktree('t')).rejects.toThrow('Super Agent 插件没开')
    await expect(h.service.superagentPeekSession('t')).rejects.toThrow('Super Agent 插件没开')
  })

  test('服务在时原样转发；Super Agent 工单 id 接受对象与裸串，其它形状当场拒绝', async () => {
    const h = fakeCtx()
    const team = {
      list: vi.fn(() => [{ name: '队友 A' }]),
      board: vi.fn((id: string) => ({ revision: 1, tasks: [{ id, title: '活' }] })),
      stop: vi.fn(async (name: string) => `停了 ${name}`),
      message: vi.fn(async (name: string, text: string) => `${name}:${text}`),
      remove: vi.fn(async (name: string) => `移除了 ${name}`),
      peek: vi.fn(async (file: string) => [{ role: 'user', text: file }]),
    }
    h.optional.set('team', team)
    expect(h.service.listTeammates()).toEqual([{ name: '队友 A' }])
    expect(h.service.listTeamBoard()).toMatchObject({ revision: 1, tasks: [{ id: 's1' }] })
    expect(await h.service.stopTeammate('A')).toBe('停了 A')
    expect(await h.service.messageTeammate('A', '走')).toBe('A:走')
    expect(await h.service.removeTeammate('A')).toBe('移除了 A')
    expect(await h.service.peekTranscript('C:/t.jsonl')).toEqual([{ role: 'user', text: 'C:/t.jsonl' }])

    const works = { stop: vi.fn(async (id: string) => `停了 ${id}`), read: vi.fn(async () => ({ text: '输出' })) }
    h.optional.set('backgroundWorks', works)
    expect(await h.service.stopBackground('job-2')).toBe('停了 job-2')
    expect(await h.service.readBackground('job-2')).toEqual({ text: '输出' })

    const superagent = {
      publish: vi.fn(async (input: unknown) => `ticket:${JSON.stringify(input)}`),
      stop: vi.fn(async (id: string) => `stop:${id}`),
      retry: vi.fn(async (id: string) => `retry:${id}`),
      clean: vi.fn(async (id: string) => `clean:${id}`),
      peekSession: vi.fn(async (id: string) => [{ text: id }]),
    }
    h.optional.set('superagent', superagent)
    expect(await h.service.superagentPublish({ task: 'x' })).toContain('ticket:')
    expect(await h.service.superagentStopTicket('t1')).toBe('stop:t1')
    expect(await h.service.superagentStopTicket({ id: 't2' })).toBe('stop:t2')
    expect(await h.service.superagentRetryTicket({ id: 't3' })).toBe('retry:t3')
    expect(await h.service.superagentCleanWorktree({ id: 't4' })).toBe('clean:t4')
    expect(await h.service.superagentPeekSession({ id: 't5' })).toEqual([{ text: 't5' }])
    expect(() => h.service.superagentStopTicket(42 as never)).toThrow('要给一个工单 id')
  })
})

describe('权限预设、模式预设与界面动作', () => {
  test('打包权限预设与模式预设：成功原样返回，失败折成 {ok:false}', async () => {
    const h = fakeCtx()
    expect(h.service.listPermissionPresets()).toEqual({ current: 'safe', options: [] })
    expect(h.service.usePermissionPreset('safe')).toEqual({ ok: true, notice: '已使用权限预设 safe' })
    expect(h.service.setDefaultPermissionPreset('safe')).toEqual({ ok: true, notice: '已设为默认权限预设' })
    ;(h.permissionPresets.use as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('预设不存在')
    })
    expect(h.service.usePermissionPreset('nope')).toEqual({ ok: false, error: '预设不存在' })

    expect(h.service.listPresets()).toEqual({ current: 'build', options: [] })
    await expect(h.service.readPreset('a')).resolves.toEqual({ ok: true, name: 'a', text: 'preset:a' })
    ;(h.presets.read as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('读不到')
    })
    await expect(h.service.readPreset('b')).resolves.toEqual({ ok: false, error: '读不到' })
    expect(h.service.usePreset('a')).toEqual({ ok: true, notice: '已使用 a' })
    expect(h.service.savePreset({ name: 'a' } as never)).toEqual({ ok: true, notice: '已保存预设' })
    expect(h.service.removePreset('a')).toEqual({ ok: true, notice: '已删除预设' })
    expect(h.service.setDefaultPreset('a')).toEqual({ ok: true, notice: '已设为默认' })
    h.service.setMode('plan' as never)
    expect(h.triggers.setMode).toHaveBeenCalledWith('plan')
  })

  test('工具清单 / 技能 / 提问 / 计划 / 目标 / todo / dock 全部转发', async () => {
    const h = fakeCtx()
    expect(h.service.listTools()).toEqual([
      { name: 'bash', risk: 'exec', description: '跑命令', presets: ['build'] },
      { name: 'read', risk: 'read', description: '读文件' },
    ])
    expect(h.service.listSkills()).toEqual([{ name: 'skill-a' }])
    await expect(h.service.readSkill('skill-a')).resolves.toMatchObject({ ok: true, text: '正文' })
    expect(h.service.setSkillEnabled('skill-a', false)).toMatchObject({ ok: true })
    await expect(h.service.browseMarket('src', '查询')).resolves.toEqual({ source: 'src', query: '查询' })
    await expect(h.service.installMarketSkill('src', 'x')).resolves.toMatchObject({ ok: true })

    h.service.answerQuestion({ id: 'q' } as never)
    expect(h.triggers.answerQuestion).toHaveBeenCalledWith({ id: 'q' })
    h.service.answerPlan('approve' as never, '好')
    expect(h.triggers.answerPlan).toHaveBeenCalledWith('approve', '好')
    await expect(h.service.goalAction('stop' as never)).resolves.toEqual({ ok: true })
    expect(h.triggers.goalAction).toHaveBeenCalledWith('stop')
    h.service.clearTodos()
    expect(h.triggers.clearTodos).toHaveBeenCalled()
    await expect(h.service.dock('close' as never)).resolves.toEqual({ ok: true })
    expect(h.triggers.dock).toHaveBeenCalledWith('close', {})
  })
})

describe('命令通道', () => {
  test('runCommand 用普通回调派发；listUiCommands 与 runUiCommand 用壳的闸门', async () => {
    const h = fakeCtx()
    await expect(h.service.runCommand('/help' as never)).resolves.toBe('command-result')
    expect(h.commands.run).toHaveBeenCalled()
    expect(h.writes['commandRun']?.[0]).toEqual(['/help', false])
    // notice 写 transcript 的 command 条目（第三个参数 true）。
    expect(h.writes['system']?.some((args) => args[0] === '跑了 /help' && args[2] === true)).toBe(true)

    const listed = h.service.listUiCommands() as Array<{ name: string; duringTask: string }>
    expect(listed.some((item) => item.name === 'help')).toBe(true)
    expect(listed.every((item) => typeof item.duringTask === 'string')).toBe(true)

    expect(() => h.service.runUiCommand('/model' as never)).toThrow(/不在桌面壳的命令清单里/)
    await expect(h.service.runUiCommand('/help' as never)).resolves.toBe('command-result')
    expect(h.writes['commandRun']?.at(-1)).toEqual(['/help', true])
  })
})

describe('设置分区与服务', () => {
  test('设置分区读写动作与模型端点操作都转发', async () => {
    const h = fakeCtx()
    expect(h.service.getSettingsSections()).toEqual([{ id: 'general' }])
    await expect(h.service.getSectionValues('general')).resolves.toEqual({ id: 'general', a: 1 })
    await expect(h.service.setSettingValue('general', 'k', 'v')).resolves.toMatchObject({ ok: true })
    expect(h.settings.save).toHaveBeenCalledWith('general', 'k', 'v')
    await expect(h.service.runSettingAction('general', 'add')).resolves.toMatchObject({ ok: true })
    expect(h.settings.action).toHaveBeenCalledWith('general', 'add')
    expect(h.service.getModelConfig()).toEqual({ providers: [] })

    await expect(h.service.saveProvider({ name: 'p' } as never)).resolves.toMatchObject({ ok: true })
    await expect(h.service.discoverModels('p')).resolves.toEqual(['m1', 'm2'])
    await expect(h.service.testConnection('p', 'm')).resolves.toEqual({ ok: true })
    await expect(h.service.removeProvider('p')).resolves.toMatchObject({ ok: true })
    await expect(h.service.setProviderKey('p', 'k')).resolves.toMatchObject({ ok: true })
    await expect(h.service.setDefaultModel('p', 'm')).resolves.toMatchObject({ ok: true })
    await expect(h.service.setConfigFile('C:/cfg.yaml')).resolves.toMatchObject({ ok: true })
  })

  test('会话库动作与用量统计转发', async () => {
    const h = fakeCtx()
    await h.service.refreshSessions()
    expect(h.session.refresh).toHaveBeenCalled()
    await expect(h.service.archiveSessions(['a'])).resolves.toMatchObject({ ok: true })
    expect(h.session.archive).toHaveBeenCalledWith(['a'])
    await expect(h.service.listArchivedSessions()).resolves.toMatchObject({ count: 0 })
    await expect(h.service.restoreSessions(['a'])).resolves.toMatchObject({ ok: true })
    await expect(h.service.purgeSessions(['a'])).resolves.toMatchObject({ ok: true })
    await expect(h.service.renameSession('a', '新名')).resolves.toMatchObject({ ok: true })
    expect(h.session.rename).toHaveBeenCalledWith('a', '新名')
    await expect(h.service.setSessionPinned('a', true)).resolves.toMatchObject({ ok: true })
    await expect(h.service.listUserMessages('a')).resolves.toEqual(['第一条', '第二条'])
    await expect(h.service.forkSession('a', 1)).resolves.toMatchObject({ ok: true })
    await expect(h.service.rewindSession('a', 1, '重说')).resolves.toMatchObject({ ok: true })
    expect(h.session.rewind).toHaveBeenCalledWith('a', 1, '重说')
    await expect(h.service.usageStats()).resolves.toHaveProperty('days')
  })

  test('界面偏好：高频静默补丁不回执，其余按改动项给一句话；市场源覆盖写偏好', async () => {
    const h = fakeCtx()
    expect(h.service.getUiPrefs()).toEqual({ sessionSort: 'recent' })

    await expect(h.service.setUiPrefs({ sessionOrder: ['a'] } as never)).resolves.toEqual({ ok: true })
    expect(h.writes['system']).toBeUndefined()
    await expect(h.service.setUiPrefs({ panelWidths: { side: 240 } } as never)).resolves.toEqual({ ok: true })
    await expect(h.service.setUiPrefs({ themeMode: 'dark' } as never)).resolves.toEqual({
      ok: true,
      notice: '已保存外观设置',
    })
    await expect(h.service.setUiPrefs({ processFold: 'compact' } as never)).resolves.toMatchObject({
      ok: true,
      notice: expect.stringContaining('紧凑'),
    })
    await expect(h.service.setUiPrefs({ sessionSort: 'created' } as never)).resolves.toMatchObject({
      ok: true,
      notice: expect.stringContaining('创建时间'),
    })

    expect(h.service.setMarketSources([{ id: 'a' }, { id: 'b' }] as never)).toEqual({
      ok: true,
      notice: '已保存 2 个市场源',
    })
    expect(h.settings.setPrefs).toHaveBeenCalledWith({ marketSources: [{ id: 'a' }, { id: 'b' }] })
  })
})

describe('旁问与收尾', () => {
  test('旁问成功：流式增量经事件转出，收尾发 done', async () => {
    const h = fakeCtx()
    const outcome = (await h.service.sideAsk('这是什么', '引用', 'rid-1', 'p', 'm')) as {
      text: string
      model: string
      stopped: boolean
    }
    expect(h.llm.routeTo).toHaveBeenCalledWith('p', 'm', 'default')
    expect(outcome).toMatchObject({ text: 'hel', model: 'm', stopped: false })
    expect(
      h.events.some(
        (item) => item.event === 'dsc/side-ask-chunk' && (item.args[0] as { delta: string }).delta === 'hel',
      ),
    ).toBe(true)
    expect(
      h.events.some(
        (item) =>
          item.event === 'dsc/side-ask-chunk' && (item.args[0] as { done?: boolean }).done === true,
      ),
    ).toBe(true)
  })

  test('同一票据可取消：正在跑的旁问以 stopped 收尾；不认识的票据返回 false', async () => {
    const h = fakeCtx()
    ;(h.llm.stream as ReturnType<typeof vi.fn>).mockImplementation(
      (_api: unknown, request: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    const running = h.service.sideAsk('问', '', 'rid-2', '', '') as Promise<{ stopped: boolean }>
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(h.service.sideAskCancel('rid-2')).resolves.toBe(true)
    await expect(running).resolves.toMatchObject({ stopped: true })
    await expect(h.service.sideAskCancel('unknown')).resolves.toBe(false)
  })

  test('审批应答与 dispose 转发；dispose 只发 dsc/exit 不退进程', async () => {
    const h = fakeCtx()
    h.service.answerApproval('allow-once' as never, 'web')
    expect(h.approval.answer).toHaveBeenCalledWith('allow-once', 'web')
    await h.service.dispose()
    expect(h.events.some((item) => item.event === 'dsc/exit')).toBe(true)
  })
})
