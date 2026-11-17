/**
 * @pneuma/superagent 的启动错误包级测试：问题表结构、`{占位符}` 填充、`place` 与 `problem` 的形状。
 *
 * 为什么这些要单独钉：`SetupError` 是部署检查失败时唯一给操作员看的东西。文案里的占位符漏填，
 * 面板上就是一句带 `{app}` 的半截话；`place` 错了，面板会把「去 GitHub 设置区修」指成飞书；
 * `problem` 少字段，管理接口就返回不了可本地化的错误码。所以每条都断言具体文案与结构。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/setup
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { SETUP_PROBLEMS, SetupError } = await import('../../../../lib/packages/superagent/setup.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 合法的设置区名字（面板按这个决定去哪修）。 */
const PLACES = ['deployment', 'github', 'feishu']

test('问题表：每个 code 都是「[设置区, 英文模板]」，设置区只有三种', () => {
  const codes = Object.keys(SETUP_PROBLEMS).sort()
  assert.deepEqual(codes, [
    'agentCliMissing', 'agentCliNoAccount', 'agentCliSignedOut', 'agentCliUnset',
    'environmentFailed', 'feishuBotNotReady', 'feishuCliFailed', 'feishuNoApp',
    'feishuNoBot', 'feishuUserIdentity', 'foreignFile', 'gitTooOld',
    'repositoryReadOnly', 'repositoryUnreadable', 'repositoryUnreported', 'repositoryUnset',
  ], '上游这张表一共 16 个 code')
  for (const code of codes) {
    const [place, text] = SETUP_PROBLEMS[code]
    assert.equal(PLACES.includes(place), true, `${code} 的设置区必须是 ${PLACES.join('/')} 之一，实际 ${place}`)
    assert.equal(typeof text, 'string')
    assert.notEqual(text.trim(), '', `${code} 的文案不能为空`)
  }
  passed += 1
})

test('SetupError：没占位符的 code，文案、place、code、values 全对齐', () => {
  const error = new SetupError('repositoryUnset')
  assert.equal(error.message, 'The GitHub Source names no repository.')
  assert.equal(error.place, 'github')
  assert.equal(error.code, 'repositoryUnset')
  assert.deepEqual(error.values, {})
  assert.deepEqual(error.problem, {
    place: 'github',
    code: 'repositoryUnset',
    values: {},
    detail: 'The GitHub Source names no repository.',
  })
  passed += 1
})

test('SetupError：`{占位符}` 按 values 填满，problem 里保留原始 values', () => {
  const error = new SetupError('repositoryUnreadable', { account: 'alice', repository: 'owner/repo' })
  assert.equal(error.message, '@alice cannot read owner/repo.')
  assert.deepEqual(error.values, { account: 'alice', repository: 'owner/repo' })
  assert.equal(error.place, 'github')
  assert.deepEqual(error.problem.values, { account: 'alice', repository: 'owner/repo' }, '界面要拿原始 values 自己翻译')
  assert.equal(error.problem.detail, error.message)
  passed += 1
})

test('SetupError：同一句模板里的两个占位符都填，place 跟模板走', () => {
  const error = new SetupError('feishuBotNotReady', { app: 'cli_abc', status: 'pending' })
  assert.equal(error.message, 'The bot identity of app cli_abc is pending; configure the app secret with lark-cli.')
  assert.equal(error.place, 'feishu')
  passed += 1
})

test('SetupError：values.output 附在文案下一行，不顶替原文案', () => {
  const error = new SetupError('agentCliMissing', { output: 'spawn gh ENOENT' })
  assert.equal(error.message, 'The agent GitHub CLI was not found.\nspawn gh ENOENT')
  assert.equal(error.place, 'github')
  assert.equal(error.problem.detail, 'The agent GitHub CLI was not found.\nspawn gh ENOENT')
  passed += 1
})

test('SetupError：是 Error，message 与 problem.detail 永远是同一句', () => {
  const error = new SetupError('gitTooOld')
  assert.equal(error instanceof Error, true)
  assert.equal(error.place, 'deployment')
  assert.equal(error.message, 'git does not read the github.com credential configuration dsh-superagent writes; dsh-superagent needs git 2.32 or later.')
  assert.equal(error.problem.code, 'gitTooOld')
  assert.equal(error.problem.place, 'deployment')
  passed += 1
})
