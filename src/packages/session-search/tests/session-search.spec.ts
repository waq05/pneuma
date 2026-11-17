/**
 * @pneuma/session-search 的包级测试：装配面、包形态、入口、文档、切词/分组两条纯逻辑，
 * 外加一次真跑 `apply()` 的注册面（工具、命令、设置分区、服务）。
 *
 * 为什么只钉这些：索引本体要会话与磁盘，留在集成探针里；能便宜钉住的是装配面与切词证据。
 *
 * 迁移说明（F 批）：旧文件用 `node:test` + `node:assert`，三个入口都从 `lib/packages/
 * session-search/`（构建产物）装载。现在换成 Vitest 的 `test` + `expect`，直接 import 源码
 * `../index.js` 与 `../session-index.js`；装配行改成解析 YAML 后按字段比对。新增第 7 条：
 * 用假 ctx 真跑 `apply()`，从注册表上取回工具名/风险/必填、命令名、分区 id 与 order、
 * 以及 `sessionSearch` 服务——旧文件只断言了入口对象存在，改名、漏注册都拦不住。
 *
 * 环境隔离：`defaultSessionIndexOptions()` 用 `dscPath('cache')`，而路径策略在模块加载时算
 * `DSC_HOME`，所以先把它指到 `mkdtempSync` 的临时目录，再动态 import；apply 期间的回填与
 * 索引文件都只落在这个临时目录里。
 *
 * @module @pneuma/session-search/tests
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SettingsSectionSpec, SessionSearchService } from '@pneuma/runtime/services/types.js'
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

/** 命令注册表收到的规格（只取本文件要比的三项）。 */
interface CommandSpec {
  name: string
  args?: string
  description?: string
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

const home = mkdtempSync(join(tmpdir(), 'dsc-session-search-spec-'))
let mod: typeof import('../index.js')
let idx: typeof import('../session-index.js')

beforeAll(async () => {
  process.env.DSC_HOME = home
  mod = await import('../index.js')
  idx = await import('../session-index.js')
})

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/session-search', () => {
  const doc = YAML.parse(read('../cordis.patch.yml')) as PatchDoc[]
  expect(Array.isArray(doc)).toBe(true)
  expect(doc).toHaveLength(1)
  const rows = doc[0]?.insert
  expect(rows, '装配行应恰好一条 insert').toHaveLength(1)
  expect(rows?.[0]?.id, '装配行的 id 必须正好是 session-search').toBe('session-search')
  expect(rows?.[0]?.name, "装配行的 name 必须是 '@pneuma/session-search'").toBe('@pneuma/session-search')
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], 'exports 必须有 "."').toBeDefined()
  expect(pkg.exports?.['./package.json'], 'exports 必须有 "./package.json"').toBeDefined()
  if (pkg.pneuma?.library === true) {
    expect(pkg.pneuma?.bundle, '库包不该有 bundle.patch').toBeUndefined()
  } else {
    expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  }
})

// 入口真能加载：插件名 = 包名最后一段 = 装配行的 id。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof mod.sessionSearchPlugin).toBe('object')
  expect(typeof mod.sessionSearchPlugin.name).toBe('string')
  expect(mod.sessionSearchPlugin.name).toBe(pkg.name.split('/').pop())
  expect(mod.sessionSearchPlugin.name).toBe('session-search')
  expect(typeof mod.sessionSearchPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})

// 切词：建索引时中文逐字记 1-gram，查询单字才搜得到；两字以上查询只取相邻 2-gram。
test('中文切词：索引带单字，查询按相邻两字，不会拿单字凑命中', () => {
  expect(idx.documentTerms('内存').sort()).toEqual(['内', '存', '内存'].sort())
  expect(idx.queryTerms('内存')).toEqual(['内存'])
  expect(idx.queryTerms('存')).toEqual(['存'])
})

// 宽松召回：长中文段按相邻两字分组、命中过半即算，短段仍要求全中（不放宽）。
test('查询分组：长段过半、短段全中，只有长段才可放宽', () => {
  const groups = idx.queryGroups('内存占用过高')
  expect(groups).toHaveLength(1)
  expect(groups[0]?.terms).toEqual(['内存', '存占', '占用', '用过', '过高'])
  expect(groups[0]?.need).toBe(3)
  expect(idx.relaxable(groups)).toBe(true)
  const short = idx.queryGroups('内存')
  expect(short).toEqual([{ terms: ['内存'], need: 1 }])
  expect(idx.relaxable(short)).toBe(false)
})

// 注册面：apply 之后工具、命令、设置分区、服务四样都在，且名字/风险/顺序与装配契约一致。
test('apply 注册 session_search 工具、/search 命令、设置分区与 sessionSearch 服务', () => {
  let tool: ToolEntry | undefined
  let command: CommandSpec | undefined
  let section: SettingsSectionSpec | undefined
  let service: SessionSearchService | undefined
  const fakeCtx = {
    get: () => undefined,
    emit: () => {},
    transcript: { system: () => {} },
    session: { current: () => ({ meta: { cwd: home } }) },
    provide: (name: string, value: SessionSearchService) => {
      expect(name).toBe('sessionSearch')
      service = value
      return () => {}
    },
    tools: {
      register: (entry: ToolEntry) => {
        tool = entry
        return () => {}
      },
    },
    commands: {
      register: (spec: CommandSpec) => {
        command = spec
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
  const dispose = (mod.sessionSearchPlugin.apply as unknown as (ctx: unknown) => () => void)(fakeCtx)
  expect(tool, '没注册 session_search 工具').toBeDefined()
  expect(tool?.name).toBe('session_search')
  expect(tool?.risk).toBe('read')
  expect(tool?.parameters?.required).toEqual(['query'])
  expect(command?.name).toBe('search')
  expect(section?.id).toBe('session-search')
  expect(section?.order).toBe(47)
  expect(service, '没提供 sessionSearch 服务').toBeDefined()
  expect(typeof service?.search).toBe('function')
  expect(typeof service?.rebuild).toBe('function')
  expect(typeof service?.stats).toBe('function')
  // 收摊：后台回填不该继续写临时目录（dispose 同时让 disposed 生效）。
  dispose()
})
