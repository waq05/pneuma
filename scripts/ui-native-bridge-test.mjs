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
 * 内嵌浏览器那一套（dockBrowser / browserNav / browserClose + browser-state /
 * browser-open-requested）2026-10 已搬进桥，同月改可多开（一台视图一个 id）——
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
 * 同日「添加工作区」那批新增 `pickDirectory`（弹系统框挑一个目录，不切工作目录）与
 * `rememberCwd`（记一笔最近用过的工作区）——`pick` / `remember` 都是既定动作
 * （一个弹框取路径、一个写一行记忆），补进来。**注意：加 op 忘了补这里会红**，
 * 探针拦的正是"冒出一个没见过的动词"。
 */
const ACTION_VERBS = ['set', 'use', 'save', 'choose', 'pick', 'remember', 'switch', 'recent', 'remove', 'open', 'install', 'session', 'notify', 'restart', 'quit', 'terminal', 'dock', 'browser']
const oddVerbs = NATIVE_OPS.filter(
  (op) => !ACTION_VERBS.some((verb) => op.toLowerCase().startsWith(verb)),
)
check('每个操作名都由既定动作动词开头', oddVerbs.length === 0, `可疑项：${oddVerbs.join('、')}`)

console.log('\n── 内嵌浏览器五件套（2026-10：页签可多开，一台视图一个 id）──')
check('桥里有 dockBrowser（带实参规格）', NATIVE_OP_SET.has('dockBrowser') && Object.hasOwn(NATIVE_ARG_SPECS, 'dockBrowser'))
check('桥里有 browserNav（带实参规格）', NATIVE_OP_SET.has('browserNav') && Object.hasOwn(NATIVE_ARG_SPECS, 'browserNav'))
check('桥里有 browserClose（关页签要能真的销毁那一台）', NATIVE_OP_SET.has('browserClose') && Object.hasOwn(NATIVE_ARG_SPECS, 'browserClose'))
check('事件白名单里有 browser-state', NATIVE_EVENT_SET.has('browser-state'))
check('事件白名单里有 browser-open-requested（网页开新窗口转新页签）', NATIVE_EVENT_SET.has('browser-open-requested'))
check('dockBrowser 正常一次通过', validateNativeCall('dockBrowser', ['t1', true, { x: 0, y: 0, width: 100, height: 100 }]).ok === true)
check('dockBrowser 隐藏某一台（给了 id、不带 rect）通过', validateNativeCall('dockBrowser', ['t1', false]).ok === true)
check('dockBrowser 的 id 必传（旧的 [visible, rect] 形状被拒）', rejects('dockBrowser', [true, { x: 0, y: 0, width: 10, height: 10 }]))
check('dockBrowser 的 visible 必须是布尔（字符串被拒）', rejects('dockBrowser', ['t1', 'yes']))
check('dockBrowser 的 rect 四边都必须是数（少字段被拒）', rejects('dockBrowser', ['t1', true, { x: 0, y: 0, width: 10 }]))
check('dockBrowser 的 id 超长被拒', rejects('dockBrowser', ['x'.repeat(300), false]))
check('dockBrowser 多传实参被拒（省略只能从尾部开始）', rejects('dockBrowser', ['t1', false, null, 'x']))
check('browserNav 的动作是枚举（未知动作被拒）', rejects('browserNav', ['https://a.example', 'print']))
check('browserNav 正常一次通过（带 id）', validateNativeCall('browserNav', ['https://a.example', 'load', 't1']).ok === true)
check('browserNav 不带 id 也通过（缺省那一台）', validateNativeCall('browserNav', ['https://a.example', 'load']).ok === true)
check('browserNav 的 id 类型不对被拒', rejects('browserNav', ['https://a.example', 'load', 7]))
check('browserClose 要一个 id', validateNativeCall('browserClose', ['t1']).ok === true && rejects('browserClose', []) && rejects('browserClose', [7]))

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

console.log('\n── 打开工作区带着目录走（2026-10-14 用户报障：打开的不是当前工作区）──')
const shellSessions = readFileSync(join(root, 'ui-shell', 'src', 'plugins', 'sessions', 'ui.tsx'), 'utf8')
check(
  'openWorkspace 的第二个实参是可选的路径（要打开哪个目录）',
  NATIVE_ARG_SPECS.openWorkspace.length === 2 &&
    NATIVE_ARG_SPECS.openWorkspace[1].optional === true &&
    NATIVE_ARG_SPECS.openWorkspace[1].shape.kind === 'string',
)
check('三个档 + 目录都能过', ['terminal', 'explorer', 'vscode'].every((kind) => validateNativeCall('openWorkspace', [kind, 'D:\\dsc']).ok === true))
check('只传 kind 照旧通过（旧渲染层不传目录，行为不变）', validateNativeCall('openWorkspace', ['explorer']).ok === true)
check('未知的档被拒', rejects('openWorkspace', ['nope', 'D:\\dsc']))
check('目录类型不对被拒', rejects('openWorkspace', ['explorer', 7]))
check('目录超长被拒', rejects('openWorkspace', ['explorer', `D:\\${'x'.repeat(5000)}`]))
check('多传第三个实参被拒', rejects('openWorkspace', ['explorer', 'D:\\dsc', 'x']))
check('壳把当前工作区（会话 cwd）传下去', shellSessions.includes("('openWorkspace', [kind, cwd])"))
check(
  '主进程按实参取目录、缺省才回落 hostCwd',
  /const dir = requested === undefined \|\| requested === '' \? hostCwd : requested/.test(mainSource),
)
check(
  '主进程分派把第二个实参透传',
  mainSource.includes('openWorkspace: ([kind, dir]) => openWorkspace(String(kind), typeof dir === \'string\' ? dir : undefined)'),
)

console.log('\n── 浏览器可多开：壳与原生两侧都按 id 走（2026-10 对齐 dsh 的浏览器侧边栏）──')
const shellBrowser = readFileSync(join(root, 'ui-shell', 'src', 'plugins', 'browser', 'ui.tsx'), 'utf8')
const nativeDock = readFileSync(join(root, 'desktop', 'electron', 'main', 'dock.ts'), 'utf8')
check('壳拿页签 id 当视图 id', shellBrowser.includes('const viewId = tab.id'))
check('壳藏起来时只摘下来（不带 rect 的那条）', shellBrowser.includes("('dockBrowser', [viewId, false])"))
check('壳卸载页签时销毁那一台', shellBrowser.includes("('browserClose', [viewId])"))
check('壳把网页开的窗口转成新页签', shellBrowser.includes('openDockBrowserTab(url)'))
check('壳订阅了 browser-open-requested', shellBrowser.includes("native.on('browser-open-requested'"))
check('原生层是一台视图一个 id（Map，不是单例变量）', nativeDock.includes('const guests = new Map<string, BrowserGuest>()'))
check('原生层开了 sandbox', nativeDock.includes('sandbox: true'))
check('原生层拦页面自己发起的非 http(s) 跳转', nativeDock.includes("contents.on('will-navigate'") && nativeDock.includes("contents.on('will-redirect'"))
check('原生层把网页弹窗 deny 成事件（不顶掉当前页）', nativeDock.includes('return { action: \'deny\' }'))
check('原生层关一台会真的销毁渲染进程', nativeDock.includes('view.webContents.close()'))
check('关窗时把全部视图收掉', mainSource.includes('disposeDockBrowsers()'))
// 工作区是 CRLF：跨行的文本钉必须容忍 \r\n（这仓里踩过一次，写记在这里）
check('主进程分派按 id 传话', /setDockBrowser\(\r?\n\s+String\(id\),/.test(mainSource))
check('主进程实现了 browserClose', /browserClose: \(\[id\]\)/.test(mainSource))
check('旧渲染层那条直连 IPC 原样保留（缺省 id 回落 main）', nativeDock.includes("'dsc:dock-browser'") && nativeDock.includes('DEFAULT_BROWSER_ID'))
check('旧渲染层的首页仍由主进程带进去（它自己不发起首次导航）', nativeDock.includes('LEGACY_HOME'))

console.log(
  failures === 0 ? `\n${String(passed)} 条断言全部通过` : `\n${String(failures)}/${String(passed + failures)} 条断言失败`,
)
process.exit(failures === 0 ? 0 : 1)
