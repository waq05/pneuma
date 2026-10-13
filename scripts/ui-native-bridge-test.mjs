/**
 * 原生桥的规格测试：白名单、实参校验、与桌面那两侧的接线。
 *
 * 为什么单开一份：原生桥是**页面能触到 Electron 主进程**的唯一一条路，它的价值不在于
 * 那条路能做什么（这里全是既定的窄动作），而在于**别的东西进不来**。所以断言钉在四件事上：
 *
 *   1. **校验真的在拦**：未知操作、非数组实参、多传、少传、类型不对、长度超限、坏枚举、
 *      坏 `#rrggbb`、`notify` 的字段形状——逐条都有拒的门；
 *   2. **白名单里没有"执行/读写任意东西"的操作**：明确点名的那批（装插件、装技能、
 *      内嵌浏览器那几个、以及任何泛用 invoke / runCommand）一个都不许出现；
 *   3. **规格与实现绑死**：`README` 式的口径没用，这里从**源码**上确认桌面主进程注册了
 *      `dsc:native`、preload 挂了 `dscNative`、并且每个操作都在主进程的分派表里出现过
 *      （编译期的 `Record<NativeOp, …>` 是主闸门，这条是防止有人把类型注解绕过去）；
 *   4. 版本常量是个正整数（壳拿它跟自己对一下）。
 *
 * 隔离：这一份纯读源码 + 纯函数，不写任何文件、不碰 `~/.dsc`。
 *
 * 用法：npx tsc -p tsconfig.json && node scripts/ui-native-bridge-test.mjs
 *
 * @module dsc/scripts/ui-native-bridge-test
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const {
  NATIVE_BRIDGE_VERSION,
  NATIVE_OPS,
  NATIVE_OP_SET,
  NATIVE_EVENTS,
  NATIVE_EVENT_SET,
  NATIVE_ARG_SPECS,
  validateNativeCall,
} = await import('../lib/core/native-bridge.js')
const { DOCK_OPS, DOCK_UI_OPS, DOCK_TERM_OPS } = await import('../lib/core/dock-ops.js')
const { UI_METHODS, UI_EXCLUDED, UI_ARG_SPECS, validateUiArgs } = await import('../lib/core/ui-methods.js')
const { trustThirdPartyUiPlugin } = await import('../lib/core/ui-bundles.js')

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` —— ${detail}`}`)
  }
}

/** 校验的拒人话里要带操作名，才看得出是哪条被拦了。 */
const rejects = (op, args) => {
  const result = validateNativeCall(op, args)
  return result.ok === false && result.error.includes(op)
}

console.log('── 规格的形状 ──')
check('版本号是正整数', Number.isInteger(NATIVE_BRIDGE_VERSION) && NATIVE_BRIDGE_VERSION > 0)
check('白名单非空', NATIVE_OPS.length > 0, `NATIVE_OPS=${String(NATIVE_OPS.length)}`)
check(
  '每个操作都有实参规格，且没有多余的规格',
  NATIVE_OPS.length === Object.keys(NATIVE_ARG_SPECS).length &&
    NATIVE_OPS.every((op) => Object.hasOwn(NATIVE_ARG_SPECS, op)),
)
check('每个操作名都进了查表集合', NATIVE_OPS.every((op) => NATIVE_OP_SET.has(op)))
check(
  '规格里的参数形状都是认得的',
  Object.values(NATIVE_ARG_SPECS).every((spec) =>
    spec.every((arg) =>
      ['string', 'stringOrNull', 'bool', 'hex', 'enum', 'notify', 'marketSources', 'rect', 'json'].includes(arg.shape.kind),
    ),
  ),
)
check('事件白名单非空且都能查表', NATIVE_EVENTS.length > 0 && NATIVE_EVENTS.every((name) => NATIVE_EVENT_SET.has(name)))

console.log('\n── 白名单里不许有的东西 ──')
/**
 * 名点要排除的：泛用执行口（能把一段字符串变成一次执行的）。
 * 装东西（installSkill / installPlugin / installMarketSkill / setMarketSources）与
 * 落信任（setUiTrust）**在桥里**——它们是供应链写入口，只对主窗口开放式；
 * 界面通道那边的排除在下一节钉住（浏览器与远程页够得着的那条面不能有它们）。
 *
 * 内嵌浏览器三件套（dockBrowser / browserNav / browser-state）2026-10 已搬进桥——
 * 正向断言在下面一节；`onBrowserState` 这种"具名回调式"的名字仍然不许出现，
 * 桥只有一个订阅口 `on(event, listener)`。
 */
const FORBIDDEN = ['invoke', 'runCommand', 'onBrowserState']
for (const name of FORBIDDEN) {
  check(`没有 ${name}`, !NATIVE_OP_SET.has(name))
}
/**
 * 白名单的每一项都必须是"既定动作 + 实参枚举"，所以操作名的**第一个词**只能是
 * 这批动作动词之一；冒出一个没见过的动词（`exec…` / `spawn…` / `write…`）当场红。
 * 0.6.68 新增 `usePermissionPreset`（应用一个打包权限预设）——`use` 同样是既定动作
 * （照 codex 的 `use` 口径），补进来；同批的 `setReviewer` / `setDefaultPermissionPreset`
 * 第一词是既有的 `set`，不用加。
 */
const ACTION_VERBS = ['set', 'use', 'save', 'choose', 'switch', 'recent', 'remove', 'open', 'install', 'session', 'notify', 'restart', 'quit', 'terminal', 'dock', 'browser']
const oddVerbs = NATIVE_OPS.filter(
  (op) => !ACTION_VERBS.some((verb) => op.toLowerCase().startsWith(verb)),
)
check('每个操作名都由既定动作动词开头', oddVerbs.length === 0, `可疑项：${oddVerbs.join('、')}`)

console.log('\n── 内嵌浏览器三件套（2026-10 搬进桥：旧渲染层直连的那两个 + 一个事件）──')
check('桥里有 dockBrowser（带实参规格）', NATIVE_OP_SET.has('dockBrowser') && Object.hasOwn(NATIVE_ARG_SPECS, 'dockBrowser'))
check('桥里有 browserNav（带实参规格）', NATIVE_OP_SET.has('browserNav') && Object.hasOwn(NATIVE_ARG_SPECS, 'browserNav'))
check('事件白名单里有 browser-state', NATIVE_EVENT_SET.has('browser-state'))
check('dockBrowser 正常一次通过', validateNativeCall('dockBrowser', [true, { x: 0, y: 0, width: 100, height: 100 }]).ok === true)
check('dockBrowser 可以只传 visible（隐藏路径）', validateNativeCall('dockBrowser', [false]).ok === true)
check('dockBrowser 的 visible 必须是布尔（字符串被拒）', rejects('dockBrowser', ['yes']))
check('dockBrowser 的 rect 四边都必须是数（少字段被拒）', rejects('dockBrowser', [true, { x: 0, y: 0, width: 10 }]))
check('browserNav 的动作是枚举（未知动作被拒）', rejects('browserNav', ['https://a.example', 'print']))
check('browserNav 正常一次通过', validateNativeCall('browserNav', ['https://a.example', 'load']).ok === true)

console.log('\n── 供应链写入口：桥有、界面通道没有 ──')
for (const name of ['installSkill', 'installPlugin', 'installMarketSkill', 'setMarketSources', 'setUiTrust']) {
  check(`桥里有 ${name}`, NATIVE_OP_SET.has(name) && Object.hasOwn(NATIVE_ARG_SPECS, name))
}
for (const name of ['installMarketSkill', 'setMarketSources', 'setUiTrust']) {
  check(`界面通道排除 ${name}`, UI_EXCLUDED.includes(name) && !UI_METHODS.includes(name))
}
check('界面通道放行 listUiTrust（信任卡要能看见状态）', UI_METHODS.includes('listUiTrust'))
check('listUiTrust 的实参规格是空表', Array.isArray(UI_ARG_SPECS.listUiTrust) && UI_ARG_SPECS.listUiTrust.length === 0)
check('marketSources 形状：一份合法源表能过', validateNativeCall('setMarketSources', [[{ name: 'anthropics', url: 'https://github.com/anthropics/skills' }]]).ok === true)
check('marketSources 形状：空表被拒', rejects('setMarketSources', [[]]))
check('marketSources 形状：不是数组被拒', rejects('setMarketSources', ['oops']))
check('marketSources 形状：缺 url 被拒', rejects('setMarketSources', [[{ name: 'a' }]]))
check('marketSources 形状：空名字被拒', rejects('setMarketSources', [[{ name: '', url: 'https://x' }]]))
check('marketSources 形状：超长 url 被拒', rejects('setMarketSources', [[{ name: 'a', url: `https://x/${'y'.repeat(3000)}` }]]))
check('installMarketSkill 收两个名字', validateNativeCall('installMarketSkill', ['anthropics', 'pdf']).ok === true)
check('installMarketSkill 少一个实参被拒', rejects('installMarketSkill', ['anthropics']))
check('setUiTrust 收目录名', validateNativeCall('setUiTrust', ['demo-plugin']).ok === true)
// 目录名的形状（空串 / 路径分隔符 / ..）由核层的落地函数钉死：预检在碰盘之前就拒。
check(
  'setUiTrust 的空串/带分隔符/.. 在落信任前被拒（路径穿越挡在拼路径之前）',
  trustThirdPartyUiPlugin('', undefined, new Set()).ok === false &&
    trustThirdPartyUiPlugin('a/b', undefined, new Set()).ok === false &&
    trustThirdPartyUiPlugin('..', undefined, new Set()).ok === false,
)
check('installSkill / installPlugin 不收实参', validateNativeCall('installSkill', []).ok === true && rejects('installPlugin', [1]))

console.log('\n── 模型端点三件套：桥有、界面通道没有（2026-10）──')
for (const name of ['saveProvider', 'removeProvider', 'setProviderKey']) {
  check(`桥里有 ${name}`, NATIVE_OP_SET.has(name) && Object.hasOwn(NATIVE_ARG_SPECS, name))
  check(`界面通道排除 ${name}`, UI_EXCLUDED.includes(name) && !UI_METHODS.includes(name))
}
check('界面通道仍放行 getModelConfig / setDefaultModel / discoverModels', ['getModelConfig', 'setDefaultModel', 'discoverModels'].every((m) => UI_METHODS.includes(m)))
check(
  'saveProvider 收一份可序列化的草稿',
  validateNativeCall('saveProvider', [{ oldName: null, name: 'x', displayName: '', baseUrl: 'https://x/v1', models: [] }]).ok === true,
)
check('saveProvider 草稿不可序列化（循环引用）被拒', (() => {
  const loop = {}
  loop.self = loop
  return rejects('saveProvider', [loop])
})())
check('saveProvider 草稿超过 64KB 被拒', rejects('saveProvider', [{ blob: 'x'.repeat(70_000) }]))
check('removeProvider 收一个名字', validateNativeCall('removeProvider', ['deepseek']).ok === true)
check('removeProvider 少传被拒', rejects('removeProvider', []))
check('setProviderKey 收 name + key', validateNativeCall('setProviderKey', ['deepseek', 'sk-abc']).ok === true)
check('setProviderKey 收 name + null（清除语义：null 是取值不是省略）', validateNativeCall('setProviderKey', ['deepseek', null]).ok === true)
check('setProviderKey 的 key 类型不对被拒', rejects('setProviderKey', ['deepseek', 7]))
check('setProviderKey 的 key 超长被拒', rejects('setProviderKey', ['deepseek', 'k'.repeat(5000)]))
check('setProviderKey 少了第二个实参被拒（清除要显式传 null）', rejects('setProviderKey', ['deepseek']))

console.log('\n── dock 三档：终端进不了 HTTP 面 ──')
check('dock 在界面放行面里', UI_METHODS.includes('dock'))
check('dock 不在排除清单里', !UI_EXCLUDED.includes('dock'))
check('dock 的牌子真有实参规格', Object.hasOwn(UI_ARG_SPECS, 'dock'))
const dockOpSpec = UI_ARG_SPECS['dock'][0].shape
const dockEnum = dockOpSpec.kind === 'enum' ? [...dockOpSpec.values] : []
check('放行的 op 就是 DOCK_UI_OPS', dockEnum.join('|') === DOCK_UI_OPS.join('|'), `实际：${dockEnum.join('、')}`)
check('放行的 op 里一个 term-* 都没有', dockEnum.every((op) => !op.startsWith('term-')))
check('DOCK_UI_OPS 与 DOCK_TERM_OPS 不相交', DOCK_UI_OPS.every((op) => !DOCK_TERM_OPS.includes(op)))
check('三档加起来正好是全部 op', DOCK_OPS.length === DOCK_UI_OPS.length + DOCK_TERM_OPS.length)
check(
  'HTTP 面里传 term-spawn 会被实参校验拒（不看宿主，先看这一层）',
  (() => {
    const result = validateUiArgs('dock', ['term-spawn', { cwd: '.' }])
    return result.ok === false && result.error.includes('必须是这几个值之一')
  })(),
)
check('HTTP 面里传读/写 op 能过校验', validateUiArgs('dock', ['fs-list', { dir: '.' }]).ok === true)
check('桥里有 terminal op（终端唯一的入口）', NATIVE_OP_SET.has('terminal'))
check('terminal 的 op 枚举就是 DOCK_TERM_OPS', (() => {
  const shape = NATIVE_ARG_SPECS.terminal[0].shape
  return shape.kind === 'enum' && shape.values.join('|') === DOCK_TERM_OPS.join('|')
})())

console.log('\n── 校验真的在拦 ──')
check('未知操作被拒', rejects('nope', []))
check('非字符串操作名被拒', rejects(7, []))
check('实参不是数组被拒', rejects('recentCwds', 'oops'))
check('多传实参被拒', rejects('recentCwds', [1]))
check('必传实参少了被拒', rejects('switchCwd', []))
check('实参类型不对被拒', rejects('switchCwd', [123]))
check('实参是 null 而该项必传时被拒', rejects('switchCwd', [null]))
check('字符串超长被拒', rejects('switchCwd', ['x'.repeat(5000)]))
check('枚举取值不认识时被拒', rejects('setThemeSource', ['blue']))
check('枚举取值对时通过', validateNativeCall('setThemeSource', ['light']).ok === true)
check('坏颜色被拒（不是 #rrggbb）', rejects('setWindowChrome', ['white', '#000000']))
check('坏颜色被拒（少于 6 位）', rejects('setWindowChrome', ['#fff', '#000000']))
check('两个合法颜色通过', validateNativeCall('setWindowChrome', ['#ffffff', '#101010']).ok === true)
check('notify 缺标题被拒', rejects('notify', [{}]))
check('notify 标题是空串被拒', rejects('notify', [{ title: '' }]))
check('notify 正文类型不对被拒', rejects('notify', [{ title: '好了', body: 7 }]))
check('notify 正常一对象通过', validateNativeCall('notify', [{ title: '好了', body: '干完了' }]).ok === true)
check('terminal 的 op 不认识时被拒', rejects('terminal', ['term-rm', {}]))
check('terminal 可以不传 payload', validateNativeCall('terminal', ['term-kill']).ok === true)
check('terminal 的 payload 太大被拒', rejects('terminal', ['term-input', { data: 'x'.repeat(9000) }]))
check('terminal 正常一次通过', validateNativeCall('terminal', ['term-spawn', { cwd: '.', shell: 'pwsh' }]).ok === true)

console.log('\n── 规格与桌面两侧的接线 ──')
const mainSource = readFileSync(join(root, 'desktop', 'electron', 'main', 'index.ts'), 'utf8')
const preloadSource = readFileSync(join(root, 'desktop', 'electron', 'preload', 'index.ts'), 'utf8')
check('主进程注册了 dsc:native 通道', mainSource.includes("ipcMain.handle('dsc:native'"))
check('主进程先校验再分派', mainSource.includes('validateNativeCall('))
check('主进程只收主窗口的调用', mainSource.includes("event.sender !== mainWindow?.webContents"))
check('preload 挂了 window.dscNative', preloadSource.includes("exposeInMainWorld('dscNative'"))
check('preload 的桥的调用口是 call(op, args)', /call\(op: string, args: unknown\[\] = \[\]\)/.test(preloadSource))
check('preload 的订阅口按事件白名单拒生名字', preloadSource.includes('NATIVE_EVENT_SET.has(event)'))
const missing = NATIVE_OPS.filter((op) => !new RegExp(`\\b${op}:`).test(mainSource))
check('每个操作都在主进程的分派表里出现过', missing.length === 0, `缺：${missing.join('、')}`)

console.log(
  failures === 0 ? `\n${String(passed)} 条断言全部通过` : `\n${String(failures)}/${String(passed + failures)} 条断言失败`,
)
process.exit(failures === 0 ? 0 : 1)
