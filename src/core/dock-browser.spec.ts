/**
 * dock 浏览器契约与「按视图路由的会话」（迁自 `scripts/dock-browser-test.mjs` 的第 2、4、8 节）。
 *
 * ## 为什么契约要单开一条
 *
 * 这条链两侧跑在两个进程、两套编译产物里：宿主（`src/**` → `lib/`）与桌面壳主进程
 * （`desktop/electron/**` → `out/`）。线上跑的是**消息**而不是函数调用——白名单、
 * 动作枚举、超时预算放在 `src/core/dock-browser.ts` 一处，两侧 import 同一份。
 * 这份模块一旦漂了，症状不是编译错，而是桌面侧静默拒掉一整类命令。
 *
 * 钉住三件事：
 *
 *   ① 命令白名单：动作/快照真正用到的命令都在、危险域一条都不在、判定真的查表；
 *   ② 导航复检入口 `dockNavigateTarget`：只认 `Page.navigate`，拿不到字符串地址一律 null；
 *   ③ 会话路由：`createDockSession` 的 sessionId 就是视图 id，命令原样透传、事件按
 *      「视图 + 方法」双重过滤，退订真的从 source 摘掉。
 *
 * ## 本文件不做什么
 *
 * 原探针第 1、3、7、8、9 节里有一批**扫源码文本**的断言（五道闸门顺序、`ui.tsx` 的
 * 事件名与锚点、`native-bridge.ts` 里有没有字面量、壳侧的 settle 帧数）。那验的是写法
 * 不是行为，按本批规矩不搬，缺口已写进交付报告的删除清单。
 *
 * @module dsc/core/dock-browser.spec
 */
import { describe, expect, test } from 'vitest'
import {
  DOCK_ACTIONS,
  DOCK_CALL_TIMEOUT_MS,
  DOCK_CDP_COMMANDS,
  DOCK_CDP_EVENTS,
  DOCK_LOOK_ACTIONS,
  DOCK_OPEN_TIMEOUT_MS,
  HOST_PROTOCOL_VERSION,
  isAgentView,
  isAllowedDockCommand,
  dockNavigateTarget,
  shouldForwardDockEvent,
} from './dock-browser.js'
import { createDockSession, type DockSessionSource } from './dock-session.js'
import { NATIVE_BRIDGE_VERSION, NATIVE_EVENT_SET, NATIVE_EVENTS } from './native-bridge.js'
import { DOCK_TAB_CLOSE_EVENT, DOCK_TAB_OPEN_EVENT, type DockBrowserEventPush } from './dock-browser.js'

describe('① 命令白名单：必需项在场、危险项缺席', () => {
  test('动作/快照那套真正用到的命令都在白名单里', () => {
    const missing = [
      'Page.enable',
      'Page.navigate',
      'Page.captureScreenshot',
      'DOM.getBoxModel',
      'Accessibility.getFullAXTree',
      'Runtime.evaluate',
      'Input.dispatchMouseEvent',
    ].filter((method) => !isAllowedDockCommand(method))
    // 缺哪条，snapshot / click / screenshot 就在那一步被桌面侧当场拒。
    expect(missing).toStrictEqual([])
  })

  test('危险命令一条都不在白名单里（越出这一页 / 读凭据 / 传文件）', () => {
    const present = [
      'Runtime.compileScript',
      'Target.createTarget',
      'Browser.close',
      'Storage.getCookies',
      'DOM.setFileInputFiles',
    ].filter((method) => isAllowedDockCommand(method))
    expect(present).toStrictEqual([])
  })

  test('没有整个域被放开（Target./Browser./Storage./Cookie）', () => {
    const bleed = DOCK_CDP_COMMANDS.filter(
      (method) => ['Target.', 'Browser.', 'Storage.'].some((prefix) => method.startsWith(prefix)) || /Cookie/i.test(method),
    )
    expect(bleed).toStrictEqual([])
  })

  test('白名单判定真的查表（表内真、表外假）', () => {
    expect(isAllowedDockCommand('Page.navigate')).toBe(true)
    expect(isAllowedDockCommand('Runtime.compileScript')).toBe(false)
  })

  test('命令白名单与事件白名单不相交', () => {
    expect(DOCK_CDP_COMMANDS.filter((method) => DOCK_CDP_EVENTS.includes(method))).toStrictEqual([])
  })

  test('事件白名单自洽（表内事件都判真，命令名判假）', () => {
    expect(DOCK_CDP_EVENTS.filter((method) => !shouldForwardDockEvent(method))).toStrictEqual([])
    expect(shouldForwardDockEvent('Page.enable')).toBe(false)
  })
})

describe('② 导航复检入口 dockNavigateTarget', () => {
  test('只对 Page.navigate 认地址', () => {
    expect(dockNavigateTarget('Page.navigate', { url: 'https://example.com/' })).toBe('https://example.com/')
    expect(dockNavigateTarget('Page.reload', { url: 'https://example.com/' })).toBeNull()
  })

  test('缺 url / 非字符串 url 一律 null（fail-closed）', () => {
    expect(dockNavigateTarget('Page.navigate', undefined)).toBeNull()
    expect(dockNavigateTarget('Page.navigate', {})).toBeNull()
    expect(dockNavigateTarget('Page.navigate', { url: 123 })).toBeNull()
  })
})

describe('③ 动作枚举、超时预算与 agent 视图前缀', () => {
  test('动作枚举与只读枚举不重不漏（两档动作各归各的）', () => {
    expect(DOCK_ACTIONS.every((action) => !DOCK_LOOK_ACTIONS.includes(action))).toBe(true)
    expect(DOCK_ACTIONS).toContain('navigate')
    expect(DOCK_LOOK_ACTIONS).toContain('screenshot')
  })

  test('超时预算：通用 25s、开页签 8s（开页签比通用短）', () => {
    expect(DOCK_CALL_TIMEOUT_MS).toBe(25_000)
    expect(DOCK_OPEN_TIMEOUT_MS).toBe(8_000)
    expect(DOCK_OPEN_TIMEOUT_MS).toBeLessThan(DOCK_CALL_TIMEOUT_MS)
  })

  test('isAgentView 只认 agent- 前缀（审批卡与工具输出靠它标来源）', () => {
    expect(isAgentView('agent-1')).toBe(true)
    expect(isAgentView('main')).toBe(false)
    expect(isAgentView('t123')).toBe(false)
  })

  test('协议版本是 3（两侧握手按它比对 hello）', () => {
    expect(HOST_PROTOCOL_VERSION).toBe(3)
  })
})

describe('④ 会话路由：按视图 + 方法双重过滤', () => {
  /** 记录 source 收到的调用。 */
  interface Call {
    viewId: string
    method: string
    params: Record<string, unknown> | undefined
  }

  /** 造一条假 source：记录调用，事件用手动 emit 推。 */
  function makeSource(): {
    source: DockSessionSource
    calls: Call[]
    emit: (event: DockBrowserEventPush) => void
  } {
    const calls: Call[] = []
    const handlers = new Set<(event: DockBrowserEventPush) => void>()
    return {
      calls,
      emit(event) {
        for (const handler of [...handlers]) handler(event)
      },
      source: {
        call: <T>(viewId: string, method: string, params?: Record<string, unknown>) => {
          calls.push({ viewId, method, params })
          return Promise.resolve({ ok: true } as T)
        },
        onEvent: (handler) => {
          handlers.add(handler)
          return () => {
            handlers.delete(handler)
          }
        },
      },
    }
  }

  test('sessionId 就是视图 id（桌面侧按它找 webContents）', () => {
    const { source } = makeSource()
    expect(createDockSession(source, 'agent-5').sessionId).toBe('agent-5')
  })

  test('send 原样透传 viewId / method / params（不带 params 的命令保持 undefined）', async () => {
    const { source, calls } = makeSource()
    const session = createDockSession(source, 'agent-5')
    await session.send('Page.navigate', { url: 'https://example.com/' })
    await session.send('Page.reload')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.viewId).toBe('agent-5')
    expect(calls[0]?.method).toBe('Page.navigate')
    expect(calls[0]?.params).toStrictEqual({ url: 'https://example.com/' })
    expect(calls[1]?.method).toBe('Page.reload')
    // 补一个 {} 会让桌面侧把「不带参数」当成「参数是空对象」，两类命令的语义就混了。
    expect(calls[1]?.params).toBeUndefined()
  })

  test('send 把 source 的返回值原样交回', async () => {
    const { source } = makeSource()
    const session = createDockSession(source, 'agent-5')
    expect(await session.send('Page.navigate', { url: 'https://example.com/' })).toStrictEqual({ ok: true })
    expect(await session.send('Page.reload')).toStrictEqual({ ok: true })
  })

  test('别的 viewId / 别的 method 的事件都不投递', () => {
    const { source, emit } = makeSource()
    const session = createDockSession(source, 'agent-5')
    const seen: unknown[] = []
    session.on('Runtime.consoleAPICalled', (params) => seen.push(params))
    emit({ type: 'browser-event', viewId: 'agent-6', method: 'Runtime.consoleAPICalled', params: { text: '别的视图' } })
    emit({ type: 'browser-event', viewId: 'agent-5', method: 'Page.frameNavigated', params: { frame: {} } })
    expect(seen).toStrictEqual([])
  })

  test('本视图 + 本方法的事件投递一次且只一次', () => {
    const { source, emit } = makeSource()
    const session = createDockSession(source, 'agent-5')
    const seen: Array<Record<string, unknown>> = []
    session.on('Runtime.consoleAPICalled', (params) => seen.push(params))
    emit({ type: 'browser-event', viewId: 'agent-5', method: 'Runtime.consoleAPICalled', params: { text: '自己这台' } })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.['text']).toBe('自己这台')
  })

  test('退订之后不再投递（退订函数真的从 source 摘掉）', () => {
    const { source, emit } = makeSource()
    const session = createDockSession(source, 'agent-5')
    const seen: unknown[] = []
    const off = session.on('Runtime.consoleAPICalled', (params) => seen.push(params))
    off()
    emit({ type: 'browser-event', viewId: 'agent-5', method: 'Runtime.consoleAPICalled', params: { text: '退订之后' } })
    expect(typeof off).toBe('function')
    expect(seen).toStrictEqual([])
  })
})

describe('⑤ 原生桥事件面：两条页签事件进白名单（同一份契约）', () => {
  test('NATIVE_EVENTS 含契约那两条页签事件', () => {
    expect(NATIVE_EVENTS).toContain(DOCK_TAB_OPEN_EVENT)
    expect(NATIVE_EVENTS).toContain(DOCK_TAB_CLOSE_EVENT)
    expect(NATIVE_EVENT_SET.has(DOCK_TAB_OPEN_EVENT)).toBe(true)
    expect(NATIVE_EVENT_SET.has(DOCK_TAB_CLOSE_EVENT)).toBe(true)
  })

  test('事件名互不相同且形如 browser-tab-*-request', () => {
    expect(DOCK_TAB_OPEN_EVENT).not.toBe(DOCK_TAB_CLOSE_EVENT)
    expect(DOCK_TAB_OPEN_EVENT).toMatch(/^browser-tab-.+-request$/)
    expect(DOCK_TAB_CLOSE_EVENT).toMatch(/^browser-tab-.+-request$/)
  })

  test('NATIVE_EVENTS 无重复项（Set 化后不会少一条）', () => {
    expect(new Set(NATIVE_EVENTS).size).toBe(NATIVE_EVENTS.length)
  })

  test('NATIVE_BRIDGE_VERSION 仍是 3（本次只加事件，按「加操作不涨」）', () => {
    expect(NATIVE_BRIDGE_VERSION).toBe(3)
  })
})
