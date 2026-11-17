/**
 * `/review` 结论卡解析（`parseReviewFindings`）的行为用例（迁自
 * `scripts/ui-review-findings-test.mjs` 第 1 节「纯解析」）。
 *
 * 报障背景：审查队友交回的 `<review-findings …>` 汇报整段当用户消息摆出来，标记文本
 * 一坨不好读；解析成「卡头 + 按条 findings + 引言」后对话流才能画成卡片。
 *
 * 为什么是行为测试：`review-findings.ts` 零 React、零 DOM（只许 `import type`），
 * `parseReviewFindings` 的真跑结果就是被测行为——包裹识别、teammate/state 属性、
 * P0–P3 四档、位置 `path:line`、字段剥壳（加粗 / 反引号 / 列表前缀 / 全角冒号）、
 * 多行续写、解析不动的行不丢，全部用真实输入压。
 *
 * 不迁的部分（原探针第 2、3 节，见交付报告缺口清单）：
 *   - 「卡片只用 views.css 已有类名 + data-priority 四档」「四档徽标色都在」——样式与
 *     组件 JSX 的接缝，要真渲染才有行为，归组件渲染批；
 *   - 「基元包导出解析与卡片」「对话流的用户消息先认 findings 再画气泡」——barrel 与
 *     user-row 的接线文本钉，同样的归处。
 *
 * @module dsc-ui-primitives/ui/review-findings.spec
 */
import { describe, expect, test } from 'vitest'
import { parseReviewFindings } from './review-findings.js'

/** 照宿主 `deliverReview` 的拼法造一份 findings 正文。 */
const wrap = (attrs: string, body: string): string => `<review-findings ${attrs}>\n${body}\n</review-findings>`

/** 三条条目的样张：P0 / P1 / 写错档位的 P7，字段带多行续写与 markdown 剥壳形态。 */
const SAMPLE = wrap(
  'teammate="reviewer-1" state="已完成"',
  [
    '整体看过一遍，改动集中在 /review 这条链上。',
    '',
    '### [P0] 取消之后记录还会被覆盖',
    '位置：src/packages/subagent/index.ts:870',
    '说明：收工回调里无条件写 finished，取消的结论会被冲掉。',
    '续一句：这里要按 handle 比对。',
    '建议：给 finish 传队友名。',
    '### [P1] 路径没归一',
    '**位置**：`src/core/git-info.ts`：128',
    '- 建议：先归一化再比较。',
    '### [P7] 写错档位的一条',
    '说明：档位认不出也要把内容留住。',
  ].join('\n'),
)

describe('包裹识别：没被整体包裹就不是 findings', () => {
  test('没被包裹的普通消息返回 null', () => {
    expect(parseReviewFindings('### [P0] 标题\n位置：a.ts:1')).toBeNull()
  })

  test('只有开标签（没闭合）返回 null', () => {
    expect(parseReviewFindings('<review-findings teammate="r">\n### [P0] x')).toBeNull()
  })

  test('空串返回 null', () => {
    expect(parseReviewFindings('')).toBeNull()
  })
})

describe('属性、条目与档位', () => {
  const doc = parseReviewFindings(SAMPLE)

  test('整体包裹的报告被认出，读到 teammate 与 state', () => {
    expect(doc).not.toBeNull()
    expect(doc?.teammate).toBe('reviewer-1')
    expect(doc?.state).toBe('已完成')
  })

  test('三条条目按文档顺序', () => {
    expect(doc?.findings.map((item) => item.title)).toEqual([
      '取消之后记录还会被覆盖',
      '路径没归一',
      '写错档位的一条',
    ])
  })

  test('条目前的自由文字归 note', () => {
    expect(doc?.note.includes('整体看过一遍')).toBe(true)
  })

  test('P0–P3 四档解析成数字，认不出的档位记 undefined 但条目留着', () => {
    expect(doc?.findings.map((item) => item.priority)).toEqual([0, 1, undefined])
    expect(doc?.findings[2]?.title).toBe('写错档位的一条')
    expect(doc?.findings[2]?.priority).toBeUndefined()
  })

  test('标题里没有夹带方括号档位', () => {
    expect(doc?.findings[0]?.title).toBe('取消之后记录还会被覆盖')
  })
})

describe('字段：位置 / 说明 / 建议', () => {
  const doc = parseReviewFindings(SAMPLE)
  const first = doc?.findings[0]
  const second = doc?.findings[1]

  test('位置解析成 path:line', () => {
    expect(first?.location?.path).toBe('src/packages/subagent/index.ts')
    expect(first?.location?.line).toBe(870)
  })

  test('说明多行续写不丢', () => {
    expect(first?.detail.includes('无条件写 finished')).toBe(true)
    expect(first?.detail.includes('按 handle 比对')).toBe(true)
  })

  test('建议单独成段', () => {
    expect(first?.suggestion).toBe('给 finish 传队友名。')
  })

  test('加粗 + 反引号 + 全角冒号的位置也认', () => {
    expect(second?.location?.path).toBe('src/core/git-info.ts')
    expect(second?.location?.line).toBe(128)
  })

  test('列表前缀的建议也认（`- 建议：`）', () => {
    expect(second?.suggestion).toBe('先归一化再比较。')
  })
})

describe('边界：没有条目 / 建议续行', () => {
  test('没有条目时 findings 为空、正文进 note', () => {
    const clean = parseReviewFindings(
      wrap('teammate="reviewer-2" state="已完成"', '没有发现问题。查了 git-info.ts 与 commands.ts。'),
    )
    expect(clean?.findings).toHaveLength(0)
    expect(clean?.note.includes('没有发现问题')).toBe(true)
  })

  test('建议的续行仍在建议里（不跑到说明去）', () => {
    const doc = parseReviewFindings(
      wrap('teammate="r"', ['### [P2] 一个边界', '建议：第一句。', '第二句也属于建议。'].join('\n')),
    )
    expect(doc?.findings[0]?.suggestion).toBe('第一句。 第二句也属于建议。')
  })
})
