/**
 * @pneuma/browser 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：受控浏览器真正的安全边界在地址闸门（协议、私网、域名名单），那是纯函数，所以额外钉它。
 * @module @pneuma/browser/tests
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { after, test } from 'node:test'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
let passed = 0

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/browser', () => {
  const patch = read('../cordis.patch.yml')
  assert.match(patch, /^\s*-\s*id: browser\s*$/m, '装配行的 id 必须正好是 browser')
  assert.ok(patch.includes("name: '@pneuma/browser'"), "装配行的 name 必须是 '@pneuma/browser'")
  passed += 1
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(pkg.name, '@pneuma/browser')
  assert.equal(pkg.type, 'module')
  assert.ok(pkg.exports['.'], 'exports 必须有 "."')
  assert.ok(pkg.exports['./package.json'], 'exports 必须有 "./package.json"')
  assert.equal(pkg.pneuma.bundle.patch, './cordis.patch.yml')
  assert.notEqual(pkg.pneuma.library, true, '功能包不该标成库包')
  passed += 1
})

// 入口真能加载：lib 产物已构建，这里直接 import 并检查插件对象的三件事。
test('lib 入口能加载，插件名与 apply 对得上', async () => {
  const pkg = JSON.parse(read('../package.json'))
  const mod = await import('../../../../lib/packages/browser/index.js')
  const keys = Object.keys(mod).filter((key) => /Plugin$/.test(key))
  assert.equal(keys.length, 1, '入口应当恰好导出一个 *Plugin 对象')
  const plugin = mod[keys[0]]
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.name, 'string')
  // 插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
  assert.equal(plugin.name, pkg.name.slice('@pneuma/'.length))
  assert.equal(plugin.name, 'browser')
  assert.equal(typeof plugin.apply, 'function')
  passed += 1
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  assert.ok(readme.includes('## Model Experience'), '缺 ## Model Experience')
  assert.ok(readme.includes('## Known Limitations'), '缺 ## Known Limitations')
  passed += 1
})

const browser = await import('../../../../lib/packages/browser/index.js')

test('域名规则：感叹号进拒绝名单，星号点只匹配子域', () => {
  assert.deepEqual(browser.parseDomainRules('example.com\n!bad.com'), { allow: ['example.com'], deny: ['bad.com'] })
  assert.equal(browser.hostMatchesRule('a.example.com', '*.example.com'), true)
  assert.equal(browser.hostMatchesRule('example.com', '*.example.com'), false)
  assert.equal(browser.hostMatchesRule('example.com', 'example.com'), true)
  passed += 1
})

test('地址闸门：file 协议与私网一律拒，公网 https 放行', () => {
  assert.equal(browser.isPrivateHost('192.168.1.1'), true)
  assert.equal(browser.isPrivateHost('example.com'), false)
  assert.equal(browser.evaluateUrlPolicy('file:///etc/passwd', { allowedDomains: '' }).allowed, false)
  assert.equal(browser.evaluateUrlPolicy('http://127.0.0.1:8080/', { allowedDomains: '' }).allowed, false)
  const ok = browser.evaluateUrlPolicy('https://example.com/', { allowedDomains: '' })
  assert.equal(ok.allowed, true)
  assert.equal(ok.url, 'https://example.com/')
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
