/**
 * 长期记忆对齐（memory parity）：真内核 + 临时 HOME + 临时 git 工作区
 * （迁自 `scripts/memory-parity-test.mjs`）。
 *
 * ## 钉住七件事
 *
 *   ① 记忆当轮生效——写入后同一个会话的下一次请求（systemPrompt）里就有那条记忆；
 *   ② `# agentsMd` 合并注入——AGENTS.md 与记忆索引在同一个块；只有记忆时标题仍在；
 *   ③ 老 `§` 纯文本格式向后兼容——能读、能写、写回形状合法（事实不加 `[fact]` 前缀）；
 *   ④ 类型解析——`feedback` / `reference` / 缺省（fact）在存储与注入里的呈现；
 *   ⑤ 整理（prune）保守性——只移不删、未被引用的优先被移、归档文件收得下；
 *   ⑥ 抽取跳过规则——本段直写过记忆、或没有 ≥3 词的独立用户文本块时不发起复盘；
 *      另加一条正向对照：条件满足时复盘确实会起（否则前两条的「没起」不算数）；
 *   ⑦ 一次性「记忆副本已过期」提醒——写入后下一拍挂上，读一次就消失（不常驻）。
 *
 * ## 为什么必须真内核
 *
 * 这些口径横跨插件装配：记忆服务算快照、prompt 服务把快照拼进系统提示、session 服务
 * 切换会话、工具层收 `memory` 调用。任何一段用假件替代，「同一会话下一次 systemPrompt
 * 里立刻有」这条最关键的断言就变成验夹具。
 *
 * ## 迁移差异
 *
 * - 工作区用 harness 的 `tempRepo()`（真 `git init` + chdir），不再手写一份 git 夹具；
 * - 两个会话文件用 `Session.create` + `close` 生成（探针是手拼 jsonl），会话目录口径交给
 *   内核自己算，少一处「目录名怎么拼」的重复事实源；
 * - 「过期提醒」那一段从探针的 ⑦ 挪到 ① 之后（原顺序在 ① 与 ② 之间）：它依赖「刚写过」，
 *   和 ① 连在一起读才看得出为什么只出现一次。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, tempRepo, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录。 */
const home = tempHome('dsc-memory-parity-')
/** 临时 git 工作区：指令文件按仓库根锚定，git 状态也在它身上。 */
const repo = tempRepo('dsc-memory-parity-repo-')
/** `.dsc` 目录（与 integration setup 口径一致：走 HOME，不设 DSC_HOME）。 */
const dsc = join(home.home, '.dsc')
/** 工作区（= 判走 `meta.cwd` 的那个目录）。 */
const ws = repo.dir

/** 内核里本文件用到的服务面。 */
interface MemoryCell {
  target: string
  entries: string[]
}

interface SessionView {
  filePath: string
  messages: Array<{ role: string; content: unknown }>
  meta: { id: string }
}

/** 一条工具（本文件只用 `memory` 那条）。 */
interface ToolEntry {
  name: string
  run(args: Record<string, unknown>, ctx: unknown): Promise<unknown>
}

interface Services {
  memory: { cells(): MemoryCell[]; snapshot(): string; prune(target: string): string }
  prompt: { systemPrompt(cwd: string): string }
  session: { current(): SessionView; open(filePath: string): Promise<void> }
  tools: { list(): ToolEntry[] }
  emit(event: string, reason: string, payload: unknown): void
  agent: { isRunning(filePath: string): boolean }
}

type MemoryModule = typeof import('@pneuma/runtime/packages/memory/memory.js')
type SessionModule = typeof import('@pneuma/runtime/core/session.js')

let llm: FakeLLM
let kernel: BootedKernel
let services: Services
let memory: MemoryModule
let sessionCore: SessionModule
/** 主会话文件（有实质用户发言，复盘条件满足）。 */
let sessionFile: string
let sessionId: string
/** 短应答会话文件（没有 ≥3 词的独立用户文本块）。 */
let shortFile: string
let shortId: string
/** memory 工具。 */
let memoryTool: ToolEntry

/** 一次工具调用的上下文。 */
function runCtx(): { cwd: string; sessionId: string; signal: AbortSignal } {
  return { cwd: ws, sessionId: services.session.current().meta.id, signal: new AbortController().signal }
}

/** 拼一次「下一步请求要发的」系统提示（不等新会话、不压缩）。 */
function systemPrompt(): string {
  return services.prompt.systemPrompt(ws)
}

/** 当前会话的消息全文（复盘是否起了就看它）。 */
function messagesText(): string {
  return JSON.stringify(services.session.current().messages)
}

/** 读一个格子文件（不存在时给空串）。 */
function readCellFile(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

/** 造一个会话文件：建 → 写一句 → 关（关掉才释放写租约，后面内核要接着用它）。 */
async function makeSession(module: SessionModule, text: string): Promise<{ file: string; id: string }> {
  const session = module.Session.create(ws)
  session.appendUser(text)
  const file = session.filePath
  const id = session.meta.id
  session.close()
  // 会话日志是流式追加：close() 只负责 end()，等落盘有 finish 那一拍。
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  return { file, id }
}

beforeAll(async () => {
  mkdirSync(dsc, { recursive: true })
  writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
  // 记忆插件的可调值走条目树：关掉会话打开时的自动整理（本文件自己控时机），陈旧阈值压到 0
  // （只要没被引用过就具备被移的资格），复盘节拍压到 1（跳过规则才验得了）。
  writeFileSync(
    join(dsc, 'plugins.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            file: 'memory',
            config: { pruneEnabled: false, pruneAfterDays: 0, reviewEnabled: true, reviewEveryTurns: 1 },
          },
          { file: 'sandbox', disabled: true },
          { file: 'session-title', disabled: true },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
  // 老格式记忆文件：内核起来之前就摆在盘上（不然后续读会被当成「外部改动」）。
  const memGlobal = join(dsc, 'memory', 'global')
  mkdirSync(memGlobal, { recursive: true })
  const globalFile = join(memGlobal, 'MEMORY.md')
  writeFileSync(globalFile, '老格式条目甲\n§\n老格式条目乙\n', 'utf8')

  // 工作区：一个真 git 仓库，指令文件与快照都按仓库根锚定。
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: ws, stdio: 'ignore', windowsHide: true })
  }
  writeFileSync(join(ws, 'a.txt'), 'one\n', 'utf8')
  git('add', 'a.txt')
  git('commit', '-qm', 'init')

  memory = await import('@pneuma/runtime/packages/memory/memory.js')
  sessionCore = await import('@pneuma/runtime/core/session.js')
  const main = await makeSession(sessionCore, '这是一条足够长的探针发言')
  const short = await makeSession(sessionCore, '嗯')
  sessionFile = main.file
  sessionId = main.id
  shortFile = short.file
  shortId = short.id

  // 复盘会起一轮真回合（正向对照），剧本给几轮「收到」就够。
  llm = await fakeLLM({ turns: ['收到', '收到', '收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl, resumeSessionPath: sessionFile })
  services = kernel.ctx as unknown as Services
  memoryTool = services.tools.list().find((tool) => tool.name === 'memory')!
})

afterAll(async () => {
  // ⑥ 的正向对照起了一轮复盘回合（真请求）：等它收尾再拆内核。不等的话，回合后半段会拿到
  // 已卸载的 session 服务，vitest 把这句 unhandled error 记成整套失败（不是断言失败）。
  const deadline = Date.now() + 20_000
  if (kernel !== undefined) {
    const filePath = services.session.current().filePath
    while (Date.now() < deadline) {
      if (!services.agent.isRunning(filePath)) {
        await new Promise((resolveQuiet) => setTimeout(resolveQuiet, 400))
        if (!services.agent.isRunning(filePath)) break
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 50))
    }
  }
  repo.restore()
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

describe('[前提] 插件与工具就位，老格式文件读成两条 fact', () => {
  test('memory 服务在册、memory 工具在册', () => {
    expect(services.memory).toBeDefined()
    expect(memoryTool).toBeDefined()
  })

  test('老格式文件读成两条 fact', () => {
    const cell = services.memory.cells().find((item) => item.target === 'global')
    expect(cell?.entries).toHaveLength(2)
  })
})

describe('③ 老 `§` 纯文本向后兼容：读 → 写 → 形状合法', () => {
  test('老条目都解析成 fact（存储里没有类型前缀）', () => {
    const cell = services.memory.cells().find((item) => item.target === 'global')
    expect((cell?.entries ?? []).every((entry) => memory.entryType(entry) === 'fact')).toBe(true)
  })

  test('在老格式文件上继续写：回执说已记下，三条都在且每条仍是 fact', async () => {
    const result = String(await memoryTool.run({ target: 'global', action: 'add', content: '老格式新增丙' }, runCtx()))
    expect(result).toMatch(/已更新|已记下/)
    const cell = services.memory.cells().find((item) => item.target === 'global')
    expect(cell?.entries).toHaveLength(3)
    expect((cell?.entries ?? []).every((entry) => memory.entryType(entry) === 'fact')).toBe(true)
  })

  test('磁盘形状合法（§ 分隔、结尾换行、事实不带 [fact] 前缀）', () => {
    const onDisk = readCellFile(join(dsc, 'memory', 'global', 'MEMORY.md'))
    expect(onDisk).toContain('\n§\n')
    expect(onDisk.endsWith('\n')).toBe(true)
    expect(onDisk).not.toContain('[fact]')
    expect(memory.splitEntries(onDisk)).toHaveLength(3)
  })
})

describe('① 记忆当轮生效：写入后同一会话的下一次注入快照里就有', () => {
  /** 这一节用的标记（同一会话里只出现一次就够了）。 */
  const marker = '同轮生效标记XYZ-2026'

  test('写入前注入里没有这条标记，写入回执说已记下', async () => {
    expect(systemPrompt()).not.toContain(marker)
    const result = String(await memoryTool.run({ target: 'global', action: 'add', content: marker }, runCtx()))
    expect(result).toMatch(/已记下|已更新/)
  })

  test('同一会话的下一次 systemPrompt 里立刻有这条标记（不等新会话/压缩）', () => {
    expect(systemPrompt()).toContain(marker)
    expect(services.memory.snapshot()).toContain(marker)
  })
})

describe('⑦ 一次性「记忆副本已过期」提醒', () => {
  test('写入后紧接着的一次请求带上过期提醒，读过一次就不再出现', async () => {
    await memoryTool.run({ target: 'global', action: 'add', content: '过期提醒探针条目' }, runCtx())
    const first = systemPrompt()
    const second = systemPrompt()
    expect(first).toContain('记忆副本已过期')
    expect(second).not.toContain('记忆副本已过期')
  })
})

describe('② 与 AGENTS.md 合并注入 `# agentsMd`', () => {
  test('只有记忆、没有 AGENTS.md 时标题仍在，且只有一个', () => {
    const base = systemPrompt()
    expect(base).toContain('# agentsMd')
    expect((base.match(/# agentsMd/g) ?? []).length).toBe(1)
  })

  test('AGENTS.md 与记忆索引进同一个块，标题在先、仍只有一个', () => {
    const marker = 'AGENTS-合并块标记-7788'
    try {
      writeFileSync(join(ws, 'AGENTS.md'), `项目说明：${marker}\n`, 'utf8')
      const merged = systemPrompt()
      const titleAt = merged.indexOf('# agentsMd')
      const agentsAt = merged.indexOf(marker)
      const memoryAt = merged.indexOf('全局事实记忆')
      expect(titleAt).toBeGreaterThanOrEqual(0)
      expect(agentsAt).toBeGreaterThan(titleAt)
      expect(memoryAt).toBeGreaterThan(titleAt)
      expect(memoryAt).toBeGreaterThan(agentsAt)
      expect((merged.match(/# agentsMd/g) ?? []).length).toBe(1)
    } finally {
      rmSync(join(ws, 'AGENTS.md'), { force: true })
    }
  })

  test('撤掉 AGENTS.md 后标题仍在、记忆仍在', () => {
    const only = systemPrompt()
    expect(only).toContain('# agentsMd')
    expect(only).toContain('全局事实记忆')
  })
})

describe('④ 类型解析与注入呈现', () => {
  test('存储里 fact / feedback / reference 三种类型都在', async () => {
    await memoryTool.run(
      {
        target: 'global',
        action: 'add',
        type: 'feedback',
        content: '用户要求提交信息用中文。Why：团队约定。How to apply：commit message 一律中文。',
      },
      runCtx(),
    )
    await memoryTool.run(
      { target: 'global', action: 'add', type: 'reference', content: '参考 docs/deploy.md 记录了部署口径，不是结论。' },
      runCtx(),
    )
    const cell = services.memory.cells().find((item) => item.target === 'global')
    const types = (cell?.entries ?? []).map((entry) => memory.entryType(entry))
    expect(types).toContain('feedback')
    expect(types).toContain('reference')
    expect(types).toContain('fact')
  })

  test('注入里把 feedback / reference 的类型标记打在正文前，缺省类型不写前缀', () => {
    const text = systemPrompt()
    expect(text).toContain('[feedback] 用户要求提交信息用中文')
    expect(text).toContain('[reference] 参考 docs/deploy.md')
    expect(text).not.toContain('[fact]')
  })
})

describe('⑤ 整理保守性：只移不删、未被引用的优先被移', () => {
  test('被引用过的留下、其余移走、归档里找得到，且回执是人话', () => {
    const before = services.memory.cells().find((item) => item.target === 'global')
    const keepEntry = '老格式条目甲'
    // 直接写台账：把「甲」标成被引用过（模拟隐式反馈命中）。
    writeFileSync(memory.usageFile(), JSON.stringify({ [memory.entryUsageKey('global', keepEntry)]: { count: 3, last: Date.now() } }), 'utf8')

    const message = services.memory.prune('global')
    const after = services.memory.cells().find((item) => item.target === 'global')
    const archive = memory.archiveFileOf('global', ws)
    const archived = memory.splitEntries(readCellFile(archive))

    expect(after?.entries).toContain(keepEntry)
    expect(after?.entries).toHaveLength(1)
    expect(archived).toHaveLength((before?.entries.length ?? 0) - 1)
    expect(archived.length).toBeGreaterThan(0)
    expect(archived).not.toContain(keepEntry)
    expect(archive.endsWith('MEMORY.archive.md')).toBe(true)
    expect(existsSync(archive)).toBe(true)
    expect(message).toContain('整理完成')
  })
})

describe('⑥ 复盘跳过规则（+ 正向对照）', () => {
  /** 触发一次 turn-end（复盘挂在它上面）。 */
  function emitTurnEnd(id: string, file: string): void {
    services.emit('dsc/turn-end', 'completed', { sessionId: id, sessionPath: file })
  }

  test('A：本段直写过记忆时不发起复盘', async () => {
    await memoryTool.run({ target: 'global', action: 'add', content: '跳过规则探针-直写过' }, runCtx())
    emitTurnEnd(sessionId, sessionFile)
    expect(messagesText()).not.toContain('【记忆复盘】')
  })

  test('B：短应答（无 ≥3 词文本块）时不发起复盘', async () => {
    await services.session.open(shortFile)
    emitTurnEnd(shortId, shortFile)
    expect(messagesText()).not.toContain('【记忆复盘】')
  })

  test('C：条件满足时复盘会起（对照，证明 A/B 的「没起」有效）', async () => {
    await services.session.open(sessionFile)
    emitTurnEnd(sessionId, sessionFile)
    expect(messagesText()).toContain('【记忆复盘】')
  })
})
