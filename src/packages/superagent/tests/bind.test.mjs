/**
 * @pneuma/superagent 的「工单 ↔ PR 接线」测试：离线、不联网、不读用户真实的 `~/.dsc`。
 *
 * 九条用例，钉的都是「改错了不报错、只会静默失联」的判断：
 *   1. 认领：机器人同仓、分支末段等于工单短名 → 绑一次，线程 id 是 PR 号、`own` 为真；
 *   2. 登录名不是机器人 → 不绑；
 *   3. 机器人登录名对、但 head 在别人的 fork 里 → 不绑（这是冒充防护）；
 *   4. 分支末段不是工单短名 → 不绑；
 *   5. 已经关注过 PR 的工单跳过，不再绑第二张；
 *   6. 读 PR 失败 → 这一拍不绑任何单，只记一行，不抛；
 *   7. 单张绑失败不影响同拍其余工单，失败的那张也不进返回值；
 *   8. `pullWatches`：没 PR 的不看、只看开着的、开着的优先于关掉的；
 *   9. `pollTicketChecks`：一张抛了其余照看，整个函数不抛，日志一单一条。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/bind
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { bindAgentPulls, pollTicketChecks, pullWatches } = await import('../../../../lib/packages/superagent/adapters/github/bind.js')

const ACCOUNT = { login: 'dsc-bot', repository: 'owner/repo' }

/** 一张开着的 PR；只填判归属与绑线程用得到的字段。 */
const pr = (number, overrides = {}) => ({
  number,
  user: { login: 'dsc-bot' },
  head: { ref: `agent/tidy-login`, repo: { full_name: 'owner/repo' } },
  ...overrides,
})

/** 一张还活着的工单；`name` 是分支末段要比的那一段。 */
const ticket = (id, name, follows = []) => ({ id, execution: { name }, follows })

/** 记下所有 `bind` 调用，断言参数而不是只数次数。 */
const recorder = () => {
  const calls = []
  return { calls, bind: (ticketId, thread, own) => { calls.push({ ticketId, thread, own }) } }
}

test('认领：机器人同仓、分支末段对得上 → 线程 id 是 PR 号', async () => {
  const seen = recorder()
  const bound = await bindAgentPulls({
    pulls: async () => [pr(12)],
    tickets: () => [ticket('t1', 'tidy-login')],
    account: ACCOUNT,
    bind: seen.bind,
  })
  assert.deepEqual(seen.calls, [{ ticketId: 't1', thread: { source: 'github', id: '12' }, own: true }])
  assert.deepEqual(bound, [{ ticketId: 't1', number: 12 }])
})

test('不绑：登录名不是机器人', async () => {
  const seen = recorder()
  const bound = await bindAgentPulls({
    pulls: async () => [pr(12, { user: { login: 'someone-else' } })],
    tickets: () => [ticket('t1', 'tidy-login')],
    account: ACCOUNT,
    bind: seen.bind,
  })
  assert.deepEqual(seen.calls, [])
  assert.deepEqual(bound, [])
})

test('不绑：别人的 fork 里开了同名分支（冒充防护）', async () => {
  const seen = recorder()
  await bindAgentPulls({
    pulls: async () => [pr(12, { head: { ref: 'agent/tidy-login', repo: { full_name: 'stranger/repo' } } })],
    tickets: () => [ticket('t1', 'tidy-login')],
    account: ACCOUNT,
    bind: seen.bind,
  })
  assert.deepEqual(seen.calls, [])
})

test('不绑：分支末段不是工单短名', async () => {
  const seen = recorder()
  await bindAgentPulls({
    pulls: async () => [pr(12, { head: { ref: 'agent/other-work', repo: { full_name: 'owner/repo' } } })],
    tickets: () => [ticket('t1', 'tidy-login')],
    account: ACCOUNT,
    bind: seen.bind,
  })
  assert.deepEqual(seen.calls, [])
})

test('跳过：已经关注过 PR 的工单不再绑第二张', async () => {
  const seen = recorder()
  const followed = [{ thread: 'github:99', closed: undefined }]
  await bindAgentPulls({
    pulls: async () => [pr(12)],
    tickets: () => [ticket('t1', 'tidy-login', followed)],
    account: ACCOUNT,
    bind: seen.bind,
  })
  assert.deepEqual(seen.calls, [])
})

test('读 PR 失败：这一拍不绑，只记一行，不抛', async () => {
  const seen = recorder()
  const lines = []
  const bound = await bindAgentPulls({
    pulls: async () => { throw new Error('502 bad gateway') },
    tickets: () => [ticket('t1', 'tidy-login')],
    account: ACCOUNT,
    bind: seen.bind,
    log: (line) => { lines.push(line) },
  })
  assert.deepEqual(bound, [])
  assert.deepEqual(seen.calls, [])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /读开着的 PR 失败：502 bad gateway/u)
})

test('单张绑失败：其余工单照绑，失败的不进返回值', async () => {
  const lines = []
  const seen = []
  const bound = await bindAgentPulls({
    pulls: async () => [
      pr(12, { head: { ref: 'agent/one', repo: { full_name: 'owner/repo' } } }),
      pr(13, { head: { ref: 'agent/two', repo: { full_name: 'owner/repo' } } }),
    ],
    tickets: () => [ticket('t1', 'one'), ticket('t2', 'two')],
    account: ACCOUNT,
    bind: (ticketId, thread, own) => {
      if (ticketId === 't1') throw new Error('已经结束了')
      seen.push({ ticketId, thread, own })
    },
    log: (line) => { lines.push(line) },
  })
  assert.deepEqual(seen, [{ ticketId: 't2', thread: { source: 'github', id: '13' }, own: true }])
  assert.deepEqual(bound, [{ ticketId: 't2', number: 13 }])
  assert.match(lines[0], /工单 t1 绑 PR #12 失败：已经结束了/u)
})

test('pullWatches：没 PR 的不看，开着的优先于关掉的', async () => {
  const watches = pullWatches([
    ticket('none', 'a'),
    ticket('open', 'b', [{ thread: 'github:12' }]),
    ticket('closed', 'c', [{ thread: 'github:7', closed: { at: '2026-09-01T00:00:00.000Z', outcome: 'merged' } }]),
    ticket('both', 'd', [
      { thread: 'github:9', closed: { at: '2026-09-01T00:00:00.000Z', outcome: 'merged' } },
      { thread: 'github:12' },
    ]),
  ])
  assert.deepEqual(watches, [
    { ticketId: 'open', number: 12 },
    { ticketId: 'closed', number: 7 },
    { ticketId: 'both', number: 12 },
  ])
})

test('pollTicketChecks：一张抛了其余照看，整体不抛', async () => {
  const lines = []
  const checked = []
  await pollTicketChecks({
    tickets: () => [
      ticket('t1', 'a', [{ thread: 'github:12' }]),
      ticket('t2', 'b', [{ thread: 'github:13' }]),
      ticket('t3', 'c'),
    ],
    check: async (number) => {
      checked.push(number)
      if (number === 12) throw new Error('403 权限不足')
    },
    log: (line) => { lines.push(line) },
  })
  assert.deepEqual(checked.sort(), [12, 13])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /工单 t1 的 PR CI 轮询失败：403 权限不足/u)
})
