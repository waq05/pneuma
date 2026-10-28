/**
 * 自检辅助：给 ~/.dsc/usage/usage.jsonl 撒一批假的用量记录，让「用量统计」页
 * 的热力图 / 趋势 / 环形图有东西可画。截完图由调用方删掉整个 usage 目录。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const models = [
  { provider: 'deepseek', model: 'deepseek-chat', share: 0.62 },
  { provider: 'glm', model: 'glm-5.3-flash', share: 0.3 },
  { provider: 'zhipu', model: 'hy3-a', share: 0.08 },
]

const start = Date.UTC(2026, 5, 20) // 2026-06-20
const end = Date.now()
const lines = []
for (let t = start; t <= end; t += 3_600_000) {
  // 每小时一格；约 55% 的格子没有活动，周末更少，工作日傍晚最密
  const date = new Date(t)
  const day = date.getUTCDay()
  const weekendFactor = day === 0 || day === 6 ? 0.25 : 1
  const hourFactor = date.getUTCHours() >= 9 && date.getUTCHours() <= 23 ? 1 : 0.12
  if (Math.random() > 0.45 * weekendFactor * hourFactor) continue
  const turns = 1 + Math.floor(Math.random() * 3)
  for (let turn = 0; turn < turns; turn += 1) {
    const pick = Math.random()
    let acc = 0
    const chosen = models.find((entry) => (acc += entry.share) >= pick) ?? models[0]
    const sizeFactor = 0.4 + Math.random() * 1.8
    lines.push({
      t: t + turn * 42_000,
      provider: chosen.provider,
      model: chosen.model,
      i: Math.round(18_000 * sizeFactor),
      o: Math.round(4_200 * sizeFactor),
      sid: 'seed-0000',
    })
  }
}

const dir = join(homedir(), '.dsc', 'usage')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'usage.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
console.log(`seeded ${lines.length} records`)
