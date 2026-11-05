/**
 * 库包自检：没有行、不参与开关的包（库包）能不能被 import、算不算缺口、热更生不生效。
 *
 * 四段，各验一条：
 *
 *   1. **库包不进清单**：没有 cordis.patch.yml、标了 pneuma.library 的包照常构建、
 *      能挂引用它的功能包，但它自己没有行、不进插件清单；plugin-model-check 也不把它算缺口。
 *   2. **代数 0 是同一实例**：库包的再导出桩与应用内真实文件指向同一个模块实例
 *      （探针里比较导出的对象引用，而不是比较值）。
 *   3. **库包真的热更**：改库包真实文件 + bump + 重挂引用它的行，新行拿到的是新库。
 *      这条在补基建之前是失效的——库包没有行，桩目录从没登记成功能包路径，
 *      解析结果停在代数 0，换代的只有引用方。
 *   4. **覆盖版包能 import 库包**：profile 里的包 import @pneuma/<库包> 会重定向到应用内
 *      那一份（否则从 profile 的 node_modules 往上找不到，ERR_MODULE_NOT_FOUND），
 *      并且重定向结果照样打代数戳，换代后拿到新库。
 *
 * 第五段是门禁的夹具：功能包 → 库包允许；功能包 → 功能包、库包 → 任何包、core → 包
 * 都记 gap，断言的是**文案**；包标准闸也跑同一批夹具，确认两个门禁给出同一句判定。
 *
 * 第六段是库包热更：只改库包、不碰引用方，轮询要把引用它的行重挂并拿到新库；库包写坏
 * 时旧版本继续跑且只有一条 warn；没有引用方的库包改了不重挂、不写日志；一次变更命中
 * 两行时只换代一次，两行拿到同一个库实例。
 *
 * 夹具全部造在临时目录（HOME / DSC_HOME 都指过去），不碰真实的 ~/.dsc。
 * 运行：pnpm build && node scripts/plugin-library-test.mjs
 * 想拿别的构建产物跑（例如临时 tsc 输出目录）：
 *   PNEUMA_TEST_LIB=.p2build node scripts/plugin-library-test.mjs
 *
 * @module dsc/scripts/plugin-library-test
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const libDir =
  process.env.PNEUMA_TEST_LIB === undefined
    ? join(repoRoot, 'lib')
    : resolve(repoRoot, process.env.PNEUMA_TEST_LIB)

const home = mkdtempSync(join(tmpdir(), 'dsc-plugin-library-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
// 这条自检自己指定 appDir，不让 config.yaml 里的 profile 混进来
delete process.env.DSC_PROFILE
// 手动换代 / 重挂：不让装配自动拉起的轮询抢同一份状态
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
const libUrl = (relative) => pathToFileURL(join(libDir, relative)).href
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 全局观察点：模块顶层与 apply 都往这里写，跑完从它身上读「哪一份真的在跑」。 */
globalThis.__LIB_TEST = {}

// ── 夹具：应用副本（库包 + 引用它的功能包 + base 清单）──────────────────────────

/**
 * 造一个包：真实代码在 lib/packages/<id>/，入口是 lib/node_modules/@pneuma/<id>/ 的再导出桩
 * （与 build-packages.mjs 的产物同形）。
 * @param appRoot - 应用目录
 * @param id - 目录名 / 包名后半段
 * @param source - 真实文件源码
 * @param pneuma - 清单里的 pneuma 字段（库包写 { library: true }）
 */
function makePackage(appRoot, id, source, pneuma) {
  const realFile = join(appRoot, 'lib', 'packages', id, 'index.js')
  writeText(realFile, source)
  const stubDir = join(appRoot, 'lib', 'node_modules', '@pneuma', id)
  writeText(
    join(stubDir, 'package.json'),
    JSON.stringify(
      {
        name: '@pneuma/' + id,
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.js', './package.json': './package.json' },
        pneuma,
      },
      null,
      2,
    ) + '\n',
  )
  const stubFile = join(stubDir, 'index.js')
  writeText(stubFile, "export * from '../../../packages/" + id + "/index.js';\n")
  return { realFile, stubFile }
}

/** 库包源码：版本、一个用于比引用的对象、一个「这份模块被求值过几次」的计数器。 */
const libSource = (version) => `export const LIB_VERSION = '${version}'
export const LIB_TOKEN = { version: '${version}' }
export const LIB_LOAD = (globalThis.__LIB_TEST.libLoads = (globalThis.__LIB_TEST.libLoads ?? 0) + 1)
`

/** 功能包源码：在模块顶层 import 库包，apply 时把看到的值记下来。 */
const featSource = `import { LIB_VERSION, LIB_TOKEN } from '@pneuma/libx'
export const name = 'feat'
export const inject = []
export function apply() {
  globalThis.__LIB_TEST.seen = { version: LIB_VERSION, token: LIB_TOKEN }
}
`

/** profile 里的覆盖版包：declare 在 profile 的 node_modules 下，只 import 库包。 */
const overrideSource = `import { LIB_VERSION, LIB_TOKEN } from '@pneuma/libx'
export const name = 'override'
export const inject = []
export function apply() {
  globalThis.__LIB_TEST.overrideSeen = { version: LIB_VERSION, token: LIB_TOKEN }
}
`

/** 写一份应用自带行清单（@pneuma/base 的清单 + 那一层 insert 行）。 */
function makeBase(appRoot, rows) {
  const baseDir = join(appRoot, 'lib', 'node_modules', '@pneuma', 'base')
  writeText(
    join(baseDir, 'package.json'),
    JSON.stringify({ name: '@pneuma/base', version: '1.0.0', type: 'module' }, null, 2) + '\n',
  )
  const lines = rows.map((row) => '    - id: ' + row.id + "\n      name: '" + row.name + "'\n").join('')
  writeText(join(baseDir, 'cordis.patch.yml'), '- insert:\n' + lines)
}

const appDir = join(home, 'app')
const lib = makePackage(appDir, 'libx', libSource('v1'), { library: true })
const feat = makePackage(appDir, 'feat', featSource, { title: '引用库包的功能包' })
makeBase(appDir, [{ id: 'feat', name: '@pneuma/feat' }])

// ── 加载被测模块（必须在 HOME/DSC_HOME 指好之后）──────────────────────────────
const { Context } = await import('@deepseek-ai/cordis')
const loader = await import(libUrl('core/plugin-loader.js'))
const registry = await import(libUrl('core/plugin-registry.js'))
const resolveHook = await import(libUrl('core/dsh-compat/resolve-hook.js'))
const watchModule = await import(libUrl('core/plugin-watch.js'))

// 解析钩子先登记，应用根 = 夹具应用：库包重定向查的就是这个根。
// （钩子是进程级单例，第一次登记的根说了算，所以必须在任何挂载之前。）
resolveHook.ensureResolveHook([], appDir)

const infos = () => registry.listPluginInfos()
const infoOf = (file) => infos().find((item) => item.file === file)

// ── 1. 库包不进清单：没有行、照样被 import ─────────────────────────────────────
console.log('── 1. 库包：没有行、不进插件清单、照常被 import ──')
{
  const root = new Context()
  const failures = await loader.mountApplicationRows(root, { appDir, surface: 'none' })
  const basePatch = readFileSync(join(appDir, 'lib', 'node_modules', '@pneuma', 'base', 'cordis.patch.yml'), 'utf8')

  check('引用库包的功能包挂上了', failures.length === 0, JSON.stringify(failures))
  check('功能包拿到了库包的值', globalThis.__LIB_TEST.seen?.version === 'v1', JSON.stringify(globalThis.__LIB_TEST.seen))
  check('库包没有行（base 清单里只有 feat）', basePatch.includes('feat') && !basePatch.includes('libx'), basePatch)
  check('库包不进插件清单', infoOf('libx') === undefined, JSON.stringify(infos().map((item) => item.file)))
  check('插件清单里只有功能包那一行', infos().length === 1 && infos()[0].file === 'feat', JSON.stringify(infos().map((item) => item.file)))
}

// ── 2. 代数 0：桩与实际文件是同一个模块实例 ────────────────────────────────────
console.log('── 2. 代数 0：库包桩与应用内同一实例 ──')
{
  const viaStub = await import(pathToFileURL(lib.stubFile).href)
  const viaApp = await import(pathToFileURL(lib.realFile).href)

  check('桩导出的对象与实际文件是同一个引用', viaStub.LIB_TOKEN === viaApp.LIB_TOKEN, String(viaStub.LIB_TOKEN) + ' != ' + String(viaApp.LIB_TOKEN))
  check('没有因为多一条解析路径而多求值一次', globalThis.__LIB_TEST.libLoads === 1, String(globalThis.__LIB_TEST.libLoads))
  check('值也对得上', viaStub.LIB_VERSION === 'v1' && viaApp.LIB_VERSION === 'v1', String(viaStub.LIB_VERSION))
}

// ── 3. 库包热更：改库 + 换代 + 重挂引用方 → 新行拿到新库 ───────────────────────
console.log('── 3. 库包热更：改库包代码后重挂引用它的行 ──')
{
  const before = globalThis.__LIB_TEST.seen?.token
  // 只改库包的真实文件：桩一个字节不动（这正是旧实现的破绽）。
  writeText(lib.realFile, libSource('v2'))
  const bumped = loader.bumpGeneration()
  const result = await loader.remountExternalPlugin('feat')

  check('换代后重挂成功', result.ok === true, JSON.stringify(result))
  check('重挂用的是新代数', result.generation > bumped, String(bumped) + ' -> ' + String(result.generation))
  check('新行拿到的是新库（这条以前失效）', globalThis.__LIB_TEST.seen?.version === 'v2', String(globalThis.__LIB_TEST.seen?.version))
  check('拿到的是新实例（不是旧对象）', globalThis.__LIB_TEST.seen?.token !== before, '还是同一个对象')
  check('库包模块重新求值过一次', globalThis.__LIB_TEST.libLoads === 2, String(globalThis.__LIB_TEST.libLoads))

  const viaStub = await import(pathToFileURL(lib.stubFile).href)
  check('换代后桩导出的也是新库', viaStub.LIB_VERSION === 'v2', String(viaStub.LIB_VERSION))
}

// ── 4. 覆盖版包 import 库包：重定向到应用内那一份，且跟着换代 ──────────────────
console.log('── 4. 覆盖版包 import 库包：解析到应用内那一份 ──')
{
  const profileDir = join(home, 'profiles', 'override')
  writeText(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'profile-override', dsh: { profile: { bundles: [] } } }, null, 2) + '\n',
  )
  writeText(join(profileDir, 'cordis.patch.yml'), "- insert:\n    - id: override\n      name: '@p3/override'\n")
  // 覆盖版包按安装形态直接住在 profile 的 node_modules 下（不是应用里的再导出桩）。
  const overrideDir = join(profileDir, 'node_modules', '@p3', 'override')
  writeText(
    join(overrideDir, 'package.json'),
    JSON.stringify(
      { name: '@p3/override', version: '1.0.0', type: 'module', exports: { '.': './index.js', './package.json': './package.json' } },
      null,
      2,
    ) + '\n',
  )
  writeText(join(overrideDir, 'index.js'), overrideSource)

  const root = new Context()
  const result = await loader.mountBundlePlugins(root, profileDir, { appDir })
  check('覆盖版包挂上了（没有 ERR_MODULE_NOT_FOUND）', result.failures.length === 0, JSON.stringify(result.failures))
  check('覆盖版包 import 到了应用内的库包', globalThis.__LIB_TEST.overrideSeen?.version === 'v2', String(globalThis.__LIB_TEST.overrideSeen?.version))

  writeText(lib.realFile, libSource('v3'))
  loader.bumpGeneration()
  const remounted = await loader.remountExternalPlugin('override')
  check('覆盖版包换代重挂成功', remounted.ok === true, JSON.stringify(remounted))
  check('重定向结果也带代数戳（拿到 v3）', globalThis.__LIB_TEST.overrideSeen?.version === 'v3', String(globalThis.__LIB_TEST.overrideSeen?.version))
}

// ── 5. 依赖方向门禁：功能包→库包允许，其余记 gap ──────────────────────────────
console.log('── 5. 依赖方向门禁：允许与禁止的文案 ──')
{
  /** 造一个「仓库根」：三个入口 + src/packages 下的若干包（清单字段按包标准闸的完整要求写）。 */
  const makeRoot = (name, packages) => {
    const dir = join(home, 'gate', name)
    // 夹具根也要有 package.json：包标准闸的版本项是「等于根版本」，没有根就无从比较。
    writeText(join(dir, 'package.json'), JSON.stringify({ name: 'gate-fixture', version: '0.0.0-fixture' }, null, 2) + '\n')
    writeText(join(dir, 'src', 'host', 'kernel.ts'), 'export const kernel = 1\n')
    writeText(join(dir, 'src', 'boot.ts'), 'export const boot = 1\n')
    writeText(join(dir, 'src', 'headless.ts'), 'export const headless = 1\n')
    for (const pkg of packages) {
      // 清单形状与真包一致（含发版四个字段与条件导出的根入口）：门禁第 1、2 项按它判，
      // 夹具少一行就会假红，那种红最费时间。
      const manifest = {
        name: '@pneuma/' + pkg.id,
        description: '门禁夹具包',
        version: '0.0.0-fixture',
        private: true,
        type: 'module',
        main: './index.js',
        types: './index.d.ts',
        exports: {
          '.': { types: './index.d.ts', default: './index.js' },
          ...(pkg.patch === true ? { './cordis.patch.yml': './cordis.patch.yml' } : {}),
          './package.json': './package.json',
        },
        files: ['index.js', 'index.d.ts'],
        engines: { pneuma: '>=1.0.0 <2.0.0' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.4' },
        pneuma: pkg.pneuma,
      }
      writeText(join(dir, 'src', 'packages', pkg.id, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
      writeText(join(dir, 'src', 'packages', pkg.id, 'index.ts'), pkg.source)
      // 第 8 项（文档与测试）是硬项：夹具包也得齐，否则「库包不红」那条会假红。
      writeText(
        join(dir, 'src', 'packages', pkg.id, 'README.md'),
        '# ' + pkg.id + '\n\n夹具包。\n\n## Model Experience\n\n夹具包。\n\n## Known Limitations\n\n- 只用于门禁夹具。\n',
      )
      writeText(join(dir, 'src', 'packages', pkg.id, 'tests', pkg.id + '.test.mjs'), 'export {}\n')
      if (pkg.patch !== true) continue
      writeText(join(dir, 'src', 'packages', pkg.id, 'cordis.patch.yml'), "- insert:\n    - id: " + pkg.id + "\n      name: '@pneuma/" + pkg.id + "'\n")
    }
    return dir
  }

  /** 跑一次真门禁（两个脚本都认 PNEUMA_CHECK_ROOT），拿它打印的 JSON。 */
  const runCheck = (script, dir) => {
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', script), '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PNEUMA_CHECK_ROOT: dir },
    })
    let parsed = null
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      parsed = null
    }
    return { status: result.status, parsed, stdout: result.stdout, stderr: result.stderr }
  }
  const runModel = (dir) => runCheck('plugin-model-check.mjs', dir)
  const runStandard = (dir) => runCheck('plugin-standard-check.mjs', dir)
  /** 拿包标准闸某一项的汇总行（passed / applicable / exempt 在 summary.hard 里）。 */
  const hardOf = (run, item) => (run.parsed?.summary?.hard ?? []).find((entry) => entry.item === item)

  // 5a：功能包 import 库包 = 允许，一条缺口都不该有
  const okDir = makeRoot('ok', [
    { id: 'liba', pneuma: { library: true }, source: 'export const LIB = 1\n' },
    {
      id: 'feat-ok',
      pneuma: { bundle: { patch: './cordis.patch.yml' }, resolution: 'overridable', order: 100 },
      patch: true,
      source: "import { LIB } from '@pneuma/liba/index.js'\nexport function apply() { return LIB }\n",
    },
  ])
  const okRun = runModel(okDir)
  check('功能包 → 库包不记缺口', okRun.status === 0 && okRun.parsed?.summary.gaps === 0, JSON.stringify(okRun.parsed?.gaps))
  check('库包单独计数（不算功能包）', okRun.parsed?.summary.libraries === 1 && okRun.parsed?.summary.packages === 1, JSON.stringify(okRun.parsed?.summary))

  // 5b：包标准闸也认库包：豁免 patch / 行 / 入口导出，其余照要求
  const okStandard = runStandard(okDir)
  check('包标准闸：库包不红（exit 0）', okStandard.status === 0, okStandard.stdout + okStandard.stderr)
  check(
    '包标准闸：库包的清单字段照要求，只豁免 行/入口导出/order',
    hardOf(okStandard, 1)?.passed === 2 &&
      hardOf(okStandard, 1)?.applicable === 2 &&
      hardOf(okStandard, 4)?.passed === 1 &&
      hardOf(okStandard, 4)?.exempt === 1 &&
      hardOf(okStandard, 5)?.passed === 1 &&
      hardOf(okStandard, 5)?.exempt === 1,
    JSON.stringify(okStandard.parsed?.summary?.hard),
  )
  check(
    '包标准闸：库包没有行也不报错（不会拿空 patch 判失败）',
    hardOf(okStandard, 4)?.issues === 0 && hardOf(okStandard, 7)?.passed === 1,
    JSON.stringify(okStandard.parsed?.hard),
  )

  // 5c：没 patch、也没标 pneuma.library 的包：两个门禁都该红
  const noFlagDir = makeRoot('no-flag', [
    { id: 'forgot', pneuma: {}, source: 'export const value = 1\n' },
  ])
  const noFlagModel = runModel(noFlagDir)
  const noFlagStandard = runStandard(noFlagDir)
  const noFlagIssues = (noFlagStandard.parsed?.hard ?? []).flatMap((entry) => entry.issues).join('\n')
  check(
    '忘写 patch 又没标库包：model-check 记缺口',
    (noFlagModel.parsed?.gaps ?? []).some((item) => item.detail.includes('没标 pneuma.library')),
    JSON.stringify(noFlagModel.parsed?.gaps),
  )
  check(
    '忘写 patch 又没标库包：standard-check 第 1 项也红',
    noFlagStandard.status === 1 && noFlagIssues.includes('pneuma.library = true'),
    noFlagIssues,
  )

  // 5d：功能包 import 功能包、库包 import 任何包、core import 包 = 三条缺口
  const badDir = makeRoot('bad', [
    { id: 'liba', pneuma: { library: true }, source: 'export const LIB = 1\n' },
    {
      id: 'feat-a',
      pneuma: { bundle: { patch: './cordis.patch.yml' }, resolution: 'overridable', order: 100 },
      patch: true,
      source: 'export function apply() {}\n',
    },
    {
      id: 'feat-b',
      pneuma: { bundle: { patch: './cordis.patch.yml' }, resolution: 'overridable', order: 110 },
      patch: true,
      source: "import { a } from '@pneuma/feat-a/index.js'\nexport function apply() { return a }\n",
    },
    { id: 'lib-bad', pneuma: { library: true }, source: "import { a } from '@pneuma/feat-a/index.js'\nexport const c = a\n" },
  ])
  writeText(join(badDir, 'src', 'core', 'leak.ts'), "import type { LIB } from '@pneuma/liba/index.js'\nexport type L = typeof LIB\n")
  const badRun = runModel(badDir)
  const gapText = (badRun.parsed?.gaps ?? []).map((item) => item.detail).join('\n')
  check('有缺口时 --strict 退出 1', spawnSync(process.execPath, [join(repoRoot, 'scripts', 'plugin-model-check.mjs'), '--strict'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PNEUMA_CHECK_ROOT: badDir },
  }).status === 1)
  check(
    '功能包 → 功能包被判失败（文案带两个包名）',
    gapText.includes('功能包「feat-b」直接 import 了功能包「feat-a」'),
    gapText,
  )
  check(
    '库包 → 功能包被判失败（文案说明库包只许用 node 内置与运行时包）',
    gapText.includes('库包「lib-bad」直接 import 了功能包「feat-a」') && gapText.includes('node 内置'),
    gapText,
  )
  check(
    'core → 包被判失败（import type 也算）',
    gapText.includes('src/core/leak.ts') && gapText.includes('含 import type'),
    gapText,
  )
  check('三条缺口全是 dep-direction', (badRun.parsed?.gaps ?? []).every((item) => item.kind === 'dep-direction'), JSON.stringify(badRun.parsed?.gaps))

  // 5e：同一批越界，包标准闸给出同一句判定（判据共用 plugin-dep-graph）
  const badStandard = runStandard(badDir)
  const standardIssues = (badStandard.parsed?.hard ?? []).flatMap((entry) => entry.issues).join('\n')
  check(
    '包标准闸：功能包 → 功能包同样红',
    badStandard.status === 1 && standardIssues.includes('功能包「feat-b」直接 import 了功能包「feat-a」'),
    standardIssues,
  )
  check(
    '包标准闸：库包 → 功能包同样红（两处文案一致）',
    standardIssues.includes('库包「lib-bad」直接 import 了功能包「feat-a」'),
    standardIssues,
  )
  check(
    '包标准闸：core → 包同样红（含 import type）',
    standardIssues.includes('src/core/leak.ts') && standardIssues.includes('含 import type'),
    standardIssues,
  )

  // 5f：这一轮新加的两条 —— 功能包不导出 patch 文件、README 的限制一节只有标题没有条目。
  // 反向夹具必须有：一条闸只要没被人故意弄红过，就不知道它到底在不在判。
  const missingExportDir = makeRoot('missing-patch-export', [
    {
      id: 'feat-noexport',
      pneuma: { bundle: { patch: './cordis.patch.yml' }, resolution: 'overridable', order: 100 },
      patch: true,
      source: 'export function apply() {}\n',
    },
  ])
  const manifestFile = join(missingExportDir, 'src', 'packages', 'feat-noexport', 'package.json')
  const shape = JSON.parse(readFileSync(manifestFile, 'utf8'))
  delete shape.exports['./cordis.patch.yml']
  writeText(manifestFile, JSON.stringify(shape, null, 2) + '\n')
  const noExportRun = runStandard(missingExportDir)
  const noExportIssues = (noExportRun.parsed?.hard ?? []).flatMap((entry) => entry.issues).join('\n')
  check(
    '功能包不导出 ./cordis.patch.yml：包标准闸第 1 项红',
    noExportRun.status === 1 && noExportIssues.includes('cordis.patch.yml'),
    noExportIssues,
  )

  const thinReadmeDir = makeRoot('thin-readme', [
    {
      id: 'feat-thin',
      pneuma: { bundle: { patch: './cordis.patch.yml' }, resolution: 'overridable', order: 100 },
      patch: true,
      source: 'export function apply() {}\n',
    },
  ])
  writeText(
    join(thinReadmeDir, 'src', 'packages', 'feat-thin', 'README.md'),
    '# feat-thin\n\n夹具包。\n\n## Model Experience\n\n## Known Limitations\n\n- 只用于门禁夹具。\n',
  )
  const thinRun = runStandard(thinReadmeDir)
  const thinIssues = (thinRun.parsed?.hard ?? []).flatMap((entry) => entry.issues).join('\n')
  check(
    'Model Experience 只有标题没有正文：包标准闸第 8 项红',
    thinRun.status === 1 && thinIssues.includes('Model Experience'),
    thinIssues,
  )
}

// ── 6. 库包热更：只改库包，引用它的行自动换代 ────────────────────────────────
console.log('── 6. 库包热更：轮询盯库包，改库即重挂引用方 ──')
{
  // 复用第 1 段的 appDir（libx + 引用它的 feat 都在）。再放一个没有引用方的库包 liby，
  // 用来验「改了也不重挂、不刷日志」。
  const lonely = makePackage(appDir, 'liby', libSource('y1'), { library: true })

  /** 新开一个 root 重挂应用自带行：plugin-watch 的默认 targets 读当前 root 上的行。 */
  const mountWatched = async () => {
    const root = new Context()
    const failures = await loader.mountApplicationRows(root, { appDir, surface: 'none' })
    return { root, failures }
  }

  const first = await mountWatched()
  check(
    '热更夹具挂上了（基线拿到 v3）',
    first.failures.length === 0 && globalThis.__LIB_TEST.seen?.version === 'v3',
    JSON.stringify(first.failures) + ' / ' + String(globalThis.__LIB_TEST.seen?.version),
  )

  const logs = { info: [], warn: [] }
  const watch = watchModule.createPluginWatch({
    appDir,
    pollIntervalMs: 20,
    debounceMs: 50,
    logger: {
      info: (line) => logs.info.push(line),
      warn: (line) => logs.warn.push(line),
    },
  })
  try {
    // a) 只改库包文件（引用方一个字节不碰）→ 轮询发现、重挂引用方、拿到新库。
    const featBefore = readFileSync(feat.realFile, 'utf8')
    const generationBefore = loader.currentGeneration()
    writeText(lib.realFile, libSource('v4'))
    await sleep(400)

    check('只改库包就重挂了引用行', globalThis.__LIB_TEST.seen?.version === 'v4', String(globalThis.__LIB_TEST.seen?.version))
    check('引用方文件一个字节没动', readFileSync(feat.realFile, 'utf8') === featBefore)
    check(
      '一次库包变更只换代一次',
      loader.currentGeneration() === generationBefore + 1,
      String(generationBefore) + ' -> ' + String(loader.currentGeneration()),
    )
    check(
      '日志点名是库包变更（不是行自己改了）',
      logs.info.length === 1 && logs.info[0].includes('库包 libx'),
      logs.info.join(' | '),
    )

    // b) 库包写成语法错误：重挂失败，旧版本继续工作，正好一条 warn。
    logs.info.length = 0
    logs.warn.length = 0
    writeText(lib.realFile, 'export const OOPS = \n')
    await sleep(400)

    check('库包写坏后旧版本继续工作', globalThis.__LIB_TEST.seen?.version === 'v4', String(globalThis.__LIB_TEST.seen?.version))
    check(
      '失败只有一条 warn（说明旧版本继续运行）',
      logs.warn.length === 1 && logs.warn[0].includes('旧版本继续运行'),
      logs.warn.join(' | '),
    )

    // c) 没有引用方的库包：改了不重挂、不写日志。
    logs.info.length = 0
    logs.warn.length = 0
    const generationBeforeLonely = loader.currentGeneration()
    writeText(lonely.realFile, libSource('y2'))
    await sleep(300)

    check(
      '无引用方的库包改动不重挂',
      loader.currentGeneration() === generationBeforeLonely,
      String(generationBeforeLonely) + ' -> ' + String(loader.currentGeneration()),
    )
    check(
      '无引用方的库包改动不写日志',
      logs.info.length === 0 && logs.warn.length === 0,
      logs.info.concat(logs.warn).join(' | '),
    )
  } finally {
    watch.stop()
  }

  // d) 一次库变更命中两行：合并成一批、只换代一次，两行拿到同一个库实例。
  writeText(lib.realFile, libSource('v5'))
  // b 的失败已经在当前代数上留下一条「求值失败」的模块记录；同一个 URL 再 import 会
  // 直接拿到那条缓存错误。换一代再挂——与真实场景里「修好后轮询再重挂」走的是同一条路。
  loader.bumpGeneration()
  const feat2Source = `import { LIB_VERSION, LIB_TOKEN } from '@pneuma/libx'
export const name = 'feat2'
export const inject = []
export function apply() {
  globalThis.__LIB_TEST.seen2 = { version: LIB_VERSION, token: LIB_TOKEN }
}
`
  makePackage(appDir, 'feat2', feat2Source, { title: '第二个引用库包的功能包' })
  makeBase(appDir, [
    { id: 'feat', name: '@pneuma/feat' },
    { id: 'feat2', name: '@pneuma/feat2' },
  ])
  const second = await mountWatched()
  check(
    '两行都挂上了（基线都拿到 v5）',
    second.failures.length === 0 &&
      globalThis.__LIB_TEST.seen?.version === 'v5' &&
      globalThis.__LIB_TEST.seen2?.version === 'v5',
    JSON.stringify(second.failures) +
      ' / ' +
      String(globalThis.__LIB_TEST.seen?.version) +
      ' / ' +
      String(globalThis.__LIB_TEST.seen2?.version),
  )

  const pairLogs = { info: [], warn: [] }
  const pairWatch = watchModule.createPluginWatch({
    appDir,
    pollIntervalMs: 20,
    debounceMs: 50,
    logger: {
      info: (line) => pairLogs.info.push(line),
      warn: (line) => pairLogs.warn.push(line),
    },
  })
  try {
    const generationBeforePair = loader.currentGeneration()
    writeText(lib.realFile, libSource('v6'))
    await sleep(500)

    check(
      '一次库变更命中两行：两行都换了新库',
      globalThis.__LIB_TEST.seen?.version === 'v6' && globalThis.__LIB_TEST.seen2?.version === 'v6',
      String(globalThis.__LIB_TEST.seen?.version) + ' / ' + String(globalThis.__LIB_TEST.seen2?.version),
    )
    check(
      '两行拿到的是同一个库实例（同一代只解析一份）',
      globalThis.__LIB_TEST.seen?.token === globalThis.__LIB_TEST.seen2?.token,
      '两行拿到的是不同对象',
    )
    check(
      '两行一起重挂也只换代一次',
      loader.currentGeneration() === generationBeforePair + 1,
      String(generationBeforePair) + ' -> ' + String(loader.currentGeneration()),
    )
    check(
      '两行只写一行 info（不刷屏）',
      pairLogs.info.length === 1 && pairLogs.info[0].includes('已重挂 2 行'),
      pairLogs.info.join(' | '),
    )
  } finally {
    pairWatch.stop()
  }
}

console.log('')
console.log(pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
