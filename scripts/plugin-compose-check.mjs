/**
 * 插件组合门禁：真起一次内核，断言「功能包一个个都装上了」。
 *
 * 为什么要有它：plugin-inventory 只导快照，不判对错——一个包挂不上、条目里记了 problem，
 * 快照照样把它收下，门禁看不出来。这份脚本把「装上」拆成五条可判的事实，任何一条不满足
 * 就打印清单并以 1 退出：
 *
 *   1. 挂载失败为 0（`createKernel` 之后从 `applicationRowFailures()` 读出来的 failures 逐条打出来）；
 *   2. `listPluginInfos()` 里没有带 problem 的条目（装上了但坏了也算红）；
 *   3. 行数对得上：功能包数 = 行清单行数，注册条目数 = 行数 - headless 跳过的行，
 *      已挂载数 = 注册数 - 默认关的行；
 *   4. 声明了 `pneuma.settingsSection` 且真的挂上的包，`root.settings.sections()` 里有这个 id；
 *   5. 界面两半对得上：`lib/ui/plugins/<id>/bundle.json` 的每个 id 都有一行 `ui-<id>` 挂着，
 *      标了 `pneuma.client` 的功能包也都在 `lib/ui/plugins` 下有产物。
 *
 * 所有数字都从清单推导（读 src/packages 的 package.json、读 base 的 cordis.patch.yml），
 * 不写死 77：包数量变了，门禁跟着变，才是真的判据。
 *
 * 为什么走 `createKernel` 而不是在脚本里自己拼一遍装配：装配顺序只有 kernel.ts 一份，
 * 脚本再抄一条就变成「测的是另一条路」——kernel 改了、脚本没跟着改，门禁会悄悄测旧顺序。
 * 失败的清单由 kernel.ts 的 `applicationRowFailures()` 只读交出来（那是真启动路径产生的
 * 那一份，不是第二遍挂载的结果）。
 *
 * 用法：node scripts/plugin-compose-check.mjs
 *
 * @module scripts/plugin-compose-check
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const home = mkdtempSync(join(tmpdir(), 'numa-compose-'))
process.env['DSC_HOME'] = home
process.env['DSC_UI_SERVER'] = '0'
// 环境里带的 profile 会让「装了什么」跟着开发机漂：门禁只认「第一次启动」的样子。
delete process.env['DSC_PROFILE']

const { readConfig } = await import('../lib/core/config.js')
const { applicationRowFailures, createKernel } = await import('../lib/host/kernel.js')
const { listMountedPluginSources, SURFACE_ROW_SKIPS } = await import('../lib/core/plugin-loader.js')
const { listPluginInfos } = await import('../lib/core/plugin-registry.js')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES_DIR = join(ROOT, 'src', 'packages')
const BASE_PATCH = join(ROOT, 'lib', 'node_modules', '@pneuma', 'base', 'cordis.patch.yml')
const UI_DIR = join(ROOT, 'lib', 'ui', 'plugins')
const SURFACE = 'headless'

/** 读一个 JSON 文件；读不到/解析不了给 null（清单缺失要报出来，不能让脚本自己崩）。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 功能包：`src/packages/<id>/package.json` 里写了 `pneuma.bundle.patch`。
 *
 * 只认 pneuma 这一段：它等于「这个目录要往行清单里插一行」；库包（cli、ui-core 这些）
 * 没有这一段，本来就不该出现在行清单里。
 */
function functionalPackages() {
  const out = []
  for (const name of readdirSync(PACKAGES_DIR).sort()) {
    const manifest = readJson(join(PACKAGES_DIR, name, 'package.json'))
    if (manifest === null) continue
    const patch = manifest?.pneuma?.bundle?.patch
    // patch 两种写法都算：一个文件名，或一组文件名（dsh 的数组写法），空数组等于没声明。
    const declared =
      (typeof patch === 'string' && patch !== '') ||
      (Array.isArray(patch) && patch.some((item) => typeof item === 'string' && item !== ''))
    if (!declared) continue
    out.push({ name, client: manifest?.pneuma?.client })
  }
  return out
}

/** 行清单：`@pneuma/base/cordis.patch.yml` 里每个 insert 条目。 */
function patchRows() {
  if (!existsSync(BASE_PATCH)) return null
  let doc
  try {
    doc = YAML.parse(readFileSync(BASE_PATCH, 'utf8'))
  } catch {
    return null
  }
  const rows = []
  for (const layer of Array.isArray(doc) ? doc : []) {
    if (layer === null || typeof layer !== 'object') continue
    for (const row of Array.isArray(layer.insert) ? layer.insert : []) {
      if (row === null || typeof row !== 'object') continue
      rows.push({
        id: typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : '',
        disabled: row.disabled === true,
      })
    }
  }
  return rows
}

/** 界面产物目录 → { id, dir }；`bundle.json` 里写了 id 就用它，没写用目录名（与清单同一口径）。 */
function uiArtifacts() {
  const out = []
  let names
  try {
    names = readdirSync(UI_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return out
  }
  for (const name of names.sort()) {
    const declared = readJson(join(UI_DIR, name, 'bundle.json'))
    const id = typeof declared?.id === 'string' && declared.id !== '' ? declared.id : name
    out.push({
      id,
      dir: name,
      bundle: existsSync(join(UI_DIR, name, 'bundle.json')),
      client: existsSync(join(UI_DIR, name, 'client.js')),
    })
  }
  return out
}

// ── 起一次真内核（headless）────────────────────────────────────────────────────
// 挂载期间屏蔽 stdout：组合包的宿主半边可能写横幅，会把报告顶掉。
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = () => true
let root
try {
  root = await createKernel({ config: readConfig(), resumeSessionPath: null, surface: SURFACE })
} finally {
  process.stdout.write = realWrite
}
// kernel 里 reportFailures 只把失败写进 transcript；这份只读快照才是机器判据。
const failures = applicationRowFailures()

// ── 收数据 ───────────────────────────────────────────────────────────────────
const infos = listPluginInfos()
const mountedIds = new Set(listMountedPluginSources().map((entry) => entry.identity))
const sections = new Set(root.settings.sections().map((section) => section.id))
const packages = functionalPackages()
const rows = patchRows()
const ui = uiArtifacts()

const skipped = new Set(SURFACE_ROW_SKIPS[SURFACE])
const skippedRows = (rows ?? []).filter((row) => skipped.has(row.id))
const expectedRegistered = (rows?.length ?? 0) - skippedRows.length
const defaultOff = (rows ?? []).filter((row) => row.disabled && !skipped.has(row.id))
const expectedMounted = expectedRegistered - defaultOff.length

const red = []
const fail = (text) => red.push(text)

// 1. 挂载失败为 0
for (const failure of failures) {
  fail(`挂载失败：file=${failure.file} name=${failure.name} problem=${failure.problem}`)
}

// 2. 没有带 problem 的条目（装上了但坏了）
for (const info of infos) {
  if (typeof info.problem === 'string' && info.problem !== '') {
    fail(`条目带 problem：file=${info.file} name=${info.name} problem=${info.problem}`)
  }
}

// 3. 行数对得上
if (rows === null) {
  fail(`行清单读不到：${BASE_PATCH}（先跑 pnpm build）`)
} else {
  if (rows.length !== packages.length) {
    const rowIds = new Set(rows.map((row) => row.id))
    const missing = packages.filter((pkg) => !rowIds.has(pkg.name)).map((pkg) => pkg.name)
    fail(`功能包 ${String(packages.length)} 个，行清单 ${String(rows.length)} 行对不上（没进清单：${missing.join('、') || '无'}）`)
  }
  if (infos.length !== expectedRegistered) {
    fail(`注册条目 ${String(infos.length)} 条，应为 ${String(expectedRegistered)} 条（行清单 ${String(rows.length)} - 界面形态跳过的 ${String(skippedRows.length)} 行）`)
  }
  if (mountedIds.size !== expectedMounted) {
    fail(`已挂载 ${String(mountedIds.size)} 行，应为 ${String(expectedMounted)} 行（注册 ${String(expectedRegistered)} - 默认关的 ${String(defaultOff.length)} 行）`)
  }
  const offIds = new Set(defaultOff.map((row) => row.id))
  for (const info of infos) {
    if (offIds.has(info.file) || skipped.has(info.file)) continue
    if (!mountedIds.has(info.file)) fail(`这一行没挂上，也没标默认关：${info.file}（${info.name}）`)
  }
  for (const id of mountedIds) {
    if (!rows.some((row) => row.id === id)) fail(`挂了一个行清单里没有的行：${id}`)
  }
}

// 4. 设置分区：声明了 pneuma.settingsSection 且真的挂上的包，分区必须存在。
// 默认关的行不要求——它的 apply 没跑过，分区当然还没注册（不是坏了）。
let sectionDeclared = 0
let sectionChecked = 0
for (const info of infos) {
  const id = info.settingsSection
  if (typeof id !== 'string' || id === '') continue
  sectionDeclared += 1
  if (!mountedIds.has(info.file)) continue
  sectionChecked += 1
  if (!sections.has(id)) fail(`设置分区缺了：${info.file} 声明 pneuma.settingsSection=${id}，settings.sections() 里没有`)
}

// 5. 界面两半对得上
const uiIds = new Set(ui.map((entry) => entry.id))
for (const entry of ui) {
  const rowId = `ui-${entry.id}`
  if (!infos.some((info) => info.file === rowId)) {
    fail(`界面产物 ${entry.dir}（id=${entry.id}）没有对应的行 ${rowId}`)
    continue
  }
  if (!mountedIds.has(rowId)) fail(`界面产物 ${entry.dir}（id=${entry.id}）对应的行 ${rowId} 没挂上`)
  if (!entry.bundle) fail(`界面产物 ${entry.dir} 缺 bundle.json`)
  if (!entry.client) fail(`界面产物 ${entry.dir} 缺 client.js`)
}
for (const pkg of packages) {
  if (pkg.client === undefined) continue
  // 包名就是行 id（`ui-actions`），界面产物的 id 是去掉前缀那一段（`actions`）。
  const artifactId = pkg.name.startsWith('ui-') ? pkg.name.slice('ui-'.length) : pkg.name
  if (!uiIds.has(artifactId)) fail(`${pkg.name} 标了 pneuma.client，但 lib/ui/plugins 下没有 ${artifactId} 的产出`)
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
const uiRows = ui.filter((entry) => mountedIds.has(`ui-${entry.id}`)).length
console.log('插件组合门禁（headless）')
console.log(`  功能包        ${String(packages.length)} 个（src/packages/*/package.json 里写了 pneuma.bundle.patch）`)
console.log(
  `  行清单        ${String(rows?.length ?? 0)} 行（headless 跳过 ${String(skippedRows.length)} 行：${skippedRows.map((row) => row.id).join('、') || '无'}）`,
)
console.log(`  注册条目      ${String(infos.length)} 条，应 ${String(expectedRegistered)} 条`)
console.log(
  `  已挂载        ${String(mountedIds.size)} 行，应 ${String(expectedMounted)} 行（默认关 ${String(defaultOff.length)} 行）`,
)
console.log(`  设置分区      声明 ${String(sectionDeclared)} 个，挂上的 ${String(sectionChecked)} 个，全在 sections() 里`)
console.log(`  界面产物      ${String(ui.length)} 个 id ↔ ${String(uiRows)} 行 ui-*`)
console.log(`  挂载失败      ${String(failures.length)} 条`)

if (red.length > 0) {
  console.log('')
  console.log(`FAIL：${String(red.length)} 条断言不满足`)
  for (const line of red) console.log('  - ' + line)
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}
console.log('')
console.log('PASS：五条断言全过')
rmSync(home, { recursive: true, force: true })
process.exit(0)
