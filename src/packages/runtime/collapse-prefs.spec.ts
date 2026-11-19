/**
 * 折叠时机（collapseTiming）与「收起后显示的回复」（foldedReplies）从存档到设置服务的
 * 往返（迁自 `scripts/ui-collapse-prefs-test.mjs` 第 [1]–[5] 段）。
 *
 * 这两项偏好最容易「存了但没通」：存档没默认值、坏值把启动拦下来、setUiPrefs 收下了
 * 但 getUiPrefs 不带出来。五段全部落在真行为上：
 *   ① 读档：没这两项时给默认（completion / final）；
 *   ② 读档：好值原样读回；
 *   ③ 读档：坏值（认不出的串、null、数字、布尔、对象、整份坏 JSON）一律回落默认，不抛；
 *   ④ setUiPrefs → getUiPrefs 往返：两项都带出来，且落进 settings.json；
 *   ⑤ 只改一项时不动另一项，回执按项说明（回执文案是 setUiPrefs 的真实返回值）。
 *
 * 为什么归 unit（node）：不装内核——runtime 插件用假 ctx 装（只实现它读的
 * `settings.prefs` / `settings.setPrefs` 与 `provide` / `emit`，与原探针同构），
 * 读档走 `core/prefs.ts` 真函数。
 *
 * 没迁的（原探针第 [6] 段）：契约字段、读档表、设置页两个下拉、词典八条的源码文本钉
 * ——按手册 §2 属必删项；契约形状由 `tsc` 编译期把关，词典完整性与文案闸（
 * `ui-locale-test` 的字典对账）同属源码闸，见交付报告缺口清单。
 *
 * 隔离：`prefs.ts` 的 settings.json 路径是模块求值时算定的（`DSC_HOME` 顶层常量），
 * 所以在**任何 import 之前**先把 `DSC_HOME` 指进临时目录，再动态 import
 * （unit 层每个文件一个 fork 进程，不会串味到别的 spec）。
 *
 * @module dsc-runtime/collapse-prefs.spec
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

/** 先钉住 DSC_HOME，再动态 import：prefs 的 settings.json 路径是模块求值时算出来的。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-collapse-spec-'))
process.env.DSC_HOME = home

/** 动态 import 进来的两半（beforeAll 里取，保证路径已钉住）。 */
let prefs: typeof import('@pneuma/runtime/core/prefs.js')
let runtime: typeof import('@pneuma/runtime/packages/runtime/index.js')

afterAll(() => {
  delete process.env.DSC_HOME
})

/** 造一份 settings.json。 */
function writeSettings(doc: unknown): void {
  prefs.writePrefs(doc as Record<string, unknown>)
}

/** runtime 插件 apply 时真正用到的 ctx 面（其余服务在别的接口里，这两条路不碰）。 */
interface FakeRuntimeCtx {
  settings: {
    prefs(): ReturnType<typeof prefs.readPrefs>
    setPrefs(patch: Record<string, unknown>): void
  }
  provide(name: string, value: unknown): void
  emit(event: string): void
}

/** 用最小假 ctx 装上 runtime 插件，拿到它 provide 出来的 ui 服务。 */
function bootRuntime(): Record<string, unknown> {
  let service: Record<string, unknown> | null = null
  const fake: FakeRuntimeCtx = {
    settings: {
      prefs: () => prefs.readPrefs(),
      setPrefs: (patch) => prefs.writePrefs(patch),
    },
    provide: (_name, value) => {
      service = value as Record<string, unknown>
    },
    emit: () => {},
  }
  const apply = runtime.runtimePlugin.apply as unknown as (ctx: FakeRuntimeCtx) => void
  apply(fake)
  if (service === null) throw new Error('runtime 插件没有 provide 出服务：假 ctx 的 provide 没被调到')
  return service
}

/** 从 ui 服务里取 setUiPrefs / getUiPrefs（这两个方法就在 provide 的那份上）。 */
function uiMethods(service: Record<string, unknown>): {
  getUiPrefs(): { collapseTiming: string; foldedReplies: string }
  setUiPrefs(patch: Record<string, unknown>): Promise<{ ok: boolean; notice?: string }> | { ok: boolean; notice?: string }
} {
  return service as unknown as ReturnType<typeof uiMethods>
}

beforeAll(async () => {
  prefs = await import('@pneuma/runtime/core/prefs.js')
  runtime = await import('@pneuma/runtime/packages/runtime/index.js')
  // 动态 import 要拉整条 runtime 依赖链；全量并行时 5 秒钩子会抖红（单独跑 871ms）。
  // 这不是放宽断言，是给「模块首次装载」一个不被邻居挤爆的预算。
}, 20_000)

describe('① 读档：缺键给默认值', () => {
  test('没这两项时 collapseTiming = completion、foldedReplies = final', () => {
    mkdirSync(dirname(prefs.DSC_SETTINGS_JSON), { recursive: true })
    writeFileSync(prefs.DSC_SETTINGS_JSON, JSON.stringify({}), 'utf8')
    const ui = prefs.readPrefs().ui
    expect(ui.collapseTiming).toBe('completion')
    expect(ui.foldedReplies).toBe('final')
  })
})

describe('② 读档：好值原样读回', () => {
  test('next-input / final 与 completion / all 都读得回（不等于缺键）', () => {
    writeSettings({ ui: { collapseTiming: 'next-input', foldedReplies: 'final' } })
    expect(prefs.readPrefs().ui.collapseTiming).toBe('next-input')
    expect(prefs.readPrefs().ui.foldedReplies).toBe('final')
    writeSettings({ ui: { collapseTiming: 'completion', foldedReplies: 'all' } })
    expect(prefs.readPrefs().ui.collapseTiming).toBe('completion')
    expect(prefs.readPrefs().ui.foldedReplies).toBe('all')
  })
})

describe('③ 读档：坏值一律回落默认，绝不拦启动', () => {
  test.each([
    ['认不出的字符串', 'later'],
    ['大小写不对', 'Next-Input'],
    ['null', null],
    ['数字', 1],
    ['布尔', true],
    ['对象', { timing: 'next-input' }],
  ])('%s → completion / final', (_label, value) => {
    writeSettings({ ui: { collapseTiming: value, foldedReplies: value } })
    const ui = prefs.readPrefs().ui
    expect(ui.collapseTiming).toBe('completion')
    expect(ui.foldedReplies).toBe('final')
  })

  test('一项坏不影响另一项', () => {
    writeSettings({ ui: { collapseTiming: 'next-input', foldedReplies: 'nope' } })
    const ui = prefs.readPrefs().ui
    expect(ui.collapseTiming).toBe('next-input')
    expect(ui.foldedReplies).toBe('final')
  })

  test('整份坏 JSON：读档走 catch，给默认值、不抛', () => {
    mkdirSync(dirname(prefs.DSC_SETTINGS_JSON), { recursive: true })
    writeFileSync(prefs.DSC_SETTINGS_JSON, '{ this is not json', 'utf8')
    const ui = prefs.readPrefs().ui
    expect(ui.collapseTiming).toBe('completion')
    expect(ui.foldedReplies).toBe('final')
  })
})

describe('④ setUiPrefs → getUiPrefs 往返', () => {
  test('两项都带出来，回执说清切成了什么，且落进 settings.json', async () => {
    writeSettings({})
    const service = bootRuntime()
    const ui = uiMethods(service)

    const before = ui.getUiPrefs()
    expect(before.collapseTiming).toBe('completion')
    expect(before.foldedReplies).toBe('final')

    const reply = await ui.setUiPrefs({ collapseTiming: 'next-input', foldedReplies: 'final' })
    expect(reply.ok).toBe(true)
    expect(String(reply.notice)).toContain('下次发言时收起')

    const after = ui.getUiPrefs()
    expect(after.collapseTiming).toBe('next-input')
    expect(after.foldedReplies).toBe('final')

    const disk = JSON.parse(readFileSync(prefs.DSC_SETTINGS_JSON, 'utf8')) as { ui: Record<string, string> }
    expect(disk.ui.collapseTiming).toBe('next-input')
    expect(disk.ui.foldedReplies).toBe('final')
    expect(prefs.readPrefs().ui.collapseTiming).toBe('next-input')
  })
})

describe('⑤ 只改一项时不动另一项，回执按项说明', () => {
  test('只改时机：回复档保持 final；只改回复档：时机不动', async () => {
    const service = bootRuntime()
    const ui = uiMethods(service)

    const onlyTiming = await ui.setUiPrefs({ collapseTiming: 'completion' })
    expect(String(onlyTiming.notice)).toContain('立即收起')
    expect(ui.getUiPrefs().foldedReplies).toBe('final')
    expect(ui.getUiPrefs().collapseTiming).toBe('completion')

    const onlyReplies = await ui.setUiPrefs({ foldedReplies: 'all' })
    expect(String(onlyReplies.notice)).toContain('全部回复')
    expect(ui.getUiPrefs().collapseTiming).toBe('completion')
    expect(ui.getUiPrefs().foldedReplies).toBe('all')
  })
})
