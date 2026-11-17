/**
 * @pneuma/superagent `app/role-models.js` 的包级测试：把设置里的角色模型种到新建会话上，
 * 不改全局默认；已经发过请求或已经选过模型的会话不被覆盖；保存设置时先校验路由。
 *
 * 转写自上游 `tests/role-models.spec.ts`。上游那 4 条依赖 DSH 的 agent / session / llm 服务，
 * 本仓是原生重写（见 `app/role-models.ts` 文件头的映射表），每条都在注释里标了对应关系：
 *
 * | 上游断言 | 本仓原生等价 | 本测试怎么落 |
 * | --- | --- | --- |
 * | `resolveCallConfig` 校验端点/模型 | `ctx.llm.routeTo(provider, model, effort)`（端点/模型不在表里抛错） | `ctx.llm` 用对象字面量，记录入参、可抛错 |
 * | 种进 `agent/request` waterfall，「只影响初始一次请求」 | `session.appendState('model', …)`：本仓模型本来就是按会话存的 | 假会话的 `state` / `appendState` |
 * | `agent.session.requestHeader()` 判「已发过请求」 | `session.messages.length > 0` | 假会话的 `messages` |
 * | `session.snapshotEvents()` 里的 `model/selection` | `session.state('model') !== undefined` | 同上 |
 * | `Agent` / `Session` | `Session`（本仓没有人格化 agent 这一层） | 假会话只实现这 4 个成员 |
 * | `sessionPersistence.flush()` | 本仓 `appendState` 同步追加日志，没有 flush | 上游 flush 断言无等价物，已跳过 |
 *
 * 上游第 1 条里「提示词变量 / 初始路由 / 后续组装」三件事，本仓分别落到：种进去的 `model`
 * 状态就是初始路由；重试同一回合时状态已存在（不覆盖）；手动换模型写的是更新的一条状态
 * （后选覆盖先选）。这三件分别在下面 1、5 两条里钉。
 *
 * 这里 import 的是 `lib/` 的构建产物，跑之前先 `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/role-models
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const { initializeRoleModel, resolveRoleModel } = await import('../../../../lib/packages/superagent/app/role-models.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 假会话：只实现 `initializeRoleModel` 读写的四个成员（`messages` / `state` / `appendState` / `meta`）。 */
function makeSession({ id = 'role-model', messages = [], state = {} } = {}) {
  const states = new Map(Object.entries(state))
  const session = {
    meta: { id },
    messages: [...messages],
    appended: [],
    states,
    state(key) {
      return states.get(key)
    },
    appendState(key, payload) {
      session.appended.push([key, payload])
      states.set(key, payload)
    },
  }
  return session
}

/** 假 LLM 路由服务：只实现 `routeTo`，记录每次入参；`route` 参数可让指定端点抛错。 */
function makeCtx({ route } = {}) {
  const calls = []
  return {
    calls,
    llm: {
      routeTo(provider, model, effort) {
        calls.push([provider, model, effort])
        return route === undefined ? { provider, model, effort } : route(provider, model, effort)
      },
    },
  }
}

// ── 1. 种入与不覆盖 ────────────────────────────────────────────────────────

test('新会话：把角色模型种成会话的 model 状态，不动全局默认（本仓原生等价：模型按会话存）', () => {
  // 上游第 1 条前半：提示词变量与初始路由都走角色模型、不保存宿主默认。
  // 本仓「初始路由」就是会话状态里的 model；不碰全局默认靠「只写这个会话」实现。
  const session = makeSession()
  initializeRoleModel(session, { provider: 'worker-provider', model: 'worker-model' })
  assert.deepEqual(session.state('model'), { provider: 'worker-provider', model: 'worker-model' })
  assert.deepEqual(session.appended, [['model', { provider: 'worker-provider', model: 'worker-model' }]], '只写这一条会话状态')
  assert.deepEqual(session.messages, [], '种模型不往会话里写消息')
  passed += 1
})

test('新会话：带 reasoningEffort 时映射成会话的 effort 字段（上游沿用原字段名）', () => {
  const session = makeSession()
  initializeRoleModel(session, { provider: 'worker', model: 'one', reasoningEffort: 'high' })
  assert.deepEqual(session.state('model'), { provider: 'worker', model: 'one', effort: 'high' })
  passed += 1
})

test('恢复的会话：已经有消息（上游 requestHeader 已落）就不再种', () => {
  // 上游 it.each 的 `header` 半边：会话恢复出来已有 request/header ⟹ 已发过请求。
  const session = makeSession({ messages: [{ role: 'user', content: [] }] })
  initializeRoleModel(session, { provider: 'worker', model: 'new' })
  assert.equal(session.state('model'), undefined)
  assert.deepEqual(session.appended, [])
  passed += 1
})

test('恢复的会话：已经选过模型（上游 model/selection）就保持原选择', () => {
  const existing = { provider: 'existing', model: 'keep' }
  const session = makeSession({ state: { model: existing } })
  initializeRoleModel(session, { provider: 'worker', model: 'new' })
  assert.deepEqual(session.state('model'), existing)
  assert.deepEqual(session.appended, [])
  passed += 1
})

test('模型为 null：什么都不种', () => {
  const session = makeSession()
  initializeRoleModel(session, null)
  assert.equal(session.state('model'), undefined)
  assert.deepEqual(session.appended, [])
  passed += 1
})

test('后选覆盖先选：手动换模型后重试同一回合，也不会被角色默认改回去', () => {
  // 上游第 2 条：later explicit selection win，且不影响「已经组装好的那一拍」。
  // 本仓每次请求都读会话状态里的最新一条；重试时 initializeRoleModel 看到状态已存在就跳过。
  const session = makeSession()
  initializeRoleModel(session, { provider: 'worker', model: 'one' })
  session.appendState('model', { provider: 'manual', model: 'two', effort: 'low' })
  initializeRoleModel(session, { provider: 'worker', model: 'one' })
  assert.deepEqual(session.state('model'), { provider: 'manual', model: 'two', effort: 'low' })
  passed += 1
})

// ── 2. 保存设置时的路由校验 ─────────────────────────────────────────────────

test('resolveRoleModel：过 routeTo 校验并原样返回选择，思考强度缺省按 default', () => {
  const ctx = makeCtx()
  assert.deepEqual(resolveRoleModel(ctx, { provider: 'worker', model: 'one' }), { provider: 'worker', model: 'one' })
  assert.deepEqual(ctx.calls, [['worker', 'one', 'default']], '不声明思考字段时传 default')
  assert.deepEqual(resolveRoleModel(ctx, { provider: 'worker', model: 'one', reasoningEffort: 'max' }), { provider: 'worker', model: 'one', reasoningEffort: 'max' })
  assert.deepEqual(ctx.calls[1], ['worker', 'one', 'max'])
  passed += 1
})

test('routeTo 抛错原样上抛，保存流程不会把坏模型种进会话（上游「先校验再记录」）', () => {
  // 上游第 4 条后半：unknown provider 在记录选择之前就失败。
  const ctx = makeCtx({ route: (provider) => { throw new Error(`unknown provider ${provider}`) } })
  const session = makeSession()
  let landed = false
  try {
    const selection = resolveRoleModel(ctx, { provider: 'unknown', model: 'x' })
    // settings.ts 的顺序是校验通过才落地（`app/settings.ts:191` → `sessions.ts:311`）。
    initializeRoleModel(session, selection)
    landed = true
  } catch (error) {
    assert.match(error.message, /unknown provider unknown/)
  }
  assert.equal(landed, false)
  assert.equal(session.state('model'), undefined)
  passed += 1
})

test('思考强度不在本仓档位里：抛错且不调 routeTo', () => {
  const ctx = makeCtx()
  assert.throws(
    () => resolveRoleModel(ctx, { provider: 'p', model: 'm', reasoningEffort: 'extreme' }),
    /Unknown reasoning effort "extreme"; use one of default, off, low, high, max/,
  )
  assert.deepEqual(ctx.calls, [], '档位先收口，坏值不往 provider 送')
  passed += 1
})

test('resolveRoleModel 不改调用方的配置对象（返回新选择）', () => {
  const ctx = makeCtx()
  const model = { provider: 'p', model: 'm', reasoningEffort: 'low' }
  const selection = resolveRoleModel(ctx, model)
  assert.notEqual(selection, model)
  assert.deepEqual(model, { provider: 'p', model: 'm', reasoningEffort: 'low' })
  assert.deepEqual(selection, { provider: 'p', model: 'm', reasoningEffort: 'low' })
  passed += 1
})
