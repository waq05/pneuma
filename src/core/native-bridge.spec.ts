/**
 * 原生桥的规格：白名单、实参校验、与界面通道的分界（迁自
 * `scripts/ui-native-bridge-test.mjs` 的导出面行为段，方案 A「断言导出对象」）。
 *
 * 原生桥是**页面能触到 Electron 主进程**的唯一一条路，它的价值不在那条路能做什么
 * （全是既定的窄动作），而在**别的东西进不来**。这里压三件事：
 *   ① 规格形状：版本、白名单、实参规格与操作一一对应、参数形状都是认得的；
 *   ② 白名单分界：泛用执行口一个不许有（invoke / runCommand / onBrowserState），
 *      供应链与端点写入口桥有、界面通道没有，dock 三档里终端进不了 HTTP 面；
 *   ③ 校验真的在拦：未知操作、非数组实参、多传、少传、类型、长度、坏枚举、坏
 *      `#rrggbb`、notify/rect/marketSources/json 的形状，逐条都有拒的门。
 *
 * 没迁的（原探针「规格与桌面两侧的接线」与「壳与原生两侧按 id 走」两段，见交付报告
 * 缺口清单）：`desktop/electron/main|preload`、`dock.ts`、sessions/browser 的壳侧接线
 * ——desktop/** 与渲染层不在 vitest 解析面，无运行期接缝。`openWorkspace` 的实参规格
 * 行为已随「校验真的在拦」一并迁入。
 *
 * 为什么归 unit：`native-bridge.ts` / `dock-ops.ts` / `ui-methods.ts` / `ui-bundles.ts`
 * 全是纯校验与文件判定，不装配内核；`trustThirdPartyUiPlugin` 的目录名预检在拼路径
 * 之前就拒，不碰盘。
 *
 * @module dsc/core/native-bridge.spec
 */
import { describe, expect, test } from 'vitest'
import { DOCK_OPS, DOCK_TERM_OPS, DOCK_UI_OPS } from './dock-ops.js'
import {
  NATIVE_ARG_SPECS,
  NATIVE_BRIDGE_VERSION,
  NATIVE_EVENTS,
  NATIVE_EVENT_SET,
  NATIVE_OPS,
  NATIVE_OP_SET,
  validateNativeCall,
} from './native-bridge.js'
import { trustThirdPartyUiPlugin } from './ui-bundles.js'
import { UI_ARG_SPECS, UI_EXCLUDED, UI_METHODS, validateUiArgs } from './ui-methods.js'

/** 校验的拒人话里要带操作名，才看得出是哪条被拦了。 */
const rejects = (op: unknown, args: unknown): boolean => {
  const result = validateNativeCall(op, args)
  return result.ok === false && result.error.includes(String(op))
}

/**
 * 白名单的宽松视图：下面的断言按名字动态点名（含「不该存在」的名字），字面量联合类型
 * 反而接不住——这里的类型事实由 139 行的「操作 ↔ 规格一一对应」断言承担。
 */
const nativeSpecs = NATIVE_ARG_SPECS as Readonly<Record<string, readonly unknown[]>>
const uiMethods: readonly string[] = UI_METHODS
const uiExcluded: readonly string[] = UI_EXCLUDED

describe('规格的形状', () => {
  test('版本号是正整数（壳拿它跟自己对版本）', () => {
    expect(Number.isInteger(NATIVE_BRIDGE_VERSION)).toBe(true)
    expect(NATIVE_BRIDGE_VERSION).toBeGreaterThan(0)
  })

  test('白名单非空，每个操作都有实参规格且没有多余的规格', () => {
    expect(NATIVE_OPS.length).toBeGreaterThan(0)
    expect(Object.keys(nativeSpecs)).toHaveLength(NATIVE_OPS.length)
    for (const op of NATIVE_OPS) expect(Object.hasOwn(nativeSpecs, op)).toBe(true)
  })

  test('每个操作名都进了查表集合', () => {
    for (const op of NATIVE_OPS) expect(NATIVE_OP_SET.has(op)).toBe(true)
  })

  test('规格里的参数形状都是认得的（冒出新形状 = 校验器接不住）', () => {
    const kinds = ['string', 'stringOrNull', 'bool', 'hex', 'enum', 'notify', 'marketSources', 'rect', 'json']
    const odd = Object.values(NATIVE_ARG_SPECS).flatMap((spec) =>
      spec.filter((arg) => !kinds.includes(arg.shape.kind)).map((arg) => arg.shape.kind),
    )
    expect(odd).toEqual([])
  })

  test('事件白名单非空且都能查表', () => {
    expect(NATIVE_EVENTS.length).toBeGreaterThan(0)
    for (const name of NATIVE_EVENTS) expect(NATIVE_EVENT_SET.has(name)).toBe(true)
  })
})

describe('白名单里不许有的东西', () => {
  /**
   * 名点要排除的：泛用执行口（能把一段字符串变成一次执行的）与"具名回调式"的名字
   * （桥只有一个订阅口 on(event, listener)）。
   */
  const FORBIDDEN = ['invoke', 'runCommand', 'onBrowserState']

  test.each(FORBIDDEN)('没有 %s', (name) => {
    expect(NATIVE_OP_SET.has(name)).toBe(false)
  })

  test('每个操作名都由既定动作动词开头（冒出 exec/spawn/write 就当场红）', () => {
    const ACTION_VERBS = ['set', 'use', 'save', 'choose', 'pick', 'remember', 'switch', 'recent', 'remove', 'open', 'install', 'session', 'notify', 'restart', 'quit', 'terminal', 'dock', 'browser', 'check']
    const odd = NATIVE_OPS.filter((op) => !ACTION_VERBS.some((verb) => op.toLowerCase().startsWith(verb)))
    expect(odd).toEqual([])
  })
})

describe('内嵌浏览器五件套（页签可多开，一台视图一个 id）', () => {
  test('桥里有 dockBrowser / browserNav / browserClose（都带实参规格）', () => {
    for (const op of ['dockBrowser', 'browserNav', 'browserClose']) {
      expect(NATIVE_OP_SET.has(op)).toBe(true)
      expect(Object.hasOwn(nativeSpecs, op)).toBe(true)
    }
  })

  test('事件白名单里有 browser-state 与 browser-open-requested', () => {
    expect(NATIVE_EVENT_SET.has('browser-state')).toBe(true)
    expect(NATIVE_EVENT_SET.has('browser-open-requested')).toBe(true)
  })

  test('dockBrowser 正常一次通过；隐藏某一台（给 id、不带 rect）也通过', () => {
    expect(validateNativeCall('dockBrowser', ['t1', true, { x: 0, y: 0, width: 100, height: 100 }]).ok).toBe(true)
    expect(validateNativeCall('dockBrowser', ['t1', false]).ok).toBe(true)
  })

  test('dockBrowser 的 id 必传（旧 [visible, rect] 形状被拒）、visible 必须是布尔', () => {
    expect(rejects('dockBrowser', [true, { x: 0, y: 0, width: 10, height: 10 }])).toBe(true)
    expect(rejects('dockBrowser', ['t1', 'yes'])).toBe(true)
  })

  test('dockBrowser 的 rect 少边被拒、id 超长被拒、多传实参被拒', () => {
    expect(rejects('dockBrowser', ['t1', true, { x: 0, y: 0, width: 10 }])).toBe(true)
    expect(rejects('dockBrowser', ['x'.repeat(300), false])).toBe(true)
    expect(rejects('dockBrowser', ['t1', false, null, 'x'])).toBe(true)
  })

  test('browserNav：动作是枚举、带 id 与不带 id 都通过、id 类型不对被拒', () => {
    expect(rejects('browserNav', ['https://a.example', 'print'])).toBe(true)
    expect(validateNativeCall('browserNav', ['https://a.example', 'load', 't1']).ok).toBe(true)
    expect(validateNativeCall('browserNav', ['https://a.example', 'load']).ok).toBe(true)
    expect(rejects('browserNav', ['https://a.example', 'load', 7])).toBe(true)
  })

  test('browserClose 要一个字符串 id', () => {
    expect(validateNativeCall('browserClose', ['t1']).ok).toBe(true)
    expect(rejects('browserClose', [])).toBe(true)
    expect(rejects('browserClose', [7])).toBe(true)
  })
})

describe('检查更新两件套（检查与安装都归主进程）', () => {
  test('桥里有 checkUpdate / installUpdate（都不收实参）', () => {
    for (const op of ['checkUpdate', 'installUpdate']) {
      expect(NATIVE_OP_SET.has(op)).toBe(true)
      expect(nativeSpecs[op]).toHaveLength(0)
    }
  })

  test('两个都不接受任何实参（地址由主进程定，页面递不进 URL）', () => {
    expect(validateNativeCall('checkUpdate', []).ok).toBe(true)
    expect(rejects('checkUpdate', ['https://evil.test/x.exe'])).toBe(true)
    expect(validateNativeCall('installUpdate', []).ok).toBe(true)
    expect(rejects('installUpdate', ['https://evil.test/x.exe'])).toBe(true)
  })

  test('事件白名单里有 update-status 与 update-progress', () => {
    expect(NATIVE_EVENT_SET.has('update-status')).toBe(true)
    expect(NATIVE_EVENT_SET.has('update-progress')).toBe(true)
  })
})

describe('供应链写入口：桥有、界面通道没有', () => {
  test('桥里有 installSkill / installPlugin / installMarketSkill / setMarketSources / setUiTrust', () => {
    for (const op of ['installSkill', 'installPlugin', 'installMarketSkill', 'setMarketSources', 'setUiTrust']) {
      expect(NATIVE_OP_SET.has(op)).toBe(true)
      expect(Object.hasOwn(nativeSpecs, op)).toBe(true)
    }
  })

  test('浏览器与远程页够得着的那条面（界面通道）排除三个市场/信任写入口', () => {
    for (const name of ['installMarketSkill', 'setMarketSources', 'setUiTrust']) {
      expect(uiExcluded.includes(name)).toBe(true)
      expect(uiMethods.includes(name)).toBe(false)
    }
  })

  test('界面通道放行 listUiTrust（信任卡要能看见状态），实参规格是空表', () => {
    expect(uiMethods.includes('listUiTrust')).toBe(true)
    expect(Array.isArray(UI_ARG_SPECS.listUiTrust)).toBe(true)
    expect(UI_ARG_SPECS.listUiTrust).toHaveLength(0)
  })

  test('marketSources：合法源表过、空表 / 非数组 / 缺 url / 空名字 / 超长 url 都拒', () => {
    expect(validateNativeCall('setMarketSources', [[{ name: 'anthropics', url: 'https://github.com/anthropics/skills' }]]).ok).toBe(true)
    expect(rejects('setMarketSources', [[]])).toBe(true)
    expect(rejects('setMarketSources', ['oops'])).toBe(true)
    expect(rejects('setMarketSources', [[{ name: 'a' }]])).toBe(true)
    expect(rejects('setMarketSources', [[{ name: '', url: 'https://x' }]])).toBe(true)
    expect(rejects('setMarketSources', [[{ name: 'a', url: `https://x/${'y'.repeat(3000)}` }]])).toBe(true)
  })

  test('installMarketSkill 收两个名字，少一个被拒；installSkill / installPlugin 不收实参', () => {
    expect(validateNativeCall('installMarketSkill', ['anthropics', 'pdf']).ok).toBe(true)
    expect(rejects('installMarketSkill', ['anthropics'])).toBe(true)
    expect(validateNativeCall('installSkill', []).ok).toBe(true)
    expect(rejects('installPlugin', [1])).toBe(true)
  })

  test('setUiTrust 收目录名；空串 / 带分隔符 / .. 在落信任（碰盘）之前被拒', () => {
    expect(validateNativeCall('setUiTrust', ['demo-plugin']).ok).toBe(true)
    expect(trustThirdPartyUiPlugin('', undefined, new Set()).ok).toBe(false)
    expect(trustThirdPartyUiPlugin('a/b', undefined, new Set()).ok).toBe(false)
    expect(trustThirdPartyUiPlugin('..', undefined, new Set()).ok).toBe(false)
  })
})

describe('模型端点三件套：桥有、界面通道没有', () => {
  test('桥里有 saveProvider / removeProvider / setProviderKey，界面通道全排除', () => {
    for (const op of ['saveProvider', 'removeProvider', 'setProviderKey']) {
      expect(NATIVE_OP_SET.has(op)).toBe(true)
      expect(Object.hasOwn(nativeSpecs, op)).toBe(true)
      expect(uiExcluded.includes(op)).toBe(true)
      expect(uiMethods.includes(op)).toBe(false)
    }
  })

  test('界面通道仍放行 getModelConfig / setDefaultModel / discoverModels', () => {
    for (const method of ['getModelConfig', 'setDefaultModel', 'discoverModels']) {
      expect(uiMethods.includes(method)).toBe(true)
    }
  })

  test('saveProvider：可序列化草稿过；循环引用与超 64KB 拒', () => {
    expect(validateNativeCall('saveProvider', [{ oldName: null, name: 'x', displayName: '', baseUrl: 'https://x/v1', models: [] }]).ok).toBe(true)
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(rejects('saveProvider', [loop])).toBe(true)
    expect(rejects('saveProvider', [{ blob: 'x'.repeat(70_000) }])).toBe(true)
  })

  test('removeProvider 收一个名字；setProviderKey 的 null 是「清除」不是省略', () => {
    expect(validateNativeCall('removeProvider', ['deepseek']).ok).toBe(true)
    expect(rejects('removeProvider', [])).toBe(true)
    expect(validateNativeCall('setProviderKey', ['deepseek', 'sk-abc']).ok).toBe(true)
    expect(validateNativeCall('setProviderKey', ['deepseek', null]).ok).toBe(true)
    expect(rejects('setProviderKey', ['deepseek', 7])).toBe(true)
    expect(rejects('setProviderKey', ['deepseek', 'k'.repeat(5000)])).toBe(true)
    // 少了第二个实参被拒：清除语义必须显式传 null。
    expect(rejects('setProviderKey', ['deepseek'])).toBe(true)
  })
})

describe('dock 三档：终端进不了 HTTP 面', () => {
  test('dock 在界面放行面里（不在排除清单），且带实参规格', () => {
    expect(uiMethods.includes('dock')).toBe(true)
    expect(uiExcluded.includes('dock')).toBe(false)
    expect(Object.hasOwn(UI_ARG_SPECS, 'dock')).toBe(true)
  })

  test('界面通道放行的 op 就是 DOCK_UI_OPS，一个 term-* 都没有', () => {
    const shape = UI_ARG_SPECS.dock[0]?.shape
    const dockEnum = shape !== undefined && shape.kind === 'enum' ? [...shape.values] : []
    expect(dockEnum).toEqual([...DOCK_UI_OPS])
    expect(dockEnum.every((op) => !op.startsWith('term-'))).toBe(true)
  })

  test('DOCK_UI_OPS 与 DOCK_TERM_OPS 不相交；三档加起来正好是全部 op', () => {
    expect(DOCK_UI_OPS.every((op) => !(DOCK_TERM_OPS as readonly string[]).includes(op))).toBe(true)
    expect(DOCK_OPS).toHaveLength(DOCK_UI_OPS.length + DOCK_TERM_OPS.length)
  })

  test('HTTP 面里传 term-spawn 被实参校验拒（不看宿主，这一层先拦）；传读 op 能过', () => {
    const denied = validateUiArgs('dock', ['term-spawn', { cwd: '.' }])
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error).toContain('必须是这几个值之一')
    expect(validateUiArgs('dock', ['fs-list', { dir: '.' }]).ok).toBe(true)
  })

  test('桥里有 terminal op，它的枚举就是 DOCK_TERM_OPS', () => {
    expect(NATIVE_OP_SET.has('terminal')).toBe(true)
    const shape = NATIVE_ARG_SPECS.terminal[0]?.shape
    expect(shape !== undefined && shape.kind === 'enum' && shape.values.join('|')).toBe(DOCK_TERM_OPS.join('|'))
  })
})

describe('校验真的在拦（逐条都有拒的门）', () => {
  test('未知操作与非字符串操作名被拒', () => {
    expect(rejects('nope', [])).toBe(true)
    expect(rejects(7, [])).toBe(true)
  })

  test('非数组实参、多传、少传、类型不对、null 必传位都被拒', () => {
    expect(rejects('recentCwds', 'oops')).toBe(true)
    expect(rejects('recentCwds', [1])).toBe(true)
    expect(rejects('switchCwd', [])).toBe(true)
    expect(rejects('switchCwd', [123])).toBe(true)
    expect(rejects('switchCwd', [null])).toBe(true)
  })

  test('字符串超长被拒；枚举不认识被拒、认识通过', () => {
    expect(rejects('switchCwd', ['x'.repeat(5000)])).toBe(true)
    expect(rejects('setThemeSource', ['blue'])).toBe(true)
    expect(validateNativeCall('setThemeSource', ['light']).ok).toBe(true)
  })

  test('坏颜色被拒（非 #rrggbb、少于 6 位）；两个合法颜色通过', () => {
    expect(rejects('setWindowChrome', ['white', '#000000'])).toBe(true)
    expect(rejects('setWindowChrome', ['#fff', '#000000'])).toBe(true)
    expect(validateNativeCall('setWindowChrome', ['#ffffff', '#101010']).ok).toBe(true)
  })

  test('notify：缺标题、空标题、正文类型不对都拒；正常对象通过', () => {
    expect(rejects('notify', [{}])).toBe(true)
    expect(rejects('notify', [{ title: '' }])).toBe(true)
    expect(rejects('notify', [{ title: '好了', body: 7 }])).toBe(true)
    expect(validateNativeCall('notify', [{ title: '好了', body: '干完了' }]).ok).toBe(true)
  })

  test('terminal：未知 op 拒、payload 太大拒、可省 payload、正常通过', () => {
    expect(rejects('terminal', ['term-rm', {}])).toBe(true)
    expect(rejects('terminal', ['term-input', { data: 'x'.repeat(9000) }])).toBe(true)
    expect(validateNativeCall('terminal', ['term-kill']).ok).toBe(true)
    expect(validateNativeCall('terminal', ['term-spawn', { cwd: '.', shell: 'pwsh' }]).ok).toBe(true)
  })
})

describe('openWorkspace：带着目录走（实参规格层）', () => {
  test('第二个实参是可选的路径（缺省回落 hostCwd）', () => {
    const spec = NATIVE_ARG_SPECS.openWorkspace
    expect(spec).toHaveLength(2)
    expect(spec[1]?.optional).toBe(true)
    expect(spec[1]?.shape.kind).toBe('string')
  })

  test('三个档 + 目录都能过；只传 kind 照旧通过；未知档 / 目录类型不对 / 超长 / 多传都拒', () => {
    for (const kind of ['terminal', 'explorer', 'vscode']) {
      expect(validateNativeCall('openWorkspace', [kind, 'D:\\dsc']).ok).toBe(true)
    }
    expect(validateNativeCall('openWorkspace', ['explorer']).ok).toBe(true)
    expect(rejects('openWorkspace', ['nope', 'D:\\dsc'])).toBe(true)
    expect(rejects('openWorkspace', ['explorer', 7])).toBe(true)
    expect(rejects('openWorkspace', ['explorer', `D:\\${'x'.repeat(5000)}`])).toBe(true)
    expect(rejects('openWorkspace', ['explorer', 'D:\\dsc', 'x'])).toBe(true)
  })
})
