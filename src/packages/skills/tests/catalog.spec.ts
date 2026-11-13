/**
 * skills 包的目录过滤测试：钉住「stale / archived 不进模型可见目录，但仍能被按名字读」。
 *
 * 为什么单独一个文件：过滤逻辑以前写在 buildCatalog 里，只能靠读源码猜它对不对。
 * 现在 `catalogEntries` 是纯函数，直接喂假定义、假停用集合、假档位就能断言四种组合；
 * 「目录过滤、读取不过滤」这条边界则用临时技能目录 + 真 `apply()` 验。
 *
 * 注意这条边界：**只过滤目录文本**，`skill` 工具走的是 service.read，不在过滤范围内。
 *
 * @module @pneuma/skills/tests/catalog
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import type { SkillDefinition, SkillLifecycleState } from '@pneuma/runtime/core/skills.js'

/** 捕获到的工具声明（只需要能调 run）。 */
interface CapturedTool {
  name: string
  run: (args: Record<string, unknown>) => Promise<string>
}

/** 一次 apply 捕获到的东西。 */
interface Harness {
  tools: CapturedTool[]
  commands: Array<{ name: string }>
  service: { catalogText: () => string }
}

const home = mkdtempSync(join(tmpdir(), 'dsc-skills-catalog-'))
const dscHome = join(home, '.dsc')
const skillsDir = join(dscHome, 'skills')
const workspace = mkdtempSync(join(tmpdir(), 'dsc-skills-catalog-cwd-'))

let skillsPlugin: typeof import('../index.js')['skillsPlugin']
let catalogEntries: typeof import('../index.js')['catalogEntries']

/** 假定义：只填过滤用得到的字段。 */
const definition = (name: string, modelInvocable = true): SkillDefinition =>
  ({ name, description: `${name} 的说明`, modelInvocable }) as SkillDefinition

/** 铺一个技能目录。 */
function writeSkill(name: string): void {
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 的说明\n---\n${name} 的正文`, 'utf8')
}

/** 写 `.usage.json`。 */
function writeUsage(text: string): void {
  writeFileSync(join(skillsDir, '.usage.json'), text, 'utf8')
}

beforeAll(async () => {
  process.env.DSC_HOME = dscHome
  process.env.DSH_HOME = join(home, '.dsh')
  process.env.HOME = home
  process.env.USERPROFILE = home
  mkdirSync(skillsDir, { recursive: true })
  writeSkill('alpha')
  writeSkill('stale-one')
  writeSkill('archived-one')
  writeUsage(
    JSON.stringify({ version: 1, skills: { 'stale-one': { state: 'stale' }, 'archived-one': { state: 'archived' } } }),
  )
  ;({ catalogEntries, skillsPlugin } = await import('../index.js'))
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

/** 假 ctx：apply 用到的面都实现；`effect` 真跑回调。 */
function runApply(): Harness {
  const harness: Harness = {
    tools: [],
    commands: [],
    service: { catalogText: () => '' },
  }
  const ctx = {
    tools: {
      register: (entry: CapturedTool) => {
        harness.tools.push(entry)
        return () => {}
      },
    },
    commands: {
      register: (spec: { name: string }) => {
        harness.commands.push(spec)
        return () => {}
      },
    },
    transcript: { system: () => {} },
    session: { current: () => ({ meta: { cwd: workspace, id: 'spec-session' } }) },
    provide: (_name: string, service: Harness['service']) => {
      harness.service = service
      return () => {}
    },
    on: () => () => {},
    effect: (execute: () => unknown) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
    emit: () => {},
  }
  skillsPlugin.apply(ctx as unknown as Context)
  return harness
}

// 第 1 条：stale 与 archived 不出现在目录里，active 出现，disabled 不出现。
test('catalogEntries：stale / archived 被剔除，active 与「没有档位」留下', () => {
  const definitions = ['alpha', 'beta', 'gamma', 'omega', 'silent'].map((name) => definition(name))
  const disabled = new Set(['omega'])
  const lifecycles = new Map<string, SkillLifecycleState>([
    ['alpha', 'active'],
    ['beta', 'stale'],
    ['gamma', 'archived'],
    ['omega', 'active'],
  ])
  const names = catalogEntries(definitions, disabled, lifecycles).map((item) => item.name)
  expect(names).toStrictEqual(['alpha', 'silent'])
})

// 第 2 条：没有档位信息（.usage.json 不存在或坏掉）时照旧全部进目录，别把技能全藏了。
test('catalogEntries：档位表为空时，可调用且启用的技能全部保留', () => {
  const definitions = [definition('alpha'), definition('beta'), definition('gamma', false)]
  const names = catalogEntries(definitions, new Set(), new Map()).map((item) => item.name)
  expect(names).toStrictEqual(['alpha', 'beta'])
})

// 第 3 条：目录只藏 stale/archived，`skill` 工具仍能按名字读出来——两者走的是不同的路径。
// （原测试这里是两条源码文本断言；现在用真技能目录验行为。）
test('目录过滤 stale/archived，但 skill 工具仍能按名字读', async () => {
  const harness = runApply()
  await vi.waitFor(() => expect(harness.service.catalogText()).toContain('alpha'))
  const catalog = harness.service.catalogText()
  expect(catalog).toContain('`alpha`')
  expect(catalog, 'stale 不该进目录').not.toContain('`stale-one`')
  expect(catalog, 'archived 不该进目录').not.toContain('`archived-one`')
  const skillTool = harness.tools.find((tool) => tool.name === 'skill')
  expect(skillTool, 'skill 工具应当注册').toBeDefined()
  const text = await skillTool!.run({ name: 'stale-one' })
  expect(text).toContain('stale-one 的正文')
})

// 第 4 条：档位文件坏掉时当「没有档位」处理：技能不该因为一份遥测文件坏掉而集体消失。
test('档位文件坏掉：技能照常进目录', async () => {
  writeUsage('{ 这不是 JSON')
  const harness = runApply()
  await vi.waitFor(() => expect(harness.service.catalogText()).toContain('alpha'))
  expect(harness.service.catalogText()).toContain('`stale-one`')
  // 恢复真实档位，避免影响同文件内其它用例的语义。
  writeUsage(
    JSON.stringify({ version: 1, skills: { 'stale-one': { state: 'stale' }, 'archived-one': { state: 'archived' } } }),
  )
})
