/**
 * prompt 装配面（`packages/prompt/index.ts`）：系统提示分段注册 / 骨架过滤 / 命名投影链 /
 * 环境快照与上报台账。
 *
 * 假 ctx 只提供 llm / skills / session / emit，`apply` 是真的；提示词拼装走真实的
 * `session-core/prompt`，因此 AGENTS.md 与预算口径也是真的（临时目录里写文件）。
 * `DSC_HOME` 在任何 import 之前指进临时目录。
 *
 * @module dsc/packages/prompt/tests/wiring.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { CONTEXT_INJECTION_KINDS } from '@pneuma/runtime/contract.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-prompt-wiring-'))
process.env['DSC_HOME'] = HOME
const ROOT = mkdtempSync(join(tmpdir(), 'dsc-prompt-cwd-'))

type PromptModule = typeof import('../index.js')
const promptPlugin: PromptModule['promptPlugin'] = (await import('../index.js')).promptPlugin

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** 一条消息（内容形状由用例自己决定）。 */
type Message = { role: string; content: unknown; [key: string]: unknown }

/** rewrite 的上报条目。 */
interface InjectionReport {
  kind: string
  source: string
  where: string
  chars: number
  preview: string
}

/** 最小假会话：env-facts 的 hash 去重要真读真写。 */
interface FakeSession {
  meta: { id: string; cwd: string }
  state(id: string): { hash?: string; text?: string } | undefined
  appendState(id: string, payload: { hash: string; text: string }): void
}

interface PromptService {
  register(
    id: string,
    text: (scope?: unknown) => string,
    options?: { order?: number; block?: 'agents-md' },
  ): () => void
  registerEnvFacts(id: string, fn: (session?: unknown) => string): () => void
  registerProjection(
    id: string,
    fn: (messages: Message[], session?: unknown, report?: (view: InjectionReport) => void) => Message[],
    options?: { order?: number },
  ): () => void
  sections(scope?: unknown): Array<{ id: string; text: string; from?: string; chars?: number }>
  registerSkeletonFilter(id: string, fn: (ids: readonly string[], scope?: unknown) => readonly string[]): () => void
  systemPrompt(cwd: string, scope?: unknown): string
  systemPromptParts(cwd: string, scope?: unknown): { text: string; sections: Array<{ id: string; from?: string }> }
  rewrite(
    messages: Message[],
    session?: unknown,
    report?: (view: InjectionReport) => void,
  ): Message[]
}

interface Harness {
  service: PromptService
  notices: string[]
}

/** 假 ctx 真 apply。 */
function fakeCtx(options: { passed?: Record<string, unknown>; modalities?: string[]; session?: FakeSession } = {}): Harness {
  const notices: string[] = []
  const services = new Map<string, unknown>()
  const session =
    options.session ??
    ({
      meta: { id: 'sess-1', cwd: ROOT },
      state: () => undefined,
      appendState: () => undefined,
    } satisfies FakeSession)
  const ctx = {
    llm: { model: 'dsc-model', provider: 'deepseek', inputModalities: options.modalities ?? [] },
    skills: { catalogText: () => '<available_skills>demo</available_skills>' },
    session: { current: () => session },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    emit(name: string, payload?: unknown) {
      if (name === 'dsc/notice') notices.push(String(payload))
    },
  }
  promptPlugin.apply(ctx as never, options.passed as never)
  return { service: services.get('prompt') as PromptService, notices }
}

/** 一个会记账的假会话。 */
function recordingSession(id: string, cwd = ROOT): { session: FakeSession; states: Array<{ id: string; payload: unknown }> } {
  const map = new Map<string, unknown>()
  const states: Array<{ id: string; payload: unknown }> = []
  return {
    states,
    session: {
      meta: { id, cwd },
      state: (key) => map.get(key) as { hash?: string; text?: string } | undefined,
      appendState: (key, payload) => {
        map.set(key, payload)
        states.push({ id: key, payload })
      },
    },
  }
}

/** 造一个 cwd 并写入 AGENTS.md。 */
function projectWithInstructions(body: string, name = 'proj'): string {
  const dir = join(ROOT, `${name}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'AGENTS.md'), body, 'utf8')
  return dir
}

describe('系统提示分段', () => {
  test('核心段 + 插件段 + 模型信息都在；退订只撤自己那份，重复注册后者顶前者', () => {
    const h = fakeCtx()
    const dir = projectWithInstructions('项目规则一句话', 'register')
    const off = h.service.register('demo', () => '来自插件的一段', { order: 300 })
    const parts = h.service.systemPromptParts(dir)
    const ids = parts.sections.map((section) => section.id)
    expect(ids).toEqual(expect.arrayContaining(['identity', 'behavior', 'tool-rules', 'demo', 'instructions', 'skills', 'model']))
    expect(parts.text).toContain('来自插件的一段')
    expect(parts.text).toContain('项目规则一句话')
    expect(parts.text).toContain('当前模型：dsc-model（provider deepseek）')
    expect(parts.text).toContain('<available_skills>demo</available_skills>')
    expect(parts.sections.find((section) => section.id === 'demo')?.from).toBe('plugin:demo')

    const offLate = h.service.register('demo', () => '后来那段')
    off()
    expect(h.service.systemPrompt(dir)).toContain('后来那段')
    expect(h.service.systemPrompt(dir)).not.toContain('来自插件的一段')
    offLate()
    expect(h.service.systemPrompt(dir)).not.toContain('后来那段')
  })

  test('段正文抛错只跳过这一段；scope.cwd 决定读哪份 AGENTS.md', () => {
    const h = fakeCtx()
    const dirA = projectWithInstructions('A 的规则', 'scope-a')
    const dirB = projectWithInstructions('B 的规则', 'scope-b')
    h.service.register('boom', () => {
      throw new Error('炸了')
    })
    expect(h.service.systemPrompt(dirA)).toContain('A 的规则')
    expect(h.service.systemPrompt(dirA, { cwd: dirB })).toContain('B 的规则')
    // sections(scope) 也把 scope 原样交给段取词函数
    h.service.register('scoped', (scope) => `cwd:${(scope as { cwd?: string } | undefined)?.cwd ?? 'none'}`)
    expect(h.service.sections({ cwd: 'C:/scope' }).find((section) => section.id === 'scoped')?.text).toBe('cwd:C:/scope')
  })

  test('块归并：agents-md 段并进指令块，不单独成段', () => {
    const h = fakeCtx()
    const dir = projectWithInstructions('项目规则', 'block')
    h.service.register('memory', () => '记忆索引正文', { block: 'agents-md' })
    const parts = h.service.systemPromptParts(dir)
    expect(parts.text).toContain('长期记忆索引')
    expect(parts.text).toContain('记忆索引正文')
    expect(parts.sections.some((section) => section.id === 'memory')).toBe(false)
    expect(parts.sections.some((section) => section.id === 'instructions')).toBe(true)
  })

  test('骨架过滤：留哪些段；过滤器抛错当它不存在并说明', () => {
    const h = fakeCtx()
    const dir = projectWithInstructions('规则', 'filter')
    h.service.registerSkeletonFilter('minimal', (ids) => ids.filter((id) => id === 'identity' || id === 'model'))
    expect(h.service.systemPromptParts(dir).sections.map((section) => section.id)).toEqual(['identity', 'model'])

    h.service.registerSkeletonFilter('boom', () => {
      throw new Error('取舍炸了')
    })
    const parts = h.service.systemPromptParts(dir)
    // 崩掉的那一位当不存在：前一位的取舍结果原样保留。
    expect(parts.sections.map((section) => section.id)).toEqual(['identity', 'model'])
    expect(h.notices.at(-1)).toContain('提示词段取舍 boom 这轮没跑成')
  })

  test('指令预算：配置夹在 4k~200k，超长文件只留头尾', () => {
    const tight = fakeCtx({ passed: { instructionBudget: 1 } })
    const dir = projectWithInstructions('y'.repeat(5000), 'budget')
    expect(tight.service.systemPrompt(dir)).toContain('过长，中间省略')

    const roomy = fakeCtx({ passed: { instructionBudget: 999_999 } })
    const text = roomy.service.systemPrompt(dir)
    expect(text).toContain('y'.repeat(5000))
    expect(text).not.toContain('过长，中间省略')
  })
})

describe('命名投影链', () => {
  test('内核保留名不许顶掉；自定义投影按 order 跑，崩了只跳过并说一声', () => {
    const h = fakeCtx()
    expect(() => h.service.registerProjection('fold-system', (messages) => messages)).toThrow('内核保留的')
    expect(() => h.service.registerProjection('drop-images', (messages) => messages)).toThrow('内核保留的')

    const off = h.service.registerProjection('marker', (messages) =>
      messages.map((message) => ({ ...message, content: `${String(message.content)}|marker` })),
    { order: 100 })
    const messages: Message[] = [{ role: 'user', content: '你好' }]
    const out = h.service.rewrite(messages)
    expect(out[0]?.content).toBe('你好|marker')
    // env-facts 永远追加在末尾（order 600）。
    expect(out.at(-1)).toMatchObject({ role: 'user' })
    expect(String(out.at(-1)?.content)).toContain('环境事实：')

    off()
    h.service.registerProjection('boom', () => {
      throw new Error('投影炸了')
    })
    expect(h.service.rewrite(messages)[0]?.content).toBe('你好')
    expect(h.notices.at(-1)).toContain('投影 boom 这轮没跑成')
  })

  test('fold-system：多条 system 并进头部；tool-result-prune 切掉超长工具结果', () => {
    const h = fakeCtx()
    const folded = h.service.rewrite([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: '问' },
    ])
    expect(folded[0]).toMatchObject({ role: 'system', content: 'A\n\nB' })
    expect(folded.filter((message) => message.role === 'system')).toHaveLength(1)

    // P2a 起是批量落点：单条候选自己就得能省出阈值（16K 字符）才会当场切。
    // 9K 的正文切开只省约 3.8K，不够一批——那正是这一轮要的语义，所以这里用 30K。
    const long = 'x'.repeat(30_000)
    const recent = Array.from({ length: 4 }, () => ({ role: 'tool', content: '最近的结果' }))
    const pruned = h.service.rewrite([{ role: 'tool', content: long }, ...recent])
    expect(String(pruned[0]?.content)).toContain('省掉了')
    expect(String(pruned[0]?.content).length).toBeLessThan(long.length)
  })

  test('tool-result-prune 批量落点：同一份历史投影两次逐字节相同（invariant 的二次派生）', () => {
    const h = fakeCtx()
    const long = 'x'.repeat(30_000)
    const recent = Array.from({ length: 4 }, () => ({ role: 'tool', content: '最近的结果' }))
    const messages: Message[] = [{ role: 'tool', content: long }, ...recent]
    const first = h.service.rewrite(messages)
    const second = h.service.rewrite(messages)
    // 第二次进来时 key 已在粘性集合里：输出必须与第一次逐字节相同，否则 invariant 每轮误报。
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  test('drop-images：模型不声明图片输入时换成一句说明；声明了原样保留', () => {
    const image: Message = { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }
    const blind = fakeCtx({ modalities: [] })
    const dropped = blind.service.rewrite([{ ...image }])
    expect(dropped[0]?.content).toEqual([{ type: 'text', text: '看图\n（当前模型没有声明照片输入能力，图像没有随请求发送）' }])

    const sighted = fakeCtx({ modalities: ['text', 'image'] })
    const kept = sighted.service.rewrite([{ ...image }])
    expect(Array.isArray(kept[0]?.content)).toBe(true)
    expect((kept[0]?.content as Array<{ type: string }>).some((part) => part.type === 'image_url')).toBe(true)
  })
})

describe('环境快照与上报台账', () => {
  test('片段按登记顺序拼进快照，落状态条目；同一份环境不重复上报', () => {
    const { session, states } = recordingSession('sess-env')
    const h = fakeCtx({ session })
    h.service.registerEnvFacts('mode', () => '当前模式：plan')
    h.service.registerEnvFacts('sandbox', () => '沙箱：workspace-write')
    h.service.registerEnvFacts('boom', () => {
      throw new Error('片段炸了')
    })

    const reports: InjectionReport[] = []
    const out = h.service.rewrite([{ role: 'user', content: '开始' }], session, (view) => reports.push(view))
    const snapshot = String(out.at(-1)?.content)
    expect(snapshot).toContain('环境事实：')
    expect(snapshot).toContain('当前模式：plan')
    expect(snapshot).toContain('沙箱：workspace-write')
    expect(snapshot).toContain('本条是程序在每次请求时自动附上的当前环境快照')
    expect(snapshot).not.toContain('片段炸了')
    expect(states.some((entry) => entry.id === 'env-facts')).toBe(true)

    expect(reports.map((report) => report.kind)).toEqual(
      expect.arrayContaining([CONTEXT_INJECTION_KINDS.envFacts, 'mode', 'sandbox']),
    )
    expect(reports[0]).toMatchObject({ source: 'env-facts', where: 'user-tail' })
    expect(reports[0]!.chars).toBeGreaterThan(0)
    expect(reports[0]!.preview.length).toBeGreaterThan(0)

    // 同一份环境再跑一遍：注入照发（快照仍在），但不再新增上报卡。
    const before = reports.length
    const again = h.service.rewrite([{ role: 'user', content: '继续' }], session, (view) => reports.push(view))
    expect(again).toHaveLength(2)
    expect(reports).toHaveLength(before)
  })

  test('envRefreshMs > 0：环境没变且没到点就整条不发', () => {
    const { session } = recordingSession('sess-refresh')
    const h = fakeCtx({ passed: { envRefreshMs: 60_000 }, session })
    const first = h.service.rewrite([{ role: 'user', content: '一' }], session)
    expect(first).toHaveLength(2)

    const secondMessages: Message[] = [{ role: 'user', content: '二' }]
    const second = h.service.rewrite(secondMessages, session)
    // 没追加环境快照（前面 image-diet 会换一层数组，所以按长度与内容断言）。
    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ role: 'user', content: '二' })
  })

  test('退订片段后快照里不再出现它', () => {
    const { session } = recordingSession('sess-off')
    const h = fakeCtx({ session })
    const off = h.service.registerEnvFacts('mode', () => '当前模式：plan')
    expect(String(h.service.rewrite([{ role: 'user', content: 'x' }], session).at(-1)?.content)).toContain('当前模式：plan')
    off()
    expect(String(h.service.rewrite([{ role: 'user', content: 'y' }], session).at(-1)?.content)).not.toContain('当前模式：plan')
  })
})
