/**
 * @pneuma/superagent 的执行环境变量包级测试：工单目录、变量声明按 owner 分组、停用来源只声明不取值、
 * 工单变量只在有工单时出现、写进 Session 说明的行格式。
 *
 * 为什么这些要单独钉：这些变量直接进 prepare 命令与 worker 的 Session 说明；`{占位符}` 式的
 * `DSH_SUPERAGENT_DIR` 若在没工单时也给个空串，命令里就会出现「cd 到空路径」；变量声明少一个，
 * 界面上的「这个环境注入什么」就少一行。所以每条都断言具体的键与值。
 *
 * 假的是「来源注册表」：只实现被测函数要用的 `environments()` / `declarations()` 两个读法，
 * 真实注册表的行为由 `source-registry.test.mjs` 管。不碰 `~/.dsc`、不连网。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/execution-environment
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, test } from 'node:test'

const { EXECUTOR_VARIABLES, executionRoot, declaredVariables, environmentOf, ticketEnvironment, environmentLines } =
  await import('../../../../lib/packages/superagent/app/execution-environment.js')
const { SettingsSchema } = await import('../../../../lib/packages/superagent/core/policy.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 造一份真设置：`executor.directory` 与禁用命令都由 schema 补齐。 */
function makeSettings(executor = {}) {
  return SettingsSchema.parse({ executor })
}

/** 一个来源 kind 的环境变量声明与取值。 */
function kindEnvironment() {
  return {
    variables: [{ key: 'GH_TOKEN', description: { zh: 'GitHub 令牌', en: 'GitHub token' } }],
    values: ({ deployment, config, trigger }) => ({ GH_TOKEN: `${deployment.repository}:${config.label}:${trigger?.id ?? 'none'}` }),
  }
}

/** 假注册表：`environments` 只回启用中的来源，`declarations` 连停用的也回（上游同义）。 */
function makeSources({ environments = [], declarations = [] } = {}) {
  const seen = []
  return {
    seen,
    environments: (settings) => { seen.push(settings); return environments },
    declarations: () => declarations,
  }
}

// ── 1. 执行目录 ────────────────────────────────────────────────────────────

test('executionRoot：配了就用配置的绝对路径，没配就落到 <stateDir>/work', () => {
  assert.equal(executionRoot(makeSettings({ directory: '/tickets' }), '/state'), '/tickets')
  assert.equal(executionRoot(makeSettings(), '/state'), join('/state', 'work'), '空 directory 的默认值就是 <stateDir>/work')
  passed += 1
})

// ── 2. 变量声明 ────────────────────────────────────────────────────────────

test('declaredVariables：执行器那组永远在，来源按 owner 分组，停用的 enabled=false', () => {
  const variables = kindEnvironment().variables
  const sources = makeSources({
    environments: [{ kind: { kind: 'github' }, environment: kindEnvironment(), config: { label: 'on' } }],
    declarations: [
      { kind: 'github', variables },
      { kind: 'feishu', variables: [{ key: 'FEISHU_CHAT', description: { zh: '群', en: 'Chat' } }] },
    ],
  })
  const settings = makeSettings()
  assert.deepEqual(declaredVariables(sources, settings), [
    { owner: 'executor', enabled: true, variables: EXECUTOR_VARIABLES },
    { owner: 'github', enabled: true, variables },
    { owner: 'feishu', enabled: false, variables: [{ key: 'FEISHU_CHAT', description: { zh: '群', en: 'Chat' } }] },
  ])
  assert.equal(sources.seen[0], settings, '注册表拿到的是同一份设置')
  passed += 1
})

test('EXECUTOR_VARIABLES：三个工单变量带 ticket 标记，禁用命令那一个不带', () => {
  assert.deepEqual(EXECUTOR_VARIABLES.map(variable => [variable.key, variable.ticket === true]), [
    ['DSH_SUPERAGENT_DIR', true],
    ['DSH_SUPERAGENT_NAME', true],
    ['DSH_SUPERAGENT_TICKET', true],
    ['DSH_SUPERAGENT_BLOCKED_COMMANDS', false],
  ])
  passed += 1
})

// ── 3. 变量取值 ────────────────────────────────────────────────────────────

test('environmentOf：没工单时只给禁用命令，来源的值带上 deployment/config/trigger', () => {
  const environment = kindEnvironment()
  const sources = makeSources({ environments: [{ kind: { kind: 'github' }, environment, config: { label: 'repo' } }] })
  const settings = makeSettings({ blockedCommands: ['rm', 'curl'] })
  const values = environmentOf({ deployment: { repository: 'owner/repo' }, sources, settings, trigger: { id: 'trg-1' } })
  assert.deepEqual(values.map(variable => [variable.key, variable.value, variable.owner]), [
    ['DSH_SUPERAGENT_BLOCKED_COMMANDS', 'rm curl', 'executor'],
    ['GH_TOKEN', 'owner/repo:repo:trg-1', 'github'],
  ])
  assert.equal(values[0].description.en, 'Commands blocked in this execution environment, separated by spaces; never run them')
  passed += 1
})

test('environmentOf：有工单时三个工单变量都出现，值来自工单', () => {
  const settings = makeSettings()
  const values = environmentOf({
    deployment: { repository: 'owner/repo' },
    sources: makeSources(),
    settings,
    ticket: { id: 't-9', name: 'fix-login', directory: '/state/work/fix-login' },
  })
  assert.deepEqual(values.map(variable => [variable.key, variable.value]), [
    ['DSH_SUPERAGENT_DIR', '/state/work/fix-login'],
    ['DSH_SUPERAGENT_NAME', 'fix-login'],
    ['DSH_SUPERAGENT_TICKET', 't-9'],
    ['DSH_SUPERAGENT_BLOCKED_COMMANDS', ''],
  ])
  passed += 1
})

test('ticketEnvironment：把工单的执行信息摊成 environmentOf 要的形状，缺执行信息给空串', () => {
  const settings = makeSettings()
  const fixed = ticketEnvironment({
    deployment: { repository: 'owner/repo' },
    sources: makeSources(),
    settings,
    ticket: { id: 't-1', execution: { name: 'fix-login', directory: '/state/work/fix-login' } },
  })
  assert.deepEqual(fixed.slice(0, 3).map(variable => variable.value), ['/state/work/fix-login', 'fix-login', 't-1'])
  const unfinished = ticketEnvironment({
    deployment: { repository: 'owner/repo' },
    sources: makeSources(),
    settings,
    ticket: { id: 't-2' },
  })
  assert.deepEqual(unfinished.map(variable => [variable.key, variable.value]), [
    ['DSH_SUPERAGENT_DIR', ''],
    ['DSH_SUPERAGENT_NAME', ''],
    ['DSH_SUPERAGENT_TICKET', 't-2'],
    ['DSH_SUPERAGENT_BLOCKED_COMMANDS', ''],
  ])
  passed += 1
})

// ── 4. Session 说明里的行格式 ──────────────────────────────────────────────

test('environmentLines：一行一个变量，值用 JSON 引号包住、描述取英文', () => {
  assert.equal(environmentLines([
    { key: 'DSH_SUPERAGENT_DIR', value: '/state/work/fix', description: { zh: '目录', en: 'The ticket directory' }, owner: 'executor' },
    { key: 'DSH_SUPERAGENT_TICKET', value: 't-1', description: { zh: '工单', en: 'The ticket id' }, owner: 'executor' },
  ]), '- DSH_SUPERAGENT_DIR = "/state/work/fix": The ticket directory.\n- DSH_SUPERAGENT_TICKET = "t-1": The ticket id.')
  assert.equal(environmentLines([]), '')
  passed += 1
})
