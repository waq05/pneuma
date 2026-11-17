/**
 * 首屏招呼语（`welcome.tsx` 的 `GREETING_TEXT` / H1）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-welcome-greeting-test.mjs` 第 [1] 段末尾与第 [3] 段（缺口清单 B37）。
 * 原探针钉 `welcome.tsx` 的 `t('…')` 字面量、`GREETING_TEXT[slot]` 与 `<h1>{greetingLine(...)}`
 * 源码文本；这里把 `WelcomeState` 对六个时段各渲染一次，H1 的文本必须正好是字典里那一句。
 *
 * 第 [3] 段里「时钟从 ui.tsx 递进来、到点重绘」的行为面在 `flow.spec.tsx`（真渲染
 * TranscriptFlow + 假时钟，验证换档）；CSS 的 `text-wrap: balance` 是样式表钉，转 shots。
 *
 * @module dsc-ui-transcript/ui/welcome.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { TranscriptEntry } from '@dsc/ui'
import type { GreetingSlot } from './greeting.js'
import type { Row } from './shared.js'
import { WelcomeState, type WelcomeCard } from './welcome.js'
import zh from '../locale/ui.zh.json'

afterEach(cleanup)

const SLOTS: GreetingSlot[] = ['earlyMorning', 'morning', 'noon', 'afternoon', 'evening', 'lateNight']

const cardOf = (id: string): WelcomeCard => ({
  id,
  Icon: () => null,
  title: `卡 ${id}`,
  hint: `说明 ${id}`,
  run: () => undefined,
})

const baseProps = {
  cards: [cardOf('read')],
  resume: null,
  leading: [] as readonly Row[],
  sessionKey: 'sess',
  cwd: 'D:/demo',
  composerReady: true,
  onResume: () => undefined,
}

const rowOf = (entry: TranscriptEntry, stable: string): Row => ({ entry, live: false, at: 0, stable })

describe('六个时段各渲染一次：H1 正好是字典里那一句', () => {
  test('每一档的 H1 都等于 transcript.welcome.hello.<slot>', () => {
    for (const slot of SLOTS) {
      const { container, unmount } = render(<WelcomeState {...baseProps} greeting={slot} />)
      const h1 = container.querySelector('.welcome h1')
      expect(h1?.textContent).toBe(zh[`transcript.welcome.hello.${slot}`])
      unmount()
    }
  })

  test('六句各不相同（按时段查表，不是一句写死）', () => {
    const lines = SLOTS.map((slot) => {
      const { container, unmount } = render(<WelcomeState {...baseProps} greeting={slot} />)
      const text = container.querySelector('.welcome h1')?.textContent
      unmount()
      return text
    })
    expect(new Set(lines).size).toBe(SLOTS.length)
  })
})

describe('首屏其余接线', () => {
  test('能力卡画标题与说明；composer 服务缺席时置灰不可点', () => {
    const { container } = render(<WelcomeState {...baseProps} greeting="morning" composerReady={false} />)
    const button = container.querySelector('.welcome-card') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(container.querySelector('.welcome-card-title')?.textContent).toBe('卡 read')
    expect(container.querySelector('.welcome-card-hint')?.textContent).toBe('说明 read')
  })

  test('开场区的命令输出画左对齐块（不是居中灰字）', () => {
    const entry = { kind: 'system', id: 1, text: '/help 的输出', command: true } as TranscriptEntry
    const { container } = render(<WelcomeState {...baseProps} greeting="noon" leading={[rowOf(entry, 'cmd')]} />)
    expect(container.querySelector('.entry-system-command')?.textContent).toBe('/help 的输出')
  })

  test('开场区的写前预览走卡片；认不出的 system 行不铺出来', () => {
    const notice = {
      kind: 'system',
      id: 1,
      text: '【改动前预览·尚未落盘】新建 a.md（+1 行 / -0 行）\n+x',
    } as TranscriptEntry
    const noise = { kind: 'system', id: 2, text: '一条短通知' } as TranscriptEntry
    const { container } = render(
      <WelcomeState {...baseProps} greeting="evening" leading={[rowOf(notice, 'n'), rowOf(noise, 'x')]} />,
    )
    expect(container.querySelector('.entry-review')).toBeTruthy()
    expect(container.textContent).not.toContain('一条短通知')
  })

  test('有「接着上次」时画出那一行，点一下回传会话 id', () => {
    const opened: string[] = []
    const { container } = render(
      <WelcomeState
        {...baseProps}
        greeting="lateNight"
        resume={{ id: 's-1', title: '接着做的事', updatedAt: Date.now() - 60_000 }}
        onResume={(id) => opened.push(id)}
      />,
    )
    const button = container.querySelector('.welcome-resume') as HTMLElement
    fireEvent.click(button)
    expect(opened).toEqual(['s-1'])
  })
})
