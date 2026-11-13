/**
 * 「换一份配置文件用」：宿主校验、桥的放行、设置行（迁自
 * `scripts/config-file-switch-test.mjs` 的 [3][4]）。
 *
 * 用户要求：设置里那一行只显示路径 + 复制/打开，得能**换一份文件**来用。换文件走原生桥
 * （`pickConfigFile` 取路径 → `setConfigFile` 落偏好），宿主那侧校验四道：绝对路径 /
 * 读得了 / 能解析的 YAML / 有 providers。
 *
 * ## 原探针 [4] 的十五条源码文本断言：八条换成了真判定
 *
 *   - 桥放行两个操作、`setConfigFile` 只收一条路径、`pickConfigFile` 不收实参
 *     → 直接调 `validateNativeCall`（页面递进来的东西真正过的那道闸）；
 *   - 界面通道排除 `setConfigFile` → 调 `isUiMethod`；
 *   - 宿主方法白名单里有它 → 调 `isInvokableMethod`；
 *   - 设置「通用」分区那一行的文案就是活动路径、「更换 / 恢复默认」两个动作按状态出现
 *     → 读 `ctx.settings.sections()` 的字段。
 * 剩余七条（契约里的 TypeScript 签名、壳 `ui.tsx` 的取路径流程、Electron 主进程的
 * 文件对话框与后缀过滤）没有行为接缝，不搬，逐条列在交付报告里。
 *
 * ## 一个必须绕开的坑：两套平面各有一份 `activeConfigFile` 缓存
 *
 * 这一层的插件来自 `lib/`、宿主来自 `src/`（D25）。`src/core/config-store.ts` 与它编进
 * `lib/` 的那一份是两个模块实例，**各有一份 `activeCache`**；设置插件（lib）换完文件只
 * 清自己那份缓存，测试若从 `src` 那份读 `activeConfigFile()`，会一直读到第一次调用的
 * 陈旧值。所以这里一律读**宿主服务交出来的事实**：`ctx.settings.prefs()`、
 * `ctx.settings.sections()` 里那一行的文案、以及热更之后 `ctx.llm` 指到哪个端点。
 *
 * 隔离：临时 HOME；真实 `~/.dsc` 一个字节都不动。按 D25：改完 src 必须 `pnpm run build`。
 *
 * @module dsc/tests/integration/config-file-switch.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { DEFAULT_CONFIG_FILE } from '@pneuma/runtime/core/config-store.js'
import { isInvokableMethod } from '@pneuma/runtime/core/host-methods.js'
import { validateNativeCall, NATIVE_BRIDGE_VERSION } from '@pneuma/runtime/core/native-bridge.js'
import { isUiMethod } from '@pneuma/runtime/core/ui-methods.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 设置分区视图里本文件用到的字段。 */
interface FieldView {
  type: string
  label?: string
  text?: string
  actions?: Array<{ id: string }>
}

interface SectionView {
  id: string
  fields: FieldView[]
}

interface Mutation {
  ok: boolean
  notice?: string
  error?: string
}

interface SettingsSurface {
  sections(): SectionView[]
  prefs(): { configFile: string }
  setConfigFile(path: string): Mutation
}

let llm: FakeLLM
let kernel: BootedKernel
let settings: SettingsSurface
let llmService: { readonly provider: string; readonly model: string }

/** 写一份最小可用的模型配置。 */
function writeYaml(path: string, providerName: string): void {
  writeFileSync(
    path,
    `default:\n  provider: ${providerName}\n  model: m\nproviders:\n  ${providerName}:\n` +
      '    baseURL: http://127.0.0.1:1/v1\n    apiKeyEnv: K\n    models:\n      - id: m\n' +
      '        name: m\n        contextWindow: 1000\n        maxTokens: 100\n',
    'utf8',
  )
}

/** 设置「通用」分区里那一条「配置文件」信息行。 */
function configFileField(): FieldView | undefined {
  const general = settings.sections().find((section) => section.id === 'general')
  return (general?.fields ?? []).find((field) => field.type === 'info' && field.text !== undefined)
}

beforeAll(async () => {
  mkdirSync(DSC_HOME, { recursive: true })
  // 配置文件里的端点用 `apiKeyEnv: K` 取 key；没有 key 的端点不会注册（`core/config.ts`
  // 的 toProvider），也就观察不到「换完文件端点热更」这件事。
  process.env['K'] = 'k'
  llm = await fakeLLM({ turns: ['收到'] })
  // 这一组只验设置服务：端点整份留空，跑不了回合，也就不需要真模型。
  kernel = await bootKernel({
    providerBaseUrl: llm.baseUrl,
    config: { providers: {}, defaultProvider: '', defaultModel: '' },
  })
  const ctx = kernel.ctx as unknown as { settings: SettingsSurface; llm: { readonly provider: string; readonly model: string } }
  settings = ctx.settings
  llmService = ctx.llm
})

afterAll(async () => {
  delete process.env['K']
  await kernel?.dispose()
  await llm?.close()
})

describe('① 宿主方法 setConfigFile：四种拒绝都是干净的', () => {
  test('相对路径被拒（文件对话框给的一定是绝对路径）', () => {
    const result = settings.setConfigFile('relative.yaml')
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('绝对路径')
  })

  test('不存在的文件被拒', () => {
    const result = settings.setConfigFile(join(DSC_HOME, '..', 'nope.yaml'))
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('读不了')
  })

  test('解析不出内容被拒（不是 YAML / 空文件）', () => {
    const notYaml = join(DSC_HOME, '..', 'broken.yaml')
    writeFileSync(notYaml, 'providers: [\n  - 这不是合法 YAML\n', 'utf8')
    const result = settings.setConfigFile(notYaml)
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('解析不出任何内容')
  })

  test('没有 providers 段被拒（看起来不是模型配置文件）', () => {
    const noProviders = join(DSC_HOME, '..', 'noprov.yaml')
    writeFileSync(noProviders, 'hello: world\n', 'utf8')
    const result = settings.setConfigFile(noProviders)
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('没有 providers 段')
  })

  test('被拒之后偏好没动（拒绝是干净的）', () => {
    expect(settings.prefs().configFile).toBe('')
    expect(configFileField()?.text).toBe(DEFAULT_CONFIG_FILE)
  })
})

describe('② 合法文件：换得成、偏好落盘、运行期端点热更', () => {
  /** 这一组换上去的那份文件。 */
  const good = join(DSC_HOME, '..', 'good.yaml')

  beforeAll(() => {
    writeYaml(good, 'good')
  })

  test('合法文件换得成，回执里带路径', () => {
    const result = settings.setConfigFile(good)
    expect(result.ok).toBe(true)
    expect(String(result.notice)).toContain(good)
  })

  test('偏好落盘了（设置服务交回来的就是那一份）', () => {
    expect(settings.prefs().configFile).toBe(good)
  })

  test('活动配置立刻变成那一份（不用重启）：那一行的文案跟着换', () => {
    expect(configFileField()?.text).toBe(good)
  })

  test('运行期端点清单也跟着热更（reloadLive）：当前模型指到新配置的默认端点', () => {
    expect(llmService.provider).toBe('good')
    expect(llmService.model).toBe('m')
  })

  test('换过之后「更换」与「恢复默认」两个动作都在', () => {
    const ids = (configFileField()?.actions ?? []).map((action) => action.id)
    expect(ids).toContain('switch-config-file')
    expect(ids).toContain('reset-config-file')
  })
})

describe('③ 空串 = 恢复出厂那份', () => {
  test('恢复成功，那一行回到出厂路径', () => {
    const result = settings.setConfigFile('')
    expect(result.ok).toBe(true)
    expect(configFileField()?.text).toBe(DEFAULT_CONFIG_FILE)
  })

  test('恢复之后偏好也清空', () => {
    expect(settings.prefs().configFile).toBe('')
  })

  test('没换过时「恢复默认」这条动作不再出现（点它等于原地不动）', () => {
    const ids = (configFileField()?.actions ?? []).map((action) => action.id)
    expect(ids).toContain('switch-config-file')
    expect(ids).not.toContain('reset-config-file')
  })
})

describe('④ 接线：桥放行、界面通道排除、宿主方法白名单', () => {
  test('原生桥放行 setConfigFile 与 pickConfigFile', () => {
    expect(validateNativeCall('setConfigFile', ['C:\\x.yaml']).ok).toBe(true)
    expect(validateNativeCall('pickConfigFile', []).ok).toBe(true)
  })

  test('setConfigFile 只收一条路径：多个实参被拒，非字符串被拒', () => {
    expect(validateNativeCall('setConfigFile', ['a.yaml', 'b.yaml'])).toMatchObject({ ok: false })
    expect(validateNativeCall('setConfigFile', [123])).toMatchObject({ ok: false })
  })

  test('pickConfigFile 不收任何实参（路径只能由对话框给）', () => {
    expect(validateNativeCall('pickConfigFile', ['C:\\x.yaml'])).toMatchObject({ ok: false })
  })

  test('界面通道排除 setConfigFile（写类入口只走原生桥）', () => {
    expect(isUiMethod('setConfigFile')).toBe(false)
    expect(isUiMethod('pickConfigFile')).toBe(false)
  })

  test('宿主方法白名单里有 setConfigFile（桌面端调得到）', () => {
    expect(isInvokableMethod('setConfigFile')).toBe(true)
  })

  test('桥的协议版本没涨（加操作不涨，改语义才涨）', () => {
    // 这一条钉的是协议契约本身：换文件只是加了一条 op，版本号仍是 3。
    expect(NATIVE_BRIDGE_VERSION).toBe(3)
  })
})
