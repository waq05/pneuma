/**
 * P0-6 探针：`waiting` 登记表要带会话归属，查询能按会话过滤。
 *
 * 病根（`docs/code-review/2026-11-09/07-agent-orchestration.md` P0-6）：审批 / 计划 / 提问
 * 三家往同一张表里登记「本进程有卡」，`goal` 的自动续跑与 `schedule` 的投递问的都是这个
 * 进程级的值。后台会话挂一张审批卡没人答，用户正在看的这条会话的目标续跑就永久停摆。
 *
 * 这个电池验两件事：
 *   1. 行为：真装上 `packages/waiting` 插件，登记几张分属不同会话的卡，`any`（全进程口径）
 *      与 `anyFor(会话 id)`（单会话口径）结论要分开；
 *   2. 消费侧：`goal` 与 `schedule` 问的是自己那条会话，`any` 仍保留给界面这类粗口径消费者。
 *
 * 纯 Node 跑（不需要 build）：`waiting/index.ts` 只有 `import type`，Node 的类型擦除直接能加载。
 *
 * 运行：node scripts/waiting-session-scope-check.mjs
 *
 * @module dsc/scripts/waiting-session-scope-check
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
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

/** 跑一段可能抛错的断言：抛错算 FAIL，不让整份探针中断。 */
const guard = (name, fn) => {
  try {
    fn()
  } catch (error) {
    fail += 1
    console.log(`FAIL  ${name}  <- 抛错：${error.message}`)
  }
}

/**
 * 按会话问一句。
 *
 * 修复前服务上没有这个方法（`anyFor` 是这次新加的）：缺了就当「查不了」，返回
 * `undefined` 让断言记 FAIL，而不是让整份探针崩在第一个用例上——修前修后都能跑完。
 */
const anyFor = (waiting, owner) => (typeof waiting.anyFor === 'function' ? waiting.anyFor(owner) : undefined)

const { waitingPlugin } = await import(pathToFileURL(join(root, 'src/packages/waiting/index.ts')).href)

/** 起一份全新的登记表（插件 apply 一次 = 一张新表）。 */
const fresh = () => {
  const provided = {}
  waitingPlugin.apply({
    provide(name, service) {
      provided[name] = service
    },
  })
  return provided.waiting
}

/** 照三家登记方的写法登记：卡带会话归属，`owner` 缺省 = 「全进程有没有卡」。 */
const registerCards = (waiting, id, cards) =>
  waiting.register(id, (owner) => cards.some((card) => owner === undefined || card.sessionId === owner))

console.log('[1] 空表')
{
  const waiting = fresh()
  check('any 为假', waiting.any === false)
  check('anyFor 为假', anyFor(waiting, 's1') === false)
  check('ids 为空', Array.isArray(waiting.ids) && waiting.ids.length === 0)
}

console.log('[2] 一张卡只挡它自己那条会话（P0-6 的核心断言）')
{
  const waiting = fresh()
  registerCards(waiting, 'approval', [{ sessionId: 's1' }])
  check('any = 真（全进程口径）', waiting.any === true)
  check('anyFor(卡所属会话) = 真', anyFor(waiting, 's1') === true)
  check('anyFor(别的会话) = 假', anyFor(waiting, 's2') === false, '后台会话的卡把别家会话也挡住了')
}

console.log('[3] 两张卡分属两条会话：各挡各的')
{
  const waiting = fresh()
  registerCards(waiting, 'approval', [{ sessionId: 's1' }, { sessionId: 's2' }])
  check('anyFor(s1) = 真', anyFor(waiting, 's1') === true)
  check('anyFor(s2) = 真', anyFor(waiting, 's2') === true)
  check('anyFor(s3) = 假', anyFor(waiting, 's3') === false)
}

console.log('[4] 多个登记方（审批 + 计划 + 提问）叠加')
{
  const waiting = fresh()
  registerCards(waiting, 'approval', [{ sessionId: 's1' }])
  registerCards(waiting, 'plan', [{ sessionId: 's2' }])
  registerCards(waiting, 'ask', [])
  check('anyFor(s1) = 真（审批卡）', anyFor(waiting, 's1') === true)
  check('anyFor(s2) = 真（计划卡）', anyFor(waiting, 's2') === true)
  check('anyFor(s3) = 假', anyFor(waiting, 's3') === false)
  check(
    'ids 按登记顺序列出三位',
    JSON.stringify(waiting.ids) === JSON.stringify(['approval', 'plan', 'ask']),
    JSON.stringify(waiting.ids),
  )
}

console.log('[5] 不区分会话的老式登记方（第三方插件）不能被漏掉')
{
  const waiting = fresh()
  waiting.register('third-party', () => true)
  check('any = 真', waiting.any === true)
  check('anyFor(任意会话) = 真（按会话问也不能漏掉它）', anyFor(waiting, 'whatever') === true)
}

console.log('[6] 退订、同 id 覆盖、判定自己算崩')
{
  const waiting = fresh()
  const cards = [{ sessionId: 's1' }]
  const off = registerCards(waiting, 'approval', cards)
  check('登记后 anyFor(s1) = 真', anyFor(waiting, 's1') === true)
  off()
  check('退订后 anyFor(s1) = 假', anyFor(waiting, 's1') === false)

  registerCards(waiting, 'plan', [])
  registerCards(waiting, 'plan', [{ sessionId: 's2' }])
  check(
    '同 id 后注册者顶掉先注册者',
    anyFor(waiting, 's2') === true && waiting.ids.length === 1,
    JSON.stringify(waiting.ids),
  )

  waiting.register('broken', () => {
    throw new Error('卡片自己算崩了')
  })
  guard('一个判定抛错不影响查询', () => {
    check('抛错的登记按「没在等」处理', anyFor(waiting, 's2') === true && waiting.any === true)
  })
}

console.log('[7] 消费侧：goal / schedule 问自己那条会话，any 保留')
{
  const goal = readFileSync(join(root, 'src/packages/goal/index.ts'), 'utf8')
  const schedule = readFileSync(join(root, 'src/packages/schedule/index.ts'), 'utf8')
  const waitingSrc = readFileSync(join(root, 'src/packages/waiting/index.ts'), 'utf8')
  check('goal 用 anyFor(自己那条会话)', goal.includes('ctx.waiting.anyFor('))
  check('goal 不再用裸 ctx.waiting.any', !/ctx\.waiting\.any\b(?!For)/.test(goal))
  check('schedule 用 anyFor', schedule.includes('ctx.waiting.anyFor('))
  check('schedule 不再把全局 any 直接交给调度器', !schedule.includes('waiting: () => ctx.waiting.any,'))
  check('waiting 仍保留 any（界面等粗口径消费者）', /get any\(\)/.test(waitingSrc))
  check(
    'waiting 保留 register / ids（老调用方不用改）',
    /register\(id, pending\)/.test(waitingSrc) && /get ids\(\)/.test(waitingSrc),
  )
}

console.log('[8] 契约面：anyFor 与放宽后的登记签名写进 WaitingService（供第三方插件包看见）')
{
  const typesSrc = readFileSync(join(root, 'src/services/types.ts'), 'utf8')
  const waitingSrc = readFileSync(join(root, 'src/packages/waiting/index.ts'), 'utf8')
  check('WaitingService 契约里有 anyFor(owner)', /anyFor\(owner: string\): boolean/.test(typesSrc))
  check(
    '登记签名放宽成 (owner?: string) => boolean',
    /register\(id: string, pending: \(owner\?: string\) => boolean\): \(\) => void/.test(typesSrc),
  )
  check('waiting 插件不再用 declare module 补类型', !/declare module/.test(waitingSrc))
}

console.log(`\nPASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
