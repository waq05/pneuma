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
 *   lib/ui/sdk/@dsc/ui-core/       package.json + ui/** + core/** + contract.d.ts
 *   lib/ui/sdk/@dsc/ui-slots/      package.json + *.d.ts
 *   …（ui-primitives / ui-dockkit / ui-layout / ui-renderer 同形）
 *
 * 两处**刻意的**处理：
 *
 * 1. `@dsc/ui` 的入口就是 `plugin-api.d.ts` 本身（不是薄转发）——`SlotMap` /
 *    `SlotFactoryMap` 的声明合并认的是**这个模块的文件身份**，转发一层合并就失效。
 * 2. 包内对 `'../plugin-api'` 的引用改写成 `'@dsc/ui'`：源码里 ui-slots / ui-layout 按
 *    相对路径引它（合并只认词法相邻的文件身份），而 SDK 里 `@dsc/ui` 与 `plugin-api.d.ts`
 *    是同一个模块，按包名引指向的还是那一份——合并照样成立。
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
    // 源码在 ../src/ui：连同它的传递依赖（src/ui/** + src/core/** + src/contract.d.ts）
    // 一起按原相对结构搬走，包内相对 import（./x.js、../core/x.js、../contract.js）原样成立。
    for (const sub of ['ui', 'core']) {
      const abs = join(emitRoot, 'src', sub)
      if (!existsSync(abs)) {
        console.error(`[build-types] 找不到 ${name} 的依赖声明 src/${sub}——它少一棵包内解析就断`)
        process.exit(1)
      }
      for (const rel of listFiles(abs)) targets.set(`${name}/${sub}/${rel}`, readFileSync(join(abs, rel), 'utf8'))
    }
    const contract = join(emitRoot, 'src', 'contract.d.ts')
    if (existsSync(contract)) targets.set(`${name}/contract.d.ts`, readFileSync(contract, 'utf8'))
  } else {
    // 其余包源码落点是 ./src/<pkgdir>/index.ts：把对应产物目录整段搬进 @dsc/<name>/。
    const pkgDir = rel.replace(/^\.\//, '').split('/').slice(-2, -1)[0]
    const abs = join(emitRoot, 'ui-shell', 'src', pkgDir)
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
/** 各包入口（相对包目录）。@dsc/ui-core 的入口在 ui/ 子目录，其余都在根。 */
const ENTRY = {
  '@dsc/ui': './index.d.ts',
  '@dsc/ui-core': './ui/index.d.ts',
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
  `[build-types] SDK 类型树 → lib/ui/sdk/@dsc/（${String(Object.keys(PACKAGES).length)} 个包）`
  + `：重写 ${String(written)} 份，字节未变保留 ${String(kept)} 份，改按包名引用 ${String(rewrites)} 处`,
)
