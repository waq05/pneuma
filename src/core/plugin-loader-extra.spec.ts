/**
 * 插件装载与宿主存储的**分支补网**（只补失败/坏输入/默认值，不重复主路径）。
 *
 * 覆盖面：
 *   - `plugin-loader.ts`：运行时未初始化、client 能力的四种形状、模块级字段回落、
 *     导入失败（不存在 / 语法错 / dsh 提示开与关）、内置 fiber 登记与卸载失败吞错、
 *     批量热重挂的前置检查与去重、热重挂成功/校验失败/挂载失败回滚（含回滚也失败与
 *     元数据还原）、dsh 兼容 ctx（tools 门面 + get 诊断 + risk 配置现读）、
 *     组合包告警、应用自带行的目标解析（绝对/相对/包名/exports 各分支/缺包/无 name）。
 *   - `plugin-npm.ts`：spec 校验、找不到 pnpm、真实 spawn 假 pnpm（成功/失败/回滚失败）、
 *     安装名推断（本地目录 / 依赖差 / spec 猜名 / https 认不出）、卸载的有变化与无变化。
 *   - `session.ts`：坏 meta 抢救（改动路径反推 cwd / 最长公共目录 / 失败）、中断回合修复、
 *     编辑重发的派生状态清理、收件箱插队、路径守卫、回收站清理、fork 遇到坏行。
 *
 * 隔离：`DSC_HOME` 在**导入产品模块之前**设到临时目录（这里全部动态 import）；
 * `DSC_HOT=0` 关掉后台轮询。假 cordis root 只记录 plugin/apply/config 与 dispose。
 *
 * @module dsc/core/plugin-loader-extra.spec
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-loader-extra-'))
const WORK = join(HOME, 'work')
mkdirSync(WORK, { recursive: true })
const savedEnv = {
  DSC_HOME: process.env['DSC_HOME'],
  DSH_HOME: process.env['DSH_HOME'],
  DSC_PROFILE: process.env['DSC_PROFILE'],
  DSC_HOT: process.env['DSC_HOT'],
}
process.env['DSC_HOME'] = HOME
process.env['DSC_HOT'] = '0'
delete process.env['DSC_PROFILE']

let loader: typeof import('./plugin-loader.js')
let registry: typeof import('./plugin-registry.js')
let npm: typeof import('./plugin-npm.js')
let sessionCore: typeof import('./session.js')

beforeAll(async () => {
  registry = await import('./plugin-registry.js')
  loader = await import('./plugin-loader.js')
  npm = await import('./plugin-npm.js')
  sessionCore = await import('./session.js')
})

beforeEach(() => {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
  delete process.env['DSC_PROFILE']
  process.env['DSC_HOT'] = '0'
})

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // Windows 上目录可能还被句柄占着：留给系统清。
  }
})

/** 写文件（父目录一次建好）。 */
function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/** 读一份 JSON。 */
function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/** 唯一的包/行 id（进程级解析表要求同名只出现一次）。 */
let serial = 0
function unique(base: string): string {
  serial += 1
  return `${base}-${String(serial)}`
}

/** 一次假的 cordis root：记录挂载、可制造失败、可吞/抛 dispose 错误。 */
interface FakeRootOptions {
  failPlugin?: (plugin: Record<string, unknown>) => boolean
  failAfterFirst?: boolean
  disposeThrows?: boolean
  ctxGet?: (name: string) => unknown
}

function fakeRoot(options: FakeRootOptions = {}) {
  const mounted: Array<{ plugin: Record<string, unknown>; config: unknown }> = []
  const applied: unknown[] = []
  const disposed: string[] = []
  const entries: Array<Record<string, unknown>> = []
  const transcript: string[] = []
  let calls = 0
  const ctx = {
    get: (name: string) => options.ctxGet?.(name),
    tools: {
      register: (entry: Record<string, unknown>) => {
        entries.push(entry)
        return () => {}
      },
    },
  }
  const root = {
    plugin(plugin: Record<string, unknown>, config?: unknown) {
      calls += 1
      if (options.failAfterFirst === true && calls > 1) throw new Error('服务重名')
      if (options.failPlugin?.(plugin) === true) throw new Error('服务重名')
      mounted.push({ plugin, config })
      ;(plugin['apply'] as (innerCtx: unknown, innerConfig: unknown) => unknown)(ctx, config)
      applied.push(config ?? {})
      const fiber = Promise.resolve() as Promise<void> & { dispose: () => Promise<void> }
      fiber.dispose = async () => {
        disposed.push(String(plugin['name']))
        if (options.disposeThrows === true) throw new Error('dispose 失败')
      }
      return fiber
    },
    get: (name: string) => (name === 'transcript' ? root.transcript : options.ctxGet?.(name)),
    transcript: {
      system: (text: string) => {
        transcript.push(text)
      },
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return { root, mounted, applied, disposed, entries, transcript }
}

/** 插件目录（每次用新目录，避免用例互相看见）。 */
function pluginDir(): string {
  return mkdtempSync(join(WORK, 'plugins-'))
}

/** 写一个插件文件，返回绝对路径。 */
function pluginFile(dir: string, name: string, code: string): string {
  const file = join(dir, name)
  writeText(file, code)
  return file
}

/** 造一个应用安装目录：`lib/node_modules` 放包，`@pneuma/base` 给行清单。 */
function makeApp(patch: string, packages: Array<{ name: string; manifest?: Record<string, unknown>; code?: string }>): string {
  const appDir = mkdtempSync(join(WORK, 'app-'))
  const lib = join(appDir, 'lib')
  for (const item of packages) {
    const dir = join(lib, 'node_modules', ...item.name.split('/'))
    writeText(
      join(dir, 'package.json'),
      JSON.stringify({ name: item.name, version: '1.0.0', type: 'module', exports: { '.': './index.js' }, ...item.manifest }),
    )
    writeText(join(dir, 'index.js'), item.code ?? "export default { name: 'P', apply() {} }\n")
  }
  writeText(join(lib, 'node_modules', '@pneuma', 'base', 'package.json'), JSON.stringify({ name: '@pneuma/base', version: '1.0.0', type: 'module' }))
  writeText(join(lib, 'node_modules', '@pneuma', 'base', 'cordis.patch.yml'), patch)
  return appDir
}

/** 一行 insert 的 YAML（默认关闭，只验解析与登记）。 */
function insertRow(id: string, name: string | undefined, extra = ''): string {
  return `    - id: ${id}\n${name === undefined ? '' : `      name: '${name}'\n`}      disabled: true${extra}`
}

/** 一个组合包目录 + patch。 */
function makeBundle(profileDir: string, name: string, patch: string, manifestExtra: Record<string, unknown> = {}): string {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  writeText(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...manifestExtra }),
  )
  writeText(join(dir, 'cordis.patch.yml'), patch)
  return dir
}

/** 一个 profile 目录（不写 patch）。 */
function makeProfile(bundles: string[] = []): string {
  const dir = mkdtempSync(join(WORK, 'profile-'))
  writeText(join(dir, 'package.json'), JSON.stringify({ name: 'profile-x', dsh: { profile: { bundles } } }))
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  return dir
}

// ── plugin-loader：运行时前置与元数据 ──────────────────────────────────────

describe('plugin-loader：运行时未初始化与内置 fiber 登记', () => {
  test('未 init 时：批量重挂逐行给失败、list 为空、卸载静默、登记内置不抛', async () => {
    const results = await loader.remountExternalPlugins(['ghost-a', 'ghost-a', 'ghost-b'])
    expect(results).toHaveLength(3)
    expect(results[0]).toBe(results[1])
    for (const result of results) {
      expect(result.ok).toBe(false)
      expect(result.problem).toContain('插件运行时还没初始化')
    }
    expect(loader.listMountedPluginSources()).toEqual([])
    await expect(loader.unmountExternalPlugin('ghost-a')).resolves.toBeUndefined()
    expect(() => {
      loader.trackBuiltinMount('/tmp/never.js', { dispose: async () => {} } as never)
    }).not.toThrow()
  })

  test('init 后 trackBuiltinMount：按文件名登记，卸载时 dispose；dispose 抛错不阻塞', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    loader.registerPluginSource('builtin.js', '/tmp/builtin.js')
    let disposed = 0
    const fiber = {
      dispose: async () => {
        disposed += 1
        throw new Error('dispose 失败')
      },
    }
    loader.trackBuiltinMount('/tmp/builtin.js', fiber as never)

    expect(loader.listMountedPluginSources()).toContainEqual({ identity: 'builtin.js', file: '/tmp/builtin.js' })
    await expect(loader.unmountExternalPlugin('builtin.js')).resolves.toBeUndefined()
    expect(disposed).toBe(1)
    // 第二次卸载是 no-op。
    await expect(loader.unmountExternalPlugin('builtin.js')).resolves.toBeUndefined()
    expect(disposed).toBe(1)
  })
})

describe('plugin-loader：导入失败的三条路', () => {
  test('文件不存在 / 语法错误：原因写进 meta.problem 并写盘停用', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const dir = pluginDir()

    expect(await loader.mountExternalPlugin(join(dir, 'missing.js'), 'missing-row')).toBe(false)
    expect(registry.getPluginMeta('missing-row')?.problem).toBe('文件不存在或不可读')
    expect(registry.isPluginEnabled('missing-row')).toBe(false)

    const syntax = pluginFile(dir, 'syntax.js', 'export const = ;\n')
    expect(await loader.mountExternalPlugin(syntax, 'syntax-row')).toBe(false)
    expect(registry.getPluginMeta('syntax-row')?.problem).toContain('模块导入失败')
    expect(registry.getPluginMeta('syntax-row')?.problem).not.toContain('dsh 插件')
  })

  test('模块里 import @deepseek-ai/*：兼容层关着给启用提示，开着不再提示', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const dir = pluginDir()
    const dshStyle = pluginFile(dir, 'dsh-import.js', "throw new Error(\"Cannot find package '@deepseek-ai/dsh-llm' imported from x\")\n")

    registry.writePluginEnabled('dsh-compat', false)
    expect(await loader.mountExternalPlugin(dshStyle, 'dsh-off-row')).toBe(false)
    expect(registry.getPluginMeta('dsh-off-row')?.problem).toContain('这像是 dsh 插件')
    expect(registry.getPluginMeta('dsh-off-row')?.problem).toContain('dsh-compat')

    registry.writePluginEnabled('dsh-compat', true)
    expect(await loader.mountExternalPlugin(dshStyle, 'dsh-on-row')).toBe(false)
    const problem = registry.getPluginMeta('dsh-on-row')?.problem ?? ''
    expect(problem).toContain('模块导入失败')
    expect(problem).not.toContain('请先在插件中心启用')
  })
})

describe('plugin-loader：client 能力与模块级字段回落', () => {
  test('client/dshClient 四种形状：字符串、数组去重、对象键名、认不出给空', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const dir = pluginDir()
    const codes: Array<[string, string, string[] | undefined]> = [
      ['client-string', "export const client = 'browser'\nexport default { apply() {} }\n", ['browser']],
      ['client-array', "export const dshClient = ['a', 'a', '', 'b']\nexport default { apply() {} }\n", ['a', 'b']],
      [
        'client-object',
        "export const client = { platform: 'web', inject: ['llm'], custom: true }\nexport default { apply() {} }\n",
        ['platform:web', '服务:llm', 'custom'],
      ],
      ['client-bad', 'export const client = 42\nexport default { apply() {} }\n', undefined],
    ]
    for (const [id, code, expected] of codes) {
      expect(await loader.mountExternalPlugin(pluginFile(dir, `${id}.js`, code), id)).toBe(true)
      expect(registry.getPluginMeta(id)?.clientCapabilities, id).toEqual(expected)
    }
  })

  test('默认导出没名字时，模块级 name/description/apiVersion/settingsSection 补进元数据', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const dir = pluginDir()
    const file = pluginFile(
      dir,
      'meta.js',
      [
        'export default { apply() {} }',
        "export const name = '模块名'",
        "export const description = '模块描述'",
        'export const apiVersion = 1',
        "export const settingsSection = 'sec-x'",
        '',
      ].join('\n'),
    )
    expect(await loader.mountExternalPlugin(file, 'meta-row')).toBe(true)
    expect(registry.getPluginMeta('meta-row')).toMatchObject({
      name: '模块名',
      description: '模块描述',
      apiVersion: 1,
      settingsSection: 'sec-x',
    })
  })
})

// ── plugin-loader：热重挂 ──────────────────────────────────────────────────

describe('plugin-loader：remount 的前置检查与成功路径', () => {
  test('未挂载 / 文件丢了 / 重复入参：各自给失败，重复项共用同一份结果', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const file = pluginFile(pluginDir(), 'gone.js', "export default { name: 'Gone', apply() {} }\n")
    expect(await loader.mountExternalPlugin(file, 'gone-row')).toBe(true)
    rmSync(file)

    const results = await loader.remountExternalPlugins(['gone-row', 'gone-row', 'never-row'])
    expect(results).toHaveLength(3)
    expect(results[0]).toBe(results[1])
    expect(results[0]?.problem).toContain('找不到这一行的入口文件')
    expect(results[2]?.problem).toContain('没有挂载')
    expect(registry.getPluginMeta('gone-row')?.problem).toContain('找不到这一行的入口文件')
  })

  test('成功：只换一代、apply 用同一份行配置、旧 fiber 被 dispose、元数据换成新名字', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const file = pluginFile(pluginDir(), 'hot.js', "export default { name: 'HotOld', apply() {} }\n")
    expect(
      await loader.mountExternalPlugin(file, 'hot-row', { config: { v: 1 }, configOrigin: 'host' }),
    ).toBe(true)

    const generation = loader.currentGeneration()
    writeText(file, "export default { name: 'HotNew', apply() {} }\n")
    utimesSync(file, new Date(), new Date(Date.now() + 2_000))

    const [result] = await loader.remountExternalPlugins(['hot-row'])
    expect(result).toEqual({ ok: true, generation: generation + 1 })
    expect(fake.applied.at(-1)).toEqual({ v: 1 })
    expect(fake.mounted.at(-1)?.plugin['name']).toBe('HotNew')
    expect(fake.disposed).toContain('HotOld')
    expect(registry.getPluginMeta('hot-row')?.name).toBe('HotNew')
  })

  test('新版本导入/校验失败：旧 fiber 不动，meta 写「热重挂失败」', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const file = pluginFile(pluginDir(), 'keep.js', "export default { name: 'KeepOld', apply() {} }\n")
    expect(await loader.mountExternalPlugin(file, 'keep-row')).toBe(true)

    writeText(file, 'export const x = 1\n')
    utimesSync(file, new Date(), new Date(Date.now() + 2_000))
    const [result] = await loader.remountExternalPlugins(['keep-row'])
    expect(result.ok).toBe(false)
    expect(result.problem).toContain('热重挂失败')
    expect(fake.disposed).toHaveLength(0)
    expect(fake.mounted).toHaveLength(1)
    expect(registry.getPluginMeta('keep-row')?.problem).toContain('热重挂失败')
  })

  test('新版本挂载失败但旧版本能回去：回滚并还原元数据（新增的 apiVersion/client 键被删掉）', async () => {
    const fake = fakeRoot({ failPlugin: (plugin) => plugin['name'] === 'NewName' })
    loader.initPluginRuntime(fake.root as never)
    const file = pluginFile(pluginDir(), 'rollback.js', "export default { name: 'OldName', apply() {} }\n")
    expect(await loader.mountExternalPlugin(file, 'rollback-row')).toBe(true)

    writeText(
      file,
      "export const apiVersion = 1\nexport const client = 'web'\nexport default { name: 'NewName', apply() {} }\n",
    )
    utimesSync(file, new Date(), new Date(Date.now() + 2_000))
    const [result] = await loader.remountExternalPlugins(['rollback-row'])

    expect(result.ok).toBe(false)
    expect(result.problem).toContain('已回滚到旧版本')
    expect(fake.mounted.at(-1)?.plugin['name']).toBe('OldName')
    const meta = registry.getPluginMeta('rollback-row')
    expect(meta?.name).toBe('OldName')
    expect(meta?.apiVersion).toBeUndefined()
    expect(meta?.clientCapabilities).toBeUndefined()
  })

  test('新版本挂载失败且旧版本也起不来：明确写「没能恢复」，不装作回滚成功', async () => {
    const fake = fakeRoot({ failAfterFirst: true })
    loader.initPluginRuntime(fake.root as never)
    const file = pluginFile(pluginDir(), 'norollback.js', "export default { name: 'OnlyOld', apply() {} }\n")
    expect(await loader.mountExternalPlugin(file, 'norollback-row')).toBe(true)

    writeText(file, "export default { name: 'OnlyNew', apply() {} }\n")
    utimesSync(file, new Date(), new Date(Date.now() + 2_000))
    const [result] = await loader.remountExternalPlugins(['norollback-row'])
    expect(result.ok).toBe(false)
    expect(result.problem).toContain('旧版本也没能恢复')
    expect(result.problem).not.toContain('已回滚到旧版本')
  })
})

// ── plugin-loader：dsh 兼容 ctx 与组合包 ───────────────────────────────────

describe('plugin-loader：兼容层 ctx', () => {
  test('tools 门面按插件条目配置现读 risk；ctx.get 记录陌生服务并写进挂载诊断', async () => {
    const fake = fakeRoot({ ctxGet: (name) => (name === 'llm' ? { provider: 'p' } : undefined) })
    loader.initPluginRuntime(fake.root as never)
    writeFileSync(
      join(HOME, 'plugins.json'),
      JSON.stringify({
        version: 1,
        entries: [
          { file: 'dsh-compat', disabled: false },
          { file: 'ctx-row', disabled: false, config: { risks: { facade: 'write' } } },
        ],
      }),
      'utf8',
    )

    const file = pluginFile(
      pluginDir(),
      'ctx.js',
      [
        'export default {',
        "  name: 'Ctx',",
        '  apply(ctx) {',
        "    ctx.tools.register({ name: 'facade', description: '', parameters: {}, execute: async () => ({ ok: true }) })",
        "    if (ctx.get('llm') === undefined) throw new Error('llm missing')",
        "    ctx.get('sessions')",
        "    ctx.get('no-such-service')",
        "    throw new Error('boom')",
        '  },',
        '}',
        '',
      ].join('\n'),
    )

    expect(await loader.mountExternalPlugin(file, 'ctx-row')).toBe(false)
    expect(fake.entries).toHaveLength(1)
    expect(fake.entries[0]).toMatchObject({ name: 'facade', risk: 'write' })
    const problem = registry.getPluginMeta('ctx-row')?.problem ?? ''
    expect(problem).toContain('boom')
    expect(problem).toContain('sessions')
    expect(problem).toContain('no-such-service')
  })

  test('mountAllExternalPlugins：profile 存在就走组合包路径，告警经 transcript 报出', async () => {
    const fake = fakeRoot()
    const profile = join(HOME, 'profiles', 'auto')
    writeText(join(profile, 'package.json'), JSON.stringify({ name: 'auto', dsh: { profile: { bundles: ['ghost'] } } }))
    process.env['DSC_PROFILE'] = 'auto'
    try {
      const failures = await loader.mountAllExternalPlugins(fake.root as never, [])
      expect(failures).toEqual([])
      expect(fake.transcript.join(' | ')).toContain('组合包')
      expect(fake.transcript.join(' | ')).toContain('ghost')
    } finally {
      delete process.env['DSC_PROFILE']
    }
  })

  test('组合包告警：缺目录 / 无 package.json / patch 不安全 / 引擎闸不过且豁免过期', async () => {
    const profile = makeProfile(['ghost', 'nullpkg', 'unsafe', 'gated'])
    writeText(join(profile, 'node_modules', 'nullpkg', 'package.json'), 'null')
    makeBundle(profile, 'unsafe', '- insert: []\n!!js\n')
    makeBundle(profile, 'gated', '- insert: []\n', { engines: { dsh: '>=9.0.0' } })
    writeText(
      join(profile, 'compatibility.json'),
      JSON.stringify({ exemptions: [{ package: 'gated', version: '1.0.0', dshVersion: '0.0.1' }] }),
    )

    const result = await loader.mountBundlePlugins(fakeRoot().root as never, profile)
    const warnings = result.warnings.join(' | ')
    expect(warnings).toContain('ghost')
    expect(warnings).toContain('没有 package.json')
    expect(warnings).toContain('unsafe')
    expect(warnings).toContain('numa plugin allow-version')
  })

  test('组合包的 pneuma.client：platform 不是 pneuma 就列出来，是 pneuma 就不列', async () => {
    const profile = makeProfile(['b1', 'b2'])
    makeBundle(profile, 'b1', "- insert:\n    - id: b1-row\n      name: './index.js'\n", {
      pneuma: { client: { platform: 'web', inject: ['llm'] } },
    })
    writeText(join(profile, 'node_modules', 'b1', 'index.js'), "export default { name: 'B1', apply() {} }\n")
    makeBundle(profile, 'b2', "- insert:\n    - id: b2-row\n      name: './index.js'\n", {
      pneuma: { client: { platform: 'pneuma', inject: ['llm'] } },
    })
    writeText(join(profile, 'node_modules', 'b2', 'index.js'), "export default { name: 'B2', apply() {} }\n")

    const result = await loader.mountBundlePlugins(fakeRoot().root as never, profile)
    expect(result.failures).toEqual([])
    expect(registry.getPluginMeta('b1-row')?.clientCapabilities).toEqual(['platform:web', '服务:llm'])
    expect(registry.getPluginMeta('b2-row')?.clientCapabilities).toBeUndefined()
  })
})

// ── plugin-loader：应用自带行的目标解析 ────────────────────────────────────

describe('plugin-loader：应用自带行解析分支', () => {
  test('缺 name / 缺包 / 绝对与相对路径 / exports 各形状 / 无入口 / 深目录都能落到正确结果', async () => {
    const resource = mkdtempSync(join(WORK, 'res-'))
    const makeDir = (files: Record<string, string>): string => {
      const dir = mkdtempSync(join(resource, 'pkg-'))
      for (const [name, text] of Object.entries(files)) writeText(join(dir, name), text)
      return dir
    }
    const pluginCode = "export default { name: 'X', apply() {} }\n"
    const cond = makeDir({ 'package.json': JSON.stringify({ exports: { '.': { import: './main.js' } } }), 'main.js': pluginCode })
    const dot = makeDir({ 'package.json': JSON.stringify({ exports: { '.': './entry.js' } }), 'entry.js': pluginCode })
    const stringExports = makeDir({ 'package.json': JSON.stringify({ exports: './s.js' }), 's.js': pluginCode })
    const main = makeDir({ 'package.json': JSON.stringify({ main: './m.js' }), 'm.js': pluginCode })
    const indexOnly = makeDir({ 'package.json': '{}', 'index.js': pluginCode })
    const badJson = makeDir({ 'package.json': '{bad', 'index.js': pluginCode })
    const noEntry = makeDir({ 'package.json': JSON.stringify({ exports: { '.': './missing.js' } }) })
    const deep = join(resource, ...Array.from({ length: 9 }, (_, index) => `d${String(index)}`), 'deep.js')
    writeText(deep, pluginCode)
    const relativeApp = makeApp(
      [
        '- insert:',
        insertRow('no-name-row', undefined),
        insertRow('abs-cond', cond),
        insertRow('abs-dot', dot),
        insertRow('abs-string', stringExports),
        insertRow('abs-main', main),
        insertRow('abs-index', indexOnly),
        insertRow('abs-badjson', badJson),
        insertRow('abs-noentry', noEntry),
        insertRow('abs-deep', deep),
        insertRow('abs-missing', join(resource, 'nope', 'x.js')),
        '',
      ].join('\n'),
      [],
    )
    // 相对路径按 base 包目录算：补一个本行插件文件。
    writeText(join(relativeApp, 'lib', 'node_modules', '@pneuma', 'base', 'local', 'plugin.js'), pluginCode)
    writeText(
      join(relativeApp, 'lib', 'node_modules', '@pneuma', 'base', 'cordis.patch.yml'),
      [
        '- insert:',
        insertRow('no-name-row', undefined),
        insertRow('abs-cond', cond),
        insertRow('abs-dot', dot),
        insertRow('abs-string', stringExports),
        insertRow('abs-main', main),
        insertRow('abs-index', indexOnly),
        insertRow('abs-badjson', badJson),
        insertRow('abs-noentry', noEntry),
        insertRow('abs-deep', deep),
        insertRow('abs-missing', join(resource, 'nope', 'x.js')),
        insertRow('rel-row', './local/plugin.js'),
        '',
      ].join('\n'),
    )

    const fake = fakeRoot()
    const failures = await loader.mountApplicationRows(fake.root as never, { appDir: relativeApp, surface: 'none' })
    expect(failures.map((item) => item.file).sort()).toEqual(['abs-missing', 'abs-noentry'])
    expect(fake.transcript.join(' | ')).toContain('没有 name')
    expect(registry.getPluginMeta('rel-row')?.file).toBe('rel-row')
    for (const id of ['abs-cond', 'abs-dot', 'abs-string', 'abs-main', 'abs-index', 'abs-badjson', 'abs-deep']) {
      expect(registry.getPluginMeta(id)?.file, id).toBe(id)
    }
  })

  test('行级 inject：字符串、数组（过滤空项）、缺省 undefined 都按原意进插件对象', async () => {
    const app = makeApp(
      [
        '- insert:',
        insertRow('inj-str', 'inj-str-pkg', '').replace('      disabled: true', "      inject: 'tools'"),
        insertRow('inj-arr', 'inj-arr-pkg', '').replace('      disabled: true', "      inject: ['tools', '', 'llm']"),
        insertRow('inj-none', 'inj-none-pkg', '').replace('      disabled: true', ''),
        '',
      ].join('\n'),
      [
        { name: 'inj-str-pkg', code: "export default { name: 'InjStr', apply() {} }\n" },
        { name: 'inj-arr-pkg', code: "export default { name: 'InjArr', apply() {} }\n" },
        { name: 'inj-none-pkg', code: "export default { name: 'InjNone', apply() {} }\n" },
      ],
    )
    const fake = fakeRoot()
    const failures = await loader.mountApplicationRows(fake.root as never, { appDir: app, surface: 'none' })
    expect(failures).toEqual([])
    const byName = new Map(fake.mounted.map((item) => [String(item.plugin['name']), item.plugin]))
    expect(byName.get('InjStr')?.['inject']).toEqual(['tools'])
    expect(byName.get('InjArr')?.['inject']).toEqual(['tools', 'llm'])
    expect(byName.get('InjNone')?.['inject']).toBeUndefined()
  })
})

// ── plugin-npm：spec 校验与真实 spawn ─────────────────────────────────────

const FAKE_PNPM = join(HOME, 'fake-pnpm.cjs')

/** 假 pnpm：按 spec 约定写/不写清单，用来验成功、失败与回滚三条路。 */
writeText(
  FAKE_PNPM,
  [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const [cmd, spec] = process.argv.slice(2)',
    'const dir = process.cwd()',
    "const pkgFile = path.join(dir, 'package.json')",
    'const read = () => { try { return JSON.parse(fs.readFileSync(pkgFile, "utf8")) } catch { return {} } }',
    'const write = (value) => fs.writeFileSync(pkgFile, JSON.stringify(value, null, 2) + "\\n")',
    "if (spec === '__fail__' || spec === '__failremove__') {",
    "  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'spawned')",
    "  process.stderr.write('fake-crash\\n')",
    "  process.exit(3)",
    '}',
    "if (spec.startsWith('http') || spec.includes('nostore')) process.exit(0)",
    "if (cmd === 'add') {",
    '  const manifest = read()',
    "  const plain = !spec.startsWith('file:') && !path.isAbsolute(spec) && !spec.startsWith('.')",
    "  const depName = plain ? spec.replace(/@[^@/]*$/, '') : spec",
    "  manifest.dependencies = { ...(manifest.dependencies || {}), [depName]: '1.0.0' }",
    '  write(manifest)',
    '  if (plain) {',
    "    const bundleDir = path.join(dir, 'node_modules', ...depName.split('/'))",
    '    fs.mkdirSync(bundleDir, { recursive: true })',
    "    const entry = { name: depName, version: '1.2.3' }",
    "    if (spec !== 'plain-bundle') entry.dsh = { bundle: { patch: './cordis.patch.yml' } }",
    "    fs.writeFileSync(path.join(bundleDir, 'package.json'), JSON.stringify(entry))",
    "    if (entry.dsh) fs.writeFileSync(path.join(bundleDir, 'cordis.patch.yml'), '- insert: []\\n')",
    '  }',
    '  process.exit(0)',
    '}',
    "if (cmd === 'remove') {",
    '  const manifest = read()',
    '  if (manifest.dependencies) delete manifest.dependencies[spec]',
    '  write(manifest)',
    '  process.exit(0)',
    '}',
    'process.exit(0)',
    '',
  ].join('\n'),
)

// POSIX 上 `resolveExecutable` 还要查可执行位（core/executable.ts 的 `isRunnable` 里
// `accessSync(X_OK)`）：只写内容的 `.cjs` 是 0644，会被判成「找不到 pnpm」，于是安装/卸载
// 全部走失败分支。补上执行位后，两边都按 `.cjs → node <脚本>` 这条真实路径跑（Windows 上
// chmod 不影响能否启动，`.cjs` 本来就交给 node 起）。
chmodSync(FAKE_PNPM, 0o755)

/** 一个带 package.json 的 profile 目录。 */
function npmProfile(name: string, manifest: Record<string, unknown>): string {
  const dir = join(WORK, 'npm-profiles', name)
  writeText(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return dir
}

describe('plugin-npm：入口校验与没有 profile', () => {
  test('spec 不合法的五种形状都在动盘前拒绝', async () => {
    const cases: Array<[unknown, string]> = [
      [12 as never, '没给包名或路径'],
      ['   ', '包名或路径是空的'],
      ['a'.repeat(301), '写得太长'],
      ['a b', '空白或 shell 元字符'],
      ['-g', '不能以 - 开头'],
    ]
    for (const [spec, needle] of cases) {
      const outcome = await npm.installNpmBundle(spec as never, { profileDir: join(WORK, 'unused') })
      expect(outcome.ok, String(spec)).toBe(false)
      expect(outcome.detail).toContain(needle)
    }
    expect((await npm.removeNpmBundle('-g')).detail).toContain('拒绝卸载')
  })

  test('没有生效 profile：安装与卸载都给出指路文案', async () => {
    const install = await npm.installNpmBundle('any-pkg', { profileDir: '' })
    expect(install.ok).toBe(false)
    expect(install.detail).toContain('没有生效的 profile')
    const remove = await npm.removeNpmBundle('any-pkg', { profileDir: '' })
    expect(remove.ok).toBe(false)
    expect(remove.detail).toContain('没有生效的 profile')
  })
})

describe('plugin-npm：安装（真实 spawn 假 pnpm）', () => {
  test('成功：依赖写进清单、包名并进 bundles、读得到版本与 patch 条数', async () => {
    const profile = npmProfile('install-ok', { name: 'p', dsh: { profile: { bundles: [] } } })
    const outcome = await npm.installNpmBundle('plain-pkg', { profileDir: profile, pnpmPath: FAKE_PNPM })
    expect(outcome).toMatchObject({ ok: true, name: 'plain-pkg', version: '1.2.3', patches: 1 })
    expect(outcome.detail).toContain('patch 1 条')
    const doc = readJson(join(profile, 'package.json'))
    expect((doc['dependencies'] as Record<string, string>)['plain-pkg']).toBe('1.0.0')
    expect((doc['dsh'] as { profile: { bundles: string[] } }).profile.bundles).toEqual(['plain-pkg'])
  })

  test('目录里原本没有 package.json：先铺最小清单再装；没有 patch 的包报 0 条', async () => {
    const fresh = join(WORK, 'npm-profiles', 'install-fresh')
    const first = await npm.installNpmBundle('plain-bundle', { profileDir: fresh, pnpmPath: FAKE_PNPM })
    expect(first.ok).toBe(true)
    expect(first.patches).toBe(0)
    expect(first.detail).toContain('patch 0 条')
    const doc = readJson(join(fresh, 'package.json'))
    expect(doc['name']).toBe('pneuma-profile')
    expect((doc['dependencies'] as Record<string, string>)['plain-bundle']).toBe('1.0.0')
  })

  test('本地绝对路径：包名从被装目录自己的 package.json 读，不靠依赖差', async () => {
    const local = join(WORK, 'local-pkg')
    writeText(join(local, 'package.json'), JSON.stringify({ name: 'local-fixture', version: '9.9.9' }))
    const profile = npmProfile('install-local', { name: 'p' })
    const outcome = await npm.installNpmBundle(local.replace(/\\/g, '/'), { profileDir: profile, pnpmPath: FAKE_PNPM })
    expect(outcome.ok).toBe(true)
    expect(outcome.name).toBe('local-fixture')
    expect(outcome.detail).toContain('读不到它的 package.json')
  })

  test('没有依赖差时从 spec 猜包名；https tarball 认不出名字就如实失败', async () => {
    const profile = npmProfile('install-guess', { name: 'p' })
    const guessed = await npm.installNpmBundle('@nostore/pkg@2.0.0', { profileDir: profile, pnpmPath: FAKE_PNPM })
    expect(guessed.ok).toBe(true)
    expect(guessed.name).toBe('@nostore/pkg')

    const tarball = await npm.installNpmBundle('https://example.com/p.tgz', { profileDir: profile, pnpmPath: FAKE_PNPM })
    expect(tarball.ok).toBe(false)
    expect(tarball.detail).toContain('认不出装进来的是哪个包')
  })

  test('pnpm 非零退出：package.json 与 lockfile 逐字节还原，并带 stderr 尾部', async () => {
    const original = JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }, null, 2) + '\n'
    const profile = join(WORK, 'npm-profiles', 'install-fail')
    writeText(join(profile, 'package.json'), original)
    writeText(join(profile, 'pnpm-lock.yaml'), 'old-lock\n')

    const outcome = await npm.installNpmBundle('__fail__', { profileDir: profile, pnpmPath: FAKE_PNPM })
    expect(outcome.ok).toBe(false)
    expect(outcome.restored).toBe(true)
    expect(outcome.detail).toContain('安装失败')
    expect(outcome.detail).toContain('已还原')
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(original)
    expect(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')).toBe('old-lock\n')
  })

  test('回滚自身失败：明确报「还原失败」，不假称已恢复', async () => {
    const profile = join(WORK, 'npm-profiles', 'install-restore-fail')
    writeText(join(profile, 'package.json'), JSON.stringify({ name: 'p' }))
    // lockfile 位置被目录占着：快照读不到（null），回滚时 rmSync 目录又失败。
    mkdirSync(join(profile, 'pnpm-lock.yaml'), { recursive: true })

    const outcome = await npm.installNpmBundle('__fail__', { profileDir: profile, pnpmPath: FAKE_PNPM })
    expect(outcome.ok).toBe(false)
    expect(outcome.restored).toBe(false)
    expect(outcome.detail).toContain('还原失败')
  })

  test.skipIf(process.platform !== 'win32')('.cmd 里读不出 pnpm 脚本：报一句可操作的错', async () => {
    const profile = npmProfile('install-cmd', { name: 'p' })
    const cmd = join(WORK, 'plain-pnpm.cmd')
    writeText(cmd, 'echo hi\r\n')
    const outcome = await npm.installNpmBundle('any-pkg', { profileDir: profile, pnpmPath: cmd })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('读不出它指向的 pnpm 脚本')
  })

  test('找不到 pnpm：给出「桌面端确认自带 pnpm/corepack」的文案', async () => {
    const profile = npmProfile('install-nopnpm', { name: 'p' })
    const outcome = await npm.installNpmBundle('any-pkg', { profileDir: profile, pnpmPath: join(WORK, 'no', 'pnpm') })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('找不到 pnpm')
  })
})

describe('plugin-npm：卸载', () => {
  test('有变化：删掉 dependencies 与 bundles 两处并写回', async () => {
    const profile = npmProfile('remove-changed', {
      name: 'p',
      dependencies: { 'plain-pkg': '1.0.0' },
      dsh: { profile: { bundles: ['plain-pkg', 'other'] } },
    })
    const outcome = await npm.removeNpmBundle('plain-pkg', { profileDir: profile, pnpmPath: FAKE_PNPM })
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('profile 清单里也去掉了')
    const doc = readJson(join(profile, 'package.json'))
    expect((doc['dsh'] as { profile: { bundles: string[] } }).profile.bundles).toEqual(['other'])
    expect((doc['dependencies'] as Record<string, string>)['plain-pkg']).toBeUndefined()
  })

  test('无变化：不重写清单，文案也不说「去掉了」', async () => {
    const profile = npmProfile('remove-same', { name: 'p', dsh: { profile: { bundles: [] } } })
    const before = readFileSync(join(profile, 'package.json'), 'utf8')
    const outcome = await npm.removeNpmBundle('plain-pkg', { profileDir: profile, pnpmPath: FAKE_PNPM })
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toBe('已卸载 plain-pkg。')
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(before)
  })

  test('pnpm remove 失败：清单还原，原因与回滚状态都在文案里', async () => {
    const original = JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['x'] } } }, null, 2) + '\n'
    const profile = join(WORK, 'npm-profiles', 'remove-fail')
    writeText(join(profile, 'package.json'), original)
    writeText(join(profile, 'pnpm-lock.yaml'), 'keep-lock\n')
    const outcome = await npm.removeNpmBundle('__failremove__', { profileDir: profile, pnpmPath: FAKE_PNPM })
    expect(outcome.ok).toBe(false)
    expect(outcome.restored).toBe(true)
    expect(outcome.detail).toContain('卸载失败')
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(original)
    expect(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')).toBe('keep-lock\n')
  })
})

// ── session.ts：坏 meta 抢救、修复、路径守卫与回收站 ──────────────────────

/** 一条合法 tool 记录里的改动摘要（salvage 从 changes[].path 反推 cwd）。 */
function changeAt(path: string) {
  return { path, added: 1, removed: 0, hunks: [], status: 'modified' as const }
}

/** 轮询到条件成立（写入流是异步的，落盘之后才读文件）。 */
async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error('3 秒内没有等到文件落盘')
    await new Promise((resolveTick) => setTimeout(resolveTick, 10))
  }
}

/** 把会话文件首行换成坏 JSON（模拟半截 meta）。 */
function corruptMeta(file: string): void {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines[0] = 'not-json'
  writeFileSync(file, lines.join('\n'), 'utf8')
}

/** 建一个写过一条用户消息的会话文件，返回路径（等落盘）。 */
async function persistedSession(cwd: string): Promise<string> {
  const session = sessionCore.Session.create(cwd)
  session.appendUser('hello')
  const file = session.filePath
  session.close()
  await until(() => existsSync(file) && readFileSync(file, 'utf8').includes('hello'))
  return file
}

describe('session：坏 meta 抢救', () => {
  test('从 tool.changes 与 state.payload.file 反推 cwd；坏行跳过；出生时间可用', async () => {
    const cwd = mkdtempSync(join(WORK, 'salvage-'))
    const session = sessionCore.Session.create(cwd)
    session.appendUser('hello')
    session.appendAssistant('', '', [{ id: 'c1', name: 'edit', arguments: '{}' }])
    session.appendTool('c1', 'edit', { text: 'ok', changes: changeAt(join(cwd, 'src', 'a.ts')) })
    session.appendState('plan', { file: join(cwd, 'plan.md') } as never)
    const file = session.filePath
    session.close()
    await until(() => existsSync(file) && readFileSync(file, 'utf8').includes('plan.md'))
    // 追加一条坏行：抢救要跳过它，而不是整份报废。
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"type":"tool","changes":[{bad\n`, 'utf8')
    corruptMeta(file)

    const loaded = sessionCore.Session.load(file, true, { lease: false })
    expect(loaded.meta.cwd).toBe(cwd)
    expect(loaded.meta.id).toBe(basename(file, '.jsonl'))
    expect(loaded.meta.createdAt).toBeGreaterThan(0)
    expect(loaded.messages.some((message) => message.role === 'tool')).toBe(true)
    loaded.close()
  })

  test('路径都推不出目录树时退回最长公共目录', () => {
    const base = mkdtempSync(join(WORK, 'common-'))
    const file = join(base, 'misc', 'id.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      [
        'broken-meta',
        JSON.stringify({ type: 'tool', callId: 'c1', name: 'edit', text: 'x', changes: [changeAt(join(base, 'a', 'x.ts'))] }),
        JSON.stringify({ type: 'tool', callId: 'c2', name: 'edit', text: 'y', changes: [changeAt(join(base, 'b', 'y.ts'))] }),
        '',
      ].join('\n'),
      'utf8',
    )
    const loaded = sessionCore.Session.load(file, true, { lease: false })
    expect(loaded.meta.cwd).toBe(base)
    loaded.close()
  })

  test('没有任何绝对路径可反推：响亮报错，文件保留', () => {
    const base = mkdtempSync(join(WORK, 'nosalvage-'))
    const file = join(base, 's.jsonl')
    writeFileSync(
      file,
      [
        'broken-meta',
        JSON.stringify({ type: 'tool', callId: 'c1', name: 'edit', text: 'x', changes: [{ path: 'relative/a.ts' }] }),
        '',
      ].join('\n'),
      'utf8',
    )
    expect(() => sessionCore.Session.load(file, true, { lease: false })).toThrow(/无法从内容推断工作目录/)
    expect(existsSync(file)).toBe(true)
  })
})

describe('session：中断回合修复与编辑重发', () => {
  test('加载时给未应答的 tool_call 补一条合成结果', async () => {
    const cwd = mkdtempSync(join(WORK, 'repair-'))
    const session = sessionCore.Session.create(cwd)
    session.appendUser('hi')
    session.appendAssistant('', '', [{ id: 'c1', name: 'edit', arguments: '{}' }])
    const file = session.filePath
    session.close()
    await until(() => existsSync(file) && readFileSync(file, 'utf8').includes('"type":"assistant"'))

    const loaded = sessionCore.Session.load(file, true)
    const tool = loaded.messages.find((message) => message.role === 'tool')
    expect(tool?.tool_call_id).toBe('c1')
    expect(String(tool?.content)).toContain('回合被打断')
    loaded.close()
  })

  test('rewind：丢掉的那段工具派生状态一并清理；越界返回 false；带图消息按多模态内容计数', () => {
    const session = sessionCore.Session.create(mkdtempSync(join(WORK, 'rewind-')))
    session.appendUser('first')
    session.appendAssistant('', '', [{ id: 'c1', name: 'edit', arguments: '{}' }])
    session.appendTool('c1', 'edit', 'ok')
    // 带 data URL 的用户消息：content 是数组，走 isHumanUserMessage 的多模态分支。
    session.appendUser('second', ['data:image/png;base64,AAAA'])
    session.appendAssistant('', '', [{ id: 'c2', name: 'edit', arguments: '{}' }])
    session.appendTool('c2', 'edit', 'ok')
    session.toolErrors.set('c1', 'tool-error')
    session.toolErrors.set('c2', 'tool-error')
    session.fileChanges.set('c2', [])
    session.presentations.set('c2', {} as never)

    expect(session.rewindToUser(1)).toBe(true)
    expect(session.toolErrors.has('c2')).toBe(false)
    expect(session.fileChanges.has('c2')).toBe(false)
    expect(session.presentations.has('c2')).toBe(false)
    expect(session.toolErrors.has('c1')).toBe(true)
    expect(session.rewindToUser(9)).toBe(false)
    session.close()
  })

  test('promoteAsync：队首原样返回 true、越界 false、中间项提到队首', () => {
    const session = sessionCore.Session.create(mkdtempSync(join(WORK, 'inbox-')))
    session.appendUser('seed')
    session.enqueueAsync('a')
    session.enqueueAsync('b')
    session.enqueueAsync('c')
    expect(session.promoteAsync(9)).toBe(false)
    expect(session.promoteAsync(0)).toBe(true)
    expect(session.promoteAsync(2)).toBe(true)
    expect(session.asyncInbox().map((item) => item.text)).toEqual(['c', 'a', 'b'])
    session.close()
  })
})

describe('session：路径守卫、回收站与 fork', () => {
  test('归档/删除的路径守卫：越界、不存在、队友记录、已在归档区都拒绝', () => {
    const root = sessionCore.sessionsRoot()
    expect(() => sessionCore.archiveSession(join(HOME, 'outside.jsonl'))).toThrow(/不在/)
    expect(() => sessionCore.archiveSession(join(root, 'missing.jsonl'))).toThrow(/不存在/)

    const teammate = join(sessionCore.teammateRoot(), 'slug', 't.jsonl')
    writeText(teammate, '{}\n')
    expect(() => sessionCore.purgeSession(teammate)).toThrow(/队友的运行记录/)

    const archived = join(sessionCore.archivedRoot(), 'slug', 'a.jsonl')
    writeText(archived, '{}\n')
    expect(() => sessionCore.archiveSession(archived)).toThrow(/已经在归档区/)
    expect(() => sessionCore.restoreSession(join(root, 'nope.jsonl'))).toThrow(/归档会话不存在/)
  })

  test('彻底删除进回收站；sweepTrash 只清过期文件，非目录项忽略', async () => {
    const file = await persistedSession(mkdtempSync(join(WORK, 'purge-')))

    const trashed = sessionCore.purgeSession(file)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(trashed)).toBe(true)
    expect(sessionCore.countTrashFiles()).toBeGreaterThanOrEqual(1)

    const trash = sessionCore.trashRoot()
    writeText(join(trash, 'not-a-dir.txt'), 'x')
    const expired = join(trash, 'slug', 'old.jsonl')
    const fresh = join(trash, 'slug', 'new.jsonl')
    writeText(expired, '{}\n')
    writeText(fresh, '{}\n')
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    utimesSync(expired, old, old)
    const removed = sessionCore.sweepTrash()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(expired)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(statSync(trash).isDirectory()).toBe(true)
  })

  test('forkSession 遇到坏 JSON 行跳过而不炸；坏行仍被原样带过去', async () => {
    const file = await persistedSession(mkdtempSync(join(WORK, 'fork-')))
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"type": bad\n`, 'utf8')
    const forked = sessionCore.forkSession(file, 1)
    expect(existsSync(forked)).toBe(true)
    expect(readFileSync(forked, 'utf8')).toContain('"type": bad')
  })
})
