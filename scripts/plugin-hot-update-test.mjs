/**
 * 功能包热更自检：改代码不重启即生效，失败保旧版本。
 *
 * 八段，各验一条：
 *
 *   1. **桩穿透**：应用自带包的入口是 `lib/node_modules/@pneuma/<id>/index.js` 这层
 *      再导出桩，真实代码在 `lib/packages/<id>/index.js`。改真实文件后换代重挂，
 *      桩导出的必须是新值——这条证明「不再被桩架空」。
 *   2. **失败保旧**：把包文件写成语法错误，重挂必须失败，旧 fiber 仍在、旧行为仍可用，
 *      并且不能被 disableSilently 停掉。
 *   3. **代数隔离**：代数不变时两次 import 是同一实例；bump 之后是新实例（模块顶层重跑）。
 *   4. **core 不被戳**：`@pneuma/runtime/core/*` 的解析结果在换代前后完全相同，
 *      并且仍是同一个模块实例（戳到 core 会出现第二份内核状态，沙箱会 fail-open）。
 *   5. **轮询去抖**：plugin-watch 按 mtime+size 发现变更，连续两次写只触发一次重挂。
 *   6. **默认开**：不设 DSC_HOT 时，mountApplicationRows 自己拉起轮询，改文件即生效。
 *   7. **profile 清单这一路**：profile 的 package.json 变了才重算组合包（不动不重算），
 *      与行/库包两路共用同一个去抖窗口；不传 profileDir 时这一路不启用。
 *   8. **外部插件目录这一路**：手工往 ~/.dsc/plugins/ 丢一个 .js，连续两轮指纹没变才挂
 *      （半个文件不挂），删掉立刻卸；这一路不传 installDir 时不启用。
 *
 * 全部夹具造在临时目录（HOME / DSC_HOME 都指过去），不碰真实的 ~/.dsc。
 * 运行：pnpm build && node scripts/plugin-hot-update-test.mjs
 * 想拿别的构建产物跑（例如临时 tsc 输出目录）：
 *   PNEUMA_TEST_LIB=.p2build node scripts/plugin-hot-update-test.mjs
 *
 * @module dsc/scripts/plugin-hot-update-test
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const libDir =
  process.env.PNEUMA_TEST_LIB === undefined
    ? join(repoRoot, 'lib')
    : resolve(repoRoot, process.env.PNEUMA_TEST_LIB)

const home = mkdtempSync(join(tmpdir(), 'dsc-plugin-hot-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
// 这条自检自己指定 appDir，不让 config.yaml 里的 profile 混进来
delete process.env.DSC_PROFILE
// 主用例手动换代/重挂：关掉 mountApplicationRows 自动拉起的后台轮询，免得两条路径
// 抢同一份状态（第 5 段单独用 createPluginWatch 验轮询）。
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
globalThis.__HOT = {}

// ── 夹具：一个应用副本（桩 + 真实包 + base 清单）──────────────────────────────
const appDir = join(home, 'app')

/**
 * 写一个功能包：真实代码在 `lib/packages/<id>/index.js`，入口是
 * `lib/node_modules/@pneuma/<id>/index.js` 的一行再导出桩（与构建产物同形）。
 */
function makePackage(id, source, appRoot = appDir) {
  const realDir = join(appRoot, 'lib', 'packages', id)
  const realFile = join(realDir, 'index.js')
  writeText(realFile, source)
  const stubDir = join(appRoot, 'lib', 'node_modules', '@pneuma', id)
  const stubFile = join(stubDir, 'index.js')
  writeText(
    join(stubDir, 'package.json'),
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
  writeText(stubFile, "export * from '../../../packages/" + id + "/index.js';\n")
  return { realFile, stubFile }
}

/** alpha 的源码：顶层与 apply 都记标记，apply 返回 disposer（验「旧 fiber 有没有被卸」）。 */
const alphaSource = (value) => `export const VALUE = '${value}'
export const name = 'alpha'
export const inject = []
globalThis.__HOT.alphaLoaded = '${value}'
export function apply() {
  globalThis.__HOT.alphaApplied = '${value}'
  globalThis.__HOT.ping = () => '${value}'
  return () => {
    globalThis.__HOT.disposed = (globalThis.__HOT.disposed ?? 0) + 1
  }
}
`

/** iso 的源码：顶层自增一个计数器，用来分辨「同一实例」还是「换了实例」。 */
const isoSource = `const load = (globalThis.__ISO = (globalThis.__ISO ?? 0) + 1)
export const LOAD_ID = load
export const name = 'iso'
export const inject = []
export function apply() {}
`

/** alpha 的「导入能过、apply 会炸」版本：验挂载这一步失败时的回滚。 */
const alphaThrowingSource = `export const VALUE = 'boom'
export const name = 'alpha'
export const inject = []
globalThis.__HOT.alphaLoaded = 'boom'
export function apply() {
  throw new Error('新版本 apply 炸了')
}
`

/** auto 的源码：验「装配结束自己拉起轮询」用。 */
const autoSource = (value) => `export const VALUE = '${value}'
export const name = 'auto'
export const inject = []
globalThis.__HOT.autoLoaded = '${value}'
export function apply() {
  globalThis.__HOT.autoApplied = '${value}'
}
`

/** tick 的源码：给轮询用例用。 */
const tickSource = (value) => `export const VALUE = '${value}'
export const name = 'tick'
export const inject = []
globalThis.__HOT.tickLoaded = '${value}'
export function apply() {
  globalThis.__HOT.tickApplied = '${value}'
}
`

/** 写一份应用自带行清单（`@pneuma/base` 的清单 + 那一层 insert 行）。 */
function makeBase(appRoot, rows) {
  const baseDir = join(appRoot, 'lib', 'node_modules', '@pneuma', 'base')
  writeText(
    join(baseDir, 'package.json'),
    JSON.stringify({ name: '@pneuma/base', version: '1.0.0', type: 'module' }, null, 2) + '\n',
  )
  const lines = rows.map((row) => '    - id: ' + row.id + "\n      name: '" + row.name + "'\n").join('')
  writeText(join(baseDir, 'cordis.patch.yml'), '- insert:\n' + lines)
}

const alpha = makePackage('alpha', alphaSource('v1'))
const iso = makePackage('iso', isoSource)
const tick = makePackage('tick', tickSource('t1'))
makeBase(appDir, [
  { id: 'alpha', name: '@pneuma/alpha' },
  { id: 'iso', name: '@pneuma/iso' },
  { id: 'tick', name: '@pneuma/tick' },
])

// ── 加载被测模块（必须在 HOME/DSC_HOME 指好之后）──────────────────────────────
const { Context } = await import('@deepseek-ai/cordis')
const loader = await import(libUrl('core/plugin-loader.js'))
const registry = await import(libUrl('core/plugin-registry.js'))
const resolveHook = await import(libUrl('core/dsh-compat/resolve-hook.js'))
const watchModule = await import(libUrl('core/plugin-watch.js'))

const root = new Context()
const failures = await loader.mountApplicationRows(root, { appDir, surface: 'none' })
const infoOf = (file) => registry.listPluginInfos().find((item) => item.file === file)

// ── 1. 桩穿透：改真实文件 + 换代重挂 → 拿到新值 ───────────────────────────────
console.log('── 1. 桩穿透：改真实文件后重挂 ──')
{
  check('三行都挂上了', failures.length === 0, JSON.stringify(failures))
  check('启动时跑的是 v1', globalThis.__HOT.alphaLoaded === 'v1' && globalThis.__HOT.alphaApplied === 'v1')
  const stubUrl = pathToFileURL(alpha.stubFile).href
  const viaStubBefore = await import(stubUrl)
  check('启动时桩导出的也是 v1（同一实例）', viaStubBefore.VALUE === 'v1', String(viaStubBefore.VALUE))

  // 只改真实文件：桩一个字节不动（这正是旧实现的破绽）。
  writeText(alpha.realFile, alphaSource('v2'))
  const bumped = loader.bumpGeneration()
  const result = await loader.remountExternalPlugin('alpha')

  check('换代后重挂成功', result.ok === true, JSON.stringify(result))
  check('重挂用的是新代数', result.generation > bumped, String(bumped) + ' -> ' + String(result.generation))
  check('新模块的顶层真的执行了', globalThis.__HOT.alphaLoaded === 'v2', String(globalThis.__HOT.alphaLoaded))
  check(
    '新 fiber 已挂上（apply 跑过，旧行为换新）',
    globalThis.__HOT.alphaApplied === 'v2' && globalThis.__HOT.ping() === 'v2',
    String(globalThis.__HOT.alphaApplied),
  )
  check('旧 fiber 已卸载（disposer 跑过一次）', globalThis.__HOT.disposed === 1, String(globalThis.__HOT.disposed))
  const viaStubAfter = await import(stubUrl)
  check('桩现在导出 v2（不再被桩架空）', viaStubAfter.VALUE === 'v2', String(viaStubAfter.VALUE))
  check('重挂成功后 problem 清空', infoOf('alpha')?.problem === undefined, JSON.stringify(infoOf('alpha')?.problem))
}

// ── 2. 失败保旧：语法错误 → 重挂失败，旧 fiber 继续工作 ───────────────────────
console.log('── 2. 失败保旧：新代码坏掉时旧版本继续跑 ──')
{
  writeText(alpha.realFile, 'export const VALUE = \n')
  const failed = await loader.remountExternalPlugin('alpha')

  check('语法错误让重挂失败', failed.ok === false, JSON.stringify(failed))
  check(
    '失败原因在返回值里（并说明旧版本继续运行）',
    String(failed.problem).includes('热重挂失败') && String(failed.problem).includes('旧版本继续运行'),
    String(failed.problem),
  )
  check(
    '失败原因写进了 meta.problem',
    String(infoOf('alpha')?.problem).includes('旧版本继续运行'),
    String(infoOf('alpha')?.problem),
  )
  check(
    '旧 fiber 原样保留（apply 过的函数仍可用）',
    globalThis.__HOT.alphaApplied === 'v2' && globalThis.__HOT.ping() === 'v2',
    String(globalThis.__HOT.alphaApplied),
  )
  check('旧 fiber 没有被卸载（disposer 没再跑）', globalThis.__HOT.disposed === 1, String(globalThis.__HOT.disposed))
  check('没有把用户插件停掉（plugins.json 仍是启用）', registry.isPluginEnabled('alpha') === true)
  check('旧模块的标记没有被失败的新模块覆盖', globalThis.__HOT.alphaLoaded === 'v2', String(globalThis.__HOT.alphaLoaded))
}

// ── 2b. 挂载这一步失败：回滚到旧版本，而不是让这一行消失 ──────────────────────
console.log('── 2b. 挂载失败也回滚：apply 抛错时旧版本重新挂回来 ──')
{
  writeText(alpha.realFile, alphaThrowingSource)
  const failed = await loader.remountExternalPlugin('alpha')

  check('apply 抛错让重挂失败', failed.ok === false, JSON.stringify(failed))
  check('失败文案说明已回滚到旧版本', String(failed.problem).includes('已回滚到旧版本'), String(failed.problem))
  check('回滚后旧行为仍可用', globalThis.__HOT.alphaApplied === 'v2' && globalThis.__HOT.ping() === 'v2', String(globalThis.__HOT.ping?.()))
  check('meta.problem 也写了回滚结果', String(infoOf('alpha')?.problem).includes('已回滚'), String(infoOf('alpha')?.problem))

  const missing = await loader.remountExternalPlugin('not-mounted')
  check('没挂载的行不能重挂（返回失败并说清原因）', missing.ok === false && String(missing.problem).includes('没有挂载'), JSON.stringify(missing))
}

// ── 3. 代数隔离：同一代同一实例，换代换实例 ────────────────────────────────────
console.log('── 3. 代数隔离：一代一个实例 ──')
{
  const isoUrl = pathToFileURL(iso.realFile).href
  const first = await import(isoUrl)
  const second = await import(isoUrl)
  check('代数不变时两次 import 是同一实例', first === second)
  check('同一实例没有重复执行模块顶层', second.LOAD_ID === first.LOAD_ID, String(first.LOAD_ID) + '/' + String(second.LOAD_ID))
  const before = first.LOAD_ID
  const next = loader.bumpGeneration()
  const third = await import(isoUrl)
  check('bump 之后拿到不同实例', third !== first)
  check('新实例真的重新执行了模块', third.LOAD_ID === before + 1, String(before) + ' -> ' + String(third.LOAD_ID))
  check('bumpGeneration 返回递增的新代数', next > 0, String(next))
}

// ── 4. core 不被戳：@pneuma/runtime/core/* 换代前后解析结果一致 ────────────────
console.log('── 4. core 不被戳：运行时包没有第二份 ──')
{
  // 运行时重定向只对「插件目录里的 import」生效：把探针放在一个登记的 profile
  // node_modules 下，让它以那个身份去 import 运行时包。
  const profileDir = join(home, 'profiles', 'runtime-check')
  const profileModules = join(profileDir, 'node_modules')
  const runtimeProbe = join(profileModules, 'runtime-probe.mjs')
  writeText(
    runtimeProbe,
    `import * as runtime from '@pneuma/runtime/core/plugin-loader.js'
export const resolved = import.meta.resolve('@pneuma/runtime/core/plugin-loader.js')
export const mount = runtime.mountExternalPlugin
`,
  )
  resolveHook.ensureResolveHook([profileModules])
  const probeUrl = pathToFileURL(runtimeProbe).href
  const beforeProbe = await import(probeUrl + '?v=1')
  const bumped = resolveHook.bumpGeneration()
  const afterProbe = await import(probeUrl + '?v=2')

  check(
    'core 的解析结果在换代前后完全相同',
    beforeProbe.resolved === afterProbe.resolved,
    String(beforeProbe.resolved) + ' != ' + String(afterProbe.resolved),
  )
  check('core 的解析结果没有代数戳', !beforeProbe.resolved.includes('g='), String(beforeProbe.resolved))
  check('core 仍是同一模块实例（没有第二份）', beforeProbe.mount === loader.mountExternalPlugin && afterProbe.mount === loader.mountExternalPlugin)
  check('运行时重定向仍然生效（解析到应用内的运行时包）', beforeProbe.resolved.includes('@pneuma/runtime'), String(beforeProbe.resolved))
  check('探针那一次 bump 没有踩到 core', bumped > 0, String(bumped))
}

// ── 5. 轮询去抖：连续两次写只重挂一次 ─────────────────────────────────────────
console.log('── 5. 轮询去抖：同一轮构建合并成一次重挂 ──')
{
  // 先把 alpha 修好（第 2 段故意写坏的），并等重挂成功后再开轮询，避免基线踩在中间态。
  writeText(alpha.realFile, alphaSource('v3'))
  const repaired = await loader.remountExternalPlugin('alpha')
  check('修好之后重挂成功（回到 v3）', repaired.ok === true && globalThis.__HOT.ping() === 'v3', JSON.stringify(repaired))

  let remounts = 0
  const warnings = []
  const handle = watchModule.createPluginWatch({
    remount: async (identity) => {
      remounts += 1
      return loader.remountExternalPlugin(identity)
    },
    pollIntervalMs: 30,
    debounceMs: 120,
    logger: {
      info: () => {},
      warn: (line) => warnings.push(line),
    },
  })
  try {
    await handle.pollNow()
    check('基线那一轮没有触发重挂', remounts === 0, String(remounts))

    // 两次写间隔小于去抖窗口：轮询会看到两次变化，但只该重挂一次。
    writeText(tick.realFile, tickSource('t2'))
    await sleep(70)
    writeText(tick.realFile, tickSource('t3'))
    await sleep(500)

    check('轮询发现变更并真的换了代码', globalThis.__HOT.tickLoaded === 't3', String(globalThis.__HOT.tickLoaded))
    check('新 fiber 也挂上了', globalThis.__HOT.tickApplied === 't3', String(globalThis.__HOT.tickApplied))
    check('连续两次写合并成一次重挂', remounts === 1, String(remounts))
    check('轮询没有吞掉失败（没有 warn）', warnings.length === 0, warnings.join(' | '))
  } finally {
    handle.stop()
  }
}

// ── 6. 默认开：不设 DSC_HOT，装配结束自己拉起轮询 ────────────────────────────
console.log('── 6. 默认开：mountApplicationRows 自己拉起轮询 ──')
{
  // 前面各段把 DSC_HOT 设成 0 是为了手动驱动；这里恢复默认，验「装配完就开」。
  delete process.env.DSC_HOT
  const autoApp = join(home, 'app-auto')
  const auto = makePackage('auto', autoSource('a1'), autoApp)
  makeBase(autoApp, [{ id: 'auto', name: '@pneuma/auto' }])

  const autoRoot = new Context()
  const autoFailures = await loader.mountApplicationRows(autoRoot, { appDir: autoApp, surface: 'none' })
  check(
    '自动热更的夹具挂上了',
    autoFailures.length === 0 && globalThis.__HOT.autoApplied === 'a1',
    JSON.stringify(autoFailures),
  )

  writeText(auto.realFile, autoSource('a2'))
  // 默认 1000ms 一轮 + 200ms 去抖：留 2.6s，慢机器也够。
  await sleep(2600)
  check(
    '装配拉起的轮询把代码换了（默认开真的生效）',
    globalThis.__HOT.autoLoaded === 'a2' && globalThis.__HOT.autoApplied === 'a2',
    String(globalThis.__HOT.autoLoaded) + '/' + String(globalThis.__HOT.autoApplied),
  )
  watchModule.stopPluginWatch()
}


// ── 7. profile 清单这一路：不动不重算，动了才重算 ─────────────────────────────
console.log('── 7. profile 清单：与行 / 库包共用定时器与去抖 ──')
{
  const profileDir = join(home, 'profile-watch')
  writeText(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }) + '\n')

  let reconciles = 0
  const infos = []
  const warns = []
  const handle = watchModule.createPluginWatch({
    // 只看 profile 这一路：行集合空着，免得前面几段的夹具行再来抢事件。
    targets: () => [],
    profileDir,
    reconcile: async () => {
      reconciles += 1
      return { mounted: ['x'], unmounted: [], failures: [], warnings: [] }
    },
    pollIntervalMs: 30,
    debounceMs: 150,
    logger: { info: (line) => infos.push(line), warn: (line) => warns.push(line) },
  })
  try {
    await handle.pollNow()
    check('清单没动时不重算', reconciles === 0, String(reconciles))

    // 两份清单在同一个去抖窗口里连着改：只该重算一次。
    writeText(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['a'] } } }) + '\n')
    await sleep(40)
    writeText(join(profileDir, 'compatibility.json'), JSON.stringify({ exemptions: [] }) + '\n')
    await sleep(600)

    check('清单变了触发重算（且只一次）', reconciles === 1, String(reconciles))
    check('日志写了「profile 清单变了，重算组合包」', infos.includes('[plugin-watch] profile 清单变了，重算组合包'), infos.join(' | '))
    check('日志写了「挂了 1 行 / 卸了 0 行」', infos.includes('[plugin-watch] 挂了 1 行 / 卸了 0 行'), infos.join(' | '))
    check('这一路没有告警', warns.length === 0, warns.join(' | '))
  } finally {
    handle.stop()
  }

  // 不传 profileDir：这一路不启用，改清单也不该调 reconcile。
  let inactive = 0
  const off = watchModule.createPluginWatch({
    targets: () => [],
    reconcile: async () => {
      inactive += 1
      return { mounted: [], unmounted: [], failures: [], warnings: [] }
    },
    pollIntervalMs: 30,
    debounceMs: 100,
    logger: { info: () => {}, warn: () => {} },
  })
  try {
    writeText(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['a', 'b'] } } }) + '\n')
    await off.pollNow()
    await sleep(200)
    check('不传 profileDir 时这一路不启用', inactive === 0, String(inactive))
  } finally {
    off.stop()
  }
}

// ── 8. 外部插件目录：手工丢进来一个 .js 也要挂上（删掉就卸）────────────────────
console.log('── 8. 外部插件目录：新出现的 .js 挂上、删掉就卸 ──')
// 为什么单列一段：前面几路都只盯「已经挂上的行」与「profile 清单」，用户直接往
// ~/.dsc/plugins/ 拷一个文件不经过任何清单，谁也不会发现它。这一路比 dsh 多做了一件事
// （dsh 没有插件目录发现），但语义与启动路径共用同一个判断（plugins.json 停用过的跳过）。
{
  const installDir = join(home, 'plugins-drop')
  mkdirSync(installDir, { recursive: true })
  const adopted = []
  const infos = []
  const warns = []
  const handle = watchModule.createPluginWatch({
    // 行、库包、profile 三路都关掉，只留目录这一路。
    targets: () => [],
    installDir,
    adopt: async (only) => {
      adopted.push([...only].sort())
      // 夹具按盘上真实情况回答：文件还在就是「挂上」，不在了就是「卸掉」。
      if (!existsSync(join(installDir, 'drop.js'))) return { mounted: [], unmounted: ['drop.js'], failures: [] }
      return { mounted: [...only], unmounted: [], failures: [] }
    },
    pollIntervalMs: 30,
    debounceMs: 100,
    logger: { info: (line) => infos.push(line), warn: (line) => warns.push(line) },
  })
  try {
    await handle.pollNow()
    check('基线那一轮不扫目录（启动路径已经挂过了）', adopted.length === 0, JSON.stringify(adopted))

    writeText(join(installDir, 'drop.js'), 'export function apply() {}\n')
    await handle.pollNow()
    check('刚出现的文件先只记指纹，不当场挂（半个文件不挂）', adopted.length === 0, JSON.stringify(adopted))

    await handle.pollNow()
    check('第二轮指纹没变才算写完，交出这个名字', JSON.stringify(adopted) === '[["drop.js"]]', JSON.stringify(adopted))
    check('挂上之后写了日志', infos.some((line) => line.includes('目录里新出现的插件已挂上 1 个')), infos.join(' | '))

    await handle.pollNow()
    check('再扫一轮不重复挂（目录没变，压根不调 adopt）', adopted.length === 1, JSON.stringify(adopted))

    rmSync(join(installDir, 'drop.js'))
    await handle.pollNow()
    check('文件被删之后立刻扫一遍（交给 adopt 的集合为空）', adopted.length === 2 && adopted[1].length === 0, JSON.stringify(adopted))
    check('卸的时候写了日志', infos.some((line) => line.includes('盘上没了')), infos.join(' | '))
    check('这一路没有告警', warns.length === 0, warns.join(' | '))
  } finally {
    handle.stop()
  }
}

console.log('')
console.log(pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
