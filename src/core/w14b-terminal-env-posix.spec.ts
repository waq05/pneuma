/**
 * `core/terminal-env.ts` 的 POSIX 分支：`detectPosixShell` 与 `resolveShellExecutable` 的
 * `sh` / `auto` 两路。
 *
 * 这一批只在 Windows 开发机上跑，所以 `process.platform` 在**导入产品模块之前**临时改成
 * `linux`（模块顶层的 `isWin` 是导入时求值的常量），导入完立刻恢复——不影响 vitest 自己
 * 与后续测试；探测本身仍是真的（`which` / `/bin/sh` 在本机起不来，于是走 ok=false 的兜底）。
 *
 * @module dsc/core/w14b-terminal-env-posix.spec
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-shell-posix-'))
process.env['DSC_HOME'] = HOME

type TerminalEnv = typeof import('./terminal-env.js')
let env: TerminalEnv

beforeAll(async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  try {
    env = await import('./terminal-env.js')
  } finally {
    // 立刻恢复：isWin 已经在模块顶层取过值，后面不再依赖 platform 属性。
    if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

describe('POSIX 平台的探测与落地', () => {
  test('detectShells 只给 auto + sh；sh 的不可用探测也照常返回候选', () => {
    const shells = env.detectShells(true)
    expect(shells.map((item) => item.value)).toEqual(['auto', 'sh'])
    expect(shells[1]?.available).toBe(true)
    // 本机没有 bash/sh（Windows 上映射成 linux 后起不来）：标签退化成静态名。
    expect(shells[1]?.label).toBe('sh')
  })

  test('resolveShellExecutable：显式选 sh 与 auto 都落到 sh', () => {
    env.detectShells(true)
    expect(env.resolveShellExecutable('sh')).toBe('/bin/sh')
    expect(env.resolveShellExecutable('auto')).toBe('sh')
  })
})
