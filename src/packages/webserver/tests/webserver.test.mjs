/**
 * `@pneuma/webserver` 的包级测试：钉 6 条不变量。
 *
 * 为什么只钉这些：真正监听端口的是 `core/ui-server.js`（那边有独立单测），
 * 包这一层只管两件事——装配（插件对象、服务名、inject 依赖）与读配置
 * （`readUiServerConfig` 对越界端口、环境变量开关的处理）。这两处错了会表现成
 * 「界面起不来」或「端口被莫名占着」，而日志里只留一句起不来，看不出原因。
 *
 * 入口加载的是 `lib/packages/webserver/index.js`（构建产物）：顶层只有 import，
 * 服务在 `apply` 里才建，没有顶层副作用，所以能真 import。
 *
 * @module @pneuma/webserver/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

let passed = 0

test('装配行与包名对得上：cordis.patch.yml 里 id 与 name 都是本包', () => {
  const patch = read('../cordis.patch.yml')
  // 为什么钉：行 id 写成别的包，插件中心的开关就永远关不掉这个包（关的是别人）。
  assert.ok(patch.includes('id: webserver'), 'cordis.patch.yml 里没有 id: webserver')
  assert.ok(patch.includes("name: '@pneuma/webserver'"), "cordis.patch.yml 里没有 name: '@pneuma/webserver'")
  passed += 1
})

test('包形态：ESM、两个出口、功能包声明 bundle.patch', () => {
  const pkg = JSON.parse(read('../package.json'))
  // 为什么钉：包级产物按 ESM 加载，出口少了壳就 import 不到；patch 声明丢了装配行不生效。
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'].default, './index.js', '缺少 exports["."]')
  assert.equal(pkg.exports['./package.json'], './package.json', '缺少 exports["./package.json"]')
  assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  passed += 1
})

test('入口能加载：webserverPlugin 的 name 与包名同源，apply 是函数', async () => {
  const mod = await import('../../../../lib/packages/webserver/index.js')
  const pkg = JSON.parse(read('../package.json'))
  const plugin = mod.webserverPlugin
  // 为什么钉：名字是这一行的身份，必须等于行 id / 包名后缀；
  // apply 不在，服务就永远不会被建起来。
  assert.equal(typeof plugin, 'object', '入口没有导出 webserverPlugin')
  assert.equal(typeof plugin.name, 'string')
  assert.equal(plugin.name, 'webserver')
  assert.equal(typeof plugin.apply, 'function', 'webserverPlugin 没有 apply')
  assert.equal(pkg.name, '@pneuma/' + plugin.name)
  passed += 1
})

test('服务契约：provide webServer，inject 带上 ui 与 transcript', async () => {
  // 为什么钉：inject 少了 transcript，装载问题写进会话流时会抛 without inject，
  // ensure() 整个 reject，桌面壳收不到地址就静默回落旧渲染层（真踩过）。
  const { webserverPlugin: plugin } = await import('../../../../lib/packages/webserver/index.js')
  assert.equal(plugin.provide, 'webServer', 'provide 不是 webServer：桌面主进程按这个名字取地址')
  assert.ok(Array.isArray(plugin.inject), 'inject 不是数组')
  for (const dep of ['ui', 'transcript']) {
    assert.ok(plugin.inject.includes(dep), 'inject 少了 ' + dep)
  }
  passed += 1
})

test('readUiServerConfig：越界端口回落 0，DSC_UI_SERVER=1 强制开', async () => {
  // 为什么钉：端口越界若原样透给 net.listen 会直接抛；环境变量开关是自检轨的唯一入口。
  const { readUiServerConfig } = await import('../../../../lib/packages/webserver/index.js')
  const savedPort = process.env['DSC_UI_PORT']
  const savedServer = process.env['DSC_UI_SERVER']
  process.env['DSC_UI_PORT'] = '99999'
  process.env['DSC_UI_SERVER'] = '1'
  try {
    const config = readUiServerConfig({})
    assert.equal(config.enabled, true, 'DSC_UI_SERVER=1 时没有打开')
    assert.equal(config.port, 0, '端口 99999 越界却没有回落到 0')
    assert.equal(typeof config.hmr.enabled, 'boolean', 'hmr.enabled 不是布尔')
    assert.ok(
      Number.isInteger(config.hmr.pollIntervalMs) &&
        config.hmr.pollIntervalMs >= 50 &&
        config.hmr.pollIntervalMs <= 60_000,
      'hmr.pollIntervalMs 越界：' + String(config.hmr.pollIntervalMs),
    )
    assert.ok(
      config.assetsDir === undefined || typeof config.assetsDir === 'string',
      'assetsDir 既不是 undefined 也不是字符串',
    )
  } finally {
    if (savedPort === undefined) delete process.env['DSC_UI_PORT']
    else process.env['DSC_UI_PORT'] = savedPort
    if (savedServer === undefined) delete process.env['DSC_UI_SERVER']
    else process.env['DSC_UI_SERVER'] = savedServer
  }
  passed += 1
})

test('README 留着两段人读的契约', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), 'README 丢了 ## Model Experience 段')
  assert.ok(readme.includes('## Known Limitations'), 'README 丢了 ## Known Limitations 段')
  passed += 1
})

// 断言计数只给 scripts/package-tests.mjs 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
