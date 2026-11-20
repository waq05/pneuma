/**
 * `core/dsh-compat/resolve-hook.ts` 的解析行为（W13）：用**真 `child_process` 子进程**跑。
 *
 * ## 为什么必须起子进程
 *
 * 被测的是 Node 的 `module.registerHooks` 同步解析钩子：它只在**真 ESM 解析**时被调用。
 * Vitest 的 SSR importer（vite-node）不走 Node 的加载器，测试文件里 import 什么都碰不到
 * 那段 `resolve()`。所以这里写一份 scratch `.mjs`，用 `process.execPath` 起真 node，
 * 让它 import 临时目录里的假插件 —— `registerHooks` 才会真的被问一遍。
 *
 * ## 夹具造什么
 *
 * 一个「应用根」：`lib/packages/<功能包>`（要打代数戳）、`lib/core`（永远不打）、
 * `lib/node_modules/@pneuma/runtime`（永远指向应用内）、`@pneuma/<库包>`（pneuma.library=true）
 * 与 `@deepseek-ai/dsh-tools`（兼容层重定向的基点）；一个「插件根」：里面的入口文件以裸说明符
 * import 上面那些。子进程把每个 import 的结果（模块导出 / import.meta.url / 错误码）打成一行
 * JSON 交给这里断言。
 *
 * 注意：shim 的替换目标是 `./shims/home-paths.js`——仓库里只有 `.ts`，所以子进程里那次 import
 * 必然报「文件不存在」。这里断言的是**走到了 shim 那条短路**（错误里带着文件名），而不是
 * 「shim 能加载」——那要构建产物才成立。
 *
 * @module dsc/core/dsh-compat/w13-resolve-hook-spawn.spec
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/support/tmp-dir.js'

/** 仓库根：vitest 从仓库根跑（自测命令也是这么跑的）。 */
const repoRoot = process.cwd()
const hookFile = join(repoRoot, 'src', 'core', 'dsh-compat', 'resolve-hook.ts')
const HOME = createTempDir('dsc-w13-resolve-hook-')

interface ChildResult {
  status: number | null
  stdout: string
  stderr: string
}

/** 建目录 + 写文件（内容原样）。 */
function put(dir: string, rel: string, body: string): string {
  const target = join(dir, rel)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, body, 'utf8')
  return target
}

/** 造一套应用根 + 插件根的夹具，返回关键路径。 */
function makeFixture(): {
  appRoot: string
  pluginRoot: string
  featMetaUrl: string
  coreUrl: string
  stubUrl: string
  externalRoot: string
  externalUrl: string
} {
  const root = join(HOME, `fixture-${String(Math.random()).slice(2, 8)}`)
  const appRoot = join(root, 'app')
  const pluginRoot = join(root, 'plugins')
  const externalRoot = join(root, 'external-pkg')
  mkdirSync(appRoot, { recursive: true })
  mkdirSync(pluginRoot, { recursive: true })
  mkdirSync(externalRoot, { recursive: true })

  // 应用根：package.json 与两类依赖（兼容层重定向的解析基点）。
  put(appRoot, 'package.json', JSON.stringify({ name: 'fake-app', version: '1.0.0' }))
  put(appRoot, 'node_modules/@deepseek-ai/dsh-tools/package.json', JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '9.9.9', main: 'index.js' }))
  put(appRoot, 'node_modules/@deepseek-ai/dsh-tools/index.js', "export const marker = 'dshtools-app'\n")
  // 运行时适配包：永远重定向到应用内这一份（且永远不代数戳）。
  put(appRoot, 'lib/node_modules/@pneuma/runtime/services/types.js', "export const marker = 'runtime-app'\n")
  // 库包：`pneuma.library === true` 才按 pinned 解析。
  put(
    appRoot,
    'lib/node_modules/@pneuma/libpkg/package.json',
    JSON.stringify({ name: '@pneuma/libpkg', version: '2.0.0', pneuma: { library: true }, main: 'index.js' }),
  )
  put(appRoot, 'lib/node_modules/@pneuma/libpkg/index.js', "export const marker = 'library-app'\n")
  // 声明成库包但没有入口：解析必然失败（走 librarySpecifierUrl 的 catch）。
  put(appRoot, 'lib/node_modules/@pneuma/brokenlib/package.json', JSON.stringify({ name: '@pneuma/brokenlib', version: '1.0.0', pneuma: { library: true } }))
  // 应用自带功能包（要打代数戳）与内核（永远不打）。
  put(appRoot, 'lib/packages/feat/index.js', "export const marker = 'feat-app'\n")
  const featMeta = put(appRoot, 'lib/packages/feat/meta.js', 'export const url = import.meta.url\n')
  const stub = put(appRoot, 'lib/packages/feat/stub.js', "export * from './index.js'\nexport const url = import.meta.url\n")
  const coreFile = put(appRoot, 'lib/core/state.js', "export const marker = 'core-app'\nexport const url = import.meta.url\n")

  // 插件根入口：各种说明符都从插件目录发出，才会走 `fromPlugin` 那条主路。
  put(pluginRoot, 'entry.mjs', [
    "export { marker as runtimeMarker } from '@pneuma/runtime/services/types.js'",
    "export { marker as libraryMarker } from '@pneuma/libpkg'",
    '',
  ].join('\n'))
  put(pluginRoot, 'builtin.mjs', "import { readFileSync } from 'node:fs'\nexport const builtinOk = typeof readFileSync === 'function'\n")
  put(pluginRoot, 'dshtools.mjs', "export { marker as toolsMarker } from '@deepseek-ai/dsh-tools'\n")
  put(pluginRoot, 'shim.mjs', "export { marker as shimMarker } from '@deepseek-ai/dsh-home-paths'\n")
  put(pluginRoot, 'unknown-shim.mjs', "export { marker as otherMarker } from '@deepseek-ai/dsh-unknown-host-lib'\n")

  put(externalRoot, 'thing.js', "export const marker = 'external'\nexport const url = import.meta.url\n")
  return {
    appRoot,
    pluginRoot,
    featMetaUrl: toUrl(featMeta),
    coreUrl: toUrl(coreFile),
    stubUrl: toUrl(stub),
    externalRoot,
    externalUrl: toUrl(join(externalRoot, 'thing.js')),
  }
}

/** 路径 → `file:` URL（Windows 盘符也要转对）。 */
function toUrl(path: string): string {
  return new URL(`file:///${path.replaceAll('\\', '/')}`).href
}

/** 子进程脚本：注册钩子，然后按顺序 import 一串夹具路径。 */
const CHILD_SCRIPT = `
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL(process.env.HOOK_FILE).href)
const appRoot = process.env.APP_ROOT
const pluginRoot = process.env.PLUGIN_ROOT
mod.ensureResolveHook([pluginRoot], appRoot)
mod.setResolveHookCompat(process.env.COMPAT === '1')

const out = {}
const attempt = async (label, specifier) => {
  try {
    const loaded = await import(specifier)
    out[label] = { ok: true, exports: loaded, url: loaded.url }
  } catch (error) {
    out[label] = { ok: false, code: error.code, message: String(error.message).slice(0, 200) }
  }
}

const pluginUrl = pathToFileURL(pluginRoot + '/entry.mjs').href
await attempt('entry', pluginUrl)
await attempt('builtin', pathToFileURL(pluginRoot + '/builtin.mjs').href)
await attempt('dshtools', pathToFileURL(pluginRoot + '/dshtools.mjs').href)
await attempt('shim', pathToFileURL(pluginRoot + '/shim.mjs').href)
await attempt('unknownShim', pathToFileURL(pluginRoot + '/unknown-shim.mjs').href)

// 代数戳：0 代不加；换代之后功能包带 ?g=，内核与运行时包不带。
const featMeta = process.env.FEAT_META_URL
out.gen0 = (await import(featMeta)).url
out.bump1 = mod.bumpGeneration()
out.gen1 = (await import(featMeta)).url
out.gen1Again = (await import(featMeta)).url
out.bump2 = mod.bumpGeneration()
out.gen2 = (await import(featMeta)).url
// 已经带 g 的 URL 不重复追加（同一 URL 被多层解析时结果稳定）。
out.existing = (await import(featMeta + '?g=99')).url
// 内核文件永远不打戳（多一份 core 会让模块级注册表落空）。
out.core = (await import(process.env.CORE_URL)).url
// 运行时包也不打戳（与 @pneuma/runtime 重定向的两条规矩一致）。
out.runtimeFile = (await import(pathToFileURL(appRoot + '/lib/node_modules/@pneuma/runtime/services/types.js').href)).url
// loader 自己 import 再导出桩（绝对文件 URL，parent 不在插件根）：也要打戳。
out.stub = (await import(process.env.STUB_URL)).url
// 登记过的外部包目录：里面的文件也算功能包一族。
mod.registerGenerationRoot(process.env.EXTERNAL_ROOT)
mod.registerGenerationRoot(appRoot + '/lib/core')
mod.registerGenerationRoot(appRoot + '/lib/node_modules/@pneuma/runtime')
out.external = (await import(process.env.EXTERNAL_URL)).url

// 裸说明符该失败的几条：运行时包没有 . 入口、未知库包、坏库包。
await attempt('bareRuntime', '@pneuma/runtime')
await attempt('unknownLibrary', '@pneuma/unknown-thing')
await attempt('brokenLibrary', '@pneuma/brokenlib')

console.log('@@DSH_RESULT@@' + JSON.stringify(out))
`

/** 起一次子进程并解析它打出来的结果行。 */
function runChild(fixture: ReturnType<typeof makeFixture>, compat: boolean): { result: Record<string, unknown>; child: ChildResult } {
  const script = join(HOME, `child-${compat ? 'on' : 'off'}.mjs`)
  writeFileSync(script, CHILD_SCRIPT, 'utf8')
  const child = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOOK_FILE: hookFile,
      APP_ROOT: fixture.appRoot,
      PLUGIN_ROOT: fixture.pluginRoot,
      COMPAT: compat ? '1' : '0',
      FEAT_META_URL: fixture.featMetaUrl,
      CORE_URL: fixture.coreUrl,
      STUB_URL: fixture.stubUrl,
      EXTERNAL_ROOT: fixture.externalRoot,
      EXTERNAL_URL: fixture.externalUrl,
    },
  })
  const line = child.stdout.split('\n').find((item) => item.startsWith('@@DSH_RESULT@@'))
  const result = line === undefined ? {} : (JSON.parse(line.slice('@@DSH_RESULT@@'.length)) as Record<string, unknown>)
  return { result, child: { status: child.status, stdout: child.stdout, stderr: child.stderr } }
}

interface Attempt {
  ok: boolean
  code?: string
  message?: string
  exports?: Record<string, unknown>
  url?: string
}

/** 取一条 import 结果（统一断言形状）。 */
function attemptOf(result: Record<string, unknown>, label: string): Attempt {
  return result[label] as Attempt
}

describe('真子进程里的解析钩子（兼容层开着）', () => {
  let result: Record<string, unknown> = {}
  let child: ChildResult = { status: null, stdout: '', stderr: '' }

  beforeAll(() => {
    expect(existsSync(hookFile)).toBe(true)
    const fixture = makeFixture()
    const run = runChild(fixture, true)
    result = run.result
    child = run.child
  }, 90_000)

  test('子进程正常退出并打出了结果行（钩子注册没有砸掉进程）', () => {
    expect(child.status, child.stderr.slice(0, 400)).toBe(0)
    expect(Object.keys(result).length).toBeGreaterThan(5)
  })

  test('插件里 import @pneuma/runtime/<子路径>：指向应用内那一份', () => {
    const entry = attemptOf(result, 'entry')
    expect(entry.ok).toBe(true)
    expect(entry.exports?.['runtimeMarker']).toBe('runtime-app')
  })

  test('插件里 import @pneuma/<库包>：按 pinned 解析到应用内那一份', () => {
    expect(attemptOf(result, 'entry').exports?.['libraryMarker']).toBe('library-app')
  })

  test('插件里 import node 内置模块：解析结果原样放行（file: 之外的 URL 不加戳）', () => {
    expect(attemptOf(result, 'builtin').exports?.['builtinOk']).toBe(true)
  })

  test('兼容层开着：@deepseek-ai/* 从应用根重新解析（命中应用那份 dsh-tools）', () => {
    const tools = attemptOf(result, 'dshtools')
    expect(tools.ok).toBe(true)
    expect(tools.exports?.['toolsMarker']).toBe('dshtools-app')
  })

  test('兼容层开着：两个宿主库被换成 shim（走到短路；仓里只有 .ts 所以加载报缺文件）', () => {
    const shim = attemptOf(result, 'shim')
    expect(shim.ok).toBe(false)
    expect(`${shim.code ?? ''}${shim.message ?? ''}`).toContain('home-paths')
  })

  test('不在 SHIMS 表里的 @deepseek-ai/* 仍按应用根解析（解析不到就响亮失败）', () => {
    const unknown = attemptOf(result, 'unknownShim')
    expect(unknown.ok).toBe(false)
    expect(String(unknown.code ?? '')).toMatch(/ERR_MODULE_NOT_FOUND/)
  })

  test('0 代：功能包解析结果不带代数戳（启动态单实例约定）', () => {
    expect(String(result['gen0'])).not.toContain('g=')
    expect(String(result['gen0'])).toContain('/lib/packages/feat/meta.js')
  })

  test('换代之后：功能包带 ?g=<代数>，同一代内重复解析结果一致', () => {
    expect(result['bump1']).toBe(1)
    expect(String(result['gen1'])).toContain('g=1')
    expect(result['gen1Again']).toBe(result['gen1'])
    expect(result['bump2']).toBe(2)
    expect(String(result['gen2'])).toContain('g=2')
  })

  test('已经带 g 的 URL 不重复追加', () => {
    const existing = String(result['existing'])
    expect(existing).toContain('g=99')
    expect(existing.match(/g=/g)?.length).toBe(1)
  })

  test('内核文件与运行时包永远不加代数戳', () => {
    expect(String(result['core'])).not.toContain('g=')
    expect(String(result['core'])).toContain('/lib/core/state.js')
    expect(String(result['runtimeFile'])).not.toContain('g=')
  })

  test('loader 的绝对文件 URL（parent 不在插件根）也照样打戳', () => {
    expect(String(result['stub'])).toContain('/lib/packages/feat/stub.js')
    expect(String(result['stub'])).toContain('g=2')
  })

  test('登记过的外部包目录算功能包；内核与运行时目录登记了也白登记', () => {
    expect(String(result['external'])).toContain('g=2')
    // 内核那条：登记被过滤掉，所以 core 仍不带戳（上一条已断言；这里再钉一次语义）。
    expect(String(result['core'])).not.toContain('g=')
  })

  test('裸 @pneuma/runtime 没有 . 入口：该失败就失败', () => {
    const bare = attemptOf(result, 'bareRuntime')
    expect(bare.ok).toBe(false)
  })

  test('未知库包 / 声明成库包但没有入口：解析失败交回默认解析', () => {
    expect(attemptOf(result, 'unknownLibrary').ok).toBe(false)
    expect(attemptOf(result, 'brokenLibrary').ok).toBe(false)
  })
})

describe('兼容层关着时：只有运行时重定向仍然生效', () => {
  let result: Record<string, unknown> = {}
  let child: ChildResult = { status: null, stdout: '', stderr: '' }

  beforeAll(() => {
    const fixture = makeFixture()
    const run = runChild(fixture, false)
    result = run.result
    child = run.child
  }, 90_000)

  test('子进程正常退出', () => {
    expect(child.status, child.stderr.slice(0, 400)).toBe(0)
  })

  test('@pneuma/runtime 仍然指向应用内（单实例保证与兼容层开关无关）', () => {
    const entry = attemptOf(result, 'entry')
    expect(entry.ok).toBe(true)
    expect(entry.exports?.['runtimeMarker']).toBe('runtime-app')
  })

  test('@deepseek-ai/* 不再重定向：dsh-tools 从插件目录解析不到就失败', () => {
    expect(attemptOf(result, 'dshtools').ok).toBe(false)
  })

  test('shim 替换也随兼容层关闭', () => {
    const shim = attemptOf(result, 'shim')
    expect(shim.ok).toBe(false)
    // 关着兼容层时走的是默认解析：找不到这个包，不会命中 shim 的缺文件。
    expect(`${shim.code ?? ''}${shim.message ?? ''}`).toMatch(/ERR_MODULE_NOT_FOUND|Cannot find/)
  })
})
