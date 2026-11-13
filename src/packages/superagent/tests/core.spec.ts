/**
 * @pneuma/superagent 领域核心的包级测试：钉三组判据 + 版本与影响面。
 *
 * 为什么是这三组（`docs/superagent-design.md:678-689` 第 3 步）：
 *   1. 准入表三档强度——explicit / inferred / 不接，是「谁有权发起工作」的唯一判据；
 *   2. 接单模式 off / observe / auto——决定推断出来的候选是被评估、只记录、还是根本不看；
 *   3. Mandate 重新校验——工单结束后能不能带着旧授权继续干，全看这一条。
 * 这三样任何一样漂了，症状都不是报错，而是「不该接的接了」或「该接的接不了」，所以要钉死。
 *
 * 断言来源：除标注「自补」的一条外，全部照抄上游
 * `D:\code\dsh-superagent-prototype\tests\policy.spec.ts`，每条用例标题后面注明上游行号。
 * 上游用 `SourceRegistry` + 真实的 Feishu / GitHub 来源插件取接收范围；本包还没有 Feishu 来源适配层
 * （`adapters/scope.ts` 只登记 manual 与 GitHub），所以用下面 `scopeOf()` 这个 stub 复刻同一批 `scope()`
 * 返回值（注释里写明每个分支对应上游哪条断言），判据（`gate` / `revalidate` 的结论）仍是上游原文。
 *
 * 迁移说明：原文件跑的是构建产物、先手工 build；现在直接 import 源码。
 *
 * @module @pneuma/superagent/tests
 */
import { expect, test } from 'vitest'
import type {
  AcceptMode,
  AdmissionCell,
  Mandate,
  MandateBasis,
  Strength,
  Thread,
  Ticket,
  Trigger,
} from '../core/model.js'
import type { AdmissionRow } from '../core/admission.js'
import type { Assessment, Rule, Settings, SourcePolicy } from '../core/policy.js'
import type { GateResult, SourceScope } from '../core/ports.js'

const {
  SettingsSchema,
  allowedSender,
  anyoneAllowed,
  assessmentOutcome,
  policyEffects,
  policyVersion,
  settingsPolicy,
} = await import('../core/policy.js')

const MEMBER = 'ou_alice'
const CHAT = 'oc_team'
const OBSERVED = 'oc_1111111111111111111111111111'

/** `SettingsSchema.parse` 的输入：一个来源实例（启用状态 + 该来源自己的配置），与上游 `base` 同形。 */
const feishuSource = (
  config: Record<string, unknown>,
  enabled = true,
): { enabled: boolean; config: Record<string, unknown> } => ({ enabled, config })
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
function scopeOf(settings: Settings): SourceScope {
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
      const chats = (config.chats as { chatId: string; listen: string }[] | undefined) ?? []
      const chat = chats.find((item) => item.chatId === meta.chatId)
      if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
      if (config.otherChats === 'mentions') return { listened: true, observed: false, row: 'other' }
      return { listened: false, reason: 'chat_not_allowed' }
    },
  }
}

function setup(settings: Settings = base) {
  const sources = scopeOf(settings)
  return { sources, policy: settingsPolicy(settings, sources), version: policyVersion(settings) }
}

const thread = (subscriptions: string[] = []): Thread => ({
  key: 'feishu:x',
  ref: { source: 'feishu', id: 'x' },
  createdAt: '',
  subscriptions,
  correlated: [],
  pending: [],
  meta: {},
})

const feishu = (overrides: Partial<Trigger> = {}): Trigger => ({
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

const unaddressed = (overrides: Partial<Trigger> = {}): Trigger => {
  const { addressed: _addressed, ...rest } = feishu(overrides)
  return rest
}

const github = (login: string, addressed?: 'mention' | 'direct'): Trigger => ({
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

/** 一张工单；只填本用例用到的字段（`gate` 只读 `id`，其余字段与授权判定无关）。 */
const ticket = {
  id: 'ticket',
  ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' },
} as unknown as Ticket

/** 准入闸的判别联合：接单才算过闸，不过就带原因让用例失败（与 `sources.spec.ts` 同一写法）。 */
function admitted(result: GateResult): Extract<GateResult, { admissible: true }> {
  if (!result.admissible) throw new Error(`期望接单，实际被判：${result.reason}（${JSON.stringify(result)}）`)
  return result
}

const { policy } = setup()

// ── gate：准入判定的基本形态（上游 tests/policy.spec.ts:53-89）─────────────────

test('gate：名单内发送者点名 → explicit（上游 policy.spec.ts:54）', () => {
  expect(policy.gate(feishu(), thread(), [])).toMatchObject({
    admissible: true,
    strength: 'explicit',
    basis: { via: 'addressed', source: 'feishu', sender: 'Alice', addressed: 'mention', scope: { chatId: CHAT } },
  })
  expect(policy.gate(feishu({ addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), [])).toMatchObject({
    admissible: true,
    strength: 'explicit',
    basis: { addressed: 'direct' },
  })
  // GitHub 登录名按大小写不敏感比较；条目没有显示名时用 id 命名发送者。
  expect(policy.gate(github('alice', 'mention'), thread(), [])).toMatchObject({
    admissible: true,
    strength: 'explicit',
    basis: { source: 'github', sender: 'Alice' },
  })
})

test('gate：各来源各一张名单，Feishu id 在 GitHub 上不放行（上游 policy.spec.ts:60）', () => {
  expect(policy.gate(github(MEMBER, 'mention'), thread(), [])).toStrictEqual({ admissible: false, reason: 'not_a_member' })
  expect(allowedSender(base, { source: 'github', id: 'ALICE' })).toStrictEqual({ id: 'Alice' })
  expect(allowedSender(base, { source: 'feishu', id: 'Alice' })).toBeUndefined()
  expect(anyoneAllowed(base)).toBe(true)
  expect(anyoneAllowed(SettingsSchema.parse({}))).toBe(false)
})

test('gate：线程上已有工单的追加消息按 followup 判（上游 policy.spec.ts:67）', () => {
  const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
  expect(policy.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), [])).toMatchObject({
    admissible: true,
    strength: 'inferred',
    basis: { via: 'followup' },
  })
  expect(policy.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({
    admissible: true,
    strength: 'explicit',
    basis: { via: 'followup', sender: 'Alice' },
  })
  expect(policy.gate(github('someone'), thread(), [ticket])).toMatchObject({ admissible: true, strength: 'inferred' })
  // 只为上下文关注的线程不产生 followup：仍按准入表判，和普通线程一样。
  const context = { ...thread(['ticket']), context: ['ticket'] }
  expect(policy.gate(unaddressed(quiet), context, [ticket])).toMatchObject({ admissible: false })
})

test('gate：被观察的未点名消息 → inferred；off 时 no_mention（上游 policy.spec.ts:76）', () => {
  const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
  expect(policy.gate(observed, thread(), [])).toMatchObject({
    admissible: true,
    strength: 'inferred',
    basis: { via: 'admission', observation: { mode: 'auto' } },
  })
  expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy.gate(observed, thread(), [])).toStrictEqual({
    admissible: false,
    reason: 'no_mention',
  })
})

test('gate：未列名单者的私信不按 followup 放行（上游 policy.spec.ts:81）', () => {
  expect(
    policy.gate(
      feishu({ actor: { source: 'feishu', id: 'ou_guest' }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }),
      thread(['ticket']),
      [],
    ),
  ).toStrictEqual({ admissible: false, reason: 'not_a_member' })
})

test('gate：机器人 / 未列名单 / 未点名分别拒绝（上游 policy.spec.ts:84）', () => {
  expect(policy.gate(feishu({ human: false }), thread(), [])).toStrictEqual({ admissible: false, reason: 'not_human' })
  expect(policy.gate(feishu({ actor: { source: 'feishu', id: 'ou_guest' } }), thread(), [])).toStrictEqual({
    admissible: false,
    reason: 'not_a_member',
  })
  expect(policy.gate(unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } }), thread(), [])).toStrictEqual({
    admissible: false,
    reason: 'no_mention',
  })
})

test('admission：表全空时复刻旧行为（上游 policy.spec.ts:102）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  expect(policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toMatchObject({
    admissible: true,
    strength: 'inferred',
    basis: { via: 'admission', row: OBSERVED, cell: 'listedUnaddressed', observation: { mode: 'auto' } },
  })
  expect(policy.gate(inChat(CHAT, STRANGER), thread(), [])).toStrictEqual({ admissible: false, reason: 'not_a_member' })
  expect(
    policy.gate(feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), []),
  ).toStrictEqual({ admissible: false, reason: 'not_a_member' })
  // 名单内发送者点名一律 explicit，跟表格怎么写无关。
  expect(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }).policy.gate(inChat(CHAT), thread(), [])).toMatchObject({
    admissible: true,
    strength: 'explicit',
  })
})

/** 准入表用例的公共构造：改表格 / 改来源配置 / 改接单模式，其余沿用 `base`。 */
function withTable(
  admission: Record<string, AdmissionRow>,
  config: Record<string, unknown> = {},
  mode: AcceptMode = 'auto',
) {
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
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  const explicit = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }).policy.gate(inChat(CHAT, STRANGER), thread(), [])
  expect(explicit).toStrictEqual({
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
  expect(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toMatchObject({
    admissible: true,
    strength: 'inferred',
    basis: { cell: 'unlistedAddressed' },
  })
  expect(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }, {}, 'off').policy.gate(inChat(CHAT, STRANGER), thread(), [])).toStrictEqual({
    admissible: false,
    reason: 'not_a_member',
  })
  expect(
    withTable({ direct: { unlistedAddressed: 'explicit' } }).policy.gate(
      feishu({ actor: { source: 'feishu', id: STRANGER }, addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }),
      thread(),
      [],
    ),
  ).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'direct', cell: 'unlistedAddressed' } })
  // 表格里没配这个群的行：不放假。
  expect(withTable({ [OBSERVED]: { unlistedAddressed: 'explicit' } }).policy.gate(inChat(CHAT, STRANGER), thread(), [])).toStrictEqual({
    admissible: false,
    reason: 'not_a_member',
  })
})

test('admission：名单内未点名消息按格子忽略，不接收的消息不查表（上游 policy.spec.ts:117）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  expect(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore' } }).policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toStrictEqual({
    admissible: false,
    reason: 'admission_ignored',
  })
  // 只收点名的群收不到未点名消息，所以哪怕是 inferred 的格子也不放行。
  expect(withTable({ [CHAT]: { listedUnaddressed: 'inferred' } }).policy.gate(inChat(CHAT, MEMBER, false), thread(), [])).toStrictEqual({
    admissible: false,
    reason: 'no_mention',
  })
  expect(withTable({ [CHAT]: { unlistedUnaddressed: 'inferred' } }).policy.gate(inChat(CHAT, STRANGER, false), thread(), [])).toStrictEqual({
    admissible: false,
    reason: 'not_a_member',
  })
})

test('admission：other 行只在来源配置允许时放行未列聊天（上游 policy.spec.ts:123）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  expect(setup().sources.scope(inChat('oc_elsewhere'))).toStrictEqual({ listened: false, reason: 'chat_not_allowed' })
  const others = withTable({ other: { unlistedAddressed: 'explicit' } }, { otherChats: 'mentions' })
  expect(others.sources.scope(inChat('oc_elsewhere'))).toStrictEqual({ listened: true, observed: false, row: 'other' })
  expect(others.policy.gate(inChat('oc_elsewhere'), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'other' } })
  expect(others.policy.gate(inChat('oc_elsewhere', STRANGER), thread(), [])).toMatchObject({
    admissible: true,
    strength: 'explicit',
    basis: { row: 'other', cell: 'unlistedAddressed' },
  })
})

test('admission：off 模式下没有 inferred followup，名单内发送者仍是 explicit（上游 policy.spec.ts:130）', () => {
  const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
  const off = setup({ ...base, eval: { ...base.eval, mode: 'off' } }).policy
  expect(off.gate(unaddressed({ ...quiet, actor: { source: 'feishu', id: 'ou_guest' } }), thread(['ticket']), [])).toStrictEqual({
    admissible: false,
    reason: 'not_a_member',
  })
  expect(off.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({
    admissible: true,
    strength: 'explicit',
    basis: { via: 'followup' },
  })
})

test('admission：explicit 格子在任何模式都算明确请求（上游 policy.spec.ts:137）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  for (const mode of ['auto', 'observe', 'off'] as const) {
    const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }, {}, mode)
    expect(open.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject({
      admissible: true,
      strength: 'explicit',
      basis: { via: 'admission', cell: 'unlistedAddressed' },
    })
    // 格子不是 explicit 时，followup 仍按 inferred 走，只要评估没关。
    const strict = withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }, {}, mode)
    expect(strict.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject(
      mode === 'off' ? { admissible: false } : { admissible: true, strength: 'inferred', basis: { via: 'followup' } },
    )
  }
})

test('admission：有工单线程的 followup 不受表格约束（上游 policy.spec.ts:148）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({ actor: { source: 'feishu', id: sender }, meta: { chatId, direct: false, mentioned: addressed } })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  const strict = withTable({ [OBSERVED]: { listedUnaddressed: 'ignore', unlistedUnaddressed: 'ignore' } })
  expect(strict.policy.gate(inChat(OBSERVED, MEMBER, false), thread(['ticket']), [])).toMatchObject({
    admissible: true,
    strength: 'explicit',
    basis: { via: 'followup' },
  })
  expect(strict.policy.gate(inChat(OBSERVED, STRANGER, false), thread(['ticket']), [])).toMatchObject({
    admissible: true,
    strength: 'inferred',
    basis: { via: 'followup' },
  })
})

test('admission：格子变弱会让 Mandate 失效，格子不变则保持（上游 policy.spec.ts:153）', () => {
  const STRANGER = 'ou_stranger'
  const inChat = () =>
    feishu({ actor: { source: 'feishu', id: STRANGER }, meta: { chatId: CHAT, direct: false, mentioned: true } })
  const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })
  const gate = open.policy.gate(inChat(), thread(), [])
  if (!gate.admissible) throw new Error('expected admission')
  const mandate = { strength: gate.strength, policyVersion: 'v', basis: gate.basis, actor: { source: 'feishu', id: STRANGER }, scope: '' }
  expect(open.policy.revalidate(mandate)).toBe(true)
  expect(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }).policy.revalidate(mandate)).toBe(false)
  expect(withTable({}).policy.revalidate(mandate)).toBe(false)
})

test('admission：格子变化会改 Policy 版本（上游 policy.spec.ts:162）', () => {
  expect(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }).version).not.toBe(setup().version)
  expect(withTable({}).version).toBe(setup().version)
})

// ── 接单模式：off / observe / auto（上游 policy.spec.ts:277-325）──────────────

test('mode：auto 下按命中规则接受 inferred，命中规则必须启用（上游 policy.spec.ts:287）', () => {
  const settings = (mode: AcceptMode): Settings => {
    const parsed = SettingsSchema.parse({})
    return { ...parsed, eval: { ...parsed.eval, mode } }
  }
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const judged = (current: Settings, matched: boolean) =>
    current.policy.rules.filter((rule) => rule.enabled).map((rule) => ({ rule_id: rule.id, matched, reason: 'judged' }))
  const accept = (current: Settings, matched = true): Assessment => ({
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
  expect(outcome).toMatchObject({
    kind: 'accept',
    rules: auto.policy.rules.filter((rule) => rule.enabled).map((rule) => rule.id),
    name: 'fix-copy',
  })
  expect(assessmentOutcome(accept(settings('observe')), settings('observe'), 'inferred')).toMatchObject({
    kind: 'ignore',
    reason: { code: 'observed', values: { text: 'asked' } },
    audit: { would_accept: true },
  })
  expect(assessmentOutcome(accept(auto, false), auto, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
  expect(() => assessmentOutcome({ ...accept(auto), rule_assessments: [] }, auto, 'inferred'))
    .toThrow(/Exactly one assessment for every enabled rule/)
  expect(() => assessmentOutcome({ ...accept(auto), intent_evidence: null }, auto, 'inferred'))
    .toThrow(/Acceptance requires intent_evidence/)
  const scope: SourceScope = { scope: () => ({ listened: true, observed: true }) }
  const enabled = auto.policy.rules.find((rule) => rule.enabled)!.id
  expect(settingsPolicy(auto, scope).admitsInferred([enabled])).toBe(true)
  expect(settingsPolicy(auto, scope).admitsInferred(['unknown'])).toBe(false)
  expect(settingsPolicy(auto, scope).admitsInferred([])).toBe(false)
  expect(settingsPolicy(settings('observe'), scope).admitsInferred([enabled])).toBe(false)
})

test('mode：explicit 候选不受接单模式影响，off 与 observe 下照常接受（上游 policy.spec.ts:315）', () => {
  const rules = SettingsSchema.parse({}).policy.rules.filter((rule) => rule.enabled)
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const assessment: Assessment = {
    decision: 'accept',
    direction,
    title: 'Fix',
    scope: 'small',
    reason: 'asked',
    intent_evidence: 'quote',
    rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: 'judged' })),
  }
  for (const mode of ['observe', 'off'] as const) {
    const settings = SettingsSchema.parse({ eval: { mode } })
    expect(assessmentOutcome(assessment, settings, 'explicit')).toMatchObject({ kind: 'accept', title: 'Fix' })
    expect(assessmentOutcome(assessment, settings, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'observed' } })
  }
})

test('mode：off 下 gate 不接 inferred，observe 下仍产生 inferred 候选（上游 policy.spec.ts:76/130）', () => {
  const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
  const quiet = unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } })
  for (const mode of ['off', 'observe', 'auto'] as const) {
    const current = setup({ ...base, eval: { ...base.eval, mode } }).policy
    const listed = current.gate(observed, thread(), [])
    if (mode === 'off') expect(listed).toStrictEqual({ admissible: false, reason: 'no_mention' })
    else expect(listed).toMatchObject({ admissible: true, strength: 'inferred' })
    // 名单内发送者的未点名消息在任何模式下都是 explicit followup：off 只关掉「推断」，不关掉「明确」。
    expect(current.gate(quiet, thread(['ticket']), [])).toMatchObject({ admissible: true, strength: 'explicit' })
  }
})

// ── Mandate 重新校验（上游 policy.spec.ts:167-231）──────────────────────────

test('Mandate：准入表矩阵（listedUnaddressed × inferred，上游 policy.spec.ts:167）', () => {
  revalidateMatrix({ cell: 'listedUnaddressed', strength: 'inferred' })
})
test('Mandate：准入表矩阵（unlistedAddressed × explicit，上游 policy.spec.ts:167）', () => {
  revalidateMatrix({ cell: 'unlistedAddressed', strength: 'explicit' })
})
test('Mandate：准入表矩阵（unlistedAddressed × inferred，上游 policy.spec.ts:167）', () => {
  revalidateMatrix({ cell: 'unlistedAddressed', strength: 'inferred' })
})
test('Mandate：准入表矩阵（unlistedUnaddressed × inferred，上游 policy.spec.ts:167）', () => {
  revalidateMatrix({ cell: 'unlistedUnaddressed', strength: 'inferred' })
})

const CELLS: AdmissionCell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
const SENDER = 'ou_sender'
const MODES: readonly AcceptMode[] = ['off', 'observe', 'auto']
const SCOPES = ['all', 'mentions', 'none'] as const

type MatrixCase = {
  listed: boolean
  mode: AcceptMode
  rule: boolean
  scope: (typeof SCOPES)[number]
  holds: boolean
}

/**
 * 上游 `it.each` 那张表：4 种来源 × 名单内/外 × 三种模式 × 规则启用/停用 × 群接收 all/mentions/none × 格子握住/失效。
 * 每个来源 36 组，断言逐个照抄（含 `expected()` 的判据本身）。
 */
function revalidateMatrix(origin: { cell: AdmissionCell; strength: Strength }): void {
  const cases: MatrixCase[] = [true, false].flatMap((listed) =>
    MODES.flatMap((mode) =>
      [true, false].flatMap((rule) =>
        SCOPES.flatMap((scope) => [true, false].map((holds) => ({ listed, mode, rule, scope, holds }))),
      ),
    ),
  )
  /** docs/002：线程必须仍被接收；名单内发送者点名一律 explicit；后来进名单的发送者走 listed 格子。 */
  function expected(item: MatrixCase): boolean {
    if (item.scope === 'none') return false
    if (origin.cell === 'unlistedAddressed' && item.listed) return true
    const now = origin.cell === 'unlistedUnaddressed' && item.listed ? 'listedUnaddressed' : origin.cell
    if ((now === 'listedUnaddressed' && !item.listed) || !item.holds) return false
    return origin.strength === 'explicit' || (item.mode === 'auto' && item.rule)
  }
  for (const item of cases) {
    // 行给出与接受时同等或更强的强度；格子不成立时给 ignore。
    const grant = (cell: AdmissionCell) => (!item.holds ? 'ignore' : cell === 'unlistedAddressed' ? origin.strength : 'inferred')
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
    const observed: { observation?: { mode: AcceptMode }; rules?: string[] } =
      origin.strength === 'inferred' ? { observation: { mode: 'auto' }, rules: ['copy'] } : {}
    const basis: MandateBasis = {
      via: 'admission',
      source: 'feishu',
      scope: { chatId: CHAT, direct: false, mentioned: addressed },
      row: CHAT,
      cell: origin.cell,
      ...(addressed ? { addressed: 'mention' } : {}),
      ...observed,
    }
    const mandate: Mandate = { strength: origin.strength, policyVersion: 'v', basis, actor: { source: 'feishu', id: SENDER }, scope: '' }
    const actual = setup(settings).policy.revalidate(mandate)
    expect(
      actual,
      `cell=${origin.cell} strength=${origin.strength} listed=${item.listed} mode=${item.mode} rule=${item.rule} scope=${item.scope} holds=${item.holds}`,
    ).toBe(expected(item))
  }
}

test('Mandate：explicit 随名单与监听存活，规则型只随 auto 与启用规则存活（上游 policy.spec.ts:206）', () => {
  const basis: MandateBasis = { via: 'addressed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice', addressed: 'mention' }
  const mandate: Mandate = { strength: 'explicit', policyVersion: 'v', basis, actor: { source: 'feishu', id: MEMBER }, scope: '' }
  expect(policy.revalidate(mandate)).toBe(true)
  const nobody = { ...base, policy: { ...base.policy, sources: {} } }
  expect(setup(nobody).policy.revalidate(mandate)).toBe(false)
  const silent = { ...base, sources: { feishu: feishuSource({ chats: [], directMessages: true }) } }
  expect(setup(silent).policy.revalidate(mandate)).toBe(false)
  // 记录 basis 之前签发的 Mandate：发送者仍在名单、来源仍在听，就继续成立。
  const listed: MandateBasis = { via: 'listed', source: 'feishu', scope: { chatId: CHAT, direct: false }, sender: 'Alice' }
  expect(setup(silent).policy.revalidate({ ...mandate, basis: listed })).toBe(false)
  expect(policy.revalidate({ ...mandate, basis: listed })).toBe(true)
  const inferred: Mandate = { ...mandate, strength: 'inferred', basis: { via: 'listed', observation: {}, rules: ['copy'] } }
  expect(policy.revalidate(inferred)).toBe(true)
  expect(setup({ ...base, eval: { ...base.eval, mode: 'observe' } }).policy.revalidate(inferred)).toBe(false)
  expect(
    setup({ ...base, policy: { ...base.policy, rules: base.policy.rules.map((rule) => ({ ...rule, enabled: rule.id !== 'copy' })) } }).policy.revalidate(inferred),
  ).toBe(false)
  expect(setup(nobody).policy.revalidate({ ...mandate, basis: { via: 'followup' } })).toBe(true)
})

test('Mandate：机器人候选随名单与 auto 模式存活（上游 policy.spec.ts:433，来源换成 Feishu）', () => {
  const settings = SettingsSchema.parse({
    ...base,
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts' }] } } },
  })
  const meta = { chatId: CHAT, direct: false, mentioned: true }
  const mandate: Mandate = {
    strength: 'inferred',
    policyVersion: '',
    actor: { source: 'feishu', id: 'cli_alerts' },
    scope: '',
    basis: { via: 'bot', source: 'feishu', scope: meta, row: CHAT, sender: 'cli_alerts', observation: { mode: 'auto' } },
  }
  expect(setup(settings).policy.revalidate(mandate)).toBe(true)
  const withoutBots = SettingsSchema.parse({
    ...base,
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu, bots: [] } } },
  })
  expect(setup(withoutBots).policy.revalidate(mandate)).toBe(false)
  expect(setup({ ...settings, eval: { ...settings.eval, mode: 'observe' } }).policy.revalidate(mandate)).toBe(false)
})

test('Mandate：名单内的机器人点名才进候选（上游 policy.spec.ts:326）', () => {
  const settings = SettingsSchema.parse({
    ...base,
    policy: { ...base.policy, sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu, bots: [{ id: 'cli_alerts' }] } } },
  })
  const mention = feishu({ actor: { source: 'feishu', id: 'cli_alerts' }, human: false, meta: { chatId: CHAT, direct: false, mentioned: true } })
  expect(setup(settings).policy.gate(mention, thread(), [])).toMatchObject({
    admissible: true,
    strength: 'inferred',
    basis: { via: 'bot', addressed: 'mention', row: CHAT },
  })
})

// ── 版本与影响面（上游 policy.spec.ts:224-231、346-378）─────────────────────

test('policyVersion：规则、接单模式、来源授权变化才改版本（上游 policy.spec.ts:224）', () => {
  const { version } = setup()
  expect(
    setup({
      ...base,
      paused: true,
      executor: { ...base.executor, maxWorkers: 9 },
      eval: { ...base.eval, timeoutSeconds: 300 },
      sources: { ...base.sources, github: { enabled: true, config: { pollSeconds: 600 } } },
    }).version,
  ).toBe(version)
  expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).version).toBe(version)
  expect(setup({ ...base, eval: { ...base.eval, mode: 'off' } }).version).not.toBe(version)
  expect(
    setup({ ...base, policy: { ...base.policy, sources: { ...base.policy.sources, github: { allowed: [], admission: {} } } } }).version,
  ).not.toBe(version)
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
const effectScope = (): SourceScope => ({ scope: () => ({ listened: true, observed: true }) })
/** 一张工单；只填本用例用到的字段（`policyEffects` 只读 `id` 与 `mandate`）。 */
const effectTicket = (id: string, mandate: Pick<Mandate, 'strength' | 'actor' | 'basis'>): Ticket =>
  ({ id, mandate }) as unknown as Ticket

test('policyEffects：告诉工单这次变更怎么影响它，其余工单不动（上游 policy.spec.ts:354）', () => {
  const inferred = effectTicket('t1', { strength: 'inferred', actor: { source: 'feishu', id: 'ou_guest' }, basis: { via: 'listed', rules: ['copy'] } })
  const explicit = effectTicket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  const rules = (copy: Partial<Rule>, visual: Partial<Rule> = {}): Settings => ({
    ...effectBase,
    policy: {
      ...effectBase.policy,
      rules: [{ ...effectBase.policy.rules[0], ...copy }, { ...effectBase.policy.rules[1], ...visual }],
    },
  })
  expect(policyEffects([inferred, explicit], effectBase, rules({}, { enabled: false }), effectScope).size).toBe(0)
  expect(policyEffects([inferred], effectBase, rules({ instruction: 'Fix typos only.' }), effectScope).get('t1')).toStrictEqual({
    rules: [{ id: 'copy', name: 'Copy', change: 'changed', instruction: 'Fix typos only.' }],
  })
  expect(policyEffects([inferred], effectBase, rules({ enabled: false }), effectScope).get('t1')).toStrictEqual({
    rules: [{ id: 'copy', name: 'Copy', change: 'disabled' }],
  })
  // 名单里多一个人不影响工单；把发起人移出名单才会。
  const allowed = (list: SourcePolicy['allowed']): Settings => ({
    ...effectBase,
    policy: { ...effectBase.policy, sources: { ...effectBase.policy.sources, feishu: { ...effectBase.policy.sources.feishu, allowed: list } } },
  })
  expect(policyEffects([inferred, explicit], effectBase, allowed([{ id: 'ou_alice' }, { id: 'ou_bob' }]), effectScope).size).toBe(0)
  expect(policyEffects([explicit], effectBase, allowed([]), effectScope).get('t2')).toStrictEqual({
    requesterAllowed: false,
    requester: { source: 'feishu', id: 'ou_alice' },
  })
})

test('policyEffects：接单模式离开 auto 时推断工单报 proactive:false（上游 policy.spec.ts:366）', () => {
  const rule = effectTicket('t3', {
    strength: 'inferred',
    actor: { source: 'feishu', id: 'ou_alice' },
    basis: { via: 'listed', source: 'feishu', rules: ['copy'], observation: {} },
  })
  const explicit = effectTicket('t2', { strength: 'explicit', actor: { source: 'feishu', id: 'ou_alice' }, basis: { via: 'listed', source: 'feishu' } })
  const auto: Settings = { ...effectBase, eval: { ...effectBase.eval, mode: 'auto' } }
  const observe: Settings = { ...effectBase, eval: { ...effectBase.eval, mode: 'observe' } }
  const effects = policyEffects([rule, explicit], auto, observe, effectScope)
  // 不是发起人被移除：写这句话的人仍可发起工作。
  expect(effects.get('t3')).toStrictEqual({ proactive: false })
  expect(effects.has('t2')).toBe(false)
  const bot = effectTicket('t4', { strength: 'explicit', actor: { source: 'feishu', id: 'cli_ci_bot' }, basis: { via: 'listed', source: 'feishu' } })
  const listed = {
    ...effectBase,
    policy: { ...effectBase.policy, sources: { ...effectBase.policy.sources, feishu: { ...effectBase.policy.sources.feishu, allowed: [{ id: 'cli_ci_bot' }] } } },
  }
  expect(policyEffects([bot], listed, effectBase, effectScope).get('t4')).toStrictEqual({
    requesterAllowed: false,
    requester: { source: 'feishu', id: 'cli_ci_bot' },
  })
})

// ── 设计文档 §4.3：P0 手动来源必须走 gate（自补）────────────────────────────

test('P0 手动来源：三种接单模式下都判定为 explicit（自补，依据 docs/superagent-design.md:203-218）', () => {
  // 设计文档 §4.3：P0 只有手动来源，发送者是操作者本人、addressed='mention'，结果恒为 explicit，
  // 且「这条路径必须走 gate，不能跳过」——因此这里断言 gate 本身的输出，而不是绕过它。
  const settings = (mode: AcceptMode) =>
    SettingsSchema.parse({
      eval: { mode },
      policy: { sources: { manual: { allowed: [{ id: 'operator' }] } } },
      sources: { manual: { enabled: true, config: {} } },
    })
  const trigger: Trigger = {
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
  for (const mode of ['off', 'observe', 'auto'] as const) {
    const current = settingsPolicy(settings(mode), scopeOf(settings(mode)))
    const result = admitted(current.gate(trigger, thread(), []))
    expect(result.admissible, `mode=${mode} 应放行手动来源`).toBe(true)
    expect(result.strength, `mode=${mode} 手动来源应恒为 explicit`).toBe('explicit')
    expect(result.basis.via, `mode=${mode} 依据应为 addressed`).toBe('addressed')
    expect(result.basis.sender).toBe('operator')
  }
})
