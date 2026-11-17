/**
 * 工具名册与摘要取词（ui 层）。
 *
 * 来源：`scripts/ui-process-grid-test.mjs` 第 [7] 段的行为部分（docs/ui-design.md §15 的
 * 「内容」档）。这三张卡原来读作「工具调用 · run_code」，标题没信息、摘要为空——修法是
 * 把常用工具收进名册、run_code 的摘要取 code 字段第一行。
 *
 * `KNOWN_TOOLS` / `SUMMARY_FIELDS` 是导出对象（手册 §2 方案 A：断言导出对象），
 * `toolSummary` 是导出函数（方案 B：走公开 API 取真实结果）。原探针其余段落全是
 * CSS 令牌与渲染体文本（--proc-* 栅格、:hover 不铺底、.step-fold-label 字号……），
 * 没有行为接缝，不迁——栅格对齐要靠截图（desktop/shots），那不是这一层该干的事。
 *
 * @module dsc-ui-primitives/ui/tool-summary.spec
 */
import { describe, expect, test } from 'vitest'
import { KNOWN_TOOLS, SUMMARY_FIELDS, toolSummary } from './tool-summary.js'

describe('KNOWN_TOOLS 名册', () => {
  // 缺一个就退化成「工具调用 · run_code」——标题没信息、摘要也取不到字段。
  test('这台机器跑得最多的几个工具都在名册里', () => {
    for (const name of ['run_code', 'pwsh', 'read_image', 'web_search']) {
      expect(KNOWN_TOOLS[name], `KNOWN_TOOLS 里有 ${name}`).toBeDefined()
    }
  })
})

describe('run_code 的摘要取 code 字段', () => {
  test('SUMMARY_FIELDS 的 run_code 取 code 字段', () => {
    expect(SUMMARY_FIELDS['run_code']).toContain('code')
  })

  test('code 字段取第一行（跳过空行与行首注释，不把整段脚本压成一行）', () => {
    const summary = toolSummary('run_code', JSON.stringify({ code: '// 批量查配置\nconst data = load();\nreturn data;' }))
    expect(summary).toBe('批量查配置')
    expect(summary).not.toContain('const data')
  })
})
