/**
 * 插件版界面的本地伺服器（开发辅助，不进测试电池）：起一个隔离的 headless 宿主，
 * 把本机界面服务开起来，并打印那一条带一次性令牌的地址。
 *
 * 为什么要单独的启动器：`msc` 是 ink TUI 入口，ink 会接管 stdout，而界面服务那条
 * 「可以访问了」的地址行要在干净的 stdout 上才读得到；桌面端将来走宿主协议拿地址，
 * 但终端调试与自检更需要一条能直接复制的 URL。
 *
 * 隔离口径与 `_tui-visual-run.mjs` 一致：HOME / USERPROFILE / DSC_HOME 三件套一起设，
 * 真实 ~/.dsc 一个字节都不动（除非用 DSC_UI_SERVE_HOME 指定一个固定目录）。
 *
 * 用法：
 *   node scripts/ui-shell-serve.mjs            # 临时 HOME，退出即丢
 *   DSC_UI_SERVE_HOME=D:\tmp\ui-home node scripts/ui-shell-serve.mjs
 *   DSC_UI_SERVE_PORT=17322 node scripts/ui-shell-serve.mjs   # 想钉端口时
 *
 * @module dsc/scripts/ui-shell-serve
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.DSC_UI_SERVE_HOME ?? mkdtempSync(join(tmpdir(), 'dsc-ui-serve-'))
mkdirSync(home, { recursive: true })

const child = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
  cwd: root,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSC_HOME: join(home, '.dsc'),
    DSC_UI_SERVER: '1',
  },
  // stdin 必须是**开着的管道**：headless 的协议桥把「stdin 关闭」当退出信号。
  stdio: ['pipe', 'pipe', 'pipe'],
})

process.stdout.write(`[ui-serve] 隔离 HOME：${home}\n`)
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => process.stdout.write(chunk))
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
child.on('exit', (code) => {
  process.stdout.write(`[ui-serve] 宿主退出（code=${String(code)}）\n`)
  process.exit(code ?? 0)
})

const stop = () => {
  child.stdin.end()
  child.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
