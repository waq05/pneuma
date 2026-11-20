/**
 * `core/terminal-env.ts` 的 POSIX 分支：`detectPosixShell` 与 `resolveShellExecutable` 的
 * `sh` / `auto` 两路。
 *
 * 这个 spec 在 Windows 开发机上把 `process.platform` 在**导入产品模块之前**临时改成
 * `linux`（模块顶层的 `isWin` 是导入时求值的常量），导入完立刻恢复——不影响 vitest 自己
 * 与后续测试；这时探测本身仍是真的（`which` / `/bin/sh` 在本机起不来，于是走 ok=false 的兜底）。
 * 在 Linux CI 上这个覆盖等价于原值，模块看到的就是真 POSIX 环境，断言必须按真行为走：
 * 标签会带真实版本号（`sh（5.3.9）`）、`which bash` 会给出真实路径。
 *
 * @module dsc/core/w14b-terminal-env-posix.spec
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
    const label = shells[1]?.label ?? ''
    const detail = shells[1]?.detail ?? ''
    if (process.platform === 'win32') {
      // 本机没有 bash/sh（Windows 上映射成 linux 后起不来）：版本探测走 ok=false，
      // 标签退化成静态名（terminal-env.ts:264）。
      expect(label).toBe('sh')
      return
    }
    // 真 Linux：`which bash` 在 PATH 里找到解释器（GitHub runner 上是 /usr/bin/bash），
    // probe `--version` 成功 → 标签是 `sh（<版本>）`；探测失败才会退化成裸 `sh`。
    // 两条路都只要求以 sh 开头，版本后缀可有可无。
    expect(label.startsWith('sh')).toBe(true)
    expect(label).toMatch(/^sh(?:（\d+\.\d+(?:\.\d+)?）)?$/)
    // detail 是 which 找到的真实路径；一个都找不到才回落字面量 '/bin/sh'。
    expect(existsSync(detail)).toBe(true)
  })

  test('resolveShellExecutable：显式选 sh 与 auto 都落到 sh', () => {
    const shells = env.detectShells(true)
    const executable = env.resolveShellExecutable('sh')
    if (process.platform === 'win32') {
      // 模拟 POSIX 但本机没有可用的 /bin/sh：pick 拿不到候选，返回字面量（terminal-env.ts:488）。
      expect(executable).toBe('/bin/sh')
    } else {
      // 真 Linux：返回探测到的真实可执行路径（即 sh 候选的 detail，terminal-env.ts:480-488），
      // 不是一个好看的占位串——它必须真是磁盘上存在的文件。
      expect(executable).toBe(shells[1]?.detail)
      expect(existsSync(executable)).toBe(true)
    }
    // auto 在非 Windows 上直接返回 'sh'（terminal-env.ts:489），与探测结果无关。
    expect(env.resolveShellExecutable('auto')).toBe('sh')
  })
})
