/**
 * `core/terminal-env.ts` 的缺口补齐：探测子进程的三种失败面——`spawnSync` 自己抛错、
 * PowerShell 5.1 不存在、WSL 没有能用的发行版。
 *
 * `node:child_process` 被换成表驱动的假实现：这些分支要的是「程序装没装 / 输出长什么样」，
 * 在真机上造不出来（真的 WSL 与真的 Docker Desktop 发行版不能为了测试去改）。
 * `SystemRoot` 指到临时目录，不碰真实系统目录；`DSC_HOME` 也指到临时目录（探测缓存落这里）。
 *
 * @module dsc/core/w14b-terminal-env-spawn.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

/** 假 spawnSync 的控制面：每个用例改一个函数。 */
const control = vi.hoisted(() => ({
  spawn: null as null | ((file: string, args: readonly string[]) => unknown),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: (file: string, args: readonly string[], options?: unknown) => {
      if (control.spawn !== null) return control.spawn(file, args)
      return actual.spawnSync(file, args, options as never)
    },
  }
})

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-shell-'))
const SYSTEM_ROOT = join(HOME, 'windows')
process.env['DSC_HOME'] = HOME
const savedSystemRoot = process.env['SystemRoot']

type TerminalEnv = typeof import('./terminal-env.js')
let env: TerminalEnv

beforeAll(async () => {
  mkdirSync(SYSTEM_ROOT, { recursive: true })
  env = await import('./terminal-env.js')
})

afterAll(() => {
  if (savedSystemRoot === undefined) delete process.env['SystemRoot']
  else process.env['SystemRoot'] = savedSystemRoot
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

beforeEach(() => {
  control.spawn = null
  env.forgetShellDetection()
})

/** 一次成功的探测输出。 */
function ok(text = ''): unknown {
  return { error: undefined, status: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0) }
}

describe('probe：spawnSync 自己抛错', () => {
  test('探测退化成「没版本号」，不把异常抛给调用方', () => {
    control.spawn = () => {
      throw new Error('spawn 挂了')
    }
    const shells = env.detectShells(true)
    expect(shells[0]?.value).toBe('auto')
    expect(shells).toHaveLength(5)
    // powershell.exe 的路径存在（真 SystemRoot），但探版本那次抛错：标签退化成静态名。
    const powershell = shells.find((item) => item.value === 'powershell')
    expect(powershell?.label).toBe('PowerShell 5.1')
    // pwsh 的每条候选都探不动：最后一条「没装」的兜底文案。
    expect(shells.find((item) => item.value === 'pwsh')?.detail).toContain('没装 pwsh.exe')
  })
})

describe('detectWindowsPowerShell / detectWsl：装没装与能不能用', () => {
  test('SystemRoot 下没有 powershell.exe / wsl.exe：都标不可用并说清原因', () => {
    process.env['SystemRoot'] = SYSTEM_ROOT
    // where.exe 什么也没找到（PATH 里没有这些程序）。
    control.spawn = () => ok('')
    const shells = env.detectShells(true)
    const powershell = shells.find((item) => item.value === 'powershell')
    expect(powershell?.available).toBe(false)
    expect(powershell?.detail).toContain('没找到 powershell.exe')
    const wsl = shells.find((item) => item.value === 'wsl')
    expect(wsl?.available).toBe(false)
    expect(wsl?.detail).toContain('没装 WSL')
  })

  test('wsl.exe --status 通、发行版只有 Docker 管理的两个：判不可用', () => {
    // wsl.exe 放在 SystemRoot 下，where.exe 找不到它，走「固定路径」那一路。
    mkdirSync(join(SYSTEM_ROOT, 'System32'), { recursive: true })
    const wslExe = join(SYSTEM_ROOT, 'System32', 'wsl.exe')
    writeFileSync(wslExe, '', 'utf8')
    process.env['SystemRoot'] = SYSTEM_ROOT
    control.spawn = (file, args) => {
      if (file.toLowerCase().endsWith('where.exe')) return ok('')
      if (args[0] === '--status') return ok('Default Distribution: docker-desktop')
      if (args[0] === '-l' && args[1] === '-v') {
        return ok(
          '  NAME            STATE           VERSION\n* docker-desktop  Running         2\ndocker-desktop-data Stopped      2\n',
        )
      }
      return { error: new Error('ENOENT'), status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    }
    const wsl = env.detectShells(true).find((item) => item.value === 'wsl')
    expect(wsl?.available).toBe(false)
    expect(wsl?.detail).toContain('没有能跑命令的 Linux 发行版')
  })
})
