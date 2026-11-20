/**
 * `core/dsh-compat/resolve-hook.ts` 的**进程内**补测（W14）：把注册进来的同步解析钩子
 * 直接调一遍，覆盖 `resolve()` 回调里那批「只在真 ESM 解析时才走得到」的分支。
 *
 * ## 为什么不能只靠 `w13-resolve-hook-spawn.spec.ts`
 *
 * 那份探针起真 `child_process` 让 Node 去 import 假插件，行为本身是对的；但 v8 覆盖率
 * 只统计**本进程**执行的代码，子进程里跑掉的 `resolve()` 在报告里仍然是未覆盖行。
 * 这里把 `registerHooks` 换成一个只记回调的替身（`vi.mock('node:module')`），
 * 然后按真实形状造 `(specifier, context, nextResolve)` 三件套直调 —— 同一段代码在
 * 统计进程内执行，覆盖率才看得见。
 *
 * ## 替身只换 `registerHooks`
 *
 * `resolve-hook.ts` 还从 `node:module` 拿 `createRequire`，用 `importOriginal` 保留原实现；
 * 只把 `registerHooks` 换成记录器。夹具在临时目录里造一套最小「应用根 + 插件根」：
 * 运行时包、真库包、坏库包、非库包、坏清单各一份，分别对应 `librarySpecifierUrl` 的
 * 正常路与三种早退。
 *
 * @module dsc/core/dsh-compat/w14-resolve-hook-inproc.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { createTempDir } from '../../../tests/support/tmp-dir.js'

/** 钩子的三件套签名（只声明被测代码真会用到的字段）。 */
type ResolveHook = (
  specifier: string,
  context: { parentURL?: string; conditions?: readonly string[] },
  nextResolve: (
    specifier: string,
    context?: { parentURL?: string; conditions?: readonly string[] },
  ) => { url: string; shortCircuit?: boolean },
) => { url: string; shortCircuit?: boolean }

/** `registerHooks` 记录下来的回调（模块求值时写入）。 */
const captured: { resolve: ResolveHook | null } = { resolve: null }

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    registerHooks: (hooks: { resolve: ResolveHook }) => {
      captured.resolve = hooks.resolve
    },
  }
})

const { bumpGeneration, ensureResolveHook, setResolveHookAppRoot, setResolveHookCompat } = await import('./resolve-hook.js')

const HOME = createTempDir('dsc-w14-resolve-hook-')

/** 写一个文件（父目录一并建）。 */
function put(rel: string, body: string): string {
  const target = join(HOME, rel)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, body, 'utf8')
  return target
}

/** 目录 → 带尾斜杠的 file: URL（与 `ensureResolveHook` 内部登记的形状一致）。 */
function dirUrl(dir: string): string {
  return `${pathToFileURL(dir).href.replace(/\/+$/, '')}/`
}

const appRoot = join(HOME, 'app')
const pluginRoot = join(HOME, 'plugins')
const outsideDir = join(HOME, 'outside')
const libPackagesDir = join(appRoot, 'lib', 'packages')
const appNodeModules = join(appRoot, 'lib', 'node_modules')

beforeAll(() => {
  // 应用根：package.json + 应用自带的 dsh-tools（兼容层重定向的第二个解析基点）。
  put('app/package.json', JSON.stringify({ name: 'fake-app', version: '1.0.0' }))
  put(
    'app/node_modules/@deepseek-ai/dsh-tools/package.json',
    JSON.stringify({
      name: '@deepseek-ai/dsh-tools',
      version: '9.9.9',
      main: 'index.js',
    }),
  )
  put('app/node_modules/@deepseek-ai/dsh-tools/index.js', "export const marker = 'dshtools-app'\n")
  // 运行时适配包：永远重定向到应用内这一份。
  put('app/lib/node_modules/@pneuma/runtime/services/types.js', "export const marker = 'runtime-app'\n")
  // 真库包（pneuma.library === true）与「声明成库包却没有入口」的坏包。
  put(
    'app/lib/node_modules/@pneuma/libpkg/package.json',
    JSON.stringify({
      name: '@pneuma/libpkg',
      version: '2.0.0',
      pneuma: { library: true },
      main: 'index.js',
    }),
  )
  put('app/lib/node_modules/@pneuma/libpkg/index.js', "export const marker = 'library-app'\n")
  put(
    'app/lib/node_modules/@pneuma/brokenlib/package.json',
    JSON.stringify({
      name: '@pneuma/brokenlib',
      version: '1.0.0',
      pneuma: { library: true },
    }),
  )
  // 不是库包：清单里 pneuma.library 不是 true（走 librarySpecifierUrl 的早退，不重定向）。
  put(
    'app/lib/node_modules/@pneuma/notlib/package.json',
    JSON.stringify({
      name: '@pneuma/notlib',
      version: '1.0.0',
      pneuma: { library: false },
      main: 'index.js',
    }),
  )
  put('app/lib/node_modules/@pneuma/notlib/index.js', "export const marker = 'not-library'\n")
  // 清单坏掉：JSON 解析失败按非库包处理（缺包会响亮失败，不静默改道）。
  put('app/lib/node_modules/@pneuma/badjson/package.json', '{ not json')
  put('app/lib/node_modules/@pneuma/badjson/index.js', "export const marker = 'bad-json'\n")
  // 功能包目录（要打代数戳）与内核目录（永远不打）。
  put('app/lib/packages/feat/index.js', "export const marker = 'feat-app'\nexport const url = import.meta.url\n")
  put('app/lib/core/state.js', "export const marker = 'core-app'\nexport const url = import.meta.url\n")
  mkdirSync(pluginRoot, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  setResolveHookAppRoot(appRoot)
  ensureResolveHook([pluginRoot], appRoot)
})

/** 插件根里的一个父模块 URL（`fromPlugin` 为真）。 */
const pluginParent = `${dirUrl(pluginRoot)}entry.mjs`
/** 插件根之外的父模块 URL（`fromPlugin` 为假；loader 自己 import 绝对 URL 的情形）。 */
const outsideParent = `${dirUrl(outsideDir)}loader.mjs`

/** 取钩子；没注册上直接让用例失败（后面每条都依赖它）。 */
function hook(): ResolveHook {
  if (captured.resolve === null) throw new Error('解析钩子没有被注册：captured.resolve 仍是 null')
  return captured.resolve
}

/** 一个「什么都不改」的默认解析替身：返回给定的 url，并记录被调用参数。 */
function nextReturning(url: string): {
  fn: Parameters<ResolveHook>[2]
  calls: { specifier: string; context?: { parentURL?: string } }[]
} {
  const calls: { specifier: string; context?: { parentURL?: string } }[] = []
  const fn = (specifier: string, context?: { parentURL?: string }) => {
    calls.push({ specifier, ...(context === undefined ? {} : { context }) })
    return { url }
  }
  return { fn, calls }
}

describe('ensureResolveHook 注册的解析回调：运行时分包与库包', () => {
  test('@pneuma/runtime/<子路径>：短路到应用内那一份，不经过默认解析', () => {
    const next = nextReturning('node:ignored')
    const result = hook()('@pneuma/runtime/services/types.js', { parentURL: pluginParent }, next.fn)
    expect(result.shortCircuit).toBe(true)
    expect(result.url).toBe(pathToFileURL(join(appNodeModules, '@pneuma', 'runtime', 'services', 'types.js')).href)
    expect(next.calls).toHaveLength(0)
  })

  test('裸 @pneuma/runtime 没有子路径：不重定向（交回默认解析去报「没有入口」）', () => {
    const next = nextReturning('node:bare')
    const result = hook()('@pneuma/runtime', { parentURL: pluginParent }, next.fn)
    expect(result.url).toBe('node:bare')
    expect(next.calls).toHaveLength(1)
  })

  test('库包按 pinned 解析到应用内那一份；同一目录第二次问命中缓存', () => {
    const next = nextReturning('node:ignored')
    const first = hook()('@pneuma/libpkg', { parentURL: pluginParent }, next.fn)
    expect(first.shortCircuit).toBe(true)
    expect(first.url).toBe(pathToFileURL(join(appNodeModules, '@pneuma', 'libpkg', 'index.js')).href)
    const second = hook()('@pneuma/libpkg', { parentURL: pluginParent }, next.fn)
    expect(second.url).toBe(first.url)
  })

  test('不是库包 / 清单坏了 / 声明成库包却没入口：三条都交回默认解析', () => {
    for (const specifier of ['@pneuma/notlib', '@pneuma/badjson', '@pneuma/brokenlib', '@pneuma/', '@pneuma/unknown-thing']) {
      const next = nextReturning('node:default')
      const result = hook()(specifier, { parentURL: pluginParent }, next.fn)
      expect(result.url, specifier).toBe('node:default')
    }
  })

  test('不是 @pneuma/ 开头的说明符直接放行给默认解析', () => {
    const next = nextReturning('node:builtin')
    expect(hook()('node:fs', { parentURL: pluginParent }, next.fn).url).toBe('node:builtin')
  })
})

describe('兼容层开关：shim 与 @deepseek-ai/* 重定向', () => {
  test('兼容层开着：两个宿主库被换成仓内 shim（短路）', () => {
    setResolveHookCompat(true)
    const next = nextReturning('node:ignored')
    const result = hook()('@deepseek-ai/dsh-home-paths', { parentURL: pluginParent }, next.fn)
    expect(result.shortCircuit).toBe(true)
    expect(result.url).toContain('shims/home-paths')
    expect(next.calls).toHaveLength(0)
  })

  test('兼容层开着：@deepseek-ai/* 先用应用根基点解析，失败再换 dsh-tools 的目录', () => {
    setResolveHookCompat(true)
    const seen: (string | undefined)[] = []
    let calls = 0
    const next = (specifier: string, context?: { parentURL?: string }) => {
      calls += 1
      seen.push(context?.parentURL)
      // 第一个基点（应用根）解析不到；第二个基点（应用自带 dsh-tools 的真实目录）成功。
      if (calls === 1) throw new Error('ERR_MODULE_NOT_FOUND')
      return { url: 'node:resolved-from-tools-dir' }
    }
    const result = hook()('@deepseek-ai/dsh-tools', { parentURL: pluginParent }, next)
    expect(result.url).toBe('node:resolved-from-tools-dir')
    expect(calls).toBe(2)
    expect(seen[0]).toBe(pathToFileURL(join(appRoot, 'package.json')).href)
    expect(String(seen[1])).toContain('dsh-tools')
  })

  test('兼容层开着：所有基点都失败时退回默认解析（context 原样传下去）', () => {
    setResolveHookCompat(true)
    const contexts: unknown[] = []
    const original = {
      parentURL: pluginParent,
      conditions: ['node', 'import'],
    }
    const next = (_specifier: string, context?: unknown) => {
      contexts.push(context)
      if (contexts.length <= 2) throw new Error('ERR_MODULE_NOT_FOUND')
      return { url: 'node:final-default' }
    }
    const result = hook()('@deepseek-ai/dsh-tools', original, next)
    expect(result.url).toBe('node:final-default')
    // 前两次是换基点重试，第三次才是退回原 context。
    expect(contexts).toHaveLength(3)
    expect(contexts[2]).toBe(original)
  })

  test('兼容层关着：shim 与 @deepseek-ai/* 都不改道，走默认解析', () => {
    setResolveHookCompat(false)
    for (const specifier of ['@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-tools']) {
      const next = nextReturning('node:default')
      expect(hook()(specifier, { parentURL: pluginParent }, next.fn).url, specifier).toBe('node:default')
      expect(next.calls).toHaveLength(1)
    }
  })

  test('父模块不在插件根里（loader 的绝对 URL）：即使兼容层开着也走默认解析', () => {
    setResolveHookCompat(true)
    const next = nextReturning('node:outside')
    expect(hook()('@deepseek-ai/dsh-tools', { parentURL: outsideParent }, next.fn).url).toBe('node:outside')
  })
})

describe('代数戳：功能包换 URL、内核与运行时永不打戳', () => {
  test('换代后功能包文件带 ?g=，同一代重复解析结果一致', () => {
    const generation = bumpGeneration()
    const featUrl = pathToFileURL(join(libPackagesDir, 'feat', 'index.js')).href
    const next = nextReturning(featUrl)
    const first = hook()('./feat/index.js', { parentURL: pluginParent }, next.fn)
    const second = hook()('./feat/index.js', { parentURL: pluginParent }, next.fn)
    expect(first.url).toBe(`${featUrl}?g=${String(generation)}`)
    expect(second.url).toBe(first.url)
  })

  test('已经没有 g 的不重复追加', () => {
    bumpGeneration()
    const featUrl = pathToFileURL(join(libPackagesDir, 'feat', 'index.js')).href
    const result = hook()('x', { parentURL: pluginParent }, nextReturning(`${featUrl}?g=99`).fn)
    expect(result.url).toBe(`${featUrl}?g=99`)
  })

  test('非 file: URL（node 内置模块）不加戳', () => {
    bumpGeneration()
    expect(hook()('node:fs', { parentURL: pluginParent }, nextReturning('node:fs').fn).url).toBe('node:fs')
  })

  test('解析结果不是功能包（内核 / 运行时 / 别的 node_modules）不加戳', () => {
    bumpGeneration()
    const cases = [
      pathToFileURL(join(appRoot, 'lib', 'core', 'state.js')).href,
      pathToFileURL(join(appNodeModules, '@pneuma', 'runtime', 'services', 'types.js')).href,
      pathToFileURL(join(appNodeModules, '@pneuma', 'libpkg', 'index.js')).href,
    ]
    for (const url of cases) {
      expect(hook()('x', { parentURL: pluginParent }, nextReturning(url).fn).url, url).toBe(url)
    }
  })

  test('URL 本身畸形（new URL 抛错）：原样返回，不加戳', () => {
    bumpGeneration()
    const result = hook()('x', { parentURL: pluginParent }, nextReturning('file://[::1').fn)
    expect(result.url).toBe('file://[::1')
  })

  test('能被 new URL 解析、但转不成磁盘路径（编码过的斜杠）：原样返回', () => {
    bumpGeneration()
    const weird = 'file:///C:/a%2Fb/index.js'
    const result = hook()('x', { parentURL: pluginParent }, nextReturning(weird).fn)
    expect(result.url).toBe(weird)
  })
})
