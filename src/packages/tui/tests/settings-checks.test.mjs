/**
 * TUI 设置页对 `checks`（分组多选）字段的行模型支持。
 *
 * 为什么单开一条包级测试：TUI 的行模型（`settings-model.ts`）是键盘焦点、滚动窗口与
 * 鼠标行号映射共用的几何表，错一行就是「焦点落在看不见的行上」。这里直接 import
 * 构建产物里的纯函数，钉住三件事：
 *
 *   1. `checks` 字段摊成「标题 + 组标题 + 每个可勾项一行」，空组给占位行、清单外的
 *      已选值另收一组（能看见也取消得掉）；
 *   2. 只有可勾项能拿焦点（组标题/标题行不抢 ↑↓），选中态从 values 现算、错形状不崩；
 *   3. 未知字段类型落回普通 field 行而不是抛异常（旧 TUI 遇到新宿主的新控件时，
 *      最坏也只是画成一行文本，不能整页白掉）。
 *
 * 运行前提：先 `pnpm run build`（本测 import 的是 lib/ 下的编译产物）。
 * 运行：node src/packages/tui/tests/settings-checks.test.mjs
 *
 * @module @pneuma/tui/tests/settings-checks
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 读构建产物里的行模型（纯函数，无 ink / react 依赖）。 */
const model = await import('../../../../lib/packages/tui/app/settings-model.js')
const { buildSettingsRows, checksSelected, focusableRows, isFocusableRow } = model

/** 按相对本文件的路径读源码（用来钉「组件里真接了键盘动作」）。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

let passed = 0

/** 一个带 checks 字段的分区（含空组 + 清单外的已选值，覆盖两种兜底）。 */
const section = {
  id: 'demo',
  title: '演示',
  order: 1,
  builtin: false,
  custom: false,
  fields: [
    {
      type: 'checks',
      key: 'allowedModels',
      label: '授权模型',
      help: '勾上的模型才允许子智能体使用',
      groups: [
        {
          title: 'Acme',
          options: [
            { value: 'acme/fast', label: 'Fast', detail: 'acme/fast' },
            { value: 'acme/slow', label: 'Slow', detail: 'acme/slow' },
          ],
        },
        { title: '空组', options: [] },
      ],
    },
  ],
}

test('checks 摊成标题 / 组标题 / 可勾行，空组与清单外的值都有兜底', () => {
  const values = { demo: { allowedModels: ['acme/fast', 'gone/model'] } }
  const rows = buildSettingsRows([section], 'demo', null, values)
  const kinds = rows.map((row) => row.kind)
  // 为什么钉：行序就是屏幕上的顺序，错位等于把组标题配给别家的选项。
  assert.deepEqual(kinds, [
    'card-top',
    'checks-head',
    'checks-group',
    'checks-option',
    'checks-option',
    'checks-group',
    'checks-group',
    'checks-option',
    'card-bottom',
  ])

  const options = rows.filter((row) => row.kind === 'checks-option')
  assert.deepEqual(options.map((row) => row.value), ['acme/fast', 'acme/slow', 'gone/model'])
  assert.deepEqual(options.map((row) => row.label), ['Fast', 'Slow', 'gone/model'])
  assert.equal(options[0].detail, 'acme/fast')
  const groups = rows.filter((row) => row.kind === 'checks-group')
  // 空组不是「消失」，是画一句占位：声明了组却没有项，那多半是数据还没装填。
  assert.deepEqual(
    groups.map((row) => [row.title, row.empty]),
    [
      ['Acme', false],
      ['空组', true],
      ['其他（不在清单里）', false],
    ],
  )
  passed += 1
})

test('空组标记；未选时没有组外兜底组', () => {
  const emptyGroupSection = {
    ...section,
    fields: [{ type: 'checks', key: 'allowedModels', label: '授权模型', groups: [{ title: '空组', options: [] }] }],
  }
  const rows = buildSettingsRows([emptyGroupSection], 'demo', null, { demo: { allowedModels: [] } })
  const group = rows.find((row) => row.kind === 'checks-group')
  assert.equal(group.empty, true)
  assert.equal(rows.filter((row) => row.kind === 'checks-group').length, 1)
  // 没勾任何东西时选中值数组是空数组（不是 undefined），宿主拿到的就是「未选」。
  assert.deepEqual(checksSelected({ allowedModels: [] }, 'allowedModels'), [])
  passed += 1
})

test('只有可勾项拿焦点：标题行与组标题不抢 ↑↓', () => {
  const rows = buildSettingsRows([section], 'demo', null, { demo: { allowedModels: ['acme/fast'] } })
  const focusables = focusableRows(rows, [section])
  const focusedKinds = focusables.map((index) => rows[index].kind)
  assert.deepEqual(focusedKinds, ['checks-option', 'checks-option'])
  assert.equal(
    isFocusableRow(rows.find((row) => row.kind === 'checks-head'), section.fields),
    false,
  )
  passed += 1
})

test('values 缺失 / 形状不对时不崩，按「一个都没选」画', () => {
  // 旧宿主 / 手改过的值：没给、给了字符串、数组里混进非字符串——都不许把设置页打崩。
  assert.deepEqual(checksSelected(undefined, 'allowedModels'), [])
  assert.deepEqual(checksSelected({ allowedModels: 'acme/fast' }, 'allowedModels'), [])
  assert.deepEqual(checksSelected({ allowedModels: ['acme/fast', 7, null] }, 'allowedModels'), ['acme/fast'])
  const rows = buildSettingsRows([section], 'demo', null, undefined)
  assert.ok(rows.some((row) => row.kind === 'checks-option'))
  passed += 1
})

test('未知字段类型落回普通 field 行（不抛异常、不白屏）', () => {
  const future = {
    id: 'future',
    title: '未来',
    order: 2,
    builtin: false,
    custom: false,
    fields: [{ type: 'holo-slider', key: 'mystery', label: '未来的控件' }],
  }
  // 为什么钉：契约将来加类型时，帧冻结的旧 TUI 只会收到「不认识的 type」；硬编 switch
  // 是最容易崩的地方。这里要求它退化成一行普通 field（可聚焦但点了没动作），而不是抛。
  const rows = buildSettingsRows([future], 'future', null, {})
  assert.equal(rows.some((row) => row.kind === 'field'), true)
  assert.deepEqual(focusableRows(rows, [future]).length, 1)
  passed += 1
})

test('键盘接好了：空格翻转、Enter 翻转、点击也翻转，组件里各有一处', () => {
  const app = read('../app/App.tsx')
  // 为什么钉：行模型只是几何；真按得动要看 App 的键盘/鼠标分支有没有接上。
  // 空格那条要贴着 checks-option 判——App 里别处也有 `input === ' '` 的分支（提问卡），
  // 只搜字符串会把「没接上」判成通过。
  assert.ok(/if \(input === ' '\) \{[\s\S]{0,300}?checks-option/.test(app), '键盘分支没有接可勾项的空格翻转')
  assert.ok(app.includes("row?.kind === 'checks-option'"), 'App 没有处理可勾项行')
  assert.ok(app.includes('toggleSettingsCheck'), 'App 没有翻转函数')
  assert.ok(app.includes("target.kind !== 'checks-option'"), '鼠标点击没有放行可勾项行')
  assert.ok(read('../app/SettingsOverlay.tsx').includes("case 'checks-option'"), 'Overlay 没有画可勾项行')
  passed += 1
})

// 断言计数只给 scripts/package-tests.mjs 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
