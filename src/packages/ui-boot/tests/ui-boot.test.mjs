/**
 * `@pneuma/ui-boot` 的包级测试：只钉两条不变量。
 *
 * 为什么只钉这两条：本包的实体在浏览器半边（`ui/`），由 `ui-shell` 的构建编进壳的 app
 * bundle；包本身没有可执行的 Node 逻辑。界面行为由 `scripts/ui-plugin-test.mjs` 那批
 * 集成探针负责（它们要整套壳才成立）。
 *
 * 两条都读源码、不读 `lib/`：产物没构建时这两条照样能跑，改坏了当场红。
 *
 * @module @pneuma/ui-boot/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

let passed = 0

test('包身份：库包（有 library、没有 patch / order），exports 至少含 boot.js 与 hmr.js', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.pneuma.library, true, '引导是库包：没有行、不能停用')
  assert.equal(pkg.pneuma.bundle, undefined, '不该有 cordis.patch.yml 声明')
  assert.equal(pkg.pneuma.order, undefined, '库包不参与行排序')
  assert.equal(pkg.exports['./boot.js'], './boot.js')
  assert.equal(pkg.exports['./hmr.js'], './hmr.js')
  passed += 1
})

test('页面入口还在，并把它交给渲染器的 start(api)', () => {
  const entry = read('../ui/main.tsx')
  assert.ok(entry.includes("from './boot'"), '入口没有从 boot.ts 取装载能力')
  assert.ok(entry.includes('loaded.start'), '入口没有调用渲染器的 start(api)')
  assert.match(entry, /RendererUnavailable|RendererFailure/, '入口没有诊断页')
  passed += 1
})

test('平台种子：cordis / zod / react-virtual 在表里，且在 boot.ts 的 MODULES 上挂了实现', () => {
  const seeds = JSON.parse(read('../ui/platform-modules.json'))
  const boot = read('../ui/boot.ts')
  for (const name of ['@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual']) {
    assert.ok(seeds.includes(name), `种子表里没有 ${name}`)
    // 位置也是契约：JSON 与 MODULES 的键顺序被 scripts/ui-plugin-test.mjs 逐位比对，
    // 这里只拦「加在了别人前面」这种一眼能看出来的漂移。
    assert.ok(
      seeds.indexOf(name) > seeds.indexOf('@dsc/ui-runtime') && seeds.indexOf(name) < seeds.indexOf('@xterm/xterm'),
      `${name} 应该在 @dsc/ui-runtime 之后、@xterm/xterm 之前`,
    )
    assert.ok(boot.includes(`from '${name}'`), `boot.ts 没有 import ${name}`)
  }
  passed += 1
})

// 第三方与组合包会带着自己那份 `external` 声明进场：合法的只有「平台种子」与「本图另一条
// 插件」两档。构建期（ui-shell/build-plugins.mjs）与装载期（boot.ts）必须说同一句话，
// 否则用户在终端看到的错与界面诊断区看到的错对不上，谁也不知道该改哪一头。
test('external 校验：装载器按「平台种子或本图插件」判，报错与构建期同一句', () => {
  const boot = read('../ui/boot.ts')
  assert.ok(boot.includes('pneuma.client.external'), '装载器没有校验 external 声明')
  // 文案在字典里，不在 boot.ts 的字符串里（界面半的硬编码由 scripts/ui-locale-test.mjs 拦）。
  // 口径必须与构建期那边一致：这里比的是词典正文里的那句话。
  assert.ok(boot.includes("t('boot.external.unknown'"), '报错文案没走本包字典')
  const zh = JSON.parse(read('../locale/ui.zh.json'))
  assert.ok(
    String(zh['boot.external.unknown']).includes('既不是平台种子，也不是本图的插件'),
    '报错文案与构建期不是一个口径',
  )
  assert.ok(boot.includes('stripClientSuffix'), '没有把 <包名>/client 与包名归一')
  assert.ok(boot.includes('pluginExternal'), 'external 指向的插件没有 require 出口（声明了也取不到）')
  passed += 1
})

// 断言计数只给 `scripts/package-tests.mjs` 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
