/**
 * `core/dsh-compat/session-bridge.ts` 的缺口补齐：用量日志读不到 / 根本没有 / 路径被目录占着。
 *
 * 夹具是临时 DSC_HOME 下的一份会话 jsonl；用量文件的位置由 `usageLogFile()` 给（DSC_HOME
 * 推导），所以换掉环境就够了。不碰真实 `~/.dsc`。
 *
 * @module dsc/core/dsh-compat/w14b-session-bridge-edges.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-bridge-'))
process.env['DSC_HOME'] = HOME

type Bridge = typeof import('./session-bridge.js')
type Core = typeof import('../session.js')
type UsageLog = typeof import('../usage-log.js')
let bridge: Bridge
let core: Core
let usageLog: UsageLog

const WORK = 'D:\\work\\w14b'
let sessionId = ''

beforeAll(async () => {
  core = await import('../session.js')
  usageLog = await import('../usage-log.js')
  const dir = join(core.sessionsRoot(), core.slugCwd(WORK))
  mkdirSync(dir, { recursive: true })
  sessionId = 'w14b-1'
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: 'meta', id: sessionId, cwd: WORK, createdAt: 1_000 })}\n` +
      `${JSON.stringify({ type: 'user', text: '问一句', ts: 1_000 })}\n`,
    'utf8',
  )
  bridge = await import('./session-bridge.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

describe('usageBySession：没有用量文件', () => {
  test('stat 照常返回快照（用量为空），不抛', () => {
    const persistence = bridge.createSessionPersistenceBridge()
    const snapshot = persistence.stat(sessionId)
    expect(snapshot?.header.id).toBe(sessionId)
    expect(snapshot?.eventCount).toBeGreaterThan(0)
  })
})

describe('usageBySession：用量文件的位置被目录占着', () => {
  test('读不动的用量日志当空表，会话仍然读得到', () => {
    const usageFile = usageLog.usageLogFile()
    rmSync(usageFile, { force: true })
    mkdirSync(usageFile, { recursive: true })
    const persistence = bridge.createSessionPersistenceBridge()
    const snapshot = persistence.stat(sessionId)
    expect(snapshot?.header.id).toBe(sessionId)
    expect(snapshot?.eventCount).toBeGreaterThan(0)
    rmSync(usageFile, { recursive: true, force: true })
  })
})
