/**
 * 启动图的 `services` 透传探针：插件声明「我要等哪个服务就绪」，组图后这一项必须还在。
 *
 * 为什么要有这条：声明去路是「插件清单 → `UiPluginRow.services`（`ui-bundles.ts` 三条解析
 * 分支）→ `composeUiBootGraph` → `UiPluginEntry.services` → 装载器」。
 * 装载器那一跳读的是 `entry.services`（`ui-boot/ui/boot.ts` 的 `serviceDepsOf` 与
 * `unmetDependencies`），读不到就退化成空数组——插件照文档写了 `services`，
 * 实际从来没等过提供者。中间只有组图这一步会丢，所以这条探针就钉这一步。
 *
 * 直接 import 源码里的 `.ts`（Node 24 原生类型擦除，`ui-manifest.ts` 自足、无 import）：
 * 探针验的是「源码现在写成什么样」，不要求先跑构建把 `lib/` 刷一遍。
 *
 * 跑法：node scripts/ui-boot-services-check.mjs
 *
 * @module dsc/scripts/ui-boot-services-check
 */
const { composeUiBootGraph } = await import('../src/core/ui-manifest.ts')

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + (extra === '' ? '' : ' — ' + extra))
  }
}

const host = { name: 'Pneuma', version: '0.0.0-probe' }
const rowsOf = (...items) => items.map((item) => ({ rev: 'r1', ...item }))
const entryOf = (graph, id) => graph.entries.find((entry) => entry.id === id)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('声明了 services 的条目：启动图里原样带着它')
{
  const graph = composeUiBootGraph(host, rowsOf({ id: 'hello', services: ['actions'] }))
  const entry = entryOf(graph, 'hello')
  check('条目在启动图里', entry !== undefined)
  check('services 还在（值是 ["actions"]）', same(entry?.services, ['actions']), JSON.stringify(entry?.services))
  check('顺序与声明一致（["actions","teammates"]）', same(
    entryOf(composeUiBootGraph(host, rowsOf({ id: 'hello', services: ['actions', 'teammates'] })), 'hello')?.services,
    ['actions', 'teammates'],
  ))
}

console.log('没声明时：既定形状是「字段缺省」，下游读到空数组')
{
  const graph = composeUiBootGraph(host, rowsOf({ id: 'plain' }))
  const entry = entryOf(graph, 'plain')
  check('entry 上没有 services 键（不是空数组，也不是 null）', entry !== undefined && !('services' in entry), JSON.stringify(entry))
  // 装载器的读法就是 `[...(item.services ?? [])]`：缺省时必须是空数组，不能是 undefined 元素。
  check('装载器读法得到空数组', Array.isArray([...(entry?.services ?? [])]) && [...(entry.services ?? [])].length === 0)
}

console.log('多条混在一起：各归各的，不串味')
{
  const graph = composeUiBootGraph(host, rowsOf(
    { id: 'a', services: ['actions'] },
    { id: 'b' },
    { id: 'c', services: ['teammates', 'actions'] },
  ))
  check('a 带 ["actions"]', same(entryOf(graph, 'a')?.services, ['actions']), JSON.stringify(entryOf(graph, 'a')?.services))
  check('b 没有 services', entryOf(graph, 'b') !== undefined && !('services' in entryOf(graph, 'b')))
  check('c 带 ["teammates","actions"]', same(entryOf(graph, 'c')?.services, ['teammates', 'actions']), JSON.stringify(entryOf(graph, 'c')?.services))
}

console.log('整图 rev 覆盖这条声明（只改声明、不动产物，也要换 rev）')
{
  const withServices = composeUiBootGraph(host, rowsOf({ id: 'x', services: ['actions'] }))
  const without = composeUiBootGraph(host, rowsOf({ id: 'x' }))
  check('声明 / 不声明的 rev 不同', withServices.rev !== without.rev, `${withServices.rev} vs ${without.rev}`)
  check('同一份声明两次的 rev 相同', composeUiBootGraph(host, rowsOf({ id: 'x', services: ['actions'] })).rev === withServices.rev)
  check('换一个服务名 rev 也变', composeUiBootGraph(host, rowsOf({ id: 'x', services: ['teammates'] })).rev !== withServices.rev)
}

console.log('两个载体读到同一份（Web 读 entry、TUI 读 row）')
{
  const row = { id: 'hello', rev: 'r1', services: ['actions'] }
  const entry = entryOf(composeUiBootGraph(host, [row]), 'hello')
  check('entry.services 与 row.services 相等', same(entry?.services, row.services), `${JSON.stringify(entry?.services)} vs ${JSON.stringify(row.services)}`)
  check('row 上声明了、entry 上也就有（不是两边各读各的）', row.services !== undefined && entry?.services !== undefined)
}

console.log(`PASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
