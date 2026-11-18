/**
 * self-improve 的缓存稳定性回归（2026-11 P0）：待审条数从系统提示挪到请求末尾。
 *
 * 钉四件事：
 * 1. **系统提示逐字稳定**：propose 一条候选前后，整份系统提示与 sha256 一个字节都不变；
 *    静态段里没有条数、没有候选正文。
 * 2. **尾部投影**：N=0 原样返回同一个数组；N>0 追加一条 user 消息，最后一行是固定标记句。
 * 3. **同一份历史重跑两次逐字相同**；注入卡与留底 note 各只记一次。
 * 4. **条数变了才再记卡**。
 *
 * @module @pneuma/self-improve/tests/prompt-stability
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

// 临时 HOME + DSC_HOME 必须在动态 import 之前：技能目录与候选清单都按它算。
const HOME = mkdtempSync(join(tmpdir(), 'dsc-self-improve-stability-'))
const savedEnv = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  DSC_HOME: process.env['DSC_HOME'],
}
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.DSC_HOME = join(HOME, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })

type SelfImprovePlugin = typeof import('../index.js')['selfImprovePlugin']
type PromptModule = typeof import('@pneuma/session-core/prompt.js')

let selfImprovePlugin: SelfImprovePlugin
let buildSystemPromptParts: PromptModule['buildSystemPromptParts']

beforeAll(async () => {
  selfImprovePlugin = (await import('../index.js')).selfImprovePlugin
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
  for (const name of ['learnings', 'skills']) rmAll(join(HOME, '.dsc', name))
  writeFileSync(join(process.env.DSC_HOME!, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** Windows 上偶发 EBUSY 的删除：容忍失败（临时目录留给系统清）。 */
function rmAll(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 句柄还没放完：不影响断言
  }
}

// ── 假 ctx：apply 真正用到的面 ───────────────────────────────────────────────

interface Msg {
  role: string
  content: string
}

interface CapturedPrompt {
  id: string
  text: () => string
  opts?: { order?: number }
}

interface CapturedProjection {
  id: string
  apply: (messages: Msg[], session?: unknown, report?: (view: Record<string, unknown>) => void) => Msg[]
  opts?: { order?: number }
}

interface Wired {
  ctx: {
    prompt: {
      systemPromptParts: () => { text: string; sections: Array<{ id: string; chars: number }> }
    }
  }
  tools: Map<string, { run: (args: Record<string, unknown>) => Promise<string> }>
  prompts: CapturedPrompt[]
  projections: CapturedProjection[]
  notes: Array<{ id: string; text: string }>
  session: { meta: { id: string; cwd: string }; messages: Msg[]; appendNote: (id: string, text: string) => void }
  dispose: () => void
}

function fakeCtx(config: Record<string, unknown> = { enabled: true, requireApproval: true }): Wired {
  const cwd = mkdtempSync(join(tmpdir(), 'dsc-self-improve-stability-cwd-'))
  const tools = new Map<string, { run: (args: Record<string, unknown>) => Promise<string> }>()
  const prompts: CapturedPrompt[] = []
  const projections: CapturedProjection[] = []
  const notes: Array<{ id: string; text: string }> = []
  const stateMap = new Map<string, unknown>()
  const session = {
    meta: { id: 'improve-stability', cwd },
    messages: [] as Msg[],
    appendNote: (id: string, text: string) => {
      notes.push({ id, text })
    },
  }

  const ctx = {
    effect(fn: () => unknown) {
      const off = fn()
      return typeof off === 'function' ? (off as () => void) : () => undefined
    },
    on: () => () => undefined,
    tools: {
      register(tool: { name: string; run: (args: Record<string, unknown>) => Promise<string> }) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
      list: () => [...tools.values()],
      visible: () => [...tools.values()],
    },
    guards: { register: () => () => undefined },
    commands: { register: () => () => undefined },
    settings: { registerSection: () => () => undefined },
    prompt: {
      register(id: string, text: () => string, opts?: { order?: number }) {
        const record = { id, text, opts }
        prompts.push(record)
        return () => {
          const index = prompts.indexOf(record)
          if (index >= 0) prompts.splice(index, 1)
        }
      },
      registerProjection(id: string, apply: CapturedProjection['apply'], opts?: { order?: number }) {
        const record = { id, apply, opts }
        projections.push(record)
        return () => {
          const index = projections.indexOf(record)
          if (index >= 0) projections.splice(index, 1)
        }
      },
      systemPromptParts() {
        return buildSystemPromptParts(cwd, {
          skills: '',
          contributions: [
            ...prompts.map((entry) => ({
              id: entry.id,
              order: entry.opts?.order ?? 60,
              text: entry.text(),
            })),
            { id: 'model', order: 890, text: '当前模型：test-model（provider test）' },
          ],
        })
      },
    },
    session: {
      current: () => ({
        meta: session.meta,
        messages: session.messages,
        filePath: join(HOME, 'sessions', 'improve-stability.jsonl'),
        toolErrors: new Map<string, string>(),
        state: (name: string) => stateMap.get(name),
        appendState: (name: string, value: unknown) => stateMap.set(name, value),
        appendNote: session.appendNote,
      }),
    },
    transcript: { system: () => undefined },
    approval: { decide: async () => 'allow-once' },
    skills: { setEnabled: () => ({ ok: true }) },
    memory: { write: () => ({ ok: true }) },
    agent: { followup: () => undefined },
    emit: () => undefined,
    get: () => undefined,
    logger: { debug: () => undefined },
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
  wired.dispose = selfImprovePlugin.apply(ctx as never, config) as unknown as () => void
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

/** 通过 learning 工具的 propose 记一条候选（与真实路径同一条）。 */
async function propose(wired: Wired, text: string): Promise<string> {
  const tool = wired.tools.get('learning')
  expect(tool, 'apply 应当注册 learning 工具').toBeDefined()
  return tool!.run({ action: 'propose', text, kind: 'note' })
}

function tailProjection(wired: Wired): CapturedProjection {
  const projection = wired.projections.find((entry) => entry.id === 'self-improve')
  expect(projection, '缺 self-improve 尾部投影').toBeDefined()
  expect(projection?.opts?.order, '尾部投影排在 memory 索引（610）之后、microcompact（650）之前').toBe(620)
  return projection!
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function history(): Msg[] {
  return [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在' },
  ]
}

// ── 1. 系统提示逐字稳定 ─────────────────────────────────────────────────────

describe('系统提示逐字稳定', () => {
  test('propose 一条候选前后，整份系统提示与 sha256 都不变，静态段里没有条数/正文', async () => {
    const wired = mount()
    const before = wired.ctx.prompt.systemPromptParts()
    expect(before.text).toContain('learning 工具')
    expect(before.text).toContain('技能写入')

    const secret = `用户原话不该进提示词-${String(Date.now())}`
    expect(await propose(wired, secret)).toContain('已记候选')

    const after = wired.ctx.prompt.systemPromptParts()
    expect(after.text, '登记候选不得改动系统提示').toBe(before.text)
    expect(sha256(after.text)).toBe(sha256(before.text))
    // 静态段不许出现条数与候选正文。
    expect(after.text).not.toContain(secret)
    expect(after.text).not.toMatch(/\d+\s*条待审/)
    expect(after.text).not.toContain('候选清单里有')
  })

  test('关掉插件：系统提示与尾消息都为空', () => {
    const off = mount({ enabled: false })
    expect(off.prompts[0]?.text()).toBe('')
    const base = history()
    expect(tailProjection(off).apply(base)).toBe(base)
  })
})

// ── 2. 尾部投影 ─────────────────────────────────────────────────────────────

describe('尾部投影', () => {
  test('没有待审候选：原样返回同一个数组，不报卡、不落 note', () => {
    const wired = mount()
    const projection = tailProjection(wired)
    const base = history()
    const views: Array<Record<string, unknown>> = []
    expect(projection.apply(base, undefined, (view) => views.push(view)), 'N=0 不注入').toBe(base)
    expect(views).toHaveLength(0)
    expect(wired.notes).toHaveLength(0)
  })

  test('有候选：追加一条 user 消息、末行标记句；两次调用逐字相同、卡与 note 各一次', async () => {
    const wired = mount()
    await propose(wired, '一条待审经验')
    const projection = tailProjection(wired)
    const base = history()
    const views: Array<Record<string, unknown>> = []

    const out = projection.apply(base, undefined, (view) => views.push(view))
    expect(out.length).toBe(base.length + 1)
    const text = String(out.at(-1)?.content)
    expect(text).toContain('候选清单里有 1 条待审经验')
    expect(text.split('\n').at(-1)).toBe('（本条是程序自动附上的，不是用户发言）')
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ kind: 'self-improve', source: 'self-improve', where: 'user-tail' })
    expect(wired.notes.filter((item) => item.id === 'self-improve')).toHaveLength(1)

    // 同一份历史重跑（invariant 二次派生）：逐字相同、不再报卡、不再落 note。
    const again = projection.apply(base, undefined, (view) => views.push(view))
    expect(String(again.at(-1)?.content), '二次派生必须给同一个答案').toBe(text)
    expect(views, '正文没变不重复记卡').toHaveLength(1)
    expect(wired.notes, '同一份历史只落一条 note').toHaveLength(1)

    // 再登记一条：条数变了 → 正文变了 → 再记一张卡。
    await propose(wired, '第二条待审经验')
    const changed = projection.apply(history(), undefined, (view) => views.push(view))
    expect(String(changed.at(-1)?.content)).toContain('候选清单里有 2 条待审经验')
    expect(views).toHaveLength(2)
  })
})
