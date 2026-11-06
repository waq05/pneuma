/**
 * runtime_api 的反射主题（services / events）探针：纯函数 + 源码钉。
 *
 * 为什么要有它：这两个主题读的是 cordis 的内部结构（`reflect.store` / `events._hooks`），
 * 口径错了不会报错、只会报出一堆假信息（原型方法、internal 事件、重复服务）。
 *
 * 用法：node scripts/runtime-api-test.mjs（先 pnpm run build）
 *
 * @module dsc/scripts/runtime-api-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), 'utf8')
const inspect = await import(new URL('../lib/packages/runtime-api/inspect.js', import.meta.url).href)

let pass = 0
let fail = 0
const check = (label, ok, extra = '') => {
  if (ok) { pass += 1; console.log('  ok  ' + label); return }
  fail += 1; console.log('  FAIL ' + label + (extra === '' ? '' : ' — ' + extra))
}

console.log('[1] listServices')
{
  const store = {}
  store[Symbol('a')] = { name: 'tools', value: { register() {}, list() {}, project() {} } }
  // 同一服务在另一个 isolation 作用域里的副本：方法少的丢掉。
  store[Symbol('b')] = { name: 'tools', value: { register() {} } }
  store[Symbol('c')] = { name: 'guards', value: { chain: [] } }
  store[Symbol('d')] = { name: 'broken' }
  const rows = inspect.listServices(store)
  check('按名字排序', rows.map((r) => r.name).join(',') === 'broken,guards,tools', JSON.stringify(rows.map((r) => r.name)))
  const tools = rows.find((r) => r.name === 'tools')
  check('重复实现保留方法多的那一份', tools.methods.length === 3, JSON.stringify(tools.methods))
  check('没有值的服务不炸', rows.some((r) => r.name === 'broken' && r.methods.length === 0))
  check('原型链上的 Object 方法不进清单', !tools.methods.includes('hasOwnProperty'), JSON.stringify(tools.methods))
  check('空表给空数组', inspect.listServices(undefined).length === 0)
}

console.log('[2] listEvents')
{
  const sym = Symbol('dsc/private')
  const hooks = {
    'dsc/changed': [() => {}, () => {}],
    'internal/listener': [() => {}],
    'agent/start': [],
    [sym]: [() => {}],
  }
  const rows = inspect.listEvents(hooks)
  check('internal/* 不列', !rows.some((r) => r.name.startsWith('internal/')))
  check('空监听不列', !rows.some((r) => r.name === 'agent/start'))
  check('字符串事件带监听数', rows.some((r) => r.name === 'dsc/changed' && r.listeners === 2), JSON.stringify(rows))
  check('符号事件也列', rows.length === 2, JSON.stringify(rows))
  check('按名字排序', rows[0].name.localeCompare(rows[1].name) <= 0)
}

console.log('[3] 源码钉：两个主题接进了 tools')
{
  const src = read('src/packages/runtime-api/index.ts')
  check('TOPICS 含 services / events', /const TOPICS = \[[^\]]*'services', 'events'/.test(src))
  check('BUILDERS 挂了两个新主题', /services: describeServices/.test(src) && /events: describeEvents/.test(src))
  check('描述里提到两个主题', src.includes('topic=services') && src.includes('topic=events'))
  check('反射逻辑走纯函数（不在闭包里各写一份）', src.includes("from './inspect.js'") && src.includes('listServices(reflect?.store)'))
  const inspectSrc = read('src/packages/runtime-api/inspect.ts')
  check('纯函数零运行时依赖', !/from '@|from '.*core/.test(inspectSrc))
}

console.log('')
console.log(fail === 0 ? 'ALL PASS  ' + pass + ' 项' : 'FAILED  ' + fail + ' 项，PASS ' + pass + ' 项')
process.exitCode = fail === 0 ? 0 : 1
