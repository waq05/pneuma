/**
 * @pneuma/dock-browser 的包级测试：装配面、包形态、插件对象、两个工具的注册面与文档。
 *
 * 为什么只钉这些：这个包对外只有插件对象与两条工具；真驱动侧栏浏览器要桌面壳，留在集成探针。
 *
 * 迁移说明（F 批）：旧文件用 `node:test` + `node:assert`，入口从 `lib/packages/dock-browser/
 * index.js`（构建产物）装载；现在换成 Vitest 的 `test` + `expect`，直接 import 源码
 * `../index.js`。装配行改成解析 YAML 后按字段比对。新增一条真跑 `apply()` 的注册面：
 * 两个工具的名字、风险档与必填参数从注册表上取；`browser_dock_look` 在没有桌面壳的宿主里
 * 真调一次，必须是「报一句人话」而不是静默返回内容——旧文件只断言了入口对象存在。
 *
 * 环境隔离：`resolvePluginConfig` 读 `DSC_HOME` 下的 `plugins.json`，`hostT` 的取词也走
 * 配置里的语言，所以先把 `DSC_HOME` 指到 `mkdtempSync` 的临时目录再动态 import。
 *
 * @module @pneuma/dock-browser/tests
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeAll, expect, test } from 'vitest'
import YAML from 'yaml'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type?: string
  exports?: Record<string, unknown>
  pneuma?: { library?: boolean; bundle?: { patch?: string } }
}

/** cordis.patch.yml 的形状：顶层是若干 `{ insert: [...] }`。 */
interface PatchDoc {
  insert?: { id?: string; name?: string }[]
}

/** 工具参数的 JSON Schema 里本文件比得到的两项。 */
interface ToolSchema {
  required?: string[]
  properties?: Record<string, { enum?: string[] }>
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

const home = mkdtempSync(join(tmpdir(), 'dsc-dock-browser-spec-'))
let mod: typeof import('../index.js')

beforeAll(async () => {
  process.env.DSC_HOME = home
  mod = await import('../index.js')
})

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/dock-browser', () => {
  const doc = YAML.parse(read('../cordis.patch.yml')) as PatchDoc[]
  expect(Array.isArray(doc)).toBe(true)
  expect(doc).toHaveLength(1)
  const rows = doc[0]?.insert
  expect(rows, '装配行应恰好一条 insert').toHaveLength(1)
  expect(rows?.[0]?.id, '装配行的 id 必须正好是 dock-browser').toBe('dock-browser')
  expect(rows?.[0]?.name, "装配行的 name 必须是 '@pneuma/dock-browser'").toBe('@pneuma/dock-browser')
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], 'exports 必须有 "."').toBeDefined()
  expect(pkg.exports?.['./package.json'], 'exports 必须有 "./package.json"').toBeDefined()
  expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma?.library, '功能包不该标成库包').not.toBe(true)
})

// 入口真能加载：入口恰好一个 *Plugin 对象，插件名 = 包名去掉 @pneuma/ = 装配行的 id。
test('入口能加载，插件名与 apply 对得上', () => {
  const keys = Object.keys(mod).filter((key) => /Plugin$/.test(key))
  expect(keys.length, '入口应当恰好导出一个 *Plugin 对象').toBe(1)
  const plugin = mod.dockBrowserPlugin
  expect(typeof plugin).toBe('object')
  expect(typeof plugin.name).toBe('string')
  expect(plugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(plugin.name).toBe('dock-browser')
  expect(plugin.inject).toEqual(['tools', 'settings'])
  expect(typeof plugin.apply).toBe('function')
})

// 注册面：两个工具都在，动手档 exec、只读档 read，且只读工具声明了「会等人」。
test('apply 注册 browser_dock（exec）与 browser_dock_look（read、等人）两个工具', async () => {
  const tools = new Map<string, ToolEntry>()
  let section: SettingsSectionSpec | undefined
  const fakeCtx = {
    get: () => undefined,
    emit: () => {},
    provide: () => () => {},
    tools: {
      register: (entry: ToolEntry) => {
        tools.set(entry.name, entry)
        return () => {}
      },
    },
    settings: {
      registerSection: (spec: SettingsSectionSpec) => {
        section = spec
        return () => {}
      },
    },
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  ;(mod.dockBrowserPlugin.apply as unknown as (ctx: unknown) => void)(fakeCtx)

  const act = tools.get('browser_dock')
  const look = tools.get('browser_dock_look')
  expect(act, '没注册 browser_dock').toBeDefined()
  expect(look, '没注册 browser_dock_look，模型就拿不到 ref').toBeDefined()
  expect(act?.risk).toBe('exec')
  expect((act?.parameters as ToolSchema).required).toEqual(['action'])
  expect((act?.parameters as ToolSchema).properties?.action?.enum).toContain('evaluate')
  // 只读档恒为 read（所有权限档都放行到执行），人批在 run 里自己做。
  expect(look?.risk).toBe('read')
  expect((look?.parameters as ToolSchema).required).toEqual(['action'])
  expect((look?.parameters as ToolSchema).properties?.action?.enum).toEqual([
    'views',
    'snapshot',
    'screenshot',
    'console',
    'network',
    'wait_for',
  ])
  // 默认配置下「看一眼」要逐次审批，所以声明 waitsForHuman（PTC 脚本时限不算等人的时间）。
  expect(look?.waitsForHuman).toBe(true)
  expect(section?.id).toBe('dock-browser')
  expect(section?.order).toBe(35)

  // 没有桌面壳（宿主里没有 hostBrowser 服务）时，只读工具必须报一句人话，不许静默返回内容。
  const runCtx = {
    cwd: home,
    signal: new AbortController().signal,
    sessionId: 'dock-browser-spec',
    sessionPath: join(home, 'session.jsonl'),
  }
  await expect(look?.run({ action: 'views' }, runCtx)).rejects.toThrow('没有桌面壳')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})
