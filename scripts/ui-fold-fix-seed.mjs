/**
 * 折叠三缺陷截图用例的种子数据：只写隔离目录，用户真实的 ~/.dsc 一个字节都不碰。
 *
 * 三个会话各拍一张图（用例表见 `ui-fold-fix-shots.ps1`）：
 *   - `tail`   —— 缺陷一：一轮「思考 → 阶段性正文 → 工具 → 思考 → 工具 → 思考 → 工具」。
 *                 最后一条正文之后还压着 3 条思考与 2 条工具行；收起后屏幕上只该剩
 *                 「用时 X」那一行（修之前那些行会挂在开关下面）。
 *   - `live`   —— 缺陷二：一轮已经定稿的短对话，自检时再提交一句，由假端点吐两次工具
 *                 调用（read 秒回 + bash 睡 90 秒），于是屏幕上有一组「两条工具、最后一条
 *                 还在跑」的阶段组：标准档组头带实时详情，紧凑档只有类别。
 *   - `orphan` —— 缺陷三：第 1 轮发起了一次 read 却没有结果（模拟被中断），第 2 轮正常
 *                 收尾。重开这份会话时那条工具行以前永远显示「进行中」。
 *
 * 环境变量：
 *   FOLD_FIX_HOME      隔离 HOME（默认 desktop/shots/fold-fix-home）
 *   FOLD_FIX_PROCESS   写进 settings.json 的 ui.processFold（默认 standard）
 *   FOLD_FIX_PORT      假端点端口（默认 18952）
 *   FOLD_FIX_OUT       清单文件路径（默认 <home>/sessions.json）
 *
 * 用法：node scripts/ui-fold-fix-seed.mjs
 *
 * @module dsc/scripts/ui-fold-fix-seed
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.FOLD_FIX_HOME ?? 'D:\\dsc\\desktop\\shots\\fold-fix-home'
const processFold = process.env.FOLD_FIX_PROCESS ?? 'standard'
const port = Number(process.env.FOLD_FIX_PORT ?? 18952)
const out = process.env.FOLD_FIX_OUT ?? join(home, 'sessions.json')

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置；目录不存在时它直接崩掉。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

// 必须在 import 核心之前换掉 HOME/USERPROFILE：会话落盘位置按 homedir 算。
process.env.HOME = home
process.env.USERPROFILE = home

/** 假端点里 read 会读的那个文件（证明工具是真跑过的）。 */
const probeTarget = join(home, 'probe-target.txt')
writeFileSync(probeTarget, '这是一份供折叠自检读取的样张文件。\n', 'utf8')

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  [
    '# 折叠三缺陷自检专用：一个指向本机假端点的 provider（不联网、不花钱）',
    'default:',
    '  provider: fake',
    '  model: fake-chat',
    'providers:',
    '  fake:',
    '    displayName: 自检假端点',
    '    baseURL: http://127.0.0.1:' + String(port) + '/v1',
    '    apiKeyEnv: FOLD_FIX_KEY',
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
      // 假端点要跑 bash（睡 90 秒）看「跑动中的组头」：full-access 不弹审批卡。
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
        processFold,
      },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

const core = await import('../lib/core/session.js')
const readCall = (id, path) => ({
  id,
  name: 'read',
  arguments: JSON.stringify({ path }),
})

// ── 会话 1：缺陷一（最后一条正文之后还压着过程行） ─────────────────────────────
const tail = core.Session.create('D:\\dsc')
tail.appendUser('帮我把整轮过程折叠做一下，先说清楚你打算怎么改。')
tail.appendAssistant('先说明改法：过程整条收起，只留一行总开关。', '思考一：先看折叠区间是怎么算的。', [])
tail.appendAssistant('', '', [readCall('call_tail_a', 'D:\\dsc\\src\\packages\\ui-transcript\\ui\\round-fold.tsx')])
tail.appendTool('call_tail_a', 'read', '（读取成功：round-fold.tsx 已返回）')
tail.appendAssistant('', '思考二：终点取的是这一轮最后一条定稿正文。', [])
tail.appendAssistant('', '', [readCall('call_tail_b', 'D:\\dsc\\src\\packages\\ui-transcript\\ui\\render.tsx')])
tail.appendTool('call_tail_b', 'read', '（读取成功：render.tsx 已返回）')
tail.appendAssistant('', '思考三：正文之后的工具行就漏在折叠区间外面了。', [])
tail.appendAssistant('', '', [readCall('call_tail_c', 'D:\\dsc\\src\\packages\\ui-transcript\\ui\\process-groups.ts')])
tail.appendTool('call_tail_c', 'read', '（读取成功：process-groups.ts 已返回）')
tail.close()

// ── 会话 2：缺陷二（实时一轮由假端点驱动，这里只铺一条已定稿的短对话） ──────────
const live = core.Session.create('D:\\dsc')
live.appendUser('先跑一轮看看。')
live.appendAssistant('好，我看着。', '', [])
live.close()

// ── 会话 3：缺陷三（第 1 轮发起工具却没有结果，第 2 轮正常收尾） ─────────────────
const orphan = core.Session.create('D:\\dsc')
orphan.appendUser('读一下配置文件，看看日志级别。')
orphan.appendAssistant('我先读一下这个文件，稍等。', '', [
  readCall('call_orphan_read', 'D:\\dsc\\src\\packages\\ui-transcript\\ui\\render.tsx'),
])
// 这里**故意不 appendTool**：进程在「tool_calls 已落盘、结果还没写」之间被杀，就是这副样子。
orphan.appendUser('算了，先别读了。')
orphan.appendAssistant('好，那就先不读了。', '', [])
orphan.close()

writeFileSync(out, JSON.stringify({
  home,
  processFold,
  port,
  probeTarget,
  tail: tail.filePath,
  live: live.filePath,
  orphan: orphan.filePath,
}, null, 2) + '\n', 'utf8')

console.log('seeded ' + home + ' (processFold=' + processFold + ')')
console.log('tail:   ' + tail.filePath)
console.log('live:   ' + live.filePath)
console.log('orphan: ' + orphan.filePath)
