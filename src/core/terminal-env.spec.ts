/**
 * 终端选择里可确定判定的那半（unit 层）。
 *
 * `terminal-env.ts` 大部分导出要起子进程（`spawnSync`）、读 `~/.dsc` 缓存、读 `plugins.json`，
 * 那部分归 integration 层，这里不碰。本文件只测三个不触 I/O 的导出：
 *
 * - `SHELL_CHOICES`：写盘校验与界面选项共用的一份清单；
 * - `parseShellChoice`：把配置里的任意值收敛成合法选择；
 * - `shellFlavor`：按选择决定结构扫描用哪套语法。
 *
 * 为什么值得钉：这份清单少一项，用户已保存的选择在下次启动就被回落成 `auto`，
 * 且不报错——用户看到的是「我明明选了 Git Bash，它却按 PowerShell 解释命令」。
 *
 * @module dsc/core/terminal-env.spec
 */
import { expect, test } from 'vitest'
import { SHELL_CHOICES, parseShellChoice, shellFlavor } from './terminal-env.js'

test('全部可配取值按设置页顺序固定为六项', () => {
  // 顺序就是设置页的展示顺序，值是写进 plugins.json 的字符串：少一项或改一个字
  // 都会让已保存的配置在读取时静默回落，不是「多个选项」而是「设置丢了」。
  expect(SHELL_CHOICES).toEqual(['auto', 'powershell', 'pwsh', 'gitbash', 'wsl', 'sh'])
})

test.each([...SHELL_CHOICES])('配置里写 %s 时原样认下', (value) => {
  // 用常量展开而不是手抄六个字面量：认下的集合必须与对外公布的集合一致。
  // 逐个值断言，是因为实现若误用了 `startsWith` / `toLowerCase`，只会在个别值上错。
  expect(parseShellChoice(value)).toBe(value)
})

test('大小写不同不算同一个值（配置值区分大小写）', () => {
  // 曾经把 `PowerShell` 写进配置的人应该走回落而不是「猜他要哪一个」；
  // 猜错的表现是命令按另一套语法解释，比直接回落更难查。
  expect(parseShellChoice('PowerShell')).toBe('auto')
  expect(parseShellChoice('WSL')).toBe('auto')
})

test('认不出的字符串回落 auto', () => {
  // 配置文件手改坏不该让宿主起不来，这是模块注释写明的兜底。
  expect(parseShellChoice('cmd')).toBe('auto')
  expect(parseShellChoice('')).toBe('auto')
  expect(parseShellChoice(' pwsh')).toBe('auto')
})

test('非字符串回落 auto', () => {
  // JSON 里数字、布尔、对象都合法；不回落会在配置读取阶段抛错。
  expect(parseShellChoice(null)).toBe('auto')
  expect(parseShellChoice(undefined)).toBe('auto')
  expect(parseShellChoice(7)).toBe('auto')
  expect(parseShellChoice(true)).toBe('auto')
  expect(parseShellChoice({})).toBe('auto')
})

test('powershell 与 pwsh 都按 PowerShell 语法扫描', () => {
  // 两个值起的是同一个语言的 shell；只认其中一个会让 `$env:PATH` 被当成 POSIX 变量。
  expect(shellFlavor('powershell')).toBe('powershell')
  expect(shellFlavor('pwsh')).toBe('powershell')
})

test('gitbash、wsl、sh 按 POSIX 语法扫描', () => {
  // 这三个都跑 sh/bash；按 PowerShell 扫描会把 `$HOME` 解析成别的变量名。
  expect(shellFlavor('gitbash')).toBe('posix')
  expect(shellFlavor('wsl')).toBe('posix')
  expect(shellFlavor('sh')).toBe('posix')
})

test('auto 跟随平台：Windows 按 PowerShell，其余按 POSIX', () => {
  // auto 的语义就是「和平台默认一致」；写死一边会让另一半平台的用户命令全被错判。
  expect(shellFlavor('auto')).toBe(process.platform === 'win32' ? 'powershell' : 'posix')
})
