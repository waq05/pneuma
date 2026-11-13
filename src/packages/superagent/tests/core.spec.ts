/**
 * @pneuma/superagent 领域核心的包级测试：钉三组判据 + 版本与影响面。
 *
 * 为什么是这三组（`docs/superagent-design.md:678-689` 第 3 步）：
 *   1. 准入表三档强度——explicit / inferred / 不接，是「谁有权发起工作」的唯一判据；
 *   2. 接单模式 off / observe / auto——决定推断出来的候选是被评估、只记录、还是根本不看；
 *   3. Mandate 重新校验——工单结束后能不能带着旧授权继续干，全看这一条。
 * 这三样任何一样漂了，症状都不是报错，而是「不该接的接了」或「该接的接不了」，所以要钉死。
 *
 * 断言来源：除标注「自补」的两条外，全部照抄上游
 * `D:\code\dsh-superagent-prototype\tests\policy.spec.ts`，每条用例标题后面注明上游行号。
 * 上游用 `SourceRegistry` + 真实的 Feishu / GitHub 来源插件取接收范围；本包还没有来源适配层，
 * 所以用下面 `scopeOf()` 这个 stub 复刻同一批 `scope()` 返回值（注释里写明每个分支对应上游哪条断言），
 * 判据（`gate` / `revalidate` 的结论）仍是上游原文。
 *
 * import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const {
  SettingsSchema,
  allowedSender,
  anyoneAllowed,
  assessmentOutcome,
  policyEffects,
  policyVersion,
  settingsPolicy,
} = await import('../../../../lib/packages/superagent/core/policy.js')

const MEMBER = 'ou_alice'
const CHAT = 'oc_team'
const OBSERVED = 'oc_1111111111111111111111111111'

let passed = 0

/** `SettingsSchema.parse` 的输入：两个来源的计划，与上游 `base` 同形。 */
const feishuSource = (config, enabled = true) => ({ enabled, config })
const base = SettingsSchema.parse({
  policy: {
    sources: {
      feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT },
      github: { allowed: [{ id: 'Alice' }] },
    },
  },
  eval: { mode: 'auto' },
  sources: {
    feishu: feishuSource({
      chats: [{ chatId: CHAT, listen: 'mentions' }, { chatId: OBSERVED, listen: 'all' }],
      directMessages: true,
    }),
  },
})

/**
 * 复刻上游 Feishu / GitHub 来源插件的 `scope()`（这两条分支的返回值逐条对着上游断言写）：
 * - Feishu：点名群 → observed=false；全量群 → observed=true；私信 → row 'direct'；未列群 → 不监听；
 *   `otherChats: 'mentions'` 时未列群按 row 'other' 接收点名；
 * - GitHub：默认监听但不观察；`observeComments` / `observeCi` / `observeIssues` 打开时对应行才观察。
 * 未配置的来源实例按「启用、空配置」处理（上游 `SourceRegistry` 同此行为）。
 */
function scopeOf(settings) {
  return {
    scope({ source, meta }) {
      const instance = settings.sources[source] ?? { enabled: true, config: {} }
      if (instance.enabled === false) return { listened: false, reason: 'source_disabled' }
      const config = instance.config ?? {}
      if (source === 'github') {
        if (meta.ci === true) {
          // 默认分支的 CI 有 row 'ci'，PR 的 CI 不归任何行。
          if (meta.number !== undefined) return { listened: true, observed: false }
          return { listened: true, observed: config.observeCi === true, row: 'ci' }
        }
        if (meta.kind === 'conversation') return { listened: true, observed: config.observeComments === true, row: 'comments' }
        if (meta.kind === 'issue') return { listened: true, observed: config.observeIssues === true, row: 'issues' }
        if (meta.kind === 'pull') return { listened: true, observed: false, row: 'pulls' }
        return { listened: true, observed: false }
      }
      if (source !== 'feishu') return { listened: true, observed: false }
      if (meta.direct === true) {
        return config.directMessages === false
          ? { listened: false, reason: 'direct_messages_not_allowed' }
          : { listened: true, observed: false, row: 'direct' }
      }
      const chat = (config.chats ?? []).find((item) => item.chatId === meta.chatId)
      if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
      if (config.otherChats === 'mentions') return { listened: true, observed: false, row: 'other' }
      return { listened: false, reason: 'chat_not_allowed' }
    },
  }
}

function setup(settings = base) {
  const sources = scopeOf(settings)
  return { sources, policy: settingsPolicy(settings, sources), version: policyVersion(settings) }
}

const thread = (subscriptions = []) => ({
  key: 'feishu:x',
  ref: { source: 'feishu', id: 'x' },
  createdAt: '',
  subscriptions,
  correlated: [],
  pending: [],
  meta: {},
})

const feishu = (overrides = {}) => ({
  id: 't',
  source: 'feishu',
  threads: [{ source: 'feishu', id: 'x' }],
  actor: { source: 'feishu', id: MEMBER },
  human: true,
  at: '',
  text: 'hi',
  addressed: 'mention',
  meta: { chatId: CHAT, direct: false, mentioned: true },
  ...overrides,
})

const unaddressed = (overrides = {}) => {
  const { addressed: _addressed, ...rest } = feishu(overrides)
  return rest
}

const github = (login, addressed) => ({
  id: 'g',
  source: 'github',
  threads: [{ source: 'github', id: '1' }],
  actor: { source: 'github', id: login },
  human: true,
  at: '',
  text: 'x',
  ...(addressed ? { addressed } : {}),
  meta: { number: 1, isPr: true },
})

const ticket = { id: 'ticket', ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' } }

/**
 * 断言工具：node:assert 没有 `toMatchObject`，这里按同样的语义实现（只查给出的键，不做全等）。
 * 上游 `toEqual` 的地方一律用 `assert.deepEqual`，不降级。
 */
function matchObject(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected)
  if (typeof actual !== 'object' || actual === null) return false
  for (const [key, value] of Object.entries(expected)) if (!matchObject(actual[key], value)) return false
  return true
}

function assertMatch(actual, expected) {
  assert.ok(
    matchObject(actual, expected),
    `实际 ${JSON.stringify(actual)} 不匹配期望 ${JSON.stringify(expected)}`,
  )
}

const { policy } = setup()

// ── gate：准入判定的基本形态（上游 tests/policy.spec.ts:53-89）─────────────────

test('gate：名单内发送者点名 → explicit（上游 policy.spec.ts:54）', () => {
  assertMatch(policy.gate(feishu(), thread(), []), {
    admissible: true,
    strength: 'explicit',
    basis: { via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: { chatId: CHAT } },
  })
  assertMatch(policy.gate(feishu({ addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), []), {
    admissible: true,
    strength: 'explicit',
    basis: { addressed: 'direct' },
  })
  // GitHub 登录名按大小写不敏感比较；条目没有显示名时用 id 命名发送者。
  assertMatch(policy.gate(github('alice', 'mention'), thread(), []), {
    admissible: true,
    strength: 'explicit',
    basis: { source: 'github', sender: 'Alice' },
  })
  passed += 1
})

test('gate：各来源各一张名单，Feishu id 在 GitHub 上不放行（上游 policy.spec.ts:60）', () => {
  assert.deepEqual(policy.gate(github(MEMBER, 'mention'), thread(), []), { admissible: false, reason: 'not_a_member' })
  assert.deepEqual(allowedSender(base, { source: 'github', id: 'ALICE' }), { id: 'Alice' })
  assert.equal(allowedSender(base, { source: 'feishu', id: 'Alice' }), undefined)
  assert.equal(anyoneAllowed(base), true)
  assert.equal(anyoneAllowed(SettingsSchema.parse({})), false)
  passed += 1
})

test('gate：线程上已有工单的追加消息按 followup 判（上游 policy.spec.ts:67）', () => {
  const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
  assertMatch(policy.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), []), {
    admissible: true,
    strength: 'inferred',
    basis: { via: 'followup' },
  })
  assertMatch(policy.gate(unaddressed(quiet), thread(['ticket']), []), {
    admissible: true,
    strength: 'explicit',
    basis: { via: 'followup', sender: 'Alice' },
  })
  assertMatch(policy.gate(github('someone'), thread(), [ticket]), { admissible: true, strength: 'inferred' })
  // 只为上下文关注的线程不产生 followup：仍按准入表判，和普通线程一样。
  const context = { ...thread(['ticket']), context: ['ticket'] }
  assertMatch(policy.gate(unaddressed(quiet), context, [ticket]), { admissible: false })
  passed += 1
})

test('gate：被观察的未点名消息 → inferred；off 时 no_mention（上游 policy.spec.ts:76）', () => {
  const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
  assertMatch(policy.gate(observed, thread(), []), {
    admissible: true,
    strength: 'inferred',
    basis: { via: 'admission', observation: { mode: 'auto' } },
  })
  assert.deepEqual(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy.gate(observed, thread(), []), {
    admissible: false,
    reason: 'no_mention',
  })
  passed += 1
})

test('gate：未列名单者的私信不按 followup 放行（上游 policy.spec.ts:81）', () => {
  assert.deepEqual(
    policy.gate(
      feishu({ actor: { source: 'feishu', id: 'ou_guest' }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }),
      thread(['ticket']),
      [],
    ),
    { admissible: false, reason: 'not_a_member' },
  )
  passed += 1
})

test('gate：机器人 / 未列名单 / 未点名分别拒绝（上游 policy.spec.ts:84）', () => {
  assert.deepEqual(policy.gate(feishu({ human: false }), thread(), []), { admissible: false, reason: 'not_human' })
  assert.deepEqual(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' } }), thread(), []), {
    admissible: false,
    reason: 'not_a_member',
  })
  assert.deepEqual(policy.gate(unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } }), thread(), []), {
    admissible: false,
    reason: 'no_mention',
  })
  passed += 1
})

test('admission：表全空时复刻旧行为（上游 policy.spec.ts:102）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId, sender = MEMBER, addressed = true) => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  assertMatch(policy.gate(inChat(OBSERVED, MEMBER, false), thread(), []), {
    admissible: true,
    strength: 'inferred',
    basis: { via: 'admission', row: OBSERVED, cell: 'listedUnaddressed', observation: { mode: 'auto' } },
  })
  assert.deepEqual(policy.gate(inChat(CHAT, STRANGER), thread(), []), { admissible: false, reason: 'not_a_member' })
  assert.deepEqual(
    policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), []),
    { admissible: false, reason: 'not_a_member' },
  )
  // 名单内发送者点名一律 explicit，跟表格怎么写无关。
  assertMatch(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }).policy.gate(inChat(CHAT), thread(), []), {
    admissible: true,
    strength: 'explicit',
  })
  passed += 1
})

/** 准入表用例的公共构造：改表格 / 改来源配置 / 改接单模式，其余沿用 `base`。 */
function withTable(admission, config = {}, mode = 'auto') {
  const settings = SettingsSchema.parse({
    ...base,
    eval: { ...base.eval, mode },
    sources: { ...base.sources, feishu: { enabled: true, config: { ...base.sources.feishu.config, ...config } } },
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu, admission } } },
  })
  return setup(settings)
}

test('admission：未列名单者点名按格子给 explicit 或 inferred，inferred 需要评估模式（上游 policy.spec.ts:109）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId, sender = MEMBER, addressed = true) => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  const explicit = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }).policy.gate(inChat(CHAT, STRANGER), thread(), [])
  assert.deepEqual(explicit, {
    admissible: true,
    strength: 'explicit',
    basis: {
      source: 'feishu',
      scope: { chatId: CHAT, direct: false, mentioned: true },
      row: CHAT,
      via: 'admission',
      cell: 'unlistedAddressed',
      addressed: 'mention',
    },
  })
  assertMatch(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }).policy.gate(inChat(CHAT, STRANGER), thread(), []), {
    admissible: true,
    strength: 'inferred',
    basis: { cell: 'unlistedAddressed' },
  })
  assert.deepEqual(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }, {}, 'off').policy.gate(inChat(CHAT, STRANGER), thread(), []), {
    admissible: false,
    reason: 'not_a_member',
  })
  assertMatch(
    withTable({ direct: { unlistedAddressed: 'explicit' } }).policy.gate(
      feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }),
      thread(),
      [],
    ),
    { admissible: true, strength: 'explicit', basis: { row: 'direct', cell: 'unlistedAddressed' } },
  )
  // 表格里没配这个群的行：不放假。
  assert.deepEqual(withTable({ [OBSERVED]: { unlistedAddressed: 'explicit' } }).policy.gate(inChat(CHAT, STRANGER), thread(), []), {
    admissible: false,
    reason: 'not_a_member',
  })
  passed += 1
})

test('admission：名单内未点名消息按格子忽略，不接收的消息不查表（上游 policy.spec.ts:117）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId, sender = MEMBER, addressed = true) => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  assert.deepEqual(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore' } }).policy.gate(inChat(OBSERVED, MEMBER, false), thread(), []), {
    admissible: false,
    reason: 'admission_ignored',
  })
  // 只收点名的群收不到未点名消息，所以哪怕是 inferred 的格子也不放行。
  assert.deepEqual(withTable({ [CHAT]: { listedUnaddressed: 'inferred' } }).policy.gate(inChat(CHAT, MEMBER, false), thread(), []), {
    admissible: false,
    reason: 'no_mention',
  })
  assert.deepEqual(withTable({ [CHAT]: { unlistedUnaddressed: 'inferred' } }).policy.gate(inChat(CHAT, STRANGER, false), thread(), []), {
    admissible: false,
    reason: 'not_a_member',
  })
  passed += 1
})

test('admission：other 行只在来源配置允许时放行未列聊天（上游 policy.spec.ts:123）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId, sender = MEMBER, addressed = true) => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  assert.deepEqual(setup().sources.scope(inChat('oc_elsewhere')), { listened: false, reason: 'chat_not_allowed' })
  const others = withTable({ other: { unlistedAddressed: 'explicit' } }, { otherChats: 'mentions' })
  assert.deepEqual(others.sources.scope(inChat('oc_elsewhere')), { listened: true, observed: false, row: 'other' })
  assertMatch(others.policy.gate(inChat('oc_elsewhere'), thread(), []), { admissible: true, strength: 'explicit', basis: { row: 'other' } })
  assertMatch(others.policy.gate(inChat('oc_elsewhere', STRANGER), thread(), []), {
    admissible: true,
    strength: 'explicit',
    basis: { row: 'other', cell: 'unlistedAddressed' },
  })
  passed += 1
})

test('admission：off 模式下没有 inferred followup，名单内发送者仍是 explicit（上游 policy.spec.ts:130）', () => {
  const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
  const off = setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy
  assert.deepEqual(off.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), []), {
    admissible: false,
    reason: 'not_a_member',
  })
  assertMatch(off.gate(unaddressed(quiet), thread(['ticket']), []), {
    admissible: true,
    strength: 'explicit',
    basis: { via: 'followup' },
  })
  passed += 1
})

test('admission：explicit 格子在任何模式都算明确请求（上游 policy.spec.ts:137）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId, sender = MEMBER, addressed = true) => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  for (const mode of ['auto', 'observe', 'off']) {
    const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }, {}, mode)
    assertMatch(open.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), []), {
      admissible: true,
      strength: 'explicit',
      basis: { via: 'admission', cell: 'unlistedAddressed' },
    })
    // 格子不是 explicit 时，followup 仍按 inferred 走，只要评估没关。
    const strict = withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }, {}, mode)
    assertMatch(
      strict.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), []),
      mode === 'off' ? { admissible: false } : { admissible: true, strength: 'inferred', basis: { via: 'followup' } },
    )
  }
  passed += 1
})

test('admission：有工单线程的 followup 不受表格约束（上游 policy.spec.ts:148）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId, sender = MEMBER, addressed = true) => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  const strict = withTable({ [OBSERVED]: { listedUnaddressed: 'ignore', unlistedUnaddressed: 'ignore' } })
  assertMatch(strict.policy.gate(inChat(OBSERVED, MEMBER, false), thread(['ticket']), []), {
    admissible: true,
    strength: 'explicit',
    basis: { via: 'followup' },
  })
  assertMatch(strict.policy.gate(inChat(OBSERVED, STRANGER, false), thread(['ticket']), []), {
    admissible: true,
    strength: 'inferred',
    basis: { via: 'followup' },
  })
  passed += 1
})

test('admission：格子变弱会让 Mandate 失效，格子不变则保持（上游 policy.spec.ts:153）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = () =>
    feishu({ actor: { source: 'feishu', id: STRANGER }, meta: { chatId: CHAT, direct: false, mentioned: true } })
  const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })
  const gate = open.policy.gate(inChat(), thread(), [])
  if (!gate.admissible) throw new Error('expected admission')
  const mandate = { strength: gate.strength, policyVersion: 'v', basis: gate.basis, actor: { source: 'feishu', id: STRANGER }, scope: '' }
  assert.equal(open.policy.revalidate(mandate), true)
  assert.equal(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }).policy.revalidate(mandate), false)
  assert.equal(withTable({}).policy.revalidate(mandate), false)
  passed += 1
})

test('admission：格子变化会改 Policy 版本（上游 policy.spec.ts:162）', () => {
  assert.notEqual(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }).version, setup().version)
  assert.equal(withTable({}).version, setup().version)
  passed += 1
})

// ── 接单模式：off / observe / auto（上游 policy.spec.ts:277-325）──────────────

test('mode：auto 下按命中规则接受 inferred，命中规则必须启用（上游 policy.spec.ts:287）', () => {
  const settings = (mode) => {
    const parsed = SettingsSchema.parse({})
    return { ...parsed, eval: { ...parsed.eval, mode } }
  }
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const judged = (current, matched) =>
    current.policy.rules.filter((rule) => rule.enabled).map((rule) => ({ rule_id: rule.id, matched, reason: 'judged' }))
  const accept = (current, matched = true) => ({
    decision: 'accept',
    rule_assessments: judged(current, matched),
    direction,
    title: 'Fix',
    scope: 'small',
    reason: 'asked',
    intent_evidence: 'quote',
    worktree_name: 'fix-copy',
  })
  const auto = settings('auto')
  const outcome = assessmentOutcome(accept(auto), auto, 'inferred')
  assertMatch(outcome, {
    kind: 'accept',
    rules: auto.policy.rules.filter((rule) => rule.enabled).map((rule) => rule.id),
    name: 'fix-copy',
  })
  assertMatch(assessmentOutcome(accept(settings('observe')), settings('observe'), 'inferred'), {
    kind: 'ignore',
    reason: { code: 'observed', values: { text: 'asked' } },
    audit: { would_accept: true },
  })
  assertMatch(assessmentOutcome(accept(auto, false), auto, 'inferred'), { kind: 'ignore', reason: { code: 'noRuleMatched' } })
  assert.throws(
    () => assessmentOutcome({ ...accept(auto), rule_assessments: [] }, auto, 'inferred'),
    /Exactly one assessment for every enabled rule/,
  )
  assert.throws(
    () => assessmentOutcome({ ...accept(auto), intent_evidence: null }, auto, 'inferred'),
    /Acceptance requires intent_evidence/,
  )
  const scope = { scope: () => ({ listened: true, observed: true }) }
  const enabled = auto.policy.rules.find((rule) => rule.enabled).id
  assert.equal(settingsPolicy(auto, scope).admitsInferred([enabled]), true)
  assert.equal(settingsPolicy(auto, scope).admitsInferred(['unknown']), false)
  assert.equal(settingsPolicy(auto, scope).admitsInferred([]), false)
  assert.equal(settingsPolicy(settings('observe'), scope).admitsInferred([enabled]), false)
  passed += 1
})

test('mode：explicit 候选不受接单模式影响，off 与 observe 下照常接受（上游 policy.spec.ts:315）', () => {
  const rules = SettingsSchema.parse({}).policy.rules.filter((rule) => rule.enabled)
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const assessment = {
    decision: 'accept',
    direction,
    title: 'Fix',
    scope: 'small',
    reason: 'asked',
    intent_evidence: 'quote',
    rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: 'judged' })),
  }
  for (const mode of ['observe', 'off']) {
    const settings = SettingsSchema.parse({ eval: { mode } })
    assertMatch(assessmentOutcome(assessment, settings, 'explicit'), { kind: 'accept', title: 'Fix' })
    assertMatch(assessmentOutcome(assessment, settings, 'inferred'), { kind: 'ignore', reason: { code: 'observed' } })
  }
  passed += 1
})

test('mode：off 下 gate 不接 inferred，observe 下仍产生 inferred 候选（上游 policy.spec.ts:76/130）', () => {
  const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
  const quiet = unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } })
  for (const mode of ['off', 'observe', 'auto']) {
    const current = setup({ ...base, eval: { ...base.eval, mode } }).policy
    const listed = current.gate(observed, thread(), [])
    if (mode === 'off') assert.deepEqual(listed, { admissible: false, reason: 'no_mention' })
    else assertMatch(listed, { admissible: true, strength: 'inferred' })
    // 名单内发送者的未点名消息在任何模式下都是 explicit followup：off 只关掉「推断」，不关掉「明确」。
    assertMatch(current.gate(quiet, thread(['ticket']), []), { admissible: true, strength: 'explicit' })
  }
  passed += 1
})

// ── Mandate 重新校验（上游 policy.spec.ts:167-231）──────────────────────────

test('Mandate：准入表矩阵（listedUnaddressed × inferred，上游 policy.spec.ts:167）', () => {
  revalidateMatrix({ cell: 'listedUnaddressed', strength: 'inferred' })
  passed += 1
})
test('Mandate：准入表矩阵（unlistedAddressed × explicit，上游 policy.spec.ts:167）', () => {
  revalidateMatrix({ cell: 'unlistedAddressed', strength: 'explicit' })
  passed += 1
})
test('Mandate：准入表矩阵（unlistedAddressed × inferred，上游 policy.spec.ts:167）', () => {
  revalidateMatrix({ cell: 'unlistedAddressed', strength: 'inferred' })
  passed += 1
})
test('Mandate：准入表矩阵（unlistedUnaddressed × inferred，上游 policy.spec.ts:167）', () => {
  revalidateMatrix({ cell: 'unlistedUnaddressed', strength: 'inferred' })
  passed += 1
})

const CELLS = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
const SENDER = 'ou_sender'

/**
 * 上游 `it.each` 那张表：4 种来源 × 名单内/外 × 三种模式 × 规则启用/停用 × 群接收 all/mentions/none × 格子握住/失效。
 * 每个来源 36 组，断言逐个照抄（含 `expected()` 的判据本身）。
 */
function revalidateMatrix(origin) {
  const cases = [true, false].flatMap((listed) =>
    ['off', 'observe', 'auto'].flatMap((mode) =>
      [true, false].flatMap((rule) =>
        ['all', 'mentions', 'none'].flatMap((scope) => [true, false].map((holds) => ({ listed, mode, rule, scope, holds }))),
      ),
    ),
  )
  /** docs/002：线程必须仍被接收；名单内发送者点名一律 explicit；后来进名单的发送者走 listed 格子。 */
  function expected({ listed, mode, rule, scope, holds }) {
    if (scope === 'none') return false
    if (origin.cell === 'unlistedAddressed' && listed) return true
    const now = origin.cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : origin.cell
    if ((now === 'listedUnaddressed' && !listed) || !holds) return false
    return origin.strength === 'explicit' || (mode === 'auto' && rule)
  }
  for (const item of cases) {
    // 行给出与接受时同等或更强的强度；格子不成立时给 ignore。
    const grant = (cell) => (!item.holds ? 'ignore' : cell === 'unlistedAddressed' ? origin.strength : 'inferred')
    const chats = item.scope === 'none' ? [] : [{ chatId: CHAT, listen: item.scope }]
    const settings = SettingsSchema.parse({
      eval: { mode: item.mode },
      sources: { feishu: feishuSource({ chats, directMessages: true }) },
      policy: {
        rules: [{ id: 'copy', name: 'Copy', enabled: item.rule, instruction: 'x' }],
        sources: {
          feishu: { allowed: item.listed ? [{ id: SENDER }] : [], admission: { [CHAT]: Object.fromEntries(CELLS.map((cell) => [cell, grant(cell)])) } },
        },
      },
    })
    const addressed = origin.cell === 'unlistedAddressed'
    const observed = origin.strength === 'inferred' ? { observation: { mode: 'auto' }, rules: ['copy'] } : {}
    const basis = {
      via: 'admission',
      source: 'feishu',
      scope: { chatId: CHAT, direct: false, mentioned: addressed },
      row: CHAT,
      cell: origin.cell,
      ...(addressed ? { addressed: 'mention' } : {}),
      ...observed,
    }
    const mandate = { strength: origin.strength, policyVersion: 'v', basis, actor: { source: 'feishu', id: SENDER }, scope: '' }
    const actual = setup(settings).policy.revalidate(mandate)
    assert.equal(
      actual,
      expected(item),
      `cell=${origin.cell} strength=${origin.strength} listed=${item.listed} mode=${item.mode} rule=${item.rule} scope=${item.scope} holds=${item.holds}`,
    )
  }
}

test('Mandate：explicit 随名单与监听存活，规则型只随 auto 与启用规则存活（上游 policy.spec.ts:206）', () => {
  const basis = { via: 'addressed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice', addressed: 'mention' }
  const mandate = { strength: 'explicit', policyVersion: 'v', basis, actor: { source: 'feishu', id: MEMBER }, scope: '' }
  assert.equal(policy.revalidate(mandate), true)
  const nobody = { ...base, policy: { ...base.policy, sources: {} } }
  assert.equal(setup(nobody).policy.revalidate(mandate), false)
  const silent = { ...base, sources: { feishu: feishuSource({ chats: [], directMessages: true }) } }
  assert.equal(setup(silent).policy.revalidate(mandate), false)
  // 记录 basis 之前签发的 Mandate：发送者仍在名单、来源仍在听，就继续成立。
  const listed = { via: 'listed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice' }
  assert.equal(setup(silent).policy.revalidate({ ...mandate, basis: listed }), false)
  assert.equal(policy.revalidate({ ...mandate, basis: listed }), true)
  const inferred = { ...mandate, strength: 'inferred', basis: { via: 'listed', observation: {}, rules: ['copy'] } }
  assert.equal(policy.revalidate(inferred), true)
  assert.equal(setup({ ...base, eval: { ...base.eval, mode: 'observe' } }).policy.revalidate(inferred), false)
  assert.equal(
    setup({ ...base, policy: { ...base.policy, rules: base.policy.rules.map((rule) => ({ ...rule, enabled: rule.id !== 'copy' })) } }).policy.revalidate(inferred),
    false,
  )
  assert.equal(setup(nobody).policy.revalidate({ ...mandate, basis: { via: 'followup' } }), true)
  passed += 1
})

test('Mandate：机器人候选随名单与 auto 模式存活（上游 policy.spec.ts:433，来源换成 Feishu）', () => {
  const settings = SettingsSchema.parse({
    ...base,
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts' }] } } },
  })
  const meta = { chatId: CHAT, direct: false, mentioned: true }
  const mandate = {
    strength: 'inferred',
    policyVersion: '',
    actor: { source: 'feishu', id: 'cli_alerts' },
    scope: '',
    basis: { via: 'bot', source: 'feishu', scope: meta, row: CHAT, sender: 'cli_alerts', observation: { mode: 'auto' } },
  }
  assert.equal(setup(settings).policy.revalidate(mandate), true)
  const withoutBots = SettingsSchema.parse({
    ...base,
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu, bots: [] } } },
  })
  assert.equal(setup(withoutBots).policy.revalidate(mandate), false)
  assert.equal(setup({ ...settings, eval: { ...settings.eval, mode: 'observe' } }).policy.revalidate(mandate), false)
  passed += 1
})

test('Mandate：名单内的机器人点名才进候选（上游 policy.spec.ts:326）', () => {
  const settings = SettingsSchema.parse({
    ...base,
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts' }] } } },
  })
  const mention = feishu({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false, meta: { chatId: CHAT, direct: false, mentioned: true } })
  assertMatch(setup(settings).policy.gate(mention, thread(), []), {
    admissible: true,
    strength: 'inferred',
    basis: { via: 'bot', addressed: 'mention', row: CHAT },
  })
  passed += 1
})

// ── 版本与影响面（上游 policy.spec.ts:224-231、346-378）─────────────────────

test('policyVersion：规则、接单模式、来源授权变化才改版本（上游 policy.spec.ts:224）', () => {
  const { version } = setup()
  assert.equal(
    setup({
      ...base,
      paused: true,
      executor: { ...base.executor, maxWorkers: 9 },
      eval: { ...base.eval, timeoutSeconds: 300 },
      sources: { ...base.sources, github: { enabled: true, config: { pollSeconds: 600 } } },
    }).version,
    version,
  )
  assert.equal(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).version, version)
  assert.notEqual(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).version, version)
  assert.notEqual(
    setup({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, github: { allowed: [], admission: {} } } } }).version,
    version,
  )
  passed += 1
})

const effectBase = SettingsSchema.parse({
  policy: {
    rules: [
      { id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
      { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' },
    ],
    sources: { feishu: { allowed: [{ id: 'ou_alice' }] } },
  },
})
const effectScope = () => ({ scope: () => ({ listened: true, observed: true }) })
const effectTicket = (id, mandate) => ({ id, mandate })

test('policyEffects：告诉工单这次变更怎么影响它，其余工单不动（上游 policy.spec.ts:354）', () => {
  const inferred = effectTicket('t1', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, basis: { via: 'listed', rules: ['copy'] } })
  const explicit = effectTicket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  const rules = (copy, visual = {}) => ({
    ...effectBase,
    policy: {
      ...effectBase.policy,
      rules: [{ ...effectBase.policy.rules[0], ...copy }, { ...effectBase.policy.rules[1], ...visual }],
    },
  })
  assert.equal(policyEffects([inferred, explicit], effectBase, rules({}, { enabled: false }), effectScope).size, 0)
  assert.deepEqual(policyEffects([inferred], effectBase, rules({ instruction: 'Fix typos only.' }), effectScope).get('t1'), {
    rules: [{ id: 'copy', name: 'Copy', change: 'changed', instruction: 'Fix typos only.' }],
  })
  assert.deepEqual(policyEffects([inferred], effectBase, rules({ enabled: false }), effectScope).get('t1'), {
    rules: [{ id: 'copy', name: 'Copy', change: 'disabled' }],
  })
  // 名单里多一个人不影响工单；把发起人移出名单才会。
  const allowed = (list) => ({
    ...effectBase,
    policy: { ...effectBase.policy, sources: { ...effectBase.policy.sources, feishu: { ...effectBase.policy.sources.feishu, allowed: list } } },
  })
  assert.equal(policyEffects([inferred, explicit], effectBase, allowed([{ id: 'ou_alice' }, { id: 'ou_bob' }]), effectScope).size, 0)
  assert.deepEqual(policyEffects([explicit], effectBase, allowed([]), effectScope).get('t2'), {
    requesterAllowed: false,
    requester: { source: 'feishu', id: 'ou_alice' },
  })
  passed += 1
})

test('policyEffects：接单模式离开 auto 时推断工单报 proactive:false（上游 policy.spec.ts:366）', () => {
  const rule = effectTicket('t3', {
    strength: 'inferred',
    actor: { source: 'feishu', id: 'ou_alice' },
    basis: { via: 'listed', source: 'feishu', rules: ['copy'], observation: {} },
  })
  const explicit = effectTicket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  const auto = { ...effectBase, eval: { ...effectBase.eval, mode: 'auto' } }
  const observe = { ...effectBase, eval: { ...effectBase.eval, mode: 'observe' } }
  const effects = policyEffects([rule, explicit], auto, observe, effectScope)
  // 不是发起人被移除：写这句话的人仍可发起工作。
  assert.deepEqual(effects.get('t3'), { proactive: false })
  assert.equal(effects.has('t2'), false)
  const bot = effectTicket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'cli_ci_bot' }, basis: { via: 'listed', source: 'feishu' } })
  const listed = {
    ...effectBase,
    policy: { ...effectBase.policy, sources: { ...effectBase.policy.sources, feishu: { ...effectBase.policy.sources.feishu, allowed: [{ id: 'cli_ci_bot' }] } } },
  }
  assert.deepEqual(policyEffects([bot], listed, effectBase, effectScope).get('t4'), {
    requesterAllowed: false,
    requester: { source: 'feishu', id: 'cli_ci_bot' },
  })
  passed += 1
})

// ── 设计文档 §4.3：P0 手动来源必须走 gate（自补）────────────────────────────

test('P0 手动来源：三种接单模式下都判定为 explicit（自补，依据 docs/superagent-design.md:203-218）', () => {
  // 设计文档 §4.3：P0 只有手动来源，发送者是操作者本人、addressed='mention'，结果恒为 explicit，
  // 且「这条路径必须走 gate，不能跳过」——因此这里断言 gate 本身的输出，而不是绕过它。
  const settings = (mode) =>
    SettingsSchema.parse({
      eval: { mode },
      policy: { sources: { manual: { allowed: [{ id: 'operator' }] } } },
      sources: { manual: { enabled: true, config: {} } },
    })
  const trigger = {
    id: 'm1',
    source: 'manual',
    threads: [{ source: 'manual', id: 'ticket-1' }],
    actor: { source: 'manual', id: 'operator' },
    human: true,
    at: '2026-01-01T00:00:00.000Z',
    text: '改登录页文案',
    addressed: 'mention',
    meta: {},
  }
  for (const mode of ['off', 'observe', 'auto']) {
    const current = settingsPolicy(settings(mode), scopeOf(settings(mode)))
    const result = current.gate(trigger, thread(), [])
    assert.equal(result.admissible, true, `mode=${mode} 应放行手动来源`)
    assert.equal(result.strength, 'explicit', `mode=${mode} 手动来源应恒为 explicit`)
    assert.equal(result.basis.via, 'addressed', `mode=${mode} 依据应为 addressed`)
    assert.equal(result.basis.sender, 'operator')
  }
  passed += 1
})

after(() => {
  console.log(`通过 ${passed}`)
})
