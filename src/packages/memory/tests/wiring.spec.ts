/**
 * memory 插件装配面（`packages/memory/index.ts`）：工具 / 提示段 / 命令 / 设置分区 / 服务，
 * 以及真落盘的读写、去重、替换删除、额度、外部改动容错、自动复盘与注入计数。
 *
 * `DSC_HOME` 在任何 import 之前指向临时目录：三格记忆、`.usage.json`、`.eval.json`
 * 都在那里。每个用例的 workspace 单独一个临时目录，global/user 两格跨用例共用，
 * 因此断言只认本用例写进去的独有文本。
 *
 * @module dsc/packages/memory/tests/wiring.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-memory-wiring-'))
process.env['DSC_HOME'] = HOME

type Plugin = typeof import('../index.js')['memoryPlugin']

interface CapturedTool {
  name: string
  description: string
  risk: string
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>, scope: Record<string, unknown>) => Promise<string>
}

interface CapturedPrompt {
  id: string
  render: () => string
  options?: Record<string, unknown>
}

interface CapturedProjection {
  id: string
  apply: (
    messages: Array<{ role: string; content: string }>,
    session?: unknown,
    report?: (view: Record<string, unknown>) => void,
  ) => Array<{ role: string; content: string }>
  options?: Record<string, unknown>
}

interface CapturedCommand {
  spec: { name: string; args?: string; description?: string }
  run: (input: { args: string[]; ui: { notice: (text: string) => void } }) => void
}

interface CapturedSection {
  id: string
  order?: number
  fields: () => Array<{ type?: string; key?: string; action?: string; group?: string }>
  values: () => Record<string, unknown>
  save: (key: string, value: unknown) => string | void
  action: (name: string) => string | void
}

interface MemoryCellView {
  target: string
  entries: string[]
  used: number
  limit: number
  problem: string
  filePath: string
}

interface MemoryServiceLike {
  cells: (at?: string) => MemoryCellView[]
  config: () => Record<string, unknown>
  write: (ops: Array<Record<string, unknown>>, at?: string) => { ok: boolean; error: string; notes: string[]; cells: MemoryCellView[] }
  snapshot: () => string
  refresh: () => string
  prune: (target?: string) => string
}

interface Harness {
  ctx: Record<string, unknown>
  tools: CapturedTool[]
  prompts: CapturedPrompt[]
  projections: CapturedProjection[]
  /** 落进会话状态（`appendState`）的记录：留底改成哈希去重后只该随正文变化增长。 */
  states: Array<{ id: string; payload: unknown }>
  commands: CapturedCommand[]
  sections: CapturedSection[]
  service: MemoryServiceLike
  section: CapturedSection
  notices: string[]
  emitted: Array<{ event: string; text?: string }>
  followups: string[]
  decisions: Array<Record<string, unknown>>
  handlers: Map<string, (reason?: string, signal?: { sessionId?: string }) => void>
  session: {
    meta: { id: string; cwd: string }
    messages: Array<{ role: string; content: string }>
    state: (id: string) => unknown
    appendState: (id: string, payload: unknown) => void
  }
  setCwd: (cwd: string) => void
  setMessages: (messages: Array<{ role: string; content: string }>) => void
  decision: 'allow-once' | 'reject'
  cleanup: () => void
}

let plugin: Plugin
const cleanups: Array<() => void> = []
const dirs: string[] = [HOME]

beforeAll(async () => {
  plugin = (await import('../index.js')).memoryPlugin
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
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 })
    } catch {
      // Windows 上可能还有句柄：临时目录留给系统清。
    }
  }
})

beforeEach(() => {
  writeJson(join(HOME, 'plugins.json'), { version: 1, entries: [] })
})

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 把 memory 这一条配置写进临时 plugins.json（插件 apply 时现读）。 */
function writeConfig(config: Record<string, unknown>): void {
  writeJson(join(HOME, 'plugins.json'), {
    version: 1,
    entries: [{ file: 'memory', disabled: false, config }],
  })
}

/** 每个用例一个独立 workspace：workspace 那一格互不污染。 */
function newWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-memory-cwd-'))
  dirs.push(dir)
  return dir
}

/** 假 ctx：apply 用到的面全实现，`effect` 真跑回调，事件处理器收下供用例触发。 */
function fakeCtx(options: { decision?: 'allow-once' | 'reject'; cwd?: string } = {}): Harness {
  const tools: CapturedTool[] = []
  const prompts: CapturedPrompt[] = []
  const projections: CapturedProjection[] = []
  const states: Array<{ id: string; payload: unknown }> = []
  const stateMap = new Map<string, unknown>()
  const commands: CapturedCommand[] = []
  const sections: CapturedSection[] = []
  const notices: string[] = []
  const emitted: Harness['emitted'] = []
  const followups: string[] = []
  const decisions: Harness['decisions'] = []
  const handlers: Harness['handlers'] = new Map()
  const effects: Array<() => void> = []

  const harness = {
    decision: options.decision ?? 'allow-once',
  } as unknown as Harness
  harness.session = {
    meta: { id: 'mem-session', cwd: options.cwd ?? newWorkspace() },
    messages: [],
    state: (id: string) => stateMap.get(id),
    appendState: (id: string, payload: unknown) => {
      stateMap.set(id, payload)
      states.push({ id, payload })
    },
  }

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
    },
    prompt: {
      register(id: string, render: () => string, opts?: Record<string, unknown>) {
        prompts.push({ id, render, ...(opts === undefined ? {} : { options: opts }) })
        return () => undefined
      },
      registerProjection(
        id: string,
        apply: CapturedProjection['apply'],
        opts?: Record<string, unknown>,
      ) {
        projections.push({ id, apply, ...(opts === undefined ? {} : { options: opts }) })
        return () => undefined
      },
    },
    commands: {
      register(spec: CapturedCommand['spec'], run: CapturedCommand['run']) {
        commands.push({ spec, run })
        return () => undefined
      },
    },
    settings: {
      registerSection(spec: CapturedSection) {
        sections.push(spec)
        return () => undefined
      },
    },
    approval: {
      decide: async (request: Record<string, unknown>) => {
        decisions.push(request)
        return harness.decision
      },
    },
    agent: {
      followup: (text: string) => {
        followups.push(text)
      },
    },
    transcript: { system: () => undefined },
    effect(execute: () => unknown) {
      const off = execute()
      if (typeof off === 'function') effects.push(off as () => void)
      return () => {
        if (typeof off === 'function') (off as () => void)()
      }
    },
    on(event: string, handler: Harness['handlers'] extends Map<string, infer F> ? F : never) {
      handlers.set(event, handler as never)
      return () => undefined
    },
    emit(event: string, text?: string) {
      emitted.push({ event, ...(text === undefined ? {} : { text }) })
    },
    provide(_name: string, service: MemoryServiceLike) {
      harness.service = service
    },
  }

  harness.ctx = ctx
  harness.tools = tools
  harness.prompts = prompts
  harness.projections = projections
  harness.states = states
  harness.commands = commands
  harness.sections = sections
  harness.notices = notices
  harness.emitted = emitted
  harness.followups = followups
  harness.decisions = decisions
  harness.handlers = handlers
  harness.setCwd = (cwd: string) => {
    harness.session.meta.cwd = cwd
  }
  harness.setMessages = (messages: Array<{ role: string; content: string }>) => {
    harness.session.messages = messages
  }

  const apply = plugin.apply as unknown as (context: unknown) => (() => void) | void
  const returned = apply(ctx)
  const cleanup = (): void => {
    if (typeof returned === 'function') returned()
    for (const off of effects.splice(0)) off()
  }
  harness.cleanup = cleanup
  cleanups.push(cleanup)
  harness.section = sections[0] as CapturedSection
  return harness
}

function memoryTool(harness: Harness): CapturedTool {
  const tool = harness.tools.find((entry) => entry.name === 'memory')
  expect(tool, 'apply 应当注册 memory 工具').toBeDefined()
  return tool as CapturedTool
}

function runTool(harness: Harness, args: Record<string, unknown>): Promise<string> {
  return memoryTool(harness).run(args, {
    cwd: harness.session.meta.cwd,
    sessionId: harness.session.meta.id,
    sessionPath: '',
    signal: new AbortController().signal,
  })
}

function runCommand(harness: Harness, args: string[]): string[] {
  const command = harness.commands.find((entry) => entry.spec.name === 'memory')
  expect(command, '/memory 命令应当注册').toBeDefined()
  const said: string[] = []
  command!.run({ args, ui: { notice: (text: string) => said.push(text) } })
  return said
}

/** 跑一次尾部投影（memory-index）；返回追加的那条 user 消息正文，没注入时 undefined。 */
function tail(harness: Harness): string | undefined {
  const projection = harness.projections.find((entry) => entry.id === 'memory-index')
  expect(projection, '缺 memory-index 投影').toBeDefined()
  const messages = [{ role: 'system', content: '系统提示' }, ...harness.session.messages]
  const out = projection!.apply(messages)
  if (out.length === messages.length) return undefined
  const last = out.at(-1)
  return last?.role === 'user' ? String(last.content) : undefined
}

function globalFile(): string {
  return join(HOME, 'memory', 'global', 'MEMORY.md')
}

/** 某一格的真实文件路径：workspaceKey 过长会带哈希，不自己拼。 */
function cellFile(harness: Harness, target: string): string {
  const cell = harness.service.cells().find((item) => item.target === target)
  expect(cell, `没有 ${target} 这一格`).toBeDefined()
  return cell!.filePath
}

function readUsageFile(): Record<string, { count: number; injected?: number }> {
  try {
    return JSON.parse(readFileSync(join(HOME, 'memory', '.usage.json'), 'utf8')) as Record<
      string,
      { count: number; injected?: number }
    >
  } catch {
    return {}
  }
}

describe('注册面', () => {
  test('工具、提示段、命令、设置分区与服务都挂上了', () => {
    const harness = fakeCtx()
    const tool = memoryTool(harness)
    expect(tool.risk).toBe('write')
    expect(tool.parameters['required']).toBeUndefined()
    expect(harness.prompts.map((prompt) => prompt.id)).toEqual(['memory'])
    expect(harness.prompts[0]?.options).toMatchObject({ order: 60 })
    // 2026-11 P0：记忆索引正文不再并进 agents-md 块，改由尾部投影（order 610）追加。
    expect(harness.prompts[0]?.options?.['block']).toBeUndefined()
    expect(harness.projections.map((projection) => projection.id)).toEqual(['memory-index'])
    expect(harness.projections[0]?.options).toMatchObject({ order: 610 })
    expect(harness.commands.map((command) => command.spec.name)).toEqual(['memory'])
    expect(String(harness.commands[0]?.spec.args)).toContain('eval')
    expect(harness.sections[0]).toMatchObject({ id: 'memory', order: 35 })
    expect(typeof harness.service.cells).toBe('function')
    expect(harness.service.config()).toMatchObject({ enabled: true, reviewEveryTurns: 10, pruneAfterDays: 60 })
    expect([...(plugin.inject as string[])]).toEqual([
      'session',
      'tools',
      'prompt',
      'approval',
      'agent',
      'commands',
      'transcript',
      'settings',
    ])
  })

  test('设置分区字段覆盖总开关、三格额度、复盘、整理与条目操作', () => {
    const harness = fakeCtx()
    const fields = harness.section.fields()
    const keys = fields.map((field) => field.key ?? field.action ?? field.type)
    for (const key of [
      'enabled',
      'userProfile',
      'workspace',
      'globalLimit',
      'userLimit',
      'workspaceLimit',
      'writeApproval',
      'reviewEnabled',
      'reviewEveryTurns',
      'pruneEnabled',
      'pruneAfterDays',
      'cell',
      'entry',
      'search',
      'clearArmed',
      'pruneNow',
      'evalReport',
      'entryDelete',
      'cellClear',
      'refresh',
    ]) {
      expect(keys, `设置分区缺 ${key}`).toContain(key)
    }
    expect(harness.section.values()).toMatchObject({
      enabled: true,
      userProfile: true,
      workspace: true,
      globalLimit: 2200,
      userLimit: 1375,
      workspaceLimit: 2200,
      reviewEveryTurns: 10,
      pruneAfterDays: 60,
      cell: 'global',
      entry: '',
      search: '',
      clearArmed: false,
    })
  })
})

describe('工具写入与读回', () => {
  test('add 真落盘、快照立刻更新、尾部投影带过期提醒且两次调用逐字相同', async () => {
    const harness = fakeCtx()
    const content = `本仓库使用 pnpm-${String(Date.now())}`
    const result = await runTool(harness, { target: 'memory', action: 'add', content })
    expect(result).toContain('全局事实记忆已更新')
    expect(result).toContain(content)
    expect(readFileSync(globalFile(), 'utf8')).toContain(content)
    expect(harness.service.cells().find((cell) => cell.target === 'global')?.entries).toContain(content)

    const first = tail(harness)
    expect(first).toContain(content)
    expect(first).toContain('记忆副本已过期')
    // 尾消息最后一行是固定标记句（P1 靠它排除合成的 user 消息）。
    expect(first?.split('\n').at(-1)).toBe('（本条是程序自动附上的，不是用户发言）')
    // 留底按正文哈希去重：同一段正文只落一条会话状态。
    expect(harness.states.filter((item) => item.id === 'memory-index')).toHaveLength(1)
    // 投影链对同一请求会跑两遍（真请求 + invariant 重建）：必须逐字相同，且不追写状态。
    expect(tail(harness)).toBe(first)
    expect(harness.states.filter((item) => item.id === 'memory-index'), '同正文不追写').toHaveLength(1)
    // 回合结束才清掉提醒；索引本身仍在。提醒消失 = 正文变了，再落一条状态。
    harness.handlers.get('dsc/turn-end')?.('completed')
    const after = tail(harness)
    expect(after).toContain(content)
    expect(after).not.toContain('记忆副本已过期')
    expect(harness.states.filter((item) => item.id === 'memory-index'), '正文变了再落一条').toHaveLength(2)
  })

  test('别名归一：memory/global/project 都落全局，profile 落用户，cwd 落工作区', async () => {
    const harness = fakeCtx()
    const suffix = String(Date.now())
    expect(await runTool(harness, { target: 'project', action: 'add', content: `项目事实${suffix}` })).toContain(
      '全局事实记忆已更新',
    )
    expect(await runTool(harness, { target: 'profile', action: 'add', content: `用户偏好${suffix}` })).toContain(
      '用户偏好记忆已更新',
    )
    expect(await runTool(harness, { target: 'cwd', action: 'add', content: `工作区事实${suffix}` })).toContain(
      '本工作区记忆已更新',
    )
    expect(readFileSync(globalFile(), 'utf8')).toContain(`项目事实${suffix}`)
    expect(readFileSync(join(HOME, 'memory', 'global', 'USER.md'), 'utf8')).toContain(`用户偏好${suffix}`)
    expect(readFileSync(cellFile(harness, 'workspace'), 'utf8')).toContain(`工作区事实${suffix}`)
  })

  test('参数不合法整批拒绝，并把合法形状回吐', async () => {
    const harness = fakeCtx()
    expect(
      String(await runTool(harness, { operations: [{ target: 'nope', action: 'add', content: 'x' }] })),
    ).toContain('operations 里每一项都得是')
    expect(String(await runTool(harness, { target: 'global', action: 'dance', content: 'x' }))).toContain(
      '要给出 action',
    )
    expect(String(await runTool(harness, { target: 'global', action: 'add', content: '   ' }))).toContain(
      '新增记忆得给出内容',
    )
  })

  test('去重、替换、删除与「命中多条」都按条目文本判定', async () => {
    const harness = fakeCtx()
    const tag = `唯一${String(Date.now())}`
    expect(await runTool(harness, { target: 'global', action: 'add', content: `${tag}甲` })).toContain('已记下')
    expect(await runTool(harness, { target: 'global', action: 'add', content: `${tag}甲` })).toContain(
      '这一条已经在了',
    )
    expect(
      await runTool(harness, { target: 'global', action: 'replace', old_text: `${tag}甲`, content: `${tag}乙` }),
    ).toContain('已改写')
    const stored = readFileSync(globalFile(), 'utf8')
    expect(stored).toContain(`${tag}乙`)
    expect(stored).not.toContain(`${tag}甲`)

    expect(
      String(await runTool(harness, { target: 'global', action: 'replace', old_text: '根本没有这条', content: 'x' })),
    ).toContain('没有找到')
    expect(String(await runTool(harness, { target: 'global', action: 'remove', old_text: '  ' }))).toContain(
      '要说清楚动的是哪一条',
    )

    await runTool(harness, { target: 'global', action: 'add', content: `${tag}重复词A` })
    await runTool(harness, { target: 'global', action: 'add', content: `${tag}重复词B` })
    expect(
      String(await runTool(harness, { target: 'global', action: 'replace', old_text: `${tag}重复词`, content: 'x' })),
    ).toContain('2 条记忆里都出现了')

    expect(await runTool(harness, { target: 'global', action: 'remove', old_text: `${tag}乙` })).toContain('已删掉')
  })

  test('额度：单条超限与总量超限都整次拒绝，连续三次给停机话术', async () => {
    writeConfig({ workspaceLimit: 60 })
    const harness = fakeCtx()
    const tooLong = 'A'.repeat(70)
    const first = await runTool(harness, { target: 'workspace', action: 'add', content: tooLong })
    expect(first).toContain('这一格总共只有 60 字额度')
    expect(existsSync(cellFile(harness, 'workspace'))).toBe(false)

    expect(await runTool(harness, { target: 'workspace', action: 'add', content: 'A'.repeat(30) })).toContain('已记下')
    const over = await runTool(harness, { target: 'workspace', action: 'add', content: 'B'.repeat(40) })
    expect(over).toContain('超过 60 字额度')
    // 写成功会把失败计数清零，所以这里连着撞三次。
    expect(await runTool(harness, { target: 'workspace', action: 'add', content: 'C'.repeat(70) })).not.toContain(
      '这是这一轮第三次没写进去',
    )
    const third = await runTool(harness, { target: 'workspace', action: 'add', content: 'D'.repeat(70) })
    expect(third).toContain('这是这一轮第三次没写进去')
    const fourth = await runTool(harness, { target: 'workspace', action: 'add', content: 'E'.repeat(70) })
    expect(fourth).toContain('这一轮已经连着几次写不进记忆了')
  })

  test('关掉的分区与总开关都拒绝写入；cells 只返回启用的格子', async () => {
    writeConfig({ userProfile: false })
    const harness = fakeCtx()
    expect(
      String(await runTool(harness, { target: 'user', action: 'add', content: '不该写进用户格' })),
    ).toContain('这些记忆分区在设置里是关着的')
    expect(harness.service.cells().map((cell) => cell.target)).toEqual(['global', 'workspace'])

    writeConfig({ enabled: false })
    const off = fakeCtx()
    expect(String(await runTool(off, { target: 'global', action: 'add', content: 'x' }))).toContain(
      '长期记忆现在是关着的',
    )
    expect(off.service.snapshot()).toBe('')
  })

  test('写入审批：拒绝时不落盘，批准时照常写', async () => {
    writeConfig({ writeApproval: true })
    const harness = fakeCtx({ decision: 'reject' })
    const content = `审批测试${String(Date.now())}`
    expect(await runTool(harness, { target: 'global', action: 'add', content })).toContain('用户没有批这次记忆写入')
    expect(readFileSync(globalFile(), 'utf8')).not.toContain(content)
    expect(harness.decisions[0]).toMatchObject({ toolName: 'memory', sessionId: 'mem-session' })

    harness.decision = 'allow-once'
    expect(await runTool(harness, { target: 'global', action: 'add', content })).toContain('记忆已更新')
    expect(readFileSync(globalFile(), 'utf8')).toContain(content)
  })

  test('外部改动容错：读路径报 problem，写入被拦下并留副本', async () => {
    const harness = fakeCtx()
    const tag = `外部${String(Date.now())}`
    await runTool(harness, { target: 'workspace', action: 'add', content: `${tag}原始条目` })
    const file = cellFile(harness, 'workspace')
    // 第一次外部改动：读路径发现并留副本（这一轮只读不写，下次以现状为基准）。
    writeFileSync(file, `${tag}原始条目\n§\n外面直接写进来的一条\n`, 'utf8')
    const cell = harness.service.cells().find((item) => item.target === 'workspace')
    expect(cell?.problem).toContain('被外面改动过')
    expect(cell?.entries).toContain('外面直接写进来的一条')

    // 基准刚认过又被外面改：写入这一瞬再发现一次，必须整次拒绝。
    writeFileSync(file, `${tag}原始条目\n§\n外面又改了一次\n`, 'utf8')
    const blocked = await runTool(harness, { target: 'workspace', action: 'add', content: '工具不该盖掉它' })
    expect(blocked).toContain('被外面改动过')
    expect(readFileSync(file, 'utf8')).toContain('外面又改了一次')
    expect(readFileSync(file, 'utf8')).not.toContain('工具不该盖掉它')
  })
})

describe('提示词、注入计数与自动复盘', () => {
  test('提示词快照包含新条目；注入计数按回合去重', async () => {
    const harness = fakeCtx()
    const tag = `注入${String(Date.now())}`
    for (let index = 1; index <= 4; index += 1) {
      await runTool(harness, { target: 'global', action: 'add', content: `${tag}-条目${String(index)}` })
    }
    const before = readUsageFile()
    const injectedText = tail(harness)
    expect(injectedText).toContain(`${tag}-条目1`)
    // 同一回合里重复组装：注入计数只记一次。
    tail(harness)
    const first = readUsageFile()
    const bumped = Object.keys(first).filter(
      (key) => (first[key]!.injected ?? 0) === ((before[key]?.injected ?? 0) + 1),
    )
    expect(bumped.length, '这一回合至少有一条条目真的进了提示词').toBeGreaterThan(0)

    harness.handlers.get('dsc/turn-end')?.('completed')
    tail(harness)
    const second = readUsageFile()
    for (const key of bumped) {
      expect(second[key]?.injected ?? 0, `${key} 下一回合应再记一次`).toBe((first[key]?.injected ?? 0) + 1)
    }
  })

  test('回话复述到条目：记一次引用；短应答不触发自动复盘', async () => {
    const harness = fakeCtx()
    const body = `这条记忆会在回话里被复述用于测试-${String(Date.now())}`
    await runTool(harness, { target: 'global', action: 'add', content: body })
    harness.setMessages([
      { role: 'user', content: '继续' },
      { role: 'assistant', content: `我查过了，${body.slice(0, 12)} 是这么回事` },
    ])
    harness.handlers.get('dsc/turn-end')?.('completed')
    const counts = Object.values(readUsageFile()).map((record) => record.count)
    expect(Math.max(...counts)).toBeGreaterThan(0)
    expect(harness.followups).toHaveLength(0)
  })

  test('自动复盘：到点叫醒一轮，且那一轮只准 add', async () => {
    writeConfig({ reviewEveryTurns: 1 })
    const harness = fakeCtx()
    harness.setMessages([{ role: 'user', content: '请把这个仓库的构建方式记住' }])
    harness.handlers.get('dsc/turn-end')?.('completed')
    expect(harness.followups).toHaveLength(1)
    expect(harness.followups[0]).toContain('【记忆复盘】')

    expect(
      String(await runTool(harness, { target: 'global', action: 'remove', old_text: '随便什么' })),
    ).toContain('只准 add')

    harness.handlers.get('dsc/turn-end')?.('completed')
    expect(harness.followups).toHaveLength(1)
  })
})

describe('/memory 命令', () => {
  test('show / refresh / eval / prune 各有输出与校验', async () => {
    writeConfig({ pruneAfterDays: 0 })
    const harness = fakeCtx()
    const tag = `整理${String(Date.now())}`
    await runTool(harness, { target: 'workspace', action: 'add', content: `${tag}陈旧条目` })

    expect(runCommand(harness, []).join('\n')).toContain('长期记忆（注入给模型的栏位')
    expect(runCommand(harness, ['refresh']).join('\n')).toContain('记忆栏已重新算了一份')
    expect(runCommand(harness, ['eval']).join('\n')).toContain('记忆评估：')

    expect(runCommand(harness, ['prune', 'nope']).join('\n')).toContain('要说清整理哪一格')
    const pruned = runCommand(harness, ['prune', 'workspace']).join('\n')
    expect(pruned).toContain('整理完成')
    expect(existsSync(join(HOME, 'memory', 'workspaces'))).toBe(true)
  })

  test('clear 缺参数 / 坏格子 / 正常清空（先留副本）', async () => {
    const harness = fakeCtx()
    const tag = `清空${String(Date.now())}`
    await runTool(harness, { target: 'global', action: 'add', content: `${tag}待清空` })

    expect(runCommand(harness, ['clear']).join('\n')).toContain('要说清清空哪一格')
    expect(runCommand(harness, ['clear', 'nope']).join('\n')).toContain('要说清清哪一格')
    const cleared = runCommand(harness, ['clear', 'global']).join('\n')
    expect(cleared).toContain('已清空「全局事实」')
    expect(cleared).toContain('副本')
    expect(harness.service.cells().find((cell) => cell.target === 'global')?.entries).toHaveLength(0)
  })
})

describe('设置分区操作', () => {
  test('save：坏值返回人话，开关与额度落盘并影响服务', () => {
    const harness = fakeCtx()
    expect(String(harness.section.save('nope', 1))).toContain('没有这项')
    expect(String(harness.section.save('reviewEveryTurns', 'abc'))).toContain('整数')
    expect(String(harness.section.save('pruneAfterDays', 'abc'))).toContain('整数')
    expect(String(harness.section.save('cell', 'nope'))).toContain('不认识这一格')

    expect(harness.section.save('userLimit', 60)).toBeUndefined()
    expect(harness.section.values()).toMatchObject({ userLimit: 60 })
    const saved = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
      entries: Array<{ file: string; config: Record<string, unknown> }>
    }
    expect(saved.entries.find((entry) => entry.file === 'memory')?.config).toMatchObject({ userLimit: 60 })

    expect(harness.section.save('enabled', false)).toBeUndefined()
    expect(harness.service.snapshot()).toBe('')
    expect(harness.section.values()).toMatchObject({ enabled: false })
  })

  test('action：删选中条目、清空整格（需二次确认）、整理与刷新', async () => {
    const harness = fakeCtx()
    const tag = `动作${String(Date.now())}`
    await runTool(harness, { target: 'global', action: 'add', content: `${tag}第一条` })
    await runTool(harness, { target: 'global', action: 'add', content: `${tag}第二条` })

    expect(String(harness.section.action('entryDelete'))).toContain('先在上面的下拉里选中')
    harness.section.save('entry', '0')
    expect(String(harness.section.action('entryDelete'))).toContain('已删掉')
    expect(harness.emitted.some((item) => item.event === 'dsc/changed')).toBe(true)

    expect(String(harness.section.action('cellClear'))).toContain('先把上面那个确认开关打开')
    harness.section.save('clearArmed', true)
    const cleared = String(harness.section.action('cellClear'))
    expect(cleared).toContain('已清空「全局事实」')

    expect(String(harness.section.action('pruneNow'))).toContain('没有需要整理的条目')
    expect(String(harness.section.action('evalReport'))).toContain('记忆评估')
    expect(String(harness.section.action('refresh'))).toContain('已重算')
    expect(String(harness.section.action('nope'))).toContain('没有这个按钮')
  })
})

describe('生命周期与服务', () => {
  test('session-open：开了自动整理就整理并通知，关掉就只重算', async () => {
    writeConfig({ pruneAfterDays: 0 })
    const harness = fakeCtx()
    const tag = `开场${String(Date.now())}`
    await runTool(harness, { target: 'global', action: 'add', content: `${tag}陈旧条目` })
    harness.handlers.get('dsc/session-open')?.()
    // 0 天判陈旧：整理应当发生，并 emit 一条通知。
    expect(harness.emitted.some((item) => item.event === 'dsc/notice')).toBe(true)

    writeConfig({ pruneEnabled: false })
    const quiet = fakeCtx()
    quiet.handlers.get('dsc/session-open')?.()
    expect(quiet.emitted.some((item) => item.event === 'dsc/notice')).toBe(false)
  })

  test('compacted 重新读取磁盘；服务 write / refresh / prune 走同一条落盘链路', async () => {
    const harness = fakeCtx()
    const cwd = harness.session.meta.cwd
    const tag = `压缩${String(Date.now())}`
    await runTool(harness, { target: 'workspace', action: 'add', content: `${tag}原始条目` })
    const file = cellFile(harness, 'workspace')
    writeFileSync(file, `${tag}原始条目\n§\n${tag}外部新增\n`, 'utf8')
    harness.handlers.get('dsc/compacted')?.()
    expect(harness.service.snapshot()).toContain(`${tag}外部新增`)

    const written = harness.service.write([{ target: 'workspace', action: 'add', content: `${tag}服务写入` }], cwd)
    expect(written.ok).toBe(true)
    expect(harness.service.snapshot()).toContain(`${tag}服务写入`)
    expect(harness.service.refresh()).toContain(`${tag}服务写入`)
    expect(typeof harness.service.prune('workspace')).toBe('string')
  })
})
