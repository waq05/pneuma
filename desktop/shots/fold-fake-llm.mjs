/**
 * 「整轮过程折叠」实时用例的假模型端点（OpenAI 兼容 SSE）：不连真模型、不花钱。
 *
 * 一轮两跳，为的是把实时路径上都验到：
 *   第 1 跳：先吐一段思考（reasoning_content）→ 再吐一句中间正文 → 收一个 read 工具调用，
 *            带 usage {prompt 100, completion 10}；
 *   第 2 跳：再吐一段思考 → 吐最终正文，带 usage {prompt 200, completion 20}。
 *
 * 于是这一轮的过程区是「思考 + 中间正文 + 工具卡 + 思考」，最终正文是最后一段；
 * 宿主按轮累计用量（110 + 220 = 330），页脚该显示「用量 330 tok」而不是「~N tok」——
 * 330 这个数就是这条用例的判据（估算口径绝算不出这个整数）。
 *
 * 端口是第 1 个参数，默认 18951。
 *
 * @module desktop/shots/fold-fake-llm
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18951)
/**
 * 第一跳吐几个 read 调用（默认 1）。
 *
 * 为什么要可调：验「组收口时阅读位置不被重置」需要一个**组体超过限高**的组
 * （`min(400px, 50vh)`），一个工具撑不起来。`step-control` 用例把它设成 14，
 * 于是第一跳那两个组里后面那个会压着 14 张卡，展开后必然可滚。
 */
const toolCount = Math.max(1, Number(process.env.FOLD_FAKE_TOOLS ?? '1') || 1)
/**
 * 第二跳里「思考」与「最终正文」之间停多久（默认 400ms）。
 *
 * `step-control` 把它设成 2500：那一段是「组还没收口」的窗口——自检要在这个窗口里把组体
 * 展开、滚到中间，再等正文到达把组封口，才能验「收口时不重置阅读位置」。留 400ms 抓不住。
 */
const tailMs = Math.max(0, Number(process.env.FOLD_FAKE_TAIL_MS ?? '400') || 400)
/**
 * 一轮有几跳（默认 2，与历史行为一致）。
 *
 * `step-control` 设成 3：中间那一跳带「一段正文 + 一个工具」，于是**上一个阶段组被正文封口**
 * 与**这一轮收尾**变成两个时刻——自检要验的正是前者（组收口时阅读位置不被重置），
 * 两跳的话这两个时刻撞在一起，测出来的其实是轮收尾的复位。
 */
const hops = Math.max(2, Number(process.env.FOLD_FAKE_HOPS ?? '2') || 2)
/**
 * 第一跳吐完 tool_calls 之后、真正结束响应之前停多久（默认 200ms）。
 *
 * 这一段就是界面上「准备中」的窗口：模型已经把工具名吐出来了，参数与工具调用事件都还没到。
 * `step-prepare` 把它设成 1500，好让自检稳稳抓到这个转瞬即逝的状态。
 */
const prepareMs = Math.max(0, Number(process.env.FOLD_FAKE_PREPARE_MS ?? '200') || 200)
/** 头一次请求故意返回 500（默认关）：用来验「模型重试行」——dsc 会退避重试并报一条。 */
const failFirst = process.env.FOLD_FAKE_FAIL_FIRST === '1'
/**
 * 超长思考的填充文本（默认关）：设了就拼进第一跳思考的末段，把组头的实时详情顶到
 * 必被截断的长度——step-live 走查靠它断言「详情行截在组头里，不再撑破会话」
 * （不设的话思考只有几十个字，修复前的旧布局也超不了宽，断言测不出差别）。
 */
const reasonPad = process.env.FOLD_FAKE_REASON_PAD ?? ''
let failedOnce = false
/** 每跳的思考正文：第一跳用来验「跑动中摘要照显」，最后一跳用来验多段思考的累计。 */
const reasoningOne = '第一跳思考：先确认这一轮要走两步，中间夹一次读文件。\n第一跳思考第二行：过程区因此会有思考、正文与工具卡。' + reasonPad + '\n\n'
const reasoningTwo = '第二跳思考：拿到文件内容了，可以把结论写出来。\n\n'
const reasoningThree = '第三跳思考：再看一眼收尾，把结论写出来。\n\n'
/** 这一轮已经收到第几次请求（每次收到用户消息开头的那一次重置为 1）。 */
let hop = 0

const server = createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
    // 请求体必须读干净，否则 keep-alive 连接会错位（也要靠它分辨这是第几跳）
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    await new Promise((resolve) => req.on('end', resolve))

    // 故意失败一次：让 llm 层的重试环（core/llm.ts 的 streamChat）真的跑一次，
    // 于是界面上会出现「模型重试行」。只在第一次请求上失败——重试的那次照常吐内容。
    if (failFirst && !failedOnce) {
      failedOnce = true
      res.writeHead(500, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: { message: '自检假端点：故意失败一次' } }),
      )
      return
    }

    // 这一跳是第几跳：最后一条是用户消息就重开一轮计数，否则累加。
    // 不能靠「请求体里有没有 tool 角色」判断——多轮对话里历史本来就带着前面几轮的工具消息，
    // 那样第二轮的第一跳会被误判成后续跳，于是它不吐工具调用（step-control 第一版栽在这里）。
    const lastRole = (() => {
      try {
        const parsed = JSON.parse(body)
        const messages = Array.isArray(parsed.messages) ? parsed.messages : []
        const last = messages[messages.length - 1]
        return last === null || typeof last !== 'object' ? '' : String(last.role ?? '')
      } catch {
        return ''
      }
    })()
    hop = lastRole === 'user' ? 1 : hop + 1

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    if (hop === 1) {
      delta({ reasoning_content: reasoningOne })
      await sleep(500)
      delta({ content: '先读一下自检样张文件，确认读得到。' })
      await sleep(300)
      delta(
        {
          tool_calls: Array.from({ length: toolCount }, (_unused, index) => ({
            index,
            id: index === 0 ? 'call_fold_live' : `call_fold_live_${String(index)}`,
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: process.env.FOLD_PROBE_TARGET ?? '' }) },
          })),
        },
        'tool_calls',
      )
      await sleep(prepareMs)
    } else if (hop < hops) {
      // 中间跳：一段正文 + 一个工具。正文把上一组封掉，工具再另起一组——
      // 于是「这一组收口」与「这一轮收尾」错开，自检才验得清前者。
      delta({ reasoning_content: reasoningTwo })
      await sleep(300)
      delta({ content: '中间小结：样张读完了，接着再确认一处。' })
      await sleep(200)
      delta(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_fold_mid',
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: process.env.FOLD_PROBE_TARGET ?? '' }) },
            },
          ],
        },
        'tool_calls',
      )
      await sleep(150)
    } else {
      delta({ reasoning_content: reasoningThree })
      await sleep(tailMs)
      delta({ content: '读到了：样张文件就一句话。整轮过程折叠这一轮的用量是真值。' })
      delta({}, 'stop')
    }
    // 用量口径保持不变：第一跳 100/10、之后每跳 200/20（两跳时合计 330，那条用例的判据）
    send({
      choices: [{ delta: {}, finish_reason: null }],
      usage: hop === 1
        ? { prompt_tokens: 100, completion_tokens: 10 }
        : { prompt_tokens: 200, completion_tokens: 20 },
    })
    res.write('data: [DONE]\n\n')
    res.end()
  })().catch((error) => {
    process.stderr.write(`[fold-fake-llm] ${String(error)}\n`)
    try {
      res.end()
    } catch {
      // 连接可能已经被对端关掉了，忽略
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[fold-fake-llm] 监听 127.0.0.1:${String(port)}\n`)
})
