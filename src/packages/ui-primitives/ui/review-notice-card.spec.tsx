/**
 * 「文件更改预览」通知卡（`review-notice-card.tsx`）的渲染段（ui 层，真渲染）。
 *
 * 来源：`scripts/ui-review-notice-test.mjs` 第 [6] 段（缺口清单 B37）。原探针钉卡片源码里的
 * `useState(false)` / `aria-expanded` / `hidden={!open}` / 动作词与类名文本；这里真渲染：
 * - 默认收起，头行是按钮、带 `aria-expanded` / `aria-controls`，正文走 `hidden`；
 * - 点一下展开、再点收起，`data-open` 与正文 `hidden` 同步；
 * - 没有 diff 正文时头行点不动、也不画箭头；
 * - 增删计数复用 `.changes-counts`，算不出时退到中性原文；
 * - 动作词与人话（新建文件 / 编辑文件）、路径展示口径。
 *
 * 不迁的（见交付报告缺口清单）：views.css 的对齐 / 限高 / 三色令牌是样式表文本钉
 * （jsdom 不应用样式表），转 shots；第 [5] 段「壳常量 == 宿主源码字面量」是契约漂移钉，
 * 宿主那份拼文本代码没有导出，归契约/产物批；第 [7] 段插件边界的相对导入扫描同理。
 *
 * @module dsc-ui-primitives/ui/review-notice-card.spec
 */
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { REVIEW_NOTICE_BANNER, parseReviewNotice, type ReviewNotice } from './review-notice.js'
import { ReviewNoticeCard } from './review-notice-card.js'

afterEach(cleanup)

/** 头行模板：`${前缀}${verb} ${path}（${counts}）`。 */
const noticeOf = (head: string, ...lines: string[]): ReviewNotice => {
  const parsed = parseReviewNotice([head, ...lines].join('\n'))
  if (parsed === null) throw new Error('样张没被解析成通知')
  return parsed
}

const HEAD = (verb: string, path: string, counts: string): string =>
  `${REVIEW_NOTICE_BANNER}${verb} ${path}（${counts}）`

const query = (container: HTMLElement, selector: string): HTMLElement => {
  const found = container.querySelector(selector)
  if (found === null) throw new Error(`没有找到 ${selector}`)
  return found as HTMLElement
}

describe('默认收起：一次写入只占一行', () => {
  const created = (): ReviewNotice =>
    noticeOf(HEAD('新建', 'E:/fallout4/自我介绍.md', '+76 行 / -0 行'), '@@ -0,0 +1,76 @@', '+# 标题')

  test('根节点、动作词、路径、计数都在；正文默认 hidden', () => {
    const { container } = render(<ReviewNoticeCard notice={created()} cwd="" />)
    expect(query(container, '.entry-review').getAttribute('data-action')).toBe('create')
    expect(query(container, '.entry-review').getAttribute('data-open')).toBe('false')
    expect(query(container, '.entry-review-verb').textContent).toBe('新建文件')
    expect(query(container, '.entry-review-path').textContent).toBe('E:/fallout4/自我介绍.md')
    expect(query(container, '.changes-added').textContent).toBe('+76 行')
    expect(query(container, '.changes-removed').textContent).toBe('-0 行')
    expect(query(container, '.entry-review-diff').hasAttribute('hidden')).toBe(true)
  })

  test('头行是按钮：aria-expanded=false、aria-controls 指向正文；点一下展开再点收起', () => {
    const { container } = render(<ReviewNoticeCard notice={created()} cwd="" />)
    const head = query(container, '.entry-review-head')
    expect(head.getAttribute('aria-expanded')).toBe('false')
    const body = query(container, '.entry-review-diff')
    expect(head.getAttribute('aria-controls')).toBe(body.id)
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(query(container, '.entry-review').getAttribute('data-open')).toBe('true')
    expect(body.hasAttribute('hidden')).toBe(false)
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(body.hasAttribute('hidden')).toBe(true)
  })

  test('正文逐行按 data-kind 画（hunk / add），文本原样不加工', () => {
    const { container } = render(<ReviewNoticeCard notice={created()} cwd="" />)
    fireEvent.click(query(container, '.entry-review-head'))
    const lines = [...container.querySelectorAll('.entry-review-line')] as HTMLElement[]
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual(['hunk', 'add'])
    expect(lines[1]?.textContent).toBe('+# 标题')
  })
})

describe('没有正文 / 算不出计数时不给死交互', () => {
  test('只有头行：箭头不画、头行不可点（点了也不展开）', () => {
    const notice = noticeOf(`${REVIEW_NOTICE_BANNER}莫名其妙的一行`, '+x')
    // 这条其实有正文（+x）；换一条真的没有正文的：头行 + 空。
    const bare = noticeOf(`${REVIEW_NOTICE_BANNER}莫名其妙的一行`)
    const { container } = render(<ReviewNoticeCard notice={bare} cwd="" />)
    expect(container.querySelector('.entry-review-diff')).toBeNull()
    expect(container.querySelector('.entry-review-chevron')).toBeNull()
    const head = query(container, '.entry-review-head')
    expect(head.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    // 同时确认带正文的那条确实会画箭头（对照组）。
    const mixed = render(<ReviewNoticeCard notice={notice} cwd="" />)
    expect(mixed.container.querySelector('.entry-review-chevron')).toBeTruthy()
  })

  test('算不出逐行 diff：计数位置改画中性原文（不装成 +0/-0）', () => {
    const notice = noticeOf(HEAD('修改', 'a.ts', '逐行 diff 未给出'), '（改动区间过大，只给摘要）')
    const { container } = render(<ReviewNoticeCard notice={notice} cwd="" />)
    expect(container.querySelector('.changes-counts')).toBeNull()
    expect(query(container, '.entry-review-counts').textContent).toBe('逐行 diff 未给出')
  })

  test('头行形状认不出：动作词不画，路径位置退回通知头行原文', () => {
    const notice = noticeOf(`${REVIEW_NOTICE_BANNER}莫名其妙的一行`, '+x')
    const { container } = render(<ReviewNoticeCard notice={notice} cwd="" />)
    expect(container.querySelector('.entry-review-verb')).toBeNull()
    expect(query(container, '.entry-review-path').textContent).toBe(`${REVIEW_NOTICE_BANNER}莫名其妙的一行`)
  })

  test('编辑动作的词是「编辑文件」，样张里没有写单复数/动词混用', () => {
    const notice = noticeOf(HEAD('修改', 'src/a.ts', '+3 行 / -2 行'), '-旧', '+新')
    const { container } = render(<ReviewNoticeCard notice={notice} cwd="" />)
    expect(query(container, '.entry-review-verb').textContent).toBe('编辑文件')
  })
})
