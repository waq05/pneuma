/**
 * 工具卡共享骨架（`tool-card/factory.tsx` 的 ToolCardView）的渲染段（ui 层，真渲染）。
 *
 * 来源（缺口清单 B33 / B34，都是「必须真渲染组件」才留守的那些）：
 * - `scripts/ui-transcript-render-test.mjs` 第 [3]④（diff / 参数表分流、dsh diff 卡并进
 *   展开体）与第 [8]（收起态只留头行、「+N 行」读数）；
 * - `scripts/ui-tool-row-flat-test.mjs` 第 [3][4]（点击与键盘只在 `.tool-click` 上、
 *   done 只留绿点）——其中键盘一条原探针是把 onKeyDown 函数体抠出来 `new Function`
 *   跑，这里改成 `fireEvent.keyDown` 真触发，连 `preventDefault` 一起在真实事件上验；
 * - `scripts/ui-fold-prefs-test.mjs` 第 [5] 工具卡半（默认展开跟随设置、手动存档优先、
 *   preparing 不可展开）；
 * - `scripts/ui-step-group-live-test.mjs` 第 [7] 渲染侧（PTC 卡内调用的标记与清单画在
 *   共享骨架里）。
 *
 * 原探针里 `.tool-card` / `.tool-head` 的 CSS 规则体、行高行距令牌（ui-tool-row-flat
 * 的 [1][2][5][6]）是样式表文本钉——jsdom 不应用样式表，渲染层没有那个行为接缝，
 * 不迁（缺口清单记为「转 shots 或留探针」）。
 *
 * @module dsc-ui-transcript/ui/tool-card-view.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ReactElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { ToolEntry } from './shared.js'
import { FOLD_PREFS, FoldPrefsContext, type FoldPrefs } from './shared.js'
import { clearFold, writeFold } from './fold-state.js'
import { IntendedPreview, ToolCardView } from './tool-card/factory.js'

/**
 * 测试替身宿主通道。ToolCardView 的「将做的改动」hook 无条件拿通道（running 期才用它），
 * 这层测试不触那条路：invoke 永不发生，快照恒 null。
 */
const stubChannel = (): HostChannel => ({
  getSnapshot: () => null,
  getHello: () => null,
  getStatus: () => 'closed',
  getHostError: () => null,
  getPluginsFrame: () => null,
  onPlugins: () => () => undefined,
  onAsk: () => () => undefined,
  subscribe: () => () => undefined,
  invoke: () => Promise.reject(new Error('测试不触发宿主调用')),
  reconnect: () => undefined,
  close: () => undefined,
})

/** ToolCardView 展开时会 new ResizeObserver（jsdom 没有）：量高逻辑在这层测试里不重要，给个空桩。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

/** 渲染工具卡：统一包上 RuntimeProvider（intended hook 的依赖，本测试不触发它的读取）。 */
const renderCard = (ui: ReactElement): ReturnType<typeof render> =>
  render(<RuntimeProvider channel={stubChannel()}>{ui}</RuntimeProvider>)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

let seq = 0
/** 造一条工具条目（字段够 ToolCardView 用；其余靠缺省）。 */
const toolEntry = (call: Partial<ToolEntry['call']> & { name: string }): ToolEntry =>
  ({
    kind: 'tool',
    id: (seq += 1),
    call: { callId: `c${String(seq)}`, argsText: '{}', status: 'done', ...call },
  }) as ToolEntry

/** 测试用的折叠偏好：出厂口径上只改指定的两格。 */
const prefsOf = (over: Partial<FoldPrefs> = {}): FoldPrefs => ({ ...FOLD_PREFS, ...over })

/** 展开 / 收起的判定：骨架根节点带 `open` 类、展开体 `.tool-body` 在不在。 */
const bodyOf = (container: HTMLElement): HTMLElement | null => container.querySelector('.tool-body')

describe('diff / 参数表分流（B33 [3]④）', () => {
  test('会改文件的工具落地后有 diff：正文走 diff 块，参数表只列其余字段（content 剔除）', () => {
    const entry = toolEntry({
      name: 'write',
      argsText: JSON.stringify({ path: 'a.md', justification: '因为', content: '# 标题\n正文' }),
      change: { path: 'a.md', added: 2, removed: 0, hunks: [], status: 'added' },
    })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    // 正文不摊 JSON：content 既不在字段表里，也不在原始参数块里。
    const fields = container.querySelector('.args.arg-fields')
    expect(fields).toBeTruthy()
    const keys = [...(fields as HTMLElement).querySelectorAll('.arg-key')].map((el) => el.textContent)
    expect(keys).toEqual(['path', 'justification'])
    // 落地后的 diff 由 bodyExtra 的 fallback（IntendedBody 的 change 分支）接手。
    expect(container.querySelector('[data-tc-change]')).toBeTruthy()
    // 原始 JSON 那条路不出现（有了 diff 就不再摊整段参数）。
    expect(container.querySelector('.args:not(.arg-fields)')).toBeNull()
  })

  test('没有 diff 时仍摊原始 JSON（信息不丢）；普通工具不走字段表', () => {
    // 原始参数 JSON 在轨迹页（取证面）；对话页对没有 diff 的工具摊的是「一行一字段」表。
    const entry = toolEntry({ name: 'foo_tool', argsText: JSON.stringify({ command: 'ls -la' }) })
    const { container } = renderCard(<ToolCardView entry={entry} variant="trace" />)
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    const plain = container.querySelector('.args:not(.arg-fields)')
    expect(plain).toBeTruthy()
    expect((plain as HTMLElement).textContent).toContain('ls -la')
    // 对话页同一张卡：参数摊成字段表，不摊整段 JSON。
    const chat = renderCard(<ToolCardView entry={entry} />)
    fireEvent.click(chat.container.querySelector('.tool-click') as HTMLElement)
    const fields = chat.container.querySelector('[data-tc-detail-fields]')
    expect(fields).toBeTruthy()
    expect((fields as HTMLElement).textContent).toContain('command')
    expect((chat.container.querySelector('.args:not(.arg-fields)') as HTMLElement | null)).toBeNull()
  })

  test('dsh 的 diff 卡片（presentation.result.card === "diff"）并进展开体同一个入口', () => {
    const entry = toolEntry({
      name: 'dsh_write',
      argsText: '{}',
      presentation: {
        result: {
          card: 'diff',
          diffs: [{ path: 'x.ts', oldText: '旧', newText: '新\n新二' }],
        },
      },
    })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    expect(container.querySelector('[data-tc-change]')).toBeTruthy()
  })
})

describe('收起 / 展开的结果面（B33 [8]）', () => {
  test('收起态只留头行：不摊结果尾巴，被截断的行数写在「+N 行」读数里', () => {
    const entry = toolEntry({ name: 'bash', argsText: '{"command":"ls"}', resultText: 'a\nb\nc\nd\ne\nf' })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    expect(bodyOf(container)).toBeNull()
    // 「+N 行」在头行上（.tool-click 之外，它是读数不是开关）。
    const more = container.querySelector('.tc-more')
    expect(more).toBeTruthy()
    expect((more as HTMLElement).textContent).toMatch(/6/)
    // 旧的结果尾巴不再渲染（0.6.x 撤掉的三行预览）。
    expect(container.querySelector('.tool-tail')).toBeNull()
  })

  test('展开态摊首行 + 「展开更多」，不再重复摊收起读数（通用卡，非终端块）', () => {
    const entry = toolEntry({ name: 'foo_tool', argsText: '{}', resultText: '首行输出\n第二行\n第三行' })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    expect(container.querySelector('.tc-result-first')?.textContent).toBe('首行输出')
    expect(container.querySelector('.tc-result-more')).toBeTruthy()
    expect(container.querySelector('.tc-more')).toBeNull()
  })
})

describe('点击与键盘只在 .tool-click 上（ui-tool-row-flat [3]）', () => {
  test('文字段带 role=button / tabIndex / aria-expanded；行尾读数与箭头留在文字段外', () => {
    const entry = toolEntry({ name: 'bash', argsText: '{"command":"ls"}', resultText: 'a\nb\nc' })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    const click = container.querySelector('.tool-click') as HTMLElement
    expect(click.getAttribute('role')).toBe('button')
    expect(click.getAttribute('tabindex')).toBe('0')
    expect(click.getAttribute('aria-expanded')).toBe('false')
    // 开关/读数各归各位：tc-more、状态列、箭头都不是 .tool-click 的子孙。
    expect(click.querySelector('.tc-more')).toBeNull()
    expect(click.querySelector('.status')).toBeNull()
    expect(click.querySelector('.tc-chevron')).toBeNull()
    expect(container.querySelector('.tool-head .tc-chevron')).toBeTruthy()
  })

  test('点一下展开、再点收起（aria-expanded 跟着翻）', () => {
    const entry = toolEntry({ name: 'bash', argsText: '{"command":"ls"}' })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    const click = container.querySelector('.tool-click') as HTMLElement
    fireEvent.click(click)
    expect(bodyOf(container)).toBeTruthy()
    expect(click.getAttribute('aria-expanded')).toBe('true')
    expect((container.querySelector('.entry.tool-card') as HTMLElement).classList.contains('open')).toBe(true)
    fireEvent.click(click)
    expect(bodyOf(container)).toBeNull()
    expect(click.getAttribute('aria-expanded')).toBe('false')
  })

  test('键盘 Enter / Space 各触发一次开合并 preventDefault；其他键不动', () => {
    const entry = toolEntry({ name: 'bash', argsText: '{"command":"ls"}' })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    const click = container.querySelector('.tool-click') as HTMLElement
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      click.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(bodyOf(container)).toBeNull() // Enter 展开又被 Space 收回，净效果零——中间各开合一次
    const stranger = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    click.dispatchEvent(stranger)
    expect(stranger.defaultPrevented).toBe(false)
    expect(bodyOf(container)).toBeNull()
  })

  test('参数没到齐（preparing）不可展开：没有 button 语义、点了也不出展开体', () => {
    const entry = toolEntry({ name: 'bash', argsText: '', status: 'preparing' })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    const click = container.querySelector('.tool-click') as HTMLElement
    expect(click.hasAttribute('role')).toBe(false)
    expect(click.getAttribute('tabindex')).toBe('-1')
    expect(container.querySelector('.tc-chevron')).toBeNull()
    fireEvent.click(click)
    expect(bodyOf(container)).toBeNull()
  })

  test('路径按钮点击不把卡折掉（stopPropagation 还在）', () => {
    const entry = toolEntry({ name: 'read', argsText: JSON.stringify({ path: 'a.ts' }) })
    const { container } = renderCard(
      <FoldPrefsContext.Provider value={prefsOf()}>
        <ToolCardView entry={entry} cwd="D:/demo" Preview={IntendedPreview} />
      </FoldPrefsContext.Provider>,
    )
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    // read 卡摘要区画可点路径；点它不该触发整行开合（收起）。
    const path = container.querySelector('.tool-head button')
    expect(path).toBeTruthy()
    fireEvent.click(path as HTMLElement)
    expect(bodyOf(container)).toBeTruthy()
  })
})

describe('成功态只留绿点（ui-tool-row-flat [4]）', () => {
  test('done 不输出状态词、也不拼用时；失败 / 进行中照旧给词', () => {
    const done = toolEntry({ name: 'bash', argsText: '{}', status: 'done', durationMs: 4200 })
    const { container, rerender } = renderCard(<ToolCardView entry={done} />)
    const status = () => ((container.querySelector('.tool-head .status') as HTMLElement).textContent ?? '')
    expect(status()).toBe('')
    rerender(<RuntimeProvider channel={stubChannel()}><ToolCardView entry={toolEntry({ name: 'bash', argsText: '{}', status: 'failed' })} /></RuntimeProvider>)
    expect(status()).not.toBe('')
    rerender(<RuntimeProvider channel={stubChannel()}><ToolCardView entry={toolEntry({ name: 'bash', argsText: '{}', status: 'running', durationMs: 800 })} /></RuntimeProvider>)
    expect(status()).not.toBe('')
  })
})

describe('PTC 卡内调用（ui-step-group-live [7] 渲染侧）', () => {
  test('卡内调用的标记在头行、清单在展开体，都只画这一份', () => {
    const entry = toolEntry({
      name: 'run_code',
      argsText: '{}',
      status: 'done',
      resultText: 'done',
      subCalls: [
        { callId: 'c1', name: 'grep', argsText: '{"pattern":"x"}', status: 'done' },
        { callId: 'c2', name: 'bash', argsText: '{"command":"ls"}', status: 'failed' },
      ],
    })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    const head = container.querySelector('.tool-head') as HTMLElement
    expect(head.querySelector('.sub-call-count')?.textContent).toMatch(/2/)
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    const list = container.querySelector('.sub-calls')
    expect(list).toBeTruthy()
    expect((list as HTMLElement).querySelectorAll('.sub-call').length).toBe(2)
  })

  test('没有子调用时两样都不画', () => {
    const entry = toolEntry({ name: 'bash', argsText: '{"command":"ls"}', status: 'done' })
    const { container } = renderCard(<ToolCardView entry={entry} />)
    expect(container.querySelector('.sub-call-count')).toBeNull()
    expect(container.querySelector('.sub-calls')).toBeNull()
  })
})

describe('默认展开跟随设置、手动存档优先（ui-fold-prefs [5] 工具卡半）', () => {
  const KEY = 'tcspec:default-open'

  afterEach(() => {
    clearFold(KEY)
  })

  test('toolOpen=true 的设置下新卡默认摊开，false 时收起（同一实例 rerender 跟着翻）', () => {
    const entry = toolEntry({ name: 'bash', argsText: '{"command":"ls"}' })
    const { container, rerender } = renderCard(<ToolCardView entry={entry} foldPrefs={prefsOf({ toolOpen: true })} />)
    expect(bodyOf(container)).toBeTruthy()
    // 设置翻回 false：没有手动存档的卡跟着收（老行不跟随的报障就是这里断的）。
    rerender(
      <RuntimeProvider channel={stubChannel()}>
        <ToolCardView entry={entry} foldPrefs={prefsOf({ toolOpen: false })} />
      </RuntimeProvider>,
    )
    expect(bodyOf(container)).toBeNull()
  })

  test('用户手动调过的卡有存档：设置怎么翻都不动它，点击把选择写进存档', () => {
    const entry = toolEntry({ name: 'bash', argsText: '{"command":"ls"}' })
    writeFold(KEY, true) // 手动点开过的存档
    const { container, rerender } = renderCard(
      <ToolCardView entry={entry} storeKey={KEY} foldPrefs={prefsOf({ toolOpen: false })} />,
    )
    // 设置说收起，存档说展开：存档赢。
    expect(bodyOf(container)).toBeTruthy()
    // 点击收起：写进存档（从此这一张卡算「手动调过」），设置翻到 true 也翻不动。
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    expect(bodyOf(container)).toBeNull()
    rerender(
      <RuntimeProvider channel={stubChannel()}>
        <ToolCardView entry={entry} storeKey={KEY} foldPrefs={prefsOf({ toolOpen: true })} />
      </RuntimeProvider>,
    )
    expect(bodyOf(container)).toBeNull()
  })

  test('没给存档键的卡（轨迹页那种）：展开态只活在本次挂载里', () => {
    const entry = toolEntry({ name: 'bash', argsText: '{"command":"ls"}' })
    const { container, unmount } = renderCard(<ToolCardView entry={entry} foldPrefs={prefsOf({ toolOpen: false })} />)
    fireEvent.click(container.querySelector('.tool-click') as HTMLElement)
    expect(bodyOf(container)).toBeTruthy()
    unmount()
    const again = renderCard(<ToolCardView entry={entry} foldPrefs={prefsOf({ toolOpen: false })} />)
    expect(bodyOf(again.container)).toBeNull()
  })
})
