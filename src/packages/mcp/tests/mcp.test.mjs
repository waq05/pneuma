/** mcp 包级测试：插件对象 + 两个能力工具的 schema + 设置分区（按源码断言，不真连 server）。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/mcp/tests/mcp.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { mcpPlugin } = await import(new URL('../../../../lib/packages/mcp/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('插件对象：名字、六个注入；服务在 apply 里挂（对象本身没有 provide）', () => {
  assert.equal(mcpPlugin.name, 'mcp')
  assert.equal(mcpPlugin.provide, undefined)
  assert.deepEqual([...mcpPlugin.inject], ['tools', 'transcript', 'settings', 'prompt', 'approval', 'session'])
  assert.match(source, /ctx\.provide\('mcp', buildService\(\)\)/)
})
check('两个能力工具各自的动作枚举', () => {
  assert.match(source, /name: 'mcp_resources'/)
  assert.match(source, /enum: \['list', 'read'\]/)
  assert.match(source, /name: 'mcp_prompts'/)
  assert.match(source, /enum: \['list', 'get'\]/)
})
check('两个能力工具都是只读风险，required 只有 action', () => {
  assert.equal((source.match(/risk: 'read'/g) ?? []).length, 2)
  assert.equal((source.match(/required: \['action'\]/g) ?? []).length, 2)
})
check('设置分区 id=mcp、order=47，defaultRisk 三档 read/write/exec', () => {
  assert.match(source, /CONFIG_KEY = 'mcp'/)
  assert.match(source, /order: 47/)
  for (const risk of ['exec', 'write', 'read']) assert.match(source, new RegExp(`value: '${risk}'`))
})
check('超时、重连与 elicitation 等卡的缺省值', () => {
  for (const snippet of [/callTimeoutMs: 60_000/, /connectTimeoutMs: 20_000/, /reconnectMaxAttempts: 5/, /ELICITATION_TIMEOUT_MS = 600_000/]) assert.match(source, snippet)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
