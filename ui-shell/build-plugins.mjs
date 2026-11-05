/**
 * 插件 bundle 的构建：把界面半的入口 `ui.tsx` 打成 `lib/ui/plugins/<id>/client.js`
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
 * 每个界面半**必须**声明它面对的契约区间：宿主包写在 `package.json` 的 `pneuma.client.api`
 * （一个包两半边），旧界面包写在 `peerDependencies['@dsc/ui']`。构建时写进清单条目的 `api`
 * （宿主拿它做 semver 门禁，内置条目同样逐条判）。其余字段（`inject` / `immediately` /
 * `external` / `platforms` / `phase`）也都在 `pneuma.client` 里声明，不再认 `plugin.json`。
 *
 * @module dsc-ui-shell/build-plugins
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { satisfies, validRange } from 'semver'
import { build } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
// 界面半边的源码有两个扫描根，新根优先、旧根兜底：
//   新：src/packages/<目录>/ui/          —— 目录名有两种形状，都算新根：
//       · <id>      宿主包自带界面半（一个包两半边，共用一个 package.json）
//       · ui-<id>   独立界面包（纯界面单元，宿主半是空 apply）
//   旧：ui-shell/src/packages/ui-<id>/  —— 迁移期的兜底根（19 个内置单元已全部搬走，这里现在是空的）
// **产物目录与 id 一律不动**：id 决定 lib/ui/plugins/<id>，也是启动图条目与停用记录里的身份。
// 搬源码只搬源码，产物路径一改等于换了个插件——所以 ui-transcript 的产物仍是
// lib/ui/plugins/transcript/client.js，与它当宿主包半边时逐字节相同。
const repoRoot = resolve(root, '..')
const hostPackagesDir = join(repoRoot, 'src', 'packages')
const legacyPackagesDir = join(root, 'src', 'packages')
const outRoot = join(repoRoot, 'lib', 'ui', 'plugins')
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
 * 这份表与运行期那张（`src/packages/ui-boot/ui/boot.ts` 的 `MODULES`）必须一模一样，
 * 所以两者同读 `platform-modules.json`；任何一边单独改动都会在这里当场构建失败。
 * 表随引导（`ui-boot`）走：引导是装载内核的家，渲染器只消费它。
 */
const PLATFORM_MODULES = JSON.parse(
  readFileSync(join(root, '..', 'src', 'packages', 'ui-boot', 'ui', 'platform-modules.json'), 'utf8'),
)

/**
 * 额外保持外部化、但**故意不给**插件的那一个：`@dsc/ui-core` 是壳的内部实现。
 * 只当类型用（`import type`）时构建期会被抹掉，不影响；一旦当**值**用，
 * 保留成 require 就会在运行期得到一句「白名单外的模块」，比静默内联一份私有实现好查。
 */
const EXTERNAL = [...PLATFORM_MODULES, '@dsc/ui-core']

/**
 * `<包名>/client` 与 `<包名>` 是同一条插件：bundle 就是包的界面半（与 dsh 的
 * `stripClientSuffix` 同口径，运行期 `src/packages/ui-boot/ui/boot.ts` 用同一份实现）。
 * @param spec - 模块名或插件 id
 */
const stripClientSuffix = (spec) => (spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec)

/**
 * 每个插件实际的外部化清单：只有**一个例外**——布局插件（id `layout`）要把
 * `@dsc/ui-layout` 的实现内联进自己的 bundle，那正是它的产物存在的意义（停用就真的省掉
 * 那块代码）。其余插件若引用 `@dsc/ui-layout`，留成 require 会在运行期撞「白名单外的模块」，
 * 构建末尾那条断言会先把它拦在构建这一步。
 * @param id - 产物 id
 */
const externalOf = (id) =>
  id === 'layout' ? EXTERNAL.filter((name) => name !== '@dsc/ui-layout') : [...EXTERNAL, '@dsc/ui-layout']

/**
 * 不许出现第二份 React。图里这些模块本身是 external（不会被打进 bundle），但界面半搬到
 * `src/packages/<id>/ui/` 之后，import 的解析起点从 ui-shell 变成了仓库根：pnpm workspace
 * 下两边各有一份 react 时，解析会落到两个不同路径。把解析钉回壳那一份，防的是那件事。
 */
const DEDUPE = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']

/** 工厂注册用的全局名（与 `src/boot.ts` 的 `FACTORY_GLOBAL` 同一个）。 */
const FACTORY_GLOBAL = '__DSC_UI_FACTORIES__'

/**
 * 读一个界面半的元数据：界面契约区间 → 清单 `api`，载体声明 → inject / phase / …
 *
 * 声明有两处来源，按源码落点选：
 *   - 新根（`src/packages/<id>/` 一个包两半边，或 `src/packages/ui-<id>/` 独立界面包）：
 *     读包自己的 package.json，`pneuma.client` 是唯一声明处，`api` 从 `pneuma.client.api` 读
 *     （与组合包、第三方同一套字段）；`peerDependencies['@dsc/ui']` 可写可不写，
 *     写了就必须与它一致。
 *   - 旧界面包（`ui-shell/src/packages/ui-<id>/`）：仍按 2.0 的读法，
 *     `peerDependencies['@dsc/ui']` 是 api 区间，`pneuma.client` 可选。
 *
 * 写坏了就报错——清单错一半比没有更糟。
 * @param dir - 声明所在目录（宿主包根 / 旧界面包根）
 * @param hostHalf - true = 宿主包里的界面半边
 */
function readMeta(dir, hostHalf) {
  const pkgFile = join(dir, 'package.json')
  if (!existsSync(pkgFile)) {
    throw new Error(
      `${pkgFile} 不存在：界面半的声明必须写在自己的 package.json 里（pneuma.client 或 peerDependencies['@dsc/ui']）`,
    )
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  } catch (error) {
    throw new Error(`${pkgFile} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
  }
  const record = pkg !== null && typeof pkg === 'object' ? pkg : {}
  /** 报错里点名的那个名字：包名优先，没写就退回落点目录（不会指到别人头上）。 */
  const owner = typeof record.name === 'string' && record.name !== '' ? record.name : dir
  const rawPeer = (record.peerDependencies ?? {})['@dsc/ui']
  // 两处都认：我们自己那 19 个界面包写 pneuma.client，真实 dsh 生态写 pneuma.client。
  const declaredClient = record.pneuma?.client ?? record.dsh?.client
  /** 区间来自哪一处：报错时要指得准，不然作者会去改错文件。 */
  let api
  let apiWhere
  if (hostHalf === true) {
    // 宿主包：pneuma.client 是唯一声明处，缺了不能猜、也不能回落到目录名。
    if (declaredClient === null || typeof declaredClient !== 'object') {
      throw new Error(
        `${pkgFile} 没有 pneuma.client：宿主包的界面半边靠它声明` +
          `（至少写 { platform: 'pneuma', api: '^0.8.1' }）`,
      )
    }
    if (typeof declaredClient.api !== 'string' || declaredClient.api.trim() === '') {
      throw new Error(
        `${pkgFile} 的 pneuma.client.api 缺失或不是非空字符串（要写 semver 区间，如「^0.8.1」）——清单的 api 字段从它读`,
      )
    }
    api = declaredClient.api.trim()
    apiWhere = "pneuma.client.api"
    if (typeof rawPeer === 'string' && rawPeer.trim() !== '' && rawPeer.trim() !== api) {
      throw new Error(
        `${pkgFile}: peerDependencies['@dsc/ui']「${rawPeer.trim()}」与 pneuma.client.api「${api}」不一致（一处声明就够，两处会分叉）`,
      )
    }
  } else {
    if (typeof rawPeer !== 'string' || rawPeer.trim() === '') {
      throw new Error(
        `${pkgFile} 的 peerDependencies['@dsc/ui'] 缺失或不是非空字符串（要写 semver 区间，如「^1.1.0」）——清单的 api 字段从它读`,
      )
    }
    api = rawPeer.trim()
    apiWhere = "peerDependencies['@dsc/ui']"
  }
  if (validRange(api) === null) {
    throw new Error(
      `${pkgFile} 的 ${apiWhere}「${api}」不是合法的 semver 区间（要像 ^1.1.0 / 1.x 这样）`,
    )
  }
  if (!satisfies(shellVersion, api, { includePrerelease: true })) {
    throw new Error(
      `${pkgFile}: 声明的 @dsc/ui 区间「${api}」不满足本壳 ${shellVersion}` +
        '——内置插件是同一份构建产物，被自己的门禁拦下等于全量失效',
    )
  }
  const meta = { api }
  // 2.0 起，界面半在**自己的 package.json** 里用 `pneuma.client` 声明——与组合包
  // （profile 里装的第三方包）同一套字段。声明了它就不再读 plugin.json：一个插件只有
  // 一处声明，两处并存迟早会分叉。
  if (declaredClient !== undefined) {
    if (declaredClient === null || typeof declaredClient !== 'object') {
      throw new Error(`${pkgFile} 的 pneuma.client 必须是对象（platform / api / phase / inject / services）`)
    }
    const client = declaredClient
    if (client.platform !== 'pneuma') {
      throw new Error(
        `${pkgFile} 的 pneuma.client.platform 必须是 'pneuma'（内置插件就是我们的界面半；` +
          `收到 ${JSON.stringify(client.platform)}）`,
      )
    }
    if (client.api !== undefined && client.api !== api) {
      throw new Error(`${pkgFile}: pneuma.client.api 与 peerDependencies['@dsc/ui'] 不一致（一处声明就够，两处会分叉）`)
    }
    const legacy = join(dir, 'plugin.json')
    if (existsSync(legacy)) {
      throw new Error(`${dir}: 同时有 pneuma.client 与 plugin.json——2.0 起只认 package.json 里那一处声明`)
    }
    return applyExtraFields(meta, client, pkgFile, owner)
  }
  // 2.0 起一个插件只许有一处声明。19 个内置插件已全部迁进 package.json 的 pneuma.client，
  // 再见到 plugin.json 就是没迁干净（或者有人照着旧文档加回来的）。
  if (existsSync(join(dir, 'plugin.json'))) {
    throw new Error(
      `${dir}: 2.0 起不再支持 plugin.json——把 phase / inject / services / external / platforms 搬进 ` +
        'package.json 的 pneuma.client（一个插件一处声明）',
    )
  }
  return meta
}

/**
 * 把界面半的附加声明并进清单条目。
 *
 * 两个来源共用这一份校验：2.0 起是 `package.json` 的 `pneuma.client`（与组合包同一套字段），
 * 旧的是 `plugin.json`。字段名一样，报错里指的位置不同——`where` 就是那个位置。
 * @param meta - 已经带 api 的条目
 * @param doc - 声明来源
 * @param where - 报错里写的位置（文件路径）
 * @param owner - 报错里点名的包名（external 那一句要写清是谁声明错了）
 */
function applyExtraFields(meta, doc, where, owner) {
  // inject = 依赖的**插件 id**；services = 依赖的**服务名**（2.0 起分开，不再双关）。
  if (doc.inject !== undefined) {
    if (!Array.isArray(doc.inject) || doc.inject.some((v) => typeof v !== 'string')) {
      throw new Error(`${where} 的 inject 必须是字符串数组（依赖的插件 id）`)
    }
    meta.inject = doc.inject
  }
  if (doc.services !== undefined) {
    if (!Array.isArray(doc.services) || doc.services.some((v) => typeof v !== 'string')) {
      throw new Error(`${where} 的 services 必须是字符串数组（依赖的服务名）`)
    }
    meta.services = doc.services
  }
  if (doc.external !== undefined) {
    if (!Array.isArray(doc.external) || doc.external.some((v) => typeof v !== 'string')) {
      throw new Error(`${where} 的 external 必须是字符串数组`)
    }
    // 合法来历只有两种：平台种子（壳里静态持有那一份实例），或本图里另一条插件（它的 bundle
    // 就是包的界面半，运行期 require 到的是那条已物化的导出）。两档都不是，说明作者把一份依赖
    // 留成了 require 而没人提供——当场失败，别等运行期那句「既不是平台种子，也不是本图的插件」。
    const allowed = new Set([...PLATFORM_MODULES, ...ids])
    const unknown = doc.external.filter((name) => !allowed.has(name) && !allowed.has(stripClientSuffix(name)))
    if (unknown.length > 0) {
      throw new Error(
        unknown
          .map(
            (name) =>
              `${owner}: pneuma.client.external 里的 "${name}" 既不是平台种子，也不是本图的插件` +
                '——插件打包时把它内联进来，或改用种子里的模块',
          )
          .join('；'),
      )
    }
    meta.external = doc.external
  }
  if (doc.immediately !== undefined) {
    if (doc.immediately !== true) throw new Error(`${where} 的 immediately 只能是 true`)
    meta.immediately = true
  }
  // phase：调度档位（`early` = 首屏批，装完壳才画第一帧；缺省 application）。
  // readMeta 静默忽略未知键——写错一个 `phse` 会毫无反应；这条校验把「拼错」变成构建失败。
  if (doc.phase !== undefined) {
    if (doc.phase !== 'early' && doc.phase !== 'application') {
      throw new Error(`${where} 的 phase 只能是 'early' / 'application'`)
    }
    meta.phase = doc.phase
  }
  if (doc.platforms !== undefined) {
    // 阶段 6 起，载体无关的插件声明 `platforms: ['web', 'tui']`：产物构建一次，
    // 清单里出两条（platform web + tui，同一个 client.js）——两种壳各自的
    // collect 按 platform 过滤，互不干扰；require('@dsc/ui') 由各自的表解析。
    if (!Array.isArray(doc.platforms) || doc.platforms.some((v) => v !== 'web' && v !== 'tui')) {
      throw new Error(`${where} 的 platforms 只能是 'web' / 'tui' 的数组`)
    }
    meta.platforms = doc.platforms
  }
  return meta
}

/**
 * 宿主包目录名 → 产物 id 的映射口子。
 *
 * 内置这批的旧 id 与宿主包目录同名，所以表里只登记「名字实在对不上」的例外。将来若出现
 * 这种包，在这里登记一行：id 一改，产物目录、启动图条目、用户停用记录全部跟着变，
 * 所以只许显式登记，不许按命名规则猜。
 */
const HOST_ID_OVERRIDES = new Map()

/** 旧界面包目录名 → 产物 id：ui-browser → browser（清单 id 与 0.8 一致，宿主不用改发现逻辑）。 */
const dirToId = (name) => name.slice('ui-'.length)

/**
 * 新根里一个**目录名** → 产物 id。
 *
 * 新根现在收两种目录：宿主包自带的 `<id>`（id 就是目录名）与独立界面包 `ui-<id>`
 * （id 要剥掉 `ui-` 前缀）。两者共用同一个「id ≠ 目录名」的换算口子——独立界面包与旧根
 * 的 ui-<id> 是同一条规则，不另造一套，否则同一个界面单元会因为源码住在哪个根而改名，
 * 产物目录、启动图条目与用户的停用记录会跟着一起换。
 * @param name - `src/packages/` 下的目录名
 */
const hostIdOf = (name) => HOST_ID_OVERRIDES.get(name) ?? (name.startsWith('ui-') ? dirToId(name) : name)

/**
 * 扫两个根，得到「这次要构建哪些界面半」。
 *
 * 新根优先：同一个 id 在两边都有时用新根，并打一行提示（迁移只该是「一边有」，
 * 两边都有就是搬完没删旧目录）。旧根等 19 个包迁完可以整个删掉。
 * 旧根仍守着老规矩：`ui-*` 目录存在就必须有 `ui.tsx`（缺了说明目录建早了）。
 * @returns {{ plugins: {id: string, entry: string, metaDir: string, hostHalf: boolean}[], missingEntry: string[] }}
 */
function discover() {
  const found = new Map()
  // 1) 新根：src/packages/<目录>/ui/ui.tsx —— 两种目录都在这里认：
  //    <id>（宿主包自带的界面半边）与 ui-<id>（独立界面包）。
  //    宿主包没有 ui/ 是常态（五十多个包只有宿主半），所以这里不看目录名开头，只看有没有入口；
  //    id 由 hostIdOf 换算，与旧根同一条 `ui-` 剥离规则。
  if (existsSync(hostPackagesDir)) {
    const names = readdirSync(hostPackagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const name of names) {
      const entryFile = join(hostPackagesDir, name, 'ui', 'ui.tsx')
      if (!existsSync(entryFile)) continue
      const id = hostIdOf(name)
      const existing = found.get(id)
      if (existing !== undefined) {
        // 同一个 id 在新根里有两份源码（`<id>/ui` 与 `ui-<id>/ui`）：那是搬完没删旧的一边。
        // 取排序在前的那份并当场报出来——静默二选一，作者会对着没生效的那份改半天。
        console.log(
          `[build-plugins] ${id}：新根里有两份源码 ${relative(repoRoot, existing.entry).split('\\').join('/')} 与 `
            + `${relative(repoRoot, entryFile).split('\\').join('/')}，用前者（另一个该删掉）`,
        )
        continue
      }
      found.set(id, { id, entry: entryFile, metaDir: join(hostPackagesDir, name), hostHalf: true })
    }
  }
  // 2) 旧根兜底：ui-shell/src/packages/ui-<id>/ui.tsx（内置单元已全部搬走，留着这段兼容旧检出）。
  const missingEntry = []
  if (existsSync(legacyPackagesDir)) {
    for (const entry of readdirSync(legacyPackagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('ui-')) continue
      const entryFile = join(legacyPackagesDir, entry.name, 'ui.tsx')
      if (!existsSync(entryFile)) {
        missingEntry.push(entry.name)
        continue
      }
      const id = dirToId(entry.name)
      const existing = found.get(id)
      if (existing !== undefined) {
        console.log(
          `[build-plugins] ${id}：新根已有 ${relative(repoRoot, existing.entry).split('\\').join('/')}，` +
            `忽略旧根 ${entry.name}（搬完就该删掉旧目录）`,
        )
        continue
      }
      found.set(id, { id, entry: entryFile, metaDir: join(legacyPackagesDir, entry.name), hostHalf: false })
    }
  }
  const plugins = [...found.values()].sort((a, b) => a.id.localeCompare(b.id))
  return { plugins, missingEntry }
}

const { plugins, missingEntry } = discover()

if (missingEntry.length > 0) {
  console.error(`[build-plugins] 这些旧界面包里没有 ui.tsx：${missingEntry.join('、')}（目录存在就该有入口）`)
  process.exit(1)
}

if (plugins.length === 0) {
  console.error('[build-plugins] 两个扫描根下都没有找到界面半（src/packages/<id>/ui/ui.tsx 或 ui-<id>/ui.tsx）')
  process.exit(1)
}

const ids = plugins.map((plugin) => plugin.id)

// 元数据先全部读完再动手构建：缺声明 / 区间写坏要立刻失败——不能先花一轮
// vite 构建再报，更不能产出一份「宿主门禁会把自家内置插件拦掉」的清单。
const metas = new Map()
for (const plugin of plugins) {
  try {
    metas.set(plugin.id, readMeta(plugin.metaDir, plugin.hostHalf))
  } catch (error) {
    console.error(`[build-plugins] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

// 先全部构建到暂存目录，再**逐文件比对后落盘**：构建到一半失败时旧产物完整
// （暂存目录还没动），成功时也只有字节真的变了的文件才被重写。
rmSync(stageRoot, { recursive: true, force: true })

const bundles = []
for (const plugin of plugins) {
  const id = plugin.id
  const outDir = join(stageRoot, id)
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    plugins: [react()],
    resolve: { alias, dedupe: DEDUPE },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      sourcemap: false,
      lib: { entry: plugin.entry, formats: ['cjs'], fileName: () => 'client' },
      rollupOptions: {
        external: externalOf(id),
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
  // 硬断言：产物里不许留这两种 require。它们都只在运行期才炸，报错也指不到构建这一步。
  //   `@dsc/ui-core` —— 故意不给插件（撞「白名单外的模块」）；
  //   `@dsc/ui-layout` —— 只有布局插件自己的 bundle 内联它，别的 bundle 引用就是错的。
  for (const banned of ['@dsc/ui-core', '@dsc/ui-layout']) {
    if (!externalOf(id).includes(banned)) continue
    if (!code.includes(`require("${banned}")`)) continue
    console.error(
      `[build-plugins] ${id} 的产物里有 require("${banned}")：这个模块不提供给插件构造。` +
        '改从 @dsc/ui / @dsc/ui-runtime 取，或把实现搬进自己的包。',
    )
    process.exit(1)
  }
  writeFileSync(
    target,
    `(globalThis.${FACTORY_GLOBAL} ??= {})[${JSON.stringify(id)}] = function (require, module, exports) {\n${code}};\n`,
    'utf8',
  )
  const meta = metas.get(id)
  const platforms = meta.platforms ?? ['web']
  delete meta.platforms
  // 每个插件目录一份自述（2.0 起一个插件一处声明）：载体写成数组，一份产物出几行由
  // 自述决定，宿主扫目录时按它铺开（`src/core/ui-bundles.ts` 的 readBundleDeclarations）。
  bundles.push({ id, text: `${JSON.stringify({ apiVersion: shellVersion, file: 'client.js', platforms, ...meta }, null, 2)}\n` })
  // 日志里带上源码落点：迁完之后还能一眼看出这条产物是从哪个根打出来的。
  console.log(
    `[build-plugins] ${id} ← ${relative(repoRoot, plugin.entry).split('\\').join('/')}`
      + ` → lib/ui/plugins/${id}/{client.js,bundle.json}（${platforms.join(' + ')}）`,
  )
}

/**
 * 根清单元数据（2.0 起**只写壳契约版本**，不再列插件）。
 *
 * 顶层 apiVersion = 插件面对的 `@dsc/ui` 契约版本（即本包的 version）。宿主拿它给第三方与
 * 组合包的声明做 semver 门禁；内置产物自己那份自述里也带着同一个值（根文件缺了就从那里取）。
 * 升级纪律见 docs/plugin-development.md：删导出、改语义、改槽位 options 形状 = 主版本 +1；
 * 纯增量 = 次版本 +1。
 */
const manifestText = `${JSON.stringify({ version: 1, apiVersion: shellVersion }, null, 2)}\n`

// 落盘：**字节没变就不动文件**。
//
// 为什么不能像以前那样 rm outRoot + rename staging：那会把 16 个 client.js 全部重写，
// mtime/ctime 全变。A3 起内置 rev 已是内容摘要（mtime 变了 rev 也不变），
// 但「写盘也稳定」是第二道保险：开发态热更、编辑器/杀毒的文件监听、
// 以及将来任何按 mtime 判断变化的工具都因此看到一份安静的文件树。
let written = 0
let kept = 0
if (existsSync(outRoot)) {
  const known = new Set(ids)
  for (const entry of readdirSync(outRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !known.has(entry.name)) {
      rmSync(join(outRoot, entry.name), { recursive: true, force: true })
      console.log(`[build-plugins] 移除已不存在的插件产物：${entry.name}`)
    }
  }
}
for (const id of ids) {
  const staged = readFileSync(join(stageRoot, id, 'client.js'))
  const target = join(outRoot, id, 'client.js')
  const existing = existsSync(target) ? readFileSync(target) : null
  mkdirSync(join(outRoot, id), { recursive: true })
  if (existing !== null && existing.equals(staged)) {
    kept += 1
  } else {
    writeFileSync(target, staged)
    written += 1
  }
  // 自述也走同一道「字节没变就不动」：一份安静的文件树，HMR 才不会假换代。
  const bundle = bundles.find((item) => item.id === id)
  const bundlePath = join(outRoot, id, 'bundle.json')
  const existingBundle = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : null
  if (bundle !== undefined && existingBundle !== bundle.text) {
    writeFileSync(bundlePath, bundle.text, 'utf8')
    written += 1
  }
}
const manifestPath = join(outRoot, 'manifest.json')
const existingManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
if (existingManifest !== manifestText) writeFileSync(manifestPath, manifestText, 'utf8')
rmSync(stageRoot, { recursive: true, force: true })
console.log(
  `[build-plugins] 每份产物自述 bundle.json（${String(bundles.length)} 份）；manifest.json 只写壳契约版本 ${shellVersion}`
  + `（重写 ${String(written)} 份，字节未变保留 ${String(kept)} 份）`,
)
