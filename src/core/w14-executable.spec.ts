/**
 * `core/executable.ts` 的补测（W14）：命令解析里「PATH 缺失」「Windows 上大写变量名」
 * 「一套环境里一个都搜不到」三条分支。
 *
 * 明细里的 89 / 119-124 / 126 都在 `missingCommandReason` 与 `readEnvValue` 里：
 * 前者是「子进程环境连 PATH 都没有」时的专门措辞，后者是 Windows 变量名不分大小写
 * 的兜底查法。后者只在 win32 有意义，非 Windows 平台跳过。
 *
 * @module dsc/core/w14-executable.spec
 */
import { describe, expect, test } from 'vitest'
import { FALLBACK_PATHEXT, missingCommandReason, resolveExecutable } from './executable.js'

describe('missingCommandReason：环境里没有 PATH 时说清这不是「没装」', () => {
  test('空环境：直接点破「宿主环境变量的问题」', () => {
    const reason = missingCommandReason('numa', {})
    expect(reason).toContain('没有 PATH')
    expect(reason).toContain('不是这个程序没装')
  })

  test('有 PATH：说清找过几个目录、试过哪些后缀', () => {
    const env =
      process.platform === 'win32' ? { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE;.CMD' } : { PATH: '/usr/local/bin:/usr/bin' }
    const reason = missingCommandReason('definitely-not-here-xyz', env)
    expect(reason).toContain('没找到')
    expect(reason).toContain('definitely-not-here-xyz')
  })
})

describe('readEnvValue：Windows 上变量名不分大小写（明细 119-124 / 126）', () => {
  test.skipIf(process.platform !== 'win32')('小写的 path / pathext 也能被读到', () => {
    const resolved = resolveExecutable('cmd', { path: 'C:\\Windows\\System32', pathext: '.EXE' }, '')
    expect(resolved.found).toBe(true)
    expect(resolved.file.toLowerCase().endsWith('cmd.exe')).toBe(true)
  })

  test.skipIf(process.platform !== 'win32')('一个都匹配不上时 readEnvValue 返回 undefined，回落内置后缀表', () => {
    const resolved = resolveExecutable('definitely-not-here-xyz', { unrelated: '1' }, '')
    expect(resolved.found).toBe(false)
    expect(resolved.file).toBe('definitely-not-here-xyz')
    expect(FALLBACK_PATHEXT.length).toBeGreaterThan(0)
  })
})
