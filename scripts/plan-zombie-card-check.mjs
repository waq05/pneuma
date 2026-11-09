/**
 * P0-6 探针：计划评审卡（尤其是重启前留下的「僵尸卡」）批准之后必须解除阻塞。
 *
 * 病根（复审 `docs/code-review/2026-11-09/P0-6-7-9-复审.md` 真问题 2）：进程崩在
 * 「已提交计划、未获批」时，会话 jsonl 里留下 `plan.decision = 'pending'`；重启后
 * `plan` 插件把它读成 `restored`（僵尸卡）并登记进 `waiting`。但 `answerPlan` 只认活卡，
 * `finish()` 也不清 `restored`，而计划卡是三类卡里唯一没有超时的——于是点批准/拒绝都是空操作，
 * `anyFor(那条会话)` 恒为真，这条会话的目标续跑永久停摆，重启也还在。
 *
 * 这个电池真装 `plan` 与 `waiting` 插件、真调服务方法（不是读源码猜），验六件事：
 *   1. 只有僵尸卡时点批准：卡收掉、`anyFor` 变假、会话状态条目写成终结态；
 *   2. 活卡与僵尸卡共存（切会话时读回一张待批旧状态）时批准活卡：两张都收掉；
 *   3. 僵尸卡还在时同一会话交新计划并批准：僵尸卡在提交时就被作废，不会永久挡；
 *   4. 僵尸卡只挡它自己那条会话，`any`（全进程口径）照旧为真；
 *   5. 宿主退出（`dsc/exit`）时僵尸卡跟着收掉；
 *   6. 写盘失败时内存不清（僵尸卡与 `anyFor` 都还在），写盘恢复后还能重试。
 *
 * 纯 Node 跑（不需要 build）：源码按 NodeNext 写 `.js` 说明符、`@pneuma/*` 是构建期映射，
 * 这里用官方 resolve hook 补两条，剩下的交给 Node 的类型擦除。
 *
 * 运行：node scripts/plan-zombie-card-check.mjs
 *
 * @module dsc/scripts/plan-zombie-card-check
 */
import { mkdtempSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// 自检不碰真实 ~/.dsc：plan 的审计行落在这里。
process.env.DSC_HOME = mkdtempSync(join(tmpdir(), 'dsc-plan-zombie-'))

// `@pneuma/runtime/*` → src/*，`@pneuma/<id>/*` → src/packages/<id>/*；`.js` 说明符回落成 `.ts`。
registerHooks({
  resolve(specifier, context, nextResolve) {
    let mapped = specifier
    if (specifier.startsWith('@pneuma/runtime/')) {
      mapped = pathToFileURL(join(root, 'src', specifier.slice('@pneuma/runtime/'.length))).href
    } else if (specifier.startsWith('@pneuma/')) {
      mapped = pathToFileURL(join(root, 'src', 'packages', specifier.slice('@pneuma/'.length))).href
    }
    try {
      return nextResolve(mapped, context)
    } catch (error) {
      if (mapped.endsWith('.js')) {
        try {
          return nextResolve(`${mapped.slice(0, -3)}.ts`, context)
        } catch {
          // 落到下面把原始错误抛出去
        }
      }
      throw error
    }
  },
})

let pass = 0
let fail = 0

const check = (name, condition, detail) => {
  if (condition) {
    pass += 1
    console.log(`  ok  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 一条假会话：只需要 meta / filePath / state / appendState；writes 记录每次状态写入。 */
const makeSession = (id, filePath, states = {}) => {
  const map = new Map(Object.entries(states))
  const session = {
    meta: { id, cwd: '/work' },
    filePath,
    writes: [],
    state(name) {
      return map.get(name)
    },
    appendState(name, value) {
      map.set(name, value)
      session.writes.push({ name, value })
    },
    /** 探针自己在会话文件里塞一条旧状态（模拟上一次进程留下的 jsonl 内容）。 */
    setState(name, value) {
      map.set(name, value)
    },
  }
  return session
}

const { waitingPlugin } = await import(pathToFileURL(join(root, 'src/packages/waiting/index.ts')).href)
const { planPlugin } = await import(pathToFileURL(join(root, 'src/packages/plan/index.ts')).href)

/** 起一份全新的 waiting 登记表（插件 apply 一次 = 一张新表）。 */
const freshWaiting = () => {
  const provided = {}
  waitingPlugin.apply({
    provide(name, service) {
      provided[name] = service
    },
  })
  return provided.waiting
}

/** 一份最小的宿主上下文：只实现 plan 插件真正用到的那几个面。 */
const makeCtx = (current, waiting) => {
  const ctx = {
    current,
    provided: {},
    surfaces: {},
    events: new Map(),
    notices: [],
    modeChanges: [],
    waiting,
    provide(name, service) {
      ctx.provided[name] = service
    },
    get(name) {
      return name === 'waiting' ? waiting : undefined
    },
    effect(fn) {
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on(event, handler) {
      const list = ctx.events.get(event) ?? []
      list.push(handler)
      ctx.events.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      if (event === 'dsc/notice') ctx.notices.push(args[0])
    },
    /** 触发一次宿主事件（`dsc/session-open` / `dsc/exit`）。 */
    fire(event, payload) {
      for (const handler of ctx.events.get(event) ?? []) handler(payload)
    },
    session: { current: () => ctx.current },
    tools: { register: () => () => {} },
    surfaces: {
      register(id, fn) {
        ctx.surfaces[id] = fn
        return () => {}
      },
    },
    mode: {
      setMode(mode) {
        ctx.modeChanges.push(mode)
      },
    },
  }
  return ctx
}

/** 装一份 plan 插件，返回上下文与它的服务面。 */
const startPlan = (session) => {
  const ctx = makeCtx(session, freshWaiting())
  planPlugin.apply(ctx)
  return ctx
}

const zombie = { file: '/work/.dsc/plans/old.md', title: '上一次没答的计划', text: '旧计划正文', decision: 'pending' }
const newPlan = { file: '/work/.dsc/plans/new.md', title: '新计划', text: '# 新计划\n1. 做事', decision: 'pending' }

console.log('[1] 只有僵尸卡：点批准要能收掉它（目标续跑才解得开）')
{
  const session = makeSession('sess-a', '/sessions/a.jsonl', { plan: zombie })
  const ctx = startPlan(session)
  const plan = ctx.provided.plan
  check('启动时快照画得出僵尸卡', plan.pendingPlan() !== null, JSON.stringify(plan.pendingPlan()))
  check('anyFor(僵尸卡所属会话) = 真（正在挡续跑）', ctx.waiting.anyFor('sess-a') === true)
  plan.answerPlan('approved')
  check('批准后快照上不再有卡', plan.pendingPlan() === null, JSON.stringify(plan.pendingPlan()))
  check('批准后 anyFor(该会话) 变假', ctx.waiting.anyFor('sess-a') === false)
  check('批准写回了终结状态条目', session.state('plan')?.decision === 'approved', JSON.stringify(session.state('plan')))
  check('批准切回执行档', ctx.modeChanges.includes('build'), JSON.stringify(ctx.modeChanges))
}

console.log('[2] 活卡与僵尸卡共存：批准活卡要把两张都收掉')
{
  const session = makeSession('sess-b', '/sessions/b.jsonl')
  const ctx = startPlan(session)
  const plan = ctx.provided.plan
  const pending = plan.proposePlan({ file: newPlan.file, title: newPlan.title, text: newPlan.text }, new AbortController().signal)
  // 模拟切会话再切回来：会话文件里留着一张待批的旧状态，插件把它读成 restored。
  session.setState('plan', { ...zombie, title: '更早的僵尸卡' })
  ctx.fire('dsc/session-open', { session, filePath: session.filePath })
  check('快照优先显示活卡', plan.pendingPlan()?.title === '新计划', JSON.stringify(plan.pendingPlan()))
  check('两张卡都在时 anyFor(该会话) = 真', ctx.waiting.anyFor('sess-b') === true)
  plan.answerPlan('approved')
  const decision = await pending
  check('活卡拿到的答案是批准', decision === 'approved', String(decision))
  check('批准活卡后 anyFor(该会话) 变假（僵尸卡不再挡）', ctx.waiting.anyFor('sess-b') === false)
  check('批准活卡后快照上不再有卡（僵尸卡也收掉）', plan.pendingPlan() === null, JSON.stringify(plan.pendingPlan()))
  check(
    '会话状态条目停在活卡的终结态（僵尸卡没把新结果盖回去）',
    session.state('plan')?.decision === 'approved' && session.state('plan')?.title === '新计划',
    JSON.stringify(session.state('plan')),
  )
}

console.log('[3] 僵尸卡 + 同一会话交新计划并批准：不能永久挡')
{
  const session = makeSession('sess-c', '/sessions/c.jsonl', { plan: zombie })
  const ctx = startPlan(session)
  const plan = ctx.provided.plan
  check('交新计划前 anyFor(该会话) = 真', ctx.waiting.anyFor('sess-c') === true)
  const pending = plan.proposePlan({ file: newPlan.file, title: newPlan.title, text: newPlan.text }, new AbortController().signal)
  const invalidated = session.writes.some(
    (write) => write.name === 'plan' && write.value?.title === zombie.title && write.value?.decision === 'rejected',
  )
  check('僵尸卡在提交新计划时就被写终结（不算永久挡）', invalidated, JSON.stringify(session.writes))
  check('新计划挂着时 anyFor(该会话) 仍为真（活卡还在等）', ctx.waiting.anyFor('sess-c') === true)
  plan.answerPlan('approved')
  await pending
  check('新计划批准后 anyFor(该会话) 变假', ctx.waiting.anyFor('sess-c') === false)

  // 重启：拿同一份会话状态再装一次插件，僵尸卡不许复活。
  const restarted = startPlan(session)
  check('重启后快照上不再有卡', restarted.provided.plan.pendingPlan() === null, JSON.stringify(restarted.provided.plan.pendingPlan()))
  check('重启后 anyFor(该会话) = 假', restarted.waiting.anyFor('sess-c') === false)
}

console.log('[4] 僵尸卡只挡它自己那条会话')
{
  const session = makeSession('sess-d', '/sessions/d.jsonl', { plan: zombie })
  const ctx = startPlan(session)
  check('any（全进程口径）= 真', ctx.waiting.any === true)
  check('anyFor(该会话) = 真', ctx.waiting.anyFor('sess-d') === true)
  check('anyFor(别的会话) = 假', ctx.waiting.anyFor('sess-other') === false)
}

console.log('[5] 宿主退出时僵尸卡跟着收掉')
{
  const session = makeSession('sess-e', '/sessions/e.jsonl', { plan: zombie })
  const ctx = startPlan(session)
  check('退出前 anyFor(该会话) = 真', ctx.waiting.anyFor('sess-e') === true)
  ctx.fire('dsc/exit')
  check('退出后 anyFor(该会话) = 假', ctx.waiting.anyFor('sess-e') === false)
  check('退出后快照上不再有卡', ctx.provided.plan.pendingPlan() === null, JSON.stringify(ctx.provided.plan.pendingPlan()))
}

console.log('[6] 写盘失败时不清内存：僵尸卡还在，下次还能重试')
{
  const session = makeSession('sess-f', '/sessions/f.jsonl', { plan: zombie })
  const ctx = startPlan(session)
  const plan = ctx.provided.plan
  const write = session.appendState
  // 模拟 jsonl 写失败（磁盘满 / 会话文件被删）：终结状态落不了盘。
  session.appendState = () => {
    throw new Error('appendState 写盘失败')
  }
  let threw = false
  try {
    plan.answerPlan('approved')
  } catch {
    threw = true
  }
  check('写盘失败时错误抛给调用方（不静默吞掉）', threw)
  check(
    '写盘失败后内存里的僵尸卡还在（不是先清后写留下的幽灵）',
    plan.pendingPlan() !== null && plan.pendingPlan()?.decision === 'pending',
    JSON.stringify(plan.pendingPlan()),
  )
  check('写盘失败后 anyFor(该会话) 仍为真（还能挡住续跑，状态没丢）', ctx.waiting.anyFor('sess-f') === true)
  check('写盘失败时不切模式、不写审计（状态没改成终结就不算批准）', ctx.modeChanges.length === 0, JSON.stringify(ctx.modeChanges))
  // 写盘恢复后重试一次：这次要能正常收掉，证明「保持原状」换来了可重试。
  session.appendState = write
  plan.answerPlan('approved')
  check('写盘恢复后重试能收掉僵尸卡', plan.pendingPlan() === null && ctx.waiting.anyFor('sess-f') === false)
  check('重试写回了终结状态条目', session.state('plan')?.decision === 'approved', JSON.stringify(session.state('plan')))
}

console.log(`\nPASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
