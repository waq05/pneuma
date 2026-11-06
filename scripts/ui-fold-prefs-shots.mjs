/**
 * 折叠两个新设置项（collapseTiming / foldedReplies）的截图宿主：隔离 HOME 起一个真宿主，
 * 把界面伺服出来，交给浏览器截图（Electron 的 capturePage 在这台机器上会被前台全屏窗口挡住）。
 *
 * 两个用例：
 *   --case live     —— 一条已经收尾的轮（阶段性正文 → 思考/工具 → 最终回答）。
 *                      截图脚本先把它拍成「next-input 摊着」，再提交一句让假端点回出第二轮，
 *                      拍「第一轮自动收起、第二轮摊着」。
 *   --case replies  —— 同形状的一条已收尾轮。拍「foldedReplies=all：收起后中间的阶段性正文
 *                      仍可见、思考与工具被折」，再把偏好改成 final 拍「同一份内容全折」。
 *
 * 隔离：HOME / USERPROFILE / DSC_HOME 全部指到 desktop/shots/fold-prefs-home，用户真实的
 * ~/.dsc 一个字节都不碰；设置里的两个新键在这个页面里用 setUiPrefs 下发（宿主侧由另一条线实现，
 * 界面侧只读 getUiPrefs 的值）。
 *
 * 用法：
 *   node scripts/ui-fold-prefs-shots.mjs --case live [--ui-port 18962] [--llm-port 18953]
 * 输出一行 READY <url>，之后进程保活，由截图方杀进程树。
 *
 * @module dsc/scripts/ui-fold-prefs-shots
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const root = 'D:\\dsc'
const home = join(root, 'desktop', 'shots', 'fold-prefs-home')
const which = argOf('--case', 'live')
const uiPort = argOf('--ui-port', '18962')
const llmPort = Number(argOf('--llm-port', '18953'))
/** 两项新偏好在启动前就写进隔离 settings.json（界面 mount 时读的就是它）。 */
const timing = argOf('--timing', which === 'live' ? 'next-input' : 'completion')
const replies = argOf('--replies', 'all')

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

// 必须在 import 核心之前换掉 HOME/USERPROFILE：会话落盘位置按 homedir 算。
process.env.HOME = home
process.env.USERPROFILE = home

const probeTarget = join(home, 'fold-prefs-probe.txt')
writeFileSync(probeTarget, '这是一份供折叠截图读取的样张文件。\n', 'utf8')

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  [
    '# 折叠截图专用：一个指向本机假端点的 provider（不联网、不花钱）',
    'default:',
    '  provider: fake',
    '  model: fake-chat',
    'providers:',
    '  fake:',
    '    displayName: 自检假端点',
    '    baseURL: http://127.0.0.1:' + String(llmPort) + '/v1',
    '    apiKeyEnv: FOLD_PREFS_KEY',
    '    models:',
    '      - id: fake-chat',
    '        name: Fake Chat',
    '        contextWindow: 128000',
    '        maxTokens: 4096',
    '',
  ].join('\n'),
  'utf8',
)

writeFileSync(
  join(home, '.dsc', 'settings.json'),
  JSON.stringify(
    {
      defaultPolicy: 'full-access',
      defaultEffort: null,
      marketSources: [],
      closeToTray: false,
      ui: {
        sessionSort: 'recent',
        sessionGroup: 'workspace',
        archivedFilter: 'hide',
        workspaceOrder: ['D:\\dsc'],
        workspaceAliases: {},
        themeMode: 'dark',
        fontSize: 1,
        buttonScale: 1,
        density: 'standard',
        processFold: 'standard',
        collapseTiming: timing,
        foldedReplies: replies,
      },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

const core = await import('../lib/core/session.js')
const readCall = (id, path) => ({ id, name: 'read', arguments: JSON.stringify({ path }) })

/** 一条已经收尾的轮：阶段性正文 → 两条思考/工具 → 最终回答。 */
const seed = core.Session.create('D:\\dsc')
seed.appendUser('帮我看看整轮折叠这一块，先说清楚你打算怎么改。')
seed.appendAssistant('先说改法：过程整段收起，只留一行「用时 X」总开关。', '思考一：先看折叠区间是怎么算的。', [
  readCall('call_fold_a', probeTarget),
])
seed.appendTool('call_fold_a', 'read', '（读取成功：样张文件已返回）')
seed.appendAssistant('', '思考二：正文之后还有工具，那一段也得跟着收起。', [
  readCall('call_fold_b', probeTarget),
])
seed.appendTool('call_fold_b', 'read', '（读取成功：样张文件已返回）')
seed.appendAssistant('改法定了：藏哪些行由一份下标集合决定，收起后中间那段阶段交代仍然留在屏幕上。', '', [])
seed.close()

// ── 假端点：只回一次「思考 + 正文」，够第二轮进来就够了（不调工具、不花钱） ──────────
const llm = createServer((req, res) => {
  if (req.method !== 'POST' || !(req.url ?? '').includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('fake: 只有 /chat/completions')
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    void body
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n')
    const delta = (patch, finish = null) =>
      send({ choices: [{ index: 0, delta: patch, finish_reason: finish }] })
    delta({ reasoning_content: '第二轮思考：这一轮只回一句话，用来把上一轮挤成历史轮。\n' })
    delta({ content: '第二轮回答：收到，这一句就是新的一轮。' })
    delta({}, 'stop')
    send({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((resolve) => llm.listen(llmPort, '127.0.0.1', resolve))

const host = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
  cwd: root,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSC_HOME: join(home, '.dsc'),
    DSC_UI_SERVER: '1',
    DSC_UI_PORT: uiPort,
    DSC_UI_HMR: '0',
    DSC_RESUME_SESSION: seed.filePath,
    FOLD_PREFS_KEY: 'sk-selfcheck-fake',
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
      console.log('READY ' + url + ' case=' + which)
    }
  } catch {
    // 还不是那一行
  }
})
host.stderr.setEncoding('utf8')
host.stderr.on('data', (chunk) => process.stderr.write('[host] ' + chunk))
host.on('exit', (code) => {
  console.error('[shots] 宿主退出：' + String(code))
  process.exit(code === 0 ? 0 : 1)
})

const stop = () => {
  try {
    host.kill()
  } catch {
    // 已经退了
  }
  try {
    llm.close()
  } catch {
    // 已经关了
  }
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.stdin.on('close', () => {
  // 后台任务里 stdin 常常立刻关闭：不跟着退，留给截图方时间
})
setTimeout(() => {
  // 保活
}, 1 << 30)
