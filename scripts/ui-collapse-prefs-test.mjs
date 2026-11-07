/**
 * 折叠时机（collapseTiming）与「收起后显示的回复」（foldedReplies）从存档到设置页的确定性测试。
 *
 * 为什么要有这一条：这两项是照参考实现（ui-chat 的 chat-settings.ts）加的新偏好，
 * 最容易「存了但没通」——存档没默认值、坏值把启动拦下来、setUiPrefs 收下了但 getUiPrefs
 * 不带出来、设置页照旧只有一行「过程折叠程度」。人眼看不到这些缺口，所以逐段钉住：
 *
 *   [1] 读档：没这两项时给默认（completion / all）；
 *   [2] 读档：好值原样读回；
 *   [3] 读档：坏值（认不出的字符串、null、数字、布尔、整份坏 JSON）一律回落默认，不抛；
 *   [4] setUiPrefs → getUiPrefs 往返：两项都带出来，且落进 settings.json；
 *   [5] setUiPrefs 只改一项时不动另一项；回执文案说清切成了什么；
 *   [6] 源码钉：契约、读档归一、界面归一、设置页两个下拉、两份词典一一对应。
 *
 * 跑法：node scripts/ui-collapse-prefs-test.mjs（先 pnpm run build）
 *
 * @module dsc/scripts/ui-collapse-prefs-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
/** 读仓库里的源文件（源码钉用）。 */
const read = (rel) => readFileSync(join(root, rel), 'utf8')

// 先钉住 DSC_HOME，再动态 import：prefs 的 settings.json 路径是模块求值时算出来的。
const home = mkdtempSync(join(tmpdir(), 'dsc-collapse-prefs-'))
process.env.DSC_HOME = home
const { DSC_SETTINGS_JSON, readPrefs, writePrefs } = await import('../lib/core/prefs.js')
const { runtimePlugin } = await import('../lib/packages/runtime/index.js')

let passed = 0
let failed = 0

/**
 * 记一条断言。
 *
 * @param {string} name 断言名（中文）
 * @param {boolean} ok 是否通过
 * @param {string} detail 失败时附上的读数
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log('  ok  ' + name)
    return
  }
  failed += 1
  console.log('FAIL  ' + name + (detail === '' ? '' : '  <- ' + detail))
}

/**
 * 造一份 settings.json。
 *
 * @param {object} doc 文件内容
 */
function writeSettings(doc) {
  mkdirSync(dirname(DSC_SETTINGS_JSON), { recursive: true })
  writeFileSync(DSC_SETTINGS_JSON, JSON.stringify(doc), 'utf8')
}

/**
 * 用一个最小的假 ctx 装上 runtime 插件，拿到它的 ui 服务。
 *
 * 只实现 setUiPrefs / getUiPrefs 真正用到的两个方法：prefs() 读盘、setPrefs() 深合并写盘。
 * 其余服务都在别的接口里，这两条路不碰它们（apply 阶段也不碰）。
 */
function bootRuntime() {
  let service
  runtimePlugin.apply({
    settings: {
      prefs: () => readPrefs(),
      setPrefs: (patch) => writePrefs(patch),
    },
    provide: (_name, value) => {
      service = value
    },
    emit: () => {},
  })
  return service
}

console.log('\n[1] 读档：没这两项时给默认值')
{
  writeSettings({})
  const ui = readPrefs().ui
  check('缺键时 collapseTiming = completion', ui.collapseTiming === 'completion', String(ui.collapseTiming))
  // 2026-11-07 默认改成 final：与用户实际那台 dsh 的收起形态一致（收起后只剩最终回答）。
  check('缺键时 foldedReplies = final', ui.foldedReplies === 'final', String(ui.foldedReplies))
}

console.log('\n[2] 读档：好值原样读回')
{
  writeSettings({ ui: { collapseTiming: 'next-input', foldedReplies: 'final' } })
  const ui = readPrefs().ui
  check('next-input 读回', ui.collapseTiming === 'next-input', String(ui.collapseTiming))
  check('final 读回', ui.foldedReplies === 'final', String(ui.foldedReplies))
  writeSettings({ ui: { collapseTiming: 'completion', foldedReplies: 'all' } })
  const second = readPrefs().ui
  check('completion 也读得回（不等于缺键）', second.collapseTiming === 'completion', String(second.collapseTiming))
  check('all 也读得回', second.foldedReplies === 'all', String(second.foldedReplies))
}

console.log('\n[3] 读档：坏值一律回落默认，绝不拦启动')
{
  const bads = [
    ['认不出的字符串', 'later'],
    ['大小写不对', 'Next-Input'],
    ['null', null],
    ['数字', 1],
    ['布尔', true],
    ['对象', { timing: 'next-input' }],
  ]
  for (const [label, value] of bads) {
    writeSettings({ ui: { collapseTiming: value, foldedReplies: value } })
    const ui = readPrefs().ui
    check(
      label + ' → completion / final',
      ui.collapseTiming === 'completion' && ui.foldedReplies === 'final',
      JSON.stringify({ collapseTiming: ui.collapseTiming, foldedReplies: ui.foldedReplies }),
    )
  }
  // 一项坏不影响另一项。
  writeSettings({ ui: { collapseTiming: 'next-input', foldedReplies: 'nope' } })
  const mixed = readPrefs().ui
  check('好的那项照读，坏的那项回落', mixed.collapseTiming === 'next-input' && mixed.foldedReplies === 'final', JSON.stringify(mixed))
  // 整份坏 JSON：读档走 catch，给默认值。
  writeFileSync(DSC_SETTINGS_JSON, '{ this is not json', 'utf8')
  let threw = null
  let broken
  try {
    broken = readPrefs().ui
  } catch (error) {
    threw = error
  }
  check('坏 JSON 不抛', threw === null, threw === null ? '' : String(threw))
  check(
    '坏 JSON 时两项仍是默认值',
    broken.collapseTiming === 'completion' && broken.foldedReplies === 'final',
    JSON.stringify(broken),
  )
}

console.log('\n[4] setUiPrefs → getUiPrefs 往返：两项都带出来，且落进 settings.json')
{
  writeSettings({})
  const service = bootRuntime()

  // 先读一次：默认值也在。
  const before = service.getUiPrefs()
  check('getUiPrefs 带出 collapseTiming', before.collapseTiming === 'completion', String(before.collapseTiming))
  check('getUiPrefs 带出 foldedReplies', before.foldedReplies === 'final', String(before.foldedReplies))

  const reply = await service.setUiPrefs({ collapseTiming: 'next-input', foldedReplies: 'final' })
  check('setUiPrefs 返回 ok', reply.ok === true, JSON.stringify(reply))
  check('回执说清时机切成了什么', String(reply.notice).includes('下次发言时收起'), String(reply.notice))
  const after = service.getUiPrefs()
  check('往返后 collapseTiming = next-input', after.collapseTiming === 'next-input', String(after.collapseTiming))
  check('往返后 foldedReplies = final', after.foldedReplies === 'final', String(after.foldedReplies))
  const disk = JSON.parse(readFileSync(DSC_SETTINGS_JSON, 'utf8'))
  check('settings.json 的 ui.collapseTiming 落了盘', disk.ui.collapseTiming === 'next-input', JSON.stringify(disk.ui))
  check('settings.json 的 ui.foldedReplies 落了盘', disk.ui.foldedReplies === 'final', JSON.stringify(disk.ui))
  check(
    '重读偏好仍是往返后的值',
    readPrefs().ui.collapseTiming === 'next-input' && readPrefs().ui.foldedReplies === 'final',
    JSON.stringify(readPrefs().ui),
  )
}

console.log('\n[5] 只改一项时不动另一项，回执按项说明')
{
  // 上一段留下 next-input / final；这里只把时机改回立即收起。
  const service = bootRuntime()
  const onlyTiming = await service.setUiPrefs({ collapseTiming: 'completion' })
  check('回执说清改为立即收起', String(onlyTiming.notice).includes('立即收起'), String(onlyTiming.notice))
  check('只改时机时回复档保持 final', service.getUiPrefs().foldedReplies === 'final', String(service.getUiPrefs().foldedReplies))
  check('时机本身改回 completion', service.getUiPrefs().collapseTiming === 'completion')

  const onlyReplies = await service.setUiPrefs({ foldedReplies: 'all' })
  check('回执说清保留全部回复', String(onlyReplies.notice).includes('全部回复'), String(onlyReplies.notice))
  check('只改回复档时不碰时机', service.getUiPrefs().collapseTiming === 'completion')
  check('回复档改回 all', service.getUiPrefs().foldedReplies === 'all')
}

console.log('\n[6] 源码钉：契约 / 归一 / 设置页 / 词典')
{
  const contract = read('src/contract/session.ts')
  check('契约有 collapseTiming 字段', /collapseTiming: UiCollapseTiming/.test(contract))
  check('契约有 foldedReplies 字段', /foldedReplies: UiFoldedReplies/.test(contract))
  check('契约声明两档时机取值', /type UiCollapseTiming = 'completion' \| 'next-input'/.test(contract))
  check('契约声明两档回复取值', /type UiFoldedReplies = 'all' \| 'final'/.test(contract))

  const prefs = read('src/core/prefs.ts')
  check('读档表含 completion / next-input', /\['completion', 'next-input'\]/.test(prefs))
  check('读档表含 all / final', /\['all', 'final'\]/.test(prefs))
  check('默认时机是 completion', /COLLAPSE_TIMING_DEFAULT: UiCollapseTiming = 'completion'/.test(prefs))
  // 2026-11-07：默认从 all 收紧成 final（长任务里「全部回复」等于没收起）。
  check('默认回复档是 final', /FOLDED_REPLIES_DEFAULT: UiFoldedReplies = 'final'/.test(prefs))
  check('readPrefs 读 collapseTiming', /ui\.collapseTiming !== undefined/.test(prefs))
  check('readPrefs 读 foldedReplies', /ui\.foldedReplies !== undefined/.test(prefs))

  const appearance = read('src/packages/ui-runtime/ui/appearance.ts')
  check('壳的归一化接住 collapseTiming', /collapseTiming: normalizeCollapseTiming\(prefs\?\.collapseTiming\)/.test(appearance))
  check('壳的归一化接住 foldedReplies', /foldedReplies: normalizeFoldedReplies\(prefs\?\.foldedReplies\)/.test(appearance))
  check('壳的默认外观也带这两项', /collapseTiming: 'completion'/.test(appearance) && /foldedReplies: 'final'/.test(appearance))

  const settingsUi = read('src/packages/ui-settings/ui/ui.tsx')
  check('设置页有折叠时机下拉', /settings\.ui\.collapseTiming\.label/.test(settingsUi))
  check('设置页有收起后回复下拉', /settings\.ui\.foldedReplies\.label/.test(settingsUi))
  check(
    '两个下拉各挂两个选项',
    ['option.completion', 'option.nextInput', 'option.all', 'option.final'].every(
      (key) => settingsUi.includes('settings.ui.collapseTiming.' + key) || settingsUi.includes('settings.ui.foldedReplies.' + key),
    ),
  )
  check(
    '改动经 setUiPrefs 落盘（复用 change）',
    /change\(\{ collapseTiming: next \}\)/.test(settingsUi) && /change\(\{ foldedReplies: next \}\)/.test(settingsUi),
  )
  check('设置页归一化兜底 completion', /prefs\?\.collapseTiming === 'next-input' \? 'next-input' : 'completion'/.test(settingsUi))
  check('设置页归一化兜底 all', /prefs\?\.foldedReplies === 'final' \? 'final' : 'all'/.test(settingsUi))

  const zh = JSON.parse(read('src/packages/ui-settings/locale/ui.zh.json'))
  const en = JSON.parse(read('src/packages/ui-settings/locale/ui.en.json'))
  const keys = [
    'settings.ui.collapseTiming.label',
    'settings.ui.collapseTiming.help',
    'settings.ui.collapseTiming.option.completion',
    'settings.ui.collapseTiming.option.nextInput',
    'settings.ui.foldedReplies.label',
    'settings.ui.foldedReplies.help',
    'settings.ui.foldedReplies.option.all',
    'settings.ui.foldedReplies.option.final',
  ]
  check(
    '中文词典八条齐全',
    keys.every((key) => typeof zh[key] === 'string' && zh[key] !== ''),
    JSON.stringify(keys.filter((key) => typeof zh[key] !== 'string')),
  )
  check(
    '英文词典八条齐全',
    keys.every((key) => typeof en[key] === 'string' && en[key] !== ''),
    JSON.stringify(keys.filter((key) => typeof en[key] !== 'string')),
  )
  check('英文里没有汉字', keys.every((key) => !/[\u4e00-\u9fff]/.test(en[key])))

  const runtimeSrc = read('src/packages/runtime/index.ts')
  check('setUiPrefs 给时机回执', /patch\.collapseTiming === 'next-input'/.test(runtimeSrc))
  check('setUiPrefs 给回复档回执', /patch\.foldedReplies === 'final'/.test(runtimeSrc))
}

console.log('')
console.log(failed === 0 ? 'ALL PASS  ' + passed + ' 项' : 'FAILED  ' + failed + ' 项，PASS ' + passed + ' 项')
process.exitCode = failed === 0 ? 0 : 1
