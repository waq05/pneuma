/**
 * 「停 500ms 出卡、移开 1s 后收」的悬停计时（`hover-delay.ts`）的行为面（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-transcript-render-test.mjs` 第 [6]（缺口清单 B33）——原探针钉的是
 * `const HOVER_DELAY_MS = 500` / `const HOVER_CLOSE_MS = 1000` 两行源码文本（backlog 上
 * 记过「可按手册 §2 E 提成具名导出」的候选）。真渲染下不需要动产品代码：把 hook 装进
 * 一个测试组件，用假时钟把两条节奏**当行为**验——出卡 500ms 一拍不多、收卡 1s 一拍不少，
 * 常量改了这里当场红。收卡与参考实现（dsh 100ms）的有意分道由此钉住。
 *
 * 挂着这个 hook 的卡片（轮尾「文件已更改」卡的接线）在
 * `src/packages/ui-transcript/ui/changes-card.spec.tsx`。
 *
 * 锚点路（`arm` 的第四参：触发行的锚点名）升级自 `scripts/ui-anchored-test.mjs` 第 [3] 段
 * 的渲染半（缺口清单 B36「ui-anchored [3]」）——原探针钉的是 `anchorName?: string` 两行
 * 源码文本；这里行为化：带上第四参 arm，出卡的 state 里就有锚点名（浮层靠它贴位置），
 * 不带就没有（回退路自己量 rect）。浮层那份样式的行为在 changes-anchor.spec.tsx。
 *
 * @module dsc-ui-primitives/ui/hover-delay.spec
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useHoverDelay } from './hover-delay.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 把 hook 的四个动作暴露成测试可调的把手。 */
function Probe({ onReady }: { onReady(api: ProbeApi): void }): ReactNode {
  const delay = useHoverDelay<string>()
  onReady({
    hover: () => delay.hover,
    arm: delay.arm,
    disarm: delay.disarm,
    keep: delay.keep,
    close: delay.close,
  })
  return null
}

interface ProbeApi {
  hover(): { item: string; anchorName?: string } | null
  arm(item: string, anchor: DOMRect, cardWidth?: number, anchorName?: string): void
  disarm(): void
  keep(): void
  close(): void
}

const rect = (): DOMRect =>
  ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0 } as DOMRect)

describe('出卡节奏照参考实现（500ms）', () => {
  test('停够 500ms 才出卡：499ms 没有卡，500ms 那一拍出现', () => {
    let api!: ProbeApi // onReady 在 render 的函数体里同步回调（渲染即赋值）
    render(<Probe onReady={(value) => { api = value }} />)
    act(() => {
      api.arm('文件', rect())
    })
    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(api.hover()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(api.hover()?.item).toBe('文件')
  })

  test('重新 arm 重置计时（划过一行再停在下一行：不按第一行的起点算）', () => {
    let api!: ProbeApi // onReady 在 render 的函数体里同步回调（渲染即赋值）
    render(<Probe onReady={(value) => { api = value }} />)
    act(() => {
      api.arm('第一行', rect())
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    act(() => {
      api.arm('第二行', rect())
    })
    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(api.hover()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(api.hover()?.item).toBe('第二行')
  })

  test('arm 会取消已经在倒数的收卡计时（移开又马上移回来：卡不该先收后开）', () => {
    let api!: ProbeApi // onReady 在 render 的函数体里同步回调（渲染即赋值）
    render(<Probe onReady={(value) => { api = value }} />)
    act(() => {
      api.arm('文件', rect())
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(api.hover()).toBeTruthy()
    act(() => {
      api.disarm()
    })
    act(() => {
      vi.advanceTimersByTime(800)
    })
    act(() => {
      api.arm('文件', rect())
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    // 收卡倒计时被 arm 取消：1s 到了卡还在，且没有二次出卡。
    expect(api.hover()?.item).toBe('文件')
  })
})

describe('收卡节奏是本壳有意分道的 1s', () => {
  test('移开 1s 后才收：999ms 时还在，1000ms 那一拍收掉', () => {
    let api!: ProbeApi // onReady 在 render 的函数体里同步回调（渲染即赋值）
    render(<Probe onReady={(value) => { api = value }} />)
    act(() => {
      api.arm('文件', rect())
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    act(() => {
      api.disarm()
    })
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(api.hover()?.item).toBe('文件')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(api.hover()).toBeNull()
  })

  test('keep（鼠标进了卡）取消收卡倒计时：读完 diff 移开才重新倒数', () => {
    let api!: ProbeApi // onReady 在 render 的函数体里同步回调（渲染即赋值）
    render(<Probe onReady={(value) => { api = value }} />)
    act(() => {
      api.arm('文件', rect())
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    act(() => {
      api.disarm()
    })
    act(() => {
      api.keep()
    })
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    // keep 把倒计时摘了：卡不收。
    expect(api.hover()?.item).toBe('文件')
    act(() => {
      api.disarm()
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(api.hover()).toBeNull()
  })

  test('close（Esc / 换行）立刻收，不等倒计时', () => {
    let api!: ProbeApi // onReady 在 render 的函数体里同步回调（渲染即赋值）
    render(<Probe onReady={(value) => { api = value }} />)
    act(() => {
      api.arm('文件', rect())
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    act(() => {
      api.close()
    })
    expect(api.hover()).toBeNull()
  })

  test('挂载期 arm 又立刻卸载：定时器被摘掉，不往已卸载的组件上 setState', () => {
    let api!: ProbeApi
    const { unmount } = render(<Probe onReady={(value) => { api = value }} />)
    act(() => {
      api.arm('文件', rect())
    })
    unmount()
    // 不炸即为过（useEffect 的清理把 arm/close 两条计时都收了）。
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(true).toBe(true)
  })
})

describe('arm 的第四参：锚点名跟着进卡（ui-anchored [3] 行为化）', () => {
  test('支持锚点定位时 arm 带上锚点名：出卡的 state 里就是它，浮层拿它贴位置', () => {
    let api!: ProbeApi
    render(<Probe onReady={(value) => { api = value }} />)
    act(() => {
      api.arm('文件', rect(), 480, '--dsc-anchor-hover-0-ats')
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(api.hover()?.anchorName).toBe('--dsc-anchor-hover-0-ats')
  })

  test('回退路（不支持锚点）不带第四参：state 里没有锚点名，浮层自己量 rect', () => {
    let api!: ProbeApi
    render(<Probe onReady={(value) => { api = value }} />)
    act(() => {
      api.arm('文件', rect(), 480)
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(api.hover()?.anchorName).toBeUndefined()
  })
})
