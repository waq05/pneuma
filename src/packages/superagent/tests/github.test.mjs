/**
 * @pneuma/superagent 的 GitHub 来源适配器测试：离线、不联网、不读用户真实的 `~/.dsc`。
 *
 * 十二个用例，每个只钉一件「改错了不会报错、只会静默漏事件」的事：
 *   1. Issue 正文的 Trigger 逐字段（id 公式、meta 形状、addressed）；
 *   2. 行内 review 评论的 Trigger 逐字段（diff 片段进 text、inReplyTo 进 meta）；
 *   3. review 结论（APPROVED）没有正文也要进 text；
 *   4. human / addressed：机器人、自己发的、邮箱里的 @；
 *   5. CI 两种事件：默认分支没有回话地址，PR 的 CI 挂在 PR 线程上；
 *   6. githubAddress 的 7 种地址（上游 `sources.spec.ts:344-354`）；
 *   7. review 评论分页与 bot / 回复归属（上游 `github-read.spec.ts:46-53`）；
 *   8. PR 检查跨页合并、提交状态取最新（上游 `github-read.spec.ts:23-29`）；
 *   9. 410 = 永久删除：不进 failures、不动重试表、游标照常前进；
 *  10. 404 = 可重试：进重试表、这一拍报失败；304 = 静默返回；
 *  11. 403 + locked = 永久不可回复；403 不锁 = 可重试；
 *  12. 游标：两拍之间回退 5 秒、ETag 只在 since 未变时发送、14 天视野夹到整点、自己发的事件跳过。
 *
 * 时钟由 `now` 注入，库在 `tmpdir()` 下的临时 `DSC_HOME` 里；`paths.ts` 每次都重读
 * `DSC_HOME`，所以每个用例一份新库。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/github
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// 必须在 import lib/ 之前把 DSC_HOME 指到临时目录，否则会读走开发者真实的 ~/.dsc。
const home = mkdtempSync(join(tmpdir(), 'superagent-github-home-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const { openStore } = await import('../../../../lib/packages/superagent/adapters/store.js')
const { createGithubApi, GithubError } = await import('../../../../lib/packages/superagent/adapters/github/api.js')
const { GITHUB_KEYS } = await import('../../../../lib/packages/superagent/adapters/github/state.js')
const {
  branchCiTrigger, ciTrigger, commentTrigger, githubAddress, IssueSchema, CommentSchema, issueTrigger, pullTrigger,
} = await import('../../../../lib/packages/superagent/adapters/github/trigger.js')
const { pullChecks, readGithub } = await import('../../../../lib/packages/superagent/adapters/github/read.js')
const { sendGithub } = await import('../../../../lib/packages/superagent/adapters/github/channel.js')
const { createGithubSource, githubEngine } = await import('../../../../lib/packages/superagent/adapters/github/source.js')
const { cursorAt } = await import('../../../../lib/packages/superagent/adapters/github/poll.js')

/** 固定时钟：断言不依赖「跑得多快」。 */
const STARTED = '2026-09-10T00:00:00.000Z'
const LATER = '2026-09-10T00:01:00.000Z'
const LATER_STILL = '2026-09-10T00:02:00.000Z'

const roots = []

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
})

/** 一个用例一份临时根目录与一个库；用完关库、留目录给 after 清。 */
async function withStore(work) {
  const root = mkdtempSync(join(tmpdir(), 'superagent-github-'))
  roots.push(root)
  process.env['DSC_HOME'] = root
  const store = openStore()
  try {
    return await work(store)
  } finally {
    store.close()
  }
}

/** 直接读 kv 里的一条；断言写在调用方。 */
function kv(store, key) {
  const row = store.handle.prepare('SELECT value FROM kv WHERE key = ?').get(key)
  return row === undefined ? undefined : JSON.parse(row.value)
}

/** 直接写 kv 里的一条，用来造「上一拍留下的状态」。 */
function seed(store, key, value) {
  store.handle.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

/** 一个 JSON 响应。 */
function json(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: options.headers ?? {},
  })
}

/** 304 不能带 body，`new Response(string, { status: 304 })` 会直接抛。 */
function notModified() {
  return new Response(null, { status: 304 })
}

/** 假 fetch：记下每次请求，交给用例自己的路由函数。 */
function fakeFetch(route) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })
    return route(String(url), init)
  }
  return { calls, fetch }
}

/** 只取这次 tick 发出的请求。 */
function callsIn(calls, from) {
  return calls.slice(from)
}

/** 按路径片段挑请求。 */
function along(calls, part) {
  return calls.filter((call) => call.url.includes(part))
}

/**
 * 造一个来源实例。
 *
 * `clock` 可变：游标语义全靠两拍之间的时间差，不能用一个固定时钟。
 * 引擎是假的，只记「谁在什么时候被叫」；真正的核心不在这里跑。
 */
function makeSource(store, fetch, options = {}) {
  const received = []
  const closed = []
  let clock = options.started ?? STARTED
  const source = createGithubSource({
    api: createGithubApi({ token: 'token', repository: 'acme/widgets', fetch }),
    repository: 'acme/widgets',
    login: 'agent-bot',
    engine: {
      receive(trigger) { received.push(trigger); return 'stored' },
      bindThread() { return undefined },
      threadClosed(thread, reason) { closed.push({ thread, reason }); return undefined },
    },
    store: { handle: store.handle },
    now: () => clock,
    log: () => {},
    observe: options.observe,
  })
  return { source, received, closed, setClock(value) { clock = value } }
}

/** 一条通知；`subject.url` 是 Issue 或 PR 的 API 地址，与 GitHub 一致。 */
function notification(number, pr = false) {
  return {
    id: `n${number}`,
    updated_at: '2026-09-09T12:00:00Z',
    reason: 'mention',
    repository: { full_name: 'acme/widgets' },
    subject: {
      url: `https://api.github.com/repos/acme/widgets/${pr ? 'pulls' : 'issues'}/${number}`,
      type: pr ? 'PullRequest' : 'Issue',
      title: 'x',
    },
  }
}

/** 事件流里的一条评论；`issue_url` 是它指回 Issue 的地址。 */
function streamComment(id, login, updatedAt, number = 12) {
  return {
    id,
    body: `comment ${id}`,
    user: { login, type: 'User' },
    html_url: `https://github.com/acme/widgets/issues/${number}#issuecomment-${id}`,
    created_at: updatedAt,
    updated_at: updatedAt,
    issue_url: `https://api.github.com/repos/acme/widgets/issues/${number}`,
  }
}

test('Issue 正文的 Trigger 与上游逐字段一致：id 公式、meta 形状、addressed 都在', () => {
  const issue = IssueSchema.parse({
    id: 1012,
    number: 12,
    title: 'Login fails',
    body: '@agent-bot please fix the login',
    state: 'open',
    created_at: '2026-09-09T00:00:00Z',
    html_url: 'https://github.com/acme/widgets/issues/12',
    user: { login: 'alice', type: 'User' },
  })
  assert.deepEqual(issueTrigger(issue, 'agent-bot'), {
    // 逐字符对齐上游 `github-trigger.ts:84`：key('github-issue', String(number)) 的 SHA-256 前 32 位。
    id: 'bb5ff665ff31195d0bb3afaf446dfa9d',
    source: 'github',
    threads: [{ source: 'github', id: '12' }],
    actor: { source: 'github', id: 'alice' },
    human: true,
    at: '2026-09-09T00:00:00Z',
    text: 'Login fails\n\n@agent-bot please fix the login',
    addressed: 'mention',
    channel: { source: 'github', thread: 'github:12', address: { number: '12', url: 'https://github.com/acme/widgets/issues/12' } },
    url: 'https://github.com/acme/widgets/issues/12',
    meta: { number: 12, isPr: false, kind: 'issue' },
  })
  // PR 与 Issue 共用一个编号序列，所以 PR 描述的 id 公式与 Issue 相同（`github-trigger.ts:90-96`）。
  const pull = pullTrigger({
    number: 7, title: 'Fix', body: 'body', user: { login: 'alice', type: 'User' },
    created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/pull/7',
  }, 'agent-bot')
  assert.equal(pull.id, '6618ff4acad5e9586f4bba62b50b259c')
  assert.deepEqual(pull.meta, { number: 7, isPr: true, prAuthor: 'alice', kind: 'pull' })
})

test('行内 review 评论：diff 片段进 text、inReplyTo 进 meta、频道指向讨论地址', () => {
  const comment = CommentSchema.parse({
    id: 5,
    body: 'nit',
    user: { login: 'review-bot[bot]', type: 'Bot' },
    html_url: 'https://github.com/acme/widgets/pull/7#discussion_r5',
    updated_at: '2026-09-01T00:00:00Z',
    path: 'src/render.ts',
    line: 43,
    diff_hunk: '@@ -40,6 +40,8 @@\n   const title = view.title\n   const margin = 12\n+  const padding = 8',
    in_reply_to_id: 4,
  })
  assert.deepEqual(
    commentTrigger(comment, { number: 7, isPr: true, prAuthor: 'agent-bot' }, 'inline', 'agent-bot', () => STARTED),
    {
      id: '18758da1f7b1e72355a5e68ff12813d2',
      source: 'github',
      threads: [{ source: 'github', id: '7' }],
      actor: { source: 'github', id: 'review-bot[bot]' },
      human: false,
      at: '2026-09-01T00:00:00Z',
      text: 'src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\nnit',
      channel: {
        source: 'github',
        thread: 'github:7',
        address: { number: '7', url: 'https://github.com/acme/widgets/pull/7#discussion_r5' },
      },
      url: 'https://github.com/acme/widgets/pull/7#discussion_r5',
      meta: {
        number: 7, isPr: true, prAuthor: 'agent-bot', commentId: 5, kind: 'inline',
        path: 'src/render.ts', line: 43, inReplyTo: 4,
      },
    },
  )
})

test('review 结论没有正文也要进 text，且不把评论地址当线程地址', () => {
  const review = CommentSchema.parse({
    id: 8, user: { login: 'carol', type: 'User' }, submitted_at: '2026-09-01T00:00:00Z', state: 'APPROVED', commit_id: 'abc123',
  })
  const trigger = commentTrigger(review, { number: 7, isPr: true }, 'review', 'agent-bot', () => STARTED)
  assert.equal(trigger.text, 'APPROVED review of commit abc123')
  assert.equal(trigger.id, 'a4274d7777504eb0913fb874a970e7bb')
  assert.equal(trigger.at, '2026-09-01T00:00:00Z')
  assert.equal(trigger.human, true)
  assert.deepEqual(trigger.meta, { number: 7, isPr: true, commentId: 8, kind: 'review' })
  assert.deepEqual(trigger.channel, { source: 'github', thread: 'github:7', address: { number: '7' } })
  assert.equal('addressed' in trigger, false)
  assert.equal('url' in trigger, false)
  // `COMMENTED` 且没有正文的 review 什么都带不出来，调用方据此跳过（`github-trigger.ts:55`）。
  assert.equal(commentTrigger({ ...review, state: 'COMMENTED', body: null }, { number: 7, isPr: true }, 'review', 'agent-bot').text, '')
})

test('human 与 addressed：机器人、自己发的、邮箱里的 @ 都不算', () => {
  const clock = () => STARTED
  const comment = (fields) => CommentSchema.parse({
    id: 1,
    user: { login: 'alice', type: 'User' },
    html_url: 'https://github.com/acme/widgets/pull/7#discussion_r1',
    updated_at: '2026-09-01T00:00:00Z',
    ...fields,
  })
  const at = { number: 7, isPr: true }
  assert.equal(commentTrigger(comment({ body: '@Agent-Bot please fix' }), at, 'conversation', 'agent-bot', clock).addressed, 'mention')
  assert.equal('addressed' in commentTrigger(comment({ body: 'mail@agent-bot.example' }), at, 'conversation', 'agent-bot', clock), false)
  assert.equal('addressed' in commentTrigger(comment({ body: 'hi @agent-bot2' }), at, 'conversation', 'agent-bot', clock), false)
  assert.equal(commentTrigger(comment({ body: 'pushed', user: { login: 'Agent-Bot', type: 'User' } }), at, 'conversation', 'agent-bot', clock).human, false)
  assert.equal(commentTrigger(comment({ body: 'x', user: { login: 'review-bot', type: 'User' } }), at, 'conversation', 'agent-bot', clock).human, true)
  assert.equal(commentTrigger(comment({ body: 'x', user: { login: 'ci[bot]', type: 'Bot' } }), at, 'conversation', 'agent-bot', clock).human, false)
  // 已注销的账号 GitHub 返回 null，展示名是 ghost（`github-trigger.ts:19-21`）。
  assert.equal(commentTrigger(comment({ body: 'x', user: null }), at, 'conversation', 'agent-bot', clock).actor.id, 'ghost')
})

test('CI 两种事件：默认分支没有回话地址，PR 的 CI 挂在 PR 线程上', () => {
  const now = () => STARTED
  const branchText = 'CI failed 1/2 on main at abc1234\nRead github/commits/abc1234/checks for every check.'
  assert.deepEqual(branchCiTrigger('main', 'abc1234', 2, branchText, 'https://github.com/acme/widgets/commit/abc1234', now), {
    id: 'e2c740c00acdbddf242231bb1b0fec9e',
    source: 'github',
    threads: [{ source: 'github', id: 'ci:main' }],
    actor: { source: 'github', id: '' },
    human: false,
    at: STARTED,
    text: branchText,
    url: 'https://github.com/acme/widgets/commit/abc1234',
    meta: { ci: true, branch: 'main', sha: 'abc1234', revision: 2 },
  })
  const prText = 'CI passed 2/2 on PR #7 at abc1234\nRead github/pulls/7/checks for every check.'
  assert.deepEqual(
    ciTrigger({ number: 7, html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'agent-bot' } }, 1, prText, now),
    {
      id: '453ad51a8dcc50926d911e1b4f83980b',
      source: 'github',
      threads: [{ source: 'github', id: '7' }],
      actor: { source: 'github', id: '' },
      human: false,
      at: STARTED,
      text: prText,
      channel: { source: 'github', thread: 'github:7', address: { number: '7' } },
      url: 'https://github.com/acme/widgets/pull/7',
      meta: { number: 7, isPr: true, prAuthor: 'agent-bot', ci: true, revision: 1 },
    },
  )
})

test('githubAddress 只认本仓库的 Issue / PR / review 讨论地址', () => {
  assert.deepEqual(githubAddress('https://api.github.com/repos/acme/widgets/pulls/9', 'acme/widgets'), { number: 9, pr: true })
  assert.deepEqual(githubAddress('https://api.github.com/repos/Acme/Widgets/issues/12', 'acme/widgets'), { number: 12, pr: false })
  assert.deepEqual(githubAddress('https://github.com/acme/widgets/pull/7/#discussion_r5', 'acme/widgets'), {
    number: 7, pr: true, discussion: 5,
  })
  assert.deepEqual(githubAddress('https://github.com/acme/widgets/issues/7#issuecomment-3', 'acme/widgets'), { number: 7, pr: false })
  for (const url of [
    'https://github.com/acme/gadgets/pull/7',
    'https://api.github.com/repos/acme/widgets/commits/abc',
    'https://github.com/acme/widgets/pull/7/files',
    '',
  ]) {
    assert.equal(githubAddress(url, 'acme/widgets'), undefined)
  }
})

/** GitHub REST 的一条行内 review 评论（照上游 `github-read.spec.ts:39-45` 的假数据）。 */
function reviewComment(id, reply) {
  return {
    id,
    url: `https://api.github.com/repos/acme/widgets/pulls/comments/${id}`,
    pull_request_review_id: 77,
    node_id: 'PRRC_x',
    path: 'src/render.ts',
    line: 43,
    original_line: 43,
    side: 'RIGHT',
    commit_id: 'abc',
    diff_hunk: '@@ -40,6 +40,8 @@\n   const title = view.title\n   const margin = 12\n+  const padding = 8',
    user: {
      login: id === 2 ? 'review-bot[bot]' : 'carol',
      id: 5,
      type: id === 2 ? 'Bot' : 'User',
    },
    body: `comment ${id}`,
    created_at: `2026-09-09T00:00:0${id}Z`,
    updated_at: `2026-09-09T00:00:0${id}Z`,
    html_url: `https://github.com/acme/widgets/pull/9#discussion_r${id}`,
    author_association: 'MEMBER',
    ...reply ? { in_reply_to_id: reply } : {},
  }
}

test('review 评论：作者、时间、正文、在回谁、文件与行号都对，满 20 条给下一页', async () => {
  const api = (route) => createGithubApi({ token: 'token', repository: 'acme/widgets', fetch: fakeFetch(route).fetch })
  const page = await readGithub(api(async () => json([reviewComment(1), reviewComment(2, 1)])), 'github/pulls/9/comments/1')
  assert.deepEqual(page, {
    messages: [
      {
        id: '1', from: 'carol', at: '2026-09-09T00:00:01Z', text: 'comment 1',
        url: 'https://github.com/acme/widgets/pull/9#discussion_r1', path: 'src/render.ts', line: 43,
      },
      {
        id: '2', from: 'review-bot[bot]', at: '2026-09-09T00:00:02Z', text: 'comment 2', bot: true,
        reply_to: '1', url: 'https://github.com/acme/widgets/pull/9#discussion_r2', path: 'src/render.ts', line: 43,
      },
    ],
  })
  // review 线程：从任意一条回复出发都能捞回同一条线程，第一条带 diff 片段（`github-read.spec.ts:54-61`）。
  const threadApi = createGithubApi({
    token: 'token',
    repository: 'acme/widgets',
    fetch: fakeFetch(async () => json([reviewComment(3), reviewComment(2, 1), reviewComment(1), reviewComment(4, 3)])).fetch,
  })
  const thread = await readGithub(threadApi, 'github/pulls/9/thread/2')
  assert.deepEqual(thread.messages.map((message) => [message.id, message.reply_to]), [['1', undefined], ['2', '1']])
  assert.equal(
    thread.messages[0].text,
    'src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\ncomment 1',
  )
  const many = Array.from({ length: 20 }, (_, index) => reviewComment((index % 8) + 1))
  const calls = []
  const apiMany = createGithubApi({
    token: 'token',
    repository: 'acme/widgets',
    fetch: async (url) => { calls.push(String(url)); return json(many) },
  })
  const next = await readGithub(apiMany, 'github/pulls/9/comments/1')
  assert.equal(next.next_resource, 'github/pulls/9/comments/2')
  assert.equal(next.messages.length, 20)
  assert.match(calls[0], /pulls\/9\/comments\?per_page=20&page=1$/)
})

test('PR 检查跨页合并，提交状态按 context 取最新一条', async () => {
  const { calls, fetch } = fakeFetch(async (url) => {
    if (url.includes('/check-runs')) {
      if (url.includes('page=2')) return json({ check_runs: [{ name: 'a', status: 'in_progress', conclusion: null }] })
      return json(
        { check_runs: [{ name: 'z', status: 'completed', conclusion: 'success' }] },
        { headers: { link: '<https://api.github.com/repositories/1/commits/abc/check-runs?per_page=100&page=2>; rel="next"' } },
      )
    }
    return json([{ context: 'build', state: 'success' }, { context: 'build', state: 'failure' }])
  })
  const api = createGithubApi({ token: 'token', repository: 'acme/widgets', fetch })
  const snapshot = await pullChecks(api, 'abc')
  assert.deepEqual(snapshot.checks.map((check) => check.name), ['a', 'z'])
  assert.deepEqual(snapshot.statuses, [{ context: 'build', state: 'success' }])
  assert.equal(along(calls, '/check-runs').length, 2)
  assert.match(along(calls, 'page=2')[0].url, /repositories\/1\/commits\/abc\/check-runs/)
})

test('410 是永久删除：不抛、不进重试表、游标照常前进', async () => {
  await withStore(async (store) => {
    const { fetch } = fakeFetch(async (url) => {
      if (url.includes('/notifications')) return json([notification(12)])
      if (url.includes('/issues/12')) return json({ message: 'Gone' }, { status: 410 })
      throw new Error(`unexpected ${url}`)
    })
    const { source, received } = makeSource(store, fetch, { observe: { issues: false, pulls: false, comments: false, ci: false } })
    await source.tick()
    assert.equal(received.length, 0)
    assert.deepEqual(kv(store, GITHUB_KEYS.retries), {})
    assert.equal(kv(store, GITHUB_KEYS.since), cursorAt(STARTED))
    assert.equal(kv(store, GITHUB_KEYS.cursor(12)), undefined)
    assert.equal(source.status().lastError, null)
  })
})

test('404 是可重试：进重试表、这一拍报失败、游标不前进到那张单', async () => {
  await withStore(async (store) => {
    const { fetch } = fakeFetch(async (url) => {
      if (url.includes('/notifications')) return json([notification(13)])
      if (url.includes('/issues/13')) return json({ message: 'Not Found' }, { status: 404 })
      throw new Error(`unexpected ${url}`)
    })
    const { source, received } = makeSource(store, fetch, { observe: { issues: false, pulls: false, comments: false, ci: false } })
    await assert.rejects(source.tick(), /#13/)
    assert.equal(received.length, 0)
    assert.deepEqual(kv(store, GITHUB_KEYS.retries), {
      '13': { since: STARTED, pr: false, failedAt: STARTED, attempts: 1 },
    })
    assert.equal(kv(store, GITHUB_KEYS.cursor(13)), undefined)
    assert.equal(source.status().lastPollAt, STARTED)
    assert.match(source.status().lastError, /#13/)
  })
})

test('304 是静默返回：条件请求发出去了，但没有事件、状态也不变', async () => {
  await withStore(async (store) => {
    const since = '2026-09-09T12:00:00.000Z'
    seed(store, GITHUB_KEYS.stream('issues'), { since, started: { issues: since, pulls: since }, etag: 'W/"keep"' })
    const { calls, fetch } = fakeFetch(async (url) => {
      if (url.includes('/notifications')) return json([])
      if (url.includes('/issues?state=all')) return notModified()
      return json([])
    })
    const { source, received } = makeSource(store, fetch, { observe: { ci: false } })
    await source.tick()
    assert.equal(received.length, 0)
    const issues = along(calls, '/issues?state=all')
    assert.equal(issues.length, 1)
    assert.equal(issues[0].headers['if-none-match'], 'W/"keep"')
    assert.equal(kv(store, GITHUB_KEYS.stream('issues')).etag, 'W/"keep"')
    assert.equal(source.status().lastError, null)
  })
})

test('githubEngine 把两参的关闭通知补成核心要的三参，并保留关闭时刻', () => {
  const calls = []
  const port = githubEngine({
    receive: () => undefined,
    bindThread: () => undefined,
    threadClosed: (thread, outcome, at) => { calls.push([thread, outcome, at]) },
  }, () => LATER)
  const thread = { source: 'github', id: '7' }
  port.threadClosed(thread, 'merged', '2026-09-09T00:00:00Z')
  // 不知道确切时刻时补本模块的时钟，而不是把 undefined 递给核心。
  port.threadClosed(thread, 'closed')
  assert.deepEqual(calls, [[thread, 'merged', '2026-09-09T00:00:00Z'], [thread, 'closed', LATER]])
})

test('403 + locked 回 gone；403 不锁仍然可重试', async () => {
  const message = {
    id: 'out-1',
    channel: { source: 'github', thread: 'github:12', address: { number: '12' } },
    text: '收到',
    kind: 'reply',
  }
  const api = (status, text) => createGithubApi({
    token: 'token',
    repository: 'acme/widgets',
    fetch: async () => json({ message: text }, { status }),
  })
  assert.equal(await sendGithub(api(403, 'Issue is locked'), message, 'agent-bot'), 'gone')
  assert.equal(await sendGithub(api(410, 'Gone'), message, 'agent-bot'), 'gone')
  await assert.rejects(() => sendGithub(api(403, 'Forbidden'), message, 'agent-bot'), /Forbidden/)
  await assert.rejects(() => sendGithub(api(404, 'Not Found'), message, 'agent-bot'), /Not Found/)
  const error = new GithubError('x', 410)
  assert.equal(error.code, 410)
})

test('游标：两拍之间回退 5 秒，ETag 只在 since 未变时发送，自己发的事件跳过', async () => {
  await withStore(async (store) => {
    const { calls, fetch } = fakeFetch(async (url) => {
      if (url.includes('/notifications')) return json([])
      if (url.includes('/review-comments') || url.includes('/pulls/comments')) return json([])
      if (url.includes('/issues/comments')) {
        // 第一拍空列表；第二拍有一条别人的和一条自己发的；第三拍又空。
        const tick = along(calls, '/issues/comments').length
        if (tick === 2) return json([streamComment(1, 'alice', LATER), streamComment(2, 'agent-bot', LATER)])
        return json([])
      }
      return json([])
    })
    const { source, received, setClock } = makeSource(store, fetch, { observe: { issues: false, pulls: false, ci: false } })

    // 第一拍：游标从这一拍开始，列表为空；带 ETag 回来了就存下（因为游标没动）。
    await source.tick()
    const first = kv(store, GITHUB_KEYS.stream('comments'))
    assert.equal(first.since, STARTED)
    assert.deepEqual(first.started, { comments: STARTED })

    // 第二拍：只有别人那条成为事件，自己发的那条被跳过（`github.ts:227`）。
    setClock(LATER)
    await source.tick()
    assert.equal(received.length, 1)
    assert.equal(received[0].actor.id, 'alice')
    assert.equal(received[0].meta.kind, 'conversation')
    const second = kv(store, GITHUB_KEYS.stream('comments'))
    // 游标 = 最新条目的时间往前 5 秒（`poll.ts:16`）；游标动了，ETag 就不该再留着。
    assert.equal(second.since, cursorAt(LATER))
    assert.equal('etag' in second, false)

    // 第三拍：请求里的 since 就是上一拍写下的「最新 - 5 秒」，且不再带 If-None-Match。
    setClock(LATER_STILL)
    const from = calls.length
    await source.tick()
    const third = along(callsIn(calls, from), '/issues/comments')
    assert.equal(third.length, 1)
    assert.equal(new URL(third[0].url).searchParams.get('since'), cursorAt(LATER))
    assert.equal(third[0].headers['if-none-match'], undefined)
  })
})

test('14 天视野夹到整点：游标太旧时 since 取视野，且不发条件请求', async () => {
  await withStore(async (store) => {
    seed(store, GITHUB_KEYS.stream('comments'), {
      since: '2026-01-01T00:00:00.000Z',
      started: { comments: '2026-01-01T00:00:00.000Z' },
      etag: 'W/"old"',
    })
    const { calls, fetch } = fakeFetch(async (url) => {
      if (url.includes('/notifications')) return json([])
      if (url.includes('/issues/comments')) {
        return json([
          // 视野之外的旧评论：即使 returned 里带着也不该变成事件。
          streamComment(1, 'alice', '2026-08-01T00:00:00.000Z'),
          streamComment(2, 'alice', STARTED),
        ])
      }
      return json([])
    })
    // 12:34:56 这一拍：视野 = 14 天前向下取整到整点 = 08-27T12:00:00Z。
    const { source, received } = makeSource(store, fetch, {
      started: '2026-09-10T12:34:56.000Z',
      observe: { issues: false, pulls: false, ci: false },
    })
    await source.tick()
    const request = along(calls, '/issues/comments')[0]
    assert.equal(new URL(request.url).searchParams.get('since'), '2026-08-27T12:00:00.000Z')
    // 视野夹过之后 since 与存下的游标不同，条件请求必须撤掉（`github.ts:211`）。
    assert.equal(request.headers['if-none-match'], undefined)
    // 只收视野之内、且晚于本拍开始那一秒重叠窗口之后的那条：第二条在 STARTED，第一条在视野外。
    assert.deepEqual(received.map((trigger) => trigger.meta.commentId), [2])
  })
})
