/**
 * 生成运行时适配包 `lib/node_modules/@pneuma/runtime`。
 *
 * 为什么不把 src/core 搬走：插件要能以**裸说明符**引用内核（打包后的插件在
 * `lib/packages/<id>/`，相对路径指不过去），但探针与脚本有 166 处直接 import
 * `lib/core/*`。搬目录会把它们全部打断，还容易造出第二份模块实例
 * （`core/tools/command-runner.js` 是模块级 Map，两份副本 = 沙箱 fail-open）。
 *
 * 做法：每个模块生成一个只有一行的桩 `export * from '<指回 lib 的相对路径>'`。
 * 桩加载的真实模块 URL 仍是 `lib/core/x.js`，与探针、boot 加载的是同一个实例。
 *
 * @module scripts/build-runtime-package
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const lib = join(root, 'lib')
const dest = join(lib, 'node_modules', '@pneuma', 'runtime')

/**
 * 收进运行时包的目录（与 src 下的目录名一致）。
 *
 * `app` 与 `ui` 是终端壳要用的：tui 插件搬进功能包之后不能再写 `../app/App.js`
 * （打包后那是 lib/node_modules/app），只能走裸说明符。它们不进浏览器产物，
 * 只在 Node 侧解析。
 */
const ROOTS = ['core', 'contract', 'services', 'adapter', 'app', 'ui']

/** 界面构建产物目录不是模块，别给它们生成桩。 */
const SKIP = ['/ui/plugins/', '/ui/assets/']

const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 递归列出目录下的文件（绝对路径）。 */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

/** 一条桩的内容：把说明符写成相对 dest 文件的路径，统一正斜杠。 */
function stubBody(fromFile, toFile) {
  let rel = relative(dirname(fromFile), toFile).split('\\').join('/')
  if (!rel.startsWith('.')) rel = './' + rel
  return `export * from '${rel}';\n`
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

let stubs = 0
const missing = []

for (const name of ROOTS) {
  const srcDir = join(lib, name)
  try {
    statSync(srcDir)
  } catch {
    missing.push(name)
    continue
  }
  for (const file of walk(srcDir)) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue
    const normalized = file.split('\\').join('/')
    if (SKIP.some((part) => normalized.includes(part))) continue
    const rel = relative(lib, file)
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, stubBody(target, file), 'utf8')
    stubs += 1
  }
}

// 包的清单：不给 "." 入口（没有聚合模块，给了就是悬空），只给通配与 package.json。
writeFileSync(
  join(dest, 'package.json'),
  JSON.stringify(
    {
      name: '@pneuma/runtime',
      version: rootManifest.version,
      private: true,
      type: 'module',
      description: 'Pneuma 内核的模块视图：每个文件都是指回 lib 的再导出桩',
      exports: { './*': './*', './package.json': './package.json' },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

console.log(`运行时适配包：${stubs} 个桩 -> ${dest}`)
if (missing.length > 0) {
  console.error('缺少编译产物目录（先跑 tsc）：' + missing.join('、'))
  process.exit(1)
}
