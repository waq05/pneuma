/**
 * 用户消息行（`rows/user-row.tsx`）的渲染段：贴图浮层、压缩小标、机器投递的唤醒卡
 * （ui 层，真渲染）。
 *
 * 来源（缺口清单 B33 / B34）：
 * - `scripts/ui-transcript-render-test.mjs` 第 [13]：已发送消息里的贴图也开浮层——
 *   可编辑行与只读出口两处都是 `<button class="entry-shot">`、点击各自写 zoom、共用
 *   同一个 ImageLightbox，不再另开窗口。原探针数的是源码里 `entry-shot` / `setZoom` /
 *   `<ImageLightbox src={zoom}` 的出现次数；这里真点一下，浮层真的开、Esc / 关闭真的收。
 * - `scripts/ui-compaction-row-test.mjs` 第 [2] 后半：重放出来的压缩摘要（user 条目）
 *   气泡上方挂小标，可编辑行与只读出口各一枚。
 * - `scripts/ui-transcript-render-test.mjs` 第 [12] 的界面侧：internal 条目画成唤醒卡
 *   （TriggerRow），不再是用户气泡。标签文案的行为面在 `rounds.spec.ts`（internalLabel）。
 *
 * 负向钉（「贴图不再是 `<a href>` / 不另开窗口」）由结构保证：浮层走 portal 而非导航，
 * 渲染层里根本不存在那条路；样式钉（.entry-shot 的 CSS）jsdom 无接缝，留探针。
 *
 * @module dsc-ui-transcript/ui/user-row.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { TranscriptEntry } from '@dsc/ui'
import { clearFold } from './fold-state.js'
import { ReadonlyUserRow, UserRow } from './rows/user-row.js'
import { FlowActionsContext, NO_ACTIONS, ShellCwdContext } from './shared.js'

afterEach(() => {
  cleanup()
  clearFold('urspec:none')
})

let seq = 0
const userOf = (extra: object = {}): Extract<TranscriptEntry, { kind: 'user' }> =>
  ({ kind: 'user', id: (seq += 1), text: '帮我看看这个问题', ...extra }) as Extract<TranscriptEntry, { kind: 'user' }>

describe('贴图浮层（B33 [13]）', () => {
  const images = ['file:///cache/shot-1.png', 'file:///cache/shot-2.png']

  test('两处贴图都是可点的按钮（可编辑行与只读出口各一份），点开同一个浮层', () => {
    const editable = render(<UserRow entry={userOf({ images })} />)
    expect(editable.container.querySelectorAll('button.entry-shot').length).toBe(2)
    const readonly = render(<ReadonlyUserRow entry={userOf({ images })} />)
    expect(readonly.container.querySelectorAll('button.entry-shot').length).toBe(2)
    // 点开：浮层挂在 body（portal），src 是被点的那张。
    fireEvent.click(editable.container.querySelectorAll('button.entry-shot')[0] as HTMLElement)
    // 浮层挂在 body（portal）：.img-lightbox 里的那张大图是被点的贴图。
    expect(document.body.querySelector('.img-lightbox img[src="file:///cache/shot-1.png"]')).toBeTruthy()
  })

  test('两处气泡各有自己的浮层状态：只读出口点开不影响可编辑行', () => {
    const editable = render(<UserRow entry={userOf({ images: ['file:///cache/only-editable.png'] })} />)
    const readonly = render(<ReadonlyUserRow entry={userOf({ images: ['file:///cache/only-readonly.png'] })} />)
    fireEvent.click(readonly.container.querySelector('button.entry-shot') as HTMLElement)
    expect(document.body.querySelector('.img-lightbox img[src="file:///cache/only-readonly.png"]')).toBeTruthy()
    // 可编辑行还没点过：浮层里没有它那张。
    expect(document.body.querySelector('.img-lightbox img[src="file:///cache/only-editable.png"]')).toBeNull()
    fireEvent.click(editable.container.querySelector('button.entry-shot') as HTMLElement)
    expect(document.body.querySelector('.img-lightbox img[src="file:///cache/only-editable.png"]')).toBeTruthy()
  })

  test('浮层的关闭真的收得回去（Esc / 关闭钮走同一个 onClose）', () => {
    const { container } = render(<UserRow entry={userOf({ images: ['file:///cache/closable.png'] })} />)
    fireEvent.click(container.querySelector('button.entry-shot') as HTMLElement)
    expect(document.body.querySelector('.img-lightbox img[src="file:///cache/closable.png"]')).toBeTruthy()
    // Esc 的监听在 window 上；act 内派发，让 setZoom 的更新同步落地。
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.body.querySelector('.img-lightbox')).toBeNull()
  })

  test('没有贴图时整块不渲染（入口按钮一个都不出现）', () => {
    const { container } = render(<UserRow entry={userOf()} />)
    expect(container.querySelector('button.entry-shot')).toBeNull()
  })
})

describe('压缩摘要的小标（ui-compaction-row [2] 后半）', () => {
  test('可编辑行与只读出口各挂一枚小标：次数与说明都在', () => {
    const editable = render(<UserRow entry={userOf({ compaction: { count: 3 } })} />)
    const mark = editable.container.querySelector('.entry-user-compaction') as HTMLElement
    expect(mark).toBeTruthy()
    expect(mark.getAttribute('data-compaction-count')).toBe('3')
    expect(mark.getAttribute('title')).toBeTruthy()
    // 只读出口同样有（同一份标记、另一处挂点）。
    const readonly = render(<ReadonlyUserRow entry={userOf({ compaction: { count: 3 } })} />)
    expect((readonly.container.querySelector('.entry-user-compaction') as HTMLElement).getAttribute('data-compaction-count')).toBe('3')
  })

  test('没有压缩标记的普通消息不挂小标', () => {
    const { container } = render(<UserRow entry={userOf()} />)
    expect(container.querySelector('.entry-user-compaction')).toBeNull()
  })
})

describe('机器投递的消息画成唤醒卡（B33 [12] 界面侧）', () => {
  test('internal 条目交给 TriggerRow：默认收起、头行可点、原文按 pre 原样排', () => {
    const body = '后台作业 job-1 成功完成。'
    const { container } = render(<UserRow entry={userOf({ text: body, internal: true })} />)
    // 不再是用户气泡，也不再是灰行：一张带 data-internal 的小卡。
    expect(container.querySelector('.user-turn')).toBeNull()
    const card = container.querySelector('[data-internal="1"]') as HTMLElement
    expect(card).toBeTruthy()
    // 头行可点、默认收起；点开先一句解释、再摊模型看到的原文（pre 原样）。
    const head = container.querySelector('.trigger-head') as HTMLElement
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.trigger-text')).toBeNull()
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    const pre = container.querySelector('.trigger-text') as HTMLElement
    expect(pre.textContent).toBe(body)
  })

  test('队友汇报同样走唤醒卡（标题走 internalLabel 的人话，不出现标记原文）', () => {
    const body = '<teammate-report from="mate-1" role="coder" state="已完成">\n派给它的任务：改个 bug\n</teammate-report>'
    const { container } = render(<ShellCwdContext.Provider value=""><UserRow entry={userOf({ text: body, internal: true })} /></ShellCwdContext.Provider>)
    const card = container.querySelector('[data-internal="1"]') as HTMLElement
    expect(card.getAttribute('data-trigger')).toBe('teammate')
    const title = container.querySelector('.trigger-title') as HTMLElement
    expect(title.textContent).toContain('mate-1')
    expect(title.textContent).not.toContain('<teammate-report')
  })

  test('审查结论（findings 标记）优先画成卡片，不走唤醒卡', () => {
    const body = '<review-findings summary="复查完成">\n<finding file="a.ts" line="1" severity="warn">有点问题</finding>\n</review-findings>'
    const { container } = render(<ShellCwdContext.Provider value=""><UserRow entry={userOf({ text: body })} /></ShellCwdContext.Provider>)
    expect(container.querySelector('.user-turn')).toBeNull()
    expect(container.querySelector('[data-internal="1"]')).toBeNull()
    // findings 卡的形状归 ui-primitives（review-findings.spec），这里钉「UserRow 让位给它」。
    expect(container.textContent).toContain('a.ts')
  })
})

describe('编辑入口（FlowActions 的消费面）', () => {
  test('跑动中（busy）编辑钮置灰', () => {
    const { container } = render(
      <FlowActionsContext.Provider value={{ ...NO_ACTIONS, busy: true }}>
        <UserRow entry={userOf()} />
      </FlowActionsContext.Provider>,
    )
    expect((container.querySelector('.user-act') as HTMLButtonElement).disabled).toBe(true)
  })
})
