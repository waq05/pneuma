/**
 * 包依赖方向图：两个门禁（plugin-model-check 与 plugin-standard-check）共用的一套判据，
 * 外加一个能单独跑的入口 `node scripts/plugin-dep-graph.mjs`。
 *
 * 为什么要抽出来：同一件事判两遍，最怕两处口径慢慢分叉——一个门禁绿、另一个红，
 * 谁也不知道该信哪个。这里同时收口四样东西：
 *
 *   - 包名索引：说明符 `@pneuma/<name>` 指向哪个源包，那个包是功能包还是库包；
 *   - 扫描口径：哪些文件算源码、四种静态 import 写法；
 *   - 相对路径解析：`./` / `../` 先落成真实文件（`.js` → `.ts` / `.tsx`、目录 → `index.ts`），
 *     再按「文件属于哪一层、哪个包」归类；
 *   - 判定文案：功能包 → 库包允许；功能包 → 功能包、库包 → 任何包、core → 任何包
 *     都算越界（`import type` 也是静态依赖，一并算）。
 *
 * 2026-11-09 补的盲区：此前四条正则只认 `@pneuma/...`，58 个 core→packages 转发垫片
 * 全用相对路径写（`export * from '../packages/...'`），一条都匹配不上，门禁全绿。
 * 现在相对说明符与裸说明符走同一套判据；命令行入口另加两条硬规则：
 *
 *   - `src/core/**` 不许用相对路径 import `src/packages/**`；
 *   - `src/services/**` 不许用相对路径 import `src/packages/**`（类型可走 `src/contract`）。
 *
 * 改这里等于同时改两个门禁——不要在两个门禁里再各写一份判据。
 *
 * @module scripts/plugin-dep-graph
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 源码扩展名：只扫 TS 家族（界面半的 tsx 也算）。 */
export const SOURCE_TS = /\.(?:ts|tsx|mts|cts)$/

/** 更宽的源码集：标准闸的「模块级可变状态」待办要把 .js 也扫进来。 */
export const SOURCE_ALL = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** 四种静态依赖写法。 */
export const IMPORT_PATTERNS = [
  /(?:^|\s)(?:import|export)\b[^\n]*?from\s*['"](@pneuma\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](@pneuma\/[^'"]+)['"]/g,
  /^\s*import\s+['"](@pneuma\/[^'"]+)['"]/gm,
  /\brequire\s*\(\s*['"](@pneuma\/[^'"]+)['"]/g,
]

/** 相对说明符的四种静态写法，与 {@link IMPORT_PATTERNS} 一一对应。 */
export const RELATIVE_IMPORT_PATTERNS = [
  /(?:^|\s)(?:import|export)\b[^\n]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm,
  /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]/g,
]

/**
 * 相对说明符解析出来算不算「代码依赖」。
 *
 * 样式表与 JSON 也常用相对路径引，但它们不构成包与包之间的模块依赖
 * （实测有 6 条 `ui-boot` → `ui-renderer` 的 CSS 引），算进来就是误报。
 */
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/**
 * 说明符写 `.js`、源文件其实是 TS 的映射（NodeNext 的写法）。
 *
 * 先试 TS 那一份、再试字面那一份：仓库里的源码一律是 `.ts` / `.tsx`，
 * 所以 `./PickerFrame.js` 要落到 `PickerFrame.tsx`。
 */
const JS_TO_TS = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
])

/** 层的机器名 → 报告里的称呼。 */
export const LAYER_LABELS = {
  core: 'core',
  services: 'services',
  contract: 'contract',
  package: '包',
  'ui-shell': 'ui-shell',
  desktop: 'desktop',
  src: 'src 根',
  other: '其它',
}

/** 一个层的称呼（报告与文案里用）。 */
export function layerLabel(layer) {
  return LAYER_LABELS[layer] ?? layer
}

/** 相对仓库根的路径（统一用 /，报告里可点）。 */
export function repoPath(root, file) {
  return relative(root, file).split('\\').join('/')
}

/** 从一段文本的字符下标算出 1 起的行号。 */
export function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/**
 * 递归列出目录里的源码。
 *
 * 跳过 `node_modules` / `lib` / `.git`：依赖与构建产物不是源包的代码，
 * 把它们算进来只会让「包与包之间」的判据变成看产物。
 * @param dir - 目录
 * @param pattern - 扩展名正则（缺省 {@link SOURCE_TS}）
 */
export function walkSources(dir, pattern = SOURCE_TS) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkSources(path, pattern))
    else if (pattern.test(entry.name)) out.push(path)
  }
  return out
}

/**
 * 一个文件属于哪一层、哪个包。
 *
 * 层级按仓库现状定：`src/core`（内核）、`src/services` 与 `src/contract`（契约层）、
 * `src/packages/<id>`（功能包 / 库包）、`ui-shell/src`（界面壳）、`desktop/electron`
 * （桌面主进程）。认不出的归 `other`，不参与跨层判定，只进统计。
 * @param root - 仓库根
 * @param file - 绝对路径
 */
export function layerOfPath(root, file) {
  const rel = repoPath(root, file)
  if (rel === '' || rel.startsWith('../')) return null
  const parts = rel.split('/')
  if (parts[0] === 'src') {
    if (parts[1] === 'core') return { layer: 'core', id: null }
    if (parts[1] === 'services') return { layer: 'services', id: null }
    if (parts[1] === 'contract') return { layer: 'contract', id: null }
    if (parts[1] === 'packages') return { layer: 'package', id: parts[2] ?? null }
    return { layer: 'src', id: null }
  }
  if (parts[0] === 'ui-shell' && parts[1] === 'src') return { layer: 'ui-shell', id: null }
  if (parts[0] === 'desktop' && parts[1] === 'electron') return { layer: 'desktop', id: null }
  return { layer: 'other', id: null }
}

/**
 * 把相对说明符解析成仓库里的真实文件；解析不到返回 null。
 *
 * 顺序按 TypeScript 的 NodeNext 习惯：带 `.js` 的先试 `.ts` / `.tsx`，再试字面那份；
 * 不带扩展名的按 `.ts` → `.tsx` → `.mts` → `.cts` → `.js` … → 目录 `index.*`。
 * 只认代码扩展名：CSS / JSON 之类不算依赖边。
 * @param file - 发起 import 的文件（绝对路径）
 * @param specifier - `./` 或 `../` 开头的说明符
 */
export function resolveRelativeModule(file, specifier) {
  // 去掉查询串与锚点：`./x.ts?raw` 这种只在打包器里成立，源码里按文件算。
  const clean = specifier.split('?')[0].split('#')[0]
  const base = resolve(dirname(file), clean)
  const extension = extname(base)
  const candidates = []
  if (extension === '') {
    for (const suffix of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) candidates.push(base + suffix)
    for (const suffix of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) candidates.push(join(base, 'index' + suffix))
  } else {
    for (const twin of JS_TO_TS.get(extension) ?? []) candidates.push(base.slice(0, -extension.length) + twin)
    candidates.push(base)
  }
  for (const candidate of candidates) {
    if (!CODE_FILE.test(candidate)) continue
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 不存在就试下一个候选
    }
  }
  return null
}

/**
 * 建一张依赖方向图。
 *
 * 包名以 `package.json` 的 `name` 为准；清单没写 name 时用目录名兜底，
 * 这样目录名与包名不一致的包（现在只有 runtime-adapter）也能被认出来。
 * @param options.root - 仓库根（报告里的相对路径以它为准）
 * @param options.packages - 功能包 `[{ id, dir, manifest }]`
 * @param options.libraries - 库包 `[{ id, dir, manifest }]`
 * @param options.pattern - 扫描扩展名（缺省 TS 家族）
 */
export function createPackageGraph(options) {
  const root = options.root
  const pattern = options.pattern ?? SOURCE_TS
  const byName = new Map()

  /** 登记一个包：清单 name 与目录名各一条键（目录名那条不覆盖已有的）。 */
  const register = (pkg, kind) => {
    const declared =
      typeof pkg.manifest?.name === 'string' && pkg.manifest.name !== '' ? pkg.manifest.name : null
    const entry = { id: pkg.id, dir: pkg.dir, manifest: pkg.manifest, kind }
    byName.set(declared ?? '@pneuma/' + pkg.id, entry)
    return entry
  }

  const features = (options.packages ?? []).map((pkg) => register(pkg, 'feature'))
  const libraries = (options.libraries ?? []).map((pkg) => register(pkg, 'library'))
  for (const entry of [...features, ...libraries]) {
    const fallback = '@pneuma/' + entry.id
    if (!byName.has(fallback)) byName.set(fallback, entry)
  }
  const entries = [...features, ...libraries]

  /**
   * 一个说明符指向哪个源包。
   *
   * `@pneuma/runtime/*` 是构建生成的适配包名（映射到 src/*），不是 src/packages 里的包，
   * 所以先排掉；其余按 scope 后的第一段找包。
   * @param specifier - import 说明符
   * @returns 源包条目；不是包或指向运行时包给 null
   */
  const targetOf = (specifier) => {
    if (!specifier.startsWith('@pneuma/')) return null
    if (specifier === '@pneuma/runtime' || specifier.startsWith('@pneuma/runtime/')) return null
    const parts = specifier.split('/')
    if (parts.length < 2 || parts[1] === '') return null
    return byName.get('@pneuma/' + parts[1]) ?? null
  }

  /**
   * 解析出来的文件落在哪个包。
   *
   * 按目录前缀匹配（取最长的那条，防嵌套）；清单坏掉、包没登记时按
   * `src/packages/<id>/` 的路径兜底认，宁可多报也不要让整层从门禁里消失。
   * @param file - 已经解析出的绝对路径
   */
  const packageAt = (file) => {
    let best = null
    for (const entry of entries) {
      const rel = relative(entry.dir, file)
      if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep))) {
        if (best === null || entry.dir.length > best.dir.length) best = entry
      }
    }
    if (best !== null) return best
    const parts = repoPath(root, file).split('/')
    if (parts[0] === 'src' && parts[1] === 'packages' && parts[2] !== undefined) {
      return { id: parts[2], dir: join(root, 'src', 'packages', parts[2]), manifest: {}, kind: 'feature' }
    }
    return null
  }

  /**
   * 一段源码里的静态说明符，带字符下标。
   *
   * 行号按说明符本身算（`match[0]` 里可能带上前面的换行），否则多行 import
   * 或「上一行是注释」时会把行号报偏一行。
   * @param source - 文件内容
   * @param patterns - 要匹配的正则组
   */
  const specifiersOf = (source, patterns) => {
    const out = []
    for (const importPattern of patterns) {
      importPattern.lastIndex = 0
      for (const match of source.matchAll(importPattern)) {
        out.push({ specifier: match[1], index: match.index + match[0].indexOf(match[1]) })
      }
    }
    return out
  }

  /**
   * 扫一个目录，把每条指向包（裸说明符或相对路径）的依赖交给 judge 判。
   *
   * judge 的第三个参数是线索：`{ specifier, to, relative }`。`to` 是相对说明符
   * 解析出的仓库相对路径（裸说明符为 null），门禁想打印「→ 目标」时用它；
   * 现成的两个门禁只取前两个参数，签名保持兼容。
   * @param dir - 目录
   * @param judge - `(target, where, detail) => void`；where 是 `文件:行号`
   */
  const scan = (dir, judge) => {
    for (const file of walkSources(dir, pattern)) {
      let source
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const { specifier, index } of specifiersOf(source, IMPORT_PATTERNS)) {
        const target = targetOf(specifier)
        if (target === null) continue
        judge(target, `${repoPath(root, file)}:${lineAt(source, index)}`, {
          specifier,
          to: null,
          relative: false,
        })
      }
      for (const { specifier, index } of specifiersOf(source, RELATIVE_IMPORT_PATTERNS)) {
        const resolved = resolveRelativeModule(file, specifier)
        if (resolved === null) continue
        const target = packageAt(resolved)
        if (target === null) continue
        judge(target, `${repoPath(root, file)}:${lineAt(source, index)}`, {
          specifier,
          to: repoPath(root, resolved),
          relative: true,
        })
      }
    }
  }

  /**
   * 只报相对路径边，不清洗、不判定：给统计用（哪些层之间在互相绕）。
   *
   * 所有能解析到真实代码文件的相对说明符都会交给 onEdge，包括同包内部的——
   * 调用方要统计跨层，自己按 {@link layerOfPath} 过滤。
   * @param dir - 目录
   * @param onEdge - `({ from, to, specifier, where }) => void`
   */
  const scanRelative = (dir, onEdge) => {
    for (const file of walkSources(dir, pattern)) {
      let source
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const { specifier, index } of specifiersOf(source, RELATIVE_IMPORT_PATTERNS)) {
        const resolved = resolveRelativeModule(file, specifier)
        if (resolved === null) continue
        onEdge({ from: file, to: resolved, specifier, where: `${repoPath(root, file)}:${lineAt(source, index)}` })
      }
    }
  }

  return { byName, targetOf, packageAt, scan, scanRelative }
}

/**
 * 读 `src/packages/*` 的清单，按插件模型门禁同一口径分成功能包与库包。
 *
 * 只给命令行入口与自检用；两个门禁自己有更细的清单检查（缺 patch、坏 YAML 等），
 * 这里只做「能不能被依赖图认出来」这件事。
 * @param root - 仓库根
 */
export function loadRepoPackages(root) {
  const packages = []
  const libraries = []
  const packagesDir = join(root, 'src', 'packages')
  if (!existsSync(packagesDir)) return { packages, libraries }
  for (const name of readdirSync(packagesDir).sort()) {
    const dir = join(packagesDir, name)
    if (!statSync(dir).isDirectory()) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      // 没有或读不动清单：仍按目录名登记成功能包，让依赖边不至于消失；
      // 「缺清单」本身由插件模型检查报。
      packages.push({ id: name, dir, manifest: {} })
      continue
    }
    const patch = manifest.pneuma?.bundle?.patch ?? manifest.dsh?.bundle?.patch
    if (typeof patch === 'string' && patch !== '') packages.push({ id: name, dir, manifest })
    else if (manifest.pneuma?.library === true) libraries.push({ id: name, dir, manifest })
    else packages.push({ id: name, dir, manifest })
  }
  return { packages, libraries }
}

/** 包的类别怎么称呼（文案里用）。 */
export function kindLabel(kind) {
  return kind === 'library' ? '库包' : '功能包'
}

/**
 * 一个包 import 另一个包是否越界；越界返回给人看的整句，允许返回 null。
 *
 * 允许的只有一条：功能包 → 库包。其余三条都算越界——
 *
 *   - 功能包 → 功能包：两个带行的包互相 import，装配顺序与开关语义都会打架；
 *   - 库包 → 功能包 / 库包：库包是被 import 的一侧，它再往下 import 包就成了环的起点；
 *   - core → 包：见 {@link coreDependencyProblem}，内核只许用 src/* 自己的东西。
 *
 * 相对路径与 `@pneuma/<id>` 走同一个判据：相对路径只是换了个写法，
 * 跨包时同样绕不过「谁依赖谁」这件事。
 * @param from - 发起 import 的包 `{ id, kind }`
 * @param target - 被 import 的包 `{ id, kind }`
 * @param where - `文件:行号`
 * @param detail - `{ specifier, to, relative }`（相对路径时 `to` 是目标文件）
 */
export function dependencyProblem(from, target, where, detail) {
  // 自己 import 自己不算跨包依赖（包内相对路径本来就不在这里）。
  if (target.id === from.id) return null
  const via =
    detail?.relative === true ? `（相对路径 ${detail.to}，跨包应改用 @pneuma/${target.id}）` : ''
  if (from.kind === 'feature') {
    if (target.kind === 'feature') {
      return `${where} 功能包「${from.id}」直接 import 了功能包「${target.id}」${via}：功能包只许 import 库包与 @pneuma/runtime/*`
    }
    return null
  }
  return `${where} 库包「${from.id}」直接 import 了${kindLabel(target.kind)}「${target.id}」${via}：库包只许用 node 内置与 @pneuma/runtime/*`
}

/**
 * core 目录 import 了任何一个包都是越界（含 import type）。
 * @param target - 被 import 的包 `{ id, kind }`
 * @param where - `文件:行号`
 * @param detail - `{ specifier, to, relative }`（相对路径时给目标文件）
 */
export function coreDependencyProblem(target, where, detail) {
  if (detail?.relative === true) {
    return `${where} → ${detail.to} 内核（src/core）以相对路径 import 了${kindLabel(target.kind)}「${target.id}」：共用类型请放 src/contract，实现经 @pneuma/runtime/* 或 inject 的服务取`
  }
  return `${where} 内核直接 import 了${kindLabel(target.kind)}「${target.id}」：src/core 不许 import src/packages（含 import type）`
}

/**
 * 服务层 import 了包是否越界：只拦相对路径。
 *
 * 为什么只拦相对路径：`src/services/types.ts` 现在还用
 * `import type ... from '@pneuma/session-core/hooks.js'` 取纯类型，这是既有且合理的
 * 写法（包标准门禁也允许裸说明符）；而相对路径能直接摸进包的内部实现，
 * 才是这次要堵的洞。相对路径跨包一旦出现，说明该下沉到 `src/contract`。
 * @param target - 被 import 的包 `{ id, kind }`
 * @param where - `文件:行号`
 * @param detail - `{ specifier, to, relative }`
 */
export function servicesDependencyProblem(target, where, detail) {
  if (detail?.relative !== true) return null
  return `${where} → ${detail.to} 服务层（src/services）以相对路径 import 了${kindLabel(target.kind)}「${target.id}」：共用类型请放 src/contract，实现经服务名 inject 取`
}

/**
 * 命令行入口：`node scripts/plugin-dep-graph.mjs`。
 *
 * 两个插件门禁只覆盖「包 → 包」与「core → 包」；服务层不在它们的扫描面内，
 * 相对路径更是一条都看不见。这里把三件事一次做完并单独给退出码：
 *
 *   1. 包 → 包：相对路径与裸说明符同一判据（功能包 → 库包允许，其余越界）；
 *   2. `src/core/**` 与 `src/services/**` 不许以相对路径进 `src/packages/**`；
 *   3. 打印跨层相对边的统计，方便以后收紧（当前只允许、不报错的方向也列出来）。
 *
 * 当前仓库实测：core / services → packages 的相对导入 0 条，所以这三条一开就绿。
 */
function main() {
  const root = resolve(process.env['PNEUMA_CHECK_ROOT'] ?? fileURLToPath(new URL('..', import.meta.url)))
  const { packages, libraries } = loadRepoPackages(root)
  const graph = createPackageGraph({ root, packages, libraries })
  const features = packages.map((pkg) => ({ ...pkg, kind: 'feature' }))
  const libs = libraries.map((pkg) => ({ ...pkg, kind: 'library' }))
  const entries = [...features, ...libs]

  const violations = []
  for (const pkg of entries) {
    graph.scan(pkg.dir, (target, where, detail) => {
      const message = dependencyProblem(pkg, target, where, detail)
      if (message !== null) violations.push({ rule: '包间依赖', message })
    })
  }

  const coreDir = join(root, 'src', 'core')
  if (existsSync(coreDir)) {
    graph.scan(coreDir, (target, where, detail) => {
      violations.push({ rule: 'core → 包', message: coreDependencyProblem(target, where, detail) })
    })
  }

  const servicesDir = join(root, 'src', 'services')
  if (existsSync(servicesDir)) {
    graph.scan(servicesDir, (target, where, detail) => {
      const message = servicesDependencyProblem(target, where, detail)
      if (message !== null) violations.push({ rule: 'services → 包', message })
    })
  }

  // ── 跨层相对边统计：同层内部、同包内部的边不计，否则每条 import 都算一条，看不出重点。
  const counts = new Map()
  let edges = 0
  const countEdge = (edge) => {
    const from = layerOfPath(root, edge.from)
    const to = layerOfPath(root, edge.to)
    if (from === null || to === null) return
    if (from.layer === 'package' && to.layer === 'package' && from.id === to.id) return
    if (from.layer === to.layer && from.layer !== 'package') return
    edges += 1
    const key = `${layerLabel(from.layer)} → ${layerLabel(to.layer)}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const pkg of entries) graph.scanRelative(pkg.dir, countEdge)
  for (const dir of [coreDir, servicesDir]) if (existsSync(dir)) graph.scanRelative(dir, countEdge)

  console.log('包依赖方向门禁（含相对路径）')
  console.log(`  扫描          ${features.length} 个功能包 + ${libs.length} 个库包 + src/core + src/services`)
  if (edges === 0) {
    console.log('  跨层相对边    0')
  } else {
    console.log(`  跨层相对边    ${edges} 条（同层 / 同包内部不计）`)
    for (const [pair, amount] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pair}  ${amount}`)
    }
  }

  if (violations.length === 0) {
    console.log('  ✓ 通过        包与包之间没有未声明的相对依赖；core / services 没有相对路径进 src/packages')
    return
  }
  console.log(`  ✗ 越界        ${violations.length} 条：跨包要声明依赖，core / services 不许用相对路径进 src/packages`)
  for (const item of violations) console.log(`    ${item.message}`)
  process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
