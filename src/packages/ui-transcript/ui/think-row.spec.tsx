/**
 * 思考行（`rows/think-row.tsx`）的渲染段（ui 层，真渲染）。
 *
 * 来源（缺口清单 B33 / B34）：
 * - `scripts/ui-transcript-render-test.mjs` 第 [3]③：直播尾不再强制展开——0.6.67 的
 *   「思考完毕闪屏折叠」报障。原探针钉的是 `useFoldState(storeKey, !live && prefs.reasoningOpen)`
 *   这行源码文本；这里把同一件事行为化：**同一份设置（reasoningOpen=true）下，定稿行摊开、
 *   直播行收起起步**。参考实现（dsh 的 ReasoningRow）的口径是推理行永远收起起步，
 *   直播的「还活着」由扫光 / 摘要 / 小圈承载——这三样也一并钉住。
 * - `scripts/ui-fold-prefs-test.mjs` 第 [5] 思考半：默认展开跟随设置（设置一改已画出的
 *   定稿行跟着翻）、手动存档优先、思考行初值不拿 live 当展开理由。
 * - 「直播的摘要取最新一个写完段落的首行」（旧版 ThinkingBlock 的教训）也在这里真渲染验。
 *
 * 原探针（ui-fold-prefs [6]）钉的「设置变化经 shell.uiprefs 事件同步进壳」在
 * `ui.tsx` 的下发链路里，那条要渲整棵 TranscriptFlow（见 flow 渲染段的报告）。
 *
 * @module dsc-ui-transcript/ui/think-row.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { TranscriptEntry } from '@dsc/ui'
import { FOLD_PREFS, FoldPrefsContext, type FoldPrefs } from './shared.js'
import { clearFold, hasFold, writeFold } from './fold-state.js'
import { ThinkRow } from './rows/think-row.js'

/** ThinkRow 展开时会 new ResizeObserver（jsdom 没有）：量高逻辑在这层测试里不重要，给个空桩。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

afterEach(() => {
  cleanup()
  clearFold('trspec:manual-open')
  clearFold('trspec:manual')
})

let seq = 0
const think = (text: string): Extract<TranscriptEntry, { kind: 'thinking' }> =>
  ({ kind: 'thinking', id: (seq += 1), text }) as Extract<TranscriptEntry, { kind: 'thinking' }>

const prefsOf = (over: Partial<FoldPrefs> = {}): FoldPrefs => ({ ...FOLD_PREFS, ...over })

describe('直播收起起步、定稿才认设置档（B33 [3]③）', () => {
  test('reasoningOpen=true 时定稿行默认摊开', () => {
    const { container } = render(
      <FoldPrefsContext.Provider value={prefsOf({ reasoningOpen: true })}>
        <ThinkRow entry={think('定稿的思考')} live={false} />
      </FoldPrefsContext.Provider>,
    )
    const head = container.querySelector('.think-head') as HTMLElement
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.think-body')).toBeTruthy()
    expect((container.querySelector('.think-block') as HTMLElement).classList.contains('open')).toBe(true)
  })

  test('同一份设置下直播行仍收起起步（0.6.67「思考完毕闪屏折叠」的行为面）', () => {
    const { container } = render(
      <FoldPrefsContext.Provider value={prefsOf({ reasoningOpen: true })}>
        <ThinkRow entry={think('还在直播的思考')} live={true} />
      </FoldPrefsContext.Provider>,
    )
    expect((container.querySelector('.think-head') as HTMLElement).getAttribute('aria-expanded')).toBe('false')
    // 展开区是有条件渲染的：收起时正文不在 DOM 里（点箭头只转方向的旧病就是少这个条件）。
    expect(container.querySelector('.think-body')).toBeNull()
  })

  test('手动存档优先于直播收起（用户点开过的直播行重挂仍摊着）', () => {
    writeFold('trspec:manual-open', true)
    const { container } = render(
      <FoldPrefsContext.Provider value={prefsOf({ reasoningOpen: false })}>
        <ThinkRow entry={think('点开过的直播思考')} live={true} storeKey="trspec:manual-open" />
      </FoldPrefsContext.Provider>,
    )
    expect((container.querySelector('.think-head') as HTMLElement).getAttribute('aria-expanded')).toBe('true')
  })

  test('设置一改、已经画出来的定稿行跟着翻；手动调过的不动', () => {
    const entry = think('跟设置的定稿行')
    const { container, rerender } = render(
      <FoldPrefsContext.Provider value={prefsOf({ reasoningOpen: true })}>
        <ThinkRow entry={entry} live={false} />
      </FoldPrefsContext.Provider>,
    )
    expect(container.querySelector('.think-body')).toBeTruthy()
    rerender(
      <FoldPrefsContext.Provider value={prefsOf({ reasoningOpen: false })}>
        <ThinkRow entry={entry} live={false} />
      </FoldPrefsContext.Provider>,
    )
    // 设置翻到收起：没有手动存档的行跟着收。
    expect(container.querySelector('.think-body')).toBeNull()
    // 手动点开（这次点击写进存档）之后，设置再翻回 true 也不动这一行——
    // 「设置一拨老行纹丝不动」的报障反过来也是这条：手动选择不能被设置翻掉。
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    expect(hasFold('trspec:manual')).toBe(false) // 没给 storeKey 的行不存档，只活在本挂载里
    rerender(
      <FoldPrefsContext.Provider value={prefsOf({ reasoningOpen: true })}>
        <ThinkRow entry={entry} live={false} />
      </FoldPrefsContext.Provider>,
    )
    // 上面那行没给存档键，设置翻回 true 它跟着重新摊开（对照组）。
    expect(container.querySelector('.think-body')).toBeTruthy()
  })

  test('带存档键的行：手动点过的选择不被设置翻动，重挂读回', () => {
    const entry = think('手动优先的定稿行')
    const { container, rerender, unmount } = render(
      <FoldPrefsContext.Provider value={prefsOf({ reasoningOpen: false })}>
        <ThinkRow entry={entry} live={false} storeKey="trspec:manual" />
      </FoldPrefsContext.Provider>,
    )
    // 出厂口径收起；用户点开 → 写存档。
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    expect(hasFold('trspec:manual')).toBe(true)
    expect(container.querySelector('.think-body')).toBeTruthy()
    // 设置翻到「默认展开」：手动调过的不动（它已经是开的，不受影响）。
    // 再手动收起：存档 false 也算手动，设置再翻也翻不动。
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    expect(hasFold('trspec:manual')).toBe(true)
    rerender(
      <FoldPrefsContext.Provider value={prefsOf({ reasoningOpen: true })}>
        <ThinkRow entry={entry} live={false} storeKey="trspec:manual" />
      </FoldPrefsContext.Provider>,
    )
    expect(container.querySelector('.think-body')).toBeNull()
    // 重挂（换会话再切回来那种）：读回的是手动值（收起）。
    unmount()
    const again = render(
      <FoldPrefsContext.Provider value={prefsOf({ reasoningOpen: true })}>
        <ThinkRow entry={entry} live={false} storeKey="trspec:manual" />
      </FoldPrefsContext.Provider>,
    )
    expect(again.container.querySelector('.think-body')).toBeNull()
  })
})

describe('直播的三样信号（B33 [3]③ 的另一半）', () => {
  test('直播行带扫光取值、小圈与读屏说明；定稿行三样都没有', () => {
    const { container, rerender } = render(
      <FoldPrefsContext.Provider value={prefsOf()}>
        <ThinkRow entry={think('第一段写完了。\n\n还在吐第二段')} live={true} />
      </FoldPrefsContext.Provider>,
    )
    expect(container.querySelector('.think-spin')).toBeTruthy()
    expect(container.querySelector('.think-sr')).toBeTruthy()
    const shimmer = container.querySelector('[data-shimmer]')
    expect(shimmer).toBeTruthy()
    // 直播的摘要取「最新一个写完的段落的首行」，不是正在吐字的那一段。
    expect((shimmer as HTMLElement).getAttribute('data-shimmer')).toBe('第一段写完了。')
    rerender(
      <FoldPrefsContext.Provider value={prefsOf()}>
        <ThinkRow entry={think('第一段写完了。\n\n还在吐第二段')} live={false} />
      </FoldPrefsContext.Provider>,
    )
    expect(container.querySelector('.think-spin')).toBeNull()
    expect(container.querySelector('.think-sr')).toBeNull()
    expect(container.querySelector('[data-shimmer]')).toBeNull()
  })

  test('reasoningPreview=false 的档位（compact）不画摘要；true 画', () => {
    const entry = think('要显示的摘要')
    const { container, rerender } = render(
      <FoldPrefsContext.Provider value={prefsOf({ policy: { ...FOLD_PREFS.policy, reasoningPreview: false } })}>
        <ThinkRow entry={entry} live={false} />
      </FoldPrefsContext.Provider>,
    )
    expect(container.querySelector('.think-summary')).toBeNull()
    rerender(
      <FoldPrefsContext.Provider value={prefsOf()}>
        <ThinkRow entry={entry} live={false} />
      </FoldPrefsContext.Provider>,
    )
    expect(container.querySelector('.think-summary')?.textContent).toBe('要显示的摘要')
  })
})

describe('开合交互与存档（ui-fold-prefs [5] 思考半）', () => {
  test('点击开合写存档；键盘 Enter / Space 同款且 preventDefault', () => {
    const { container } = render(
      <FoldPrefsContext.Provider value={prefsOf()}>
        <ThinkRow entry={think('交互的思考')} live={false} />
      </FoldPrefsContext.Provider>,
    )
    const head = container.querySelector('.think-head') as HTMLElement
    expect(head.getAttribute('role')).toBe('button')
    fireEvent.click(head)
    expect(container.querySelector('.think-body')).toBeTruthy()
    fireEvent.click(head)
    expect(container.querySelector('.think-body')).toBeNull()
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      head.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    // Enter 展开又被 Space 收回，净效果收起；中间各开合一次即是「各触发一次」。
    expect(container.querySelector('.think-body')).toBeNull()
  })
})

describe('正文区归 body prop（槽当选者接管）', () => {
  test('给了 body 就不画内置 ThinkText 的那一份（transcript.reasoning.body 选举的落点）', () => {
    const { container } = render(
      <FoldPrefsContext.Provider value={prefsOf()}>
        <ThinkRow
          entry={think('槽接管的思考')}
          live={false}
          body={<div data-testid="elected">当选者的排版</div>}
        />
      </FoldPrefsContext.Provider>,
    )
    fireEvent.click(container.querySelector('.think-head') as HTMLElement)
    expect(container.querySelector('[data-testid="elected"]')).toBeTruthy()
    expect(container.querySelector('.think-text')).toBeNull()
  })
})
