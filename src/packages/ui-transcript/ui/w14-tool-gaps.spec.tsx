/**
 * 工具卡装配层（`tool-card/factory.tsx`）第四批补测：W14 剩余的几个独立出口。
 *
 * 已有 `tool-card/factory.spec` 铺过装配主干（五张专用卡、轨迹页、路径挡冒泡、空名字）与
 * `w11-branches.spec` 铺过内置卡槽装配。这一份只补它们没点到的几处行为：
 *
 * - `fileTargetOf` 参数不是合法 JSON / 不是文件类工具时的回落（认不出就 null，不抛）；
 * - 通用卡展开后点「展开更多」：余下原文摊开、按钮 aria 翻面；
 * - `IntendedPreview` 的路径按钮在按键冒泡上挡一层（Enter/Space 不会把卡折了）；
 * - `IntendedBody` 的「将做的改动」三态（有 diff + 回退提示 / 内容一致 / 落地后由真实改动接手）；
 * - `TraceJumpButton` 点一下带条目 id 切轨迹、按键冒泡同样被挡住。
 *
 * @module dsc-ui-transcript/ui/w14-tool-gaps.spec
 */
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ChangedFileView, ToolCallView } from '@dsc/ui'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { ToolEntry } from './shared.js'
import type { IntendedDiff } from './intended-diff.js'
import { IntendedBody, IntendedPreview, ToolCardView, TraceJumpButton, fileTargetOf } from './tool-card/factory.js'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub as unknown as typeof ResizeObserver)
})

afterEach(() => {
  cleanup()
})

/** 假宿主通道：这批组件不 invoke，只接住 RuntimeProvider 的 context。 */
function fakeChannel(): HostChannel {
  const noop = (): void => undefined
  return {
    getSnapshot: () => null,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => noop,
    onAsk: () => noop,
    subscribe: () => noop,
    invoke: <T,>() => Promise.resolve(null as T),
    reconnect: noop,
    close: noop,
  }
}

const wrap = (node: Parameters<typeof render>[0]): ReturnType<typeof render> =>
  render(<RuntimeProvider channel={fakeChannel()}>{node}</RuntimeProvider>)

const entryOf = (call: Partial<ToolCallView> & Pick<ToolCallView, 'name' | 'argsText'>): ToolEntry => ({
  kind: 'tool',
  id: 7,
  call: { callId: 'c7', status: 'done', ...call },
})

/** 一份最小改动视图（字段形状照 `ChangedFileView`；hunks 内容这部分用例不读）。 */
const changeOf = (over: Partial<ChangedFileView> = {}): ChangedFileView =>
  ({
    path: 'src/a.ts',
    added: 2,
    removed: 1,
    hunks: [],
    status: 'modified',
    ...over,
  }) as ChangedFileView

const intendedOf = (over: Partial<IntendedDiff> = {}): IntendedDiff => ({
  absPath: 'D:/work/src/a.ts',
  file: changeOf(),
  fellBack: false,
  ...over,
})

describe('fileTargetOf：认不出目标文件就 null', () => {
  test('参数不是合法 JSON：catch 之后给 null，不抛', () => {
    expect(fileTargetOf('read', '{不是 json', 'D:/work')).toBeNull()
    expect(fileTargetOf('edit', '', 'D:/work')).toBeNull()
  })

  test('不是文件类工具 / 参数里没有路径：同样给 null；有路径就拼绝对路径', () => {
    expect(fileTargetOf('bash', JSON.stringify({ path: 'a.ts' }), 'D:/work')).toBeNull()
    expect(fileTargetOf('read', JSON.stringify({ other: 1 }), 'D:/work')).toBeNull()
    expect(fileTargetOf('read', JSON.stringify({ path: 'a.ts' }), 'D:/work')).toBe('D:/work/a.ts')
  })
})

describe('通用卡的「展开更多」', () => {
  test('展开后点一下：余下原文摊出来，按钮 aria 翻成已展开', () => {
    const entry = entryOf({
      name: 'mcp_unknown',
      argsText: '{"k":"v"}',
      resultText: '第一行\n第二行\n第三行',
    })
    const view = render(
      <RuntimeProvider channel={fakeChannel()}>
        <ToolCardView entry={entry} variant="chat" />
      </RuntimeProvider>,
    )
    fireEvent.click(view.container.querySelector('.tool-click') as HTMLElement)
    const more = view.container.querySelector('.tc-result-more') as HTMLButtonElement | null
    if (more === null) throw new Error('展开体里没有「展开更多」按钮')
    expect(view.container.querySelector('.tc-result-rest')).toBeNull()
    fireEvent.click(more)
    expect(view.container.querySelector('.tc-result-rest')?.textContent).toContain('第二行')
    expect(view.container.querySelector('.tc-result-more')?.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('IntendedPreview：路径按钮在按键冒泡上挡一层', () => {
  test('Enter / Space 键不会冒泡到卡外层（外层处理函数收不到）', () => {
    const onKeyDown = vi.fn()
    const { container } = wrap(
      <div onKeyDown={onKeyDown}>
        <IntendedPreview intended={intendedOf()} summary="摘要" cwd="D:/work" targetPath="D:/work/src/a.ts" change={null} />
      </div>,
    )
    const path = container.querySelector('.tc-path') as HTMLElement | null
    if (path === null) throw new Error('摘要区没有路径按钮')
    fireEvent.keyDown(path, { key: 'Enter' })
    fireEvent.keyDown(path, { key: ' ' })
    expect(onKeyDown).not.toHaveBeenCalled()
  })
})

describe('IntendedBody：将做的改动的三态', () => {
  test('有 diff：标题 + 回退与不匹配两条提示都上屏', () => {
    const { container } = render(<IntendedBody intended={intendedOf({ fellBack: true, mismatch: 'missing' })} change={null} />)
    expect(container.querySelector('.tc-intended-title')).not.toBeNull()
    expect(container.querySelectorAll('.tc-warn').length).toBe(2)
    expect(container.querySelector('.tc-intended-diff')).not.toBeNull()
  })

  test('推演内容与盘上一致（file 为 null）：画一句「没有改动」的说明', () => {
    const { container } = render(<IntendedBody intended={intendedOf({ file: null })} change={null} />)
    expect(container.querySelector('.tc-intended-note')).not.toBeNull()
    expect(container.querySelector('.tc-intended-diff')).toBeNull()
  })

  test('落地后 intended 为空：由真实改动接手', () => {
    const { container } = render(<IntendedBody intended={null} change={changeOf()} />)
    expect(container.querySelector('.tc-intended')).not.toBeNull()
    expect(container.querySelector('.tc-intended-diff')).not.toBeNull()
  })
})

describe('TraceJumpButton：切轨迹与按键冒泡', () => {
  test('点一下带上条目 id；Enter 冒泡被挡住', () => {
    const entry = entryOf({ name: 'bash', argsText: '{"command":"ls"}' })
    const onClick = vi.fn()
    const onKeyDown = vi.fn()
    const { container } = wrap(
      <div onClick={onClick} onKeyDown={onKeyDown}>
        <TraceJumpButton entry={entry} />
      </div>,
    )
    const button = container.querySelector('.tc-trace') as HTMLButtonElement | null
    if (button === null) throw new Error('没有画「在轨迹中查看」')
    expect(button.getAttribute('data-trace-jump')).toBe('7')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(onKeyDown).not.toHaveBeenCalled()
  })
})
