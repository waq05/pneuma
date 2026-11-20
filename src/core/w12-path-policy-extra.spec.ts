/**
 * 路径策略（`core/path-policy.ts`）的读禁清单与「读过之后又被改」台账：
 * 凭据文件名/扩展名、DSC_HOME 下的 config.yaml 与 plugins.json、
 * 整写覆盖与定点替换的陈旧判定。
 *
 * `DSC_HOME` 在模块 import 期就定死，所以先建临时目录、把环境指过去，再动态
 * import 被测模块——不碰真实 `~/.dsc`。
 *
 * @module dsc/core/w12-path-policy-extra.spec
 */
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../tests/support/tmp-dir.js'

const home = createTempDir('dsc-w12-path-home-')
const elsewhere = createTempDir('dsc-w12-path-elsewhere-')
const previous = {
  DSC_HOME: process.env['DSC_HOME'],
  HOME: process.env['HOME'],
  USERPROFILE: process.env['USERPROFILE'],
}
process.env['DSC_HOME'] = home
process.env['HOME'] = home
process.env['USERPROFILE'] = home

type PathPolicy = typeof import('./path-policy.js')
let policy: PathPolicy

beforeAll(async () => {
  policy = await import('./path-policy.js')
})

afterAll(() => {
  for (const key of ['DSC_HOME', 'HOME', 'USERPROFILE'] as const) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

describe('readBlockReason 的读禁清单', () => {
  test('凭据类文件名（id_rsa / .npmrc）拒读', () => {
    expect(policy.readBlockReason(join(home, 'id_rsa'))).toContain('凭据或私钥文件')
    expect(policy.readBlockReason(join(home, '.npmrc'))).toContain('凭据或私钥文件')
  })

  test('密钥/证书扩展名（.pem）拒读', () => {
    expect(policy.readBlockReason(join(home, 'server.pem'))).toContain('密钥/证书')
  })

  test('.env 家族拒读、.env.example 放行', () => {
    expect(policy.readBlockReason(join(home, '.env.local'))).toContain('本地密钥文件')
    expect(policy.readBlockReason(join(home, '.env.example'))).toBeNull()
  })

  test('DSC_HOME 下的 config.yaml 拒读，别处的 config.yaml 不归这层管', () => {
    expect(policy.readBlockReason(join(home, 'config.yaml'))).toContain('dsc 自己的配置')
    expect(policy.readBlockReason(join(elsewhere, 'config.yaml'))).toBeNull()
  })

  test('DSC_HOME 下的 plugins.json 拒读，别处的同名文件放行', () => {
    expect(policy.readBlockReason(join(home, 'plugins.json'))).toContain('控制文件')
    expect(policy.readBlockReason(join(elsewhere, 'plugins.json'))).toBeNull()
  })
})

describe('读取台账与陈旧判定', () => {
  /** 造一个真实文件并返回路径。 */
  function makeFile(name: string): string {
    const file = join(home, name)
    writeFileSync(file, `content-${name}`, 'utf8')
    return file
  }

  test('noteRead 一个不存在的文件：不抛，且台账里不留下这项', () => {
    const missing = join(home, 'missing.txt')
    expect(() => policy.noteRead(missing, 'sess-missing')).not.toThrow()
    // 不存在 = 新建，陈旧判定直接放行
    expect(policy.staleOverwriteReason(missing, 'sess-missing')).toBeNull()
  })

  test('整写覆盖：没读过要拒，读过放行，读后文件又被改动要拒', () => {
    const file = makeFile('overwrite.txt')
    const session = 'sess-overwrite'
    expect(policy.staleOverwriteReason(file, session)).toContain('本次会话没读过它')
    policy.noteRead(file, session)
    expect(policy.staleOverwriteReason(file, session)).toBeNull()
    // 把 mtime 推后 10 秒，模拟第三方改动
    const future = Date.now() / 1000 + 10
    utimesSync(file, future, future)
    expect(policy.staleOverwriteReason(file, session)).toContain('又被改动了')
    // noteWrite 会刷新台账，刚写完的文件不该被自己拦
    policy.noteWrite(file, session)
    expect(Number.isNaN(statSync(file).mtimeMs)).toBe(false)
    expect(policy.staleOverwriteReason(file, session)).toBeNull()
  })

  test('定点替换：没读过放行（edit 自己现读），读后被改要拒，文件没了放行', () => {
    const file = makeFile('edit.txt')
    const session = 'sess-edit'
    expect(policy.staleEditReason(file, session)).toBeNull()
    policy.noteRead(file, session)
    const future = Date.now() / 1000 + 10
    utimesSync(file, future, future)
    expect(policy.staleEditReason(file, session)).toContain('又被改动了')
    rmSync(file)
    expect(policy.staleEditReason(file, session)).toBeNull()
  })

  test('clearReadLedger 清掉台账后重新按「没读过」判', () => {
    const file = makeFile('clear.txt')
    const session = 'sess-clear'
    policy.noteRead(file, session)
    expect(policy.staleOverwriteReason(file, session)).toBeNull()
    policy.clearReadLedger(session)
    expect(policy.staleOverwriteReason(file, session)).toContain('没读过')
  })

  test('会话之间台账隔离：A 读过不算 B 读过', () => {
    const file = makeFile('per-session.txt')
    policy.noteRead(file, 'sess-a')
    expect(policy.staleOverwriteReason(file, 'sess-b')).toContain('没读过')
  })

  test('noteRead 落在目录上：stat 成功但不影响其他会话', () => {
    const dir = join(home, 'a-dir')
    mkdirSync(dir, { recursive: true })
    expect(() => policy.noteRead(dir, 'sess-dir')).not.toThrow()
  })
})

