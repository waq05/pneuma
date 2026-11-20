/**
 * 部署解析（`deployment.ts`）与 DSC 插件入口里那段纯读配置的测试。
 *
 * 为什么挑这层：部署解析是「gh / lark-cli 到底能不能按智能体身份跑」的唯一判据，它判错不抛异常
 * 的地方在于**错误码**——把 `agentCliSignedOut` 报成 `agentCliMissing`、把只读仓库放过去，
 * 用户看到的都是「来源起不来」，但修的地方完全不同。所以这里逐条钉错误码与顺序。
 *
 * 假的只有 `probe`（`(argv, env) => Promise<string>`，按 argv 喂 CLI 输出）与 PATH 里的临时
 * 可执行文件；`resolveDeployment` / `resolveFeishuBot` / `executable` / `machineOf` 全是源码。
 * 不联网、不跑真 gh / lark-cli、不碰 `~/.dsc`，临时目录走 `createTempDir()`。
 *
 * @module @pneuma/superagent/tests/deployment
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import {
  Config,
  executable,
  machineOf,
  resolveDeployment,
  resolveFeishuBot,
  workerProbe,
  FeishuBotSchema,
  type Machine,
  type Probe,
} from '../deployment.js'
import { legacyPluginKeys } from '../index.js'

/** 写一个可执行文件；Windows 上 chmod 是空操作，POSIX 上必须给执行位。 */
function executableFile(path: string, content = '#!/bin/sh\nexit 0\n'): string {
  writeFileSync(path, content, { mode: 0o755 })
  if (process.platform !== 'win32') chmodSync(path, 0o755)
  return path
}

const machineOfDir = (stateDir: string): Machine => ({
  stateDir,
  promptMaxChars: 100_000,
  admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15_000,
})

describe('machineOf', () => {
  it('把配置读成运行期机器设置', () => {
    const config = Config.parse({ stateDir: '/tmp/state', promptMaxChars: 1000, admissionContextMaxPages: 4, admissionContextTimeoutMs: 900 })
    expect(machineOf(config)).toEqual({ stateDir: '/tmp/state', promptMaxChars: 1000, admissionContextMaxPages: 4, admissionContextTimeoutMs: 900 })
  })

  it('点名旧键并说清搬去了哪；不认识的键原样点名', () => {
    const config = Config.parse({ stateDir: '/tmp/state', repository: 'acme/widgets', branchPrefix: 'agent/', unknownKey: 1 })
    expect(() => machineOf(config)).toThrow(/repository \(now on the GitHub Source\)/)
    expect(() => machineOf(config)).toThrow(/branchPrefix \(now in the prepare command of the Execution settings\)/)
    expect(() => machineOf(config)).toThrow(/unknownKey/)
    expect(() => machineOf(config)).toThrow(/docs\/006-deployment\.md lists the keys/)
  })
})

describe('executable', () => {
  it('绝对路径直接校验是不是可执行文件', () => {
    const dir = createTempDir('dsc-sa-exe-')
    const file = executableFile(join(dir, 'gh'))
    expect(executable(file, '')).toBe(file)
    expect(() => executable(join(dir, 'missing'), '')).toThrow(/is not an executable file/)
  })

  it('命令名按 PATH 逐目录找，且跳过 shim 目录', () => {
    const dir = createTempDir('dsc-sa-exe-path-')
    const file = executableFile(join(dir, 'lark-cli'))
    expect(executable('lark-cli', `${dir}${delimiter}${join(dir, 'nope')}`)).toBe(file)
    expect(() => executable('lark-cli', `${dir}${delimiter}${join(dir, 'nope')}`, dir)).toThrow(/is not an executable file on PATH/)
  })

  it('相对路径带斜杠直接拒绝；POSIX 上没执行位的文件不算', () => {
    expect(() => executable('bin/gh', '')).toThrow(/must be a command name or an absolute path/)
    if (process.platform !== 'win32') {
      const dir = createTempDir('dsc-sa-exe-mode-')
      const plain = join(dir, 'plain')
      writeFileSync(plain, 'text', { mode: 0o644 })
      chmodSync(plain, 0o644)
      expect(() => executable(plain, '')).toThrow(/is not an executable file/)
    }
  })
})

describe('resolveDeployment', () => {
  const paths = () => {
    const dir = createTempDir('dsc-sa-deploy-')
    const cli = executableFile(join(dir, 'gh'))
    return { dir, cli, path: dir }
  }

  it('仓库与智能体 CLI 没配时按 setup 错误码报出来', async () => {
    const { dir } = paths()
    const machine = machineOfDir(dir)
    await expect(resolveDeployment(machine, {}, async () => '', dir)).rejects.toMatchObject({ code: 'repositoryUnset' })
    await expect(resolveDeployment(machine, { repository: 'acme/widgets' }, async () => '', dir)).rejects.toMatchObject({ code: 'agentCliUnset' })
  })

  it('CLI 找不到、读不到账号、读不到仓库各报各的码', async () => {
    const { dir, cli } = paths()
    const machine = machineOfDir(dir)
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli: '/nowhere/gh' }, async () => '', dir))
      .rejects.toMatchObject({ code: 'agentCliMissing' })

    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli }, async () => { throw new Error('not signed in') }, dir))
      .rejects.toMatchObject({ code: 'agentCliSignedOut' })
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli }, async () => 'not json', dir))
      .rejects.toMatchObject({ code: 'agentCliNoAccount' })
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli }, async () => '{"login":"bad login!","id":1}', dir))
      .rejects.toMatchObject({ code: 'agentCliNoAccount' })

    const probe = async (argv: string[]) => argv[2] === 'user' ? '{"login":"agent","id":7}' : { toString: () => 'nope' }.toString()
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli }, probe, dir))
      .rejects.toMatchObject({ code: 'repositoryUnreported' })
  })

  it('仓库读不到、只读都拦住；能推时返回规范化仓库名与 noreply 邮箱', async () => {
    const { dir, cli } = paths()
    const machine = machineOfDir(dir)
    const one = (access: string | Error): Probe => async (argv) => {
      if (argv[2] === 'user') return '{"login":"agent","id":7}'
      if (access instanceof Error) throw access
      return access
    }
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli }, one(new Error('HTTP 404')), dir))
      .rejects.toMatchObject({ code: 'repositoryUnreadable' })
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli }, one('{"name":"acme/widgets","push":false}'), dir))
      .rejects.toMatchObject({ code: 'repositoryReadOnly' })

    const seen: string[][] = []
    const probe: Probe = async (argv) => {
      seen.push(argv)
      return argv[2] === 'user' ? '{"login":"Agent","id":7}' : '{"name":"Acme/Widgets","push":true}'
    }
    const deployment = await resolveDeployment(machine, { repository: 'acme/widgets', cli }, probe, dir)
    expect(deployment).toEqual({
      ...machine, repository: 'Acme/Widgets',
      github: { cli, login: 'Agent', noreply: '7+Agent@users.noreply.github.com' },
    })
    expect(seen[0]).toEqual([cli, 'api', 'user'])
    expect(seen[1]).toEqual([cli, 'api', 'repos/acme/widgets', '--jq', '{name: .full_name, push: .permissions.push}'])
  })
})

describe('resolveFeishuBot', () => {
  const paths = () => {
    const dir = createTempDir('dsc-sa-feishu-')
    const cli = executableFile(join(dir, 'lark-cli'))
    return { dir, cli, path: dir }
  }
  const outputs = {
    auth: 'noise\n{"appId":"cli_abc","brand":"lark","identities":{"bot":{"status":"ready"}}}',
    mode: 'strict-mode: bot',
    info: '{"bot":{"open_id":"ou_bot","app_name":"My Bot"}}\n',
  }
  const probeOf = (over: Partial<typeof outputs> = {}): Probe => async (argv) => {
    if (argv[1] === 'auth') return over.auth ?? outputs.auth
    if (argv[1] === 'config') return over.mode ?? outputs.mode
    return over.info ?? outputs.info
  }

  it('没配 CLI 时返回 undefined，CLI 坏了报 feishuCliFailed', async () => {
    const { dir } = paths()
    await expect(resolveFeishuBot(machineOfDir(dir), undefined, async () => '', dir)).resolves.toBeUndefined()
    await expect(resolveFeishuBot(machineOfDir(dir), { cli: '' }, async () => '', dir)).resolves.toBeUndefined()
    expect(FeishuBotSchema.parse({})).toEqual({ cli: '' })
    await expect(resolveFeishuBot(machineOfDir(dir), { cli: '/nowhere/lark-cli' }, async () => '', dir))
      .rejects.toMatchObject({ code: 'feishuCliFailed' })
    const { cli } = paths()
    await expect(resolveFeishuBot(machineOfDir(dir), { cli }, async () => { throw new Error('boom') }, dir))
      .rejects.toMatchObject({ code: 'feishuCliFailed' })
  })

  it('auth status 读不出 app、bot 未就绪、允许用户身份、读不到 bot 各有各的码', async () => {
    const { dir, cli } = paths()
    const machine = machineOfDir(dir)
    await expect(resolveFeishuBot(machine, { cli }, probeOf({ auth: 'no json here' }), dir)).rejects.toMatchObject({ code: 'feishuNoApp' })
    await expect(resolveFeishuBot(machine, { cli }, probeOf({ auth: '{"appId":"cli_abc","identities":{"bot":{"status":"off"}}}' }), dir))
      .rejects.toMatchObject({ code: 'feishuBotNotReady', values: { app: 'cli_abc', status: 'off' } })
    await expect(resolveFeishuBot(machine, { cli }, probeOf({ mode: 'strict-mode: user' }), dir))
      .rejects.toMatchObject({ code: 'feishuUserIdentity', values: { mode: 'user' } })
    await expect(resolveFeishuBot(machine, { cli }, probeOf({ info: 'garbage' }), dir)).rejects.toMatchObject({ code: 'feishuNoBot' })
  })

  it('全部通过时返回机器人身份，并把两个通知开关传给子进程', async () => {
    const { dir, cli } = paths()
    const envs: (Record<string, string> | undefined)[] = []
    const probe: Probe = async (argv, env) => {
      envs.push(env)
      return probeOf()(argv, env)
    }
    await expect(resolveFeishuBot(machineOfDir(dir), { cli }, probe, dir)).resolves.toEqual({
      cli, appId: 'cli_abc', brand: 'lark', botId: 'ou_bot', name: 'My Bot',
    })
    expect(envs[0]).toEqual({ LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' })
  })
})

describe('workerProbe', () => {
  it('用 node 真实的子进程跑一条命令并拿到 stdout', async () => {
    const dir = createTempDir('dsc-sa-probe-')
    const controller = new AbortController()
    const probe = workerProbe(dir, dir, controller.signal)
    await expect(probe([process.execPath, '-e', 'process.stdout.write("hi")'])).resolves.toBe('hi')
    controller.abort()
    await expect(probe([process.execPath, '-e', 'setTimeout(() => {}, 5000)'])).rejects.toThrow()
  })
})

describe('legacyPluginKeys', () => {
  it('只点名四个旧键，别的键与非对象输入不算', () => {
    expect(legacyPluginKeys(undefined)).toEqual([])
    expect(legacyPluginKeys(null)).toEqual([])
    expect(legacyPluginKeys('superagent')).toEqual([])
    expect(legacyPluginKeys(['repoPath'])).toEqual([])
    expect(legacyPluginKeys({ stateDir: '/tmp/state', promptMaxChars: 1 })).toEqual([])
    expect(legacyPluginKeys({ repoPath: 'x', ticketTimeoutSeconds: 5, collectUnknown: true })).toEqual(['repoPath', 'ticketTimeoutSeconds'])
    expect(legacyPluginKeys({ githubTokenEnv: 'GH_TOKEN', confirmInferred: false, repoPath: 'x' }))
      .toEqual(['repoPath', 'confirmInferred', 'githubTokenEnv'])
  })
})
