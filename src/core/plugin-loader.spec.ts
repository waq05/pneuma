/**
 * 外部插件热挂载（`core/plugin-loader.ts` 的挂载面）：导入 → 校验 → 挂载 → 失败停用 → 热启停。
 *
 * 用假的 cordis root：`root.plugin()` 记录插件对象与配置并同步跑一次 apply，
 * 返回一个可 dispose 的 thenable。插件源码是临时目录里的真 ESM 文件，
 * 所以「默认导出 / 唯一命名导出 / 模块级 apply / apiVersion / Config / dsh 服务名」
 * 这些判定走的都是真 import 路径。DSC_HOME 指向临时目录，不碰 `~/.dsc`。
 *
 * @module dsc/core/plugin-loader.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-plugin-loader-'))
process.env['DSC_HOME'] = HOME

let loader: typeof import('./plugin-loader.js')
let registry: typeof import('./plugin-registry.js')

beforeAll(async () => {
  registry = await import('./plugin-registry.js')
  loader = await import('./plugin-loader.js')
})

beforeEach(() => {
  // 每个用例从干净的开关记录开始。
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
})

/** 插件目录（每次用新目录，避免 adopt 用例互相看见对方留下的文件）。 */
function pluginsDir(): string {
  const dir = join(HOME, `plugins-${String(Math.random()).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 假 cordis root：记录挂载、可制造挂载失败。 */
function fakeRoot(fail = false) {
  const mounted: Array<{ plugin: Record<string, unknown>; config: unknown }> = []
  const disposed: string[] = []
  const applied: Array<Record<string, unknown>> = []
  const ctx = { get: () => undefined, tools: { register: () => {} } }
  const root = {
    plugin(plugin: Record<string, unknown>, config: unknown) {
      if (fail) throw new Error('服务重名')
      mounted.push({ plugin, config })
      ;(plugin['apply'] as (c: unknown, v: unknown) => void)(ctx, config)
      applied.push((config ?? {}) as Record<string, unknown>)
      const fiber = Promise.resolve() as Promise<void> & { dispose: () => Promise<void> }
      fiber.dispose = async () => {
        disposed.push(String(plugin['name']))
      }
      return fiber
    },
    get: () => undefined,
    emit: () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  return { root: root as never, mounted, disposed, applied }
}

/** 写一个插件文件；返回绝对路径。 */
function pluginFile(dir: string, name: string, code: string): string {
  const file = join(dir, name)
  writeFileSync(file, code, 'utf8')
  return file
}

describe('导入与插件对象识别', () => {
  test('默认导出对象插件：挂上、apply 收到配置、meta 记名字与来源', async () => {
    const dir = pluginsDir()
    const file = pluginFile(dir, 'a.js', "export default { name: 'A', apply(ctx, config) { globalThis.__aConfig = config } }\n")
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root)

    expect(await loader.mountExternalPlugin(file, 'row-a')).toBe(true)
    expect(fake.mounted).toHaveLength(1)
    expect(fake.applied[0]).toEqual({})
    expect((globalThis as Record<string, unknown>)['__aConfig']).toEqual({})
    expect(registry.getPluginMeta('row-a')).toMatchObject({ name: 'A', source: 'external' })
    expect(loader.listMountedPluginSources()).toContainEqual({ identity: 'row-a', file })
    await loader.unmountExternalPlugin('row-a')
    expect(fake.disposed).toHaveLength(1)
  })

  test('唯一带 apply 的命名导出、模块级 apply 都认；多个候选 / 没有候选都拒绝', async () => {
    const dir = pluginsDir()
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root)

    const named = pluginFile(dir, 'named.js', "export const bp = { name: 'BP', apply() {} }\n")
    expect(await loader.mountExternalPlugin(named, 'named')).toBe(true)

    const moduleLevel = pluginFile(dir, 'module.js', "export function apply() {}\nexport const apiVersion = 3\n")
    expect(await loader.mountExternalPlugin(moduleLevel, 'module')).toBe(true)

    const ambiguous = pluginFile(dir, 'ambiguous.js', 'export const x1 = { apply() {} }\nexport const x2 = { apply() {} }\n')
    expect(await loader.mountExternalPlugin(ambiguous, 'ambiguous')).toBe(false)
    expect(registry.getPluginMeta('ambiguous')?.problem).toContain('找不到插件对象')

    const none = pluginFile(dir, 'none.js', 'export const x = 1\n')
    expect(await loader.mountExternalPlugin(none, 'none')).toBe(false)
    expect(registry.getPluginMeta('none')?.problem).toContain('找不到插件对象')
  })
})

describe('挂载前校验', () => {
  test('apiVersion 高于内核：拒绝挂载、写盘停用、原因带版本号', async () => {
    const dir = pluginsDir()
    const file = pluginFile(dir, 'future.js', 'export const apiVersion = 999\nexport default { apply() {} }\n')
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root)

    expect(await loader.mountExternalPlugin(file, 'future')).toBe(false)
    expect(fake.mounted).toHaveLength(0)
    const problem = registry.getPluginMeta('future')?.problem ?? ''
    expect(problem).toContain('内核 API v999')
    expect(problem).toContain('请升级')
    expect(registry.isPluginEnabled('future')).toBe(false)
  })

  test('没有 apply 的默认导出：认不出插件对象，拒绝并说清三种写法', async () => {
    const dir = pluginsDir()
    const file = pluginFile(dir, 'noapply.js', "export default { name: 'NoApply' }\n")
    loader.initPluginRuntime(fakeRoot().root)
    expect(await loader.mountExternalPlugin(file, 'noapply')).toBe(false)
    expect(registry.getPluginMeta('noapply')?.problem).toContain('找不到插件对象')
  })

  test('inject 里的 dsh 服务名：兼容层关着提示先启用，开着说清对不上；native 行不受影响', async () => {
    const dir = pluginsDir()
    const dshStyle = pluginFile(
      dir,
      'dsh.js',
      "export const inject = ['sessions']\nexport default { name: 'Dsh', apply() {} }\n",
    )
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root)

    registry.writePluginEnabled('dsh-compat', false)
    expect(await loader.mountExternalPlugin(dshStyle, 'dsh')).toBe(false)
    expect(registry.getPluginMeta('dsh')?.problem).toContain('启用「dsh 兼容层」')

    registry.writePluginEnabled('dsh-compat', true)
    expect(await loader.mountExternalPlugin(dshStyle, 'dsh')).toBe(false)
    expect(registry.getPluginMeta('dsh')?.problem).toContain('Pneuma 没有或对不上')

    // native 行（@pneuma/*）不做 dsh 判定，且行上 inject 会盖过模块自带的。
    expect(await loader.mountExternalPlugin(dshStyle, 'native', { native: true, inject: ['presets'] })).toBe(true)
  })

  test('Config schema：返回值替换配置；抛错阻止挂载并给出原文', async () => {
    const dir = pluginsDir()
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root)

    const good = pluginFile(
      dir,
      'cfg.js',
      "export const Config = (raw) => ({ ...raw, extra: true })\nexport default { apply() {} }\n",
    )
    expect(await loader.mountExternalPlugin(good, 'cfg', { config: { a: 1 }, configOrigin: 'host' })).toBe(true)
    expect(fake.applied[0]).toEqual({ a: 1, extra: true })

    const bad = pluginFile(
      dir,
      'badcfg.js',
      "export const Config = () => { throw new Error('缺 field') }\nexport default { apply() {} }\n",
    )
    expect(await loader.mountExternalPlugin(bad, 'badcfg')).toBe(false)
    const problem = registry.getPluginMeta('badcfg')?.problem ?? ''
    expect(problem).toContain('插件配置校验失败')
    expect(problem).toContain('缺 field')
  })

  test('挂载时抛错：meta.problem 记失败并写盘停用', async () => {
    const dir = pluginsDir()
    const file = pluginFile(dir, 'boom.js', "export default { name: 'Boom', apply() {} }\n")
    const fake = fakeRoot(true)
    loader.initPluginRuntime(fake.root)

    expect(await loader.mountExternalPlugin(file, 'boom')).toBe(false)
    expect(registry.getPluginMeta('boom')?.problem).toContain('挂载失败')
    expect(registry.getPluginMeta('boom')?.problem).toContain('服务重名')
    expect(registry.isPluginEnabled('boom')).toBe(false)
  })
})

describe('热启停与目录扫描', () => {
  test('setPluginEnabledHot：关掉卸 fiber 并写盘；再打开重新挂；旧文件名别名也能读到开关', async () => {
    // 热启停按 `~/.dsc/plugins/<名字>` 找文件，所以插件要落在 DSC_PLUGINS_DIR 里。
    const dir = join(HOME, 'plugins')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'hot.js'), "export default { name: 'Hot', apply() {} }\n", 'utf8')
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root)

    expect(await loader.setPluginEnabledHot('hot.js', true)).toEqual({ ok: true })
    expect(fake.mounted).toHaveLength(1)
    expect(registry.isPluginEnabled('hot.js')).toBe(true)

    expect(await loader.setPluginEnabledHot('hot.js', false)).toEqual({ ok: true })
    expect(fake.disposed).toHaveLength(1)
    expect(registry.isPluginEnabled('hot.js')).toBe(false)

    expect(await loader.setPluginEnabledHot('hot.js', true)).toEqual({ ok: true })
    expect(fake.mounted).toHaveLength(2)

    // 找不到文件：给一句指路（检查 ~/.dsc/plugins/）。
    const missing = await loader.setPluginEnabledHot('nope.js', true)
    expect(missing.ok).toBe(false)
    expect(missing.problem).toContain('找不到插件文件')
  })

  test('mountAllExternalPlugins：按开关挂目录里的 .js 与 extraPaths，坏模块进 failures', async () => {
    const dir = pluginsDir()
    pluginFile(dir, 'ok.js', "export default { name: 'Ok', apply() {} }\n")
    pluginFile(dir, 'off.js', "export default { name: 'Off', apply() {} }\n")
    pluginFile(dir, 'bad.js', "export default { name: 'Bad' }\n")
    const extra = pluginFile(dir, 'extra.js', "export default { name: 'Extra', apply() {} }\n")
    registry.writePluginEnabled('off.js', false)

    // 用临时目录顶替 DSC_PLUGINS_DIR：模块里那个常量是 import 时定死的，这里改用 extraPaths
    // 把三个文件都交进去，同时验证「按文件名开关」与 failures 的形状。
    const fake = fakeRoot()
    const failures = await loader.mountAllExternalPlugins(fake.root, [join(dir, 'ok.js'), join(dir, 'off.js'), join(dir, 'bad.js'), extra])
    const names = failures.map((item) => item.file)
    expect(names).toContain('bad.js')
    const mountedNames = fake.mounted.map((item) => String(item.plugin['name']))
    expect(mountedNames).toContain('Ok')
    expect(mountedNames).toContain('Extra')
    expect(mountedNames).not.toContain('Off')
    expect(mountedNames).not.toContain('Bad')
  })

  test('adoptPluginsFromDisk：只挂 only 交进来的新文件；盘上没了就卸；坏文件进 failures', async () => {
    // adopt 只扫模块里定死的 DSC_PLUGINS_DIR，所以先造它（HOME 是临时目录）。
    const dir = join(HOME, 'plugins')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'keep.js'), "export default { name: 'Keep', apply() {} }\n", 'utf8')
    writeFileSync(join(dir, 'new.js'), "export default { name: 'New', apply() {} }\n", 'utf8')
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root)

    const first = await loader.adoptPluginsFromDisk(new Set(['new.js']))
    expect(first.mounted).toEqual(['new.js'])
    expect(first.failures).toEqual([])

    rmSync(join(dir, 'new.js'))
    const second = await loader.adoptPluginsFromDisk()
    expect(second.unmounted).toEqual(['new.js'])

    writeFileSync(join(dir, 'broken.js'), 'export const x = 1\n', 'utf8')
    const third = await loader.adoptPluginsFromDisk(new Set(['broken.js']))
    expect(third.mounted).toEqual([])
    expect(third.failures.map((item) => item.file)).toEqual(['broken.js'])
  })
})

describe('读写 plugins.json 的边界', () => {
  test('坏 plugins.json：挂载失败路径不覆盖用户文件，错误原样抛出', () => {
    writeFileSync(join(HOME, 'plugins.json'), '{bad', 'utf8')
    expect(() => registry.writePluginEnabled('anything', false)).toThrow(/解析不了/)
    // 写盘失败不该被吞：文件内容原样还在。
    expect(readFileSync(join(HOME, 'plugins.json'), 'utf8')).toBe('{bad')
  })
})
