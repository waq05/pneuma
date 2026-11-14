/**
 * 状态面板四组新数据面的宿主侧端到端（迁自 `scripts/ui-status-data-test.mjs`）。
 *
 * 「宿主到底算不算得出这些数」只有把真内核起起来才验得了——git 的增删行数、计划目录的
 * 会话账（提交 → 批 / 拒 → 入账 → 切会话不可见）、后台作业 / 终端会话按会话进出清单与
 * 收掉、只读输出面（readBackground：读作业 / 终端输出 + 归属校验 + 读口不抢模型增量
 * 游标）、定点任务进「工作流」面、空仓库（HEAD 未出生）里的 diff 与未跟踪合成预览、
 * 会话目录是仓库子目录时的路径 rebase、git 快照面与分支清单 / 切分支 / 建分支。
 *
 * ## 落位与隔离
 *
 * 跨领域（git dock + plan + 后台活 + schedule + 会话切换），按 D23 放 `tests/integration/`。
 * 隔离：临时 HOME 由 `tests/setup/temp-home.ts` 给（每个测试文件一个）；git 仓库是本文件
 * 在临时 HOME 里真 `git init` 的工作区，不碰仓库本体——规矩 7：读 git 工作区状态的用例
 * 必须用临时仓库。内核起的是「宿主来自 src、插件来自 lib」的混合平面（D25），改 src 后
 * 先 `pnpm run build`。
 *
 * ## 与探针的两处有意的不同
 *
 * 1. 探针手搓临时 HOME，这里交给 setup；plugins.json 在起内核**之前**写好（harness
 *    的 `prepareIsolatedHome` 只在文件缺席时写），schedule 显式打开，memory / sandbox /
 *    session-title 沿用 harness 的默认关闭口径（memory 与标题插件会多发模型请求，
 *    吃掉假模型的剧本——本文件不起回合，关着纯粹省时间）。
 * 2. 探针用计数器 + `check()`，这里一条 `check` 对应一个 `test`；断言值与预算
 *    （`SURFACE_CATCHUP_MS` = 5 秒、写类 op 催拍 8 秒）逐条照搬，来历见探针内注释。
 *
 * @module dsc/tests/integration/ui-status-data
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, type FakeLLM } from '../harness.js'

// ── 类型面：只声明断言真正读的字段（混合平面的服务来自 lib，读服务交出来的事实） ──

/** dock 服务的 git 只读 op 回包（字段按 op 挑；stats: true 才带增删与分档）。 */
interface GitStatusView {
  added?: number
  removed?: number
  branch?: string
  dirtyFileCount?: number
  unstaged?: string[]
  untracked?: string[]
  staged?: string[]
  unstagedStats?: Record<string, { added: number; removed: number }>
  untrackedStats?: Record<string, { added: number; removed: number }>
  stagedStats?: Record<string, { added: number; removed: number }>
}

/** `git-diff` 回包。 */
interface GitDiffView {
  diff: string
  note?: string
}

/** `git-branches` 回包。 */
interface GitBranchesView {
  current: string
  detached: boolean
  branches: Array<{ name: string; current: boolean }>
}

/** `git-checkout` / `git-branch-create` 回包。 */
interface GitOpView {
  ok: boolean
  branch: string
}

/** 只读输出面（readBackground 回包）。 */
interface BackgroundOutputView {
  kind: 'job' | 'terminal'
  text: string
  status: string
  atEnd: boolean
  totalChars: number
  droppedChars: number
}

/** 内核里的一个工具（只声明 list / run 用到的）。 */
interface KernelTool {
  name: string
  run(args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown>
}

/** 本文件用到的内核服务面（混合平面：宿主来自 src，插件来自 lib）。 */
interface StatusDataKernel {
  emit(event: string, payload?: unknown): void
  get<T>(id: string): T | undefined
  transcript: { getSnapshot(): { surfaces: Record<string, unknown> } }
  ui: {
    stopBackground(id: string): Promise<unknown>
    readBackground(id: string): Promise<BackgroundOutputView>
  }
  tools: { list(): KernelTool[] }
}

/** git 快照面（surfaces.git 的字段）。 */
interface GitSurface {
  repo: boolean
  branch: string
  detached: boolean
  dirtyFileCount: number
}

/** 计划目录条目（planDirectory）。 */
interface PlanEntry {
  file: string
  title: string
  at: number
}

/** 定点任务条目（scheduled）。 */
interface ScheduledEntry {
  title: string
  nextRunAt: number
  enabled: boolean
}

/** dock / git / session / plan / approval 各服务在本文件里用到的面。 */
interface DockService {
  handle(op: string, payload?: Record<string, unknown>): Promise<unknown>
}
interface SessionService {
  open(path: string): Promise<void>
  current(): { meta: { id: string }; filePath: string }
}
interface PlanService {
  pendingPlan(): unknown
  answerPlan(decision: string, note?: string): Promise<unknown>
  proposePlan(spec: { file: string; title: string; text: string }, signal: AbortSignal): Promise<string>
}
interface ApprovalService {
  policy: string
  setPolicy(policy: string): void
}
interface GitPluginService {
  refresh(): void
}

// ── 环境与工作区（beforeAll 一次铺好；临时 HOME 由 integration setup 给） ──

let home = ''
let llm: FakeLLM
let kernel: StatusDataKernel
let disposeKernel: (() => Promise<void>) | null = null

/** 会话文件按 cwd 编码进目录名（与宿主的会话目录约定一致）。 */
const sessionDirOf = (ws: string): string => join(home, '.dsc', 'sessions', ws.replace(/[:\\/]+/g, '-'))

/** 写一份最小会话文件（meta 钉 cwd + 一条 user 消息）。 */
function writeSession(id: string, cwd: string, createdAt: number): string {
  const dir = sessionDirOf(cwd)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'meta', id, cwd, createdAt })}\n${JSON.stringify({ type: 'user', text: '探针' })}\n`,
    'utf8',
  )
  return file
}

/** 在指定目录跑一次 git（显式带身份：CI 没有全局 git 身份）。 */
function gitIn(dir: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@local', ...args], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

/** 轮询等一个异步条件成立（后台输出与快照面都要等落定；固定 sleep 在慢机器上必翻车）。 */
async function pollUntil(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

/** 每次读快照前抖一下失效（transcript 监听 `dsc/changed` 清缓存）。 */
function surfaces(): Record<string, unknown> {
  kernel.emit('dsc/changed')
  return kernel.transcript.getSnapshot().surfaces
}

/** 快照面「跟上」的上限：大于一次 git 读取，小于一个巡检周期（来历见探针注释）。 */
const SURFACE_CATCHUP_MS = 5_000

/**
 * 把快照面催到当前工作区的读数并等一拍进入安静期；断言写类 op 自己催的那一拍前用。
 */
async function quietSurface(matches: (git: GitSurface) => boolean): Promise<boolean> {
  const settled = await pollUntil(() => {
    kernel.get<GitPluginService>('git')?.refresh()
    return matches(surfaces().git as GitSurface)
  }, SURFACE_CATCHUP_MS)
  if (!settled) return false
  await new Promise((resolve) => setTimeout(resolve, 1200))
  return matches(surfaces().git as GitSurface)
}

/** 服务取用（混合平面：读不到就响亮失败，别让 undefined 混进断言）。 */
function dock(): DockService {
  return kernel.get<DockService>('dock') as DockService
}
function sessionService(): SessionService {
  return kernel.get<SessionService>('session') as SessionService
}
function planService(): PlanService {
  return kernel.get<PlanService>('plan') as PlanService
}
function approvalService(): ApprovalService {
  return kernel.get<ApprovalService>('approval') as ApprovalService
}
function tool(name: string): KernelTool {
  const found = kernel.tools.list().find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`工具不在册：${name}`)
  return found
}
async function gitStatus(payload: Record<string, unknown>): Promise<GitStatusView> {
  return (await dock().handle('git-status', payload)) as GitStatusView
}
async function gitDiff(payload: Record<string, unknown>): Promise<GitDiffView> {
  return (await dock().handle('git-diff', payload)) as GitDiffView
}

let ws = ''
let sessionFile = ''
let sessionB = ''
let sessionC = ''
let sessionPlain = ''
let plans = ''

beforeAll(async () => {
  const env = process.env.HOME ?? process.env.USERPROFILE
  if (env === undefined || env.trim() === '') throw new Error('integration setup 没给临时 HOME')
  home = env
  const dsc = join(home, '.dsc')
  mkdirSync(dsc, { recursive: true })
  // plugins.json 在起内核之前写：schedule 是官方可开关插件（清单里 defaultDisabled），
  // 条目树里显式打开才算开；其余三条沿用 harness 的隔离口径。
  writeFileSync(
    join(dsc, 'plugins.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          { file: 'schedule', disabled: false },
          { file: 'memory', config: { enabled: false } },
          { file: 'sandbox', disabled: true },
          { file: 'session-title', disabled: true },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )

  // 工作区 ws：真 git 仓库（一次提交 + 一处改动 + 一个未跟踪文件 + 更早留下的计划文件）。
  ws = join(home, 'ws')
  mkdirSync(ws, { recursive: true })
  gitIn(ws, 'init', '-q')
  writeFileSync(join(ws, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
  gitIn(ws, 'add', 'a.txt')
  gitIn(ws, 'commit', '-qm', 'init')
  writeFileSync(join(ws, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n', 'utf8')
  writeFileSync(join(ws, 'new.txt'), 'untracked\n', 'utf8')
  plans = join(ws, '.dsc', 'plans')
  mkdirSync(plans, { recursive: true })
  writeFileSync(join(plans, '20260101-0100-旧文件.md'), '# 旧文件\n\n更早留下的，不属于任何会话\n', 'utf8')

  sessionFile = writeSession('aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000', ws, 1)
  sessionB = writeSession('bbbbbbbb-cccc-dddd-eeee-ffff00001111', ws, 2)

  // 工作区 ws-none：git init 之后一次没提交（HEAD 未出生）——用户报障现场的复刻。
  const wsNone = join(home, 'ws-none')
  mkdirSync(join(wsNone, 'sub'), { recursive: true })
  gitIn(wsNone, 'init', '-q')
  writeFileSync(join(wsNone, '中文 名.txt'), 'one\ntwo\nthree\n', 'utf8')
  writeFileSync(join(wsNone, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42, 0x43]), 'utf8')
  writeFileSync(join(wsNone, 'big.txt'), `${'x'.repeat(600 * 1024)}\n`, 'utf8')
  writeFileSync(join(wsNone, 'empty.txt'), '', 'utf8')
  writeFileSync(join(wsNone, 'sub', 'inner.txt'), 'inner\n', 'utf8')
  sessionC = writeSession('cccccccc-dddd-eeee-ffff-000011112222', wsNone, 3)

  // 普通目录（不是 git 仓库）：git 面该给 repo: false。
  const wsPlain = join(home, 'plain')
  mkdirSync(wsPlain, { recursive: true })
  writeFileSync(join(wsPlain, 'notes.txt'), 'plain\n', 'utf8')
  sessionPlain = writeSession('eeeeeeee-ffff-0000-1111-222233334444', wsPlain, 5)

  llm = await fakeLLM({ turns: ['收到'] })
  const booted = await bootKernel({ providerBaseUrl: llm.baseUrl, resumeSessionPath: sessionFile })
  // harness 返回的是包装（ctx / runTurn / dispose）；服务都在 ctx 上。
  kernel = booted.ctx as StatusDataKernel
  disposeKernel = booted.dispose
})

afterAll(async () => {
  await disposeKernel?.()
  await llm?.close()
})

describe('[1] Git 读数（dock git-status 的 stats 档）', () => {
  test('增删行数含未跟踪（加 4 删 1），每文件行数分档', async () => {
    const full = await gitStatus({ stats: true })
    // 未跟踪的 new.txt（一行）也计入：a.txt 加 3 删 1 + new.txt 加 1 = 加 4 删 1。
    expect(full.added).toBe(4)
    expect(full.removed).toBe(1)
    expect(full.unstagedStats?.['a.txt']).toEqual({ added: 3, removed: 1 })
    expect(full.untrackedStats?.['new.txt']).toEqual({ added: 1, removed: 0 })
  })

  test('脏文件数含未跟踪（a.txt / new.txt / .dsc 各一条），目录折叠条目保留', async () => {
    const full = await gitStatus({ stats: true })
    expect(full.dirtyFileCount).toBe(3)
    expect(full.untracked).toContain('.dsc/')
    expect(full.untrackedStats?.['.dsc/']?.added ?? 0).toBe(0)
  })

  test('分支名是真名；不传 stats 就不算增删（Git 页签那条路不多跑一条 git）', async () => {
    const full = await gitStatus({ stats: true })
    expect(typeof full.branch).toBe('string')
    expect(full.branch).not.toBe('')
    expect(full.branch).not.toBe('(无提交)')
    const lean = await gitStatus({})
    expect(lean.added).toBeUndefined()
    expect(lean.removed).toBeUndefined()
  })
})

describe('[2] 计划目录（plan 贡献 planDirectory：会话账驱动，不扫盘）', () => {
  test('exit_plan_mode 提卡后挂起，待批的不进目录，但工具真的落盘了', async () => {
    const plan = planService()
    const sess = sessionService().current()
    const runCtx = { cwd: ws, sessionId: sess.meta.id, sessionPath: sess.filePath, signal: new AbortController().signal }
    const first = tool('exit_plan_mode').run({ plan: '# 甲计划\n\n正文甲\n' }, runCtx)
    const pending = await pollUntil(() => plan.pendingPlan() !== null, 3000)
    expect(pending).toBe(true)
    expect(surfaces().planDirectory as PlanEntry[]).toHaveLength(0)
    const landed = readdirSync(plans).filter((name) => name !== '20260101-0100-旧文件.md')
    expect(landed).toHaveLength(1)
    await plan.answerPlan('approved')
    const firstText = String(await first)
    expect(firstText).toContain('已批准')
  })

  test('批准后进目录（标题 + 绝对路径），工作区里更早留下的计划文件不进目录', () => {
    const dir = surfaces().planDirectory as PlanEntry[]
    expect(dir).toHaveLength(1)
    expect(dir[0]?.title).toBe('甲计划')
    expect(dir[0]?.file.endsWith('.md')).toBe(true)
    expect((dir[0]?.at ?? 0)).toBeGreaterThan(0)
    expect(dir.every((item) => !item.file.includes('旧文件'))).toBe(true)
  })

  test('被拒的也进目录、最新在前；账不依赖落盘文件（第二份没有对应文件）', async () => {
    const plan = planService()
    const ghost = join(plans, '不存在的第二份.md')
    const second = plan.proposePlan({ file: ghost, title: '乙计划', text: '没有标题行\n\n正文乙\n' }, new AbortController().signal)
    await plan.answerPlan('rejected', '再想想')
    expect(await second).toBe('rejected')
    const dir = surfaces().planDirectory as PlanEntry[]
    expect(dir.map((item) => item.title)).toEqual(['乙计划', '甲计划'])
    expect(dir[0]?.file).toBe(ghost)
    expect(existsSync(ghost)).toBe(false)
  })

  test('两条账都落进会话 jsonl（plans 状态条目；写流 flush 是异步的，轮询等）', async () => {
    const plansLines = (): number => {
      try {
        return (readFileSync(sessionFile, 'utf8').match(/"id":"plans"/g) ?? []).length
      } catch {
        return 0
      }
    }
    expect(await pollUntil(() => plansLines() >= 2, 3000)).toBe(true)
  })

  test('切到别的会话目录空（账按会话，互不可见），切回来两条都在', async () => {
    await sessionService().open(sessionB)
    expect(surfaces().planDirectory as PlanEntry[]).toHaveLength(0)
    await sessionService().open(sessionFile)
    const dir = surfaces().planDirectory as PlanEntry[]
    expect(dir.map((item) => item.title)).toEqual(['乙计划', '甲计划'])
  })
})

describe('[3] 后台活（tools-default 贡献 backgroundWorks + stopBackground：按当前会话）', () => {
  test('当前会话起的作业进清单；别的会话起的活不进清单、stopBackground 也收不走', async () => {
    const sid = sessionService().current().meta.id
    const runCtx = { cwd: ws, sessionId: sid, signal: new AbortController().signal }
    const launched = String(
      await tool('bash').run({ command: 'node -e "setTimeout(()=>{}, 60000)"', run_in_background: true }, runCtx),
    )
    expect(launched).toMatch(/job-\d+/)
    let works = surfaces().backgroundWorks as Array<{ id: string; kind: string; title: string }>
    expect(works).toHaveLength(1)
    expect(works[0]?.kind).toBe('job')
    expect(works[0]?.title).toContain('setTimeout')

    const foreignText = String(
      await tool('bash').run(
        { command: 'node -e "setTimeout(()=>{}, 60000)"', run_in_background: true },
        { ...runCtx, sessionId: 'other-session' },
      ),
    )
    const foreign = /job-\d+/.exec(foreignText)?.[0] ?? ''
    expect(foreign).not.toBe('')
    expect(surfaces().backgroundWorks as unknown[]).toHaveLength(1)
    await expect(kernel.ui.stopBackground(foreign)).rejects.toThrow(/别的会话/)

    const worksNow = surfaces().backgroundWorks as Array<{ id: string }>
    const stopped = await kernel.ui.stopBackground(worksNow[0]?.id ?? '')
    expect(surfaces().backgroundWorks as unknown[]).toHaveLength(0)
    expect(stopped).toBeDefined()
    // 外来的那条从工具面收掉（job_kill 是模型 / 脚本面的口，不看会话归属）。
    await tool('job_kill').run({ job_id: foreign }, runCtx)
  })

  test('终端会话进清单（标题取最近发进去的一条命令），readBackground 读得到输出', async () => {
    const sid = sessionService().current().meta.id
    const runCtx = { cwd: ws, sessionId: sid, signal: new AbortController().signal }
    const opened = String(await tool('terminal').run({ action: 'open' }, runCtx))
    const termId = /term-\d+/.exec(opened)?.[0] ?? ''
    expect(termId).not.toBe('')
    await tool('terminal').run({ action: 'send', session_id: termId, data: 'echo hi\n' }, runCtx)
    const works = surfaces().backgroundWorks as Array<{ id: string; kind: string; title: string }>
    expect(works).toHaveLength(1)
    expect(works[0]?.kind).toBe('terminal')
    expect(works[0]?.title).toContain('echo hi')
    await pollUntil(async () => (await kernel.ui.readBackground(termId)).text.includes('hi'))

    const termOut = await kernel.ui.readBackground(termId)
    expect(termOut.kind).toBe('terminal')
    expect(termOut.text).toContain('hi')
    expect(termOut.status).toBe('running')
    expect(typeof termOut.atEnd).toBe('boolean')
    expect(typeof termOut.totalChars).toBe('number')
    expect(termOut.droppedChars).toBe(0)
  })

  test('切会话清单为空，切回来终端会话还在，收掉后清单归空', async () => {
    const works = surfaces().backgroundWorks as Array<{ id: string }>
    const termId = works[0]?.id ?? ''
    await sessionService().open(sessionB)
    expect(surfaces().backgroundWorks as unknown[]).toHaveLength(0)
    await sessionService().open(sessionFile)
    expect((surfaces().backgroundWorks as Array<{ id: string }>).some((work) => work.id === termId)).toBe(true)
    await kernel.ui.stopBackground(termId)
    expect(surfaces().backgroundWorks as unknown[]).toHaveLength(0)
  })
})

describe('[4] 定点任务（schedule 贡献 scheduled，「工作流」区）', () => {
  test('schedule 插件按条目树打开了，任务进「工作流」面（标题 + 下次运行 + 启用态）', async () => {
    const sid = sessionService().current().meta.id
    const runCtx = { cwd: ws, sessionId: sid, signal: new AbortController().signal }
    await tool('schedule').run({ action: 'create', title: '探针任务', prompt: '探针', rule: 'every:30m' }, runCtx)
    const scheduled = surfaces().scheduled as ScheduledEntry[]
    expect(Array.isArray(scheduled)).toBe(true)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.title).toBe('探针任务')
    expect(typeof scheduled[0]?.nextRunAt).toBe('number')
    expect(scheduled[0]?.enabled).toBe(true)
  })
})

describe('[5] 空仓库（HEAD 未出生）：diff 不报错 + 未跟踪按内容合成', () => {
  test('空仓库读得出状态：分支占位、未跟踪原样（非 ASCII 不转义）、目录整条收录', async () => {
    await sessionService().open(sessionC)
    const status = await gitStatus({ stats: true })
    expect(status.branch).toBe('(无提交)')
    expect(status.untracked).toContain('中文 名.txt')
    expect(status.untracked).toContain('sub/')
    expect(status.dirtyFileCount).toBe(5)
  })

  test('空仓库的增删行数把未跟踪计入；≤1MiB 才数，二进制 / 空文件出局', async () => {
    const status = await gitStatus({ stats: true })
    expect(status.added).toBe(4)
    expect(status.removed).toBe(0)
    expect(status.untrackedStats?.['中文 名.txt']?.added).toBe(3)
    expect(status.untrackedStats?.['big.txt']?.added).toBe(1)
    expect(status.untracked).not.toContain('bin.dat')
    expect(status.untracked).not.toContain('empty.txt')
  })

  test('「全部改动」不再吐 HEAD 的原始报错；未跟踪合成出全新增段；合成不出的报条数', async () => {
    const all = await gitDiff({})
    expect(typeof all.diff).toBe('string')
    expect(all.diff).not.toContain('ambiguous argument')
    expect(all.diff).toContain('+++ b/中文 名.txt')
    expect(all.diff).toContain('@@ -0,0 +1,3 @@')
    expect(all.diff).toContain('+one')
    expect(all.note).toContain('另有 4 个未跟踪条目')
  })

  test('单点未跟踪：合成 patch（`--- /dev/null` + 新文件头），且不带 note', async () => {
    const one = await gitDiff({ file: '中文 名.txt' })
    expect(one.diff).toContain('--- /dev/null')
    expect(one.diff).toContain('+++ b/中文 名.txt')
    expect(one.note ?? '').toBe('')
  })

  test('二进制 / 超过 512KB / 空文件 / 目录条目：给说明不出 diff', async () => {
    const binary = await gitDiff({ file: 'bin.dat' })
    expect(binary.diff).toBe('')
    expect(binary.note).toContain('二进制')
    const big = await gitDiff({ file: 'big.txt' })
    expect(big.diff).toBe('')
    expect(big.note).toContain('512KB')
    const empty = await gitDiff({ file: 'empty.txt' })
    expect(empty.diff).toBe('')
    expect(empty.note).toContain('空文件')
    const dir = await gitDiff({ file: 'sub/' })
    expect(dir.diff).toBe('')
    expect(dir.note).toContain('未跟踪目录')
  })

  test('空仓库里暂存后的单文件 diff 也出得来（无 HEAD 走 `diff --cached`）', async () => {
    gitIn(join(home, 'ws-none'), 'add', '中文 名.txt')
    const staged = await gitDiff({ file: '中文 名.txt' })
    expect(staged.diff).toContain('+two')
    const after = await gitStatus({ stats: true })
    expect(after.added).toBe(4)
    expect(after.removed).toBe(0)
    expect(after.stagedStats?.['中文 名.txt']?.added).toBe(3)
    expect(after.staged?.some((line) => line.startsWith('A ') && line.includes('中文 名.txt'))).toBe(true)
    expect(after.untracked).not.toContain('中文 名.txt')
    await sessionService().open(sessionFile)
  })
})

describe('[6] 会话目录是仓库子目录：路径基准 rebase + 只看 cwd 之内', () => {
  test('展示路径 rebase 到 cwd 相对，cwd 之外的仓库改动整条过滤', async () => {
    const wsRepo = join(home, 'ws-sub')
    mkdirSync(join(wsRepo, 'sub'), { recursive: true })
    gitIn(wsRepo, 'init', '-q')
    writeFileSync(join(wsRepo, 'root.txt'), 'root\n', 'utf8')
    writeFileSync(join(wsRepo, 'sub', 'inner.txt'), 'one\ntwo\n', 'utf8')
    gitIn(wsRepo, 'add', '-A')
    gitIn(wsRepo, 'commit', '-qm', 'init')
    writeFileSync(join(wsRepo, 'root.txt'), 'root\nchanged-outside\n', 'utf8')
    writeFileSync(join(wsRepo, 'sub', 'inner.txt'), 'one\nTWO\nthree\n', 'utf8')
    writeFileSync(join(wsRepo, 'sub', 'newfile.txt'), 'fresh\nlines\n', 'utf8')
    const sessionSub = writeSession('dddddddd-eeee-ffff-0000-111122223333', join(wsRepo, 'sub'), 4)
    await sessionService().open(sessionSub)

    const status = await gitStatus({ stats: true })
    expect(status.unstaged?.some((line) => line.endsWith('inner.txt'))).toBe(true)
    expect(status.unstaged?.some((line) => line.includes('sub/'))).toBe(false)
    expect(JSON.stringify(status)).not.toContain('root.txt')
    expect(status.unstagedStats?.['inner.txt']).toEqual({ added: 2, removed: 1 })
    expect(status.untrackedStats?.['newfile.txt']?.added).toBe(2)
  })

  test('点 cwd 里的未跟踪行：合成出全新增段；点 tracked 行：出得来该文件的 diff', async () => {
    const one = await gitDiff({ file: 'newfile.txt' })
    expect(one.diff).toContain('+++ b/newfile.txt')
    expect(one.diff).toContain('+fresh')
    const tracked = await gitDiff({ file: 'inner.txt' })
    expect(tracked.diff).toContain('+TWO')
    expect(tracked.diff).toContain('-two')
  })

  test('「全部改动」也限定在 cwd 之内（不带 cwd 外的 root.txt 改动）', async () => {
    const all = await gitDiff({})
    expect(all.diff).toContain('inner.txt')
    expect(all.diff).not.toContain('root.txt')
    await sessionService().open(sessionFile)
  })
})

describe('[7] 后台活输出面（readBackground：只读快照 + 归属校验 + 不动模型增量游标）', () => {
  test('readBackground 读作业输出非空（kind = job，带 atEnd / 头部丢字字段）', async () => {
    const sid = sessionService().current().meta.id
    const runCtx = { cwd: ws, sessionId: sid, signal: new AbortController().signal }
    const launched = String(
      await tool('bash').run({ command: 'node -e "console.log(\'job-hello-output\')"', run_in_background: true }, runCtx),
    )
    const jobId = /job-\d+/.exec(launched)?.[0] ?? ''
    expect(jobId).not.toBe('')
    await pollUntil(async () => (await kernel.ui.readBackground(jobId)).text.includes('job-hello-output'))
    await kernel.ui.readBackground(jobId)
    const view = await kernel.ui.readBackground(jobId)
    expect(view.kind).toBe('job')
    expect(view.text).toContain('job-hello-output')
    expect(typeof view.atEnd).toBe('boolean')
    expect(view.droppedChars).toBe(0)
    expect(typeof view.totalChars).toBe('number')

    // peek 不动 lastRead：界面读过之后，模型的 job_output 仍能从头上读到全文。
    const modelRead = String(await tool('job_output').run({ job_id: jobId }, runCtx))
    expect(modelRead).toContain('job-hello-output')

    // 归属校验：别的会话起的活读不了（与 stop 同口径）；陌生 id 也拒（不静默给空）。
    const foreignText = String(
      await tool('bash').run(
        { command: 'node -e "setTimeout(()=>{}, 60000)"', run_in_background: true },
        { ...runCtx, sessionId: 'other-session' },
      ),
    )
    const foreignId = /job-\d+/.exec(foreignText)?.[0] ?? ''
    expect(foreignId).not.toBe('')
    await expect(kernel.ui.readBackground(foreignId)).rejects.toThrow(/别的会话/)
    await expect(kernel.ui.readBackground('job-99999')).rejects.toThrow()

    await kernel.ui.stopBackground(jobId)
    await tool('job_kill').run({ job_id: foreignId }, runCtx)
  })
})

describe('[8] git 快照面（surfaces.git）+ 分支清单 / 切分支 / 建分支', () => {
  /** 起始分支名与起始审批策略：第一条用例记下，收尾切回、还原（探针同口径）。 */
  let branch0 = ''
  let policy0 = ''

  const gitHead = (): string =>
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ws, encoding: 'utf8' }).trim()

  test('git 面在场；界面一读就催一拍，读数立刻到位（不是等 5 秒的巡检档）', async () => {
    await sessionService().open(sessionFile)
    branch0 = gitHead()
    policy0 = approvalService().policy
    expect(await quietSurface((git) => git.repo === true && git.branch === branch0)).toBe(true)
    const first = surfaces()
    expect(typeof first.git).toBe('object')
    expect(first.git).not.toBeNull()
    expect(typeof (first.git as GitSurface).repo).toBe('boolean')
    expect(await pollUntil(() => (surfaces().git as GitSurface).repo === true, 4000)).toBe(true)
  })

  test('分支名与 git-status 一致；改动计数同口径（含未跟踪，只看 cwd 之内）；detached = false', async () => {
    const mine = surfaces().git as GitSurface
    const status = await gitStatus({ stats: true })
    expect(mine.branch).toBe(status.branch)
    // 快照面是按拍缓存的读数，工作区刚变过那一下会落后一拍；等它追上再比（慢不算错）。
    const sameCount = await pollUntil(
      () => (surfaces().git as GitSurface).dirtyFileCount === status.dirtyFileCount,
      SURFACE_CATCHUP_MS,
    )
    expect(sameCount).toBe(true)
    expect(mine.detached).toBe(false)
  })

  test('分支清单：本地两条都在、当前那条排第一且标 current', async () => {
    gitIn(ws, 'branch', 'probe-side')
    const list = (await dock().handle('git-branches', {})) as GitBranchesView
    expect(typeof list.current).toBe('string')
    expect(list.detached).toBe(false)
    expect(list.branches).toHaveLength(2)
    expect(list.branches[0]?.current).toBe(true)
    expect(list.branches[0]?.name).toBe(list.current)
    expect(list.branches[1]?.current).toBe(false)
    expect(list.branches[1]?.name).toBe('probe-side')
  })

  test('只读档下切分支被拒（写类 op 过审批闸），工作区没动', async () => {
    const approval = approvalService()
    approval.setPolicy('readonly')
    await expect(dock().handle('git-checkout', { branch: 'probe-side' })).rejects.toThrow(/已拒绝/)
    expect(gitHead()).toBe(branch0)
    approval.setPolicy('full-access')
  })

  test('完全访问：真切成立，快照面自己跟上（催拍那条路，不必等下一个 12 秒）', async () => {
    const switched = (await dock().handle('git-checkout', { branch: 'probe-side' })) as GitOpView
    expect(switched.ok).toBe(true)
    expect(switched.branch).toBe('probe-side')
    expect(gitHead()).toBe('probe-side')
    expect(await pollUntil(() => (surfaces().git as GitSurface).branch === 'probe-side', 8000)).toBe(true)
  })

  test('建分支并切过去；新分支进了清单', async () => {
    const created = (await dock().handle('git-branch-create', { branch: 'probe-fresh' })) as GitOpView
    expect(created.ok).toBe(true)
    expect(created.branch).toBe('probe-fresh')
    expect(gitHead()).toBe('probe-fresh')
    expect(await pollUntil(() => (surfaces().git as GitSurface).branch === 'probe-fresh', 8000)).toBe(true)
    const list = (await dock().handle('git-branches', {})) as GitBranchesView
    expect(list.branches).toHaveLength(3)
  })

  test('切回原分支也成；策略还原', async () => {
    await sessionService().open(sessionFile)
    gitIn(ws, 'checkout', branch0)
    expect(gitHead()).toBe(branch0)
    approvalService().setPolicy(policy0)
  })

  test('非仓库：面里 repo = false（界面整行不画），清单给空表而不是抛错', async () => {
    const branch0 = gitHead()
    expect(await quietSurface((git) => git.repo === true && git.branch === branch0)).toBe(true)
    await sessionService().open(sessionPlain)
    expect(await pollUntil(() => (surfaces().git as GitSurface).repo === false, 8000)).toBe(true)
    const plainList = (await dock().handle('git-branches', {})) as GitBranchesView
    expect(plainList.branches).toHaveLength(0)
    expect(plainList.current).toBe('')
    await sessionService().open(sessionFile)
  })
})
