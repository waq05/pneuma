/**
 * 升权（`sandbox_permissions` / `justification` / `sandbox_scope`）与授权范围（integration 层，
 * 原 `scripts/escalation-scope-test.mjs`）。
 *
 * 升权是**唯一一条「模型主动申请放宽安全边界」的路**，所以它的每条分支都得有断言盯着：
 *
 *   [1] 成对校验：半截请求（只给 justification / 只给 scope）一律 malformed；
 *   [2] 两档分家：danger-full-access 跳过沙箱判定；workspace-write 留在沙箱里**放宽目标后
 *       重判**，受保护路径照样被拒（而且是被更早的灾难地板拒的）；
 *   [3] 范围：只有「写类 + workspace-write + 认得出目标」才在卡上给「本会话允许」；
 *       命令类不给（静态界定不出边界）；
 *   [4] 接线：卡上点「本会话允许」时把目标并进**该会话**的可写根——别的会话仍被拦。
 *
 * ## 原探针第 [3][4] 段的源码文本断言换成了什么
 *
 * 那 5 条 `readFileSync('src/packages/...')` + 正则本来钉的是「接线还在」。这里换成行为：
 * 卡上的 `scopes` 是不是真的只有 `once`/`session`、点下去之后沙箱是不是真的对**这个会话**
 * 放行。接线断了这两条会红；改个变量名不会假红。
 *
 * ## 为什么沙箱插件必须打开
 *
 * harness 默认关它（Windows 上它会 spawn PowerShell 体检）。这一组测的正是沙箱边界，
 * 关掉之后每个断言都会退化成「审批层说了算」，测成另一件事。所以预置 `plugins.json`
 * 只关记忆，沙箱保持开启。
 *
 * @module dsc/tests/integration/escalation-scope.int.spec
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../harness.js'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { readSandboxRequest } from '../../src/core/tools/sandbox-args.js'
import { checkWrite, createPolicy, sandboxTmpDir } from '@pneuma/sandbox/policy.js'
import { BUILTIN_PERMISSION_PRESETS } from '@pneuma/permission-core/permission-presets.js'

/** 内核里本文件用到的服务面。 */
interface Verdict {
  action: 'allow' | 'deny' | 'defer'
  reason?: string
}

interface Card {
  toolName: string
  reason: string
  risk: string
  scopes: string[]
  escalation?: { permission: string; scope: string; justification: string }
}

interface KernelSurface {
  on(event: 'dsc/turn-end', listener: (reason: string) => void): () => void
  provide(name: string, value: unknown): void
  guards: {
    chain: Array<{ id: string; order: number }>
    gate(input: {
      toolName: string
      risk: string
      cwd: string
      args: Record<string, unknown>
      target?: string
      signal: AbortSignal
      sessionId: string
      sessionPath: string
    }): Promise<Verdict>
  }
  approval: {
    decide(
      request: {
        toolName: string
        argsSummary: string
        args: Record<string, unknown>
        cwd: string
        sessionId: string
        sessionPath: string
      },
      signal: AbortSignal,
    ): Promise<string>
    pendingView(): Card | null
    answer(answer: 'reject' | 'allow-once' | 'allow-session'): void
    setPolicy(next: string): void
  }
  sandbox: {
    readonly mode: string
    setMode(next: string): void
    check(target: string | undefined, command: string | undefined, cwd?: string, sessionPath?: string): {
      allowed: boolean
      requestable: boolean
      rule?: string
    }
  }
  permissionPresets: { use(name: string): string }
  session: {
    current(): { meta: { id: string; cwd: string }; filePath: string; appendUser(text: string): void }
    open(filePath?: string): Promise<void>
  }
  ui: { newSessionIn(cwd: string): Promise<void> }
}

const home = { home: process.env.HOME ?? process.env.USERPROFILE ?? '' }
/** 会话的工作目录（不是进程目录：权限与沙箱判定都按会话的 cwd）。 */
const WORK = join(home.home, 'ws')
/** 工作区外的一个目录：升权要写到那里。 */
const OUTSIDE_DIR = join(home.home, 'outside')
const OUTSIDE_FILE = join(OUTSIDE_DIR, 'out.txt')

let llm: FakeLLM
let kernel: BootedKernel
let surface: KernelSurface
let cwd = ''
let sessionId = ''
let sessionPath = ''
/**
 * 现在有没有人能回答审批卡。
 *
 * 守卫链那几条要的正是「没人能答 → 审批层直接按拒」（这样 `gate()` 立刻返回，不必等一张
 * 没人点的卡）；卡相关的几条才把它打开，把卡真挂出来。
 */
let interactiveReachable = false

beforeAll(async () => {
  for (const dir of [WORK, OUTSIDE_DIR]) mkdirSync(dir, { recursive: true })
  // 只关记忆：沙箱插件保持开启，这一组才有「围栏」可测。
  mkdirSync(DSC_HOME, { recursive: true })
  writeFileSync(
    join(DSC_HOME, 'plugins.json'),
    `${JSON.stringify(
      {
        version: 1,
        entries: [
          { file: 'memory', config: { enabled: false } },
          // 卡没人答时 10 秒就收（出厂 5 分钟）：这条用例要的是「卡弹出来了」，
          // 不是「挂着等满 5 分钟」，超时太长会让一次断言失败变成一次挂死。
          { file: 'approval', config: { approvalTimeoutMs: 10_000 } },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  surface = kernel.ctx as unknown as KernelSurface
  // 「有人在看」的可达性由用例开关（见 interactiveReachable 的注释）。
  surface.provide('interactive', { kind: 'tui', reachable: () => interactiveReachable })
  await surface.ui.newSessionIn(WORK)
  const current = surface.session.current()
  // 会话必须先真落盘：守卫按会话身份解析权限档，读不回来的会话会被判成「已结束」并直接拒。
  current.appendUser('（自检）让这条会话落盘')
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      if (readFileSync(current.filePath, 'utf8').includes('"type":"user"')) break
    } catch {
      // 还没建出来：继续等。
    }
    if (Date.now() > deadline) break
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
  cwd = current.meta.cwd
  sessionId = current.meta.id
  sessionPath = current.filePath
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

/** 直接在守卫链上问一次：给什么参数、拿什么裁决。 */
function gate(toolName: string, args: Record<string, unknown>, risk = 'write', target?: string): Promise<Verdict> {
  return surface.guards.gate({
    toolName,
    risk,
    cwd,
    args,
    ...(target === undefined ? {} : { target }),
    signal: new AbortController().signal,
    sessionId,
    sessionPath,
  })
}

/** 判据是「**哪一层**拒的」：无头环境没人能点卡，落点会是审批层的拒，那恰好证明沙箱放行了。 */
const sandboxRefused = (verdict: Verdict): boolean =>
  verdict.action === 'deny' && (verdict.reason ?? '').includes('沙箱拒绝')

/** 轮询到条件成立；超时返回 false。 */
async function until(condition: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/**
 * 新开一条会话并让它真落盘，返回它的身份。
 *
 * 为什么要落盘：守卫按会话身份解析权限档，读不回来的会话会被判成「已结束」直接拒；
 * 而权限/授权都按会话记账，换用例换会话才不会互相串。
 */
async function openSession(): Promise<{ id: string; filePath: string; cwd: string }> {
  await surface.ui.newSessionIn(WORK)
  const current = surface.session.current()
  current.appendUser('（自检）让这条会话落盘')
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      if (readFileSync(current.filePath, 'utf8').includes('"type":"user"')) break
    } catch {
      // 还没建出来：继续等。
    }
    if (Date.now() > deadline) break
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
  return { id: current.meta.id, filePath: current.filePath, cwd: current.meta.cwd }
}

describe('[1] 成对校验：半截请求一律 malformed', () => {
  test('成对给全 → ok，scope 默认 once', () => {
    const pair = readSandboxRequest({ sandbox_permissions: 'workspace-write', justification: '要写到另一个盘' })
    expect(pair).toMatchObject({ kind: 'ok', permission: 'workspace-write', scope: 'once' })
  })

  test('scope 写 session 也认', () => {
    const scoped = readSandboxRequest({
      sandbox_permissions: 'workspace-write',
      justification: 'x',
      sandbox_scope: 'session',
    })
    expect(scoped).toMatchObject({ kind: 'ok', scope: 'session' })
  })

  test('只给 justification / 只给 scope / scope 值非法 → malformed', () => {
    expect(readSandboxRequest({ justification: '没说要放宽什么' }).kind).toBe('malformed')
    expect(readSandboxRequest({ sandbox_scope: 'session' }).kind).toBe('malformed')
    expect(
      readSandboxRequest({ sandbox_permissions: 'workspace-write', justification: 'x', sandbox_scope: 'forever' }).kind,
    ).toBe('malformed')
  })

  test('三样都不给 → none（这条路上不算升权）', () => {
    expect(readSandboxRequest({}).kind).toBe('none')
  })
})

describe('[2] 两档在守卫链上真的分家', () => {
  test('工作区外写、不提放宽 → 沙箱 defer，落到审批层（理由不是「沙箱拒绝」）', async () => {
    const verdict = await gate('write', { path: OUTSIDE_FILE, content: 'x' }, 'write', OUTSIDE_FILE)
    expect(verdict.action).toBe('deny')
    expect(sandboxRefused(verdict)).toBe(false)
  })

  test('danger-full-access：这一次跳过沙箱判定', async () => {
    const verdict = await gate(
      'write',
      { path: OUTSIDE_FILE, content: 'x', sandbox_permissions: 'danger-full-access', justification: '要装到另一个盘' },
      'write',
      OUTSIDE_FILE,
    )
    expect(sandboxRefused(verdict)).toBe(false)
  })

  test('workspace-write：放宽目标后重判，普通工作区外目标可以过', async () => {
    const verdict = await gate(
      'write',
      { path: OUTSIDE_FILE, content: 'x', sandbox_permissions: 'workspace-write', justification: '要装到另一个盘' },
      'write',
      OUTSIDE_FILE,
    )
    expect(sandboxRefused(verdict)).toBe(false)
  })

  test('workspace-write 到受保护路径：仍被拒，而且拒它的是更早的灾难地板', async () => {
    // 受保护路径这一条轮不到沙箱说话：灾难地板在 order 5、沙箱在 order 8，地板先拒。
    const protectedTarget = join(DSC_HOME, 'credentials.yaml')
    const verdict = await gate(
      'write',
      { path: protectedTarget, content: 'x', sandbox_permissions: 'workspace-write', justification: '想改凭据' },
      'write',
      protectedTarget,
    )
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('灾难地板')
  })

  test('「放宽的是写边界，不是安全边界」：可写根里的只读子路径照旧不许写', () => {
    const base = createPolicy({
      mode: 'workspace-write',
      cwd,
      tmpDir: sandboxTmpDir(DSC_HOME, cwd, sessionId),
      extraWritableRoots: [],
      readOnlySubpaths: [],
      dscHome: DSC_HOME,
      networkAccess: false,
    })
    const widened = { ...base, roots: [...base.roots, join(home.home, 'granted')] }
    expect(checkWrite(widened, join(home.home, 'granted', 'a.txt')).allowed).toBe(true)
    const guarded = { ...widened, readOnlySubpaths: [join(home.home, 'granted', 'keep')] }
    expect(checkWrite(guarded, join(home.home, 'granted', 'keep', 'a.txt')).allowed).toBe(false)
  })
})

/** 把卡真挂出来跑一次裁决：先开「有人在看」，答完再关回去。 */
async function decideWithAnswer(
  request: Parameters<KernelSurface['approval']['decide']>[0],
  answer: 'reject' | 'allow-once' | 'allow-session',
): Promise<{ decision: string; card: { scopes: string[]; escalation?: { permission: string; justification: string } } }> {
  interactiveReachable = true
  try {
    const pending = surface.approval.decide(request, new AbortController().signal)
    expect(await until(() => surface.approval.pendingView() !== null)).toBe(true)
    const card = surface.approval.pendingView()!
    surface.approval.answer(answer)
    return { decision: await pending, card }
  } finally {
    interactiveReachable = false
  }
}

describe('[3] 卡上的授权范围：只有写类 + workspace-write 才给「本会话允许」', () => {
  test('写类升权卡给 once + session，不给 always；卡上摊开模型给的理由', async () => {
    // 危险地板与权限模式都要先放行，才能走到「升权卡」这一层：拿「完全访问」的沙箱档，
    // 但权限模式留在 auto-edit（写类 + 工作区外 + 非命令 → 没有可自动放行的理由）。
    surface.sandbox.setMode('danger-full-access')
    surface.approval.setPolicy('auto-edit')
    const { decision, card } = await decideWithAnswer(
      {
        toolName: 'write',
        argsSummary: '{"path":"out.txt"}',
        args: {
          path: OUTSIDE_FILE,
          content: 'x',
          sandbox_permissions: 'workspace-write',
          justification: '要写到另一个盘',
        },
        cwd,
        sessionId,
        sessionPath,
      },
      'allow-session',
    )
    expect(decision).toBe('allow-session')
    expect(card.scopes).toEqual(['once', 'session'])
    expect(card.escalation).toMatchObject({ permission: 'workspace-write', justification: '要写到另一个盘' })
  })

  test('命令类升权卡只给 once（静态界定不出边界，不给跨调用的放宽）', async () => {
    surface.sandbox.setMode('danger-full-access')
    surface.approval.setPolicy('auto-edit')
    interactiveReachable = true
    try {
      const pending = surface.approval.decide(
        {
          toolName: 'bash',
          argsSummary: 'ls',
          args: { command: 'npm install left-pad', sandbox_permissions: 'workspace-write', justification: '要装依赖' },
          cwd,
          sessionId,
          sessionPath,
        },
        new AbortController().signal,
      )
      expect(await until(() => surface.approval.pendingView() !== null)).toBe(true)
      expect(surface.approval.pendingView()!.scopes).toEqual(['once'])
      surface.approval.answer('reject')
      expect(await pending).toBe('reject')
    } finally {
      interactiveReachable = false
    }
  })
})

describe('[4] 点「本会话允许」把目标并进该会话的可写根', () => {
  test('放行之后目标对这个会话可写，另一个会话仍被拦', async () => {
    // 换一条新会话：上一条用例答过「本会话允许」，同类动作在那条会话里已经免问了，
    // 复用同一条会话会走到「本会话已允许同类操作」的自动放行，卡根本不弹。
    const second = await openSession()
    const granted = join(home.home, 'granted-dir')
    mkdirSync(granted, { recursive: true })
    const target = join(granted, 'a.txt')
    // 前置：没放宽时这个目标确实在围栏外（否则下面的「放行之后」证明不了什么）。
    surface.sandbox.setMode('workspace-write')
    expect(surface.sandbox.check(target, undefined, second.cwd, second.filePath).allowed).toBe(false)

    surface.sandbox.setMode('danger-full-access')
    surface.approval.setPolicy('auto-edit')
    const { decision } = await decideWithAnswer(
      {
        toolName: 'write',
        argsSummary: 'write a.txt',
        args: { path: target, content: 'x', sandbox_permissions: 'workspace-write', justification: '要写到别的目录' },
        cwd: second.cwd,
        sessionId: second.id,
        sessionPath: second.filePath,
      },
      'allow-session',
    )
    expect(decision).toBe('allow-session')

    surface.sandbox.setMode('workspace-write')
    // 这条会话：目标已并进可写根。
    expect(surface.sandbox.check(target, undefined, second.cwd, second.filePath).allowed).toBe(true)
    // 别的会话（上一个用例那条）：拿不到这次放宽（放宽是按会话路径记账的）。
    // 先把那条会话的沙箱档切回 workspace-write：上一条用例把它留在「完全访问」上，
    // 那样它当然可写，但那是档位放行、不是这次授权。
    await surface.session.open(sessionPath)
    surface.sandbox.setMode('workspace-write')
    expect(surface.sandbox.check(target, undefined, cwd, sessionPath).allowed).toBe(false)
  })
})

describe('[5] 只读档的 dsh 语义：沙箱拦下 → 问用户一次', () => {
  test('出厂只读档 = read-only 沙箱 + auto-edit + 本人审', () => {
    const readOnly = BUILTIN_PERMISSION_PRESETS.find((preset) => preset.name === 'read-only')
    expect(readOnly).toMatchObject({ sandbox: 'read-only', policy: 'auto-edit', reviewer: 'user' })
  })

  test('工作区内写在只读档下被判越界，但给「点一次允许」的机会；受保护名不给', async () => {
    // 切回本文件开头那条会话：上一条用例换了会话，沙箱档位是按会话记的。
    await surface.session.open(sessionPath)
    surface.sandbox.setMode('read-only')
    surface.approval.setPolicy('auto-edit')
    try {
      const inside = join(cwd, 'inside.txt')
      const fence = surface.sandbox.check(inside, undefined, cwd, sessionPath)
      expect(fence.allowed).toBe(false)
      expect(fence.requestable).toBe(true)
      expect(fence.rule).toBe('mode-read-only')
      const protectedFence = surface.sandbox.check(join(DSC_HOME, 'credentials.yaml'), undefined, cwd, sessionPath)
      expect(protectedFence.requestable).toBe(false)
      // 守卫链不再由沙箱硬拒：交审批收场（无头 → 审批层的拒）。
      const verdict = await gate('write', { path: inside, content: 'x' }, 'write', inside)
      expect(verdict.action).toBe('deny')
      expect(sandboxRefused(verdict)).toBe(false)
    } finally {
      surface.sandbox.setMode('workspace-write')
      surface.approval.setPolicy('auto-edit')
    }
  })
})
