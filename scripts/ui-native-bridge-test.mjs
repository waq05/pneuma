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
  NATIVE_ARG_SPECS,
  validateNativeCall,
} = await import('../lib/core/native-bridge.js')

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
    spec.every((arg) => ['string', 'hex', 'enum', 'notify'].includes(arg.shape.kind)),
  ),
)

console.log('\n── 白名单里不许有的东西 ──')
/** 名点要排除的：供应链写入口、内嵌浏览器（阶段 5.2 再进）、以及任何泛用执行口。 */
const FORBIDDEN = ['invoke', 'runCommand', 'installPlugin', 'installSkill', 'dockBrowser', 'browserNav', 'onBrowserState']
for (const name of FORBIDDEN) {
  check(`没有 ${name}`, !NATIVE_OP_SET.has(name))
}
/**
 * 白名单的每一项都必须是"既定动作 + 实参枚举"，所以操作名的**第一个词**只能是
 * 这批动作动词之一；冒出一个没见过的动词（`exec…` / `spawn…` / `write…`）当场红。
 */
const ACTION_VERBS = ['set', 'choose', 'switch', 'recent', 'remove', 'open', 'session', 'notify', 'restart', 'quit']
const oddVerbs = NATIVE_OPS.filter(
  (op) => !ACTION_VERBS.some((verb) => op.toLowerCase().startsWith(verb)),
)
check('每个操作名都由既定动作动词开头', oddVerbs.length === 0, `可疑项：${oddVerbs.join('、')}`)

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

console.log('\n── 规格与桌面两侧的接线 ──')
const mainSource = readFileSync(join(root, 'desktop', 'electron', 'main', 'index.ts'), 'utf8')
const preloadSource = readFileSync(join(root, 'desktop', 'electron', 'preload', 'index.ts'), 'utf8')
check('主进程注册了 dsc:native 通道', mainSource.includes("ipcMain.handle('dsc:native'"))
check('主进程先校验再分派', mainSource.includes('validateNativeCall('))
check('主进程只收主窗口的调用', mainSource.includes("event.sender !== mainWindow?.webContents"))
check('preload 挂了 window.dscNative', preloadSource.includes("exposeInMainWorld('dscNative'"))
check('preload 的桥只有一个 call 入口', /call\(op: string, args: unknown\[\] = \[\]\)/.test(preloadSource))
const missing = NATIVE_OPS.filter((op) => !new RegExp(`\\b${op}:`).test(mainSource))
check('每个操作都在主进程的分派表里出现过', missing.length === 0, `缺：${missing.join('、')}`)

console.log(
  failures === 0 ? `\n${String(passed)} 条断言全部通过` : `\n${String(failures)}/${String(passed + failures)} 条断言失败`,
)
process.exit(failures === 0 ? 0 : 1)
