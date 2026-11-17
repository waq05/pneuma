/**
 * 常驻多 agent：切会话不打断运行中的回合（迁自 `scripts/resident-agents-test.mjs`）。
 *
 * 0.6.47 之前全局单 agent，切会话 = abort 当前轮 + 中止收尾的工具结果误写进新会话的
 * 日志（探针实锤的跨会话污染）。0.6.48 起每个会话一个常驻 agent：切换只换「当前查看」
 * 的指向，后台回合跑完写回自己的日志；侧栏状态点 / 「已完成未读」徽标走
 * `dsc/agent-status`；完全闲下来又不是当前查看的 agent 就地收摊（写租约随之释放）。
 *
 * ## 观测窗怎么握（本文件和原探针唯一的实质差别）
 *
 * 原探针靠假端点 `sleep(600)` 拖出「正在干活」的窗口。`fakeLLM` 的剧本是**按请求序号**
 * 发的，服务器侧拖时间做不到；这里换成**注册一个闸门工具** `slow_thing`：它一直挂在
 * `run` 里等一个由用例控制的 release，于是「回合跑动中」这个状态由用例自己决定何时结束，
 * 不靠固定 sleep 赌时序。剧本只需按顺序写：工具调用轮 → 收尾正文轮。
 *
 * ## 覆盖范围
 *
 * 原探针十二层全部搬过来，逐层一个（或几个）`test`：切走不中断、B 不受影响、切回复用
 * 常驻会话、后台收工的「已完成未读」、自动收摊与租约释放、迟到投递、事件归属与用量记账、
 * 后台首回合自动标题、后台可停、归档在跑的会话（含重试）、子代理 chip 作用域、名册僵尸。
 *
 * 隔离：临时 HOME + 假端点，真实 `~/.dsc` 一个字节都不动。
 *
 * @module dsc/tests/integration/resident-agents.int.spec
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, readSessionJsonl, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录；`DSC_HOME` 是模块级常量，必须先换好再加载内核。 */
const home = tempHome('dsc-resident-')
/** `~/.dsc`：名册、用量日志、角色文件都在这下面。 */
const DSC_HOME = join(home.home, '.dsc')

/** 回合信号（`turn-start` / `turn-end` 都带会话归属）。 */
interface TurnSignal {
  kind: 'start' | 'end'
  reason?: string
  sessionId?: string
  sessionPath?: string
}
/** 快照里本文件用到的三个面。 */
interface SnapshotView {
  status: { turnState: string; cwd: string; sessionPath: string }
  sessionStates: Record<string, string>
  subagents: Array<{ sessionPath: string; state: string }>
}
/** 名册一行。 */
interface TeammateView {
  name: string
  state: string
  rounds: number
  file: string
  sessionId?: string
}
/** 会话服务里用到的成员。 */
interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  persisted: boolean
  messages: Array<{ role: string; content: unknown }>
  state(id: string): unknown
  appendUser(text: string): void
}
interface Services {
  session: {
    current(): SessionView
    open(filePath?: string, cwd?: string): Promise<void>
    archive(paths: string[]): Promise<{ ok: boolean }>
  }
  agent: {
    followup(text: string, images?: string[], sessionId?: string, origin?: 'user' | 'notice'): void
    interrupt(filePath?: string): void
    isRunning(filePath: string): boolean
    hasAgent(sessionId: string): boolean
  }
  transcript: { getSnapshot(): SnapshotView }
  tools: {
    register(entry: {
      name: string
      description: string
      parameters: Record<string, unknown>
      risk: 'read'
      run(args: Record<string, unknown>, ctx: { cwd: string; signal: AbortSignal; sessionId: string; sessionPath: string }): Promise<string>
    }): () => void
    list(): Array<{ name: string; run(args: Record<string, unknown>, ctx: unknown): Promise<string> }>
  }
  on(event: 'dsc/turn-start', listener: (signal: TurnSignal) => void): () => void
  on(event: 'dsc/turn-end', listener: (reason: string, signal: TurnSignal) => void): () => void
  on(event: 'dsc/agent-status', listener: (payload: { path: string; state: string }) => void): () => void
  emit(event: 'dsc/exit'): void
  get(name: string): unknown
}

let kernel: BootedKernel
let fake: FakeLLM
let services: Services
let team: { list(): TeammateView[] }
/** 内核模块（会话类、归档根、名册读法）一律动态 import：`DSC_HOME` 是模块级常量。 */
let core: typeof import('../../src/core/session.js')
let sessionMeta: typeof import('../../src/core/session-meta.js')

// ── 回合信号与假端点剧本 ────────────────────────────────────────────────────

const turnSignals: TurnSignal[] = []
const statusLog: string[] = []

/**
 * 闸门工具的状态：每次要开一个「跑动中」窗口就 `openGate()`，用例显式 `release()`。
 * 取消（interrupt / archive）也会放行——被停的回合不该把工具永远挂在那里。
 */
let release: () => void = () => {}
let toolStarted = false
let toolSessionId: string | null = null

/** 开一个新闸门（返回的资源由用例自己 release）。 */
function openGate(): void {
  toolStarted = false
  toolSessionId = null
  let opened = (): void => {}
  const gate = new Promise<void>((resolve) => {
    opened = resolve
  })
  release = opened
  currentGate = gate
}
let currentGate: Promise<void> = Promise.resolve()

/** 会话 A（第一条会话）与 B（切过去看的那条）。 */
let sessionA: SessionView
let sidA = ''
let sessionB: SessionView

beforeAll(async () => {
  mkdirSync(DSC_HOME, { recursive: true })
  writeFileSync(join(DSC_HOME, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
  // 子代理插件默认关；第 ⑥ 段要派真队友。另外留一个「工具不限」的角色：
  // 不写 `tools:` 那一行 = 不限工具，队友才拿得到下面注册的闸门工具。
  mkdirSync(join(DSC_HOME, 'agents'), { recursive: true })
  writeFileSync(
    join(DSC_HOME, 'agents', 'slow-mate.md'),
    ['---', 'name: slow-mate', 'description: 挂在闸门上的测试队友', 'approval: forbid', '---', '', '你是测试队友。'].join('\n'),
    'utf8',
  )
  writeFileSync(
    join(DSC_HOME, 'plugins.json'),
    `${JSON.stringify({ version: 1, entries: [{ file: 'subagent', disabled: false, config: {} }] }, null, 2)}\n`,
    'utf8',
  )
  core = await import('../../src/core/session.js')
  sessionMeta = await import('../../src/core/session-meta.js')

  fake = await fakeLLM({
    turns: [
      // ① A 的第一个回合：工具调用 → 结果回来后的结论。
      { toolCall: { name: 'slow_thing', args: {} } },
      // ② B 的回合：一条普通回答。
      'B 的回答',
      // ③ A 收工后的结论。
      'A 的结论：工具返回了 slow ok',
      // ④ 第 ⑨ 段：A 的第二个回合（工具调用，随后被按路径打断）。
      { toolCall: { name: 'slow_thing', args: {} } },
      // ⑤ 第 ⑩ 段：A 的第三个回合（工具调用，随后被归档打断）。
      { toolCall: { name: 'slow_thing', args: {} } },
      // ⑥ 第 ⑪ 段：队友的回合（闸门工具，挂住让 chip 可观察）。
      { toolCall: { name: 'slow_gate', args: {} } },
      // ⑦ 队友收工的那句话。
      '慢队友干完了',
      '收到',
    ],
  })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
  team = services.get('team') as { list(): TeammateView[] }

  services.on('dsc/turn-start', (signal) => turnSignals.push({ ...signal, kind: 'start' }))
  services.on('dsc/turn-end', (reason, signal) => turnSignals.push({ ...signal, reason, kind: 'end' }))
  services.on('dsc/agent-status', (payload) => statusLog.push(`${basename(payload.path).slice(0, 8)}:${payload.state}`))

  const offThing = services.tools.register({
    name: 'slow_thing',
    description: '测试用慢工具',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async (_args, toolCtx) => {
      toolStarted = true
      // 工具上下文必须带会话身份（0.6.48：后台作业通知按它归属）。
      toolSessionId = toolCtx.sessionId
      await Promise.race([
        currentGate,
        new Promise<void>((resolve) => toolCtx.signal.addEventListener('abort', () => resolve(), { once: true })),
      ])
      return 'slow ok'
    },
  })
  const offGate = services.tools.register({
    name: 'slow_gate',
    description: '测试用闸门工具（队友用）',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => {
      await currentGate
      return 'gate ok'
    },
  })
  // 内核卸载时会逐个 dispose 插件，这里保留手动卸载口只是为了表达「谁注册的谁撤」。
  void offThing
  void offGate

  sessionA = services.session.current()
  sidA = sessionA.meta.id
})

afterAll(async () => {
  // 兜底放行：任何还挂在闸门上的工具都别再拦着卸载。
  release()
  await kernel?.dispose()
  await fake?.close()
  home.restore()
})

/** 等条件成立；超时返回 false，由断言报出可读错误。 */
async function until(condition: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** 跑一个回合并等它结束，返回结束原因。 */
async function runTurnToEnd(sessionId: string, text: string): Promise<string> {
  const ended = new Promise<string>((resolve) => {
    const off = services.on('dsc/turn-end', (reason, signal) => {
      if (signal.sessionId !== sessionId) return
      off()
      resolve(reason)
    })
  })
  services.agent.followup(text)
  return ended
}

/** 会话文件当前的记录序列（坏行与空行不算）。 */
function recordTypes(file: string): string[] {
  return readSessionJsonl(file).map((record) => String(record.type ?? '?'))
}


/** 归档落点：`archivedRoot/<原目录名>/<文件名>`。 */
function archivedPathOf(filePath: string): string {
  return join(core.archivedRoot(), basename(dirname(filePath)), basename(filePath))
}

describe('① A 回合跑动中切到 B：不中断、不串台、切回复用常驻会话', () => {
  /** 各关键时刻的现场：只在这里拍一次，后面的用例只读它。 */
  let obs: {
    toolStarted: boolean
    toolSessionId: string | null
    aRunning: boolean
    bIsDifferent: boolean
    bTurnState: string
    bState: string | undefined
    aEndedWhileRunning: boolean
    aReused: boolean
    aTurnState: string
    aEndReason: string | null
    bLog: string
    aLogAtFinish: string
    justFinished: boolean
  }

  beforeAll(async () => {
    openGate()
    const aFirst = runTurnToEnd(sidA, '开跑')
    await until(() => toolStarted && toolSessionId === sidA)

    // 切到 B（新会话）：切走不是 abort。
    await services.session.open(undefined)
    sessionB = services.session.current()
    const bSnapshot = services.transcript.getSnapshot()
    obs = {
      toolStarted,
      toolSessionId,
      aRunning: services.agent.isRunning(sessionA.filePath),
      bIsDifferent: sessionB !== sessionA,
      bTurnState: bSnapshot.status.turnState,
      bState: bSnapshot.sessionStates[sessionA.filePath],
      aEndedWhileRunning: false,
      aReused: false,
      aTurnState: '',
      aEndReason: null,
      bLog: '',
      aLogAtFinish: '',
      justFinished: false,
    }
    // 切走之后这一小段窗口里不该冒出 A 的 turn/end（旧实现是当场 abort）。
    await new Promise((resolve) => setTimeout(resolve, 200))
    obs.aEndedWhileRunning = !turnSignals.some((signal) => signal.kind === 'end' && signal.sessionId === sidA)

    // B 正常对话，不受 A 的回合影响。
    const bEnd = runTurnToEnd(sessionB.meta.id, 'B 的问题')
    expect(await bEnd).toBe('completed')
    await new Promise((resolve) => setTimeout(resolve, 200))
    obs.bLog = readFileSync(sessionB.filePath, 'utf8')

    // 切回 A（回合还在跑）：会话对象复用常驻实例，视图补种成「回合中」。
    await services.session.open(sessionA.filePath)
    obs.aReused = services.session.current() === sessionA
    obs.aTurnState = services.transcript.getSnapshot().status.turnState
    await services.session.open(sessionB.filePath)

    // A 收工：工具放行，结果与结论写回 A 自己的日志。
    release()
    obs.aEndReason = await aFirst
    obs.justFinished = await until(
      () => services.transcript.getSnapshot().sessionStates[sessionA.filePath] === 'just-finished',
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    obs.aLogAtFinish = readFileSync(sessionA.filePath, 'utf8')
  })

  test('工具开跑且带上会话身份', () => {
    expect(obs.toolStarted).toBe(true)
    expect(obs.toolSessionId).toBe(sidA)
  })

  test('切到 B 后 A 还在跑（不被打断）；B 是另一条会话对象', () => {
    expect(obs.aRunning).toBe(true)
    expect(obs.bIsDifferent).toBe(true)
  })

  test('B 视图是 idle，侧栏亮着 A 的运行点', () => {
    expect(obs.bTurnState).toBe('idle')
    expect(obs.bState).toBe('working')
  })

  test('切走不产生 A 的 turn/end（不再中止）', () => {
    expect(obs.aEndedWhileRunning).toBe(true)
  })

  test('B 的回答落进 B 的日志，且 B 的日志零污染（没有 A 的工具结果与结论）', () => {
    expect(obs.bLog).toContain('B 的回答')
    expect(obs.bLog).not.toContain('slow ok')
    expect(obs.bLog).not.toContain('A 的结论')
  })

  test('切回 A 复用常驻会话对象，视图补种成「回合中」', () => {
    expect(obs.aReused).toBe(true)
    expect(['thinking', 'working']).toContain(obs.aTurnState)
  })

  test('A 的回合在后台正常结束，工具结果与结论落回 A 自己的日志', () => {
    expect(obs.aEndReason).toBe('completed')
    expect(obs.aLogAtFinish).toContain('slow ok')
    expect(obs.aLogAtFinish).toContain('A 的结论')
  })

  test('A 收工且没在看 → 侧栏「已完成未读」', () => {
    expect(obs.justFinished).toBe(true)
    expect(statusLog.length).toBeGreaterThan(0)
  })
})

describe('② 完全闲下来又不是当前查看：agent 自动收摊、写租约释放', () => {
  let hasAgent = true
  let leaseFree = false

  beforeAll(async () => {
    hasAgent = await until(() => services.agent.hasAgent(sidA) === false)
    leaseFree = await until(() => {
      try {
        // 能重新拿到写租约就说明上一份已经释放。
        const reloaded = core.Session.load(sessionA.filePath, true)
        reloaded.close()
        return true
      } catch {
        return false
      }
    })
  })

  test('A 的 agent 自动收摊（hasAgent=false）', () => {
    expect(hasAgent).toBe(true)
  })

  test('收摊后写租约释放（可重新加载）', () => {
    expect(leaseFree).toBe(true)
  })
})

describe('③ 收摊后的会话仍能收到迟到的投递', () => {
  let landed = false

  beforeAll(async () => {
    services.agent.followup('晚到的通知', undefined, sidA)
    landed = await until(() => readFileSync(sessionA.filePath, 'utf8').includes('晚到的通知'))
  })

  test('迟到的投递写进 A 的会话文件（不丢）', () => {
    expect(landed).toBe(true)
  })
})

describe('④ 事件带会话归属，用量按发起回合的会话记账', () => {
  test('turn-start 带会话归属（id + 路径）', () => {
    const start = turnSignals.find((signal) => signal.kind === 'start' && signal.sessionId === sidA)
    expect(start).toBeDefined()
    expect(start?.sessionPath).toBe(sessionA.filePath)
  })

  test('A 的 turn-end 在切走之后才发、reason=completed', () => {
    const end = turnSignals.find((signal) => signal.kind === 'end' && signal.sessionId === sidA)
    expect(end?.reason).toBe('completed')
  })

  test('用量日志按会话分别记账（A 与 B 各一条）', async () => {
    const usageFile = join(DSC_HOME, 'usage', 'usage.jsonl')
    expect(await until(() => existsSync(usageFile))).toBe(true)
    const usageText = readFileSync(usageFile, 'utf8')
    expect(usageText).toContain(`"sid":"${sidA}"`)
    expect(usageText).toContain(`"sid":"${sessionB.meta.id}"`)
  })
})

describe('⑤ 后台收工的首回合也拿到自动标题', () => {
  let aTitle: string | undefined
  let bTitle: string | undefined

  beforeAll(async () => {
    await until(() => sessionMeta.readSessionMeta()[sidA]?.autoTitle !== undefined)
    aTitle = sessionMeta.readSessionMeta()[sidA]?.autoTitle
    bTitle = sessionMeta.readSessionMeta()[sessionB.meta.id]?.autoTitle
  })

  test('A（后台收工）拿到自动标题', () => {
    expect(aTitle).toBeDefined()
  })

  test('B（前台收工）也拿到自动标题', () => {
    expect(bTitle).toBeDefined()
  })
})

describe('⑥ 按路径 interrupt：后台在跑的回合能停', () => {
  let started = false
  let stopped = false
  let reason: string | null = null

  beforeAll(async () => {
    await services.session.open(sessionA.filePath)
    openGate()
    const ended = runTurnToEnd(sidA, '开跑')
    started = await until(() => services.agent.isRunning(sessionA.filePath))
    // 切到新会话 C，A 转后台继续跑，再按路径停它。
    await services.session.open(undefined)
    services.agent.interrupt(sessionA.filePath)
    stopped = await until(() => !services.agent.isRunning(sessionA.filePath))
    reason = await ended
  })

  test('A 的第二个回合开跑', () => {
    expect(started).toBe(true)
  })

  test('按路径 interrupt 停下后台回合', () => {
    expect(stopped).toBe(true)
  })

  test('被停的回合 reason=aborted', () => {
    expect(reason).toBe('aborted')
  })
})

describe('⑦ 归档后台在跑的会话：先收摊常驻 agent 再挪文件', () => {
  let archiveOk = false
  let reason: string | null = null
  let hasAgent = true
  let moved = false
  let retryOk = false

  beforeAll(async () => {
    // 上一段 interrupt 后 A 已闲下来并被收摊；重新打开再起一轮，让归档撞上「后台在跑」。
    await services.session.open(sessionA.filePath)
    openGate()
    const ended = runTurnToEnd(sidA, '开跑')
    await until(() => services.agent.isRunning(sessionA.filePath))
    // 切走，A 在后台跑着时归档它。
    await services.session.open(undefined)
    const result = await services.session.archive([sessionA.filePath])
    archiveOk = result.ok === true
    reason = await ended
    hasAgent = services.agent.hasAgent(sidA) === false
    moved = !existsSync(sessionA.filePath) && existsSync(archivedPathOf(sessionA.filePath))
    // 重试：已归档的跳过不算失败（半途而废的批量归档重试不再卡死）。
    const retry = await services.session.archive([sessionA.filePath])
    retryOk = retry.ok === true
  })

  test('归档后台在跑的会话成功（先收摊再挪文件）', () => {
    expect(archiveOk).toBe(true)
  })

  test('归档停机的回合 reason=aborted', () => {
    expect(reason).toBe('aborted')
  })

  test('A 的 agent 已收摊，jsonl 挪进归档区（原位置不存在）', () => {
    expect(hasAgent).toBe(true)
    expect(moved).toBe(true)
  })

  test('重试归档已归档会话：跳过且 ok', () => {
    expect(retryOk).toBe(true)
  })
})

describe('⑧ 状态栏子代理 chip 只认当前会话、还在干活的队友', () => {
  let parent: SessionView
  let mate: TeammateView | undefined
  let obs: {
    chipCount: number
    chipPath: string | undefined
    chipState: string | undefined
    globalState: string | undefined
    afterSwitchCount: number
    globalAfterSwitch: string | undefined
    clearedAfterFinish: boolean
  }

  beforeAll(async () => {
    parent = services.session.current()
    openGate()
    const tool = services.tools.list().find((entry) => entry.name === 'subagent')
    expect(tool).toBeDefined()
    await tool!.run(
      { action: 'spawn', role: 'slow-mate', task: '慢队友任务：慢慢查一下 package.json 里的名字叫什么，一句话交差', background: true },
      { cwd: parent.meta.cwd, signal: new AbortController().signal, sessionId: parent.meta.id, sessionPath: parent.filePath },
    )
    await until(() => {
      mate = team.list().find((entry) => entry.state === 'working' && entry.sessionId === parent.meta.id)
      return mate !== undefined
    })
    const mid = services.transcript.getSnapshot()
    obs = {
      chipCount: mid.subagents.length,
      chipPath: mid.subagents[0]?.sessionPath,
      chipState: mid.subagents[0]?.state,
      globalState: mate === undefined ? undefined : mid.sessionStates[mate.file],
      afterSwitchCount: 0,
      globalAfterSwitch: undefined,
      clearedAfterFinish: false,
    }
    // 切到别的会话：chip 立刻消失（所有权过滤），全局面不跟着清。
    await services.session.open(undefined)
    const away = services.transcript.getSnapshot()
    obs.afterSwitchCount = away.subagents.length
    obs.globalAfterSwitch = mate === undefined ? undefined : away.sessionStates[mate.file]
    await services.session.open(parent.filePath)
    // 放行闸门，让队友收工（chip 的清空要看它真干完）。
    release()
    obs.clearedAfterFinish = await until(() => {
      const snap = services.transcript.getSnapshot()
      return snap.subagents.length === 0 && team.list().find((entry) => entry.sessionId === parent.meta.id)?.state === 'idle'
    })
  })

  test('队友派出并开工（名册 state=working，归属当前会话）', () => {
    expect(mate).toBeDefined()
    expect(mate?.state).toBe('working')
  })

  test('干活中的队友进 subagents（状态栏 chip 的数据源）', () => {
    expect(obs.chipCount).toBe(1)
    expect(obs.chipPath).toBe(mate?.file)
    expect(obs.chipState).toBe('working')
  })

  test('全局 sessionStates 仍亮队友的点（/resume 行内状态点用）', () => {
    expect(obs.globalState).toBe('working')
  })

  test('切走会话后 subagents 清空，但全局 sessionStates 保留', () => {
    expect(obs.afterSwitchCount).toBe(0)
    expect(obs.globalAfterSwitch).toBe('working')
  })

  test('队友收工后 subagents 清空、名册落 idle', () => {
    expect(obs.clearedAfterFinish).toBe(true)
  })
})

describe('⑨ 名册僵尸：上次进程没 settle 就退了的 working 记录改报 stopped', () => {
  let zombie: TeammateView | undefined
  let chipped = false

  beforeAll(async () => {
    const rosterDir = join(DSC_HOME, 'team')
    mkdirSync(rosterDir, { recursive: true })
    // 等过一个文件系统 mtime 窗口再写：名册读缓存按 mtime 判「文件动过没有」，Windows 的
    // mtimeMs 精度只有十来毫秒——同一窗口内写，缓存会命中旧名册，这条用例就会偶发读不到
    // 刚写的僵尸（原探针在 check-core 里抓到过一次，合并 dev 时跟着移植过来）。
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(
      join(rosterDir, 'roster.json'),
      `${JSON.stringify(
        {
          teammates: [
            {
              name: 'zombie',
              role: 'explorer',
              state: 'working',
              task: '旧进程没 settle 就退了留下的记录',
              file: join(home.home, '.dsc', 'teammates', 'ghost.jsonl'),
              cwd: '/w',
              parent: 'lead',
              depth: 1,
              rounds: 1,
              startedAt: Date.now(),
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    zombie = team.list().find((entry) => entry.name === 'zombie')
    chipped = services.transcript
      .getSnapshot()
      .subagents.some((chip) => chip.sessionPath === zombie?.file)
  })

  test('僵尸记录读作 stopped（不再永远「干活」）', () => {
    expect(zombie).toBeDefined()
    expect(zombie?.state).toBe('stopped')
  })

  test('僵尸不进状态栏 chip 列表', () => {
    expect(chipped).toBe(false)
  })

  test('收尾：会话记录里没有多出来的脏东西（记录类型只有那几种）', () => {
    // 这一条只是把「日志是 append-only 的几类记录」钉住：出现别的类型多半是某处写错了。
    // A 已被归档，这里读的是归档区那份。
    const archived = archivedPathOf(sessionA.filePath)
    expect(existsSync(archived)).toBe(true)
    const types = new Set(recordTypes(archived))
    for (const type of types) expect(['meta', 'state', 'user', 'assistant', 'tool', 'summary']).toContain(type)
  })
})

