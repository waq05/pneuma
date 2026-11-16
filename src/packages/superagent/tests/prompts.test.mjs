/**
 * 提示词与上下文的包级测试：测移植版 `app/prompts.ts` + `app/context.ts`，转写自上游
 * `tests/prompts.spec.ts`（18 条用例）。钉的是：团队段存成版本可回滚、每个角色的固定段顺序、
 * 提示词文件换行归一、覆盖按角色原位替换、生成段模板填充、非法覆盖被拒、内置文本变更提示、
 * 旧配置兼容与已删段的处理、原型链名字被拒、执行环境收尾。改坏任何一条的后果都是
 * 「团队改过的文案悄悄丢」或「升级把覆盖冲掉」这类静默错误。
 *
 * 全程用临时目录与显式库路径，绝不碰 `~/.dsc`。
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/prompts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { after, test } from 'node:test'

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 记一条通过的断言；失败照常抛给 node:test。 */
function ok(value, message) {
  assert.ok(value, message)
  passed += 1
}

/** 严格相等。 */
function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  passed += 1
}

/** 深比较（对象 / 数组）。 */
function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

const { Prompts, builtInBase, composePrompt, defaultPrompts, policySection, promptParts } =
  await import('../../../../lib/packages/superagent/app/prompts.js')
const { guides, handoffPolicy, mainAdmissionPolicy, masterPrompt, sharedPrompt, workerPrompt } =
  await import('../../../../lib/packages/superagent/app/context.js')
const { promptFile } = await import('../../../../lib/packages/superagent/app/skill-files.js')
const { Store } = await import('../../../../lib/packages/superagent/app/store.js')
const { KV } = await import('../../../../lib/packages/superagent/kv.js')
const { SettingsSchema, policyVersion } = await import('../../../../lib/packages/superagent/core/policy.js')
const { USER_ERRORS, UserError } = await import('../../../../lib/packages/superagent/core/index.js')

/** 执行环境（工单之外，setup 完成之后运行期传的那一份）。 */
const variables = () => [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', value: 'acme/widgets',
  description: { zh: '仓库', en: 'The repository' }, owner: 'github' }]
const ENVIRONMENT_LINE = '- DSH_SUPERAGENT_GITHUB_REPOSITORY = "acme/widgets": The repository.'
/** 一套提示词服务：真 Store、固定执行环境、飞书已配置。 */
const promptsOf = (store, maxChars = 100000) => new Prompts(store, () => maxChars, variables, () => true)

/** 一个临时 Store；`body` 回来之后关库删目录。 */
function withStore(body) {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-prompts-app-'))
  const store = new Store(join(dir, 'db'))
  try { body(store, dir) } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}

/** `toMatchObject` 的等价物：只比写出的键，数组等长逐项匹配。 */
function matches(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matches(actual[index], item))
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false
    return Object.entries(expected).every(([name, value]) => name in actual && matches(actual[name], value))
  }
  return Object.is(actual, expected)
}

/** 记一条部分匹配。 */
function matched(actual, expected, message) {
  assert.ok(matches(actual, expected), message)
  passed += 1
}

/** 记一条同步抛出（正则或校验函数）。 */
function throws(work, check, message) {
  assert.throws(work, check, message)
  passed += 1
}

/** 记一条「按 UserError 的 code 拒绝」。 */
function throwsUserError(work, code, message) {
  let thrown
  try { work() } catch (error) { thrown = error }
  assert.ok(thrown instanceof UserError, message ?? `应以 UserError 拒绝，实际：${String(thrown)}`)
  assert.equal(thrown.code, code, message)
  passed += 1
}

test('团队段与技能存成版本，重启后仍在，带历史与回滚', () => {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-prompt-config-'))
  let store = new Store(join(dir, 'db'))
  try {
    let prompts = promptsOf(store)
    deepEqual(prompts.current().config, defaultPrompts(), '没存过时用出厂配置')
    const config = { ...defaultPrompts(), scope: 'Finish what was asked.', delivery: '', skills: { release: 'Tag releases on Fridays.' } }
    prompts.save(config, 0, 'panel')
    ok(composePrompt(prompts.current().config, 'worker').includes('## Ticket scope\nFinish what was asked.'), '团队段进提示词')
    // 空的团队段离开提示词；固定段留着。
    ok(!promptParts(config, 'worker').map(part => part.name).includes('delivery'), '空段不占位')
    deepEqual(store.get('settings-revision'), undefined, '提示词版本不碰设置版本号')
    store.close()
    store = new Store(join(dir, 'db'))
    prompts = promptsOf(store)
    matched(prompts.current(), { revision: 1, config }, '重启后仍在')
    prompts.save(prompts.version(0).config, 1, 'tool')
    matched(prompts.current(), { revision: 2, previousRevision: 1, config: defaultPrompts() }, '回滚成出厂配置')
    matched(prompts.history(0, 1), { revisions: [{ revision: 2 }], next_offset: 1 })
    equal(prompts.history(2, 1).next_offset, null)
    matched(prompts.history(1, 1).revisions[0], { revision: 1, changed: ['scope', 'delivery', 'skill/release'] })
    throws(() => prompts.save(config, 1, 'panel'), /version changed/, '拿旧版本号保存要拒')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('每个角色的提示词都由固定段围着团队段拼成，配置说什么都不改顺序', () => {
  const config = { communication: 'Say little.', scope: '', delivery: 'Attach screenshots.', skills: {} }
  for (const role of ['orchestrator', 'worker']) {
    const names = promptParts(config, role, 'env').map(part => part.name)
    deepEqual(names, ['runtime/shared', `runtime/${role}`, 'communication', 'delivery', 'runtime/subscriptions', 'runtime/replies',
      role === 'orchestrator' ? 'runtime/dispatch' : 'runtime/work', ...role === 'orchestrator' ? ['runtime/admission'] : [],
      'runtime/handoff', 'runtime/environment'], `${role} 的段顺序`)
    const prompt = composePrompt(config, role)
    for (const fixed of [sharedPrompt, role === 'orchestrator' ? masterPrompt : workerPrompt, guides.subscriptions, guides.replies,
      handoffPolicy(role)]) ok(prompt.includes(fixed), `${role} 的提示词含固定段`)
    equal(prompt.endsWith(handoffPolicy(role)), true, `${role} 的提示词以交接规则收尾`)
  }
  ok(composePrompt(config, 'orchestrator').includes(mainAdmissionPolicy), '主会话带准入段')
  ok(!composePrompt(config, 'worker').includes(mainAdmissionPolicy), '执行者不带准入段')
})

test('提示词文件不管换行与空行怎么排都能读，缺文件或空文件按名字报错', () => {
  // promptFile 读的是构建产物里的 `prompts/`；临时文件放在它的同级目录，相对路径才能跨平台成立。
  const promptsRoot = join(import.meta.dirname, '../../../../lib/packages/superagent/prompts')
  const dir = mkdtempSync(join(import.meta.dirname, '../../../../lib/packages/superagent', '.prompt-file-'))
  const name = (file) => relative(promptsRoot, join(dir, file))
  try {
    writeFileSync(join(dir, 'crlf.md'), 'One.\r\nTwo. \r\n \t\r\n\r\nThree.\r\n')
    writeFileSync(join(dir, 'blank.md'), ' \n\t\n')
    equal(promptFile(name('crlf')), 'One. Two.\nThree.')
    throws(() => promptFile(name('blank')), (error) => error.message === `Empty packaged file: ${join(dir, 'blank.md')}`)
    throws(() => promptFile(name('absent')), (error) => error.message === `Missing packaged file: ${join(dir, 'absent.md')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('界面「前后对比」证据交给交付要求，团队可以改', () => {
  const config = { ...defaultPrompts(), delivery: 'Only capture the finished screen.' }
  for (const role of ['orchestrator', 'worker']) {
    ok(!composePrompt(config, role).includes('Before and After visual evidence'), `${role} 的固定段不写死证据要求`)
  }
})

for (const role of ['orchestrator', 'worker']) {
  test(`以固定交接规则与执行环境收尾（${role}），主会话还以 Policy 收尾`, () => {
    withStore((store) => {
      const prompts = promptsOf(store)
      const preview = prompts.preview(defaultPrompts())
      deepEqual(promptParts(defaultPrompts(), role).at(-1), { name: 'runtime/handoff', kind: 'fixed', key: `runtime/handoff/${role}`,
        text: handoffPolicy(role) })
      equal(preview[role], prompts.compose(defaultPrompts(), role))
      ok(preview[role].includes(`${handoffPolicy(role)}\n\nExecution environment`), '交接规则之后是执行环境')
      if (role === 'worker') equal(preview[role].endsWith(ENVIRONMENT_LINE), true)
      // 主会话的 Policy 段之后什么都没有，所以 Policy 变了也只改它自己。
      else equal(preview[role].endsWith(`${ENVIRONMENT_LINE}\n\n${policySection(store.settings()).text}`), true)
      equal(preview.parts[role].at(-1).name, role === 'orchestrator' ? 'runtime/policy' : 'runtime/environment')
    })
  })
}

test('未知键、内置技能名、超长配置都在落盘前被拒', () => {
  withStore((store) => {
    const prompts = promptsOf(store)
    throws(() => prompts.save({ ...defaultPrompts(), shared: 'x' }, 0, 'panel'))
    throws(() => prompts.save({ communication: '', scope: '' }, 0, 'panel'))
    for (const name of ['github', 'feishu']) throws(() => prompts.save({ ...defaultPrompts(), skills: { [name]: 'mine' } }, 0, 'panel'), /built-in skill/)
    throws(() => prompts.save({ ...defaultPrompts(), skills: { 'Bad Name': 'x' } }, 0, 'panel'))
    throws(() => promptsOf(store, 1000).save(defaultPrompts(), 0, 'panel'), /exceeds/)
    equal(prompts.current().revision, 0, '被拒的保存一个版本都没留')
  })
})

test('工单的执行环境列进它的提示词；setup 没完成时说还在等 setup', () => {
  withStore((store) => {
    const ticket = [{ key: 'DSH_SUPERAGENT_DIR', value: '/srv/work/fix-1', description: { zh: '', en: 'This ticket\'s directory' },
      owner: 'executor' }]
    equal(promptsOf(store).compose(defaultPrompts(), 'worker', ticket)
      .endsWith('- DSH_SUPERAGENT_DIR = "/srv/work/fix-1": This ticket\'s directory.'), true)
    deepEqual(promptParts(defaultPrompts(), 'worker', 'env').at(-1), { name: 'runtime/environment', kind: 'generated', key: 'runtime/environment',
      text: 'env' })
    ok(new Prompts(store, () => 100000, () => undefined, () => false).compose(defaultPrompts(), 'worker')
      .includes('dsh-superagent is waiting for setup'), 'setup 没完成时说在等')
  })
})

test('内置来源技能按「飞书只在有机器人时」注册，排在团队技能之前', () => {
  withStore((store) => {
    const config = { ...defaultPrompts(), skills: { release: 'Tag releases.' } }
    const skills = promptsOf(store).skills(config)
    deepEqual(skills.map(([name]) => name), ['feishu', 'github', 'release'])
    ok(skills[1][1].includes('## CLI usage'), '内置技能带 CLI 用法')
    equal(skills[2][1], 'Tag releases.')
    deepEqual(new Prompts(store, () => 100000, variables, () => false).skills(config).map(([name]) => name), ['github', 'release'])
  })
})

// ── 内置段覆盖 ──────────────────────────────────────────────────────────────

const overridesConfig = (overrides) => ({ ...defaultPrompts(), overrides })
const plainSettings = () => SettingsSchema.parse({})

test('覆盖按角色原位替换内置文本：主会话段只换主会话，交接按角色，来源技能也是', () => {
  withStore((store) => {
    const prompts = promptsOf(store)
    const edited = prompts.validate(overridesConfig({ 'runtime/shared': { text: 'Shared, the team way.' },
      'runtime/dispatch': { text: '## dispatch\nRoute well.' }, 'runtime/handoff/worker': { text: 'Hand off as a worker.' },
      'skill/github': { text: 'GitHub, the team way.' } }))
    const main = prompts.compose(edited, 'orchestrator'), worker = prompts.compose(edited, 'worker')
    for (const prompt of [main, worker]) ok(prompt.startsWith('Shared, the team way.\n\n'), '主会话与执行者都换开头')
    ok(main.includes('## dispatch\nRoute well.'), '主会话用团队的分发规则')
    ok(!main.includes(guides.dispatch), '内置分发文本不再出现')
    ok(worker.includes('Hand off as a worker.'), '执行者用团队的交接文本')
    ok(main.includes(handoffPolicy('orchestrator')), '主会话的交接没被换')
    deepEqual(prompts.skills(edited).find(([name]) => name === 'github'), ['github', 'GitHub, the team way.'])
    // 段自己说出被谁编辑。
    matched(promptParts(edited, 'worker').find(part => part.name === 'runtime/handoff'), { key: 'runtime/handoff/worker',
      text: 'Hand off as a worker.' })
  })
})

test('生成段的模板被覆盖时用数据填充，填充结果仍算生成段', () => {
  withStore((store) => {
    const prompts = promptsOf(store)
    const edited = prompts.validate(overridesConfig({ 'runtime/environment': { text: 'Where you work:\n{variables}\nAsk nobody for more.' },
      'runtime/policy': { text: '## Policy\nRules of {version} in {mode} mode:\n{rules}' },
      'runtime/policy/none': { text: '## Policy\n{version}, {mode}: nothing to accept.' } }))
    equal(prompts.compose(edited, 'worker').endsWith(`Where you work:\n${ENVIRONMENT_LINE}\nAsk nobody for more.`), true)
    const policy = policySection(plainSettings(), edited)
    deepEqual(policy, { key: 'runtime/policy', text: `## Policy\nRules of ${policyVersion(plainSettings())} in ${plainSettings().eval.mode} mode:\n`
      + plainSettings().policy.rules.filter(rule => rule.enabled).map(rule => `- ${rule.name} (${rule.id}): ${rule.instruction}`).join('\n') })
    const none = SettingsSchema.parse({ policy: { rules: [] } })
    deepEqual(policySection(none, edited), { key: 'runtime/policy/none', text: `## Policy\n${policyVersion(none)}, ${none.eval.mode}: nothing to accept.` })
    // 规则文本里出现的占位符不会再被填一次。
    const named = SettingsSchema.parse({ policy: { rules: [{ id: 'x', name: 'X', enabled: true,
      instruction: 'Keep {mode} and $& as written.' }] } })
    equal(policySection(named, edited).text.endsWith('- X (x): Keep {mode} and $& as written.'), true)
  })
})

test('未知段、丢了占位符的模板、空的段都拒绝；与内置文本相同的覆盖被丢掉', () => {
  withStore((store) => {
    const prompts = promptsOf(store)
    throwsUserError(() => prompts.validate(overridesConfig({ 'runtime/nothing': { text: 'x' } })), 'unknownPromptPart')
    throwsUserError(() => prompts.validate(overridesConfig({ 'runtime/policy': { text: '## Policy\n{version} {mode}' } })), 'promptPlaceholders')
    throwsUserError(() => prompts.validate(overridesConfig({ 'runtime/environment': { text: 'Where you work.' } })), 'promptPlaceholders')
    // 回到内置文本：这一段重新跟随内置文本，升级时会跟着更新。
    ok(!('overrides' in prompts.validate(overridesConfig({ 'runtime/shared': { text: sharedPrompt } }))), '与内置相同就不算覆盖')
    // 整份配置（含覆盖）不超上限。
    throws(() => promptsOf(store, 5000).validate(overridesConfig({ 'runtime/shared': { text: 'x'.repeat(5000) } })), UserError)
  })
})

test('记下覆盖所依据的内置文本，并列出内置文本此后变过的覆盖', () => {
  withStore((store) => {
    const prompts = promptsOf(store)
    // 从今天的内置文本改的覆盖没什么可显示。
    const saved = prompts.save(overridesConfig({ 'runtime/dispatch': { text: '## dispatch\nRoute well.' } }), 0, 'panel')
    equal(saved.config.overrides['runtime/dispatch'].base, builtInBase(`## dispatch\n${guides.dispatch}`))
    deepEqual(prompts.defaultChanged(saved.config), [])
    // 从更早版本的内置文本改的覆盖：本安装留着那版文本。
    const earlier = '## replies\nAn earlier built-in text.'
    store.set(KV.prompts.builtIn(builtInBase(earlier)), earlier)
    const upgraded = prompts.save(overridesConfig({ ...saved.config.overrides, 'runtime/replies': { text: 'Our replies.', base: builtInBase(earlier) },
      'runtime/work': { text: 'Our work.', base: 'unknown' } }), saved.revision, 'panel')
    deepEqual(prompts.defaultChanged(upgraded.config), [{ part: 'runtime/replies', base: builtInBase(earlier), previous: earlier },
      { part: 'runtime/work', base: 'unknown' }])
    // 团队文本原样保留：升级从不替换它。
    ok(prompts.compose(prompts.current().config, 'worker').includes('Our replies.'), '升级不动团队文本')
  })
})

test('覆盖出现之前存的配置原样读得懂', () => {
  withStore((store) => {
    const prompts = promptsOf(store)
    const saved = prompts.save({ ...defaultPrompts(), communication: 'Ours.' }, 0, 'panel')
    deepEqual(saved.config, { ...defaultPrompts(), communication: 'Ours.' })
    equal(prompts.compose(saved.config, 'orchestrator'),
      prompts.compose({ ...defaultPrompts(), communication: 'Ours.', overrides: {} }, 'orchestrator'))
  })
})

test('丢掉后来版本已经没有的段的覆盖（旧版本里存过），并把它标成 removed', () => {
  withStore((store) => {
    const prompts = promptsOf(store)
    const config = { ...defaultPrompts(), overrides: { 'runtime/retired': { text: 'Old.', base: 'b' } } }
    // 只有「存过那一版」里的段才悄悄丢；客户端自己编的段拒绝。
    throwsUserError(() => prompts.validate(config), 'unknownPromptPart')
    store.set(KV.prompts.version(1), { revision: 1, previousRevision: 0, savedAt: '', source: 'panel', config })
    store.set(KV.prompts.revision, 1)
    deepEqual(prompts.defaultChanged(config), [{ part: 'runtime/retired', base: 'b', removed: true }])
    deepEqual(prompts.validate(config), defaultPrompts())
    equal(USER_ERRORS.unknownPromptPart[0], 'refused')
  })
})

test('保存时省略 base 就保留已存覆盖的 base；重新对齐 base 算一次变化', () => {
  withStore((store) => {
    const prompts = promptsOf(store)
    const first = prompts.save(overridesConfig({ 'runtime/shared': { text: 'Ours.', base: 'earlier' } }), 0, 'panel')
    const second = prompts.save(overridesConfig({ 'runtime/shared': { text: 'Ours, edited.' } }), first.revision, 'tool')
    deepEqual(second.config.overrides['runtime/shared'], { text: 'Ours, edited.', base: 'earlier' })
    // 升级后保留团队文本只改 base，历史里会说出这件事。
    const rebased = prompts.save(overridesConfig({ 'runtime/shared': { text: 'Ours, edited.', base: builtInBase(sharedPrompt) } }),
      second.revision, 'panel')
    deepEqual(prompts.history().revisions.find(version => version.revision === rebased.revision).changed, ['runtime/shared'])
  })
})

test('原型链上的名字、空文本都拒绝；原型上的名字不被当成占位符填', () => {
  withStore((store) => {
    const prompts = promptsOf(store)
    for (const part of ['constructor', 'toString']) {
      throwsUserError(() => prompts.validate(overridesConfig(JSON.parse(`{"${part}": { "text": "x" }}`))), 'unknownPromptPart')
    }
    // 解析器会丢掉 `__proto__` 键，它不改原型。
    deepEqual(prompts.validate(overridesConfig(JSON.parse('{"__proto__": { "text": "x" }}'))), defaultPrompts())
    throwsUserError(() => prompts.validate(overridesConfig({ 'runtime/shared': { text: ' \n ' } })), 'promptPartEmpty')
    const edited = prompts.validate(overridesConfig({ 'runtime/environment': { text: '{constructor} {toString}\n{variables}' } }))
    equal(prompts.compose(edited, 'worker').endsWith(`{constructor} {toString}\n${ENVIRONMENT_LINE}`), true)
  })
})

test('执行环境的标题保持原样，并说明 prepare 命令读同一批变量', () => {
  ok(!composePrompt(defaultPrompts(), 'worker', 'x').includes('The prepare command'), '显式给环境时不带标题')
  withStore((store) => {
    ok(promptsOf(store).compose(defaultPrompts(), 'worker')
      .includes('an empty value means that part is not configured here). '
        + `The prepare command of a ticket directory reads the same variables:\n${ENVIRONMENT_LINE}`), '默认环境带完整标题')
  })
})
