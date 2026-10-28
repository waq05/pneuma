/**
 * UI 修复自检（turn-fold 分节线 + 5px 滚动条）的种子数据：只写 `desktop/shots/ui-home`，
 * 真实的 ~/.dsc 一个字节都不写（跑前跑后指纹比对在 ui-fix-shots.ps1 里）。
 *
 * 会话造了两轮，正好覆盖折叠行的两种形态（0.6.35 实机反馈的问题行）：
 *   - 第 0 轮：用户问好 → 助手纯文本回答（没有 reasoning / 工具）→ 无过程内容，
 *     折叠行画成不可点的「用时 2秒」、无 chevron——就是实机截图里被圈成
 *     「散落灰字」的那一行，现在它该带 0.5px 下边框、读作分节线；
 *   - 第 1 轮：带 reasoning + 工具调用的完整轮 → 折叠行可点、带 chevron。
 *
 * 环境变量：无（主题固定 dark）。
 *
 * 用法：node desktop/shots/ui-seed.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = 'D:\\dsc\\desktop\\shots\\ui-home'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })
// Chromium 在 app ready 之前要找 %USERPROFILE%\AppData\Roaming，不存在会直接崩
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# UI 自检专用：只重放历史不发请求，端点指一个不存在的本机端口即可
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:18960/v1
    apiKeyEnv: UI_FAKE_KEY
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
        themeMode: 'dark',
        fontSize: 1,
        buttonScale: 1,
        density: 'standard',
        processFold: 'standard',
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

const id = '3f9b1c64-0000-4a52-8e10-00000000e2b7'
const base = Date.now() - 600_000
const at = (offset) => base + offset

const records = [
  { type: 'meta', id, cwd: 'D:\\dsc', createdAt: at(-300_000) },
  // 第 0 轮：无过程内容 → 折叠行「用时 2秒」不可点（对照实机截图被圈的那一行）
  { type: 'user', text: '你好', ts: at(0) },
  { type: 'assistant', text: '你好，兄弟。我是 dsc，跑在你桌面里的编程助手。要干点什么？', ts: at(2_000) },
  // 第 1 轮：带过程内容 → 折叠行「用时 X」可点、带 chevron
  { type: 'user', text: '帮我看看当前目录下有哪些文件。', ts: at(10_000) },
  {
    type: 'assistant',
    text: '',
    reasoning: '先列一下工作区根目录，把文件名报给用户。',
    toolCalls: [
      { id: 'call_ui_fix_ls', name: 'fs-list', arguments: JSON.stringify({ path: '.' }) },
    ],
    ts: at(11_000),
  },
  { type: 'tool', callId: 'call_ui_fix_ls', name: 'fs-list', text: 'desktop/\nsrc/\ndocs/\npackage.json', ts: at(12_000) },
  { type: 'assistant', text: '根目录下有 desktop/、src/、docs/ 三个目录和 package.json。', reasoning: '', ts: at(21_000) },
]

const dir = join(home, '.dsc', 'sessions', 'D-dsc')
mkdirSync(dir, { recursive: true })
const file = join(dir, `${id}.jsonl`)
writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')

writeFileSync(
  'D:\\dsc\\desktop\\shots\\ui-sessions.json',
  `${JSON.stringify({ home, session: file }, null, 2)}\n`,
  'utf8',
)

console.log(`seeded ${home}`)
console.log(`ui session: ${file}`)
