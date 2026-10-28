/**
 * 「对话区修正批」自检的种子数据：只写 `desktop/shots/fix2-home`（临时 HOME + 临时 userData +
 * 临时 DSC_HOME），用户真实的 `~/.dsc` 与真实 workspace 一个字节都不写。
 *
 * 造四条会话：
 *   fix2-fold-a.jsonl —— 折叠修复的「第一条」：user → assistant(正文 + 思考)，形状就是
 *                        user / text / thinking 三条内容条目。
 *   fix2-fold-b.jsonl —— 折叠修复的「第二条」：形状与 fold-a **完全一样**（也是
 *                        user / text / thinking），只有这样宿主重放时 React 才会
 *                        按 key 把上一条会话的组件实例复用给下一条——第 3 条要修的就是它。
 *   fix2-live.jsonl   —— 流式滚动用：一轮已收工的干净对话（配 fix2-fake-llm.mjs 慢慢吐长回复）。
 *   fix2-btn.jsonl    —— 按钮尺寸用：一轮对话就够（用户气泡 + 助手正文 + 每轮页脚），
 *                        三种消息操作按钮（复制/赞/踩、气泡下的编辑、页脚里的分叉）都在这一屏。
 *
 * 环境变量：
 *   FIX2_THEME=dark|light   写进 settings.json 的 ui.themeMode（默认 dark）
 *   FIX2_FAKE_PORT=18951    config.yaml 里假端点的端口
 *
 * 用法：node shots/fix2-seed.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = 'D:\\dsc\\desktop\\shots\\fix2-home'
const theme = process.env.FIX2_THEME === 'light' ? 'light' : 'dark'
const port = Number(process.env.FIX2_FAKE_PORT ?? 18951)

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })

// 必须在 import 核心之前换掉 HOME/USERPROFILE/DSC_HOME：会话落盘位置是按 homedir 算的，
// 而 path-policy 的 DSC_HOME 是模块加载时读的环境变量。
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 对话区修正批自检专用：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:${String(port)}/v1
    apiKeyEnv: FIX2_FAKE_KEY
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

/** 多条正文，让助手那一条足够长（按钮那一屏要有正文可看）。 */
const fill = (lines) =>
  Array.from(
    { length: lines },
    (_, index) =>
      `第 ${String(index + 1)} 句：消息操作条上的按钮这次按 dsh 的 28px hit area 与 15/17px 图标校准，并且跟着「按钮大小」滑杆一起缩放。`,
  ).join('')

/** 折叠条的思考原文：展开后要能看出「确实展开了」，不是一行摘要。 */
const think = (tag) =>
  [
    `${tag} 第一段：这条思考是被自检点开的那一条。`,
    `${tag} 第二段：切到另一条会话再切回来，它必须还是展开的。`,
    `${tag} 第三段：展开态由 fold-state.ts 的存档读回，不靠 React 实例复用。`,
  ].join('\n\n')

// ── 折叠修复用：两条形状完全相同的会话 ──
const foldA = core.Session.create('D:\\dsc')
foldA.appendUser('会话甲：点开我这轮的思考折叠条，然后切到会话乙再切回来。')
foldA.appendAssistant(`会话甲的回复正文。${fill(2)}`, think('会话甲'), [])
foldA.close()

const foldB = core.Session.create('D:\\dsc')
foldB.appendUser('会话乙：形状与会话甲一模一样，专门用来撞出 React 的实例复用。')
foldB.appendAssistant(`会话乙的回复正文，形状与会话甲一致。${fill(2)}`, think('会话乙'), [])
foldB.close()

// ── 按钮尺寸用：一轮收工的对话 ──
const btn = core.Session.create('D:\\dsc')
btn.appendUser('量一下消息操作条上那几颗按钮的尺寸：气泡下的编辑、正文末尾的复制/赞/踩、页脚里的分叉。')
btn.appendAssistant(`量完了，三种按钮都在这一屏。${fill(3)}`, think('按钮样张'), [])
btn.close()

// ── 流式滚动用：一轮已收工的对话，等假端点慢慢吐长回复 ──
const live = core.Session.create('D:\\dsc')
live.appendUser('先随便说一句，等会儿我要在流式输出的时候往上翻历史。')
live.appendAssistant('好，我等着。', '', [])
live.close()

console.log(`seeded ${home} (theme=${theme})`)
console.log(`fold-a session: ${foldA.filePath}`)
console.log(`fold-b session: ${foldB.filePath}`)
console.log(`btn session:    ${btn.filePath}`)
console.log(`live session:   ${live.filePath}`)
// 把四条路径留给截图脚本用：会话文件名是随机 id，脚本不该去猜。
writeFileSync(
  'D:\\dsc\\desktop\\shots\\fix2-sessions.json',
  `${JSON.stringify(
    { home, theme, foldA: foldA.filePath, foldB: foldB.filePath, btn: btn.filePath, live: live.filePath },
    null,
    2,
  )}\n`,
  'utf8',
)
