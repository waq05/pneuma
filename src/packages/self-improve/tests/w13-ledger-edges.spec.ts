/**
 * 技能台账（`ledger.ts`）的边角覆盖：读失败、副本失败、回滚的失败与成功路径。
 *
 * 全部落临时 `DSC_HOME`（import 之前指走），不碰真实 `~/.dsc`。
 * 已有 `branches-extra.spec.ts` 覆盖常规路径，这里只补它没走到的分支。
 *
 * @module dsc/packages/self-improve/tests/w13-ledger-edges
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-ledger-w13-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

const ld = await import('../ledger.js')
const sw = await import('../skill-write.js')

const skillsDir = sw.skillsRoot()

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** 造技能目录 + SKILL.md，返回目录。 */
function writeSkill(name: string, text: string): string {
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
  return dir
}

describe('读失败兜底', () => {
  test('hashFileOf：路径是目录时读不出来，按空内容指纹处理', () => {
    const dir = join(home, 'a-directory')
    mkdirSync(dir, { recursive: true })
    expect(ld.hashFileOf(dir)).toBe(ld.EMPTY_HASH)
  })

  test('台账文件是目录：readLedger 给空数组，ledgerSize 给 0', () => {
    const file = ld.ledgerFile()
    mkdirSync(file, { recursive: true })
    try {
      expect(ld.readLedger()).toEqual([])
      expect(ld.ledgerSize()).toBe(0)
    } finally {
      rmSync(file, { recursive: true, force: true })
    }
  })
})

describe('rollbackEntry：副本路径', () => {
  test('副本在且指纹对得上：SKILL.md 被还原成改前内容，并追加一条 rollback 台账', () => {
    const before = '# demo\n\n改前内容\n'
    const after = '# demo\n\n改后内容\n'
    const dir = writeSkill('rollback-ok', after)
    const backupName = 'SKILL.md.bak.1700000000'
    writeFileSync(join(dir, backupName), before, 'utf8')
    const entry = ld.appendLedger({
      actor: 'model',
      action: 'patch',
      skill: 'rollback-ok',
      beforeHash: ld.hashText(before),
      afterHash: ld.hashText(after),
      backup: backupName,
    })

    const result = ld.rollbackEntry(entry.id, 1_700_000_111_000)
    expect(result.ok).toBe(true)
    expect(result.notice).toContain('已把 rollback-ok/SKILL.md 还原')
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(before)
    // 回滚本身也进台账：历史链条不断
    const rollback = ld.readLedger().find((item) => item.action === 'rollback' && item.skill === 'rollback-ok')
    expect(rollback?.note).toContain(`回滚 ${entry.id}`)
    expect(rollback?.ts).toBe(1_700_000_111_000)
  })

  test('副本是个目录读不出来：明确报错，不回滚', () => {
    const dir = writeSkill('rollback-badbackup', '# x\n')
    const backupName = 'SKILL.md.bak.42'
    mkdirSync(join(dir, backupName), { recursive: true })
    const entry = ld.appendLedger({
      actor: 'model',
      action: 'patch',
      skill: 'rollback-badbackup',
      beforeHash: ld.hashText('whatever'),
      afterHash: ld.hashText('# x\n'),
      backup: backupName,
    })
    const result = ld.rollbackEntry(entry.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('副本读不出来')
  })

  test('恢复写盘失败（SKILL.md 位置被目录占着）：报恢复失败，不假装成功', () => {
    const before = '# failwrite\n\n改前\n'
    const dir = writeSkill('rollback-writefail', '占位')
    // 把 SKILL.md 换成目录，rename 到它上面必然失败
    rmSync(join(dir, 'SKILL.md'), { force: true })
    mkdirSync(join(dir, 'SKILL.md'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md.bak.7'), before, 'utf8')
    const entry = ld.appendLedger({
      actor: 'model',
      action: 'patch',
      skill: 'rollback-writefail',
      beforeHash: ld.hashText(before),
      afterHash: ld.hashText('占位'),
      backup: 'SKILL.md.bak.7',
    })
    const result = ld.rollbackEntry(entry.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('恢复失败')
    // 半截临时文件不留
    expect(existsSync(join(dir, 'SKILL.md.tmp'))).toBe(false)
  })
})

describe('rollbackEntry：归档路径', () => {
  test('技能目录又出现了：拒绝覆盖，给出目录坐标', () => {
    const dir = writeSkill('archive-exists', '# 又回来了\n')
    const hash = ld.hashText('# 旧内容\n')
    const entry = ld.appendLedger({
      actor: 'user',
      action: 'archive',
      skill: 'archive-exists',
      beforeHash: hash,
      afterHash: ld.EMPTY_HASH,
    })
    const result = ld.rollbackEntry(entry.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('目录又出现了')
    expect(result.error).toContain(dir)
  })

  test('归档区读不出来（路径被文件占着）：按找不到处理', () => {
    const root = sw.archiveRoot()
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(root, 'not a directory', 'utf8')
    try {
      const entry = ld.appendLedger({
        actor: 'user',
        action: 'archive',
        skill: 'archive-unreadable',
        beforeHash: ld.hashText('# 找不到的一份\n'),
        afterHash: ld.EMPTY_HASH,
      })
      const result = ld.rollbackEntry(entry.id)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('归档区里找不到内容指纹')
    } finally {
      rmSync(root, { force: true })
    }
  })

  test('归档区里名字像但指纹对不上：找不到就报错', () => {
    const root = sw.archiveRoot()
    mkdirSync(join(root, 'archive-mismatch-20261111'), { recursive: true })
    writeFileSync(join(root, 'archive-mismatch-20261111', 'SKILL.md'), '# 别的版本\n', 'utf8')
    // 再来一个非目录的干扰项，走一遍 isDirectory 的跳过分支
    writeFileSync(join(root, 'archive-mismatch-note.txt'), 'x', 'utf8')
    const entry = ld.appendLedger({
      actor: 'user',
      action: 'archive',
      skill: 'archive-mismatch',
      beforeHash: ld.hashText('# 目标版本\n'),
      afterHash: ld.EMPTY_HASH,
    })
    const result = ld.rollbackEntry(entry.id)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('找不到内容指纹为')
    expect(result.error).toContain('archive-mismatch')
  })
})
