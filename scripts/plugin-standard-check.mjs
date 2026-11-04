/**
 * 包标准闸：把「每个功能包都长成 dsh 包的样子」这件事做成机器判得动的门禁。
 *
 * 为什么要有它：包化改造走到后面，缺口全是「某个包的 package.json 少一行字段」
 * 「某个包的 exports 多一个键」「两个包 order 撞了」这种一眼看不出来的事。
 * plugin-model-check 管的是「有没有包、有没有行」，这个脚本管「包本身合不合规格」。
 *
 * 六条硬项（不通过退出 1，合并前必须全绿）：
 *   1. package.json 的字段齐全（name / version / private / type / exports /
 *      engines.pneuma / cordis 对等依赖；功能包另有 pneuma.bundle.patch /
 *      pneuma.resolution / pneuma.order，库包不需要）；
 *   2. exports 的键集只许 .、./client、./package.json、./locale/*.json；
 *      库包另许模块子路径 ./<模块>.js（键与目标一字不差，功能包不给这条）；
 *   3. 功能包：cordis.patch.yml 能解析、恰好一条 insert 行，行 id 与目录名一致、
 *      name 等于包名（库包没有行，不判）；
 *   4. 功能包：入口 index.ts 能导出一个插件（模块级 apply / default / 唯一带 apply 的
 *      命名导出），名叫 name 的导出必须是字符串（库包不导出插件对象，不判）；
 *   5. 依赖方向：功能包 → 库包允许；功能包 → 功能包、库包 → 任何包、core → 任何包
 *      都算越界（判据与 plugin-model-check 共用 scripts/plugin-dep-graph.mjs）；
 *   6. order 不撞号（只数字功能包）。
 *
 * 库包 = 没有 cordis.patch.yml、也没有 pneuma.bundle.patch 的包；清单里还要显式写
 * pneuma.library: true，否则第 1 项照报缺口——两个门禁对「忘了写 patch」的判断一致。
 * 库包没有行、不参与开关，所以豁免 patch / resolution / order / 行 / 入口导出这五项；
 * name、version 0.0.0、private、type module、exports、engines.pneuma、cordis 对等依赖照要求。
 *
 * 三项待办（只打印清单，不影响退出码）：
 *   - 缺 README.md，或 README 里没有「Model Experience」「Known Limitations」两段；
 *   - 缺 tests/ 目录；
 *   - 模块级可变状态可疑写法（顶层导出的 Map / Set / Array）。
 *
 * 用法：
 *   node scripts/plugin-standard-check.mjs          # 人看
 *   node scripts/plugin-standard-check.mjs --json   # 机器读
 *
 * 自检要造夹具时用 PNEUMA_CHECK_ROOT=<目录> 换一个仓库根（缺省是本仓库）。
 *
 * @module scripts/plugin-standard-check
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import YAML from 'yaml'
import {
  coreDependencyProblem,
  createPackageGraph,
  dependencyProblem,
  SOURCE_ALL,
  walkSources,
} from './plugin-dep-graph.mjs'

const root = resolve(process.env['PNEUMA_CHECK_ROOT'] ?? fileURLToPath(new URL('..', import.meta.url)))
const asJson = new Set(process.argv.slice(2)).has('--json')
const packagesDir = join(root, 'src', 'packages')

/**
 * exports 里允许出现的键。
 *
 * 为什么不直接照抄 dsh 的全套键：我们暂时没有类型条件导出与 ./browser 这类次级入口，
 * 多出来的键没人用，还会让产物里出现指向不存在文件的路径。哪天真要用，往这里加一行，
 * 别在包里偷偷加——这个闸会把「包里冒出计划外的键」报出来，由主控决定收不收。
 */
const ALLOWED_EXPORT_KEYS = new Set(['.', './client', './package.json'])
/** 本地化文件是允许的第二类键：./locale/<语言>.json。 */
const LOCALE_EXPORT_KEY = /^\.\/locale\/[^/]+\.json$/
/**
 * 库包的第三类键：模块子路径（`./actions.js` → `./actions.js`）。
 *
 * 为什么只给库包开：库包是被功能包 import 的一侧，源码里就有好几个模块
 * （cdp 的 transport / actions / snapshot …），它们只能靠子路径导出被裸说明符引用。
 * 功能包对外只有一个插件入口，多开子路径等于让别的包绕过开关直接拿内部实现；
 * 键与目标必须一字不差（不做任意的 `./x` → `./y` 映射），这样构建产物里
 * 每条导出都指向包内真实存在的同名文件。
 */
const LIBRARY_MODULE_EXPORT_KEY = /^\.\/[a-z0-9][a-z0-9-]*\.js$/

/** cordis 对等依赖的键名：版本区间由 build-packages 统一注入，这里只查有没有。 */
const CORDIS_PEER = '@deepseek-ai/cordis'

/** 硬项编号 → 问题清单；键顺序就是报表顺序。 */
const hard = new Map([
  [1, { title: '清单字段', issues: [], passed: 0 }],
  [2, { title: 'exports 键集', issues: [], passed: 0 }],
  [3, { title: '行 id 与 name', issues: [], passed: 0 }],
  [4, { title: '入口导出', issues: [], passed: 0 }],
  [5, { title: '依赖方向', issues: [], passed: 0 }],
  [6, { title: 'order 撞号', issues: [], passed: 0 }],
])

/** 待办清单（只打印）。 */
const todo = {
  readme: [],
  tests: [],
  state: [],
}

/** 记一条问题：id 说明是哪个包，detail 给人看。 */
function fail(item, id, detail) {
  hard.get(item).issues.push(`${id}：${detail}`)
}

/** 读文件，读不了返回 null。 */
function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 这个语句上有 export 修饰符吗。 */
function isExported(node) {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

/** 这个语句上有 default 修饰符吗（export default class / function）。 */
function isDefault(node) {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
}

/** 对象字面量里有 apply 成员（方法、属性或简写都算）。 */
function hasApplyMember(object) {
  return object.properties.some((property) => {
    if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      return ts.isIdentifier(property.name) && property.name.text === 'apply'
    }
    return ts.isShorthandPropertyAssignment(property) && property.name.text === 'apply'
  })
}

/**
 * 用 TypeScript 的语法树认入口文件导出了什么。
 *
 * 为什么不用正则：函数体里随便一句中文注释带个引号，花括号配对就会错位（memory/index.ts
 * 就这么被误判过），而「这个对象有没有 apply 成员」恰恰是加载器挑插件的唯一依据。
 *
 * 三套写法都收：dsh 的模块级 `export function apply`、`export default class`，
 * 以及我们 56 个宿主包在用的 `export const xxxPlugin = { name, apply }`。
 * 最后一种不是 dsh 的字面写法，但它是加载器真正认的形状（构建产物是 `export *` 桩，
 * default 过不去），所以这里按加载器的规则判，并在报告里说明这条靠约定。
 */
function analyzeEntry(text) {
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const result = { moduleApply: -1, defaultExport: -1, plugins: [], nameLine: null }

  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals) result.defaultExport = lineOf(statement)
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === 'apply') result.moduleApply = lineOf(statement)
        if (element.name.text === 'default') result.defaultExport = lineOf(statement)
      }
      continue
    }
    if (!isExported(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'apply') {
      result.moduleApply = lineOf(statement)
      continue
    }
    if (ts.isClassDeclaration(statement) && isDefault(statement)) {
      result.defaultExport = lineOf(statement)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const exportedName = declaration.name.text
      const initializer = declaration.initializer
      if (exportedName === 'apply') result.moduleApply = lineOf(declaration)
      if (exportedName === 'name') {
        // 只有字符串字面量算数：`export const name = someVar` 里装的什么都可能。
        const isString =
          initializer !== undefined &&
          (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
        result.nameLine = { line: lineOf(declaration), ok: isString }
      }
      if (initializer !== undefined && ts.isObjectLiteralExpression(initializer) && hasApplyMember(initializer)) {
        result.plugins.push({ name: exportedName, line: lineOf(declaration) })
      }
    }
  }

  return result
}

// ── 逐个包 ──────────────────────────────────────────────────────────────────

const ids = existsSync(packagesDir)
  ? readdirSync(packagesDir)
      .filter((name) => statSync(join(packagesDir, name)).isDirectory())
      .sort()
  : []

const packages = []
for (const id of ids) {
  const dir = join(packagesDir, id)
  const manifestFile = join(dir, 'package.json')
  const entryFile = join(dir, 'index.ts')
  const patchFile = join(dir, 'cordis.patch.yml')
  const rel = (file) => relative(root, file).split('\\').join('/')

  if (!existsSync(manifestFile)) {
    fail(1, id, `缺 package.json（${rel(manifestFile)}）`)
    continue
  }
  let manifest = null
  try {
    manifest = JSON.parse(readText(manifestFile) ?? '')
  } catch (error) {
    fail(1, id, `package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  // 库包判据：目录里没有 cordis.patch.yml，清单里也没有 pneuma.bundle.patch。
  // 有其一的是功能包（缺哪样由第 1、3 项分别报）；两样都没有但没标 pneuma.library
  // 的，按库包豁免其余四项，但第 1 项照红——与 plugin-model-check 的缺口同义。
  const declaredPatch =
    typeof manifest.pneuma?.bundle?.patch === 'string' && manifest.pneuma.bundle.patch !== ''
  const kind = !existsSync(patchFile) && !declaredPatch ? 'library' : 'feature'
  const pkg = { id, dir, manifest, entryFile, patchFile, rel, kind }
  packages.push(pkg)

  // ── 1. 清单字段 ──────────────────────────────────────────────────────────
  let fieldOk = true
  const want = (ok, detail) => {
    if (!ok) {
      fieldOk = false
      fail(1, id, detail)
    }
  }
  want(typeof manifest.name === 'string' && manifest.name !== '', 'name 缺失或不是字符串')
  want(manifest.version === '0.0.0', `version 是 ${JSON.stringify(manifest.version)}，源码期要求 "0.0.0"`)
  want(manifest.private === true, 'private 不是 true')
  want(manifest.type === 'module', `type 是 ${JSON.stringify(manifest.type)}，要求 "module"`)
  const exportsField = manifest.exports
  want(exportsField !== null && typeof exportsField === 'object', 'exports 缺失或不是对象')
  if (exportsField !== null && typeof exportsField === 'object') {
    want(exportsField['.'] === './index.js', `exports["."] 是 ${JSON.stringify(exportsField['.'])}，要求 "./index.js"`)
    want(exportsField['./package.json'] === './package.json', 'exports 缺 "./package.json": "./package.json"')
  }
  if (pkg.kind === 'feature') {
    want(declaredPatch, 'pneuma.bundle.patch 缺失')
    want(
      manifest.pneuma?.resolution === 'pinned' || manifest.pneuma?.resolution === 'overridable',
      `pneuma.resolution 是 ${JSON.stringify(manifest.pneuma?.resolution)}，只允许 pinned / overridable`,
    )
    want(
      typeof manifest.pneuma?.order === 'number' && Number.isFinite(manifest.pneuma.order),
      'pneuma.order 缺失或不是数字',
    )
  } else if (manifest.pneuma?.library !== true) {
    // 没有 patch、也没标库包：按库包放行其余四项，但这一条必须红——与
    // plugin-model-check 的「没声明 patch 也没标 library」是同一个缺口。
    want(false, '没有 cordis.patch.yml，也没标 pneuma.library = true（功能包要有 patch，库包要显式声明）')
  }
  want(typeof manifest.engines?.pneuma === 'string' && manifest.engines.pneuma !== '', 'engines.pneuma 缺失')
  want(
    typeof manifest.peerDependencies?.[CORDIS_PEER] === 'string' &&
      manifest.peerDependencies[CORDIS_PEER] !== '',
    `peerDependencies["${CORDIS_PEER}"] 缺失`,
  )
  if (fieldOk) hard.get(1).passed += 1

  // ── 2. exports 键集 ──────────────────────────────────────────────────────
  let keyOk = exportsField !== null && typeof exportsField === 'object'
  if (keyOk) {
    for (const key of Object.keys(exportsField)) {
      if (ALLOWED_EXPORT_KEYS.has(key) || LOCALE_EXPORT_KEY.test(key)) continue
      // 库包的模块子路径：键与目标一字不差才算（见 LIBRARY_MODULE_EXPORT_KEY）。
      if (pkg.kind === 'library' && LIBRARY_MODULE_EXPORT_KEY.test(key) && exportsField[key] === key) continue
      keyOk = false
      fail(2, id, `exports 里有计划外的键「${key}」——要不要收由主控定，别在包里偷偷加`)
    }
  }
  if (keyOk) hard.get(2).passed += 1

  // ── 3. 行（库包没有行，整项豁免、也不计入分母）──────────────────────────
  const rowApplicable = pkg.kind === 'feature'
  let rowOk = true
  const rowFail = (detail) => {
    rowOk = false
    fail(3, id, detail)
  }
  if (!rowApplicable) {
    // 库包没有 cordis.patch.yml：不判这一项。
  } else if (!existsSync(patchFile)) {
    rowFail('缺 cordis.patch.yml')
  } else {
    let parsed = null
    try {
      parsed = YAML.parse(readText(patchFile) ?? '')
    } catch (error) {
      rowFail(`cordis.patch.yml 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
    }
    if (parsed !== null) {
      if (!Array.isArray(parsed)) {
        rowFail('cordis.patch.yml 顶层不是数组')
      } else {
        const entries = parsed.filter((entry) => entry !== null && typeof entry === 'object')
        const inserts = entries.filter((entry) => Array.isArray(entry.insert))
        const rows = inserts.flatMap((entry) => entry.insert)
        if (entries.length !== parsed.length || entries.length !== 1) {
          rowFail(`patch 顶层有 ${parsed.length} 条，要求恰好 1 条 insert`)
        } else if (inserts.length !== 1 || rows.length !== 1) {
          rowFail(`patch 里有 ${rows.length} 行，要求恰好 1 行 insert`)
        } else if (Object.keys(entries[0]).length !== 1) {
          rowFail(`patch 的 insert 旁边还有 ${Object.keys(entries[0]).join('、')}，只许一条 insert`)
        } else {
          const row = rows[0] ?? {}
          // 界面单元包的行 id 必须带 ui- 前缀，别的包用目录名本身：两者都等于目录名，
          // 分开写是为了让报错说清「差在哪个前缀」。
          const expectedId = id.startsWith('ui-') ? id : id
          if (row.id !== expectedId) {
            rowFail(`行 id 是 ${JSON.stringify(row.id)}，目录约定要求 "${expectedId}"`)
          }
          if (row.name !== manifest.name) {
            rowFail(`行的 name 是 ${JSON.stringify(row.name)}，要求等于包名 ${JSON.stringify(manifest.name)}`)
          }
        }
      }
    }
  }
  if (rowApplicable && rowOk) hard.get(3).passed += 1

  // ── 4. 入口导出（库包不导出插件对象，整项豁免）──────────────────────────
  const entryApplicable = pkg.kind === 'feature'
  let entryOk = true
  if (!entryApplicable) {
    // 库包导出的是函数/常量，不是 cordis 插件：不判这一项。
  } else if (!existsSync(entryFile)) {
    entryOk = false
    fail(4, id, '缺 index.ts')
  } else {
    const shape = analyzeEntry(readText(entryFile) ?? '')
    const hasPlugin =
      shape.moduleApply !== -1 || shape.defaultExport !== -1 || shape.plugins.length === 1
    if (!hasPlugin) {
      entryOk = false
      if (shape.plugins.length > 1) {
        const names = shape.plugins.map((item) => `${item.name}（第 ${item.line} 行）`).join('、')
        fail(4, id, `有 ${shape.plugins.length} 个带 apply 的命名导出：${names}——加载器分不清用哪个`)
      } else {
        fail(4, id, 'index.ts 没有 apply 函数、没有 default、也没有带 apply 的插件对象导出')
      }
    }
    if (shape.nameLine !== null && !shape.nameLine.ok) {
      entryOk = false
      fail(4, id, `第 ${shape.nameLine.line} 行导出了 name，但不是字符串字面量`)
    }
  }
  if (entryApplicable && entryOk) hard.get(4).passed += 1

  // ── 待办：README / tests / 模块级可变状态 ────────────────────────────────
  const readmeFile = join(dir, 'README.md')
  if (!existsSync(readmeFile)) {
    todo.readme.push(`${id}：缺 README.md`)
  } else {
    const readme = readText(readmeFile) ?? ''
    for (const section of ['Model Experience', 'Known Limitations']) {
      // 标题层级 1–3 都算：dsh 的写法是 ##，我们不强制。
      if (!new RegExp(`^#{1,3}\\s*${section}\\b`, 'mi').test(readme)) {
        todo.readme.push(`${id}：README.md 缺「${section}」一节`)
      }
    }
  }
  if (!existsSync(join(dir, 'tests'))) todo.tests.push(`${id}：缺 tests/ 目录`)

  // 库包的待办只保留 README 与 tests：模块级可变状态是功能包的装配隐患，
  // 而常量表 / 缓存本来就是库包的正常写法，列出来只是噪声。
  const stateFiles = pkg.kind === 'feature' ? walkSources(dir, SOURCE_ALL) : []
  for (const file of stateFiles) {
    const source = readText(file) ?? ''
    const lines = source.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (!/^export\s+(?:const|let)\b/.test(line)) return
      const looksStateful =
        /=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\s*\(/.test(line) ||
        /=\s*\[/.test(line) ||
        /^export\s+let\b/.test(line)
      if (!looksStateful) return
      // 常量表也会命中这条规则（导出的数组）。把声明块扫到收尾的 ]，看有没有
      // readonly / as const：有就标一句「只读」，没有就提醒先看——省得 19 条一样的东西
      // 全要人从头读一遍。
      const block = []
      for (let i = index; i < Math.min(index + 80, lines.length); i += 1) {
        block.push(lines[i])
        if (/^\s*\]/.test(lines[i])) break
      }
      const readonlyDecl = /(?:readonly|Readonly(?:Set|Map)|as const)/.test(block.join('\n'))
      const note = readonlyDecl ? '（声明为只读）' : '（没声明只读，先看这条）'
      todo.state.push(`${rel(file)}:${index + 1}：${line.trim().slice(0, 90)}${note}`)
    })
  }
}

// ── 5. 依赖方向 ─────────────────────────────────────────────────────────────

// 判据与 plugin-model-check 共用 scripts/plugin-dep-graph.mjs：功能包 → 库包允许；
// 功能包 → 功能包、库包 → 任何包、core → 任何包都算越界（含 import type）。
// 库包与功能包都在这张图里：库包自己 import 了包同样要报。
const graph = createPackageGraph({
  root,
  packages: packages.filter((pkg) => pkg.kind === 'feature'),
  libraries: packages.filter((pkg) => pkg.kind === 'library'),
})

for (const pkg of packages) {
  let crossOk = true
  graph.scan(pkg.dir, (target, where) => {
    const message = dependencyProblem({ id: pkg.id, kind: pkg.kind }, target, where)
    if (message === null) return
    crossOk = false
    // 文案自己带包名与位置：不再套一层「id：」，否则报错里同一个包名出现两次。
    hard.get(5).issues.push(message)
  })
  if (crossOk) hard.get(5).passed += 1
}

// core → 包：内核文件（含 import type）不许碰 src/packages。
const coreDir = join(root, 'src', 'core')
if (existsSync(coreDir)) {
  graph.scan(coreDir, (target, where) => hard.get(5).issues.push(coreDependencyProblem(target, where)))
}

// ── 6. order 撞号 ───────────────────────────────────────────────────────────

/** 功能包 / 库包各多少：库包没有行，第 3、4、6 项的分母只数功能包。 */
const featureTotal = packages.filter((pkg) => pkg.kind === 'feature').length
const libraryTotal = packages.length - featureTotal

const byOrder = new Map()
for (const pkg of packages) {
  if (pkg.kind !== 'feature') continue
  const order = pkg.manifest.pneuma?.order
  if (typeof order !== 'number') continue
  const key = String(order)
  if (!byOrder.has(key)) byOrder.set(key, [])
  byOrder.get(key).push(pkg.id)
}
// 撞号的包都不算通过，其余照常通过：这样 74/75 能说清「只有一对撞了」。
const collided = new Set()
for (const [order, group] of byOrder) {
  if (group.length < 2) continue
  for (const id of group) collided.add(id)
  fail(6, group[0], `order ${order} 被 ${group.length} 个包共用：${group.join('、')}`)
}
hard.get(6).passed = featureTotal - collided.size

// ── 汇总 ────────────────────────────────────────────────────────────────────

const total = packages.length
/** 每一项的分母：库包不适用「行 / 入口导出 / order」三项，分母只数功能包。 */
const applicableOf = new Map([
  [1, total],
  [2, total],
  [3, featureTotal],
  [4, featureTotal],
  [5, total],
  [6, featureTotal],
])
const issues = [...hard.values()].flatMap((item) => item.issues)
const summary = {
  // packages 仍是「src/packages 下的目录数」，features / libraries 是拆开的两半。
  packages: total,
  features: featureTotal,
  libraries: libraryTotal,
  // rows 只数功能包：库包没有行（契约：一个功能包恰好一行）。
  rows: featureTotal,
  hard: [...hard.entries()].map(([index, item]) => ({
    item: index,
    title: item.title,
    passed: item.passed,
    applicable: applicableOf.get(index) ?? total,
    total,
    exempt: total - (applicableOf.get(index) ?? total),
    issues: item.issues.length,
  })),
  todo: {
    readme: todo.readme.length,
    tests: todo.tests.length,
    state: todo.state.length,
  },
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        summary,
        hard: [...hard.entries()].map(([index, item]) => ({ item: index, issues: item.issues })),
        todo,
      },
      null,
      2,
    ),
  )
  process.exit(issues.length === 0 ? 0 : 1)
}

console.log(`包标准检查（${total} 个包：${featureTotal} 功能包 + ${libraryTotal} 库包）`)
console.log('')
console.log('硬项（不通过退出 1）')
for (const [index, item] of hard) {
  const mark = item.issues.length === 0 ? '通过' : `${item.issues.length} 条问题`
  const applicable = applicableOf.get(index) ?? total
  const exempt = total - applicable
  const tail = exempt > 0 ? `（库包豁免 ${exempt}）` : ''
  console.log(`  ${index} ${item.title.padEnd(12)} ${item.passed}/${applicable} 包  ${mark}${tail}`)
}
console.log(`  合计 ${issues.length} 条问题`)
console.log('')
console.log('待办（只提示，不阻塞合并）')
console.log(`  README         ${todo.readme.length} 条`)
console.log(`  tests/         ${todo.tests.length} 条`)
console.log(`  模块级可变状态 ${todo.state.length} 条`)

if (issues.length > 0) {
  console.log('')
  console.log('硬项明细')
  for (const [index, item] of hard) {
    for (const issue of item.issues) console.log(`  [${index}] ${issue}`)
  }
}

// 待办清单只列前 20 条：75 个包全缺 README，全列出来会把终端刷没，统计在汇总里。
const todoLines = [...todo.readme, ...todo.tests, ...todo.state]
if (todoLines.length > 0) {
  console.log('')
  console.log('待办明细（最多列 20 条）')
  for (const line of todoLines.slice(0, 20)) console.log(`  ${line}`)
  if (todoLines.length > 20) console.log(`  ……另有 ${todoLines.length - 20} 条`)
}

process.exit(issues.length === 0 ? 0 : 1)
