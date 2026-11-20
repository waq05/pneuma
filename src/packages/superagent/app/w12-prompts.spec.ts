/**
 * 覆盖补齐（W12）：`app/prompts.ts` 的版本化提示词、策略段与技能装配。
 *
 * 这一层决定两个角色每次请求收到什么系统提示：段序、团队覆盖、占位符、版本与审计。
 * 错一处不会抛错，只会让 agent 少一段规则或被旧文本覆盖，所以每条断言都钉住「装配出来的文本与版本记录」。
 * 夹具：真 SQLite 临时库（`Versions` 要落 KV），`Sessions` 只用手写假件。
 *
 * @module @pneuma/superagent/app
 */
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { UserError } from '../core/index.js'
import { SettingsSchema, policyVersion } from '../core/policy.js'
import { KV } from '../kv.js'
import { createTempDir } from '../../../../tests/support/tmp-dir.js'
import { Store } from './store.js'
import {
  PromptConflict, Prompts, TEAM_SECTIONS, builtInBase, builtInPart, builtInParts, composePrompt, composeSkill,
  defaultPrompts, environmentSection, policySection, promptParts, savePrompts, type PromptConfig, type PromptVersion,
} from './prompts.js'
import type { Variable } from './execution-environment.js'

const opened: Store[] = []
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
})

function store() {
  const dir = createTempDir('dsc-sa-prompts-')
  const value = new Store(join(dir, 'orchestrator.sqlite'))
  opened.push(value)
  value.saveSettings(SettingsSchema.parse({ eval: { mode: 'auto' },
    policy: { rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy\nin place' },
      { id: 'off', name: 'Disabled', enabled: false, instruction: 'never' }] } }))
  return value
}
const variables: Variable[] = [
  { key: 'DSH_SUPERAGENT_DIR', value: '/work/t1', description: { zh: '执行目录', en: 'Ticket directory' }, owner: 'executor' },
]

describe('prompts：纯装配函数', () => {
  test('内置段按 key 可查、原型链上的名字不算；内置文本有稳定 base 哈希', () => {
    expect(Object.keys(builtInParts())).toHaveLength(15)
    expect(builtInPart('runtime/shared')?.roles).toEqual(['orchestrator', 'worker'])
    expect(builtInPart('toString')).toBeUndefined()
    expect(builtInPart('skill/feishu')?.placeholders).toBeUndefined()
    expect(builtInBase('hello')).toBe(builtInBase('hello'))
    expect(builtInBase('hello')).not.toBe(builtInBase('hello!'))
  })

  test('执行环境段：有变量时填进模板，等待 setup 时说明还在等', () => {
    const text = environmentSection(defaultPrompts(), variables)
    expect(text).toContain('- DSH_SUPERAGENT_DIR = "/work/t1": Ticket directory.')
    expect(environmentSection(defaultPrompts(), undefined)).toContain('waiting for setup')
    // 团队覆盖模板后仍会填占用位符。
    const overridden: PromptConfig = { ...defaultPrompts(), overrides: { 'runtime/environment': { text: 'ENV {variables}' } } }
    expect(environmentSection(overridden, variables)).toBe('ENV - DSH_SUPERAGENT_DIR = "/work/t1": Ticket directory.')
  })

  test('策略段：列已启用规则（换行压成空格），没有规则时用「只能忽略」的模板', () => {
    const settings = store().settings()
    const section = policySection(settings)
    expect(section.key).toBe('runtime/policy')
    expect(section.text).toContain(`Policy version ${policyVersion(settings)}; accept mode auto.`)
    expect(section.text).toContain('- Copy fixes (copy): Fix copy in place')
    expect(section.text).not.toContain('Disabled')
    const empty = policySection(SettingsSchema.parse({ eval: { mode: 'observe' }, policy: { rules: [] } }))
    expect(empty.key).toBe('runtime/policy/none')
    expect(empty.text).toContain('No rule is enabled')
    expect(empty.text).toContain('accept mode observe')
    // 团队覆盖模板：它自己带的占位符会被填。
    const overridden: PromptConfig = { ...defaultPrompts(), overrides: { 'runtime/policy': {
      text: 'V={version} M={mode}\n{rules}' } } }
    expect(policySection(settings, overridden).text).toBe(`V=${policyVersion(settings)} M=auto\n- Copy fixes (copy): Fix copy in place`)
  })

  test('角色段序：orchestrator 有准入与策略尾段，worker 没有；空团队段被过滤', () => {
    const config = defaultPrompts()
    const orchestrator = promptParts(config, 'orchestrator', 'ENV', { key: 'runtime/policy', text: 'POLICY' })
    expect(orchestrator.map(part => part.name)).toEqual(['runtime/shared', 'runtime/orchestrator', ...TEAM_SECTIONS,
      'runtime/subscriptions', 'runtime/replies', 'runtime/dispatch', 'runtime/admission', 'runtime/handoff',
      'runtime/environment', 'runtime/policy'])
    expect(orchestrator.at(-1)).toMatchObject({ kind: 'generated', key: 'runtime/policy', text: 'POLICY' })
    expect(orchestrator.find(part => part.name === 'runtime/handoff')).toMatchObject({ key: 'runtime/handoff/orchestrator' })
    const worker = promptParts(config, 'worker', 'ENV')
    expect(worker.map(part => part.name)).toEqual(['runtime/shared', 'runtime/worker', ...TEAM_SECTIONS,
      'runtime/subscriptions', 'runtime/replies', 'runtime/work', 'runtime/handoff', 'runtime/environment'])
    // 团队段有内容时带上固定标题；全空的团队段整段消失。
    const withTeam: PromptConfig = { ...config, communication: 'Use Chinese.' }
    expect(promptParts(withTeam, 'worker').find(part => part.name === 'communication'))
      .toEqual({ name: 'communication', kind: 'team', heading: '## Communication', text: '## Communication\nUse Chinese.' })
    const blank: PromptConfig = { ...config, communication: '', scope: '', delivery: '' }
    const names = promptParts(blank, 'worker').map(part => part.name)
    expect(names).not.toContain('communication')
    expect(names).not.toContain('scope')
    expect(names).not.toContain('delivery')
  })

  test('composePrompt 用两个换行连接各段；composeSkill 只给内置技能或团队技能', () => {
    expect(composePrompt(defaultPrompts(), 'worker', 'ENV')).toContain('\n\n')
    expect(composeSkill(defaultPrompts(), 'feishu')).toContain('## CLI usage')
    expect(composeSkill(defaultPrompts(), 'github')).toContain('## CLI usage')
    expect(composeSkill({ ...defaultPrompts(), skills: { my: 'skill body' } }, 'my')).toBe('skill body')
    expect(composeSkill(defaultPrompts(), 'missing')).toBe('')
  })
})

describe('prompts：Prompts 类的校验、预览、保存与历史', () => {
  function prompts(maxChars = 200_000, feishu = false) {
    return new Prompts(store(), () => maxChars, () => variables, () => feishu)
  }

  test('current 在没有保存时是内置默认；version 只认已存在的修订', () => {
    const service = prompts()
    const current = service.current()
    expect(current).toMatchObject({ revision: 0, previousRevision: null, source: 'defaults' })
    expect(current.config).toEqual(defaultPrompts())
    // 修订 0 在第一次保存前解析成内置默认。
    expect(service.version(0).config).toEqual(defaultPrompts())
    expect(() => service.version(3)).toThrow(UserError)
    expect(() => service.version(3)).toThrow(/Unknown prompt revision/)
  })

  test('skills：飞书机器人配置了才注册 Feishu 技能，永远带 GitHub 与团队技能', () => {
    expect(prompts(200_000, false).skills(defaultPrompts()).map(([name]) => name)).toEqual(['github'])
    const config: PromptConfig = { ...defaultPrompts(), skills: { mine: 'body' } }
    expect(prompts(200_000, true).skills(config).map(([name]) => name)).toEqual(['feishu', 'github', 'mine'])
  })

  test('compose：orchestrator 每次按当前 settings 生成策略尾段，worker 没有', () => {
    const service = prompts()
    const orchestrator = service.compose(defaultPrompts(), 'orchestrator')
    expect(orchestrator).toContain('## Policy')
    expect(orchestrator).toContain('- Copy fixes (copy): Fix copy in place')
    expect(service.compose(defaultPrompts(), 'worker')).not.toContain('## Policy')
    // 没有环境变量（setup 未完成）时环境段说明在等待。
    const waiting = new Prompts(service['store'], () => 200_000, () => undefined, () => false)
    expect(waiting.compose(defaultPrompts(), 'worker')).toContain('waiting for setup')
  })

  test('validate：拒绝未知覆盖名、空文本、缺占位符；等于内置文本的覆盖被丢掉', () => {
    const service = prompts()
    const base = defaultPrompts()
    expect(() => service.validate({ ...base, overrides: { nope: { text: 'x' } } })).toThrow(/Unknown built-in prompt part/)
    expect(() => service.validate({ ...base, overrides: { 'runtime/shared': { text: '   ' } } })).toThrow(/cannot be empty/)
    expect(() => service.validate({ ...base, overrides: { 'runtime/environment': { text: 'no placeholder' } } }))
      .toThrow(/must keep/)
    // 覆盖文本与内置一致就等于没改。
    const same = service.validate({ ...base, overrides: { 'runtime/shared': { text: builtInParts()['runtime/shared'].text } } })
    expect(same.overrides).toBeUndefined()
    const changed = service.validate({ ...base, overrides: { 'runtime/shared': { text: 'CUSTOM' } } })
    expect(changed.overrides).toEqual({ 'runtime/shared': { text: 'CUSTOM', base: builtInBase(builtInParts()['runtime/shared'].text) } })
    // 覆盖的 base 可以显式给。
    expect(service.validate({ ...base, overrides: { 'runtime/shared': { text: 'CUSTOM', base: 'given' } } }).overrides)
      .toEqual({ 'runtime/shared': { text: 'CUSTOM', base: 'given' } })
  })

  test('validate：保存版本里有、当前版本已删掉的覆盖不再报错，直接丢掉', () => {
    const service = prompts()
    const config = { ...defaultPrompts(), overrides: { 'runtime/gone': { text: 'x' } } }
    service['store'].set(KV.prompts.version(1), { revision: 1, previousRevision: null, savedAt: '', source: 'panel',
      config } as PromptVersion)
    service['store'].set(KV.prompts.revision, 1)
    expect(service.validate(config).overrides).toBeUndefined()
  })

  test('validate：超过长度上限时拒绝', () => {
    const service = prompts(200)
    expect(() => service.validate(defaultPrompts())).toThrow(/exceeds 200 characters/)
  })

  test('defaultChanged：内置文本变了给出旧文，删掉的段标 removed，没变的段不提', () => {
    const service = prompts()
    const store = service['store']
    const sharedText = builtInParts()['runtime/shared'].text
    const savedBase = builtInBase(sharedText)
    const environmentBase = builtInBase(builtInParts()['runtime/environment'].text)
    store.set(KV.prompts.builtIn('old-base'), 'old built-in text')
    const config: PromptConfig = { ...defaultPrompts(), overrides: {
      'runtime/shared': { text: 'edited', base: 'old-base' },
      'runtime/environment': { text: 'ENV {variables}', base: environmentBase },
      'runtime/removed': { text: 'gone', base: 'x' },
      'skill/feishu': { text: 'no base' },
    } }
    expect(service.defaultChanged(config)).toEqual([
      { part: 'runtime/shared', base: 'old-base', previous: 'old built-in text' },
      { part: 'runtime/removed', base: 'x', removed: true },
    ])
  })

  test('preview 返回两角色的完整文本、分段与技能', () => {
    const preview = prompts(200_000, true).preview(defaultPrompts())
    expect(Object.keys(preview)).toEqual(['orchestrator', 'worker', 'parts', 'skills', 'scope'])
    expect(preview.orchestrator).toContain('## Policy')
    expect(preview.worker).not.toContain('## Policy')
    expect(preview.parts.orchestrator.map(part => part.name)).toContain('runtime/policy')
    expect(Object.keys(preview.skills)).toEqual(['feishu', 'github'])
    expect(preview.scope).toContain('Team sections, skills, and overrides')
  })

  test('save：首次保存先落 revision 0 基线，再写新版本；保存内置文本用于升级对比', () => {
    const service = prompts()
    const store = service['store']
    const config: PromptConfig = { ...defaultPrompts(), communication: 'Speak Chinese',
      overrides: { 'runtime/shared': { text: 'CUSTOM' } } }
    const saved = service.save(config, 0, 'panel')
    expect(saved).toMatchObject({ revision: 1, previousRevision: 0, source: 'panel' })
    expect(service.version(0).config).toEqual(defaultPrompts())
    expect(store.get(KV.prompts.builtIn(builtInBase(builtInParts()['runtime/shared'].text))))
      .toBe(builtInParts()['runtime/shared'].text)
    // 基于旧修订再保存会被拒绝。
    expect(() => service.save(config, 0, 'panel')).toThrow(PromptConflict)
    const next = service.save({ ...config, scope: 'Only copy' }, 1, 'tool')
    expect(next.revision).toBe(2)
  })

  test('history：逐版给出改动字段，legacy 版本只说 legacy，并带 next_offset', () => {
    const service = prompts()
    service.save({ ...defaultPrompts(), communication: 'one' }, 0, 'panel')
    service.save({ ...defaultPrompts(), communication: 'two', skills: { mine: 'body' } }, 1, 'panel')
    const history = service.history()
    expect(history.revisions.map(item => item.revision)).toEqual([2, 1, 0])
    expect(history.revisions[0]!.changed).toContain('communication')
    expect(history.revisions[0]!.changed).toContain('skill/mine')
    expect(history.revisions[1]!.changed).toEqual(['communication'])
    expect(history.revisions[2]!.changed).toEqual([])
    expect(history.next_offset).toBeNull()
    const paged = service.history(0, 1)
    expect(paged.revisions).toHaveLength(1)
    expect(paged.next_offset).toBe(1)
    // 更早的版本不在历史里时没有可比的基准。
    expect(service.history(5, 5).revisions).toEqual([])
  })

  test('history：迁移前的版本只标 legacy 不逐字段比较', () => {
    const service = prompts()
    const store = service['store']
    // 先按真实流程留下 revision 0 基线，再把最新一版改写成迁移前的 legacy 结构。
    service.save({ ...defaultPrompts(), communication: 'one' }, 0, 'panel')
    const legacy: PromptVersion = { revision: 2, previousRevision: 1, savedAt: '', source: 'panel',
      config: defaultPrompts(), legacy: { config: { old: true } } }
    store.set(KV.prompts.version(2), legacy)
    store.set(KV.prompts.revision, 2)
    expect(service.history().revisions[0]!.changed).toEqual(['legacy'])
  })

  test('savePrompts：非工具来源保存时通知主会话，并返回下一次请求生效与上下文投递', async () => {
    const value = store()
    const service = new Prompts(value, () => 200_000, () => variables, () => false)
    const notices: unknown[][] = []
    const sessions = {
      notify: (...args: unknown[]) => { notices.push(args) },
      delivery: async (name: string) => `${name} delivered`,
    } as never
    const result = await savePrompts({ store: value, prompts: service, sessions }, { ...defaultPrompts(), scope: 'x' }, 0, 'panel')
    expect(result).toEqual({ revision: 1, effect: 'next-request', context_delivery: 'prompts delivered' })
    expect(notices).toHaveLength(1)
    expect(notices[0]![0]).toBe('prompts')
    expect(notices[0]![2]).toContain('revision 1')
    // 工具自己改的不通知它自己。
    await savePrompts({ store: value, prompts: service, sessions }, { ...defaultPrompts(), scope: 'y' }, 1, 'tool')
    expect(notices).toHaveLength(1)
  })
})
