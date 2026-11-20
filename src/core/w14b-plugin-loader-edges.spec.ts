/**
 * `core/plugin-loader.ts` 的缺口补齐：模块级字段回落（默认导出把同名字段写成空值那一支）、
 * 单行热重挂的返回值、dsh 兼容 ctx 的透传、热更轮询起不来、profile 目录不存在的归属判断、
 * 应用自带行的包名解析失败链（Node 解析失败 → 猜入口 → exports 认不出）与 stat 失败。
 *
 * 夹具照 `plugin-loader-extra.spec.ts`：临时 DSC_HOME + 真假插件文件 + 假 cordis root。
 * `plugin-watch` 被替换成「导入就抛」，用来走热更启动的兜底；`node:fs.statSync` 只对
 * 一个点名的路径抛错（模拟 stat 失败），其余原样透传。
 *
 * @module dsc/core/w14b-plugin-loader-edges.spec
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

/** statSync 要抛错的路径（模拟「文件在那但 stat 不了」）。 */
const trap = vi.hoisted(() => ({ path: '' }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (...args: unknown[]) => {
      const path = String(args[0] ?? '')
      if (trap.path !== '' && path === trap.path) throw Object.assign(new Error('stat 失败'), { code: 'EPERM' })
      return (actual.statSync as unknown as (...args: unknown[]) => unknown)(...args)
    },
  }
})

vi.mock('./plugin-watch.js', () => ({
  startPluginWatch: () => {
    throw new Error('热更轮询起不来')
  },
  stopPluginWatch: () => {},
}))

const HOME = mkdtempSync(join(tmpdir(), 'dsc-w14b-loader-'))
const WORK = join(HOME, 'work')
mkdirSync(WORK, { recursive: true })
process.env['DSC_HOME'] = HOME
process.env['DSC_HOT'] = '1'

type Loader = typeof import('./plugin-loader.js')
type Registry = typeof import('./plugin-registry.js')
let loader: Loader
let registry: Registry

beforeAll(async () => {
  registry = await import('./plugin-registry.js')
  loader = await import('./plugin-loader.js')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  delete process.env['DSC_HOT']
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5 })
})

beforeEach(() => {
  writeFileSync(join(HOME, 'plugins.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8')
  trap.path = ''
})

/** 假 cordis root：记录挂载、apply 真跑、带一条 transcript。 */
function fakeRoot() {
  const mounted: Array<{ plugin: Record<string, unknown>; config: unknown }> = []
  const transcript: string[] = []
  const ctx = { get: () => undefined, tools: { register: () => () => {} } }
  const root = {
    plugin(plugin: Record<string, unknown>, config: unknown) {
      mounted.push({ plugin, config })
      ;(plugin['apply'] as (innerCtx: unknown, config: unknown) => void)(ctx, config)
      const fiber = Promise.resolve() as Promise<void> & { dispose: () => Promise<void> }
      fiber.dispose = async () => {}
      return fiber
    },
    get: (name: string) => (name === 'transcript' ? root.transcript : undefined),
    transcript: { system: (text: string) => transcript.push(text) },
    emit: () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  return { root, mounted, transcript }
}

/** 一个插件目录。 */
let serial = 0
function pluginDir(): string {
  serial += 1
  const dir = join(WORK, `plugins-${String(serial)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 写一个插件文件。 */
function pluginFile(dir: string, name: string, code: string): string {
  const file = join(dir, name)
  writeFileSync(file, code, 'utf8')
  return file
}

/** 写文件（父目录一次建好）。 */
function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}

/** 造一个应用安装目录：base 包（patch）+ 若干 lib/node_modules 下的包。 */
function makeApp(
  patch: string,
  packages: Array<{ name: string; manifest?: Record<string, unknown> | string; files?: Record<string, string> }>,
): string {
  serial += 1
  const appDir = join(WORK, `app-${String(serial)}`)
  for (const item of packages) {
    const dir = join(appDir, 'lib', 'node_modules', ...item.name.split('/'))
    writeText(
      join(dir, 'package.json'),
      typeof item.manifest === 'string'
        ? item.manifest
        : JSON.stringify({ name: item.name, version: '1.0.0', ...(item.manifest ?? {}) }),
    )
    for (const [rel, body] of Object.entries(item.files ?? {})) writeText(join(dir, rel), body)
  }
  writeText(
    join(appDir, 'lib', 'node_modules', '@pneuma', 'base', 'package.json'),
    JSON.stringify({ name: '@pneuma/base', version: '1.0.0' }),
  )
  writeText(join(appDir, 'lib', 'node_modules', '@pneuma', 'base', 'cordis.patch.yml'), patch)
  return appDir
}

/** 一行 insert；不给 name = 缺 name 的行。 */
function row(id: string, name?: string, extra = ''): string {
  return `    - id: ${id}\n${name === undefined ? '' : `      name: '${name}'\n`}${extra}`
}

/** insert 行拼成一份 patch。 */
function patchOf(rows: string[]): string {
  return rows.length === 0 ? '- insert: []\n' : `- insert:\n${rows.join('')}`
}

describe('模块级字段回落：默认导出把同名字段写成空值', () => {
  test('空 name / 空 description / undefined apiVersion 时取模块级导出', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const file = pluginFile(
      pluginDir(),
      'meta-empty.js',
      [
        "export default { name: '', description: '', apiVersion: undefined, apply() {} }",
        "export const name = '模块名'",
        "export const description = '模块描述'",
        'export const apiVersion = 1',
        '',
      ].join('\n'),
    )
    expect(await loader.mountExternalPlugin(file, 'meta-empty-row')).toBe(true)
    expect(registry.getPluginMeta('meta-empty-row')).toMatchObject({
      name: '模块名',
      description: '模块描述',
      apiVersion: 1,
    })
  })
})

describe('remountExternalPlugin：单行入口的返回值', () => {
  test('未挂载的行：给一条失败结果，不抛', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const result = await loader.remountExternalPlugin('ghost-row')
    expect(result.ok).toBe(false)
    expect(result.problem).toContain('没有挂载')
  })
})

describe('dsh 兼容 ctx：非 tools / get 的属性透传', () => {
  test('插件在 apply 里读 ctx.logger 走 Proxy 的 Reflect.get', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    registry.writePluginEnabled('dsh-compat', true)
    const file = pluginFile(
      pluginDir(),
      'compat-get.js',
      [
        'export default {',
        "  name: 'CompatGet',",
        '  apply(ctx) {',
        '    globalThis.__w14bSeen = ctx.logger',
        '  },',
        '}',
        '',
      ].join('\n'),
    )
    expect(await loader.mountExternalPlugin(file, 'compat-get-row')).toBe(true)
    const seen = (globalThis as Record<string, unknown>)['__w14bSeen']
    // 假 ctx 上没有 logger：透传拿到的就是 undefined，但这一行必须走 proxy 的 Reflect.get。
    expect(seen).toBeUndefined()
    delete (globalThis as Record<string, unknown>)['__w14bSeen']
    registry.writePluginEnabled('dsh-compat', false)
  })
})

describe('启动热更轮询失败', () => {
  test('plugin-watch 导入就抛：写一条 transcript，不影响装配', async () => {
    const fake = fakeRoot()
    const app = makeApp(patchOf([]), [])
    const failures = await loader.mountApplicationRows(fake.root as never, { appDir: app, surface: 'none' })
    expect(failures).toEqual([])
    expect(fake.transcript.join(' | ')).toContain('功能包热更没起来')
  })
})

describe('profile 目录不存在时的归属判断', () => {
  test('fileUnderProfile 里 physicalDir 解不开：回落 resolve，不抛', async () => {
    const fake = fakeRoot()
    loader.initPluginRuntime(fake.root as never)
    const file = pluginFile(pluginDir(), 'owned.js', "export default { name: 'Owned', apply() {} }\n")
    expect(await loader.mountExternalPlugin(file, 'owned-row')).toBe(true)
    const result = await loader.reconcileProfileBundles(fake.root as never, join(WORK, 'no-such-profile'))
    expect(result.failures).toEqual([])
  })
})

describe('应用自带行的包名解析失败链', () => {
  test('包 exports 把根入口挡住：Node 解析失败后猜入口（index.js）', async () => {
    const fake = fakeRoot()
    const app = makeApp(patchOf([row('hidden-entry-row', 'hidden-entry')]), [
      {
        name: 'hidden-entry',
        manifest: { exports: { './other': './other.js' } },
        files: { 'other.js': 'export {}\n', 'index.js': "export default { name: 'Hidden', apply() {} }\n" },
      },
    ])
    const failures = await loader.mountApplicationRows(fake.root as never, { appDir: app, surface: 'none' })
    expect(failures).toEqual([])
    expect(registry.getPluginMeta('hidden-entry-row')?.name).toBe('Hidden')
  })

  test('exports 认不出、也没有入口：这一行判缺包', async () => {
    const fake = fakeRoot()
    const app = makeApp(patchOf([row('no-entry-row', 'no-entry-pkg')]), [
      { name: 'no-entry-pkg', manifest: { exports: { './other': './other.js' } }, files: { 'other.js': 'export {}\n' } },
    ])
    const failures = await loader.mountApplicationRows(fake.root as never, { appDir: app, surface: 'none' })
    expect(failures.map((item) => item.file)).toEqual(['no-entry-row'])
    expect(fake.transcript.join(' | ')).toContain('找不到对应文件')
  })

  test('入口文件 stat 失败：按「找不到入口」处理', async () => {
    const fake = fakeRoot()
    const dir = pluginDir()
    const file = pluginFile(dir, 'trap-plugin.js', "export default { name: 'Trap', apply() {} }\n")
    trap.path = file
    const app = makeApp(patchOf([row('trap-row', file)]), [])
    const failures = await loader.mountApplicationRows(fake.root as never, { appDir: app, surface: 'none' })
    expect(failures.map((item) => item.file)).toEqual(['trap-row'])
  })
})
