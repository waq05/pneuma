/**
 * 两张「请求账单」卡（`rows/prompt-card.tsx`）与它们的三处结构约定的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-prompt-cards-test.mjs` 第 [1]–[4] 段（缺口清单 B37）。原探针钉的是卡片
 * JSX、`render.tsx` 两个 case、`round-fold` / `rounds` / `ui.tsx` 的结构表源码文本；这里
 * 全部换成真渲染与真跑：
 * - [1] 系统提示卡：根类名 / 字数折算 K / 段数 / 模型有才画 / 段清单按 order 升序 /
 *   hash 前 8 位；上下文注入卡：空清单不画、按 kind 首次出现合并、前三类 + N、逐条来源 /
 *   位置 / 字数 / 预览、步数 >1 才画；
 * - [2] 老会话（`bodyMissing`）：展开只给一句「没有段清单」，不画空表；
 * - [3] `RowBody` 的两个分支直画卡片（不交给节点槽），存档键是 `会话id:行稳定身份`——
 *   点开后 `readFold` 读到的就是那个键；
 * - [4] 两张卡进了三张结构表：整轮收起不藏它们、分轮不推进 endIndex / answered、
 *   空会话欢迎态不被开场账单卡顶掉（欢迎态那条在 `flow.spec.tsx`）。
 *
 * 不迁的：views.css 的类名 / 令牌扫描（第 [5] 段，jsdom 不应用样式表）、第 [7] 段的
 * 反向源码钉（没有正文字段 / 没有中文字面量 / 没有 import 契约）——它们没有运行期行为，
 * 归 shots 或代码审查。第 [6] 段文案字典已在 `prompt-cards-locale.spec.ts`。
 *
 * @module dsc-ui-transcript/ui/prompt-cards.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { TranscriptEntry } from '@dsc/ui'
import { buildRoundFolds } from './round-fold.js'
import { splitRounds } from './rounds.js'
import { RowBody } from './render.js'
import { ContextInjectionCard, SystemPromptCard, type ContextInjectionView, type SystemPromptView } from './rows/prompt-card.js'
import { clearFold, readFold } from './fold-state.js'
import { ShellSessionContext } from './shared.js'

afterEach(() => {
  cleanup()
  clearFold('s1:prompt-1')
  clearFold('s2:prompt-1')
})

/** 一份系统提示摘要：三段故意乱序，验证按 order 排。 */
const promptOf = (extra: Partial<SystemPromptView> = {}): SystemPromptView => ({
  hash: 'abcdef0123456789',
  chars: 6234,
  model: 'deepseek-chat',
  sections: [
    { id: 'behavior', order: 2, from: 'file', chars: 1200 },
    { id: 'identity', order: 1, from: 'core', chars: 500 },
    { id: 'persona', order: 3, from: 'plugin:preset:persona', chars: 10 },
  ],
  ...extra,
})

/** 一份注入清单：`env-facts` 两次（合并），再加三类，四类里前三类 + 一类收进 +N。 */
const partsOf = (): ContextInjectionView[] => [
  { kind: 'env-facts', source: 'env', where: 'user-tail', chars: 300, preview: '平台 win32 · cwd D:/demo' },
  { kind: 'mode', source: 'mode', where: 'system', chars: 86 },
  { kind: 'env-facts', source: 'env', where: 'user-tail', chars: 18 },
  { kind: 'sandbox', source: 'sandbox', where: 'system', chars: 10 },
  { kind: 'todo-reminder', source: 'todo', where: 'user-tail', chars: 5 },
]

const cardOf = (html: HTMLElement, selector: string): HTMLElement => {
  const found = html.querySelector(selector)
  if (found === null) throw new Error(`没有找到 ${selector}`)
  return found as HTMLElement
}

describe('系统提示卡：收起行读数与展开段表', () => {
  test('根类名与 data-prompt-hash；字数折算 K、段数、模型三段读数都在', () => {
    const { container } = render(<SystemPromptCard prompt={promptOf()} />)
    const root = cardOf(container, '.entry-prompt')
    expect(root.getAttribute('data-prompt-hash')).toBe('abcdef0123456789')
    const head = cardOf(container, '.entry-prompt-head')
    expect(head.getAttribute('aria-expanded')).toBe('false')
    // 6234 → 6.2K；三段 → 3 段；模型名照画。
    expect(head.textContent).toContain('6.2K 字')
    expect(head.textContent).toContain('3 段')
    expect(head.textContent).toContain('deepseek-chat')
  })

  test('没有 model 时既不画模型名也不多一个分隔点', () => {
    const withModel = render(<SystemPromptCard prompt={promptOf()} />)
    const without = render(<SystemPromptCard prompt={promptOf({ model: undefined })} />)
    const dots = (container: HTMLElement): number => container.querySelectorAll('.entry-prompt-dot').length
    expect(dots(withModel.container)).toBe(3)
    expect(dots(without.container)).toBe(2)
    expect(without.container.querySelector('.entry-prompt-model')).toBeNull()
  })

  test('展开后段表按 order 升序（不是按数组原序），来源三档都翻成人话，末行 hash 取前 8 位', () => {
    const { container } = render(<SystemPromptCard prompt={promptOf()} />)
    const head = cardOf(container, '.entry-prompt-head')
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(cardOf(container, '.entry-prompt').getAttribute('data-open')).toBe('1')
    const ids = [...container.querySelectorAll('.entry-prompt-id')].map((node) => node.textContent)
    expect(ids).toEqual(['identity', 'behavior', 'persona'])
    const froms = [...container.querySelectorAll('.entry-prompt-from')].map((node) => node.textContent)
    expect(froms).toEqual(['内核', '指令文件', '插件 preset:persona'])
    expect(cardOf(container, '.entry-prompt-hash').textContent).toBe('hash abcdef01')
  })

  test('键盘 Enter 也能开合（行头是 div，空格要先挡掉默认滚动）', () => {
    const { container } = render(<SystemPromptCard prompt={promptOf()} />)
    const head = cardOf(container, '.entry-prompt-head')
    fireEvent.keyDown(head, { key: 'Enter' })
    expect(head.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(head, { key: ' ' })
    expect(head.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('老会话（bodyMissing）：展开只给一句说明，不画空表', () => {
  test('展开给的是「来自老会话」那句话，段表与 hash 行都不出现', () => {
    const { container } = render(<SystemPromptCard prompt={promptOf({ bodyMissing: true })} />)
    // 收起行照画（老会话也有摘要）。
    expect(cardOf(container, '.entry-prompt-head').textContent).toContain('6.2K 字')
    fireEvent.click(cardOf(container, '.entry-prompt-head'))
    expect(cardOf(container, '.entry-prompt-missing').textContent).toBe('这一条来自老会话，没有段清单')
    expect(container.querySelector('.entry-prompt-table')).toBeNull()
    expect(container.querySelector('.entry-prompt-hash')).toBeNull()
  })
})

describe('上下文注入卡：合并、收进 +N、逐条展开', () => {
  test('空清单整卡不画（钩子仍先调，挂载期钩子顺序不随数据变）', () => {
    const { container } = render(<ContextInjectionCard parts={[]} />)
    expect(container.querySelector('.entry-injection')).toBeNull()
  })

  test('同 kind 合并、按首次出现顺序、最多列三类、其余收进 +N', () => {
    const { container } = render(<ContextInjectionCard parts={partsOf()} />)
    const root = cardOf(container, '.entry-injection')
    expect(root.getAttribute('data-injection-count')).toBe('5')
    const summary = cardOf(container, '.entry-injection-summary').textContent
    // env-facts 300 + 18 = 318 字；顺序是 env-facts → mode → sandbox；第四类收进 +1。
    expect(summary).toContain('环境快照 318 字')
    expect(summary).toContain('模式 86 字')
    expect(summary).toContain('沙箱 10 字')
    expect(summary).toContain('+1')
    expect(summary.indexOf('环境快照')).toBeLessThan(summary.indexOf('模式'))
    expect(summary.indexOf('模式')).toBeLessThan(summary.indexOf('沙箱'))
  })

  test('步数 >1 才画「共 N 步」，1 步不占位置', () => {
    const multi = render(<ContextInjectionCard parts={partsOf()} count={3} />)
    expect(multi.container.querySelector('.entry-injection-steps')?.textContent).toBe('共 3 步')
    const single = render(<ContextInjectionCard parts={partsOf()} />)
    expect(single.container.querySelector('.entry-injection-steps')).toBeNull()
  })

  test('展开逐条画来源 / 位置 / 字数 / 预览；没有预览的那条不画空 span', () => {
    const { container } = render(<ContextInjectionCard parts={partsOf()} />)
    fireEvent.click(cardOf(container, '.entry-injection-head'))
    expect(container.querySelectorAll('.entry-injection-row')).toHaveLength(5)
    const first = container.querySelectorAll('.entry-injection-row')[0] as HTMLElement
    expect(first.querySelector('.entry-injection-source')?.textContent).toBe('env')
    expect(first.querySelector('.entry-injection-where')?.textContent).toBe('请求末尾')
    expect(first.querySelector('.entry-injection-chars')?.textContent).toBe('300 字')
    expect(first.querySelector('.entry-injection-preview')?.textContent).toBe('平台 win32 · cwd D:/demo')
    const mode = container.querySelectorAll('.entry-injection-row')[1] as HTMLElement
    expect(mode.querySelector('.entry-injection-where')?.textContent).toBe('系统提示')
    expect(mode.querySelector('.entry-injection-preview')).toBeNull()
  })
})

/** 造一条 system-prompt / context-injection 的 RowBody 输入。 */
const rowOf = (entry: TranscriptEntry): Parameters<typeof RowBody>[0]['row'] =>
  ({ entry, live: false, at: 0, stable: 'prompt-1' }) as Parameters<typeof RowBody>[0]['row']

describe('RowBody 接线：两个 case 直画卡片，存档键是 会话id:行稳定身份', () => {
  test('system-prompt 分支画出系统提示卡，点开写进 `s1:prompt-1`', () => {
    const entry = { kind: 'system-prompt', id: 1, prompt: promptOf() } as TranscriptEntry
    const { container } = render(
      <ShellSessionContext.Provider value="s1">
        <RowBody row={rowOf(entry)} />
      </ShellSessionContext.Provider>,
    )
    fireEvent.click(cardOf(container, '.entry-prompt-head'))
    expect(readFold('s1:prompt-1', false)).toBe(true)
  })

  test('context-injection 分支画出注入卡，同一行的存档键跟着会话 id 走', () => {
    const entry = { kind: 'context-injection', id: 1, parts: partsOf(), count: 2 } as TranscriptEntry
    const { container } = render(
      <ShellSessionContext.Provider value="s2">
        <RowBody row={rowOf(entry)} />
      </ShellSessionContext.Provider>,
    )
    fireEvent.click(cardOf(container, '.entry-injection-head'))
    expect(readFold('s2:prompt-1', false)).toBe(true)
    // 换个会话重挂：读不到上一份存档，回到收起态。
    cleanup()
    const again = render(
      <ShellSessionContext.Provider value="s1">
        <RowBody row={rowOf(entry)} />
      </ShellSessionContext.Provider>,
    )
    expect(cardOf(again.container, '.entry-injection-head').getAttribute('aria-expanded')).toBe('false')
  })

  test('有节点槽渲染器时也把内置卡片作为兜底交出去（不另起一套）', () => {
    const entry = { kind: 'system-prompt', id: 1, prompt: promptOf() } as TranscriptEntry
    const seen: string[] = []
    const renderSlot = ((slot: string, _owner: unknown, fallback: unknown) => {
      seen.push(slot)
      return fallback
    }) as Parameters<typeof RowBody>[0]['renderSlot']
    const { container } = render(
      <ShellSessionContext.Provider value="s1">
        <RowBody row={rowOf(entry)} renderSlot={renderSlot} />
      </ShellSessionContext.Provider>,
    )
    expect(seen).toEqual(['transcript.node'])
    expect(container.querySelector('.entry-prompt')).toBeTruthy()
  })
})

/** 造一条条目（id 递增）。 */
let seq = 0
const entryOf = (kind: TranscriptEntry['kind'], extra: object = {}): TranscriptEntry =>
  ({ kind, id: (seq += 1), ...extra }) as TranscriptEntry

describe('结构表：两张卡进了整轮折叠 / 分轮 / 欢迎态的判据', () => {
  // 2026-11-17（dev 2bcf8d3c）：整轮折叠以前只收 thinking / tool，两张账单卡留在折叠之外，
  // 收起之后仍看得见一长条提示词与注入内容——「收起」等于没收。现在它们算回合过程内容，
  // 与 thinking / tool 一起藏；轮尾早退与欢迎态判据仍认它们（见下一条用例）。
  test('整轮收起把两张账单卡当过程内容一起藏，思考与工具同样藏', () => {
    const entries = [
      entryOf('user', { text: '问', ts: 1 }),
      entryOf('thinking', { text: '想' }),
      entryOf('system-prompt', { prompt: promptOf() }),
      entryOf('context-injection', { parts: partsOf() }),
      entryOf('tool', { call: { callId: 'c1', name: 'bash', argsText: '{}', status: 'done' } }),
    ]
    const rounds = splitRounds(entries).rounds
    const fold = buildRoundFolds(entries, rounds, { foldTurns: true, live: false, lastRoundIndex: 0 }).get(0)
    expect(fold).toBeTruthy()
    expect(fold?.hidden.has(1)).toBe(true) // thinking
    expect(fold?.hidden.has(4)).toBe(true) // tool
    expect(fold?.hidden.has(2)).toBe(true) // system-prompt
    expect(fold?.hidden.has(3)).toBe(true) // context-injection
  })

  test('分轮：开场与轮中的账单卡都不推进 endIndex / answered', () => {
    const entries = [
      entryOf('system-prompt', { prompt: promptOf() }),
      entryOf('context-injection', { parts: partsOf() }),
      entryOf('user', { text: '问', ts: 1 }),
      entryOf('context-injection', { parts: partsOf(), count: 2 }),
    ]
    const split = splitRounds(entries)
    // 开场两张卡不造轮：只有 user 开的那一轮。
    expect(split.rounds).toHaveLength(1)
    expect(split.rounds[0]?.startIndex).toBe(2)
    // 轮中那条注入不推进轮尾、也不把「答没答」置真。
    expect(split.rounds[0]?.endIndex).toBe(2)
    expect(split.rounds[0]?.answered).toBe(false)
  })
})
