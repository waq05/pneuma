/**
 * 插件 bundle 的构建：把 `src/plugins/<id>/ui.tsx` 打成 `lib/ui/plugins/<id>/client.js`
 * （注册进全局工厂表的 CommonJS 工厂），并写一份 `manifest.json` 说明有哪些插件、依赖谁。
 *
 * 为什么是 CJS 工厂而不是 ESM：插件 bundle 在页面里由加载器交给一个受控的 `require`
 * 执行（见 `src/boot.ts`），这样 React 与 `@dsc/ui` 由壳提供而不是各带一份
 * ——两份 React 会让 hooks 直接崩。dsh 的客户端插件也是同一个形状。
 *
 * 为什么产物外面包一层 `(globalThis.__DSC_UI_FACTORIES__ ||= {})[id] = function (...)`
 * 而不是让加载器 `new Function(code)`：后者要求页面放开 `unsafe-eval`，
 * 一旦给页面加 CSP 所有插件会同时失效，而且报错来自浏览器安全策略、不进我们的诊断。
 *
 * 每个插件目录**必须**有 `package.json`：`peerDependencies['@dsc/ui']` 是它面对的契约区间，
 * 构建时写进清单条目的 `api`（宿主拿它做 semver 门禁，内置条目同样逐条判）。可选：再放一个
 * `plugin.json` 声明 `inject` / `immediately` / `external` / `platforms`（两种文件并存）。
 *
 * @module dsc-ui-shell/build-plugins
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { satisfies, validRange } from 'semver'
import { build } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const srcDir = join(root, 'src', 'plugins')
const outRoot = resolve(root, '..', 'lib', 'ui', 'plugins')
const stageRoot = `${outRoot}.staging`

/**
 * 壳内包名 → 源码落点，单一事实源是 `packages.json`（vite 侧同读，`tsconfig` 的 paths
 * 读不了 JSON 只能手抄，漂移由 `scripts/ui-plugin-test.mjs` 钉住）。为什么不再各写一份
 * alias：多一个包就多一处会漏改的地方，而漏改的表现是运行期解析出两份实现。
 */
const PACKAGES = JSON.parse(readFileSync(join(root, 'packages.json'), 'utf8'))
const alias = Object.fromEntries(
  Object.entries(PACKAGES).map(([name, rel]) => [name, resolve(root, rel)]),
)

/**
 * 插件面对的 `@dsc/ui` 契约版本：本包的 version，也是清单顶层 apiVersion。
 * 构建期拿它先判一遍每个插件的 peer 区间——内置插件被自己的门禁拦下就是全量失效。
 */
const shellVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

/**
 * 由壳提供的模块：插件 bundle 里对它们的引用保持原样，运行期从白名单表取。
 *
 * 这份表与运行期那张（`src/boot.ts` 的 `MODULES`）必须一模一样，所以两者同读
 * `platform-modules.json`；任何一边单独改动都会在这里当场构建失败。
 */
const PLATFORM_MODULES = JSON.parse(readFileSync(join(root, 'src', 'platform-modules.json'), 'utf8'))

/**
 * 额外保持外部化、但**故意不给**插件的那一个：`@dsc/ui-core` 是壳的内部实现。
 * 只当类型用（`import type`）时构建期会被抹掉，不影响；一旦当**值**用，
 * 保留成 require 就会在运行期得到一句「白名单外的模块」，比静默内联一份私有实现好查。
 */
const EXTERNAL = [...PLATFORM_MODULES, '@dsc/ui-core']

/** 工厂注册用的全局名（与 `src/boot.ts` 的 `FACTORY_GLOBAL` 同一个）。 */
const FACTORY_GLOBAL = '__DSC_UI_FACTORIES__'

/**
 * 读一个插件目录的元数据：`package.json` 的 peer 区间 → 清单 `api`，与可选的
 * `plugin.json` 并成一份（写坏了就报错——清单错一半比没有更糟）。
 */
function readMeta(dir) {
  const pkgFile = join(dir, 'package.json')
  if (!existsSync(pkgFile)) {
    throw new Error(
      `${pkgFile} 不存在：每个插件目录都必须有 package.json（写 name / version / peerDependencies['@dsc/ui']）`,
    )
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  } catch (error) {
    throw new Error(`${pkgFile} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
  }
  const rawPeer =
    pkg !== null && typeof pkg === 'object' ? (pkg.peerDependencies ?? {})['@dsc/ui'] : undefined
  if (typeof rawPeer !== 'string' || rawPeer.trim() === '') {
    throw new Error(
      `${pkgFile} 的 peerDependencies['@dsc/ui'] 缺失或不是非空字符串（要写 semver 区间，如「^1.1.0」）——清单的 api 字段从它读`,
    )
  }
  const api = rawPeer.trim()
  if (validRange(api) === null) {
    throw new Error(
      `${pkgFile} 的 peerDependencies['@dsc/ui']「${api}」不是合法的 semver 区间（要像 ^1.1.0 / 1.x 这样）`,
    )
  }
  if (!satisfies(shellVersion, api, { includePrerelease: true })) {
    throw new Error(
      `${pkgFile}: 声明的 @dsc/ui 区间「${api}」不满足本壳 ${shellVersion}` +
        '——内置插件是同一份构建产物，被自己的门禁拦下等于全量失效',
    )
  }
  const meta = { api }
  const file = join(dir, 'plugin.json')
  if (!existsSync(file)) return meta
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  if (doc.api !== undefined) {
    throw new Error(
      `${dir}/plugin.json 声明了 api——内置插件的 @dsc/ui 区间唯一来源是 package.json 的 peerDependencies`,
    )
  }
  if (doc.inject !== undefined) {
    if (!Array.isArray(doc.inject) || doc.inject.some((v) => typeof v !== 'string')) {
      throw new Error(`${dir}/plugin.json 的 inject 必须是字符串数组`)
    }
    meta.inject = doc.inject
  }
  if (doc.external !== undefined) {
    if (!Array.isArray(doc.external) || doc.external.some((v) => typeof v !== 'string')) {
      throw new Error(`${dir}/plugin.json 的 external 必须是字符串数组`)
    }
    const unknown = doc.external.filter((name) => !PLATFORM_MODULES.includes(name))
    if (unknown.length > 0) {
      throw new Error(
        `${dir}/plugin.json 声明了壳不提供的模块：${unknown.join('、')}` +
          `（壳提供的只有：${PLATFORM_MODULES.join('、')}）`,
      )
    }
    meta.external = doc.external
  }
  if (doc.immediately !== undefined) {
    if (doc.immediately !== true) throw new Error(`${dir}/plugin.json 的 immediately 只能是 true`)
    meta.immediately = true
  }
  if (doc.platforms !== undefined) {
    // 阶段 6 起，载体无关的插件声明 `platforms: ['web', 'tui']`：产物构建一次，
    // 清单里出两条（platform web + tui，同一个 client.js）——两种壳各自的
    // collect 按 platform 过滤，互不干扰；require('@dsc/ui') 由各自的表解析。
    if (!Array.isArray(doc.platforms) || doc.platforms.some((v) => v !== 'web' && v !== 'tui')) {
      throw new Error(`${dir}/plugin.json 的 platforms 只能是 'web' / 'tui' 的数组`)
    }
    meta.platforms = doc.platforms
  }
  return meta
}

const ids = readdirSync(srcDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const missingEntry = ids.filter((id) => !existsSync(join(srcDir, id, 'ui.tsx')))
if (missingEntry.length > 0) {
  console.error(`[build-plugins] 这些插件目录里没有 ui.tsx：${missingEntry.join('、')}（目录存在就该有入口）`)
  process.exit(1)
}

if (ids.length === 0) {
  console.error('[build-plugins] src/plugins 下没有找到任何插件（缺 ui.tsx？）')
  process.exit(1)
}

// 元数据先全部读完再动手构建：缺 package.json / 区间写坏要立刻失败——不能先花一轮
// vite 构建再报，更不能产出一份「宿主门禁会把自家内置插件拦掉」的清单。
const metas = new Map()
for (const id of ids) {
  try {
    metas.set(id, readMeta(join(srcDir, id)))
  } catch (error) {
    console.error(`[build-plugins] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

// 先全部构建到暂存目录，最后一次性换上去：构建到一半失败时，旧产物与旧清单仍然完整，
// 宿主不会看到「清单说有这个插件、目录里却已经空了」这种半截状态。
rmSync(stageRoot, { recursive: true, force: true })

const plugins = []
for (const id of ids) {
  const outDir = join(stageRoot, id)
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    plugins: [react()],
    resolve: { alias },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      sourcemap: false,
      lib: { entry: join(srcDir, id, 'ui.tsx'), formats: ['cjs'], fileName: () => 'client' },
      rollupOptions: {
        external: EXTERNAL,
        output: {
          exports: 'named',
          // lib 模式默认按 format 加后缀（type: module 的包会写成 .cjs）；
          // 宿主按 `client.js` 找文件，这里显式钉死扩展名。
          entryFileNames: 'client.js',
          assetFileNames: '[name][extname]',
        },
      },
    },
  })
  const target = join(outDir, 'client.js')
  const code = readFileSync(target, 'utf8')
  writeFileSync(
    target,
    `(globalThis.${FACTORY_GLOBAL} ??= {})[${JSON.stringify(id)}] = function (require, module, exports) {\n${code}};\n`,
    'utf8',
  )
  const meta = metas.get(id)
  const platforms = meta.platforms ?? ['web']
  delete meta.platforms
  // 载体无关的插件出两条清单行（同一份 client.js）；每行都带 platform，
  // 宿主与终端壳各自按自己的载体取（collectUiPluginArtifacts 按 platform 过滤）。
  for (const platform of platforms) {
    plugins.push({ id, file: 'client.js', platform, ...meta })
  }
  console.log(`[build-plugins] ${id} → lib/ui/plugins/${id}/client.js（${platforms.join(' + ')}）`)
}

/** 宿主只读这份清单（见 `src/core/ui-bundles.ts`）。 */
// 顶层 apiVersion = 插件面对的 `@dsc/ui` 契约版本（即本包的 version，1.0.0 起）。
// 宿主拿它对条目逐条做 semver 门禁：内置条目也带 api（各自 package.json 的 peer 区间，
// 上面已用 satisfies 验过），第三方条目必须自带 api 区间。升级纪律见
// docs/plugin-development.md：删导出、改语义、改槽位 options 形状 = 主版本 +1；纯增量 = 次版本 +1。
writeFileSync(
  join(stageRoot, 'manifest.json'),
  `${JSON.stringify({ version: 1, apiVersion: shellVersion, plugins }, null, 2)}\n`,
  'utf8',
)

rmSync(outRoot, { recursive: true, force: true })
renameSync(stageRoot, outRoot)
console.log(`[build-plugins] manifest.json：${plugins.map((plugin) => plugin.id).join('、')}`)
