/**
 * skills 插件装配面的补盲（`packages/skills/index.ts`）：`skill` 工具的坏输入与停用分支、
 * 外部提供方的拉取/取正文失败、市场浏览与安装的错误分支、`/skills` 与 `/技能名` 命令、
 * 自定义发现目录、会话切换时的重扫节流。
 *
 * `skills.spec.ts` 覆盖的是目录形态、工具/命令注册与内置命令名占用；这一份只补失败路径
 * 与外部扩展点。技能文件铺在临时 `DSC_HOME` 下，`settings.json` 的市场源清空后
 * 由本文件自己注册假市场，绝不联网。
 *
 * @module dsc/packages/skills/tests/wiring-extra.spec
 */
import type { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolEntry } from '@pneuma/runtime/core/tools.js'
import type { SkillDefinition, SkillSummary } from '@pneuma/runtime/core/skills.js'
import type { SkillMarketProvider, SkillProvider, SkillService } from '@pneuma/runtime/services/types.js'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'

const TMP = mkdtempSync(join(tmpdir(), 'dsc-skills-wiring-'))
process.env['DSC_HOME'] = join(TMP, '.dsc')
process.env['HOME'] = TMP
process.env['USERPROFILE'] = TMP
// `DSH_HOME` 必须一起隔离：技能发现根里有 `dshSkillsDir()`（src/core/skills.ts:197），
// 它读 `DSH_HOME`，没设就落到 `~/.dsh/skills`。本机 `~/.dsh/skills` 真有技能时，
// 「一个技能都没有」那条用例的目录永远清不空，`waitFor` 空转 5 秒后超时——同一份
// 代码在别人机器上绿、在这台机器上红，与合并无关（2026-11-17 复查实测：隔离后 9/9 通过）。
process.env['DSH_HOME'] = join(TMP, '.dsh')
const DSH = join(TMP, '.dsc')
const SKILLS = join(DSH, 'skills')
const WORK = mkdtempSync(join(tmpdir(), 'dsc-skills-wiring-cwd-'))
const CONFIG_YAML = join(DSH, 'config.yaml')
const SETTINGS_JSON = join(DSH, 'settings.json')
const SKILLS_JSON = join(DSH, 'skills.json')

type SkillsModule = typeof import('../index.js')
let skillsPlugin: SkillsModule['skillsPlugin']

interface CommandEntry {
  spec: { name: string; args?: string; description?: string }
  handler: (input: { args: string[]; runtime: { submit: (text: string) => void }; ui: { notice: (text: string) => void; openSkills?: () => void } }) => unknown
}

interface Harness {
  tools: Map<string, ToolEntry>
  commands: Map<string, CommandEntry>
  service: SkillService
  transcript: string[]
  emitted: string[]
  handlers: Map<string, Array<() => void>>
  cwd: { value: string }
}

function writeSkill(dir: string, name: string, frontmatter: string[] = []): void {
  const target = join(dir, name)
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} 的技能`, ...frontmatter, '---', `正文：${name}`].join('\n'),
    'utf8',
  )
}

async function mount(): Promise<Harness> {
  const tools = new Map<string, ToolEntry>()
  const commands = new Map<string, CommandEntry>()
  const transcript: string[] = []
  const emitted: string[] = []
  const handlers = new Map<string, Array<() => void>>()
  const cwd = { value: WORK }
  let service: SkillService | undefined
  const ctx = {
    effect(fn: () => unknown) {
      const result = fn()
      return typeof result === 'function' ? result : () => undefined
    },
    tools: {
      register(entry: ToolEntry) {
        tools.set(entry.name, entry)
        return () => undefined
      },
    },
    commands: {
      register(spec: CommandEntry['spec'], handler: CommandEntry['handler']) {
        commands.set(spec.name, { spec, handler })
        return () => {
          commands.delete(spec.name)
        }
      },
    },
    transcript: { system: (text: string) => transcript.push(text) },
    session: { current: () => ({ meta: { cwd: cwd.value, id: 'skills-wiring' } }) },
    provide(_name: string, value: SkillService) {
      service = value
    },
    on(event: string, handler: () => void) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => undefined
    },
    emit(event: string) {
      emitted.push(event)
      for (const handler of handlers.get(event) ?? []) handler()
    },
  }
  skillsPlugin.apply(ctx as unknown as Context, undefined)
  if (service === undefined) throw new Error('apply 没有 provide skills 服务')
  const harness: Harness = { tools, commands, service, transcript, emitted, handlers, cwd }
  await vi.waitFor(() => expect(harness.service.catalogText()).toContain('alpha'))
  return harness
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const skillTool = (harness: Harness): ToolEntry => {
  const tool = harness.tools.get('skill')
  if (tool === undefined) throw new Error('没有注册 skill 工具')
  return tool
}

beforeEach(() => {
  mkdirSync(SKILLS, { recursive: true })
  // 每个用例从干净的停用清单 / 市场源开始；上一个用例删掉的自定义配置也清掉。
  writeFileSync(SKILLS_JSON, JSON.stringify({ version: 1, disabled: [] }), 'utf8')
  writeFileSync(SETTINGS_JSON, JSON.stringify({ version: 1, marketSources: [] }), 'utf8')
  if (existsSync(CONFIG_YAML)) unlinkSync(CONFIG_YAML)
  writeSkill(SKILLS, 'alpha')
  writeSkill(SKILLS, 'beta')
})

beforeAll(async () => {
  ;({ skillsPlugin } = await import('../index.js'))
})

afterAll(() => {
  delete process.env['DSC_HOME']
  delete process.env['DSH_HOME']
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('skill 工具：缺 name / 名字不存在 / 正常加载带 location', async () => {
  const harness = await mount()
  const tool = skillTool(harness)
  const run = (args: Record<string, unknown>): Promise<string> => tool.run(args, { cwd: WORK } as never) as Promise<string>
  expect(await run({})).toBe('缺少 name 参数')
  expect(await run({ name: '   ' })).toBe('缺少 name 参数')
  expect(await run({ name: 'nope' })).toContain('加载技能失败：没有名为 nope')
  const loaded = await run({ name: 'alpha' })
  expect(loaded).toContain('<skill_content name="alpha">')
  expect(loaded).toContain('正文：alpha')
  expect(loaded).toContain('<skill_location>')
})

test('停用：目录剔除、命令撤掉、工具拒绝；重新启用恢复；未知名字与远端条目不可启停', async () => {
  const harness = await mount()
  const tool = skillTool(harness)
  const disabled = harness.service.setEnabled('alpha', false)
  expect(disabled).toMatchObject({ ok: true, notice: '已停用 alpha' })
  await waitFor(() => !harness.service.catalogText().includes('`alpha`'))
  expect(harness.service.list().find((item) => item.name === 'alpha')?.enabled).toBe(false)
  expect(harness.commands.has('alpha')).toBe(false)
  expect(await tool.run({ name: 'alpha' }, { cwd: WORK } as never)).toContain('已被停用')
  expect(harness.emitted).toContain('dsc/skills-changed')

  expect(harness.service.setEnabled('alpha', true)).toMatchObject({ ok: true, notice: '已启用 alpha' })
  await waitFor(() => harness.service.catalogText().includes('`alpha`'))
  expect(harness.commands.has('alpha')).toBe(true)

  expect(harness.service.setEnabled('nope', true)).toMatchObject({ ok: false, error: '没有名为 nope 的技能' })

  const provider: SkillProvider = {
    name: 'remote',
    rank: 500,
    list: () => [
      { name: 'gamma', description: '远端技能', source: 'remote', rank: 500, modelInvocable: true, userInvocable: true, local: false },
    ],
    get: () => undefined,
  }
  harness.service.registerProvider(provider)
  await waitFor(() => harness.service.list().some((item) => item.name === 'gamma'))
  expect(harness.service.setEnabled('gamma', false)).toMatchObject({
    ok: false,
    error: 'gamma 由插件 remote 提供，不能在技能中心启停',
  })
})

test('外部提供方：拉取失败写日志，get 返回空 / 抛错 / 成功三条分支', async () => {
  const harness = await mount()
  const tool = skillTool(harness)
  const summary = (name: string, rank: number): SkillSummary => ({
    name,
    description: `${name} 的描述`,
    source: 'remote',
    rank,
    modelInvocable: true,
    userInvocable: true,
    local: false,
  })
  const bad: SkillProvider = {
    name: 'bad',
    rank: 501,
    list: () => {
      throw new Error('boom')
    },
    get: () => undefined,
  }
  const ghost: SkillProvider = {
    name: 'ghost-src',
    rank: 502,
    list: () => [summary('ghost', 502)],
    get: () => undefined,
  }
  const thrower: SkillProvider = {
    name: 'thrower',
    rank: 503,
    list: () => [summary('explode', 503)],
    get: () => {
      throw new Error('get爆炸')
    },
  }
  const good: SkillProvider = {
    name: 'good',
    rank: 504,
    list: () => [summary('remote-good', 504)],
    get: () => ({
      ...summary('remote-good', 504),
      content: '远端正文',
    }),
  }
  for (const provider of [bad, ghost, thrower, good]) harness.service.registerProvider(provider)

  await waitFor(() => harness.transcript.some((text) => text.includes('技能源 bad 拉取失败：boom')))
  await waitFor(() => harness.service.list().some((item) => item.name === 'remote-good'))
  expect(String(await tool.run({ name: 'ghost' }, { cwd: WORK } as never))).toContain('ghost-src 里没有 ghost')
  expect(String(await tool.run({ name: 'explode' }, { cwd: WORK } as never))).toContain('加载技能失败：get爆炸')
  const loaded = String(await tool.run({ name: 'remote-good' }, { cwd: WORK } as never))
  expect(loaded).toContain('远端正文')
  expect(loaded).not.toContain('<skill_location>')
})

test('市场：没有配置源 / 未知源 / 插件市场浏览与安装 / 市场抛错', async () => {
  const harness = await mount()
  const empty = await harness.service.browseMarket('')
  expect(empty.error).toContain('没有配置技能市场源')
  expect(empty.sources).toEqual([])

  // 先注册一个坏市场，再注册好市场：未知源与抛错各走一次。
  const broken: SkillMarketProvider = {
    name: 'broken',
    browse: () => {
      throw new Error('市场挂了')
    },
    install: () => '',
  }
  harness.service.registerMarket(broken)
  const failed = await harness.service.browseMarket('broken')
  expect(failed.error).toBe('市场挂了')
  expect(failed.items).toEqual([])
  expect(failed.sources[0]).toMatchObject({ name: 'broken', ok: false })

  const market: SkillMarketProvider = {
    name: 'local-market',
    browse: () => [{ name: 'market-skill', description: '市场技能', source: 'local-market', installed: false }],
    install: async (name) => (name === 'market-skill' ? '装好了' : ''),
  }
  harness.service.registerMarket(market)
  const browsed = await harness.service.browseMarket('local-market', true)
  expect(browsed).toMatchObject({ source: 'local-market' })
  expect(browsed.items[0]?.name).toBe('market-skill')
  expect(await harness.service.installMarketSkill('local-market', 'market-skill')).toMatchObject({
    ok: true,
    notice: '装好了',
  })
  expect(await harness.service.installMarketSkill('local-market', 'silent')).toMatchObject({ ok: true })
  await expect(harness.service.installMarketSkill('nope', 'x')).resolves.toMatchObject({
    ok: false,
    error: '没有名为 nope 的市场源',
  })
  expect(harness.emitted.filter((event) => event === 'dsc/skills-changed').length).toBeGreaterThan(0)

  // 未知源：源清单逐条带 ok:false，items 为空。
  const unknown = await harness.service.browseMarket('missing')
  expect(unknown.error).toContain('没有配置技能市场源')
  expect(unknown.sources.every((item) => item.ok === false)).toBe(true)
})

test('/skills：接了选择器就开浮层，没接就给清单', async () => {
  const harness = await mount()
  const command = harness.commands.get('skills')
  expect(command).toBeDefined()
  let opened = 0
  command?.handler({
    args: [],
    runtime: { submit: () => undefined },
    ui: { notice: () => undefined, openSkills: () => (opened += 1) },
  })
  expect(opened).toBe(1)

  const notices: string[] = []
  command?.handler({
    args: [],
    runtime: { submit: () => undefined },
    ui: { notice: (text: string) => notices.push(text) },
  })
  expect(notices[0]).toContain('技能（')
  expect(notices[0]).toContain('/alpha')
})

test('/技能名：有需求原样带上，没需求给默认流程；技能被删后只回一句打不开', async () => {
  const harness = await mount()
  const command = harness.commands.get('alpha')
  expect(command).toBeDefined()
  const submitted: string[] = []
  const notices: string[] = []
  command?.handler({
    args: [],
    runtime: { submit: (text: string) => submitted.push(text) },
    ui: { notice: (text: string) => notices.push(text) },
  })
  await waitFor(() => submitted.length === 1)
  expect(submitted[0]).toContain('请使用技能 alpha')
  expect(submitted[0]).toContain('（用户没有补充需求，按技能正文的默认流程做）')
  expect(submitted[0]).toContain('<skill_content name="alpha">')

  command?.handler({
    args: ['加', '一个需求'],
    runtime: { submit: (text: string) => submitted.push(text) },
    ui: { notice: (text: string) => notices.push(text) },
  })
  await waitFor(() => submitted.length === 2)
  expect(submitted[1]).toContain('加 一个需求')

  rmSync(join(SKILLS, 'alpha'), { recursive: true, force: true })
  for (const handler of harness.handlers.get('dsc/skills-changed') ?? []) handler()
  await waitFor(() => !harness.service.catalogText().includes('`alpha`'))
  command?.handler({
    args: [],
    runtime: { submit: (text: string) => submitted.push(text) },
    ui: { notice: (text: string) => notices.push(text) },
  })
  await waitFor(() => notices.length > 0)
  expect(notices[0]).toContain('技能 alpha 打不开：')
})

test('会话切换：同一工作区不重扫，换目录才扫；连续变更合并成补跑', async () => {
  const harness = await mount()
  let listCalls = 0
  const provider: SkillProvider = {
    name: 'counter',
    rank: 505,
    list: () => {
      listCalls += 1
      return []
    },
    get: () => undefined,
  }
  harness.service.registerProvider(provider)
  await waitFor(() => listCalls >= 1)

  listCalls = 0
  for (const handler of harness.handlers.get('dsc/session-open') ?? []) handler()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(listCalls, '同一个 cwd 的 session-open 不该重扫').toBe(0)

  harness.cwd.value = mkdtempSync(join(tmpdir(), 'dsc-skills-wiring-cwd2-'))
  for (const handler of harness.handlers.get('dsc/session-open') ?? []) handler()
  await waitFor(() => listCalls >= 1)

  // 等换目录那次 refresh 彻底收尾，再重置计数，否则两次 changed 只会合并成一次补跑。
  await new Promise((resolve) => setTimeout(resolve, 150))
  listCalls = 0
  const changed = harness.handlers.get('dsc/skills-changed') ?? []
  for (const handler of changed) handler()
  for (const handler of changed) handler()
  await waitFor(() => listCalls >= 2)
  expect(listCalls).toBeGreaterThanOrEqual(2)
})

test('config.yaml 的自定义发现目录：只认字符串项，空串与非字符串被丢掉', async () => {
  const harness = await mount()
  const customDir = mkdtempSync(join(tmpdir(), 'dsc-skills-custom-'))
  writeSkill(customDir, 'custom-skill')
  writeFileSync(
    CONFIG_YAML,
    ['skills:', `  - ${JSON.stringify(customDir)}`, '  - 42', '  - ""', 'providers: {}', ''].join('\n'),
    'utf8',
  )
  for (const handler of harness.handlers.get('dsc/skills-changed') ?? []) handler()
  await waitFor(() => harness.service.catalogText().includes('`custom-skill`'))
  expect(harness.service.catalogText()).toContain('`custom-skill`')
  rmSync(customDir, { recursive: true, force: true })
})

test('一个技能都没有：/skills 给出放哪的指引', async () => {
  const harness = await mount()
  // 放最后：清空共享技能目录再恢复，别影响前面的用例。
  try {
    rmSync(SKILLS, { recursive: true, force: true })
    mkdirSync(SKILLS, { recursive: true })
    for (const handler of harness.handlers.get('dsc/skills-changed') ?? []) handler()
    await waitFor(() => harness.service.catalogText() === '')
    const notices: string[] = []
    harness.commands.get('skills')?.handler({
      args: [],
      runtime: { submit: () => undefined },
      ui: { notice: (text: string) => notices.push(text) },
    })
    expect(notices[0]).toContain('还没有技能')
    expect(notices[0]).toContain(SKILLS)
  } finally {
    writeSkill(SKILLS, 'alpha')
    writeSkill(SKILLS, 'beta')
  }
})
