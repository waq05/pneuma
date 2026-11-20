/**
 * 会话导出（`packages/commands/session-export.ts`）的序列化分支补齐：
 * 围栏升级、工具结果截断、assistant 工具调用段、tool 结果段、system 跳过。
 *
 * 纯函数，不碰盘；消息按 `ChatMessage` 协议形状手造。
 *
 * @module @pneuma/commands/tests/session-export-branches
 */
import { describe, expect, test } from 'vitest'
import type { ChatMessage } from '../../../core/llm.js'
import { DEFAULT_TOOL_CHAR_BUDGET, exportSessionMarkdown, truncateToolOutput } from '../session-export.js'

/** 会话头：id / cwd / 创建时间。 */
const input = { id: 'abcdef1234567890', cwd: '/work/demo', createdAt: Date.UTC(2026, 0, 2, 3, 4) }

describe('truncateToolOutput', () => {
  test('预算内原样返回', () => {
    expect(truncateToolOutput('short', 100)).toBe('short')
  })

  test('超预算：留头 70% 与尾 20%，中间注明原长', () => {
    const text = 'x'.repeat(100)
    const out = truncateToolOutput(text, 10)
    // 头 7 字符 + 尾 2 字符，其余被省略
    expect(out.startsWith('x'.repeat(7))).toBe(true)
    expect(out.endsWith('x'.repeat(2))).toBe(true)
    expect(out).toContain('中间截断，原长 100 字符')
  })

  test('默认预算 2000 字符：1999 原样、2001 截断', () => {
    expect(truncateToolOutput('y'.repeat(1999))).toHaveLength(1999)
    expect(truncateToolOutput('y'.repeat(2001))).toContain('原长 2001 字符')
    expect(DEFAULT_TOOL_CHAR_BUDGET).toBe(2000)
  })
})

describe('exportSessionMarkdown', () => {
  test('跳过 system；用户与助手正文成段；空助手正文不落标题', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '系统提示不该出现在导出里' },
      { role: 'user', content: '帮我看看构建' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '构建通过。' },
    ]
    const out = exportSessionMarkdown({ ...input, messages })
    expect(out).toContain('# 会话导出 abcdef12')
    expect(out).toContain('- 工作目录：/work/demo')
    expect(out).toContain('## 用户')
    expect(out).toContain('帮我看看构建')
    expect(out).not.toContain('系统提示不该出现在导出里')
    expect(out).toContain('## 助手')
    expect(out).toContain('构建通过。')
    // 空正文不产生第二个助手标题
    expect(out.match(/## 助手\n/g)).toHaveLength(1)
  })

  test('工具调用与结果：调用参数进围栏，工具结果带 call id 并截断', () => {
    const long = 'L'.repeat(50)
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
      },
      { role: 'tool', content: long, tool_call_id: 'call-1' },
      { role: 'tool', content: 'no-id-result', tool_call_id: '' },
    ]
    const out = exportSessionMarkdown({ ...input, messages }, 20)
    expect(out).toContain('## 助手 · 工具调用')
    expect(out).toContain('bash({"cmd":"ls"})')
    expect(out).toContain('## 工具结果（call-1）')
    expect(out).toContain('原长 50 字符')
    expect(out).toContain('## 工具结果\n')
    expect(out).toContain('no-id-result')
  })

  test('围栏内容里出现三连反引号时围栏加长，块不被截断', () => {
    const body = 'before\n```js\nconst a = 1\n```\nafter'
    // 围栏只包工具调用与工具结果：把带反引号的内容放进工具调用参数。
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: body } }],
      },
    ]
    const out = exportSessionMarkdown({ ...input, messages })
    // 最长连续反引号是 3，围栏要 4 个
    expect(out).toContain('````\n')
    expect(out).toContain('\n````\n')
    expect(out).toContain('before')
    expect(out).toContain('const a = 1')
  })

  test('空 cwd 显示「（未知）」；消息数写进头部', () => {
    const out = exportSessionMarkdown({ ...input, cwd: '', messages: [{ role: 'user', content: 'hi' }] })
    expect(out).toContain('- 工作目录：（未知）')
    expect(out).toContain('- 消息数：1')
  })
})
