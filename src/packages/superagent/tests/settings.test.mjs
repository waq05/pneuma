/**
 * @pneuma/superagent 设置保存的包级测试（移植自上游 `tests/settings.spec.ts`，4 条用例）。
 *
 * 为什么这些要单独钉：`Settings.save` 的乐观并发是「先校验、再检查、再合并」三步，判错不抛错，
 * 只会悄悄留下两次保存混在一起的值；`sync` 的重试退避不对，要么一分钟被打爆、要么一次失败就永远
 * 不再同步。每条都断言「拒绝 / 留下哪个值 / 什么时候重试」。
 *
 * 假件：上游用 `tests/fixtures/host.ts` 起真 cordis Runtime（DSH 会话、Commands、Agents、vitest
 * mock），本仓 `node:test` 没有 `vi`，所以这里用对象字面量的 `SettingsHost`：`Store`、`SourceRegistry`、
 * `HealthBoard`、`feishuKind` / `githubKind` 全是真的，只有 DSH 宿主能力（setup 检查、会话通知、
 * 命令执行）换成可等待 / 可计数的假件。`lark` 假件只回答飞书名单同步要的那一次调用。
 *
 * 与上游的一处不可移植：上游 `resolveRoleModel` 等的是异步 `resolveCallConfig`，本仓
 * `app/role-models.ts` 的 `resolveRoleModel` 是同步的（`ctx.llm.routeTo` 不返回 Promise），
 * 所以「模型检查期间被另一个保存超车」这个窗口在本仓不存在，只测账号检查那半边。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/settings
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, test } from 'node:test'

const { Store } = await import('../../../../lib/packages/superagent/app/store.js')
const { Settings, SettingsConflict } = await import('../../../../lib/packages/superagent/app/settings.js')
const { SourceRegistry } = await import('../../../../lib/packages/superagent/sources/registry.js')
const { HealthBoard } = await import('../../../../lib/packages/superagent/infra/health.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')
const { feishuKind } = await import('../../../../lib/packages/superagent/sources/feishu.js')
const { githubKind } = await import('../../../../lib/packages/superagent/sources/github.js')
const { UserError } = await import('../../../../lib/packages/superagent/core/index.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一个可以稍后兑现的 promise：用来把异步检查卡在中间。 */
function deferred() {
  let resolve
  const promise = new Promise((settle) => { resolve = settle })
  return { promise, resolve }
}

/** 清掉所有计时器并等微任务队列跑完：假计时器 `tick()` 只推进时钟，不替异步链跑 promise。 */
const drain = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }

/** 一个用例一套真 Store + 真注册表 + 真健康板子；宿主能力用假件，`close()` 收尾。 */
function makeHost({ sources = {}, policy = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-settings-'))
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources, policy }))
  const board = new HealthBoard()
  const registry = new SourceRegistry(() => store.settings(), board)
  registry.register(feishuKind)
  registry.register(githubKind)
  const controller = new AbortController()
  const calls = { notify: 0, delivery: 0, restart: 0, requestPass: 0 }
  /** 假 lark：默认不回答，用例自己设 `impl`；`calls` 记每次 argv。 */
  const lark = { calls: [], impl: async () => { throw new Error('no lark response configured') } }
  const sourceHost = { context: () => ({ commands: { withSignal: () => ({ lark: (...args) => {
    lark.calls.push(args)
    return lark.impl(...args)
  } }) } }) }
  /** 假 Setup：`checkAccounts` 可被用例换成卡住的 promise，`configured` 可被切换。 */
  const setup = { configured: () => true, checkAccounts: async () => {}, blockCommands: async () => {},
    restart: () => { calls.restart += 1 } }
  const host = { store, sources: registry, engine: { policyChanged() {} }, health: board, context: { llm: { routeTo() {} } },
    lifetime: controller.signal,
    sessions: { notify() { calls.notify += 1 }, delivery: async () => { calls.delivery += 1; return 'injected' } },
    sourceHost, setup, requestPass() { calls.requestPass += 1 } }
  const settings = new Settings(host)
  return { settings, store, board, calls, lark, setup,
    close: () => { controller.abort(); store.close(); rmSync(directory, { recursive: true, force: true }) } }
}

// ── 断言助手（每条记一次 `passed`） ─────────────────────────────────────────

/** 深比较。 */
function eq(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

/** 布尔条件。 */
function ok(value, message) {
  assert.ok(value, message)
  passed += 1
}

/** 异步拒绝，`check` 是 `(error) => boolean` 或正则。 */
async function rejects(promise, check, message) {
  await assert.rejects(promise, check, message)
  passed += 1
}

/** 同步抛出，`check` 是 `(error) => boolean` 或正则。 */
function throws(work, check, message) {
  assert.throws(work, check, message)
  passed += 1
}

// ── 用例 ────────────────────────────────────────────────────────────────────

test('另一个保存在账号检查期间改了这个块时，拒绝这次保存，且它一点都没留下', async () => {
  const h = makeHost({ sources: { github: { enabled: true, config: {} } } })
  try {
    const accounts = deferred()
    h.setup.checkAccounts = () => accounts.promise
    const github = h.settings.block('source:github')
    const value = github.value
    // 先起一个改了账号 CLI 的保存：它卡在账号检查里。
    const moved = h.settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
      'panel')
    // 同一个版本号上再保存一次轮询间隔：这次不触发账号检查，直接落盘。
    await h.settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
    accounts.resolve()
    await rejects(moved, (error) => error instanceof SettingsConflict)
    const saved = h.store.settings().sources.github.config
    eq({ cli: saved.cli, pollSeconds: saved.pollSeconds }, { cli: value.config.cli, pollSeconds: 90 }, '两次保存不混在一起')
  } finally {
    h.close()
  }
})

test('Policy 保存在 Policy 同步跑完之前改过时，拒绝这次同步、在 sync:feishu 上报错，并保留那次保存', async () => {
  const h = makeHost({ sources: { feishu: { enabled: true, config: {} } },
    policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' } } } })
  try {
    const members = deferred()
    h.lark.impl = () => members.promise
    // 同步先起，卡在拉群成员上。
    const syncing = h.settings.sync('feishu')
    const policy = h.store.settings().policy
    const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
    await h.settings.save('policy', { ...policy, rules }, h.store.blockRevision('policy'), 'panel')
    members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
    await rejects(syncing, (error) => error instanceof SettingsConflict)
    const health = h.board.all['sync:feishu']
    eq(health.state, 'error')
    ok(health.detail.includes('Policy changed during synchronization'), '健康项说明是同步期间 Policy 变了')
    eq(h.store.settings().policy.rules, rules, '那次保存的规则保留')
    eq(h.store.settings().policy.sources.feishu.allowed, [{ id: 'ou_alice', name: 'Alice' }], '同步来的名单没有落盘')
  } finally {
    h.close()
  }
})

test('同步失败后一分钟重试、之后等待时间翻倍，直到成功为止', async (t) => {
  const h = makeHost({ sources: { feishu: { enabled: true, config: {} } },
    policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' } } } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let failures = 2
    h.lark.impl = async () => {
      if (failures > 0) { failures -= 1; throw new Error('network down') }
      return { users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false }
    }
    await rejects(h.settings.sync('feishu'), (error) => error.message === 'network down')
    eq(h.board.all['sync:feishu'].state, 'error')
    ok(h.board.all['sync:feishu'].detail.includes('network down'), '健康项带上失败原因')
    const calls = () => h.lark.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    t.mock.timers.tick(60_000)
    await drain()
    // 第一次重试也失败，下一次等两分钟。
    eq(calls(), before + 1)
    t.mock.timers.tick(60_000)
    await drain()
    eq(calls(), before + 1, '还在一分钟的等待里，不提前重试')
    t.mock.timers.tick(60_000)
    await drain()
    eq(calls(), before + 2, '翻倍后的两分钟到了才重试，这次成功')
    eq(h.board.all['sync:feishu'].state, 'ready')
    // 成功之后不再重试。
    t.mock.timers.tick(3_600_000)
    await drain()
    eq(calls(), before + 2)
  } finally {
    h.close()
    t.mock.timers.reset()
  }
})

test('pause 没有变化就什么都不记；setup 没就绪时拒绝同步；未知块按 unknownBlock 拒绝', async () => {
  const h = makeHost()
  try {
    const revision = h.store.blockRevision('pause')
    eq(await h.settings.pause(false, 'panel'), { paused: false })
    eq([h.store.blockRevision('pause'), h.calls.notify, h.calls.delivery], [revision, 0, 0], '没有变化就不记版本、不通知')
    h.setup.configured = () => false
    await rejects(h.settings.sync('feishu'), (error) => error instanceof UserError && error.code === 'nothingToSync')
    throws(() => h.settings.block('source:x'), (error) => error instanceof UserError && error.code === 'unknownBlock')
  } finally {
    h.close()
  }
})
