/**
 * 「会话脚注与思考折叠改版」自检的种子数据：只写 `desktop/shots/tf-home`（临时 HOME +
 * 临时 userData），用户真实的 `~/.dsc` 与真实 workspace 一个字节都不写。
 *
 * 造三条会话：
 *   tf-static.jsonl —— 静态样张：两条多段思考（首行与「最后一段首行」故意不同，用来分辨
 *                      摘要取的是哪一种口径）、一条长思考（展开必然超过 400px，验证展开区
 *                      的吸附快捷栏与高度过渡）、一条短思考；两轮对话 ⇒ 两个页脚。
 *   tf-other.jsonl  —— 跨重放用：切到它再切回来，宿主会把 tf-static 整表重建，
 *                      用来验证折叠态的存档（fold-state.ts）没坏。
 *   tf-live.jsonl   —— 实时样张：一轮干净对话，配 tf-fake-llm.mjs 慢慢吐思考，
 *                      用来拍「跑动中」的折叠态（摘要取写完段落的首行 + 扫光）。
 *
 * 环境变量：
 *   TF_THEME=dark|light   写进 settings.json 的 ui.themeMode（默认 dark）
 *   TF_FAKE_PORT=18941    config.yaml 里假端点的端口
 *
 * 用法：node shots/tf-seed.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = 'D:\\dsc\\desktop\\shots\\tf-home'
const theme = process.env.TF_THEME === 'light' ? 'light' : 'dark'
const port = Number(process.env.TF_FAKE_PORT ?? 18941)

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })

// 必须在 import 核心之前换掉 HOME/USERPROFILE：会话落盘位置是按 homedir 算的。
process.env.HOME = home
process.env.USERPROFILE = home

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 会话脚注与思考折叠自检专用：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:${String(port)}/v1
    apiKeyEnv: TF_FAKE_KEY
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

/**
 * 多段思考：收工后摘要取「首行」（第一段），跑动中取「最新写完的段落首行」。
 * 两条口径在同一个文本上给出不同答案，截图脚本据此分辨接口取的是哪一种。
 * 段落之间空行分隔（与 dsh latestCompletedParagraphFirstLine 的段落定义一致）。
 */
const thinkMulti = [
  '第一段首行：先把三条改版各自的位置量清楚。',
  '第一段第二行：页脚在右缘、把手在列外 24px、折叠条只有标题。',
  '',
  '第二段首行：思考折叠改按 dsh 的 ReasoningRow。',
  '第二段第二行：摘要取写完的段落首行，跑动中带扫光。',
  '',
  '第三段首行：最后把三处坐标再量一遍收工。',
].join('\n')

/** 长思考：30 段，展开必然超过 400px，折叠条展开后该出现吸附快捷栏。 */
const thinkLong = Array.from(
  { length: 30 },
  (_, index) => `第 ${String(index + 1)} 段：长思考用来验证展开区的吸附快捷栏与高度过渡。`,
).join('\n\n')

/** 短思考：展开也远不到 400px，不该出现快捷栏。 */
const thinkShort = ['短思考：只占两行，展开也到不了 400px。', '第二行：就是用来对照那两条长思考的。'].join('\n')

const fill = (lines) =>
  Array.from(
    { length: lines },
    (_, index) =>
      `第 ${String(index + 1)} 句：改版以后每轮的元信息都贴正文左缘，读完一段回复不用横跨整屏找分叉入口。`,
  ).join('')

// ── 静态样张：两轮对话 ──
const seed = core.Session.create('D:\\dsc')

seed.appendUser('对话区三条改版：脚注左移、思考折叠照 dsh 的 ReasoningRow、拖宽把手贴到正文列边缘。先看一眼现状。')
seed.appendAssistant(`现状看完了。${fill(3)}`, thinkMulti, [])
seed.appendAssistant(`这一段的思考很长，展开会超过 400px。${fill(3)}`, thinkLong, [])
seed.appendAssistant('最后一段短思考，用来对照那两条。', thinkShort, [])

seed.appendUser('第二条：把手现在离正文列有多远？')
seed.appendAssistant('量完了：把手中心已经压在正文列的左右缘上，热区一半在列外、一半落在列内缩里。', thinkShort, [])

seed.close()

// ── 跨重放用：另一条会话，切过去再切回来 ──
// 条目形状故意与静态样张错开（第一条助手消息带一次工具调用、没有思考）：
// fold-state 的键是「会话:序号」，而 React 是按 ChatView 的 key={entry.id} 对账的——
// 两条会话的前几个 id 位置如果都是「思考折叠条」，React 会把上一条会话的组件实例直接
// 复用给下一条（状态跟着实例走，存档根本读不到）。形状错开才是「换会话再切回来」的真实样子。
const other = core.Session.create('D:\\dsc')
other.appendUser('这是另一条会话，只用来说「切走再切回来」。')
other.appendAssistant('好，我先读一个文件再回答。', '', [
  { id: 'call_other_1', name: 'read', arguments: JSON.stringify({ path: 'README.md' }) },
])
other.appendTool('call_other_1', 'read', '# Muse Code 桌面端\n前几行内容，用来占一条工具卡。')
other.appendAssistant('读完了，我这边没有任何要改的东西。', '另一条会话的短思考，与本条无关。', [])
other.close()

// ── 实时样张：一轮干净对话，等着假端点慢慢吐思考 ──
const live = core.Session.create('D:\\dsc')
live.appendUser('把跑动中的思考念一段给我看看。')
live.appendAssistant('好，我一边想一边往外写。', '', [])
live.close()

console.log(`seeded ${home} (theme=${theme})`)
console.log(`static session: ${seed.filePath}`)
console.log(`other session:  ${other.filePath}`)
console.log(`live session:   ${live.filePath}`)
// 把三条路径留给截图脚本用：会话文件名是随机 id，脚本不该去猜。
writeFileSync(
  'D:\\dsc\\desktop\\shots\\tf-sessions.json',
  `${JSON.stringify(
    { home, theme, static: seed.filePath, other: other.filePath, live: live.filePath },
    null,
    2,
  )}\n`,
  'utf8',
)
