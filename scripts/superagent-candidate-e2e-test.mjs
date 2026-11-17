/**
 * 推断候选全链路门禁（新架构版）：真飞书来源从假 lark-cli 收到两条「群里没 @ 机器人」的消息 →
 * 准入判成推断候选 → 真判定器（主会话模型回合，假模型端点）判 accept → 直接建工单 → worker 真跑 →
 * 两张工单以 completed 收尾。
 *
 * ## 为什么重写（相对旧版）
 *
 * 旧版验的是「候选收件箱」：判定结果落 `candidate` 表 pending，人在面板点「接单」才建工单。
 * 移植到上游架构后收件箱整条路都不存在了（`app/api.ts` 的 `acceptCandidate` / `ignoreCandidate`
 * 只剩一句「新架构没有这条路」的报错，`candidate` 表与 `surface().candidates` 也一起消失）。
 * 新架构的等价物是：消息进来 → 准入闸判 `inferred` → 主会话的模型回合用 `orchestrator_eval_decide`
 * 直接落 accept → 工单落 `ticket` 表并开跑。`eval.mode='auto'` 是「推断候选能直接被接单」的前提
 * （`core/policy.ts:67`、`:224`），所以人不用点，也不需要点。
 *
 * ## 配置怎么进去的（与旧版的三处不同）
 *
 * 1. **不再是 `plugins.json` 的配置键**：新树从编排库的 settings 读一切（`app/store.ts` 的
 *    `Store` + `saveSettings`）。本探针在起宿主之前用 `lib/packages/superagent/app/store.js`
 *    把一份 `Settings` 播进 `<DSC_HOME>/superagent/orchestrator.sqlite`，然后 `close()`。
 * 2. **来源字段名以 `sources/feishu.ts` 的 `fields` 为准**：配置里只有 `cli` / `chats` /
 *    `directMessages` / `otherChats` / `readPageSize` / `linkTimeoutMs`（`FeishuConfigSchema`，
 *    `.strict()`）；`appId` / `brand` / `botId` 来自部署检查（`resolveFeishuBot`），`bots` 名单
 *    是策略字段（`policy.sources.feishu.bots`）。旧版那套 `feishuCli` / `feishuAllowed` /
 *    `feishuChats` 键在 schema 里一个都不存在，写进 config 会让 `SourceRegistry.resolve` 解析失败、
 *    整个来源被降级成停用（`sources/registry.ts:155-158`）。
 * 3. **假 CLI 不能再靠 `.cmd` 包装**：旧树有 `adapters/feishu/cli-run.ts` 把 `.cmd` 解包成
 *    `node <script>`；新树没有这个解包（`spawn(bot.cli, ...)` / `runAsWorker` 都直接 spawn，
 *    `sources/feishu-loops.ts:81`、`infra/environment.ts:163-166`），Windows 上直接 spawn 一个
 *    `.cmd` 会 EINVAL。所以这里换个同族办法：`cli` 指 `process.execPath`（node.exe），把
 *    **无扩展名的 node 脚本**按「被调用时的第一个参数」起名放进 `<DSC_HOME>/superagent/`
 *    （`auth` / `config` / `api` / `im` / `event`），宿主进程的 cwd 也设成这个目录——node 用
 *    `node auth status` 跑脚本时按 cwd 解析出 `auth` 这个文件。这是从产品自己的口子
 *    （`cli` 本就可以填任意可执行文件路径）进去的，走的仍是真来源装配、真准入闸、真判定器。
 *    GitHub 的假 gh 与飞书共用同一个 `api` 脚本（`argv[2]` 是 `user` / `repos/...` 就回 gh 的两份
 *    JSON，是 `GET` 就回飞书接口），因为 `resolveDeployment` 在飞书之前跑。
 * 4. **prepare 走 `.cmd` 而不是内联命令**：`prepareDirectory` 用
 *    `spawn(cmd.exe, ['/d','/s','/c', command])` 调它（`executor/dsh.ts:248-249`），Windows 上
 *    Node 会把参数里的引号转义成 `\"`、cmd 又不认，内联的 `"%DSH_SUPERAGENT_DIR%"` 会被当成路径的
 *    一部分。这里把 `git clone ... "%DSH_SUPERAGENT_DIR%"` 放进 PATH 上的 `sa-prepare.cmd`，
 *    `executor.prepare` 只写命令名，转义那层就绕开了。
 *
 * ## 判据（逐条打印 PASS / FAIL，退出码 0 / 1）
 *
 *   1. 临时 HOME / USERPROFILE / DSC_HOME + 临时 git 仓库，真实 `~/.dsc` 一个字节不碰；
 *   2. settings 播进编排库后读得回来（`eval.mode=auto`、飞书来源启用、bots 名单里有那个发送方）；
 *   3. 宿主 stdio 应答（listModels）；部署检查通过（假 gh 的 `api user` / `api repos/...` 真被调过）；
 *   4. 飞书来源真的起来了（假 CLI 被按 `event consume ...` 起过，且它自己打了 `[event] ready`）；
 *   5. 假 lark-cli 押进去的两条群消息都成了 feishu trigger（`trigger` 表 2 行，actor 是名单里的机器人）；
 *   6. 消息真的从事件流穿过来了（KV `feishu-chats` 记到了这个群，`sources/feishu-loops.ts:102-105`）；
 *   7. 假模型端点收到判定请求，判定结果是 accept（`decision` 表 2 行、`kind=accept`、`strength=inferred`）；
 *   8. 两条消息各建出一张工单（`ticket` 表 2 行，标题来自判定器）；
 *   9. 库里不存在 `candidate` 表（旧收件箱的存储面确实没了）；
 *  10. 两张工单都以 completed 收尾，工作目录在 `<DSC_HOME>/superagent/work/<name>`，README 被 worker 改过；
 *  11. 临时目录被清掉。
 *
 * ## 与另外两条探针的分工
 *
 * `superagent-e2e-test.mjs` 验「人明确要求 → 直接建单交付」；`superagent-worker-e2e-test.mjs` 验
 * 「worker 干活时的后台作业与队友」。本条只验「消息进来 → 推断 → 无人点头 → 自动接单」这一段。
 *
 * ## 没覆盖的点（写在这儿，免得下次误以为绿了就全绿）
 *
 *   - 不覆盖飞书历史补收与线程订阅轮询（假 CLI 对这两类只回空页）；
 *   - 不覆盖 worker 的 `bash` / git 提交（新执行器把 git 身份钉成 `useConfigOnly = true`，
 *     没有 `gh` 登录态时提交会失败；这条探针只验「改文件 + 报告收尾」）；
 *   - 不覆盖面板（DSC 没有 HTTP 路由，快照面走 `INVOKABLE_METHODS`，本条只读库）。
 *
 * 前置：`lib/` 产物要在（本探针**不**自己跑 `pnpm run build`）。
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
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// ── 隔离环境（照 `superagent-e2e-test.mjs`）──────────────────────────────────
const realHome = homedir()
const KEEP = process.env['DSC_SA_E2E_KEEP'] === '1'
const home = mkdtempSync(join(tmpdir(), 'dsc-sa-candidate-e2e-'))
const dsc = join(home, '.dsc')
const repo = join(home, 'repo')
// 新树的落盘坐标：`<DSC_HOME>/superagent`（`src/packages/superagent/paths.ts:21-28`）。
const state = join(dsc, 'superagent')
const dbPath = join(state, 'orchestrator.sqlite')
const workRoot = join(state, 'work')
mkdirSync(dsc, { recursive: true })
mkdirSync(repo, { recursive: true })
mkdirSync(state, { recursive: true })
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

// ── 第 1 步：临时 git 仓库（prepare 的 clone 源）─────────────────────────────
git(['init', '-b', 'main'])
git(['config', 'user.email', 'sa-candidate-e2e@example.invalid'])
git(['config', 'user.name', 'superagent-candidate-e2e'])
writeFileSync(join(repo, 'README.md'), '# demo\n', 'utf8')
git(['add', '-A'])
git(['commit', '-m', 'init'])
check('临时仓库建好了（一个 init 提交）', git(['log', '--oneline']).code === 0)

// ── 第 2 步：假模型端点 ─────────────────────────────────────────────────────
//
// 新树的判定是**主会话的模型回合**（`app/assessment.ts` 的 `MasterAssessor`）：候选卡片以一条用户
// 消息投进主会话，模型看到卡片后调 `orchestrator_eval_decide`（`app/tools/main.ts:236-243`），
// 结论经 `assessmentOutcome` 校验后落库。所以假端点按 system 提示分两类：
//
//   - 主会话（system 含 `You are the orchestrator`）：历史里有几张还没判过的候选卡片，就回一次
//     `orchestrator_eval_decide` 工具调用；全部判完回一段正文收尾。卡片正文是
//     `JSON.stringify({ kind: 'candidate', ...candidateCard })`（`app/assessment.ts:123`、
//     `app/links.ts:67-83`），`trigger_id` 就在里面。
//   - worker（system 含 `You are a worker`）：read → write → `orchestrator_report(ready)` → 正文。
//     每个 worker 会话的请求各自带自己的历史，按「已有几条 assistant tool_calls」分派不会错位。
//
// 判定内容要过 `AssessmentSchema`（`app/assessment.ts:45-58`）：accept 必须有 worktree_name、
// 两份规则结论（启用的 copy / visual 各一次）、立得住的 direction、intent_evidence。
// 故意不带 `acknowledgement`：带了就会往飞书回一句话（`core/tickets.ts:53`），那条出站与本链无关。
const MARK = 'SA-CANDIDATE-E2E-OK'
const README_NEXT = '# demo\n\n' + MARK + '：推断候选被判定器接单后 worker 改的这一行。\n'
const TITLE = '检查并修正 README 的过时说明'
const WORKTREE_NAME = 'fix-readme-notes'

function assessmentOf(triggerId) {
  return {
    trigger_id: triggerId,
    decision: 'accept',
    rule_assessments: [
      { rule_id: 'copy', matched: true, reason: '名单内机器人转达的是明确的文字修正请求：检查并修改 README 的过时说明' },
      { rule_id: 'visual', matched: false, reason: '不涉及间距、对齐或样式' },
    ],
    direction: {
      implementation_requested: true,
      target_basis: 'specified',
      requires_design_decision: false,
      evidence: '消息明确要求检查 README 有没有过时的说明，有的话顺手改掉',
    },
    title: TITLE,
    worktree_name: WORKTREE_NAME,
    scope: 'README.md',
    reason: '群里转达的请求目标明确（README）且方向已定，属于 copy 规则覆盖的本地小改',
    intent_evidence: '「帮我检查 README 有没有过时的说明，有的话顺手改掉」是明确的实现请求',
  }
}

function frame(delta, finish = null) {
  return {
    id: 'chatcmpl-sa-candidate-e2e',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

/** 把一条消息的 content 读成纯文本（字符串或内容块数组都认）。 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => block !== null && typeof block === 'object' && typeof block.text === 'string' ? [block.text] : []).join('\n')
}

/** 从请求历史里认出「已投递但还没被判过」的候选卡片 trigger_id。 */
function pendingCandidates(messages) {
  const offered = []
  for (const message of messages) {
    if (message?.role !== 'user') continue
    let value
    try { value = JSON.parse(textOf(message).trim()) } catch { continue }
    if (value !== null && typeof value === 'object' && value.kind === 'candidate' && typeof value.trigger_id === 'string') offered.push(value.trigger_id)
  }
  const decided = new Set()
  for (const message of messages) {
    if (message?.role !== 'assistant') continue
    for (const call of message.tool_calls ?? []) {
      if (call?.function?.name !== 'orchestrator_eval_decide') continue
      try { decided.add(String(JSON.parse(call.function.arguments).trigger_id)) } catch { /* 参数坏了就当没判 */ }
    }
  }
  return [...new Set(offered)].filter((id) => !decided.has(id))
}

async function startFakeLlm() {
  const port = await freePort()
  const stats = { assessor: 0, worker: 0, decides: 0, workerTools: [] }
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
      const messages = Array.isArray(body.messages) ? body.messages : []
      const system = textOf(messages.find((message) => message?.role === 'system'))
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
      const toolCall = (name, args) => {
        send(frame({ role: 'assistant', content: '' }))
        send(frame({
          tool_calls: [{
            index: 0,
            id: 'call_sa_cand_' + String(Date.now()) + '_' + String(stats.assessor + stats.worker),
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        }))
        send(frame({}, 'tool_calls'))
        finish()
      }

      // ── 主会话（判定器）──
      if (system.includes('You are the orchestrator')) {
        stats.assessor += 1
        const pending = pendingCandidates(messages)
        if (pending.length === 0) {
          plainReply('候选都判完了，本轮没有要再判的卡片。')
          return
        }
        stats.decides += 1
        toolCall('orchestrator_eval_decide', assessmentOf(pending[0]))
        return
      }

      // ── worker ──
      if (system.includes('You are a worker')) {
        stats.worker += 1
        const calls = messages.filter(
          (message) => message?.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
        ).length
        if (calls === 0) {
          stats.workerTools.push('read')
          toolCall('read', { path: 'README.md' })
          return
        }
        if (calls === 1) {
          stats.workerTools.push('write')
          toolCall('write', { path: 'README.md', content: README_NEXT })
          return
        }
        if (calls === 2) {
          stats.workerTools.push('report')
          toolCall('orchestrator_report', { state: 'ready', summary: 'README 的过时说明已修正，改动在工作目录里' })
          return
        }
        plainReply('改好了：README.md 加了 ' + MARK + ' 一行。')
        return
      }

      plainReply('（探针不驱动这类请求）')
    })
  })
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok))
  return { port, stats, close: () => new Promise((ok) => server.close(() => ok())) }
}

// ── 第 3 步：假 lark-cli / 假 gh（同一个 node 入口脚本集）────────────────────
//
// 为什么不写 `.cmd`：新树的 `spawn(bot.cli, ...)`（`sources/feishu-loops.ts:81`）、
// `Commands.run`（`infra/commands.ts:78`）、`runAsWorker`（`infra/environment.ts:166`）都直接
// spawn，Windows 上 `.cmd` 会 EINVAL——旧树的 `.cmd` 解包器（`adapters/feishu/cli-run.ts`）已随
// 旧树删除。这里改成「node.exe + 按第一个参数命名的无扩展名脚本」：宿主进程的 cwd 设成
// `<DSC_HOME>/superagent`，`node auth status` 就会按 cwd 解析出同目录的 `auth` 脚本。
//
// 行为按脚本名分派：
//   - `auth`：机器人身份（`resolveFeishuBot` 的 `auth status`）；
//   - `config`：`strict-mode: bot`（同一个部署检查）；
//   - `api`：`GET /open-apis/bot/v3/info` 回机器人身份，`GET /open-apis/im/v1/messages*` 回空页，
//     `user` / `repos/...` 回 gh 的两份 JSON（`resolveDeployment`，飞书之前先跑）；
//   - `im`：群清单；
//   - `event`：stderr 打 `[event] ready`，然后每 200ms 扫事件文件，新行原样写 stdout——这就是
//     「长连接收到一条群消息」。
const CHAT_ID = 'oc_demo0001'
const DEPLOY_BOT_ID = 'ou_deploybot01'
const SENDER_BOT_ID = 'ou_fakebot0001'
const APP_ID = 'cli_fake0001'
const EVENTS_FILE = join(home, 'feishu-events.ndjson')
const CALLS_FILE = join(state, 'fake-cli-calls.ndjson')

/** 记录一次 CLI 调用，供断言「产品真的按 CLI 起了来源」。 */
const RECORD = `const fs = require('node:fs')
const CALLS = ${JSON.stringify(CALLS_FILE)}
exports.record = (name, argv) => { try { fs.appendFileSync(CALLS, JSON.stringify({ name, argv: argv ?? [] }) + '\\n') } catch { /* 记录失败不影响 CLI 行为 */ } }
`
writeFileSync(join(state, 'fake-cli-lib.cjs'), RECORD, 'utf8')

writeFileSync(join(state, 'auth'), `const lib = require('./fake-cli-lib.cjs')
const argv = process.argv.slice(2)
lib.record('auth', argv)
if (argv[0] === 'status') {
  process.stdout.write(JSON.stringify({ appId: ${JSON.stringify(APP_ID)}, brand: 'feishu', identities: { bot: { status: 'ready' } } }) + '\\n')
  return
}
process.stdout.write(JSON.stringify({ ok: true, data: {} }) + '\\n')
`, 'utf8')

writeFileSync(join(state, 'config'), `const lib = require('./fake-cli-lib.cjs')
lib.record('config', process.argv.slice(2))
process.stdout.write('strict-mode: bot\\n')
`, 'utf8')

writeFileSync(join(state, 'api'), `const lib = require('./fake-cli-lib.cjs')
const argv = process.argv.slice(2)
lib.record('api', argv)
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (argv[0] === 'user') { out({ login: 'sa-bot', id: 1 }); return }
if (typeof argv[0] === 'string' && argv[0].startsWith('repos/')) { out({ name: 'owner/name', push: true }); return }
if (argv[0] === 'GET') {
  if (String(argv[1] ?? '').includes('/open-apis/bot/v3/info')) {
    out({ bot: { open_id: ${JSON.stringify(DEPLOY_BOT_ID)}, app_name: 'fake-bot' } })
    return
  }
  // 历史补收与消息详情：空页（消息从长连接来，不走历史）。
  out({ ok: true, data: { items: [], has_more: false } })
  return
}
out({ ok: true, data: {} })
`, 'utf8')

writeFileSync(join(state, 'im'), `const lib = require('./fake-cli-lib.cjs')
const argv = process.argv.slice(2)
lib.record('im', argv)
process.stdout.write(JSON.stringify({ ok: true, data: { chats: [{ chat_id: ${JSON.stringify(CHAT_ID)}, name: '演示群' }] } }) + '\\n')
`, 'utf8')

writeFileSync(join(state, 'event'), `const fs = require('node:fs')
const lib = require('./fake-cli-lib.cjs')
const EVENTS = ${JSON.stringify(EVENTS_FILE)}
lib.record('event', process.argv.slice(2))
process.stderr.write('[event] ready\\n')
lib.record('event-ready', [])
const sent = new Set()
const tick = () => {
  let lines = []
  try { lines = fs.readFileSync(EVENTS, 'utf8').split('\\n') } catch { lines = [] }
  for (const line of lines) {
    const row = line.trim()
    if (row === '' || sent.has(row)) continue
    sent.add(row)
    process.stdout.write(row + '\\n')
  }
}
setInterval(tick, 200)
process.on('SIGTERM', () => process.exit(0))
process.stdin.resume()
`, 'utf8')

/** 探针往事件文件里追加一条群消息（不 @ 机器人，发送方是策略 bots 名单里的机器人）。 */
function feishuEvent(messageId, text) {
  return JSON.stringify({
    message_id: messageId,
    chat_id: CHAT_ID,
    chat_type: 'group',
    sender_id: SENDER_BOT_ID,
    sender_type: 'bot',
    content: text,
    create_time: String(Date.now()),
    mentions: [],
    message_app_link: 'https://example.feishu.cn/message/' + messageId,
  })
}

/** 读假 CLI 的调用记录。 */
function cliCalls() {
  if (!existsSync(CALLS_FILE)) return []
  return readFileSync(CALLS_FILE, 'utf8').split('\n').flatMap((line) => {
    if (line.trim() === '') return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

// ── 第 4 步：把 Settings 播进编排库 ─────────────────────────────────────────
//
// 起宿主之前先写库：新树不在 `plugins.json` 里读业务配置，`Runtime` 构造时 `new Store(...)` 之后
// 立刻 `store.settings()` 就是这里播的那份。字段以 `core/policy.ts` 的 `SettingsSchema` 为准，
// 来源配置以各自 kind 的 schema 为准（多一个键会被 `.strict()` 拒掉、整个来源降级成停用）。
//
// prepare 为什么是一个 PATH 上的 `.cmd` 而不是一行内联命令：`prepareDirectory` 用
// `spawn(cmd.exe, ['/d','/s','/c', command])` 调它（`executor/dsh.ts:248-249`），Node 在 Windows
// 上会把带空格的参数整体加引号、把参数里的引号转义成 `\"`，cmd 又不认 `\"`——内联命令里的
// `"%DSH_SUPERAGENT_DIR%"` 于是被当成路径的一部分（实测报
// `could not create leading directories of '"C:\...\fix-..."'`）。把命令放进 `.cmd` 文件、
// 让 prepare 只写一个不含空格和引号的命令名，就绕开了这层转义。
const PATH_BIN = join(home, 'bin')
mkdirSync(PATH_BIN, { recursive: true })
writeFileSync(join(PATH_BIN, 'sa-prepare.cmd'), [
  '@echo off',
  'git clone "%~dp0..\\repo" "%DSH_SUPERAGENT_DIR%"',
  '',
].join('\r\n'), 'utf8')
process.env['PATH'] = PATH_BIN + ';' + String(process.env['PATH'] ?? '')
check('prepare 命令与 clone 源就位（PATH 上的 sa-prepare.cmd）', existsSync(join(PATH_BIN, 'sa-prepare.cmd')))

const settings = {
  paused: false,
  sources: {
    github: { enabled: true, config: { repository: 'owner/name', cli: process.execPath } },
    feishu: {
      enabled: true,
      config: {
        cli: process.execPath,
        chats: [{ chatId: CHAT_ID, listen: 'all' }],
        directMessages: true,
      },
    },
  },
  policy: {
    // 不写 rules：缺省就是 copy + visual 两条启用（`core/policy.ts:74-77`）。
    sources: {
      feishu: {
        allowed: [],
        // `bots` 是策略字段，不是来源配置：名单里的机器人发的消息成为推断候选（`core/policy.ts:135-138`）。
        bots: [{ id: SENDER_BOT_ID }],
      },
    },
  },
  eval: { mode: 'auto', timeoutSeconds: 60, model: null },
  executor: {
    maxWorkers: 3,
    prepare: 'sa-prepare',
  },
}

let store = null
try {
  const storeModule = await import(pathToFileURL(join(root, 'lib', 'packages', 'superagent', 'app', 'store.js')).href)
  store = new storeModule.Store(dbPath)
  store.saveSettings(settings)
  const seeded = store.settings()
  check(
    'settings 播进编排库：eval.mode=auto、飞书来源启用、发送方在 bots 名单里',
    seeded.eval.mode === 'auto'
      && seeded.sources.feishu?.enabled === true
      && seeded.sources.feishu?.config?.cli === process.execPath
      && (seeded.policy.sources.feishu?.bots ?? []).some((bot) => bot.id === SENDER_BOT_ID),
    JSON.stringify({ eval: seeded.eval, feishu: seeded.sources.feishu, policy: seeded.policy.sources.feishu }).slice(0, 400),
  )
} finally {
  try { store?.close() } catch { /* 已经关了 */ }
}

// 插件开关仍走 `plugins.json`；新树只从这里的 `config` 读 `stateDir` 等宿主参数（`index.ts:96-107`）。
writeFileSync(join(dsc, 'plugins.json'), JSON.stringify({
  version: 1,
  entries: [{ file: 'superagent', disabled: false, config: { stateDir: state } }],
}, null, 2) + '\n', 'utf8')
check('插件开关就位（superagent 启用，stateDir 指向隔离目录）', existsSync(join(dsc, 'plugins.json')))

// ── 第 5 步：宿主（stdio 协议，照 `superagent-e2e-test.mjs`）────────────────
async function startHost(llmPort) {
  const proc = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    // cwd 是假 CLI 的解析根：`node auth status` 按 cwd 找 `auth` 脚本（见第 3 步）。
    cwd: state,
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
      if (stderr.length > 600) stderr.splice(0, stderr.length - 600)
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

// ── 第 6 步：直接读编排库 ───────────────────────────────────────────────────
let sqlite = null
/** 只读打开编排库跑一次查询；读不了（WAL 句柄等）就退回读写打开。 */
async function query(sql, ...parameters) {
  if (!existsSync(dbPath)) return []
  sqlite ??= await import('node:sqlite')
  let db
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  } catch {
    db = new sqlite.DatabaseSync(dbPath)
  }
  try {
    return db.prepare(sql).all(...parameters)
  } finally {
    db.close()
  }
}

const readTickets = async () => (await query('SELECT value FROM ticket ORDER BY rowid ASC')).map((row) => JSON.parse(String(row.value)))
const readDecisions = async () => (await query('SELECT value FROM decision ORDER BY rowid ASC')).map((row) => JSON.parse(String(row.value)))
const readTriggers = async () => (await query('SELECT value FROM trigger ORDER BY rowid ASC')).map((row) => JSON.parse(String(row.value)))
const tableNames = async () => (await query("SELECT name FROM sqlite_master WHERE type='table'")).map((row) => String(row.name))
const readKv = async (key) => (await query('SELECT value FROM kv WHERE key = ?', key))[0]?.value
/** 编排库里的当前 settings（`settings-revision` → `settings-version:<n>`，`kv.ts` 的 `KV.settings`）。 */
async function readCurrentSettings() {
  const revision = await readKv('settings-revision')
  if (typeof revision !== 'string' && typeof revision !== 'number') return undefined
  const row = (await query('SELECT value FROM kv WHERE key = ?', 'settings-version:' + String(revision)))[0]
  if (row === undefined) return undefined
  try { return JSON.parse(String(row.value))?.settings } catch { return undefined }
}

let llm = null
let host = null
try {
  check('宿主构建产物在（lib/headless.js，前置 pnpm run build）', existsSync(join(root, 'lib', 'headless.js')))
  if (!existsSync(join(root, 'lib', 'headless.js'))) throw new Error('没有 lib/headless.js，先构建')

  llm = await startFakeLlm()
  check('假模型端点已起（127.0.0.1:' + String(llm.port) + '）', llm.port > 0)
  writeFileSync(join(dsc, 'config.yaml'), [
    'default:', '  provider: fake', '  model: fake-chat', 'providers:', '  fake:',
    '    displayName: 推断候选自检假端点', '    baseURL: http://127.0.0.1:' + String(llm.port) + '/v1',
    '    apiKeyEnv: DSC_FAKE_KEY', '    models:', '      - id: fake-chat', '        name: Fake Chat',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'), 'utf8')

  host = await startHost(llm.port)
  check('宿主启动并用 stdio 协议应答（listModels）', host.alive, tail(host.stderr))
  if (!host.alive) throw new Error('宿主没应答')

  // 部署检查：gh 的两份 JSON 与飞书的机器人身份都从假 CLI 来（`resolveDeployment` / `resolveFeishuBot`）。
  const deployed = await until(() => cliCalls().some((call) => call.name === 'api' && call.argv[0] === 'user'), 30_000)
  check('部署检查跑过：假 gh 被问到账号与仓库权限', deployed && cliCalls().some((call) => call.name === 'api' && typeof call.argv[0] === 'string' && call.argv[0].startsWith('repos/')), JSON.stringify(cliCalls().map((call) => call.name + ' ' + call.argv[0])).slice(0, 300))
  const resolvedBot = await until(() => cliCalls().some((call) => call.name === 'auth') && cliCalls().some((call) => call.name === 'config'), 30_000)
  check('飞书机器人身份被解析（假 CLI 的 auth status 与 config strict-mode 都真被调过）', resolvedBot, JSON.stringify(cliCalls().map((call) => call.name)).slice(0, 300))

  // 飞书来源真的起来了：事件长连接是用我们的假 CLI 起的，且它自己打出了 ready 标记
  // （`sources/feishu-loops.ts:81-93`；宿主不再打「飞书来源已启动」，这一条是它的等价证据）。
  const watching = await until(() => cliCalls().some((call) => call.name === 'event' && call.argv[0] === 'consume')
    && cliCalls().some((call) => call.name === 'event-ready'), 40_000)
  check('飞书来源真的启动了（假 CLI 被按 event consume 起过，并回了 [event] ready）', watching, tail(host.stderr))

  // 两条事件先后押进长连接：同群、不同 message_id → 两个线程 → 两张候选。
  writeFileSync(EVENTS_FILE, feishuEvent('om_candidate_e2e_0001', '帮我检查 README 有没有过时的说明，有的话顺手改掉') + '\n', 'utf8')
  await sleep(2_000)
  appendFileSync(EVENTS_FILE, feishuEvent('om_candidate_e2e_0002', '顺便看看 README 的措辞是不是也该统一一下') + '\n', 'utf8')

  const triggersIn = await until(async () => (await readTriggers()).length >= 2, 60_000)
  const triggers = await readTriggers()
  check('两条消息都进了库（trigger 表 2 行）', triggersIn && triggers.length === 2, String(triggers.length))
  check(
    '触发器来自飞书来源、发送方是策略 bots 名单里的机器人（不是人）',
    triggers.length >= 2 && triggers.every((trigger) => trigger.source === 'feishu' && trigger.actor?.id === SENDER_BOT_ID && trigger.human === false),
    JSON.stringify(triggers.map((trigger) => ({ source: trigger.source, actor: trigger.actor?.id, human: trigger.human }))).slice(0, 300),
  )
  const chats = await readKv('feishu-chats')
  check(
    '事件真的穿过长连接到了来源（KV feishu-chats 记到了这个群）',
    typeof chats === 'string' && chats.includes(CHAT_ID),
    String(chats).slice(0, 200),
  )

  // 判定器：主会话收到候选卡片并调 orchestrator_eval_decide（`app/tools/main.ts:236-243`）。
  const judged = await until(() => llm.stats.decides >= 2, 90_000, 500)
  check('判定器被真跑过（假模型端点收到主会话的判定请求）', llm.stats.assessor >= 2, String(llm.stats.assessor))
  check('两条候选各落一条 accept 结论（判定工具被调了两次）', judged && llm.stats.decides >= 2, String(llm.stats.decides))

  const ticketsIn = await until(async () => (await readTickets()).length >= 2, 90_000, 500)
  const tickets = await readTickets()
  check('两条消息各建出一张工单（ticket 表 2 行）', ticketsIn && tickets.length === 2, String(tickets.length))
  check('工单标题来自判定器（假端点回的那份）', tickets.length >= 2 && tickets.every((ticket) => ticket.title === TITLE), JSON.stringify(tickets.map((ticket) => ticket.title)))

  const decisions = await readDecisions()
  check('判定结果落库为 accept（decision 表 kind=accept）', decisions.length >= 2 && decisions.every((decision) => decision.kind === 'accept'), JSON.stringify(decisions.map((decision) => decision.kind)))
  check(
    '判定强度是推断（inferred），没有人工点头（eval.mode=auto 下判定器直接接单）',
    decisions.length >= 2 && decisions.every((decision) => decision.strength === 'inferred'),
    JSON.stringify(decisions.map((decision) => decision.strength)),
  )

  const tables = await tableNames()
  check('库里不存在 candidate 表（旧收件箱的存储面确实没了）', !tables.includes('candidate'), tables.join(','))

  // 工单收尾：worker 报 ready → completed（`core/assignments.ts:128-132`，无 follows 时即 completed）。
  const ended = await until(async () => {
    const rows = await readTickets()
    return rows.length >= 2 && rows.every((ticket) => ticket.ended !== undefined)
  }, 150_000, 500)
  const finalTickets = await readTickets()
  check('两张工单都自己跑完了（ended 有值）', ended, tail(host.stderr, 12))
  check(
    '两张工单以 completed 收尾',
    finalTickets.length >= 2 && finalTickets.every((ticket) => ticket.ended?.outcome === 'completed'),
    JSON.stringify(finalTickets.map((ticket) => ticket.ended?.outcome ?? null)),
  )
  const workerTools = llm.stats.workerTools
  const countOf = (name) => workerTools.filter((item) => item === name).length
  check(
    '假模型端点按 read → write → orchestrator_report 驱动了 worker（每个 worker 各一遍）',
    countOf('read') === 2 && countOf('write') === 2 && countOf('report') === 2,
    workerTools.join(',') || '一次 worker 工具调用都没发生',
  )

  const workDirs = existsSync(workRoot)
    ? readdirSync(workRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)
    : []
  check('两张工单各有一棵工作目录（<DSC_HOME>/superagent/work/<name>）', workDirs.length === 2, workDirs.join('、'))
  const readmes = workDirs.map((name) => {
    const file = join(workRoot, name, 'README.md')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  })
  check(
    '两棵工作目录里的 README 都被 worker 改过（含 ' + MARK + '）',
    readmes.length === 2 && readmes.every((text) => text.includes(MARK)),
    readmes.map((text) => JSON.stringify(text.slice(0, 80))).join(' | '),
  )
  check(
    '工单执行目录名带上判定器给的短名（' + WORKTREE_NAME + '-<id>）',
    workDirs.length === 2 && workDirs.every((name) => name.startsWith(WORKTREE_NAME + '-')),
    workDirs.join('、'),
  )

  // 判定在 auto 模式下直接接单：读宿主自己库里的当前 settings，证明没有谁中途把它改回 observe。
  const live = await readCurrentSettings()
  check(
    '编排库里的 eval.mode 仍是 auto（宿主运行期读到的就是这份）',
    live?.eval?.mode === 'auto',
    JSON.stringify(live?.eval ?? null),
  )
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
