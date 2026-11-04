/** web-search 包级测试：插件对象 + web_search 工具 schema。读 lib/ 产物，先 pnpm run build。
 * 工具只在配了 key 时才注册，schema 那段按源码断言。单独跑：node src/packages/web-search/tests/web-search.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { webSearchPlugin } = await import(new URL('../../../../lib/packages/web-search/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}

check('插件对象：名字与它依赖的三个服务', () => {
  assert.equal(webSearchPlugin.name, 'web-search')
  assert.deepEqual([...webSearchPlugin.inject], ['tools', 'prompt', 'settings'])
  assert.equal(typeof webSearchPlugin.apply, 'function')
})
check('工具叫 web_search，风险等级是只读', () => {
  assert.match(source, /name: 'web_search'/)
  assert.match(source, /risk: 'read'/)
})
check('schema 根是 object，必填只有 query', () => {
  assert.match(source, /parameters: \{\s*\r?\n\s*type: 'object'/)
  assert.match(source, /required: \['query'\]/)
})
check('三个入参都在：query / includeDomains / excludeDomains', () => {
  assert.match(source, /query: \{ type: 'string'/)
  assert.match(source, /includeDomains: \{/)
  assert.match(source, /excludeDomains: \{/)
})
check('域名过滤参数的语义写在说明里：只有 tavily 生效', () => {
  assert.match(source, /当前提供方为 tavily 时生效/)
})

console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
