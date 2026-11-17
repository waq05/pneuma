/**
 * 自检用的**慢**本地技能市场源：一份 index.json 故意晚 800ms 才回，并统计被命中几次。
 *
 * 给 `desktop/shots/skills-market-check.ps1` 当靶子，验「离开技能页再回来不再联网」：
 *   - `/index.json`：延迟 800ms 后返回一条 slow-skill；每命中一次计数 +1，并往命中日志
 *     （第三个参数）追加一行 `{ at: 毫秒时间戳, path }` —— 页面里有 CSP，渲染进程 fetch
 *     不到这个回环端口，所以命中次数只能从**服务端日志**按时间窗读；
 *   - `/hits`：返回 `{ hits: N }`（PS 侧自己查，人肉排查也方便）；
 *   - `/slow-skill/slow-skill.md`：技能正文（200），安装链路备用；
 *   - 所有响应带 `Access-Control-Allow-Origin: *`。
 *
 * 只监听回环，不发任何真实请求。用法：
 *   node scripts/_market-local-slow.mjs <port> [hitsLogPath]
 *
 * @module dsc/scripts/_market-local-slow
 */
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 17461)
const hitsLog = process.argv[3] ?? ''
if (!Number.isInteger(port) || port <= 0) {
  console.error('用法：node scripts/_market-local-slow.mjs <port> [hitsLogPath]')
  process.exit(2)
}

/** /index.json 的人为延迟：够长，让「没走缓存」这件事在耗时上看得出来。 */
const INDEX_DELAY_MS = 800

/** /index.json 被命中次数（每请求一次 +1，失败也算命中）。 */
let indexHits = 0

/** 记一次命中：内存计数 + 追加日志行（PS 侧按时间窗判「这段时间有没有联网」）。 */
function noteHit(path) {
  indexHits += 1
  if (hitsLog === '') return
  try {
    appendFileSync(hitsLog, JSON.stringify({ at: Date.now(), path }) + '\n', 'utf8')
  } catch {
    // 日志只是自检读数：写不进去不能把一次正常的市场请求变成失败
  }
}

const skillMarkdown = `---
description: 慢源自检技能
when-to-use: 只在自检脚本里用
---

# 慢源自检技能

这份正文来自本地慢源：用来验证市场列表、缓存与安装链路，不联网。
`

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(port)}`)
  /** 所有响应都带 CORS（本机排查用；渲染进程读不到见文件头说明）。 */
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers)
    response.end()
    return
  }
  if (url.pathname === '/index.json') {
    noteHit(url.pathname)
    // 故意慢：客户端缓存命中时不该再等这 800ms，也说明根本没再打到这里
    setTimeout(() => {
      response.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' })
      response.end(
        JSON.stringify({
          skills: [{ name: 'slow-skill', description: '慢源自检技能', path: 'slow-skill/slow-skill.md' }],
        }),
      )
    }, INDEX_DELAY_MS)
    return
  }
  if (url.pathname === '/hits') {
    response.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ hits: indexHits }))
    return
  }
  if (url.pathname === '/slow-skill/slow-skill.md') {
    response.writeHead(200, { ...headers, 'content-type': 'text/markdown; charset=utf-8' })
    response.end(skillMarkdown)
    return
  }
  response.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' })
  response.end('没有这个文件')
})

server.listen(port, '127.0.0.1', () => {
  console.log(
    `本地慢市场源在 http://127.0.0.1:${String(port)}/index.json（延迟 ${String(INDEX_DELAY_MS)}ms）` +
      (hitsLog === '' ? '' : `，命中日志 ${hitsLog}`),
  )
})
