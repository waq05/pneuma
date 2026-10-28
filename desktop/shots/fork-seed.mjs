/**
 * 「每轮分叉与编辑重发」自检的种子会话：只写 desktop/shots/fork-home（临时 HOME +
 * 临时 userData），用户真实的 ~/.dsc 一个字节都不写。
 *
 * 为什么不用 tc-seed：那份种子只有一条用户消息，编辑重发与「分叉到第 N 条之前」
 * 都需要至少两条用户消息才看得出「这条之前的全部内容」到底复制没复制。
 *
 * 造一条会话（两条用户消息、两种折叠条）：
 *   user「第一轮：把对话流的工具卡收成一行」
 *   assistant 正文 + thinking + 一张工具卡
 *   user「第二轮：折叠条的 hover 底色再改一档」
 *   assistant 正文 + 一张工具卡
 *
 * 用法：node shots/fork-seed.mjs   （输出路径写进 fork-sessions.json）
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const shots = 'D:\\dsc\\desktop\\shots'
const home = join(shots, 'fork-home')
const theme = process.env.FORK_THEME === 'light' ? 'light' : 'dark'
const port = Number(process.env.FORK_FAKE_PORT ?? 18961)

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'sessions'), { recursive: true })

// 必须在 import 核心之前换掉 HOME/USERPROFILE：会话落盘位置按 homedir 算。
process.env.HOME = home
process.env.USERPROFILE = home

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 分叉/编辑自检专用：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:${String(port)}/v1
    apiKeyEnv: FORK_FAKE_KEY
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
      defaultPolicy: null,
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
        fontSize: 'md',
        density: 'standard',
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

const core = await import('../../lib/core/session.js')

const seed = core.Session.create('D:\\dsc')

seed.appendUser('第一轮：帮我把对话流里的工具卡收成一行，展开再看细节。')
seed.appendAssistant(
  '先看一下现有工具卡的结构：紧凑行负责扫视，展开区放参数与结果。',
  '用户要的是「一屏扫过更多调用」；那我得把入参从行上挪进展开区，行上只留摘要。',
  [
    {
      id: 'call_fork_seed_1',
      name: 'read',
      arguments: JSON.stringify({ path: 'D:\\dsc\\desktop\\src\\renderer\\ToolCard.tsx' }),
    },
  ],
)
seed.appendTool('call_fork_seed_1', 'read', '读到了 301 行：紧凑行 + 展开区 + 超 400px 的吸附快捷栏。')

seed.appendUser('第二轮：折叠条的 hover 底色再改一档，跟侧栏那套令牌对齐。')
seed.appendAssistant('好，我把 hover 与按下两档都换成控制层令牌，这样两处不会各自漂。', '', [
  {
    id: 'call_fork_seed_2',
    name: 'bash',
    arguments: JSON.stringify({ command: 'rg -n "control-hover-bg" D:/dsc/desktop/src/renderer/styles.css' }),
  },
])
seed.appendTool('call_fork_seed_2', 'bash', '12 处命中：.meta-btn、.tool-head、.think-head 都在用同一档。')
seed.close()

console.log(`seeded ${home} (theme=${theme})`)
console.log(`session: ${seed.filePath}`)
writeFileSync(
  join(shots, 'fork-sessions.json'),
  `${JSON.stringify({ home, theme, static: seed.filePath }, null, 2)}\n`,
  'utf8',
)
