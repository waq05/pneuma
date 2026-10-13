/**
 * 状态面板（status 插件）的确定性探针。
 *
 * 三段：
 *   1. 纯逻辑——聚焦窗口 / 折叠桶语义 / 胶囊十档优先级链 / 时间口径（规则对照 ZCode
 *      `packages/ui/src/v4/ConversationStatusPanel.tsx`，模型按 Node 类型擦除直读 .ts，
 *      不需要先 build）；
 *   2. 形态钉——「同一壳收展（morph）」「按宿主宽度裁决而不是 window.innerWidth」
 *      「七个分区的顺序」「Git 本地轮询三档」「预览卡开合延迟」「已结束目录经 teamPanel
 *      服务」这几条只能靠文本钉住（它们是结构约定，不是可单位化的纯函数）；
 *   3. 宿主数据面的文本钉（新 surfaces / stopBackground 白名单 / 计划目录排除待批）。
 *
 * 运行：node scripts/ui-status-panel-test.mjs
 *
 * @module dsc/scripts/ui-status-panel-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const model = await import(
  new URL('../ui-shell/src/plugins/status/status-model.ts', import.meta.url).href
)
const {
  todoFocusWindow,
  foldBucketKind,
  capsuleSummary,
  formatAgo,
  formatCountdown,
  formatDuration,
  mateElapsedMs,
  longestElapsedMs,
  longestWorkElapsedMs,
} = model

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 造一条 todo（只带模型读得到的三件：id / content / status）。 */
const todo = (id, status, content = `任务${id}`) => ({ id, content, status })

console.log('[1] 聚焦窗口')
{
  const six = [todo('a', 'completed'), todo('b', 'completed'), todo('c', 'in_progress'), todo('d', 'pending'), todo('e', 'pending'), todo('f', 'pending')]
  const plain = todoFocusWindow(six)
  check('≤6 条全显、无折叠', plain.compact === false && plain.focus.length === 6 && plain.preceding.length === 0 && plain.following.length === 0)

  // 9 条，进行中在第 5 位（0 基 4）：窗口 = 第 4..6 条（连续 3 条）
  const items = [
    todo('0', 'completed'), todo('1', 'completed'), todo('2', 'completed'), todo('3', 'completed'),
    todo('4', 'in_progress'), todo('5', 'pending'), todo('6', 'pending'), todo('7', 'pending'), todo('8', 'pending'),
  ]
  const mid = todoFocusWindow(items)
  check('>6 条聚焦进行中及其后续两条', mid.compact === true && mid.focus.map((i) => i.id).join(',') === '4,5,6')
  check('窗口前是前四条、后是后三条', mid.preceding.map((i) => i.id).join(',') === '0,1,2,3' && mid.following.map((i) => i.id).join(',') === '7,8')

  // 进行中在末尾：向前回填，窗口仍是连续 3 条
  const tailItems = [todo('0', 'completed'), todo('1', 'completed'), todo('2', 'pending'), todo('3', 'pending'), todo('4', 'pending'), todo('5', 'pending'), todo('6', 'pending'), todo('7', 'in_progress')]
  const tail = todoFocusWindow(tailItems)
  check('进行中在末尾：向前回填成连续 3 条', tail.focus.map((i) => i.id).join(',') === '5,6,7' && tail.following.length === 0)

  // 无进行中：首个待办；全办完：末尾三条
  const noRunning = [todo('0', 'completed'), todo('1', 'completed'), todo('2', 'pending'), todo('3', 'pending'), todo('4', 'pending'), todo('5', 'pending'), todo('6', 'pending')]
  check('无进行中时聚焦首个待办', todoFocusWindow(noRunning).focus.map((i) => i.id).join(',') === '2,3,4')
  const allDone = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => todo(String(n), 'completed'))
  const doneWindow = todoFocusWindow(allDone)
  check('全办完时取末尾三条', doneWindow.focus.map((i) => i.id).join(',') === '5,6,7' && doneWindow.preceding.length === 5)

  // 原序不被打乱：窗口永远是 items 的一段连续切片
  const contiguous = mid.focus.every((item, index) => items[4 + index] === item)
  check('窗口保持 snapshot 原序（连续切片）', contiguous)
}

console.log('[2] 折叠桶语义')
{
  check('前桶全办完 → completed', foldBucketKind([todo('0', 'completed'), todo('1', 'completed')], 'preceding') === 'completed')
  check('cancelled 也算办完', foldBucketKind([todo('0', 'completed'), todo('1', 'cancelled')], 'preceding') === 'completed')
  check('前桶混待办 → earlier', foldBucketKind([todo('0', 'completed'), todo('1', 'pending')], 'preceding') === 'earlier')
  check('后桶全待办 → waiting', foldBucketKind([todo('0', 'pending'), todo('1', 'pending')], 'following') === 'waiting')
  check('后桶混着 → later', foldBucketKind([todo('0', 'pending'), todo('1', 'completed')], 'following') === 'later')
}

console.log('[3] 胶囊优先级链（十档，顺序照 ZCode）')
{
  const base = {
    todos: null,
    goal: null,
    runningMates: 0,
    git: null,
    plans: [],
    runningWorks: [],
    runningTask: null,
    endedMates: 0,
  }
  const work = (id, title = `作业${id}`) => ({ id, kind: 'job', title, startedAt: 1 })

  check('全空 → null', capsuleSummary(base) === null)

  const s0 = capsuleSummary({ ...base, runningTask: '每天早报' })
  check('在跑的定点任务排第一（工作流档）', s0?.kind === 'workflow' && s0.text === '每天早报', JSON.stringify(s0))

  const todos = { items: [todo('0', 'pending'), todo('1', 'in_progress', '正在做这条'), todo('2', 'pending')], done: 0, total: 3, active: '正在做这条', revision: 1 }
  const s1 = capsuleSummary({ ...base, todos, runningWorks: [work('job-1')] })
  check('当前待办压过后台活兜底', s1?.kind === 'todo-current' && s1.text === '正在做这条', JSON.stringify(s1))
  const s1b = capsuleSummary({ ...base, todos, runningTask: '早报' })
  check('在跑的定点任务压过当前待办（ZCode 第一档位）', s1b?.kind === 'workflow' && s1b.text === '早报', JSON.stringify(s1b))

  const goalActive = { objective: '把状态面板补齐', phase: 'active', rounds: 1, maxRounds: 8, armed: true }
  const s2 = capsuleSummary({ ...base, goal: goalActive, runningMates: 1 })
  check('无待办时未完成目标排第二', s2?.kind === 'goal' && s2.text === '把状态面板补齐', JSON.stringify(s2))

  const git = { added: 12, removed: 3, files: 4 }
  const s3 = capsuleSummary({ ...base, goal: goalActive, git })
  check('未完成目标排在 Git 变更之前', s3?.kind === 'goal', JSON.stringify(s3))
  const s3b = capsuleSummary({ ...base, git })
  check('没有别的状态时 Git 变更自己撑胶囊', s3b?.kind === 'git' && s3b.added === 12 && s3b.files === 4, JSON.stringify(s3b))

  const s4 = capsuleSummary({ ...base, goal: { ...goalActive, phase: 'complete' }, git })
  check('Git 变更排在已完成目标之前（ZCode 的 git 档在 done goal 之前）', s4?.kind === 'git', JSON.stringify(s4))
  const s4b = capsuleSummary({ ...base, goal: { ...goalActive, phase: 'complete' } })
  check('没有 Git 变更时已完成目标自己出档', s4b?.kind === 'goal-done' && s4b.text === '把状态面板补齐', JSON.stringify(s4b))

  const doneTodos = { items: [todo('0', 'completed', '办完的一'), todo('1', 'completed', '办完的二')], done: 2, total: 2, active: null, revision: 1 }
  const s5 = capsuleSummary({ ...base, todos: doneTodos })
  check('没有当前项时报最后一条办完的', s5?.kind === 'todo-done' && s5.text === '办完的二', JSON.stringify(s5))

  const cancelled = { items: [todo('0', 'cancelled'), todo('1', 'cancelled')], done: 0, total: 2, active: null, revision: 3 }
  const s6 = capsuleSummary({ ...base, todos: cancelled })
  check('全取消（无当前 / 无办完）时落到进程进度', s6?.kind === 'progress' && s6.done === 0 && s6.total === 2, JSON.stringify(s6))

  const plans = [{ file: 'D:\\w\\.dsc\\plans\\b.md', title: '计划乙', at: 2 }, { file: 'D:\\w\\.dsc\\plans\\a.md', title: '计划甲', at: 1 }]
  const s7 = capsuleSummary({ ...base, plans })
  check('计划目录档：报最新一份的标题', s7?.kind === 'plan' && s7.text === '计划乙', JSON.stringify(s7))

  const s8 = capsuleSummary({ ...base, runningWorks: [work('job-1')] })
  check('只有后台活：报作业数', s8?.kind === 'running' && s8.works === 1 && s8.mates === 0, JSON.stringify(s8))
  const s9 = capsuleSummary({ ...base, runningMates: 2, runningWorks: [work('job-1')] })
  check('混合（队友 + 后台活）：两端都带上', s9?.kind === 'running' && s9.mates === 2 && s9.works === 1, JSON.stringify(s9))

  const s10 = capsuleSummary({ ...base, endedMates: 3 })
  check('只有已结束队友时兜底报一条（dsc 的有意偏离：面板是它们唯一入口）', s10?.kind === 'mates-ended' && s10.count === 3, JSON.stringify(s10))
  const s11 = capsuleSummary({ ...base, endedMates: 3, todos })
  check('已结束队友不压过任何主状态', s11?.kind === 'todo-current', JSON.stringify(s11))
}

console.log('[4] 时间口径')
{
  check('90 秒 → 1分30秒', formatDuration(90_000) === '1分30秒')
  check('8 秒 → 8秒', formatDuration(8_000) === '8秒')
  check('3.7 小时 → 3小时42分', formatDuration(3.7 * 3600_000) === '3小时42分')
  check('负数 / NaN → null', formatDuration(-1) === null && formatDuration(Number.NaN) === null)
  const running = { startedAt: 1_000, finishedAt: undefined }
  check('在跑的按 now 算', mateElapsedMs(running, 6_000) === 5_000)
  const idle = { startedAt: 1_000, finishedAt: 4_000 }
  check('收工的冻结在 finishedAt', mateElapsedMs(idle, 60_000) === 3_000)
  check('最长运行取最大', longestElapsedMs([idle, running], 6_000) === 5_000)
  check('后台活最长已运行', longestWorkElapsedMs([{ startedAt: 1_000 }, { startedAt: 3_000 }], 10_000) === 9_000)

  check('倒计时：90 秒 → 1分30秒后', formatCountdown(1_000 + 90_000, 1_000) === '1分30秒后')
  check('倒计时：已过点 → 已到点', formatCountdown(500, 1_000) === '已到点')
  check('倒计时：不到一秒 → 即将', formatCountdown(1_400, 1_000) === '即将')
  check('倒计时：没有排期 → null', formatCountdown(null, 1_000) === null)
  check('多久前：不到一分钟 → 刚刚', formatAgo(99_000, 100_000) === '刚刚')
  check('多久前：3.2 小时 → 3小时12分前', formatAgo(100_000, 100_000 + 3.2 * 3600_000) === '3小时12分前')
  check('多久前：未来时刻 → null', formatAgo(2_000, 1_000) === null)
}

console.log('[5] 形态钉（结构约定）')
{
  const status = read('ui-shell/src/plugins/status/ui.tsx')
  const css = read('ui-shell/src/styles.css')
  const team = read('ui-shell/src/plugins/team/ui.tsx')
  const tasks = read('ui-shell/src/plugins/tasks/ui.tsx')
  /** 去掉注释再查「不许出现」的东西：注释里提到 window.innerWidth 是在解释为什么不用它。 */
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  check('自动档按宿主宽度裁决（代码里不再读 window.innerWidth）', !stripComments(status).includes('window.innerWidth') && status.includes('ResizeObserver'))
  check('同一壳收展：data-expanded 在 aside 上', status.includes('data-expanded') && css.includes(".sp[data-expanded='0']"))
  check('收展过渡挂在 max-height 上', /\.sp\s*\{[\s\S]*?max-height[^;]*transition|transition:[\s\S]{0,120}max-height/.test(css))
  check('少动模式下停掉收展过渡', /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.sp/.test(css))
  check('预览卡开合有延迟（120/80ms）', status.includes('PREVIEW_OPEN_MS') && status.includes('PREVIEW_CLOSE_MS'))
  check('折叠桶行带 data-sp-fold 钩子', status.includes('data-sp-fold'))
  check('已结束目录行经 teamPanel 服务且缺服务不渲染', status.includes("'teamPanel'") && status.includes('data-sp-ended'))
  check('team 插件把 teamPanel 服务 provide 出来', team.includes("ui.provide('teamPanel'"))
  check('进程行三态图标（进行中/办完/待办）', status.includes('sp-icon-run') && status.includes('sp-icon-done') && status.includes('sp-icon-wait'))

  check(
    '七个分区的渲染顺序照 ZCode（git → goal → plan → todo → terminal → workflow → agent）',
    /<GitSection[\s\S]*?<GoalSection[\s\S]*?<PlanSection[\s\S]*?<TodoSection[\s\S]*?<WorkSection[\s\S]*?<WorkflowSection[\s\S]*?<AgentSection/.test(status),
  )
  check(
    'Git 读数是本地轮询（三档 + 慢仓库退让）',
    status.includes('GIT_POLL_DIRTY_MS') && status.includes('GIT_POLL_CLEAN_MS') && status.includes('GIT_POLL_IDLE_MS') && status.includes('GIT_SLOW_MS'),
  )
  check('Git 区「更改」行点开右侧栏 Git 页签', status.includes("openDockTab('git')"))
  check('计划行点开右侧栏文件预览', status.includes('setDockPreview({ path: plan.file })'))
  check('终端区停止走 stopBackground（界面白名单里的那一条）', status.includes("invoke<string>('stopBackground'"))
  check('新区都有限高（计划 / 终端 / 工作流）', css.includes("data-sp-section='plan'") && css.includes("data-sp-section='terminal'") && css.includes("data-sp-section='workflow'"))
  check('只读行不给悬停底（.sp-row-static）', css.includes('.sp-row-static') && css.includes('.sp-row:has(.sp-row-static):hover'))
  check('增删读数用设计令牌上色', css.includes('.sp-add') && css.includes('.sp-del') && /\.sp-add\s*\{[^}]*--dsc-green/.test(css) && /\.sp-del\s*\{[^}]*--dsc-red/.test(css))

  check('任务条已撤（tasks 插件里没有 TaskDock / tasks.dock）', !stripComments(tasks).includes('TaskDock') && !tasks.includes('tasks.dock'))
  check('清空清单搬进进程区', status.includes('data-sp-clear') && status.includes("invoke('clearTodos'"))
  check('团队钮已撤（team 插件里没有 TeamButton / team.toggle）', !stripComments(team).includes('TeamButton') && !team.includes('team.toggle'))
  check('名册轮询仍在（移进子智能体下拉）', team.includes("invoke<TeammateView[]>('listTeammates'") && /function SubagentMenu[\s\S]*?setInterval/.test(team))
  check('团队面板仍由常挂载的那一簇渲染', team.includes('{teamOpen ? <TeamPanel'))
}

console.log('[6] 宿主数据面（文本钉）')
{
  const contract = read('src/contract.ts')
  const uiMethods = read('src/core/ui-methods.ts')
  const hostMethods = read('src/core/host-methods.ts')
  const toolsDefault = read('src/plugins/tools-default.ts')
  const plan = read('src/plugins/plan.ts')
  const schedule = read('src/plugins/schedule.ts')

  check(
    '契约里有三个新面（scheduled 可缺席）',
    contract.includes('backgroundWorks: BackgroundWorkView[]') &&
      contract.includes('planDirectory: PlanEntryView[]') &&
      contract.includes('scheduled?: ScheduledTaskView[]'),
  )
  check('stopBackground 三处齐（契约 / 协议白名单 / 界面白名单 + 实参规格）', contract.includes('stopBackground(id: string)') && hostMethods.includes("'stopBackground'") && uiMethods.includes("'stopBackground'") && uiMethods.includes('stopBackground: ['))
  check('backgroundWorks 只出运行中的（作业 + 终端两条都是）', toolsDefault.includes("job.status !== 'running'") && toolsDefault.includes("term.status !== 'running'"))
  check('作业完成 / 终端自退都会抖快照', toolsDefault.includes("ctx.emit('dsc/changed')") && toolsDefault.includes('new TerminalTable({ onExit:'))
  check('计划目录排除待批的那一份', plan.includes('pendingFile') && plan.includes("cardOfCurrent()?.view.file ?? restored?.file"))
  check('计划目录有 TTL 缓存（快照帧可能很密）', plan.includes('PLAN_DIRECTORY_TTL_MS'))
  check('工作流区绑的是定点任务（schedule 贡献 scheduled 面）', schedule.includes("ctx.surfaces.register('scheduled'"))
}

if (failures === 0) {
  console.log('\n全部通过')
} else {
  console.log(`\n${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
