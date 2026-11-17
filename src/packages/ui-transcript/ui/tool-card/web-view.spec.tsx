/**
 * web 工具卡渲染体的渲染断言（ui 层）。
 *
 * 来源：`scripts/ui-tool-web-test.mjs` 第 [4] 段里「装配与渲染体」的那一半（`web-view.tsx`
 * 是 TSX，探针只能读源码钉类名与分支写法）。真渲染下这些钉全部有行为等价物：
 *
 * - 「还在跑才画占位（call.status === running）」→ running + 结果未到 → 「正在搜索 / 正在抓取」；
 *   done + 结果认不出 → 摊结果原文（`tc-web-raw`），不画空壳；
 * - 「摘要段有取词（webAnswer 的落点）」→ 带 `answer` 的卡渲染出 `.tc-web-answer`；
 * - 「外链口径」→ http(s) 画成 `<a target="_blank">`，`javascript:` / `data:` 画成同款样子的
 *   纯文本 `<span>`（没有 href，点不动）——点错一次是执行别人的脚本，这条必须钉在 DOM 上；
 * - 「类名只用清单里的 11 个」→ 渲染全部档位后枚举 DOM 上出现的 `tc-web*` 类名，逐个对清单。
 *
 * 判据与解析的**数据**半边（`web-model.ts`）已由 `web-model.spec.ts` 覆盖，这里只管画。
 *
 * @module dsc-ui-transcript/ui/tool-card/web-view.spec
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { ToolCallView } from '@dsc/ui'
import { webCallOf, webResultOf, type WebResult } from './web-model.js'
import { WebBody, WebCount } from './web-view.js'

afterEach(cleanup)

/** 一条 web 调用（名字 + 参数），状态与结果按用例给。 */
function callOf(name: string, argsText: string, over: Partial<ToolCallView> = {}): ToolCallView {
  return { callId: 'c1', name, argsText, status: 'done', ...over }
}

/** 结构化搜索结果：两条来源 + 摘要 + 截断。 */
function searchResult(over: Partial<Extract<WebResult, { kind: 'search' }>> = {}): WebResult {
  return {
    kind: 'search',
    sources: [
      { url: 'https://a.example/one', title: '第一条', snippet: '摘要一' },
      { url: 'https://b.example/two', title: null, snippet: null },
    ],
    answer: '提供方给的整段摘要',
    notes: [],
    truncated: true,
    ...over,
  }
}

// ── 头行读数（WebCount） ──────────────────────────────────────────────────────

test('搜索卡头行：有来源说条数，零来源说「没有结果」', () => {
  const card = render(<WebCount result={searchResult()} />)
  expect(card.container.textContent).toContain('2 条结果')
  card.unmount()
  const none = render(<WebCount result={searchResult({ sources: [], answer: null, truncated: false })} />)
  expect(none.container.textContent).toContain('没有结果')
})

test('抓取卡头行说 HTTP 状态码；还没有状态码（刚回来）什么都不画', () => {
  const fetchResult = webResultOf(
    webCallOf('webfetch', '{"url":"https://example.com/a"}'),
    { result: { card: 'web', kind: 'fetch', url: 'https://example.com/a', statusCode: 404 } },
    undefined,
  )
  expect(fetchResult?.kind).toBe('fetch')
  const card = render(<WebCount result={fetchResult} />)
  expect(card.container.textContent).toBe('HTTP 404')
  card.unmount()
  const noStatus = render(<WebCount result={{ kind: 'fetch', url: 'https://example.com/a', statusCode: null, notes: [], truncated: false }} />)
  expect(noStatus.container.textContent).toBe('')
})

// ── 三种「还没有内容」分开画 ──────────────────────────────────────────────────

test('还在跑：一句「正在搜索 / 正在抓取」占位（按调用档位选）', () => {
  const searching = render(
    <WebBody call={callOf('web_search', '{"query":"pneuma"}', { status: 'running' })} kind="search" result={null} />,
  )
  expect(searching.container.querySelector('.tc-web-note')?.textContent).toBe('正在搜索')
  searching.unmount()
  const fetching = render(
    <WebBody call={callOf('webfetch', '{"url":"https://e.com"}', { status: 'running' })} kind="fetch" result={null} />,
  )
  expect(fetching.container.querySelector('.tc-web-note')?.textContent).toBe('正在抓取')
})

test('跑完了但结果认不出：摊结果原文（tc-web-raw），不留空壳', () => {
  const card = render(
    <WebBody call={callOf('web_search', '{"query":"pneuma"}', { resultText: 'HTTP 429：too many requests' })} kind="search" result={null} />,
  )
  expect(card.container.querySelector('.tc-web-raw')?.textContent).toBe('HTTP 429：too many requests')
})

test('跑完了、原文也是空的：整格不画（连 .tc-web 都不挂）', () => {
  const card = render(<WebBody call={callOf('web_search', '{"query":"pneuma"}', { resultText: '   ' })} kind="search" result={null} />)
  expect(card.container.querySelector('.tc-web')).toBeNull()
})

// ── 搜索卡展开体 ──────────────────────────────────────────────────────────────

test('摘要段 + 来源有序清单：标题是链接、摘要、无标题来源用 URL 当标签', () => {
  const card = render(<WebBody call={callOf('web_search', '{"query":"pneuma"}')} kind="search" result={searchResult()} />)
  const answer = card.container.querySelector('.tc-web-answer')
  expect(answer?.textContent).toBe('提供方给的整段摘要')
  expect(answer?.getAttribute('title')).not.toBe('')
  const items = card.container.querySelectorAll('.tc-web-source')
  expect(items).toHaveLength(2)
  const first = items[0] as HTMLElement
  expect(first.querySelector('a')?.getAttribute('href')).toBe('https://a.example/one')
  expect(first.querySelector('a')?.getAttribute('target')).toBe('_blank')
  expect(first.querySelector('.tc-web-snippet')?.textContent).toBe('摘要一')
  // 第二条没有标题：标签落成 URL 本身（一个字的标题画出来是一条看不见的链接）。
  expect(items[1]?.querySelector('.tc-web-link')?.textContent).toBe('https://b.example/two')
  // 截断说明（truncated: true）：webTruncated 的中文文案带「只列了前 N 条」。
  expect(card.container.textContent).toContain('只列了前 2 条')
})

test('零来源的搜索卡：一句「没有结果」+ 宿主尾注（notes 一句一段）', () => {
  const card = render(
    <WebBody
      call={callOf('web_search', '{"query":"pneuma"}')}
      kind="search"
      result={searchResult({ sources: [], answer: null, truncated: false, notes: ['没有搜到结果。换个更具体的关键词再试。'] })}
    />,
  )
  const notes = card.container.querySelectorAll('.tc-web-note')
  expect(notes[0]?.textContent).toBe('没有结果')
  expect(notes[1]?.textContent).toContain('没有搜到结果')
})

// ── 抓取卡展开体 ──────────────────────────────────────────────────────────────

test('抓取卡：一条链接 + 状态码；内容截断有单独一句', () => {
  const card = render(
    <WebBody
      call={callOf('webfetch', '{"url":"https://example.com/a"}')}
      kind="fetch"
      result={{ kind: 'fetch', url: 'https://example.com/a', statusCode: 200, notes: [], truncated: true }}
    />,
  )
  expect(card.container.querySelector('.tc-web-fetch a')?.getAttribute('href')).toBe('https://example.com/a')
  expect(card.container.querySelector('.tc-web-status')?.textContent).toBe('HTTP 200')
  expect(card.container.querySelector('.tc-web-note')?.textContent).not.toBe('')
})

// ── 外链口径：只有 http(s) 能点 ───────────────────────────────────────────────

test('javascript: / data: 画成同款样子的纯文本（没有 href，点不动）', () => {
  const evil = searchResult({
    sources: [
      { url: 'javascript:alert(1)', title: '坏链接', snippet: null },
      { url: 'data:text/html,<script>', title: null, snippet: null },
    ],
    answer: null,
    truncated: false,
  })
  const card = render(<WebBody call={callOf('web_search', '{"query":"x"}')} kind="search" result={evil} />)
  const links = card.container.querySelectorAll('.tc-web-link')
  expect(links).toHaveLength(2)
  for (const link of links) {
    expect(link.tagName).toBe('SPAN')
    expect(link.getAttribute('href')).toBeNull()
  }
})

// ── 类名清单：DOM 上出现的 web 类名都在探针那张单子里 ─────────────────────────

test('全部档位渲染后，DOM 上出现的类名都在清单里（写错名字等于没样式）', () => {
  const ALLOWED = new Set([
    'tc-web-count',
    'tc-web',
    'tc-web-answer',
    'tc-web-sources',
    'tc-web-source',
    'tc-web-link',
    'tc-web-snippet',
    'tc-web-fetch',
    'tc-web-status',
    'tc-web-note',
    'tc-web-raw',
  ])
  const search = searchResult()
  const fixtures: [ToolCallView, 'search' | 'fetch', WebResult | null][] = [
    [callOf('web_search', '{"query":"p"}', { status: 'running' }), 'search', null],
    [callOf('web_search', '{"query":"p"}'), 'search', search],
    [callOf('web_search', '{"query":"p"}'), 'search', searchResult({ sources: [], answer: null, truncated: false })],
    [callOf('web_search', '{"query":"p"}'), 'search', null],
    [callOf('webfetch', '{"url":"https://e.com"}'), 'fetch', { kind: 'fetch', url: 'https://example.com/a', statusCode: 404, notes: [], truncated: true }],
    [callOf('webfetch', '{"url":"https://e.com"}', { resultText: '坏了' }), 'fetch', null],
    [callOf('webfetch', '{"url":"https://e.com"}'), 'fetch', { kind: 'fetch', url: 'https://e.com', statusCode: null, notes: ['尾注'], truncated: false }],
  ]
  const seen = new Set<string>()
  for (const [call, kind, result] of fixtures) {
    const { container, unmount } = render(<WebBody call={call} kind={kind} result={result} />)
    for (const node of container.querySelectorAll<HTMLElement>('[class*="tc-web"]')) {
      for (const name of node.className.split(' ')) {
        if (name.startsWith('tc-web')) seen.add(name)
      }
    }
    unmount()
  }
  expect(seen.size).toBeGreaterThan(0)
  const unknown = [...seen].filter((name) => !ALLOWED.has(name))
  expect(unknown, `清单外的类名：${unknown.join('、')}`).toEqual([])
})
