/**
 * @pneuma/session-title 的包级测试：装配面、包形态、入口、文档，外加 `cleanTitle` 的清洗规则
 * 与 `dsc/turn-end` 监听上的「只认 completed」守卫。
 *
 * 为什么只钉这些：入口只有插件对象与一个纯函数 cleanTitle，起标题本身要会话与模型，留在集成
 * 探针里。最后那条监听守卫是旧文件没测、但 0.6.49 明确要求的行为（后台收工也起名，非正常
 * 收工不起名），这里用「reason 不是 completed 时一次都不读当前会话」来钉。
 *
 * 迁移说明（F 批）：旧文件用 `node:test` + `node:assert`，入口从 `lib/packages/session-title/
 * index.js`（构建产物）装载。现在换成 Vitest 的 `test` + `expect`，直接 import 源码
 * `../index.js`，装配行改成解析 YAML 后按字段比对（改引号/缩进不会假红）。
 *
 * 环境隔离：`Session` 在模块加载时用 `dscPath()` 算出 `.last-session` 路径，所以先把
 * `DSC_HOME` 指到 `mkdtempSync` 的临时目录，再动态 import。
 *
 * @module @pneuma/session-title/tests
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@deepseek-ai/cordis'
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

/** 插件对象里本文件用到的两个字段。 */
type TitlePlugin = Plugin.Object & { inject?: string[] }

const pkg = JSON.parse(read('../package.json')) as PackageJson

const home = mkdtempSync(join(tmpdir(), 'dsc-session-title-spec-'))
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
test('cordis.patch.yml 的装配行认的是 @pneuma/session-title', () => {
  const doc = YAML.parse(read('../cordis.patch.yml')) as PatchDoc[]
  expect(Array.isArray(doc)).toBe(true)
  expect(doc).toHaveLength(1)
  const rows = doc[0]?.insert
  expect(rows, '装配行应恰好一条 insert').toHaveLength(1)
  expect(rows?.[0]?.id, '装配行的 id 必须正好是 session-title').toBe('session-title')
  expect(rows?.[0]?.name, "装配行的 name 必须是 '@pneuma/session-title'").toBe('@pneuma/session-title')
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
  expect(typeof mod.sessionTitlePlugin).toBe('object')
  expect(typeof mod.sessionTitlePlugin.name).toBe('string')
  expect(mod.sessionTitlePlugin.name).toBe(pkg.name.split('/').pop())
  expect(mod.sessionTitlePlugin.name).toBe('session-title')
  expect(typeof mod.sessionTitlePlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})

// 纯函数：模型爱加引号、前缀、think 块；洗完是空就返回 undefined，超长按 40 字截。
test('cleanTitle：洗掉 think 块、引号与「标题：」前缀，空串返回 undefined，超长截到 40', () => {
  expect(mod.cleanTitle('标题：修复登录')).toBe('修复登录')
  expect(mod.cleanTitle('<think>内部推理</think>\n「登录修复」\n')).toBe('登录修复')
  expect(mod.cleanTitle('   ')).toBeUndefined()
  const long = mod.cleanTitle('一'.repeat(60))
  expect(typeof long).toBe('string')
  expect((long ?? '').length).toBe(40)
})

// 监听守卫：turn-end 只有 completed 才起名；带 sessionPath 的载荷直接用它，不读当前会话。
test('apply 监听 dsc/turn-end，且只在 reason === completed 时才去读当前会话', async () => {
  let handler: ((reason: string, signal?: { sessionPath?: string }) => void) | undefined
  let currentCalls = 0
  const fakeCtx = {
    on: (name: string, fn: (reason: string, signal?: { sessionPath?: string }) => void) => {
      expect(name).toBe('dsc/turn-end')
      handler = fn
      return () => {}
    },
    get: () => undefined,
    emit: () => {},
    session: {
      current: () => {
        currentCalls += 1
        return { filePath: join(home, 'current.jsonl'), meta: { id: 'current' }, messages: [] }
      },
      refresh: () => Promise.resolve(),
    },
  }
  ;(mod.sessionTitlePlugin.apply as unknown as (ctx: unknown) => void)(fakeCtx)
  expect(handler).toBeTypeOf('function')

  // 非正常收工（stopped / aborted）：一次都不该碰当前会话。
  handler?.('stopped')
  expect(currentCalls).toBe(0)

  // 收工载荷里带了 sessionPath：直接读那条会话，同样不读当前会话。
  handler?.('completed', { sessionPath: join(home, 'missing.jsonl') })
  expect(currentCalls).toBe(0)
  // 让 generate 的异步尾巴（读盘失败 → 静默）跑完，别把未处理的 rejection 漏到下一个用例。
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(currentCalls).toBe(0)
})
