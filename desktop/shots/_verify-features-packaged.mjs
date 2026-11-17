/**
 * 打包产物逐功能实机测试（2026-11-17 合并验收）。
 *
 * 每个场景一个全新进程、一份全新 HOME，操控的是 `desktop/dist/win-unpacked/Pneuma.exe`，
 * 也就是用户双击的那份东西，不是 dev 版。
 *
 * 覆盖清单（来自 CHANGELOG「未发布」段）：
 *   1. 思考正文改 Markdown 排版 —— 代码块、列表、加粗要真的排版
 *   2. 命令调用换成紧凑卡 —— 摘要里有命令原文、能展开看结果
 *   3. `/doctor` 一条命令查九项（**终端侧**命令，桌面输入框只跑白名单，见下）
 *   4. `/log` 看日志状况（同上）
 *   5. `/doctor --bundle` 导出诊断包（同上）
 *   6. 设置里能看到「运行日志」那一组
 *
 * 3/4/5 在桌面输入框里不执行：桌面壳只转 7 条 `shell: true` 命令进终端
 * （`src/packages/commands-core/commands-completion.ts:256` 的 `shellHelpText`），
 * `/doctor`、`/log` 走的是终端界面。探针里标 SKIP 而不是 FAIL——那不是产品缺陷，
 * 是「这条命令不归桌面输入框管」。要验它们得在终端里跑。
 *
 * 不测：superagent（用户要求留着）、归档 OS 锁（要两个进程同时抢，另开）、编辑重发折叠复位
 * （要精确操作时序，成本高）。
 *
 * 运行：node desktop/shots/_verify-features-packaged.mjs
 * 产物：desktop/shots/out/feat-*.png
 */
process.on('unhandledRejection', () => {})

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { withApp } from './_pkg-harness.mjs'

let passed = 0
let failed = 0
let skipped = 0
const check = (name, ok, detail) => {
  if (ok) { passed += 1; console.log('  ok  ' + name) }
  else { failed += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  <- ' + String(detail).slice(0, 220))) }
}
/** 不适用：不是缺陷，只是这条通道（桌面输入框）不归它管。 */
const skip = (name, why) => {
  skipped += 1
  console.log('  SKIP ' + name + '  <- ' + why)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. 思考正文的 Markdown 排版 ──────────────────────────────────────────────
console.log('[1] 思考正文：代码块 / 列表 / 加粗')
await withApp({
  id: 'think-md',
  index: 1,
  fake: {
    script: {
      reasoning: [
        '先看结构：\n\n```ts\nconst a = 1\n```\n\n要点：\n\n- 第一条\n- 第二条\n\n**结论**：可行。\n',
      ],
      content: ['看完了。'],
    },
  },
}, async (ctx) => {
  await ctx.type('帮我看看这段代码')
  const ok = await ctx.waitText('看完了', 30000)
  check('回合跑完', ok === true)
  // 展开思考（若有开关）
  await ctx.evaluate(`
    const toggle = document.querySelector('.think-block [class*="toggle"], .think-row, .think-head')
    if (toggle !== null) toggle.click()
    return true
  `)
  await sleep(600)
  const dom = await ctx.evaluate(`
    const block = document.querySelector('.think-block') ?? document.body
    const html = block.innerHTML
    return {
      hasPre: html.includes('<pre'),
      hasCode: html.includes('<code'),
      hasLi: html.includes('<li'),
      hasStrong: html.includes('<strong'),
      text: block.innerText.slice(0, 300),
    }
  `)
  check('思考里有代码块 <pre>/<code>', dom.hasPre || dom.hasCode, JSON.stringify(dom).slice(0, 200))
  check('思考里有列表 <li>', dom.hasLi === true, dom.text)
  check('思考里加粗被渲染成 <strong>', dom.hasStrong === true, dom.text)
  await ctx.shot('feat-think-md.png')
})

// ── 2. 命令调用换成紧凑卡 ────────────────────────────────────────────────────
console.log('[2] 命令调用：紧凑卡 + 展开看结果')
await withApp({
  id: 'bash-card',
  index: 2,
  fake: {
    tool: { name: 'bash', args: { command: 'echo hi-from-numa' } },
    script: { content: ['命令跑完了。'] },
  },
}, async (ctx) => {
  await ctx.type('跑一下 echo')
  const ok = await ctx.waitText('命令跑完了', 40000)
  check('工具步 + 收尾都在', ok === true)
  const dom = await ctx.evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    // 卡片是流式渲染的：回合刚结束时还会重画一次，等它稳住再读
    await wait(900)
    const card = document.querySelector('.tool-card')
    if (card === null) return { found: false }
    const toggle = card.querySelector('.tool-click')
    const head = card.querySelector('.tool-head')
    return {
      found: true,
      cardText: card.innerText,
      hasToggle: toggle !== null,
      expandedBefore: toggle === null ? null : toggle.getAttribute('aria-expanded'),
      hasMore: head !== null && /\\+\\d+\\s*行/.test(head.innerText),
      statusDone: String(card.className).includes('status-done'),
    }
  `)
  check('画出了一张工具卡', dom.found === true)
  check('摘要里有命令原文', dom.found === true && String(dom.cardText).includes('echo hi-from-numa'), dom.cardText)
  check('折叠态给了展开入口（aria-expanded=false）', dom.hasToggle === true && dom.expandedBefore === 'false', dom.cardText)
  check('有「+N 行」这种结果条数提示', dom.hasMore === true, dom.cardText)
  check('卡片标成已完成（status-done）', dom.statusDone === true, dom.cardText)
  // 点开：展开后文本要变长（结果区露出来），aria-expanded 变 true
  const opened = await ctx.evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const card = () => document.querySelector('.tool-card')
    const before = card() === null ? 0 : card().innerText.length
    const toggle = card() === null ? null : card().querySelector('.tool-click')
    if (toggle !== null) toggle.click()
    await wait(800)
    const after = card() === null ? 0 : card().innerText.length
    const fresh = card() === null ? null : card().querySelector('.tool-click')
    return { before, after, expanded: fresh === null ? null : fresh.getAttribute('aria-expanded') }
  `)
  check('点开后展开（aria-expanded=true 且文本变长）', opened.expanded === 'true' && opened.after > opened.before, JSON.stringify(opened))
  await ctx.shot('feat-bash-card.png')
})

// ── 3. /doctor 九项体检 ──────────────────────────────────────────────────────
console.log('[3] /doctor 一条命令查九项')
skip('/doctor 九项体检', '终端侧斜杠命令，桌面输入框不执行（shell 白名单 7 条）')
console.log('[4] /log 一眼看当前状况')
skip('/log 日志状况', '终端侧斜杠命令，桌面输入框不执行（shell 白名单 7 条）')
console.log('[5] /doctor --bundle 导出诊断包')
skip('/doctor --bundle 诊断包', '终端侧斜杠命令，桌面输入框不执行（shell 白名单 7 条）')

// ── 6. 设置里的日志配置 ──────────────────────────────────────────────────────
console.log('[6] 设置 → 运行日志')
await withApp({ id: 'settings-log', index: 6 }, async (ctx) => {
  const clicked = await ctx.clickText('设置')
  check('侧栏能点开设置', clicked === true)
  const ok = await ctx.waitText('通用', 20000)
  check('设置面板画出来了', ok === true)
  const text = await ctx.body()
  check('有「运行日志」入口或分组', /运行日志|日志级别|日志/.test(text), text.slice(0, 400))
  await ctx.shot('feat-settings.png')
})

console.log('')
console.log('打包产物逐功能实机测试：' + String(passed) + ' 通过 / ' + String(failed) + ' 失败 / ' + String(skipped) + ' 不适用')
process.exit(failed === 0 ? 0 : 1)
