/**
 * P7 三个主会话工具（settings_save / eval / eval_decide）与两个读取资源
 * （settings 的新结构、candidate:<id>）的包级测试：全用假端口，不建运行期、不碰磁盘。
 *
 * 钉的是「工具 / 资源与端口之间的那一层」：参数怎么映射成端口调用、读到的现场怎么拼、
 * 什么情况下明确拒绝。候选与设置的存储、真实工单流转归 `runtime.test.mjs` / `store.test.mjs`，
 * 这里一条都不重复。
 *
 * 十一组用例：
 *   1. settings_save 真 key + 字符串值：调端口、回「已保存 旧值 → 新值」、推快照；
 *   2. settings_save 不存在的 key / 值类型不对：拒绝，且端口一次都没被调；
 *   3. settings_save 端口返回失败原因：原样回给模型，且不推快照；
 *   4. read settings：fields 与 history 同时有；
 *   5. candidate:<id>：候选 / 触发那条 / 线程三块都在；查不到明确报错；
 *   6. candidate:<id> 线程超过 10 条：只回最新 10 条（旧 → 新）；
 *   7. superagent_eval：与 candidate 资源是同一份装配；
 *   8. eval_decide accept：调 acceptCandidate、回 ticket_id、title 透传；
 *   9. eval_decide ignore：调 ignoreCandidate 并带 reason；
 *   10. 候选收件箱没开：两个 eval 工具都拒，且一次 acceptCandidate 都没调；
 *   11. 三个新工具在 worker 会话里都拒、host() 为 null 都拒。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/eval-settings
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { createMainTools } = await import('../../../../lib/packages/superagent/main-tools.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

/** 记一条通过的断言；失败照常抛给 node:test。 */
function ok(value, message) {
  assert.ok(value, message)
  passed += 1
}

/** 严格相等。 */
function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  passed += 1
}

/** 深比较（对象 / 数组）。 */
function deepEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

/** 异步拒绝：工具都是 async 的，抛错会变成 rejected promise。 */
async function rejects(promise, pattern, message) {
  await assert.rejects(promise, pattern, message)
  passed += 1
}

/** 固定时钟：断言不依赖「跑得快慢」。 */
const AT = '2026-01-01T00:00:00.000Z'

/** 接单建出来的工单 id（32 位十六进制；与 `paths.ts` 的目录名校验同形）。 */
const TICKET_A = 'abcdef0123456789abcdef0123456789'

/** 主会话 id；工具只拿它问 `isWorkerSession`。 */
const MAIN_SESSION = 'session-main'

/** 一次工具调用的上下文（`ToolContext` 里工具真用到的几项）。 */
function ctxOf(sessionId) {
  return { cwd: '.', sessionId, sessionPath: '', signal: new AbortController().signal }
}

/** 假设置分区投影：三种值类型各一，够验「key 校验 + 类型校验 + 旧值 → 新值」。 */
const FIELDS = [
  { key: 'repoPath', label: '默认仓库路径', type: 'text', value: '/old/repo', help: 'worker 在这里开工作树' },
  { key: 'maxWorkers', label: '并发上限', type: 'number', value: 2 },
  { key: 'confirmInferred', label: '推断候选先等人确认', type: 'boolean', value: false },
]

/**
 * 一条候选现场：形状与运行期 `CandidateContextView` 一致。
 *
 * `thread` 按时间升序（旧 → 新）——工具层按「留最后 10 条」理解，顺序反了就会把最旧的
 * 十条当成最新的，所以这里显式按契约排。
 */
function candidateOf(overrides = {}) {
  return {
    id: 'candidate-1',
    triggerId: 'trg-1',
    state: 'pending',
    at: AT,
    title: '改登录页文案',
    reason: '明确 @ 了机器人，要求改代码',
    scope: '改登录页文案',
    source: 'github',
    trigger: { text: '帮我把登录页的报错改成中文', actor: 'alice', at: AT },
    thread: [
      { text: '第 1 条', actor: 'bob', at: AT },
      { text: '第 2 条', actor: 'alice', at: AT },
    ],
    ...overrides,
  }
}

/**
 * 一台记调用的假端口：只回答被测工具真会问的那几样。
 *
 * @param options.settings - settings() 的返回值，缺省 {@link FIELDS}
 * @param options.saveSetting - 覆盖保存：返回字符串 = 被拒原因
 * @param options.candidates - candidates() 的返回值，缺省 []
 * @param options.confirmingInferred - 候选收件箱开没开，缺省 true
 * @param options.acceptCandidate - 覆盖接单（返回 ticket_id 或抛错），缺省 TICKET_A
 * @param options.ignoreCandidate - 覆盖忽略
 * @param options.surface - 覆盖快照面（history 从它读）
 * @param options.worker - 这条会话 id 会被认成 worker
 */
function fakeHost(options = {}) {
  const calls = []
  // 分区当前值收在假端口里：save 成功后要能「读回新值」（工具回执里那条「旧值 → 新值」靠它）。
  const settings = (options.settings ?? FIELDS).map((field) => ({ ...field }))
  const host = {
    settings() {
      calls.push(['settings'])
      return settings
    },
    saveSetting(key, value) {
      calls.push(['saveSetting', key, value])
      if (options.saveSetting !== undefined) return options.saveSetting(key, value)
      // 与真分区一样：保存成功就改当前值；校验被拒时提前 return（见上面的覆盖分支）。
      const field = settings.find((item) => item.key === key)
      if (field !== undefined) field.value = value
      return undefined
    },
    candidates() {
      calls.push(['candidates'])
      return options.candidates ?? []
    },
    confirmingInferred() {
      return options.confirmingInferred ?? true
    },
    acceptCandidate(id, title) {
      calls.push(['acceptCandidate', id, title])
      if (options.acceptCandidate !== undefined) return options.acceptCandidate(id, title)
      return TICKET_A
    },
    ignoreCandidate(id, reason) {
      calls.push(['ignoreCandidate', id, reason])
      if (options.ignoreCandidate !== undefined) options.ignoreCandidate(id, reason)
    },
    snapshot() {
      return options.surface ?? {
        ready: true,
        counts: { needsYou: 0, running: 0, done: 0 },
        tickets: [],
        recent: [],
        settingsHistory: [],
      }
    },
    changed() {
      calls.push(['changed'])
    },
    isWorkerSession(sessionId) {
      return sessionId === options.worker
    },
  }
  return { host, calls }
}

/** 十二个工具 + 按名字查的索引。 */
function toolsOf(host) {
  const tools = createMainTools({ host: () => host })
  return { tools, byName: new Map(tools.map((tool) => [tool.name, tool])) }
}

/** 调一个工具（默认主会话）。 */
function run(byName, name, args, sessionId = MAIN_SESSION) {
  return byName.get(name).run(args, ctxOf(sessionId))
}

test('settings_save：真 key + 字符串值 → 调端口、回「已保存 旧值 → 新值」', async () => {
  const { host, calls } = fakeHost()
  const { byName } = toolsOf(host)
  const out = await run(byName, 'superagent_settings_save', { key: 'repoPath', value: '/new/repo' })
  ok(out.text.includes('已保存'), `成功要说「已保存」：${out.text}`)
  ok(out.text.includes('repoPath'), '回执里带 key')
  ok(out.text.includes('/old/repo') && out.text.includes('/new/repo'), `要说清旧值 → 新值：${out.text}`)
  deepEqual(
    calls.filter((call) => call[0] === 'saveSetting'),
    [['saveSetting', 'repoPath', '/new/repo']],
    '保存走端口（与设置面板同一个 save）',
  )
  ok(calls.some((call) => call[0] === 'changed'), '保存成功后推一次快照')
})

test('settings_save：不存在的 key / 值类型不对 → 拒绝，端口一次都没被调', async () => {
  const { host, calls } = fakeHost()
  const { byName } = toolsOf(host)
  await rejects(
    run(byName, 'superagent_settings_save', { key: 'noSuchKey', value: '/new/repo' }),
    /没有这一项设置/,
    '不存在的 key 要说「没有这一项设置」',
  )
  await rejects(
    run(byName, 'superagent_settings_save', { key: 'maxWorkers', value: '四' }),
    /数字设置/,
    'number 字段收到字符串要被拦下，不是悄悄落盘',
  )
  equal(calls.filter((call) => call[0] === 'saveSetting').length, 0, '被拒时一次 saveSetting 都不调')
  equal(calls.filter((call) => call[0] === 'changed').length, 0, '被拒时也不推快照')
})

test('settings_save：端口返回失败原因 → 原样回给模型，不推快照', async () => {
  const { host, calls } = fakeHost({ saveSetting: () => '仓库路径要写成 /x/y 这样' })
  const { byName } = toolsOf(host)
  const message = await run(byName, 'superagent_settings_save', { key: 'repoPath', value: '随便写' })
    .then(() => '', (error) => error.message)
  ok(message.includes('仓库路径要写成 /x/y 这样'), `分区给的原因要原样带回：${message}`)
  equal(calls.filter((call) => call[0] === 'changed').length, 0, '没保存成功就不推快照')
})

test('read settings：fields 与 history 同时有', async () => {
  const { host } = fakeHost({
    surface: {
      ready: true,
      counts: { needsYou: 0, running: 0, done: 0 },
      tickets: [],
      recent: [],
      settingsHistory: [{ version: 2, at: AT, key: 'repoPath', from: '/old/repo', to: '/new/repo' }],
    },
  })
  const { byName } = toolsOf(host)
  const body = JSON.parse((await run(byName, 'superagent_read', { resource: 'settings' })).text)
  equal(body.resource, 'settings')
  equal(body.fields.length, 3, '当前字段三项都在')
  equal(body.fields[0].key, 'repoPath')
  equal(body.fields[0].type, 'text')
  equal(body.fields[0].value, '/old/repo', '字段里带当前值，不是只有声明')
  equal(body.fields[0].help, 'worker 在这里开工作树', '说明一起给')
  equal(body.history.length, 1, '历史与字段同时返回')
  equal(body.history[0].key, 'repoPath')
  equal(body.history[0].to, '/new/repo')
})

test('candidate:<id>：候选 / 触发那条 / 线程三块都在；查不到明确报错', async () => {
  const { host } = fakeHost({ candidates: [candidateOf()] })
  const { byName } = toolsOf(host)
  const body = JSON.parse((await run(byName, 'superagent_read', { resource: 'candidate:candidate-1' })).text)
  equal(body.candidate.id, 'candidate-1')
  equal(body.candidate.title, '改登录页文案')
  equal(body.candidate.reason, '明确 @ 了机器人，要求改代码')
  equal(body.candidate.source, 'github')
  equal(body.trigger.text, '帮我把登录页的报错改成中文')
  equal(body.trigger.actor, 'alice')
  equal(body.trigger.at, AT)
  equal(body.thread.length, 2)
  deepEqual(body.thread[1], { text: '第 2 条', actor: 'alice', at: AT }, '线程消息原样给')
  await rejects(
    run(byName, 'superagent_read', { resource: 'candidate:nope' }),
    /没有这条候选/,
    '查不到要说「没有这条候选」',
  )
})

test('candidate:<id>：线程超过 10 条只回最新 10 条（旧 → 新）', async () => {
  const thread = Array.from({ length: 12 }, (_, index) => ({
    text: `第 ${String(index + 1)} 条`,
    actor: 'alice',
    at: AT,
  }))
  const { host } = fakeHost({ candidates: [candidateOf({ thread })] })
  const { byName } = toolsOf(host)
  const body = JSON.parse((await run(byName, 'superagent_read', { resource: 'candidate:candidate-1' })).text)
  equal(body.thread.length, 10, '最多 10 条')
  equal(body.thread[0].text, '第 3 条', '留下的应该是最新 10 条（前两条最旧的被切掉）')
  equal(body.thread[9].text, '第 12 条', '最后一条是最新那条')
})

test('superagent_eval：与 candidate:<id> 资源是同一份装配', async () => {
  const { host } = fakeHost({ candidates: [candidateOf()] })
  const { byName } = toolsOf(host)
  const viaResource = JSON.parse(
    (await run(byName, 'superagent_read', { resource: 'candidate:candidate-1' })).text,
  )
  const viaEval = JSON.parse((await run(byName, 'superagent_eval', { trigger_id: 'trg-1' })).text)
  deepEqual(viaEval, viaResource, '两处读到的现场必须逐字段一致')
})

test('eval_decide accept：调 acceptCandidate、回 ticket_id、title 透传', async () => {
  const { host, calls } = fakeHost({ candidates: [candidateOf()] })
  const { byName } = toolsOf(host)
  const body = JSON.parse(
    (await run(byName, 'superagent_eval_decide', {
      trigger_id: 'trg-1',
      decision: 'accept',
      title: '改登录页错误文案',
    })).text,
  )
  deepEqual(
    calls.filter((call) => call[0] === 'acceptCandidate'),
    [['acceptCandidate', 'candidate-1', '改登录页错误文案']],
    '按候选 id 接单，title 原样透传（与面板接单同一个口子）',
  )
  equal(body.ticket_id, TICKET_A, '返回建出来的工单 id')
  ok(calls.some((call) => call[0] === 'changed'), '接单改了库，推一次快照')
})

test('eval_decide ignore：调 ignoreCandidate 并带 reason', async () => {
  const { host, calls } = fakeHost({ candidates: [candidateOf()] })
  const { byName } = toolsOf(host)
  const out = await run(byName, 'superagent_eval_decide', {
    trigger_id: 'trg-1',
    decision: 'ignore',
    reason: '只是随口一说',
  })
  ok(out.text.includes('已忽略'), `ignore 要回「已忽略」：${out.text}`)
  deepEqual(
    calls.filter((call) => call[0] === 'ignoreCandidate'),
    [['ignoreCandidate', 'candidate-1', '只是随口一说']],
    'reason 原样透传',
  )
  ok(calls.some((call) => call[0] === 'changed'), '忽略改了库，推一次快照')
  await rejects(
    run(byName, 'superagent_eval_decide', { trigger_id: 'trg-1', decision: 'maybe' }),
    /decision 只能是/,
    'decision 只认 accept / ignore',
  )
})

test('候选收件箱没开：两个 eval 工具都明确拒绝', async () => {
  const { host, calls } = fakeHost({ candidates: [candidateOf()], confirmingInferred: false })
  const { byName } = toolsOf(host)
  await rejects(run(byName, 'superagent_eval', { trigger_id: 'trg-1' }), /候选收件箱没开/, 'eval 要拒')
  await rejects(
    run(byName, 'superagent_eval_decide', { trigger_id: 'trg-1', decision: 'accept' }),
    /候选收件箱没开/,
    'eval_decide 也要拒，不能静默',
  )
  equal(calls.filter((call) => call[0] === 'acceptCandidate').length, 0, '关着时一次接单都不许发生')
})

test('三个新工具在 worker 会话里都拒、host() 为 null 都拒', async () => {
  const { host } = fakeHost({ worker: 'session-worker', candidates: [candidateOf()] })
  const { byName } = toolsOf(host)
  const calls = [
    ['superagent_settings_save', { key: 'repoPath', value: '/new/repo' }],
    ['superagent_eval', { trigger_id: 'trg-1' }],
    ['superagent_eval_decide', { trigger_id: 'trg-1', decision: 'accept' }],
  ]
  for (const [name, args] of calls) {
    await rejects(run(byName, name, args, 'session-worker'), /只在主会话里可用/, `${name} 在 worker 会话里要拒`)
  }

  const none = createMainTools({ host: () => null })
  const noneByName = new Map(none.map((tool) => [tool.name, tool]))
  for (const [name, args] of calls) {
    await rejects(run(noneByName, name, args), /还没启动/, `${name} 在运行期没起来时要给一句人话`)
  }
})
