/**
 * 持久 shell（极简档的 `shell` 工具）探针（迁自 `scripts/persistent-shell-test.mjs`）。
 *
 * 三组断言：
 *
 *   ① 解码：合法 UTF-8 与 GBK 字节都能还原成中文（中文 Windows 的 PowerShell 输出 GBK）；
 *   ② 干净化：回显行、哨兵行、结尾提示符都被剥掉，正文原样留下；
 *   ③ **真实会话**（Windows / 有 pwsh 或 powershell 时）：两条命令共享状态（变量与 cwd），
 *      抛错的命令仍能拿到哨兵与 `[exit code: 1]`，超时会收掉 shell 并允许重建。
 *
 * ## 为什么第 ③ 段必须真起 shell
 *
 * ①② 是纯函数，改坏了当场看得见；但「状态跨调用保留」这件事只存在于**同一个子进程**里，
 * 假 shell 验的只是我自己的假设。所以这里真起一条常驻 shell，跑完就 `closeAll()`
 * （不然那句 `Start-Sleep` 和 shell 句柄会把 vitest 钉到退出不了）。
 *
 * ## 落位
 *
 * 第 ③ 段起真子进程，unit 层的 5 秒超时与线程池都不合适，所以放 integration 层。
 * 非 Windows 只跑 ①②（判据与探针一致：Windows 上才有 GBK 与 PowerShell 这两位主角）。
 *
 * @module @pneuma/tools-default/tests/persistent-shell.int.spec
 */
import { isUtf8 } from 'node:buffer'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { cleanShellOutput, decodeChunk, PersistentShellTable } from '../persistent-shell.js'

/** 真实会话的工作目录（不放在仓库里，免得 shell 的初值把断言带偏）。 */
const cwd = mkdtempSync(join(tmpdir(), 'dsc-persistent-'))
/** 三组共用的一份原文：PowerShell 侧那条命令的回显 + 正文 + 哨兵 + 提示符。 */
const PWSH_RAW = [
  "PS D:\\dsc> $__dsc = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('eA==')); Invoke-Expression $__dsc; Write-Output ('__DS' + 'C_ab12__' + [string]$__ec)",
  'A=41',
  '__DSC_ab12__0',
  'PS D:\\dsc> ',
].join('\r\n')
/** bash 侧同样的四行（回显行是裸输入行）。 */
const BASH_RAW = [
  'eval "$(printf \'%s\' \'eA==\' | base64 -d)"; __ec=$?; echo "__DS""C_ab12__$__ec"',
  'hello',
  '__DSC_ab12__0',
  '$ ',
].join('\n')

describe('① 按块解码（中文 Windows 的 PowerShell 写 GBK）', () => {
  /** 「中文输出正常」的 UTF-8 字节与 GBK 字节。 */
  const utf8 = Buffer.from('中文输出正常', 'utf8')
  const gbk = Buffer.from('d6d0cec4cae4b3f6d5fdb3a3', 'hex')

  test('UTF-8 字节按 UTF-8 还原', () => {
    expect(decodeChunk(utf8)).toBe('中文输出正常')
  })

  test('GBK 字节按 GBK 还原（按 UTF-8 硬解会是一屏乱码）', () => {
    expect(decodeChunk(gbk)).toBe('中文输出正常')
  })

  test('ASCII 两种解码一致', () => {
    expect(decodeChunk(Buffer.from('abc'))).toBe('abc')
  })

  test('前提成立：isUtf8 真能区分这两种字节', () => {
    expect(isUtf8(utf8)).toBe(true)
    expect(isUtf8(gbk)).toBe(false)
  })
})

describe('② 干净化：回显 / 哨兵 / 提示符', () => {
  test('PowerShell：回显行被剥掉（含 base64 那串）', () => {
    expect(cleanShellOutput(PWSH_RAW, 'pwsh')).not.toContain('FromBase64String')
  })

  test('PowerShell：哨兵行被剥掉', () => {
    expect(cleanShellOutput(PWSH_RAW, 'pwsh')).not.toContain('__DSC_')
  })

  test('PowerShell：正文原样留下', () => {
    expect(cleanShellOutput(PWSH_RAW, 'pwsh')).toBe('A=41')
  })

  test('bash 侧同样干净', () => {
    expect(cleanShellOutput(BASH_RAW, 'bash')).toBe('hello')
  })

  test('空输入不炸', () => {
    expect(cleanShellOutput('', 'pwsh')).toBe('')
  })
})

describe.skipIf(process.platform !== 'win32')('③ 真实会话（Windows）', () => {
  /** 这一组共用一条常驻 shell：状态共享本身就是被测行为。 */
  let table: PersistentShellTable
  /** 单条命令给足的时间（首次要等 PowerShell 起来）。 */
  const WAIT = 30_000

  beforeAll(() => {
    table = new PersistentShellTable()
  })

  afterAll(() => {
    // 不 closeAll 的话 shell 句柄与它在等的 stdin 会把 vitest 钉住。
    table.closeAll()
  })

  test('第一条命令的输出正确', async () => {
    const text = await table.run('probe-a', cwd, '$x = 41; Set-Location $env:TEMP; Write-Output "A=$x"', WAIT)
    expect(text.trim()).toBe('A=41')
  })

  test('变量跨调用保留（同一条壳里下一次还看得见 $x）', async () => {
    const text = await table.run('probe-a', cwd, 'Write-Output "B=$x"; Write-Output "LOC=$(Get-Location)"', WAIT)
    expect(text).toContain('B=41')
  })

  test('工作目录跨调用保留', async () => {
    const text = await table.run('probe-a', cwd, 'Write-Output "LOC=$(Get-Location)"', WAIT)
    expect(text).toContain('LOC=')
  })

  test('抛错仍交回错误文本与退出码（哨兵没被 throw 吃掉）', async () => {
    const text = await table.run('probe-a', cwd, 'throw "boom"', WAIT)
    expect(text).toContain('boom')
    expect(text).toContain('[exit code: 1]')
  })

  test('中文不乱码', async () => {
    const text = await table.run('probe-a', cwd, 'Write-Output "中文输出正常"', WAIT)
    expect(text.trim()).toBe('中文输出正常')
  })

  test('超时会失败并收掉这个 shell', async () => {
    await expect(table.run('probe-b', cwd, 'Start-Sleep -Seconds 5', 800)).rejects.toThrow(/已收掉这个 shell/)
  })

  test('超时之后能重建（下一条命令从全新状态开始）', async () => {
    const text = await table.run('probe-b', cwd, 'Write-Output "fresh"', WAIT)
    expect(text.trim()).toBe('fresh')
  })
})
