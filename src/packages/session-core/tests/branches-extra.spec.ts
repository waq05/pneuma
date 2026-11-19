/**
 * `@pneuma/session-core` 的**分支补网**：坏输入、默认值、失败与拒绝路径。
 *
 * 现有的 `session-core.spec.ts` 只钉库包身份与桶文件转出，集成用例又不在 unit 层跑；
 * 这个文件专门补 `compact.ts` / `modes.ts` / `prompt.ts` / `loop.ts` 里「正常路径之外」
 * 的那一半：
 *
 *   - compact：前置裁剪（纯截断 / spill 落盘 / 图片预算）、estimateTokens 的三种 content、
 *     切点的 token 预算与工具边界、compactSession 的 noop / 空摘要 / 摘要不缩小 / 成功落库。
 *   - modes：四档闸门的放行、拒绝与计划文件白名单；日期文件名、别名翻译、坏标识回落。
 *   - prompt：空段过滤与排序、指令文件截断/全局文件/读不到、`# agentsMd` 归并、
 *     keep 取舍、src 来源、环境事实缓存与子代理版本。
 *   - loop：上下文爆窗重试、流中断保留半截再续、工具分支（未知工具 / 坏 JSON / 拒绝 /
 *     执行抛错 / 多文件改动 + 卡片）、上下文注入与 invariant 失败只报不杀。
 *
 * 隔离：`HOME/USERPROFILE/DSC_HOME` 在**任何内核模块被加载之前**指向临时目录（这里的
 * import 全部是动态的）；临时仓库用 `git init` 造，不碰开发者的 `~/.dsc`。
 *
 * @module @pneuma/session-core/tests/branches-extra.spec
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync , realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatMessage, StreamHandlers, StreamRequest, StreamResult } from '@pneuma/runtime/core/llm.js'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { ToolGuardVerdict } from '@pneuma/runtime/core/tool-guards.js'

const HOME = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-session-core-branches-')))
const DSC = join(HOME, '.dsc')
mkdirSync(DSC, { recursive: true })
const savedEnv = {
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
  DSC_HOME: process.env['DSC_HOME'],
  DSC_PROFILE: process.env['DSC_PROFILE'],
  DSC_HOT: process.env['DSC_HOT'],
}
process.env['HOME'] = HOME
process.env['USERPROFILE'] = HOME
process.env['DSC_HOME'] = DSC
process.env['DSC_HOT'] = '0'
delete process.env['DSC_PROFILE']

let compact: typeof import('../compact.js')
let modes: typeof import('../modes.js')
let prompt: typeof import('../prompt.js')
let loop: typeof import('../loop.js')
let llm: typeof import('@pneuma/runtime/core/llm.js')
let Session: typeof import('@pneuma/runtime/core/session.js')['Session']

beforeAll(async () => {
  llm = await import('@pneuma/runtime/core/llm.js')
  compact = await import('../compact.js')
  modes = await import('../modes.js')
  prompt = await import('../prompt.js')
  loop = await import('../loop.js')
  Session = (await import('@pneuma/runtime/core/session.js')).Session
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 上目录可能还被句柄占着：留给系统清，不让收尾拖红测试。
  }
})

/** 建一个临时工作目录。 */
function workDir(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-branches-work-')))
}

/** 写文件（父目录一次建好）。 */
function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/** 一条普通消息（测试只关心 content / role）。 */
function msg(role: ChatMessage['role'], content: ChatMessage['content']): ChatMessage {
  return { role, content }
}

// ── compact：前置裁剪 ───────────────────────────────────────────────────────

describe('compact.pruneRegion：只动超限工具结果与超预算图片', () => {
  test('纯截断：短结果原样、长结果留前 N 字符并写明原长；工具里的图整条收成一句说明', () => {
    const long = 'x'.repeat(50)
    const out = compact.pruneRegion(
      [
        msg('tool', long),
        msg('tool', 'short'),
        msg('tool', [
          { type: 'text', text: 'before' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ]),
      ],
      's-pure',
      { imageBudget: 4, toolResultChars: 10 },
    )

    expect(out.spilledTools).toBe(1)
    expect(out.offloadedImages).toBe(1)
    expect(String(out.region[0]?.content)).toContain('（已裁剪，原长 50 字符）')
    expect(String(out.region[0]?.content)).toContain(long.slice(0, 10))
    expect(out.region[1]?.content).toBe('short')
    const toolParts = out.region[2]?.content as Array<{ type: string; text?: string }>
    expect(toolParts).toHaveLength(1)
    expect(toolParts[0]?.text).toContain('工具结果里的 1 张图已卸载')
    expect(toolParts[0]?.text).toContain('before')
  })

  test('用户图片按预算保留，超出预算的换成占位；文本部件原样留下', () => {
    const parts = [
      { type: 'text' as const, text: '看图' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,1' } },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,2' } },
    ]
    const out = compact.pruneRegion([msg('user', parts)], 's-img', { imageBudget: 1, toolResultChars: 10 })
    expect(out.offloadedImages).toBe(1)
    const next = out.region[0]?.content as Array<{ type: string; text?: string }>
    expect(next).toHaveLength(3)
    expect(next[1]?.type).toBe('image_url')
    expect(next[2]).toEqual({ type: 'text', text: '（图片已卸载，原文里这里是一张图）' })
  })

  test('配了 spill：超限工具结果落盘，预览仍超两倍预算时按字符再截一刀并补回指针', () => {
    const spill = {
      thresholdChars: 1,
      keepLines: 1000,
      readChunkLines: 10,
      maxBytes: 1_000_000,
      retentionDays: 1,
      maxTotalBytes: 10_000_000,
      dir: join(HOME, 'spill-test'),
    }
    const content = Array.from({ length: 50 }, (_, index) => `line-${String(index)}`).join('\n')
    const out = compact.pruneRegion([msg('tool', content)], 's-spill', {
      spill,
      imageBudget: 0,
      toolResultChars: 10,
    })

    expect(out.spilledTools).toBe(1)
    const text = String(out.region[0]?.content)
    expect(text).toContain('预览超限已截')
    expect(text).toContain('完整输出已落盘')
  })
})

describe('compact.estimateTokens：三种 content 与 tool_calls', () => {
  test('字符串、null、多模态部件、工具参数都计入；结果取整', () => {
    const text = compact.estimateTokens([msg('user', 'abcd')])
    expect(Number.isInteger(text)).toBe(true)
    expect(text).toBeGreaterThan(0)

    expect(compact.estimateTokens([msg('assistant', null)])).toBe(0)

    const image = compact.estimateTokens([
      msg('user', [
        { type: 'text', text: 'abcd' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,1' } },
      ]),
    ])
    expect(image).toBeGreaterThanOrEqual(1_000)

    const withCalls = compact.estimateTokens([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }],
      },
    ])
    expect(withCalls).toBeGreaterThan(0)
  })
})

describe('compact.selectCut / safeCut：token 预算、条数下限与工具配对边界', () => {
  const caps = {
    keepRecent: 2,
    anchorChars: 100,
    userQuoteChars: 100,
    readStateFiles: 1,
    readStateChars: 100,
  }

  test('retainTokens 缺省 = 0 时退回条数口径；keepRecent 为负按 0 处理', () => {
    const messages = Array.from({ length: 6 }, (_, index) => msg('user', `m${String(index)}`))
    expect(compact.selectCut(messages, caps)).toBe(4)
    expect(compact.selectCut(messages, { ...caps, keepRecent: -3 })).toBe(5)
  })

  test('预算大到走完整段：切点落回 0，不会被当成「留了几条」', () => {
    const messages = Array.from({ length: 5 }, (_, index) => msg('user', `m${String(index)}`))
    expect(compact.selectCut(messages, { ...caps, retainTokens: 1_000_000 })).toBe(0)
  })

  test('全是工具消息时安全切点退到 0（调用方据此判 noop）', () => {
    const messages = Array.from({ length: 4 }, () => msg('tool', 'x'))
    expect(compact.safeCut(messages, 3)).toBe(0)
    expect(compact.selectCut(messages, caps)).toBe(0)
  })
})

describe('compact.compactSession：noop、失败与成功落库', () => {
  interface FakeSession {
    messages: ChatMessage[]
    meta: { id: string }
    filePath: string
    replaced?: { summary: string; kept: ChatMessage[] }
    replaceWithSummary(summary: string, kept: ChatMessage[]): void
  }

  function fakeSession(messages: ChatMessage[]): FakeSession {
    const session: FakeSession = {
      messages,
      meta: { id: 'fake-session' },
      filePath: join(HOME, 'fake.jsonl'),
      replaceWithSummary(summary, kept) {
        session.replaced = { summary, kept }
      },
    }
    return session
  }

  const route = { api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm', maxTokens: 100, temperature: 0 }
  const context = { system: 'sys', tools: [{ name: 'read', description: 'r', parameters: {} }] as never }

  test('历史太短（<= keepRecent+2）直接 noop，不调模型', async () => {
    const session = fakeSession([msg('user', 'hi')])
    let calls = 0
    const result = await compact.compactSession(
      session as never,
      route,
      (async () => {
        calls += 1
        return { text: 'x', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      }) as never,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      context,
    )
    expect(result.outcome).toBe('noop')
    expect(result.beforeTokens).toBe(result.afterTokens)
    expect(calls).toBe(0)
  })

  test('切点退到 0（整段都是工具结果）也是 noop，即使 force', async () => {
    const session = fakeSession([msg('tool', 'x'), msg('tool', 'y')])
    let calls = 0
    const result = await compact.compactSession(
      session as never,
      route,
      (async () => {
        calls += 1
        return { text: 'x', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      }) as never,
      new AbortController().signal,
      undefined,
      { keepRecent: 0, anchorChars: 10, userQuoteChars: 10, readStateFiles: 0, readStateChars: 10 },
      true,
      undefined,
      context,
    )
    expect(result.outcome).toBe('noop')
    expect(calls).toBe(0)
  })

  test('摘要模型返回空白 → 抛错（不能把空摘要写回去）', async () => {
    const messages = Array.from({ length: 6 }, (_, index) => msg(index % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(200)))
    const session = fakeSession(messages)
    await expect(
      compact.compactSession(
        session as never,
        route,
        (async () => ({ text: '   ', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' })) as never,
        new AbortController().signal,
        undefined,
        { keepRecent: 2, anchorChars: 10, userQuoteChars: 10, readStateFiles: 0, readStateChars: 10 },
        true,
        undefined,
        context,
      ),
    ).rejects.toThrow(/摘要模型返回为空/)
  })

  test('摘要不比被折内容小 → 抛错（压缩不能把上下文撑大）', async () => {
    const session = fakeSession([msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')])
    await expect(
      compact.compactSession(
        session as never,
        route,
        (async () => ({ text: '短', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' })) as never,
        new AbortController().signal,
        undefined,
        { keepRecent: 0, anchorChars: 10, userQuoteChars: 10, readStateFiles: 0, readStateChars: 10 },
        true,
        undefined,
        context,
      ),
    ).rejects.toThrow(/压缩没有意义/)
  })

  test('成功：请求是「系统提示 + 原文 + 压缩指令」的前缀扩展，摘要与尾部落库', async () => {
    const messages = Array.from({ length: 6 }, (_, index) => msg(index % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(200)))
    const session = fakeSession(messages)
    let request: StreamRequest | undefined
    const result = await compact.compactSession(
      session as never,
      { ...route, cacheControl: true },
      (async (_api: string, req: StreamRequest) => {
        request = req
        return { text: '交接摘要', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' }
      }) as never,
      new AbortController().signal,
      '  额外状态  ',
      { keepRecent: 2, anchorChars: 50, userQuoteChars: 50, readStateFiles: 0, readStateChars: 50 },
      false,
      undefined,
      context,
    )

    expect(result.outcome).toBe('compacted')
    expect(result.afterTokens).toBeLessThan(result.beforeTokens)
    expect(request?.sessionId).toBe('fake-session')
    expect(request?.cacheControl).toBe(true)
    expect(request?.tools).toHaveLength(1)
    expect(request?.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(String(request?.messages.at(-1)?.content)).toContain('交接摘要')
    expect(session.replaced?.summary).toContain('交接摘要')
    expect(session.replaced?.summary).toContain('额外状态')
    expect(session.replaced?.kept[0]?.role).toBe('user')
  })

  test('limits 缺省用 DEFAULT_COMPACT_LIMITS、prune 缺省用默认口径（不传也能压）', async () => {
    const messages = Array.from({ length: 24 }, () => msg('user', 'x'.repeat(800)))
    const session = fakeSession(messages)
    const result = await compact.compactSession(
      session as never,
      route,
      (async () => ({ text: '短摘要', reasoning: '', toolCalls: [], usage: null, finishReason: 'stop' })) as never,
      new AbortController().signal,
      '',
      undefined,
      undefined,
      undefined,
      context,
    )
    expect(result.outcome).toBe('compacted')
    expect(session.replaced?.summary).toContain('短摘要')
  })
})

// ── modes：四档闸门与文件名 ────────────────────────────────────────────────

describe('modes：闸门分支', () => {
  const cwd = workDir()

  const gate = (spec: (typeof modes.MODES)[keyof typeof modes.MODES], input: Parameters<typeof modes.MODES.build.gate>[0]) =>
    spec.gate(input)

  test('build 永远 defer，交给权限模式与审批卡', () => {
    expect(gate(modes.MODES.build, { toolName: 'x', risk: 'exec', cwd })).toEqual({ action: 'defer' })
  })

  test('plan：读写计划文件放行；普通写入与危险命令拒绝；只读命令放行', () => {
    expect(gate(modes.MODES.plan, { toolName: 'read', risk: 'read', cwd })).toEqual({ action: 'pass' })

    const planFile = join(cwd, '.dsc', 'plans', 'x.md')
    expect(gate(modes.MODES.plan, { toolName: 'write', risk: 'write', cwd, target: planFile })).toEqual({
      action: 'pass',
    })
    const deniedWrite = gate(modes.MODES.plan, { toolName: 'write', risk: 'write', cwd, target: join(cwd, 'src', 'x.ts') })
    expect(deniedWrite.action).toBe('deny')
    if (deniedWrite.action === 'deny') expect(deniedWrite.reason).toContain('计划模式不改工程文件')

    expect(gate(modes.MODES.plan, { toolName: 'bash', risk: 'exec', cwd, command: 'ls -la' })).toEqual({
      action: 'pass',
    })
    const deniedCommand = gate(modes.MODES.plan, { toolName: 'bash', risk: 'exec', cwd, command: 'rm -rf build' })
    expect(deniedCommand.action).toBe('deny')
    if (deniedCommand.action === 'deny') expect(deniedCommand.reason).toContain('只跑只读命令')
  })

  test('explore：只读命令放行，写入与危险命令都拒；空命令不算只读', () => {
    expect(gate(modes.MODES.explore, { toolName: 'read', risk: 'read', cwd })).toEqual({ action: 'pass' })
    expect(gate(modes.MODES.explore, { toolName: 'bash', risk: 'exec', cwd, command: 'git status --porcelain' })).toEqual({
      action: 'pass',
    })
    const write = gate(modes.MODES.explore, { toolName: 'write', risk: 'write', cwd, target: join(cwd, 'a.ts') })
    expect(write.action).toBe('deny')
    if (write.action === 'deny') expect(write.reason).toContain('只读不写')
    const command = gate(modes.MODES.explore, { toolName: 'bash', risk: 'exec', cwd, command: 'rm -rf build' })
    expect(command.action).toBe('deny')
    if (command.action === 'deny') expect(command.reason).toContain('会改动东西')
    expect(gate(modes.MODES.explore, { toolName: 'bash', risk: 'exec', cwd, command: '   ' }).action).toBe('deny')
  })

  test('quiet：工作区内写放行、工作区外拒；只读命令放行、危险命令拒并带策略理由', () => {
    expect(gate(modes.MODES.quiet, { toolName: 'read', risk: 'read', cwd })).toEqual({ action: 'pass' })
    expect(
      gate(modes.MODES.quiet, { toolName: 'write', risk: 'write', cwd, target: join(cwd, 'nested', 'a.ts') }),
    ).toEqual({ action: 'pass' })
    const outside = gate(modes.MODES.quiet, {
      toolName: 'write',
      risk: 'write',
      cwd,
      target: join(tmpdir(), 'outside-branches', 'a.ts'),
    })
    expect(outside.action).toBe('deny')
    if (outside.action === 'deny') expect(outside.reason).toContain('工作目录内')

    expect(gate(modes.MODES.quiet, { toolName: 'bash', risk: 'exec', cwd, command: 'ls -la' })).toEqual({
      action: 'pass',
    })
    const dangerous = gate(modes.MODES.quiet, { toolName: 'bash', risk: 'exec', cwd, command: 'rm -rf build' })
    expect(dangerous.action).toBe('deny')
    if (dangerous.action === 'deny') expect(dangerous.reason).toContain('不弹审批卡')
  })
})

describe('modes：文件名、计划路径与别名', () => {
  test('planFileName：日期补零、标题转 slug、全标点回落 plan、超长截 40', () => {
    const at = new Date(2026, 0, 2, 3, 4)
    expect(modes.planFileName('Hello, World!', at)).toBe('20260102-0304-hello-world.md')
    expect(modes.planFileName('!!!', at)).toBe('20260102-0304-plan.md')
    expect(modes.planFileName(' 中文 标题 ', at)).toBe('20260102-0304-中文-标题.md')
    expect(modes.planFileName('a'.repeat(60), at)).toBe(`20260102-0304-${'a'.repeat(40)}.md`)
  })

  test('planFilePath：Windows 与 POSIX 两种分隔符都按基准目录拼', () => {
    const at = new Date(2026, 0, 2, 3, 4)
    expect(modes.planFilePath('C:\\work', 'T', at)).toBe('C:\\work\\.dsc\\plans\\20260102-0304-t.md')
    expect(modes.planFilePath('/work/', 'T', at)).toBe('/work/.dsc/plans/20260102-0304-t.md')
  })

  test('isPlanFileWrite：只认 .dsc/plans 下的 .md（大小写与斜杠都归一）', () => {
    expect(modes.isPlanFileWrite('C:\\work', 'C:/work/.dsc/plans/x.md')).toBe(true)
    expect(modes.isPlanFileWrite('C:\\work', 'C:\\work\\.dsc\\plans\\x.MD')).toBe(true)
    expect(modes.isPlanFileWrite('C:\\work', 'C:\\work\\.dsc\\plans\\x.txt')).toBe(false)
    expect(modes.isPlanFileWrite('C:\\work', 'C:\\work\\src\\x.md')).toBe(false)
    expect(modes.isPlanFileWrite('C:\\work', 'C:\\work\\.dsc\\plans\\nested\\x.md')).toBe(true)
    expect(modes.isPlanFileWrite('C:\\work', 'D:\\work\\.dsc\\plans\\x.md')).toBe(false)
  })

  test('modeSpec 坏标识回落 build；parseModeToken 认中英别名与大小写，未知给 null', () => {
    expect(modes.modeSpec('nope').id).toBe('build')
    expect(modes.modeSpec('quiet').id).toBe('quiet')
    expect(modes.parseModeToken(' PLAN ')).toBe('plan')
    expect(modes.parseModeToken('只读')).toBe('explore')
    expect(modes.parseModeToken('DND')).toBe('quiet')
    expect(modes.parseModeToken('执行')).toBe('build')
    expect(modes.parseModeToken('nope')).toBeNull()
  })
})

// ── prompt：装配、指令文件与环境事实 ───────────────────────────────────────

describe('prompt：分段与指令文件', () => {
  test('composePrompt 丢掉空白段，按 order 再按 id 排序', () => {
    const text = prompt.composePrompt([
      { id: 'b', order: 10, text: ' B ' },
      { id: 'a', order: 10, text: 'A' },
      { id: 'z', order: 0, text: '  ' },
      { id: 'c', order: 5, text: 'C' },
    ])
    expect(text).toBe('C\n\nA\n\nB')
  })

  test('buildSystemPromptParts：keep 只留指定段；插件段标 plugin:<id>；skills 去空白', () => {
    const cwd = workDir()
    const onlyIdentity = prompt.buildSystemPromptParts(cwd, { keep: (ids) => ids.filter((id) => id === 'identity') })
    expect(onlyIdentity.sections.map((section) => section.id)).toEqual(['identity'])
    expect(onlyIdentity.sections[0]?.from).toBe('core')

    const built = prompt.buildSystemPromptParts(cwd, {
      skills: '  技能目录  ',
      contributions: [
        { id: 'custom', order: 30, text: '插件段' },
        { id: 'memory', order: 5, text: '记忆正文', block: 'agents-md' },
      ],
    })
    expect(built.text).toContain('插件段')
    expect(built.text).toContain('# agentsMd')
    expect(built.text).toContain('长期记忆索引')
    const custom = built.sections.find((section) => section.id === 'custom')
    expect(custom?.from).toBe('plugin:custom')
    const skills = built.sections.find((section) => section.id === 'skills')
    expect(skills?.chars).toBe('技能目录'.length)
  })

  test('AGENTS.md 超预算：保留头尾、中间标省略；AGENTS.md 是目录时跳过且不抛', () => {
    const cwd = workDir()
    writeText(join(cwd, 'AGENTS.md'), '头'.repeat(80) + '尾'.repeat(80))
    const built = prompt.buildSystemPromptParts(cwd, { instructionBudget: 60 })
    expect(built.text).toContain('过长，中间省略')
    expect(built.text).toContain('【')

    const dirCwd = workDir()
    mkdirSync(join(dirCwd, 'AGENTS.md'), { recursive: true })
    const empty = prompt.buildSystemPromptParts(dirCwd, {
      instructionBudget: 100,
      keep: (ids) => ids.filter((id) => id === 'instructions'),
    })
    expect(empty.text).toBe('')
    expect(empty.sections).toEqual([])
  })

  test('全局指令文件（~/.dsc/AGENTS.md）与工作区文件都进同一个块；override 排最前', () => {
    const globalFile = join(HOME, '.dsc', 'AGENTS.md')
    writeText(globalFile, '全局指令')
    const cwd = workDir()
    writeText(join(cwd, 'AGENTS.md'), '项目指令')
    writeText(join(cwd, 'AGENTS.override.md'), '覆盖指令')

    const built = prompt.buildSystemPromptParts(cwd)
    expect(built.text).toContain('覆盖指令')
    expect(built.text).toContain('项目指令')
    expect(built.text).toContain('全局指令')
    // override 在 AGENTS.md 之前（同一目录先读它），文件路径按出现顺序。
    expect(built.text.indexOf('AGENTS.override.md')).toBeLessThan(built.text.indexOf('AGENTS.md'))
  })

  test('git 仓库里的 cwd：从仓库根到 cwd 逐层收集（根之上不再找）', () => {
    // 仓库本体一定是个 git 仓库；取一个嵌套目录，让「cwd → root」的链不止一层。
    const nested = join(process.cwd(), 'src', 'packages', 'session-core')
    const built = prompt.buildSystemPromptParts(nested)
    expect(built.sections.some((section) => section.id === 'instructions')).toBe(true)
    expect(built.text).toContain('AGENTS.md')
  })
})

describe('prompt：环境事实', () => {
  test('非 git 目录：有日期/平台/目录、没有分支行；同一 cwd 第二次读缓存结果一致', () => {
    const cwd = workDir()
    const first = prompt.environmentText(cwd)
    expect(first).toContain('环境事实')
    expect(first).toContain(cwd)
    expect(first).not.toContain('git 分支')
    expect(prompt.environmentText(cwd)).toBe(first)
  })

  test('git 仓库：分支行出现；子代理版只带 cwd 与模型、不查 git', () => {
    const repo = prompt.environmentText(process.cwd())
    expect(repo).toContain('git 分支')
    expect(prompt.subagentEnvironmentText('C:\\w', 'model-x')).toContain('你用的模型：model-x')
  })
})

// ── loop：爆窗、中断与工具分支 ─────────────────────────────────────────────

interface Harness {
  agent: InstanceType<typeof loop.MiniAgent>
  session: ReturnType<typeof Session.create>
  events: Array<{ type: string; [key: string]: unknown }>
  notices: string[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, ms))

async function settle(agent: InstanceType<typeof loop.MiniAgent>): Promise<void> {
  const deadline = Date.now() + 4_000
  while (agent.isRunning) {
    if (Date.now() > deadline) throw new Error('回合 4 秒内没有收尾')
    await sleep(10)
  }
}

interface HarnessOptions {
  tools?: ToolEntry[]
  stream: (api: string, request: StreamRequest, handlers: StreamHandlers) => Promise<StreamResult>
  gate?: (input: { toolName: string }) => Promise<ToolGuardVerdict>
  onContextOverflow?: (signal: AbortSignal) => Promise<boolean>
  rewrite?: (messages: ChatMessage[]) => ChatMessage[]
  takeContextInjections?: () => Array<{ kind: string; source: string; where: 'system' | 'user-tail'; chars: number; preview?: string }>
  observe?: (name: string, text: string) => string
}

function makeHarness(options: HarnessOptions): Harness {
  const work = workDir()
  const session = Session.create(work)
  const events: Harness['events'] = []
  const notices: string[] = []
  const agent = new loop.MiniAgent(
    {
      route: () => ({ api: 'test', baseUrl: 'http://localhost:0', apiKey: 'k', model: 'm' }),
      systemPrompt: () => ({ text: 'sys', sections: [] }),
      tools: () => options.tools ?? [],
      guards: {
        gate: async (input) => (await options.gate?.(input)) ?? { action: 'pass' },
        observe: (name, text) => (options.observe === undefined ? text : options.observe(name, text)),
      },
      emit: (event) => {
        events.push(event as unknown as Harness['events'][number])
      },
      stream: options.stream,
      notice: (text) => notices.push(text),
      ...(options.onContextOverflow === undefined ? {} : { onContextOverflow: options.onContextOverflow }),
      ...(options.rewrite === undefined ? {} : { rewrite: (messages) => options.rewrite!(messages) }),
      ...(options.takeContextInjections === undefined
        ? {}
        : { takeContextInjections: options.takeContextInjections }),
    },
    session,
  )
  return { agent, session, events, notices }
}

const okResult = (text: string, toolCalls: StreamResult['toolCalls'] = []): StreamResult => ({
  text,
  reasoning: '',
  toolCalls,
  usage: null,
  finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
})

describe('loop.runTurn：上下文爆窗与流中断', () => {
  test('400 爆窗：强制压缩一次后重试；重试成功不再抛错', async () => {
    let streamCalls = 0
    let overflowCalls = 0
    const harness = makeHarness({
      stream: async () => {
        streamCalls += 1
        if (streamCalls === 1) throw new llm.LlmError('maximum context length exceeded', 400)
        return okResult('好了')
      },
      onContextOverflow: async () => {
        overflowCalls += 1
        return true
      },
    })
    harness.agent.followup('hi')
    await settle(harness.agent)
    expect(streamCalls).toBe(2)
    expect(overflowCalls).toBe(1)
    expect(harness.events.some((event) => event.type === 'turn/end' && event['reason'] === 'completed')).toBe(true)
    harness.agent.dispose()
  })

  test('爆窗但压不出空间：原错误抛回，回合以 error 收尾并落一条 notice', async () => {
    let overflowCalls = 0
    const harness = makeHarness({
      stream: async () => {
        throw new llm.LlmError('prompt is too long', 400)
      },
      onContextOverflow: async () => {
        overflowCalls += 1
        return false
      },
    })
    harness.agent.followup('hi')
    await settle(harness.agent)
    expect(overflowCalls).toBe(1)
    expect(harness.events.some((event) => event.type === 'error')).toBe(true)
    expect(harness.session.notices().some((notice) => notice.kind === 'turn-error')).toBe(true)
    harness.agent.dispose()
  })

  test('非 400 / 文案不匹配的 LlmError 不走爆窗重试；普通异常也不走', async () => {
    let overflowCalls = 0
    const harness = makeHarness({
      stream: async () => {
        throw new llm.LlmError('server exploded', 500)
      },
      onContextOverflow: async () => {
        overflowCalls += 1
        return true
      },
    })
    harness.agent.followup('hi')
    await settle(harness.agent)
    expect(overflowCalls).toBe(0)
    expect(harness.events.some((event) => event.type === 'error')).toBe(true)
    harness.agent.dispose()
  })

  test('流中断（已收半截）：半截先落库、记一条 model-retry、再自动续一轮', async () => {
    let streamCalls = 0
    const harness = makeHarness({
      stream: async () => {
        streamCalls += 1
        if (streamCalls === 1) {
          throw new llm.StreamInterruptedError(
            '连接断了',
            okResult('半截回复'),
          )
        }
        return okResult('完整回复')
      },
    })
    harness.agent.followup('hi')
    await settle(harness.agent)

    expect(streamCalls).toBe(2)
    const messages = harness.events.filter((event) => event.type === 'message')
    expect(messages.some((event) => event['finishReason'] === 'interrupted')).toBe(true)
    const retry = harness.events.find((event) => event.type === 'model/retry')
    expect(retry?.['delayMs']).toBe(0)
    expect(harness.session.messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
    harness.agent.dispose()
  })
})

describe('loop.executeToolCalls：坏输入与失败分支', () => {
  test('未知工具 / 坏 JSON / 守卫拒绝 / 执行抛错 / 多文件改动与卡片各有正确落库', async () => {
    const change = {
      path: join(workDir(), 'a.ts'),
      added: 1,
      removed: 0,
      hunks: [],
      status: 'modified' as const,
      baseline: 'old',
    }
    const tools: ToolEntry[] = [
      { name: 'good', description: '', parameters: {}, risk: 'read', run: async () => 'ok' },
      { name: 'w', description: '', parameters: {}, risk: 'write', run: async () => 'should not run' },
      {
        name: 'boom',
        description: '',
        parameters: {},
        risk: 'read',
        run: async () => {
          throw new Error('工具炸了')
        },
      },
      {
        name: 'rich',
        description: '',
        parameters: {},
        risk: 'read',
        run: async () => ({
          text: 'rich-text',
          changesList: [change],
          presentation: { result: { card: 1 } },
        }),
      },
    ]
    let calls = 0
    const harness = makeHarness({
      tools,
      gate: async (input) => (input.toolName === 'w' ? { action: 'deny', reason: '不许写' } : { action: 'pass' }),
      stream: async () => {
        calls += 1
        if (calls === 1) {
          return okResult('', [
            { id: 'c1', name: 'ghost', arguments: '{}' },
            { id: 'c2', name: 'good', arguments: '{bad' },
            { id: 'c3', name: 'w', arguments: '{}' },
            { id: 'c4', name: 'boom', arguments: '{}' },
            { id: 'c5', name: 'rich', arguments: '{}' },
          ])
        }
        return okResult('done')
      },
    })

    harness.agent.followup('跑工具')
    await settle(harness.agent)

    const results = harness.events.filter((event) => event.type === 'tool/result')
    expect(results.map((event) => String(event['text'])).join(' | ')).toContain('未知工具：ghost')
    expect(results.map((event) => String(event['text'])).join(' | ')).toContain('参数不是合法 JSON')
    expect(results.find((event) => event['callId'] === 'c3')?.['error']).toBe('rejected')
    expect(String(results.find((event) => event['callId'] === 'c4')?.['text'])).toContain('工具炸了')
    expect(harness.events.some((event) => event.type === 'tool/changes')).toBe(true)
    expect(harness.events.some((event) => event.type === 'tool/presentation')).toBe(true)
    expect(harness.session.toolErrors.get('c3')).toBe('rejected')
    expect(harness.session.toolErrors.get('c4')).toBe('tool-error')
    harness.agent.dispose()
  })

  test('观察者改写过的工具结果只落改写后的文本', async () => {
    let calls = 0
    const harness = makeHarness({
      tools: [{ name: 'secret', description: '', parameters: {}, risk: 'read', run: async () => 'sk-xxx' }],
      observe: (_name, text) => text.replace('sk-xxx', '[已遮红]'),
      stream: async (_api, _request, _handlers) => {
          calls += 1
        return calls === 1
          ? okResult('', [{ id: 'c1', name: 'secret', arguments: '{}' }])
          : okResult('done')
      },
    })
    harness.agent.followup('读密钥')
    await settle(harness.agent)
    const result = harness.events.find((event) => event.type === 'tool/result')
    expect(String(result?.['text'])).toBe('[已遮红]')
    const toolMessage = harness.session.messages.find((message) => message.role === 'tool')
    expect(String(toolMessage?.content)).toBe('[已遮红]')
    harness.agent.dispose()
  })
})

describe('loop.requestOnce：上下文注入与 invariant 只报不杀', () => {
  test('注入清单落盘并广播；同一轮第二次请求不再重复报', async () => {
    let injected = false
    const harness = makeHarness({
      takeContextInjections: () => {
        if (injected) return []
        injected = true
        return [{ kind: 'env-facts', source: 'prompt', where: 'user-tail', chars: 5, preview: 'abc' }]
      },
      stream: async () => okResult('好'),
    })
    harness.agent.followup('hi')
    await settle(harness.agent)
    const event = harness.events.find((item) => item.type === 'context/injected')
    expect((event?.['parts'] as unknown[]).length).toBe(1)
    expect(harness.session.state('context-injected')?.parts).toHaveLength(1)
    harness.agent.dispose()
  })

  test('invariant 重建抛错：只报一条 notice（请求照常完成），不把回合打红', async () => {
    let rewriteCalls = 0
    const harness = makeHarness({
      rewrite: (messages) => {
        rewriteCalls += 1
        if (rewriteCalls > 1) throw new Error('投影坏了')
        return messages
      },
      stream: async () => okResult('照常回答'),
    })
    harness.agent.followup('hi')
    await settle(harness.agent)
    expect(harness.notices.join(' | ')).toContain('请求 invariant 这轮没跑成')
    expect(harness.events.some((event) => event.type === 'message')).toBe(true)
    expect(harness.events.some((event) => event.type === 'error')).toBe(false)
    harness.agent.dispose()
  })
})
