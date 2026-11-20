/**
 * `numa plugin` 子命令的 W14 补缺口测试：pnpm 侧的三种收场与清单/组合包的边角。
 *
 * 与 `plugin-cli-extra.spec.ts` 同一套做法：替换 argv、临时 `DSC_HOME`、拦 `process.exit`
 * 后重新 import 入口模块；`spawnSync` 用桩控制（不起真 pnpm、不碰网络与全局 store）。
 *
 * 覆盖：
 *   - pnpm 起不来（error）与没正常结束（status=null）两句提示与退出码；
 *   - `add` 成功后问 `pnpm ignored-builds` 并把被跳过的脚本提示打出来；
 *   - `list` 读 entries（数组里有坏项）、组合包目录没有 package.json；
 *   - `builds` 在 pnpm 起不来时的提示与退出码；
 *   - `--profile` 缺省时回落到 default profile。
 *
 * @module @pneuma/cli/tests/w14-plugin-cli-pnpm
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test, vi } from 'vitest'

/** 脚本里 `process.exit` 被调用时抛出的信号。 */
class CliExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${String(code)})`)
  }
}

const state = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'error' | 'null-status',
  logs: [] as Array<{ call: number; stdout: string }>,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: (command: string, args: readonly string[]) => {
      const call = state.logs.length
      state.logs.push({ call, stdout: '' })
      if (state.mode === 'error')
        return {
          error: new Error('spawn pnpm ENOENT'),
          status: null,
          stdout: '',
          stderr: '',
        }
      if (state.mode === 'null-status') return { error: undefined, status: null, stdout: '', stderr: '' }
      // 默认成功：`ignored-builds` 的探针回一行包名，其余（add/remove）什么都不回。
      const stdout = args.includes('ignored-builds') ? 'demo-pkg\n' : ''
      return { error: undefined, status: 0, stdout, stderr: '' }
    },
  }
})

const home = mkdtempSync(join(tmpdir(), 'dsc-cli-w14-'))

interface CliRun {
  code: number
  out: string
}

/** 跑一次 CLI：改 argv / HOME，拦 console 与 process.exit。 */
async function runPlugin(args: readonly string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const argv = process.argv
  const keys = ['DSC_HOME', 'DSC_UI_SERVER', 'DSC_PROFILE', ...Object.keys(env)]
  const before = new Map(keys.map((key) => [key, process.env[key]]))
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '))
  })
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new CliExit(typeof code === 'number' ? code : 0)
  }) as typeof process.exit)
  process.argv = [process.execPath, 'plugin-cli.js', ...args]
  process.env['DSC_HOME'] = home
  process.env['DSC_UI_SERVER'] = '0'
  process.env['DSC_PROFILE'] = ''
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  let code = 0
  try {
    vi.resetModules()
    await import('../plugin-cli.js')
  } catch (thrown) {
    if (!(thrown instanceof CliExit)) throw thrown
    code = thrown.code
  } finally {
    process.argv = argv
    exit.mockRestore()
    log.mockRestore()
    error.mockRestore()
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return { code, out: lines.join('\n') }
}

afterEach(() => {
  state.mode = 'ok'
  state.logs.length = 0
})

afterAll(() => {
  try {
    rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  } catch {
    // 临时目录留给系统清。
  }
})

test('pnpm 起不来：提示装 pnpm 与手动命令，退出码 1', async () => {
  state.mode = 'error'
  const run = await runPlugin(['add', 'demo-pkg'])
  expect(run.code).toBe(1)
  expect(run.out).toContain('没能启动 pnpm')
  expect(run.out).toContain('pnpm add demo-pkg')
})

test('pnpm 没正常结束（可能被中断）：说清楚并返回 1', async () => {
  state.mode = 'null-status'
  const run = await runPlugin(['add', 'demo-pkg'])
  expect(run.code).toBe(1)
  expect(run.out).toContain('pnpm 没有正常结束')
})

test('add 成功后问 ignored-builds，有被跳过的脚本就打出建议', async () => {
  const run = await runPlugin(['add', 'demo-pkg'])
  expect(run.code).toBe(0)
  expect(run.out).toContain('装上了')
  // 第二次 spawnSync 是 ignored-builds 探针；建议文案里要带上包名与 profile 目录。
  expect(state.logs.length).toBeGreaterThanOrEqual(2)
  expect(run.out).toContain('demo-pkg')
})

test('list：entries 数组里的坏项跳过、组合包目录缺 package.json 时给提示', async () => {
  const profile = join(home, 'profiles', 'default')
  mkdirSync(join(profile, 'node_modules', 'broken-bundle'), {
    recursive: true,
  })
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'pneuma-profile',
      private: true,
      dsh: { profile: { bundles: ['broken-bundle'] } },
    }),
    'utf8',
  )
  writeFileSync(
    join(home, 'plugins.json'),
    JSON.stringify({
      version: 1,
      entries: [null, 42, { file: 'demo', disabled: true }, { file: 7 }],
    }),
    'utf8',
  )
  const run = await runPlugin(['list'])
  expect(run.code).toBe(0)
  expect(run.out).toContain('broken-bundle')
  expect(run.out).toContain('没有 package.json')
})

test('builds：pnpm 起不来时提示并返回 1', async () => {
  const profile = join(home, 'profiles', 'default')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'pneuma-profile', private: true }), 'utf8')
  state.mode = 'error'
  const run = await runPlugin(['builds'])
  expect(run.code).toBe(1)
  expect(run.out).toContain('没能启动 pnpm')
})

test('不给 --profile 且 DSC_PROFILE 为空：回落到 profiles/default', async () => {
  const run = await runPlugin(['builds'])
  expect(run.code).toBe(0)
  expect(run.out).toContain(join('profiles', 'default'))
})
