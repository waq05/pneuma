/**
 * 换包 e2e：在**应用副本**上换功能包的产物，验证「重启即生效、删包仍能启动、pinned 不让路」。
 *
 * 为什么不用真实安装目录：这会改用户的文件。脚本把 `lib/` 整个拷到临时目录、把家目录
 * （`DSC_HOME`）也指到副本里，然后在副本上做五件事——换版本、换 pinned 包的副本、
 * 删可选包、删核心包——每一项都真的起一次内核，一个字节都不碰真实的 `~/.dsc`。
 *
 * pinned 那两段验的是口径本身：应用里声明 `pinned` 的包被用户在 profile 里装了一份时
 * 仍走应用那份；把声明改成 `overridable` 之后同一份副本立刻生效。方向相反的两次结果
 * 才算证明「profile 里的副本被看见了，只是被口径挡住」。
 *
 * 用法：node scripts/plugin-swap-e2e.mjs（需要先 pnpm build）
 *
 * @module scripts/plugin-swap-e2e
 */
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

let passed = 0
let failed = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log('PASS  ' + label)
    return
  }
  failed += 1
  console.log('FAIL  ' + label + (detail === '' ? '' : ' → ' + detail))
}

const repo = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const app = mkdtempSync(join(tmpdir(), 'numa-swap-'))
cpSync(join(repo, 'lib'), join(app, 'lib'), { recursive: true })
// 副本没有自己的 node_modules：用 junction 指回仓库那份（cordis / yaml / semver 这些运行时依赖）。
symlinkSync(join(repo, 'node_modules'), join(app, 'node_modules'), 'junction')
// 临时家目录：plugins.json、默认 profile、下面造的覆盖 profile 都在副本里。
const home = join(app, 'home')
mkdirSync(home, { recursive: true })

const writeText = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
}
/** 往一个模块尾巴上挂一行标记：加载到哪一份，跑完就能从 globalThis 上看出来。 */
const markFile = (file, line) => appendFileSync(file, '\n' + line + '\n', 'utf8')

const probe = `import { join } from 'node:path'
import { createKernel } from './lib/host/kernel.js'
import * as loader from './lib/core/plugin-loader.js'
import * as registry from './lib/core/plugin-registry.js'
const muted = process.stdout.write.bind(process.stdout)
process.stdout.write = () => true
const root = await createKernel({ config: {}, resumeSessionPath: null })
// profile 里的组合包：真实启动时由 loadExternalPlugins 调同一个函数，这里直接调它，
// 好把 warnings 拿回来（真实启动时它们被转发进对话流，探针读不到）。
let bundles = { failures: [], warnings: [] }
const profileName = process.env.DSC_PROFILE ?? ''
if (profileName !== '') bundles = await loader.mountBundlePlugins(root, join(process.env.DSC_HOME ?? '', 'profiles', profileName))
process.stdout.write = muted
const infos = registry.listPluginInfos()
let swap = null
try {
  swap = (await import('./lib/packages/ops/index.js')).SWAP_MARK ?? null
} catch {
  swap = null
}
console.log('PROBE ' + JSON.stringify({
  count: infos.length,
  hasOps: infos.some((i) => i.file === 'ops'),
  hasSession: infos.some((i) => i.file === 'session'),
  problems: infos.filter((i) => i.problem).map((i) => i.file),
  swap,
  waiting: globalThis.__WAITING ?? null,
  todo: globalThis.__TODO ?? null,
  pinned: globalThis.__PINNED ?? null,
  bundleWarnings: bundles.warnings,
  bundleFailures: bundles.failures.map((failure) => failure.file),
}))
process.exit(0)
`
writeFileSync(join(app, 'probe.mjs'), probe, 'utf8')

/**
 * 起一次副本里的内核，拿它打印的那行 JSON。
 * @param env - 额外环境变量（换 profile 用）
 */
function boot(env = {}) {
  const result = spawnSync(process.execPath, [join(app, 'probe.mjs')], {
    cwd: app,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DSC_HOME: home, DSC_PROFILE: '', DSC_UI_SERVER: '0', ...env },
  })
  const line = (result.stdout ?? '').split('\n').find((row) => row.startsWith('PROBE '))
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    data: line === undefined ? null : JSON.parse(line.slice('PROBE '.length)),
  }
}

// ── 1. 基线 ──────────────────────────────────────────────────────────────────
const baseline = boot()
check('副本能起内核', baseline.data !== null && baseline.data.count > 0, String(baseline.data?.count))
check('ops 在清单里', baseline.data?.hasOps === true)

// ── 2. 换包：改产物 → 重启生效 ────────────────────────────────────────────────
const opsFile = join(app, 'lib', 'packages', 'ops', 'index.js')
writeFileSync(opsFile, readFileSync(opsFile, 'utf8') + "\nexport const SWAP_MARK = 'v2'\n", 'utf8')
const swapped = boot()
check('换包后重启读的是新产物', swapped.data?.swap === 'v2', String(swapped.data?.swap))
check('换包不影响其余行', swapped.data?.count === baseline.data?.count, String(swapped.data?.count))

// ── 3. profile 覆盖：pinned 不让路，overridable 真的顶替 ──────────────────────
// 一份 profile：waiting（pinned）与 todo（overridable）各装一份改过的副本，
// 再加一条自己 patch 里的行，指向应用里一份声明 pinned 的夹具包。
const profile = join(home, 'profiles', 'probe')
writeText(
  join(profile, 'package.json'),
  JSON.stringify({ name: 'pneuma-profile', private: true, dsh: { profile: { bundles: [] } } }, null, 2) + '\n',
)
writeText(join(profile, 'cordis.patch.yml'), "- insert:\n    - id: pinned-only\n      name: '@p3/pinned-only'\n")

/** 把应用里的某个包抄进 profile，并给这份副本打上哪来的标记。 */
function copyIntoProfile(pkgName, moduleFile, marker) {
  const from = join(app, 'lib', 'node_modules', ...pkgName.split('/'))
  const to = join(profile, 'node_modules', ...pkgName.split('/'))
  writeText(join(to, 'package.json'), readFileSync(join(from, 'package.json'), 'utf8'))
  writeText(join(to, 'index.js'), readFileSync(join(app, 'lib', 'packages', moduleFile), 'utf8'))
  markFile(join(to, 'index.js'), marker)
}

markFile(join(app, 'lib', 'packages', 'waiting', 'index.js'), "globalThis.__WAITING = 'app'")
markFile(join(app, 'lib', 'packages', 'todo', 'index.js'), "globalThis.__TODO = 'app'")
copyIntoProfile('@pneuma/waiting', 'waiting/index.js', "globalThis.__WAITING = 'profile'")
copyIntoProfile('@pneuma/todo', 'todo/index.js', "globalThis.__TODO = 'profile'")

// 应用侧的夹具包：声明 pinned，profile 里也有一份同名副本
const pinnedDir = join(app, 'lib', 'node_modules', '@p3', 'pinned-only')
writeText(
  join(pinnedDir, 'package.json'),
  JSON.stringify({ name: '@p3/pinned-only', version: '1.0.0', type: 'module', exports: { '.': './index.js' }, pneuma: { resolution: 'pinned' } }, null, 2) + '\n',
)
writeText(join(pinnedDir, 'index.js'), "globalThis.__PINNED = 'app'\nexport const name = 'pinned-only'\nexport function apply() {}\n")
const pinnedProfileDir = join(profile, 'node_modules', '@p3', 'pinned-only')
writeText(
  join(pinnedProfileDir, 'package.json'),
  JSON.stringify({ name: '@p3/pinned-only', version: '2.0.0', type: 'module', exports: { '.': './index.js' }, pneuma: { resolution: 'pinned' } }, null, 2) + '\n',
)
writeText(
  join(pinnedProfileDir, 'index.js'),
  "globalThis.__PINNED = 'profile'\nexport const name = 'pinned-only'\nexport function apply() {}\n",
)

const overridden = boot({ DSC_PROFILE: 'probe' })
check('pinned：profile 里有同名副本时仍用应用那份', overridden.data?.waiting === 'app', String(overridden.data?.waiting))
check('overridable：profile 副本真的顶替了应用那份', overridden.data?.todo === 'profile', String(overridden.data?.todo))
check('pinned 的 bundle 行用了应用那份', overridden.data?.pinned === 'app', String(overridden.data?.pinned))
check(
  'pinned 被让路时告警写清了不生效的那份在哪',
  (overridden.data?.bundleWarnings ?? []).some(
    (warning) => warning.includes('pinned') && warning.includes(join(profile, 'node_modules', '@p3', 'pinned-only')),
  ),
  JSON.stringify(overridden.data?.bundleWarnings),
)
check('覆盖 profile 起内核没有多出失败行', (overridden.data?.bundleFailures ?? []).length === 0, JSON.stringify(overridden.data?.bundleFailures))

// 把应用侧那份改成 overridable：同一份 profile 副本立刻生效（口径真的在起作用）
const pinnedManifest = join(pinnedDir, 'package.json')
const pinnedDoc = JSON.parse(readFileSync(pinnedManifest, 'utf8'))
pinnedDoc.pneuma.resolution = 'overridable'
writeFileSync(pinnedManifest, JSON.stringify(pinnedDoc, null, 2) + '\n', 'utf8')
const flipped = boot({ DSC_PROFILE: 'probe' })
check('改成 overridable 后同一份副本生效', flipped.data?.pinned === 'profile', String(flipped.data?.pinned))
check('改成 overridable 后没有 pinned 告警', !(flipped.data?.bundleWarnings ?? []).some((warning) => warning.includes('pinned')), JSON.stringify(flipped.data?.bundleWarnings))

// ── 4. 删可选包：应用仍起得来 ────────────────────────────────────────────────
rmSync(join(app, 'lib', 'node_modules', '@pneuma', 'ops'), { recursive: true, force: true })
const removed = boot()
check('删掉 ops 包后内核照常启动', removed.status === 0 && removed.data !== null, String(removed.status))
check('清单里 ops 标成缺包（不是静默消失）', removed.data?.problems?.includes('ops') === true, JSON.stringify(removed.data?.problems))
check('其余行仍在', (removed.data?.count ?? 0) >= baseline.data?.count - 1, String(removed.data?.count))

// ── 5. 删核心包：不崩，失败逐个报出来 ────────────────────────────────────────
rmSync(join(app, 'lib', 'node_modules', '@pneuma', 'session'), { recursive: true, force: true })
const coreGone = boot()
check('删掉 session 包后内核仍返回', coreGone.status === 0 && coreGone.data !== null, String(coreGone.status))
check('session 标成缺包', coreGone.data?.problems?.includes('session') === true, JSON.stringify(coreGone.data?.problems))
check('没有静默：stderr 里有失败原因', /session|插件/.test(coreGone.stderr), coreGone.stderr.slice(0, 120))

rmSync(app, { recursive: true, force: true })
console.log(`\n换包 e2e：${passed} PASS / ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
