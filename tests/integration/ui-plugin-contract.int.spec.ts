/**
 * 界面插件体系的**契约面**：真实构建产物、分包落点、平台种子表、槽位契约与设置回执
 * （迁自 `scripts/ui-plugin-test.mjs` 的 [5][5b][5c][5d][9] 五段）。
 *
 * ## 这一份和其它几份的分工
 *
 * `ui-plugin-slots` / `ui-plugin-manifest` / `ui-plugin-serve` 钉的是**运行期**；这一份钉
 * **构建期契约**——逻辑分包没有 workspace 的依赖图兜底，最容易「改了一半、两处漂移」：
 *
 * - [5] 真实构建产物（`lib/ui/`）：清单可读、bundle 的工厂壳、不内联 React 与基元、
 *   壳页面挂了入口脚本。壳没构建时整段 skip（探针同款 SKIP）。
 * - [5b] 分包落点：`ui-shell/packages.json` ↔ tsconfig paths ↔ 包目录两两一致；
 *   六个逻辑包的单向依赖（import 说明符走查）；别名落点必须正好是包内 `ui/index.ts`。
 * - [5c] 槽位契约表：SLOT 常量与 SlotMap 声明的键集一致；产物里找得到全部壳槽名。
 * - [5d] 种子表 ↔ 壳实现：platform-modules.json 每一项都挂在 boot.ts 的 MODULES 上、
 *   真实导出非空、构建期读同一份 JSON。
 * - [9] 设置回执的结构化载荷：契约里 `SettingsMutationOk.data` 的每一种 kind，壳的
 *   设置插件源码里都必须有**正向**出口；配对码交给弹窗；产物里也带着（改完壳要重建）。
 *
 * ## 为什么允许读源码文本
 *
 * 这一份的对象是「跨文件的结构一致性」（两份手抄的表、一条 import 边、一处契约联合），
 * 被测的正是源码的形状本身——没有可以调用的行为接缝；换成行为断言等于重写一遍构建器。
 * 断言全部走**结构判定**（import 说明符、键集合、正负向分派），不钉整段字面量。
 *
 * ## 产物段的门
 *
 * [5][5c][9-产物] 读 `lib/ui/**`，壳没构建时跳过（探针同款），缺口由构建流程保证。
 *
 * @module dsc/tests/integration/ui-plugin-contract
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { collectUiPluginArtifacts, readUiPluginBundle } from '@pneuma/runtime/core/ui-bundles.js'

/** 仓库根（本文件在 tests/integration/ 下）。 */
const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UI_SHELL = join(REPO_ROOT, 'ui-shell')
/**
 * 界面壳产物目录（显式拼，不用 `uiPluginsDir()` 的缺省值）。
 *
 * 为什么：那个缺省值按**模块自身位置**解析——探针从 `lib/core/ui-bundles.js` 导入，
 * 算出来是 `lib/ui/plugins`；spec 从 src 导入，同一个函数算出的是 `src/ui/plugins`，
 * 那里永远没有产物。spec 在这里测的是**构建产物契约**，目录本来就写死在 `lib/ui/`。
 */
const UI_PLUGINS = join(REPO_ROOT, 'lib', 'ui', 'plugins')

/** 契约源码全文：入口 `src/contract.ts` 加上 `src/contract/` 按域拆开的每一份。 */
function readContractSource(): string {
  const barrel = readFileSync(join(REPO_ROOT, 'src', 'contract.ts'), 'utf8')
  const dir = join(REPO_ROOT, 'src', 'contract')
  const parts = [barrel]
  for (const file of readdirSync(dir).sort()) {
    if (file.endsWith('.ts')) parts.push(readFileSync(join(dir, file), 'utf8'))
  }
  return parts.join('\n')
}

/** 一个界面单元的源码目录：先新根后旧根（与 `scripts/_check-runner.mjs` 同口径）。 */
function resolveUiHalfDir(id: string): string {
  const candidates = [`src/packages/${id}/ui`, `src/packages/ui-${id}/ui`]
  for (const rel of candidates) {
    const abs = join(REPO_ROOT, rel)
    if (existsSync(abs)) return abs
  }
  throw new Error(`找不到界面单元 ${id} 的源码目录（试过 ${candidates.join('、')}）`)
}

/** 界面壳有没有构建（产物段共用的门）。 */
const SHELL_BUILT = existsSync(join(UI_PLUGINS, 'manifest.json'))

/**
 * 去掉 JSONC 的注释再 parse：`ui-shell/tsconfig.json` 带行注释（tsconfig 的标准写法），
 * `JSON.parse` 直接抛。只处理字符串外的行注释与块注释，不动其它内容。
 */
function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (inString) {
      out += char
      if (char === '\\') {
        out += text[index + 1] ?? ''
        index += 1
      } else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 1
      continue
    }
    out += char
  }
  return JSON.parse(out)
}

// ── [5] 真实构建产物 ───────────────────────────────────────────────────────────
describe.skipIf(!SHELL_BUILT)('真实构建产物（lib/ui）', () => {
  const collected = collectUiPluginArtifacts(UI_PLUGINS)
  const bundles = collected.entries.map((entry) => ({
    id: entry.id,
    text: (readUiPluginBundle(entry.id, entry.file, UI_PLUGINS) ?? Buffer.alloc(0)).toString('utf8'),
  }))

  test('产物里有界面插件', () => {
    expect(collected.entries.length, JSON.stringify(collected.entries.map((entry) => entry.id))).toBeGreaterThan(0)
  })

  test('产物没有缺文件的问题', () => {
    expect(collected.problems, collected.problems.join(' | ')).toEqual([])
  })

  test('每个内置条目都带 api（来自各自 package.json 的 @dsc/ui 区间）', () => {
    const missingApi = collected.entries.filter((entry) => typeof entry.api !== 'string' || entry.api === '')
    expect(missingApi.map((entry) => [entry.id, entry.api]), JSON.stringify(missingApi)).toEqual([])
  })

  test('每个 bundle 都注册进全局工厂表', () => {
    const bad = bundles.filter((bundle) => !bundle.text.startsWith('(globalThis.__DSC_UI_FACTORIES__'))
    expect(bad.map((bundle) => bundle.id), bad.map((bundle) => bundle.id).join(',')).toEqual([])
  })

  test('工厂签名是受控的 require/module/exports', () => {
    expect(bundles.every((bundle) => bundle.text.includes('function (require, module, exports) {'))).toBe(true)
  })

  test('用 React 的 bundle 走 require 而不是内联', () => {
    const reactUser = bundles.find((bundle) => bundle.text.includes('useState')) ?? bundles[0]
    expect(reactUser?.text.includes('require("react")'), reactUser?.id).toBe(true)
  })

  test('没有 bundle 内联 React 实现（那会让 hooks 崩）', () => {
    expect(bundles.every((bundle) => !bundle.text.includes('__SECRET_INTERNALS') && !bundle.text.includes('Minified React error'))).toBe(true)
  })

  test('插件 bundle 引用壳的插件 API', () => {
    expect(bundles.every((bundle) => bundle.text.includes('require("@dsc/ui")'))).toBe(true)
  })

  test('插件 bundle 是工厂形状（导出 apply）', () => {
    expect(bundles.every((bundle) => bundle.text.includes('apply'))).toBe(true)
  })

  test('没有 bundle 内联基元实现（Select / 图标 / completion-sound）', () => {
    const inlined = bundles
      .filter(
        (bundle) =>
          bundle.text.includes('function Select(props)') ||
          bundle.text.includes('function base(path') ||
          bundle.text.includes('function sized(size)') ||
          bundle.text.includes('reverbImpulse'),
      )
      .map((bundle) => bundle.id)
    expect(inlined, inlined.join(',')).toEqual([])
  })

  test('改用种子的五份 bundle 都 require("@dsc/ui-primitives")', () => {
    const seedUsers = ['settings', 'plugins', 'terminal', 'trace', 'transcript']
    const missing = seedUsers.filter((id) => {
      const bundle = bundles.find((candidate) => candidate.id === id)
      return bundle === undefined || !bundle.text.includes('require("@dsc/ui-primitives")')
    })
    expect(missing, missing.join(',')).toEqual([])
  })

  test('宿主侧能读到界面壳的静态页，壳页面挂了入口脚本', () => {
    const shellPage = join(UI_PLUGINS, '..', 'assets', 'index.html')
    expect(existsSync(shellPage)).toBe(true)
    expect(readFileSync(shellPage, 'utf8')).toContain('app-')
  })
})

// ── [5b] 分包落点（packages.json ↔ tsconfig paths ↔ 包目录） ────────────────────
describe('分包落点（packages.json ↔ tsconfig paths）', () => {
  const packages = JSON.parse(readFileSync(join(UI_SHELL, 'packages.json'), 'utf8')) as Record<string, string>
  const shellPackage = JSON.parse(readFileSync(join(UI_SHELL, 'package.json'), 'utf8')) as { version: string }
  const tsconfig = parseJsonc(readFileSync(join(UI_SHELL, 'tsconfig.json'), 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> }
  }
  const paths = tsconfig.compilerOptions?.paths ?? {}
  const names = Object.keys(packages)
  const resolved = Object.fromEntries(names.map((name) => [name, resolvePath(UI_SHELL, packages[name] ?? '')]))

  test('packages.json 登记了插件 API 与共享核心两个包名', () => {
    expect(names.includes('@dsc/ui') && names.includes('@dsc/ui-core'), names.join(',')).toBe(true)
  })

  test('packages.json 的每个落点都在盘上', () => {
    const missing = names.filter((name) => !existsSync(resolved[name] ?? ''))
    expect(missing.join(','), missing.join(',')).toBe('')
  })

  test('tsconfig paths 与 packages.json 键集一致', () => {
    const tsNames = Object.keys(paths)
    const missingInTs = names.filter((name) => !tsNames.includes(name))
    const extraInTs = tsNames.filter((name) => !names.includes(name))
    expect(
      `tsconfig 缺：${missingInTs.join('、')}；tsconfig 多：${extraInTs.join('、')}`,
      `tsconfig 缺：${missingInTs.join('、') || '(无)'}；tsconfig 多：${extraInTs.join('、') || '(无)'}`,
    ).toBe('tsconfig 缺：；tsconfig 多：')
  })

  test('同一包名的落点在两处指向同一个文件', () => {
    const mismatched = names.filter(
      (name) => paths[name] !== undefined && resolvePath(UI_SHELL, paths[name]?.[0] ?? '') !== resolved[name],
    )
    expect(
      mismatched.map((name) => `${name}: tsconfig=${JSON.stringify(paths[name])} packages=${packages[name]}`).join(' | '),
    ).toBe('')
  })

  test('src/packages/ui-core/package.json 就是 @pneuma/ui-core 的包身份', () => {
    const corePackage = JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'packages', 'ui-core', 'package.json'), 'utf8')) as {
      name: string
      version: string
    }
    expect(corePackage.name).toBe('@pneuma/ui-core')
    expect(resolvePath(UI_SHELL, packages['@dsc/ui-core'] ?? '')).toBe(join(REPO_ROOT, 'src', 'packages', 'ui-core', 'index.ts'))
    expect(corePackage.version === shellPackage.version, `${corePackage.version} ≠ ${shellPackage.version}`).toBe(true)
  })

  test('两个构建消费方必须真接在 packages.json 上（不是各写一份 alias）', () => {
    expect(readFileSync(join(UI_SHELL, 'vite.config.ts'), 'utf8')).toContain('packages.json')
    expect(readFileSync(join(UI_SHELL, 'build-plugins.mjs'), 'utf8')).toContain('packages.json')
  })

  test('@dsc/ui-core 不在平台模块表里（故意不给插件）', () => {
    const platformModules = JSON.parse(
      readFileSync(join(REPO_ROOT, 'src', 'packages', 'ui-boot', 'ui', 'platform-modules.json'), 'utf8'),
    ) as string[]
    expect(platformModules.includes('@dsc/ui-core'), platformModules.join(',')).toBe(false)
  })

  test('@dsc/ui-runtime 在平台模块表里、@dsc/ui-layout 不在', () => {
    const platformModules = JSON.parse(
      readFileSync(join(REPO_ROOT, 'src', 'packages', 'ui-boot', 'ui', 'platform-modules.json'), 'utf8'),
    ) as string[]
    expect(platformModules.includes('@dsc/ui-runtime')).toBe(true)
    expect(platformModules.includes('@dsc/ui-layout')).toBe(false)
  })
})

// ── [5b] 包内分层：六个逻辑包的单向依赖 ────────────────────────────────────────
describe('包内分层：六个逻辑包的单向依赖', () => {
  /** 每包的 ui/ 目录（别名落点与声明入口）。 */
  const layerDirs: Record<string, string> = {
    '@dsc/ui-primitives': join(REPO_ROOT, 'src', 'packages', 'ui-primitives', 'ui'),
    '@dsc/ui-slots': join(REPO_ROOT, 'src', 'packages', 'ui-slots', 'ui'),
    '@dsc/ui-dockkit': join(REPO_ROOT, 'src', 'packages', 'ui-dockkit', 'ui'),
    '@dsc/ui-runtime': join(REPO_ROOT, 'src', 'packages', 'ui-runtime', 'ui'),
    '@dsc/ui-layout': join(REPO_ROOT, 'src', 'packages', 'ui-layout', 'ui'),
    '@dsc/ui-renderer': join(REPO_ROOT, 'src', 'packages', 'ui-renderer', 'ui'),
  }
  /** 每包不许出现的包名（往上走的那些）。 */
  const forbiddenUpward: Record<string, string[]> = {
    '@dsc/ui-primitives': ['@dsc/ui-dockkit', '@dsc/ui-slots', '@dsc/ui-runtime', '@dsc/ui-layout', '@dsc/ui-renderer'],
    '@dsc/ui-slots': ['@dsc/ui-dockkit', '@dsc/ui-runtime', '@dsc/ui-layout', '@dsc/ui-renderer'],
    '@dsc/ui-dockkit': ['@dsc/ui-slots', '@dsc/ui-runtime', '@dsc/ui-layout', '@dsc/ui-renderer'],
    '@dsc/ui-runtime': ['@dsc/ui-layout', '@dsc/ui-renderer'],
    '@dsc/ui-layout': ['@dsc/ui-renderer'],
    '@dsc/ui-renderer': [],
  }
  const layerNames = Object.keys(layerDirs)

  /**
   * 递归列 .ts/.tsx 源文件。
   *
   * 为什么排除 `*.spec.ts(x)`：这条走查钉的是「会被编进 bundle 的运行期源码」——测试文件
   * 不进产物，它们 import 内核模块（`../../../core/...`）是合法的。探针年代 ui/ 下还没有
   * spec 文件，P3 之后各包的 ui/ 里会持续出现，不排除的话每加一条测试这条就假红一次。
   */
  function sourceFilesOf(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) sourceFilesOf(file, out)
      else if (/\.spec\.tsx?$/.test(entry.name)) continue
      else if (/\.tsx?$/.test(entry.name)) out.push(file)
    }
    return out
  }

  /** 剔注释后收 import 说明符（探针同款三种形态）。 */
  function importsOf(text: string): string[] {
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    const specs = new Set<string>()
    for (const m of clean.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1] ?? '')
    for (const m of clean.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) specs.add(m[1] ?? '')
    for (const m of clean.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.add(m[1] ?? '')
    return [...specs].filter((spec) => spec !== '')
  }

  test('每个 @dsc/ui-* 别名都落在对应包的 ui/index.ts', () => {
    const packages = JSON.parse(readFileSync(join(UI_SHELL, 'packages.json'), 'utf8')) as Record<string, string>
    const drifted = layerNames.filter(
      (name) => resolvePath(UI_SHELL, packages[name] ?? '') !== join(layerDirs[name] ?? '', 'index.ts'),
    )
    expect(drifted.map((name) => `${name}: ${packages[name]}`).join('；'), drifted.join('；')).toBe('')
  })

  test('六个逻辑包的入口都在盘上', () => {
    const missing = layerNames.filter((name) => !existsSync(join(layerDirs[name] ?? '', 'index.ts')))
    expect(missing.join(',')).toBe('')
  })

  test('四个种子包的包身份（library、无 client 声明）', () => {
    const seedNames = ['@dsc/ui-slots', '@dsc/ui-primitives', '@dsc/ui-dockkit', '@dsc/ui-runtime']
    const bad = layerNames.filter((name) => {
      const pkg = JSON.parse(readFileSync(join(dirname(layerDirs[name] ?? ''), 'package.json'), 'utf8')) as {
        name?: string
        private?: boolean
        version?: string
        pneuma?: { library?: boolean; client?: unknown }
      }
      if (pkg.name !== name.replace('@dsc/', '@pneuma/') || pkg.private !== true) return true
      if (typeof pkg.version !== 'string' || pkg.version === '') return true
      if (seedNames.includes(name)) return pkg.pneuma?.library !== true || pkg.pneuma?.client !== undefined
      return false
    })
    expect(bad.join('、'), bad.join('、')).toBe('')
  })

  test('ui-layout 是客户端插件（有行、有 ./client、有 pneuma.client，不再是库包）', () => {
    const layoutPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'packages', 'ui-layout', 'package.json'), 'utf8')) as {
      pneuma?: { library?: boolean; bundle?: { patch?: string }; client?: { platform?: string } }
      exports?: Record<string, unknown>
    }
    expect(
      layoutPkg.pneuma?.library !== true &&
        layoutPkg.pneuma?.bundle?.patch === './cordis.patch.yml' &&
        layoutPkg.exports?.['./client'] !== undefined &&
        layoutPkg.pneuma?.client?.platform === 'pneuma',
      JSON.stringify(layoutPkg.pneuma),
    ).toBe(true)
  })

  test('ui-renderer 是可停用的插件（有行、immediately、./client）', () => {
    const rendererPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'packages', 'ui-renderer', 'package.json'), 'utf8')) as {
      pneuma?: { library?: boolean; bundle?: { patch?: string }; client?: { immediately?: boolean } }
      exports?: Record<string, unknown>
    }
    expect(
      rendererPkg.pneuma?.bundle?.patch === './cordis.patch.yml' &&
        rendererPkg.pneuma?.client?.immediately === true &&
        rendererPkg.exports?.['./client'] !== undefined &&
        rendererPkg.pneuma?.library === undefined,
      JSON.stringify(rendererPkg.pneuma),
    ).toBe(true)
  })

  test('ui-boot 是引导库包（library、无行、immediately）', () => {
    const bootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'packages', 'ui-boot', 'package.json'), 'utf8')) as {
      pneuma?: { library?: boolean; bundle?: unknown; client?: { immediately?: boolean } }
    }
    expect(
      bootPkg.pneuma?.library === true && bootPkg.pneuma?.bundle === undefined && bootPkg.pneuma?.client?.immediately === true,
      JSON.stringify(bootPkg.pneuma),
    ).toBe(true)
  })

  test('包内不出现反向依赖（primitives / slots ← dockkit ← runtime ← layout ← renderer）', () => {
    const upwardEdges: string[] = []
    const outsideEdges: string[] = []
    for (const name of layerNames) {
      const dir = layerDirs[name] ?? ''
      for (const file of sourceFilesOf(dir)) {
        for (const spec of importsOf(readFileSync(file, 'utf8'))) {
          if ((forbiddenUpward[name] ?? []).includes(spec)) {
            upwardEdges.push(`${relative(REPO_ROOT, file)} → ${spec}`)
            continue
          }
          if (!spec.startsWith('.')) continue
          const target = resolvePath(dirname(file), spec)
          if (target === dir || target.startsWith(dir + sep)) continue
          // 样式表与数据 JSON 没有**模块身份**：重复加载顶多是层叠/数据副本，不是「两份实现」。
          if (/\.(css|json)$/.test(spec)) continue
          outsideEdges.push(`${relative(REPO_ROOT, file)} → ${spec}`)
        }
      }
    }
    expect(upwardEdges.join('；'), upwardEdges.join('；')).toBe('')
    expect(outsideEdges.join('；'), outsideEdges.join('；')).toBe('')
  })

  test('四个下层对 @dsc/ui 只有类型引用（值 import 会把插件 API 内联进包）', () => {
    const valueUiImports: string[] = []
    for (const name of layerNames) {
      // renderer 是链条顶端；layout 是插件（源码只进自己的 bundle），两者同档放行。
      if (name === '@dsc/ui-renderer' || name === '@dsc/ui-layout') continue
      for (const file of sourceFilesOf(layerDirs[name] ?? '')) {
        // `ui/ui.tsx` 是插件入口：打包后 `@dsc/ui` 走 external，写值 import 是正常的。
        if (file.endsWith(join('ui', 'ui.tsx'))) continue
        const clean = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
        let statement: string | null = null
        for (const line of clean.split('\n')) {
          const trimmed = line.trim()
          if (statement === null && !trimmed.startsWith('import')) continue
          statement = statement === null ? trimmed : `${statement}\n${trimmed}`
          if (!/from\s*'[^']+'/.test(statement)) continue
          if (/from\s*'@dsc\/ui'/.test(statement) && !/^import\s+type\b/.test(statement)) {
            valueUiImports.push(`${relative(REPO_ROOT, file)} → @dsc/ui`)
          }
          statement = null
        }
        if (/import\s*\(\s*'@dsc\/ui'\s*\)/.test(clean)) {
          valueUiImports.push(`${relative(REPO_ROOT, file)} → import('@dsc/ui')`)
        }
      }
    }
    expect(valueUiImports.join('；'), valueUiImports.join('；')).toBe('')
  })
})

// ── [5d] 种子表 ↔ 壳实现 ───────────────────────────────────────────────────────
describe('种子表 ↔ 壳实现', () => {
  const seedFile = join(REPO_ROOT, 'src', 'packages', 'ui-boot', 'ui', 'platform-modules.json')
  const platformModules = JSON.parse(readFileSync(seedFile, 'utf8')) as string[]
  const bootSource = readFileSync(join(REPO_ROOT, 'src', 'packages', 'ui-boot', 'ui', 'boot.ts'), 'utf8')
  const shellPackages = JSON.parse(readFileSync(join(UI_SHELL, 'packages.json'), 'utf8')) as Record<string, string>
  const shellRequire = createRequire(join(UI_SHELL, 'package.json'))

  test('种子表每一项都挂在 boot.ts 的 MODULES 上', () => {
    const missing: string[] = []
    for (const seed of platformModules) {
      const spec = seed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const imported = new RegExp(`^import \\* as ([A-Za-z_$][\\w$]*) from '${spec}'$`, 'm').exec(bootSource)
      if (imported === null) {
        missing.push(`${seed}（没有 import * as）`)
        continue
      }
      if (!new RegExp(`^\\s{2}'?${spec}'?: ${imported[1]},$`, 'm').test(bootSource)) {
        missing.push(`${seed}（MODULES 没挂 ${imported[1]}）`)
      }
    }
    expect(missing.join('；'), missing.join('；')).toBe('')
  })

  test('每个种子 require 回来的东西非空', async () => {
    const empty: string[] = []
    for (const seed of platformModules) {
      if (seed.startsWith('@dsc/')) {
        // 壳内别名：运行期拿到的是源码模块的命名空间，Node 里 import 不了 .ts。
        // 判据是「落点文件在、并且真导出东西」——空文件也算没实现。
        const target = shellPackages[seed]
        const file = target === undefined ? undefined : resolvePath(REPO_ROOT, 'ui-shell', target)
        if (file === undefined || !existsSync(file) || !/\bexport\b/.test(readFileSync(file, 'utf8'))) empty.push(seed)
        continue
      }
      try {
        const resolvedPath = shellRequire.resolve(seed)
        const mod = (await import(pathToFileURL(resolvedPath).href)) as Record<string, unknown>
        if (Object.keys(mod).length === 0) empty.push(`${seed}（导出为空）`)
      } catch (error) {
        empty.push(`${seed}（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    expect(empty.join('；'), empty.join('；')).toBe('')
  })

  test('种子表含 cordis / zod / react-virtual（2026-11-05 补齐）', () => {
    for (const name of ['@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual']) {
      expect(platformModules.includes(name), name).toBe(true)
    }
  })

  test('build-plugins.mjs 从同一份 platform-modules.json 生成 external', () => {
    const buildPlugins = readFileSync(join(UI_SHELL, 'build-plugins.mjs'), 'utf8')
    expect(buildPlugins.includes('platform-modules.json') && buildPlugins.includes('const EXTERNAL = [...PLATFORM_MODULES')).toBe(true)
  })

  test('platform-modules.json 与 boot.ts MODULES 键集且顺序全等', () => {
    const modulesBlock = /const MODULES[^{]*\{([\s\S]*?)\n\}/.exec(bootSource)?.[1] ?? ''
    const modKeys = [...modulesBlock.matchAll(/^\s{2}(?:'([^']+)'|([A-Za-z][^:\s]*)):\s/gm)].map((m) => m[1] ?? m[2])
    expect(
      modKeys.length === platformModules.length && platformModules.every((name, index) => modKeys[index] === name),
      `MODULES=${modKeys.join(',')} | json=${platformModules.join(',')}`,
    ).toBe(true)
  })

  test('跑在种子里的是三个包（不是 @dsc/ui-core——它继续故意不给）', () => {
    const seedPackages = ['@dsc/ui-slots', '@dsc/ui-primitives', '@dsc/ui-dockkit']
    expect(seedPackages.every((name) => platformModules.includes(name)) && !platformModules.includes('@dsc/ui-core')).toBe(true)
  })

  test('E6 起种子下发给插件，boot.ts 的 MODULES 里挂了实现', () => {
    const seedPackages = ['@dsc/ui-slots', '@dsc/ui-primitives', '@dsc/ui-dockkit']
    for (const name of seedPackages) {
      expect(platformModules.includes(name), `平台模块表缺 ${name}`).toBe(true)
      expect(
        new RegExp(`^\\s*'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':`, 'm').test(bootSource) && bootSource.includes(`from '${name}'`),
        `boot.ts MODULES 缺 ${name}`,
      ).toBe(true)
    }
  })
})

// ── [5c] 槽位契约表 ────────────────────────────────────────────────────────────
describe.skipIf(!SHELL_BUILT)('槽位契约表（源码与产物）', () => {
  const slotsSource = readFileSync(join(REPO_ROOT, 'src', 'packages', 'ui-slots', 'ui', 'slots.ts'), 'utf8')
  const constSlots = [...slotsSource.matchAll(/^\s+\w+: '(shell\.[\w.]+)',/gm)].map((match) => match[1] ?? '')
  const declaredSlots = [...slotsSource.matchAll(/'((?:shell\.)[\w.]+)': \{ kind:/g)].map((match) => match[1] ?? '')
  const assets = join(REPO_ROOT, 'lib', 'ui', 'assets')
  const appFile = existsSync(assets) ? readdirSync(assets).find((name) => name.startsWith('app-') && name.endsWith('.js')) : undefined
  const appBundle = appFile === undefined ? '' : readFileSync(join(assets, appFile), 'utf8')

  test('壳槽常量表 9 个键、SlotMap 声明 9 个键、两边集合一致', () => {
    expect(
      constSlots.length === 9 && declaredSlots.length === 9 && constSlots.every((name) => declaredSlots.includes(name)),
      `const=${constSlots.join(',')} declared=${declaredSlots.join(',')}`,
    ).toBe(true)
  })

  test('应用产物里含全部 9 个壳槽名', () => {
    expect(constSlots.length === 9 && constSlots.every((name) => appBundle.includes(name)), appFile ?? '缺 app-*.js').toBe(true)
  })

  test('transcript 产物含 tool-card Factory 与 footer 槽名；trace 含消费点', () => {
    const readBundle = (id: string): string => readFileSync(join(REPO_ROOT, 'lib', 'ui', 'plugins', id, 'client.js'), 'utf8')
    expect(readBundle('transcript').includes('transcript.tool-card') && readBundle('transcript').includes('transcript.toolcard.footer')).toBe(true)
    expect(readBundle('trace').includes('transcript.tool-card')).toBe(true)
  })

  test('transcript 产物含工具卡可点路径（tc-path-btn / data-tc-open）', () => {
    const bundle = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'plugins', 'transcript', 'client.js'), 'utf8')
    expect(bundle.includes('tc-path-btn') && bundle.includes('data-tc-open')).toBe(true)
  })

  test('transcript 产物含 chip 的补丁/内容分流（data-tc-source / opensPatch）', () => {
    const bundle = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'plugins', 'transcript', 'client.js'), 'utf8')
    expect(bundle.includes('data-tc-source') && bundle.includes('opensPatch')).toBe(true)
  })

  test('preview 产物含 patch 页签与 DiffRows 渲染', () => {
    const bundle = readFileSync(join(REPO_ROOT, 'lib', 'ui', 'plugins', 'preview', 'client.js'), 'utf8')
    expect(/kind:\s*["']patch["']/.test(bundle) && bundle.includes('DiffRows')).toBe(true)
  })
})

// ── [9] 设置回执的结构化载荷 ────────────────────────────────────────────────────
describe('设置回执的结构化载荷（契约 ↔ 壳出口）', () => {
  const contractText = readContractSource()
  const interfaceBody = (name: string): string =>
    new RegExp(`interface ${name} \\{[\\s\\S]*?\\n\\}`).exec(contractText)?.[0] ?? ''
  const okBlock = interfaceBody('SettingsMutationOk')
  const payloadNames = [...okBlock.matchAll(/data\?:\s*([A-Za-z| ]+)/g)]
    .flatMap((match) => (match[1] ?? '').split('|').map((piece) => piece.trim()))
    .filter((piece) => piece !== '')
  const kinds = payloadNames.map((name) => ({
    name,
    kind: /kind:\s*'([a-z-]+)'/.exec(interfaceBody(name))?.[1] ?? '',
  }))

  test('从契约读到了 SettingsMutationOk.data 的载荷类型', () => {
    expect(payloadNames.length, okBlock).toBeGreaterThan(0)
  })

  test('每种载荷都带一个 kind 判别位（壳按它对出口）', () => {
    expect(kinds.length).toBeGreaterThan(0)
    expect(kinds.every((item) => item.kind !== ''), JSON.stringify(kinds)).toBe(true)
  })

  const settingsDir = resolveUiHalfDir('settings')
  const sources = readdirSync(settingsDir)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => readFileSync(join(settingsDir, file), 'utf8'))
    .join('\n')
  /** 一种载荷的「出口」：对该 kind 的正向分派（比较或 case 标签）。 */
  const outletFor = (kind: string): boolean =>
    new RegExp(`kind\\s*={2,3}\\s*['"]${kind}['"]`).test(sources) || new RegExp(`case\\s*['"]${kind}['"]\\s*:`).test(sources)

  test('壳的设置插件对每一种载荷都有正向出口', () => {
    const unhandled = kinds.filter((item) => !outletFor(item.kind))
    expect(unhandled.map((item) => item.kind).join(','), unhandled.map((item) => item.kind).join(',')).toBe('')
  })

  test('配对码载荷交给弹窗（不是一行说明）', () => {
    expect(sources.includes('<PairModal') && outletFor('pair-code')).toBe(true)
  })

  test('可扫地址行整行居中、能折行不截断（长地址要照着输进手机）', () => {
    const viewsCss = readFileSync(join(REPO_ROOT, 'src', 'packages', 'ui-renderer', 'ui', 'styles', 'legacy', 'views.css'), 'utf8')
    const cssBlock = (pattern: string): string => new RegExp(`\\n${pattern} \\{[\\s\\S]*?\\n\\}`).exec(viewsCss)?.[0] ?? ''
    const urlBlock = cssBlock('\\.pair-url')
    const urlTextBlock = cssBlock('\\.pair-url-text')
    expect(urlBlock.includes('justify-content: center') && urlBlock.includes('text-align: center'), urlBlock).toBe(true)
    expect(sources.includes('pair-url-text') && urlTextBlock.includes('white-space: normal'), urlTextBlock).toBe(true)
  })

  describe.skipIf(!SHELL_BUILT)('设置插件产物里带着每一种载荷的出口', () => {
    const bundleFile = join(UI_PLUGINS, 'settings', 'client.js')
    const bundle = existsSync(bundleFile) ? readFileSync(bundleFile, 'utf8') : ''
    const outletInBundle = (kind: string): boolean =>
      new RegExp(`kind\\s*={2,3}\\s*['"]${kind}['"]`).test(bundle) || new RegExp(`case\\s*['"]${kind}['"]\\s*:`).test(bundle)

    test('出口齐全（改完壳要重建）', () => {
      const missing = kinds.filter((item) => !outletInBundle(item.kind))
      expect(missing.map((item) => item.kind).join(','), missing.map((item) => item.kind).join(',')).toBe('')
    })

    test('配对弹窗在产物里（画得出二维码的那张）', () => {
      expect(bundle.includes('pair-card') && bundle.includes('pair-qr-img') && outletInBundle('pair-code')).toBe(true)
    })
  })
})

// ── 反向验证用的夹具（仅在本 spec 内部，不影响其它用例） ────────────────────────
// 这一段没有任何断言：它只是保证「临时目录在文件被 afterAll 清理前已经存在」，
// 避免极端情况下 mkdtemp 失败导致整个文件的 hook 全红、掩盖真正的失败原因。
const PROBE_WORK = mkdtempSync(join(tmpdir(), 'dsc-ui-contract-'))
beforeAll(() => {
  mkdirSync(join(PROBE_WORK, 'keep'), { recursive: true })
  writeFileSync(join(PROBE_WORK, 'keep', 'readme.txt'), 'fixture root for reverse verification\n')
})
afterAll(() => {
  try {
    rmSync(PROBE_WORK, { recursive: true, force: true })
  } catch {
    // 删不掉不影响结论：临时目录会被系统清。
  }
})
