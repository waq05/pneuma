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
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const srcDir = join(root, 'src', 'packages')
const outDir = join(root, 'lib', 'node_modules', '@pneuma')
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 递归列出目录下的文件。 */
function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(path))
    else out.push(path)
  }
  return out
}

/** 一条再导出桩：指回 lib/packages 里的真实文件。 */
function stubBody(fromFile, toFile) {
  let rel = relative(dirname(fromFile), toFile).split('\\').join('/')
  if (!rel.startsWith('.')) rel = './' + rel
  return `export * from '${rel}';\n`
}

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
    // `ui-<id>` 是独立界面包：**它有自己的一行**（宿主半是空 apply，只为进 Loader 拿开关），
    // 所以照常参与 @pneuma/base 的行清单。它的界面产物不在这里构建——那是 ui-shell 的
    // build-plugins 打的 `lib/ui/plugins/<id>/client.js`，与宿主包的产物同一个目录。
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
  // 目录名按**包名**去掉 scope，不能按源目录名：`runtime` 这个插件叫
  // `@pneuma/runtime-adapter`，按 id 落盘会盖掉运行时适配包（同名冲突）。
  const dirName = (pkg.manifest.name ?? `@pneuma/${pkg.id}`).replace(/^@[^/]+\//, '')
  if (dirName === 'runtime') {
    problems.push(`${pkg.id} 的包名不能是 @pneuma/runtime：这个名字留给构建生成的运行时适配包`)
    continue
  }
  const dest = join(outDir, dirName)
  const compiled = join(root, 'lib', 'packages', pkg.id, 'index.js')
  if (!existsSync(compiled)) {
    problems.push(`${pkg.id} 没有编译产物（lib/packages/${pkg.id}/index.js）`)
    continue
  }
  // 不复制，生成「再导出桩」：lib/packages/<id> 是唯一实体，
  // 探针与 App 直接 import 它，内核从 node_modules 里 import——两边必须是同一个模块实例，
  // 复制一份的话 commands 的 serviceRef 这类模块级单例就裂成两份（斜杠命令电池会当场红）。
  const srcPkgDir = join(root, 'lib', 'packages', pkg.id)
  for (const file of walkFiles(srcPkgDir)) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue
    const rel = relative(srcPkgDir, file)
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, stubBody(target, file), 'utf8')
  }
  /**
   * 译本不是模块：tsc 只搬 `.ts`，`locale/<语言>.json` 要在这里原样抄进产物。
   *
   * 不抄的后果不是报错，而是插件中心与 `numa plugin list` 在成品里永远显示中文原文——
   * 源码树里明明有 `locale/en.json`，装完就是没有，这种漂移最难查。
   */
  const localeSrc = join(pkg.dir, 'locale')
  if (existsSync(localeSrc)) {
    for (const file of walkFiles(localeSrc)) {
      const rel = relative(localeSrc, file)
      // 两个落点都要有：
      //   - 适配包目录（`lib/node_modules/@pneuma/<id>/locale`）：插件中心与 `numa plugin list` 从
      //     包元数据那一侧按目录找译本；
      //   - 真实模块目录（`lib/packages/<id>/locale`）：包自己的取词器按 `import.meta.dirname`
      //     找界面字典（`src/core/i18n.ts` 的 `hostT`）。少了这一份，运行期第一句话就是
      //     「缺 locale/ui.zh.json」——源码树里明明有，产物里没有，最难查。
      for (const base of [dest, srcPkgDir]) {
        const target = join(base, 'locale', rel)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, readFileSync(file))
      }
    }
  }
  /**
   * 提示词不是模块：tsc 只搬 `.ts`，`prompts/*.md` 要在这里原样抄进产物。
   *
   * 与 locale 同一个理由的两个落点：
   *   - 适配包目录（`lib/node_modules/@pneuma/<id>/prompts`）：发行版按包目录取文件；
   *   - 真实模块目录（`lib/packages/<id>/prompts`）：包自己按 `import.meta.dirname` 读
   *     （`adapters/executor.ts` 的 `buildWorkerPrompt`）。少了这一份，运行期就只剩内置兜底，
   *     源码里改的文案在成品里永远不生效——这种漂移最难查。
   *
   * 只拷 `.md`：目录里可能还放着设计草图、截图之类，模型不该看见；目录不存在就跳过
   * （绝大多数包没有提示词）。
   */
  const promptsSrc = join(pkg.dir, 'prompts')
  const skillsSrc = join(pkg.dir, 'skills')
  /**
   * 静态资产不是模块：tsc 只搬 `.ts`，`prompts` 与 `skills` 下的 `.md` 要在这里原样抄进产物。
   *
   * 落点与 locale 同两个：
   *   - 适配包目录（`lib/node_modules/@pneuma/<id>/prompts`）：发行版按包目录取文件；
   *   - 真实模块目录（`lib/packages/<id>/prompts`）：包自己按 `import.meta.dirname` 读
   *     （`adapters/executor.ts` 的 `buildWorkerPrompt`、`app/skill-files.ts` 的技能文件）。
   *     少了这一份，运行期就只剩内置兜底，源码里改的文案在成品里永远不生效。
   *
   * 只拷 `.md`：目录里可能还放着设计草图、截图之类，模型不该看见；目录不存在就跳过。
   */
  for (const [name, srcDir] of [['prompts', promptsSrc], ['skills', skillsSrc]]) {
    if (!existsSync(srcDir)) continue
    for (const file of walkFiles(srcDir)) {
      if (!file.endsWith('.md')) continue
      const rel = relative(srcDir, file)
      for (const base of [dest, srcPkgDir]) {
        const target = join(base, name, rel)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, readFileSync(file))
      }
    }
  }
  const pneuma = pkg.manifest.pneuma ?? {}
  /**
   * 只保留产物里**真的存在**的入口。
   *
   * 一个包两半边之后，界面半边的源码在包里（`./ui/ui.tsx`），但构建产物落
   * `lib/ui/plugins/<id>/client.js`，**不在包内**。照抄会留下一条
   * `import '@pneuma/<id>/client'` → ERR_MODULE_NOT_FOUND 的坏引用；
   * 内置界面半本来就不走 exports（走产物目录的 bundle.json），所以这里去掉它，
   * 把「这个包有界面半」这件事留在 `pneuma.client` 声明里（dsh 生态那边叫 `dsh.client`）。
   *
   * 通配符导出（`./locale/*.json`）没有字面文件可判：按「产物目录里有没有匹配」算，
   * 否则每条译本键都会被当成悬空引用删掉。
   */
  const existsInDest = (target) => {
    if (typeof target !== 'string') return false
    if (!target.includes('*')) return existsSync(join(dest, target))
    const dir = join(dest, dirname(target))
    const suffix = target.slice(target.lastIndexOf('*') + 1)
    return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(suffix))
  }
  // 基础两条永远在（`index.js` 是桩、`package.json` 还没写盘，别拿它们做过不过滤的判据）。
  const exports = {
    '.': './index.js',
    ...(pkg.manifest.exports ?? {}),
    './package.json': './package.json',
  }
  for (const [key, target] of Object.entries(pkg.manifest.exports ?? {})) {
    const targetPath =
      typeof target === 'string'
        ? target
        : target !== null && typeof target === 'object' && 'default' in target
          ? target.default
          : null
    // dsh 形状的 `{types, default}` 只看 default；认不出的保持原样，别替人做决定。
    // `.` 与 `./package.json` 是产物固定有的，不参与过滤（后者此刻还没写盘）。
    if (key === '.' || key === './package.json') continue
    if (targetPath !== null && typeof targetPath === 'string' && !existsInDest(targetPath)) {
      delete exports[key]
    }
  }
  /**
   * 产物清单的字段与源清单一一对应：**发版面（description / main / types / files）
   * 不许在构建这一步丢掉**。
   *
   * 为什么要在产物里也留一份：源清单是给门禁与作者看的，装到 node_modules 里的那份
   * 才是别人 import、编辑器找类型、npm 打包时真正读的。dsh 的包两边同形，我们少了这层
   * 就会出现「源码里 main 写着 index.js，装上去那份没有 main」——发行版解析落回默认，
   * 类型在编辑器里全丢，而且看不出来。
   *
   * files 只列产物里真的有的：README 不进包（它留在源码树），locale / prompts 有才列。
   */
  const outFiles = [
    'index.js',
    'index.d.ts',
    ...(existsSync(pkg.patchFile) ? ['cordis.patch.yml'] : []),
    ...(existsSync(localeSrc) ? ['locale/**'] : []),
    ...(existsSync(promptsSrc) ? ['prompts/**'] : []),
    ...(existsSync(skillsSrc) ? ['skills/**'] : []),
  ]
  const outManifest = {
    name: pkg.manifest.name ?? `@pneuma/${pkg.id}`,
    description: pkg.manifest.description ?? '',
    version: rootManifest.version,
    private: true,
    type: 'module',
    main: './index.js',
    types: './index.d.ts',
    exports,
    files: outFiles,
    pneuma,
    // pneuma.client 也要带过去：它是「这个包有界面半」在产物里的唯一声明（内置界面半的
    // 产物不在包内，exports 那条已被上面的过滤去掉）。
    ...(pkg.manifest.dsh === undefined ? {} : { dsh: pkg.manifest.dsh }),
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

// 库包也走同一套产物（子路径导出要指回 lib/packages/<id>），但它们没有行，
// 所以「功能包」只数带行的那些，库包单独报——否则数字会看起来像凭空多了个功能。
const libraryCount = generated.filter((pkg) => pkg.manifest.pneuma?.library === true).length
const featureCount = generated.length - libraryCount
console.log(`功能包：${featureCount} 个包，基础包 ${insert.length} 行 -> ${outDir}（另有库包 ${libraryCount} 个，不占行）`)
for (const problem of problems) console.error('问题：' + problem)
if (problems.length > 0) process.exit(1)
