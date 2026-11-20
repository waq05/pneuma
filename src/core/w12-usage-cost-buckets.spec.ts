/**
 * 会话费用回填（`core/usage-log.ts` 的 `readSessionCostBuckets`）：按 1MiB 块扫
 * usage.jsonl、按 sid 预筛、跳过工具行/判官行/坏行/缺 token 行，最后按模型分峰谷桶。
 *
 * `usageLogFile()` 在 import 期由 `DSC_HOME` 定死，所以先指临时目录再动态 import。
 *
 * @module dsc/core/w12-usage-cost-buckets.spec
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'

const home = createTempDir('dsc-w12-usage-home-')
const previous = {
  DSC_HOME: process.env['DSC_HOME'],
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
}
process.env['DSC_HOME'] = home
process.env['HOME'] = home
process.env['USERPROFILE'] = home

const usageDir = join(home, 'usage')
const usageFile = join(usageDir, 'usage.jsonl')

type UsageModule = typeof import('./usage-log.js')
let usage: UsageModule

beforeAll(async () => {
  usage = await import('./usage-log.js')
})

afterAll(() => {
  for (const key of ['DSC_HOME', 'HOME', 'USERPROFILE'] as const) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
})

/** 一行 JSONL。 */
function row(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

describe('readSessionCostBuckets', () => {
  test('只折本会话的请求行：工具行/判官行/坏行/缺 token 行/别的会话都跳过', () => {
    mkdirSync(usageDir, { recursive: true })
    const lines = [
      row({ sid: 'sess-a', model: 'm1', i: 10, o: 5, ch: 2, cm: 8, t: Date.now() }),
      row({ sid: 'sess-a', k: 'tool' }),
      row({ sid: 'sess-a', k: 'judge', i: 100, o: 100, model: 'm1' }),
      row({ sid: 'sess-a', model: 'm1' }), // 缺 token
      '{"sid":"sess-a", 半截\n',
      row({ sid: 'sess-b', model: 'm1', i: 999, o: 999 }),
      row({ sid: 'sess-a', model: 'm2', i: 7, o: 3, t: 0 }),
    ]
    writeFileSync(usageFile, lines.join(''), 'utf8')

    const buckets = usage.readSessionCostBuckets('sess-a')
    expect(buckets).not.toBeNull()
    expect([...buckets!.keys()].sort()).toEqual(['m1', 'm2'])

    const m1 = buckets!.get('m1')!
    // inputTokens 拆成峰谷两桶：命中+未命中合计 = 10，output = 5
    expect(m1.peak.hit + m1.peak.miss + m1.idle.hit + m1.idle.miss).toBe(10)
    expect(m1.peak.output + m1.idle.output).toBe(5)

    const m2 = buckets!.get('m2')!
    expect(m2.peak.hit + m2.peak.miss + m2.idle.hit + m2.idle.miss).toBe(7)
    expect(m2.peak.output + m2.idle.output).toBe(3)
  })

  test('本会话一行请求都没有：返回 null（别把没有账画成 0 元）', () => {
    expect(usage.readSessionCostBuckets('sess-none')).toBeNull()
    expect(usage.readSessionCostBuckets('')).toBeNull()
  })

  test('usage.jsonl 还不存在：返回 null 而不是抛', () => {
    rmSync(usageDir, { recursive: true, force: true })
    expect(usage.readSessionCostBuckets('sess-a')).toBeNull()
  })
})
