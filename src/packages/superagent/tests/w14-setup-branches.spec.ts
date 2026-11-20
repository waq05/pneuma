/**
 * `app/setup.ts` 的解析失败分支覆盖（W14）。
 *
 * `resolve()` 的后半段（飞书 SetupError 降级、写环境失败转 environmentFailed、应用环境变量、
 * verifyEnvironment 失败时先还原再抛）此前没有任何 unit 用例走到：真跑要真 gh / 真 lark-cli。
 *
 * 这里把 `deployment.ts` 的探测函数与 `infra/environment.ts` 的两个有副作用函数换成受控假件，
 * 其余（Setup 的判定顺序、SetupError 的装配、SetupProblem 字段）全是真代码。
 *
 * @module dsc/packages/superagent/tests/w14-setup-branches
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, test, vi } from 'vitest'

// ── 受控假件 ────────────────────────────────────────────────────────────────

const fake = vi.hoisted(() => ({
  feishuFails: false,
  writeFails: false,
  verifyFails: false,
}))

vi.mock('../deployment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deployment.js')>()
  return {
    ...actual,
    workerProbe: () => () => undefined,
    resolveDeployment: async (_machine: unknown, _config: unknown, _probe: unknown) => ({
      repository: 'acme/widgets',
      github: {
        cli: 'gh',
        login: 'agent',
        noreply: '1+agent@users.noreply.github.com',
      },
      stateDir: (globalThis as unknown as { __w14StateDir?: string }).__w14StateDir ?? '/state',
    }),
    resolveFeishuBot: async () => {
      const { SetupError } = await import('../setup.js')
      if (fake.feishuFails)
        throw new SetupError('feishuBotNotReady', {
          app: 'cli_app',
          status: 'stopped',
        })
      return {
        cli: 'lark-cli',
        appId: 'cli_app',
        brand: 'feishu',
        botId: 'ou_bot',
        name: 'Bot',
      }
    },
  }
})

vi.mock('../infra/environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/environment.js')>()
  return {
    ...actual,
    writeEnvironment: async (...args: unknown[]) => {
      if (fake.writeFails) throw new Error('disk full')
      return actual.writeEnvironment(...(args as Parameters<typeof actual.writeEnvironment>))
    },
    applyEnvironment: () => () => {},
    verifyEnvironment: async () => {
      if (fake.verifyFails) throw new Error('git says no')
    },
  }
})

const { Setup } = await import('../app/setup.js')
const { SettingsSchema } = await import('../core/policy.js')

const stateDir = mkdtempSync(join(tmpdir(), 'dsc-w14-setup-'))
;(globalThis as unknown as { __w14StateDir?: string }).__w14StateDir = stateDir

afterAll(() => {
  rmSync(stateDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })
})

const warnings: string[] = []
const ctx = {
  logger: {
    warn: (format: string, ...values: unknown[]) => {
      warnings.push(`${format} ${values.map(String).join(' ')}`)
    },
  },
} as unknown as Context

function makeSetup(): InstanceType<typeof Setup> {
  return new Setup({
    context: ctx,
    machine: {
      stateDir,
      promptMaxChars: 100_000,
      admissionContextMaxPages: 10,
      admissionContextTimeoutMs: 15_000,
    },
    lifetime: new AbortController().signal,
    restart: () => {},
  })
}

const settings = SettingsSchema.parse({})

describe('Setup.resolve：飞书失败降级', () => {
  test('飞书 CLI 解析失败只记 feishuProblem 并警告，GitHub 部署照常落地', async () => {
    fake.feishuFails = true
    fake.writeFails = false
    fake.verifyFails = false
    warnings.length = 0
    const setup = makeSetup()
    try {
      await expect(setup.run(settings)).resolves.toBe(true)
      expect(setup.configured()).toBe(true)
      expect(setup.deployment.repository).toBe('acme/widgets')
      expect(setup.deployment.feishu).toBeUndefined()
      expect(setup.feishuProblem?.code).toBe('feishuBotNotReady')
      expect(warnings.join('\n')).toContain('leaves Feishu out')
    } finally {
      setup.restore()
      fake.feishuFails = false
    }
  })
})

describe('Setup.resolve：写环境 / 验证环境的失败', () => {
  test('写 worker 环境失败（非 SetupError）：转成 environmentFailed', async () => {
    fake.writeFails = true
    const setup = makeSetup()
    try {
      await expect(setup.run(settings)).resolves.toBe(false)
      expect(setup.configured()).toBe(false)
      expect(setup.problem?.code).toBe('environmentFailed')
      expect(setup.problem?.detail).toContain('disk full')
    } finally {
      setup.restore()
      fake.writeFails = false
    }
  })

  test('verifyEnvironment 失败：先还原环境，再把错误转成 environmentFailed', async () => {
    fake.verifyFails = true
    const setup = makeSetup()
    try {
      await expect(setup.run(settings)).resolves.toBe(false)
      expect(setup.problem?.code).toBe('environmentFailed')
      expect(setup.problem?.detail).toContain('git says no')
    } finally {
      setup.restore()
      fake.verifyFails = false
    }
  })

  test('全部通过：环境落地、applyEnvironment 记下还原函数、configured 为真', async () => {
    const setup = makeSetup()
    try {
      await expect(setup.run(settings)).resolves.toBe(true)
      expect(setup.configured()).toBe(true)
      const deployment = setup.deployment
      expect(deployment.repository).toBe('acme/widgets')
      // getter 面：commandEnvironment 带 agent git 变量与去掉 shim 的 PATH。
      expect(setup.commandEnvironment['PATH']).toBeTypeOf('string')
    } finally {
      setup.restore()
    }
  })
})
