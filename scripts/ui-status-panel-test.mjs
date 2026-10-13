/**
 * 状态面板（status 插件）的确定性探针。
 *
 * 两段：
 *   1. 纯逻辑——聚焦窗口 / 折叠桶语义 / 胶囊优先级链 / 时长口径（规则对照 ZCode
 *      `packages/ui/src/v4/ConversationStatusPanel.tsx`，模型按 Node 类型擦除直读 .ts，
 *      不需要先 build）；
 *   2. 形态钉——「同一壳收展（morph）」「按宿主宽度裁决而不是 window.innerWidth」
 *      「预览卡开合延迟」「已结束目录经 teamPanel 服务」这几条只能靠文本钉住
 *      （它们是结构约定，不是可单位化的纯函数）。
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
const { todoFocusWindow, foldBucketKind, capsuleSummary, formatDuration, mateElapsedMs, longestElapsedMs } = model

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

console.log('[3] 胶囊优先级链')
{
  const base = { todos: null, goal: null, runningMates: 0 }
  check('全空 → null', capsuleSummary(base) === null)

  const todos = { items: [todo('0', 'pending'), todo('1', 'in_progress', '正在做这条'), todo('2', 'pending')], done: 0, total: 3, active: '正在做这条', revision: 1 }
  const s1 = capsuleSummary({ ...base, todos, runningMates: 2 })
  check('当前待办压过目标与队友数', s1?.kind === 'todo-current' && s1.text === '正在做这条', JSON.stringify(s1))

  const goalActive = { objective: '把状态面板补齐', phase: 'active', rounds: 1, maxRounds: 8, armed: true }
  const s2 = capsuleSummary({ ...base, goal: goalActive, runningMates: 1 })
  check('无待办时目标排第二', s2?.kind === 'goal' && s2.text === '把状态面板补齐', JSON.stringify(s2))

  const doneTodos = { items: [todo('0', 'completed', '办完的一'), todo('1', 'completed', '办完的二')], done: 2, total: 2, active: null, revision: 1 }
  const s3 = capsuleSummary({ ...base, todos: doneTodos })
  check('没有当前项时报最后一条办完的', s3?.kind === 'todo-done' && s3.text === '办完的二', JSON.stringify(s3))
  const s3b = capsuleSummary({ ...base, todos: doneTodos, goal: { ...goalActive, phase: 'complete' } })
  check('已完成的目标排在办完的待办之前（对照 ZCode 的 done-goal 档）', s3b?.kind === 'goal', JSON.stringify(s3b))

  const s4 = capsuleSummary({ ...base, todos: { ...doneTodos, items: [], done: 0, total: 0 } , runningMates: 3 })
  check('条目清空后落到队友数', s4?.kind === 'mates' && s4.count === 3, JSON.stringify(s4))

  const s5 = capsuleSummary({ ...base, runningMates: 2 })
  check('只有已结束队友时不撑胶囊（只剩 runningMates 才有）', capsuleSummary(base) === null && s5.kind === 'mates')
}

console.log('[4] 时长口径')
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
}

console.log('[5] 形态钉（结构约定）')
{
  const status = read('ui-shell/src/plugins/status/ui.tsx')
  const css = read('ui-shell/src/styles.css')
  const team = read('ui-shell/src/plugins/team/ui.tsx')
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
}

if (failures === 0) {
  console.log('\n全部通过')
} else {
  console.log(`\n${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
