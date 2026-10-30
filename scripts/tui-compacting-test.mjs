/**
 * 终端界面的压缩活动行（2026-10-30）：`compact` 跑着的时候终端里也要看得见。
 *
 * 为什么单开一份：桌面/网页壳那条活动行有快照字段与源码钉，终端这边是另一套渲染
 * （ink 的行几何），只能真渲染一帧再断言文字在不在——顺带钉住「不在压缩时这一行不出现」，
 * 免得它变成常驻噪音。
 *
 * 运行：pnpm build && node scripts/tui-compacting-test.mjs
 *
 * @module dsc/scripts/tui-compacting-test
 */
import React from 'react'
import { render } from 'ink'
import { PassThrough } from 'node:stream'

const { ChatView } = await import('../lib/app/ChatView.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const entries = [
  { id: 1, kind: 'user', text: '帮我压缩一下' },
  { id: 2, kind: 'text', text: '好' },
]

const props = {
  entries,
  turnState: 'idle',
  expandThinking: false,
  empty: false,
  maxWidth: 80,
  columns: 100,
}

const sleep = (ms) => new Promise((resolveDone) => setTimeout(resolveDone, ms))

/** 渲染一帧，返回这期间写进 stdout 的全部文本（ink 的 lastFrame 在 v6 里没有了）。 */
const frame = async (extra) => {
  let out = ''
  const stdout = new PassThrough()
  stdout.columns = 100
  stdout.rows = 40
  stdout.isTTY = false
  stdout.on('data', (chunk) => {
    out += String(chunk)
  })
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  const view = render(React.createElement(ChatView, { ...props, ...extra }), {
    stdin,
    stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(160)
  view.unmount()
  return out
}

console.log('[1] 压缩中：底部有 spinner 行与已用时')
{
  const out = await frame({ compactingSince: Date.now() - 3_000 })
  check('画了「压缩上下文中」', out.includes('压缩上下文中'), out.slice(-300))
  check('带了说明与已用时', out.includes('把更早的历史折成摘要') && /已用 \d+s/.test(out), out.slice(-300))
  check('有盲文 spinner 字形', /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(out))
}

console.log('[2] 没在压缩：这一行不出现')
{
  const out = await frame({})
  check('没有压缩行', !out.includes('压缩上下文中'), out.slice(-200))
}

console.log('[3] 源码钉：App 把字段传给会话视图')
{
  const { readFileSync } = await import('node:fs')
  const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8')
  check('App 传 compactingSince', /compactingSince=\{snapshot\.status\.compactingSince\}/.test(app))
}

if (failures > 0) {
  console.log(`\n${String(failures)} 条用例失败`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
