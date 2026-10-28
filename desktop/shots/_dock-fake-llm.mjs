/**
 * dock 浏览器实机走查的**假模型端点**（开发辅助，`desktop/shots/` 整目录 gitignored）。
 *
 * 为什么要它：要验的是「agent 自己开侧栏页签 → 读快照 → 点那颗按钮 → 读回标题」这条真链路，
 * 而真链路要有模型驱动。这里用假端点按**上一轮工具调用的名字与动作**分派，并**从真工具结果里
 * 抠出 viewId 与 ref**——也就是说 ref 不是写死的，是上一轮真快照里读出来的，点错东西就点不中。
 *
 * 分派（看历史里最后一条 assistant 的 tool_calls，再读它对应的工具结果）：
 *   （没有工具调用）                      → browser_dock      { action: 'open', url }
 *   上一条是 browser_dock action=open     → browser_dock_look { action: 'snapshot', viewId }
 *   上一条是 browser_dock_look            → browser_dock      { action: 'click', viewId, ref }
 *   上一条是 browser_dock action=click    → browser_dock      { action: 'evaluate', viewId, expression: 'document.title' }
 *   上一条是 browser_dock action=evaluate → 收尾正文（把读回来的标题念出来）
 *
 * 环境变量：
 *   DSC_DOCK_FAKE_PORT   监听端口（默认 18931，与 _dock-seed.mjs 对齐）
 *   DSC_DOCK_PAGE_URL    要打开的靶页地址（默认 http://127.0.0.1:38517/）
 *
 * 用法：node desktop/shots/_dock-fake-llm.mjs
 *
 * @module dsc/desktop-shots/dock-fake-llm
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.DSC_DOCK_FAKE_PORT ?? 18_931)
const PAGE_URL = process.env.DSC_DOCK_PAGE_URL ?? 'http://127.0.0.1:38517/'

const log = (line) => process.stderr.write(`[dock-fake-llm] ${line}\n`)

/** 历史里的工具结果正文（按调用 id 对上那一条）。 */
function toolResultFor(messages, callId) {
  const hit = messages.find((message) => message.role === 'tool' && message.tool_call_id === callId)
  if (hit === undefined) return ''
  const content = hit.content
  if (typeof content === 'string') return content
  // 有些实现把结果拆成 [{type:'text',text}] 的数组
  if (Array.isArray(content)) {
    return content
      .map((part) => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
  }
  return ''
}

/** 历史里最后一条带工具调用的 assistant 消息。 */
function lastToolCall(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    if (calls.length === 0) continue
    const call = calls[0]
    let args = {}
    try {
      args = JSON.parse(call.function?.arguments ?? '{}')
    } catch {
      // 参数不是 JSON 就当空实参（走到这里说明是别的探针留下的历史，不该发生）
    }
    return { name: String(call.function?.name ?? ''), args, callId: String(call.id ?? '') }
  }
  return null
}

/** 从工具结果里抠 viewId（open 的回执里写着 `viewId=agent-1`）。 */
function pickViewId(text, fallback) {
  const hit = /(agent-\d+)/.exec(text)
  return hit === null ? fallback : hit[1]
}

/**
 * 从快照文本里抠一颗按钮的 ref。
 *
 * 优先取带 `button` 的那行（靶页上唯一可点的东西），没有就退到第一条 ref——
 * **不是写死的**：这一条直接决定「点得中还是点不中」。
 */
function pickButtonRef(text) {
  const lines = text.split('\n')
  const button = lines.find((line) => /\bbutton\b/.test(line) && /\[ref=e\d+\]/.test(line))
  const target = button ?? lines.find((line) => /\[ref=e\d+\]/.test(line))
  if (target === undefined) return null
  const ref = /\[ref=(e\d+)\]/.exec(target)
  return ref === null ? null : ref[1]
}

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url ?? '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'dock-flow', object: 'model' }] }))
    return
  }
  if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('只有 POST /chat/completions')
    return
  }

  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  await new Promise((resolve) => req.on('end', resolve))

  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' })
    res.end('body 不是 JSON')
    return
  }

  const messages = Array.isArray(body.messages) ? body.messages : []
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const delta = (patch, finish = null) => send(res, { choices: [{ delta: patch, finish_reason: finish }] })
  const usage = { prompt_tokens: 240, completion_tokens: 48 }
  const end = (finish) => {
    delta({}, finish)
    send(res, { choices: [{ delta: {}, finish_reason: null }], usage })
    res.write('data: [DONE]\n\n')
    res.end()
  }
  const toolCall = (id, name, args) => {
    delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] })
    delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
    end('tool_calls')
  }
  const say = (text) => {
    delta({ content: text })
    end('stop')
  }

  const previous = lastToolCall(messages)
  const previousResult = previous === null ? '' : toolResultFor(messages, previous.callId)

  // ① 还没有任何工具调用 → 开一张页签
  if (previous === null) {
    log(`第 1 步：open ${PAGE_URL}`)
    toolCall('dock_open', 'browser_dock', { action: 'open', url: PAGE_URL })
    return
  }

  // ② 已经 open 过 → 读快照（viewId 从 open 的回执里抠）
  if (previous.name === 'browser_dock' && previous.args['action'] === 'open') {
    const viewId = pickViewId(previousResult, '')
    if (viewId === '') {
      log(`open 回执里没找到 viewId，回正文收尾：${previousResult.slice(0, 200)}`)
      say(`开页签那一步没拿到 viewId，停下来。回执：${previousResult.slice(0, 300)}`)
      return
    }
    log(`第 2 步：snapshot ${viewId}`)
    toolCall('dock_look', 'browser_dock_look', { action: 'snapshot', viewId })
    return
  }

  // ③ 拿过快照 → 从快照里挑一颗按钮点它（ref 是读出来的，不是写死的）
  if (previous.name === 'browser_dock_look') {
    const viewId = String(previous.args['viewId'] ?? '')
    const ref = pickButtonRef(previousResult)
    if (ref === null) {
      log('快照里没找到带 ref 的按钮，回正文收尾')
      say(`快照里没找到可点的按钮。快照前 300 字：${previousResult.slice(0, 300)}`)
      return
    }
    log(`第 3 步：click ${viewId} ref=${ref}`)
    toolCall('dock_click', 'browser_dock', { action: 'click', viewId, ref })
    return
  }

  // ④ 点过了 → 读回文档标题（点击真生效的话它会变成 clicked-1）
  if (previous.name === 'browser_dock' && previous.args['action'] === 'click') {
    log(`第 4 步：evaluate document.title（点击回执：${previousResult.slice(0, 120)}）`)
    toolCall('dock_eval', 'browser_dock', {
      action: 'evaluate',
      viewId: String(previous.args['viewId'] ?? ''),
      expression: 'document.title',
    })
    return
  }

  // ⑤ 收尾：把读回来的标题念出来（走查脚本按这句话判断点没点到）
  if (previous.name === 'browser_dock' && previous.args['action'] === 'evaluate') {
    log(`第 5 步：收尾。标题读数：${previousResult.replace(/\s+/g, ' ').trim().slice(0, 200)}`)
    say(`点完了。页面读回的标题是：${previousResult.replace(/\s+/g, ' ').trim().slice(0, 200)}`)
    return
  }

  log(`没预料到的上一步：${previous.name} ${JSON.stringify(previous.args)}`)
  say('走查脚本不认识这一步，停下。')
})

server.listen(PORT, '127.0.0.1', () => {
  log(`在 127.0.0.1:${String(PORT)} 上听着；靶页 ${PAGE_URL}`)
})
