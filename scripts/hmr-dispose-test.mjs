/**
 * 热停用探针：停一行，它注册的工具与设置分区必须跟着走；再启用，必须原样回来。
 *
 * 为什么要这个探针：插件销毁时 cordis 只回收「挂在 fiber 上的 effect」，服务自己的
 * Map 不会自动清——注册点不包 ctx.effect 就会留下幽灵工具/幽灵分区（设置页
 * sections() 甚至因为读到已卸载插件的 ctx 而整表抛错）。这里按「停用 → 断言 →
 * 启用 → 断言」的次序把两个方向都跑一遍。
 *
 * 用临时 DSC_HOME 起一个 headless 内核，不碰真实 ~/.dsc；stdout 全程屏蔽
 * （host-stdio 重挂时会往 stdout 写一行 hello，会顶掉结果输出）。
 *
 * 用法：node scripts/hmr-dispose-test.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 *
 * @module scripts/hmr-dispose-test
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'numa-hmr-dispose-'))
process.env['DSC_HOME'] = home
process.env['DSC_UI_SERVER'] = '0'
// 环境里带的 profile 会让这次探针改读开发机的组合包：只认「第一次启动」的样子。
delete process.env['DSC_PROFILE']

const { readConfig } = await import('../lib/core/config.js')
const { createKernel } = await import('../lib/host/kernel.js')
const { setPluginEnabledHot } = await import('../lib/core/plugin-loader.js')

// 挂载期间屏蔽 stdout：tui 会写整屏横幅，host-stdio 会写一行 hello。
const realWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = () => true

const root = await createKernel({ config: readConfig(), resumeSessionPath: null, surface: 'headless' })

let pass = 0
let fail = 0
const failures = []

/** 记一条断言结果。 */
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
  } else {
    fail += 1
    failures.push(detail === '' ? name : `${name}（${detail}）`)
  }
}

/** 当前注册表里模型能看到的工具名。 */
function toolNames() {
  return root.tools.visible().map((entry) => entry.name)
}

/** 设置分区 id 列表；sections() 抛错时返回 null 并把原因记下来。 */
function sectionIds() {
  try {
    return root.settings.sections().map((section) => section.id)
  } catch (error) {
    return null
  }
}

/** 轮询等到条件成立（热挂载是异步的，等 fiber 重新装配完再断言）。 */
async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/** 停一行，返回禁用结果。 */
async function disable(file) {
  return setPluginEnabledHot(file, false)
}

/** 启用一行，返回启用结果。 */
async function enable(file) {
  return setPluginEnabledHot(file, true)
}

try {
  // ── 基线：先确认这几样本来就在场，否则后面的「消失」断言没有意义 ──────────
  const baselineTools = toolNames()
  const baselineSections = sectionIds()
  for (const name of ['todo_write', 'goal', 'exit_plan_mode', 'ask_user']) {
    check(`基线：工具 ${name} 在场`, baselineTools.includes(name))
  }
  check('基线：设置分区列表可读', baselineSections !== null, 'sections() 一开始就抛错')
  check('基线：todo 分区在场', baselineSections !== null && baselineSections.includes('todo'))
  check('基线：remote 分区在场', baselineSections !== null && baselineSections.includes('remote'))

  // ── a + e：停用 todo → 工具与分区都走，sections() 不抛 ──────────────────────
  const offTodo = await disable('todo')
  check('a. 停用 todo 返回 ok', offTodo.ok === true, offTodo.problem ?? '')
  check('a. todo_write 已从注册表消失', !toolNames().includes('todo_write'))
  const afterTodoSections = sectionIds()
  check('e. 停用 todo 后 sections() 不抛错', afterTodoSections !== null)
  check('e. 分区列表不含 todo', afterTodoSections !== null && !afterTodoSections.includes('todo'))

  // ── f（正向）：重新启用 todo → 工具与分区都回来 ────────────────────────────
  const onTodo = await enable('todo')
  check('f. 重新启用 todo 返回 ok', onTodo.ok === true, onTodo.problem ?? '')
  check('f. todo_write 回来了', await waitFor(() => toolNames().includes('todo_write')))
  check(
    'f. todo 分区回来了',
    await waitFor(() => {
      const ids = sectionIds()
      return ids !== null && ids.includes('todo')
    }),
  )

  // ── b：停用 goal → goal 工具消失 ───────────────────────────────────────────
  const offGoal = await disable('goal')
  check('b. 停用 goal 返回 ok', offGoal.ok === true, offGoal.problem ?? '')
  check('b. goal 工具已从注册表消失', !toolNames().includes('goal'))
  const afterGoalSections = sectionIds()
  check('b. 停用 goal 后 sections() 不抛错', afterGoalSections !== null)
  const onGoal = await enable('goal')
  check('b. 重新启用 goal 返回 ok', onGoal.ok === true, onGoal.problem ?? '')
  check('b. goal 工具回来了', await waitFor(() => toolNames().includes('goal')))

  // ── c：停用 plan → exit_plan_mode 消失 ─────────────────────────────────────
  const offPlan = await disable('plan')
  check('c. 停用 plan 返回 ok', offPlan.ok === true, offPlan.problem ?? '')
  check('c. exit_plan_mode 已从注册表消失', !toolNames().includes('exit_plan_mode'))
  const afterPlanSections = sectionIds()
  check('c. 停用 plan 后 sections() 不抛错', afterPlanSections !== null)
  const onPlan = await enable('plan')
  check('c. 重新启用 plan 返回 ok', onPlan.ok === true, onPlan.problem ?? '')
  check('c. exit_plan_mode 回来了', await waitFor(() => toolNames().includes('exit_plan_mode')))

  // ── d：停用 ask → ask_user 消失 ────────────────────────────────────────────
  const offAsk = await disable('ask')
  check('d. 停用 ask 返回 ok', offAsk.ok === true, offAsk.problem ?? '')
  check('d. ask_user 已从注册表消失', !toolNames().includes('ask_user'))
  const afterAskSections = sectionIds()
  check('d. 停用 ask 后 sections() 不抛错', afterAskSections !== null)
  const onAsk = await enable('ask')
  check('d. 重新启用 ask 返回 ok', onAsk.ok === true, onAsk.problem ?? '')
  check('d. ask_user 回来了', await waitFor(() => toolNames().includes('ask_user')))

  // ── g：停用 remote → 分区消失且 sections() 不抛；启用 → 分区回来 ───────────
  const offRemote = await disable('remote')
  check('g. 停用 remote 返回 ok', offRemote.ok === true, offRemote.problem ?? '')
  const afterRemoteSections = sectionIds()
  check('g. 停用 remote 后 sections() 不抛错', afterRemoteSections !== null)
  check('g. 分区列表不含 remote', afterRemoteSections !== null && !afterRemoteSections.includes('remote'))
  const onRemote = await enable('remote')
  check('g. 重新启用 remote 返回 ok', onRemote.ok === true, onRemote.problem ?? '')
  check(
    'g. remote 分区回来了',
    await waitFor(() => {
      const ids = sectionIds()
      return ids !== null && ids.includes('remote')
    }),
  )
} finally {
  process.stdout.write = realWrite
  rmSync(home, { recursive: true, force: true })
}

console.log(`PASS ${String(pass)} FAIL ${String(fail)}`)
if (fail > 0) {
  for (const item of failures) console.log(`  ✗ ${item}`)
  process.exit(1)
}
process.exit(0)
