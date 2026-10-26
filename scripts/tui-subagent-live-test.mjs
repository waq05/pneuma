/**
 * 「开子代理就卡」的端到端验收：**真内核 + 假端点 + 真队友 + 真 App**。
 *
 * 与 `tui-snapshot-coalesce-test` 的区别：那个用假 runtime 灌通知，量的是合并器本身；
 * 这里跑真链路——用户发言 → 主回合调 `subagent` 工具 → subagent 插件派真队友 → 队友流式
 * 输出（每口都走 `forwardSubagent → transcript.emit → invalidate`）→ App 真的在渲染。
 * 量的就是用户体感的那件事：**队友打字期间，界面每秒重排几次**。
 *
 * 断言：
 *   [1] 队友卡出现在会话流里（真派活成功）；
 *   [2] 队友流式期间 React 提交率被合并窗口夹住（≤ 1000/80 × 2 = 25 次/秒，实测远低于此）；
 *   [3] 流式结束后界面里能看到队友瀑布的最新内容（内容没被合并丢掉）。
 *
 * 隔离：临时 HOME + 假模型端点，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm build && node scripts/tui-subagent-live-test.mjs
 *
 * @module dsc/scripts/tui-subagent-live-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import React from 'react'
import { render } from 'ink'

const home = mkdtempSync(join(tmpdir(), 'dsc-subagent-live-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 关掉长期记忆（回合结束会投机器通知，抢镜头），并按官方插件的默认状态打开子智能体
// （`allowDelegation` 默认关，不打开连 subagent 工具都不在场，模型派的活会落空）
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        { file: 'subagent', disabled: false, config: { allowDelegation: true, notify: 'quiet' } },
        { file: 'memory', config: { enabled: false } },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    console.log(`  FAIL  ${label}${extra === '' ? '' : ` — ${extra}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 假端点 ──────────────────────────────────────────────────────────────────
const sseText = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
const sseToolCall = (id, name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`
const sseEnd = () =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\n` +
  'data: [DONE]\n\n'

/** 队友那条流：很多口增量（模拟「打字」的洪峰）。 */
const TEAMMATE_CHUNKS = 240

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const isTeammate = body.includes('你在团队里的位置')
    const isTitle = body.includes('给这段对话起一个短标题')
    if (isTitle) {
      res.end(sseText('子代理性能探针') + sseEnd())
      return
    }
    if (isTeammate) {
      // 每口一行，200+ 口：这就是让界面卡的那个洪峰
      let index = 0
      const push = () => {
        if (index >= TEAMMATE_CHUNKS) {
          res.end(sseEnd())
          return
        }
        index += 1
        res.write(sseText(`队友第 ${index} 行进来了。\n`))
        setTimeout(push, 1)
      }
      push()
      return
    }
    if (body.includes('"tool"') || body.includes('tool_result')) {
      res.end(sseText('收到结论了。') + sseEnd())
      return
    }
    // 主回合：派一个后台队友
    res.end(
      sseToolCall('call-1', 'subagent', {
        action: 'spawn',
        role: 'explorer',
        task: '把这一串输出逐行打出来，最后给一句结论。',
        background: true,
      }) + sseEnd(),
    )
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const { createKernel } = await import('../lib/host/kernel.js')
const { App } = await import('../lib/app/App.js')

const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'k',
        models: [
          {
            id: 'm',
            name: 'm',
            contextWindow: 100000,
            maxTokens: 500,
            modalities: ['text'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}
const stdout = new PassThrough()
stdout.columns = 110
stdout.rows = 40
stdout.isTTY = false
let output = ''
stdout.on('data', (chunk) => {
  output += String(chunk)
})

let commits = 0
render(
  React.createElement(
    React.Profiler,
    { id: 'app', onRender: () => { commits += 1 } },
    React.createElement(App, { runtime: ctx.ui }),
  ),
  { stdin, stdout, exitOnCtrlC: false, patchConsole: false },
)
await sleep(300)

const frame = () => {
  const idx = output.lastIndexOf('\x1b[2K')
  return (idx < 0 ? output : output.slice(idx)).replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}
const flat = () => frame().replace(/\n/g, ' ⏎ ')

console.log('子代理 + TUI 端到端性能验收')

// 发言 → 主回合派活
ctx.ui.submit('开跑')
const sawCard = await (async () => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (frame().includes('子代理：')) return true
    await sleep(120)
  }
  return false
})()
check('[1] 真队友被派出去、卡片进了会话流', sawCard, flat().slice(-300))

// 队友流式期间的提交率
commits = 0
const window = 2500
const started = Date.now()
let peak = ''
while (Date.now() - started < window) {
  const current = frame()
  if (current.includes('队友第') && current.length > peak.length) peak = current
  await sleep(100)
}
const elapsed = Date.now() - started
const perSecond = (commits / elapsed) * 1000
check(
  `[2] 队友打字期间提交率被夹住（${commits} 次 / ${elapsed}ms = ${perSecond.toFixed(1)} 次/秒 ≤ 25）`,
  perSecond <= 25,
  `${commits} 次 / ${elapsed}ms`,
)
check('[2b] 界面确实在跟着更新（提交没有掉到 0）', commits >= 3, String(commits))
check('[3] 队友瀑布的最新内容看得见（合并没有丢内容）', peak.includes('队友第'), peak.slice(-200))

await ctx.dispose?.()
server.close()
process.exit(failures === 0 ? 0 : 1)
