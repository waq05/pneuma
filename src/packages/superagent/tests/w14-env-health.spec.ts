/**
 * `infra/environment.ts` 的 worker git 校验与 `host/health.ts` 的依赖体检探测分支。
 *
 * 环境校验：`verifyEnvironment` / `verifyDirectory` 真正要跑 `git config` 才能判「worker 的
 * git 会不会读到不该读的配置」。这里在临时目录里真跑 git（`git init` + 写 local config），
 * 覆盖「配置对不上直接报 gitTooOld」与「仓库自己配了 credential.* 就拒绝」两条错误分支——
 * 它们此前只在走 `lib/` 构建产物的包级探针里跑到过，vitest 覆盖率里是空白。
 *
 * 体检：`probeVersion` 的四条结局（超时 / 起不来 / 非零退出 / spawn 抛错）与
 * `createTeammatesHealth` 的读插件表失败，用受控的 `spawnSync` 假件驱动，不起真 CLI。
 *
 * @module dsc/packages/superagent/tests/w14-env-health
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

// ── 受控的 spawnSync（health.ts 的版本探测注入点）───────────────────────────

const cp = vi.hoisted(() => ({
  spawnSync: null as null | ((...args: unknown[]) => unknown),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => (cp.spawnSync === null ? actual.spawnSync(...(args as [string])) : cp.spawnSync(...args)),
  }
})

/** 在目录里初始化一个真 git 仓库（临时目录，不碰工作区）。 */
function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' })
  return dir
}

const signal = new AbortController().signal

describe('verifyEnvironment：worker git 的凭证助手必须与部署一致', () => {
  test('stateDir 里没有 worker gitconfig：helper 列表对不上，报 gitTooOld', async () => {
    const { verifyEnvironment } = await import('../infra/environment.js')
    const stateDir = createTempDir('dsc-env-verify-')
    await expect(verifyEnvironment({ github: { cli: 'gh' }, stateDir } as never, signal)).rejects.toMatchObject({
      code: 'gitTooOld',
    })
  })
})

describe('verifyDirectory：仓库自己的 credential / extraheader 配置', () => {
  test('干净仓库：git config --get-regexp 退出码 1 当作「没有」处理，不抛', async () => {
    const { verifyDirectory } = await import('../infra/environment.js')
    const dir = initRepo(join(createTempDir('dsc-env-clean-'), 'repo'))
    await expect(verifyDirectory(dir, signal)).resolves.toBeUndefined()
  })

  test('仓库 local config 配了 credential.helper：报出键名并拒绝', async () => {
    const { verifyDirectory } = await import('../infra/environment.js')
    const dir = initRepo(join(createTempDir('dsc-env-dirty-'), 'repo'))
    execFileSync('git', ['config', '--local', 'credential.helper', 'store'], {
      cwd: dir,
      stdio: 'ignore',
    })
    await expect(verifyDirectory(dir, signal)).rejects.toThrow(/sets credential\.helper/)
  })

  test('worktree 里配了 http.extraheader 也拒绝', async () => {
    const { verifyDirectory } = await import('../infra/environment.js')
    const dir = initRepo(join(createTempDir('dsc-env-scope-'), 'repo'))
    execFileSync('git', ['config', '--local', 'http.extraheader', 'AUTHORIZATION: bearer x'], { cwd: dir, stdio: 'ignore' })
    await expect(verifyDirectory(dir, signal)).rejects.toThrow(/http\.extraheader/)
  })
})

// ── 依赖体检：版本探测的四条结局 ──────────────────────────────────────────

interface SourceSettings {
  sources: {
    github?: { config?: Record<string, unknown> }
    feishu?: { config?: Record<string, unknown> }
  }
}

/** 体检项只读 `runtime.store.settings()`。 */
function fakeRuntime(settings: SourceSettings) {
  return { store: { settings: () => settings } }
}

const CLI = process.execPath

/** 摆一份「两个来源都填了 CLI」的设置；`probeVersion` 从设置里取命令名。 */
const configured = (): SourceSettings => ({
  sources: {
    github: { config: { cli: CLI } },
    feishu: { config: { cli: CLI } },
  },
})

describe('createDependenciesHealth：spawnSync 的四种结局', () => {
  test('超时：报「--version 超过 5 秒没结束」', async () => {
    const { createDependenciesHealth } = await import('../host/health.js')
    cp.spawnSync = () => ({
      error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    })
    const result = await createDependenciesHealth(fakeRuntime(configured()) as never).run()
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('版本号读不出来')
    expect(result.detail).toContain('--version 超过 5 秒没结束')
  })

  test('起不来：把底层错误信息原样带出', async () => {
    const { createDependenciesHealth } = await import('../host/health.js')
    cp.spawnSync = () => ({
      error: Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      }),
    })
    const result = await createDependenciesHealth(fakeRuntime(configured()) as never).run()
    expect(result.status).toBe('warn')
    expect(result.detail).toContain('EACCES: permission denied')
  })

  test('非零退出：带退出码与它打印的第一行', async () => {
    const { createDependenciesHealth } = await import('../host/health.js')
    cp.spawnSync = () => ({ status: 2, stdout: '', stderr: 'not a flag\n' })
    const result = await createDependenciesHealth(fakeRuntime(configured()) as never).run()
    expect(result.status).toBe('warn')
    expect(result.detail).toContain('--version 退出码 2：not a flag')
    // 全部 failed（不是 missing）走「装了却跑不通」那一支。
    expect(result.fix).toContain('退出码说明它不认 --version 参数')
  })

  test('spawnSync 自己抛错：只报 warn，不把 /doctor 弄脏', async () => {
    const { createDependenciesHealth } = await import('../host/health.js')
    cp.spawnSync = () => {
      throw new Error('spawn boom')
    }
    const result = await createDependenciesHealth(fakeRuntime(configured()) as never).run()
    expect(result.status).toBe('warn')
    expect(result.detail).toContain('spawn boom')
  })
})

// `createTeammatesHealth` 的 catch（health.ts:344-349）不可达：`readPluginEntries` 内部已经
// 把所有读盘/解析异常吞掉并返回 []，这个体检项拿不到会抛的输入。
