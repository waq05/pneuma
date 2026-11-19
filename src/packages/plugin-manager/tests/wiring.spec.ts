/**
 * plugin-manager 装配面（`packages/plugin-manager/index.ts`）：一颗 `plugin_manager`
 * 工具的八个 action、三处失败文案与热挂载/热停用。
 *
 * 做法：假 ctx 只收 `tools.register`，`apply` 是真的；注册表、热挂载、插件目录都是真的
 * （`DSC_HOME` 在任何 import 之前指进临时目录）。远程市场与 npm 包这两条真腿会走网络/
 * pnpm，这里用 `vi.mock` 换成可控的假实现——本文件钉的是「工具怎么把结果转给人话」，
 * 市场与 pnpm 自己的行为已有 `config-core` 与 `plugin-npm.spec.ts` 覆盖。
 *
 * @module dsc/packages/plugin-manager/tests/wiring.spec
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-plugin-manager-wiring-'))
process.env['DSC_HOME'] = HOME

/** 远程市场与 npm 包腿的假实现（真实现要网络 / pnpm，行为另有测试）。 */
const market = vi.hoisted(() => ({ browse: vi.fn(), install: vi.fn() }))
const npm = vi.hoisted(() => ({ install: vi.fn(), remove: vi.fn() }))

vi.mock('@pneuma/config-core/market.js', () => ({
  browsePluginMarketSource: market.browse,
  installPluginMarketEntry: market.install,
}))
vi.mock('@pneuma/runtime/core/plugin-npm.js', () => ({
  installNpmBundle: npm.install,
  removeNpmBundle: npm.remove,
}))

type PluginManagerModule = typeof import('../index.js')
type RegistryModule = typeof import('../../../core/plugin-registry.js')
type LoaderModule = typeof import('../../../core/plugin-loader.js')

let pluginManagerPlugin: PluginManagerModule['pluginManagerPlugin']
let registry: RegistryModule
let loader: LoaderModule
/** 热挂载需要真的 cordis root；一个文件里用同一只即可（装过的插件在文件末尾收掉）。 */
let root: Context

/** 工具声明里本文件用得到的字段。 */
interface CapturedTool {
  name: string
  description: string
  risk: string
  parameters: {
    properties: Record<string, { type?: string; enum?: string[]; description?: string }>
    required?: string[]
  }
  run(args: Record<string, unknown>, ctx: unknown): Promise<string>
}

interface Harness {
  tools: CapturedTool[]
  run(args: Record<string, unknown>): Promise<string>
}

/** 假 ctx 真 apply：只收工具挂载点。 */
function harness(): Harness {
  const tools: CapturedTool[] = []
  const ctx = {
    tools: {
      register(tool: CapturedTool) {
        tools.push(tool)
        return () => undefined
      },
    },
    effect(fn: () => unknown) {
      fn()
      return () => undefined
    },
  }
  pluginManagerPlugin.apply(ctx as never, undefined as never)
  const tool = tools[0]
  if (tool === undefined) throw new Error('plugin_manager 工具没注册出来')
  return { tools, run: (args) => tool.run(args, { cwd: HOME, signal: new AbortController().signal }) }
}

/** 写条目树（开关状态真读这里）。 */
function writeEntries(entries: Array<Record<string, unknown>>): void {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries }), 'utf8')
}

/** 读条目树。 */
function readEntries(): Array<{ file?: string; disabled?: boolean }> {
  const doc = JSON.parse(readFileSync(join(HOME, 'plugins.json'), 'utf8')) as {
    entries?: Array<{ file?: string; disabled?: boolean }>
  }
  return doc.entries ?? []
}

beforeAll(async () => {
  registry = await import('../../../core/plugin-registry.js')
  loader = await import('../../../core/plugin-loader.js')
  pluginManagerPlugin = (await import('../index.js')).pluginManagerPlugin
  root = new Context()
  loader.initPluginRuntime(root)
})

afterAll(() => {
  // 装过又还开着的插件收掉，别把 fiber 留给后面的文件。
  for (const entry of readEntries()) {
    if (entry.file !== undefined) void loader.setPluginEnabledHot(entry.file, false)
  }
  delete process.env['DSC_HOME']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

beforeEach(() => {
  mkdirSync(join(HOME, 'plugins'), { recursive: true })
  writeEntries([])
  market.browse.mockReset()
  market.install.mockReset()
  npm.install.mockReset()
  npm.remove.mockReset()
})

describe('注册与清单', () => {
  test('工具名/风险/action 枚举与 effect 退订都挂上了', () => {
    const h = harness()
    expect(h.tools).toHaveLength(1)
    expect(h.tools[0]).toMatchObject({ name: 'plugin_manager', risk: 'write' })
    expect(h.tools[0]!.parameters.required).toEqual(['action'])
    expect(h.tools[0]!.parameters.properties['action']?.enum).toEqual([
      'list',
      'enable',
      'disable',
      'install',
      'browse_remote',
      'install_remote',
      'install_package',
      'remove_package',
    ])
  })

  test('list：空目录说「无插件」，有插件时逐行给开关/描述/问题', async () => {
    const h = harness()
    expect(await h.run({ action: 'list' })).toBe('（无插件）')

    registry.registerPluginMeta({ file: 'alpha.js', name: '甲插件', description: '甲说明', source: 'external' })
    registry.registerPluginMeta({
      file: 'beta.js',
      name: '乙插件',
      description: '',
      source: 'external',
      problem: '模块导入失败：坏了',
    })
    writeEntries([{ file: 'beta.js', disabled: true, config: {} }])

    const text = await h.run({ action: 'list' })
    expect(text).toContain('[启用] 甲插件 (alpha.js)  甲说明')
    expect(text).toContain('[停用] 乙插件 (beta.js)  ⚠ 模块导入失败：坏了')
  })
})

describe('启用与停用', () => {
  test('运行内核不许拨开关；缺 file 参数当场说清', async () => {
    registry.registerPluginMeta({ file: 'kernel-ish', name: '内核', description: '', source: 'builtin' })
    const h = harness()
    expect(await h.run({ action: 'enable', file: 'kernel-ish' })).toContain('属于运行内核')
    expect(await h.run({ action: 'disable', file: 'kernel-ish' })).toContain('属于运行内核')
    expect(await h.run({ action: 'enable' })).toContain('缺少 file 参数')
    expect(await h.run({ action: 'disable', file: '' })).toContain('缺少 file 参数')
  })

  test('停用：真写条目树；再启用时文件不在插件目录 → 如实报找不到', async () => {
    const h = harness()
    expect(await h.run({ action: 'disable', file: 'ghost.js' })).toBe('已停用插件 ghost.js（热生效，已写盘持久化）')
    expect(readEntries().find((entry) => entry.file === 'ghost.js')?.disabled).toBe(true)

    const enable = await h.run({ action: 'enable', file: 'ghost.js' })
    expect(enable).toContain('找不到插件文件 ghost.js')
  })
})

describe('install（本地 .js）', () => {
  test('参数与扩展名校验走人话', async () => {
    const h = harness()
    expect(await h.run({ action: 'install' })).toContain('缺少 file 参数')
    expect(await h.run({ action: 'install', file: 'readme.txt' })).toBe('错误：仅支持 .js 插件文件')
    expect(await h.run({ action: 'install', file: join(HOME, 'nope', 'x.js') })).toContain('错误：')
  })

  test('复制到插件目录并热挂载；停用状态的同名文件不偷偷点亮', async () => {
    const h = harness()
    mkdirSync(join(HOME, 'probes'), { recursive: true })
    const good = join(HOME, 'probes', 'probe-good.js')
    writeFileSync(good, 'export default { name: "probe-good", apply() {} }\n', 'utf8')
    expect(await h.run({ action: 'install', file: good })).toBe('已安装并热挂载 probe-good.js')
    expect(existsSync(join(HOME, 'plugins', 'probe-good.js'))).toBe(true)

    const disabled = join(HOME, 'probes', 'probe-off.js')
    writeFileSync(disabled, 'export default { name: "probe-off", apply() {} }\n', 'utf8')
    writeEntries([{ file: 'probe-off.js', disabled: true, config: {} }])
    const off = await h.run({ action: 'install', file: disabled })
    expect(off).toContain('已复制 probe-off.js')
    expect(off).toContain('没有自动挂载')
  })

  test('复制成功但模块里没有插件对象：报挂载失败并说明文件已复制', async () => {
    const h = harness()
    const broken = join(HOME, 'probes', 'probe-broken.js')
    mkdirSync(join(HOME, 'probes'), { recursive: true })
    writeFileSync(broken, 'export const nothing = 1\n', 'utf8')
    const out = await h.run({ action: 'install', file: broken })
    expect(out).toContain('模块里找不到插件对象')
    expect(out).toContain('文件已复制')
  })
})

describe('browse_remote / install_remote', () => {
  test('浏览：源地址校验、空源、条目排版、拉取失败', async () => {
    const h = harness()
    expect(await h.run({ action: 'browse_remote' })).toContain('缺少 file 参数')
    expect(await h.run({ action: 'browse_remote', file: 'http://example.com/x.json' })).toContain('必须是 https')

    market.browse.mockResolvedValue([])
    expect(await h.run({ action: 'browse_remote', file: 'https://example.com/x.json' })).toBe('这个源里没有可安装的 .js 插件')

    market.browse.mockResolvedValue([
      { name: 'alpha', description: '甲插件', version: '1.2.0' },
      { name: 'beta', description: '乙插件' },
    ])
    expect(await h.run({ action: 'browse_remote', file: 'https://example.com/x.json' })).toBe(
      '- alpha（1.2.0）：甲插件\n- beta：乙插件',
    )

    market.browse.mockRejectedValue(new Error('boom'))
    expect(await h.run({ action: 'browse_remote', file: 'https://example.com/x.json' })).toBe('错误：boom')
  })

  test('远程安装：直链校验、下载后热挂载、停用状态、下载失败', async () => {
    const h = harness()
    expect(await h.run({ action: 'install_remote' })).toContain('缺少 file 参数')
    expect(await h.run({ action: 'install_remote', file: 'http://example.com/a.js' })).toContain('https 直链')
    expect(await h.run({ action: 'install_remote', file: 'https://example.com/a.txt' })).toContain('必须是 .js')

    market.install.mockImplementation(async (entry: { name: string }, dir: string) => {
      mkdirSync(dir, { recursive: true })
      const target = join(dir, entry.name)
      writeFileSync(target, `export default { name: "remote-${entry.name}", apply() {} }\n`, 'utf8')
      return target
    })
    expect(await h.run({ action: 'install_remote', file: 'https://example.com/probe-remote.js' })).toBe(
      '已从 https://example.com/probe-remote.js 安装并热挂载 probe-remote.js',
    )

    writeEntries([{ file: 'probe-off-remote.js', disabled: true, config: {} }])
    const off = await h.run({ action: 'install_remote', file: 'https://example.com/probe-off-remote.js' })
    expect(off).toContain('已下载 probe-off-remote.js')
    expect(off).toContain('没有自动挂载')

    market.install.mockRejectedValue(new Error('下载超时'))
    expect(await h.run({ action: 'install_remote', file: 'https://example.com/probe-err.js' })).toBe('错误：下载超时')
  })
})

describe('install_package / remove_package 与未知 action', () => {
  test('缺 spec 报错；成功原样转 detail；失败加「错误：」前缀', async () => {
    const h = harness()
    expect(await h.run({ action: 'install_package' })).toContain('缺少 spec 参数')
    expect(await h.run({ action: 'remove_package', spec: '   ' })).toContain('缺少 spec 参数')

    npm.install.mockResolvedValue({ ok: true, detail: '已装好 probe' })
    expect(await h.run({ action: 'install_package', spec: 'probe' })).toBe('已装好 probe')
    expect(npm.install).toHaveBeenCalledWith('probe')

    npm.install.mockResolvedValue({ ok: false, detail: 'pnpm 说不行' })
    expect(await h.run({ action: 'install_package', spec: 'probe' })).toBe('错误：pnpm 说不行')

    npm.remove.mockResolvedValue({ ok: true, detail: '已卸载 probe' })
    expect(await h.run({ action: 'remove_package', spec: 'probe' })).toBe('已卸载 probe')
    npm.remove.mockResolvedValue({ ok: false, detail: '没这个包' })
    expect(await h.run({ action: 'remove_package', spec: 'probe' })).toBe('错误：没这个包')
  })

  test('未知 action 把可用清单列出来', async () => {
    const h = harness()
    expect(await h.run({ action: 'dance' })).toContain('未知 action dance')
    expect(await h.run({ action: 'dance' })).toContain('list / enable / disable')
  })
})
