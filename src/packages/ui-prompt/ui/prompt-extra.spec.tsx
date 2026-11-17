/**
 * 提示卡（`ui-prompt/ui/ui.tsx`）的补充分支（ui 层，真渲染）。
 *
 * `prompt-cards.spec.tsx` 已钉住三张卡的主干（三档放行、计划批/退、单选与批量提交、
 * 失败提示、空态与错误边界）。这里补它没走到的部分：卡头的档位与归属、通用理由的
 * 隐藏、空 scopes 的收窄、快捷键的 scope 守卫与 preventDefault、差异的增删状态与空 hunk、
 * 计划反馈为空/取消/已决/失败、批量翻页与缺题回跳、自由文本与 IME、折叠保留草稿、
 * 失败重试从断点续传、脏数据过滤。
 *
 * @module dsc-ui-prompt/ui/prompt-extra.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
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

type Handler = (args: unknown[]) => unknown

interface HarnessOptions {
  surfaces: Record<string, unknown>
  sessions?: unknown
  status?: Record<string, unknown>
  handlers?: Record<string, Handler>
}

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
}

function harnessOf(options: HarnessOptions): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const snapshot = {
    sessions: options.sessions ?? [],
    status: {
      cwd: 'C:/repo',
      sessionPath: 'C:/repo/current.jsonl',
      turnState: 'idle',
      ...options.status,
    },
    surfaces: options.surfaces,
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
      const handler = options.handlers?.[method]
      if (handler === undefined) return Promise.resolve({ ok: true }) as Promise<T>
      try {
        const value = handler(args)
        if (value instanceof Error) return Promise.reject(value) as Promise<T>
        return Promise.resolve(value) as Promise<T>
      } catch (error) {
        return Promise.reject(error) as Promise<T>
      }
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
const answersOf = (harness: Harness, method: string): unknown[] =>
  harness.calls.filter((call) => call.method === method).map((call) => call.args[0])

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('审批卡的卡头与归属', () => {
  test('档位名优先用宿主表；别的会话标注标题；通用理由不重复画', async () => {
    const harness = harnessOf({
      surfaces: {
        pendingApproval: approval({
          policy: 'auto-edit',
          reviewer: 'auto-review',
          mode: 'plan',
          reason: '需要授权',
          sessionPath: 'C:/repo/other.jsonl',
        }),
        policy: {
          current: 'auto-edit',
          options: [{ id: 'auto-edit', label: '工作区自动X', hint: '' }],
          reviewer: 'auto-review',
          reviewerOptions: [{ id: 'auto-review', label: 'AI 复核X', hint: '' }],
        },
        mode: { current: 'plan', options: [{ id: 'plan', label: '计划X', hint: '' }] },
      },
      sessions: [
        { id: 'C:/repo/other.jsonl', cwd: 'C:/repo', title: '后台任务', createdAt: 0, updatedAt: 0 },
      ],
    })
    const { container } = mount(harness)
    await flush()

    expect(container.querySelector('.approval')?.getAttribute('title')).toBe(
      '权限 工作区自动X · 审阅 AI 复核X · 模式 计划X',
    )
    expect(textOf(container.querySelector('.approval-owner'))).toContain('来自会话「后台任务」')
    // 「需要授权」是没有信息量的兜底，不再占一行。
    expect(container.querySelector('.approval-reason')).toBeNull()
  })

  test('宿主没给档位表时退回写死名；查不到标题标「后台会话」；同会话不标', async () => {
    const unknown = harnessOf({
      surfaces: {
        pendingApproval: approval({
          policy: 'auto-edit',
          reviewer: 'auto-review',
          mode: 'plan',
          sessionPath: 'C:/repo/missing.jsonl',
        }),
      },
    })
    const first = mount(unknown)
    await flush()
    expect(first.container.querySelector('.approval')?.getAttribute('title')).toBe(
      '权限 工作区自动 · 审阅 AI 复核 · 模式 计划',
    )
    expect(textOf(first.container.querySelector('.approval-owner'))).toContain('后台会话')

    cleanup()
    const same = harnessOf({
      surfaces: { pendingApproval: approval({ sessionPath: 'C:/repo/current.jsonl' }) },
    })
    const second = mount(same)
    await flush()
    expect(second.container.querySelector('.approval-owner')).toBeNull()
  })

  test('scopes 为空回退成「只给这一次」；快捷键按 scope 收窄，命中后拦住默认行为', async () => {
    const harness = harnessOf({ surfaces: { pendingApproval: approval({ scopes: [] }) } })
    const { container } = mount(harness)
    await flush()

    expect(container.querySelectorAll('.approval-actions button')).toHaveLength(2)

    const s = new KeyboardEvent('keydown', { key: 's', cancelable: true })
    window.dispatchEvent(s)
    const x = new KeyboardEvent('keydown', { key: 'x', cancelable: true })
    window.dispatchEvent(x)
    await flush()
    expect(harness.calls.some((call) => call.method === 'answerApproval')).toBe(false)
    expect(s.defaultPrevented).toBe(false)
    expect(x.defaultPrevented).toBe(false)

    const y = new KeyboardEvent('keydown', { key: 'y', cancelable: true })
    window.dispatchEvent(y)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'answerApproval', args: ['allow-once'] })
    expect(y.defaultPrevented).toBe(true)
  })

  test('Esc 真的按拒绝处理；焦点在可编辑区时不抢键', async () => {
    const harness = harnessOf({ surfaces: { pendingApproval: approval() } })
    mount(harness)
    await flush()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(escape)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'answerApproval', args: ['reject'] })
    expect(escape.defaultPrevented).toBe(true)

    cleanup()
    const editable = document.createElement('div')
    editable.tabIndex = 0
    Object.defineProperty(editable, 'isContentEditable', { configurable: true, value: true })
    document.body.append(editable)
    editable.focus()
    expect(document.activeElement).toBe(editable)

    const guarded = harnessOf({ surfaces: { pendingApproval: approval() } })
    mount(guarded)
    await flush()
    fireEvent.keyDown(window, { key: 'y' })
    await flush()
    expect(guarded.calls.some((call) => call.method === 'answerApproval')).toBe(false)
  })
})

describe('审批卡的差异区', () => {
  test('新增/删除各有状态词与徽标；空 hunk 展开说「不会有实际改动」；多处匹配给警告', async () => {
    const added = harnessOf({
      surfaces: {
        pendingApproval: approval({
          diff: {
            path: 'C:/repo/new.ts',
            status: 'added',
            added: 2,
            removed: 0,
            mismatch: 'ambiguous',
            hunks: [],
          },
        }),
      },
    })
    const first = mount(added)
    await flush()
    const firstHead = textOf(first.container.querySelector('.approval-diff-head'))
    expect(firstHead).toContain('将写入')
    expect(firstHead).toContain('新增')
    expect(textOf(first.container.querySelector('.tc-warn'))).toContain('匹配多处')
    fireEvent.click(first.container.querySelector('.approval-diff-toggle') as HTMLElement)
    expect(textOf(first.container.querySelector('.tc-intended-note'))).toContain('不会有实际改动')

    cleanup()
    const deleted = harnessOf({
      surfaces: {
        pendingApproval: approval({
          diff: { path: 'C:/repo/old.ts', status: 'deleted', added: 0, removed: 3, hunks: [] },
        }),
      },
    })
    const second = mount(deleted)
    await flush()
    const secondHead = textOf(second.container.querySelector('.approval-diff-head'))
    expect(secondHead).toContain('将删除')
    expect(secondHead).toContain('删除')
  })

  test('沙箱放宽的说明与理由都在场；会话级放宽多一句', async () => {
    const harness = harnessOf({
      surfaces: {
        pendingApproval: approval({
          escalation: { effect: '允许写工作区外', scope: 'session', justification: '要改系统配置' },
        }),
      },
    })
    const { container } = mount(harness)
    await flush()
    expect(container.querySelector('[data-approval-escalation]')).not.toBeNull()
    expect(textOf(container.querySelector('.approval-escalation-line'))).toContain('允许写工作区外')
    expect(textOf(container.querySelector('.approval-escalation-line'))).toContain('本会话一直放宽')
    expect(textOf(container.querySelector('.approval-escalation-why'))).toContain('要改系统配置')
  })
})

describe('计划卡的边界', () => {
  test('反馈留空只提交 rejected；点取消退回批准/还要改', async () => {
    const harness = harnessOf({ surfaces: { pendingPlan: PLAN } })
    const { container } = mount(harness)
    await flush()

    fireEvent.click(container.querySelectorAll('.plan-btn')[1] as HTMLElement)
    expect(container.querySelector('.plan-feedback')).not.toBeNull()
    fireEvent.click(container.querySelectorAll('.plan-btn')[0] as HTMLElement)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'answerPlan', args: ['rejected'] })

    cleanup()
    const cancelled = harnessOf({ surfaces: { pendingPlan: PLAN } })
    const second = mount(cancelled)
    await flush()
    fireEvent.click(second.container.querySelectorAll('.plan-btn')[1] as HTMLElement)
    fireEvent.click(second.container.querySelectorAll('.plan-btn')[1] as HTMLElement)
    expect(second.container.querySelector('.plan-feedback')).toBeNull()
    expect(textOf(second.container.querySelectorAll('.plan-btn')[0])).toContain('批准开工')
  })

  test('已决的计划不再给按钮；提交失败留在卡上并可重试', async () => {
    const settled = harnessOf({
      surfaces: { pendingPlan: { ...PLAN, decision: 'approved' } },
    })
    const first = mount(settled)
    await flush()
    expect(textOf(first.container.querySelector('.plan-verdict'))).toContain('已批准')
    expect(first.container.querySelectorAll('.plan-btn')).toHaveLength(0)

    cleanup()
    const failing = harnessOf({
      surfaces: { pendingPlan: PLAN },
      handlers: {
        answerPlan: () => {
          throw new Error('计划通道断了')
        },
      },
    })
    const second = mount(failing)
    await flush()
    fireEvent.click(second.container.querySelectorAll('.plan-btn')[0] as HTMLElement)
    await flush()
    expect(textOf(second.container.querySelector('.shell-composer-fault'))).toContain('计划通道断了')
    expect((second.container.querySelectorAll('.plan-btn')[0] as HTMLButtonElement).disabled).toBe(false)
  })

  test('长计划正文原样渲染，不截断', async () => {
    const longText = `# 长计划\n${'步骤内容。'.repeat(2_000)}`
    const harness = harnessOf({ surfaces: { pendingPlan: { ...PLAN, text: longText } } })
    const { container } = mount(harness)
    await flush()
    expect(textOf(container.querySelector('.plan-body'))).toBe(longText)
  })
})

describe('提问卡的批量与焦点', () => {
  const THREE = {
    id: 'q3',
    question: '第一题',
    options: [{ label: '一' }],
    multiSelect: false,
    allowFreeText: false,
    questions: [
      { question: '第一题', options: [{ label: '一' }], multiSelect: false, allowFreeText: false },
      { question: '第二题', options: [{ label: '二' }], multiSelect: false, allowFreeText: false },
      { question: '第三题', options: [{ label: '三' }], multiSelect: false, allowFreeText: false },
    ],
  }

  test('翻页器前后移动；最后一题提交时缺题会跳回并提示，补齐后按序提交', async () => {
    const harness = harnessOf({ surfaces: { pendingQuestion: THREE } })
    const { container } = mount(harness)
    await flush()

    expect(textOf(container.querySelector('.ask-progress'))).toBe('1/3')
    expect((container.querySelector('[data-ask-page="prev"]') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(container.querySelector('[data-ask-page="next"]') as HTMLElement)
    expect(textOf(container.querySelector('.ask-progress'))).toBe('2/3')
    fireEvent.click(container.querySelector('[data-ask-page="next"]') as HTMLElement)
    expect(textOf(container.querySelector('.ask-progress'))).toBe('3/3')
    expect((container.querySelector('[data-ask-page="next"]') as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('.ask-panel')?.getAttribute('data-ask-index')).toBe('2')

    // 只答最后一题就提交：前两题缺答，焦点跳回第一题。
    fireEvent.click(container.querySelector('.ask-option') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-submit') as HTMLElement)
    await flush()
    expect(textOf(container.querySelector('.ask-hint'))).toContain('还有题目没答')
    expect(container.querySelector('.ask-panel')?.getAttribute('data-ask-index')).toBe('0')
    expect(harness.calls.some((call) => call.method === 'answerQuestion')).toBe(false)

    // 补齐前两题（单选自动前进），再提交最后一题：三题按序交回。
    fireEvent.click(container.querySelector('.ask-option') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-option') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-submit') as HTMLElement)
    await flush()
    expect(answersOf(harness, 'answerQuestion')).toEqual(['一', '二', '三'])
  })

  test('自由文本：单选写字顶掉已选，多选保留已选；回车走主按钮，输入法回车不算', async () => {
    const single = harnessOf({ surfaces: { pendingQuestion: QUESTION } })
    const first = mount(single)
    await flush()
    fireEvent.click(first.container.querySelectorAll('.ask-option')[0] as HTMLElement)
    expect(first.container.querySelector('.ask-option.picked')).not.toBeNull()
    const input = first.container.querySelector('.ask-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '自己写' } })
    expect(first.container.querySelector('.ask-option.picked')).toBeNull()

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    await flush()
    expect(single.calls.some((call) => call.method === 'answerQuestion')).toBe(false)

    fireEvent.keyDown(input, { key: 'Enter' })
    await flush()
    expect(answersOf(single, 'answerQuestion')).toEqual(['自己写'])

    cleanup()
    const multi = harnessOf({
      surfaces: {
        pendingQuestion: {
          ...QUESTION,
          multiSelect: true,
          options: [{ label: '甲' }, { label: '乙' }],
        },
      },
    })
    const second = mount(multi)
    await flush()
    fireEvent.click(second.container.querySelectorAll('.ask-option')[0] as HTMLElement)
    const multiInput = second.container.querySelector('.ask-input') as HTMLInputElement
    fireEvent.change(multiInput, { target: { value: '补充说明' } })
    // 多选下自由文本不顶掉已选项。
    expect(second.container.querySelector('.ask-option.picked')).not.toBeNull()
    fireEvent.click(second.container.querySelector('.ask-submit') as HTMLElement)
    await flush()
    expect(answersOf(multi, 'answerQuestion')).toEqual(['补充说明'])
  })

  test('折叠只收面板：草稿、焦点与展开状态都留着', async () => {
    const harness = harnessOf({
      surfaces: {
        pendingQuestion: {
          id: 'q1',
          question: '备注？',
          options: [],
          multiSelect: false,
          allowFreeText: true,
        },
      },
    })
    const { container } = mount(harness)
    await flush()
    const input = container.querySelector('.ask-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '还没交的草稿' } })

    fireEvent.click(container.querySelector('.ask-fold') as HTMLElement)
    expect(container.querySelector('.ask-card')?.getAttribute('data-open')).toBe('false')
    expect(container.querySelector('.ask-panel')?.hasAttribute('hidden')).toBe(true)

    fireEvent.click(container.querySelector('.ask-fold') as HTMLElement)
    expect(container.querySelector('.ask-card')?.getAttribute('data-open')).toBe('true')
    expect((container.querySelector('.ask-input') as HTMLInputElement).value).toBe('还没交的草稿')
  })

  test('逐题提交中途失败：重试从断点续传，不重交已经收下的题', async () => {
    let calls = 0
    const harness = harnessOf({
      surfaces: { pendingQuestion: THREE },
      handlers: {
        answerQuestion: () => {
          calls += 1
          if (calls === 2) throw new Error('第二次断了')
          return { ok: true }
        },
      },
    })
    const { container } = mount(harness)
    await flush()

    fireEvent.click(container.querySelector('.ask-option') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-option') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-option') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-submit') as HTMLElement)
    await flush()
    expect(textOf(container.querySelector('.shell-composer-fault'))).toContain('第二次断了')
    expect(answersOf(harness, 'answerQuestion')).toEqual(['一', '二'])

    // 断点在第二题：重试只从第二题接着交，第一题不会再交一次。
    fireEvent.click(container.querySelector('.ask-submit') as HTMLElement)
    await flush()
    expect(answersOf(harness, 'answerQuestion')).toEqual(['一', '二', '二', '三'])
  })

  test('脏数据：题目为空/选项没有 label 的条目被丢掉；整批都无效时什么都不画', async () => {
    const dirty = harnessOf({
      surfaces: {
        pendingQuestion: {
          id: 'q1',
          question: '',
          options: [],
          multiSelect: false,
          allowFreeText: true,
          questions: [
            { question: '   ', options: [] },
            { question: '有效题', options: [{ label: '甲' }, { label: '' }], allowFreeText: false },
            { question: '   ', options: {}, allowFreeText: false },
          ],
        },
      },
    })
    const first = mount(dirty)
    await flush()
    expect(first.container.querySelector('.ask-card')?.getAttribute('data-ask-count')).toBe('1')
    expect(textOf(first.container.querySelector('.ask-text'))).toContain('有效题')
    expect(first.container.querySelectorAll('.ask-option')).toHaveLength(1)

    cleanup()
    const empty = harnessOf({
      surfaces: {
        pendingQuestion: { id: 'q2', question: '   ', options: [], multiSelect: false, allowFreeText: true },
      },
    })
    const second = mount(empty)
    await flush()
    expect(second.container.innerHTML).toBe('')
  })
})
