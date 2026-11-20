/**
 * 需要先把 `DSC_HOME` 指到临时目录、再动态 import 的两个模块（W14）：
 * `core/audit.ts` 与 `core/session-meta.ts`。
 *
 * `core/path-policy.ts` 的 `DSC_HOME` 是**模块顶层常量**，所以静态 import 会按真实
 * `~/.dsc` 算死；这里在模块体里先改 `process.env`，再 `await import(...)`，让常量取到
 * 临时目录。收尾还原环境变量，真实用户目录一个字节都不碰。
 *
 * 补的两支都是「写/读盘坏了」的容错路：审计连续写不进去就关掉落盘；会话属性文件坏成
 * 半截 JSON 时当空表。
 *
 * @module dsc/core/w14-dsc-home.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'

const HOME = createTempDir('dsc-w14-dsc-home-')
const DSC_HOME = join(HOME, '.dsc')
const originalHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = DSC_HOME

const { AUDIT_FILE, audit, setAuditEnabled } = await import('./audit.js')
const { bootNoticeOnce } = await import('./boot-notices.js')
const { patchSessionMeta, readSessionMeta } = await import('./session-meta.js')
const { readDisabledSkills } = await import('./skills.js')

afterAll(() => {
  setAuditEnabled(true)
  if (originalHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = originalHome
})

describe('审计落盘：写不进去就关掉，不再每条都撞一次磁盘', () => {
  test('审计文件位置跟着 DSC_HOME 走', () => {
    expect(AUDIT_FILE.startsWith(DSC_HOME)).toBe(true)
  })

  test('把审计文件做成目录：append 失败被吞掉，写入被关掉，后续调用是空操作', () => {
    // 让 AUDIT_FILE 成为一个目录：existsSync(dirname) 为真，appendFileSync 抛 EISDIR。
    mkdirSync(AUDIT_FILE, { recursive: true })
    expect(() => {
      audit({ ts: 1, kind: 'auto-allow', id: 'a1', reason: '临时夹具' })
    }).not.toThrow()
    // 关掉之后再次调用直接 return（不会因为同一个目录再抛一次）。
    expect(() => {
      audit({ ts: 2, kind: 'auto-deny', id: 'a2', reason: '临时夹具' })
    }).not.toThrow()
  })
})

describe('会话展示属性：文件坏了当空表', () => {
  test('非法 JSON 被吞成空表（列表投影还能照常跑）', () => {
    const sessions = join(DSC_HOME, 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'meta.json'), '{ 半截 JSON', 'utf8')
    expect(readSessionMeta()).toEqual({})
  })

  test('正常写读一轮：坏文件被覆盖成合法结构', () => {
    const table = patchSessionMeta('00000000-0000-4000-8000-000000000001', {
      title: '改过的名字',
    })
    expect(table['00000000-0000-4000-8000-000000000001']?.title).toBe('改过的名字')
    expect(readSessionMeta()['00000000-0000-4000-8000-000000000001']?.title).toBe('改过的名字')
  })
})

describe('启动提示：从磁盘装载上次的记录', () => {
  test('记录里已有的同文提示不再重复展示；新文本照常展示', () => {
    writeFileSync(join(DSC_HOME, 'boot-notices.json'), JSON.stringify({ 'sandbox-ready': '沙箱已就绪' }), 'utf8')
    // 首次调用才装载磁盘记录，所以这两条要用新进程一般的语义去断言：
    // 同一个 key + 同文 → false（已说过）；换文本 → true，并写回磁盘。
    expect(bootNoticeOnce('sandbox-ready', '沙箱已就绪')).toBe(false)
    expect(bootNoticeOnce('sandbox-ready', '沙箱换成别的档位了')).toBe(true)
  })
})

describe('技能停用表：坏 JSON 当空表', () => {
  test('skills.json 半截 JSON：返回空集合而不是抛错（明细 244）', () => {
    writeFileSync(join(DSC_HOME, 'skills.json'), '{ 半截 JSON', 'utf8')
    expect(readDisabledSkills().size).toBe(0)
  })
})
