/**
 * 换包 e2e：在**应用副本**上换一个功能包的产物，验证「重启即生效、删包仍能启动」。
 *
 * 为什么不用真实安装目录：这会改用户的文件。脚本把 `lib/` 整个拷到临时目录，
 * 在副本上做三件事——换版本、删可选包、删核心包——每一项都真的起一次内核。
 *
 * 用法：node scripts/plugin-swap-e2e.mjs（需要先 pnpm build）
 *
 * @module scripts/plugin-swap-e2e
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

const probe = `import { createKernel } from './lib/host/kernel.js'
const registry = await import('./lib/core/plugin-registry.js')
const muted = process.stdout.write.bind(process.stdout)
process.stdout.write = () => true
const root = await createKernel({ config: {}, resumeSessionPath: null })
process.stdout.write = muted
const infos = registry.listPluginInfos()
let mark = null
try {
  mark = (await import('./lib/packages/ops/index.js')).SWAP_MARK ?? null
} catch {
  mark = null
}
console.log('PROBE ' + JSON.stringify({ count: infos.length, hasOps: infos.some((i) => i.file === 'ops'), hasSession: infos.some((i) => i.file === 'session'), problems: infos.filter((i) => i.problem).map((i) => i.file), mark }))
process.exit(0)
`
writeFileSync(join(app, 'probe.mjs'), probe, 'utf8')

/** 起一次副本里的内核，拿它打印的那行 JSON。 */
function boot() {
  const result = spawnSync(process.execPath, [join(app, 'probe.mjs')], { cwd: app, encoding: 'utf8', timeout: 120_000 })
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
check('换包后重启读的是新产物', swapped.data?.mark === 'v2', String(swapped.data?.mark))
check('换包不影响其余行', swapped.data?.count === baseline.data?.count, String(swapped.data?.count))

// ── 3. 删可选包：应用仍起得来 ────────────────────────────────────────────────
rmSync(join(app, 'lib', 'node_modules', '@pneuma', 'ops'), { recursive: true, force: true })
const removed = boot()
check('删掉 ops 包后内核照常启动', removed.status === 0 && removed.data !== null, String(removed.status))
check('清单里 ops 标成缺包（不是静默消失）', removed.data?.problems?.includes('ops') === true, JSON.stringify(removed.data?.problems))
check('其余行仍在', (removed.data?.count ?? 0) >= baseline.data?.count - 1, String(removed.data?.count))

// ── 4. 删核心包：不崩，失败逐个报出来 ────────────────────────────────────────
rmSync(join(app, 'lib', 'node_modules', '@pneuma', 'session'), { recursive: true, force: true })
const coreGone = boot()
check('删掉 session 包后内核仍返回', coreGone.status === 0 && coreGone.data !== null, String(coreGone.status))
check('session 标成缺包', coreGone.data?.problems?.includes('session') === true, JSON.stringify(coreGone.data?.problems))
check('没有静默：stderr 里有失败原因', /session|插件/.test(coreGone.stderr), coreGone.stderr.slice(0, 120))

rmSync(app, { recursive: true, force: true })
console.log(`\n换包 e2e：${passed} PASS / ${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
