/**
 * 工具卡的装配（factory）渲染断言（ui 层）。
 *
 * 来源：`scripts/ui-tool-views-test.mjs` 第 [4] 段（装配）。原探针读 `factory.tsx` 源码钉
 * 「判据写法、卡体位置、轨迹页分支」——文本钉在真渲染下全部有行为等价物：
 *
 * - 「判据 = 有参数 且 对话页」→ 渲染同一条调用：`variant` 缺省（chat）出专用卡，
 *   `variant='trace'` 摊原始参数与结果原文（轨迹页的取证职责）；
 * - 「三个卡体都在展开体里（收起态不铺内容）」→ 收起态 DOM 里没有卡体，点开（fireEvent）
 *   后出现；
 * - 「头行读数在可点展开的那一段里」→ 读数节点是 `.tool-click` 的后代；
 * - 「专用卡不再画 +N 行」→ 同一份多行结果：read 卡收起态没有 `.tc-more`，通用卡有；
 * - 「轨迹页那一支里没有卡体」→ trace 渲染后 DOM 里一个专用卡类名都不出现；
 * - 「头行的路径按钮挡冒泡（点路径不折卡）」→ fireEvent 点 `.tc-path`，卡不展开。
 *
 * 第 [5] 段（views.css 的限高 / 令牌 / 色值门）是 CSS 文本钉：jsdom 不做布局也不吃样式表，
 * 渲染层没有接缝，不迁（与 B26 同一处置，归 `desktop/shots` 截图探针）。
 *
 * 顺带钉住 `ui-tool-name-null-test.mjs` 第 [3] 段的渲染半边：名字是空串（宿主把 null
 * 修成空串后的形状）的工具卡照常渲染、不抛——白屏事故的最后一道闸。
 *
 * 渲染口径：`ToolCardView` 是纯展示组件（Factory 的共享骨架），没有槽上下文也能渲染；
 * 它经 `useIntendedDiff` 摸 `useHostChannel`，所以要包一层 `RuntimeProvider` + 假通道
 * （read / bash / 检索 / 待办 / web / 图片这些名字不触发任何 invoke，假通道只是接住 context）。
 * jsdom 没有 `ResizeObserver`，展开体那个量高 effect 会用到——在这里打桩（`dom.ts` 不预埋）。
 *
 * @module dsc-ui-transcript/ui/tool-card/factory.spec
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { ToolCallView } from '@dsc/ui'
import { RuntimeProvider, type HostChannel } from '@dsc/ui-runtime'
import type { ToolEntry } from '../shared.js'
import { IntendedPreview, ToolCardView } from './factory.js'
import type { ReadImageCall } from './read-image-model.js'

// ── 渲染的桩与环境 ─────────────────────────────────────────────────────────────

/**
 * jsdom 没有 `ResizeObserver`（factory 的吸附快捷栏量高要用）。桩只保证「能 new、能挂」，
 * 量出来的尺寸恒 0——那是 jsdom 没有布局引擎的自然结果，这里只验装配，不验量高。
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver)

/** 假宿主通道：这批卡不 invoke，订阅面给空实现就够。 */
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

/** 一条工具条目：名字 + 参数 + 可选的结果与状态。 */
function entryOf(call: Partial<ToolCallView> & Pick<ToolCallView, 'name' | 'argsText'>): ToolEntry {
  return { kind: 'tool', id: 1, call: { callId: 'c1', status: 'done', ...call } }
}

const readEntry = entryOf({
  name: 'read',
  argsText: JSON.stringify({ path: 'sample.txt', offset: 3, limit: 5 }),
  resultText: 'D:\\work\\sample.txt\n3\t第三行的原文\n4\t第四行的原文\n5\t第五行的原文\n7\t第七行的原文\n…（共 300 行，可用 offset/limit 续读）',
})
const grepEntry = entryOf({
  name: 'grep',
  argsText: JSON.stringify({ pattern: 'needle' }),
  resultText: 'src/a.ts:12: const needle = 1\nsrc/b.md:3: needle 在这里',
})
const todoEntry = entryOf({
  name: 'todo_write',
  argsText: JSON.stringify({ todos: [{ id: 'a1', content: '写单测', status: 'completed' }] }),
  resultText: '清单已更新（1/1 完成）\n[x] a1 写单测',
})
const bashEntry = entryOf({
  name: 'bash',
  argsText: JSON.stringify({ command: 'pnpm run build' }),
  resultText: '退出码 3\n输出一行',
})
const unknownEntry = entryOf({ name: 'mcp_unknown_tool', argsText: '{"key":"值"}', resultText: '第一行\n第二行\n第三行' })

/** 渲染一张卡（默认对话页；`trace` 就传 'trace'）。 */
function renderCard(entry: ToolEntry, variant: 'chat' | 'trace' = 'chat'): ReturnType<typeof render> {
  return render(
    <RuntimeProvider channel={fakeChannel()}>
      <ToolCardView entry={entry} variant={variant} />
    </RuntimeProvider>,
  )
}

/** 展开一张卡（收起态点头行那一段文字）。 */
function expand(card: ReturnType<typeof render>): void {
  fireEvent.click(card.container.querySelector('.tool-click') as HTMLElement)
}

afterEach(cleanup)

// ── 对话页：五张专用卡各自被选中（判据 = 名字 + 参数 + 对话页） ───────────────

test('read / grep / todo_write / bash 在对话页各出各的专用卡（判据三件齐才选）', () => {
  for (const [entry, marker] of [
    [readEntry, 'tc-read'],
    [grepEntry, 'tc-search'],
    [todoEntry, 'tc-todo'],
    [bashEntry, 'tc-bash'],
  ] as const) {
    const card = renderCard(entry)
    expand(card)
    expect(card.container.querySelector(`.${marker}`), `${marker} 卡体应出现`).not.toBeNull()
    card.unmount()
  }
})

test('轨迹页（trace）不走专用卡：摊原始参数 JSON 与结果原文', () => {
  const card = renderCard(readEntry, 'trace')
  expand(card)
  // 反向钉：轨迹页那一支里一个专用卡类名都不许出现。
  for (const cls of ['tc-bash', 'tc-read', 'tc-search', 'tc-todo', 'tc-web', 'tc-shot']) {
    expect(card.container.querySelector(`.${cls}`), `轨迹页不应出现 .${cls}`).toBeNull()
  }
  // 轨迹页的取证职责：参数原文（prettyJson 格式化）+ 结果原文都在。
  expect(card.container.textContent).toContain('参数')
  expect(card.container.textContent).toContain('"sample.txt"')
  expect(card.container.textContent).toContain('第三行的原文')
})

test('收起态不铺卡体，点开后才出现（三个卡体都挂在展开体里）', () => {
  const card = renderCard(readEntry)
  expect(card.container.querySelector('.tc-read'), '收起态不应有 read 卡体').toBeNull()
  expect(card.container.querySelector('.tool-body'), '收起态没有展开体').toBeNull()
  expand(card)
  expect(card.container.querySelector('.tool-body')).not.toBeNull()
  expect(card.container.querySelector('.tc-read-lines')).not.toBeNull()
})

test('头行读数都在可点展开的那一段里（摘要之后、状态之前）', () => {
  const read = renderCard(readEntry)
  const click = read.container.querySelector('.tool-click') as HTMLElement
  expect(click.querySelector('.tc-range')?.textContent).toBe('第 3–7 行')
  read.unmount()
  const search = renderCard(grepEntry)
  expect((search.container.querySelector('.tool-click') as HTMLElement).querySelector('.tc-hit-count')?.textContent).toContain('2 处')
  search.unmount()
  const todo = renderCard(todoEntry)
  expect((todo.container.querySelector('.tool-click') as HTMLElement).querySelector('.tc-todo-progress')?.textContent).toContain('1/1 完成')
})

test('专用卡不再画「+N 行」；通用卡照旧（同一件事不说两遍）', () => {
  // read 卡带一份多行结果：头行有区间读数，不再叠「+N 行」。
  const read = renderCard(readEntry)
  expect(read.container.querySelector('.tc-more')).toBeNull()
  read.unmount()
  // 通用卡同一份多行结果：收起态仍画「+N 行」说明点开还有更多。
  const generic = renderCard(unknownEntry)
  // resultTail 的 hidden 口径：有内容的行数 − 摊出来的行数（收起态摊 0 行，三行全记 hidden）。
  expect(generic.container.querySelector('.tc-more')?.textContent).toBe('+3 行')
})

test('对话页通用卡展开体仍是「输入 / 输出」两段', () => {
  const card = renderCard(unknownEntry)
  expand(card)
  const text = card.container.textContent ?? ''
  expect(text).toContain('输入')
  expect(text).toContain('输出')
  expect(text).toContain('值')
})

// ── 路径按钮挡冒泡 ─────────────────────────────────────────────────────────────

test('头行路径按钮点了不折卡也不展开卡（挡冒泡）', () => {
  // 路径按钮住在对话页选用的摘要组件里（IntendedPreview）；fallback 的 SummaryPreview 是纯文本。
  const { container, unmount } = render(
    <RuntimeProvider channel={fakeChannel()}>
      <ToolCardView entry={readEntry} variant="chat" Preview={IntendedPreview} cwd="D:\\work" />
    </RuntimeProvider>,
  )
  expect(container.querySelector('.tool-card.open')).toBeNull()
  fireEvent.click(container.querySelector('.tc-path') as HTMLElement)
  expect(container.querySelector('.tool-card.open'), '点路径不该把卡展开').toBeNull()
  unmount()
})

// ── web 卡的装配（原探针 ui-tool-web [4] 的装配半边） ─────────────────────────

test('web 卡：头行读数（条数 / HTTP）与展开体都由装配选中', () => {
  const search = entryOf({
    name: 'web_search',
    argsText: JSON.stringify({ query: 'pneuma' }),
    resultText: '1. 标题\nhttps://a.example/one\n摘要',
  })
  const card = renderCard(search)
  expect((card.container.querySelector('.tool-click') as HTMLElement).querySelector('.tc-web-count')?.textContent).toContain('1 条结果')
  expand(card)
  expect(card.container.querySelector('.tc-web-sources')).not.toBeNull()
})

// ── 图片卡的装配（需要 cwd 拼绝对路径；不触发读盘：结果没落地时不 invoke） ─────

test('read_image 卡在对话页被装配选中，头行有格式读数', () => {
  const shot = entryOf({
    name: 'read_image',
    argsText: JSON.stringify({ path: 'shot.png' }),
    resultText: '已加载图片 D:\\work\\shot.png（image/png，12288 字节）',
  })
  const card = renderCard(shot)
  expect(card.container.querySelector('.tc-shot-badge')?.textContent).toContain('PNG')
  // 图片卡体在展开体里；展开后（done）会向 dock 现读——这里只验装配选中与挂载不崩。
  expand(card)
  expect(card.container.querySelector('.tc-shot')).not.toBeNull()
})

// ── 名字是空串（null 事故修好后的形状）：卡照常渲染，不抛 ─────────────────────

test('工具名是空串（宿主把 null 修成空串）→ 通用卡照画，整页不崩', () => {
  const card = renderCard(entryOf({ name: '', argsText: '{"x":1}', resultText: '未知工具：null' }))
  // 认不出的名字带原名补注；空串不画分隔点（factory 的 `match.known || call.name === ''`）。
  expect(card.container.querySelector('.name')).toBeNull()
  expand(card)
  expect(card.container.querySelector('.tool-body')).not.toBeNull()
})

test('图片卡的名字判据只认 read_image（名字不匹配不走这张卡）', () => {
  const wrong = renderCard(entryOf({
    name: 'read',
    argsText: JSON.stringify({ path: 'shot.png' } satisfies ReadImageCall),
  }))
  expect(wrong.container.querySelector('.tc-shot-badge')).toBeNull()
})
