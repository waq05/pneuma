/**
 * `session/event` 旁路广播自检：把内核的回合过程翻译成 dsh 的会话语义事件。
 *
 * 为什么要这条：这条链路一旦断，症状是「插件挂上了、历史查得到，但正在跑的这一轮
 * 它一无所知」——dsh-cost-meter 的统计预热等 `turn/end`，按事件对账的那部分等
 * `assistant/message` 里的 `usage`。真包验收要联网，进不了默认门禁，所以钉在这儿。
 *
 * 钉四件事：
 *   [1] 顺序：turn/start → user/message → step/start → assistant/message → tool/* → step/end → turn/end
 *   [2] 形状：seq 连续、surfaceOp 只加在改可见面的那三类上、用量与工具调用原样带出
 *   [3] 边界：没用量也定稿、重试不另开一步、中止/失败各有 reason、桥自己不崩
 *   [4] 真挂载：dsh 风格插件 `ctx.on('session/event')` 真能接住（走真实 loader）
 *
 * 跑法：cd D:\dsc && pnpm run build && node scripts/dsh-session-events-check.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-session-events-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(join(dsc, 'plugins'), { recursive: true })
mkdirSync(join(dsc, 'sessions', 'proj'), { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

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

const { createDshSessionEventBridge, DSH_SESSION_EVENT } = await import('../lib/core/dsh-compat/session-events.js')

/** 记账用的假 ctx：把每次 emit 的 (name, carrier, event) 收下来。 */
function recordingCtx() {
  const seen = []
  return {
    seen,
    emit(name, carrier, event) {
      seen.push({ name, carrier, event })
    },
  }
}

/** 一次完整回合：问一句 → 调一个工具 → 再说一句 → 收尾。 */
function driveTurn(bridge) {
  bridge.publish({ type: 'user', text: '这条应该等 turn/start 之后才出现在事件里' })
  bridge.publish({ type: 'turn/start' })
  bridge.publish({ type: 'context', segments: [] })
  bridge.publish({ type: 'message', text: '我先读文件。', reasoning: '想想', finishReason: 'tool_calls', toolCalls: [{ id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' }] })
  bridge.publish({ type: 'usage', inputTokens: 120, outputTokens: 30, cacheHitTokens: 100, cacheMissTokens: 20, model: 'deepseek-chat' })
  bridge.publish({ type: 'tool/call', callId: 'call-1', name: 'read', args: '{"path":"a.ts"}' })
  bridge.publish({ type: 'tool/result', callId: 'call-1', text: '文件内容', ms: 12 })
  bridge.publish({ type: 'context', segments: [] })
  bridge.publish({ type: 'message', text: '读完了。', reasoning: '', finishReason: 'stop' })
  bridge.publish({ type: 'usage', inputTokens: 300, outputTokens: 90, model: 'deepseek-chat' })
  bridge.publish({ type: 'turn/end', reason: 'completed' })
}

const baseRoute = { provider: 'deepseek', model: 'deepseek-chat' }

console.log('顺序与形状')
{
  const ctx = recordingCtx()
  const bridge = createDshSessionEventBridge({
    ctx,
    sessionId: 'sid-1',
    cwd: 'D:\\proj',
    createdAt: 1_700_000_000_000,
    route: () => baseRoute,
  })
  driveTurn(bridge)
  const events = ctx.seen.map((row) => row.event)
  const types = events.map((event) => event.type)
  check('事件名是 session/event', ctx.seen.every((row) => row.name === DSH_SESSION_EVENT) && DSH_SESSION_EVENT === 'session/event')
  check(
    '顺序：turn/start 在 user/message 之前',
    types.indexOf('turn/start') >= 0 && types.indexOf('turn/start') < types.indexOf('user/message'),
    types.join(','),
  )
  check('每一步有 step/start 与 step/end 成对', types.filter((t) => t === 'step/start').length === 2 && types.filter((t) => t === 'step/end').length === 2, types.join(','))
  check('工具事件在第一步里', types.indexOf('tool/call') > types.indexOf('step/start') && types.indexOf('tool/result') < types.indexOf('step/end'))
  check('seq 从 0 连续递增', events.every((event, index) => event.seq === index), events.map((e) => e.seq).join(','))
  check('每条带毫秒时间', events.every((event) => Number.isFinite(event.time) && event.time > 0))

  const surface = events.filter((event) => event.surfaceOp !== undefined).map((event) => event.type)
  check('surfaceOp 只加在 user/message、assistant/message、tool/result 上', surface.join(',') === 'user/message,assistant/message,tool/result,assistant/message', surface.join(','))
  check('生命周期事件没有 surfaceOp', events.filter((e) => ['turn/start', 'step/start', 'step/end', 'turn/end', 'tool/call'].includes(e.type)).every((e) => e.surfaceOp === undefined))

  const assistant = events.find((event) => event.type === 'assistant/message')
  const blocks = assistant?.data?.message?.content ?? []
  check('助手消息带正文块', blocks[0]?.type === 'text' && blocks[0]?.text === '我先读文件。', JSON.stringify(blocks[0]))
  check('助手消息带推理块', blocks[1]?.type === 'reasoning' && blocks[1]?.text === '想想', JSON.stringify(blocks[1]))
  check('助手消息带工具调用块（dsh 把它算消息内容）', blocks[2]?.type === 'tool-call' && blocks[2]?.id === 'call-1' && blocks[2]?.arguments === '{"path":"a.ts"}', JSON.stringify(blocks[2]))
  check('助手消息带 provider / model', assistant?.data?.message?.source?.provider === 'deepseek' && assistant?.data?.message?.source?.model === 'deepseek-chat', JSON.stringify(assistant?.data?.message?.source))
  // 我们报的 inputTokens 是 prompt 总量（命中含在内），dsh 的分项是互斥的：
  // 输入只算未命中（120-100=20），命中单列 100，缓存写入我们不知道、恒 0。
  check('用量按 dsh 的互斥口径换算', assistant?.data?.usage?.inputTokens === 20 && assistant?.data?.usage?.outputTokens === 30 && assistant?.data?.usage?.cacheReadTokens === 100 && assistant?.data?.usage?.cacheWriteTokens === 0, JSON.stringify(assistant?.data?.usage))
  check('合计是四项之和', assistant?.data?.usage?.totalTokens === 150 && assistant?.data?.usage?.reasoningTokens === 0, JSON.stringify(assistant?.data?.usage))
  check('stream 记录里有正文与用量', Array.isArray(assistant?.data?.stream) && assistant?.data?.stream?.length === 2 && assistant?.data?.stream?.[0]?.chunk?.type === 'text-delta' && assistant?.data?.stream?.[1]?.chunk?.type === 'usage')

  const toolResult = events.find((event) => event.type === 'tool/result')
  check('工具结果的消息角色与配对 id 对', toolResult?.data?.message?.role === 'tool' && toolResult?.data?.message?.toolCallId === 'call-1' && toolResult?.data?.message?.source?.callId === 'call-1', JSON.stringify(toolResult?.data?.message))
  check('成功的工具结果不带 isError', toolResult?.data?.message?.isError === undefined && toolResult?.data?.error === undefined)

  const turnEnd = events.find((event) => event.type === 'turn/end')
  check('turn/end 的 reason 是 completed', turnEnd?.data?.reason?.kind === 'completed', JSON.stringify(turnEnd?.data?.reason))
  check('carrier 给的是只读会话视图', ctx.seen[0]?.carrier?.id === 'sid-1' && ctx.seen[0]?.carrier?.header?.id === 'sid-1' && ctx.seen[0]?.carrier?.header?.cwd === 'D:\\proj')
  check('carrier 的 events 尾巴看得见刚发的事件', ctx.seen[0].carrier.events.length > 0 && ctx.seen[0].carrier.events.length <= 64)
}

console.log('边界')
{
  // 没有用量：下一条事件之前一定要定稿，不能把助手消息吞掉。
  const ctx = recordingCtx()
  const bridge = createDshSessionEventBridge({ ctx, sessionId: 'sid-2', route: () => baseRoute })
  bridge.publish({ type: 'turn/start' })
  bridge.publish({ type: 'context', segments: [] })
  bridge.publish({ type: 'message', text: '没有用量的回答', reasoning: '', finishReason: 'stop' })
  bridge.publish({ type: 'turn/end', reason: 'completed' })
  const assistant = ctx.seen.map((row) => row.event).filter((event) => event.type === 'assistant/message')
  check('没带用量也发 assistant/message', assistant.length === 1, String(assistant.length))
  check('没用量时不编 usage 字段', assistant[0]?.data?.usage === undefined, JSON.stringify(assistant[0]?.data?.usage))

  // 重试：同一步里再来一条 context，不许开出第二步。
  const retryCtx = recordingCtx()
  const retryBridge = createDshSessionEventBridge({ ctx: retryCtx, sessionId: 'sid-3', route: () => baseRoute })
  retryBridge.publish({ type: 'turn/start' })
  retryBridge.publish({ type: 'context', segments: [] })
  retryBridge.publish({ type: 'context', segments: [] })
  retryBridge.publish({ type: 'message', text: '一次就成', reasoning: '', finishReason: 'stop' })
  retryBridge.publish({ type: 'turn/end', reason: 'completed' })
  const starts = retryCtx.seen.map((row) => row.event).filter((event) => event.type === 'step/start')
  check('重试不另开一步', starts.length === 1, String(starts.length))

  // 中止：reason 要带原因，别只说「结束了」。
  const abortCtx = recordingCtx()
  const abortBridge = createDshSessionEventBridge({ ctx: abortCtx, sessionId: 'sid-4', route: () => baseRoute })
  abortBridge.publish({ type: 'turn/start' })
  abortBridge.publish({ type: 'turn/end', reason: 'aborted' })
  const aborted = abortCtx.seen.map((row) => row.event).find((event) => event.type === 'turn/end')
  check('中止的 reason 是 aborted(user)', aborted?.data?.reason?.kind === 'aborted' && aborted?.data?.reason?.reason?.kind === 'user', JSON.stringify(aborted?.data?.reason))

  // 失败：reason 是 error，带 message。
  const errCtx = recordingCtx()
  const errBridge = createDshSessionEventBridge({ ctx: errCtx, sessionId: 'sid-5', route: () => baseRoute })
  errBridge.publish({ type: 'turn/start' })
  errBridge.publish({ type: 'error', message: '端点 500' })
  errBridge.publish({ type: 'turn/end', reason: 'error' })
  const errored = errCtx.seen.map((row) => row.event).find((event) => event.type === 'turn/end')
  check('失败的 reason 是 error 且带真实错误文案', errored?.data?.reason?.kind === 'error' && errored?.data?.reason?.error?.message === '端点 500', JSON.stringify(errored?.data?.reason))

  // 失败的工具结果要标 isError 与 error 身份（dsh 只在 isError 时允许带 error）。
  const toolCtx = recordingCtx()
  const toolBridge = createDshSessionEventBridge({ ctx: toolCtx, sessionId: 'sid-6', route: () => baseRoute })
  toolBridge.publish({ type: 'turn/start' })
  toolBridge.publish({ type: 'context', segments: [] })
  toolBridge.publish({ type: 'tool/call', callId: 'c9', name: 'bash', args: '{}' })
  toolBridge.publish({ type: 'tool/result', callId: 'c9', text: '炸了', error: 'tool-error' })
  const failed = toolCtx.seen.map((row) => row.event).find((event) => event.type === 'tool/result')
  check('失败的工具结果标 isError', failed?.data?.message?.isError === true, JSON.stringify(failed?.data?.message))
  check('失败的工具结果带错误身份', failed?.data?.error?.code === 'tool-error' && failed?.data?.error?.name === 'ToolError')

  // 桥自己不崩：没有 emit、emit 抛错、route 都没给。
  check('ctx 没有 emit 时静默返回', (() => {
    const bridge = createDshSessionEventBridge({ ctx: {}, sessionId: 'sid-7' })
    driveTurn(bridge)
    return bridge.carrier.events.length > 0
  })())
  const throwing = { emit() { throw new Error('监听器炸了') } }
  check('监听器抛错不往上冒', (() => {
    const bridge = createDshSessionEventBridge({ ctx: throwing, sessionId: 'sid-8' })
    driveTurn(bridge)
    return true
  })())
  const noRoute = recordingCtx()
  const noRouteBridge = createDshSessionEventBridge({ ctx: noRoute, sessionId: 'sid-9' })
  noRouteBridge.publish({ type: 'turn/start' })
  noRouteBridge.publish({ type: 'message', text: 'x', reasoning: '', finishReason: 'stop' })
  noRouteBridge.publish({ type: 'turn/end', reason: 'completed' })
  const anonymous = noRoute.seen.map((row) => row.event).find((event) => event.type === 'assistant/message')
  check('没给 route 也不崩（source 字段留空串）', anonymous?.data?.message?.source?.model === '', JSON.stringify(anonymous?.data?.message?.source))

  // 回合没开就来的消息不许丢：下一回合开的时候补发。
  const lateCtx = recordingCtx()
  const lateBridge = createDshSessionEventBridge({ ctx: lateCtx, sessionId: 'sid-10', route: () => baseRoute })
  lateBridge.publish({ type: 'user', text: '先说的话' })
  lateBridge.publish({ type: 'turn/start' })
  lateBridge.publish({ type: 'turn/end', reason: 'completed' })
  const lateTypes = lateCtx.seen.map((row) => row.event.type)
  check('turn 之前来的用户消息补在 turn/start 之后', lateTypes.join(',') === 'turn/start,user/message,turn/end', lateTypes.join(','))
}

console.log('真挂载：dsh 风格插件 ctx.on(session/event)')
{
  writeFileSync(
    join(dsc, 'plugins', 'dsh-listens-events.js'),
    `export const name = 'dsh-listens-events'

export function apply(ctx) {
  const heard = []
  ctx.on('session/event', (session, event) => {
    heard.push({ id: session?.header?.id, type: event?.type, seq: event?.seq, usage: event?.data?.usage?.inputTokens })
    globalThis.__eventProbe = heard
  })
  return () => {
    delete globalThis.__eventProbe
  }
}
`,
    'utf8',
  )
  const { createKernel } = await import('../lib/host/kernel.js')
  const { mountAllExternalPlugins } = await import('../lib/core/plugin-loader.js')
  const { writePluginEnabled, writePluginConfig } = await import('../lib/core/plugin-registry.js')
  writePluginEnabled('dsh-compat', true)
  writePluginEnabled('dsh-listens-events.js', true)
  writePluginConfig('dsh-listens-events.js', { risk: 'read' })

  const ctx = await createKernel({
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl: 'http://127.0.0.1:9',
          apiKey: 'k',
          models: [{ id: 'm', name: 'm', contextWindow: 1000, maxTokens: 100, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm',
    },
    resumeSessionPath: null,
  })
  const failures = await mountAllExternalPlugins(ctx, [])
  const failure = failures.find((row) => row.file === 'dsh-listens-events.js')
  check('插件挂载无问题', failure === undefined, failure === undefined ? '' : failure.problem)

  const bridge = createDshSessionEventBridge({ ctx, sessionId: 'live-1', cwd: 'D:\\proj', route: () => baseRoute })
  bridge.publish({ type: 'turn/start' })
  bridge.publish({ type: 'context', segments: [] })
  bridge.publish({ type: 'message', text: '在跑的这一轮', reasoning: '', finishReason: 'stop' })
  bridge.publish({ type: 'usage', inputTokens: 42, outputTokens: 7, model: 'deepseek-chat' })
  bridge.publish({ type: 'turn/end', reason: 'completed' })

  const heard = globalThis.__eventProbe ?? []
  const types = heard.map((row) => row.type)
  check('插件真的听到了事件', heard.length > 0, JSON.stringify(types))
  check('顺序对（turn/start 打头、turn/end 收尾）', types[0] === 'turn/start' && types[types.length - 1] === 'turn/end', types.join(','))
  check('会话 id 经 header 传到了插件手上', heard[0]?.id === 'live-1', String(heard[0]?.id))
  check('用量跟着 assistant/message 到了插件', heard.some((row) => row.type === 'assistant/message' && row.usage === 42), JSON.stringify(heard))

  ctx.emit('dsc/exit')
  const fiber = ctx?.fiber
  if (fiber !== null && fiber !== undefined && typeof fiber.dispose === 'function') await fiber.dispose()
}

console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
