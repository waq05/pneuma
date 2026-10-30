/**
 * MCP 工具名清洗不能撞名（2026-10-30）。
 *
 * 工具名是目录的键：两个 server 工具清洗成同一个名字，后注册的会把先注册的顶掉——
 * 模型看到的目录里少一条，按另一个名字调用时还可能打到错的工具。
 * 旧实现只把非法字符换成下划线，于是 `a.b` 与 `a_b`、`tool.name` 与 `tool_name`
 * 都会落到同一个名字上。
 *
 * 钉住四件事：
 *   [1] 本来就合法的名字一个字节都不变（用户手上的风险配置与延后规则不受影响）；
 *   [2] 清洗过的片段各带 8 位短哈希，`a.b` 与 `a_b` 不再撞名；
 *   [3] server 名与工具名两侧都适用（任一侧撞名都算撞）；
 *   [4] 超长名字照旧截断 + 12 位哈希尾巴，长度不超 64、两个长名字不撞。
 *
 * 纯函数，不起内核、不连 server。用法：pnpm run build && node scripts/mcp-name-test.mjs
 *
 * @module dsc/scripts/mcp-name-test
 */
const { mcpToolName } = await import('../lib/core/mcp.js')

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

console.log('MCP 工具名清洗')

// ── [1] 合法名字原样保留 ─────────────────────────────────────────────────────
{
  check('普通名字一个字节都不变', mcpToolName('github', 'create_issue') === 'mcp__github__create_issue', mcpToolName('github', 'create_issue'))
  check('带连字符与数字也不变', mcpToolName('my-server', 'get_v2') === 'mcp__my-server__get_v2', mcpToolName('my-server', 'get_v2'))
}

// ── [2] 清洗过的片段不撞名 ───────────────────────────────────────────────────
{
  const dotted = mcpToolName('github', 'tool.name')
  const underscored = mcpToolName('github', 'tool_name')
  check('a.b 与 a_b 不再撞名', dotted !== underscored, `${dotted} / ${underscored}`)
  check('清洗过的工具名带 8 位短哈希', /^mcp__github__tool_name_[0-9a-f]{8}$/.test(dotted), dotted)
  const spaced = mcpToolName('github', 'tool name')
  check('空格与点号得到不同的名字', spaced !== dotted && spaced !== underscored, spaced)
  check('同一个输入每次得到同一个名字（可重放）', mcpToolName('github', 'tool.name') === dotted)
}

// ── [3] server 名撞名同样要分开 ─────────────────────────────────────────────
{
  const dot = mcpToolName('my.server', 'run')
  const under = mcpToolName('my_server', 'run')
  check('server 名 a.b 与 a_b 不撞名', dot !== under, `${dot} / ${under}`)
  check('server 侧清洗也带短哈希', /^mcp__my_server_[0-9a-f]{8}__run$/.test(dot), dot)
}

// ── [4] 超长名字：截断 + 尾巴哈希 ───────────────────────────────────────────
{
  const longA = mcpToolName('server', 'x'.repeat(80))
  const longB = mcpToolName('server', 'x'.repeat(79) + 'y')
  check('超长名字不超 64 字符', longA.length <= 64, String(longA.length))
  check('两个超长名字不撞名', longA !== longB, `${longA} / ${longB}`)
  check('截断后的名字仍以 mcp__server__ 开头', longA.startsWith('mcp__server__'), longA)
  const hugeServer = mcpToolName('s'.repeat(70), 't')
  check('server 名超长也不超 64', hugeServer.length <= 64, String(hugeServer.length))
}

console.log('')
console.log(`${String(pass)} PASS / ${String(fail)} FAIL`)
process.exit(fail === 0 ? 0 : 1)
