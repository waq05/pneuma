/**
 * 状态面板的纯派生逻辑（ui 层）。
 *
 * 来源 `scripts/ui-status-panel-test.mjs` 的第 [1]–[4] 段。探针第 [2] 段之后的「形态钉」
 * 读的是 `ui.tsx` / `styles.css` 的源码文本（`includes('data-expanded')`、正则找渲染顺序……），
 * 按迁移规则**不迁**：改个引号就假红、删掉逻辑但留下字面量就假绿。那条路要靠真渲染断言或
 * 截图，不在这一条 POC 的范围里。这里只迁可以被单位化的纯函数。
 *
 * 为什么放 ui 层而不是 unit：`status-model.ts` 经 `@dsc/ui` 的 `createT` 取词，字典是
 * 本包的两份 JSON。这条 import 链按浏览器侧解析（`@dsc/ui` 别名 + JSON 模块），
 * jsdom + ui project 才是它的运行环境；`tests/setup/dom.ts` 现在一条桩都不需要。
 *
 * @module dsc-ui-shell/plugins/status/model.spec
 */
import { expect, test } from 'vitest'
import type { BackgroundWorkView, GoalView, PlanEntryView, TodoItemView, TodoView } from '@dsc/ui'
import type { CapsuleInput } from './status-model.js'
import {
  capsuleSummary,
  foldBucketKind,
  formatAgo,
  formatCountdown,
  formatDuration,
  longestElapsedMs,
  longestWorkElapsedMs,
  mateElapsedMs,
  todoFocusWindow,
} from './status-model.js'

/** 造一条 todo。只带模型读得到的三件，`parent` 与折叠窗口的判定无关。 */
const todo = (id: string, status: TodoItemView['status'], content = `任务${id}`): TodoItemView => ({
  id,
  content,
  status,
})

/** 造一份清单投影。`done` / `total` 单独覆盖，因为胶囊的「进程进度」档读的就是这两个数。 */
const todoView = (items: TodoItemView[], overrides: Partial<TodoView> = {}): TodoView => ({
  items,
  revision: 1,
  done: 0,
  total: items.length,
  active: null,
  ...overrides,
})

/** 胶囊输入的全空档：每档都从它加上去，能看清「谁是靠什么才出现的」。 */
const emptyInput = (): CapsuleInput => ({
  todos: null,
  goal: null,
  runningMates: 0,
  git: null,
  plans: [],
  runningWorks: [],
  runningTask: null,
  endedMates: 0,
})

/** 一条在跑的后台作业（`startedAt` 只要是个数，胶囊链不读它）。 */
const work = (id: string): BackgroundWorkView => ({ id, kind: 'job', title: `作业${id}`, startedAt: 1 })

/** 目标投影：objective 固定，phase 由用例挑。 */
const goalOf = (phase: GoalView['phase']): GoalView => ({
  objective: '把状态面板补齐',
  phase,
  rounds: 1,
  maxRounds: 8,
  armed: true,
})

const ids = (items: readonly TodoItemView[]): string => items.map((item) => item.id).join(',')

// ── 聚焦窗口 ────────────────────────────────────────────────────────────────

test('6 条以内按原序全显、不折叠', () => {
  // 阈值本身是产品决定（6 条以内一屏放得下）；这里钉的是边界「≤6 不走折叠」。
  const six = [
    todo('a', 'completed'),
    todo('b', 'completed'),
    todo('c', 'in_progress'),
    todo('d', 'pending'),
    todo('e', 'pending'),
    todo('f', 'pending'),
  ]
  const window = todoFocusWindow(six)
  expect(window.compact).toBe(false)
  expect(ids(window.focus)).toBe('a,b,c,d,e,f')
  expect(window.preceding).toHaveLength(0)
  expect(window.following).toHaveLength(0)
})

test('超过 6 条时聚焦进行中那条及其后两条', () => {
  // 9 条、进行中在 0 基第 4 位：窗口取 4..6，正好是「正在做的 + 接下来要做的」。
  const items = [
    todo('0', 'completed'),
    todo('1', 'completed'),
    todo('2', 'completed'),
    todo('3', 'completed'),
    todo('4', 'in_progress'),
    todo('5', 'pending'),
    todo('6', 'pending'),
    todo('7', 'pending'),
    todo('8', 'pending'),
  ]
  const window = todoFocusWindow(items)
  expect(window.compact).toBe(true)
  expect(ids(window.focus)).toBe('4,5,6')
})

test('窗口之前的条目进前桶、之后的进后桶', () => {
  // 桶的边界错了不会让窗口本身难看，却会让折叠行报错数（「前面 4 项」说成 3 项）。
  const items = [
    todo('0', 'completed'),
    todo('1', 'completed'),
    todo('2', 'completed'),
    todo('3', 'completed'),
    todo('4', 'in_progress'),
    todo('5', 'pending'),
    todo('6', 'pending'),
    todo('7', 'pending'),
    todo('8', 'pending'),
  ]
  const window = todoFocusWindow(items)
  expect(ids(window.preceding)).toBe('0,1,2,3')
  expect(ids(window.following)).toBe('7,8')
})

test('进行中在末尾时向前回填成连续三条', () => {
  // 不做回填的话窗口只剩 1 条，面板会突然变矮一截；ZCode 的处理是向前补齐。
  const items = [
    todo('0', 'completed'),
    todo('1', 'completed'),
    todo('2', 'pending'),
    todo('3', 'pending'),
    todo('4', 'pending'),
    todo('5', 'pending'),
    todo('6', 'pending'),
    todo('7', 'in_progress'),
  ]
  const window = todoFocusWindow(items)
  expect(ids(window.focus)).toBe('5,6,7')
  expect(window.following).toHaveLength(0)
})

test('没有进行中时聚焦首个待办', () => {
  const items = [
    todo('0', 'completed'),
    todo('1', 'completed'),
    todo('2', 'pending'),
    todo('3', 'pending'),
    todo('4', 'pending'),
    todo('5', 'pending'),
    todo('6', 'pending'),
  ]
  expect(ids(todoFocusWindow(items).focus)).toBe('2,3,4')
})

test('全办完时取末尾三条，前面五条全进前桶', () => {
  // 没有进行中、也没有待办：给「最近的战果」比给开头那三条更有用。
  const items = Array.from({ length: 8 }, (_, index) => todo(String(index), 'completed'))
  const window = todoFocusWindow(items)
  expect(ids(window.focus)).toBe('5,6,7')
  expect(window.preceding).toHaveLength(5)
})

test('窗口保持 snapshot 原序（是原数组的一段连续切片）', () => {
  // 用引用相等而不是 id 相等：重排过的窗口即使 id 集合一样，也会让用户看到顺序跳动。
  const items = [
    todo('0', 'completed'),
    todo('1', 'completed'),
    todo('2', 'completed'),
    todo('3', 'completed'),
    todo('4', 'in_progress'),
    todo('5', 'pending'),
    todo('6', 'pending'),
    todo('7', 'pending'),
    todo('8', 'pending'),
  ]
  const window = todoFocusWindow(items)
  expect(window.focus.every((item, index) => items[4 + index] === item)).toBe(true)
})

// ── 折叠桶语义 ──────────────────────────────────────────────────────────────

test('前桶全办完 → completed', () => {
  expect(foldBucketKind([todo('0', 'completed'), todo('1', 'completed')], 'preceding')).toBe('completed')
})

test('前桶里 cancelled 也算办完', () => {
  // 完成口径刻意包含 cancelled：「取消」同样意味着不用再盯，不该退化成中性的「前面 n 项」。
  expect(foldBucketKind([todo('0', 'completed'), todo('1', 'cancelled')], 'preceding')).toBe('completed')
})

test('前桶混着待办 → earlier', () => {
  // 只要还有没办完的，就不能说「已完成 n 项」——那是在虚报状态。
  expect(foldBucketKind([todo('0', 'completed'), todo('1', 'pending')], 'preceding')).toBe('earlier')
})

test('后桶全待办 → waiting', () => {
  expect(foldBucketKind([todo('0', 'pending'), todo('1', 'pending')], 'following')).toBe('waiting')
})

test('后桶混着已办完的 → later', () => {
  expect(foldBucketKind([todo('0', 'pending'), todo('1', 'completed')], 'following')).toBe('later')
})

// ── 胶囊十档优先级链 ────────────────────────────────────────────────────────

test('所有数据面都空时不出胶囊', () => {
  // 全空给 null，面板整块不画——不是画一条「暂无状态」的空壳。
  expect(capsuleSummary(emptyInput())).toBeNull()
})

test('在跑的定点任务压过一切（第一档）', () => {
  expect(capsuleSummary({ ...emptyInput(), runningTask: '每天早报' })).toEqual({
    kind: 'workflow',
    text: '每天早报',
  })
})

test('当前待办压过后台活兜底', () => {
  // 主代理此刻在做的事比「后台还有活」更该占位。
  const todos = todoView(
    [todo('0', 'pending'), todo('1', 'in_progress', '正在做这条'), todo('2', 'pending')],
    { active: '正在做这条' },
  )
  expect(capsuleSummary({ ...emptyInput(), todos, runningWorks: [work('job-1')] })).toEqual({
    kind: 'todo-current',
    text: '正在做这条',
  })
})

test('在跑的定点任务压过当前待办', () => {
  // 这是 ZCode 的第一档位；dsc 用定点任务代工作流，优先级不变。
  const todos = todoView(
    [todo('0', 'pending'), todo('1', 'in_progress', '正在做这条'), todo('2', 'pending')],
    { active: '正在做这条' },
  )
  expect(capsuleSummary({ ...emptyInput(), todos, runningTask: '早报' })).toEqual({
    kind: 'workflow',
    text: '早报',
  })
})

test('没有待办时未完成的目标排第二', () => {
  expect(capsuleSummary({ ...emptyInput(), goal: goalOf('active'), runningMates: 1 })).toEqual({
    kind: 'goal',
    text: '把状态面板补齐',
    phase: 'active',
  })
})

test('未完成的目标排在 Git 变更之前', () => {
  // 目标还在办是「有主线」，Git 只是「有改动」：这是链上的先后，不是并列。
  expect(
    capsuleSummary({ ...emptyInput(), goal: goalOf('active'), git: { added: 12, removed: 3, files: 4 } }),
  ).toEqual({ kind: 'goal', text: '把状态面板补齐', phase: 'active' })
})

test('没有别的状态时 Git 变更自己撑胶囊（报增删与文件数）', () => {
  expect(capsuleSummary({ ...emptyInput(), git: { added: 12, removed: 3, files: 4 } })).toEqual({
    kind: 'git',
    added: 12,
    removed: 3,
    files: 4,
  })
})

test('Git 变更排在已完成目标之前', () => {
  // ZCode 的 git 档在 done goal 之前：改动是「还要做的事」，已完成的目标是「过去的事」。
  expect(
    capsuleSummary({ ...emptyInput(), goal: goalOf('complete'), git: { added: 1, removed: 0, files: 1 } }),
  ).toEqual({ kind: 'git', added: 1, removed: 0, files: 1 })
})

test('没有 Git 变更时已完成目标自己出档', () => {
  expect(capsuleSummary({ ...emptyInput(), goal: goalOf('complete') })).toEqual({
    kind: 'goal-done',
    text: '把状态面板补齐',
  })
})

test('没有当前项时报最后一条办完的待办', () => {
  const todos = todoView([todo('0', 'completed', '办完的一'), todo('1', 'completed', '办完的二')], {
    done: 2,
    total: 2,
  })
  expect(capsuleSummary({ ...emptyInput(), todos })).toEqual({ kind: 'todo-done', text: '办完的二' })
})

test('全取消（无当前、无办完）时落到进程进度', () => {
  const todos = todoView([todo('0', 'cancelled'), todo('1', 'cancelled')], { done: 0, total: 2, revision: 3 })
  expect(capsuleSummary({ ...emptyInput(), todos })).toEqual({ kind: 'progress', done: 0, total: 2 })
})

test('计划目录档报最新一份的标题（plans[0] 就是最新）', () => {
  // 目录约定「最新在前」，胶囊只读第一条——不要在这里再排一次序，排序是投影的事。
  const plans: PlanEntryView[] = [
    { file: 'D:\\w\\.dsc\\plans\\b.md', title: '计划乙', at: 2 },
    { file: 'D:\\w\\.dsc\\plans\\a.md', title: '计划甲', at: 1 },
  ]
  expect(capsuleSummary({ ...emptyInput(), plans })).toEqual({ kind: 'plan', text: '计划乙' })
})

test('只有后台活时报作业数', () => {
  expect(capsuleSummary({ ...emptyInput(), runningWorks: [work('job-1')] })).toEqual({
    kind: 'running',
    mates: 0,
    works: 1,
  })
})

test('混合（队友 + 后台活）时两端都带上', () => {
  // 只报一边会让用户以为另一边没了；这一档的语义是「同时在跑多少」。
  expect(capsuleSummary({ ...emptyInput(), runningMates: 2, runningWorks: [work('job-1')] })).toEqual({
    kind: 'running',
    mates: 2,
    works: 1,
  })
})

test('只有已结束队友时兜底报一条', () => {
  // dsc 对 ZCode 的有意偏离：去掉标题栏团队钮之后，面板是已结束名册的唯一入口。
  expect(capsuleSummary({ ...emptyInput(), endedMates: 3 })).toEqual({ kind: 'mates-ended', count: 3 })
})

test('已结束队友不压过任何主状态', () => {
  // 它是最末一档兜底，有主状态时必须让位。
  const todos = todoView([todo('0', 'in_progress', '正在做这条')])
  expect(capsuleSummary({ ...emptyInput(), endedMates: 3, todos })).toEqual({
    kind: 'todo-current',
    text: '正在做这条',
  })
})

// ── 时间口径 ────────────────────────────────────────────────────────────────

test('90 秒格式化成 1分30秒', () => {
  expect(formatDuration(90_000)).toBe('1分30秒')
})

test('不足一分钟时不带分位（8 秒 → 8秒）', () => {
  expect(formatDuration(8_000)).toBe('8秒')
})

test('超过一小时时只到分（3.7 小时 → 3小时42分）', () => {
  // 面板上的时长不需要秒级精度，秒位在小时档被舍掉——这条钉的是「舍，不是截断成别的」。
  expect(formatDuration(3.7 * 3600_000)).toBe('3小时42分')
})

test('负数与 NaN 给 null（不编一个数出来）', () => {
  expect(formatDuration(-1)).toBeNull()
  expect(formatDuration(Number.NaN)).toBeNull()
})

test('还在跑的队友按 now 算已运行', () => {
  expect(mateElapsedMs({ startedAt: 1_000 }, 6_000)).toBe(5_000)
})

test('收工的队友冻结在 finishedAt', () => {
  // 不冻结的话，面板每秒刷新都会把「已跑 3 秒」涨成 1 分钟，全是假读数。
  expect(mateElapsedMs({ startedAt: 1_000, finishedAt: 4_000 }, 60_000)).toBe(3_000)
})

test('最长运行取最大的一条', () => {
  expect(longestElapsedMs([{ startedAt: 1_000, finishedAt: 4_000 }, { startedAt: 1_000 }], 6_000)).toBe(5_000)
})

test('后台活取最长已运行', () => {
  expect(longestWorkElapsedMs([{ startedAt: 1_000 }, { startedAt: 3_000 }], 10_000)).toBe(9_000)
})

test('倒计时：90 秒 → 1分30秒后', () => {
  expect(formatCountdown(1_000 + 90_000, 1_000)).toBe('1分30秒后')
})

test('倒计时：已过点 → 已到点', () => {
  expect(formatCountdown(500, 1_000)).toBe('已到点')
})

test('倒计时：不足一秒 → 即将', () => {
  // 「0 秒后」这种读数是噪声；差一点点就该说「即将」。
  expect(formatCountdown(1_400, 1_000)).toBe('即将')
})

test('倒计时：没有排期 → null', () => {
  // null 是「没有排期」这件事本身，文案由调用方给；这里不能编一个「已到点」。
  expect(formatCountdown(null, 1_000)).toBeNull()
})

test('多久前：不到一分钟 → 刚刚', () => {
  // 列表按分钟级刷新，给秒级读数只会闪。
  expect(formatAgo(99_000, 100_000)).toBe('刚刚')
})

test('多久前：3.2 小时 → 3小时12分前', () => {
  expect(formatAgo(100_000, 100_000 + 3.2 * 3600_000)).toBe('3小时12分前')
})

test('多久前：未来时刻 → null', () => {
  // 系统时钟漂移会让「提交时刻」比 now 还新；那不是「刚刚」，是不该显示。
  expect(formatAgo(2_000, 1_000)).toBeNull()
})
