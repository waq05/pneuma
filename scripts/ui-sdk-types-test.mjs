/**
 * 界面 SDK 类型产物的探针：证明「第三方按包名拿官方类型」这条路是通的、且不会悄悄退化。
 *
 * 与 `ui-plugin-test.mjs` 的分工：那个钉运行期（bundle 里 require 到的是壳提供的模块），
 * 这里钉**类型面**——`ui-shell/build-types.mjs` 出的 `lib/ui/sdk/@dsc/<包名>/` 那棵 .d.ts 树。
 * 出问题的形状都很像「编辑器里全是红波浪线/全是 any」，所以断言钉在五处：
 *
 *   1. SDK 树在不在（每个包目录 + 入口 .d.ts）；
 *   2. `@dsc/ui` 的入口就是 plugin-api 那份声明——`SlotMap` / `SlotFactoryMap` 的合并锚点，
 *      它一旦被换成薄转发，`declare module '@dsc/ui'` 的合并就静默失效；
 *   3. 每个包 `package.json` 的 `types` 指向真实存在的文件（写歪了编辑器直接找不到类型）；
 *   4. `platform-modules.json` 的种子面与发布的类型面**一一对应**（少一个 = 作者按包名取不到类型）；
 *   5. **真跑一遍 tsc**：`examples/ui-sdk-types-demo` 这个最小第三方工程对 SDK 编译零错——
 *      这是本任务唯一的硬证据，前面几条只是它的护栏。
 *
 * 用法：pnpm -C ui-shell build && node scripts/ui-sdk-types-test.mjs
 * （界面壳没构建时打一行 SKIP，与既有探针一致。）
 *
 * @module dsc/scripts/ui-sdk-types-test
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sdkRoot = join(repoRoot, 'lib', 'ui', 'sdk')
const packagesJson = join(repoRoot, 'ui-shell', 'packages.json')
const platformModulesFile = join(repoRoot, 'src', 'packages', 'ui-boot', 'ui', 'platform-modules.json')
const sampleDir = join(repoRoot, 'examples', 'ui-sdk-types-demo')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  PASS  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

if (!existsSync(sdkRoot)) {
  console.log(`\nSKIP  界面 SDK 类型树不在（${sdkRoot}）——先跑 pnpm -C ui-shell build`)
  process.exit(0)
}

const sdkPackages = new Set(
  existsSync(join(sdkRoot, '@dsc')) ? readdirSync(join(sdkRoot, '@dsc')) : [],
)
const readManifest = (pkgDir) => JSON.parse(readFileSync(join(sdkRoot, '@dsc', pkgDir, 'package.json'), 'utf8'))

/** 递归列目录下的文件（相对路径，POSIX 分隔符）——与 build-types 的 listFiles 同一口径。 */
const listFiles = (dir, prefix = '') => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

/** 声明文件后缀（build-types 只搬这些）。 */
const DECLARATION_SUFFIX = /\.d\.(?:ts|cts|mts)$/

// ── 1. SDK 树在不在 ──────────────────────────────────────────────────────────────
console.log('\n[1] SDK 类型树')
check('@dsc 作用域目录存在', existsSync(join(sdkRoot, '@dsc')))
const declared = Object.keys(JSON.parse(readFileSync(packagesJson, 'utf8')))
for (const name of declared) {
  const pkgDir = name.replace(/^@dsc\//, '')
  check(`包目录 ${name} 存在`, sdkPackages.has(pkgDir), `缺 ${join(sdkRoot, '@dsc', pkgDir)}`)
}

// ── 2. @dsc/ui 是合并锚点本体 ────────────────────────────────────────────────────
console.log('\n[2] @dsc/ui 合并锚点')
const uiEntry = join(sdkRoot, '@dsc', 'ui', 'index.d.ts')
const uiBody = existsSync(uiEntry) ? readFileSync(uiEntry, 'utf8') : ''
check('@dsc/ui 入口 index.d.ts 在', existsSync(uiEntry))
check('入口里有 SlotMap 声明（合并锚点）', /interface SlotMap\b/.test(uiBody))
check('入口里有 SlotFactoryMap 声明', /interface SlotFactoryMap\b/.test(uiBody))
check('入口导出 defineUiPlugin（就是 plugin-api 那份，不是薄转发）', uiBody.includes('defineUiPlugin'))
// plugin-api 独有、别处不会有的符号：它在本体里，说明入口确实不是一层转发壳。
check('入口带 plugin-api 独有的 HostStatusView / requestAppearance', uiBody.includes('HostStatusView') && uiBody.includes('requestAppearance'))

// ── 3. 每个包的 package.json 指向真实文件 ───────────────────────────────────────
console.log('\n[3] 包清单与 types 落点')
for (const name of declared) {
  const pkgDir = name.replace(/^@dsc\//, '')
  const dir = join(sdkRoot, '@dsc', pkgDir)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    check(`${name} 有 package.json`, false, manifestPath)
    continue
  }
  const doc = readManifest(pkgDir)
  check(`${name} 的 name 字段与目录一致`, doc.name === name, String(doc.name))
  check(`${name} 有 version / files`, typeof doc.version === 'string' && Array.isArray(doc.files))
  const entry = doc.exports?.['.']?.types ?? doc.types
  check(`${name} 声明了 types`, typeof entry === 'string' && entry.length > 0, String(entry))
  if (typeof entry === 'string') {
    check(`${name} 的 types 指向真实文件`, existsSync(join(dir, entry)), `缺 ${join(dir, entry)}`)
    check(`${name} 的 types 字段与 exports 一致`, doc.types === doc.exports?.['.']?.types)
  }
}

// ── 4. 种子面 ↔ 类型面一一对应 ───────────────────────────────────────────────────
console.log('\n[4] 平台种子面 ↔ 发布类型面')
const seeds = JSON.parse(readFileSync(platformModulesFile, 'utf8'))
const seedDsc = seeds.filter((seed) => typeof seed === 'string' && seed.startsWith('@dsc/'))
check('种子表里有 @dsc/* 包面', seedDsc.length > 0, JSON.stringify(seeds))
for (const seed of seedDsc) {
  const pkgDir = seed.replace(/^@dsc\//, '')
  check(`种子 ${seed} 有发布的类型包`, sdkPackages.has(pkgDir), `缺 ${join(sdkRoot, '@dsc', pkgDir)}`)
}
// 反向：发布的 @dsc 包不会凭空多出一个种子也不认识、作者又下不到的（放宽：ui-core/layout/renderer
// 是解析依赖，属内部包；这里只要求「种子里的每个都在发布面」）。
check(
  '每个种子都能在 SDK 里按包名解析（缺一即断）',
  seedDsc.every((seed) => sdkPackages.has(seed.replace(/^@dsc\//, ''))),
)

// ── 4b. 第三方种子（cordis / zod / react-virtual / xterm）的类型面 ──────────────
// 这几样的类型不是本仓库源码，由 build-types.mjs 从 node_modules 的 .d.ts **整段转出**。
// 判据三条：包目录在、`types` 指向真实文件、转出的声明与 node_modules 里的**逐字节相同**
// （手抄一份签名也能让前两条过，第三条专治「抄一半、版本分家」）。
// react 系不在其中：作者自己的工程要装 @types/react，SDK 再发一份会让 ReactNode 两个身份。
const SEED_TYPES_SKIP = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'])
const shellRequire = createRequire(join(repoRoot, 'ui-shell', 'package.json'))
/**
 * 一个已装包的真实目录。
 *
 * 解析起点是 `ui-shell`（壳的依赖树）：pnpm workspace 下根 node_modules 看不到兄弟包的依赖，
 * 而 build-types 正是从 ui-shell 起解析的——两边必须同一个起点，否则「转出」与「比对」看的不是一份。
 */
const installedDirOf = (name) => {
  try {
    return realpathSync(dirname(shellRequire.resolve(`${name}/package.json`)))
  } catch {
    let dir = realpathSync(dirname(shellRequire.resolve(name)))
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, 'package.json'))) return dir
      dir = dirname(dir)
    }
    throw new Error(`找不到包 ${name} 的目录`)
  }
}
const seedExternal = seeds.filter((seed) => typeof seed === 'string' && !seed.startsWith('@dsc/') && !SEED_TYPES_SKIP.has(seed))
check('种子表里有第三方种子（cordis / zod / react-virtual 之类）', seedExternal.length >= 3, seedExternal.join(','))
for (const seed of seedExternal) {
  const dir = join(sdkRoot, ...seed.split('/'))
  if (!existsSync(dir)) {
    check(`种子 ${seed} 有发布的类型包`, false, `缺 ${dir}（先跑 node ui-shell/build-types.mjs）`)
    continue
  }
  const doc = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  check(`种子 ${seed} 的包清单 name 与种子一致`, doc.name === seed, String(doc.name))
  const entry = typeof doc.types === 'string' ? doc.types : doc.exports?.['.']?.types
  check(`${seed} 声明了 types`, typeof entry === 'string' && entry.length > 0, String(entry))
  if (typeof entry === 'string') check(`${seed} 的 types 指向真实文件`, existsSync(join(dir, entry)), `缺 ${join(dir, entry)}`)
  // 逐字节比对：转出 = 拷贝，不是重写。
  const installed = installedDirOf(seed)
  const sourceDeclarations = listFiles(installed).filter((file) => DECLARATION_SUFFIX.test(file))
  const published = new Set(listFiles(dir).filter((file) => DECLARATION_SUFFIX.test(file)))
  const missing = sourceDeclarations.filter((file) => !published.has(file))
  const drifted = sourceDeclarations
    .filter((file) => published.has(file))
    .filter((file) => !readFileSync(join(dir, file)).equals(readFileSync(join(installed, file))))
  check(
    `${seed} 的声明从 node_modules 原样转出（文件齐、字节同）`,
    missing.length === 0 && drifted.length === 0,
    `缺 ${missing.length} 份、改了 ${drifted.length} 份`,
  )
}
// 合并改写的回归：声明里不该再残留相对引用的 '../plugin-api'（SDK 里按包名引）。
let leftover = 0
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name.endsWith('.d.ts')) {
      const body = readFileSync(p, 'utf8')
      if (body.includes("from '../plugin-api'") || body.includes("declare module '../plugin-api'")) leftover += 1
    }
  }
}
walk(join(sdkRoot, '@dsc'))
check('声明里无残留的相对合并锚点 ../plugin-api', leftover === 0, `${String(leftover)} 处`)

// ── 5. 真跑一遍 tsc：最小第三方工程零错 ──────────────────────────────────────────
console.log('\n[5] 真实第三方 tsc 验收')
check('最小第三方工程在（examples/ui-sdk-types-demo）', existsSync(join(sampleDir, 'tsconfig.json')))
if (existsSync(join(sampleDir, 'tsconfig.json'))) {
  const tsc = require.resolve('typescript/lib/tsc.js')
  let ok = true
  let out = ''
  try {
    out = execFileSync(process.execPath, [tsc, '-p', join(sampleDir, 'tsconfig.json')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    ok = false
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  check('示例工程 import @dsc/ui 并 tsc 零错', ok, out.trim().split('\n').slice(0, 6).join(' | '))
}

// ── 6. 种子类型真能用：临时工程只 import 种子，tsc 零错 ──────────────────────────
// 第 4b 条只证明「文件在那儿、字节没改」。这里补最后一刀：拿 SDK 编一个真工程，且用三条
// `@ts-expect-error` 做反向断言——如果某个种子的类型其实没解析出来（变成 any），那三行就
// 不会报错，tsc 会把「未使用的 @ts-expect-error」当错误（TS2578）报出来。空壳类型面过不了。
console.log('\n[6] 种子类型 tsc 验收')
{
  const tsc = require.resolve('typescript/lib/tsc.js')
  /** 发布面里的每个第三方种子包 → 它的 SDK 目录（probe 的 paths 按这个生成）。 */
  const seedTypePaths = {}
  for (const entry of readdirSync(sdkRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '@dsc' || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(join(sdkRoot, entry.name))) {
        seedTypePaths[`${entry.name}/${child}`] = [join(sdkRoot, entry.name, child)]
      }
      continue
    }
    seedTypePaths[entry.name] = [join(sdkRoot, entry.name)]
  }
  const probeDir = mkdtempSync(join(tmpdir(), 'dsc-sdk-probe-'))
  try {
    writeFileSync(
      join(probeDir, 'probe.ts'),
      [
        "import type { Context } from '@deepseek-ai/cordis'",
        "import { z } from 'zod'",
        "import type { VirtualItem } from '@tanstack/react-virtual'",
        '',
        'const schema = z.string()',
        'declare const ctx: Context',
        'declare const item: VirtualItem',
        '',
        '// @ts-expect-error zod 的 schema 不是数字',
        'const badSchema: number = schema',
        '// @ts-expect-error cordis 的 Context 不是数字',
        'const badContext: number = ctx',
        '// @ts-expect-error 虚拟项不是数字',
        'const badItem: number = item',
        '',
        'export { badSchema, badContext, badItem }',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(probeDir, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            lib: ['ES2023', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            // 基元包/第三方声明会引重依赖；作者工程不一定装，跳过 .d.ts 本体检查。
            skipLibCheck: true,
            noEmit: true,
            baseUrl: '.',
            paths: seedTypePaths,
          },
          include: ['probe.ts'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    let ok = true
    let out = ''
    try {
      out = execFileSync(process.execPath, [tsc, '-p', join(probeDir, 'tsconfig.json')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      ok = false
      out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    check('种子类型能让一个只 import 种子的工程零错（三种子各一条负向断言）', ok, out.trim().split('\n').slice(0, 8).join(' | '))
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.log(`\n${String(failures)} 条断言未过`)
  process.exit(1)
}
console.log('\n全部通过')
