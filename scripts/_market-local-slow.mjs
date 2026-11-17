/**
 * 自检用的**慢**本地技能市场源：一份 index.json 故意晚 800ms 才回，并统计被命中几次。
 *
 * 给 `desktop/shots/skills-market-check.ps1` 当靶子，验「离开技能页再回来不再联网」：
 *   - `/index.json`：延迟 800ms 后返回一条 slow-skill；每命中一次计数 +1；
 *   - `/hits`：返回 `{ hits: N }`，界面脚本用它做「二次打开时命中数没有涨」的证据；
 *   - `/slow-skill/slow-skill.md`：技能正文（200），安装链路备用；
 *   - 所有响应带 `Access-Control-Allow-Origin: *`：界面（渲染进程）要能直接 fetch /hits。
 *
 * 只监听回环，不发任何真实请求。用法：
 *   node scripts/_market-local-slow.mjs <port>
 *
 * @module dsc/scripts/_market-local-slow
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 17461)
if (!Number.isInteger(port) || port <= 0) {
  console.error('用法：node scripts/_market-local-slow.mjs <port>')
  process.exit(2)
}

/** /index.json 的人为延迟：够长，让「没走缓存」这件事在耗时上看得出来。 */
const INDEX_DELAY_MS = 800

/** /index.json 被命中次数（每请求一次 +1，失败也算命中）。 */
let indexHits = 0

const skillMarkdown = `---
description: 慢源自检技能
when-to-use: 只在自检脚本里用
---

# 慢源自检技能

这份正文来自本地慢源：用来验证市场列表、缓存与安装链路，不联网。
`

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(port)}`)
  /** 所有响应都带 CORS：渲染进程（页面）要能读 /hits。 */
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
    indexHits += 1
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
  console.log(`本地慢市场源在 http://127.0.0.1:${String(port)}/index.json（延迟 ${String(INDEX_DELAY_MS)}ms）`)
})
