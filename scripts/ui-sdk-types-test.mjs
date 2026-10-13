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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sdkRoot = join(repoRoot, 'lib', 'ui', 'sdk')
const packagesJson = join(repoRoot, 'ui-shell', 'packages.json')
const platformModulesFile = join(repoRoot, 'ui-shell', 'src', 'platform-modules.json')
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

if (failures > 0) {
  console.log(`\n${String(failures)} 条断言未过`)
  process.exit(1)
}
console.log('\n全部通过')
