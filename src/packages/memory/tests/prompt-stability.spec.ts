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
 * 4. **注入卡与留底状态**：卡只报一次且正文没变不重复报；会话状态按正文哈希去重，
 *    同一段正文跨多次请求只留一条（25K 字符索引也不会让日志随请求数增长）。
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
  /** 落进会话状态（`appendState`）的记录：留底改成哈希去重后只该随正文变化增长。 */
  states: Array<{ id: string; payload: { hash: string; text: string } }>
  handlers: Map<string, (reason?: string) => void>
  session: {
    meta: { id: string; cwd: string }
    messages: Msg[]
    state: (id: string) => { hash?: string; text?: string } | undefined
    appendState: (id: string, payload: { hash: string; text: string }) => void
  }
  dispose: () => void
}

function fakeCtx(): Wired {
  const cwd = mkdtempSync(join(tmpdir(), 'dsc-memory-stability-cwd-'))
  const tools: CapturedTool[] = []
  const prompts: Array<() => string> = []
  const projections: CapturedProjection[] = []
  const stateMap = new Map<string, { hash?: string; text?: string }>()
  const states: Array<{ id: string; payload: { hash: string; text: string } }> = []
  const handlers = new Map<string, (reason?: string) => void>()
  const session = {
    meta: { id: 'mem-stability', cwd },
    messages: [] as Msg[],
    state: (id: string) => stateMap.get(id),
    appendState: (id: string, payload: { hash: string; text: string }) => {
      stateMap.set(id, payload)
      states.push({ id, payload })
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

  const wired: Wired = {
    ctx: ctx as unknown as Wired['ctx'],
    tools,
    prompts,
    projections,
    states,
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

function write(wired: Wired, content: string, target = 'memory'): Promise<string> {
  return memoryTool(wired).run(
    { target, action: 'add', content },
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
  test('没有记忆：原样返回同一个数组，不报卡、不落状态', () => {
    const wired = mount()
    const projection = tailProjection(wired)
    const base = history()
    const views: Array<Record<string, unknown>> = []
    expect(projection.apply(base, undefined, (view) => views.push(view)), '空索引不注入').toBe(base)
    expect(views).toHaveLength(0)
    expect(wired.states).toHaveLength(0)
  })

  test('有记忆：追加一条 user 消息、末行标记句；跨请求同正文只落一条状态', async () => {
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
    expect(wired.states.filter((item) => item.id === 'memory-index')).toHaveLength(1)
    expect(wired.states[0]?.payload.text).toBe(text)

    // 同一份历史重跑（invariant 二次派生）：正文逐字相同、不再报卡、不追写状态。
    const again = projection.apply(base, undefined, (view) => views.push(view))
    expect(String(again.at(-1)?.content), '二次派生必须给同一个答案（过期提醒不许一次性消费）').toBe(text)
    expect(views, '正文没变不重复记卡').toHaveLength(1)

    // 跨请求：历史最后一条消息每次都不同，正文没变 → 状态不追写（日志不随请求数增长）。
    for (let step = 0; step < 5; step += 1) {
      wired.session.messages.push({ role: 'assistant', content: `第 ${String(step)} 步` })
      expect(String(projection.apply(history()).at(-1)?.content)).toBe(text)
    }
    expect(wired.states.filter((item) => item.id === 'memory-index'), '跨请求同正文只留一条').toHaveLength(1)
  })

  test('25K 字符的记忆索引：多请求下日志状态条数不增长，正文变了才再落一条', async () => {
    // 把三格额度放大到能凑出 >25K 的索引（maxIndexChars 缺省 25000，超过就截断）。
    writeFileSync(
      join(process.env.DSC_HOME!, 'plugins.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            file: 'memory',
            disabled: false,
            config: { globalLimit: 20_000, userLimit: 20_000, workspaceLimit: 20_000, maxIndexChars: 25_000 },
          },
        ],
      }),
      'utf8',
    )
    const wired = mount()
    await write(wired, 'A'.repeat(12_000))
    await write(wired, 'B'.repeat(12_000), 'user')
    const projection = tailProjection(wired)

    const first = String(projection.apply(history()).at(-1)?.content)
    expect(first.length, '索引正文应接近 25K 上限').toBeGreaterThan(20_000)
    expect(wired.states.filter((item) => item.id === 'memory-index')).toHaveLength(1)
    const firstEntryChars = wired.states[0]!.payload.text.length

    // 模拟 10 次真实请求：每次历史都比上一次长，正文不变。
    for (let step = 0; step < 10; step += 1) {
      wired.session.messages.push({ role: 'assistant', content: `第 ${String(step)} 步` })
      expect(String(projection.apply(history()).at(-1)?.content)).toBe(first)
    }
    const indexStates = wired.states.filter((item) => item.id === 'memory-index')
    expect(indexStates, '日志条目数不随请求数增长').toHaveLength(1)
    // 日志总量就是「最新一份」，不是 11 份叠加。
    const total = indexStates.reduce((sum, item) => sum + item.payload.text.length, 0)
    expect(total).toBe(firstEntryChars)

    // 正文变了（再写一条记忆）→ 才再落一条状态。
    await write(wired, '正文变化后的一条')
    const changed = String(projection.apply(history()).at(-1)?.content)
    expect(changed).not.toBe(first)
    expect(wired.states.filter((item) => item.id === 'memory-index')).toHaveLength(2)
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
