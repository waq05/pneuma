/**
 * plan 插件长尾补盲（w14）：
 *
 *   - 僵尸计划卡还在、同一会话又交来新计划：旧卡按「作废」安静收尾（只 touch，不喊界面）；
 *   - 活跃评审卡挂着时同会话恢复出一张僵尸卡：卡落定时清掉内存里那张，别让 `anyFor` 恒真。
 *
 * 复用 `plan.spec.ts` 的假 ctx 真 apply 形状；`DSC_HOME` 在任何产品 import 之前指进
 * 临时目录，计划文件写在临时工作区。
 *
 * @module dsc/packages/plan/tests/w14-gaps.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlanView } from '@pneuma/runtime/contract.js'
import type { PlanService } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-plan-w14-'))
const workdir = join(home, 'work')
process.env['DSC_HOME'] = join(home, '.dsc')
const savedDscHome = process.env['DSC_HOME']

let planPlugin: (typeof import('../index.js'))['planPlugin']

interface FakeSession {
  meta: { id: string; cwd: string }
  filePath: string
  messages: unknown[]
  state: (name: string) => unknown
  appendState: (name: string, value: unknown) => void
}

interface Harness {
  service: PlanService
  tool: { run: (args: Record<string, unknown>, runCtx: Record<string, unknown>) => Promise<unknown> }
  waiting: Map<string, (owner?: string) => boolean>
  modes: string[]
  handlers: Map<string, (input: Record<string, unknown>) => void>
  session: FakeSession
  emissions: string[]
}

function mount(): Harness {
  const state = new Map<string, unknown>()
  const session: FakeSession = {
    meta: { id: 'plan-w14-session', cwd: workdir },
    filePath: join(home, 'sessions', 'plan-w14.jsonl'),
    messages: [],
    state: (name) => state.get(name),
    appendState: (name, value) => {
      state.set(name, value)
    },
  }
  const harness = {
    service: undefined as unknown as PlanService,
    tool: undefined as unknown as Harness['tool'],
    waiting: new Map<string, (owner?: string) => boolean>(),
    modes: [] as string[],
    handlers: new Map<string, (input: Record<string, unknown>) => void>(),
    session,
    emissions: [] as string[],
  }
  const ctx = {
    session: { current: () => session },
    get: () => undefined,
    provide(_name: string, value: PlanService) {
      harness.service = value
    },
    tools: {
      register(entry: Harness['tool']) {
        harness.tool = entry
        return () => undefined
      },
    },
    surfaces: { register: () => () => undefined },
    waiting: {
      register(id: string, pending: (owner?: string) => boolean) {
        harness.waiting.set(id, pending)
        return () => undefined
      },
    },
    mode: {
      setMode(mode: string) {
        harness.modes.push(mode)
      },
    },
    on(event: string, handler: (input: Record<string, unknown>) => void) {
      harness.handlers.set(event, handler)
      return () => undefined
    },
    emit(event: string) {
      harness.emissions.push(event)
    },
    effect(execute: () => unknown) {
      const off = execute()
      return typeof off === 'function' ? off : () => undefined
    },
  }
  planPlugin.apply?.(ctx as never, {} as never)
  return harness
}

async function waitForCard(harness: Harness, title?: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const card = harness.service.pendingPlan() as PlanView | null
    if (card !== null && (title === undefined || card.title === title)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('评审卡还没挂上')
}

afterAll(() => {
  if (savedDscHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = savedDscHome
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 句柄：留给系统清
  }
})

beforeAll(async () => {
  planPlugin = (await import('../index.js')).planPlugin
})

test('僵尸卡还在、同会话又交新计划：旧卡按作废安静收尾，新卡照常批', async () => {
  const harness = mount()
  harness.session.appendState('plan', { file: 'old.md', title: '旧计划', text: '# 旧', decision: 'pending' })
  harness.handlers.get('dsc/session-open')?.({ session: harness.session, filePath: harness.session.filePath })
  expect(harness.service.pendingPlan()).not.toBeNull()
  const pending = harness.tool.run(
    { plan: '# 新计划\n\n第一步：跑测试。', title: '新计划' },
    { cwd: workdir, signal: new AbortController().signal },
  )
  // 僵尸卡先被安静作废，之后挂上来的必须是这份新计划。
  await waitForCard(harness, '新计划')
  harness.service.answerPlan('approved')
  expect(String(await pending)).toContain('用户已批准')
  expect((harness.session.state('plan') as PlanView).decision).toBe('approved')
  expect(harness.modes).toEqual(['build'])
})

test('活跃卡挂着时同会话恢复出僵尸卡：卡落定时清掉内存那张', async () => {
  const harness = mount()
  const pending = harness.service.proposePlan({ file: 'live.md', title: '待批', text: '# 待批' }, new AbortController().signal)
  await waitForCard(harness)

  // 评审卡还挂着，同一条会话的 jsonl 里又读出 pending 的计划条目。
  harness.session.appendState('plan', { file: 'zombie.md', title: '僵尸', text: '# 僵尸', decision: 'pending' })
  harness.handlers.get('dsc/session-open')?.({ session: harness.session, filePath: harness.session.filePath })
  harness.service.answerPlan('approved')
  await pending

  expect(harness.service.pendingPlan()).toBeNull()
  expect((harness.session.state('plan') as PlanView).decision).toBe('approved')
  // 清掉内存僵尸卡后等待登记不再恒真。
  expect(harness.waiting.get('plan')?.(harness.session.meta.id)).toBe(false)
})
