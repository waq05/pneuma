/**
 * 正文列宽拖拽条的纯逻辑半边（迁自 `scripts/ui-thread-resizer-test.mjs` 第 [1] 段）。
 *
 * `panels.ts` 钉的夹取数学与读档口径：
 *   ① 夹取区间是导出常量（侧栏 200–420、正文下限 480、停靠 300–820 / 默认 420、
 *      存档天花板 3200），`PANEL_KEYS` 与桌面渲染层同名（切界面时宽度延续）；
 *   ② 右缘轨道宽 / 侧栏默认宽从样式表现读，读不到落回常数；
 *   ③ localStorage 的读档语义：越界当没有、非数字当没有（存坏了不该把面板挤没）；
 *   ④ `setRootVar` 写根变量 / null 撤掉行内值。
 *
 * 读写宿主几何那一半（localStorage 与宿主份的优先级、写盘整份上交）已由
 * `panels-geometry.spec.ts` 覆盖（迁自 `panel-prefs-test.mjs`），这里不重复。
 *
 * 原探针没迁的：[2]–[4] 的 CSS 几何契约与 `thread-resizer.tsx` 量算接线——全是
 * 样式表 / JSX 源码文本钉，接缝在真渲染（把手真的落在列缘外 24px、底边停在输入区
 * 上沿），归「待组件渲染批」；见交付报告缺口清单。
 *
 * 为什么归 ui project（jsdom）：`setRootVar` 与 `readRootPx` 直接碰
 * `document.documentElement` 与 `getComputedStyle`；样式表读数用桩顶上
 * （jsdom 不算样式，`vi.stubGlobal` 换成可控的那一台）。
 *
 * @module dsc-ui-primitives/ui/panels-resizer.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  DOCK_DEFAULT_WIDTH,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  PANEL_KEYS,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  STORED_MAX,
  THREAD_EDGE_BUDGET,
  THREAD_MIN,
  readRightRailPx,
  readSidebarDefaultPx,
  readStoredPx,
  setRootVar,
  writeStoredPx,
} from './panels.js'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('夹取区间与键名（导出常量，方案 A：断言导出对象）', () => {
  test('侧栏 200–420、正文下限 480 / 两侧预算 80', () => {
    expect(SIDEBAR_MIN).toBe(200)
    expect(SIDEBAR_MAX).toBe(420)
    expect(THREAD_MIN).toBe(480)
    expect(THREAD_EDGE_BUDGET).toBe(80)
  })

  test('停靠面板三档与桌面渲染层同一组数字；存档天花板 3200', () => {
    expect(DOCK_MIN_WIDTH).toBe(300)
    expect(DOCK_MAX_WIDTH).toBe(820)
    expect(DOCK_DEFAULT_WIDTH).toBe(420)
    expect(STORED_MAX).toBe(3200)
  })

  test('localStorage 键与桌面渲染层同名（切界面时宽度延续）', () => {
    expect(PANEL_KEYS.threadWidth).toBe('dsc.threadWidth')
    expect(PANEL_KEYS.sidebarWidth).toBe('dsc.sidebarWidth')
    expect(PANEL_KEYS.dockWidth).toBe('dsc.dockWidth')
  })
})

describe('从样式表现读的读数（读不到落回常数）', () => {
  test('右缘轨道宽 = 刻度条 + 滚动条，逐项从样式表来', () => {
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string): string =>
        ({ '--dsc-jump-lane': '36px', '--dsc-scrollbar-w': '5px' })[name] ?? '',
    }))
    expect(readRightRailPx()).toBe(41)
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string): string =>
        ({ '--dsc-jump-lane': '40px', '--dsc-scrollbar-w': '8px' })[name] ?? '',
    }))
    expect(readRightRailPx()).toBe(48)
  })

  test('样式表读不到时落回 36 + 5（tokens.css 改了这里跟着变，缺了不炸）', () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (): string => '' }))
    expect(readRightRailPx()).toBe(41)
  })

  test('侧栏默认宽：读得到用读到的，读不到是 237', () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string): string => (name === '--dsc-sidebar-w' ? '300px' : '') }))
    expect(readSidebarDefaultPx()).toBe(300)
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (): string => '' }))
    expect(readSidebarDefaultPx()).toBe(237)
  })
})

describe('localStorage 读档的挡脏值口径', () => {
  test('存了 300，区间内读得回来；越界当没有', () => {
    writeStoredPx(PANEL_KEYS.threadWidth, 300)
    expect(readStoredPx(PANEL_KEYS.threadWidth, 200, 420)).toBe(300)
    // 拖动上限比存档时收窄（比如窗口变小）：越出新区间的存档不能把面板挤没。
    expect(readStoredPx(PANEL_KEYS.threadWidth, 400, 420)).toBeNull()
  })

  test('非数字当没有', () => {
    localStorage.setItem(PANEL_KEYS.threadWidth, 'abc')
    expect(readStoredPx(PANEL_KEYS.threadWidth, 0, 100)).toBeNull()
  })
})

describe('setRootVar：拖出来的宽度交给样式表', () => {
  test('写值走 setProperty，null 撤掉行内值（回样式表）', () => {
    const setProperty = vi.spyOn(document.documentElement.style, 'setProperty')
    const removeProperty = vi.spyOn(document.documentElement.style, 'removeProperty')
    setRootVar('--dsc-x', '12px')
    expect(setProperty).toHaveBeenCalledWith('--dsc-x', '12px')
    setRootVar('--dsc-x', null)
    expect(removeProperty).toHaveBeenCalledWith('--dsc-x')
  })
})
