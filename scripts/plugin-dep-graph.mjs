/**
 * 包依赖方向图：两个门禁（plugin-model-check 与 plugin-standard-check）共用的一套判据。
 *
 * 为什么要抽出来：同一件事判两遍，最怕两处口径慢慢分叉——一个门禁绿、另一个红，
 * 谁也不知道该信哪个。这里同时收口三样东西：
 *
 *   - 包名索引：说明符 `@pneuma/<name>` 指向哪个源包，那个包是功能包还是库包；
 *   - 扫描口径：哪些文件算源码、四种静态 import 写法；
 *   - 判定文案：功能包 → 库包允许；功能包 → 功能包、库包 → 任何包、core → 任何包
 *     都算越界（`import type` 也是静态依赖，一并算）。
 *
 * 改这里等于同时改两个门禁——不要在两个门禁里再各写一份判据。
 *
 * @module scripts/plugin-dep-graph
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

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
   * 扫一个目录，把每条 `@pneuma/<包>` 依赖交给 judge 判。
   * @param dir - 目录
   * @param judge - `(target, where) => void`；where 是 `文件:行号`
   */
  const scan = (dir, judge) => {
    for (const file of walkSources(dir, pattern)) {
      let source
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const importPattern of IMPORT_PATTERNS) {
        importPattern.lastIndex = 0
        for (const match of source.matchAll(importPattern)) {
          const target = targetOf(match[1])
          if (target !== null) judge(target, `${repoPath(root, file)}:${lineAt(source, match.index)}`)
        }
      }
    }
  }

  return { byName, targetOf, scan }
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
 * @param from - 发起 import 的包 `{ id, kind }`
 * @param target - 被 import 的包 `{ id, kind }`
 * @param where - `文件:行号`
 */
export function dependencyProblem(from, target, where) {
  // 自己 import 自己不算跨包依赖（包内相对路径本来就不在这里）。
  if (target.id === from.id) return null
  if (from.kind === 'feature') {
    if (target.kind === 'feature') {
      return `${where} 功能包「${from.id}」直接 import 了功能包「${target.id}」：功能包只许 import 库包与 @pneuma/runtime/*`
    }
    return null
  }
  return `${where} 库包「${from.id}」直接 import 了${kindLabel(target.kind)}「${target.id}」：库包只许用 node 内置与 @pneuma/runtime/*`
}

/**
 * core 目录 import 了任何一个包都是越界（含 import type）。
 * @param target - 被 import 的包 `{ id, kind }`
 * @param where - `文件:行号`
 */
export function coreDependencyProblem(target, where) {
  return `${where} 内核直接 import 了${kindLabel(target.kind)}「${target.id}」：src/core 不许 import src/packages（含 import type）`
}
