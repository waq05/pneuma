/**
 * 队友「叫停之后还能接着用」的端到端验收（2026-10-27 查账第三条）。
 *
 * 三条被钉住的旧行为：
 *   1. `stop` 把队友从在队名单里删掉 → 之后主会话传话只会写进信箱、没人读
 *      （「某一子代理中断后，主会话能否继续该子代理？」答案是「不能」）；
 *   2. 传话之后没有汇报回流 → 它又干完一遍，主会话什么也收不到；
 *   3. 被叫醒的队友状态还停在 stopped（界面一直显示停着）。
 *
 * 跑的是真链路：真内核 + 假端点 + 真队友（subagent 插件派活 → MiniAgent 跑回合）。
 * 隔离：临时 HOME，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm build && node scripts/subagent-resume-test.mjs
 *
 * @module dsc/scripts/subagent-resume-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-subagent-resume-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// notify=quiet：汇报直接写进派出它的会话文件（不依赖常驻 agent），断言就看法这条通道
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
const until = async (fn, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await sleep(25)
  }
}

// ── 假端点 ──────────────────────────────────────────────────────────────────
const sseText = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'
const sseToolCall = (id, name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'

let teammateCalls = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      payload = {}
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const system = messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    const realUser = [...messages]
      .reverse()
      .find((m) => m.role === 'user' && !(typeof m.content === 'string' && m.content.includes('不是用户发言')))
    const lastText = typeof realUser?.content === 'string' ? realUser.content : ''
    if (system.includes('会话标题生成器')) {
      res.end(sseText('队友续跑探针'))
    } else if (system.includes('你在团队里的位置')) {
      teammateCalls += 1
      res.end(sseText(teammateCalls === 1 ? '第一轮：查完了，包名叫 pneuma' : '第二轮：又查了一遍，还是 pneuma'))
    } else if (messages.some((m) => m.role === 'tool')) {
      res.end(sseText('收到队友的汇报了。'))
    } else if (lastText.includes('派队友')) {
      res.end(
        sseToolCall(
          'ts1',
          'subagent',
          JSON.stringify({
            action: 'spawn',
            role: 'explorer',
            task: '慢队友任务：查一下 package.json 里的包名，一句话交差',
            background: true,
          }),
        ),
      )
    } else {
      res.end(sseText('收到'))
    }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const { createKernel } = await import('../lib/host/kernel.js')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'k',
        models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

const parent = ctx.session.current()
const team = ctx.get('team')
const stateOf = (name) => team.list().find((mate) => mate.name === name)?.state

console.log('1. 派一个后台队友并等它收工')
ctx.agent.followup('派队友')
check('队友派出来了', await until(() => team.list().length === 1), JSON.stringify(team.list()))
const name = team.list()[0]?.name ?? ''
check('只派了一个（没有回环重派）', await until(() => team.list().length === 1), JSON.stringify(team.list().map((m) => m.name)))
check('队友干完一轮（idle）', await until(() => stateOf(name) === 'idle'), JSON.stringify(team.list()))
check('第一轮汇报写进了派出它的会话', await until(() => parent.messages.some((m) => typeof m.content === 'string' && m.content.includes('第一轮'))), String(parent.messages.length))

console.log('2. 叫停：人还在名册里，不是被删掉')
const stopText = await team.stop(name)
check('stop 的回复说明可以接着用', stopText.includes('保留') || stopText.includes('传话'), stopText)
// 它已经自己收工了：叫停没有在跑的回合可停，状态仍是 idle——但关键是**人还在名册里**
check('叫停后仍在名册里（没被删掉）', stateOf(name) !== undefined, JSON.stringify(team.list()))

console.log('3. 传话接着用：它会再干一轮，并把结果报回来')
const messageText = await team.message(name, '再确认一次包名')
check('传话没被「没有叫…的队友」挡下', !messageText.includes('没有叫'), messageText)
// 这一条原来直接等 state === 'working'：假端点回得太快时，第二轮在断言执行之前就收工了，
// 状态已经翻回 idle，于是长批跑到这里偶发失败（2026-10-30 实测两次：耗时 12.6 秒、rounds=2、
// finishedAt 已写）。意图是「传话真的把它叫起来了，没停在 idle」——观测到 working 或第二轮
// 已经跑完都算成立；后面三条（第二轮真跑了 / 干完回 idle / 汇报写回主会话）会继续钉细节。
const woke = await until(
  () => stateOf(name) === 'working' || (team.list().find((mate) => mate.name === name)?.rounds ?? 0) >= 2,
)
check('传话把它叫起来了（观测到 working，或第二轮已经跑完）', woke, JSON.stringify(team.list()))
check('第二轮确实跑了（假端点收到两次队友请求）', await until(() => teammateCalls === 2), String(teammateCalls))
check('第二轮干完回到 idle', await until(() => stateOf(name) === 'idle'), JSON.stringify(team.list()))
check(
  '第二轮汇报也写回了主会话（以前这一条会永远缺席）',
  await until(() => parent.messages.some((m) => typeof m.content === 'string' && m.content.includes('第二轮'))),
  JSON.stringify(parent.messages.slice(-6).map((m) => String(m.content).slice(0, 40))),
)
check('两次汇报都是 <teammate-report> 形状', parent.messages.filter((m) => typeof m.content === 'string' && m.content.includes('<teammate-report')).length >= 2, String(parent.messages.length))

console.log('4. 移除：真正收掉时才从名册消失')
const removeText = await team.remove(name)
check('移除有明确回执', removeText.includes('移除'), removeText)
check('名册里没有它了', stateOf(name) === undefined, JSON.stringify(team.list()))

console.log('\n清理')
server.close()
process.exit(failures === 0 ? 0 : 1)
