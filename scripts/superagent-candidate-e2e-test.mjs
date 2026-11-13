/**
 * 候选收件箱全链路门禁（backlog D 表第一条）：真飞书来源收到一条「群里没 @ 机器人」的消息 →
 * 真判定器（假模型端点）判 accept → 候选落库等人点头 → 界面通道「接单」→ 工单开跑 → 交付；
 * 另一条候选走「忽略」收场。
 *
 * 为什么要有它：候选收件箱是唯一「新增的对外能力」，此前只有包级测试钉契约——判定器挂起
 * （`assessor.test.mjs`）、表读写（`store.test.mjs`）、快照面（`surface.test.mjs`）、界面按钮
 * （`pages.test.mjs`），四个部件各自为真，但从「消息进来」到「工单开跑」这条真链路没有在
 * 真宿主里走过一遍。中间任何一处接错（设置没传进 settings、事件到不了引擎、候选落错表），
 * 都要等人手工发现。本探针把这一整段钉住。
 *
 * 为什么用假 lark-cli 而不是真飞书：真账号只有人能配（backlog S5）。`feishuCli` 设置项本来
 * 就接受任意可执行文件路径，所以假 CLI 是从**产品自己的口子**进去的——走的仍是真来源装配
 * （`readFeishuBot` → 长连接 → `engine.receive`）、真准入闸、真候选表。假只假在 CLI 的输出。
 *
 * 为什么用假模型端点而不是真模型：与 `superagent-e2e-test.mjs` 同一条理由——CI 没有密钥，
 * 真模型还会让判定结果随措辞漂移。假端点按 system 提示区分两类请求：判定器（「只输出一个
 * JSON 对象」）回一份能通过 `assessmentOutcome` 校验的 accept；worker（「超级智能体的执行者」）
 * 回 read → write → bash 的动作序列。走的是真判定器、真准入闸、真引擎、真 worktree、真 git。
 *
 * 判据（逐条打印 PASS / FAIL，退出码 0 / 1）：
 *   1. 临时 HOME / USERPROFILE / DSC_HOME + 临时 git 仓库，真实 `~/.dsc` 一个字节不碰；
 *   2. 假 lark-cli 与假模型端点已起，宿主 stdio 应答（listModels）；
 *   3. 飞书来源真的启动了（日志出现「飞书来源已启动」）；
 *   4. 两条事件各落一条 pending 候选（读 candidate 表：快照面的数据源；快照面的形状由
 *      `surface.test.mjs` / `pages.test.mjs` 包级钉住，这里不重复）；
 *   5. 「接单」建出工单并真开工（日志出现「开工」），工作树只有一棵；
 *   6. 工单以 completed 收尾，README 被 worker 改过，动作序列 read → write → bash；
 *   7. 「忽略」把另一条候选置成 ignored，且没有第二张工单；
 *   8. 临时目录被清掉。
 *
 * 与 `superagent-e2e-test.mjs` 的分工：那条验「`/sa new` 明确请求直接建单交付」；本条验
 * 「推断候选等人点头」——入口不同（飞书来源 vs 手动发布）、判定器参与与否不同（本条真跑
 * 判定器），两条合起来把「工单怎么来的」两条路都钉住。
 *
 * 前置：先 `pnpm run build`（宿主跑的是 `lib/`）。
 * 用法：`node scripts/superagent-candidate-e2e-test.mjs`；被 `scripts/check-core.mjs` 按
 * `<话题>-test.mjs` 自动发现。
 *
 * @module dsc/scripts/superagent-candidate-e2e-test
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── 判据与公共小工具（照 `superagent-e2e-test.mjs`）─────────────────────────
const failures = []
let total = 0
const check = (name, ok, detail = '') => {
  total += 1
  if (ok) { console.log('  PASS ' + name); return }
  failures.push(name)
  console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail))
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const tail = (lines, count = 8) => lines.slice(-count).join(' | ')

/** 等一个条件成立；异步谓词每拍重新求值（读库要现读）。 */
async function until(predicate, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

/** 让系统挑一个空闲端口。 */
function freePort() {
  return new Promise((ok, no) => {
    const probe = createNetServer()
    probe.once('error', no)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => ok(port))
    })
  })
}

// ── 隔离环境（照 `superagent-e2e-test.mjs:81-103`）──────────────────────────
const realHome = homedir()
const KEEP = process.env['DSC_SA_E2E_KEEP'] === '1'
const home = mkdtempSync(join(tmpdir(), 'dsc-sa-candidate-e2e-'))
const dsc = join(home, '.dsc')
const repo = join(home, 'repo')
mkdirSync(dsc, { recursive: true })
mkdirSync(repo, { recursive: true })
process.env['HOME'] = home
process.env['USERPROFILE'] = home
process.env['DSC_HOME'] = dsc
console.log('[superagent-candidate-e2e] 隔离 HOME：' + home)

check(
  '临时 DSC_HOME 在系统临时目录里，不是真实的 ~/.dsc',
  resolve(dsc).startsWith(resolve(tmpdir())) && resolve(dsc) !== resolve(join(realHome, '.dsc')),
  dsc,
)

function git(args, cwd = repo) {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: done.status, out: String(done.stdout ?? '') + String(done.stderr ?? '') }
}

function killHard(proc) {
  if (proc?.pid === undefined || proc.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' })
    return
  }
  try { proc.kill('SIGKILL') } catch { /* 已经退了 */ }
}

// ── 第 1 步：临时 git 仓库 ───────────────────────────────────────────────────
git(['init', '-b', 'main'])
git(['config', 'user.email', 'sa-candidate-e2e@example.invalid'])
git(['config', 'user.name', 'superagent-candidate-e2e'])
writeFileSync(join(repo, 'README.md'), '# demo\n', 'utf8')
git(['add', '-A'])
git(['commit', '-m', 'init'])
check('临时仓库建好了（一个 init 提交）', git(['log', '--oneline']).code === 0)

// ── 第 2 步：假模型端点 ─────────────────────────────────────────────────────
//
// 两类请求按 system 提示区分：
//   - 判定器（`index.ts` 的 `oneShot`）：system =「你只输出一个 JSON 对象，不要解释。」
//     → 回一份能过 `assessmentOutcome` 全部校验的 accept：规则恰好覆盖启用的 copy / visual
//     各一次、方向三项全立得住、intent_evidence 必填（`core/policy.ts:52-80`）。
//   - worker（`prompts/worker.md` 首句）：system 含「超级智能体的执行者」→ read → write →
//     bash 三步动作序列，与 `superagent-e2e-test.mjs` 同一种形状。
const MARK = 'SA-CANDIDATE-E2E-OK'
const COMMIT_SUBJECT = 'test: superagent candidate e2e README SA-CANDIDATE-E2E-OK'
const README_NEXT = '# demo\n\n' + MARK + '：候选收件箱接单后 worker 改的这一行。\n'
/** 判定器对每条 Trigger 的回复都一样：两张候选的卡片标题由此而来。 */
const ASSESSOR_REPLY = JSON.stringify({
  decision: 'accept',
  rule_assessments: [
    { rule_id: 'copy', matched: true, reason: '名单内用户请机器人检查并修改 README 的过时说明，属于明确的文字修正请求' },
    { rule_id: 'visual', matched: false, reason: '不涉及间距、对齐或样式' },
  ],
  direction: {
    implementation_requested: true,
    target_basis: 'specified',
    requires_design_decision: false,
    evidence: '用户明确让机器人检查并顺手修改 README 的过时说明',
  },
  title: '检查并修正 README 的过时说明',
  scope: 'README.md',
  reason: '群里名单内用户直接请机器人改 README，方向与范围都已确定',
  intent_evidence: '「帮我检查 README 有没有过时的说明，有的话顺手改掉」是明确的实现请求',
})

function frame(delta, finish = null) {
  return {
    id: 'chatcmpl-sa-candidate-e2e',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

async function startFakeLlm() {
  const port = await freePort()
  const servedTools = []
  let requests = 0
  const server = createHttpServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('只有 POST /v1/chat/completions')
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('body 不是 JSON')
        return
      }
      requests += 1
      const messages = Array.isArray(body.messages) ? body.messages : []
      const system = messages.find((message) => message.role === 'system')
      const text = String(system?.content ?? '')
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n')
      const finish = () => { res.write('data: [DONE]\n\n'); res.end() }
      const plainReply = (content) => {
        send(frame({ role: 'assistant', content: '' }))
        send(frame({ content }))
        send(frame({}, 'stop'))
        finish()
      }

      if (text.includes('你只输出一个 JSON 对象')) {
        // 判定器：一次问答回一份 JSON。multi-turn 不会再有第二次（oneShot）。
        plainReply(ASSESSOR_REPLY)
        return
      }
      if (!text.includes('超级智能体的执行者')) {
        plainReply('（探针不驱动这类请求）')
        return
      }

      // worker：按「历史里已有几条 assistant tool_calls」分派，请求重试不错位。
      const calls = messages.filter(
        (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
      ).length
      if (calls < 3) {
        const step = [
          { name: 'read', arguments: { path: 'README.md' } },
          { name: 'write', arguments: { path: 'README.md', content: README_NEXT } },
          // PowerShell 5.1 不认 `&&`，用 `;`（理由见 `superagent-e2e-test.mjs:224-227`）。
          { name: 'bash', arguments: { command: 'git add -A; git commit -m "' + COMMIT_SUBJECT + '"' } },
        ][calls]
        servedTools.push(step.name)
        send(frame({ role: 'assistant', content: '' }))
        send(frame({
          tool_calls: [{
            index: 0,
            id: 'call_sa_cand_' + String(calls + 1),
            type: 'function',
            function: { name: step.name, arguments: JSON.stringify(step.arguments) },
          }],
        }))
        send(frame({}, 'tool_calls'))
        finish()
        return
      }
      plainReply('改好了：README.md 加了 ' + MARK + ' 一行，已在 agent 分支上提交。')
    })
  })
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok))
  return { port, servedTools, requests: () => requests, close: () => new Promise((ok) => server.close(() => ok())) }
}

// ── 第 3 步：假 lark-cli ────────────────────────────────────────────────────
//
// 一个 node 脚本 + 一个 `.cmd` 包装（Windows 上 `resolveFeishuCli` 只认这两类入口：
// 原生可执行或「能解出 Node 入口的包装脚本」，`cli-run.ts:154-176`）。
//
// 行为按子命令分派：
//   - `auth status` / `api GET /open-apis/bot/v3/info`：机器人身份（`readFeishuBot`）；
//   - `event consume ...`：stderr 打 `[event] ready`，然后每 300ms 扫一遍事件文件，
//     新行原样写 stdout——这就是「长连接收到一条群消息」；
//   - `im +chat-list ...` / `api GET /open-apis/im/v1/messages ...` / 其余：空的正常信封
//     （补收与群清单照常转，只是读不到东西）。
//
// 事件文件里放什么由探针控制：两条「群里没 @ 机器人」的消息，发送者都在准入名单里。
const CHAT_ID = 'oc_demo0001'
const BOT_ID = 'ou_bot0001'
const USER_ID = 'ou_user0001'
const EVENTS_FILE = join(home, 'feishu-events.ndjson')

const FAKE_CLI_JS = `\
const { readFileSync, appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
const envelope = (data) => JSON.stringify({ ok: true, data })
const out = (text) => process.stdout.write(text)
const sent = new Set()
const isEvent = args[0] === 'event' && args[1] === 'consume'
if (isEvent) {
  process.stderr.write('[event] ready\\n')
  const tick = () => {
    let lines = []
    try { lines = readFileSync(${JSON.stringify(EVENTS_FILE)}, 'utf8').split('\\n') } catch { lines = [] }
    for (const line of lines) {
      const row = line.trim()
      if (row === '' || sent.has(row)) continue
      sent.add(row)
      out(row + '\\n')
    }
  }
  setInterval(tick, 300)
  return
}
const rest = args.join(' ')
if (rest.startsWith('auth status')) {
  out(JSON.stringify({ appId: 'cli_fake0001', identities: { bot: { status: 'ready' } } }))
  return
}
if (rest.includes('/open-apis/bot/v3/info')) {
  out(JSON.stringify({ bot: { open_id: ${JSON.stringify(BOT_ID)}, app_name: 'fake' } }))
  return
}
if (rest.startsWith('im +chat-list')) {
  out(envelope({ chats: [{ chat_id: ${JSON.stringify(CHAT_ID)}, name: '演示群' }] }))
  return
}
// 历史补收与消息详情都回空页：消息从长连接来，不走历史。
out(envelope({ items: [], has_more: false }))
`

// `.cmd` 的解包规则（`cli-run.ts:120-138`）：读文件、展开 `%~dp0`、正则抓 `node xx.js` 入口。
// 双引号必须带——正则先认带引号的路径，npm shim 的惯例，这里照抄。`%~dp0` 后面要写 `\`：
// 适配器按 `dirname`（无尾分隔符）展开，npm shim 的实际写法也是 `%~dp0\` 跟子路径。
const FAKE_CLI_CMD = '@node "%~dp0\\fake-lark-cli.js" %*\r\n'

writeFileSync(join(home, 'fake-lark-cli.js'), FAKE_CLI_JS, 'utf8')
writeFileSync(join(home, 'fake-lark-cli.cmd'), FAKE_CLI_CMD, 'utf8')

/** 探针往事件文件里追加一条群消息（不 @ 机器人 → 准入判 inferred）。 */
function feishuEvent(messageId, text) {
  return JSON.stringify({
    message_id: messageId,
    chat_id: CHAT_ID,
    chat_type: 'group',
    sender_id: USER_ID,
    sender_type: 'user',
    content: text,
    create_time: String(Date.now()),
    mentions: [],
  })
}

// ── 第 4 步：插件配置 ────────────────────────────────────────────────────────
//
// 与 `superagent-e2e-test.mjs:268-284` 同一条路：直接写 `plugins.json`。这一条比那条多的是
// 候选收件箱与飞书来源的开关：`evalMode=auto` 是收件箱有内容的前提（`core/policy.ts:67`，
// 非 auto 下降级成 would_accept）；`confirmInferred` 让判定器挂起而不是直接接单。
writeFileSync(join(dsc, 'plugins.json'), JSON.stringify({
  version: 1,
  entries: [{
    file: 'superagent',
    disabled: false,
    config: {
      repoPath: repo,
      evalMode: 'auto',
      confirmInferred: true,
      assessorModel: 'fake/fake-chat',
      feishuEnabled: true,
      feishuCli: join(home, 'fake-lark-cli.cmd'),
      feishuChats: CHAT_ID,
      feishuAllowed: USER_ID,
    },
  }],
}, null, 2) + '\n', 'utf8')
const plugins = JSON.parse(readFileSync(join(dsc, 'plugins.json'), 'utf8'))
const entry = plugins.entries.find((item) => item.file === 'superagent')
check(
  '插件配置就位（evalMode=auto、confirmInferred、飞书来源指向假 CLI）',
  entry?.config?.evalMode === 'auto' && entry?.config?.confirmInferred === true
    && entry?.config?.feishuCli === join(home, 'fake-lark-cli.cmd'),
  JSON.stringify(entry?.config ?? null),
)

// ── 第 5 步：宿主（stdio 协议，照 `superagent-e2e-test.mjs:291-349`）────────
async function startHost(llmPort) {
  const proc = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: { ...process.env, DSC_FAKE_KEY: 'sk-sa-candidate-e2e' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr = []
  const pending = new Map()
  let seq = 0
  let buffer = ''
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(String.fromCharCode(10))) {
      if (line.trim() === '') continue
      stderr.push(line)
      if (stderr.length > 400) stderr.splice(0, stderr.length - 400)
    }
  })
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf(String.fromCharCode(10))
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('{')) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.type !== 'result') continue
      const waiting = pending.get(message.id)
      if (waiting === undefined) continue
      pending.delete(message.id)
      if (message.ok === true) waiting.ok(message.value)
      else waiting.no(new Error(String(message.error ?? '未知错误')))
    }
  })
  const invoke = (method, args) => new Promise((ok, no) => {
    seq += 1
    const id = seq
    pending.set(id, { ok, no })
    proc.stdin.write(JSON.stringify({ type: 'invoke', id, method, args }) + String.fromCharCode(10))
  })
  const deadline = Date.now() + 60_000
  let alive = false
  while (!alive && Date.now() < deadline && proc.exitCode === null) {
    try {
      await Promise.race([
        invoke('listModels', []),
        sleep(700).then(() => Promise.reject(new Error('探活超时'))),
      ])
      alive = true
    } catch {
      await sleep(250)
    }
  }
  return { proc, stderr, invoke, alive }
}

/** 直接读编排库的 candidate 表（快照面的数据源）。 */
let sqlite = null
async function readCandidates() {
  const dbPath = join(dsc, 'superagent', 'orchestrator.sqlite')
  if (!existsSync(dbPath)) return []
  try {
    sqlite ??= await import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare('SELECT id, state, value FROM candidate ORDER BY rowid ASC').all()
        .map((row) => ({ id: row.id, state: row.state, value: JSON.parse(row.value) }))
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

/** 直接读编排库的 ticket 表（最新在前）。 */
async function readTickets() {
  const dbPath = join(dsc, 'superagent', 'orchestrator.sqlite')
  if (!existsSync(dbPath)) return []
  try {
    sqlite ??= await import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare('SELECT value FROM ticket ORDER BY rowid DESC').all()
        .map((row) => JSON.parse(row.value))
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

const TITLE = '检查并修正 README 的过时说明'
let llm = null
let host = null
let worktree = null
try {
  check('宿主构建产物在（lib/headless.js，前置 pnpm run build）', existsSync(join(root, 'lib', 'headless.js')))
  if (!existsSync(join(root, 'lib', 'headless.js'))) throw new Error('没有 lib/headless.js，先构建')

  llm = await startFakeLlm()
  check('假模型端点已起（127.0.0.1:' + String(llm.port) + '）', llm.port > 0)
  writeFileSync(join(dsc, 'config.yaml'), [
    'default:', '  provider: fake', '  model: fake-chat', 'providers:', '  fake:',
    '    displayName: 候选收件箱自检假端点', '    baseURL: http://127.0.0.1:' + String(llm.port) + '/v1',
    '    apiKeyEnv: DSC_FAKE_KEY', '    models:', '      - id: fake-chat', '        name: Fake Chat',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'), 'utf8')

  host = await startHost()
  check('宿主启动并用 stdio 协议应答（listModels）', host.alive, tail(host.stderr))
  if (!host.alive) throw new Error('宿主没应答')

  check(
    '飞书来源真的启动了（日志出现「飞书来源已启动」）',
    await until(() => host.stderr.some((line) => line.includes('飞书来源已启动')), 30_000),
    tail(host.stderr),
  )

  // 两条事件先后落进长连接：同群、不同 message_id → 两条独立的 Trigger。
  // content 里没有 @ 机器人，发送者在 feishuAllowed 名单里 → 准入判 inferred（`core/policy.ts:221`）。
  writeFileSync(EVENTS_FILE, feishuEvent('om_candidate_e2e_0001', '帮我检查 README 有没有过时的说明，有的话顺手改掉') + '\n', 'utf8')
  await sleep(2_000)
  appendFileSync(EVENTS_FILE, feishuEvent('om_candidate_e2e_0002', '顺便看看目录结构合不合理，不合理就调整一下') + '\n', 'utf8')

  const pending = await until(async () => (await readCandidates()).filter((item) => item.state === 'pending').length >= 2, 60_000)
  const candidates = await readCandidates()
  check('两条推断候选都进了收件箱（candidate 表 pending）', pending && candidates.filter((item) => item.state === 'pending').length >= 2, JSON.stringify(candidates.map((item) => ({ state: item.state, title: item.value?.title }))))
  check('候选标题来自判定器（假端点回的那份）', candidates[0]?.value?.title === TITLE, String(candidates[0]?.value?.title ?? 'null'))
  check('候选结论是 accept（落库的就是判定结果本身）', candidates[0]?.value?.outcome?.kind === 'accept', JSON.stringify(candidates[0]?.value?.outcome?.kind ?? null))
  if (!pending || candidates.length < 2) throw new Error('候选没落库，后面的断言没有对象')

  // ── 接单：人在界面上给第一条候选定结论 ──────────────────────────────────
  let ticketId = null
  try {
    ticketId = await host.invoke('superagentAcceptCandidate', [candidates[0].id])
  } catch (error) {
    check('「接单」建出工单', false, error instanceof Error ? error.message : String(error))
  }
  check('「接单」建出工单', typeof ticketId === 'string' && ticketId !== '', String(ticketId ?? 'null'))

  const started = await until(() => host.stderr.some((line) => line.includes('开工')), 60_000)
  check('worker 真的开工了（宿主日志出现「开工」）', started, tail(host.stderr))

  const worktreesDir = join(dsc, 'superagent', 'worktrees')
  const worktreeDirs = existsSync(worktreesDir)
    ? readdirSync(worktreesDir, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)
    : []
  check('开工后工作树只有一棵', worktreeDirs.length === 1, worktreeDirs.join('、'))
  worktree = worktreeDirs.length === 1 ? join(worktreesDir, worktreeDirs[0]) : null

  const finished = await until(async () => (await readTickets()).some((item) => item.id === ticketId && item.ended !== undefined), 100_000, 500)
  const tickets = await readTickets()
  const mine = tickets.find((item) => item.id === ticketId)
  check('接单的工单自己跑完了（ended 有值）', finished && mine?.ended !== undefined, finished ? '' : tail(host.stderr, 12))
  check('工单以完成收尾（outcome=completed）', mine?.ended?.outcome === 'completed', JSON.stringify(mine?.ended ?? null))

  const readme = worktree !== null && existsSync(join(worktree, 'README.md'))
    ? readFileSync(join(worktree, 'README.md'), 'utf8')
    : ''
  check('工作树里的 README 被 worker 改过（含 ' + MARK + '）', readme.includes(MARK), JSON.stringify(readme.slice(0, 120)))
  check(
    '假端点按 read → write → bash 的顺序驱动了 worker',
    llm.servedTools.join(',') === 'read,write,bash',
    llm.servedTools.join(',') || '一次工具调用都没发生',
  )

  // ── 忽略：另一条候选 ────────────────────────────────────────────────────
  const afterAccept = await readCandidates()
  const pendingId = afterAccept.find((item) => item.state === 'pending')?.id
  check('另一条候选还在等人点（pending）', pendingId !== undefined, JSON.stringify(afterAccept.map((item) => item.state)))
  if (pendingId !== undefined) {
    let ignored = false
    try {
      await host.invoke('superagentIgnoreCandidate', [pendingId])
      ignored = true
    } catch (error) {
      check('「忽略」不抛错', false, error instanceof Error ? error.message : String(error))
    }
    const settled = await until(async () => (await readCandidates()).every((item) => item.state !== 'pending'), 15_000)
    const final = await readCandidates()
    check('「忽略」后收件箱里没有 pending 了', ignored && settled && final.every((item) => item.state !== 'pending'), JSON.stringify(final.map((item) => item.state)))
    check('忽略不建工单（ticket 表只有接单那张）', (await readTickets()).length === 1, String((await readTickets()).length))
  }

  check('判定器被真跑过（假端点收到判定请求）', llm.requests() >= 3, String(llm.requests()))
} catch (error) {
  check('链路没有中途抛错', false, error instanceof Error ? error.message : String(error))
} finally {
  killHard(host?.proc)
  await sleep(300)
  try { await llm?.close() } catch { /* 已经关了 */ }
  if (KEEP) {
    console.log('  ..    保留临时目录（DSC_SA_E2E_KEEP=1）：' + home)
  } else {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(home, { recursive: true, force: true }) } catch { /* 句柄还没放干净，再试 */ }
      if (!existsSync(home)) break
      await sleep(300)
    }
    check('临时目录已清理（不留下垃圾，也不碰 ~/.dsc）', !existsSync(home), home)
  }
}

console.log('')
const passed = total - failures.length
if (failures.length === 0) {
  console.log('[superagent-candidate-e2e] ' + String(passed) + '/' + String(total) + ' 通过')
  process.exit(0)
}
console.log('[superagent-candidate-e2e] ' + String(passed) + '/' + String(total) + ' 通过，' + String(failures.length) + ' 条失败：' + failures.join('；'))
process.exit(1)
