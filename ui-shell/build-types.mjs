/**
 * 界面 SDK 的类型产物：把「作者可见的七个界面包」编成一棵能按**包名 import** 的 .d.ts 树。
 *
 * 为什么要有这一步：`build-plugins.mjs` 只出 `client.js`（运行期 bundle），类型此前没有
 * 随 SDK 发布——第三方 TS 作者只能把 `ui-shell/packages.json` 那张源码落点表手抄进自己的
 * `tsconfig.json`，且必须先检出本仓库。这里让类型跟着发行包走：产物落 `lib/ui/sdk/`
 * （`prepare-runtime.mjs` 整拷 `lib/`，所以自动随包），作者一条 paths 就拿到完整类型。
 *
 * 产物形状（每个包一个真实的包目录）：
 *
 *   lib/ui/sdk/@dsc/ui/            package.json + index.d.ts（= plugin-api 那份声明）
 *   lib/ui/sdk/@dsc/ui-core/       package.json + packages/ui-core/** + core/** + contract.d.ts + contract/**
 *   lib/ui/sdk/@dsc/ui-slots/      package.json + *.d.ts
 *   …（ui-primitives / ui-dockkit / ui-layout / ui-renderer 同形）
 *   lib/ui/sdk/@deepseek-ai/cordis/  种子包的第三方类型：从 node_modules **原样转出**
 *   lib/ui/sdk/zod/ 与 lib/ui/sdk/@tanstack/react-virtual/ 同形（含它们声明里 import 的包）
 *
 * 两处**刻意的**处理：
 *
 * 1. `@dsc/ui` 的入口就是 `plugin-api.d.ts` 本身（不是薄转发）——`SlotMap` /
 *    `SlotFactoryMap` 的声明合并认的是**这个模块的文件身份**，转发一层合并就失效。
 * 2. 万一还有文件按 `'../plugin-api'` 相对引，落盘前改写成 `'@dsc/ui'`。汇总阶段本来
 *    就要求按包名引（源码里 ui-slots / ui-layout 已经改成 `@dsc/ui`），这段是兜底：
 *    界面半搬出 ui-shell 后，相对路径在 SDK 树里会指到包外，静默变成 any。
 *
 * @module dsc-ui-shell/build-types
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(root, '..')
const sdkRoot = join(repoRoot, 'lib', 'ui', 'sdk')
const emitRoot = join(sdkRoot, '.emit')

const shellPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(shellPkg.version)
const PACKAGES = JSON.parse(readFileSync(join(root, 'packages.json'), 'utf8'))

/** 递归列出一个目录下的全部文件（相对该目录，POSIX 分隔符）。 */
function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

// ── 1. 先跑 tsc 出声明（产物在 .emit，仓库根相对结构）────────────────────────────
rmSync(emitRoot, { recursive: true, force: true })
const tsc = require.resolve('typescript/lib/tsc.js')
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.types.json')], { stdio: 'inherit' })
if (!existsSync(emitRoot)) {
  console.error(`[build-types] tsc 没产出 ${emitRoot}：检查 tsconfig.types.json 的 outDir`)
  process.exit(1)
}

// ── 2. 把 .emit 分发成 @dsc/<包名>/ 的 SDK 目录树 ────────────────────────────────
// 目标相对路径（POSIX）→ 文件内容。tsc 产物是整棵树，这里按包的源码落点归位。
const targets = new Map()

for (const [name, rel] of Object.entries(PACKAGES)) {
  if (name === '@dsc/ui') {
    // plugin-api.ts 是单文件落点：它的声明就是 @dsc/ui 的入口本体。
    const src = join(emitRoot, 'ui-shell', 'src', 'plugin-api.d.ts')
    if (!existsSync(src)) {
      console.error('[build-types] 找不到 plugin-api 的声明产物——@dsc/ui 的合并锚点就靠它')
      process.exit(1)
    }
    targets.set(`${name}/index.d.ts`, readFileSync(src, 'utf8'))
  } else if (name === '@dsc/ui-core') {
    // 源码落点是 ../src/packages/ui-core/index.ts，包内文件 import 的是 ../../core/** 与
    // ../../contract.js。SDK 里按仓库相对结构摆（packages/ui-core/** + core/** + contract.d.ts + contract/**），
    // 四种相对写法（./x.js、../../core/x.js、../contract.js、./contract/x.js）原样成立；入口见下方 ENTRY。
    // contract/** 也要带：contract.d.ts 只做转出，十个域的类型实体在对面的目录里。
    for (const sub of ['packages/ui-core', 'core', 'contract']) {
      const abs = join(emitRoot, 'src', ...sub.split('/'))
      if (!existsSync(abs)) {
        console.error(`[build-types] 找不到 ${name} 的依赖声明 src/${sub}——它少一棵包内解析就断`)
        process.exit(1)
      }
      for (const file of listFiles(abs)) targets.set(`${name}/${sub}/${file}`, readFileSync(join(abs, file), 'utf8'))
    }
    const contract = join(emitRoot, 'src', 'contract.d.ts')
    if (existsSync(contract)) targets.set(`${name}/contract.d.ts`, readFileSync(contract, 'utf8'))
  } else {
    // 其余包源码落点是 ../src/packages/<pkgdir>/ui/index.ts：把对应的 ui/ 产物目录整段搬进 @dsc/<name>/。
    // 按 'src/packages/' 之后的第一段取包名——不能再用「倒数第二段」，那是 ui/ 了。
    const pkgDir = rel.split('src/packages/')[1]?.split('/')[0]
    const abs = pkgDir === undefined ? '' : join(emitRoot, 'src', 'packages', pkgDir, 'ui')
    if (!existsSync(abs)) {
      console.error(`[build-types] 找不到 ${name} 的声明产物 ${pkgDir}——落点与 packages.json 对不上？`)
      process.exit(1)
    }
    for (const relFile of listFiles(abs)) targets.set(`${name}/${relFile}`, readFileSync(join(abs, relFile), 'utf8'))
  }
}

// 引用的改写：包内对 '../plugin-api' 的引用改按包名（SDK 里它是同一个模块，合并仍成立）。
let rewrites = 0
for (const [pathKey, body] of targets) {
  if (!body.includes("'../plugin-api'")) continue
  targets.set(pathKey, body.split("'../plugin-api'").join("'@dsc/ui'"))
  rewrites += 1
}

// ── 3. 每个包一份 package.json：真实 name/version/types/exports/files ─────────────
/** 各包入口（相对包目录）。@dsc/ui-core 的入口在 packages/ui-core/ 子目录（落点保留仓库相对结构），其余都在根。 */
const ENTRY = {
  '@dsc/ui': './index.d.ts',
  '@dsc/ui-core': './packages/ui-core/index.d.ts',
}
/** 源码包的 description（ui-* 各有），没有的给一句兜底。 */
function describe(name, rel) {
  const guess = name === '@dsc/ui' ? join(root, 'src', 'plugin-api.ts') : join(root, rel)
  const dir = statSync(guess).isDirectory() ? guess : dirname(guess)
  const file = join(dir, 'package.json')
  if (existsSync(file)) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof doc.description === 'string') return doc.description
    } catch {
      // 读坏了不致命：description 只是注解
    }
  }
  return `${name} 的界面 SDK 类型声明（随 dsc 界面壳发布）。`
}

const writePackageJson = (name) => {
  const entry = ENTRY[name] ?? './index.d.ts'
  const doc = {
    name,
    version,
    private: true,
    description: describe(name, PACKAGES[name]),
    type: 'module',
    types: entry,
    exports: { '.': { types: entry } },
    files: ['**/*.d.ts'],
  }
  const key = `${name}/package.json`
  targets.set(key, `${JSON.stringify(doc, null, 2)}\n`)
}
for (const name of Object.keys(PACKAGES)) writePackageJson(name)

// ── 3b. 平台种子的第三方类型：从 node_modules 的 .d.ts 直接转出 ────────────────────
//
// 种子表里除了 @dsc/* 还有三样基础设施（cordis / zod / @tanstack/react-virtual）。它们的
// 声明住在各自的包里，作者按包名 import 时要解析到**与壳里同一版**的类型——手抄签名迟早
// 与 node_modules 里的版本分家，所以这里整段拷过来（只拷 .d.ts 与 package.json：SDK 是类型
// 产物，运行期实例由壳的种子表提供）。声明的依赖也一并带上，否则作者那边会静默变成 any。
const platformModules = JSON.parse(
  readFileSync(join(repoRoot, 'src', 'packages', 'ui-boot', 'ui', 'platform-modules.json'), 'utf8'),
)

/**
 * react 系不搬：作者自己的工程本来就要装 @types/react，搬一份进来只会得到两份类型身份
 * （`ReactNode` 互不兼容）。它们的类型面由作者自己的依赖提供，与壳无关。
 */
const SEED_TYPES_SKIP = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'])

/** 声明文件后缀：只转出类型，不搬实现。 */
const DECLARATION_SUFFIX = /\.d\.(?:ts|cts|mts)$/

/**
 * 找一个已安装包的目录。
 *
 * 解析起点是**引用它的那个包**（种子本身从 `ui-shell` 起）：pnpm 把依赖藏在
 * `.pnpm/<包>/node_modules/` 里，从仓库根或 ui-shell 都看不见 cordis 的 `cosmokit`。
 * @param name - 包名
 * @param from - 解析起点目录
 */
function installedPackageDir(name, from) {
  try {
    return dirname(require.resolve(`${name}/package.json`, { paths: [from] }))
  } catch {
    // 少数包不导出 ./package.json：从入口文件往上找到最近的 package.json。
    let dir = dirname(require.resolve(name, { paths: [from] }))
    while (dir !== dirname(dir)) {
      if (existsSync(join(dir, 'package.json'))) return dir
      dir = dirname(dir)
    }
    throw new Error(`[build-types] 找不到包 ${name} 的目录`)
  }
}

/** `@scope/name/sub` → `@scope/name`；`name/sub` → `name`（声明里的子路径要退回到包身份）。 */
function packageNameOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** 一个包目录里的全部声明文件（相对路径，POSIX 分隔符）。 */
function declarationsOf(dir) {
  return listFiles(dir).filter((file) => DECLARATION_SUFFIX.test(file))
}

/** 声明文件里 import 的裸包名（相对路径与 node: 内置不算）。 */
function bareImportsOf(text) {
  const found = new Set()
  for (const match of text.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
    const spec = match[1]
    if (spec.startsWith('.') || spec.startsWith('node:')) continue
    found.add(spec)
  }
  return [...found]
}

// 从种子表出发，把「声明里 import 到的包」也收进来（一层层直到没有新名字）：
// `@tanstack/react-virtual` 的声明直接 import `@tanstack/virtual-core`，cordis 的引
// `@deepseek-ai/cosmokit` 与 `@standard-schema/spec`——少一个，作者读到的类型就是 any。
const seedQueues = platformModules
  .filter((name) => !SEED_TYPES_SKIP.has(name) && PACKAGES[name] === undefined)
  .map((name) => ({ name, from: root }))
const seedTypeDirs = new Map()
while (seedQueues.length > 0) {
  const { name, from } = seedQueues.shift()
  if (seedTypeDirs.has(name)) continue
  const dir = installedPackageDir(name, from)
  seedTypeDirs.set(name, dir)
  for (const file of declarationsOf(dir)) {
    for (const spec of bareImportsOf(readFileSync(join(dir, file), 'utf8'))) {
      const dep = packageNameOf(spec)
      if (!seedTypeDirs.has(dep)) seedQueues.push({ name: dep, from: dir })
    }
  }
}
for (const [name, dir] of seedTypeDirs) {
  for (const file of declarationsOf(dir)) targets.set(`${name}/${file}`, readFileSync(join(dir, file), 'utf8'))
  // package.json 原样带上：`types` / `exports[...].types` 是模块解析的入口，改写它等于换类型。
  targets.set(`${name}/package.json`, readFileSync(join(dir, 'package.json'), 'utf8'))
}

// ── 4. 同步落盘：字节没变就不动文件，删掉已不在目标集里的旧文件 ──────────────────
let written = 0
let kept = 0
const targetKeys = new Set(targets.keys())
if (existsSync(sdkRoot)) {
  for (const rel of listFiles(sdkRoot)) {
    if (rel.startsWith('.emit/')) continue
    if (!targetKeys.has(rel)) {
      rmSync(join(sdkRoot, rel.split('/').join(sep)), { force: true })
    }
  }
}
for (const [rel, body] of targets) {
  const target = join(sdkRoot, rel.split('/').join(sep))
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : null
  if (existing === body) {
    kept += 1
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, body, 'utf8')
  written += 1
}
// 清掉暂存目录；再删掉因目标集变化而空掉的目录（同步只删文件，空壳留着会误导）。
rmSync(emitRoot, { recursive: true, force: true })
function pruneEmpty(d) {
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = join(d, entry.name)
    pruneEmpty(child)
    if (readdirSync(child).length === 0) rmSync(child, { recursive: true, force: true })
  }
}
pruneEmpty(sdkRoot)

console.log(
  `[build-types] SDK 类型树 → lib/ui/sdk/（@dsc 下 ${String(Object.keys(PACKAGES).length)} 个包，`
  + `种子包的第三方类型 ${String(seedTypeDirs.size)} 个：${[...seedTypeDirs.keys()].join('、')}）`
  + `：重写 ${String(written)} 份，字节未变保留 ${String(kept)} 份，改按包名引用 ${String(rewrites)} 处`,
)
