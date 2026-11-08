/**
 * 临时诊断：市场浏览到底慢在哪一步。
 *
 * 用法：node scripts/_market-speed-check.mjs
 * 只读，不写任何目录（缓存写在临时 HOME 里，跑完删）。
 *
 * @module dsc/scripts/_market-speed-check
 */
const { browseMarketSource } = await import('../lib/node_modules/@pneuma/config-core/market.js')

const sources = [
  { name: 'anthropics', url: 'https://github.com/anthropics/skills/tree/main/skills' },
  { name: 'dsh', url: 'https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/skills' },
  { name: 'ClawHub', url: 'https://clawhub.ai/api/v1/skills?sort=downloads&limit=100' },
  { name: 'skills.sh', url: 'https://skills.sh/api/search' },
]

for (const source of sources) {
  const started = Date.now()
  try {
    const entries = await browseMarketSource(source, { refresh: true, query: 'git' })
    console.log(`${String(Date.now() - started).padStart(6)} ms  ${entries.length.toString().padStart(3)} 条  ${source.name}`)
  } catch (error) {
    console.log(`${String(Date.now() - started).padStart(6)} ms  ERROR  ${source.name} — ${String(error?.message ?? error).slice(0, 120)}`)
  }
}
