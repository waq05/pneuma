/**
 * `checks`（分组多选）控件在设置面板这一半的契约与形状。
 *
 * 为什么单独钉这几条：这个控件是给「允许 Agent 为子智能体选择模型 + 授权模型列表」
 * 铺路的**契约基础设施**——声明形状、值形状、写回链路、文案键任何一处对不上，
 * 后面接真数据时才会暴露，而那时排查要跨契约 / 界面 / 宿主三层。这里在源头钉住：
 *
 *   1. 契约里有 `checks` 分支与 `SettingsCheckOption`，且 `SettingsValue` 收得下
 *      `string[]`（要过 IPC，必须能 JSON 往返）；
 *   2. 面板的 render(field) 真有一支 `checks`：分组标题、复选行、灰色 detail、
 *      带边框的可滚动清单，值通过现有 `commit(field.key, value)` 写回；
 *   3. 新文案在中英两份字典里都在（`ui-locale-test.mjs` 的判据同款，但那是全仓闸，
 *      这里让本包自己的包测试也能单独跑出来）。
 *
 * 运行：node src/packages/ui-settings/tests/settings-checks.test.mjs（读源码，不需要先编译；
 * 只有 JSON 往返那一段是纯数据）。
 *
 * @module @pneuma/ui-settings/tests/settings-checks
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
/** 按相对本文件的路径读 JSON。 */
const readJson = (rel) => JSON.parse(read(rel))

let passed = 0

test('契约：SettingsCheckOption 与 checks 分支的形状', () => {
  const contract = read('../../../contract/settings.ts')
  // 为什么钉：这两个形状是宿主编排设置页时唯一能写的声明面，少了宿主那头就没法声明多选。
  assert.ok(contract.includes('export interface SettingsCheckOption'), '契约里没有 SettingsCheckOption')
  assert.ok(/value: string\s*\n\s*label: string\s*\n\s*detail\?: string/.test(contract), 'SettingsCheckOption 缺 value/label/detail 之一')
  assert.ok(contract.includes("type: 'checks'"), "SettingsField 里没有 type: 'checks' 分支")
  assert.ok(/type: 'checks'[\s\S]{0,240}?groups: SettingsCheckGroup\[\]/.test(contract), 'checks 分支缺 groups 声明')
  assert.ok(contract.includes('export interface SettingsCheckGroup'), '契约里没有 SettingsCheckGroup')
  passed += 1
})

test('契约：SettingsValue 收得下 string[]（多选值可 JSON 往返）', () => {
  const contract = read('../../../contract/settings.ts')
  // 为什么钉：值的形状决定 IPC 能不能过。`setSettingValue` 那个参数是 kind:'json'，
  // 只要值是普通数组就过得了；写成 Set/位掩码就会在序列化时丢掉或变味。
  assert.ok(/export type SettingsValue = [^\n]*\| string\[\]/.test(contract), 'SettingsValue 没有 string[] 这一支')
  const payload = { allowedModels: ['acme/fast', 'acme/slow'] }
  const roundTrip = JSON.parse(JSON.stringify(payload))
  assert.deepEqual(roundTrip, payload)
  assert.ok(Array.isArray(roundTrip.allowedModels))
  assert.equal(roundTrip.allowedModels.every((value) => typeof value === 'string'), true)
  passed += 1
})

test('面板渲染：分组标题 + 复选行 + detail 副说明 + 边框滚动清单 + commit 写回', () => {
  const ui = read('../ui/ui.tsx')
  // 为什么钉：控件长什么样是这一版的主要交付物，缺一处就等于没实现。
  assert.ok(ui.includes("field.type === 'checks'"), 'render(field) 里没有 checks 分支')
  assert.ok(ui.includes('field.groups.flatMap'), 'checks 分支没有遍历分组')
  assert.ok(ui.includes('option.detail'), 'checks 分支没有画 detail 副说明')
  assert.ok(ui.includes("role=\"group\""), '清单没有 role=group（读屏拿不到这是一组多选）')
  assert.ok(ui.includes("overflowY: 'auto'"), '长清单没有可滚动（超出 maxHeight 会被切掉）')
  assert.ok(ui.includes("type=\"checkbox\""), '没有画复选框')
  // 写回必须走现有 commit 链路（不另造一条 setSettingValue 直调），否则失败回执/回读会缺席。
  assert.ok(/commit\(field\.key, on \? \[\.\.\.selected, value\]/.test(ui), '勾选没有通过 commit(key, value) 写回')
  passed += 1
})

test('文案：checks 的四个键在中英两份字典里都有，英文无汉字', () => {
  const zh = readJson('../locale/ui.zh.json')
  const en = readJson('../locale/ui.en.json')
  const ui = read('../ui/ui.tsx')
  const keys = Object.keys(zh)
    .filter((key) => key.startsWith('settings.ui.checks.'))
    .sort()
  // 为什么钉：界面半不许有硬编码中文（ui-locale-test.mjs 的全仓判据），键少一条就回落成键名。
  assert.deepEqual(keys, ['settings.ui.checks.count', 'settings.ui.checks.empty', 'settings.ui.checks.emptyGroup', 'settings.ui.checks.strayGroup'])
  assert.deepEqual(Object.keys(en).filter((key) => key.startsWith('settings.ui.checks.')).sort(), keys)
  for (const key of keys) {
    assert.ok(ui.includes(`t('${key}'`), `ui.tsx 没有用到文案键 ${key}`)
    assert.ok(typeof zh[key] === 'string' && zh[key] !== '', `中文缺值：${key}`)
    assert.ok(typeof en[key] === 'string' && en[key] !== '', `英文缺值：${key}`)
    assert.equal(/[\u4e00-\u9fff]/.test(en[key]), false, `英文值里有汉字：${key}`)
  }
  passed += 1
})

// 断言计数只给 scripts/package-tests.mjs 显示；判据始终是退出码。
after(() => {
  console.log(`通过 ${String(passed)} 项`)
})
