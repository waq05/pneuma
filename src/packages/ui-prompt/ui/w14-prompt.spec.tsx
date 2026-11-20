/**
 * `ui-prompt` 的补盲：内容比较的「非空且不同」分支、跨工作区路径显示，以及三张卡里
 * 几颗按钮的实际落点。
 *
 * 缺口逐条：
 *   - `ui.tsx:167-168`：宿主推来新一帧且与上一帧内容不同时，`sameContent` 走真比较
 *     （既有用例的快照对象恒等，永远停在 `previous === next` 那一支）；
 *   - `ui.tsx:225`：文件路径不在会话 cwd 下时原样显示（不做相对化）；
 *   - `ui.tsx:591`：审批卡「拒绝」钮（不是快捷键，是那颗 danger 按钮）；
 *   - `ui.tsx:892`：多选再次点同一项 = 取消勾选；
 *   - `ui.tsx:947-948` / `958-960`：不是最后一题时「继续」「跳过」只推进焦点、清提示；
 *   - `ui.tsx:1066-1067`：问题翻页器的「上一题」。
 *
 * 装载方式与 `prompt-extra.spec.tsx` 相同（照壳收下 `shell.composer` 的登记）；
 * 这一份的假通道多了 `subscribe`/`emit`，用来推「新一帧」。
 *
 * @module dsc-ui-prompt/ui/w14-prompt
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
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

function approval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

interface Harness {
  channel: HostChannel
  calls: Array<{ method: string; args: unknown[] }>
  /** 换一份 surfaces 并通知订阅者（模拟宿主推新一帧）。 */
  push(surfaces: Record<string, unknown>): void
}

function harnessOf(surfaces: Record<string, unknown>): Harness {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const listeners = new Set<() => void>()
  let current = surfaces
  const snapshot = {
    sessions: [],
    status: { cwd: 'C:/repo', sessionPath: 'C:/repo/current.jsonl', turnState: 'idle' },
    get surfaces(): Record<string, unknown> {
      return current
    },
  } as unknown as HostSnapshot
  const channel: HostChannel = {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    invoke: (<T,>(method: string, args: unknown[] = []): Promise<T> => {
      calls.push({ method, args })
      return Promise.resolve({ ok: true } as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
  return {
    channel,
    calls,
    push(next) {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
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

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('内容比较与路径显示', () => {
  test('宿主推来内容不同的新一帧：卡片跟着换，不整块退回空', async () => {
    const harness = harnessOf({ pendingApproval: approval({ id: 'a1', meaning: '第一件事' }) })
    const { container } = mount(harness)
    await flush()
    expect(container.textContent).toContain('第一件事')

    act(() => {
      harness.push({ pendingApproval: approval({ id: 'a2', meaning: '第二件事' }) })
    })
    expect(container.textContent).toContain('第二件事')
  })

  test('文件不在会话 cwd 下：路径原样显示，不做相对化', async () => {
    const harness = harnessOf({
      pendingApproval: approval({
        diff: { path: 'D:/other/a.ts', status: 'modified', added: 1, removed: 0, hunks: [] },
      }),
    })
    const { container } = mount(harness)
    await flush()
    expect(textOf(container.querySelector('.approval-diff-path'))).toContain('D:/other/a.ts')
  })
})

describe('审批卡的拒绝钮', () => {
  test('点「拒绝」把 reject 交给宿主', async () => {
    const harness = harnessOf({ pendingApproval: approval() })
    const { container } = mount(harness)
    await flush()
    const reject = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('拒绝'),
    ) as HTMLButtonElement
    expect(reject).toBeDefined()
    fireEvent.click(reject)
    await flush()
    expect(harness.calls).toContainEqual({ method: 'answerApproval', args: ['reject'] })
  })
})

describe('提问卡的多选与推进', () => {
  test('多选再点同一项 = 取消勾选', async () => {
    const harness = harnessOf({
      pendingQuestion: {
        id: 'q1',
        question: '选哪些？',
        options: [{ label: '甲' }, { label: '乙' }],
        multiSelect: true,
        allowFreeText: false,
      },
    })
    const { container } = mount(harness)
    await flush()
    const first = container.querySelector('.ask-option') as HTMLElement
    fireEvent.click(first)
    expect(container.querySelector('.ask-option.picked')).not.toBeNull()
    fireEvent.click(first)
    expect(container.querySelector('.ask-option.picked')).toBeNull()
  })

  test('不是最后一题时「继续」与「跳过」只推进焦点，不提交', async () => {
    // 多选不会「选中即前进」，才能停在某一题上点「继续」/「跳过」。
    const multi = {
      ...THREE,
      questions: THREE.questions.map((item) => ({ ...item, multiSelect: true })),
    }
    const harness = harnessOf({ pendingQuestion: multi })
    const { container } = mount(harness)
    await flush()
    expect(textOf(container.querySelector('.ask-progress'))).toBe('1/3')

    fireEvent.click(container.querySelector('.ask-option') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-submit') as HTMLElement)
    expect(textOf(container.querySelector('.ask-progress'))).toBe('2/3')
    expect(container.querySelector('.ask-panel')?.getAttribute('data-ask-index')).toBe('1')

    fireEvent.click(container.querySelector('.ask-skip') as HTMLElement)
    expect(textOf(container.querySelector('.ask-progress'))).toBe('3/3')
    expect(harness.calls.some((call) => call.method === 'answerQuestion')).toBe(false)
  })

  test('最后一题点「跳过」直接整批提交；翻页器「上一题」回退', async () => {
    const harness = harnessOf({ pendingQuestion: THREE })
    const { container } = mount(harness)
    await flush()
    fireEvent.click(container.querySelector('[data-ask-page="next"]') as HTMLElement)
    expect(textOf(container.querySelector('.ask-progress'))).toBe('2/3')
    fireEvent.click(container.querySelector('[data-ask-page="prev"]') as HTMLElement)
    expect(textOf(container.querySelector('.ask-progress'))).toBe('1/3')

    fireEvent.click(container.querySelector('.ask-skip') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-skip') as HTMLElement)
    fireEvent.click(container.querySelector('.ask-skip') as HTMLElement)
    await flush()
    expect(harness.calls.filter((call) => call.method === 'answerQuestion')).toHaveLength(3)
  })
})
