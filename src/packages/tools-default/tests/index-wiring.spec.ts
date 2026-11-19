/**
 * tools-default 装配面补盲（`packages/tools-default/index.ts`）：工具注册、预算夹取、
 * 两个设置分区（工具预算 / 终端环境）、后台作业与终端会话在 `backgroundWorks`
 * 快照/读取/停止上的归属校验，以及完成通知的合并投递与收尾。
 *
 * 已有 `tools-default.spec.ts` 只验插件入口与两条纯函数；`bash-extra` / `bash-jobs` /
 * `search-ignore` 验的是 bash / search 工具自身。这一份只补 **index.ts 的装配与坏输入分支**：
 * 假 ctx 真跑 `apply()`，作业与终端用真子进程（收尾统一由插件返回的清理函数收掉）。
 *
 * @module dsc/packages/tools-default/tests/index-wiring.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SettingsField, SettingsMutationOk, SettingsValues } from '@pneuma/runtime/contract.js'
import type { BackgroundWorksService, SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-tools-default-wiring-'))
process.env['DSC_HOME'] = HOME
const PLUGINS_FILE = join(HOME, 'plugins.json')
const PROJECT = mkdtempSync(join(tmpdir(), 'dsc-tools-default-proj-'))

type IndexModule = typeof import('../index.js')
let toolsDefaultPlugin!: IndexModule['toolsDefaultPlugin']

const cleanups: Array<() => void> = []

beforeAll(async () => {
  ;({ toolsDefaultPlugin } = await import('../index.js'))
})

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeFileSync(PLUGINS_FILE, JSON.stringify({ version: 1, entries: [] }), 'utf8')
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
    rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // 后台进程可能还没完全放开目录：临时目录留给系统清。
  }
  try {
    rmSync(PROJECT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // 同上：终端会话的 cwd 可能还被刚杀掉的进程占着。
  }
})

interface SessionLike {
  meta: { id: string; cwd: string }
  filePath: string
  messages: unknown[]
  state: () => undefined
  appendState: () => void
  appendNote: () => void
}

interface Harness {
  tools: ToolEntry[]
  sections: SettingsSectionSpec[]
  services: Map<string, unknown>
  surfaces: Map<string, () => unknown>
  followups: Array<{ text: string; owner?: string }>
  emitted: Array<{ event: string; args: unknown[] }>
  offCount: number
  cleanup: () => void
  session: SessionLike
}

/** 假 ctx：apply 用到的面都实现，`effect` 真跑回调（否则注册不会发生）。 */
function mount(passed?: Record<string, unknown>): Harness {
  const tools: ToolEntry[] = []
  const sections: SettingsSectionSpec[] = []
  const services = new Map<string, unknown>()
  const surfaces = new Map<string, () => unknown>()
  const followups: Array<{ text: string; owner?: string }> = []
  const emitted: Array<{ event: string; args: unknown[] }> = []
  let offCount = 0
  const session: SessionLike = {
    meta: { id: 'sess-1', cwd: PROJECT },
    filePath: join(PROJECT, '.dsc', 'sessions', 'sess-1.jsonl'),
    messages: [],
    state: () => undefined,
    appendState: () => undefined,
    appendNote: () => undefined,
  }
  const off = (): void => {
    offCount += 1
  }
  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      return typeof result === 'function' ? result : off
    },
    on() {
      return off
    },
    emit(event: string, ...args: unknown[]) {
      emitted.push({ event, args })
    },
    tools: {
      register(entry: ToolEntry) {
        tools.push(entry)
        return off
      },
    },
    surfaces: {
      register(id: string, read: () => unknown) {
        surfaces.set(id, read)
        return off
      },
    },
    settings: {
      registerSection(section: SettingsSectionSpec) {
        sections.push(section)
        return off
      },
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    session: { current: () => session },
    agent: {
      followup(text: string, _runtime?: unknown, owner?: string) {
        followups.push({ text, owner })
      },
    },
    get() {
      return undefined
    },
  }
  const cleanup = toolsDefaultPlugin.apply?.(ctx as never, passed as never)
  const harness: Harness = {
    tools,
    sections,
    services,
    surfaces,
    followups,
    emitted,
    get offCount() {
      return offCount
    },
    cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : () => undefined,
    session,
  }
  cleanups.push(harness.cleanup)
  return harness
}

const toolNamed = (harness: Harness, name: string): ToolEntry => {
  const entry = harness.tools.find((tool) => tool.name === name)
  if (entry === undefined) throw new Error(`没有注册工具 ${name}`)
  return entry
}

const numParam = (tool: ToolEntry, key: string): string => {
  const properties = tool.parameters?.['properties'] as Record<string, { description?: string }> | undefined
  return properties?.[key]?.description ?? ''
}

const sectionOf = (harness: Harness, id: string): SettingsSectionSpec => {
  const section = harness.sections.find((item) => item.id === id)
  if (section === undefined) throw new Error(`没有注册设置分区 ${id}`)
  return section
}

const toolCtx = (sessionId = 'sess-1'): { cwd: string; sessionId: string; signal: AbortSignal } => ({
  cwd: PROJECT,
  sessionId,
  signal: new AbortController().signal,
})

/** 等一个条件成立（后台进程收尾 / 通知定时器）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** 从工具回执里抠出后台作业 / 终端会话的 id。 */
function idFrom(text: string, prefix: 'job' | 'term'): string {
  const matched = new RegExp(`${prefix}-\\d+`).exec(text)
  if (matched === null) throw new Error(`回执里没有 ${prefix}-*：${text}`)
  return matched[0]
}

function readPluginEntry(): Record<string, unknown> {
  const saved = JSON.parse(readFileSync(PLUGINS_FILE, 'utf8')) as {
    entries?: Array<{ file?: string; config?: Record<string, unknown> }>
  }
  return saved.entries?.find((entry) => entry.file === 'tools-default')?.config ?? {}
}

describe('装配面：工具、分区、服务与快照', () => {
  test('十二件工具、两个设置分区、backgroundWorks 服务与快照都挂上了', () => {
    const harness = mount()
    expect(harness.tools.map((tool) => tool.name).sort()).toEqual([
      'bash',
      'edit',
      'glob',
      'grep',
      'job_kill',
      'job_list',
      'job_output',
      'read',
      'read_image',
      'shell',
      'terminal',
      'write',
    ])
    const budget = sectionOf(harness, 'tools-default')
    expect(budget).toMatchObject({ id: 'tools-default', order: 36 })
    const shell = sectionOf(harness, 'terminal-env')
    expect(shell).toMatchObject({ id: 'terminal-env', parent: 'general', order: 6 })
    expect(harness.services.get('backgroundWorks')).toBeDefined()
    expect(harness.surfaces.has('backgroundWorks')).toBe(true)
    expect(harness.surfaces.get('backgroundWorks')?.()).toEqual([])
  })

  test('收尾函数撤掉注册并清掉作业/会话（重复收不炸）', () => {
    const harness = mount()
    const before = harness.offCount
    harness.cleanup()
    expect(harness.offCount).toBeGreaterThan(before)
    expect(() => harness.cleanup()).not.toThrow()
  })
})

describe('工具预算：装配配置与磁盘配置的夹取', () => {
  test('装配时给的越界值被夹回区间，并写进工具说明', () => {
    const harness = mount({
      bashTimeoutMs: 1,
      bashMaxTimeoutMs: 99_999_999,
      bashOutputChars: 1,
      readLineLimit: 99_999_999,
    })
    const bash = toolNamed(harness, 'bash')
    expect(numParam(bash, 'timeoutMs')).toContain('默认 5000')
    expect(numParam(bash, 'timeoutMs')).toContain('上限 600000')
    const read = toolNamed(harness, 'read')
    expect(numParam(read, 'limit')).toContain('默认 10000')
  })

  test('装配时给的不是数字：回默认预算而不是 NaN', () => {
    const harness = mount({
      bashTimeoutMs: 'abc',
      bashMaxTimeoutMs: 'abc',
      bashOutputChars: {},
      readLineLimit: Number.NaN,
    })
    expect(numParam(toolNamed(harness, 'bash'), 'timeoutMs')).toContain('默认 30000')
    expect(numParam(toolNamed(harness, 'bash'), 'timeoutMs')).toContain('上限 120000')
    expect(numParam(toolNamed(harness, 'read'), 'limit')).toContain('默认 2000')
  })

  test('设置分区保存：非数字/未知键给失败文案，四个合法键都落盘并重注册', () => {
    const harness = mount()
    const section = sectionOf(harness, 'tools-default')
    const save = section.save as (key: string, value: unknown) => string | void

    expect(save('bashTimeoutMs', 'abc')).toBe('这里要填一个数字')
    expect(String(save('nope', 1))).toContain('这个分区没有这项：nope')

    const toolsBefore = harness.tools.length
    save('bashTimeoutMs', 1)
    save('bashMaxTimeoutMs', 99_999_999)
    save('bashOutputChars', 1)
    save('readLineLimit', 99_999_999)
    // 每次保存都走 applyConfig → syncTools：四轮重注册。
    expect(harness.tools.length).toBe(toolsBefore * 5)

    const values = section.values() as SettingsValues
    expect(values).toMatchObject({
      bashTimeoutMs: 5_000,
      bashMaxTimeoutMs: 600_000,
      bashOutputChars: 1_000,
      readLineLimit: 10_000,
    })
    expect(readPluginEntry()).toMatchObject({
      bashTimeoutMs: 1,
      bashMaxTimeoutMs: 99_999_999,
      bashOutputChars: 1,
      readLineLimit: 99_999_999,
    })
  })
})

describe('终端环境分区', () => {
  test('字段形状：select + info + button，切值与重新检测都有回执', () => {
    const harness = mount()
    const section = sectionOf(harness, 'terminal-env')
    const fields = section.fields() as SettingsField[]
    const select = fields.find((field) => 'key' in field && field.key === 'bashShell') as
      | { type: string; options?: Array<{ value: string }> }
      | undefined
    expect(select?.type).toBe('select')
    expect(select?.options?.some((option) => option.value === 'auto')).toBe(true)
    expect(fields.some((field) => field.type === 'info')).toBe(true)
    expect(fields.some((field) => field.type === 'button' && field.action === 'redetect')).toBe(true)
    expect(section.values()).toEqual({ bashShell: 'auto' })

    const save = section.save as (key: string, value: unknown) => string | SettingsMutationOk | void
    expect(String(save('nope', 'x'))).toContain('这个分区没有这项：nope')
    expect(String(save('bashShell', 'nope'))).toBe('不认识的终端：nope')
    const ok = save('bashShell', 'auto') as SettingsMutationOk
    expect(ok.notice).toContain('已切到')
    expect(String(section.action?.('redetect'))).toContain('重新检测完成')
    expect(() => section.action?.('nope')).toThrow('不认识的按钮：nope')
  }, 30_000)

  test('选了检测到但当前不可用的 shell：拒绝保存并点名', async () => {
    const harness = mount()
    const section = sectionOf(harness, 'terminal-env')
    const { detectShells, SHELL_CHOICES } = await import('@pneuma/runtime/core/terminal-env.js')
    // 探测结果里找一条「认识但不可用」的项；这台机器全都装了就跳过这一分支。
    const hit = detectShells().find(
      (item) => !item.available && item.value !== 'auto' && (SHELL_CHOICES as readonly string[]).includes(item.value),
    )
    if (hit === undefined) return
    const save = section.save as (key: string, value: unknown) => string | SettingsMutationOk | void
    expect(String(save('bashShell', hit.value))).toContain('没检测到')
  }, 30_000)
})

describe('backgroundWorks：作业与终端的快照、读取、停止', () => {
  test('长命令进快照时标题截断；read 给作业视图；stop 两次走「正在终止 / 已经结束」', async () => {
    const harness = mount()
    const bash = toolNamed(harness, 'bash')
    const longCommand = `node -e "setTimeout(()=>{},15000)" # ${'x'.repeat(80)}`
    const launched = String(await bash.run({ command: longCommand, run_in_background: true }, toolCtx() as never))
    const id = idFrom(launched, 'job')

    const works = harness.surfaces.get('backgroundWorks')?.() as Array<{ id: string; kind: string; title: string }>
    expect(works).toHaveLength(1)
    expect(works[0]).toMatchObject({ id, kind: 'job' })
    expect(works[0]!.title.endsWith('…')).toBe(true)
    expect(works[0]!.title.length).toBeLessThanOrEqual(61)

    const service = harness.services.get('backgroundWorks') as BackgroundWorksService
    const view = service.read(id)
    expect(view).toMatchObject({ id, kind: 'job', status: 'running' })
    expect(typeof view.text).toBe('string')

    expect(service.stop(id)).toMatch(/正在终止|进程已经不在了/)
    expect(service.stop(id)).toContain('已经是')
    expect(() => service.stop('job-999')).toThrow('没有这个后台作业或终端会话')
    expect(() => service.read('job-999')).toThrow('没有这个后台作业或终端会话')
  })

  test('别的会话起的作业：不进当前快照，读/收都被归属校验挡住', async () => {
    const harness = mount()
    const bash = toolNamed(harness, 'bash')
    const launched = String(
      await bash.run(
        { command: 'node -e "setTimeout(()=>{},15000)"', run_in_background: true },
        toolCtx('other-session') as never,
      ),
    )
    const id = idFrom(launched, 'job')
    expect(harness.surfaces.get('backgroundWorks')?.()).toEqual([])

    const service = harness.services.get('backgroundWorks') as BackgroundWorksService
    expect(() => service.read(id)).toThrow('属于别的会话，读不了')
    expect(() => service.stop(id)).toThrow('属于别的会话，不收')
  })

  test('终端会话：打开进快照、read 给终端视图；收掉后再说一句「本来就已经结束」；别家的读/收都拒', async () => {
    const harness = mount()
    const terminal = toolNamed(harness, 'terminal')
    await terminal.run({ action: 'open' }, toolCtx() as never)
    const listed = String(await terminal.run({ action: 'list' }, toolCtx() as never))
    const id = idFrom(listed, 'term')

    const works = harness.surfaces.get('backgroundWorks')?.() as Array<{ id: string; kind: string; title: string }>
    expect(works.some((item) => item.id === id && item.kind === 'terminal')).toBe(true)
    expect(works.find((item) => item.id === id)?.title).toBe(`终端会话 ${id}`)

    const service = harness.services.get('backgroundWorks') as BackgroundWorksService
    expect(service.read(id)).toMatchObject({ id, kind: 'terminal' })
    expect(service.stop(id)).toContain('已收掉')
    expect(service.stop(id)).toContain('本来就已经结束')

    // 另一个会话开的终端：快照里不出现，读/收都按归属拒绝。
    await terminal.run({ action: 'open' }, toolCtx('other-session') as never)
    const all = String(await terminal.run({ action: 'list' }, toolCtx() as never))
    const otherId = idFrom(all.split('\n').at(-1) ?? '', 'term')
    expect(harness.surfaces.get('backgroundWorks')?.()).toEqual([])
    expect(() => service.read(otherId)).toThrow('属于别的会话，读不了')
    expect(() => service.stop(otherId)).toThrow('属于别的会话，不收')
    expect(() => service.read('term-999')).toThrow('没有这个终端会话')
  }, 20_000)

  test('作业跑完：合并 800ms 后经 agent.followup 投给所属会话', async () => {
    const harness = mount()
    const bash = toolNamed(harness, 'bash')
    const launched = String(
      await bash.run({ command: 'node -e "console.log(\'done\')"', run_in_background: true }, toolCtx() as never),
    )
    const id = idFrom(launched, 'job')
    await waitFor(() => harness.followups.length > 0)
    expect(harness.followups.length).toBeGreaterThan(0)
    expect(harness.followups[0]).toMatchObject({ owner: 'sess-1' })
    expect(harness.followups[0]!.text).toContain(`后台作业 ${id}`)
    expect(harness.emitted.some((item) => item.event === 'dsc/changed')).toBe(true)
  }, 15_000)
})
