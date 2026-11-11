/**
 * core/plugin-npm 的包级测试：钉住「按 npm 包形态装插件包」的四条不变量。
 *
 * 为什么用临时 profile 目录：这一层真的会跑 `pnpm add`、真的写 package.json 与
 * node_modules。绝不能在真实的 `~/.dsc` 上试，也不该依赖仓库自己的依赖树。
 *
 * 为什么断言「逐字节相同」而不是「JSON 深相等」：回滚的意义就是磁盘回到原样，
 * 格式化差异也算没还原干净。
 * @module @pneuma/plugin-manager/tests
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const { installNpmBundle, removeNpmBundle } = await import(
  new URL('../../../../lib/core/plugin-npm.js', import.meta.url).href
)
const { pluginManagerPlugin } = await import(
  new URL('../../../../lib/packages/plugin-manager/index.js', import.meta.url).href
)

const root = mkdtempSync(join(tmpdir(), 'pneuma-plugin-npm-'))
const profileDir = join(root, 'profile')
const packageDir = join(root, 'probe-hello')

/** 造一个最小组合包：一个清单、一份 patch、一个入口。 */
function makeProbePackage() {
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: 'probe-hello',
        version: '1.0.0',
        main: 'index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  writeFileSync(join(packageDir, 'cordis.patch.yml'), "- insert:\n    - id: probe-hello\n      name: 'probe-hello'\n", 'utf8')
  writeFileSync(join(packageDir, 'index.js'), 'export default {}\n', 'utf8')
}

/** 造一个临时 profile 目录（最小 package.json）。 */
function makeProfile() {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), '{"name":"probe-profile","private":true}\n', 'utf8')
}

/** 读 profile 的 package.json（每次都重读，断言的是磁盘上的现状）。 */
function profileManifest() {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

let passed = 0

test('工具接线：action 枚举里有 install_package / remove_package，spec 参数在', () => {
  let tool
  pluginManagerPlugin.apply({
    tools: {
      register(entry) {
        tool = entry
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
  })
  assert.ok(tool, 'plugin_manager 工具没注册出来')
  const actions = tool.parameters.properties.action.enum
  for (const action of ['install_package', 'remove_package']) {
    assert.ok(actions.includes(action), `缺少 action ${action}`)
    assert.ok(tool.description.includes(action))
  }
  assert.ok(tool.parameters.properties.spec, '缺少 spec 参数')
  assert.ok(actions.includes('list') && actions.includes('install'))
  passed += 1
})

test('装本地插件包：name/version/patch 都对，清单与 node_modules 落盘', async () => {
  makeProfile()
  makeProbePackage()
  const outcome = await installNpmBundle('file:' + packageDir, { profileDir })
  assert.equal(outcome.ok, true, outcome.detail)
  assert.equal(outcome.name, 'probe-hello')
  assert.ok(typeof outcome.version === 'string' && outcome.version.length > 0)
  assert.ok((outcome.patches ?? 0) >= 1)
  assert.ok(existsSync(join(profileDir, 'node_modules', 'probe-hello', 'package.json')))
  const manifest = profileManifest()
  assert.ok(manifest.dsh.profile.bundles.includes('probe-hello'))
  assert.ok(manifest.dependencies['probe-hello'])
  passed += 1
})

test('pnpm 失败：清单与 lockfile 回到调用前（真回滚，不是只报错）', async () => {
  const before = readFileSync(join(profileDir, 'package.json'))
  const hadLock = existsSync(join(profileDir, 'pnpm-lock.yaml'))
  const outcome = await installNpmBundle('file:' + join(root, 'no-such-package-dir'), { profileDir })
  assert.equal(outcome.ok, false, outcome.detail)
  assert.equal(outcome.restored, true)
  assert.deepEqual(readFileSync(join(profileDir, 'package.json')), before)
  assert.equal(existsSync(join(profileDir, 'pnpm-lock.yaml')), hadLock)
  passed += 1
})

test('非法 spec：拒绝且 package.json 逐字节不变', async () => {
  const before = readFileSync(join(profileDir, 'package.json'))
  const outcome = await installNpmBundle('bad spec!!', { profileDir })
  assert.equal(outcome.ok, false)
  assert.notEqual(outcome.restored, false)
  const afterBytes = readFileSync(join(profileDir, 'package.json'))
  assert.deepEqual(afterBytes, before)
  passed += 1
})

test('以 - 开头的 spec 被拒：那是 pnpm 的选项，不是包名', async () => {
  const before = readFileSync(join(profileDir, 'package.json'))
  const outcome = await installNpmBundle('-g', { profileDir })
  assert.equal(outcome.ok, false)
  // 要点名「选项」，否则用户会以为只是包名写错了
  assert.match(outcome.detail, /选项/)
  assert.deepEqual(readFileSync(join(profileDir, 'package.json')), before)
  passed += 1
})

test('找不到 pnpm：报人话，不动 profile', async () => {
  const before = readFileSync(join(profileDir, 'package.json'))
  const outcome = await installNpmBundle('probe-hello', {
    profileDir,
    pnpmPath: join(root, 'no-such-bin', 'pnpm'),
  })
  assert.equal(outcome.ok, false)
  assert.ok(outcome.detail.includes('找不到 pnpm'), outcome.detail)
  assert.deepEqual(readFileSync(join(profileDir, 'package.json')), before)
  passed += 1
})

test('卸载：bundles 与 dependencies 都不再含它', async () => {
  const outcome = await removeNpmBundle('probe-hello', { profileDir })
  assert.equal(outcome.ok, true, outcome.detail)
  const manifest = profileManifest()
  assert.ok(!manifest.dsh.profile.bundles.includes('probe-hello'))
  assert.equal(manifest.dependencies?.['probe-hello'], undefined)
  passed += 1
})

after(() => {
  rmSync(root, { recursive: true, force: true })
  console.log(`通过 ${String(passed)} 项`)
})
