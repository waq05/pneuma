/**
 * 自检用的本地技能市场源：一份 index.json 加一份技能的正文，都在内存里回。
 *
 * 给「编辑源 → 保存 → 浏览 → 安装」这条真实链路当靶子（ui-batch4-check）：
 * 源地址形如 http://127.0.0.1:<port>/index.json，条目 path 指到
 * /selftest-skill/selftest-skill.md（basename 与技能名一致，落盘才是 selftest-skill.md）。
 *
 * 用法：node scripts/_market-local.mjs <port>（只监听回环；不发任何真实请求）
 *
 * @module dsc/scripts/_market-local
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 17441)

const skillMarkdown = `---
description: 自检用技能（本地源）
when-to-use: 只在自检脚本里用
---

# 自检技能

这是一份自检用的技能正文：市场源 → 安装 → 落进 ~/.dsc/skills 的真实链路。
`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(port)}`)
  if (url.pathname === '/index.json') {
    const body = JSON.stringify({
      skills: [
        {
          name: 'selftest-skill',
          description: '自检用技能（本地源）',
          path: 'selftest-skill/selftest-skill.md',
        },
      ],
    })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(body)
    return
  }
  if (url.pathname === '/selftest-skill/selftest-skill.md') {
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
    res.end(skillMarkdown)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('没有这个文件')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`本地市场源在 http://127.0.0.1:${String(port)}/index.json`)
})
