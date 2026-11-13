/**
 * 判定器的线程上下文（backlog S1）：窗口选择对齐上游 `threadWindow`，读失败不拖累判定。
 *
 * 钉三件最容易悄悄坏掉的事：
 *   1. 窗口的选取与省略计数——它决定模型看到的是「这条消息在回答谁」，还是一段无关的开头；
 *   2. 读失败（网络、404、形状变了）只让上下文缺席，判定照常进行；
 *   3. 非 GitHub 来源一条请求都不发，`undefined` 就是「没有上下文」的唯一答案。
 *
 * 与其它包级测试一样 import `lib/` 的构建产物；跑之前先 `pnpm run build`。
 * 全程用 `tmpdir()` 下的临时目录，不碰真实 `~/.dsc`。
 *
 * @module @pneuma/superagent/tests/thread-context
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'superagent-thread-context-'))
process.env['DSC_HOME'] = home

const { threadWindow, readThreadWindow } = await import('../../../../lib/packages/superagent/adapters/github/read.js')
const { SuperagentRuntime, renderThreadContext } = await import('../../../../lib/packages/superagent/runtime.js')
const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { ModelAssessor } = await import('../../../../lib/packages/superagent/adapters/assessor-model.js')
const { defaultSettings } = await import('../../../../lib/packages/superagent/adapters/settings.js')

after(() => { rmSync(home, { recursive: true, force: true }) })

/** 造 `count` 条按时间递增的会话消息，id 是 `m1`…`mN`。 */
function messages(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${String(index + 1)}`,
    author: index % 2 === 0 ? 'alice' : 'bob',
    at: `2026-01-01T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00Z`,
    text: `第 ${String(index + 1)} 条`,
  }))
}

/**
 * 一条 GitHub 会话评论的 Trigger（形状取自 `adapters/github/trigger.ts:152-171`）。
 *
 * `url` 是评论的网页地址，也是窗口用来认「哪条是触发消息」的 id。
 */
function githubTrigger(overrides = {}) {
  return {
    id: 'trg-gh-1',
    source: 'github',
    threads: [{ source: 'github', id: '12' }],
    actor: { source: 'github', id: 'alice' },
    human: true,
    at: '2026-01-01T00:01:00.000Z',
    text: '那就按你说的办',
    url: 'https://github.com/acme/widgets/issues/12#issuecomment-2',
    channel: { source: 'github', thread: 'github:12', address: { number: '12' } },
    meta: { number: 12, isPr: false, commentId: 2, kind: 'conversation', title: '改首页' },
    ...overrides,
  }
}

/** 一个只实现 `get` 的假 GitHub 客户端；`readThreadWindow` 只用到这一个动作。 */
function fakeApi(get) {
  return { get }
}

/** 一条评论的 API 形状（`CommentSchema`，`adapters/github/trigger.ts:73-79`）。 */
function comment(id, body, login = 'bob') {
  return {
    id,
    body,
    user: { login, type: 'User' },
    html_url: `https://github.com/acme/widgets/issues/12#issuecomment-${String(id)}`,
    created_at: `2026-01-01T00:0${String(id)}:00Z`,
  }
}

/** Issue / PR 的 API 形状（`IssueSchema`，`adapters/github/trigger.ts:83-87`）。 */
function issue() {
  return {
    id: 1200,
    number: 12,
    title: '改首页',
    state: 'open',
    created_at: '2026-01-01T00:00:00Z',
    html_url: 'https://github.com/acme/widgets/issues/12',
    user: { login: 'alice', type: 'User' },
    body: '首页标题要改',
  }
}

/** 造一个运行期；只给它判定上下文要用的那一格。没有 ctx，不会起 worker。 */
async function withRuntime(githubApi, work) {
  const store = openStore()
  const runtime = new SuperagentRuntime(store, {
    now: () => '2026-01-01T00:00:00.000Z',
    log: () => {},
    githubApi,
  })
  try {
    // 必须 await：`work` 是异步的，先关库会让它的后半段撞上已关闭的连接。
    return await work({ runtime, store })
  } finally {
    runtime.close()
    store.close()
  }
}

/** 一份形状正确的模型回复（两条启用规则各判一次，接单且方向明确）。 */
function acceptReply() {
  return JSON.stringify({
    decision: 'accept',
    direction: {
      implementation_requested: true,
      target_basis: 'existing-standard',
      requires_design_decision: false,
      evidence: '那就按你说的办',
    },
    rule_assessments: [
      { rule_id: 'copy', matched: true, reason: '明确要求改首页' },
      { rule_id: 'visual', matched: false, reason: '不涉及样式' },
    ],
    title: '改首页',
    scope: 'README.md',
    reason: '属于首页文案修改',
    intent_evidence: '那就按你说的办',
  })
}

/** 假引擎：只关心「有没有 decide」。 */
function fakeEngine(candidate) {
  const decisions = []
  return {
    engine: {
      candidate: () => candidate,
      candidateDelivered: () => {},
      decide: (triggerId, outcome) => { decisions.push({ triggerId, outcome }); return { ticketId: 'tkt-1' } },
    },
    decisions,
  }
}

/** 造一个模型版判定器，提示词与日志都收回来。 */
function modelAssessor(extra = {}) {
  const prompts = []
  const logs = []
  const assessor = new ModelAssessor({
    complete: async (prompt) => { prompts.push(prompt); return acceptReply() },
    settings: () => defaultSettings(),
    log: (line) => { logs.push(line) },
    ...extra,
  })
  return { assessor, prompts, logs }
}

// ── 1. 窗口选择：与上游 `threadWindow` 同一套规则 ─────────────────────────────

test('窗口选择：10 条消息、触发在第 6 条 → 前五条 + 前后各五条覆盖全部', () => {
  const result = threadWindow(messages(10), 'm6')
  assert.equal(result.sourceFound, true)
  assert.equal(result.loaded, 10)
  assert.equal(result.omittedAfter, 0)
  assert.deepEqual(result.messages.map((message) => message.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.ok(result.messages.every((message) => message.omittedBefore === 0), '全选时不该有省略')
})

test('窗口选择：40 条、触发在第 21 条 → 前五条 + 第 16~26 条，空隙与末尾计数正确', () => {
  const result = threadWindow(messages(40), 'm21')
  assert.equal(result.sourceFound, true)
  assert.equal(result.loaded, 40)
  // 前五条（index < 5）+ 触发消息前后各五条（index 15~25）。
  assert.deepEqual(
    result.messages.map((message) => message.position),
    [1, 2, 3, 4, 5, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
  )
  const gap = result.messages.find((message) => message.position === 16)
  assert.equal(gap.omittedBefore, 10, '第 6~15 条被省略')
  assert.equal(result.messages.filter((message) => message.omittedBefore !== 0).length, 1)
  assert.equal(result.omittedAfter, 14, '第 27~40 条被省略')
})

test('窗口选择：找不到触发消息 → sourceFound 为 false，窗口只留前五条', () => {
  const result = threadWindow(messages(30), 'https://example.com/not-in-thread')
  assert.equal(result.sourceFound, false)
  assert.deepEqual(result.messages.map((message) => message.position), [1, 2, 3, 4, 5])
  assert.equal(result.omittedAfter, 25)
})

// ── 2. 读窗口：描述 + 分页 + 排序 ───────────────────────────────────────────

test('readThreadWindow：描述算第一条，评论按时刻升序，maxPages 封顶不多读', async () => {
  const pages = []
  const api = fakeApi(async (path) => {
    if (path === 'issues/12') return issue()
    pages.push(path)
    // 第一页排成倒序，验证窗口按 created_at 排序而不是相信响应顺序。
    if (path.includes('page=1')) return [comment(3, '第三条'), comment(1, '第一条'), comment(2, '第二条')]
    return [comment(4, '第四条')]
  })
  const window = await readThreadWindow(
    api, 12, 'https://github.com/acme/widgets/issues/12#issuecomment-2', 1,
  )
  assert.equal(pages.length, 1, 'maxPages=1 只该读一页评论')
  assert.deepEqual(window.messages.map((message) => message.text), [
    '改首页\n\n首页标题要改', '第一条', '第二条', '第三条',
  ])
  assert.equal(window.sourceFound, true)
  assert.equal(window.loaded, 4)
  // 渲染出来要带作者与时刻，并标出哪条是这条请求本身。
  const text = renderThreadContext(window, 'https://github.com/acme/widgets/issues/12#issuecomment-2')
  assert.match(text, /^对话上下文（本线程共 4 条，省略前 0 条、后 0 条）：/)
  assert.match(text, /alice/)
  assert.match(text, /2026-01-01T00:01:00Z bob/)
  assert.match(text, /这条就是上面的请求正文/)
})

test('readThreadWindow：评论满页时继续翻页', async () => {
  const pages = []
  const api = fakeApi(async (path) => {
    if (path === 'issues/12') return issue()
    pages.push(path)
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => comment(index + 10, `满页 ${String(index)}`))
    }
    return []
  })
  const window = await readThreadWindow(api, 12, '', 2)
  assert.equal(pages.length, 2, '满页要读下一页，第二页空就停')
  assert.equal(window.loaded, 101)
  assert.equal(window.sourceFound, false)
})

// ── 3. 读失败与非 GitHub 来源：只让上下文缺席 ───────────────────────────────

test('运行期：读上下文失败 → 返回 undefined，不抛', async () => {
  await withRuntime(
    () => fakeApi(async () => { throw new Error('HTTP 502') }),
    async ({ runtime }) => {
      const context = await runtime.threadContext(githubTrigger())
      assert.equal(context, undefined)
    },
  )
})

test('运行期：非 github 来源、没有编号 → undefined，一次请求都不发', async () => {
  let calls = 0
  await withRuntime(
    () => fakeApi(async () => { calls += 1; return issue() }),
    async ({ runtime }) => {
      assert.equal(await runtime.threadContext(githubTrigger({ source: 'manual' })), undefined)
      assert.equal(await runtime.threadContext(githubTrigger({ meta: { title: '没有编号' } })), undefined)
      assert.equal(calls, 0, '非 github 来源不该读 GitHub')
    },
  )
})

test('判定器：上下文读取抛错也照常判，提示词里没有「上下文」一节', async () => {
  const { assessor, prompts } = modelAssessor({
    context: async () => { throw new Error('读线程失败') },
  })
  const candidate = { evalId: 'eval-1', strength: 'explicit', triggers: [githubTrigger()] }
  const { engine, decisions } = fakeEngine(candidate)
  assessor.request(candidate)
  await assessor.drainAsync(engine)
  assert.equal(decisions.length, 1, '读不到上下文不该让这一条判不了')
  assert.equal(decisions[0].outcome.kind, 'accept')
  assert.doesNotMatch(prompts[0], /不是工单正文/)
})

test('判定器：有上下文时拼进提示词，并写明它不是工单正文', async () => {
  const { assessor, prompts } = modelAssessor({
    context: async () => '对话上下文（本线程共 2 条，省略前 0 条、后 0 条）：\n- 2026-01-01T00:00:00Z alice：首页标题要改',
  })
  const candidate = { evalId: 'eval-1', strength: 'explicit', triggers: [githubTrigger()] }
  const { engine, decisions } = fakeEngine(candidate)
  assessor.request(candidate)
  await assessor.drainAsync(engine)
  assert.equal(decisions.length, 1)
  assert.match(prompts[0], /不是工单正文/)
  assert.match(prompts[0], /对话上下文（本线程共 2 条/)
  assert.match(prompts[0], /那就按你说的办/, '请求正文仍然在上面')
})
