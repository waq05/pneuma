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
 * DSC_HOME 是**模块加载那一刻**定死的，所以要在 import `lib/` 之前设好。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/sources
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'superagent-sources-home-'))
process.env['DSC_HOME'] = home

const { defaultSettings, normalizeGithubAccount, GITHUB_SOURCE, MANUAL_SOURCE, DEFAULT_ACTOR } =
  await import('../../../../lib/packages/superagent/adapters/settings.js')
const { superagentScope } = await import('../../../../lib/packages/superagent/adapters/scope.js')
const { manualScope } = await import('../../../../lib/packages/superagent/adapters/manual.js')
const { settingsPolicy } = await import('../../../../lib/packages/superagent/core/policy.js')
const { readSuperagentConfig, createSettingsSection, assessorTargetOf, workerTargetOf } = await import('../../../../lib/packages/superagent/index.js')

after(() => { rmSync(home, { recursive: true, force: true }) })

/** 一个配好的 GitHub 账户。 */
const ACCOUNT = { repository: 'owner/repo', login: 'pneuma-bot', allowed: ['alice'] }

/** 造一条 GitHub 上人对机器人说的话。 */
function githubTrigger(actor, repository = 'owner/repo') {
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

/** 造一条线程（核心的 `Thread` 只有这几个字段与授权判定有关）。 */
function thread() {
  return { id: 'github:owner/repo#discussion_r1', source: GITHUB_SOURCE, subscriptions: [] }
}

// ── 1. 默认设置：不带 GitHub 就一个字节都不加 ───────────────────────────────

test('默认设置：没配 GitHub 时只登记 manual，策略里也不多一个来源', () => {
  const settings = defaultSettings()
  assert.deepEqual(Object.keys(settings.sources), [MANUAL_SOURCE])
  assert.deepEqual(Object.keys(settings.policy.sources), [MANUAL_SOURCE])
  assert.deepEqual(settings.policy.sources[MANUAL_SOURCE].allowed.map((item) => item.id), [DEFAULT_ACTOR])
})

test('默认设置：配了 GitHub 就把来源与名单一起登记', () => {
  const settings = defaultSettings(ACCOUNT)
  assert.equal(settings.sources[GITHUB_SOURCE].enabled, true)
  assert.deepEqual(settings.policy.sources[GITHUB_SOURCE].allowed.map((item) => item.id), ['alice'])
})

test('配置清洗：三项缺一就当没配，格式不对也算没配', () => {
  assert.equal(normalizeGithubAccount(undefined), undefined)
  assert.equal(normalizeGithubAccount({ repository: '', login: 'bot', allowed: ['alice'] }), undefined, '没仓库')
  assert.equal(normalizeGithubAccount({ repository: 'owner/repo', login: '  ', allowed: ['alice'] }), undefined, '没登录名')
  assert.equal(normalizeGithubAccount({ repository: 'owner/repo', login: 'bot', allowed: [] }), undefined, '空名单')
  assert.equal(normalizeGithubAccount({ repository: 'repo', login: 'bot', allowed: ['alice'] }), undefined, '缺 owner')
  const cleaned = normalizeGithubAccount({ repository: ' owner/repo ', login: ' bot ', allowed: [' alice ', '', 'bob'] })
  assert.deepEqual(cleaned, { repository: 'owner/repo', login: 'bot', allowed: ['alice', 'bob'] })
})

// ── 2. 组合范围 ─────────────────────────────────────────────────────────────

test('组合范围：没接 GitHub 时，GitHub 的消息一律判「没连上」，手动来源照收', () => {
  const scope = superagentScope(undefined)
  assert.deepEqual(scope.scope({ source: GITHUB_SOURCE, meta: { repository: 'owner/repo' } }),
    { listened: false, reason: 'source_not_connected' })
  assert.deepEqual(scope.scope({ source: MANUAL_SOURCE, meta: {} }), { listened: true, observed: true })
})

test('组合范围：配了 GitHub 就全收；没配就判「没连上」', () => {
  const scope = superagentScope(() => ({ repository: 'Owner/Repo' }))
  assert.deepEqual(scope.scope({ source: GITHUB_SOURCE, meta: {} }), { listened: true, observed: true })
  // 不按仓库名过滤是对的：meta 与上游逐字段一致，里面没有仓库这个键。仓库边界由轮询器
  // （只轮询一个仓库）与 api.ts 的路径限制保证，不在这一层。
  assert.deepEqual(scope.scope({ source: GITHUB_SOURCE, meta: { repository: 'someone/else' } }),
    { listened: true, observed: true })
  // 别的手动来源判定不受影响。
  assert.deepEqual(scope.scope({ source: MANUAL_SOURCE, meta: {} }), manualScope.scope({ source: MANUAL_SOURCE, meta: {} }))
})

// ── 3. 准入闸：名单是授权边界 ───────────────────────────────────────────────

test('准入：名单里的人 @ 机器人 → explicit；名单外的人 → 不接单', () => {
  const settings = defaultSettings(ACCOUNT)
  const policy = settingsPolicy(settings, superagentScope(() => ({ repository: 'owner/repo' })))

  const allowed = policy.gate(githubTrigger('alice'), thread(), [])
  assert.equal(allowed.admissible, true, JSON.stringify(allowed))
  assert.equal(allowed.strength, 'explicit')
  assert.equal(allowed.basis.via, 'addressed')

  const stranger = policy.gate(githubTrigger('mallory'), thread(), [])
  assert.equal(stranger.admissible, false, JSON.stringify(stranger))
  assert.equal(stranger.reason, 'not_a_member')
})

test('准入：没接 GitHub 时，同一个人的 @ 也进不来', () => {
  const policy = settingsPolicy(defaultSettings(), superagentScope(undefined))
  const denied = policy.gate(githubTrigger('alice'), thread(), [])
  assert.equal(denied.admissible, false, JSON.stringify(denied))
})

// ── 4. 设置面：四个字段的读写 ───────────────────────────────────────────────

test('设置面：四个 GitHub 字段能存能读，令牌环境变量缺省是 GITHUB_TOKEN', () => {
  const section = createSettingsSection()
  // 缺省：四个字段都是空的，令牌变量名有缺省。
  assert.equal(section.values().githubRepository, '')
  assert.equal(section.values().githubLogin, '')
  assert.equal(section.values().githubAllowed, '')
  assert.equal(section.values().githubTokenEnv, 'GITHUB_TOKEN')

  assert.equal(section.save('githubRepository', 'owner/repo'), undefined)
  assert.equal(section.save('githubLogin', ' pneuma-bot '), undefined)
  // 名单：去掉多余空白与重复项，存成逗号分隔的一行。
  assert.equal(section.save('githubAllowed', ' alice, bob ,alice '), undefined)
  assert.equal(section.values().githubAllowed, 'alice, bob')

  const config = readSuperagentConfig()
  assert.equal(config.githubRepository, 'owner/repo')
  assert.equal(config.githubLogin, 'pneuma-bot')
  assert.deepEqual(config.githubAllowed, ['alice', 'bob'])

  // 仓库格式不对：当场给提示，不落盘。
  assert.match(String(section.save('githubRepository', 'not-a-repo')), /owner\/name/)
  assert.equal(section.values().githubRepository, 'owner/repo', '写坏的仓库不该覆盖已有的好值')

  // 清空 = 关掉这个来源（删键），不是写一个空串。
  section.save('githubRepository', '   ')
  assert.equal(section.values().githubRepository, '')
  assert.equal(readSuperagentConfig().githubRepository, '')
})

// ── 5. 判定模型：格式不对等于不配 ───────────────────────────────────────────

test('判定模型：provider/model 拆得开，写不对就按「不调模型」处理', () => {
  const of = (text) => assessorTargetOf({ ...readSuperagentConfig(), assessorModel: text })
  assert.deepEqual(of('openai/gpt-5'), { provider: 'openai', model: 'gpt-5' })
  // 端点名里允许带斜杠，所以按最后一个斜杠拆。
  assert.deepEqual(of('acme/eu/claude'), { provider: 'acme/eu', model: 'claude' })
  // 空 = 不调模型（`core/policy.ts:98` 的默认形态），不是错误。
  assert.equal(of(''), null)
  assert.equal(of('   '), null)
  // 格式不对也按不配处理：模型名是手填的，写错不该让插件起不来。
  assert.equal(of('no-slash'), null)
  assert.equal(of('/model-only'), null)
  assert.equal(of('provider/'), null)
})

// ── 6. worker 模型与禁令名单：与判定模型同一条拆分规则 ───────────────────────

test('worker 模型：provider/model 拆得开，写不对就按「跟随选路」处理', () => {
  const of = (text) => workerTargetOf({ ...readSuperagentConfig(), workerModel: text })
  assert.deepEqual(of('openai/gpt-5'), { provider: 'openai', model: 'gpt-5' })
  // 端点名里允许带斜杠，与判定模型同一条规则（同一个拆分函数）。
  assert.deepEqual(of('acme/eu/claude'), { provider: 'acme/eu', model: 'claude' })
  // 空 = 跟随宿主当前选路（执行器 `route()` 的缺省分支），不是错误。
  assert.equal(of(''), null)
  assert.equal(of('no-slash'), null)
  assert.equal(of('provider/'), null)
})

test('worker 禁令名单：逗号分隔、去空白、去重；空 = 只有内置限制', () => {
  const section = createSettingsSection()
  section.save('workerBlockedCommands', ' npm publish , docker push ,, npm publish ')
  assert.deepEqual(readSuperagentConfig().workerBlockedCommands, ['npm publish', 'docker push'], '去重与去空白')
  section.save('workerBlockedCommands', '   ')
  assert.deepEqual(readSuperagentConfig().workerBlockedCommands, [], '空 = 删键 = 没有额外禁令')
})

test('worker 模型设置面：存进去、读回来是同一个值', () => {
  const section = createSettingsSection()
  section.save('workerModel', 'acme/eu/claude')
  assert.equal(readSuperagentConfig().workerModel, 'acme/eu/claude')
  assert.deepEqual(workerTargetOf(readSuperagentConfig()), { provider: 'acme/eu', model: 'claude' })
  section.save('workerModel', '')
  assert.equal(readSuperagentConfig().workerModel, '')
})

// ── 7. 接单模式：候选收件箱的开关（backlog G1）────────────────────────────────

test('接单模式：缺省 observe，存 auto 读回 auto，非法值被 save 拒掉', () => {
  const section = createSettingsSection()
  // 不配 = observe：行为与收件箱做出之前一致。
  assert.equal(readSuperagentConfig().evalMode, 'observe')
  section.save('evalMode', 'auto')
  assert.equal(readSuperagentConfig().evalMode, 'auto')
  section.save('evalMode', 'off')
  assert.equal(readSuperagentConfig().evalMode, 'off')
  // 下拉只发三值，但 save 的枚举校验要真拦：给一句提示、不落盘。
  assert.match(String(section.save('evalMode', 'yolo')), /判定模式/)
  assert.equal(readSuperagentConfig().evalMode, 'off', '非法值不该覆盖已有的好值')
})

test('接单模式：defaultSettings 第三参把模式传进 eval 块', async () => {
  const { defaultSettings } = await import('../../../../lib/packages/superagent/adapters/settings.js')
  assert.equal(defaultSettings().eval.mode, 'observe', '不传 = observe（与 P0 一致）')
  assert.equal(defaultSettings(undefined, undefined, 'auto').eval.mode, 'auto')
  assert.equal(defaultSettings(undefined, undefined, 'off').eval.mode, 'off')
})

test('判定超时：缺省 120，存 300 读回 300，夹在 30–600', () => {
  const section = createSettingsSection()
  assert.equal(readSuperagentConfig().evalTimeoutSeconds, 120, '不配 = schema 默认 120')
  section.save('evalTimeoutSeconds', 300)
  assert.equal(readSuperagentConfig().evalTimeoutSeconds, 300)
  section.save('evalTimeoutSeconds', 5)
  assert.equal(readSuperagentConfig().evalTimeoutSeconds, 30, '低于下限夹回 30')
  section.save('evalTimeoutSeconds', 9999)
  assert.equal(readSuperagentConfig().evalTimeoutSeconds, 600, '高于上限夹回 600')
  assert.match(String(section.save('evalTimeoutSeconds', 'abc')), /判定超时/)
})

test('判定超时：defaultSettings 第四参把秒数传进 eval 块', async () => {
  const { defaultSettings } = await import('../../../../lib/packages/superagent/adapters/settings.js')
  assert.equal(defaultSettings().eval.timeoutSeconds, 120)
  assert.equal(defaultSettings(undefined, undefined, undefined, 300).eval.timeoutSeconds, 300)
})

// ── 8. 设置变更历史：save 包装只在「写盘且值真的变了」时记 ────────────────────

test('设置历史：record 只在保存成功且值变了时被调，校验被拒不记', () => {
  // 前面的用例把 evalMode 留在了别的值上：先用一个不记历史的分区清回缺省，
  // 否则这条的「从什么改到什么」会跟着跑测试的顺序漂。
  createSettingsSection().save('evalMode', 'observe')
  const recorded = []
  const section = createSettingsSection(undefined, (change) => recorded.push(change))
  section.save('evalMode', 'auto')
  assert.deepEqual(recorded.at(-1), { key: 'evalMode', from: 'observe', to: 'auto' }, '值变了要记')
  section.save('evalMode', 'auto')
  assert.equal(recorded.length, 1, '重写同一个值不记')
  section.save('githubRepository', 'not-a-repo')
  assert.equal(recorded.length, 1, '被校验拦下的保存不记')
  section.save('githubRepository', 'owner/repo')
  assert.deepEqual(recorded.at(-1), { key: 'githubRepository', from: '', to: 'owner/repo' }, '新键记「从空到有」')
  section.save('workerBlockedCommands', 'npm publish, docker push')
  assert.deepEqual(
    recorded.at(-1),
    { key: 'workerBlockedCommands', from: [], to: ['npm publish', 'docker push'] },
    '名单字段按数组记（展示层自己拼逗号）',
  )
})

test('设置历史：不给 record 时不记、行为与原来一致', () => {
  const section = createSettingsSection()
  section.save('evalMode', 'auto')
  assert.equal(readSuperagentConfig().evalMode, 'auto', '保存照常生效')
})
