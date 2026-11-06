/**
 * 折叠三缺陷截图的「网页半」启动器：隔离 HOME 起一个真宿主，把界面伺服出来，
 * 交给 agent 浏览器去截图（Electron 的 capturePage 在这台机器上会被别的前台窗口挡住，
 * 报 Current display surface not available；网页这一侧不受影响）。
 *
 * 用法：
 *   node scripts/ui-fold-fix-web.mjs --case tail [--process compact] [--port 18961]
 * 输出（stdout 一行，供上层脚本读）：
 *   READY <url>
 * 之后进程一直活着（stdin 关闭即退出），由上层用 ego_navigate / ego_screenshot 操作。
 *
 * 隔离：HOME / USERPROFILE / DSC_HOME 全部指到 desktop/shots/fold-fix-home，
 * 用户真实的 ~/.dsc 一个字节都不碰（种子脚本自己也只写这个目录）。
 *
 * @module dsc/scripts/ui-fold-fix-web
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const root = 'D:\\dsc'
const home = join(root, 'desktop', 'shots', 'fold-fix-home')
const which = argOf('--case', 'tail')
const processFold = argOf('--process', which.startsWith('live-') ? which.slice(5) : 'standard')
const port = argOf('--port', '18961')

const seedEnv = {
  ...process.env,
  FOLD_FIX_HOME: home,
  FOLD_FIX_PROCESS: processFold,
  FOLD_FIX_PORT: '18952',
}
const seed = spawn(process.execPath, [join(root, 'scripts', 'ui-fold-fix-seed.mjs')], {
  cwd: root,
  env: seedEnv,
  stdio: ['ignore', 'pipe', 'inherit'],
})
let seedOut = ''
seed.stdout.setEncoding('utf8')
seed.stdout.on('data', (chunk) => { seedOut += chunk })
const seeded = await new Promise((resolve) => seed.on('exit', (code) => resolve(code)))
if (seeded !== 0) {
  console.error('[web] 种子失败：' + seedOut)
  process.exit(1)
}
const sessions = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8'))
const sessionPath = sessions[which]
if (typeof sessionPath !== 'string') {
  console.error('[web] 没有这个会话：' + which)
  process.exit(1)
}

const host = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
  cwd: root,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSC_HOME: join(home, '.dsc'),
    DSC_UI_SERVER: '1',
    DSC_UI_PORT: port,
    DSC_UI_HMR: '0',
    DSC_RESUME_SESSION: sessionPath,
    FOLD_FIX_KEY: 'sk-selfcheck-fake',
    FOLD_FIX_TARGET: sessions.probeTarget,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let ready = false
let buffer = ''
host.stdout.setEncoding('utf8')
host.stdout.on('data', (chunk) => {
  buffer += chunk
  const line = buffer.split('\n').find((item) => item.indexOf('"ui-url"') >= 0)
  if (ready || line === undefined) return
  try {
    const url = JSON.parse(line).url
    if (typeof url === 'string' && url !== '') {
      ready = true
      console.log('READY ' + url)
    }
  } catch {
    // 还不是那一行
  }
})
host.stderr.setEncoding('utf8')
host.stderr.on('data', (chunk) => { process.stderr.write('[host] ' + chunk) })
host.on('exit', (code) => {
  console.error('[web] 宿主退出：' + String(code))
  process.exit(code === 0 ? 0 : 1)
})

const stop = () => {
  try { host.kill() } catch { /* 已经退了 */ }
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.stdin.on('close', stop)
// stdin 关掉（后台任务里很常见）也不立刻退出：让上层有足够时间截图，实例用完由上层杀进程树。
setTimeout(() => { /* 保活 */ }, 1 << 30)
