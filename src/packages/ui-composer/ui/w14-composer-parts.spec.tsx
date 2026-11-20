/**
 * `ui-composer` 的零碎补盲（不碰输入区主组件，那些在 `w14-composer-box.spec.tsx`）。
 *
 * 缺口逐条：
 *
 *   - `effort-slider.tsx`：指针拖动（按下 → 移动换档 → 松手落盘）与释放指针捕获；
 *   - `attachments.ts`：视频抽帧里 seek 超时那一支（超时按「这一帧不要」，不抛错）；
 *   - `queue-dock.tsx`：编辑态的两颗钮——保存（点钮保存，不只是回车）与取消；
 *   - `mention.ts`：单个目录列举失败只跳过这一层、路径命中（非文件名命中）的候选、
 *     `listWorkspaceFiles` 抛错时把加载态收掉（不把面板挂在「正在读取」上）。
 *
 * 这些都不需要整棵输入区：组件/函数本身导出就能驱动，`@` 面板用 `renderHook` 直接驱动。
 *
 * @module dsc-ui-composer/ui/w14-composer-parts.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { HostSnapshot } from '@dsc/ui'
import { EffortSlider } from './effort-slider.js'
import { extractVideoFrames } from './attachments.js'
import { QueueDock } from './queue-dock.js'
import { useMention } from './mention.js'
import type { useHostChannel } from '@dsc/ui'

/** 一个只带 `queued` 的最小快照通道（排队条只读队列与回合状态）。 */
function queueChannel(queued: Array<{ index: number; text: string }>, editResult = true): HostChannel {
  const snapshot = {
    sessions: [],
    queued,
    notices: [],
    status: { turnState: 'idle' },
    surfaces: {},
  } as unknown as HostSnapshot
  return {
    getSnapshot: () => snapshot,
    getHello: () => null,
    getStatus: () => 'open',
    getHostError: () => null,
    getPluginsFrame: () => null,
    onPlugins: () => () => undefined,
    onAsk: () => () => undefined,
    subscribe: () => () => undefined,
    invoke: (<T,>(method: string): Promise<T> => {
      if (method === 'editQueued') return Promise.resolve(editResult as unknown as T)
      return Promise.resolve(true as unknown as T)
    }) as HostChannel['invoke'],
    reconnect: () => undefined,
    close: () => undefined,
  }
}

function mountQueue(queued: Array<{ index: number; text: string }>): HTMLElement {
  const { container } = render(
    <RuntimeProvider channel={queueChannel(queued)}>
      <QueueDock />
    </RuntimeProvider>,
  )
  return container
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  // jsdom 没有 PointerEvent：拿 MouseEvent 顶上，React 的合成事件才读得到 clientX / button
  // （否则 button 是 undefined，滑杆直接把这次按下当成「非主键」丢掉）。
  vi.stubGlobal('PointerEvent', MouseEvent)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('档位滑杆的指针拖动', () => {
  test('按下 → 移动换档 → 松手落盘；有指针捕获时松手释放捕获', () => {
    const onCommit = vi.fn()
    const { container } = render(
      <EffortSlider levels={['off', 'low', 'high', 'max']} value="default" note={null} onCommit={onCommit} />,
    )
    const track = container.querySelector('[data-effort-track]') as HTMLElement
    const rail = container.querySelector('.effort-rail') as HTMLElement
    // jsdom 里没有排版：轨道换成 0..300 的假盒子，拖动位置才有意义。
    rail.getBoundingClientRect = () =>
      ({ left: 0, right: 300, top: 0, bottom: 10, width: 300, height: 10, x: 0, y: 0 }) as DOMRect
    const release = vi.fn()
    track.hasPointerCapture = () => true
    track.releasePointerCapture = release

    fireEvent.pointerDown(track, { clientX: 300, button: 0, pointerId: 1 })
    expect(track.getAttribute('data-dragging')).toBe('1')
    // 300px 处是最后一档（max），拖到 100px 落到 low。
    fireEvent.pointerMove(track, { clientX: 100, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: 100, pointerId: 1 })

    expect(release).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith('low')
    expect(track.hasAttribute('data-dragging')).toBe(false)
  })

  test('没按下时移动不落盘；按下后同一格移动不重复写本地预览', () => {
    const onCommit = vi.fn()
    const { container } = render(<EffortSlider levels={['off', 'low']} value="off" note="小字说明" onCommit={onCommit} />)
    const track = container.querySelector('[data-effort-track]') as HTMLElement
    const rail = container.querySelector('.effort-rail') as HTMLElement
    rail.getBoundingClientRect = () =>
      ({ left: 0, right: 200, top: 0, bottom: 10, width: 200, height: 10, x: 0, y: 0 }) as DOMRect
    track.hasPointerCapture = () => false
    track.releasePointerCapture = () => undefined

    fireEvent.pointerMove(track, { clientX: 200 })
    expect(track.hasAttribute('data-dragging')).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.pointerDown(track, { clientX: 0, button: 0, pointerId: 2 })
    // 同一档（下标没变）不重画：这一条不会让 data-dragging 之外的状态跳变。
    fireEvent.pointerMove(track, { clientX: 0, pointerId: 2 })
    expect(track.getAttribute('data-dragging')).toBe('1')
    fireEvent.pointerUp(track, { clientX: 0, pointerId: 2 })
    expect(onCommit).not.toHaveBeenCalled()
    expect(container.querySelector('.effort-note')?.textContent).toBe('小字说明')
  })
})

describe('视频抽帧的 seek 超时', () => {
  test('seek 不回调 seeked：超时按「这一帧不要」，整段抽帧返回空数组而不是挂住', async () => {
    vi.useFakeTimers()
    const pending = extractVideoFrames('blob:w14-video', 1)
    const video = document.querySelector('video') as HTMLVideoElement
    expect(video).not.toBeNull()
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 10 })
    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 0 })
    Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 0 })
    // currentTime 可写但永远不会触发 seeked：走到 5 秒超时那一支。
    let current = 0
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => current,
      set: (value: number) => {
        current = value
      },
    })
    video.onloadedmetadata?.(new Event('loadedmetadata'))
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(pending).resolves.toEqual([])
  })

  test('抽帧数量为 0 时直接返回空（不建 video）', async () => {
    await expect(extractVideoFrames('blob:w14-video', 0)).resolves.toEqual([])
    expect(document.querySelector('video')).toBeNull()
  })
})

describe('排队条编辑态的两颗钮', () => {
  test('点「保存」按当前正文落盘并退出编辑态', async () => {
    vi.useRealTimers()
    const container = mountQueue([{ index: 3, text: '旧正文' }])
    await flush()
    fireEvent.click(container.querySelector('[aria-label="编辑排队消息"]') as HTMLButtonElement)
    await flush()
    const box = container.querySelector('.queue-edit-box') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '点钮保存' } })
    fireEvent.click(container.querySelector('[aria-label="保存排队消息"]') as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('.queue-edit-box')).toBeNull()
    })
  })

  test('点「取消」退出编辑态、不写宿主', async () => {
    const writes: string[] = []
    const channel = queueChannel([{ index: 4, text: '旧正文' }])
    const invoke = channel.invoke.bind(channel) as (method: string, args?: unknown[]) => Promise<unknown>
    channel.invoke = (<T,>(method: string, args?: unknown[]): Promise<T> => {
      writes.push(method)
      return invoke(method, args) as Promise<T>
    }) as HostChannel['invoke']
    const { container } = render(
      <RuntimeProvider channel={channel}>
        <QueueDock />
      </RuntimeProvider>,
    )
    await flush()
    fireEvent.click(container.querySelector('[aria-label="编辑排队消息"]') as HTMLButtonElement)
    await flush()
    fireEvent.click(container.querySelector('[aria-label="取消编辑"]') as HTMLButtonElement)
    await flush()
    expect(container.querySelector('.queue-edit-box')).toBeNull()
    expect(writes).not.toContain('editQueued')
  })
})

describe('@ 文件提及的边界（mention.ts）', () => {
  /** 用一个假通道直接驱动 hook：只认 `fs-roots` / `fs-list` 两个 op。 */
  function mentionHarness(handler: (op: string, args: unknown[]) => unknown) {
    const channel = {
      invoke: (method: string, args: unknown[] = []): Promise<unknown> => {
        if (method !== 'dock') return Promise.resolve(undefined)
        try {
          return Promise.resolve(handler(String(args[0]), args))
        } catch (error) {
          return Promise.reject(error)
        }
      },
    } as unknown as ReturnType<typeof useHostChannel>
    const applied: Array<{ next: string; caret: number }> = []
    const area = { current: document.createElement('textarea') }
    document.body.appendChild(area.current)
    const hook = renderHook(() => {
      const ref = useRef(area.current)
      return useMention({ channel, area: ref, apply: (next, caret) => applied.push({ next, caret }) })
    })
    return { ...hook, applied }
  }

  test('多根遍历里单个目录 fs-list 失败：只跳过这一层，面板给空态而不是抛错', async () => {
    const harness = mentionHarness((op) => {
      if (op === 'fs-roots') return { cwd: '/repo', roots: [{ path: '/repo' }, { path: '/other' }] }
      throw new Error('目录读不了')
    })
    act(() => {
      harness.result.current.track('@a', 2)
    })
    await waitFor(() => {
      expect(harness.result.current.loading).toBe(false)
    })
    expect(harness.result.current.items).toEqual([])
    expect(harness.result.current.open).toBe(true)
  })

  test('查询词只命中路径（文件名不含）时也算候选', async () => {
    const roots = [{ path: '/w14-path-hit' }]
    const harness = mentionHarness((op, args) => {
      if (op === 'fs-roots') return { cwd: '/w14-path-hit', roots }
      const options = args[1] as { dir?: string }
      if (options.dir === '.') return { entries: [{ name: 'src', dir: true }] }
      return { entries: [{ name: 'a.ts', dir: false }] }
    })
    act(() => {
      harness.result.current.track('@src', 4)
    })
    await waitFor(() => {
      expect(harness.result.current.items).toEqual(['src/a.ts'])
    })
  })

  test('清单抛错时把加载态收掉，不把面板挂在「正在读取」上', async () => {
    const harness = mentionHarness((op, args) => {
      if (op === 'fs-roots') return { cwd: '/w14-bad', roots: [{ path: '/w14-bad' }] }
      // 坏回包：name 不是字符串，路径拼接时抛 TypeError，整份清单 rejection。
      void args
      return { entries: [{ name: 42, dir: false }] }
    })
    act(() => {
      harness.result.current.track('@x', 2)
    })
    await waitFor(() => {
      expect(harness.result.current.loading).toBe(false)
    })
    expect(harness.result.current.items).toEqual([])
    expect(harness.result.current.at).toBe(0)
  })
})
