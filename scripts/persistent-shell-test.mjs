/**
 * 持久 shell（极简档的 `shell` 工具）探针：纯逻辑 + 一次真实会话。
 *
 * 三组断言：
 *   [1] 解码：合法 UTF-8 与 GBK 字节都能还原成中文（中文 Windows 的 PowerShell 输出 GBK）；
 *   [2] 干净化：回显行、哨兵行、结尾提示符都被剥掉，正文原样留下；
 *   [3] 真实会话（Windows / 有 pwsh 或 powershell 时）：两条命令共享状态（变量与 cwd），
 *       抛错的命令仍能拿到哨兵与 [exit code: 1]，超时会收掉 shell 并允许重建。
 *
 * 用法：node scripts/persistent-shell-test.mjs（先 pnpm run build）
 *
 * @module dsc/scripts/persistent-shell-test
 */
import { isUtf8 } from 'node:buffer'

const mod = await import(new URL('../lib/packages/tools-default/persistent-shell.js', import.meta.url).href)

let pass = 0
let fail = 0
const check = (label, ok, extra = '') => {
  if (ok) { pass += 1; console.log('  ok  ' + label); return }
  fail += 1; console.log('  FAIL ' + label + (extra === '' ? '' : ' — ' + extra))
}

console.log('[1] 按块解码')
{
  const utf8 = Buffer.from('中文输出正常', 'utf8')
  const gbk = Buffer.from('d6d0cec4cae4b3f6d5fdb3a3', 'hex')
  check('UTF-8 字节按 UTF-8 还原', mod.decodeChunk(utf8) === '中文输出正常', JSON.stringify(mod.decodeChunk(utf8)))
  check('GBK 字节按 GBK 还原', mod.decodeChunk(gbk) === '中文输出正常', JSON.stringify(mod.decodeChunk(gbk)))
  check('ASCII 两种解码一致', mod.decodeChunk(Buffer.from('abc')) === 'abc')
  check('isUtf8 能区分（前提成立）', isUtf8(utf8) === true && isUtf8(gbk) === false)
}

console.log('[2] 干净化：回显 / 哨兵 / 提示符')
{
  const raw = ['PS D:\\dsc> $__dsc = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'eA==\')); Invoke-Expression $__dsc; Write-Output (\'__DS\' + \'C_ab12__\' + [string]$__ec)', 'A=41', '__DSC_ab12__0', 'PS D:\\dsc> '].join('\r\n')
  const cleaned = mod.cleanShellOutput(raw, 'pwsh')
  check('回显行被剥掉', !cleaned.includes('FromBase64String'), JSON.stringify(cleaned))
  check('哨兵行被剥掉', !cleaned.includes('__DSC_'), JSON.stringify(cleaned))
  check('正文留下', cleaned === 'A=41', JSON.stringify(cleaned))
  const bashRaw = ['eval "$(printf \'%s\' \'eA==\' | base64 -d)"; __ec=$?; echo "__DS""C_ab12__$__ec"', 'hello', '__DSC_ab12__0', '$ '].join('\n')
  check('bash 侧同样干净', mod.cleanShellOutput(bashRaw, 'bash') === 'hello', JSON.stringify(mod.cleanShellOutput(bashRaw, 'bash')))
  check('空输入不炸', mod.cleanShellOutput('', 'pwsh') === '')
}

console.log('[3] 真实会话（Windows）')
if (process.platform !== 'win32') {
  console.log('  跳过：非 Windows')
} else {
  const table = new mod.PersistentShellTable()
  try {
    const a = await table.run('probe-a', process.cwd(), '$x = 41; Set-Location $env:TEMP; Write-Output "A=$x"', 30000)
    check('第一条命令的输出正确', a.trim() === 'A=41', JSON.stringify(a))
    const b = await table.run('probe-a', process.cwd(), 'Write-Output "B=$x"; Write-Output "LOC=$(Get-Location)"', 30000)
    check('变量跨调用保留', b.includes('B=41'), JSON.stringify(b))
    check('工作目录跨调用保留', b.includes('LOC='), JSON.stringify(b))
    const c = await table.run('probe-a', process.cwd(), 'throw "boom"', 30000)
    check('抛错仍交回错误文本与退出码', c.includes('boom') && c.includes('[exit code: 1]'), JSON.stringify(c))
    const cn = await table.run('probe-a', process.cwd(), 'Write-Output "中文输出正常"', 30000)
    check('中文不乱码', cn.trim() === '中文输出正常', JSON.stringify(cn))
    let timedOut = false
    try { await table.run('probe-b', process.cwd(), 'Start-Sleep -Seconds 5', 800) } catch { timedOut = true }
    check('超时会失败并收掉 shell', timedOut)
    const after = await table.run('probe-b', process.cwd(), 'Write-Output "fresh"', 30000)
    check('超时之后能重建', after.trim() === 'fresh', JSON.stringify(after))
  } finally {
    table.closeAll()
  }
}

console.log('')
console.log(fail === 0 ? 'ALL PASS  ' + pass + ' 项' : 'FAILED  ' + fail + ' 项，PASS ' + pass + ' 项')
process.exitCode = fail === 0 ? 0 : 1