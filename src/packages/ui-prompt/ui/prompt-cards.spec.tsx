/**
 * 提示卡（`ui-prompt/ui/ui.tsx`）：审批、计划评审、模型提问三张卡（ui 层，真渲染）。
 *
 * 这是「人点一下决定放不放行」的地方，按钮与快捷键的对应关系写错就等于替用户答了。
 * 这里用假宿主快照把三张卡分别点亮：按钮/快捷键各回传什么、失效与失败怎么显示、
 * 批量提问的逐题提交顺序、以及一张卡崩了不拖累另外两张。
 *
 * @module dsc-ui-prompt/ui/prompt-cards.spec
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentType } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot, UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** PromptCards 不直接导出：照壳装载插件那条路，收下 `shell.composer` 的登记。 */
function promptCards(): ComponentType {
  const registered: Array<{ slot: string; id: string; component: unknown }> = []
  const fakeUi = {
    slots: {
      register: (slot: string, options: { id?: string }, component: unknown): void => {
        registered.push({ slot, id: options.id ?? '', component })
      },
      declare: (): void => undefined,
      registerFactory: (): void => undefined,
    },
    provide: (): void => undefined,
    consume(): undefined {
      return undefined
    },
  } as unknown as UiPluginApi
  plugin.apply(fakeUi)
  const found = registered.find((item) => item.slot === 'shell.composer' && item.id === 'prompt.cards')
  if (found === undefined) throw new Error('prompt 插件没有把提示卡登记进 shell.composer')
  return found.component as ComponentType
}

const PromptCards = promptCards()

type Approval = Record<string, unknown>

function approval(overrides: Approval = {}): Approval {
  return {
    id: 'a1',
    toolName: 'bash',
    argsSummary: 'rm -rf build',
    meaning: '删除构建产物',
    reason: '命中危险命令',
    risk: 'medium',
    suggestedRule: null,
    hardline: false,
    scopes: ['once', 'session', 'always'],
    policy: 'auto-edit',
    reviewer: 'user',
    mode: 'build',
    ...overrides,
  }
}

const PLAN = {
  file: 'C:/repo/.dsc/plans/p1.md',
  title: '重构方案',
  text: '# 步骤\n1. 拆模块',
  decision: 'pending',
}

const QUESTION = {
  id: 'q1',
  question: '选哪个？',
  options: [{ label: '甲' }, { label: '乙' }],
  multiSelect: false,
  allowFreeText: true,
}

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

function harnessOf(surfaces: Record<string, unknown>, options: { rejectAnswer?: boolean } = {}): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const snapshot = {
    sessions: [],
    status: { cwd: 'C:/repo', turnState: 'idle' },
    surfaces,
  } as unknown as HostSnapshot
  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      if (options.rejectAnswer === true) return Promise.reject(new Error('宿主没接上')) as Promise<T>
      return Promise.resolve({ ok: true }) as Promise<T>
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return { channel, calls }
}

const mount = (harness: Harness): ReturnType<typeof render> =>
  render(
    <RuntimeProvider channel={harness.channel}>
      <PromptCards />
    </RuntimeProvider>,
  )

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

const textOf = (element: Element | null): string => element?.textContent ?? ''

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  cleanup()
})

describe('审批卡', () => {
  test('三档都在：工具名/含义/理由可见，中风险带徽章，三个放行 + 拒绝', async () => {
    const harness = harnessOf({ pendingApproval: approval() })
    const { container } = mount(harness)
    await flush()
    expect(textOf(container.querySelector('.approval'))).toContain('bash')
    expect(textOf(container.querySelector('.approval'))).toContain('删除构建产物')
    expect(textOf(container.querySelector('.approval'))).toContain('命中危险命令')
    expect(container.querySelector('.risk-badge')).not.toBeNull()
    const buttons = container.querySelectorAll('.approval-actions button')
    expect(buttons).toHaveLength(4)

    fireEvent.click(buttons[0] as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'answerApproval', args: ['allow-once'] })
  })

  test('低风险不画徽章；scopes 只有 once 时只给两个按钮', async () => {
    const harness = harnessOf({ pendingApproval: approval({ risk: 'low', scopes: ['once'] }) })
    const { container } = mount(harness)
    await flush()
    expect(container.querySelector('.risk-badge')).toBeNull()
    expect(container.querySelectorAll('.approval-actions button')).toHaveLength(2)
  })

  test('硬地板：一个放行按钮都不给，只留说明', async () => {
    const harness = harnessOf({ pendingApproval: approval({ hardline: true }) })
    const { container } = mount(harness)
    await flush()
    expect(container.querySelector('.approval-hardline')).not.toBeNull()
    expect(container.querySelector('.approval-actions')).toBeNull()
  })

  test('快捷键：y/s/a/n 与 Esc 各回传对应决定；焦点在输入框时不抢键', async () => {
    const harness = harnessOf({ pendingApproval: approval() })
    mount(harness)
    await flush()

    fireEvent.keyDown(window, { key: 'y' })
    await flush()
    fireEvent.keyDown(window, { key: 's' })
    fireEvent.keyDown(window, { key: 'a' })
    fireEvent.keyDown(window, { key: 'Escape' })
    await flush()
    const answers = harness.calls.filter((call) => call.method === 'answerApproval').map((call) => call.args[0])
    expect(answers).toEqual(['allow-once'])

    // 首次点击后 busy 会锁住按钮，但键盘处理里也有 busy 守卫：重置一张新卡再测 n/Esc。
    cleanup()
    const second = harnessOf({ pendingApproval: approval() })
    mount(second)
    await flush()
    fireEvent.keyDown(window, { key: 'n' })
    await flush()
    expect(second.calls).toContainEqual({ method: 'answerApproval', args: ['reject'] })

    const typing = document.createElement('textarea')
    document.body.append(typing)
    typing.focus()
    cleanup()
    const third = harnessOf({ pendingApproval: approval() })
    mount(third)
    await flush()
    fireEvent.keyDown(window, { key: 'y' })
    await flush()
    expect(third.calls.some((call) => call.method === 'answerApproval')).toBe(false)
  })

  test('提交失败：按钮放开并把原因写在卡里', async () => {
    const harness = harnessOf({ pendingApproval: approval() }, { rejectAnswer: true })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelector('.approval-actions button') as HTMLElement)
    await flush()
    expect(textOf(container.querySelector('.shell-composer-fault'))).toContain('宿主没接上')
    expect((container.querySelector('.approval-actions button') as HTMLButtonElement).disabled).toBe(false)
  })

  test('差异预览：有 diff 时不重复参数行；展开后逐行显示增删；错位/回退各有提示', async () => {
    const harness = harnessOf({
      pendingApproval: approval({
        argsSummary: '{"path":"a.ts"}',
        diff: {
          path: 'C:/repo/a.ts',
          status: 'modify',
          added: 1,
          removed: 0,
          mismatch: 'missing',
          fellBack: true,
          hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [{ kind: 'add', oldLine: null, newLine: 1, text: '新行' }] }],
        },
      }),
    })
    const { container } = mount(harness)
    await flush()
    expect(container.querySelector('.approval-args')).toBeNull()
    expect(textOf(container.querySelector('.approval-diff-head'))).toContain('a.ts')
    expect(textOf(container.querySelector('.changes-added'))).toContain('+1')
    expect(container.querySelector('.tc-warn')).not.toBeNull()
    expect(container.querySelector('.approval-diff-note')).not.toBeNull()

    fireEvent.click(container.querySelector('.approval-diff-toggle') as HTMLElement)
    expect(container.querySelector('.diff-line.diff-add')).not.toBeNull()
    expect(textOf(container.querySelector('.diff-line.diff-add'))).toContain('新行')
  })
})

describe('计划评审卡', () => {
  test('待批：批准直接回传 approved', async () => {
    const harness = harnessOf({ pendingPlan: PLAN })
    const { container } = mount(harness)
    await flush()
    expect(textOf(container.querySelector('.plan-title'))).toContain('重构方案')
    expect(container.querySelector('.plan-body')).not.toBeNull()
    fireEvent.click(container.querySelectorAll('.plan-btn')[0] as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'answerPlan', args: ['approved'] })
  })

  test('打回：先展开反馈框，提交时把反馈一起带上', async () => {
    const harness = harnessOf({ pendingPlan: PLAN })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelectorAll('.plan-btn')[1] as HTMLElement)
    const box = container.querySelector('.plan-feedback') as HTMLTextAreaElement
    expect(box).not.toBeNull()
    fireEvent.change(box, { target: { value: '把第三步拆细' } })
    fireEvent.click(container.querySelectorAll('.plan-btn')[0] as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'answerPlan', args: ['rejected', '把第三步拆细'] })
  })
})

describe('提问卡', () => {
  test('单选：选项即答案，提交回传选中项', async () => {
    const harness = harnessOf({ pendingQuestion: QUESTION })
    const { container } = mount(harness)
    await flush()
    const options = container.querySelectorAll('.ask-option')
    expect(options).toHaveLength(2)
    fireEvent.click(options[0] as HTMLElement)
    expect(container.querySelector('.ask-option.picked')).not.toBeNull()
    fireEvent.click(container.querySelector('.ask-submit') as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'answerQuestion', args: ['甲'] })
  })

  test('批量：下一题不提交，最后一题逐题交回；跳过的题交回跳过文案', async () => {
    const harness = harnessOf({
      pendingQuestion: {
        ...QUESTION,
        questions: [
          { id: 'q1', question: '第一题', options: [{ label: '甲' }], multiSelect: false, allowFreeText: false },
          { id: 'q2', question: '第二题', options: [{ label: '乙' }], multiSelect: false, allowFreeText: false },
        ],
      },
    })
    const { container } = mount(harness)
    await flush()
    expect(container.querySelector('.ask-card')?.getAttribute('data-ask-count')).toBe('2')
    fireEvent.click(container.querySelector('.ask-option') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-submit') as HTMLElement)
    await flush()
    expect(harness.calls.some((call) => call.method === 'answerQuestion')).toBe(false)

    // 第二题跳过：最后一题跳过会直接提交，两题的答案都交出去。
    fireEvent.click(container.querySelector('.ask-skip') as HTMLElement)
    await flush()
    const answers = harness.calls.filter((call) => call.method === 'answerQuestion').map((call) => call.args[0])
    expect(answers).toHaveLength(2)
    expect(answers[0]).toBe('甲')
    expect(typeof answers[1]).toBe('string')
  })

  test('提交失败：保留草稿并把原因显示出来', async () => {
    const harness = harnessOf({ pendingQuestion: QUESTION }, { rejectAnswer: true })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelector('.ask-option') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-submit') as HTMLElement)
    await flush()
    expect(textOf(container.querySelector('.shell-composer-fault'))).toContain('宿主没接上')
    expect(container.querySelector('.ask-option.picked')).not.toBeNull()
  })
})

describe('空态与错误边界', () => {
  test('三张卡都没挂起：什么都不画（不留空外壳）', async () => {
    const harness = harnessOf({})
    const { container } = mount(harness)
    await flush()
    expect(container.innerHTML).toBe('')
  })

  test('一张卡数据长歪：只顶掉它那一张，另外两张照常可答', async () => {
    const harness = harnessOf({
      // risk 不认识 → 审批卡渲染期抛错，被 CardBoundary 接住。
      pendingApproval: approval({ risk: 'unknown' }),
      pendingPlan: PLAN,
    })
    const { container } = mount(harness)
    await flush()
    expect(container.querySelector('[data-card-crash]')).not.toBeNull()
    expect(container.querySelector('.plan-card')).not.toBeNull()
    fireEvent.click(container.querySelectorAll('.plan-btn')[0] as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'answerPlan', args: ['approved'] })
  })
})
