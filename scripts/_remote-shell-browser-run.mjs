/**
 * 「手机端切壳」的浏览器走查后端：在隔离 HOME 里真拉起 headless 宿主（远程控制开在固定端口），
 * 生成一张配对码，把 {port, code} 以 JSON 打到 stdout，然后保持运行——前台由浏览器走查
 * 脚本（Browser Use / 人工）打开 http://127.0.0.1:<port>/，走真实配对页 → 进壳。
 *
 * 用法：node scripts/_remote-shell-browser-run.mjs
 * 结束：stdin 关闭或进程被 kill（宿主随退出）。
 *
 * @module dsc/scripts/_remote-shell-browser-run
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const repo = 'D:\\dsc'
const home = join(repo, 'scripts', '.remote-browser-home')

/** 由系统挑一个空闲端口。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

const port = await freePort()
rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc'), { recursive: true })
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
writeFileSync(
  join(home, '.dsc', 'settings.json'),
  `${JSON.stringify({ remote: { enabled: true, port, lan: false } }, null, 2)}\n`,
  'utf8',
)

const child = spawn(process.execPath, ['lib/headless.js'], {
  cwd: repo,
  env: { ...process.env, HOME: home, USERPROFILE: home },
  stdio: ['pipe', 'pipe', 'inherit'],
})

let buffer = ''
let said = false
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index < 0) break
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (!said && message.type === 'hello') {
      said = true
      child.stdin.write(`${JSON.stringify({ type: 'invoke', id: 1, method: 'runSettingAction', args: ['remote', 'regenerate-code'] })}\n`)
    }
    if (message.type === 'result' && message.id === 1) {
      const code = message.ok === true ? message.value?.data?.code ?? '' : ''
      console.log(JSON.stringify({ port, code, ready: code !== '' }))
    }
  }
})

const stop = () => {
  try {
    child.kill()
  } catch {
    // 已经退了
  }
  process.exit(0)
}
process.stdin.on('end', stop)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
