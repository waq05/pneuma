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
  test('侧栏宽读回', () => {
    writeSettings({ ui: { panelWidths: { sidebar: 300 } } })
    expect(panelWidths().sidebar).toBe(300)
  })

  test('正文列宽读回', () => {
    writeSettings({ ui: { panelWidths: { thread: 720 } } })
    expect(panelWidths().thread).toBe(720)
  })

  test('右侧栏宽读回', () => {
    writeSettings({ ui: { panelWidths: { dock: 480 } } })
    expect(panelWidths().dock).toBe(480)
  })

  test('并排审查宽读回', () => {
    writeSettings({ ui: { panelWidths: { diff: 520 } } })
    expect(panelWidths().diff).toBe(520)
  })

  test('侧栏收起读回', () => {
    writeSettings({ ui: { panelWidths: { collapsed: true } } })
    expect(panelWidths().collapsed).toBe(true)
  })
})

describe('③ 小数四舍五入（拖拽算出来的是浮点）', () => {
  test('301 ← 300.6', () => {
    writeSettings({ ui: { panelWidths: { sidebar: 300.6 } } })
    expect(panelWidths().sidebar).toBe(301)
  })

  test('419 ← 419.4', () => {
    writeSettings({ ui: { panelWidths: { dock: 419.4 } } })
    expect(panelWidths().dock).toBe(419)
  })
})

describe('④ 脏值丢掉，不夹取（夹出来的宽度用户没选过）', () => {
  test('字符串不当宽度', () => {
    writeSettings({ ui: { panelWidths: { sidebar: '320' } } })
    expect(panelWidths().sidebar).toBeUndefined()
  })

  test('负数丢掉', () => {
    writeSettings({ ui: { panelWidths: { thread: -5 } } })
    expect(panelWidths().thread).toBeUndefined()
  })

  test('0 丢掉', () => {
    writeSettings({ ui: { panelWidths: { dock: 0 } } })
    expect(panelWidths().dock).toBeUndefined()
  })

  test('超上限丢掉', () => {
    writeSettings({ ui: { panelWidths: { diff: 99999 } } })
    expect(panelWidths().diff).toBeUndefined()
  })

  test('非布尔的收起态丢掉', () => {
    writeSettings({ ui: { panelWidths: { collapsed: 'yes' } } })
    expect(panelWidths().collapsed).toBeUndefined()
  })

  test('整份脏值读成空对象', () => {
    writeSettings({
      ui: {
        panelWidths: { sidebar: '320', thread: -5, dock: 0, diff: 99999, collapsed: 'yes' },
      },
    })
    expect(JSON.stringify(panelWidths())).toBe('{}')
  })
})

describe('⑤ 一项脏不影响别的项', () => {
  test('好的留下来', () => {
    writeSettings({ ui: { panelWidths: { sidebar: 260, thread: 'x' } } })
    expect(panelWidths().sidebar).toBe(260)
  })

  test('坏的那项不在', () => {
    writeSettings({ ui: { panelWidths: { sidebar: 260, thread: 'x' } } })
    expect(panelWidths().thread).toBeUndefined()
  })

  test('collapsed=false 也认得出来（不是「缺键」）', () => {
    writeSettings({ ui: { panelWidths: { collapsed: false } } })
    expect(panelWidths().collapsed).toBe(false)
  })
})
