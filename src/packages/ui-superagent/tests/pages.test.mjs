/**
 * `@pneuma/ui-superagent` 的页面级测试：钉「五个真页面接上去之后」仍然成立的静态事实。
 *
 * 只测不渲染 React 的东西（与其它界面包的包级测试同一档）：字典键集、字面量取词的键、
 * 两个槽注册、页内信号的存放位置、五个写方法的入参形状、清理按钮的可用条件。
 * 界面真的能不能点开要整套壳，归 `scripts/` 的集成探针与本包的 ui-locale-test。
 *
 * 为什么读源码而不 import `lib/`：本轮明确不跑构建，包级测试若依赖 `lib/` 会在未构建
 * 的检出上直接红。这些不变量全是「源码里写没写」，读文本判得同样准。
 *
 * @module @pneuma/ui-superagent/tests/pages
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test, after } from 'node:test'

/** 按相对本文件的路径读文本。 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 界面半的全部源码（`ui/` 下的 .ts / .tsx）。 */
const uiFiles = readdirSync(new URL('../ui/', import.meta.url)).filter((name) => /\.tsx?$/.test(name))

/** 汉字范围：与 `scripts/ui-locale-test.mjs` 同一档（只判常用区）。 */
const CJK = /[\u4e00-\u9fff]/

let passed = 0

test('字典：zh / en 键集完全一致，中文非空，英文里没有汉字', () => {
  const zh = JSON.parse(read('../locale/ui.zh.json'))
  const en = JSON.parse(read('../locale/ui.en.json'))
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh 与 en 的键集不一致')
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(typeof value, 'string', `ui.zh.json 的 ${key} 不是字符串`)
    assert.notEqual(value.trim(), '', `ui.zh.json 的 ${key} 是空串`)
  }
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', `ui.en.json 的 ${key} 不是字符串`)
    assert.ok(!CJK.test(value), `ui.en.json 的 ${key} 还是中文`)
  }
  passed += 1
})

test('取词：源码里每个字面量 t(...) 的键都在字典里，字典里也没有没人用的键', () => {
  const zh = JSON.parse(read('../locale/ui.zh.json'))
  const used = new Set()
  for (const name of uiFiles) {
    const source = read(`../ui/${name}`)
    // 只认 `t('…')` 的字面量写法：动态拼键在这条闸下就是「没人用」，与 ui-locale-test 同口径。
    for (const match of source.matchAll(/(?<![A-Za-z0-9_$])t\('([^']+)'/g)) {
      if (match[1].startsWith('superagent.')) used.add(match[1])
    }
  }
  assert.deepEqual([...used].sort(), Object.keys(zh).sort(), '源码用的键与 ui.zh.json 的键集不一致')
  passed += 1
})

test('装配：侧栏 order 2、整页 order 30，页条目在组件体里比对 shellPage', () => {
  const source = read('../ui/ui.tsx')
  assert.match(source, /register\('shell\.sidebar',\s*\{ id: 'superagent\.entry', order: 2 \}/)
  assert.match(source, /register\('shell\.page',\s*\{ id: 'superagent\.page', order: 30 \}/)
  assert.match(source, /const PAGE = 'superagent'/)
  assert.match(source, /useShellPage\(\)/)
  passed += 1
})

test('页签：三页状态是 state.ts 的模块级信号，ui.tsx 挂上三个页面组件', () => {
  const state = read('../ui/state.ts')
  // 页签必须活过整页卸载（app.tsx:477），所以不能是 useState。
  assert.match(state, /createSignal<SuperagentTab>\('publish'\)/)
  assert.match(state, /const selectedSignal = createSignal<string \| null>\(null\)/)
  assert.match(state, /const highlightSignal = createSignal<string \| null>\(null\)/)
  assert.match(state, /useSyncExternalStore\(tabSignal\.subscribe/)
  // 页内位置不能落进组件 state：这里只查 import（注释里出现 useState 是在讲这条规矩）。
  assert.ok(!/import\s*\{[^}]*\buseState\b[^}]*\}\s*from\s*'react'/.test(state), 'state.ts 不该 import useState')

  const source = read('../ui/ui.tsx')
  for (const name of ['PublishPage', 'TicketsPage', 'SettingsPage']) {
    assert.ok(source.includes(name), `ui.tsx 没有挂 ${name}`)
  }
  passed += 1
})

test('写动作：发布传一个对象，四个按 id 的动作统一传 { id }', () => {
  const publish = read('../ui/publish.tsx')
  assert.ok(publish.includes("invoke<string>('superagentPublish', [input])"), '发布没有把对象当唯一实参')
  assert.match(publish, /title: trimmed/)
  assert.match(publish, /body: body\.trim\(\)/)

  const detail = read('../ui/detail.tsx')
  for (const method of ['superagentStopTicket', 'superagentRetryTicket', 'superagentCleanWorktree', 'superagentPeekSession']) {
    assert.ok(detail.includes(`'${method}'`), `detail.tsx 没有调 ${method}`)
  }
  assert.ok(detail.includes('[{ id }]'), '四个按 id 的动作没有统一传 { id }')
  passed += 1
})

test('清理：只有 ended 时可点，且点之前过二次确认', () => {
  const detail = read('../ui/detail.tsx')
  assert.match(detail, /const ended = ticket\.stage\.stage === 'ended'/)
  assert.match(detail, /disabled=\{busy !== null \|\| !ended\}/)
  assert.match(detail, /confirmAction\(\{/)
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
