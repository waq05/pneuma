/**
 * 请求追踪号落进会话日志的探针（插件层，非 core 层）。
 *
 * 与 `llm-request-id-test.mjs` 的分工：那条验「解析头、挂到错误、回调」；
 * 这条验「llm 插件在 stream() 这个汇聚点真的把号写进了会话的 note 记录」——
 * 也就是用户事后按会话回查某次请求时，日志里能不能找到那一行。
 *
 * @module dsc/scripts/llm-request-note-test
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-note-'))
process.env['DSC_HOME'] = join(home, '.dsc')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_note_42' })
  response.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()

const { createKernel } = await import('../lib/host/kernel.js')
const { OPENAI_COMPLETIONS_API } = await import('../lib/core/llm.js')
const kernel = await createKernel({ config: {}, resumeSessionPath: null })

const result = await kernel.llm.stream(
  OPENAI_COMPLETIONS_API,
  {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'probe-key',
    model: 'probe-model',
    messages: [{ role: 'user', content: 'hi' }],
  },
  { onDelta() {} },
)
check('请求本身成功', result?.text === 'hi', String(result?.text))

const notes = kernel.session.current().notes()
check('会话里记了一条 note', notes.length >= 1, String(notes.length))
check('note 的 id 是 llm/request-id', notes.some((note) => note.id === 'llm/request-id'), JSON.stringify(notes))
check('note 里带着追踪号', notes.some((note) => String(note.text).includes('req_note_42')), JSON.stringify(notes.map((note) => note.text)))

// 写盘是流式的，等一拍再读文件，确认它真的落到了日志里（不只是内存）
await new Promise((resolve) => setTimeout(resolve, 400))
const file = kernel.session.current().filePath
let body = ''
try {
  body = readFileSync(file, 'utf8')
} catch {
  body = ''
}
check('note 落进了会话 jsonl', body.includes('"type":"note"') && body.includes('req_note_42'), file)

await new Promise((resolve) => server.close(resolve))
try {
  await kernel.dispose()
} catch {
  // 收尾失败不影响结论
}
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
process.exitCode = failures === 0 ? 0 : 1
