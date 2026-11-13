/**
 * plan 包级测试：插件对象、`exit_plan_mode` 工具、两个投影与一个等待登记。
 *
 * 迁移说明：原文件五条断言里十条正则全在读 `index.ts` 源码（工具名、`required: ['plan']`、
 * `risk: 'read'`、`planFilePath(...)`、`ctx.mode.setMode('build')`、三个 register 名字、
 * 两个 `*_LIMIT` 常量）。它们描述的对象与行为都只在 apply() 之后才存在，所以现在用假 ctx
 * 真跑一遍 apply，然后：
 *   - 工具名/风险/必填从 `tools.register` 抓到的对象上取；
 *   - 「计划落盘」真调一次 `run`，看 `.dsc/plans/` 下是不是真写出了那份文件；
 *   - 「批准后切回 build」从假 `mode.setMode` 的调用参数上取；
 *   - 三个投影从 `surfaces` / `waiting` 注册表上取，并且验证它们**返回的值**；
 *   - 两个上限用真行为验：15 条账只出 12 条、51 次提交只留 50 条。
 *
 * 环境隔离：`audit()` 在模块加载时就算出 `~/.dsc/audit.jsonl`，所以先把 `DSC_HOME`
 * 指到 `mkdtempSync` 的临时目录再动态 import；计划文件写在同一个临时目录下的工作区里。
 *
 * @module @pneuma/plan/tests
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanEntryView, PlanView } from '@pneuma/runtime/contract.js'
import type { PlanService } from '@pneuma/runtime/services/types.js'
import { afterAll, expect, test, vi } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-plan-spec-'))
const workdir = join(home, 'work')
process.env.DSC_HOME = join(home, '.dsc')

const { planPlugin } = await import('../index.js')

/** 计划评审卡在状态条目里的形状。 */
interface PlanState {
  items?: Array<{ file: string; title: string; at: number; decision: string }>
}

/** 一条被捕获的会话状态。 */
type StateMap = Map<string, unknown>

/** 假会话：状态存 Map，计划工具只碰这几项。 */
interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  messages: unknown[]
  state: (name: string) => unknown
  appendState: (name: string, value: unknown) => void
}

function fakeSession(id = 'plan-spec-session'): FakeSession {
  const state: StateMap = new Map()
  return {
    meta: { id, cwd: workdir },
    filePath: join(home, 'sessions', `${id}.jsonl`),
    messages: [],
    state: (name) => state.get(name),
    appendState: (name, value) => {
      state.set(name, value)
    },
  }
}

/** apply 捕获到的东西。 */
interface Harness {
  service: PlanService
  tool: {
    name: string
    risk: string
    parameters: { required?: string[]; properties: Record<string, { type?: string }> }
    run: (args: Record<string, unknown>, runCtx: Record<string, unknown>) => Promise<unknown>
  }
  surfaces: Map<string, () => unknown>
  waiting: Map<string, (owner?: string) => boolean>
  modes: string[]
  handlers: Map<string, (input: Record<string, unknown>) => void>
  session: FakeSession
}

/** 假 ctx：apply 用到的面都实现，`effect` 真跑回调（否则注册不会发生）。 */
function mount(): Harness {
  const session = fakeSession()
  const harness = {
    service: undefined as unknown as PlanService,
    tool: undefined as unknown as Harness['tool'],
    surfaces: new Map<string, () => unknown>(),
    waiting: new Map<string, (owner?: string) => boolean>(),
    modes: [] as string[],
    handlers: new Map<string, (input: Record<string, unknown>) => void>(),
    session,
  }
  const ctx = {
    session: { current: () => session },
    get: () => undefined,
    provide: (_name: string, value: PlanService) => {
      harness.service = value
    },
    tools: {
      register: (entry: Harness['tool']) => {
        harness.tool = entry
        return () => {}
      },
    },
    surfaces: {
      register: (id: string, read: () => unknown) => {
        harness.surfaces.set(id, read)
        return () => {}
      },
    },
    waiting: {
      register: (id: string, pending: (owner?: string) => boolean) => {
        harness.waiting.set(id, pending)
        return () => {}
      },
    },
    mode: {
      setMode: (mode: string) => {
        harness.modes.push(mode)
      },
    },
    on: (event: string, handler: (input: Record<string, unknown>) => void) => {
      harness.handlers.set(event, handler)
      return () => {}
    },
    emit: () => {},
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  planPlugin.apply(ctx as never)
  return harness
}

/** 每个用例装一次，互不共享挂起卡。 */
const mountPlan = (): Harness => mount()

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

/** 等一张卡真的挂上（工具 run 先落盘、后挂卡，是异步的）。 */
const waitForCard = async (harness: Harness): Promise<void> => {
  await vi.waitFor(() => {
    if (harness.service.pendingPlan() === null) throw new Error('评审卡还没挂上')
  })
}

test('插件对象：名字、提供服务、五个注入', () => {
  expect(planPlugin.name).toBe('plan')
  expect(planPlugin.provide).toBe('plan')
  expect([...(planPlugin.inject ?? [])]).toEqual(['session', 'tools', 'mode', 'surfaces', 'waiting'])
  expect(typeof planPlugin.apply).toBe('function')
})

test('工具叫 exit_plan_mode，风险只读，只有 plan 必填', () => {
  const harness = mountPlan()
  expect(harness.tool.name).toBe('exit_plan_mode')
  expect(harness.tool.risk).toBe('read')
  expect(harness.tool.parameters.required).toEqual(['plan'])
  expect(harness.tool.parameters.properties['plan']?.type).toBe('string')
  expect(harness.tool.parameters.properties['title']?.type).toBe('string')
})

test('计划真写进 .dsc/plans/，批准后调 mode.setMode(build)', async () => {
  const harness = mountPlan()
  const pending = harness.tool.run(
    { plan: '# 迁移计划\n\n第一步：先跑测试。' },
    { cwd: workdir, signal: new AbortController().signal },
  )
  await waitForCard(harness)
  const card = harness.service.pendingPlan()
  expect(card?.title).toBe('迁移计划')
  expect(card?.decision).toBe('pending')
  // 落盘路径在 planFilePath(cwd, title) 那一路：工作区下 `.dsc/plans/` 里真有一份文件。
  expect(typeof card?.file).toBe('string')
  expect(existsSync(String(card?.file))).toBe(true)
  expect(readFileSync(String(card?.file), 'utf8')).toContain('第一步：先跑测试。')

  harness.service.answerPlan('approved')
  const text = String(await pending)
  expect(text).toContain('用户已批准这份计划')
  expect(harness.modes).toEqual(['build'])
  expect(harness.service.pendingPlan()).toBeNull()
})

test('拒绝时把用户原话捎给模型，且不切模式', async () => {
  const harness = mountPlan()
  const pending = harness.tool.run(
    { plan: '# 另一个计划\n\n正文', title: '另一个计划' },
    { cwd: workdir, signal: new AbortController().signal },
  )
  await waitForCard(harness)
  harness.service.answerPlan('rejected', '  先补上回滚步骤  ')
  const text = String(await pending)
  expect(text).toContain('用户没有批准这份计划')
  expect(text).toContain('先补上回滚步骤')
  expect(harness.modes).toEqual([])
})

test('投影两个面 + 一个等待登记，且都真能返回挂起的那张卡', async () => {
  const harness = mountPlan()
  expect([...harness.surfaces.keys()]).toEqual(['pendingPlan', 'planDirectory'])
  expect([...harness.waiting.keys()]).toEqual(['plan'])
  expect(harness.surfaces.get('pendingPlan')?.()).toBeNull()
  expect(harness.waiting.get('plan')?.()).toBe(false)

  const pending = harness.service.proposePlan({ file: 'x.md', title: '示例', text: '# 示例' }, new AbortController().signal)
  expect(harness.surfaces.get('pendingPlan')?.()).not.toBeNull()
  expect(harness.waiting.get('plan')?.()).toBe(true)
  // 按会话登记：别人的卡不挡这条会话
  expect(harness.waiting.get('plan')?.('another-session')).toBe(false)
  harness.service.answerPlan('approved')
  await pending
})

test('恢复会话时把僵尸计划卡放回投影（dsc/session-open）', () => {
  const harness = mountPlan()
  const zombie: PlanView = { file: 'z.md', title: '旧计划', text: '# 旧计划', decision: 'pending' }
  harness.session.appendState('plan', zombie)
  harness.handlers.get('dsc/session-open')?.({ session: harness.session, filePath: harness.session.filePath })
  expect(harness.service.pendingPlan()).toEqual(zombie)
  expect(harness.waiting.get('plan')?.(harness.session.meta.id)).toBe(true)
  // 用户点了拒绝：状态写回 rejected，卡收掉
  harness.service.answerPlan('rejected')
  expect((harness.session.state('plan') as PlanView).decision).toBe('rejected')
  expect(harness.service.pendingPlan()).toBeNull()
})

test('计划目录只出最近 12 条，按提交时刻倒序', () => {
  const harness = mountPlan()
  const items = Array.from({ length: 15 }, (_, index) => ({
    file: `p${index}.md`,
    title: `计划 ${index}`,
    at: index,
    decision: 'approved',
  }))
  harness.session.appendState('plans', { items })
  const directory = harness.surfaces.get('planDirectory')?.() as PlanEntryView[]
  expect(directory.length).toBe(12)
  expect(directory[0]?.title).toBe('计划 14')
  expect(directory.at(-1)?.title).toBe('计划 3')
})

test('会话账最多留 50 条（提交 51 次只留最后 50）', async () => {
  const harness = mountPlan()
  for (let index = 0; index < 51; index += 1) {
    const pending = harness.service.proposePlan(
      { file: `p${index}.md`, title: `计划 ${index}`, text: '# x' },
      new AbortController().signal,
    )
    harness.service.answerPlan('approved')
    await pending
  }
  const state = harness.session.state('plans') as PlanState
  expect(state.items?.length).toBe(50)
  expect(state.items?.[0]?.title).toBe('计划 1')
  expect(state.items?.at(-1)?.title).toBe('计划 50')
})

test('宿主退出时挂起的卡按拒绝收尾，不留悬 Promise', async () => {
  const harness = mountPlan()
  const pending = harness.service.proposePlan(
    { file: 'q.md', title: '待批', text: '# 待批' },
    new AbortController().signal,
  )
  expect(harness.service.pendingPlan()).not.toBeNull()
  harness.handlers.get('dsc/exit')?.({})
  // quiet 收尾：决策是 rejected，但不再喊界面
  expect(await pending).toBe('rejected')
  expect(harness.service.pendingPlan()).toBeNull()
  expect((harness.session.state('plan') as PlanView).decision).toBe('rejected')
})

