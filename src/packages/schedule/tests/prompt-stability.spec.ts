/**
 * schedule 的缓存稳定性回归（2026-11 P0）：任务清单与下次触发时刻移出系统提示。
 *
 * 钉四件事：
 * 1. **系统提示逐字稳定**：新增任务 / 改规则（nextRunAt 跟着变）前后，整份系统提示
 *    与 sha256 一个字节都不变——它一变，服务端前缀缓存从这一段起整段作废。
 * 2. **静态段不含易变值**：没有任务标题、没有绝对/相对触发时刻，只有「用法 + 授权边界」。
 * 3. **尾部投影**：有任务时往请求末尾追加一条 user 消息，最后一行是固定标记句；
 *    没任务/总开关关着时原样返回同一个数组；同一份历史重跑两次输出逐字相同。
 * 4. **注入卡与留底 note**：正文变了才再记卡；同一份历史的二次派生只落一条 note。
 *
 * @module @pneuma/schedule/tests/prompt-stability
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

// 临时 HOME + DSC_HOME 必须在动态 import 之前：store 的默认目录在模块求值时算定。
const HOME = mkdtempSync(join(tmpdir(), 'dsc-schedule-stability-'))
const savedEnv = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  DSC_HOME: process.env['DSC_HOME'],
}
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.DSC_HOME = join(HOME, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })

type SchedulePlugin = typeof import('../index.js')['schedulePlugin']
type StoreModule = typeof import('../../../core/schedule/store.js')
type PromptModule = typeof import('@pneuma/session-core/prompt.js')

let schedulePlugin: SchedulePlugin
let storeModule: StoreModule
let buildSystemPromptParts: PromptModule['buildSystemPromptParts']

beforeAll(async () => {
  schedulePlugin = (await import('../index.js')).schedulePlugin
  storeModule = await import('../../../core/schedule/store.js')
  buildSystemPromptParts = (await import('@pneuma/session-core/prompt.js')).buildSystemPromptParts
})

afterAll(() => {
  for (const name of ['HOME', 'USERPROFILE', 'DSC_HOME'] as const) {
    const before = savedEnv[name]
    if (before === undefined) delete process.env[name]
    else process.env[name] = before
  }
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(() => {
  rmSync(join(HOME, '.dsc', 'schedule'), { recursive: true, force: true })
  writeFileSync(join(process.env.DSC_HOME!, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

// ── 假 ctx：apply 真正用到的面 ───────────────────────────────────────────────

interface Msg {
  role: string
  content: string
}

interface CapturedProjection {
  id: string
  apply: (messages: Msg[], session?: unknown, report?: (view: Record<string, unknown>) => void) => Msg[]
  options?: { order?: number }
}

interface Wired {
  ctx: {
    prompt: {
      systemPromptParts: () => { text: string; sections: Array<{ id: string; chars: number }> }
    }
  }
  tools: Array<Record<string, unknown>>
  prompts: Array<() => string>
  projections: CapturedProjection[]
  notes: Array<{ id: string; text: string }>
  session: { meta: { id: string; cwd: string }; messages: Msg[]; appendNote: (id: string, text: string) => void }
  dispose: () => void
}

function fakeCtx(config: Record<string, unknown> = { enabled: true, timeZone: 'UTC' }): Wired {
  const tools: Array<Record<string, unknown>> = []
  const prompts: Array<() => string> = []
  const projections: CapturedProjection[] = []
  const notes: Array<{ id: string; text: string }> = []
  const session = {
    meta: { id: 'sched-stability', cwd: HOME },
    messages: [] as Msg[],
    appendNote: (id: string, text: string) => {
      notes.push({ id, text })
    },
  }

  const ctx = {
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
    tools: {
      register(spec: Record<string, unknown>) {
        tools.push(spec)
        return () => undefined
      },
    },
    commands: { register: () => () => undefined },
    prompt: {
      register(_id: string, fn: () => string) {
        prompts.push(fn)
        return () => undefined
      },
      registerProjection(id: string, apply: CapturedProjection['apply'], options?: { order?: number }) {
        projections.push({ id, apply, ...(options === undefined ? {} : { options }) })
        return () => undefined
      },
      /** 与内核同一条拼装器：用捕获到的段拼整份系统提示，比只比单段更接近真实请求。 */
      systemPromptParts() {
        return buildSystemPromptParts(HOME, {
          skills: '',
          contributions: [
            ...prompts.map((render, index) => ({ id: `plugin-${String(index)}`, order: 41, text: render() })),
            { id: 'model', order: 890, text: '当前模型：test-model（provider test）' },
          ],
        })
      },
    },
    surfaces: { register: () => () => undefined },
    settings: { registerSection: () => () => undefined },
    transcript: { getSnapshot: () => ({ entries: [] }), system: () => undefined },
    agent: { followup: () => undefined },
    waiting: { anyFor: () => false },
    session: { current: () => session },
    llm: { route: () => ({ baseUrl: 'https://api.test', apiKey: 'fake-key', model: 'test-model' }) },
    get: () => undefined,
    on: () => () => undefined,
  }

  const wired = {
    ctx: ctx as unknown as Wired['ctx'],
    tools,
    prompts,
    projections,
    notes,
    session,
    dispose: () => undefined,
  }
  wired.dispose = schedulePlugin.apply(ctx as never, config) as unknown as () => void
  return wired
}

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

function mount(config?: Record<string, unknown>): Wired {
  const wired = fakeCtx(config)
  cleanup = wired.dispose
  return wired
}

/** 用真实 tool 面建任务 / 改任务，让 store 与排期走同一条路径。 */
function runTool(wired: Wired, args: Record<string, unknown>): Promise<unknown> {
  const tool = wired.tools[0]!
  return (tool['run'] as (a: unknown) => Promise<unknown>)(args)
}

/** 从一个任务 id 前缀找任务（工具 update/delete 都按前缀）——直接用 id 就行。 */
function firstTaskId(): string {
  return (new storeModule.ScheduleStore().load().tasks[0]!).id
}

function tailProjection(wired: Wired): CapturedProjection {
  const projection = wired.projections.find((entry) => entry.id === 'schedule')
  expect(projection, '缺 schedule 尾部投影').toBeDefined()
  expect(projection?.options?.order, '尾部投影排在 env-facts（600）之后、microcompact（650）之前').toBe(630)
  return projection!
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 一段普通对话历史（投影只往后追加）。 */
function history(): Msg[] {
  return [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在' },
  ]
}

// ── 1. 系统提示逐字稳定 ─────────────────────────────────────────────────────

describe('系统提示逐字稳定', () => {
  test('新增任务 / 改任务规则（nextRunAt 变了）之后，整份提示与 sha256 都不变', async () => {
    const wired = mount()
    await runTool(wired, { action: 'create', title: '早报任务标题', prompt: '写早报', rule: 'daily:09:30' })
    const first = wired.ctx.prompt.systemPromptParts()
    expect(first.text).toContain('你有定时任务')
    expect(first.text).toContain('不构成任何授权')
    // 静态段里不许出现任务标题、规则时刻这类易变值。
    expect(first.text).not.toContain('早报任务标题')
    expect(first.text).not.toMatch(/每天\s*\d{2}:\d{2}/)
    expect(first.text).not.toMatch(/\d{4}-\d{2}-\d{2}/)

    // 再加一条任务：任务数 1 → 2，系统提示必须逐字不变。
    await runTool(wired, { action: 'create', title: '喝水任务标题', prompt: '起来喝水', rule: 'every:30m' })
    const second = wired.ctx.prompt.systemPromptParts()
    expect(second.text, '新增任务不得改动系统提示').toBe(first.text)
    expect(sha256(second.text)).toBe(sha256(first.text))

    // 改规则：nextRunAt 跟着变，系统提示仍然不许动。
    const id = firstTaskId()
    await runTool(wired, { action: 'update', id, rule: 'every:45m' })
    const third = wired.ctx.prompt.systemPromptParts()
    expect(third.text).toBe(first.text)
    expect(sha256(third.text)).toBe(sha256(first.text))
  })

  test('没有任务 / 总开关关着：静态段返回空串', async () => {
    const empty = mount()
    expect(empty.prompts[0]!()).toBe('')
    expect(empty.ctx.prompt.systemPromptParts().text).not.toContain('你有定时任务')
    // 先建一条任务（落盘），再挂一个总开关关着的实例：静态段仍然为空。
    await runTool(empty, { action: 'create', title: 'T', prompt: 'P', rule: 'every:30m' })
    empty.dispose()
    const off = mount({ enabled: false, timeZone: 'UTC' })
    expect(off.prompts[0]!()).toBe('')
  })
})

// ── 2. 尾部投影 ─────────────────────────────────────────────────────────────

describe('尾部投影', () => {
  test('没有任务：原样返回同一个数组，不报卡、不落 note', () => {
    const wired = mount()
    const projection = tailProjection(wired)
    const base = history()
    const views: Array<Record<string, unknown>> = []
    expect(projection.apply(base, undefined, (view) => views.push(view)), '没任务不注入').toBe(base)
    expect(views).toHaveLength(0)
    expect(wired.notes).toHaveLength(0)
  })

  test('有任务：追加一条 user 消息、末行是标记句；两次调用逐字相同、卡与 note 各只一次', async () => {
    const wired = mount()
    await runTool(wired, { action: 'create', title: '早报', prompt: '写早报', rule: 'daily:09:30' })
    const projection = tailProjection(wired)
    const base = history()
    const views: Array<Record<string, unknown>> = []

    const out = projection.apply(base, undefined, (view) => views.push(view))
    expect(out.length).toBe(base.length + 1)
    const text = String(out.at(-1)?.content)
    expect(text).toContain('本会话有 1 个启用的定时任务')
    expect(text).toContain('action=list')
    expect(text.split('\n').at(-1)).toBe('（本条是程序自动附上的，不是用户发言）')
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ kind: 'schedule', source: 'schedule', where: 'user-tail' })
    expect(wired.notes.filter((item) => item.id === 'schedule')).toHaveLength(1)

    // 同一份历史重跑（invariant 二次派生）：正文逐字相同、不再报卡、不再落 note。
    const again = projection.apply(base, undefined, (view) => views.push(view))
    expect(String(again.at(-1)?.content), '二次派生必须给同一个答案').toBe(text)
    expect(views, '正文没变不重复记卡').toHaveLength(1)
    expect(wired.notes, '同一份历史只落一条 note').toHaveLength(1)

    // 再加一条任务：条数变了 → 正文变了 → 再记一张卡。
    await runTool(wired, { action: 'create', title: '喝水', prompt: '起来喝水', rule: 'every:30m' })
    const changed = projection.apply(history(), undefined, (view) => views.push(view))
    expect(String(changed.at(-1)?.content)).toContain('本会话有 2 个启用的定时任务')
    expect(views).toHaveLength(2)
  })

  test('全部暂停：原样返回（没有启用的任务就不占尾巴）', async () => {
    const wired = mount()
    await runTool(wired, { action: 'create', title: 'T', prompt: 'P', rule: 'every:30m' })
    const projection = tailProjection(wired)
    await runTool(wired, { action: 'pause', id: firstTaskId() })
    const base = history()
    expect(projection.apply(base)).toBe(base)
  })
})
