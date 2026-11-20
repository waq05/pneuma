/**
 * `app/effects.ts` 的队列自身失败分支（W14）：`dispatch()` 的 catch、`run()` 的 catch 与
 * `failed()` 写体检那三处。
 *
 * 手法：让 effect 表在「派发中途」消失（处理器第一句把表删掉）。于是：
 *   - 运行中的那次 `attempt` 在写回结果时抛错 → `run().catch` 走 `failed`；
 *   - 下一轮 `dispatch` 的查询语句也抛错 → `dispatch()` 自己那条 catch 再走一次 `failed`。
 * 队列不该把这两种失败吞成静默的丢活，体检项必须变成 error。
 *
 * @module dsc/packages/superagent/tests/w14-effects-failures
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14-effects-'))
process.env['DSC_HOME'] = HOME

const { Effects } = await import('../app/effects.js')
const { Store } = await import('../app/store.js')
const { HealthBoard } = await import('../infra/health.js')

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('Effects：effect 表在派发中消失', () => {
  test('处理器删掉队列表：写入结果与下一轮查询都失败，体检项变 error', async () => {
    const dir = mkdtempSync(join(HOME, 'case-'))
    const store = new Store(join(dir, 'orchestrator.sqlite'))
    const board = new HealthBoard()
    const effects = new Effects(store, board, () => Date.now())
    try {
      effects.handle('relay', async () => {
        // 处理器第一句就把表删掉：后面的写回与下一轮查询都会抛。
        store.db.exec('DROP TABLE effect')
      })
      effects.enqueue('relay', 'k1', { text: 'hello' })
      effects.start()
      await effects.idle('relay').catch(() => undefined)
      expect(board.all['relay']?.state).toBe('error')
      expect(String(board.all['relay']?.detail)).toContain('effect queue failed')
    } finally {
      await effects.drain().catch(() => undefined)
      store.close()
    }
  })
})
