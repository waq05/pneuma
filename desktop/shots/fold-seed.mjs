/**
 * 「整轮过程折叠 + 脚注合并」桌面自检的种子数据：只写 `desktop/shots/fold-home`
 * （临时 HOME + 临时 userData），用户真实的 `~/.dsc` 与真实 workspace 一个字节都不写。
 *
 * 造三样东西：
 *   folder-seed.jsonl  —— 静态样张：三轮对话，覆盖三种过程区形态
 *                         · 第 1 轮：思考 + 中间正文 + 工具卡 + 最终正文（组内 3 条，页脚挂在最终正文上）
 *                         · 第 2 轮：思考 + 最终正文（组内 1 条）
 *                         · 第 3 轮：中间正文 + 工具卡、**没有最终正文**（组内 2 条，页脚正好挂在
 *                           组内最后一条上——这是「收起时页脚不能跟着消失」那条边界的实测样张）
 *   folder-live.jsonl  —— 实时样张：一轮已定稿的对话（带思考，于是它自己也有一个总开关），
 *                         再配 fold-fake-llm.mjs 跑一轮真对话，用来验「跑动中不画总开关」
 *                         「定稿后自动收起」「用量显示宿主上报的真值」。
 *
 * 环境变量：
 *   FOLD_THEME=dark|light   写进 settings.json 的 ui.themeMode（默认 dark）
 *   FOLD_PROCESS_FOLD=...   写进 ui.processFold（默认 standard）
 *   FOLD_FAKE_PORT=18951    config.yaml 里假端点的端口
 *
 * 用法：node shots/fold-seed.mjs（在 desktop/ 下）
 *
 * @module desktop/shots/fold-seed
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = 'D:\\dsc\\desktop\\shots\\fold-home'
const theme = process.env.FOLD_THEME === 'light' ? 'light' : 'dark'
const processFold = process.env.FOLD_PROCESS_FOLD ?? 'standard'
const port = Number(process.env.FOLD_FAKE_PORT ?? 18951)

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置；这个目录不存在时
// 它直接崩掉（0x80000003，stdout 一个字都留不下），所以隔离目录必须预先建好它。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

// 必须在 import 核心之前换掉 HOME/USERPROFILE：会话落盘位置是按 homedir 算的。
process.env.HOME = home
process.env.USERPROFILE = home

// 假端点要读的那份文件：实时样张里模型会调一次 read，读的就是它。
const probeTarget = join(home, 'probe-target.txt')
writeFileSync(probeTarget, '这是一份供自检读取的样张文件：整轮过程折叠的实时用例读它。\n', 'utf8')

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 整轮过程折叠自检专用：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:${String(port)}/v1
    apiKeyEnv: FOLD_FAKE_KEY
    models:
      - id: fake-chat
        name: Fake Chat
        contextWindow: 128000
        maxTokens: 4096
`,
  'utf8',
)

writeFileSync(
  join(home, '.dsc', 'settings.json'),
  `${JSON.stringify(
    {
      // 实时用例里模型要调一次 read 工具：readonly 策略放行只读工具，不会弹审批卡。
      defaultPolicy: 'readonly',
      defaultEffort: null,
      marketSources: [],
      closeToTray: false,
      ui: {
        sessionSort: 'recent',
        sessionGroup: 'workspace',
        archivedFilter: 'hide',
        workspaceOrder: ['D:\\dsc'],
        workspaceAliases: {},
        themeMode: theme,
        fontSize: 1,
        buttonScale: 1,
        density: 'standard',
        processFold,
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

const core = await import('../../lib/core/session.js')

const MID_REASONING = [
  '思考第一段：先看 ChatView 怎么切轮，再看条目类型有哪几种。',
  '思考第一段第二行：轮次边界是「用户消息到下一条用户消息」。',
  '',
  '思考第二段：过程区只认 thinking / tool / 中间正文，计划卡不进组。',
  '思考第二段第二行：跑动中的轮不折。',
  '',
].join('\n')

const seed = core.Session.create('D:\\dsc')

// ── 第 1 轮：思考 + 中间正文 + 工具卡 + 最终正文（组内 3 条） ────────────────────
seed.appendUser('帮我把整轮过程折叠做一下，先说清楚你打算怎么改。')
seed.appendAssistant(
  '先说明改法：过程条目整组收起，原位只留一行总开关。',
  MID_REASONING,
  [],
)
seed.appendAssistant('先读一下轮次切分的实现确认边界。', '', [
  {
    id: 'call_fold_read',
    name: 'read',
    arguments: JSON.stringify({ path: 'D:\\dsc\\desktop\\src\\renderer\\turn-timing.ts' }),
  },
])
seed.appendTool(
  'call_fold_read',
  'read',
  'export interface RoundInfo { index: number; startIndex: number; endIndex: number; startTs: number | null; endTs: number | null; answered: boolean }',
)
seed.appendAssistant(
  '最终回答：一轮 = 用户消息到下一条用户消息之前，过程区就是这中间除最后一条定稿正文以外的部分。',
  '',
  [],
)

// ── 第 2 轮：思考 + 最终正文（组内 1 条） ────────────────────────────────────────
seed.appendUser('那计划卡会不会被一起收起来？')
seed.appendAssistant(
  '最终回答：计划卡不折叠。审批流要看得见，收起过程不能把「等你点批准」也藏掉。',
  '思考：确认 exit_plan_mode 交上来的是 plan 条目，它属于独立类型。',
  [],
)

// ── 第 3 轮：**没有最终正文**（组内两条，页脚正好落在组内最后一条上） ─────────────
// 这一轮的形态是「用户消息 + 思考 + 工具卡」，一句正文都没有：按「本轮最后一条定稿 text
// 之前」那条口径，answerIndex 找不到（-1），于是整轮都算过程区，页脚挂在组内最后一条工具卡上。
// 它验的是「收起过程不能把复制 / 分叉 / 用量整行一起收掉」这条边界。
seed.appendUser('最后量一遍高度就行，不用再写总结了。')
seed.appendAssistant('', '思考：只量高度，不写总结，量完就收工。', [
  {
    id: 'call_fold_measure',
    name: 'read',
    arguments: JSON.stringify({ path: 'D:\\dsc\\desktop\\src\\renderer\\ChatView.tsx' }),
  },
])
seed.appendTool('call_fold_measure', 'read', '（读取成功：ChatView.tsx 已按行返回，内容从略）')

seed.close()

// ── 实时样张：一轮已定稿的对话（带思考，于是它自己也有总开关） ────────────────────
const live = core.Session.create('D:\\dsc')
live.appendUser('把刚才那处改动跑一遍自检，顺便看一眼用量是不是真值。')
live.appendAssistant('好，我调一次读文件把改动确认一遍。', '思考：先确认一下入口在哪。', [])
live.close()

console.log(`seeded ${home} (theme=${theme}, processFold=${processFold})`)
console.log(`static session: ${seed.filePath}`)
console.log(`live session:   ${live.filePath}`)
console.log(`probe target:   ${probeTarget}`)
// 把路径留给截图脚本用：会话文件名是随机 id，脚本不该去猜。
writeFileSync(
  'D:\\dsc\\desktop\\shots\\fold-sessions.json',
  `${JSON.stringify({ home, theme, processFold, static: seed.filePath, live: live.filePath, probeTarget }, null, 2)}\n`,
  'utf8',
)
