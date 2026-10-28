/**
 * 收尾自检（批次 A–E UI 实机目检）的种子数据：只写 `desktop/shots/final-home`，
 * 真实的 ~/.dsc 一个字节都不写（跑前跑后指纹比对在 final-shots.ps1 里）。
 *
 * 覆盖的 UI（重放路径与「打开老会话」完全相同）：
 *   - T18 findings 卡：user 条目整条被 <review-findings> 包裹（deliverReview 写回的形态），
 *     两条带位置的 finding 的路径/行号都指向真实存在的文件（工作区就是 D:\dsc 本仓库），
 *     点位置按钮能真的打开 preview 并高亮到那一行；
 *   - T14 @ 面板：候选来自工作区 fs-list（D:\dsc），@dock 应出 dock-model.ts；
 *
 * 环境变量：无（主题固定 dark）。
 *
 * 用法：node desktop/shots/final-seed.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = 'D:\\dsc\\desktop\\shots\\final-home'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })
// Chromium 在 app ready 之前要找 %USERPROFILE%\AppData\Roaming，不存在会直接崩
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 收尾自检专用：只重放历史不发请求，端点指一个不存在的本机端口即可
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:18960/v1
    apiKeyEnv: FINAL_FAKE_KEY
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

const id = '7c1d22a8-0000-4b71-9a02-00000000f1a2'
const base = Date.now() - 300_000
const at = (offset) => base + offset

// findings 的正文与 T18 deliverReview 写回的形态一致：整条 <review-findings> 包裹，
// 头部行之前的引言进 trailing，条目按「### [P?] 标题 / 位置：相对路径:行号」的约定格式。
const FINDINGS_TEXT = `<review-findings teammate="reviewer" state="completed">
已完成对批次 D（/review 升级）改动的只读审查：工牌已压只读交集，结论共 3 条。

### [P1] 后台作业清理缺停止前置
位置：desktop/src/renderer/dock-model.ts:40
说明：DockTab 的 line 字段在预览复用时没有清空旧值，可能把上一个文件的行号带进新预览。
建议：openPreview 复用已有 tab 时显式覆盖 line 字段。

### [P2] 行号高亮应先等渲染再滚动
位置：desktop/src/renderer/file-preview.tsx:80
说明：targetLine 的定位效果在首帧前触发会拿不到正确偏移。
建议：useEffect 里先 requestAnimationFrame 再 scrollIntoView。

### [P3] 位置为空的条目应整条折叠
说明：审查队友偶尔产出不带位置的杂项结论，现在整条平铺有点吵。
</review-findings>`

const records = [
  { type: 'meta', id, cwd: 'D:\\dsc', createdAt: at(-120_000) },
  { type: 'user', text: '帮我审查一下批次 D 的 /review 升级改动，重点看 findings 写回和行号跳转。', ts: at(0) },
  {
    type: 'assistant',
    text: '',
    reasoning: '发起只读审查队友：tools 压 read/glob/grep 交集，approval forbid，后台跑，findings 写回本会话。',
    toolCalls: [
      { id: 'call_final_review', name: 'review', arguments: JSON.stringify({ focus: 'findings 写回与行号跳转' }) },
    ],
    ts: at(1_000),
  },
  { type: 'tool', callId: 'call_final_review', name: 'review', text: '已派审查队友 reviewer（只读），完成后结论会写回本会话。', ts: at(1_400) },
  { type: 'assistant', text: '已派只读审查队友 reviewer，正在后台审查批次 D 的改动，结论出来我会贴在这里。', reasoning: '', ts: at(2_000) },
  { type: 'user', text: FINDINGS_TEXT, ts: at(60_000) },
]

const dir = join(home, '.dsc', 'sessions', 'D-dsc')
mkdirSync(dir, { recursive: true })
const file = join(dir, `${id}.jsonl`)
writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')

writeFileSync(
  'D:\\dsc\\desktop\\shots\\final-sessions.json',
  `${JSON.stringify({ home, session: file }, null, 2)}\n`,
  'utf8',
)

console.log(`seeded ${home}`)
console.log(`final session: ${file}`)
