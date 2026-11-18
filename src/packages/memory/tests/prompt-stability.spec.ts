/**
 * memory 的缓存稳定性回归（2026-11 P0）：记忆索引从系统提示挪到请求末尾。
 *
 * 钉四件事：
 * 1. **系统提示逐字稳定**：写一条记忆前后，整份系统提示与 sha256 一个字节都不变；
 *    静态段里没有索引正文（没有条目、没有额度条、没有分隔线）。
 * 2. **尾部投影**：有索引时往请求末尾追加一条 user 消息，最后一行是固定标记句；
 *    没索引时原样返回同一个数组。
 * 3. **过期提醒幂等**：写入后同一回合内连续两次投影逐字相同（投影链对同一请求跑两遍，
 *    一次性消费会破坏 invariant）；到 `dsc/turn-end` 才清掉。
 * 4. **注入卡与留底 note**：卡只报一次；同一份历史的二次派生只落一条 note。
 *
 * @module @pneuma/memory/tests/prompt-stability
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

// 临时 HOME + DSC_HOME 必须在动态 import 之前：memory 的三格目录按它算。
const HOME = mkdtempSync(join(tmpdir(), 'dsc-memory-stability-'))
const savedEnv = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  DSC_HOME: process.env['DSC_HOME'],
}
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.DSC_HOME = join(HOME, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })

type MemoryPlugin = typeof import('../index.js')['memoryPlugin']
type PromptModule = typeof import('@pneuma/session-core/prompt.js')

let memoryPlugin: MemoryPlugin
let buildSystemPromptParts: PromptModule['buildSystemPromptParts']

beforeAll(async () => {
  memoryPlugin = (await import('../index.js')).memoryPlugin
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
  rmSync(join(HOME, '.dsc', 'memory'), { recursive: true, force: true })
  writeFileSync(join(process.env.DSC_HOME!, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

// ── 假 ctx：apply 真正用到的面 ───────────────────────────────────────────────

interface Msg {
  role: string
  content: string
}

interface CapturedTool {
  name: string
  run: (args: Record<string, unknown>, scope: Record<string, unknown>) => Promise<string>
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
  tools: CapturedTool[]
  prompts: Array<() => string>
  projections: CapturedProjection[]
  notes: Array<{ id: string; text: string }>
  handlers: Map<string, (reason?: string) => void>
  session: { meta: { id: string; cwd: string }; messages: Msg[]; appendNote: (id: string, text: string) => void }
  dispose: () => void
}

function fakeCtx(): Wired {
  const cwd = mkdtempSync(join(tmpdir(), 'dsc-memory-stability-cwd-'))
  const tools: CapturedTool[] = []
  const prompts: Array<() => string> = []
  const projections: CapturedProjection[] = []
  const notes: Array<{ id: string; text: string }> = []
  const handlers = new Map<string, (reason?: string) => void>()
  const session = {
    meta: { id: 'mem-stability', cwd },
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
      register(entry: CapturedTool) {
        tools.push(entry)
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
      systemPromptParts() {
        return buildSystemPromptParts(cwd, {
          skills: '',
          contributions: [
            ...prompts.map((render, index) => ({ id: `plugin-${String(index)}`, order: 60, text: render() })),
            { id: 'model', order: 890, text: '当前模型：test-model（provider test）' },
          ],
        })
      },
    },
    settings: { registerSection: () => () => undefined },
    approval: { decide: async () => 'allow-once' },
    agent: { followup: () => undefined },
    transcript: { system: () => undefined },
    session: { current: () => session },
    provide: () => undefined,
    emit: () => undefined,
    on(event: string, handler: (reason?: string) => void) {
      handlers.set(event, handler)
      return () => undefined
    },
  }

  const wired = {
    ctx: ctx as unknown as Wired['ctx'],
    tools,
    prompts,
    projections,
    notes,
    handlers,
    session,
    dispose: () => undefined,
  }
  const returned = memoryPlugin.apply(ctx as never, undefined) as (() => void) | undefined
  wired.dispose = returned ?? (() => undefined)
  return wired
}

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

function mount(): Wired {
  const wired = fakeCtx()
  cleanup = wired.dispose
  return wired
}

function memoryTool(wired: Wired): CapturedTool {
  const tool = wired.tools.find((entry) => entry.name === 'memory')
  expect(tool, 'apply 应当注册 memory 工具').toBeDefined()
  return tool!
}

function write(wired: Wired, content: string): Promise<string> {
  return memoryTool(wired).run(
    { target: 'memory', action: 'add', content },
    { cwd: wired.session.meta.cwd, sessionId: wired.session.meta.id, sessionPath: '', signal: new AbortController().signal },
  )
}

function tailProjection(wired: Wired): CapturedProjection {
  const projection = wired.projections.find((entry) => entry.id === 'memory-index')
  expect(projection, '缺 memory-index 尾部投影').toBeDefined()
  expect(projection?.options?.order, '尾部投影排在 env-facts（600）之后、microcompact（650）之前').toBe(610)
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
  test('写一条记忆前后，整份系统提示与 sha256 都不变，静态段里没有索引正文', async () => {
    const wired = mount()
    const before = wired.ctx.prompt.systemPromptParts()
    expect(before.text).toContain('长期记忆索引')

    const content = `本仓库用 pnpm 构建-${String(Date.now())}`
    await write(wired, content)

    const after = wired.ctx.prompt.systemPromptParts()
    expect(after.text, '写记忆不得改动系统提示').toBe(before.text)
    expect(sha256(after.text)).toBe(sha256(before.text))
    // 静态段只讲位置与用法：没有条目正文、没有额度条、没有分隔线。
    expect(after.text).not.toContain(content)
    expect(after.text).not.toContain('═')
    expect(after.text).not.toMatch(/\d+\s*\/\s*\d+\s*字/)
  })

  test('再写一条 / 删掉一条，系统提示仍然逐字不变', async () => {
    const wired = mount()
    await write(wired, '第一条记忆正文')
    const first = wired.ctx.prompt.systemPromptParts().text

    await write(wired, '第二条记忆正文')
    expect(wired.ctx.prompt.systemPromptParts().text).toBe(first)

    const removed = await memoryTool(wired).run(
      { target: 'memory', action: 'remove', old_text: '第一条记忆正文' },
      { cwd: wired.session.meta.cwd, sessionId: wired.session.meta.id, sessionPath: '', signal: new AbortController().signal },
    )
    expect(removed).toContain('已删掉')
    expect(wired.ctx.prompt.systemPromptParts().text).toBe(first)
  })
})

// ── 2. 尾部投影 ─────────────────────────────────────────────────────────────

describe('尾部投影', () => {
  test('没有记忆：原样返回同一个数组，不报卡、不落 note', () => {
    const wired = mount()
    const projection = tailProjection(wired)
    const base = history()
    const views: Array<Record<string, unknown>> = []
    expect(projection.apply(base, undefined, (view) => views.push(view)), '空索引不注入').toBe(base)
    expect(views).toHaveLength(0)
    expect(wired.notes).toHaveLength(0)
  })

  test('有记忆：追加一条 user 消息、末行标记句；连续两次逐字相同、卡与 note 各一次', async () => {
    const wired = mount()
    const content = `跨会话事实-${String(Date.now())}`
    await write(wired, content)
    const projection = tailProjection(wired)
    const base = history()
    const views: Array<Record<string, unknown>> = []

    const out = projection.apply(base, undefined, (view) => views.push(view))
    expect(out.length).toBe(base.length + 1)
    const text = String(out.at(-1)?.content)
    expect(text).toContain(content)
    expect(text.split('\n').at(-1)).toBe('（本条是程序自动附上的，不是用户发言）')
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ kind: 'memory-index', source: 'memory', where: 'user-tail' })
    expect(wired.notes.filter((item) => item.id === 'memory-index')).toHaveLength(1)

    // 同一份历史重跑（invariant 二次派生）：正文逐字相同、不再报卡、不再落 note。
    const again = projection.apply(base, undefined, (view) => views.push(view))
    expect(String(again.at(-1)?.content), '二次派生必须给同一个答案（过期提醒不许一次性消费）').toBe(text)
    expect(views, '正文没变不重复记卡').toHaveLength(1)
    expect(wired.notes, '同一份历史只落一条 note').toHaveLength(1)
  })

  test('写入后的过期提醒在本回合内幂等，回合结束才消失；索引本身一直在', async () => {
    const wired = mount()
    const content = `幂等提醒-${String(Date.now())}`
    await write(wired, content)
    const projection = tailProjection(wired)
    const first = String(projection.apply(history()).at(-1)?.content)
    expect(first).toContain('记忆副本已过期')
    const second = String(projection.apply(history()).at(-1)?.content)
    expect(second, '连续两次调用（同一回合）必须逐字相同').toBe(first)

    wired.handlers.get('dsc/turn-end')?.('completed')
    const afterTurn = String(projection.apply(history()).at(-1)?.content)
    expect(afterTurn).toContain(content)
    expect(afterTurn).not.toContain('记忆副本已过期')
  })
})
