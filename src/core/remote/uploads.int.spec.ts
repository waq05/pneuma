/**
 * 上传：文件名安全化、落盘、按天分目录、配额淘汰（迁自 `scripts/remote-host-test.mjs` 第 9 节）。
 *
 * ## 被测的是什么
 *
 * `RemoteUploads` 的三条安全规矩（uploads.ts 文件头）：
 *   - **文件名从不可信输入里造**：路径分隔符（`/`、`\`）剥到只剩最后一段、控制字符与
 *     Windows 非法字符去掉、空名/纯点点/纯空白回落 `upload`、扩展名保留、主名截到 80 字、
 *     设备名（CON / COM1…）改写加下划线前缀；
 *   - **单文件 20MB**（超过直接拒，不落盘）；落盘名前置 8 位随机十六进制前缀；
 *   - **目录配额**：探针把配额调成 300 字节，第三个 150 字节文件写进来时最旧那个要被淘汰；
 *     刚写下去的那个文件有 `protect` 护着，不会被这次淘汰带走。
 *
 * 落盘目录是 tempHome 下的子目录（显式传 dir），真实 `~/.dsc` 一个字节不写；按天分目录用
 * 注入的假钟（Date.UTC(2026,0,2,3,4,5)）验，`day()` 与被测的 `dayDir` 同一把本地时区算法。
 *
 * @module dsc/core/remote/uploads.int.spec
 */
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../tests/harness.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见 prefs.int.spec 文件头）。 */
const home = tempHome('dsc-remote-uploads-')

delete process.env['DSC_HOME']

afterAll(() => {
  home.restore()
})

type UploadsModule = typeof import('@pneuma/runtime/core/remote/uploads.js')
let mod: UploadsModule

beforeAll(async () => {
  mod = await import('@pneuma/runtime/core/remote/uploads.js')
})

/** 探针的假钟：固定在 2026-01-02 03:04:05 UTC，`day()` 用本地时区展开成 yyyymmdd。 */
const stamp = Date.UTC(2026, 0, 2, 3, 4, 5)
const day = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getFullYear())}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

describe('上传（文件名的安全化与配额）', () => {
  test('单文件上限是 20MB、目录配额是 100MB', () => {
    expect(mod.UPLOAD_MAX_BYTES).toBe(20 * 1024 * 1024)
    expect(mod.UPLOAD_QUOTA_BYTES).toBe(100 * 1024 * 1024)
  })

  test('路径分隔符被剥掉（穿越攻击最后只剩文件名）', () => {
    expect(mod.safeUploadName('../../evil.txt')).toBe('evil.txt')
    expect(mod.safeUploadName('..\\..\\Windows\\System32\\evil.exe')).toBe('evil.exe')
    expect(mod.safeUploadName('/etc/passwd')).toBe('passwd')
  })

  test('控制字符与 Windows 非法字符被去掉', () => {
    expect(mod.safeUploadName('a\u0000b<c>d:e"f|g?h*i.txt')).toBe('abcdefghi.txt')
  })

  test('空名、纯点点、纯空白回落 upload', () => {
    expect(mod.safeUploadName('')).toBe('upload')
    expect(mod.safeUploadName('..')).toBe('upload')
    expect(mod.safeUploadName('...')).toBe('upload')
    expect(mod.safeUploadName('../..')).toBe('upload')
    expect(mod.safeUploadName('   ')).toBe('upload')
  })

  test('扩展名保留、名字截到 80 字以内', () => {
    expect(mod.safeUploadName('photo.PNG')).toBe('photo.PNG')
    expect(mod.safeUploadName(`${'x'.repeat(200)}.txt`).length).toBeLessThanOrEqual(84)
  })

  test('Windows 设备名被改写（CON / COM1 这些不能直接当文件名）', () => {
    expect(mod.safeUploadName('CON')).toBe('_CON')
    expect(mod.safeUploadName('com1.txt')).toBe('_com1.txt')
  })

  test('落盘成功：返回 path / size / name，目录按 yyyymmdd 分，文件名带 8 位随机前缀', () => {
    const dir = join(home.home, 'uploads-unit')
    const uploads = new mod.RemoteUploads({ dir, now: () => stamp, quotaBytes: 300 })
    const saved = uploads.save('note.txt', Buffer.from('hello 远程', 'utf8'))
    expect(saved.ok).toBe(true)
    if (saved.ok !== true) return
    expect(saved.size).toBe(Buffer.byteLength('hello 远程', 'utf8'))
    expect(saved.name).toBe('note.txt')
    expect(saved.path.startsWith(join(dir, day(stamp)))).toBe(true)
    expect(/[0-9a-f]{8}-note\.txt$/.test(saved.path)).toBe(true)
    expect(readFileSync(saved.path, 'utf8')).toBe('hello 远程')
  })

  test('穿越文件名落盘后仍在当天目录里（没跑出 uploads 根）', () => {
    const dir = join(home.home, 'uploads-unit')
    const uploads = new mod.RemoteUploads({ dir, now: () => stamp, quotaBytes: 300 })
    const escaped = uploads.save('../../../evil.txt', Buffer.from('x'))
    expect(escaped.ok).toBe(true)
    if (escaped.ok !== true) return
    expect(escaped.path.startsWith(join(dir, day(stamp)))).toBe(true)
    expect(escaped.name).toBe('evil.txt')
    expect(existsSync(join(home.home, 'evil.txt'))).toBe(false)
  })

  test('超过 20MB 直接拒（不落盘）', () => {
    const uploads = new mod.RemoteUploads({ dir: join(home.home, 'uploads-reject'), now: () => stamp })
    const tooBig = uploads.save('big.bin', Buffer.alloc(mod.UPLOAD_MAX_BYTES + 1))
    expect(tooBig.ok).toBe(false)
    expect(tooBig.ok === false ? typeof tooBig.error === 'string' : false).toBe(true)
  })

  test('超过目录配额时按最旧淘汰（writing 第三个 150B 之后第一个不见了）', () => {
    const quotaDir = join(home.home, 'uploads-quota')
    const quota = new mod.RemoteUploads({ dir: quotaDir, now: () => stamp, quotaBytes: 300 })
    const one = quota.save('one.bin', Buffer.alloc(150, 1))
    expect(one.ok).toBe(true)
    if (one.ok === true) utimesSync(one.path, new Date(1_000_000), new Date(1_000_000))
    const two = quota.save('two.bin', Buffer.alloc(150, 2))
    expect(two.ok).toBe(true)
    if (two.ok === true) utimesSync(two.path, new Date(2_000_000), new Date(2_000_000))
    const three = quota.save('three.bin', Buffer.alloc(150, 3))
    expect(three.ok).toBe(true)
    if (three.ok !== true || one.ok !== true || two.ok !== true) return
    expect(existsSync(one.path)).toBe(false)
    expect(existsSync(two.path)).toBe(true)
    expect(existsSync(three.path)).toBe(true)
    expect(quota.totalBytes()).toBe(300)
  })

  test('刚写下去的那个文件不会被这次淘汰带走（写前后各查一次）', () => {
    const tiny = new mod.RemoteUploads({ dir: join(home.home, 'uploads-tiny'), now: () => stamp, quotaBytes: 10 })
    const only = tiny.save('only.bin', Buffer.alloc(20, 7))
    expect(only.ok).toBe(true)
    if (only.ok !== true) return
    expect(existsSync(only.path)).toBe(true)
  })
})
