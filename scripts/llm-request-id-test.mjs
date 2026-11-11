/**
 * 请求追踪号的探针：起一个本地服务真的返回 500，确认号进了错误。
 *
 * 为什么不用假的 fetch：这一段的价值就在「从真实的 Headers 里取到」，桩掉的正是要验的东西。
 * 本地回环服务不起子进程，沙箱里也跑得动。
 *
 * @module dsc/scripts/llm-request-id-test
 */
import { createServer } from 'node:http'

const { streamChat } = await import('../lib/core/llm.js')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

/** 起一个只回固定响应的服务，返回 { baseUrl, close }。 */
function serve(status, headers, body) {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, headers)
      response.end(body)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

/** 发一次请求并把错误捞出来。 */
async function catchError(baseUrl, handlers = {}) {
  try {
    await streamChat({ baseUrl, apiKey: 'probe-key', model: 'probe', messages: [] }, handlers)
    return undefined
  } catch (error) {
    return error
  }
}

// 重试会让这条探针从 0.5 秒拖到十几秒；这里只要第一次的结果
process.env['DSC_LLM_RETRY_ATTEMPTS'] = '1'

let failedDebug
const withId = await serve(500, { 'content-type': 'application/json', 'x-request-id': 'req_probe_500' }, '{"error":"boom"}')
const error = await catchError(withId.baseUrl, { onDelta() {}, onRequestDebug: (debug) => { failedDebug = debug } })
await withId.close()

check('500 会抛错', error !== undefined)
check('状态码是 500', error?.status === 500, String(error?.status))
check('requestId 挂到了错误对象上', error?.requestId === 'req_probe_500', String(error?.requestId))
check('文案里带得上追踪号', String(error?.message).includes('（request-id req_probe_500）'), String(error?.message).slice(0, 120))
check('失败时也回调 onRequestDebug', failedDebug?.requestId === 'req_probe_500', String(failedDebug?.requestId))

// 成功那半：流式正文要真的解出来，回调才有意义
let okDebug
const okServer = await serve(
  200,
  { 'content-type': 'text/event-stream', 'x-request-id': 'req_ok_1' },
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
)
const okResult = await streamChat(
  { baseUrl: okServer.baseUrl, apiKey: 'probe-key', model: 'probe', messages: [] },
  { onDelta() {}, onRequestDebug: (debug) => { okDebug = debug } },
)
await okServer.close()

check('成功响应也回调 onRequestDebug', okDebug?.requestId === 'req_ok_1', String(okDebug?.requestId))
check('成功时正文照常解析', okResult?.text === 'hi', String(okResult?.text))

const without = await serve(400, { 'content-type': 'application/json' }, '{"error":"bad"}')
const bare = await catchError(without.baseUrl)
await without.close()

check('端点不给号时不硬凑', bare?.requestId === undefined, String(bare?.requestId))
check('不给号时文案不出现 request-id', !String(bare?.message).includes('request-id'), String(bare?.message).slice(0, 120))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
// 不调 process.exit：本进程里 fetch 的 keep-alive 连接还在收尾，硬退会在 Windows 上
// 撞 libuv 的 UV_HANDLE_CLOSING 断言（退出码会变成 1，把 6 条 PASS 全盖掉）。
process.exitCode = failures === 0 ? 0 : 1
