/**
 * subagent 装配面的分支补测（w11）：一次性小工的 list/stop/message 话术、设置分区的
 * 数值与 notify 保存、轮次预算取更严的那条、团队服务的 stop/message、任务板的
 * claim_now/set_dependencies/作用域提醒/板子提示词，以及审查通道的额度与「没在跑」分支。
 *
 * 复用 wiring.spec 的假 ctx 思路：真 `apply`、真写 `~/.dsc/agents` 与会话文件；模型端点
 * 换成直接返回一段文本。`DSC_HOME` 在 import 之前指进临时目录。
 *
 * @module dsc/packages/subagent/tests/w11-branches
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-subagent-w11-'))
process.env['DSC_HOME'] = HOME
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsc-subagent-w11-cwd-'))

type SessionT = import('../../../core/session.js').Session
type SessionModule = typeof import('../../../core/session.js')
type Plugin = typeof import('../index.js')['subagentPlugin']

interface CapturedTool {
  name: string
  risk: string
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>, runCtx: Record<string, unknown>) => Promise<string> | string
}
interface CapturedPrompt {
  id: string
  render: () => string
}
interface CapturedSection {
  id: string
  fields: () => Array<{ key?: string; action?: string; group?: string }>
  values: () => Record<string, unknown>
  save: (key: string, value: unknown) => string | void
  action: (name: string) => string
}
interface StreamResultLike {
  text: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  usage: { inputTokens: number; outputTokens: number } | null
  finishReason: string | null
}
interface Harness {
  tools: CapturedTool[]
  prompts: CapturedPrompt[]
  sections: CapturedSection[]
  services: Map<string, unknown>
  guards: Array<{ id: string; order: number; decide: (input: Record<string, unknown>) => Promise<unknown> }>
  systems: Array<{ text: string; sessionId?: string }>
  emitted: Array<Record<string, unknown>>
  followups: Array<{ text: string; sessionId?: string; origin?: string }>
  session: { meta: { id: string; cwd: string }; messages: Array<{ role: string; content: string }>; filePath: string }
  altSession: unknown
  setSession: (session: unknown) => void
  streamHandler: (api: string, request: { signal?: AbortSignal }, handlers: { onDelta?: (kind: 'text', text: string) => void }) => Promise<StreamResultLike>
  section: CapturedSection
  cleanup: () => void
}

const okStream = (text: string): StreamResultLike => ({
  text,
  reasoning: '',
  toolCalls: [],
  usage: { inputTokens: 2, outputTokens: 3 },
  finishReason: 'stop',
})

let plugin: Plugin
let SessionClass: SessionModule['Session']
const cleanups: Array<() => void> = []

beforeAll(async () => {
  SessionClass = (await import('../../../core/session.js')).Session
  plugin = (await import('../index.js')).subagentPlugin
})

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeJson(join(HOME, 'plugins.json'), { version: 1, entries: [] })
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {
      // 已经收过了
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 上可能还有句柄：临时目录留给系统清
  }
  try {
    rmSync(WORKSPACE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 同上
  }
})

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function roster(): Array<Record<string, unknown>> {
  try {
    const doc = JSON.parse(readFileSync(join(HOME, 'team', 'roster.json'), 'utf8')) as { teammates?: unknown }
    return Array.isArray(doc.teammates) ? (doc.teammates as Array<Record<string, unknown>>) : []
  } catch {
    return []
  }
}

async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

function newSession(): SessionT {
  const file = join(HOME, 'sessions', `w11-${String(Date.now())}-${String(Math.random()).slice(2)}.jsonl`)
  return SessionClass.create(WORKSPACE, file)
}

function fakeCtx(config?: Record<string, unknown>): Harness {
  const tools: CapturedTool[] = []
  const prompts: CapturedPrompt[] = []
  const sections: CapturedSection[] = []
  const services = new Map<string, unknown>()
  const guards: Harness['guards'] = []
  const systems: Harness['systems'] = []
  const emitted: Harness['emitted'] = []
  const followups: Harness['followups'] = []
  const effects: Array<() => void> = []
  const parent = newSession()
  cleanups.push(() => {
    try {
      parent.close()
    } catch {
      // 已经关了
    }
  })

  const harness = {
    streamHandler: async (_api: string, _request: unknown, handlers: { onDelta?: (kind: 'text', text: string) => void }) => {
      handlers.onDelta?.('text', '结论\n')
      return okStream('结论')
    },
  } as unknown as Harness

  const ctx = {
    session: { current: () => harness.session },
    tools: {
      register(entry: CapturedTool) {
        tools.push(entry)
        return () => {
          const index = tools.indexOf(entry)
          if (index >= 0) tools.splice(index, 1)
        }
      },
      list: () => tools,
    },
    prompt: {
      register(id: string, render: () => string) {
        const item = { id, render }
        prompts.push(item)
        return () => {
          const index = prompts.indexOf(item)
          if (index >= 0) prompts.splice(index, 1)
        }
      },
    },
    settings: {
      about: () => ({ home: HOME }),
      registerSection(spec: CapturedSection) {
        sections.push(spec)
        return () => undefined
      },
    },
    provide(name: string, service: unknown) {
      services.set(name, service)
    },
    effect(execute: () => unknown) {
      const off = execute()
      if (typeof off === 'function') effects.push(off as () => void)
      return () => {
        if (typeof off === 'function') (off as () => void)()
      }
    },
    transcript: {
      touch: () => undefined,
      emit: (event: Record<string, unknown>) => {
        emitted.push(event)
      },
      system: (text: string, _a?: unknown, _b?: unknown, sessionId?: string) => {
        systems.push({ text, ...(sessionId === undefined ? {} : { sessionId }) })
      },
    },
    llm: {
      model: 'fake/model',
      routeForSession: () => ({ api: 'fake', baseUrl: 'http://fake', apiKey: 'k', model: 'fake/model' }),
      routeTo: () => ({ api: 'fake', baseUrl: 'http://fake', apiKey: 'k', model: 'fake/model' }),
      stream: (api: string, request: unknown, handlers: { onDelta?: (kind: 'text', text: string) => void }) =>
        harness.streamHandler(api, request as { signal?: AbortSignal }, handlers),
    },
    approval: { decide: async () => 'allow-once' },
    guards: {
      register(guard: Harness['guards'][number]) {
        guards.push(guard)
        return () => undefined
      },
      registerSessionResolver() {
        return () => undefined
      },
      gate: async () => ({ action: 'defer' }),
      observe: () => undefined,
    },
    agent: {
      sessionById: (id: string) => {
        if (harness.session.meta.id === id) return harness.session
        const alt = harness.altSession as { meta: { id: string } } | undefined
        return alt !== undefined && alt.meta.id === id ? alt : undefined
      },
      hasAgent: () => false,
      followup: (text: string, _images?: unknown, sessionId?: string, origin?: string) => {
        followups.push({ text, ...(sessionId === undefined ? {} : { sessionId }), ...(origin === undefined ? {} : { origin }) })
      },
    },
  }

  for (const name of ['read', 'glob', 'grep']) {
    tools.push({ name, risk: 'read', parameters: {}, run: () => name })
  }
  harness.tools = tools
  harness.prompts = prompts
  harness.sections = sections
  harness.services = services
  harness.guards = guards
  harness.systems = systems
  harness.emitted = emitted
  harness.followups = followups
  harness.session = parent as unknown as Harness['session']
  harness.altSession = undefined
  harness.setSession = (session: unknown) => {
    harness.session = session as Harness['session']
  }
  const apply = plugin.apply as unknown as (context: unknown, passed?: unknown) => (() => void) | void
  const returned = apply(ctx, config)
  harness.cleanup = () => {
    if (typeof returned === 'function') returned()
    for (const off of effects.splice(0)) off()
  }
  cleanups.push(harness.cleanup)
  harness.section = sections[0] as CapturedSection
  return harness
}

function tool(harness: Harness, name: string): CapturedTool {
  const found = harness.tools.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`没有注册 ${name} 工具`)
  return found
}

const TASK = '统计仓库里有多少个测试文件并给出结论，附证据位置'

function runSubagent(harness: Harness, args: Record<string, unknown>): Promise<string> | string {
  return tool(harness, 'subagent').run(args, {
    cwd: WORKSPACE,
    signal: new AbortController().signal,
    sessionId: harness.session.meta.id,
  })
}

function runBoard(harness: Harness, args: Record<string, unknown>): Promise<string> | string {
  return tool(harness, 'team_task').run(args, {
    cwd: WORKSPACE,
    signal: new AbortController().signal,
    sessionId: harness.session.meta.id,
  })
}

// ── 模型侧工具：一次性小工与话术 ─────────────────────────────────────────────

test('一次性小工：list 标「一次性」，收工后 stop/message 都给出同一句实话', async () => {
  const harness = fakeCtx()
  const text = String(
    await runSubagent(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, keep: false, name: 'one-shot-1' }),
  )
  expect(text).toContain('一次性')

  await until(() => roster().some((entry) => entry.name === 'one-shot-1' && entry.state !== 'working'))
  const listed = String(await runSubagent(harness, { action: 'list' }))
  // 一次性小工收工后已从在队表摘掉，list 只报「没有在队」。
  expect(listed).toContain('没有在队')
  expect(roster().some((entry) => entry.name === 'one-shot-1' && entry.mode === 'one-shot')).toBe(true)

  expect(String(await runSubagent(harness, { action: 'stop', name: 'one-shot-1' }))).toContain('已经结束了')
  expect(String(await runSubagent(harness, { action: 'message', name: 'one-shot-1', text: '还在吗' }))).toContain('不再接后续消息')
})

test('同名队友被拒；传话给不存在的名字写进信箱并说明没人读', async () => {
  const harness = fakeCtx()
  harness.streamHandler = () => new Promise(() => undefined)
  const first = String(await runSubagent(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'dup-name' }))
  expect(first).toContain('已派给 dup-name')
  const second = String(await runSubagent(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'dup-name' }))
  expect(second).toContain('已经在用')

  const ghost = String(await runSubagent(harness, { action: 'message', name: 'ghost', text: '在吗' }))
  expect(ghost).toContain('没人会读')
})

test('进程内切走当前会话：后台队友的卡片不往别的会话转发', async () => {
  const harness = fakeCtx()
  harness.streamHandler = () => new Promise(() => undefined)
  const other = newSession()
  cleanups.push(() => {
    try {
      other.close()
    } catch {
      // 已经关了
    }
  })
  harness.setSession(other)
  // 当前查看的是 other，但这次派活归属另一条会话：卡片不该折进 other 的转录。
  const parent = newSession()
  cleanups.push(() => {
    try {
      parent.close()
    } catch {
      // 已经关了
    }
  })
  harness.setSession(parent)
  harness.altSession = other
  await tool(harness, 'subagent').run(
    { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'elsewhere-1' },
    { cwd: WORKSPACE, signal: new AbortController().signal, sessionId: other.meta.id },
  )
  expect(harness.emitted.some((event) => event['type'] === 'subagent')).toBe(false)
})

// ── 设置分区 ─────────────────────────────────────────────────────────────────

test('设置保存：数值夹取、notify 归一、授权模型校验与未知键', () => {
  const harness = fakeCtx()
  const section = harness.section
  section.save('maxTeammates', '20')
  section.save('maxDepth', '-1')
  section.save('maxTurns', '5')
  section.save('notify', 'quiet')
  expect(section.values()).toMatchObject({ maxTeammates: 8, maxDepth: 0, maxTurns: 5, notify: 'quiet' })

  // 2026-11：defaultModel 文本框已从界面移除（旧配置仍兼容读取，但设置键不再接受写入）
  expect(String(section.save('defaultModel', 'fake/model'))).toMatch(/没有这项/)
  expect('defaultModel' in section.values(), 'defaultModel 不该再出现在设置值里').toBe(false)

  // 授权模型：开关开着但清单为空必须拒；勾选后才能开；开着时清空也要拒
  expect(String(section.save('allowModelSelection', true))).toMatch(/至少选择一个模型/)
  expect(section.values()['allowModelSelection']).toBe(false)
  expect(section.save('allowedModels', ['fake/model', 'fake/other'])).toBeUndefined()
  expect(section.save('allowModelSelection', true)).toBeUndefined()
  expect(section.values()).toMatchObject({
    allowModelSelection: true,
    allowedModels: ['fake/model', 'fake/other'],
  })
  expect(String(section.save('allowedModels', []))).toMatch(/至少选择一个模型/)
  expect(section.values()['allowedModels'], '保存失败不改原值').toStrictEqual(['fake/model', 'fake/other'])

  expect(String(section.save('unknownKey', 1))).toMatch(/unknown|未知|没有这项/i)
  section.save('allowDelegation', false)
  section.save('board', false)
  expect(section.values()).toMatchObject({ allowDelegation: false, board: false })

  // 团队模式：打开 = 允许二层派活，顺手把刚才夹到 0 的递归层级抬到 2；关闭不回退
  expect(section.save('teamMode', true)).toBeUndefined()
  expect(section.values()).toMatchObject({ teamMode: true, maxDepth: 2 })
  expect(section.save('teamMode', false)).toBeUndefined()
  expect(section.values()).toMatchObject({ teamMode: false, maxDepth: 2 })
})

test('轮次预算取角色与插件设置中更严的那个（角色默认轮次也生效）', () => {
  // 角色默认：writer 128 轮 / pm 48 轮；插件全局设 2 轮时一律压到 2
  const defaults = fakeCtx()
  const defaultPrompt = defaults.prompts.find((entry) => entry.id === 'subagent')?.render() ?? ''
  expect(defaultPrompt).toContain('最多 128 轮')
  expect(defaultPrompt).toContain('最多 48 轮')
  expect(defaultPrompt).toContain('轮次不限')

  const harness = fakeCtx({ maxTurns: 2 })
  const prompt = harness.prompts.find((entry) => entry.id === 'subagent')
  expect(prompt).toBeDefined()
  // 全局 2 轮比角色默认 128 更严：提示词里应当报 2 轮。
  expect(prompt!.render()).toContain('最多 2 轮')
})

// ── 团队服务 ─────────────────────────────────────────────────────────────────

test('团队服务：stop/message 不存在的人、remove 也不存在的人都有可读回执', async () => {
  const harness = fakeCtx()
  const team = harness.services.get('team') as {
    stop: (name: string) => Promise<string>
    message: (name: string, text: string) => Promise<string>
    remove: (name: string) => Promise<string>
  }
  expect(await team.stop('ghost')).toContain('没有叫 ghost')
  expect(await team.message('ghost', '你好')).toContain('没人会读')
  expect(await team.remove('ghost')).toContain('名册里没有')
  expect(await team.message('ghost', '   ')).toContain('要带上 text')
})

// ── 任务板 ───────────────────────────────────────────────────────────────────

test('任务板：作用域重叠提醒、claim_now 依赖未完成、set_dependencies、get 不存在与板子提示词', async () => {
  const harness = fakeCtx()
  const created = String(await runBoard(harness, { action: 'create', subject: '第一条', write_scopes: ['src/a'] }))
  expect(created).toContain('已建')

  const warned = String(await runBoard(harness, { action: 'create', subject: '第二条', write_scopes: ['src/a'] }))
  expect(warned).toContain('提醒')
  expect(warned).toContain('重叠')

  const blocked = String(
    await runBoard(harness, { action: 'create', subject: '第三条', blocked_by: ['t1'], claim_now: true }),
  )
  expect(blocked).toContain('但没能认领')

  const list = String(await runBoard(harness, { action: 'list' }))
  const revision = Number(/第 (\d+) 版/.exec(list)?.[1] ?? 0)
  expect(revision).toBeGreaterThan(0)

  const got = String(await runBoard(harness, { action: 'get', id: 't999' }))
  expect(got).toContain('没有 t999')

  const deps = String(
    await runBoard(harness, { action: 'set_dependencies', id: 't1', blocked_by: [], expected_revision: revision }),
  )
  expect(deps).toContain('t1 →')

  // 板上已经有任务：板子提示段应当列出它们，而不是「板上还没有任务」。
  const boardPrompt = harness.prompts.find((entry) => entry.id === 'team')
  expect(boardPrompt).toBeDefined()
  expect(boardPrompt!.render()).toContain('第一条')
})

test('任务板：不认识的 action 与缺版本号都给人话', async () => {
  const harness = fakeCtx()
  expect(String(await runBoard(harness, { action: 'nope' }))).toContain('不认识的 action')
  expect(String(await runBoard(harness, { action: 'claim', id: 't1' }))).toContain('expected_revision')
})

// ── 审查通道 ─────────────────────────────────────────────────────────────────

const scope = {
  target: { kind: 'worktree' as const },
  label: '未提交改动',
  diffPath: join(WORKSPACE, 'review.diff'),
  diffBytes: 12,
  stat: ' a.ts | 1 +',
  untracked: [] as string[],
}

test('审查通道：并发额度满时如实拒绝；没有在跑的审查时 cancel 返回 false', async () => {
  const harness = fakeCtx({ maxTeammates: 1 })
  harness.streamHandler = () => new Promise(() => undefined)
  await runSubagent(harness, { action: 'spawn', role: 'explorer', task: TASK, background: true, name: 'busy-1' })

  const review = harness.services.get('review') as {
    spawn: (request: unknown) => { ok: boolean; reason?: string }
    cancel: () => boolean
  }
  const spawned = review.spawn({ scope, focus: '' })
  expect(spawned.ok).toBe(false)
  expect(String(spawned.reason)).toContain('上限')
  expect(review.cancel()).toBe(false)
})
