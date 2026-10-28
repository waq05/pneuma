/**
 * dock 浏览器实机走查的**靶页**（开发辅助，`desktop/shots/` 整目录 gitignored）。
 *
 * 为什么要专门一页：要验的是「agent 通过 CDP 真的点到了页面上的东西」。所以这一页必须
 * 有一个**可点击且可观测**的目标——按钮点一下改文档标题（`document.title`），再加一个
 * 计数节点。标题读得回来就说明点击真的发生在 Chromium 里，而不是「命令发出去了」。
 *
 *   `/`       标题 `dock-靶页·<token>`，一枚 `#hit` 按钮（点一次 → 标题变 `clicked-N`）、
 *             一个 `#count` 计数节点
 *   `/plain`  只有文本，用来验 snapshot 能读出静态文本
 *
 * 用法：node desktop/shots/_dock-page.mjs 38517
 *
 * @module dsc/desktop-shots/dock-page
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? '38517')
const token = Math.random().toString(36).slice(2, 8)

const HOME = `<!doctype html><meta charset="utf-8"><title>dock-靶页·${token}</title>
<h1>dock 靶页</h1>
<p id="hint">点下面这颗按钮。</p>
<button id="hit" style="width:220px;height:56px;font-size:18px">点我</button>
<p>已点击 <span id="count">0</span> 次</p>
<script>
  let n = 0
  document.getElementById('hit').addEventListener('click', () => {
    n += 1
    document.getElementById('count').textContent = String(n)
    document.title = 'clicked-' + n
    document.getElementById('hint').textContent = '被点到了 ' + n + ' 次'
  })
</script>`

const PLAIN = `<!doctype html><meta charset="utf-8"><title>dock-静态页·${token}</title>
<h1>只有文本的一页</h1><p>这一页没有任何按钮。</p>`

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(path === '/plain' ? PLAIN : HOME)
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`dock 靶页：http://127.0.0.1:${String(port)}/ （token ${token}）\n`)
})
