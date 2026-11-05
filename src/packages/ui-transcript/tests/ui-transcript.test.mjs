/**
 * ui-transcript 包级测试：薄宿主半的身份（name）、空 apply 与清单声明的对齐。
 *
 * 真画东西的界面半在 ui/ui.tsx，由界面壳单独构建，不在包级测试里跑；
 * 这里只钉宿主半与 package.json / cordis.patch.yml 的形状（先 pnpm run build）。
 * 单独跑：node src/packages/ui-transcript/tests/ui-transcript.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const mod = await import(new URL('../../../../lib/packages/ui-transcript/index.js', import.meta.url).href)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
/** 界面契约版本 = 壳包的 version。不写死：抬产品号时这份测试不用跟着改。 */
const shellVersion = JSON.parse(readFileSync(new URL('../../../../ui-shell/package.json', import.meta.url), 'utf8')).version

let pass = 0, fail = 0
const check = (label, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${label}`) } catch (error) { fail += 1; console.log(`FAIL  ${label} → ${error.message}`) }
}

check('导出的 name 是 ui-transcript', () => assert.equal(mod.name, 'ui-transcript'))
check('apply 是空实现：不吃参数、调用不做任何事', () => {
  assert.equal(mod.apply.length, 0)
  assert.equal(mod.apply(), undefined)
})
check('package.json：order 368（界面段里 transcript 的位置）', () => assert.equal(manifest.pneuma.order, 368))
check('界面半的声明在：./client 指到 ui/ui.tsx，pneuma.client 写了平台与 API', () => {
  assert.equal(manifest.exports['./client'], './ui/ui.tsx')
  assert.equal(manifest.pneuma.client.platform, 'pneuma')
  assert.equal(manifest.pneuma.client.api, '^' + shellVersion)
})
check('行 id 与导出的 name 一致，行的 name 是这个包', () => {
  const rowId = /- id: (\S+)/.exec(patch)[1]
  assert.equal(rowId, mod.name)
  assert.match(patch, new RegExp(`name: '${manifest.name}'`))
})

console.log(`通过 ${pass}${fail === 0 ? '' : `，失败 ${fail}`}`)
if (fail > 0) process.exit(1)
