/**
 * 第九批走查的种子（开发辅助，不进测试电池）：一间一次性隔离 HOME + 一间真 git 仓库，
 * 外加一条**已定稿的会话**，用来在浏览器里核对四件事：
 *
 *   ① 阶段组的组员被重复渲染（「已写入文件 2 项」下面跟着两条一样的思考栏）——
 *      种子的第二轮就是「思考 + write 工具」两员的组：组头是 write，思考是第二个组员，
 *      带 bug 的版本会在组体之外**再单独铺一条**一样的思考栏；
 *   ② 写前预览（宿主 file-review 的 dsc/notice）渲染成什么样——第二轮的 write 带 changes，
 *      但要看预览要到**真跑一轮**（假端点那条路，见 _b9-fake-llm.mjs）；
 *   ③ 思考块从「直播」到「定稿」那一拍会不会自己收起来：种子里历史全是定稿的，
 *      要跑真回合才看得到直播尾（假端点那条路）；
 *   ④ 编辑卡的展开体：write 落的改动（changes）在卡里是 diff + 字段表，而不是原始 JSON。
 *
 * 另加：仓库种子是**干净**的（一次提交、无未提交改动）——真回合里 write 落一个未跟踪文件后，
 * 状态面板的 Git 区与胶囊就该亮起来（这是「编辑了文件后没有 git 胶囊」那条的现场复核）。
 *
 * 用法：node desktop/shots/_b9-seed.mjs
 * 之后：node scripts/_ui-shell-serve.mjs    # 见脚本打印的地址
 *
 * @module dsc/desktop/shots/b9-seed
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = join(here, 'b9-home')
const dsc = join(home, '.dsc')
const ws = join(home, 'ws')
const PORT = Number(process.env.DSC_B9_PORT ?? 18_929)

rmSync(home, { recursive: true, force: true })
mkdirSync(dsc, { recursive: true })
mkdirSync(ws, { recursive: true })

const git = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'pipe', windowsHide: true })

writeFileSync(join(ws, 'readme.txt'), '第一行：工作区说明。\n第二行：假端点会读它一次。\n', 'utf8')
writeFileSync(join(ws, '.gitignore'), '.dsc/\n', 'utf8')
git('init', '--quiet')
git('config', 'core.autocrlf', 'false')
git('config', 'user.email', 'seed@local')
git('config', 'user.name', 'seed')
git('add', '.')
git('commit', '--quiet', '-m', 'seed')

writeFileSync(
  join(dsc, 'config.yaml'),
  `# 走查专用：指向本机假端点（不联网）
default:
  provider: fake
  model: b9-flow
providers:
  fake:
    displayName: 走查假端点
    baseURL: http://127.0.0.1:${String(PORT)}/v1
    apiKeyEnv: DSC_FAKE_KEY
    models:
      - id: b9-flow
        name: B9 Flow
        contextWindow: 128000
        maxTokens: 4096
`,
  'utf8',
)

const key = ws.replace(/[:\\/]+/g, '-')
const uuid = 'b9000000-1111-2222-3333-444444444444'
mkdirSync(join(dsc, 'sessions', key), { recursive: true })

const now = Date.now()
const j = (value) => JSON.stringify(value)
/** write 第二轮的改动摘要（与 FileChangeSummary 同形；hunks 逐行带新旧行号）。 */
const writeHunks = [
  {
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: 3,
    lines: [
      { kind: 'add', text: '# 笔记', oldLine: null, newLine: 1 },
      { kind: 'add', text: '第一行', oldLine: null, newLine: 2 },
      { kind: 'add', text: '第二行', oldLine: null, newLine: 3 },
    ],
  },
]

const lines = [
  j({ type: 'meta', id: uuid, cwd: ws, createdAt: now }),
  j({ type: 'user', text: '第一轮：先说思路，再读文件。', ts: now + 1000 }),
  j({ type: 'assistant', text: '', reasoning: '先想清楚要做什么。\n\n再看工作区。', ts: now + 1500 }),
  j({
    type: 'assistant',
    text: '',
    toolCalls: [{ id: 'b9r1', name: 'read', arguments: JSON.stringify({ path: 'readme.txt' }) }],
    ts: now + 2000,
  }),
  j({ type: 'tool', callId: 'b9r1', name: 'read', text: '第一行：工作区说明。', ts: now + 2200 }),
  j({ type: 'assistant', text: '第一轮答完了。', ts: now + 3000 }),
  j({ type: 'user', text: '第二轮：落一个文件。', ts: now + 4000 }),
  j({ type: 'assistant', text: '', reasoning: '这一轮要落一个文件。\n\n先写再汇报。', ts: now + 4500 }),
  j({
    type: 'assistant',
    text: '',
    toolCalls: [
      {
        id: 'b9w1',
        name: 'write',
        arguments: JSON.stringify({
          path: '笔记.md',
          justification: '用户要求把话说清就落一个文件，写进工作区里。',
          sandbox_permissions: 'workspace-write',
          content: '# 笔记\n第一行\n第二行\n',
        }),
      },
    ],
    ts: now + 5000,
  }),
  j({
    type: 'tool',
    callId: 'b9w1',
    name: 'write',
    text: `已写入 ${join(ws, '笔记.md')}（21 字符）`,
    ts: now + 5200,
    changes: { path: join(ws, '笔记.md'), added: 3, removed: 0, hunks: writeHunks, status: 'added' },
  }),
  j({ type: 'assistant', text: '第二轮也写完了。', ts: now + 6000 }),
]
writeFileSync(join(dsc, 'sessions', key, `${uuid}.jsonl`), lines.join('\n'), 'utf8')

writeFileSync(
  join(dsc, 'sessions', 'meta.json'),
  JSON.stringify({ version: 1, sessions: { [uuid]: { title: '第九批走查会话' } } }, null, 2),
  'utf8',
)
writeFileSync(
  join(dsc, 'desktop.json'),
  JSON.stringify({ lastCwd: ws, recentCwds: [ws], ui: 'shell' }, null, 2),
  'utf8',
)

process.stdout.write(
  `[b9-seed] 隔离 HOME：${home}\n[b9-seed] 工作区（真 git 仓库，干净）：${ws}\n` +
    `[b9-seed] 会话：${uuid}（两轮，第二轮是「思考 + write」两员的阶段组）\n` +
    `[b9-seed] 起壳：DSC_UI_SERVE_HOME=${resolve(home)} DSC_UI_SERVE_CWD=${resolve(ws)} node scripts/_ui-shell-serve.mjs\n`,
)
