/**
 * @pneuma/skills 的包级测试：插件对象、skill 工具、/skills 与每个技能的命令、目录文本。
 *
 * 原测试 6 条 check() 里 4 条读 `index.ts` 源码文本（`name: 'skill'`、`RESERVED_COMMANDS`
 * 那一行、`DESCRIPTION_LIMIT = 500` 等）。现在改成假 ctx 真跑 `apply()`，把技能文件铺在
 * `mkdtempSync` 的临时 DSC_HOME 下，等 `refresh()` 扫完，再从注册出来的工具 / 命令 /
 * 目录文本上断言。
 *
 * 「九个内置命令名不许被技能占用」原来靠正则抠 `const RESERVED_COMMANDS` 那一行；
 * 现在把九个名字都做成真技能目录，断言它们的 `/名字` 命令一条都没注册——同名冲突
 * 只有走真注册流程才验得对。
 *
 * @module @pneuma/skills/tests
 */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

/** 捕获到的工具声明。 */
interface CapturedTool {
  name: string
  description: string
  risk: string
  parameters: { properties: Record<string, { type?: string }>; required?: string[] }
}

/** 捕获到的命令声明。 */
interface CommandSpec {
  name: string
  args?: string
  description?: string
}

/** skills 服务在测试里用得到的面。 */
interface ServiceView {
  catalogText: () => string
  list: () => Array<{ name: string; enabled: boolean }>
  read: (name: string) => Promise<{ ok: boolean; skill?: { content: string } }>
}

/** 一次 apply 捕获到的东西。 */
interface Harness {
  tools: CapturedTool[]
  commands: CommandSpec[]
  service: ServiceView
}

const home = mkdtempSync(join(tmpdir(), 'dsc-skills-spec-'))
const dscHome = join(home, '.dsc')
const skillsDir = join(dscHome, 'skills')
const workspace = mkdtempSync(join(tmpdir(), 'dsc-skills-cwd-'))
/** 内置命令名：技能占用了它们，用户输入 /help 就分不清是技能还是内置命令。 */
const RESERVED = ['new', 'resume', 'compact', 'model', 'help', 'exit', 'effort', 'plugins', 'skills']
/** 长描述：目录里单条说明必须截到 500 字。 */
const LONG_DESCRIPTION = '长描述'.repeat(200)

let skillsPlugin: typeof import('../index.js')['skillsPlugin']

/** 铺一个技能目录：`<skillsDir>/<name>/SKILL.md`。 */
function writeSkill(name: string, frontmatter: string[]): void {
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), ['---', `name: ${name}`, ...frontmatter, '---', `正文：${name}`].join('\n'), 'utf8')
}

beforeAll(async () => {
  process.env.DSC_HOME = dscHome
  process.env.DSH_HOME = join(home, '.dsh')
  process.env.HOME = home
  process.env.USERPROFILE = home
  mkdirSync(skillsDir, { recursive: true })
  writeSkill('alpha', ['description: Alpha 技能', 'when-to-use: 写代码之前'])
  // 不进模型目录，但用户仍能 /beta 调用。
  writeSkill('beta', ['description: Beta 只能人调', 'disable-model-invocation: true'])
  writeSkill('long', [`description: ${LONG_DESCRIPTION}`])
  for (const name of RESERVED) writeSkill(name, [`description: 占用内置命令名 ${name}`])

  ;({ skillsPlugin } = await import('../index.js'))
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

/** 假 ctx：apply 用到的面都实现；`effect` 真跑回调，否则注册不会发生。 */
function runApply(): Harness {
  const harness: Harness = {
    tools: [],
    commands: [],
    service: { catalogText: () => '', list: () => [], read: async () => ({ ok: false }) },
  }
  const ctx = {
    tools: {
      register: (entry: CapturedTool) => {
        harness.tools.push(entry)
        return () => {}
      },
    },
    commands: {
      register: (spec: CommandSpec) => {
        harness.commands.push(spec)
        return () => {}
      },
    },
    transcript: { system: () => {} },
    session: { current: () => ({ meta: { cwd: workspace, id: 'spec-session' } }) },
    provide: (_name: string, service: ServiceView) => {
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
  // 假 ctx 只实现 apply 用到的面；真实 Context 的字段远多于它。
  skillsPlugin.apply(ctx as unknown as Context, undefined)
  return harness
}

/** 等异步 refresh 扫完：目录文本里出现 alpha 就说明这一轮扫过了。 */
async function appliedAndScanned(): Promise<Harness> {
  const harness = runApply()
  await vi.waitFor(() => expect(harness.service.catalogText()).toContain('alpha'))
  return harness
}

// 第 1 条：插件对象本体——名字、提供服务、四个注入。
test('插件对象：名字、提供服务、四个注入', () => {
  expect(skillsPlugin.name).toBe('skills')
  expect(skillsPlugin.provide).toBe('skills')
  expect([...(skillsPlugin.inject as string[])]).toStrictEqual(['session', 'tools', 'commands', 'transcript'])
  expect(typeof skillsPlugin.apply).toBe('function')
})

// 第 2 条：skill 工具只读，只有 name 必填，说明里指路 <available_skills>。
test('工具叫 skill，只读，只有 name 必填', () => {
  const harness = runApply()
  const tool = harness.tools.find((entry) => entry.name === 'skill')
  expect(tool, 'apply 应当注册 skill 工具').toBeDefined()
  expect(tool?.risk).toBe('read')
  expect(tool?.parameters.required).toStrictEqual(['name'])
  expect(tool?.parameters.properties['name']?.type).toBe('string')
  expect(tool?.description).toContain('<available_skills>')
})

// 第 3 条：/skills 固定命令注册在命令表里。
test('/skills 固定命令注册在命令表里', async () => {
  const harness = await appliedAndScanned()
  const command = harness.commands.find((entry) => entry.name === 'skills')
  expect(command, '/skills 应当注册').toBeDefined()
  expect(command?.args).toBe('')
  expect(command?.description).toContain('查看技能清单')
})

// 第 4 条：每个 user-invocable 的技能各注册一条 /技能名，参数是 [需求]。
test('每个可调用技能再注册一条 /技能名，参数是 [需求]', async () => {
  const harness = await appliedAndScanned()
  const alpha = harness.commands.find((entry) => entry.name === 'alpha')
  expect(alpha, 'alpha 应当有 /alpha 命令').toBeDefined()
  expect(alpha?.args).toBe('[需求]')
  // beta 不进模型目录，但人是可调用的：命令必须有。
  expect(harness.commands.find((entry) => entry.name === 'beta')).toBeDefined()
})

// 第 5 条：九个内置命令名被技能占用时，一条 /名字 都不许注册。
// `skills` 是唯一例外：它本来就有一条固定的 /skills 清单命令，占用它的技能不能把那条顶掉，
// 所以这里断言「只出现一次，且还是固定命令（args 为空串）」。
test('九个内置命令名不许被技能占用', async () => {
  const harness = await appliedAndScanned()
  const registered = harness.commands.map((entry) => entry.name)
  for (const name of RESERVED) {
    if (name === 'skills') continue
    expect(registered, `占用内置命令名 ${name} 的技能不该注册 /${name}`).not.toContain(name)
  }
  const fixed = harness.commands.filter((entry) => entry.name === 'skills')
  expect(fixed, '/skills 只该有固定命令那一条').toHaveLength(1)
  expect(fixed[0]?.args).toBe('')
})

// 第 6 条：目录文本形态——带 <available_skills> 包裹，模型不可调用的不进，描述截到 500。
test('目录形态是 <available_skills>，描述截到 500 字', async () => {
  const harness = await appliedAndScanned()
  const catalog = harness.service.catalogText()
  expect(catalog).toContain('<available_skills>')
  expect(catalog).toContain('</available_skills>')
  expect(catalog).toContain('`alpha`')
  expect(catalog, 'disable-model-invocation 的技能不该进目录').not.toContain('`beta`')
  // whenToUse 进目录：它是模型挑技能的关键信号。
  expect(catalog).toContain('（何时用：写代码之前）')
  // 600 字的说明只留前 500 字，后面补省略号——不能整段塞进系统提示。
  expect(catalog).toContain(`${LONG_DESCRIPTION.slice(0, 500)}…`)
  expect(catalog).not.toContain(LONG_DESCRIPTION)
})
