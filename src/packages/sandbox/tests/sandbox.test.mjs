/** sandbox 包级测试：policy.ts 的判定（默认值、白名单、档位拒写、受保护名）、包的装配形状，
 * 以及并进来的改动前预览（review.ts 的配置夹取与路径显示）。读 lib/ 产物，先 pnpm run build。
 * 单独跑：node src/packages/sandbox/tests/sandbox.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const policy = await import(new URL('../../../../lib/packages/sandbox/policy.js', import.meta.url).href)
const review = await import(new URL('../../../../lib/packages/sandbox/review.js', import.meta.url).href)
const entry = await import(new URL('../../../../lib/packages/sandbox/index.js', import.meta.url).href)
const repo = fileURLToPath(new URL('../../../..', import.meta.url))
const base = { cwd: repo, tmpDir: join(repo, '.tmp'), dscHome: join(repo, '.dsc'), extraWritableRoots: [], readOnlySubpaths: [], networkAccess: false }
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}
check('默认配置 workspace-write、网络关；坏档位回落并记一条问题', () => {
  const { config } = policy.resolveSandboxConfig(undefined)
  assert.deepEqual([config.mode, config.networkAccess], ['workspace-write', false])
  const bad = policy.resolveSandboxConfig({ mode: 'yolo' })
  assert.equal(bad.config.mode, 'workspace-write')
  assert.equal(bad.problems.length, 1)
})
check('白名单：精确域不放行子域，通配只放一层；条目归一后路径与中文域不收', () => {
  assert.equal(policy.allowlistMatches('api.example.com', ['example.com']), false)
  assert.equal(policy.allowlistMatches('api.example.com', ['*.example.com']), true)
  assert.equal(policy.allowlistMatches('a.b.example.com', ['*.example.com']), false)
  assert.deepEqual(policy.normalizeAllowlistEntry(' Example.COM. '), { ok: true, domain: 'example.com' })
  const rejects = ['https://x/y', '中文.中国'].map((raw) => policy.normalizeAllowlistEntry(raw).ok)
  assert.deepEqual(rejects, [false, false])
})
check('档位判定：只读档拒一切写，可写档放行根内、拒根外与受保护名', () => {
  const readOnly = policy.createPolicy({ ...base, mode: 'read-only' })
  assert.equal(policy.checkWrite(readOnly, join(repo, 'package.json')).rule, 'mode-read-only')
  const write = policy.createPolicy({ ...base, mode: 'workspace-write' })
  assert.equal(policy.checkWrite(write, join(repo, 'package.json')).allowed, true)
  assert.equal(policy.checkWrite(write, join(tmpdir(), 'outside.txt')).rule, 'outside-writable-roots')
  assert.equal(policy.checkWrite(write, join(repo, '.env')).rule, 'protected-metadata')
})
// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
check('cordis.patch.yml 的装配行认的是 @pneuma/sandbox', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: sandbox\s*$/m, '装配行的 id 必须正好是 sandbox')
  assert.ok(patch.includes("name: '@pneuma/sandbox'"), "装配行的 name 必须是 '@pneuma/sandbox'")
})
// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
check('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.name, '@pneuma/sandbox')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'].default, 'exports 必须有 "."')
  assert.ok(pkg.exports['./package.json'], 'exports 必须有 "./package.json"')
  assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  assert.notEqual(pkg.pneuma.library, true, '功能包不该标成库包')
})
// 入口真能加载：lib 产物已构建，这里直接 import 并检查插件对象的三件事。
check('lib 入口能加载，插件名与 apply 对得上', () => {
  const pkg = JSON.parse(read('../package.json'))
  const keys = Object.keys(entry).filter((key) => /Plugin$/.test(key))
  assert.equal(keys.length, 1, '入口应当恰好导出一个 *Plugin 对象')
  const plugin = entry[keys[0]]
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.name, 'string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  assert.equal(plugin.name, pkg.name.slice('@pneuma/'.length))
  assert.equal(plugin.name, 'sandbox')
  assert.equal(typeof plugin.apply, 'function')
})
// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
check('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
})
// 改动前预览（原 @pneuma/file-review）并进来时搬的 6 条里的两条纯函数断言。
check('配置解析：缺省值正确，越界夹到区间内', () => {
  assert.deepEqual(review.parseReviewConfig({}), { enabled: true, maxLines: 120, contextLines: 3 })
  assert.equal(review.parseReviewConfig({ maxLines: 99999 }).maxLines, review.REVIEW_RANGES.maxLines.max)
  assert.equal(review.parseReviewConfig({ contextLines: -5 }).contextLines, 0)
  assert.equal(review.parseReviewConfig({ enabled: false }).enabled, false)
})
check('路径显示：工作目录内写相对路径，目录外保留绝对路径', () => {
  assert.equal(review.displayPathOf('/w', '/w/src/a.ts'), 'src/a.ts')
  assert.equal(review.displayPathOf('/w', '/other/a.ts'), '/other/a.ts')
})
console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
