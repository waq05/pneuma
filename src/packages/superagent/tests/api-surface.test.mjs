/**
 * `app/api.ts` 快照面的包级测试：设置历史投影、最近动态、以及「候选那一格已经没有了」。
 *
 * 为什么这三件事要钉：它们都不抛错，错了只是界面静默少一块——
 *   - `settingsHistory` 不给 → 设置页「最近变更」整块消失；
 *   - `recent` 恒空 → 概览「最近动态」与发布页「最近 5 条」永远空；
 *   - `recent` 的 `at` 拿读快照的时刻冒充 → 动态按「刷新时间」排序，看起来像刚发生。
 * 所以每条断言钉的是「投影按规则给出的值」，不是「函数不崩」。
 *
 * 假件只到 runtime 一层：`store` 用真 SQLite（临时库），`sources` / `links` / `health` /
 * `setupProblem` 是最小桩——`surface()` 只从它们读开关、链接与体检项。不 import 任何宿主
 * 装配（`app/runtime.ts`），也不起会话。这里 import 的是 `lib/` 的构建产物，跑之前先
 * `pnpm run build`。
 *
 * @module @pneuma/superagent/tests/api-surface
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, test } from 'node:test'

const { PanelApi } = await import('../../../../lib/packages/superagent/app/api.js')
const { Store } = await import('../../../../lib/packages/superagent/app/store.js')

/** 通过数：`package-tests.mjs` 只从最后一行「通过 N」里读断言数。 */
let passed = 0

after(() => {
  console.log(`通过 ${passed}`)
})

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 临时库：每个用例一个，收尾关库并删目录。 */
let directory
let store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-api-surface-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

/**
 * 一版设置的底稿：只写本文件用到的字段，其余由 `SettingsSchema` 补默认值
 * （`policy.rules` 的两条默认规则在每次保存里都一样，不会刷出差异行）。
 */
const base = {
  paused: false,
  sources: { github: { enabled: false } },
  eval: { mode: 'observe' },
  executor: { prepare: '' },
}

/** 最小假 runtime：真 store + 只看被 `surface()` 读到的几个成员。 */
function runtimeOf(overrides = {}) {
  return {
    store,
    // 两个来源都没装 kind：`sourceViews` 回落到设置里的 `enabled`。
    sources: { instance: () => undefined, kind: () => undefined },
    links: () => ({ url: '', label: { zh: '', en: '' } }),
    health: {},
    setupProblem: undefined,
    ...overrides,
  }
}

const surfaceOf = (overrides) => new PanelApi(runtimeOf(overrides)).surface()

/** 记一条通过：深比较（对象 / 数组 / 原始值都适用）。 */
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  passed += 1
}

/** 记一条通过：布尔条件。 */
function ok(value, message) {
  assert.ok(value, message)
  passed += 1
}

/** 一张工单：`ended` / `summary` 可省，其余字段只填视图层要读的。 */
let sequence = 0
function ticket({ title, ended, summary } = {}) {
  sequence += 1
  const id = sequence.toString(16).padStart(32, '0')
  const at = '2026-01-01T00:00:00.000Z'
  store.tickets.save({
    id,
    title,
    decisionId: `decision-${id}`,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'manual', id: 'operator' }, scope: '' },
    channels: [],
    ...(ended === undefined ? {} : { ended }),
    assignments: summary === undefined ? [] : [{ id: `${id}-a`, state: 'ended', report: { state: 'ready', summary } }],
    inputs: [],
    undelivered: [],
    createdAt: at,
    updatedAt: at,
    origin: { triggerId: 'trigger', triggerIds: ['trigger'] },
  })
  return id
}

// ── 用例：settingsHistory ──────────────────────────────────────────────────

test('相邻 revision 的每个改动字段各出一行，from/to 用旧展示口径，新的在前', () => {
  store.saveSettings({ ...base })
  store.saveSettings({ ...base, eval: { mode: 'auto' }, executor: { prepare: 'pnpm test' } })
  store.saveSettings({ ...base, eval: { mode: 'auto' }, executor: { prepare: 'pnpm test' }, sources: { github: { enabled: true } } })
  const surface = surfaceOf()
  const history = surface.settingsHistory

  // 三版设置、两次相邻比较：rev3→2 改一个字段，rev2→1 改两个字段。
  equal(history.map((change) => change.key), ['sources.github.enabled', 'eval.mode', 'executor.prepare'])
  equal(history.map((change) => [change.from, change.to]), [
    ['false', 'true'],
    ['observe', 'auto'],
    ['', 'pnpm test'],
  ])
  // 新的在前：version 递减且唯一（界面拿它当 React key）。
  equal(history.map((change) => change.version), [3, 2, 1])
  equal(new Set(history.map((change) => change.version)).size, 3)
  // `at` 是改动那一版的保存时刻，不是读快照的时刻。
  equal(history[0].at, store.settingsHistory(1)[0].savedAt)
  ok(history.every((change) => typeof change.at === 'string' && change.at.endsWith('Z')))
})

test('只跟相邻 revision 比：跨多版的字段不会重复出现，也不会串出中间没改的差异', () => {
  // rev1 observe → rev2 auto（mode 改）→ rev3 只改 prepare（mode 不动）→ rev4 再改 prepare。
  store.saveSettings({ ...base })
  store.saveSettings({ ...base, eval: { mode: 'auto' } })
  store.saveSettings({ ...base, eval: { mode: 'auto' }, executor: { prepare: 'pnpm a' } })
  store.saveSettings({ ...base, eval: { mode: 'auto' }, executor: { prepare: 'pnpm b' } })
  const history = surfaceOf().settingsHistory

  // 与「每版都跟最新版比」的区别就在这条：mode 只出一次（rev2 那次），不是三次。
  equal(history.filter((change) => change.key === 'eval.mode').length, 1)
  equal(history.filter((change) => change.key === 'eval.mode').map((change) => [change.from, change.to]), [['observe', 'auto']])
  // prepare 也只出它真正变化的两次（'' → a → b），没有 '' → b 这种跨版比较。
  equal(history.filter((change) => change.key === 'executor.prepare').map((change) => [change.from, change.to]),
    [['pnpm a', 'pnpm b'], ['', 'pnpm a']])
})

test('历史被裁断号时整对跳过：缺了中间那版，算出来的差异不是「这次保存改了什么」', () => {
  store.saveSettings({ ...base })
  store.saveSettings({ ...base, eval: { mode: 'auto' } })
  store.saveSettings({ ...base, eval: { mode: 'auto' }, executor: { prepare: 'pnpm x' } })
  const read = store.settingsHistory.bind(store)
  const all = read(30)
  // 只留 rev3 与 rev1：中间断了 rev2，这一对不能相减。
  store.settingsHistory = () => [all[0], all[2]]
  try {
    equal(surfaceOf().settingsHistory, [])
  } finally {
    store.settingsHistory = read
  }
})

// ── 用例：recent ───────────────────────────────────────────────────────────

test('recent 的结局词按 outcome 映射，未知结局原样显示，摘要附在后面', () => {
  const cases = [
    ['completed', '已完成'],
    ['merged', '已合并'],
    ['closed', '已关闭'],
    ['dropped', '已放弃'],
    ['stopped', '已停止'],
  ]
  cases.forEach(([outcome], index) => {
    ticket({
      title: `t-${outcome}`,
      ended: { at: `2026-01-01T00:00:0${String(index)}.000Z`, by: 'executor', outcome },
      summary: `summary ${outcome}`,
    })
  })
  // 旧库 / 新版本里可能写出映射表以外的结局：原样用 outcome，不吞成「已结束」。
  ticket({ title: 't-cancelled', ended: { at: '2026-01-01T00:00:09.000Z', by: 'executor', outcome: 'cancelled' } })
  const recent = surfaceOf().recent

  equal(recent.map((row) => row.text), [
    '工单「t-completed」已完成：summary completed',
    '工单「t-merged」已合并：summary merged',
    '工单「t-closed」已关闭：summary closed',
    '工单「t-dropped」已放弃：summary dropped',
    '工单「t-stopped」已停止：summary stopped',
    '工单「t-cancelled」cancelled',
  ])
  equal(recent.map((row) => row.at), [
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:01.000Z',
    '2026-01-01T00:00:02.000Z',
    '2026-01-01T00:00:03.000Z',
    '2026-01-01T00:00:04.000Z',
    '2026-01-01T00:00:09.000Z',
  ])
})

test('recent 的摘要截到 120 字，并把换行压成一行', () => {
  ticket({ title: 'long', ended: { at: '2026-01-01T00:00:00.000Z', by: 'executor', outcome: 'completed' }, summary: `${'x'.repeat(150)}\nsecond line` })
  ticket({ title: 'flat', ended: { at: '2026-01-01T00:00:01.000Z', by: 'executor', outcome: 'completed' }, summary: 'first\nsecond' })
  const recent = surfaceOf().recent

  equal(recent[0].text, `工单「long」已完成：${'x'.repeat(120)}…`)
  equal(recent[1].text, '工单「flat」已完成：first second')
})

test('recent 按 ended.at 升序、最多 20 条，at 就是结束时刻', () => {
  // 25 张已结束工单，插入顺序与结束时刻相反：投影必须按 ended.at 排，不能按库里行序。
  const stamps = Array.from({ length: 25 }, (_, index) => `2026-02-01T00:00:${String(index).padStart(2, '0')}.000Z`)
  ;[...stamps.keys()].reverse().forEach((index) => {
    ticket({ title: `t${index}`, ended: { at: stamps[index], by: 'executor', outcome: 'completed' } })
  })
  // 一张没结束的不算动态。
  ticket({ title: 'open' })
  const recent = surfaceOf().recent

  equal(recent.length, 20)
  // 超了丢最旧的：留下的是第 5~24 条。
  equal(recent[0].at, stamps[5])
  equal(recent[19].at, stamps[24])
  equal(recent[0].text, '工单「t5」已完成')
  ok(recent.every((row, index) => index === 0 || recent[index - 1].at <= row.at))
  ok(recent.every((row) => stamps.slice(5).includes(row.at)))
})

// ── 用例：快照面本身 ───────────────────────────────────────────────────────

test('surface 不再有 candidates 键，且空库时 settingsHistory 是空数组（功能在、只是没记录）', () => {
  const surface = surfaceOf()
  equal('candidates' in surface, false)
  equal(surface.settingsHistory, [])
  equal(surface.recent, [])
  equal(surface.tickets, [])
})
