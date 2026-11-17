/**
 * MCP 工具名清洗不能撞名（迁自 `scripts/mcp-name-test.mjs`，纯函数，不需要 build）。
 *
 * ## 为什么值得单开一条
 *
 * 工具名是工具目录的键：两个 server 的工具清洗成同一个名字，后注册的会把先注册的顶掉——
 * 模型看到的目录里少一条，按另一个名字调用时还可能打到错的工具。旧实现只把非法字符
 * 换成下划线，于是 `a.b` 与 `a_b`、`tool.name` 与 `tool_name` 都落到同一个名字上。
 *
 * ## 钉住四件事
 *
 *   ① 本来就合法的名字一个字节都不变（用户手上的风险配置与延后规则按名字匹配，不能跟着变）；
 *   ② 清洗过的片段各带 8 位短哈希，`a.b` 与 `a_b` 不再撞名，且同一输入永远得到同一个名字；
 *   ③ server 名与工具名两侧都适用（任一侧撞名都算撞）；
 *   ④ 超长名字照旧截断 + 哈希尾巴，长度不超 64。
 *
 * @module @pneuma/mcp/tests/mcp-name.spec
 */
import { describe, expect, test } from 'vitest'
import { mcpToolName } from '../mcp.js'

describe('① 合法名字原样保留', () => {
  test('普通名字一个字节都不变', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
  })

  test('带连字符与数字也不变', () => {
    expect(mcpToolName('my-server', 'get_v2')).toBe('mcp__my-server__get_v2')
  })
})

describe('② 清洗过的片段不撞名', () => {
  /** 点号与下划线清洗出来的两个名字（这一节反复用）。 */
  const dotted = mcpToolName('github', 'tool.name')
  const underscored = mcpToolName('github', 'tool_name')

  test('a.b 与 a_b 不再撞名', () => {
    expect(dotted).not.toBe(underscored)
  })

  test('清洗过的工具名带 8 位短哈希', () => {
    expect(dotted).toMatch(/^mcp__github__tool_name_[0-9a-f]{8}$/)
  })

  test('空格与点号得到不同的名字', () => {
    const spaced = mcpToolName('github', 'tool name')
    expect(spaced).not.toBe(dotted)
    expect(spaced).not.toBe(underscored)
  })

  test('同一个输入每次得到同一个名字（可重放）', () => {
    expect(mcpToolName('github', 'tool.name')).toBe(dotted)
  })
})

describe('③ server 名撞名同样要分开', () => {
  test('server 名 a.b 与 a_b 不撞名', () => {
    expect(mcpToolName('my.server', 'run')).not.toBe(mcpToolName('my_server', 'run'))
  })

  test('server 侧清洗也带短哈希', () => {
    expect(mcpToolName('my.server', 'run')).toMatch(/^mcp__my_server_[0-9a-f]{8}__run$/)
  })
})

describe('④ 超长名字：截断 + 尾巴哈希', () => {
  /** 两个只差最后一个字符的超长工具名。 */
  const longA = mcpToolName('server', 'x'.repeat(80))
  const longB = mcpToolName('server', 'x'.repeat(79) + 'y')

  test('超长名字不超 64 字符', () => {
    expect(longA.length).toBeLessThanOrEqual(64)
  })

  test('两个超长名字不撞名', () => {
    expect(longA).not.toBe(longB)
  })

  test('截断后的名字仍以 mcp__server__ 开头（前缀不被截掉）', () => {
    expect(longA.startsWith('mcp__server__')).toBe(true)
  })

  test('server 名超长也不超 64', () => {
    expect(mcpToolName('s'.repeat(70), 't').length).toBeLessThanOrEqual(64)
  })
})
