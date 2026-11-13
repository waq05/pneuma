/** commands 包级测试：插件对象 + 两个纯函数（/status、/usage 的文本组装）+ 内置命令清单。
 * 读 lib/ 产物，先 pnpm run build。单独跑：node src/packages/commands/tests/commands.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { commandsPlugin, runCommand, statusReport, usageReport } = await import(new URL('../../../../lib/packages/commands/index.js', import.meta.url).href)
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('插件对象：名字、提供服务、两个注入', () => {
  assert.deepEqual([commandsPlugin.name, commandsPlugin.provide], ['commands', 'commands'])
  assert.deepEqual([...commandsPlugin.inject], ['session', 'llm'])
  assert.equal(typeof commandsPlugin.apply, 'function')
})
check('/status 文本按窗口算占用与还差多少', () => {
  const text = statusReport({ provider: 'deepseek', model: 'chat', window: 100_000, tokens: 50_000, messageCount: 12, toolCount: 3, autoCompactPercent: 80 })
  for (const expected of [/窗口 100,000/, /约占窗口 50%/, /还差 30,000/]) assert.match(text, expected)
})
check('/usage 没有记录时直说，有记录时换算 M/k 与缓存命中率', () => {
  assert.match(usageReport({ totalTurns: 0 }), /还没有用量记录/)
  const text = usageReport({ totalTurns: 3, activeDays: 2, totalInputTokens: 1_500_000, totalOutputTokens: 2_000, totalCacheHitTokens: 1_000,
    totalCacheMissTokens: 3_000, peakDay: null, currentStreakDays: 2, longestStreakDays: 5, models: [] })
  assert.match(text, /输入 1\.5M \/ 输出 2\.0k/)
  assert.match(text, /前缀缓存命中：25%/)
})
check('二十四个内置命令都用 builtinSpec(名字) 注册，顺序固定', () => {
  const names = [...source.matchAll(/builtinSpec\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual(names, [
    'help', 'new', 'resume', 'agents', 'settings', 'model', 'status', 'usage', 'export', 'review', 'review-status', 'review-cancel',
    'diff', 'copy', 'policy', 'reviewer', 'permission', 'effort', 'fork', 'thinking', 'plugins', 'update', 'ui-trust', 'exit',
  ])
})
check('没有插件实例时 runCommand 不派发也不抛', () => {
  assert.equal(runCommand('/help', {}, {}), false)
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
