/**
 * @pneuma/browser 的包级测试：钉 7 条不变量。
 *
 * 为什么只钉这些：受控浏览器真正的安全边界在地址闸门（协议、私网、域名名单），
 * 那是纯函数，所以额外钉它。真开浏览器不在这层——那要一台真 Chrome，成本不成比例。
 *
 * 迁移说明：原测试读 `lib/` 产物、自己累加 passed 计数；现在直接 import src 入口，
 * 插件对象与纯函数都从同一份源码拿。域名规则与地址闸门拆成两条（一条管名单，
 * 一条管协议/私网），失败时能直接看出是哪一侧坏了。
 *
 * @module @pneuma/browser/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { browserPlugin, evaluateUrlPolicy, hostMatchesRule, isPrivateHost, parseDomainRules } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type?: string
  exports?: Record<string, unknown>
  pneuma?: { library?: boolean; bundle?: { patch?: string } }
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/browser', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch, '装配行的 id 必须正好是 browser').toMatch(/^\s*-\s*id: browser\s*$/m)
  expect(patch, "装配行的 name 必须是 '@pneuma/browser'").toContain("name: '@pneuma/browser'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.name).toBe('@pneuma/browser')
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], 'exports 必须有 "."').toBeDefined()
  expect(pkg.exports?.['./package.json'], 'exports 必须有 "./package.json"').toBeDefined()
  expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma?.library, '功能包不该标成库包').not.toBe(true)
})

// 入口真能加载：插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id；三者不一致说明装配时认错了包。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof browserPlugin).toBe('object')
  expect(typeof browserPlugin.name).toBe('string')
  expect(browserPlugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(browserPlugin.name).toBe('browser')
  expect(typeof browserPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})

// 域名名单：感叹号前缀进拒绝名单；`*.example.com` 只匹配子域，裸域要单独写。
test('域名规则：感叹号进拒绝名单，星号点只匹配子域', () => {
  expect(parseDomainRules('example.com\n!bad.com')).toStrictEqual({ allow: ['example.com'], deny: ['bad.com'] })
  expect(hostMatchesRule('a.example.com', '*.example.com')).toBe(true)
  expect(hostMatchesRule('example.com', '*.example.com')).toBe(false)
  expect(hostMatchesRule('example.com', 'example.com')).toBe(true)
})

// 地址闸门：非 http(s) 协议与私网地址一律拒，公网 https 放行并回填规范化后的地址。
test('地址闸门：file 协议与私网一律拒，公网 https 放行', () => {
  expect(isPrivateHost('192.168.1.1')).toBe(true)
  expect(isPrivateHost('example.com')).toBe(false)
  expect(evaluateUrlPolicy('file:///etc/passwd', { allowedDomains: '' }).allowed).toBe(false)
  expect(evaluateUrlPolicy('http://127.0.0.1:8080/', { allowedDomains: '' }).allowed).toBe(false)
  const ok = evaluateUrlPolicy('https://example.com/', { allowedDomains: '' })
  expect(ok.allowed).toBe(true)
  expect(ok.allowed ? ok.url : '').toBe('https://example.com/')
})

// 名单与拒绝名单同时在场时以拒绝优先：allow 写了 example.com 也不能放行 bad.example.com。
test('域名名单：拒绝优先于放行', () => {
  const policy = { allowedDomains: 'example.com\n!bad.example.com' }
  expect(evaluateUrlPolicy('https://bad.example.com/', policy).allowed).toBe(false)
  expect(evaluateUrlPolicy('https://ok.example.com/', policy).allowed).toBe(true)
})
