/**
 * @pneuma/superagent 的「来源登记与准入」用例：默认设置、配置清洗、组合范围、可活策略。
 *
 * 这几件事的共同点是「判错了不报错」：
 *   - 来源没登记 → 轮询在跑、一条工单都不建；
 *   - 范围判宽 → 任何仓库 @ 一下都能给本机派活；
 *   - 名单判错 → 明确要求反而以 not_a_member 被拒。
 * 所以每条都用「准不准」而不是「有没有抛错」来断言。
 *
 * 全程用 `tmpdir()` 下的临时 DSC_HOME，不碰真实 `~/.dsc`；`core/plugin-registry` 的
 * DSC_HOME 是**模块加载那一刻**定死的，所以要在 import 源码之前设好。
 *
 * 迁移说明：原文件跑的是构建产物、先手工 build；现在直接 import 源码。
 *
 * @module @pneuma/superagent/tests/sources
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { SettingsSectionSpec, SettingsValue, SettingsValues } from '@pneuma/runtime/services/types.js'
import type { GateResult } from '../core/ports.js'
import type { Thread, Trigger } from '../core/model.js'

const home = mkdtempSync(join(tmpdir(), 'superagent-sources-home-'))
process.env['DSC_HOME'] = home

const { defaultSettings, normalizeGithubAccount, GITHUB_SOURCE, MANUAL_SOURCE, DEFAULT_ACTOR } =
  await import('../adapters/settings.js')
const { superagentScope } = await import('../adapters/scope.js')
const { manualScope } = await import('../adapters/manual.js')
const { settingsPolicy } = await import('../core/policy.js')
const { readSuperagentConfig, createSettingsSection, assessorTargetOf } = await import('../index.js')

afterAll(() => { rmSync(home, { recursive: true, force: true }) })

/** 一个配好的 GitHub 账户。 */
const ACCOUNT = { repository: 'owner/repo', login: 'pneuma-bot', allowed: ['alice'] }

/** 造一条 GitHub 上人对机器人说的话。 */
function githubTrigger(actor: string, repository = 'owner/repo'): Trigger {
  return {
    id: 'trg-gh-1',
    source: GITHUB_SOURCE,
    threads: [{ source: GITHUB_SOURCE, id: 'github:owner/repo#discussion_r1' }],
    actor: { source: GITHUB_SOURCE, id: actor },
    human: true,
    addressed: 'mention',
    at: '2026-01-01T00:00:00.000Z',
    text: '@pneuma-bot 把这个错别字改掉',
    meta: { repository },
  }
}

/**
 * 造一条线程。只填本用例用到的字段：授权判定只读 `id` / `source` / `subscriptions`，
 * `Thread` 还要求 key / createdAt / correlated / pending / meta。
 */
function thread(): Thread {
  return { id: 'github:owner/repo#discussion_r1', source: GITHUB_SOURCE, subscriptions: [] } as unknown as Thread
}

/** 准入闸的判别联合：接单才算过闸，不过就带原因让用例失败。 */
function admitted(result: GateResult): Extract<GateResult, { admissible: true }> {
  if (!result.admissible) throw new Error(`期望接单，实际被判：${result.reason}（${JSON.stringify(result)}）`)
  return result
}

/**
 * 本文件的 `createSettingsSection()` 实现是同步的（`index.ts:363` 的 `values`、`index.ts:383`
 * 的 `save` 都直接返回值），而契约声明的是 `MaybePromise`、`save` 还是可选的。这里按实现收窄一次。
 */
type SyncSection = Omit<SettingsSectionSpec, 'values' | 'save'> & {
  values(): SettingsValues
  save(key: string, value: SettingsValue): string | void
}

// ── 1. 默认设置：不带 GitHub 就一个字节都不加 ───────────────────────────────

test('默认设置：没配 GitHub 时只登记 manual，策略里也不多一个来源', () => {
  const settings = defaultSettings()
  expect(Object.keys(settings.sources)).toStrictEqual([MANUAL_SOURCE])
  expect(Object.keys(settings.policy.sources)).toStrictEqual([MANUAL_SOURCE])
  expect(settings.policy.sources[MANUAL_SOURCE].allowed.map((item) => item.id)).toStrictEqual([DEFAULT_ACTOR])
})

test('默认设置：配了 GitHub 就把来源与名单一起登记', () => {
  const settings = defaultSettings(ACCOUNT)
  expect(settings.sources[GITHUB_SOURCE].enabled).toBe(true)
  expect(settings.policy.sources[GITHUB_SOURCE].allowed.map((item) => item.id)).toStrictEqual(['alice'])
})

test('配置清洗：三项缺一就当没配，格式不对也算没配', () => {
  expect(normalizeGithubAccount(undefined)).toBeUndefined()
  expect(normalizeGithubAccount({ repository: '', login: 'bot', allowed: ['alice'] }), '没仓库').toBeUndefined()
  expect(normalizeGithubAccount({ repository: 'owner/repo', login: '  ', allowed: ['alice'] }), '没登录名').toBeUndefined()
  expect(normalizeGithubAccount({ repository: 'owner/repo', login: 'bot', allowed: [] }), '空名单').toBeUndefined()
  expect(normalizeGithubAccount({ repository: 'repo', login: 'bot', allowed: ['alice'] }), '缺 owner').toBeUndefined()
  const cleaned = normalizeGithubAccount({ repository: ' owner/repo ', login: ' bot ', allowed: [' alice ', '', 'bob'] })
  expect(cleaned).toStrictEqual({ repository: 'owner/repo', login: 'bot', allowed: ['alice', 'bob'] })
})

// ── 2. 组合范围 ─────────────────────────────────────────────────────────────

test('组合范围：没接 GitHub 时，GitHub 的消息一律判「没连上」，手动来源照收', () => {
  const scope = superagentScope(undefined)
  expect(scope.scope({ source: GITHUB_SOURCE, meta: { repository: 'owner/repo' } }))
    .toStrictEqual({ listened: false, reason: 'source_not_connected' })
  expect(scope.scope({ source: MANUAL_SOURCE, meta: {} })).toStrictEqual({ listened: true, observed: true })
})

test('组合范围：配了 GitHub 就全收；没配就判「没连上」', () => {
  const scope = superagentScope(() => ({ repository: 'Owner/Repo' }))
  expect(scope.scope({ source: GITHUB_SOURCE, meta: {} })).toStrictEqual({ listened: true, observed: true })
  // 不按仓库名过滤是对的：meta 与上游逐字段一致，里面没有仓库这个键。仓库边界由轮询器
  // （只轮询一个仓库）与 api.ts 的路径限制保证，不在这一层。
  expect(scope.scope({ source: GITHUB_SOURCE, meta: { repository: 'someone/else' } }))
    .toStrictEqual({ listened: true, observed: true })
  // 别的手动来源判定不受影响。
  expect(scope.scope({ source: MANUAL_SOURCE, meta: {} }))
    .toStrictEqual(manualScope.scope({ source: MANUAL_SOURCE, meta: {} }))
})

// ── 3. 准入闸：名单是授权边界 ───────────────────────────────────────────────

test('准入：名单里的人 @ 机器人 → explicit；名单外的人 → 不接单', () => {
  const settings = defaultSettings(ACCOUNT)
  const policy = settingsPolicy(settings, superagentScope(() => ({ repository: 'owner/repo' })))

  const allowed = admitted(policy.gate(githubTrigger('alice'), thread(), []))
  expect(allowed.strength).toBe('explicit')
  expect(allowed.basis.via).toBe('addressed')

  const stranger = policy.gate(githubTrigger('mallory'), thread(), [])
  expect(stranger.admissible, JSON.stringify(stranger)).toBe(false)
  if (stranger.admissible) throw new Error(`名单外的人不该接单，实际接单：${JSON.stringify(stranger)}`)
  expect(stranger.reason).toBe('not_a_member')
})

test('准入：没接 GitHub 时，同一个人的 @ 也进不来', () => {
  const policy = settingsPolicy(defaultSettings(), superagentScope(undefined))
  const denied = policy.gate(githubTrigger('alice'), thread(), [])
  expect(denied.admissible, JSON.stringify(denied)).toBe(false)
})

// ── 4. 设置面：四个字段的读写 ───────────────────────────────────────────────

test('设置面：四个 GitHub 字段能存能读，令牌环境变量缺省是 GITHUB_TOKEN', () => {
  const section = createSettingsSection() as SyncSection
  // 缺省：四个字段都是空的，令牌变量名有缺省。
  expect(section.values().githubRepository).toBe('')
  expect(section.values().githubLogin).toBe('')
  expect(section.values().githubAllowed).toBe('')
  expect(section.values().githubTokenEnv).toBe('GITHUB_TOKEN')

  expect(section.save('githubRepository', 'owner/repo')).toBeUndefined()
  expect(section.save('githubLogin', ' pneuma-bot ')).toBeUndefined()
  // 名单：去掉多余空白与重复项，存成逗号分隔的一行。
  expect(section.save('githubAllowed', ' alice, bob ,alice ')).toBeUndefined()
  expect(section.values().githubAllowed).toBe('alice, bob')

  const config = readSuperagentConfig()
  expect(config.githubRepository).toBe('owner/repo')
  expect(config.githubLogin).toBe('pneuma-bot')
  expect(config.githubAllowed).toStrictEqual(['alice', 'bob'])

  // 仓库格式不对：当场给提示，不落盘。
  expect(String(section.save('githubRepository', 'not-a-repo'))).toMatch(/owner\/name/)
  expect(section.values().githubRepository, '写坏的仓库不该覆盖已有的好值').toBe('owner/repo')

  // 清空 = 关掉这个来源（删键），不是写一个空串。
  section.save('githubRepository', '   ')
  expect(section.values().githubRepository).toBe('')
  expect(readSuperagentConfig().githubRepository).toBe('')
})

// ── 5. 判定模型：格式不对等于不配 ───────────────────────────────────────────

test('判定模型：provider/model 拆得开，写不对就按「不调模型」处理', () => {
  const of = (text: string) => assessorTargetOf({ ...readSuperagentConfig(), assessorModel: text })
  expect(of('openai/gpt-5')).toStrictEqual({ provider: 'openai', model: 'gpt-5' })
  // 端点名里允许带斜杠，所以按最后一个斜杠拆。
  expect(of('acme/eu/claude')).toStrictEqual({ provider: 'acme/eu', model: 'claude' })
  // 空 = 不调模型（`core/policy.ts:98` 的默认形态），不是错误。
  expect(of('')).toBeNull()
  expect(of('   ')).toBeNull()
  // 格式不对也按不配处理：模型名是手填的，写错不该让插件起不来。
  expect(of('no-slash')).toBeNull()
  expect(of('/model-only')).toBeNull()
  expect(of('provider/')).toBeNull()
})
