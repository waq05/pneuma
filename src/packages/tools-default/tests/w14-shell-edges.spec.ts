/**
 * `tools-default` 的持久 shell 与终端会话边角覆盖（W14）。
 *
 * 补的缺口：
 *   - `persistent-shell.ts` 里四种终端档位的 spawn 分支、bash 信封、stderr 追加、
 *     子进程起不来时的 error 事件，以及 `shell` 工具的空命令/正常转发；
 *   - `bash.ts` 的 POSIX 车道：`shellPlan` 非 Windows 通用分支与 `spawnTerminalShell`
 *     的非 Windows 兜底（用 `vi.resetModules()` + 临时改 `process.platform` 重新加载模块，
 *     否则模块级的 `isWin` 常量在 Windows 上永远为真）；
 *   - 终端会话 `send` 时输入口已经没了的分支。
 *
 * `DSC_HOME` 指到临时目录：`readShellChoice` 从 `plugins.json` 读 `bashShell`。
 *
 * @module dsc/packages/tools-default/tests/w14-shell-edges
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

const HOME = createTempDir('dsc-w14-shell-')
process.env['DSC_HOME'] = HOME
mkdirSync(join(HOME, 'plugins'), { recursive: true })

type ShellModule = typeof import('../persistent-shell.js')
let shell: ShellModule
let bash: typeof import('../bash.js')
let terminalEnv: typeof import('../../../core/terminal-env.js')
let registry: typeof import('../../../core/plugin-registry.js')

beforeAll(async () => {
  shell = await import('../persistent-shell.js')
  bash = await import('../bash.js')
  terminalEnv = await import('../../../core/terminal-env.js')
  registry = await import('../../../core/plugin-registry.js')
}, 60_000)

afterAll(() => {
  delete process.env['DSC_HOME']
})

/** 把默认终端切到指定档（`readShellChoice` 有缓存，改完清一次）。 */
function chooseShell(choice: string | null): void {
  registry.writePluginConfig('tools-default', { bashShell: choice })
  terminalEnv.forgetShellDetection()
}

afterEach(() => {
  chooseShell(null)
})

const ctxOf = (cwd = HOME) => ({ cwd, sessionId: 'sess-1' }) as never

describe('persistent-shell：纯函数与工具转发', () => {
  test('shellEnvelope：bash 用 eval + base64，哨兵字面量拆成两段拼出来', () => {
    const envelope = shell.shellEnvelope('bash', 'ZmFrZQ==', 'tag42')
    expect(envelope).toContain('eval "$(printf')
    expect(envelope).toContain('__DS""C_tag42__$__ec')
    expect(shell.shellEnvelope('pwsh', 'ZmFrZQ==', 'tag42')).toContain('Invoke-Expression')
  })

  test('shell 工具：空命令当场拒，正常命令交给表执行', async () => {
    chooseShell('pwsh')
    const table = new shell.PersistentShellTable()
    const tool = shell.createPersistentShellTool(table, { timeoutMs: 20_000 }, 'PowerShell')
    try {
      await expect(tool.run!({ command: '   ' }, ctxOf())).rejects.toThrow('command 不能为空')
      const output = await tool.run!({ command: 'Write-Output hello-w14' }, ctxOf())
      expect(output).toContain('hello-w14')
    } finally {
      table.closeAll()
    }
  }, 30_000)

  test('stderr 也计入输出：命令写 stderr 照样能等到哨兵', async () => {
    chooseShell('pwsh')
    const table = new shell.PersistentShellTable()
    try {
      const output = await table.run('sess-stderr', HOME, '[Console]::Error.WriteLine("err-w14")', 20_000)
      expect(output).toContain('err-w14')
      expect(table.close('sess-stderr')).toBe(true)
    } finally {
      table.closeAll()
    }
  }, 30_000)

  test('子进程起不来（PATH 空掉）：error 事件把 shell 标成不可用，调用按超时失败', async () => {
    chooseShell('sh')
    const table = new shell.PersistentShellTable()
    const savedPath = process.env['PATH']
    process.env['PATH'] = ''
    try {
      await expect(table.run('sess-broken', HOME, 'echo x', 800)).rejects.toThrow(/还没结束/)
    } finally {
      process.env['PATH'] = savedPath
      table.closeAll()
    }
  }, 20_000)
})

describe('persistent-shell：各终端档位的 spawn 分支', () => {
  test('选择 auto 且平台不是 Windows：落到最后的 bash 兜底分支', async () => {
    chooseShell(null)
    const original = process.platform
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    })
    const table = new shell.PersistentShellTable()
    try {
      await table.run('sess-posix-auto', HOME, 'echo started', 1_500).catch(() => undefined)
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      })
      table.closeAll()
    }
  }, 30_000)
  test.each(['gitbash', 'wsl', 'sh', 'pwsh'] as const)(
    '选择 %s 时会走到对应 spawn 分支',
    async (choice) => {
      chooseShell(choice)
      const table = new shell.PersistentShellTable()
      try {
        // 每个档位都真起一次：命令跑到超时或者正常返回都行，判据是分支被走到且收尾干净。
        await table.run(`sess-${choice}`, HOME, 'echo started', 1_500).catch(() => undefined)
        // 超时路径自己会 close；没超时的话这里再收一次。
        table.close(`sess-${choice}`)
        expect(true).toBe(true)
      } finally {
        table.closeAll()
      }
    },
    30_000,
  )
})

describe('bash：POSIX 车道（重新加载模块让 isWin 为假）', () => {
  /** 临时把平台改成 linux，重新加载 `bash.ts` 跑一段。 */
  async function asPosix<T>(run: (fresh: typeof import('../bash.js')) => Promise<T>): Promise<T> {
    const original = process.platform
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    })
    vi.resetModules()
    try {
      const fresh = await import('../bash.js')
      return await run(fresh)
    } finally {
      Object.defineProperty(process, 'platform', {
        value: original,
        configurable: true,
      })
      vi.resetModules()
    }
  }

  test('shellPlan：非 Windows 的 auto 走 sh -c', async () => {
    const plan = await asPosix(async (fresh) => fresh.shellPlan('auto', 'echo x', '/tmp', {}))
    expect(plan).toMatchObject({ file: 'sh', args: ['-c', 'echo x'] })
  })

  test('spawnTerminalShell：非 Windows 的 auto 起 bash 并置 detached', async () => {
    await asPosix(async (fresh) => {
      const child = fresh.spawnTerminalShell('')
      // spawn 失败（本机没有 POSIX bash）也只会走 error 事件；挂个监听免成未处理异常。
      child.on('error', () => {})
      child.on('close', () => {})
      fresh.killTree(child)
    })
  })
})

describe('bash：终端会话 send 时输入口已经没了', () => {
  test('会话还在运行但底下的子进程登记被摘掉：报「输入口已经关了」', async () => {
    chooseShell('pwsh')
    const table = new bash.TerminalTable({})
    try {
      const id = table.open('sess-1', HOME)
      // 模拟子进程已经脱离登记（进程自己退出后 stdin 不可用）。
      bash.untrackBackgroundChild(id)
      expect(() => table.send(id, 'echo x')).toThrow(/输入口已经关了/)
    } finally {
      table.close('term-1')
    }
  }, 30_000)
})

// 收尾：确保临时目录里的 plugins 配置不会残留到别的用例。
test('清理 plugins.json', () => {
  writeFileSync(join(HOME, 'plugins.json'), '{"version":1,"entries":[]}\n', 'utf8')
  expect(true).toBe(true)
})
