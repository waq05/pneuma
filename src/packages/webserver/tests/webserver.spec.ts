/**
 * `@pneuma/webserver` 的包级测试：钉 6 条不变量。
 *
 * 为什么只钉这些：真正监听端口的是 `core/ui-server.js`（那边有独立单测），
 * 包这一层只管两件事——装配（插件对象、服务名、inject 依赖）与读配置
 * （`readUiServerConfig` 对越界端口、环境变量开关的处理）。这两处错了会表现成
 * 「界面起不来」或「端口被莫名占着」，而日志里只留一句起不来，看不出原因。
 *
 * 迁移说明：装配行改成 `YAML.parse` 后断言结构；入口直接 import 源码，不再依赖 `lib/` 产物。
 *
 * @module @pneuma/webserver/tests
 */
import { readFileSync } from 'node:fs'
import YAML from 'yaml'
import { expect, test } from 'vitest'
import { readUiServerConfig, webserverPlugin } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type?: string
  exports?: Record<string, { default?: string } | string>
  pneuma?: { library?: boolean; bundle?: { patch?: string } }
}

/** 装配文件里的一行。 */
interface PatchRow {
  id?: string
  name?: string
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

test('装配行与包名对得上：cordis.patch.yml 里 id 与 name 都是本包', () => {
  const patch = YAML.parse(read('../cordis.patch.yml')) as Array<{ insert?: PatchRow[] }>
  const row = patch.flatMap((layer) => layer.insert ?? []).find((item) => item.id === 'webserver')
  // 为什么钉：行 id 写成别的包，插件中心的开关就永远关不掉这个包（关的是别人）。
  expect(row, 'cordis.patch.yml 里没有 id: webserver').toBeDefined()
  expect(row?.name, "cordis.patch.yml 里没有 name: '@pneuma/webserver'").toBe('@pneuma/webserver')
})

test('包形态：ESM、两个出口、功能包声明 bundle.patch', () => {
  // 为什么钉：包级产物按 ESM 加载，出口少了壳就 import 不到；patch 声明丢了装配行不生效。
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], '缺少 exports["."]').toBeDefined()
  expect(pkg.exports?.['./package.json'], '缺少 exports["./package.json"]').toBeDefined()
  expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
})

test('入口能加载：webserverPlugin 的 name 与包名同源，apply 是函数', () => {
  const plugin = webserverPlugin
  // 为什么钉：名字是这一行的身份，必须等于行 id / 包名后缀；
  // apply 不在，服务就永远不会被建起来。
  expect(typeof plugin, '入口没有导出 webserverPlugin').toBe('object')
  expect(typeof plugin.name).toBe('string')
  expect(plugin.name).toBe('webserver')
  expect(typeof plugin.apply, 'webserverPlugin 没有 apply').toBe('function')
  expect(pkg.name).toBe('@pneuma/' + plugin.name)
})

test('服务契约：provide webServer，inject 带上 ui 与 transcript', () => {
  // 为什么钉：inject 少了 transcript，装载问题写进会话流时会抛 without inject，
  // ensure() 整个 reject，桌面壳收不到地址就静默回落旧渲染层（真踩过）。
  expect(webserverPlugin.provide, 'provide 不是 webServer：桌面主进程按这个名字取地址').toBe('webServer')
  expect(Array.isArray(webserverPlugin.inject), 'inject 不是数组').toBe(true)
  for (const dep of ['ui', 'transcript']) {
    expect(webserverPlugin.inject, 'inject 少了 ' + dep).toContain(dep)
  }
})

test('readUiServerConfig：越界端口回落 0，DSC_UI_SERVER=1 强制开', () => {
  // 为什么钉：端口越界若原样透给 net.listen 会直接抛；环境变量开关是自检轨的唯一入口。
  const savedPort = process.env['DSC_UI_PORT']
  const savedServer = process.env['DSC_UI_SERVER']
  process.env['DSC_UI_PORT'] = '99999'
  process.env['DSC_UI_SERVER'] = '1'
  try {
    const config = readUiServerConfig({})
    expect(config.enabled, 'DSC_UI_SERVER=1 时没有打开').toBe(true)
    expect(config.port, '端口 99999 越界却没有回落到 0').toBe(0)
    expect(typeof config.hmr.enabled, 'hmr.enabled 不是布尔').toBe('boolean')
    expect(
      Number.isInteger(config.hmr.pollIntervalMs) &&
        config.hmr.pollIntervalMs >= 50 &&
        config.hmr.pollIntervalMs <= 60_000,
      'hmr.pollIntervalMs 越界：' + String(config.hmr.pollIntervalMs),
    ).toBe(true)
    expect(
      config.assetsDir === undefined || typeof config.assetsDir === 'string',
      'assetsDir 既不是 undefined 也不是字符串',
    ).toBe(true)
  } finally {
    if (savedPort === undefined) delete process.env['DSC_UI_PORT']
    else process.env['DSC_UI_PORT'] = savedPort
    if (savedServer === undefined) delete process.env['DSC_UI_SERVER']
    else process.env['DSC_UI_SERVER'] = savedServer
  }
})

test('README 留着两段人读的契约', () => {
  const readme = read('../README.md')
  expect(readme, 'README 丢了 ## Model Experience 段').toContain('## Model Experience')
  expect(readme, 'README 丢了 ## Known Limitations 段').toContain('## Known Limitations')
})
