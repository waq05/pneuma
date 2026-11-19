/**
 * 悬停预览卡的「两条定位路」（`rows/changes-card.tsx`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-anchored-test.mjs` 第 [3] 段的渲染半（缺口清单 B36「ui-anchored [3]」；
 * 计时半在 `@dsc/ui-primitives` 的 hover-delay.spec.tsx）。原探针钉的是 changes-card.tsx
 * 里的样式字面量与回退分支源码文本；这里行为化——
 *   - **支持锚点**（CSS.supports('anchor-name: …') 为真）：触发行挂 `anchor-name`，
 *     浮层写 `position-anchor` / 贴上方 6px / `flip-block` 翻向 / `clamp` 夹左缘；
 *   - **回退路**：按量到的 rect「上下二选一」（`anchor.top - 12 >= maxHeight`），
 *     上方贴 `bottom`、下方贴 `top`，横向夹进视口——老浏览器上预览卡照样有位置。
 *
 * 两条路靠 `ANCHORED` 模块级常量分流（`anchorPositioningSupported()` 在模块加载时算一次），
 * 所以这里用「stub CSS.supports + 重载模块」显式各开一条：锚点路 stub 成真，回退路 stub
 * 成假——不给 jsdom 的默认值（没有 CSS.supports，恒假）留偶然。
 *
 * 不迁的：`.hover-preview` 的 CSS 规则体是样式表文本钉（jsdom 不应用样式表）；真机矩形、
 * 间距、打开当帧不隐藏由 `ui-anchor-e2e.mjs` 量（探针文件头写明的那半）。
 *
 * @module dsc-ui-transcript/ui/changes-anchor.spec
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ChangedFileView } from '@dsc/ui'
import type { Row } from './shared.js'
import { DiffHoverCard } from './rows/changes-card.js'

/** 造一条 changes 条目包成行（与 changes-card.spec 的同款）。 */
const changeRow = (path: string, added: number, removed: number): Row =>
  ({
    entry: { kind: 'changes', id: Math.abs(hashOf(path)), file: { path, added, removed, hunks: [], status: 'modified' } },
    live: false,
    at: 1,
    stable: `r0:changes:${path}`,
  }) as unknown as Row

function hashOf(text: string): number {
  let value = 0
  for (const ch of text) value = (value * 31 + ch.charCodeAt(0)) | 0
  return value
}

/** 悬停用例的样张：两张文件（悬停只发生在多文件卡的行列表上）。 */
const twoRows = (): Row[] => [changeRow('a.ts', 3, 1), changeRow('b.ts', 1, 1)]

const hoverCard = (): HTMLElement | null => document.body.querySelector('.hover-preview')

/** 动态重载 changes-card：`ANCHORED` 是模块级常量，stub 必须在 import 前生效。 */
async function loadCard(anchored: boolean): Promise<typeof import('./rows/changes-card.js')> {
  vi.resetModules()
  vi.stubGlobal('CSS', { supports: (value: string): boolean => anchored && value.startsWith('anchor-name:') })
  return import('./rows/changes-card.js')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

afterAll(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/** 渲染多文件卡并悬停第一行 500ms（出卡），回渲染器与容器。 */
async function hoverFirstRow(
  card: { ChangesCard: typeof import('./rows/changes-card.js')['ChangesCard'] },
  rows: Row[],
): Promise<ReturnType<typeof render>> {
  const rendered = render(<card.ChangesCard rows={rows} cwd="D:/demo" />)
  const row = rendered.container.querySelector('.changes-row-wrap') as HTMLElement
  fireEvent.mouseEnter(row, { currentTarget: row })
  await act(async () => {
    vi.advanceTimersByTime(500)
  })
  if (hoverCard() === null) throw new Error('悬停 500ms 后预览卡没有出来')
  return rendered
}

describe('支持锚点定位（Chromium 125+）：浮层贴锚点、翻向、夹取全交给浏览器', () => {
  const card = { ChangesCard: null as unknown as typeof import('./rows/changes-card.js')['ChangesCard'] }
  beforeAll(async () => {
    card.ChangesCard = (await loadCard(true)).ChangesCard
  })

  test('触发行挂 anchor-name：一行一个名（悬停的那一行才是锚点）', async () => {
    const rendered = await hoverFirstRow(card, twoRows())
    const rows = rendered.container.querySelectorAll('.changes-row-wrap')
    const first = rows[0] as HTMLElement
    // 第一行的锚点名由 `hover-<序号>-<路径>` 整出来（路径里的点被剔掉，撞名也不顶掉）。
    expect(first.style.getPropertyValue('anchor-name')).toBe('--dsc-anchor-hover-0-ats')
  })

  test('浮层写 position-anchor 指回触发行、贴上方 6px、放不下翻下方、左缘 clamp', async () => {
    await hoverFirstRow(card, twoRows())
    const style = hoverCard() as HTMLElement
    expect(style.style.getPropertyValue('position-anchor')).toBe('--dsc-anchor-hover-0-ats')
    // bottom 量的是「浮层底边到包含块底边」，贴锚点上方 6px 要 +6（符号写反是 2026-10-14
    // 真机抓出来的那条：卡底落在锚点顶下方 6px）。jsdom 的 cssstyle 会把 calc 里的项重排
    // （`calc(anchor(top) + 6px)` 读回来是 `calc(6px + anchor(top))`），只认运算的两端。
    expect(style.style.bottom).toContain('anchor(top)')
    expect(style.style.bottom).toContain('6px')
    expect(style.style.getPropertyValue('position-try-fallbacks')).toBe('flip-block')
    expect(style.style.left).toContain('clamp(')
    expect(style.style.width).toBe('var(--dsc-hover-w)')
  })

  test('换一行悬停，锚点名跟着换（不会钉在第一行上）', async () => {
    const rendered = render(<card.ChangesCard rows={twoRows()} cwd="D:/demo" />)
    const second = rendered.container.querySelectorAll('.changes-row-wrap')[1] as HTMLElement
    fireEvent.mouseEnter(second, { currentTarget: second })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect((hoverCard() as HTMLElement).style.getPropertyValue('position-anchor')).toBe('--dsc-anchor-hover-1-bts')
  })
})

describe('回退路（不支持锚点定位）：量 rect 上下二选一、横向夹进视口', () => {
  /**
   * 直接渲染 DiffHoverCard：回退/锚点在浮层里是 `anchorName === undefined` 的**运行时
   * 分支**，给不给锚点名就换一条路——不需要为它重载模块（jsdom 没有 CSS.supports，
   * ChangesCard 的 ANCHORED 恒假，它的浮层走的正是这条路）。
   */
  const file: ChangedFileView = { path: 'a.ts', added: 3, removed: 1, hunks: [], status: 'modified' }
  const rect = (top: number, bottom: number, left: number): DOMRect =>
    ({
      top, bottom, left, right: left + 200, width: 200, height: bottom - top, x: left, y: top,
    }) as DOMRect

  const renderCard = (anchor: DOMRect): void => {
    render(
      <DiffHoverCard
        file={file}
        anchor={anchor}
        cardWidth={480}
        cwd="D:/demo"
        onKeep={(): void => undefined}
        onLeave={(): void => undefined}
        onClose={(): void => undefined}
      />,
    )
    if (hoverCard() === null) throw new Error('预览卡没有渲染出来')
  }

  test('上方空间够（anchor.top − 12 ≥ maxHeight）：贴上方，bottom = innerHeight − anchor.top + 6', () => {
    // maxHeight = min(420, innerHeight-24)；top=600 时上方有 588px ≥ 420，走 bottom 定位。
    renderCard(rect(600, 620, 100))
    expect((hoverCard() as HTMLElement).style.bottom).toBe(`${String(768 - 600 + 6)}px`)
    expect((hoverCard() as HTMLElement).style.top).toBe('')
    // 横向：行左缘 −24px 起步，夹在 [8, innerWidth − width − 8] 里。
    expect((hoverCard() as HTMLElement).style.left).toBe('76px')
  })

  test('上方放不下：落到下方，top = anchor.bottom + 6（卡不伸出视口顶）', () => {
    renderCard(rect(200, 220, 100))
    expect((hoverCard() as HTMLElement).style.top).toBe(`${String(220 + 6)}px`)
    expect((hoverCard() as HTMLElement).style.bottom).toBe('')
  })

  test('两条路共用同一套尺寸口径：宽 = max(320, 卡宽 − 48)、高上限 420', () => {
    renderCard(rect(200, 220, 100))
    const style = hoverCard() as HTMLElement
    expect(style.style.width).toBe('432px')
    expect(style.style.maxHeight).toBe('420px')
  })
})
