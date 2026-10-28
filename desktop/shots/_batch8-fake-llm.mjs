/**
 * 第八批自检用的假模型端点（OpenAI 兼容 SSE）：让一次真实的回合跑出
 * 「长思考 + 任务清单 + 工具调用」，用来验证思考块、分组折叠与状态面板。
 *
 * 三拍（按**请求计数器**分派，不看请求形状——那套判定在第七批自检里出过事故：
 * 回合陷入无限工具循环，对话页长出 741 张工具卡）：
 *   1. 第一拍：**慢速**吐一大段 reasoning（分多次 delta，每次之间 sleep），让直播中的
 *      思考块有足够长的观察窗；
 *   2. 第二拍：调 `todo_write` 立一份三项清单（状态面板的「进程 N/M」就靠它）；
 *   3. 第三拍：调 `read` 读工作区文件（只读、无需审批）；
 *   4. 第四拍：收尾正文，结束回合。
 *
 * 第二轮（自检里再发一条消息触发；仍按计数器分派）：第五拍把清单换成八项
 * （4 办完 / 1 进行中 / 3 待办——驱动状态面板的聚焦窗口与折叠桶预览卡），第六拍收尾。
 *
 * 端口是第 1 个参数，默认 18928。
 *
 * @module dsc/desktop/shots/batch8-fake-llm
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18928)

/** 这一进程收过几次 /chat/completions（见文件头：为什么用计数器而不是请求形状）。 */
let calls = 0

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && (req.url ?? '').split('?')[0].endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-flow', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('fake endpoint: 只有 /chat/completions')
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    await new Promise((resolve) => req.on('end', resolve))
    calls += 1
    process.stderr.write(`[batch8-fake-llm] 第 ${String(calls)} 次请求\n`)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const delta = (patch, finish = null) => send({ choices: [{ delta: patch, finish_reason: finish }] })
    const usage = { prompt_tokens: 200, completion_tokens: 60 }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const end = (finish) => {
      delta({}, finish)
      send({ choices: [{ delta: {}, finish_reason: null }], usage })
      res.write('data: [DONE]\n\n')
      res.end()
    }
    const toolCall = (id, name, args, finish) => {
      delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] })
      delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
      end(finish)
    }

    if (calls === 1) {
      // 慢速长思考：每一口之间停 400ms，自检在这段窗口里点开合、验「不抽搐」。
      // 段落之间留空行（思考摘要取「最新一个写完的段落的首行」，正是要靠空行分段）。
      // 每一口之后停 500ms：自检要在这段窗口里点开合、验「显示不抽搐、关得掉」。
      // 段落之间留**空行**（思考摘要取「最后一个写完的段落的首行」，靠空行分段）。
      // 参数名是 `todos` 不是 `items`——写错时工具会回一句「todos 必须是数组」，
      // 那一轮就没有清单、状态面板的「进程 N/M」也就无从出现（自检第一版踩过）。
      const parts = [
        '先把这件事拆开看。\n',
        '第一步，确认工作区里有什么文件。\n',
        '第二步，立一份任务清单，把三步写下来，免得做着做着自己忘了。\n\n',
        '第三步，读一眼说明文件。\n',
        '最后收尾汇报。\n\n',
        '顺序定了，开始。\n\n',
        '先照这个顺序往下走。\n',
        '马上调工具。',
      ]
      for (const part of parts) {
        delta({ reasoning_content: part })
        // 650ms/口：直播观察窗约 5.5s——自检要在里面点收起、跨三拍验「不重挂」、
        // 再点开回来；窗口太窄时最后那步会撞上「推理已结束、live 块被替换」的时序。
        await sleep(650)
      }
      toolCall('call_b8_todo', 'todo_write', {
        todos: [
          { content: '看一眼工作区有哪些文件', status: 'completed' },
          { content: '读 readme.txt 的说明', status: 'in_progress' },
          { content: '汇报结论', status: 'pending' },
        ],
      }, 'tool_calls')
      return
    }
    if (calls === 2) {
      toolCall('call_b8_read', 'read', { path: 'readme.txt' }, 'tool_calls')
      return
    }
    if (calls === 3) {
      // 落一个文件：驱动三件事——宿主 file-review 的写前预览进对话流（`.entry-review` 卡片）、
      // write 工具卡落地后拿到「这次改动」diff、仓库变脏（状态面板 Git 区读数 +3）。
      toolCall('call_b8_write', 'write', {
        path: '自检写入.md',
        justification: '自检要一张落地的编辑卡与一条写前预览。',
        sandbox_permissions: 'workspace-write',
        content: `# 自检写入
第一行
第二行
`,
      }, 'tool_calls')
      return
    }
    if (calls === 4) {
      delta({ content: '清单立好了、说明文件读了、文件也写了一份：这是一条第八批自检会话。' })
      end('stop')
      return
    }
    if (calls === 5) {
      // 第二轮（自检里再发一条消息触发）：换成八项清单（4 办完 / 1 进行中 / 3 待办）——
      // 状态面板的聚焦窗口与折叠桶预览卡就靠它：窗口取进行中那条起的连续 3 条，
      // 前后各折一个桶（前桶全办完 →「已完成 4 项」，后桶全待办 →「待处理 1 项」）。
      toolCall('call_b8_todo_big', 'todo_write', {
        todos: [
          { content: '确认工作区有哪些文件', status: 'completed' },
          { content: '读 readme.txt 的说明', status: 'completed' },
          { content: '记下说明文件的行数', status: 'completed' },
          { content: '汇报前面几步的结论', status: 'completed' },
          { content: '把清单扩成八项', status: 'in_progress' },
          { content: '核对每一项的状态', status: 'pending' },
          { content: '补一条收尾说明', status: 'pending' },
          { content: '最后收尾汇报', status: 'pending' },
        ],
      }, 'tool_calls')
      return
    }
    delta({ content: '清单扩成八项了：四条办完、一条进行中、三条待办。' })
    end('stop')
  })().catch((error) => {
    process.stderr.write(`[batch8-fake-llm] ${String(error)}\n`)
    try {
      res.end()
    } catch {
      // 对端可能已经关掉连接，忽略
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[batch8-fake-llm] 监听 127.0.0.1:${String(port)}\n`)
})
