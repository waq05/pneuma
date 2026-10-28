/**
 * 工具卡折叠自检的种子数据：只写 `desktop/shots/tc-home`（临时 HOME + 临时 userData），
 * 用户真实的 `~/.dsc` 与真实 workspace 一个字节都不写。
 *
 * 造两张会话：
 *   tc-seed.jsonl  —— 静态样张用：短卡（展开也不到 400px，不该出现快捷栏）、长卡（展开
 *                     必然超过 400px）、失败卡、已拒绝卡、以及一条「没有结果记录」的
 *                     进行中卡（重放时 adapter 就把它算成 running）。
 *   tc-live.jsonl  —— 实时样张用：只有一轮干净对话，配 tc-fake-llm.mjs 跑一次真工具调用，
 *                     用来验证「完成 + 用时」那条路径（静态重放的卡片量不到耗时）。
 *
 * 环境变量：
 *   TC_THEME=dark|light   写进 settings.json 的 ui.themeMode（默认 dark）
 *   TC_FAKE_PORT=18931    config.yaml 里假端点的端口
 *
 * 用法：node shots/tc-seed.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = 'D:\\dsc\\desktop\\shots\\tc-home'
const theme = process.env.TC_THEME === 'light' ? 'light' : 'dark'
const port = Number(process.env.TC_FAKE_PORT ?? 18931)

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })

// 必须在 import 核心之前换掉 HOME/USERPROFILE：会话落盘位置是按 homedir 算的。
process.env.HOME = home
process.env.USERPROFILE = home

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 工具卡自检专用：一个指向本机假端点的 provider（不联网、不花钱）
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:${String(port)}/v1
    apiKeyEnv: TC_FAKE_KEY
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

// ── 造一段「够长」的内容：长卡要真的超过 400px，快捷栏才有出现的理由 ──────────────
const longLines = Array.from({ length: 90 }, (_, index) => {
  const n = index + 1
  return `${String(n).padStart(3, '0')} | 第 ${String(n)} 行快照：节点树 tool-card > tool-head > tool-body，可见文本与坐标都已记录，供模型挑选可点元素。`
})
const longResult = longLines.join('\n')
const longScript = Array.from(
  { length: 40 },
  (_, index) =>
    `  const card${String(index)} = document.querySelectorAll('.tool-card')[${String(index)}]; // 第 ${String(index + 1)} 行：量一次高度`,
).join('\n')

const seed = core.Session.create('D:\\dsc')

/**
 * 给助手的一句说明垫上一段正文。
 * 为什么需要：吸附快捷栏只有在「内容能滚」时才看得出来（不能滚的时候它本来就停在原位），
 * 所以种子会话必须有足够的高度，长卡才能被滚到视口上方去。
 */
const filler = (lines) =>
  Array.from(
    { length: lines },
    (_, index) =>
      `第 ${String(index + 1)} 段：工具卡折叠以后，一屏能扫过的调用条数翻了一倍；要看的细节再点开，展开区顶部还留着一条收起栏。`,
  ).join('\n')

seed.appendUser('帮我把对话流里的工具调用卡改一下：默认只留一行，展开以后别把整屏占满。')

// 开场先垫一段长正文：吸附快捷栏只有在「内容真的能滚」时才看得出来
//（不能滚的时候它本来就停在原位），所以种子会话得有足够高度。
seed.appendAssistant(filler(14), '', [])

// 短卡：参数与结果都只有几行，展开远不到 400px —— 这张卡不该出现吸附快捷栏。
seed.appendAssistant('先查一下 sticky 与 overflow 的既有结论。', '', [
  {
    id: 'call_seed_short',
    name: 'web_search',
    arguments: JSON.stringify({ query: 'CSS position sticky overflow hidden 祖先 建构' }),
  },
])
seed.appendTool(
  'call_seed_short',
  'web_search',
  '搜到 3 条：\n1. sticky 的吸附参照是最近的滚动容器；\n2. overflow: hidden 的祖先自己就成了滚动容器；\n3. 所以吸附栏要么换参照系，要么让卡片展开时放开裁剪。',
)

// 长卡：参数里带一串长地址、结果 90 行 —— 展开必然超过 400px，快捷栏该出现。
seed.appendAssistant('把搜索页的可见文本整段抓回来对照。', '', [
  {
    id: 'call_seed_long',
    name: 'browser',
    arguments: JSON.stringify({
      action: 'goto',
      url: `https://www.bing.com/search?q=${encodeURIComponent('工具调用卡 折叠 紧凑行 吸附快捷栏')}&form=QBLH&filters=ex1%3a%22ez1%22&tsc=ImageBasicHover`,
    }),
  },
])
seed.appendTool('call_seed_long', 'browser', longResult)

// 失败卡：语义色那一档要看得到（左侧竖条与状态文字都是红的）。
seed.appendAssistant('再读一下打包配置。', '', [
  {
    id: 'call_seed_failed',
    name: 'read',
    arguments: JSON.stringify({ path: 'D:\\dsc\\desktop\\electron-builder-not-exist.yml' }),
  },
])
seed.appendTool(
  'call_seed_failed',
  'read',
  'ENOENT: no such file or directory, open \'D:\\dsc\\desktop\\electron-builder-not-exist.yml\'',
  'tool-error',
)

// 已拒绝卡：用户拒掉的写盘动作，状态位走黄色那一档。
seed.appendAssistant('这一步要往用户主目录写配置。', '', [
  {
    id: 'call_seed_rejected',
    name: 'write',
    arguments: JSON.stringify({ path: 'C:\\Users\\waq\\.dsc\\config.yaml', content: 'default:\n  provider: fake\n' }),
  },
])
seed.appendTool('call_seed_rejected', 'write', '用户拒绝了这次调用：改用户主目录的配置属于越界写。', 'rejected')

// 进行中卡：只写了工具调用、没有结果记录 —— 重放时 adapter 就把它折成 running，
// 参数里的表达式故意很长，展开后能同时看到「进行中的吸附栏（没有收起按钮）」。
seed.appendAssistant('最后量一遍每张卡的高度。', '', [
  {
    id: 'call_seed_running',
    name: 'browser',
    arguments: JSON.stringify({ action: 'evaluate', expression: longScript }),
  },
])

seed.appendAssistant(filler(30), '', [])

seed.close()

// 实时样张用的干净会话：一轮对话，没有悬空的工具调用（悬空会让协议消息缺配对结果）。
const live = core.Session.create('D:\\dsc')
live.appendUser('把刚才那处改动跑一遍自检，看工具卡是不是只有一行。')
live.appendAssistant('好，我调一次读文件把改动确认一遍。', '', [])
live.close()

console.log(`seeded ${home} (theme=${theme})`)
console.log(`static session: ${seed.filePath}`)
console.log(`live session:   ${live.filePath}`)
// 把两条路径留给截图脚本用：会话文件名是随机 id，脚本不该去猜。
writeFileSync(
  'D:\\dsc\\desktop\\shots\\tc-sessions.json',
  `${JSON.stringify({ home, theme, static: seed.filePath, live: live.filePath }, null, 2)}\n`,
  'utf8',
)


