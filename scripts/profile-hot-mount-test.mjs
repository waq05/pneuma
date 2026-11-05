/**
 * profile 清单热更自检：`numa plugin add/remove` 之后不重启宿主就生效。
 *
 * 五段，各验一条：
 *
 *   1. **起内核就挂上**：profile 清单里列一个组合包，宿主启动路径（mountAllExternalPlugins）
 *      把它 patch 里 insert 的行挂起来。
 *   2. **加包不重启**：不动进程，往 profile 的 package.json 追加第二个包，轮询一轮后
 *      第二个行挂上、第一个仍在。
 *   3. **删包真卸**：把第一个包从清单里去掉，一轮后它的行从 mounted 表消失、disposer 跑过；
 *      整份 profile 被删（package.json 不见了）也不许抛，挂过的行全卸掉。
 *   4. **patch 数组**：`bundle.patch` 写成 ["./a.yml", "./b.yml"]，两层的 insert 行都挂上；
 *      readBundle 也单测一遍（非字符串项跳过并告警、空数组等于没声明）。
 *   5. **接上轮询**：先由装配路径拉起轮询器、宿主启动路径后到，第二次调用要把 profile
 *      这一路补上（同一个轮询器），改清单后真能自动挂上。
 *
 * 夹具全在临时目录：HOME / DSC_HOME 都指过去，不碰真实 ~/.dsc；假应用是 lib 的一份拷贝
 * （cpSync），它的 node_modules 用 junction 借仓库那份，第三方包才解析得到。
 *
 * 跑法：node scripts/profile-hot-mount-test.mjs（需要先有 lib 构建产物）
 * 想拿别的构建产物跑：PNEUMA_TEST_LIB=.p2build node scripts/profile-hot-mount-test.mjs
 *
 * @module dsc/scripts/profile-hot-mount-test
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const libDir =
  process.env.PNEUMA_TEST_LIB === undefined
    ? join(repoRoot, 'lib')
    : resolve(repoRoot, process.env.PNEUMA_TEST_LIB)

const home = mkdtempSync(join(tmpdir(), 'dsc-profile-hot-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
// 固定一个 profile 名字：activeProfileDir() 认 DSC_PROFILE，测试因此不依赖 config.yaml。
process.env.DSC_PROFILE = 'test'
// 前四段手动驱动轮询（pollNow）保证时序；第五段再恢复默认，验「接上轮询」那一环。
process.env.DSC_HOT = '0'
mkdirSync(process.env.DSC_HOME, { recursive: true })

let pass = 0
let fail = 0
/** 一条断言：通过打印 PASS，失败打印 FAIL 并带现场。 */
function check(label, ok, extra) {
  if (ok) {
    pass += 1
    console.log('PASS  ' + label)
    return
  }
  fail += 1
  console.log('FAIL  ' + label + (extra === undefined || extra === '' ? '' : ' \u2192 ' + String(extra)))
}

const writeText = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ── 假应用：lib 的一份拷贝 + 借仓库 node_modules 的 junction ─────────────────
const appDir = join(home, 'app')
mkdirSync(appDir, { recursive: true })
cpSync(libDir, join(appDir, 'lib'), { recursive: true })
// 夹具应用没有自己的 node_modules：解析 @deepseek-ai/cordis、yaml、semver 时要落到仓库那份
// （junction 在 Windows 上不需要管理员权限，其他平台会被当成普通目录软链）。
const modulesLink = join(appDir, 'node_modules')
try {
  symlinkSync(join(repoRoot, 'node_modules'), modulesLink, 'junction')
} catch {
  symlinkSync(join(repoRoot, 'node_modules'), modulesLink, 'dir')
}

const libUrl = (relative) => pathToFileURL(join(appDir, 'lib', relative)).href

/**
 * 造一个自带包：真实代码在 `lib/packages/<id>/index.js`，入口是 `lib/node_modules/@pneuma/<id>`
 * 里的一行再导出桩（与 scripts/build-packages.mjs 的产物同形）。
 *
 * 包里记两个计数：apply 跑过（真挂上了）、disposer 跑过（真卸掉了）——只看 mounted 表
 * 分不清「卸了」和「从来没挂」。
 */
function makePackage(id) {
  const source = [
    "export const name = '" + id + "'",
    'export const inject = []',
    'export function apply() {',
    '  const state = (globalThis.__PROFILE_HOT = globalThis.__PROFILE_HOT ?? { applied: {}, disposed: {} })',
    "  state.applied['" + id + "'] = (state.applied['" + id + "'] ?? 0) + 1",
    '  return () => {',
    "    state.disposed['" + id + "'] = (state.disposed['" + id + "'] ?? 0) + 1",
    '  }',
    '}',
    '',
  ].join('\n')
  writeText(join(appDir, 'lib', 'packages', id, 'index.js'), source)
  writeText(
    join(appDir, 'lib', 'node_modules', '@pneuma', id, 'package.json'),
    JSON.stringify(
      {
        name: '@pneuma/' + id,
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.js', './package.json': './package.json' },
      },
      null,
      2,
    ) + '\n',
  )
  writeText(join(appDir, 'lib', 'node_modules', '@pneuma', id, 'index.js'), "export * from '../../../packages/" + id + "/index.js';\n")
}

// ── profile 夹具 ───────────────────────────────────────────────────────────
const profileDir = join(process.env.DSC_HOME, 'profiles', 'test')

/** 写 profile 清单（bundles 就是 `numa plugin add/remove` 改的那一行）。 */
function writeProfile(bundles) {
  writeText(join(profileDir, 'package.json'), JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles } } }, null, 2) + '\n')
}

/** 一个组合包的清单：`pneuma.bundle.patch` 写字符串或字符串数组。 */
function bundleManifest(name, patch) {
  return JSON.stringify({ name, version: '1.0.0', pneuma: { bundle: { patch } } }, null, 2) + '\n'
}

/** 造一个装在 profile 里的组合包（包名决定目录：@probe/one -> node_modules/@probe/one）。 */
function writeBundle(name, files) {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  for (const [file, text] of Object.entries(files)) writeText(join(dir, file), text)
  return dir
}

// ── 加载被测模块（必须在 HOME / DSC_HOME 指好之后）──────────────────────────
const { Context } = await import('@deepseek-ai/cordis')
const loader = await import(libUrl('core/plugin-loader.js'))
const bundleModule = await import(libUrl('core/plugin-bundle.js'))
const registry = await import(libUrl('core/plugin-registry.js'))
const watchModule = await import(libUrl('core/plugin-watch.js'))

// 夹具：第一个包 + 它的组合包 + profile 清单
makePackage('probe-a')
writeBundle('@probe/one', {
  'package.json': bundleManifest('@probe/one', './cordis.patch.yml'),
  'cordis.patch.yml': "- insert:\n    - id: probe-a\n      name: '@pneuma/probe-a'\n",
})
writeProfile(['@probe/one'])

/** 当前 root 上已挂载的行 id（走 loader 的公开读口，不自造一张表）。 */
const mountedIds = () => loader.listMountedPluginSources().map((item) => item.identity)
/** 插件中心那一条元数据（验「这一行记着来自哪个组合包」）。 */
const infoOf = (id) => registry.listPluginInfos().find((item) => item.file === id)

// ── 1. 起内核就挂上 ────────────────────────────────────────────────────────
console.log('── 1. 起内核：profile 里的组合包行挂上 ──')
const root = new Context()
// 裸 Context 没有 transcript 服务：mountAllExternalPlugins 只在有告警时用它。
try {
  Object.defineProperty(root, 'transcript', { value: { system() {} }, configurable: true })
} catch {
  // 拿不到就算了：夹具干净，走不到写 transcript 那一步。
}
const failures = await loader.mountAllExternalPlugins(root, [])
check('profile 里的包装上了（probe-a）', failures.length === 0 && mountedIds().includes('probe-a'), JSON.stringify({ failures, mounted: mountedIds() }))
check('这一行真的 apply 过', (globalThis.__PROFILE_HOT?.applied?.['probe-a'] ?? 0) === 1, JSON.stringify(globalThis.__PROFILE_HOT))
check('这一行记着来源组合包（meta.bundle = one）', infoOf('probe-a')?.bundle === 'one', JSON.stringify(infoOf('probe-a')))

// ── 2. 加包不重启 ──────────────────────────────────────────────────────────
console.log('── 2. 加包不重启：追加第二个包，一轮后挂上 ──')
const logs = { info: [], warn: [] }
const handle = watchModule.createPluginWatch({
  root,
  profileDir,
  // 定时器拉到很远：这一段手动 pollNow，时序才可复现（去抖仍然生效）。
  pollIntervalMs: 600000,
  debounceMs: 120,
  logger: { info: (line) => logs.info.push(line), warn: (line) => logs.warn.push(line) },
})
await handle.pollNow()
check('清单没动时一轮扫描不重算', logs.info.length === 0 && logs.warn.length === 0, logs.info.concat(logs.warn).join(' | '))

makePackage('probe-b')
writeBundle('@probe/two', {
  'package.json': bundleManifest('@probe/two', './cordis.patch.yml'),
  'cordis.patch.yml': "- insert:\n    - id: probe-b\n      name: '@pneuma/probe-b'\n",
})
writeProfile(['@probe/one', '@probe/two'])
await handle.pollNow()
check('第二个包装上了（没重启宿主）', mountedIds().includes('probe-b'), JSON.stringify(mountedIds()))
check('第一个包还在', mountedIds().includes('probe-a'), JSON.stringify(mountedIds()))
check('第二个行也 apply 过', (globalThis.__PROFILE_HOT?.applied?.['probe-b'] ?? 0) === 1, JSON.stringify(globalThis.__PROFILE_HOT))
check('日志写了「profile 清单变了，重算组合包」', logs.info.includes('[plugin-watch] profile 清单变了，重算组合包'), logs.info.join(' | '))
check('日志写了「挂了 1 行 / 卸了 0 行」', logs.info.includes('[plugin-watch] 挂了 1 行 / 卸了 0 行'), logs.info.join(' | '))

// ── 3. 删包真卸 + 整个 profile 被删 ─────────────────────────────────────────
console.log('── 3. 删包真卸：清单去掉谁，谁的行下来 ──')
writeProfile(['@probe/two'])
await handle.pollNow()
check('删掉的包的行从 mounted 表里消失', !mountedIds().includes('probe-a'), JSON.stringify(mountedIds()))
check('被删的行跑过 disposer', (globalThis.__PROFILE_HOT?.disposed?.['probe-a'] ?? 0) === 1, JSON.stringify(globalThis.__PROFILE_HOT))
check('没被删的包不受影响', mountedIds().includes('probe-b'), JSON.stringify(mountedIds()))
check('日志写了「挂了 0 行 / 卸了 1 行」', logs.info.includes('[plugin-watch] 挂了 0 行 / 卸了 1 行'), logs.info.join(' | '))

rmSync(join(profileDir, 'package.json'))
let threw = null
try {
  await handle.pollNow()
} catch (error) {
  threw = error
}
check('profile 整个被删也不抛错', threw === null, String(threw))
check('profile 挂过的行全卸掉', !mountedIds().includes('probe-b'), JSON.stringify(mountedIds()))

// ── 4. patch 字符串数组：多层按顺序叠 ──────────────────────────────────────
console.log('── 4. patch 数组：一个包声明两份 patch 文件 ──')
makePackage('probe-c')
makePackage('probe-d')
writeBundle('@probe/three', {
  'package.json': bundleManifest('@probe/three', ['./a.yml', './b.yml']),
  'a.yml': "- insert:\n    - id: probe-c\n      name: '@pneuma/probe-c'\n",
  'b.yml': "- insert:\n    - id: probe-d\n      name: '@pneuma/probe-d'\n",
})
writeProfile(['@probe/three'])
await handle.pollNow()
check('第一层插的行挂上了（probe-c）', mountedIds().includes('probe-c'), JSON.stringify(mountedIds()))
check('第二层插的行挂上了（probe-d）', mountedIds().includes('probe-d'), JSON.stringify(mountedIds()))
check('两层插的行都记着同一个来源（three）', infoOf('probe-c')?.bundle === 'three' && infoOf('probe-d')?.bundle === 'three', JSON.stringify([infoOf('probe-c'), infoOf('probe-d')]))

// readBundle 的形状单独钉一遍：上面那一段验证的是「装进去能用」，这里验证读盘口径。
const unitsDir = join(home, 'units')
function writeUnit(name, manifest, files) {
  const dir = join(unitsDir, name)
  for (const [file, text] of Object.entries(files ?? {})) writeText(join(dir, file), text)
  writeText(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }, null, 2) + '\n')
  return dir
}
const twoLayers = writeUnit('two-layers', { pneuma: { bundle: { patch: ['./a.yml', './b.yml'] } } }, {
  'a.yml': '- insert:\n    - id: x\n',
  'b.yml': '- insert:\n    - id: y\n',
})
const infoTwo = bundleModule.readBundle(twoLayers)
check('patch 写数组 → 两层都读出来', infoTwo.patch.length === 2 && infoTwo.warnings.length === 0, JSON.stringify(infoTwo.patch.map((layer) => layer.label)))
check('多层的标签带文件名（诊断分得清是哪一份）', infoTwo.patch[0].label.includes('a.yml') && infoTwo.patch[1].label.includes('b.yml'), JSON.stringify(infoTwo.patch.map((layer) => layer.label)))

const mixed = writeUnit('mixed-layers', { pneuma: { bundle: { patch: ['./a.yml', 42] } } }, { 'a.yml': '- insert:\n    - id: x\n' })
const infoMixed = bundleModule.readBundle(mixed)
check('数组里的非字符串项跳过、其余照收', infoMixed.patch.length === 1 && infoMixed.warnings.length === 1, JSON.stringify(infoMixed))
check('告警说清是第几项', String(infoMixed.warnings[0]).includes('第 2 项'), JSON.stringify(infoMixed.warnings))

const emptyLayers = writeUnit('empty-layers', { pneuma: { bundle: { patch: [] } } })
const infoEmpty = bundleModule.readBundle(emptyLayers)
check('patch 写空数组 = 没声明（也不告警）', infoEmpty.patch.length === 0 && infoEmpty.warnings.length === 0, JSON.stringify(infoEmpty))

const singleLayer = writeUnit('single-layer', { pneuma: { bundle: { patch: './cordis.patch.yml' } } }, { 'cordis.patch.yml': '- insert:\n    - id: x\n' })
const infoSingle = bundleModule.readBundle(singleLayer)
check('字符串写法照旧（单层标签不变）', infoSingle.patch.length === 1 && infoSingle.patch[0].label === 'single-layer v1.0.0', JSON.stringify(infoSingle.patch.map((layer) => layer.label)))

// ── 5. 接上轮询：装配路径先起，宿主启动路径后到 ────────────────────────────
console.log('── 5. 接上轮询：第二次启动补 profile 这一路 ──')
handle.stop()
delete process.env.DSC_HOT
makePackage('probe-e')
writeBundle('@probe/four', {
  'package.json': bundleManifest('@probe/four', './cordis.patch.yml'),
  'cordis.patch.yml': "- insert:\n    - id: probe-e\n      name: '@pneuma/probe-e'\n",
})
writeProfile(['@probe/three'])

const root2 = new Context()
try {
  Object.defineProperty(root2, 'transcript', { value: { system() {} }, configurable: true })
} catch {
  // 同第 1 段：夹具干净时用不到。
}
// 第一次：只有行/库包两路（模拟装配路径先拉起轮询器，那时还不知道 profile 在哪）。
const first = watchModule.startPluginWatch(root2, { appDir })
// 宿主启动路径后到：它带 profileDir，应该把清单这一路补上，而不是另起一个轮询器。
await loader.mountAllExternalPlugins(root2, [])
const second = watchModule.startPluginWatch(root2, { appDir })
check('二次启动返回同一个轮询器（没有重建）', first === second)
check('root2 上组合包的行都挂上了', ['probe-c', 'probe-d'].every((id) => mountedIds().includes(id)), JSON.stringify(mountedIds()))

writeProfile(['@probe/three', '@probe/four'])
// 默认 1000ms 一轮 + 200ms 去抖：留 3.2s，慢机器也够。
await sleep(3200)
check('补上的那一路上真的在跑：新包装上了', mountedIds().includes('probe-e'), JSON.stringify(mountedIds()))
check('新行也 apply 过', (globalThis.__PROFILE_HOT?.applied?.['probe-e'] ?? 0) === 1, JSON.stringify(globalThis.__PROFILE_HOT))
watchModule.stopPluginWatch()

console.log('')
console.log(pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
