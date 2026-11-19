/**
 * 插件清单本地化的「接线」集成用例（原 `scripts/plugin-locale-test.mjs` 的第 [5] 段）。
 *
 * 原第 [5] 段是 5 条源码文本断言（`readSource('src/core/plugin-loader.ts')` 里找
 * `pluginDisplayOf(`、`const rowName = display.title` 这些字面量）。那是**写法**不是行为：
 * 改个变量名就假红，逻辑改坏了但字面量还留着就假绿。这里改成两条行为断言：
 *
 *   1. 起真内核、`config.yaml` 写 `language: en` → 插件中心里那一行显示英文标题；
 *   2. `numa plugin list` 在同一个语言设置下也显示英文，切回默认显示中文。
 *
 * 两条合起来才是原第 [5] 段想钉的东西：loader 与 CLI 都真的走了 `pluginDisplayOf`
 * 这条取值路径，而不是各读各的清单原文。
 *
 * ## 隔离
 *
 * `tempHome()` 必须在任何内核模块被加载之前调用（`DSC_HOME` 是 `path-policy.ts:23` 的
 * 模块级常量），所以内核模块一律 `await import()`。`config.yaml` 要在 `bootKernel` 之前
 * 铺好：harness 只在文件不存在时才写默认配置。
 *
 * @module dsc/tests/integration/plugin-locale.int.spec
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, runCli, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录；内核的 `DSC_HOME` 由它派生。 */
const home = tempHome('dsc-plugin-locale-int-')
/** CLI 那一半的 `DSC_HOME` 根：两次调用的语言设置不能互相踩。 */
const CLI_HOME = join(home.home, 'cli')

/** 中文原文与英文译本的标题（`src/packages/plugin-manager`）。 */
const ZH_TITLE = '插件管理'
const EN_TITLE = 'Plugin manager'

let llm: FakeLLM
let kernel: BootedKernel
/** 插件中心里的行视图。 */
let infos: Array<{ file: string; name: string; description: string }>

beforeAll(async () => {
  // 先铺配置：language: en，其余字段给内核默认值。
  mkdirSync(join(home.home, '.dsc'), { recursive: true })
  writeFileSync(join(home.home, '.dsc', 'config.yaml'), 'model:\n  name: test\nlanguage: en\n', 'utf8')

  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  const registry = (await import('@pneuma/runtime/core/plugin-registry.js')) as {
    listPluginInfos: () => Array<{ file: string; name: string; description: string }>
  }
  infos = registry.listPluginInfos()
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

describe('① 内核侧：插件中心的行标题跟着 config.yaml 的 language 走', () => {
  test('language: en 时显示英文译本', () => {
    const row = infos.find((item) => item.file === 'plugin-manager')
    expect(row).toBeDefined()
    expect(row?.name).toBe(EN_TITLE)
    expect(row?.description).toBe('List, toggle and install local or remote plugins; writes are approved first')
  })

  test('其它行也一起切了（不是只给一行开了后门）', () => {
    // 至少还有一行拿到英文：说明翻译是按语言整批生效的。
    const translated = infos.filter((item) => /^[A-Za-z]/.test(item.name))
    expect(translated.length).toBeGreaterThan(1)
  })
})

describe('② CLI 侧：numa plugin list 与内核走同一条取值路径', () => {
  /** 跑一次 `plugin list`；`dscHome` 决定这次的语言设置。 */
  async function listWith(dscHome: string): Promise<string> {
    const result = await runCli(['plugin', 'list'], {
      env: { DSC_HOME: dscHome, DSC_PROFILE: '', DSC_UI_SERVER: '0' },
      timeoutMs: 120_000,
    })
    expect(result.code).toBe(0)
    return result.stdout
  }

  /** 铺一份只有语言设置的 `DSC_HOME`。 */
  function makeDscHome(name: string, language: string | null): string {
    const dir = join(CLI_HOME, name)
    mkdirSync(dir, { recursive: true })
    const lines = ['model:', '  name: test']
    if (language !== null) lines.push(`language: ${language}`)
    writeFileSync(join(dir, 'config.yaml'), `${lines.join('\n')}\n`, 'utf8')
    return dir
  }

  test('language: en → 行标题是英文', async () => {
    const stdout = await listWith(makeDscHome('en', 'en'))
    expect(stdout).toContain(EN_TITLE)
    expect(stdout).not.toContain(ZH_TITLE)
  })

  test('没配 language → 行标题回到中文原文', async () => {
    const stdout = await listWith(makeDscHome('zh', null))
    expect(stdout).toContain(ZH_TITLE)
    expect(stdout).not.toContain(EN_TITLE)
  })
})
