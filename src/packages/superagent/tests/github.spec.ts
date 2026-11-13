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
 * 迁移说明：原文件 import `lib/` 构建产物；现在直接 import 源码，不再要求先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/github
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import type { GithubObserve } from '../adapters/github/source.js'
import type { GithubComment } from '../adapters/github/trigger.js'
import type { OutboundMessage } from '../core/ports.js'
import type { DscStore } from '../adapters/store.js'

// 必须在 import 源码之前把 DSC_HOME 指到临时目录，否则会读走开发者真实的 ~/.dsc。
const home = mkdtempSync(join(tmpdir(), 'superagent-github-home-'))
const previousHome = process.env['DSC_HOME']
process.env['DSC_HOME'] = home

const { openStore } = await import('../adapters/store.js')
const { createGithubApi, GithubError } = await import('../adapters/github/api.js')
const { GITHUB_KEYS } = await import('../adapters/github/state.js')
const {
  branchCiTrigger, ciTrigger, commentTrigger, githubAddress, IssueSchema, CommentSchema, issueTrigger, pullTrigger,
} = await import('../adapters/github/trigger.js')
const { pullChecks, readGithub } = await import('../adapters/github/read.js')
const { sendGithub } = await import('../adapters/github/channel.js')
const { createGithubSource, githubEngine } = await import('../adapters/github/source.js')
const { cursorAt } = await import('../adapters/github/poll.js')

/** 固定时钟：断言不依赖「跑得多快」。 */
const STARTED = '2026-09-10T00:00:00.000Z'
const LATER = '2026-09-10T00:01:00.000Z'
const LATER_STILL = '2026-09-10T00:02:00.000Z'

const roots: string[] = []

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env['DSC_HOME']
  else process.env['DSC_HOME'] = previousHome
})

/** 一个用例一份临时根目录与一个库；用完关库、留目录给 afterAll 清。 */
async function withStore<T>(work: (store: DscStore) => Promise<T>): Promise<T> {
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
function kv(store: DscStore, key: string): unknown {
  const row = store.handle.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined
  return row?.value === undefined ? undefined : (JSON.parse(row.value) as unknown)
}

/** 直接写 kv 里的一条，用来造「上一拍留下的状态」。 */
function seed(store: DscStore, key: string, value: unknown): void {
  store.handle.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

/** 一个 JSON 响应。 */
function json(body: unknown, options: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: options.headers ?? {},
  })
}

/** 304 不能带 body，`new Response(string, { status: 304 })` 会直接抛。 */
function notModified(): Response {
  return new Response(null, { status: 304 })
}

/** 一次假 fetch 的记录。 */
interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body: RequestInit['body']
}

/** 假 fetch 的路由函数。 */
type Route = (url: string, init: RequestInit) => Response | Promise<Response>

/** 假 fetch：记下每次请求，交给用例自己的路由函数。 */
function fakeFetch(route: Route): { calls: FetchCall[]; fetch: typeof globalThis.fetch } {
  const calls: FetchCall[] = []
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    })
    return route(url, init)
  }
  return { calls, fetch }
}

/** 只取这次 tick 发出的请求。 */
function callsIn(calls: readonly FetchCall[], from: number): FetchCall[] {
  return calls.slice(from)
}

/** 按路径片段挑请求。 */
function along(calls: readonly FetchCall[], part: string): FetchCall[] {
  return calls.filter((call) => call.url.includes(part))
}

/** 来源实例的探针。 */
interface SourceProbe {
  source: ReturnType<typeof import('../adapters/github/source.js').createGithubSource>
  received: import('../core/model.js').Trigger[]
  closed: Array<{ thread: unknown; reason: string | undefined }>
  setClock(value: string): void
}

/** `makeSource` 的可选项。 */
interface SourceFixtureOptions {
  started?: string
  observe?: GithubObserve
}

/**
 * 造一个来源实例。
 *
 * `clock` 可变：游标语义全靠两拍之间的时间差，不能用一个固定时钟。
 * 引擎是假的，只记「谁在什么时候被叫」；真正的核心不在这里跑。
 */
function makeSource(store: DscStore, fetch: typeof globalThis.fetch, options: SourceFixtureOptions = {}): SourceProbe {
  const received: import('../core/model.js').Trigger[] = []
  const closed: Array<{ thread: unknown; reason: string | undefined }> = []
  let clock = options.started ?? STARTED
  const source = createGithubSource({
    api: createGithubApi({ token: 'token', repository: 'acme/widgets', fetch }),
    repository: 'acme/widgets',
    login: 'agent-bot',
    engine: {
      receive(trigger) {
        received.push(trigger)
        return 'stored'
      },
      bindThread() {
        return undefined
      },
      threadClosed(thread, reason) {
        closed.push({ thread, reason })
        return undefined
      },
    },
    store: { handle: store.handle },
    now: () => clock,
    log: () => {},
    observe: options.observe,
  })
  return {
    source,
    received,
    closed,
    setClock(value) {
      clock = value
    },
  }
}

/** 一条通知；`subject.url` 是 Issue 或 PR 的 API 地址，与 GitHub 一致。 */
function notification(number: number, pr = false): Record<string, unknown> {
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
function streamComment(id: number, login: string, updatedAt: string, number = 12): Record<string, unknown> {
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
  expect(issueTrigger(issue, 'agent-bot')).toStrictEqual({
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
  } as unknown as Parameters<typeof pullTrigger>[0], 'agent-bot')
  expect(pull.id).toBe('6618ff4acad5e9586f4bba62b50b259c')
  expect(pull.meta).toStrictEqual({ number: 7, isPr: true, prAuthor: 'alice', kind: 'pull' })
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
  expect(
    commentTrigger(comment, { number: 7, isPr: true, prAuthor: 'agent-bot' }, 'inline', 'agent-bot', () => STARTED),
  ).toStrictEqual({
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
  })
})

test('review 结论没有正文也要进 text，且不把评论地址当线程地址', () => {
  const review = CommentSchema.parse({
    id: 8, user: { login: 'carol', type: 'User' }, submitted_at: '2026-09-01T00:00:00Z', state: 'APPROVED', commit_id: 'abc123',
  })
  const trigger = commentTrigger(review, { number: 7, isPr: true }, 'review', 'agent-bot', () => STARTED)
  expect(trigger.text).toBe('APPROVED review of commit abc123')
  expect(trigger.id).toBe('a4274d7777504eb0913fb874a970e7bb')
  expect(trigger.at).toBe('2026-09-01T00:00:00Z')
  expect(trigger.human).toBe(true)
  expect(trigger.meta).toStrictEqual({ number: 7, isPr: true, commentId: 8, kind: 'review' })
  expect(trigger.channel).toStrictEqual({ source: 'github', thread: 'github:7', address: { number: '7' } })
  expect('addressed' in trigger).toBe(false)
  expect('url' in trigger).toBe(false)
  // `COMMENTED` 且没有正文的 review 什么都带不出来，调用方据此跳过（`github-trigger.ts:55`）。
  expect(
    commentTrigger({ ...review, state: 'COMMENTED', body: null }, { number: 7, isPr: true }, 'review', 'agent-bot').text,
  ).toBe('')
})

test('human 与 addressed：机器人、自己发的、邮箱里的 @ 都不算', () => {
  const clock = (): string => STARTED
  const comment = (fields: Record<string, unknown>): GithubComment => CommentSchema.parse({
    id: 1,
    user: { login: 'alice', type: 'User' },
    html_url: 'https://github.com/acme/widgets/pull/7#discussion_r1',
    updated_at: '2026-09-01T00:00:00Z',
    ...fields,
  })
  const at = { number: 7, isPr: true }
  expect(commentTrigger(comment({ body: '@Agent-Bot please fix' }), at, 'conversation', 'agent-bot', clock).addressed).toBe('mention')
  expect('addressed' in commentTrigger(comment({ body: 'mail@agent-bot.example' }), at, 'conversation', 'agent-bot', clock)).toBe(false)
  expect('addressed' in commentTrigger(comment({ body: 'hi @agent-bot2' }), at, 'conversation', 'agent-bot', clock)).toBe(false)
  expect(commentTrigger(comment({ body: 'pushed', user: { login: 'Agent-Bot', type: 'User' } }), at, 'conversation', 'agent-bot', clock).human).toBe(false)
  expect(commentTrigger(comment({ body: 'x', user: { login: 'review-bot', type: 'User' } }), at, 'conversation', 'agent-bot', clock).human).toBe(true)
  expect(commentTrigger(comment({ body: 'x', user: { login: 'ci[bot]', type: 'Bot' } }), at, 'conversation', 'agent-bot', clock).human).toBe(false)
  // 已注销的账号 GitHub 返回 null，展示名是 ghost（`github-trigger.ts:19-21`）。
  expect(commentTrigger(comment({ body: 'x', user: null }), at, 'conversation', 'agent-bot', clock).actor.id).toBe('ghost')
})

test('CI 两种事件：默认分支没有回话地址，PR 的 CI 挂在 PR 线程上', () => {
  const now = (): string => STARTED
  const branchText = 'CI failed 1/2 on main at abc1234\nRead github/commits/abc1234/checks for every check.'
  expect(
    branchCiTrigger('main', 'abc1234', 2, branchText, 'https://github.com/acme/widgets/commit/abc1234', now),
  ).toStrictEqual({
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
  expect(
    ciTrigger({ number: 7, html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'agent-bot' } }, 1, prText, now),
  ).toStrictEqual({
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
  })
})

test('githubAddress 只认本仓库的 Issue / PR / review 讨论地址', () => {
  expect(githubAddress('https://api.github.com/repos/acme/widgets/pulls/9', 'acme/widgets')).toStrictEqual({ number: 9, pr: true })
  expect(githubAddress('https://api.github.com/repos/Acme/Widgets/issues/12', 'acme/widgets')).toStrictEqual({ number: 12, pr: false })
  expect(githubAddress('https://github.com/acme/widgets/pull/7/#discussion_r5', 'acme/widgets')).toStrictEqual({
    number: 7, pr: true, discussion: 5,
  })
  expect(githubAddress('https://github.com/acme/widgets/issues/7#issuecomment-3', 'acme/widgets')).toStrictEqual({ number: 7, pr: false })
  for (const url of [
    'https://github.com/acme/gadgets/pull/7',
    'https://api.github.com/repos/acme/widgets/commits/abc',
    'https://github.com/acme/widgets/pull/7/files',
    '',
  ]) {
    expect(githubAddress(url, 'acme/widgets')).toBeUndefined()
  }
})

/** GitHub REST 的一条行内 review 评论（照上游 `github-read.spec.ts:39-45` 的假数据）。 */
function reviewComment(id: number, reply?: number): Record<string, unknown> {
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
    ...(reply === undefined ? {} : { in_reply_to_id: reply }),
  }
}

/** 读话题 / 评论页面的返回形状（本文件读到的字段）。 */
interface ReadMessages {
  messages: Array<{ id: string; from?: string; text?: string; reply_to?: string; bot?: boolean }>
  next_resource?: string
}

test('review 评论：作者、时间、正文、在回谁、文件与行号都对，满 20 条给下一页', async () => {
  const api = (route: Route): ReturnType<typeof createGithubApi> =>
    createGithubApi({ token: 'token', repository: 'acme/widgets', fetch: fakeFetch(route).fetch })
  const page = (await readGithub(api(async () => json([reviewComment(1), reviewComment(2, 1)])), 'github/pulls/9/comments/1')) as ReadMessages
  expect(page).toStrictEqual({
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
  const thread = (await readGithub(threadApi, 'github/pulls/9/thread/2')) as ReadMessages
  expect(thread.messages.map((message) => [message.id, message.reply_to])).toStrictEqual([['1', undefined], ['2', '1']])
  expect(thread.messages[0].text).toBe(
    'src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\ncomment 1',
  )
  const many = Array.from({ length: 20 }, (_, index) => reviewComment((index % 8) + 1))
  const calls: string[] = []
  const apiMany = createGithubApi({
    token: 'token',
    repository: 'acme/widgets',
    fetch: async (url) => {
      calls.push(String(url))
      return json(many)
    },
  })
  const next = (await readGithub(apiMany, 'github/pulls/9/comments/1')) as ReadMessages
  expect(next.next_resource).toBe('github/pulls/9/comments/2')
  expect(next.messages.length).toBe(20)
  expect(calls[0]).toMatch(/pulls\/9\/comments\?per_page=20&page=1$/)
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
  expect(snapshot.checks.map((check) => check.name)).toStrictEqual(['a', 'z'])
  expect(snapshot.statuses).toStrictEqual([{ context: 'build', state: 'success' }])
  expect(along(calls, '/check-runs').length).toBe(2)
  expect(along(calls, 'page=2')[0].url).toMatch(/repositories\/1\/commits\/abc\/check-runs/)
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
    expect(received.length).toBe(0)
    expect(kv(store, GITHUB_KEYS.retries)).toStrictEqual({})
    expect(kv(store, GITHUB_KEYS.since)).toBe(cursorAt(STARTED))
    expect(kv(store, GITHUB_KEYS.cursor(12))).toBeUndefined()
    expect(source.status().lastError).toBeNull()
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
    await expect(source.tick()).rejects.toThrow(/#13/)
    expect(received.length).toBe(0)
    expect(kv(store, GITHUB_KEYS.retries)).toStrictEqual({
      '13': { since: STARTED, pr: false, failedAt: STARTED, attempts: 1 },
    })
    expect(kv(store, GITHUB_KEYS.cursor(13))).toBeUndefined()
    expect(source.status().lastPollAt).toBe(STARTED)
    expect(source.status().lastError ?? '').toMatch(/#13/)
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
    expect(received.length).toBe(0)
    const issues = along(calls, '/issues?state=all')
    expect(issues.length).toBe(1)
    expect(issues[0].headers['if-none-match']).toBe('W/"keep"')
    expect((kv(store, GITHUB_KEYS.stream('issues')) as { etag?: string }).etag).toBe('W/"keep"')
    expect(source.status().lastError).toBeNull()
  })
})

test('githubEngine 把两参的关闭通知补成核心要的三参，并保留关闭时刻', () => {
  const calls: Array<[unknown, string, string]> = []
  const port = githubEngine({
    receive: () => undefined,
    bindThread: () => undefined,
    threadClosed: (thread, outcome, at) => {
      calls.push([thread, outcome, at])
    },
  }, () => LATER)
  const thread = { source: 'github', id: '7' }
  port.threadClosed(thread, 'merged', '2026-09-09T00:00:00Z')
  // 不知道确切时刻时补本模块的时钟，而不是把 undefined 递给核心。
  port.threadClosed(thread, 'closed')
  expect(calls).toStrictEqual([[thread, 'merged', '2026-09-09T00:00:00Z'], [thread, 'closed', LATER]])
})

test('403 + locked 回 gone；403 不锁仍然可重试', async () => {
  const message: OutboundMessage = {
    id: 'out-1',
    channel: { source: 'github', thread: 'github:12', address: { number: '12' } },
    text: '收到',
    kind: 'reply',
  }
  const api = (status: number, text: string): ReturnType<typeof createGithubApi> => createGithubApi({
    token: 'token',
    repository: 'acme/widgets',
    fetch: async () => json({ message: text }, { status }),
  })
  expect(await sendGithub(api(403, 'Issue is locked'), message, 'agent-bot')).toBe('gone')
  expect(await sendGithub(api(410, 'Gone'), message, 'agent-bot')).toBe('gone')
  await expect(sendGithub(api(403, 'Forbidden'), message, 'agent-bot')).rejects.toThrow(/Forbidden/)
  await expect(sendGithub(api(404, 'Not Found'), message, 'agent-bot')).rejects.toThrow(/Not Found/)
  const error = new GithubError('x', 410)
  expect(error.code).toBe(410)
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
    const first = kv(store, GITHUB_KEYS.stream('comments')) as { since?: string; started?: Record<string, string> }
    expect(first.since).toBe(STARTED)
    expect(first.started).toStrictEqual({ comments: STARTED })

    // 第二拍：只有别人那条成为事件，自己发的那条被跳过（`github.ts:227`）。
    setClock(LATER)
    await source.tick()
    expect(received.length).toBe(1)
    expect(received[0].actor.id).toBe('alice')
    expect(received[0].meta['kind']).toBe('conversation')
    const second = kv(store, GITHUB_KEYS.stream('comments')) as { since?: string; etag?: string }
    // 游标 = 最新条目的时间往前 5 秒（`poll.ts:16`）；游标动了，ETag 就不该再留着。
    expect(second.since).toBe(cursorAt(LATER))
    expect('etag' in second).toBe(false)

    // 第三拍：请求里的 since 就是上一拍写下的「最新 - 5 秒」，且不再带 If-None-Match。
    setClock(LATER_STILL)
    const from = calls.length
    await source.tick()
    const third = along(callsIn(calls, from), '/issues/comments')
    expect(third.length).toBe(1)
    expect(new URL(third[0].url).searchParams.get('since')).toBe(cursorAt(LATER))
    expect(third[0].headers['if-none-match']).toBeUndefined()
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
    expect(new URL(request.url).searchParams.get('since')).toBe('2026-08-27T12:00:00.000Z')
    // 视野夹过之后 since 与存下的游标不同，条件请求必须撤掉（`github.ts:211`）。
    expect(request.headers['if-none-match']).toBeUndefined()
    // 只收视野之内、且晚于本拍开始那一秒重叠窗口之后的那条：第二条在 STARTED，第一条在视野外。
    expect(received.map((trigger) => trigger.meta['commentId'])).toStrictEqual([2])
  })
})
