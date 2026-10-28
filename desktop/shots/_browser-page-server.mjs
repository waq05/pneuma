/**
 * 浏览器侧边栏自检用的**本机页面**（桌面端实机走查专用，`desktop/shots/` 整目录 gitignored）。
 *
 * 为什么要它：内嵌浏览器要验的是「真加载一页之后」的事——标题进 chip、前进后退可用态、
 * 切走再切回**不重新加载**、网页自己 `window.open` 转新页签。这些都得有一页真网页。
 * 公网在这台机器上不可靠，所以自己在 127.0.0.1 上起一个最小站点：
 *
 *   - `/`        标题带一枚随机 token（每次加载都换）——**token 变了就是页面被重新加载了**，
 *                这是"切页签保活"唯一可观测的证据；
 *   - `/two`      第二页（验前进后退）；
 *   - `/popup`    一加载就 `window.open('/two')`（验弹窗转新页签）。
 *
 * 用法：node desktop/shots/_browser-page-server.mjs 38173
 *
 * @module dsc/desktop-shots/browser-page-server
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? '38173')
const token = () => Math.random().toString(36).slice(2, 8)

const PAGES = {
  '/': () => ({ title: `自检页一·${token()}`, body: '<h1>one</h1>' }),
  '/two': () => ({ title: `自检页二·${token()}`, body: '<h1>two</h1>' }),
  '/popup': () => ({ title: `自检弹窗页·${token()}`, body: '<p>popup</p>', script: "window.open('/two')" }),
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  const make = PAGES[path] ?? PAGES['/']
  const page = make()
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${page.title}</title>${page.body}` +
      (page.script === undefined ? '' : `<script>${page.script}</script>`),
  )
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`browser-check page server on http://127.0.0.1:${String(port)}/\n`)
})
