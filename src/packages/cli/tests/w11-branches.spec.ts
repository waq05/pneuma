/**
 * `numa config` 子命令的补盲（`packages/cli/config-cli.ts`）。
 *
 * 这个文件是「内核起来之前」的脚本：顶层读 argv、末尾 process.exit。测试按既有
 * `cli.spec.ts` 的做法在进程内跑：`vi.resetModules()` 后动态 import 源码，把
 * `process.exit` 拦成异常，HOME / USERPROFILE / DSC_HOME 指向临时目录——不碰真实
 * `~/.dsh` 与 `~/.dsc`，也不需要 build。
 *
 * 覆盖：migrate 的找不到 dsh / 成功 / 幂等 / --force，show 的空端点、默认标记与
 * 四种 key 来源标注，以及无参数/未知子命令的退出码。
 *
 * @module @pneuma/cli/tests/w11-branches.spec
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${String(code)})`)
  }
}

interface CliRun {
  code: number
  out: string
}

const sandboxes: string[] = []

/** 每个用例一套干净的 HOME + DSC_HOME。 */
function sandbox(): { home: string; dsc: string } {
  const root = mkdtempSync(join(tmpdir(), 'numa-config-cli-w11-'))
  sandboxes.push(root)
  const home = join(root, 'home')
  const dsc = join(root, 'dsc')
  mkdirSync(home, { recursive: true })
  mkdirSync(dsc, { recursive: true })
  return { home, dsc }
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 上偶发占用：临时目录交给系统清
    }
  }
})

/** 在测试进程里执行一次 `numa config <args>`。 */
async function runConfig(args: readonly string[], env: { home: string; dsc: string; extra?: Record<string, string> }): Promise<CliRun> {
  const touched = ['HOME', 'USERPROFILE', 'DSC_HOME', ...Object.keys(env.extra ?? {})]
  const before = new Map(touched.map((key) => [key, process.env[key]]))
  const argv = process.argv
  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '))
  })
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new CliExit(typeof code === 'number' ? code : 0)
  }) as typeof process.exit)
  process.argv = [process.execPath, 'config-cli', ...args]
  process.env['HOME'] = env.home
  process.env['USERPROFILE'] = env.home
  process.env['DSC_HOME'] = env.dsc
  for (const [key, value] of Object.entries(env.extra ?? {})) process.env[key] = value
  let code = 0
  try {
    vi.resetModules()
    await import('../config-cli.js')
  } catch (thrown) {
    if (!(thrown instanceof CliExit)) throw thrown
    code = thrown.code
  } finally {
    process.argv = argv
    exit.mockRestore()
    log.mockRestore()
    for (const key of touched) {
      const value = before.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  return { code, out: lines.join('\n') }
}

/** 写一份 dsh settings.yaml（一个可迁移端点 + 默认模型）。 */
function writeDshSettings(home: string): void {
  mkdirSync(join(home, '.dsh'), { recursive: true })
  writeFileSync(
    join(home, '.dsh', 'settings.yaml'),
    [
      'llm-pi-ai:',
      '  providers:',
      '    demo:',
      '      api: openai-completions',
      '      baseURL: https://api.example.com/',
      '      apiKeyEnv: DEMO_KEY',
      '      displayName: Demo 端点',
      '      models:',
      '        - id: m1',
      '          contextWindow: 64000',
      'agent-default-model:',
      '  provider: demo',
      '  model: m1',
      '',
    ].join('\n'),
    'utf8',
  )
}

/** 写一份 dsc config.yaml。 */
function writeDscConfig(dsc: string, yaml: string): void {
  writeFileSync(join(dsc, 'config.yaml'), yaml, 'utf8')
}

const CONFIG_YAML = [
  'default:',
  '  provider: demo',
  '  model: m1',
  'providers:',
  '  demo:',
  '    displayName: Demo 端点',
  '    baseURL: https://api.example.com',
  '    apiKeyEnv: DEMO_KEY',
  '    models:',
  '      - id: m1',
  '        contextWindow: 64000',
  '',
].join('\n')

test('migrate：找不到 dsh 配置时退出 1 并给出两条可照做的提示', async () => {
  const { home, dsc } = sandbox()
  const run = await runConfig(['migrate'], { home, dsc })
  expect(run.code).toBe(1)
  expect(run.out).toContain('未找到 dsh 配置')
  expect(run.out).toContain('可直接编辑')
})

test('migrate：成功写 config + 凭据；再跑幂等；--force 覆盖重迁', async () => {
  const { home, dsc } = sandbox()
  writeDshSettings(home)
  writeFileSync(join(home, '.dsh', '.credentials.yaml'), 'refs:\n  DEMO_KEY: secret-value\n', 'utf8')

  const first = await runConfig(['migrate'], { home, dsc })
  expect(first.code).toBe(0)
  expect(first.out).toContain('迁移完成')
  expect(first.out).toContain('端点      demo')
  expect(first.out).toContain('默认      demo/m1')
  expect(first.out).toContain('凭据副本')
  expect(first.out).not.toContain('secret-value')
  expect(existsSync(join(dsc, 'config.yaml'))).toBe(true)
  expect(existsSync(join(dsc, 'credentials.yaml'))).toBe(true)

  const again = await runConfig(['migrate'], { home, dsc })
  expect(again.code).toBe(0)
  expect(again.out).toContain('目标配置已存在')

  const forced = await runConfig(['migrate', '--force'], { home, dsc })
  expect(forced.code).toBe(0)
  expect(forced.out).toContain('迁移完成')
})

test('migrate：dsh 配置在但没有可迁移端点 / 没有引用 key：都走「已存在」出口', async () => {
  const { home, dsc } = sandbox()
  mkdirSync(join(home, '.dsh'), { recursive: true })
  // 非 openai-completions 的端点不被迁移。
  writeFileSync(
    join(home, '.dsh', 'settings.yaml'),
    'llm-pi-ai:\n  providers:\n    other:\n      api: anthropic\n      baseURL: https://x\n      models:\n        - id: m\n',
    'utf8',
  )
  const run = await runConfig(['migrate'], { home, dsc })
  expect(run.code).toBe(0)
  expect(run.out).toContain('目标配置已存在')
  expect(existsSync(join(dsc, 'config.yaml'))).toBe(false)

  // 有端点但没有 apiKeyEnv：成功但凭据段说「未复制」。
  mkdirSync(join(dsc), { recursive: true })
  writeFileSync(
    join(home, '.dsh', 'settings.yaml'),
    'llm-pi-ai:\n  providers:\n    other:\n      api: openai-completions\n      baseURL: https://x\n      models:\n        - id: m\n',
    'utf8',
  )
  const migrated = await runConfig(['migrate'], { home, dsc })
  expect(migrated.code).toBe(0)
  expect(migrated.out).toContain('凭据      未复制')
})

test('show：没有可用端点时退出 1', async () => {
  const { home, dsc } = sandbox()
  writeDscConfig(dsc, 'providers: {}\n')
  const run = await runConfig(['show'], { home, dsc })
  expect(run.code).toBe(1)
  expect(run.out).toContain('可用端点  （无')
})

test('show：默认标记、三种 key 来源与上下文大小', async () => {
  const { home, dsc } = sandbox()
  writeDscConfig(dsc, CONFIG_YAML)

  // 1) dsc 凭据文件
  writeFileSync(join(dsc, 'credentials.yaml'), 'refs:\n  DEMO_KEY: from-dsc\n', 'utf8')
  const dscRun = await runConfig(['show'], { home, dsc, extra: { DEMO_KEY: 'from-env' } })
  expect(dscRun.code).toBe(0)
  expect(dscRun.out).toContain('端点 demo（Demo 端点）')
  expect(dscRun.out).toContain('DEMO_KEY（dsc 凭据文件）')
  expect(dscRun.out).toContain('64k 上下文 ←默认')

  // 2) 只有环境变量
  rmSync(join(dsc, 'credentials.yaml'), { force: true })
  const envRun = await runConfig(['show'], { home, dsc, extra: { DEMO_KEY: 'from-env' } })
  expect(envRun.out).toContain('DEMO_KEY（环境变量）')

  // 3) dsh 凭据回退（值与环境变量一致才算）
  mkdirSync(join(home, '.dsh'), { recursive: true })
  writeFileSync(join(home, '.dsh', '.credentials.yaml'), 'refs:\n  DEMO_KEY: same-value\n', 'utf8')
  const fallbackRun = await runConfig(['show'], { home, dsc, extra: { DEMO_KEY: 'same-value' } })
  expect(fallbackRun.out).toContain('DEMO_KEY（dsh 凭据回退）')
  expect(fallbackRun.out).toContain('默认路由  demo/m1')
})

test('无参数给用法并退出 0；未知子命令退出 1', async () => {
  const { home, dsc } = sandbox()
  const usage = await runConfig([], { home, dsc })
  expect(usage.code).toBe(0)
  expect(usage.out).toContain('numa config migrate')

  const unknown = await runConfig(['bogus'], { home, dsc })
  expect(unknown.code).toBe(1)
  expect(unknown.out).toContain('用法：numa config')
})
