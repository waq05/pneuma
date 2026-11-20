/**
 * doctor 的 W14 补缺口测试：把「读不到 / 写不进去 / 超预算 / 探测炸了」这些错误分支
 * 真正走一遍，而不是只验通过态。
 *
 * 覆盖：
 *   - `environment.installCheck` 版本读不到 / 基础包清单缺失；
 *   - `environment.terminalCheck` 探测抛错 / 一个可用 shell 都没有 / 正常；
 *   - `ecosystem.pluginsCheck` 插件清单读不出来；
 *   - `data.sessionCheck` 会话目录不可写；`data.diskCheck` 超过 2 GiB 预算；
 *   - `bundle.readSessionExcerpt` 读不到文件 / 半截 JSON 行 / 未知事件类型；
 *   - `util.countFiles` 与 `util.walkFiles` 遇到不存在的目录。
 *
 * 磁盘预算用 `truncate` 造一个 2.1 GiB 的稀疏文件（`stat.size` 变大、实际不占盘）。
 * 终端探测、应用版本/根与插件清单都是模块级依赖，用 `vi.mock` 换桩；
 * 其余 util 函数走原实现。
 *
 * @module @pneuma/doctor/tests/w14-failure-paths
 */
import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'

const home = createTempDir('dsc-doctor-w14-')
process.env['DSC_HOME'] = home
const appRoot = join(home, 'app-root')

const state = vi.hoisted(() => ({
  version: '9.9.9' as string | undefined,
  root: '',
  shells: 'ok' as 'ok' | 'empty' | 'throw',
  pluginThrows: false,
  pluginRows: [] as Array<{ name: string; enabled: boolean; source: string }>,
}))

vi.mock('../checks/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../checks/util.js')>()
  return {
    ...actual,
    appVersion: () => state.version,
    appRoot: () => state.root,
  }
})

vi.mock('@pneuma/runtime/core/terminal-env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pneuma/runtime/core/terminal-env.js')>()
  return {
    ...actual,
    detectShells: () => {
      if (state.shells === 'throw') throw new Error('终端探测本身炸了')
      if (state.shells === 'empty') return []
      return [{ label: 'bash', available: true, detail: '/bin/bash' }]
    },
  }
})

vi.mock('@pneuma/runtime/core/plugin-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pneuma/runtime/core/plugin-registry.js')>()
  return {
    ...actual,
    listPluginInfos: () => {
      if (state.pluginThrows) throw new Error('plugins.json 语法坏了')
      return state.pluginRows
    },
  }
})

type Exception = typeof import('../checks/environment.js')
type DataMod = typeof import('../checks/data.js')
type EcoMod = typeof import('../checks/ecosystem.js')
type BundleMod = typeof import('../bundle.js')
type UtilMod = typeof import('../checks/util.js')

let environment: Exception
let data: DataMod
let ecosystem: EcoMod
let bundle: BundleMod
let util: UtilMod

beforeAll(async () => {
  ;({ environment, data, ecosystem, bundle, util } = {
    environment: await import('../checks/environment.js'),
    data: await import('../checks/data.js'),
    ecosystem: await import('../checks/ecosystem.js'),
    bundle: await import('../bundle.js'),
    util: await import('../checks/util.js'),
  })
  state.root = appRoot
})

afterEach(() => {
  state.version = '9.9.9'
  state.shells = 'ok'
  state.pluginThrows = false
  state.pluginRows = []
  vi.unstubAllGlobals()
})

/** 连通性检查认的端点形状。 */
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

afterAll(() => {
  delete process.env['DSC_HOME']
})

describe('安装检查的两条 warn', () => {
  test('版本读不到 → warn 并提示先构建/重装', async () => {
    state.version = undefined
    const result = await environment.installCheck().run()
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('读不到应用版本')
  })

  test('基础包清单缺失 → warn 并给 pnpm build', async () => {
    mkdirSync(appRoot, { recursive: true })
    const result = await environment.installCheck().run()
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('基础包清单缺失')
    expect(result.fix).toContain('pnpm build')
  })
})

describe('终端检查的三条路', () => {
  test('探测抛错 → warn', async () => {
    state.shells = 'throw'
    const result = await environment.terminalCheck().run()
    expect(result.status).toBe('warn')
    expect(result.summary).toContain('终端探测本身报错')
  })

  test('一个可用 shell 都没有 → fail', async () => {
    state.shells = 'empty'
    const result = await environment.terminalCheck().run()
    expect(result.status).toBe('fail')
    expect(result.fix).toContain('终端环境')
  })

  test('有可用 shell → ok', async () => {
    state.shells = 'ok'
    const result = await environment.terminalCheck().run()
    expect(result.status).toBe('ok')
    expect(result.summary).toContain('bash')
  })
})

describe('插件清单读不出来 → fail', () => {
  test('listPluginInfos 抛错时给一句可执行的修复建议', async () => {
    state.pluginThrows = true
    const result = await ecosystem.pluginsCheck().run()
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('插件清单读不出来')
    expect(result.fix).toContain('plugins.json')
  })
})

describe('插件清单的成功面', () => {
  test('列出合计 / 启停 / 停用名单', async () => {
    state.pluginRows = [
      { name: 'base', enabled: true, source: 'builtin' },
      { name: 'demo', enabled: false, source: 'external' },
    ]
    const result = await ecosystem.pluginsCheck().run()
    expect(result.status).toBe('ok')
    expect(result.summary).toContain('2 个插件，1 个启用')
    expect(result.detail).toContain('内置 1、外部 1')
    expect(result.detail).toContain('停用的：demo')
    state.pluginRows = []
  })
})

describe('连通性检查的四种 HTTP 结论', () => {
  /** 造一个只回状态的 fetch 桩。 */
  function stubStatus(status: number): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status })),
    )
  }

  test('200 / 401 / 5xx / 其它状态各给一句对应结论', async () => {
    const settings = {
      modelConfig: () => ({
        providers: [provider('p1', true)],
        defaultProvider: 'p1',
        defaultModel: 'm1',
      }),
    } as never
    const check = ecosystem.reachabilityCheck(settings)

    stubStatus(200)
    expect((await check.run()).status).toBe('ok')

    stubStatus(401)
    const unauthorized = await check.run()
    expect(unauthorized.summary).toContain('未带密钥')

    stubStatus(503)
    const serverError = await check.run()
    expect(serverError.status).toBe('warn')
    expect(serverError.summary).toContain('服务端 503')

    stubStatus(404)
    const notFound = await check.run()
    expect(notFound.status).toBe('warn')
    expect(notFound.fix).toContain('baseUrl')
  })
})

describe('数据检查的失败面', () => {
  test('会话目录位置被一个文件占着 → 判不可写', async () => {
    rmSync(join(home, 'sessions'), { recursive: true, force: true })
    writeFileSync(join(home, 'sessions'), 'not a dir', 'utf8')
    const result = await data.sessionCheck().run()
    expect(result.status).toBe('fail')
    expect(result.summary).toContain('会话目录不可写')
    expect(result.fix).toContain('权限')
    rmSync(join(home, 'sessions'), { force: true })
  })

  test('占用超过 2 GiB 预算 → warn（稀疏文件只动 size）', async () => {
    rmSync(join(home, 'sessions'), { recursive: true, force: true })
    mkdirSync(join(home, 'logs'), { recursive: true })
    const big = join(home, 'logs', 'big.log')
    writeFileSync(big, '', 'utf8')
    truncateSync(big, 2 * 1024 * 1024 * 1024 + 1024)
    try {
      const result = await data.diskCheck().run()
      expect(result.status).toBe('warn')
      expect(result.summary).toContain('超过')
      expect(result.fix).toContain('清理')
    } finally {
      rmSync(big, { force: true })
    }
  })
})

describe('诊断包读取与文件遍历的兜底', () => {
  test('readSessionExcerpt：读不到文件回空、坏行跳过、未知类型归 other', () => {
    const missing = bundle.readSessionExcerpt(join(home, 'no-such-session.jsonl'))
    expect(missing).toMatchObject({ total: 0, events: [] })

    const file = join(home, 'session.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'meta' }),
        '{ half written',
        JSON.stringify({ type: 'user', text: '你好' }),
        JSON.stringify({ type: 'custom-event', text: 'x' }),
        '',
      ].join('\n'),
      'utf8',
    )
    const excerpt = bundle.readSessionExcerpt(file)
    expect(excerpt.events).toEqual([
      { role: 'user', text: '你好' },
      { role: 'other', name: 'custom-event' },
    ])
  })

  test('countFiles / walkFiles 遇到不存在的目录不抛', () => {
    expect(util.countFiles(join(home, 'nope'), '.jsonl')).toBe(0)
    expect(util.walkFiles(join(home, 'nope'), 2)).toEqual([])
  })
})
