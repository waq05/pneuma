/**
 * 把 `src/packages/<id>/` 打成可加载的功能包，并生成基础包 `@pneuma/base`。
 *
 * 产物统一落在 `lib/node_modules/@pneuma/`，和运行时包同一个 node_modules：
 * 包之间、包与运行时之间都用裸说明符互相引用，Node 向上查找命中同一份，单实例由目录唯一性保证。
 *
 * 基础包只做一件事：把这些包各自 patch 里的行，按 `pneuma.order` 合成一层 insert。
 * 它等价于 dsh 的 `dsh-base`，只是行由各包自己声明，不在这里手抄。
 *
 * @module scripts/build-packages
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const srcDir = join(root, 'src', 'packages')
const outDir = join(root, 'lib', 'node_modules', '@pneuma')
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 一个源包的读盘结果。 */
function readPackage(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const id = dir.split(/[\\/]/).pop()
  const patchFile = join(dir, 'cordis.patch.yml')
  const patches = existsSync(patchFile) ? YAML.parse(readFileSync(patchFile, 'utf8')) : null
  const rows = []
  for (const entry of patches ?? []) {
    for (const row of entry.insert ?? []) rows.push(row)
  }
  return { id, dir, manifest, patches, rows, patchFile }
}

const packages = []
const problems = []

if (existsSync(srcDir)) {
  for (const name of readdirSync(srcDir).sort()) {
    const dir = join(srcDir, name)
    if (!statSync(dir).isDirectory()) continue
    if (!existsSync(join(dir, 'package.json'))) {
      problems.push(`${name} 目录里没有 package.json`)
      continue
    }
    packages.push(readPackage(dir))
  }
}

// 先清空上一轮的功能包（运行时包由 build-runtime-package 管，这里只删非 runtime 的目录）。
for (const name of existsSync(outDir) ? readdirSync(outDir) : []) {
  if (name === 'runtime') continue
  rmSync(join(outDir, name), { recursive: true, force: true })
}

const generated = []
for (const pkg of packages) {
  const dest = join(outDir, pkg.id)
  const compiled = join(root, 'lib', 'packages', pkg.id, 'index.js')
  if (!existsSync(compiled)) {
    problems.push(`${pkg.id} 没有编译产物（lib/packages/${pkg.id}/index.js）`)
    continue
  }
  mkdirSync(dest, { recursive: true })
  const pneuma = pkg.manifest.pneuma ?? {}
  const exports = {
    '.': './index.js',
    ...(pkg.manifest.exports ?? {}),
    './package.json': './package.json',
  }
  const outManifest = {
    name: pkg.manifest.name ?? `@pneuma/${pkg.id}`,
    version: rootManifest.version,
    private: true,
    type: 'module',
    exports,
    pneuma,
    ...(pkg.manifest.engines === undefined ? {} : { engines: pkg.manifest.engines }),
    peerDependencies: { '@deepseek-ai/cordis': rootManifest.dependencies['@deepseek-ai/cordis'] },
  }
  writeFileSync(join(dest, 'package.json'), JSON.stringify(outManifest, null, 2) + '\n', 'utf8')
  if (existsSync(pkg.patchFile)) writeFileSync(join(dest, 'cordis.patch.yml'), readFileSync(pkg.patchFile))
  generated.push({ ...pkg, outManifest })
}

// 基础包：所有行按 order 排好，合成一层 insert。
const ordered = [...generated].sort((a, b) => {
  const oa = a.manifest.pneuma?.order ?? 1000
  const ob = b.manifest.pneuma?.order ?? 1000
  return oa - ob || a.id.localeCompare(b.id)
})

const baseDir = join(outDir, 'base')
mkdirSync(baseDir, { recursive: true })
const seen = new Set()
const insert = []
for (const pkg of ordered) {
  for (const row of pkg.rows) {
    if (typeof row.id === 'string') {
      if (seen.has(row.id)) {
        problems.push(`行 id 重复：${row.id}（出现在 ${pkg.id}）`)
        continue
      }
      seen.add(row.id)
    }
    insert.push(row)
  }
}

writeFileSync(
  join(baseDir, 'package.json'),
  JSON.stringify(
    {
      name: '@pneuma/base',
      version: rootManifest.version,
      private: true,
      type: 'module',
      description: 'Pneuma 基础包：把各功能包的行按 order 合成一层',
      pneuma: { bundle: { patch: './cordis.patch.yml' } },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)
writeFileSync(join(baseDir, 'cordis.patch.yml'), YAML.stringify([{ insert }]), 'utf8')

console.log(`功能包：${generated.length} 个包，基础包 ${insert.length} 行 -> ${outDir}`)
for (const problem of problems) console.error('问题：' + problem)
if (problems.length > 0) process.exit(1)
