/**
 * 面板几何的读写半边（迁自 `scripts/panel-prefs-test.mjs` 第 [7]、[8] 节）。
 *
 * ## 这里测的是什么
 *
 * `ui-primitives/ui/panels.ts` 是浏览器侧的真实现：读宽度时先问 localStorage（同源内的
 * 最新值），没有再问宿主那份（跨宿主重启的那份）；拖完一个值要同时写 localStorage 与
 * 把**整份**几何交给宿主（宿主补丁是整键替换语义）。第 [8] 节再验启动时从地址里带过来
 * 的那份几何——宿主冷启动、数据通道还没就绪时，首帧靠它不跳一下。
 *
 * 归 `ui` project（jsdom）：`panels.ts` 在模块求值时读一次 `window.location.search`，
 * 其余函数直接碰 `localStorage`。unit 层（node）没有这两样。
 *
 * ## 为什么第 [8] 节要换一个模块实例
 *
 * `bootGeometry` 是模块级常量，只在模块求值时读一次地址。所以先用
 * `history.replaceState` 摆好地址，再 `vi.resetModules()` + 动态 import 拿一份**新求值**
 * 的模块——与生产里「带着 `?panels=...` 打开一个页面」同义，不是另写一套读地址的逻辑。
 *
 * ## 原探针里没搬的部分
 *
 * 六条「读源码文本」的接线检查（契约字段、`runtime/index.ts` 的补丁回执闸门、
 * `ui-renderer/ui/ui.tsx` 的两次启动调用、`desktop/electron/main` 拼地址）都是
 * 读 `.ts`/`.tsx` 找字符串：按迁移手册第 2 节属必删项，缺口逐条记在交付报告里。
 * 其中「localStorage 空着时先看地址里那份」与「落盘发整份」两条，本节与第 ⑦ 节
 * 已有行为断言覆盖，不欠账。
 *
 * @module @pneuma/ui-primitives/ui/panels-geometry.spec
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import * as panels from './panels.js'

/** 第 ⑦ 节收到的宿主落盘调用（整份几何）。 */
const sent: panels.PanelGeometry[] = []

describe('⑦ 面板模块的真行为（真 localStorage + 假宿主）', () => {
  beforeAll(() => {
    localStorage.clear()
    panels.setPanelGeometrySaver((geometry) => {
      sent.push(geometry)
    })
    panels.primePanelGeometry({ sidebar: 300, dock: 480, collapsed: true })
  })

  afterAll(() => {
    panels.setPanelGeometrySaver(null)
  })

  test('localStorage 空着时读宿主那份（侧栏宽 / 右侧栏宽 / 收起态）', () => {
    expect(panels.readStoredPx(panels.PANEL_KEYS.sidebarWidth, 200, 420)).toBe(300)
    expect(panels.readStoredPx(panels.PANEL_KEYS.dockWidth, 300, 820)).toBe(480)
    expect(panels.readStoredFlag(panels.PANEL_KEYS.sidebarCollapsed)).toBe(true)
  })

  test('没存过的项仍是 null（用样式表默认）', () => {
    expect(panels.readStoredPx(panels.PANEL_KEYS.threadWidth, 480, 3200)).toBeNull()
  })

  test('拖完同时写 localStorage、并把整份几何发给宿主', () => {
    panels.writeStoredPx(panels.PANEL_KEYS.sidebarWidth, 260)
    expect(localStorage.getItem(panels.PANEL_KEYS.sidebarWidth)).toBe('260')
    // 整份而不是单个键：宿主补丁是整键替换，只发一项会把别的项抹成缺键。
    expect(sent).toHaveLength(1)
    expect(sent[0]?.sidebar).toBe(260)
    expect(sent[0]?.dock).toBe(480)
  })

  test('同源内 localStorage 压过宿主那份，删掉后回落到宿主那份', () => {
    // 两个值必须不同：以前写完之后 localStorage 与内存副本是同一个数，
    // 删掉任何一边这条断言都照样过，等于没测。
    panels.primePanelGeometry({ sidebar: 300 })
    localStorage.setItem(panels.PANEL_KEYS.sidebarWidth, '260')
    expect(panels.readStoredPx(panels.PANEL_KEYS.sidebarWidth, 200, 420)).toBe(260)
    localStorage.removeItem(panels.PANEL_KEYS.sidebarWidth)
    expect(panels.readStoredPx(panels.PANEL_KEYS.sidebarWidth, 200, 420)).toBe(300)
  })

  test('收起态翻回来也记（false 不是「缺键」）', () => {
    panels.writeStoredFlag(panels.PANEL_KEYS.sidebarCollapsed, false)
    expect(sent.at(-1)?.collapsed).toBe(false)
    expect(panels.readStoredFlag(panels.PANEL_KEYS.sidebarCollapsed)).toBe(false)
  })

  test('复位删键（回到默认宽），整份几何里也去掉这一项', () => {
    panels.writeStoredPx(panels.PANEL_KEYS.threadWidth, null)
    expect(localStorage.getItem(panels.PANEL_KEYS.threadWidth)).toBeNull()
    expect(sent.at(-1)?.thread).toBeUndefined()
  })

  test('localStorage 存坏了也回落到宿主那份', () => {
    localStorage.setItem(panels.PANEL_KEYS.dockWidth, 'wide')
    panels.primePanelGeometry({ dock: 460 })
    expect(panels.readStoredPx(panels.PANEL_KEYS.dockWidth, 300, 820)).toBe(460)
    localStorage.removeItem(panels.PANEL_KEYS.dockWidth)
  })

  test('宿主那份越界也不认（不能因为「宿主说的」就放行）', () => {
    panels.primePanelGeometry({ sidebar: 9999 })
    localStorage.removeItem(panels.PANEL_KEYS.sidebarWidth)
    expect(panels.readStoredPx(panels.PANEL_KEYS.sidebarWidth, 200, 420)).toBeNull()
  })
})

describe('⑧ 地址里带过来的那份额外保险（宿主冷启动慢时用）', () => {
  /** 换过一次求值的模块实例（地址里的 `?panels=` 已摆好）。 */
  let boot: typeof import('./panels.js')

  beforeAll(async () => {
    localStorage.clear()
    window.history.replaceState({}, '', '/?theme=claude&panels=sidebar:340,dock:700,collapsed:1')
    // bootGeometry 只在模块求值时读地址：清掉模块缓存才能拿到「带着地址打开」那一份。
    vi.resetModules()
    boot = await import('./panels.js')
  })

  test('侧栏宽 / 右侧栏宽 / 收起态取地址里那份', () => {
    expect(boot.readStoredPx(boot.PANEL_KEYS.sidebarWidth, 200, 420)).toBe(340)
    expect(boot.readStoredPx(boot.PANEL_KEYS.dockWidth, 300, 820)).toBe(700)
    expect(boot.readStoredFlag(boot.PANEL_KEYS.sidebarCollapsed)).toBe(true)
  })

  test('地址里没有的项回落到宿主回读', () => {
    boot.primePanelGeometry({ thread: 780 })
    expect(boot.readStoredPx(boot.PANEL_KEYS.threadWidth, 480, 3200)).toBe(780)
  })

  test('拖过之后 localStorage 压过地址里那份', () => {
    localStorage.setItem(boot.PANEL_KEYS.sidebarWidth, '260')
    expect(boot.readStoredPx(boot.PANEL_KEYS.sidebarWidth, 200, 420)).toBe(260)
  })
})
