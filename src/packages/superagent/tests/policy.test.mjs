/**
 * @pneuma/superagent 策略层（`core/policy.js`）的包级测试，转写自上游 `tests/policy.spec.ts`（486 行）。
 *
 * 为什么这条链要单独钉：策略判错从不报错，只会悄悄换个行为——名单里的人不再能发起工作、
 * 群里的普通消息突然变成候选、规则关掉之后旧工单还在跑、设置一改把所有授权哈希都作废。
 * 所以每条都断言「准入结果长什么样」，而不是「函数没抛错」。
 *
 * 覆盖范围（对应上游 spec 的 describe）：
 *   来源范围（`SourceRegistry.scope`）、准入门（`policy.gate`）、准入表（格位/名单/模式/接收范围）、
 *   从准入表反复核验 Mandate（上游 `it.each` 展开成 288 条）、Mandate 振验与策略版本、
 *   设置迁移（`migrateSettings`，上游 spec 里属于这一份）、评估结论（`assessmentOutcome`）、
 *   准入表设置校验（`validatePolicy`）、规则判定、策略变更影响（`policyEffects`）、机器人与无人消息。
 *
 * 假件只有两种：设置（真 `SettingsSchema.parse` 造）、来源注册表（真 `SourceRegistry` + 真
 * `feishuKind` / `githubKind`）；`scope` 这类只被 `settingsPolicy` 读一个方法的依赖用对象字面量。
 * 全程不写盘、不碰 `~/.dsc`。
 *
 * 上游 `expect(...).toEqual(...)` 换成 `assert.deepEqual`，`toMatchObject` 用本文件末尾的
 * `matchObject` 仿写（对象逐键包含、数组等长逐项包含）。`it.each` 展开成逐个 `test`，名字保留
 * 上游的维度（格位、强度、现在是否在名单、模式、规则、接收范围、格位是否仍成立）。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/policy
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { SettingsSchema, allowedSender, anyoneAllowed, assessmentOutcome, policyEffects, policyVersion, settingsPolicy } =
  await import('../../../../lib/packages/superagent/core/policy.js')
const { migrateSettings } = await import('../../../../lib/packages/superagent/app/migration.js')
const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')
const { feishuKind } = await import('../../../../lib/packages/superagent/sources/feishu.js')
const { githubKind } = await import('../../../../lib/packages/superagent/sources/github.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 上游 `expect(...).toMatchObject(...)` 的等价物：对象逐键递归包含，数组要求等长且逐项包含，其余严格相等。 */
function matchObject(actual, expected) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `期望数组，实际是 ${typeof actual}`)
    assert.equal(actual.length, expected.length)
    expected.forEach((item, index) => matchObject(actual[index], item))
    return
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `期望对象，实际是 ${String(actual)}`)
    for (const [key, value] of Object.entries(expected)) matchObject(actual[key], value)
    return
  }
  assert.deepEqual(actual, expected)
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

const MEMBER = 'ou_alice'
const CHAT = 'oc_team'
const OBSERVED = 'oc_1111111111111111111111111111'

/** 飞书来源实例：上游 `feishuSource`。 */
const feishuSource = (config, enabled = true) => ({ enabled, config })

/** 基准设置：飞书名单位 Alice、同步群；GitHub 名单单位 Alice；评估模式 auto。 */
const base = SettingsSchema.parse({
  policy: { sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'Alice' }] } } },
  eval: { mode: 'auto' },
  sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }], directMessages: true }) },
})

/** 一套真注册表（飞书 + GitHub）与由它实现的策略。 */
function setup(settings = base) {
  const sources = new SourceRegistry(() => settings)
  sources.register(feishuKind)
  sources.register(githubKind)
  return { sources, policy: settingsPolicy(settings, sources), version: policyVersion(settings) }
}
const { sources, policy } = setup()

const thread = (subscriptions = []) => ({ key: 'feishu:x', ref: { source: 'feishu', id: 'x' }, createdAt: '', subscriptions, correlated: [], pending: [], meta: {} })
const feishu = (overrides = {}) => ({ id: 't', source: 'feishu', threads: [{ source: 'feishu', id: 'x' }], actor: { source: 'feishu', id: MEMBER },
  human: true, at: '', text: 'hi', addressed: 'mention', meta: { chatId: CHAT, direct: false, mentioned: true }, ...overrides })
/** 去掉 `addressed`：没 @ 也没私聊的消息。 */
const unaddressed = (overrides = {}) => { const { addressed: _addressed, ...rest } = feishu(overrides); return rest }
const github = (login, addressed) => ({ id: 'g', source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: login },
  human: true, at: '', text: 'x', ...addressed ? { addressed } : {}, meta: { number: 1, isPr: true } })
const ticket = { id: 'ticket', ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' } }

// ── 来源范围 ────────────────────────────────────────────────────────────────

test('来源范围：按配置的群接收，只有“全部消息”的群才观察全文，私聊跟随开关', () => {
  assert.deepEqual(sources.scope(feishu()), { listened: true, observed: false, row: CHAT })
  assert.deepEqual(sources.scope(feishu({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })), { listened: true, observed: true, row: OBSERVED })
  assert.deepEqual(sources.scope(feishu({ meta: { chatId: 'oc_other', direct: false, mentioned: true } })), { listened: false, reason: 'chat_not_allowed' })
  assert.deepEqual(sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } })), { listened: true, observed: false, row: 'direct' })
  assert.deepEqual(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).sources.scope(feishu({ meta: { chatId: 'p2p', direct: true, mentioned: false } })),
    { listened: false, reason: 'direct_messages_not_allowed' })
  // GitHub 没有“群”可选，只要来源在就听，是否观察某类事件由 scope 的 row 决定。
  assert.deepEqual(sources.scope(github('anyone')), { listened: true, observed: false })
  passed += 1
})

test('来源范围：配置了但插件没装的来源一条都不听；配置存坏了就停用', () => {
  const bare = new SourceRegistry(() => base)
  assert.deepEqual(bare.scope(feishu()), { listened: false, reason: 'source_not_installed' })
  assert.deepEqual(bare.scope(github('anyone')), { listened: true, observed: false })
  const broken = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: 'oops' } } } }))
  broken.register(feishuKind)
  matchObject(broken.instance('feishu'), { enabled: false })
  assert.deepEqual(broken.scope(feishu()), { listened: false, reason: 'source_disabled' })
  passed += 1
})

test('来源范围：停用的来源整个都不听', () => {
  assert.deepEqual(setup({ ...base, sources: { ...base.sources, github: { enabled: false, config: {} } } }).sources.scope(github('anyone')),
    { listened: false, reason: 'source_disabled' })
  passed += 1
})

// ── 准入门 ──────────────────────────────────────────────────────────────────

test('准入门：名单里的人 @ 机器人给明确授权，依据记录来源、发送者与接收范围', () => {
  matchObject(policy.gate(feishu(), thread(), []), { admissible: true, strength: 'explicit',
    basis: { via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: { chatId: CHAT } } })
  matchObject(policy.gate(feishu({ addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), []),
    { admissible: true, strength: 'explicit', basis: { addressed: 'direct' } })
  // GitHub 登录名不分大小写；名单项没有显示名时用 id 当发送者名。
  matchObject(policy.gate(github('alice', 'mention'), thread(), []), { admissible: true, strength: 'explicit', basis: { source: 'github', sender: 'Alice' } })
  passed += 1
})

test('准入门：每份来源查自己的名单，飞书的 id 在 GitHub 上什么也不放行', () => {
  assert.deepEqual(policy.gate(github(MEMBER, 'mention'), thread(), []), { admissible: false, reason: 'not_a_member' })
  assert.deepEqual(allowedSender(base, { source: 'github', id: 'ALICE' }), { id: 'Alice' })
  assert.equal(allowedSender(base, { source: 'feishu', id: 'Alice' }), undefined)
  assert.equal(anyoneAllowed(base), true)
  assert.equal(anyoneAllowed(SettingsSchema.parse({})), false)
  passed += 1
})

test('准入门：有工单的线程上按后续消息处理，名单里的人明确、别人推断', () => {
  const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
  matchObject(policy.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), []),
    { admissible: true, strength: 'inferred', basis: { via: 'followup' } })
  matchObject(policy.gate(unaddressed(quiet), thread(['ticket']), []), { admissible: true, strength: 'explicit', basis: { via: 'followup', sender: 'Alice' } })
  matchObject(policy.gate(github('someone'), thread(), [ticket]), { admissible: true, strength: 'inferred' })
  // 只为上下文订阅的线程借不出后续消息的身份，照准入表判。
  const context = { ...thread(['ticket']), context: ['ticket'] }
  matchObject(policy.gate(unaddressed(quiet), context, [ticket]), { admissible: false })
  passed += 1
})

test('准入门：来源观察到的消息对名单里的人推断放行，评估关掉就不放', () => {
  const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
  matchObject(policy.gate(observed, thread(), []), { admissible: true, strength: 'inferred', basis: { via: 'admission', observation: { mode: 'auto' } } })
  assert.deepEqual(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy.gate(observed, thread(), []), { admissible: false, reason: 'no_mention' })
  passed += 1
})

test('准入门：来源那段名单不认的发送者私聊机器人，也不当后续消息放行', () => {
  assert.deepEqual(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(['ticket']), []),
    { admissible: false, reason: 'not_a_member' })
  passed += 1
})

test('准入门：机器人消息、线程外的陌生发送者、没 @ 的名单成员都不要', () => {
  assert.deepEqual(policy.gate(feishu({ human: false }), thread(), []), { admissible: false, reason: 'not_human' })
  assert.deepEqual(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' } }), thread(), []), { admissible: false, reason: 'not_a_member' })
  assert.deepEqual(policy.gate(unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } }), thread(), []), { admissible: false, reason: 'no_mention' })
  passed += 1
})

// ── 准入表 ──────────────────────────────────────────────────────────────────

test('准入表：格位全空时复现加表之前的行为', () => {
  const STRANGER = 'ou_stranger'
  matchObject(policy.gate(inChat(OBSERVED, MEMBER, false), thread(), []), { admissible: true, strength: 'inferred',
    basis: { via: 'admission', row: OBSERVED, cell: 'listedUnaddressed', observation: { mode: 'auto' } } })
  assert.deepEqual(policy.gate(inChat(CHAT, STRANGER), thread(), []), { admissible: false, reason: 'not_a_member' })
  assert.deepEqual(policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), []),
    { admissible: false, reason: 'not_a_member' })
  // 名单里的人 @ 机器人，无论表里怎么写都是明确请求。
  matchObject(setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } })).policy.gate(inChat(CHAT), thread(), []), { admissible: true, strength: 'explicit' })
  passed += 1
})

test('准入表：陌生人的 @ 按格位给明确或推断，推断的还要模式在评估', () => {
  const STRANGER = 'ou_stranger'
  const explicit = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), [])
  assert.deepEqual(explicit, { admissible: true, strength: 'explicit',
    basis: { source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: true }, row: CHAT, via: 'admission', cell: 'unlistedAddressed', addressed: 'mention' } })
  matchObject(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER), thread(), []),
    { admissible: true, strength: 'inferred', basis: { cell: 'unlistedAddressed' } })
  assert.deepEqual(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }, {}, 'off')).policy.gate(inChat(CHAT, STRANGER), thread(), []),
    { admissible: false, reason: 'not_a_member' })
  matchObject(setup(withTable({ direct: { unlistedAddressed: 'explicit' } })).policy.gate(
    feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), []),
  { admissible: true, strength: 'explicit', basis: { row: 'direct', cell: 'unlistedAddressed' } })
  assert.deepEqual(setup(withTable({ [OBSERVED]: { unlistedAddressed: 'explicit' } })).policy.gate(inChat(CHAT, STRANGER), thread(), []),
    { admissible: false, reason: 'not_a_member' })
  passed += 1
})

test('准入表：名单成员没 @ 时按格位忽略；群本来收不到的消息根本不查表', () => {
  const STRANGER = 'ou_stranger'
  assert.deepEqual(setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore' } })).policy.gate(inChat(OBSERVED, MEMBER, false), thread(), []),
    { admissible: false, reason: 'admission_ignored' })
  // 只收 @ 的群收不到没 @ 的消息，格位写推断也不放行。
  assert.deepEqual(setup(withTable({ [CHAT]: { listedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, MEMBER, false), thread(), []),
    { admissible: false, reason: 'no_mention' })
  assert.deepEqual(setup(withTable({ [CHAT]: { unlistedUnaddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER, false), thread(), []),
    { admissible: false, reason: 'not_a_member' })
  passed += 1
})

test('准入表：没列出的群按 other 行接收，只有飞书卡片让收 @ 时才听', () => {
  const STRANGER = 'ou_stranger'
  assert.deepEqual(sources.scope(inChat('oc_elsewhere')), { listened: false, reason: 'chat_not_allowed' })
  const others = setup(withTable({ other: { unlistedAddressed: 'explicit' } }, { otherChats: 'mentions' }))
  assert.deepEqual(others.sources.scope(inChat('oc_elsewhere')), { listened: true, observed: false, row: 'other' })
  matchObject(others.policy.gate(inChat('oc_elsewhere'), thread(), []), { admissible: true, strength: 'explicit', basis: { row: 'other' } })
  matchObject(others.policy.gate(inChat('oc_elsewhere', STRANGER), thread(), []), { admissible: true, strength: 'explicit', basis: { row: 'other', cell: 'unlistedAddressed' } })
  passed += 1
})

test('准入表：评估关掉时推断的后续消息一律不放，名单成员的照旧', () => {
  const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
  const off = setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy
  assert.deepEqual(off.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), []),
    { admissible: false, reason: 'not_a_member' })
  matchObject(off.gate(unaddressed(quiet), thread(['ticket']), []), { admissible: true, strength: 'explicit', basis: { via: 'followup' } })
  passed += 1
})

test('准入表：格位写明确的陌生人 @ 在三种模式下都是明确请求，有工单的线程也一样', () => {
  const STRANGER = 'ou_stranger'
  for (const mode of ['auto', 'observe', 'off']) {
    const open = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }, {}, mode))
    matchObject(open.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), []),
      { admissible: true, strength: 'explicit', basis: { via: 'admission', cell: 'unlistedAddressed' } })
    // 不明确的格位让后续消息回到推断，前提是评估还开着。
    const strict = setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }, {}, mode))
    matchObject(strict.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), []),
      mode === 'off' ? { admissible: false } : { admissible: true, strength: 'inferred', basis: { via: 'followup' } })
  }
  passed += 1
})

test('准入表：有工单的线程上的后续消息不走准入表', () => {
  const STRANGER = 'ou_stranger'
  const strict = setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore', unlistedUnaddressed: 'ignore' } }))
  matchObject(strict.policy.gate(inChat(OBSERVED, MEMBER, false), thread(['ticket']), []), { admissible: true, strength: 'explicit', basis: { via: 'followup' } })
  matchObject(strict.policy.gate(inChat(OBSERVED, STRANGER, false), thread(['ticket']), []), { admissible: true, strength: 'inferred', basis: { via: 'followup' } })
  passed += 1
})

test('准入表：格位给得比接受时弱，Mandate 就失效；格位不变则一直有效', () => {
  const STRANGER = 'ou_stranger'
  const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })
  const gate = setup(open).policy.gate(inChat(CHAT, STRANGER), thread(), [])
  if (!gate.admissible) throw new Error('期望准入通过')
  const mandate = { strength: gate.strength, policyVersion: 'v', basis: gate.basis, actor: { source: 'feishu', id: STRANGER }, scope: '' }
  assert.equal(setup(open).policy.revalidate(mandate), true)
  assert.equal(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.revalidate(mandate), false)
  assert.equal(setup(withTable({})).policy.revalidate(mandate), false)
  passed += 1
})

test('准入表：改一个格位策略版本就变', () => {
  assert.notEqual(setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).version, setup().version)
  assert.equal(setup(withTable({})).version, setup().version)
  passed += 1
})

// ── 从准入表反复核验 Mandate（上游 it.each，展开 288 条） ────────────────────

/** 准入表的三个格位。 */
const CELLS = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
const SENDER = 'ou_sender'
/** 接单时的格位与强度组合。 */
const ORIGINS = [
  { cell: 'listedUnaddressed', strength: 'inferred' }, { cell: 'unlistedAddressed', strength: 'explicit' },
  { cell: 'unlistedAddressed', strength: 'inferred' }, { cell: 'unlistedUnaddressed', strength: 'inferred' },
]
/** 上游 docs/002 的振验判据：线程还得收得到；名单里的人 @ 机器人永远明确；事后进名单的人改走 listed 格。 */
function expectedVerdict({ cell, strength, listed, mode, rule, scope, holds }) {
  if (scope === 'none') return false
  if (cell === 'unlistedAddressed' && listed) return true
  const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
  if ((now === 'listedUnaddressed' && !listed) || !holds) return false
  return strength === 'explicit' || (mode === 'auto' && rule)
}
/** 展开 upstream `cases`：4 个起点 × 是否在名单 × 三种模式 × 规则开关 × 接收范围 × 格位是否仍成立 = 288。 */
const MANDATE_CASES = ORIGINS.flatMap(origin => [true, false].flatMap(listed => ['off', 'observe', 'auto'].flatMap(mode =>
  [true, false].flatMap(rule => ['all', 'mentions', 'none'].flatMap(scope => [true, false].map(holds => ({ ...origin, listed, mode, rule, scope, holds })))))))

for (const item of MANDATE_CASES) {
  const name = `${item.cell}（${item.strength}）、现在${item.listed ? '在' : '不在'}名单、模式 ${item.mode}、规则${item.rule ? '开' : '关'}、`
    + `群${item.scope}、格位${item.holds ? '仍成立' : '已不成立'}`
  test(`反复核验准入表 Mandate：${name}`, () => {
    // 格位给到接单时的强度，或者已不成立就给忽略；陌生人的 @ 格随接单强度，其余推断。
    const grant = (cell) => !item.holds ? 'ignore' : cell === 'unlistedAddressed' ? item.strength : 'inferred'
    const chats = item.scope === 'none' ? [] : [{ chatId: CHAT, listen: item.scope }]
    const settings = SettingsSchema.parse({
      eval: { mode: item.mode },
      sources: { feishu: feishuSource({ chats, directMessages: true }) },
      policy: {
        rules: [{ id: 'copy', name: 'Copy', enabled: item.rule, instruction: 'x' }],
        sources: { feishu: { allowed: item.listed ? [{ id: SENDER }] : [], admission: { [CHAT]: Object.fromEntries(CELLS.map(cell => [cell, grant(cell)])) } } },
      },
    })
    const addressed = item.cell === 'unlistedAddressed'
    const observed = item.strength === 'inferred' ? { observation: { mode: 'auto' }, rules: ['copy'] } : {}
    const basis = { via: 'admission', source: 'feishu', scope: { chatId: CHAT, direct: false, mentioned: addressed }, row: CHAT, cell: item.cell,
      ...addressed ? { addressed: 'mention' } : {}, ...observed }
    const mandate = { strength: item.strength, policyVersion: 'v', basis, actor: { source: 'feishu', id: SENDER }, scope: '' }
    assert.equal(setup(settings).policy.revalidate(mandate), expectedVerdict(item))
    passed += 1
  })
}

// ── Mandate 振验与策略版本 ──────────────────────────────────────────────────

test('振验：明确 Mandate 只要发送者还在名单、来源还听就有效；规则 Mandate 还要 auto 模式与规则仍开', () => {
  const basis = { via: 'addressed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice', addressed: 'mention' }
  const mandate = { strength: 'explicit', policyVersion: 'v', basis, actor: { source: 'feishu', id: MEMBER }, scope: '' }
  assert.equal(policy.revalidate(mandate), true)
  const nobody = { ...base, policy: { ...base.policy, sources: {} } }
  assert.equal(setup(nobody).policy.revalidate(mandate), false)
  const silent = { ...base, sources: { feishu: feishuSource({ chats: [], directMessages: true }) } }
  assert.equal(setup(silent).policy.revalidate(mandate), false)
  // 加准入门之前记的是 listed 依据；只要发送者仍在名单、来源还听，它继续成立。
  const listed = { via: 'listed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice' }
  assert.equal(setup(silent).policy.revalidate({ ...mandate, basis: listed }), false)
  assert.equal(policy.revalidate({ ...mandate, basis: listed }), true)
  const inferred = { ...mandate, strength: 'inferred', basis: { via: 'listed', observation: {}, rules: ['copy'] } }
  assert.equal(policy.revalidate(inferred), true)
  assert.equal(setup({ ...base, eval: { ...base.eval, mode: 'observe' } }).policy.revalidate(inferred), false)
  assert.equal(setup({ ...base, policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } })
    .policy.revalidate(inferred), false)
  assert.equal(setup(nobody).policy.revalidate({ ...mandate, basis: { via: 'followup' } }), true)
  passed += 1
})

test('策略版本：规则、评估模式和来源策略段变了才变；暂停、并发、模型、来源配置都不变', () => {
  const version = setup().version
  assert.equal(setup({ ...base, paused: true, executor: { ...base.executor, maxWorkers: 9 }, eval: { ...base.eval, timeoutSeconds: 300 },
    sources: { ...base.sources, github: { enabled: true, config: { pollSeconds: 600 } } } }).version, version)
  assert.equal(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).version, version)
  assert.notEqual(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).version, version)
  assert.notEqual(setup({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, github: { allowed: [], admission: {} } } } }).version, version)
  passed += 1
})

// ── 设置迁移（上游 spec 里属于这一份） ───────────────────────────────────────

test('设置迁移：把成员身份拆进各来源的策略段，丢掉提示词与执行环境取代的字段', () => {
  const saved = SettingsSchema.parse(migrateSettings({
    policy: { members: [{ name: 'Alice', feishuId: MEMBER, github: 'alice' }, { name: 'Bob', feishuId: 'ou_bob', github: '' }, { name: 'Carol', feishuId: '', github: 'carol' }],
      memberChat: CHAT, autoMergeLineLimit: 300, rules: [{ id: 'visual', name: 'V', enabled: true, visual: true, instruction: 'x' }] },
    executor: { maxWorkers: 2, reviewer: 'dave', visualReviewer: 'carol', branchPrefix: 'bot/' },
    sources: { feishu: { enabled: true, config: { chats: [], directMessages: true }, authority: { chats: [] } } },
  }))
  assert.deepEqual(saved.policy, {
    rules: [{ id: 'visual', name: 'V', enabled: true, instruction: 'x' }],
    sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }], syncChat: CHAT, admission: {} },
      github: { allowed: [{ id: 'alice' }, { id: 'carol' }], admission: {} } },
  })
  matchObject(saved, { paused: false, executor: { model: null, maxWorkers: 2, directory: '', prepare: '', blockedCommands: [] } })
  assert.deepEqual(saved.sources.feishu, { enabled: true, config: { chats: [], directMessages: true } })
  assert.deepEqual(SettingsSchema.parse(migrateSettings(saved)), saved)
  matchObject(SettingsSchema.parse(migrateSettings({ executor: { maxWorkers: 2, paused: true } })), { paused: true, executor: { maxWorkers: 2 } })
  passed += 1
})

test('设置迁移：旧的群列表、暂停开关、成员各自挪进新位置', () => {
  const migrated = SettingsSchema.parse(migrateSettings({ paused: true, allowedChats: [CHAT, OBSERVED], allowDirectMessages: false, pollSeconds: 120, maxWorkers: 5,
    members: [{ name: 'A', feishuId: MEMBER, github: 'a' }],
    models: { orchestrator: { provider: 'p', model: 'm' }, worker: null, admission: null },
    admission: { mode: 'auto', chats: [OBSERVED], maxEvaluators: 1, timeoutSeconds: 90, rules: [] } }))
  assert.deepEqual(migrated, {
    paused: true,
    sources: { feishu: feishuSource({ chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }], directMessages: false }),
      github: { enabled: true, config: { pollSeconds: 120 } } },
    policy: { rules: [], sources: { feishu: { allowed: [{ id: MEMBER, name: 'A' }], admission: {} }, github: { allowed: [{ id: 'a' }], admission: {} } } },
    eval: { mode: 'auto', timeoutSeconds: 90, model: { provider: 'p', model: 'm' } },
    executor: { model: null, maxWorkers: 5, directory: '', prepare: '', blockedCommands: [] },
  })
  assert.deepEqual(migrateSettings(migrated), migrated)
  passed += 1
})

test('设置迁移：只在评估关掉时才观察的群不进飞书来源', () => {
  const migrated = SettingsSchema.parse(migrateSettings({ allowedChats: [CHAT], members: [], admission: { mode: 'off', chats: [OBSERVED] } }))
  assert.deepEqual(migrated.sources.feishu.config, { chats: [{ chatId: CHAT, listen: 'mentions' }], directMessages: true })
  passed += 1
})

test('设置迁移：旧的 prepare 命令里的项目名前缀改成现在的', () => {
  const settings = SettingsSchema.parse(migrateSettings({ executor: { prepare: 'git worktree add "$DSH_TAG_DIR" -b "agent/${DSH_GO_NAME}" "refs/x/$DSH_FREELANCER_TICKET"' } }))
  assert.equal(settings.executor.prepare, 'git worktree add "$DSH_SUPERAGENT_DIR" -b "agent/${DSH_SUPERAGENT_NAME}" "refs/x/$DSH_SUPERAGENT_TICKET"')
  passed += 1
})

test('设置迁移：存下来的 GitHub 来源配置点名了合并账号，读出来时去掉', () => {
  const settings = SettingsSchema.parse(migrateSettings({ sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent', mergeCli: 'gh-merge-account', pollSeconds: 120 } } } }))
  assert.deepEqual(settings.sources.github.config, { repository: 'acme/widgets', cli: 'gh-agent', pollSeconds: 120 })
  passed += 1
})

// ── 评估结论 ────────────────────────────────────────────────────────────────

test('评估结论：推断候选只在 auto 模式下按命中的启用规则接受，策略只认启用且命中的规则', () => {
  const settings = (mode) => { const parsed = SettingsSchema.parse({}); return { ...parsed, eval: { ...parsed.eval, mode } } }
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const judged = (current, matched) => current.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched, reason: 'judged' }))
  const accept = (current, matched = true) => ({ decision: 'accept', rule_assessments: judged(current, matched), direction, title: 'Fix', scope: 'small',
    reason: 'asked', intent_evidence: 'quote', worktree_name: 'fix-copy' })
  const auto = settings('auto')
  const outcome = assessmentOutcome(accept(auto), auto, 'inferred')
  matchObject(outcome, { kind: 'accept', rules: auto.policy.rules.filter(rule => rule.enabled).map(rule => rule.id), name: 'fix-copy' })
  matchObject(assessmentOutcome(accept(settings('observe')), settings('observe'), 'inferred'),
    { kind: 'ignore', reason: { code: 'observed', values: { text: 'asked' } }, audit: { would_accept: true } })
  matchObject(assessmentOutcome(accept(auto, false), auto, 'inferred'), { kind: 'ignore', reason: { code: 'noRuleMatched' } })
  assert.throws(() => assessmentOutcome({ ...accept(auto), rule_assessments: [] }, auto, 'inferred'), /Exactly one assessment for every enabled rule/)
  assert.throws(() => assessmentOutcome({ ...accept(auto), intent_evidence: null }, auto, 'inferred'), /Acceptance requires intent_evidence/)
  const scope = { scope: () => ({ listened: true, observed: true }) }
  const enabled = auto.policy.rules.find(rule => rule.enabled).id
  assert.equal(settingsPolicy(auto, scope).admitsInferred([enabled]), true)
  assert.equal(settingsPolicy(auto, scope).admitsInferred(['unknown']), false)
  assert.equal(settingsPolicy(auto, scope).admitsInferred([]), false)
  assert.equal(settingsPolicy(settings('observe'), scope).admitsInferred([enabled]), false)
  passed += 1
})

// ── 准入表设置 ──────────────────────────────────────────────────────────────

test('准入表设置：没 @ 的消息不许配“明确”格位，设置与提交的策略都拒', () => {
  const part = (cell) => ({ allowed: [], admission: { [CHAT]: { [cell]: 'explicit' } } })
  for (const cell of ['listedUnaddressed', 'unlistedUnaddressed']) {
    assert.throws(() => SettingsSchema.parse({ policy: { sources: { feishu: part(cell) } } }))
    assert.throws(() => sources.validatePolicy({ feishu: part(cell) }))
  }
  matchObject(sources.validatePolicy({ feishu: { allowed: [], admission: { [CHAT]: { unlistedAddressed: 'explicit' } } } }).feishu,
    { admission: { [CHAT]: { unlistedAddressed: 'explicit' } } })
  passed += 1
})

test('准入表设置：明确的候选无论评估模式都接受，模式只约束推断的', () => {
  const rules = SettingsSchema.parse({}).policy.rules.filter(rule => rule.enabled)
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const assessment = { decision: 'accept', direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
    rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: 'judged' })) }
  for (const mode of ['observe', 'off']) {
    const settings = SettingsSchema.parse({ eval: { mode } })
    matchObject(assessmentOutcome(assessment, settings, 'explicit'), { kind: 'accept', title: 'Fix' })
    matchObject(assessmentOutcome(assessment, settings, 'inferred'), { kind: 'ignore', reason: { code: 'observed' } })
  }
  passed += 1
})

test('准入表设置：来源不观察消息时，名单里的机器人 @ 机器人也能推断准入，和名单里的人 @ 一样', () => {
  const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
    feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts' }] } } } })
  const mention = feishu({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false, meta: { chatId: CHAT, direct: false, mentioned: true } })
  matchObject(setup(settings).policy.gate(mention, thread(), []), { admissible: true, strength: 'inferred', basis: { via: 'bot', addressed: 'mention', row: CHAT } })
  passed += 1
})

// ── 规则判定 ────────────────────────────────────────────────────────────────

test('规则判定：同一条启用的规则判两次、另一条没判，评估被拒', () => {
  const parsed = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
    { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }] } })
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const assessment = { decision: 'accept', direction, title: 'Fix', scope: 'small', reason: 'asked', intent_evidence: 'quote',
    rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'typo' }, { rule_id: 'copy', matched: false, reason: 'again' }] }
  assert.throws(() => assessmentOutcome(assessment, parsed, 'inferred'), /Exactly one assessment for every enabled rule/)
  const once = { ...assessment, rule_assessments: [assessment.rule_assessments[0], { rule_id: 'visual', matched: false, reason: 'no colors' }] }
  matchObject(assessmentOutcome(once, parsed, 'inferred'), { kind: 'accept', rules: ['copy'] })
  passed += 1
})

// ── 策略变更影响 ────────────────────────────────────────────────────────────

test('策略变更影响：告诉工单这次改动怎么影响它，别的工单不动', () => {
  const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
    { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }],
  sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
  const scope = () => ({ scope: () => ({ listened: true, observed: true }) })
  const mockTicket = (id, mandate) => ({ id, mandate })
  const inferred = mockTicket('t1', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, basis: { via: 'listed', rules: ['copy'] } })
  const explicit = mockTicket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  const rules = (copy, visual = {}) => ({ ...settings, policy: { ...settings.policy, rules: [{ ...settings.policy.rules[0], ...copy }, { ...settings.policy.rules[1], ...visual }] } })
  // 工单接单时没命中的规则里发生了什么，它不受影响。
  assert.equal(policyEffects([inferred, explicit], settings, rules({}, { enabled: false }), scope).size, 0)
  assert.deepEqual(policyEffects([inferred], settings, rules({ instruction: 'Fix typos only.' }), scope).get('t1'),
    { rules: [{ id: 'copy', name: 'Copy', change: 'changed', instruction: 'Fix typos only.' }] })
  assert.deepEqual(policyEffects([inferred], settings, rules({ enabled: false }), scope).get('t1'), { rules: [{ id: 'copy', name: 'Copy', change: 'disabled' }] })
  // 名单里多一个人（成员同步会加）不影响任何工单；把请求者移出名单才是影响。
  const allowed = (list) => ({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { ...settings.policy.sources.feishu, allowed: list } } } })
  assert.equal(policyEffects([inferred, explicit], settings, allowed([{ id: 'ou_alice' }, { id: 'ou_bob' }]), scope).size, 0)
  assert.deepEqual(policyEffects([explicit], settings, allowed([]), scope).get('t2'), { requesterAllowed: false, requester: { source: 'feishu', id: 'ou_alice' } })
  passed += 1
})

test('策略变更影响：推断工单在评估模式离开 auto 时告诉它推断工作不再接受，并点名机器人', () => {
  const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' }],
    sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
  const scope = () => ({ scope: () => ({ listened: true, observed: true }) })
  const mockTicket = (id, mandate) => ({ id, mandate })
  const auto = { ...settings, eval: { ...settings.eval, mode: 'auto' } }
  const observe = { ...settings, eval: { ...settings.eval, mode: 'observe' } }
  const explicit = mockTicket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  const rule = mockTicket('t3', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_alice' },
    basis: { via: 'listed', source: 'feishu', rules: ['copy'], observation: {} } })
  const effects = policyEffects([rule, explicit], auto, observe, scope)
  // 不是发送者被移出名单：写它的人仍可发起工作。
  assert.deepEqual(effects.get('t3'), { proactive: false })
  assert.equal(effects.has('t2'), false)
  const bot = mockTicket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'cli_ci_bot' }, basis: { via: 'listed', source: 'feishu' } })
  const listed = { ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { ...settings.policy.sources.feishu, allowed: [{ id: 'cli_ci_bot' }] } } } }
  assert.deepEqual(policyEffects([bot], listed, settings, scope).get('t4'), { requesterAllowed: false, requester: { source: 'feishu', id: 'cli_ci_bot' } })
  passed += 1
})

test('策略变更影响：推断后续消息的 Mandate 只在候选能成为工作、规则仍开时保留', () => {
  const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' }],
    sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
  const scope = () => ({ scope: () => ({ listened: true, observed: true }) })
  const followup = { id: 't5', mandate: { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
    basis: { via: 'followup', source: 'feishu', scope: { chatId: 'oc_team' }, rules: ['copy'] } } }
  const mode = (value) => ({ ...settings, eval: { ...settings.eval, mode: value } })
  const disabled = { ...mode('auto'), policy: { ...settings.policy, rules: settings.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) } }
  assert.equal(settingsPolicy(mode('auto'), scope()).revalidate(followup.mandate), true)
  for (const current of [mode('observe'), mode('off'), disabled]) assert.equal(settingsPolicy(current, scope()).revalidate(followup.mandate), false)
  assert.deepEqual(policyEffects([followup], mode('auto'), mode('observe'), scope).get('t5'), { proactive: false })
  // 明确的后续消息什么模式下都成立。
  const explicitFollowup = { ...followup, mandate: { ...followup.mandate, strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' } } }
  assert.equal(settingsPolicy(mode('off'), scope()).revalidate(explicitFollowup.mandate), true)
  passed += 1
})

test('策略变更影响：格位变弱或候选不再能成为工作时撤销推断工单，删掉的规则报成停用', () => {
  const chat = 'oc_1111111111111111111111111111'
  const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
    { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' }], sources: { feishu: { allowed: [{ id: 'ou_alice' }] } } } })
  const table = (cell, mode = 'auto') => SettingsSchema.parse({ ...settings, eval: { ...settings.eval, mode },
    policy: { ...settings.policy, sources: { feishu: { ...settings.policy.sources.feishu, admission: { [chat]: { unlistedUnaddressed: cell } } } } } })
  const observed = () => ({ scope: () => ({ listened: true, observed: true, row: chat }) })
  const proactive = { id: 't3', mandate: { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, scope: '',
    basis: { via: 'admission', cell: 'unlistedUnaddressed', source: 'feishu', scope: { chatId: chat }, row: chat, rules: ['copy'], observation: { mode: 'auto' } } } }
  assert.equal(policyEffects([proactive], table('inferred'), table('inferred'), observed).size, 0)
  // 格位变弱把工作从发送者手里拿走，影响里点名发送者；换模式只是停掉推断工作。
  assert.deepEqual(policyEffects([proactive], table('inferred'), table('ignore'), observed).get('t3'),
    { requesterAllowed: false, requester: { source: 'feishu', id: 'ou_guest' } })
  assert.deepEqual(policyEffects([proactive], table('inferred'), table('inferred', 'observe'), observed).get('t3'), { proactive: false })
  const deleted = { ...settings, policy: { ...settings.policy, rules: settings.policy.rules.filter(rule => rule.id !== 'visual') } }
  const visual = { id: 't4', mandate: { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu', rules: ['visual'] } } }
  assert.deepEqual(policyEffects([visual], settings, deleted, scopeForObserved()).get('t4'), { rules: [{ id: 'visual', name: 'Visual', change: 'disabled' }] })
  passed += 1
})

// ── 机器人与没有发送者的消息 ────────────────────────────────────────────────

test('机器人：来源观察范围内的名单机器人作为推断候选准入，其他机器人一条不接', () => {
  const comment = { id: 'b', source: 'github', threads: [{ source: 'github', id: '1' }],
    actor: { source: 'github', id: 'dependabot[bot]' }, human: false, at: '', text: 'Bump lodash', meta: { number: 1, isPr: true, kind: 'conversation' } }
  matchObject(setup(observing({ observeComments: true })).policy.gate(comment, thread(), []),
    { admissible: true, strength: 'inferred', basis: { via: 'bot', source: 'github', sender: 'dependabot[bot]', row: 'comments', observation: { mode: 'auto' } } })
  // 机器人 @ 机器人也不是明确请求，有工单的线程上也不算后续消息。
  matchObject(setup(observing({ observeComments: true })).policy.gate({ ...comment, addressed: 'mention' }, thread(['ticket']), [ticket]),
    { strength: 'inferred', basis: { via: 'bot', addressed: 'mention' } })
  assert.deepEqual(setup(observing({ observeComments: true })).policy.gate({ ...comment, actor: { source: 'github', id: 'renovate[bot]' } }, thread(), []),
    { admissible: false, reason: 'not_human' })
  assert.deepEqual(setup(observing({})).policy.gate(comment, thread(), []), { admissible: false, reason: 'not_human' })
  assert.deepEqual(setup(observing({ observeComments: true }, {}, 'off')).policy.gate(comment, thread(), []), { admissible: false, reason: 'admission_ignored' })
  passed += 1
})

test('机器人：名单机器人的候选 Mandate 只要它还留在名单、候选还能成为工作就成立', () => {
  const comment = { id: 'b', source: 'github', threads: [{ source: 'github', id: '1' }],
    actor: { source: 'github', id: 'dependabot[bot]' }, human: false, at: '', text: 'Bump lodash', meta: { number: 1, isPr: true, kind: 'conversation' } }
  const settings = observing({ observeComments: true })
  const mandate = { strength: 'inferred', policyVersion: '', actor: comment.actor, scope: '',
    basis: { via: 'bot', source: 'github', scope: comment.meta, row: 'comments', sender: 'dependabot[bot]', observation: { mode: 'auto' } } }
  assert.equal(setup(settings).policy.revalidate(mandate), true)
  assert.equal(setup(observing({ observeComments: true }, { bots: [] })).policy.revalidate(mandate), false)
  assert.equal(setup({ ...settings, eval: { ...settings.eval, mode: 'observe' } }).policy.revalidate(mandate), false)
  passed += 1
})

test('机器人：默认分支的 CI 观察并配了格位才准入，PR 的 CI 永不', () => {
  const ci = (meta) => ({ id: 'ci', source: 'github', threads: [{ source: 'github', id: 'ci:main' }], actor: { source: 'github', id: '' },
    human: false, at: '', text: 'CI failed 1/9 on main', meta: { ci: true, ...meta } })
  const admission = { ci: { unlistedUnaddressed: 'inferred' } }
  matchObject(setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ branch: 'main' }), thread(), []),
    { admissible: true, strength: 'inferred', basis: { via: 'admission', cell: 'unlistedUnaddressed', row: 'ci', observation: { mode: 'auto' } } })
  // 格位默认忽略，所以只打开观察什么都不变。
  assert.deepEqual(setup(observing({ observeCi: true })).policy.gate(ci({ branch: 'main' }), thread(), []), { admissible: false, reason: 'admission_ignored' })
  assert.deepEqual(setup(observing({ observeCi: true }, { admission })).policy.gate(ci({ number: 9, isPr: true }), thread(), []),
    { admissible: false, reason: 'not_human' })
  passed += 1
})

test('机器人：名单里的飞书机器人在来源观察的群里推断准入', () => {
  const settings = SettingsSchema.parse({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources,
    feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts', name: 'Alerts' }] } } } })
  const alert = unaddressed({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false, meta: { chatId: OBSERVED, direct: false, mentioned: false } })
  matchObject(setup(settings).policy.gate(alert, thread(), []), { admissible: true, strength: 'inferred', basis: { via: 'bot', sender: 'Alerts', row: OBSERVED } })
  // 只收 @ 的群里，机器人没 @ 机器人的消息根本收不到。
  assert.deepEqual(setup(settings).policy.gate({ ...alert, meta: { chatId: CHAT, direct: false, mentioned: false } }, thread(), []),
    { admissible: false, reason: 'not_human' })
  passed += 1
})

test('机器人：GitHub 机器人名单的提示写明消息什么时候收到：@ 机器人时，或打开观察评论时', () => {
  const field = githubKind.policy.fields.find(item => item.key === 'bots')
  const comments = githubKind.fields.find(item => item.key === 'observeComments').label
  assert.ok(field.hint.en.includes('mentions the agent'), '英文提示要写明 @ 机器人时收到')
  assert.ok(field.hint.en.includes(comments.en), '英文提示要引用“接收评论”开关的英文名')
  assert.ok(field.hint.zh.includes(comments.zh), '中文提示要引用“接收评论”开关的中文名')
  passed += 1
})

test('机器人：GitHub Trigger 的接收范围按事件种类命名，观察开关打开时才算观察', () => {
  const observed = setup(observing({ observeIssues: true })).sources
  const trigger = (meta) => ({ source: 'github', meta })
  assert.deepEqual(observed.scope(trigger({ kind: 'issue', number: 3 })), { listened: true, observed: true, row: 'issues' })
  assert.deepEqual(observed.scope(trigger({ kind: 'pull', number: 4, isPr: true })), { listened: true, observed: false, row: 'pulls' })
  assert.deepEqual(observed.scope(trigger({ kind: 'inline', number: 4 })), { listened: true, observed: false, row: 'comments' })
  assert.deepEqual(observed.scope(trigger({ ci: true, branch: 'main' })), { listened: true, observed: false, row: 'ci' })
  assert.deepEqual(observed.scope(trigger({ ci: true, number: 4 })), { listened: true, observed: false })
  const rows = githubKind.policy.rows({ observeIssues: true })
  assert.deepEqual(rows.map(row => [row.id, row.cells]), [
    ['issues', { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
    ['pulls', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
    ['comments', { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
    ['ci', { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false }]])
  passed += 1
})

// ── 夹具（放在末尾，避免挡住阅读） ──────────────────────────────────────────

/** 上游 `inChat`：在某个群里发的消息，`addressed=false` 时去掉 @。 */
function inChat(chatId, sender = MEMBER, addressed = true) {
  const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
  if (addressed) return message
  const { addressed: _addressed, ...rest } = message
  return rest
}

/** 上游 `withTable`：在基准设置上挂一张准入表（只挂飞书那段）。 */
function withTable(admission, config = {}, mode = 'auto') {
  return SettingsSchema.parse({ ...base,
    eval: { ...base.eval, mode },
    sources: { ...base.sources, feishu: { enabled: true, config: { ...base.sources.feishu.config, ...config } } },
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu, admission } } } })
}

/** 上游 `observing`：GitHub 来源开着你想观察的开关，策略里挂名单。 */
function observing(config, part = {}, mode = 'auto') {
  return SettingsSchema.parse({
    policy: { sources: { github: { allowed: [{ id: 'Alice' }], bots: [{ id: 'dependabot[bot]' }], ...part } } }, eval: { mode },
    sources: { github: { enabled: true, config } } })
}

/** 上游 `policyEffects` 那条的 `scope`：来源观察全部消息。 */
function scopeForObserved() {
  return () => ({ scope: () => ({ listened: true, observed: true }) })
}
