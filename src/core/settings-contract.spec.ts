/**
 * settings 契约：`~/.dsc/settings.json` 的默认形状、读写对称与设置分区的投影形状。
 *
 * ## 钉的是什么
 *
 * 1. `readPrefs()` 在**没有 settings.json** 时返回的整对象（键全集 + 出厂默认值）；
 * 2. `writePrefs()` 的深合并、返回值与「写下去的那份」逐字段一致（读写对称）；
 *    JSON 顶层 / `ui` / `remote` 的键集也一并钉住（磁盘格式不许悄悄多键少键）；
 * 3. settings 插件的投影：`sections()` 视图的键集、`values()` 的整对象（general / tui /
 *    五个 custom 分区 / about）。界面通道按这些键名取值，改名就是断链。
 *
 * ## 与既有 spec 的分工
 *
 * - `prefs.int.spec.ts`：只钉 `remote` 段的逐项校验（非法类型回落、端口夹取、webhook 白名单）。
 * - `prefs-panel-widths.spec.ts`：只钉 `ui.panelWidths` 的读档规则。
 * - `packages/settings/tests/settings.spec.ts`：钉插件对象、八个分区的 id/order、general
 *   字段的 key 顺序、custom 标记与「检查更新」动作。本文件不重做这些，只补它没钉的两块：
 *   **默认值的整对象**与 **values() 投影的键全集**。
 * - `config-store.spec.ts`：模型配置文件（config.yaml / credentials.yaml），与本文件无关。
 *
 * ## 为什么留在 unit（用临时 HOME）
 *
 * 被测的是纯文件读写与插件声明投影，不起内核、不碰 `lib`（D25 的混合平面对这里没有收益）。
 * 临时 HOME 的用法与同目录 `prefs-panel-widths.spec.ts` 相同：`path-policy` 的 `DSC_HOME`
 * 是模块级常量，所以 `tempHome()` 必须在 `prefs.ts` 加载之前执行，模块一律动态 import。
 *
 * ## 改契约时应当红在哪
 *
 * 改任一出厂默认值 → 第 ① 条红；改 `writePrefs` 的合并口径或落盘字段 → 第 ③ 条红；
 * 改 `values()` / `sections()` 的投影键 → 第 ② 条红。反向验证：把 `readPrefs()` 里的
 * `closeToTray: true` 临时改成 `false`，第 ① 条应当红。
 *
 * @module dsc/core/settings-contract.spec
 */
import { readFileSync, rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DscCoreConfig } from './config.js'
import type { DscPrefs, RemotePrefs } from './prefs.js'
import type { SettingsService } from '../services/types.js'
import type { UiPrefsView } from '../contract.js'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录：`settings.json` 从这里推导（一个文件只能调一次）。 */
const home = tempHome('dsc-settings-contract-')
// 继承来的 DSC_HOME 会把隔离击穿（`path-policy` 优先读它）。
delete process.env['DSC_HOME']

type PrefsModule = typeof import('./prefs.js')
let prefs: PrefsModule
let settingsPlugin: typeof import('../packages/settings/index.js')['settingsPlugin']
let service: SettingsService

/** 出厂 `settings.json` 应当读出来的整对象（键全集 + 默认值）。 */
const DEFAULT_PREFS: DscPrefs = {
  defaultPolicy: null,
  defaultReviewer: null,
  defaultPermissionPreset: '',
  defaultEffort: null,
  defaultPreset: '',
  marketSources: [
    { name: 'anthropics', url: 'https://github.com/anthropics/skills/tree/main/skills' },
    {
      name: 'dsh',
      url: 'https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/skills',
    },
    { name: 'ClawHub', url: 'https://clawhub.ai/api/v1/skills?sort=downloads&limit=100' },
    { name: 'skills.sh', url: 'https://skills.sh/api/search' },
  ],
  closeToTray: true,
  updateCheck: 'launch',
  configFile: '',
  ui: {
    sessionSort: 'manual',
    sessionGroup: 'workspace',
    archivedFilter: 'hide',
    workspaceOrder: [],
    workspaceAliases: {},
    themeMode: 'claude',
    textSizePx: 14,
    fontSize: 1,
    textFontFamily: '',
    codeFontFamily: '',
    buttonScale: 1,
    density: 'standard',
    processFold: 'standard',
    collapseTiming: 'completion',
    foldedReplies: 'final',
    reasoningDefaultOpen: false,
    toolDefaultOpen: false,
    sessionExpansion: {},
    sessionOrder: {},
    turnCompleteSound: true,
    turnCompleteSoundVariant: 1,
    turnCompleteNotify: true,
    statusBar: {
      model: true,
      effort: false,
      cache: true,
      tokens: false,
      cost: true,
      mode: false,
      policy: true,
      ctx: true,
      cwd: true,
      session: false,
    },
    panelWidths: {},
  },
  remote: { enabled: false, port: 17321, lan: false, push: false, notifyWebhook: '' },
}

/**
 * 起一次 settings 插件（假 ctx 只实现 `apply` 与 `values()` 真正用到的成员）。
 *
 * 不装 `permissionPresets`：general 分区的 `permissionPreset` 因此是派生值 `custom`，
 * 这正是「服务没挂时投影仍可用」的那条路径。
 */
function mountSettings(): SettingsService {
  let provided: SettingsService | undefined
  const fakeCtx = {
    get: () => undefined,
    transcript: { touch: () => {}, system: () => {} },
    llm: {
      provider: 'test',
      model: 'm',
      effort: 'high',
      setEffort: () => {},
      setModel: () => {},
      routeTo: () => ({}),
      stream: () => {},
    },
    approval: { reviewer: 'user', setPolicy: () => {}, setReviewer: () => {} },
    provide: (_name: string, value: SettingsService) => {
      provided = value
    },
  }
  ;(settingsPlugin.apply as (ctx: unknown, config: DscCoreConfig) => void)(fakeCtx, {} as DscCoreConfig)
  return provided as SettingsService
}

beforeAll(async () => {
  prefs = await import('./prefs.js')
  ;({ settingsPlugin } = await import('../packages/settings/index.js'))
  service = mountSettings()
})

afterAll(() => {
  home.restore()
})

describe('① 出厂默认：没有 settings.json 时的整对象', () => {
  test('readPrefs() 与 DEFAULT_PREFS 逐字段相等（键全集与默认值）', () => {
    rmSync(prefs.DSC_SETTINGS_JSON, { force: true })
    expect(prefs.readPrefs()).toStrictEqual(DEFAULT_PREFS)
  })
})

describe('② settings 插件投影', () => {
  test('prefs() 与出厂默认同一份；values() 的整对象按分区钉住', async () => {
    // 插件在 apply 那一刻读了一次盘；此时还没写过任何东西，必须就是出厂默认。
    expect(service.prefs()).toStrictEqual(DEFAULT_PREFS)

    // general：预设服务没挂 → permissionPreset 是派生的 custom，显示名走 approval.reviewer。
    expect(await service.values('general')).toStrictEqual({
      permissionPreset: 'custom',
      permissionPresetName: '自定义',
      effort: 'high',
      temperature: 'follow',
      closeToTray: true,
    })

    // tui：一个顶层开关 + 十段状态栏显隐（点号键）。
    expect(await service.values('tui')).toStrictEqual({
      reasoningDefaultOpen: false,
      'statusBar.model': true,
      'statusBar.effort': false,
      'statusBar.cache': true,
      'statusBar.tokens': false,
      'statusBar.cost': true,
      'statusBar.mode': false,
      'statusBar.policy': true,
      'statusBar.ctx': true,
      'statusBar.cwd': true,
      'statusBar.session': false,
    })

    // 五个由桌面端自画的分区：没有表单值，投影必须是空对象。
    for (const id of ['models', 'presets', 'skills', 'usage', 'archive']) {
      expect(await service.values(id), `${id} 的 values() 应为空对象`).toStrictEqual({})
    }
    expect(await service.values('about')).toStrictEqual({ updateCheck: 'launch' })
  })

  test('sections() 视图的键集、fields 投影与 groups 形状', () => {
    const sections = service.sections()
    expect(sections.map((section) => section.id)).toEqual([
      'general',
      'models',
      'presets',
      'skills',
      'usage',
      'archive',
      'tui',
      'about',
    ])

    const general = sections.find((section) => section.id === 'general')
    expect(general).toBeDefined()
    expect(Object.keys(general!).sort()).toEqual([
      'builtin',
      'custom',
      'fields',
      'groups',
      'id',
      'order',
      'subtitle',
      'title',
    ])
    expect(general?.builtin).toBe(true)
    expect(general?.custom).toBe(false)
    // general 的第 1 个控件是预设下拉：派生显示名是它独有的字段。
    expect(general?.fields).toHaveLength(5)
    expect(Object.keys(general!.fields[0]!).sort()).toEqual([
      'derivedLabelKey',
      'help',
      'key',
      'label',
      'options',
      'type',
    ])

    const tui = sections.find((section) => section.id === 'tui')
    expect(tui).toBeDefined()
    expect(tui?.fields).toHaveLength(11)
    expect(Object.keys(tui!.fields[0]!).sort()).toEqual(['help', 'key', 'label', 'type'])
    expect(tui?.groups).toHaveLength(1)
    expect(Object.keys(tui!.groups![0]!).sort()).toEqual(['description', 'id', 'title'])
    expect(tui?.groups?.[0]?.id).toBe('status-bar')
  })
})

describe('③ 写读对称与磁盘格式', () => {
  test('writePrefs 深合并：只给嵌套段的一项，其余键不丢；读回与返回值除派生字号外逐字段相等', () => {
    rmSync(prefs.DSC_SETTINGS_JSON, { force: true })
    const written = prefs.writePrefs({
      closeToTray: false,
      updateCheck: 'off',
      configFile: 'D:\\cfg\\config.yaml',
      defaultPolicy: 'full-access',
      defaultReviewer: 'auto-review',
      defaultPermissionPreset: 'trusted',
      defaultEffort: 'high',
      defaultPreset: 'plan',
      marketSources: [{ name: 'mine', url: 'https://example.com/skills' }],
      // 故意只给嵌套段的一项：writePrefs 必须与当前值深合并，其余键原样保留。
      // 字号写 px 不写倍率：2026-11 起 `textSizePx` 是唯一真源，`fontSize` 是读档时回算的派生值
      //（见 contract/session.ts 的 UiPrefsView），写倍率会被重算覆盖掉。
      ui: { themeMode: 'dark', textSizePx: 16 } as UiPrefsView,
      remote: { port: 21_000 } as RemotePrefs,
    })

    // 写读对称：**除了派生的 fontSize**。writePrefs 只做浅合并、不回算派生字段，
    // 返回的 fontSize 还是合并时留下的默认 1；读档（readPrefs）才按 textSizePx 重算成 1.1429。
    // 这个不对称是产品口径（contract/session.ts 的 UiPrefsView：两者不一致时以 textSizePx 为准，
    // 读档会重算），所以这里把 fontSize 抹平再比其余字段，别写成整对象严格相等。
    const back = prefs.readPrefs()
    const sameExceptFontSize = (value: typeof written): typeof written => ({
      ...value,
      ui: { ...value.ui, fontSize: 0 },
    })
    expect(sameExceptFontSize(back)).toStrictEqual(sameExceptFontSize(written))
    // 深合并的证据：没传的键还在，传了的键生效。
    expect(back.ui.themeMode).toBe('dark')
    expect(back.ui.textSizePx).toBe(16)
    // 派生值跟随真源：16px ÷ 14 ≈ 1.1429。
    expect(back.ui.fontSize).toBeCloseTo(16 / 14, 3)
    expect(back.ui.density).toBe('standard')
    expect(back.remote.port).toBe(21_000)
    expect(back.remote.enabled).toBe(false)
    expect(back.remote.notifyWebhook).toBe('')

    // 磁盘格式：JSON 的键集就是契约（多一个键 = 多了没有人读的垃圾字段）。
    const disk = JSON.parse(readFileSync(prefs.DSC_SETTINGS_JSON, 'utf8')) as Record<string, unknown>
    expect(disk).toStrictEqual(written)
    expect(Object.keys(disk).sort()).toEqual([
      'closeToTray',
      'configFile',
      'defaultEffort',
      'defaultPermissionPreset',
      'defaultPolicy',
      'defaultPreset',
      'defaultReviewer',
      'marketSources',
      'remote',
      'ui',
      'updateCheck',
    ])
    expect(Object.keys(disk['ui'] as Record<string, unknown>).sort()).toEqual([
      'archivedFilter',
      'buttonScale',
      'codeFontFamily',
      'collapseTiming',
      'density',
      'foldedReplies',
      'fontSize',
      'panelWidths',
      'processFold',
      'reasoningDefaultOpen',
      'sessionExpansion',
      'sessionGroup',
      'sessionOrder',
      'sessionSort',
      'statusBar',
      'textFontFamily',
      'textSizePx',
      'themeMode',
      'toolDefaultOpen',
      'turnCompleteNotify',
      'turnCompleteSound',
      'turnCompleteSoundVariant',
      'workspaceAliases',
      'workspaceOrder',
    ])
    expect(Object.keys(disk['remote'] as Record<string, unknown>).sort()).toEqual([
      'enabled',
      'lan',
      'notifyWebhook',
      'port',
      'push',
    ])
  })
})
