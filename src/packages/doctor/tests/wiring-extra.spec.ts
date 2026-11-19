/**
 * @pneuma/doctor 的补缺口测试：九项检查的可注入部分 + /doctor 两条输出通道 + 诊断包落盘。
 *
 * 既有 `doctor.spec.ts` 只钉登记表语义、两种渲染与 `--with-session` 的摘要；这里补它没碰的：
 *
 *   - 环境四项（安装 / 配置 / 认证 / 终端）与生态三项（插件 / 沙箱 / 连通性）的分支；
 *   - 数据两项（会话目录可写性、残留锁、磁盘占用）与 `recentSessionFiles` 的排序；
 *   - `apply()` 里 `/doctor --json` 与 `--bundle [--with-session]` 两条 handler 路径。
 *
 * 会话/导出/锁都落在 mkdtemp 的 `DSC_HOME` 下；`path-policy.ts` 的 `DSC_HOME` 是模块级常量，
 * 所以产品模块用动态 import（见 ops 那份同款说明）。九项真检查不跑：`service.run` 在 apply
 * 之后被替换成固定报告，避免网络与 shell 探测把单测拖成集成测试。
 *
 * @module @pneuma/doctor/tests/wiring-extra
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, describe, expect, test } from 'vitest'
import type { HealthReport, SettingsService } from '@pneuma/runtime/services/types.js'

const home = mkdtempSync(join(tmpdir(), 'dsc-doctor-extra-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const doctor = await import('../index.js')
const environment = await import('../checks/environment.js')
const data = await import('../checks/data.js')
const ecosystem = await import('../checks/ecosystem.js')
const util = await import('../checks/util.js')

afterAll(() => {
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** 一份形状完整的模型配置；`providers` 决定各检查走哪一支。 */
function modelConfig(overrides: { providers?: unknown[] } = {}) {
  const providers = overrides.providers ?? []
  return {
    providers,
    defaultProvider: providers.length > 0 ? 'p1' : '',
    defaultModel: providers.length > 0 ? 'm1' : '',
    temperature: null,
    configFile: join(home, 'config.yaml'),
    credentialsFile: join(home, 'credentials.yaml'),
  }
}

/** 只实现 `modelConfig` 的设置服务桩。 */
function settingsOf(value: unknown | (() => unknown)): SettingsService {
  return {
    modelConfig: () => {
      const result = typeof value === 'function' ? (value as () => unknown)() : value
      if (result instanceof Error) throw result
      return result
    },
  } as unknown as SettingsService
}

/** 造一个端点。 */
function provider(name: string, configured: boolean) {
  return {
    name,
    displayName: name.toUpperCase(),
    baseUrl: 'http://127.0.0.1:1',
    keyRef: `KEY_${name}`,
    keyConfigured: configured,
    models: [],
  }
}

describe('环境四项：配置 / 认证 / 安装', () => {
  test('config：零端点警告、有端点通过、读不出来算失败', async () => {
    expect((await environment.configCheck(settingsOf(modelConfig())).run()).status).toBe('warn')
    const ok = await environment.configCheck(settingsOf(modelConfig({ providers: [provider('p1', true)] }))).run()
    expect(ok.status).toBe('ok')
    expect(ok.summary).toContain('1 个端点')
    const failed = await environment.configCheck(settingsOf(new Error('yaml 坏了'))).run()
    expect(failed.status).toBe('fail')
    expect(failed.fix).toContain('config.yaml')
  })

  test('auth：配置坏跳过、无端点跳过、全缺 key 失败、部分/全部配好分别警告与通过', async () => {
    expect((await environment.authCheck(settingsOf(new Error('boom'))).run()).status).toBe('skip')
    expect((await environment.authCheck(settingsOf(modelConfig())).run()).status).toBe('skip')

    const missing = await environment.authCheck(settingsOf(modelConfig({ providers: [provider('p1', false)] }))).run()
    expect(missing.status).toBe('fail')
    expect(missing.summary).toContain('都没有可用密钥')
    expect(missing.detail).toContain('· P1（KEY_p1）')

    const partial = await environment.authCheck(
      settingsOf(modelConfig({ providers: [provider('p1', true), provider('p2', false)] })),
    ).run()
    expect(partial.status).toBe('warn')
    expect(partial.summary).toBe('1/2 个端点已配密钥')
    expect(partial.detail).toContain('✓ P1（KEY_p1）')

    const all = await environment.authCheck(
      settingsOf(modelConfig({ providers: [provider('p1', true), provider('p2', true)] })),
    ).run()
    expect(all.status).toBe('ok')
    expect(all.summary).toContain('均已配密钥')
  })

  test('install：版本、Node、平台与应用根都写进 detail；缺基础包清单时带修复建议', async () => {
    const result = await environment.installCheck().run()
    expect(['ok', 'warn']).toContain(result.status)
    expect(result.detail).toContain(`Node：${process.version}`)
    expect(result.detail).toContain('基础包清单：')
    expect(util.appRoot().length).toBeGreaterThan(0)
    expect(typeof util.appVersion()).toBe('string')
  })
})

describe('生态三项：插件 / 沙箱 / 连通性', () => {
  test('plugins：隔离进程里目录为空，照样给出稳定的 0 计数', async () => {
    const result = await ecosystem.pluginsCheck().run()
    expect(result.status).toBe('ok')
    expect(result.summary).toBe('0 个插件，0 个启用')
    expect(result.detail).toContain('内置 0、外部 0')
  })

  test('sandbox：未启用跳过、完全访问警告、常规档位通过', async () => {
    expect((await ecosystem.sandboxCheck(() => undefined).run()).status).toBe('skip')

    const full = {
      mode: 'danger-full-access',
      enforcement: 'policy',
      writableRoots: ['/'],
      networkAccess: true,
      tmpDir: '/tmp',
      describe: () => '全开',
    }
    const warned = await ecosystem.sandboxCheck(() => full as never).run()
    expect(warned.status).toBe('warn')
    expect(warned.summary).toContain('完全访问')
    expect(warned.detail).toContain('网络：放行')

    const safe = { ...full, mode: 'workspace-write', networkAccess: false, writableRoots: ['/w', '/x'] }
    const ok = await ecosystem.sandboxCheck(() => safe as never).run()
    expect(ok.status).toBe('ok')
    expect(ok.summary).toBe('workspace-write · policy')
    expect(ok.detail).toContain('可写根：2 个')
  })

  test('reachability：配置坏跳过、无端点跳过、连不上算失败', async () => {
    expect((await ecosystem.reachabilityCheck(settingsOf(new Error('bad'))).run()).status).toBe('skip')
    expect((await ecosystem.reachabilityCheck(settingsOf(modelConfig())).run()).status).toBe('skip')

    const failed = await ecosystem.reachabilityCheck(
      settingsOf(modelConfig({ providers: [provider('p1', true)] })),
    ).run()
    expect(failed.status).toBe('fail')
    expect(failed.detail).toContain('地址：http://127.0.0.1:1/models')
  })
})

describe('数据两项与工具：会话目录、磁盘、文件遍历', () => {
  test('session：残留锁警告、清掉后通过；recentSessionFiles 按 mtime 倒序', async () => {
    const sessions = join(home, 'sessions')
    mkdirSync(join(sessions, 'workspace'), { recursive: true })
    const older = join(sessions, 'workspace', 'old.jsonl')
    const newer = join(sessions, 'workspace', 'new.jsonl')
    writeFileSync(older, '{}\n')
    writeFileSync(newer, '{}\n')
    const now = Date.now()
    // 显式改 mtime，避免同毫秒里两个文件排序不分。
    const { utimesSync } = await import('node:fs')
    utimesSync(older, new Date(now - 60_000), new Date(now - 60_000))
    utimesSync(newer, new Date(now), new Date(now))
    expect(data.recentSessionFiles(sessions, 5)).toEqual([newer, older])

    const lock = join(sessions, 'workspace', 'dead.lock')
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_646 }))
    const warned = await data.sessionCheck().run()
    expect(warned.status).toBe('warn')
    expect(warned.summary).toContain('主人已经不在了')
    expect(warned.fix).toContain('.lock')

    rmSync(lock)
    const ok = await data.sessionCheck().run()
    expect(ok.status).toBe('ok')
    expect(ok.summary).toContain('最近 2 份会话')
  })

  test('disk：按子目录列占用并给出合计', async () => {
    writeFileSync(join(home, 'created-here.txt'), 'x')
    const logs = join(home, 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'a.log'), '0123456789')
    const result = await data.diskCheck().run()
    expect(result.status).toBe('ok')
    expect(result.detail).toContain(`根目录：${home}`)
    expect(result.detail).toContain('logs:')
    expect(result.detail).toContain('合计：')
  })

  test('util：遍历深度、后缀计数与不可读目录的 0 回落', () => {
    const dir = join(home, 'walk')
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'top.txt'), 'x')
    writeFileSync(join(dir, 'a', 'mid.txt'), 'x')
    writeFileSync(join(dir, 'a', 'b', 'deep.txt'), 'x')

    expect(util.walkFiles(dir, -1)).toEqual([])
    expect(util.walkFiles(dir, 0)).toEqual([join(dir, 'top.txt')])
    expect(util.walkFiles(dir, 2)).toContain(join(dir, 'a', 'b', 'deep.txt'))
    expect(util.countFiles(dir, '.txt')).toBe(1)
    expect(util.dirSize(join(home, 'nope'))).toBe(0)
    expect(util.dirSize(dir)).toBe(3)
    expect(util.redactHome('plain text')).toBe('plain text')
  })
})

describe('/doctor 命令：--json 与 --bundle 两条通道', () => {
  // 抹 ~ 的被测基准是 `homedir()`（`redactHome` 的实现口径）；本文件的 DSC_HOME 在 POSIX 上
  // 是 /tmp/...，本来就不在家目录下，不能拿它当「应当被抹掉」的样本。
  const homePath = join(homedir(), 'pneuma-doctor-home')
  /** 固定报告：不跑九项真检查。 */
  function report(): HealthReport {
    return {
      at: Date.UTC(2026, 10, 16, 0, 0),
      entries: [
        { id: 'install', title: '安装', status: 'ok', summary: `在 ${homePath}`, detail: `应用根：${homePath}` },
        {
          id: 'session',
          title: '会话',
          status: 'warn',
          summary: '锁残留',
          fix: '删掉 .lock',
        },
      ],
      ok: 1,
      warn: 1,
      fail: 0,
      skip: 0,
    }
  }

  /** 装一次插件并拿到命令 handler 与 health 服务。 */
  function mount() {
    const provided = new Map<string, unknown>()
    const commands: Array<{ spec: { name: string }; handler: (invocation: unknown) => Promise<void> }> = []
    const ctx = {
      settings: settingsOf(modelConfig()),
      provide(name: string, value: unknown) {
        provided.set(name, value)
        return () => provided.delete(name)
      },
      get(name: string) {
        return name === 'log' ? { tail: () => ['warn line'] } : undefined
      },
      commands: {
        register(spec: { name: string }, handler: (invocation: unknown) => Promise<void>) {
          commands.push({ spec, handler })
          return () => {}
        },
      },
    }
    doctor.doctorPlugin.apply(ctx as never, {} as never)
    const service = provided.get('health') as { run: () => Promise<HealthReport> }
    service.run = async () => report()
    return { commands, service }
  }

  test('--json 输出可解析、家目录被抹成 ~', async () => {
    const { commands } = mount()
    const notices: string[] = []
    await commands[0]!.handler({ args: ['--json'], ui: { notice: (text: string) => notices.push(text) } })
    const text = notices.at(-1) ?? ''
    const parsed = JSON.parse(text) as { status: string; counts: { warn: number }; checks: Record<string, unknown> }
    expect(parsed.status).toBe('warn')
    expect(parsed.counts.warn).toBe(1)
    expect(Object.keys(parsed.checks)).toEqual(['install', 'session'])
    expect(text).not.toContain(homedir())
    expect(text).toContain('~')
  })

  test('--bundle 写出 gzip 包；--with-session 才带会话摘要', async () => {
    const sessions = join(home, 'sessions', 'workspace')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(
      join(sessions, 'chat.jsonl'),
      [
        JSON.stringify({ type: 'meta', id: 's' }),
        JSON.stringify({ type: 'user', text: '你好' }),
        JSON.stringify({ type: 'assistant', text: '在' }),
      ].join('\n'),
    )
    const { commands } = mount()

    const plainNotices: string[] = []
    await commands[0]!.handler({
      args: ['--bundle'],
      ui: { notice: (text: string) => plainNotices.push(text) },
    })
    const plainText = plainNotices.at(-1) ?? ''
    expect(plainText).toContain('诊断包已写出')
    expect(plainText).toContain('不含密钥')
    const plainPath = plainText.split('\n')[0]!.replace('诊断包已写出：', '')
    const plain = JSON.parse(gunzipSync(readFileSync(plainPath)).toString('utf8')) as {
      logs: { lines: number }
      sessions: { count: number }
      excluded: string[]
      sessionExcerpt?: unknown
    }
    expect(plain.logs.lines).toBe(1)
    expect(plain.sessions.count).toBeGreaterThanOrEqual(1)
    expect(plain.excluded).toContain('会话的完整内容')
    expect(plain.sessionExcerpt).toBeUndefined()

    const withNotices: string[] = []
    await commands[0]!.handler({
      args: ['--bundle', '--with-session'],
      ui: { notice: (text: string) => withNotices.push(text) },
    })
    const withText = withNotices.at(-1) ?? ''
    expect(withText).toContain('条对话摘要')
    const withPath = withText.split('\n')[0]!.replace('诊断包已写出：', '')
    const withBundle = JSON.parse(gunzipSync(readFileSync(withPath)).toString('utf8')) as {
      excluded: string[]
      sessionExcerpt?: { events: Array<{ role: string }> }
    }
    expect(withBundle.excluded).not.toContain('会话的完整内容')
    expect(withBundle.sessionExcerpt?.events.map((event) => event.role)).toEqual(['user', 'assistant'])
  })

  test('人读版：全 skip 说「全部跳过」，ok 项不挂修复行', async () => {
    const allSkip = doctor.renderText({
      at: Date.now(),
      entries: [{ id: 'a', title: 'A', status: 'skip', summary: '没查' }],
      ok: 0,
      warn: 0,
      fail: 0,
      skip: 1,
    })
    expect(allSkip).toContain('全部跳过')

    const okWithFix = doctor.renderText({
      at: Date.now(),
      entries: [{ id: 'a', title: 'A', status: 'ok', summary: '好', fix: '不该出现' }],
      ok: 1,
      warn: 0,
      fail: 0,
      skip: 0,
    })
    expect(okWithFix).toContain('全部正常')
    expect(okWithFix).not.toContain('修复：不该出现')
  })
})
