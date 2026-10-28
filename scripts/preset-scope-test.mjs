/**
 * 「模式是会话的属性」与「一轮之内工具目录只有一份」的回归探针（2026-10-28）。
 *
 * 背景：用户报某个会话里连着一串「未知工具」。日志摆出来是这样——同一个会话的系统提示
 * fingerprint 变了两次又变回来（模式被切走又切回），而中间那几轮模型喊的工具全部执行失败。
 * 根因两条，这里各钉一遍：
 *
 *   1. **模式原来是宿主全局量**（plugins/presets.ts）。`dsc/session-open` 一打开别的
 *      会话就把它改掉，于是**后台跑着的那个会话**的工具目录与提示词跟着换。现在按会话存，
 *      谁问就给谁算（`AgentScope.sessionId`）。
 *   2. **同一轮里请求一份目录、执行另取一份**（core/loop.ts 的 deps.tools 被读了两次）。
 *      两次取值之间注册表一变，模型照着刚发出去的 schema 喊的名字就落进「未知工具」。
 *      现在执行用这一轮请求的快照。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/preset-scope-test.mjs
 *
 * @module dsc/scripts/preset-scope-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// config 模块在 import 时就固定了 ~/.dsc 路径，临时 HOME 必须先于一切 lib 导入
const home = mkdtempSync(join(tmpdir(), 'dsc-preset-scope-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 一档「只给 bash」的自定义模式：工具白名单就是那条投影的试金石
mkdirSync(join(home, '.dsc', 'presets'), { recursive: true })
writeFileSync(
  join(home, '.dsc', 'presets', 'narrow.md'),
  '---\nname: narrow\nlabel: 窄档\ndescription: 只给 bash\ntools: bash\n---\n\n窄档的正文：这句只该出现在用窄档的那个会话的提示词里。\n',
  'utf8',
)

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

/** 假端点：只认「开跑消失工具」这一句，回一个 vanishing 的工具调用。 */
let switchBeforeReply = null
const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const sseText = (text) =>
  sse({ choices: [{ delta: { content: text } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
  sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) +
  'data: [DONE]\n\n'
const sseToolCall = (id, name, args) =>
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] }) +
  sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
  sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) +
  'data: [DONE]\n\n'

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      payload = {}
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const realUser = [...messages]
      .reverse()
      .find((m) => m.role === 'user' && !(typeof m.content === 'string' && m.content.includes('不是用户发言')))
    const lastText = typeof realUser?.content === 'string' ? realUser.content : ''
    const hasToolResult = messages.some((m) => m.role === 'tool')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (hasToolResult) {
      res.end(sseText('工具回来了'))
      return
    }
    if (lastText.includes('开跑消失工具')) {
      // **关键时序**：请求已经按「标准档的全量目录」发出去（循环在发请求前取了快照），
      // 这里在回包之前把模式切走。没有快照的那版执行时会现取目录，vanishing 就不在里面了。
      if (switchBeforeReply !== null) switchBeforeReply()
      res.end(sseToolCall('t_van', 'vanishing', '{}'))
      return
    }
    res.end(sseText('收到'))
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
        baseUrl: `http://127.0.0.1:${String(port)}`,
        apiKey: 'k',
        models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

const names = (list) => list.map((tool) => tool.name)

console.log('[1] 打开会话不再往转录里写「已恢复会话」')
{
  const sessionA = ctx.session.current()
  await ctx.session.open(undefined)
  const snapshot = JSON.stringify(ctx.transcript.getSnapshot())
  check('转录里没有「已恢复会话」这条 system 行', !snapshot.includes('已恢复会话'))
  await ctx.session.open(sessionA.filePath)
  check('切回原会话也照样没有', !JSON.stringify(ctx.transcript.getSnapshot()).includes('已恢复会话'))
}

console.log('[2] 工具目录按会话算（切走别的会话不改后台那个）')
{
  const sessionA = ctx.session.current()
  const sidA = sessionA.meta.id
  ctx.presets.use('narrow')
  check('A 切到窄档后只剩 bash', JSON.stringify(names(ctx.tools.visible({ sessionId: sidA }))) === JSON.stringify(['bash']), JSON.stringify(names(ctx.tools.visible({ sessionId: sidA }))))

  await ctx.session.open(undefined)
  const sessionB = ctx.session.current()
  const sidB = sessionB.meta.id
  check('新建的 B 是默认档（全量目录里有 bash 也有 read）', names(ctx.tools.visible({ sessionId: sidB })).includes('bash') && names(ctx.tools.visible({ sessionId: sidB })).includes('read'))
  check('**切到 B 之后 A 的目录还是只有 bash**（这条以前会随 B 一起变）', JSON.stringify(names(ctx.tools.visible({ sessionId: sidA }))) === JSON.stringify(['bash']), JSON.stringify(names(ctx.tools.visible({ sessionId: sidA }))))
  check('不带 scope 的 visible() 跟随当前会话（B = 全量）', names(ctx.tools.visible()).length > 1)
  check('presets.name 报的是当前会话那一档', ctx.presets.name === 'standard', ctx.presets.name)

  console.log('[3] 系统提示也按会话：A 的 persona 是窄档，B 的不是')
  const promptA = ctx.prompt.systemPrompt(sessionA.meta.cwd, { sessionId: sidA, cwd: sessionA.meta.cwd })
  const promptB = ctx.prompt.systemPrompt(sessionB.meta.cwd, { sessionId: sidB, cwd: sessionB.meta.cwd })
  check('A 的提示词里有窄档正文', promptA.includes('窄档的正文'), '')
  check('B 的提示词里没有窄档正文', !promptB.includes('窄档的正文'), '')

  console.log('[4] 换档只影响本会话')
  ctx.presets.use('ptc')
  check('B 切到 ptc 后 B 有 run_code', names(ctx.tools.visible({ sessionId: sidB })).includes('run_code'))
  check('A 仍是窄档（只有 bash、没有 run_code）', JSON.stringify(names(ctx.tools.visible({ sessionId: sidA }))) === JSON.stringify(['bash']))
  ctx.presets.use('standard')
  // 会话落盘是攒批的（不是每次 appendState 都 write）：等一拍再重开，否则 open() 找不到
  // 那个文件、会静默留在当前会话上——探针自己踩过一次。
  await sleep(1200)
  await ctx.session.open(sessionA.filePath)
  check('切回 A：当前会话确实换成了 A', ctx.session.current().meta.id === sidA)
  check('切回 A：当前档跟着回到 A 的窄档', ctx.presets.name === 'narrow', ctx.presets.name)
}

console.log('[5] 同一轮里注册表变了，模型喊过的工具照样能跑（执行用请求那一刻的目录）')
{
  let ran = false
  ctx.tools.register({
    name: 'vanishing',
    description: '探针用：请求发出之后就会被模式白名单挡掉',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => {
      ran = true
      return 'vanished ok'
    },
  })
  const session = ctx.session.current()
  // 先回到全量档：这一轮请求必须**看见** vanishing（否则失败与快照无关，探针自己就不成立）
  ctx.presets.use('standard')
  check('请求这一轮用的目录里有 vanishing', ctx.tools.visible({ sessionId: session.meta.id }).some((tool) => tool.name === 'vanishing'))
  // 回包前把当前会话切到窄档：vanishing 不在白名单里，执行那一步现取目录就会判「未知工具」
  switchBeforeReply = () => {
    ctx.presets.use('narrow')
    switchBeforeReply = null
  }
  const done = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason, signal) => {
      if (signal.sessionId !== session.meta.id) return
      off()
      resolve(reason)
    })
  })
  ctx.agent.followup('开跑消失工具')
  await done
  const toolTexts = session.messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
  check('工具真的执行了（不是「未知工具」）', ran)
  check('日志里的工具结果是它的返回值', toolTexts.some((text) => text.includes('vanished ok')), JSON.stringify(toolTexts))
  check('日志里没有「未知工具」', !toolTexts.some((text) => text.includes('未知工具')), JSON.stringify(toolTexts))
}

// 收尾与别的内核探针一致：先让宿主收摊（常驻 agent、会话写盘），再关假端点，最后退出。
// 直接 process.exit 会在 libuv 还没关完句柄时断言（"!(handle->flags & UV_HANDLE_CLOSING)"）。
ctx.emit('dsc/exit')
console.log('')
console.log(`${String(pass)} PASS / ${String(fail)} FAIL`)
await new Promise((resolve) => {
  server.close(resolve)
  server.closeAllConnections?.()
})
// 不显式 process.exit：句柄正在关的时候硬退会让 libuv 断言。给事件循环一个退出的机会，
// 真退不出去再兜一次（兜底那条不会触发本来要防的断言，因为它前面已经等过一拍）。
setTimeout(() => {
  process.exit(fail === 0 ? 0 : 1)
}, 300).unref()
process.exitCode = fail === 0 ? 0 : 1
