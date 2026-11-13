/**
 * 面板几何的读档一端（迁自 `scripts/panel-prefs-test.mjs` 第 [1]–[5] 节）。
 *
 * ## 为什么要有这一条
 *
 * 侧栏宽 / 正文列宽 / 右侧栏宽 / 并排审查宽 / 侧栏收起这五项以前只写 localStorage，
 * 而宿主每次启动、每次切工作目录都会换一个端口，localStorage 按源隔离——换端口就是
 * 一份空存储，用户拖出来的宽度每次重开都回默认（2026-10-29 报障）。修法是把它们跟别的
 * 界面偏好一起落进 `settings.json`，这一条盯的就是**读回来**那半边：
 *
 *   - 好值读得回来；
 *   - 小数四舍五入（拖拽算出来的是浮点）；
 *   - 脏值**丢掉**而不是夹取（夹出来的宽度用户没选过，而且会挡住样式表默认值）；
 *   - 一项脏不影响别的项；
 *   - `collapsed: false` 是「显式打开」，不是「缺键」。
 *
 * ## 为什么归 unit，不归 ui
 *
 * 被测的是 `core/prefs.ts` 的 `readPrefs()`——纯文件读取与字段校验，不碰 DOM。
 * 另一半（`ui-primitives/ui/panels.ts` 的 localStorage / 宿主几何优先级）在
 * `src/packages/ui-primitives/ui/panels-geometry.spec.ts`，那边才要 jsdom。
 *
 * ## 隔离
 *
 * `DSC_SETTINGS_JSON` 是从 `path-policy` 的模块级常量 `DSC_HOME` 派生的，所以
 * `tempHome()` 必须在 `prefs.ts` 被加载之前跑，模块一律动态 import。真实 `~/.dsc`
 * 一个字节都不动。
 *
 * @module dsc/core/prefs-panel-widths.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录：`settings.json` 从这里推导（`tempHome` 一个文件只能调一次）。 */
const home = tempHome('dsc-panel-prefs-')

type PrefsModule = typeof import('./prefs.js')
/** 本文件只关心 `readPrefs().ui.panelWidths`，但类型仍取真模块的。 */
type PanelWidths = ReturnType<PrefsModule['readPrefs']>['ui']['panelWidths']

let prefs: PrefsModule

beforeAll(async () => {
  prefs = await import('./prefs.js')
})

afterAll(() => {
  home.restore()
})

/** 造一份 settings.json；路径从产品代码取，不在这里另拼一份。 */
function writeSettings(doc: Record<string, unknown>): void {
  mkdirSync(dirname(prefs.DSC_SETTINGS_JSON), { recursive: true })
  writeFileSync(prefs.DSC_SETTINGS_JSON, JSON.stringify(doc), 'utf8')
}

/** 读回 `ui.panelWidths`（只读这一项）。 */
function panelWidths(): PanelWidths {
  return prefs.readPrefs().ui.panelWidths
}

describe('① 没写过：出厂空表', () => {
  test('缺键读出空对象（各项用样式表默认宽）', () => {
    writeSettings({})
    expect(JSON.stringify(panelWidths())).toBe('{}')
  })
})

describe('② 好值原样读回', () => {
  test('五项好值一次读回', () => {
    writeSettings({
      ui: { panelWidths: { sidebar: 300, thread: 720, dock: 480, diff: 520, collapsed: true } },
    })
    const widths = panelWidths()
    expect(widths.sidebar).toBe(300)
    expect(widths.thread).toBe(720)
    expect(widths.dock).toBe(480)
    expect(widths.diff).toBe(520)
    expect(widths.collapsed).toBe(true)
  })
})

describe('③ 小数四舍五入（拖拽算出来的是浮点）', () => {
  test('300.6 → 301、419.4 → 419', () => {
    writeSettings({ ui: { panelWidths: { sidebar: 300.6, dock: 419.4 } } })
    const widths = panelWidths()
    expect(widths.sidebar).toBe(301)
    expect(widths.dock).toBe(419)
  })
})

describe('④ 脏值丢掉，不夹取（夹出来的宽度用户没选过）', () => {
  test('字符串 / 负数 / 0 / 超上限 / 非布尔收起态全丢', () => {
    writeSettings({
      ui: {
        panelWidths: { sidebar: '320', thread: -5, dock: 0, diff: 99999, collapsed: 'yes' },
      },
    })
    const widths = panelWidths()
    expect(widths.sidebar).toBeUndefined()
    expect(widths.thread).toBeUndefined()
    expect(widths.dock).toBeUndefined()
    expect(widths.diff).toBeUndefined()
    expect(widths.collapsed).toBeUndefined()
    expect(JSON.stringify(widths)).toBe('{}')
  })
})

describe('⑤ 一项脏不影响别的项', () => {
  test('好的留下来、坏的那项不在、collapsed=false 也认得出来', () => {
    writeSettings({ ui: { panelWidths: { sidebar: 260, thread: 'x', collapsed: false } } })
    const widths = panelWidths()
    expect(widths.sidebar).toBe(260)
    expect(widths.thread).toBeUndefined()
    // false 是「显式打开」，不能和「缺键」混成一档。
    expect(widths.collapsed).toBe(false)
  })
})
