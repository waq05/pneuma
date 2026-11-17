/**
 * @pneuma/superagent GitHub 只读读取器的包级测试：评论页 / review 线程 / Issue 与 PR 描述 / CI 快照。
 *
 * 上游 `tests/github-read.spec.ts` 的七条用例逐条转写。被钉住的都是「模型看到的形状」：
 * 评论页的下一页引用、越界路径在发请求之前就被拒、CI 状态按 context 取最新、
 * review 线程从任意一条评论都能读回根评论并带文件行号。判错不会报错，只会把 GitHub 的
 * 原始记录原样喂给模型，所以这里逐字段对形状。
 *
 * 假的只有 `Commands`（`fixtures-commands.mjs` 的对象字面量，按调用次序喂数据）：
 * `api` / `pages` 返回什么就断言什么，不跑 gh。被测模块跑的是 `lib/` 构建产物，
 * 跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/github-read
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { fakeCommands, queued } from './fixtures-commands.mjs'

const { pullChecks, readGithub } = await import('../../../../lib/packages/superagent/sources/github-read.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/**
 * 一条假的 GitHub REST review comment：文件 `src/render.ts` 第 43 行、带 3 行 diff 尾巴；
 * `reply` 传了就带 `in_reply_to_id`，用来测线程归并。`id === 2` 固定是机器人账号。
 */
const reviewComment = (id, reply) => ({
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
  user: { login: id === 2 ? 'review-bot[bot]' : 'carol', id: 5, type: id === 2 ? 'Bot' : 'User', avatar_url: 'https://avatars/5', html_url: 'https://github.com/carol' },
  body: `comment ${id}`,
  created_at: `2026-09-09T00:00:0${id}Z`,
  updated_at: `2026-09-09T00:00:0${id}Z`,
  html_url: `https://github.com/acme/widgets/pull/9#discussion_r${id}`,
  author_association: 'MEMBER',
  reactions: { total_count: 0 },
  _links: { self: { href: 'x' } },
  ...reply ? { in_reply_to_id: reply } : {},
})

test('读一页有界评论并给出下一页引用', async () => {
  const commands = fakeCommands({ api: queued(Array.from({ length: 20 }, (_, id) => ({ id, body: 'comment' }))) })
  assert.partialDeepStrictEqual(await readGithub(commands, 'github/issues/123/comments/2'),
    { next_resource: 'github/issues/123/comments/3' })
  assert.deepEqual(commands.calls.api, [['repos/acme/widgets/issues/123/comments?per_page=20&page=2']],
    '要按 page 参数请求仓库内的评论页，且只发一次请求')
  passed += 1
})

test('拒绝不支持的路径与越界路径，且一个请求都不发', async () => {
  const commands = fakeCommands({ api: () => { throw new Error('越界路径不该走到发请求') } })
  for (const resource of ['github/../outside', 'github/issues/1/reviews', 'github/pulls/1/checks/2', 'github/issues/1?repo=other']) {
    await assert.rejects(readGithub(commands, resource))
  }
  assert.equal(commands.calls.api.length, 0, '校验失败要在 api 之前抛，不能先把请求发出去')
  passed += 1
})

test('跨页读 CI 检查，并按 context 归一化最新状态', async () => {
  const commands = fakeCommands({
    api: queued([
      { check_runs: [{ name: 'z', status: 'completed', conclusion: 'success' }] },
      { check_runs: [{ name: 'a', status: 'in_progress', conclusion: null }] },
    ]),
    pages: queued([{ context: 'build', state: 'success' }, { context: 'build', state: 'failure' }]),
  })
  const result = await pullChecks(commands, 'abc')
  assert.deepEqual(result.checks.map((check) => check.name), ['a', 'z'], 'check 按名字稳定排序')
  assert.deepEqual(result.statuses, [{ context: 'build', state: 'success' }],
    '同名 context 只留最新一条（响应里先出现的那个）')
  passed += 1
})

test('按需读任意 PR 的 CI，不限制作者', async () => {
  const commands = fakeCommands({
    api: queued(
      { head: { sha: 'abc' }, user: { login: 'another-author' } },
      [{ check_runs: [] }],
    ),
    pages: queued([]),
  })
  assert.deepEqual(await readGithub(commands, 'github/pulls/123/checks'), { head: 'abc', checks: [], statuses: [] })
  assert.equal(commands.calls.api.length, 2, '一次取 PR 的 head sha，一次取该 sha 的 check-runs')
  passed += 1
})

test('把一页 review comment 读成消息：id、作者、时间、正文、回答的评论、文件与行号', async () => {
  const commands = fakeCommands({ api: queued([reviewComment(1), reviewComment(2, 1)]) })
  assert.deepEqual(await readGithub(commands, 'github/pulls/9/comments/1'), {
    messages: [
      { id: '1', from: 'carol', at: '2026-09-09T00:00:01Z', text: 'comment 1', url: 'https://github.com/acme/widgets/pull/9#discussion_r1',
        path: 'src/render.ts', line: 43 },
      { id: '2', from: 'review-bot[bot]', at: '2026-09-09T00:00:02Z', text: 'comment 2', bot: true, reply_to: '1',
        url: 'https://github.com/acme/widgets/pull/9#discussion_r2', path: 'src/render.ts', line: 43 },
    ],
  })
  passed += 1
})

test('从任意一条评论读 review 线程，第一条带文件、行号与 diff 行', async () => {
  const rows = [reviewComment(3), reviewComment(2, 1), reviewComment(1), reviewComment(4, 3)]
  const commands = fakeCommands({
    pages: queued(rows.map((item) => ({ ...item, user: { login: item.user.login, type: item.user.type } }))),
  })
  const thread = await readGithub(commands, 'github/pulls/9/thread/2')
  assert.deepEqual(thread.messages.map((message) => [message.id, message.reply_to]), [['1', undefined], ['2', '1']],
    '从回复 2 出发要找到根评论 1，线程只含这一对，且按时间升序')
  assert.equal(thread.messages[0].text,
    'src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\ncomment 1',
    '根评论的正文前要带文件:行号与 diff 最后三行')
  await assert.rejects(readGithub(commands, 'github/issues/9/thread/2'), /require a pull request/,
    'Issue 没有 review 线程，要在请求前拒绝')
  passed += 1
})

test('把 Issue / PR 读成作者、时间、标题、状态、描述与 PR 分支', async () => {
  const commands = fakeCommands({
    api: queued({
      number: 9, id: 1, title: 'Fix the margin', state: 'open', body: 'Details', draft: true,
      user: { login: 'carol', type: 'User' }, created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/widgets/pull/9',
      head: { ref: 'agent/fix', sha: 'abc', repo: {} }, base: { ref: 'main' }, labels: [{ name: 'ui', color: 'fff' }], node_id: 'x', _links: {},
    }),
  })
  assert.deepEqual(await readGithub(commands, 'github/pulls/9'), {
    number: 9, title: 'Fix the margin', state: 'open', draft: true, head: 'agent/fix',
    base: 'main', labels: ['ui'], id: '9', from: 'carol', at: '2026-09-09T00:00:00Z', text: 'Details',
    url: 'https://github.com/acme/widgets/pull/9',
  })
  passed += 1
})
