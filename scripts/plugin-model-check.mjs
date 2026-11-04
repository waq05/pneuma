/**
 * 插件模型校验：检查「所有功能都是包、都是行」这件事有没有做到。
 *
 * 为什么要这个脚本：过去几次「对齐 dsh」都停在「表格退役了但还有插件静态 import」这类
 * 半成品状态。人眼看不出来，脚本能。默认模式只报告缺口（可以分期转绿），
 * --strict 模式有任何缺口就退出 1，进 check:all。
 *
 * 检查项：
 *   1. src/packages/<id>/package.json 存在，且 pneuma.bundle.patch 指向存在的文件。
 *      没有 patch 但标了 pneuma.library = true 的是**库包**：单独计数，不算缺口；
 *      既没有 patch 也没标 library 才是缺口。
 *   2. 所有 patch 里的行 id 全局唯一，name 非空；
 *   3. src/host/kernel.ts 行数 ≤ 120，且不再 import src/plugins/*；
 *   4. 依赖方向（静态扫源码）：功能包 → 库包允许；功能包 → 功能包、库包 → 任何包、
 *      core → 任何包都记缺口（含 import type）；
 *   5. 每个功能包都有 lib 产物（只在 --built 下查，源码期跳过）；
 *   6. profile 模板存在（只在 --built 下查）。
 *
 * 用法：
 *   node scripts/plugin-model-check.mjs            # 报告模式
 *   node scripts/plugin-model-check.mjs --strict   # 有缺口即失败
 *   node scripts/plugin-model-check.mjs --json     # 机器可读
 *
 * 自检要造夹具时用 PNEUMA_CHECK_ROOT=<目录> 换一个仓库根（缺省是本仓库）。
 *
 * @module scripts/plugin-model-check
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { coreDependencyProblem, createPackageGraph, dependencyProblem } from './plugin-dep-graph.mjs'

const root = resolve(process.env['PNEUMA_CHECK_ROOT'] ?? fileURLToPath(new URL('..', import.meta.url)))
const args = new Set(process.argv.slice(2))
const strict = args.has('--strict')
const asJson = args.has('--json')
const checkBuilt = args.has('--built')

/** 内核行数上限。超过说明装配代码还没搬走。 */
const KERNEL_MAX_LINES = 120

const gaps = []
const notes = []
/** 库包：没有 patch、但显式标了 pneuma.library = true 的包（不参与开关、没有行）。 */
const libraries = []

/** 记一条缺口：kind 用于分组，detail 给人看。 */
function gap(kind, detail) {
  gaps.push({ kind, detail })
}

/** 松读 JSON；坏文件返回 null 并记缺口。 */
function readJson(file, kind) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    gap(kind, `${file} 读不了：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

// ── 1. 包与 patch ────────────────────────────────────────────────────────────

const packagesDir = join(root, 'src', 'packages')
const packages = []
if (!existsSync(packagesDir)) {
  gap('packages', 'src/packages 不存在：功能还是静态插件文件，没有包化')
} else {
  for (const name of readdirSync(packagesDir).sort()) {
    // `ui-<id>` 是独立界面包：它有一行（空 apply 的宿主半），所以与功能包同一套检查走。
    // 它的界面半边的门禁在 ui-shell 的构建里（build-plugins 读 pneuma.client.api）。
    const dir = join(packagesDir, name)
    if (!statSync(dir).isDirectory()) continue
    const manifestFile = join(dir, 'package.json')
    if (!existsSync(manifestFile)) {
      gap('packages', `${name} 目录里没有 package.json`)
      continue
    }
    const manifest = readJson(manifestFile, 'packages')
    if (manifest === null) continue
    const declared = manifest.pneuma?.bundle?.patch ?? manifest.dsh?.bundle?.patch
    if (typeof declared !== 'string' || declared === '') {
      // 三分支：有 patch = 功能包（走下面的原逻辑）；没 patch 但标了 library = 库包；
      // 两样都没有才是缺口。库包没有行、不进插件清单，所以不读 patch、不数行。
      if (manifest.pneuma?.library === true) {
        libraries.push({ name, dir, manifest })
        continue
      }
      gap('packages', `${name} 没声明 pneuma.bundle.patch，也没标 pneuma.library = true`)
      continue
    }
    const patchFile = join(dir, declared)
    if (!existsSync(patchFile)) {
      gap('packages', `${name} 的 patch 文件不存在：${declared}`)
      continue
    }
    let patches
    try {
      patches = YAML.parse(readFileSync(patchFile, 'utf8'))
    } catch (error) {
      gap('packages', `${name} 的 patch 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!Array.isArray(patches)) {
      gap('packages', `${name} 的 patch 顶层不是数组`)
      continue
    }
    const rows = []
    for (const entry of patches) {
      if (entry === null || typeof entry !== 'object') continue
      for (const row of entry.insert ?? []) {
        if (row === null || typeof row !== 'object') continue
        rows.push(row)
      }
    }
    packages.push({ name, dir, manifest, rows })
  }
}

// ── 2. 行 id 唯一 ────────────────────────────────────────────────────────────

const seen = new Map()
for (const pkg of packages) {
  for (const row of pkg.rows) {
    const id = row.id
    if (typeof id !== 'string' || id === '') {
      gap('rows', `${pkg.name} 有一行没有 id`)
      continue
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      gap('rows', `${pkg.name} 的行 id「${id}」格式不对（只允许小写字母、数字、连字符）`)
    }
    const previous = seen.get(id)
    if (previous !== undefined) {
      gap('rows', `行 id「${id}」重复：${previous} 与 ${pkg.name}`)
    } else {
      seen.set(id, pkg.name)
    }
    if (typeof row.name !== 'string' || row.name === '') {
      gap('rows', `${pkg.name} 的行「${id}」没有 name`)
    }
  }
}

// ── 3. 内核 ──────────────────────────────────────────────────────────────────

const kernelFile = join(root, 'src', 'host', 'kernel.ts')
let kernelLines = 0
if (!existsSync(kernelFile)) {
  gap('kernel', 'src/host/kernel.ts 不存在')
} else {
  const text = readFileSync(kernelFile, 'utf8')
  // 按「行」数（与 wc -l 同口径）：文件末尾那个换行不算多一行，否则每个文件都虚报 1。
  const rows = text.split(/\r?\n/)
  kernelLines = rows.length - (rows[rows.length - 1] === '' ? 1 : 0)
  if (kernelLines > KERNEL_MAX_LINES) {
    gap('kernel', `kernel.ts 有 ${kernelLines} 行（上限 ${KERNEL_MAX_LINES}），装配代码还没搬走`)
  }
}

// 三个入口都不许静态 import 插件：只查 kernel 会漏掉「表退役了但旁路还在」。
for (const entry of ['src/host/kernel.ts', 'src/boot.ts', 'src/headless.ts']) {
  const file = join(root, ...entry.split('/'))
  if (!existsSync(file)) {
    gap('entry', `${entry} 不存在`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  const staticImports = [...text.matchAll(/from '(\.{1,2}\/[^']*plugins\/[^']*)'/g)].map((m) => m[1])
  if (staticImports.length > 0) {
    const unique = [...new Set(staticImports)]
    gap('entry', `${entry} 还在静态 import 插件：${unique.slice(0, 5).join('、')}${unique.length > 5 ? ' 等' : ''}`)
  }
}

// ── 4. 依赖方向 ──────────────────────────────────────────────────────────────
//
// 判据收在 scripts/plugin-dep-graph.mjs，与 plugin-standard-check 共用同一份：
// 允许的只有一条「功能包 → 库包」；功能包 → 功能包、库包 → 任何包、core → 任何包
// 都记缺口。改判据只改那一处，两个门禁才不会各说各话。

const graph = createPackageGraph({
  root,
  packages: packages.map((pkg) => ({ id: pkg.name, dir: pkg.dir, manifest: pkg.manifest })),
  libraries: libraries.map((pkg) => ({ id: pkg.name, dir: pkg.dir, manifest: pkg.manifest })),
})

for (const pkg of [
  ...packages.map((item) => ({ id: item.name, dir: item.dir, kind: 'feature' })),
  ...libraries.map((item) => ({ id: item.name, dir: item.dir, kind: 'library' })),
]) {
  graph.scan(pkg.dir, (target, where) => {
    const message = dependencyProblem(pkg, target, where)
    if (message !== null) gap('dep-direction', message)
  })
}

// core → 包：内核文件（含 import type）不许碰 src/packages。
const coreDir = join(root, 'src', 'core')
if (existsSync(coreDir)) {
  graph.scan(coreDir, (target, where) => gap('dep-direction', coreDependencyProblem(target, where)))
}

// ── 5. 构建产物（可选） ──────────────────────────────────────────────────────

if (checkBuilt) {
  for (const pkg of packages) {
    const built = join(root, 'lib', 'packages', pkg.name.replace(/^@[^/]+\//, ''), 'package.json')
    if (!existsSync(built)) gap('built', `${pkg.name} 没有构建产物：lib/packages/${pkg.name.replace(/^@[^/]+\//, '')}`)
  }
  const template = join(root, 'profiles', 'default', 'package.json')
  if (!existsSync(template)) gap('built', '没有随应用发布的默认 profile 模板：profiles/default/package.json')
  const runtimePkg = join(root, 'lib', 'node_modules', '@pneuma', 'runtime', 'package.json')
  if (!existsSync(runtimePkg)) gap('built', '没有生成运行时包：lib/node_modules/@pneuma/runtime')
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

const summary = {
  packages: packages.length,
  rows: seen.size,
  libraries: libraries.length,
  kernelLines,
  gaps: gaps.length,
}

if (asJson) {
  console.log(JSON.stringify({ summary, gaps }, null, 2))
} else {
  console.log('插件模型检查')
  console.log(`  功能包        ${summary.packages}`)
  console.log(`  行            ${summary.rows}`)
  console.log(`  库包          ${summary.libraries}`)
  console.log(`  kernel.ts     ${summary.kernelLines} 行（上限 ${KERNEL_MAX_LINES}）`)
  if (gaps.length === 0) {
    console.log('  缺口          0')
    for (const note of notes) console.log(`  说明          ${note}`)
  } else {
    console.log(`  缺口          ${gaps.length}`)
    for (const item of gaps.slice(0, 40)) console.log(`    [${item.kind}] ${item.detail}`)
    if (gaps.length > 40) console.log(`    ……另有 ${gaps.length - 40} 条`)
  }
}

if (strict && gaps.length > 0) process.exit(1)
if (strict && packages.length === 0) process.exit(1)
