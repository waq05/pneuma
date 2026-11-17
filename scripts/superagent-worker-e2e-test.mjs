/**
 * worker 深能力全链路门禁（backlog D 表第二、三条，合并一条）：真 worker 里
 *   1. 起后台作业（bash `run_in_background`）→ 回合结束因作业在跑不交付 → 作业完成被唤醒 →
 *      worker 读 `job_output` → 交付；
 *   2. 调 `subagent(action=spawn)` 起一个队友 → 队友真的跑了一回合回了话 → 工单收尾。
 *
 * 为什么要有它：这两条此前各有「零件级」测试——执行器用假 jobs 表测过等待逻辑（注入
 * `backgroundLimitMs`）、`JobTable` 真子进程测过 list/running/wait/kill、worker 白名单里
 * 有 `subagent`、父会话查不到会抛错——但「真 worker 会话里真的调了这些工具、真的被
 * 唤醒、队友真的回了话」没有走过一遍。工具目录漏挂、唤醒链路接错，都要等人手工发现。
 *
 * ## 移植后（feat/pluginization）的三处改写
 *
 * 1. **配置进编排库**：仓库 / 假 CLI / prepare 命令都由 `lib/packages/superagent/app/store.js`
 *    的 `Store.saveSettings({...})` 播种（`stateDir` = `<DSC_HOME>/superagent`），
 *    `plugins.json` 只留两个开关（superagent + subagent）。理由与逐字段来源见
 *    `superagent-e2e-test.mjs` 的文件头第 1、2 条。
 * 2. **判定由主会话模型回合完成**：`/sa new` 两单都是 `publish` → 候选卡 → 主会话调
 *    `orchestrator_route` 接单。假端点按请求里的工具名单分派（worker 用 `orchestrator_report`，
 *    主会话用 `orchestrator_route`），两张工单的动作序列再按投递消息里的标题分开。
 * 3. **工单目录是 `<DSC_HOME>/superagent/work/<短名>-<id12>`**，由 `executor.prepare` 命令
 *    在父目录里建出来（Windows 走 `cmd.exe /d /s /c`，命令里不能加引号——node 的 spawn 包一层
 *    引号、cmd 的 `/s` 只剥最外一对，内层引号会变成参数字符，见主探针同段注释）。
 *
 * 为什么用假模型端点：与 `superagent-e2e-test.mjs` 同一条理由。假端点按工单标题区分两张
 * 工单、按「历史里几条 assistant tool_calls」在各自序列内分派（请求重试不错位）。队友的请求
 * 落到兜底分支（回一段正文）——正是一次性队友需要的全部。
 *
 * 判据（逐条打印 PASS / FAIL，退出码 0 / 1）：
 *   1. 临时 HOME / USERPROFILE / DSC_HOME + 临时 git 仓库 + 假 gh + 队友角色文件，真实 ~/.dsc 不碰；
 *   2. 设置播种成功、宿主 stdio 应答，两张工单都建成（标题各是探针发的那张）；
 *   3. 后台作业单：worker 被唤醒过（同一张工单至少两轮 worker 请求）、转录含 `run_in_background`、
 *      `job_output` 真读到了作业输出（转录含作业回显标记）、工单 completed、目录里有那条提交；
 *   4. 子智能体单：转录含 spawn 调用与队友回话标记、队友记录落进 roster.json（收工状态）、
 *      工单 completed、目录里有那条提交；
 *   5. 两张工单的目录都在 `<DSC_HOME>/superagent/work` 下且干净；
 *   6. 临时目录被清掉。
 *
 * 与 `superagent-e2e-test.mjs` / `superagent-candidate-e2e-test.mjs` 的分工：那条验
 * 「明确请求直接交付」、这条验「人工发布进判定」，本条验「worker 干活时的两个深能力」。
 *
 * 前置：先 `pnpm run build`。
 * 用法：`node scripts/superagent-worker-e2e-test.mjs`；被 `scripts/check-core.mjs` 自动发现。
 *
 * @module dsc/scripts/superagent-worker-e2e-test
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
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

async function until(predicate, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

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

const realHome = homedir()
const KEEP = process.env['DSC_SA_E2E_KEEP'] === '1'
const home = mkdtempSync(join(tmpdir(), 'dsc-sa-worker-e2e-'))
const dsc = join(home, '.dsc')
const repo = join(home, 'repo')
/** 超级智能体数据根（`paths.ts` 的 `superagentRoot()`）。 */
const stateDir = join(dsc, 'superagent')
mkdirSync(dsc, { recursive: true })
mkdirSync(repo, { recursive: true })
mkdirSync(join(dsc, 'agents'), { recursive: true })
process.env['HOME'] = home
process.env['USERPROFILE'] = home
process.env['DSC_HOME'] = dsc
console.log('[superagent-worker-e2e] 隔离 HOME：' + home)

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

/** 读一棵目录下所有 .jsonl 的正文（会话文件按内容找，不按文件名）。 */
function readSessionText(dir) {
  if (!existsSync(dir)) return ''
  const parts = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { parts.push(readFileSync(abs, 'utf8')) } catch { /* 正在写的那一行跳过 */ }
      }
    }
  }
  walk(dir)
  return parts.join('\n')
}

// ── 第 1 步：临时 git 仓库 + 后台作业脚本 + 队友角色文件 ──────────────────
const JOB_MARK = 'SA-WORKER-E2E-JOB-OUTPUT'
const TEAMMATE_MARK = 'SA-TEAMMATE-E2E-OK'
const JOB_TITLE = '后台作业链路 SA-WORKER-E2E'
const TEAM_TITLE = '子智能体链路 SA-TEAMMATE-E2E'
const JOB_COMMIT = 'test: worker e2e job README'
const TEAM_COMMIT = 'test: worker e2e teammate README'

/**
 * worker 用 `bash` 工具跑的那条提交命令（两个平台各一份）。带重试的原因见
 * `superagent-e2e-test.mjs` 同名函数：宿主自己的 `git status` 会短暂持有
 * `.git/index.lock`，worker 的 `git commit` 撞上就报 `File exists`（实测偶发，约 1/3）。
 * 身份要显式给：隔离的全局配置设了 `useConfigOnly = true`。
 */
function commitCommand(subject, allowEmpty = false) {
  const empty = allowEmpty ? ' --allow-empty' : ''
  return process.platform === 'win32'
    ? 'git config user.name sa-worker-e2e; git config user.email sa-worker-e2e@example.invalid; for ($i = 0; $i -lt 3; $i++) { git add -A; git commit' + empty + ' -m "' + subject + '"; if ($?) { break }; Start-Sleep -Milliseconds 400 }'
    : 'git config user.name sa-worker-e2e; git config user.email sa-worker-e2e@example.invalid; for i in 1 2 3; do git add -A; git commit' + empty + ' -m "' + subject + '" && break; sleep 0.4; done'
}

git(['init', '-b', 'main'])
git(['config', 'user.email', 'sa-worker-e2e@example.invalid'])
git(['config', 'user.name', 'superagent-worker-e2e'])
writeFileSync(join(repo, 'README.md'), '# demo\n', 'utf8')
// 后台作业跑这个脚本：用 node 而不是 `Start-Sleep` / `sleep`，两种 shell 的写法才一致。
// 延迟 5 秒是有意留的余量：执行器只在「回合结束时作业还在跑」的情况下进入等待并稍后唤醒
// （`executor/dsh.ts` 的 `workerIdle` / `untilQuiet`）；作业若在回合收尾前就结束，它会直接
// 记一条 `waiting` 报告、不再唤醒——那一步就成了时序赌博（实测 1.5 秒会偶发红）。
writeFileSync(join(repo, 'job-sleep.mjs'),
  "setTimeout(() => { console.log('" + JOB_MARK + "') }, 5000)\n", 'utf8')
git(['add', '-A'])
git(['commit', '-m', 'init'])
check('临时仓库建好了（一个 init 提交，带后台作业脚本）', git(['log', '--oneline']).code === 0)

// 队友的角色文件：subagent 的 spawn 按 `~/.dsc/agents/<name>.md` 找角色（`agent-roles.ts:287`）。
// tools: none = 一个工具都不给，队友一回合正文就收工。
writeFileSync(join(dsc, 'agents', 'helper.md'), [
  '---', 'name: helper', 'description: 回一句话就收工的帮手', 'tools: none', '---', '',
  '你只做一件事：把任务里要求的文字原样回复出来，不要使用任何工具。', '',
].join('\n'), 'utf8')
check('队友角色文件就位（agents/helper.md）', existsSync(join(dsc, 'agents', 'helper.md')))

// ── 第 2 步：假 gh（部署检查与来源轮询都要它）──────────────────────────────
//
// 与主探针同一招：cli = node.exe，stateDir 放一个无扩展名脚本 `api`，按 argv[2] 回 JSON。
// 详见 `superagent-e2e-test.mjs` 第 2 步的注释（`spawn` 不能直跑 `.cmd`）。
const FAKE_REPO = 'owner/name'
const FAKE_API = [
  '// 探针的假 gh：按第一个参数回 resolveDeployment 与来源轮询要的形状。',
  "const args = process.argv.slice(2)",
  "const path = args[0] ?? ''",
  'const out = (text) => process.stdout.write(text)',
  "if (path === 'user') out(JSON.stringify({ login: 'sa-bot', id: 1 }))",
  `else if (path === 'repos/${FAKE_REPO}') out(JSON.stringify({ name: '${FAKE_REPO}', push: true }))`,
  "else if (args.includes('--include')) out('HTTP/1.1 200 OK\\nx-poll-interval: 3600\\n\\n[]\\n')",
  "else if (args.includes('--slurp')) out('[]')",
  "else out('[]')",
  '',
].join('\n')
mkdirSync(stateDir, { recursive: true })
writeFileSync(join(stateDir, 'api'), FAKE_API, 'utf8')
check('假 gh 脚本就位（<DSC_HOME>/superagent/api）', existsSync(join(stateDir, 'api')))

// ── 第 3 步：假模型端点 ─────────────────────────────────────────────────────
//
// 三条分派线都按请求里的**工具名单**认：
//   带 `orchestrator_route` → 主会话回合：把两张候选卡各自接单（标题 / 短名按候选正文里的工单名映射）。
//   带 `orchestrator_report` → worker 回合：按投递消息里的工单标题分成两条序列。
//   其余（队友、摘要类）      → 兜底正文，队友标记就在这段话里。
function frame(delta, finish = null) {
  return {
    id: 'chatcmpl-sa-worker-e2e',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

async function startFakeLlm() {
  const port = await freePort()
  /** 每张工单收到了几次 worker 请求（后台作业单要 ≥2：首轮 + 作业唤醒轮）。 */
  const perTicketRequests = new Map()
  const bump = (ticket) => perTicketRequests.set(ticket, (perTicketRequests.get(ticket) ?? 0) + 1)
  /** 已接单的候选 trigger_id：候选卡重投时不重复接单。 */
  const routed = new Set()
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
      const tools = new Set((Array.isArray(body.tools) ? body.tools : [])
        .map((item) => item?.function?.name ?? item?.name).filter((name) => typeof name === 'string'))
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
          tool_calls: [{ index: 0, id: 'call_wkr_' + String(Date.now() % 100000), type: 'function',
            function: { name, arguments: JSON.stringify(args) } }],
        }))
        send(frame({}, 'tool_calls'))
        finish()
      }
      const jsonMessages = messages.flatMap((message) => {
        if (message.role !== 'user' || typeof message.content !== 'string') return []
        if (!message.content.trimStart().startsWith('{')) return []
        try { return [JSON.parse(message.content)] } catch { return [] }
      })
      const userText = messages.filter((message) => message.role === 'user')
        .map((message) => String(message.content ?? '')).join('\n')

      // ── 主会话：两张候选卡各自接单（一张一次，重投不重复）。 ──
      if (tools.has('orchestrator_route')) {
        const pending = jsonMessages.filter((item) => item?.kind === 'candidate' && item?.trigger_id && !routed.has(item.trigger_id))
        if (pending.length === 0) {
          plainReply('（没有待接的候选，收工。）')
          return
        }
        const decisionOf = (card) => {
          const text = JSON.stringify(card)
          const job = text.includes(JOB_TITLE)
          routed.add(card.trigger_id)
          return {
            kind: 'accept',
            trigger_id: card.trigger_id,
            title: job ? JOB_TITLE : TEAM_TITLE,
            worktree_name: job ? 'sa-job' : 'sa-team',
            acknowledgement: job ? '开始：后台跑一条命令并读它的输出。' : '开始：派一个队友回一句话。',
          }
        }
        toolCall('orchestrator_route', { decisions: pending.slice(0, 1).map(decisionOf) })
        return
      }

      // ── worker：按投递消息里的工单标题分成两条序列。 ──
      if (tools.has('orchestrator_report')) {
        const titles = jsonMessages.map((item) => item?.title).filter((title) => typeof title === 'string')
        const which = titles.includes(JOB_TITLE) ? JOB_TITLE : titles.includes(TEAM_TITLE) ? TEAM_TITLE : null
        if (which === null) {
          plainReply('（探针找不到工单标题，不驱动）')
          return
        }
        bump(which)
        const calls = messages.filter(
          (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
        ).length

        if (which === JOB_TITLE) {
          if (calls === 0) {
            // 后台作业：立刻返回 job id；回合到这里先收尾，等执行器因作业结束来唤醒。
            toolCall('bash', { command: 'node job-sleep.mjs', run_in_background: true })
            return
          }
          if (calls === 1) {
            // 唤醒提示里会写「background work ended … read a job's output with job_output」。
            // 纯文本收尾（作业还在跑）与唤醒轮都落在 calls===1，靠这句话区分。
            if (!userText.includes('background work ended')) {
              plainReply('后台作业还在跑，等它结束。')
              return
            }
            // 作业 id 只有 bash 的返回里有（`已转入后台：<id>`）：从历史里把它捞出来。
            const resultText = messages.filter((message) => message.role === 'tool')
              .map((message) => String(message.content ?? '')).join('\n')
            const id = /已转入后台：([^\s\n]+)/.exec(resultText)?.[1] ?? ''
            toolCall('job_output', { job_id: id })
            return
          }
          if (calls === 2) {
            // 这张单不要求改文件，用 --allow-empty 留一条提交当锚点（只验「提交发生」）。
            toolCall('bash', { command: commitCommand(JOB_COMMIT, true) })
            return
          }
          if (calls === 3) {
            toolCall('orchestrator_report', { state: 'ready', summary: '后台作业完成，输出已读，README 已提交' })
            return
          }
          plainReply('后台作业跑完了：' + JOB_MARK + ' 已读到，README 已提交。')
          return
        }

        // 子智能体：spawn 一个 helper（前台等结果）→ git commit → report + 收尾。
        if (calls === 0) {
          toolCall('subagent', { action: 'spawn', role: 'helper', task: '请原样回复：' + TEAMMATE_MARK, background: false })
          return
        }
        if (calls === 1) {
          toolCall('bash', { command: commitCommand(TEAM_COMMIT, true) })
          return
        }
        if (calls === 2) {
          toolCall('orchestrator_report', { state: 'ready', summary: '队友已回复，README 提交完成' })
          return
        }
        plainReply('队友回复过了：' + TEAMMATE_MARK + '，README 已提交。')
        return
      }

      // 队友（helper，tools: none）与其它请求：正文就是 spawn 要的结果。
      plainReply('队友回复：' + TEAMMATE_MARK + '。任务已了解，无需工具，到此收工。')
    })
  })
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok))
  return { port, perTicketRequests, close: () => new Promise((ok) => server.close(() => ok())) }
}

// ── 第 4 步：插件开关 + 设置播种 + 宿主 ─────────────────────────────────────
writeFileSync(join(dsc, 'plugins.json'), JSON.stringify({
  version: 1,
  // subagent 默认关（`subagent/cordis.patch.yml:4`）：不显式启用它，`team` 服务不在场，
  // 执行器收队友那一支（`untilQuiet` 里 `ctx.get('team')` 的子智能体列表）就永远是空的。
  entries: [
    { file: 'superagent', disabled: false },
    { file: 'subagent', disabled: false },
  ],
}, null, 2) + '\n', 'utf8')

// prepare 命令：见主探针同段的注释（Windows 上不能给参数加引号；prepare 的 cwd 是工单目录的父目录）。
const PREPARE_CWD = join(stateDir, 'work')
const preparable = process.platform === 'win32'
  ? relative(PREPARE_CWD, repo)
  : "'" + relative(PREPARE_CWD, repo).replaceAll("'", "'\\''") + "'"
const PREPARE = process.platform === 'win32'
  ? 'git clone ' + preparable + ' %DSH_SUPERAGENT_NAME% && git -C %DSH_SUPERAGENT_NAME% checkout -b agent/%DSH_SUPERAGENT_NAME%'
  : 'git clone ' + preparable + ' "$DSH_SUPERAGENT_NAME" && git -C "$DSH_SUPERAGENT_NAME" checkout -b "agent/$DSH_SUPERAGENT_NAME"'

const SETTINGS = {
  paused: false,
  sources: { github: { enabled: true, config: { repository: FAKE_REPO, cli: process.execPath } } },
  policy: { sources: {} },
  eval: { mode: 'observe' },
  // 两张工单并发派（缺省 maxWorkers=3 也够，这里显式写 2 表明探针要的并发度）。
  executor: { maxWorkers: 2, directory: '', prepare: PREPARE, blockedCommands: [] },
}

const seeded = await (async () => {
  const storeUrl = pathToFileURL(join(root, 'lib', 'packages', 'superagent', 'app', 'store.js')).href
  const { Store } = await import(storeUrl)
  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  try {
    store.saveSettings(SETTINGS)
    return store.settings()
  } finally {
    store.close()
  }
})()
check(
  '设置已播种进编排库（仓库、假 CLI、prepare 命令、maxWorkers=2）',
  seeded.sources.github?.config?.repository === FAKE_REPO && seeded.sources.github?.config?.cli === process.execPath
    && seeded.executor.prepare === PREPARE && seeded.executor.maxWorkers === 2,
  JSON.stringify(seeded.executor ?? null),
)

let sqlite = null
async function readTickets() {
  const dbPath = join(stateDir, 'orchestrator.sqlite')
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

async function startHost(llmPort) {
  writeFileSync(join(dsc, 'config.yaml'), [
    'default:', '  provider: fake', '  model: fake-chat', 'providers:', '  fake:',
    '    displayName: worker 深能力自检假端点', '    baseURL: http://127.0.0.1:' + String(llmPort) + '/v1',
    '    apiKeyEnv: DSC_FAKE_KEY', '    models:', '      - id: fake-chat', '        name: Fake Chat',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'), 'utf8')
  const proc = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: { ...process.env, DSC_FAKE_KEY: 'sk-sa-worker-e2e' },
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

let llm = null
let host = null
try {
  check('宿主构建产物在（lib/headless.js，前置 pnpm run build）', existsSync(join(root, 'lib', 'headless.js')))
  if (!existsSync(join(root, 'lib', 'headless.js'))) throw new Error('没有 lib/headless.js，先构建')

  llm = await startFakeLlm()
  check('假模型端点已起（127.0.0.1:' + String(llm.port) + '）', llm.port > 0)

  host = await startHost(llm.port)
  check('宿主启动并用 stdio 协议应答（listModels）', host.alive, tail(host.stderr))
  if (!host.alive) throw new Error('宿主没应答')

  // 两张工单并发派（maxWorkers=2）：各自走各自的序列。
  await host.invoke('runCommand', ['/sa new ' + JOB_TITLE + ' | ' + JOB_TITLE + '：后台跑一条命令，读它的输出，然后提交 README'])
  await host.invoke('runCommand', ['/sa new ' + TEAM_TITLE + ' | ' + TEAM_TITLE + '：派一个 helper 队友回一句话，然后提交 README'])
  const bothBuilt = await until(async () => (await readTickets()).length >= 2, 60_000)
  const created = await readTickets()
  check('两张工单都建成了', bothBuilt && created.length >= 2, String(created.length))
  check(
    '两张工单的标题都是主会话接单时写的那张',
    created.some((item) => item.title === JOB_TITLE) && created.some((item) => item.title === TEAM_TITLE),
    created.map((item) => item.title).join('、'),
  )
  if (!bothBuilt) throw new Error('工单没建成，后面的断言没有对象')

  const bothEnded = await until(
    async () => {
      const tickets = await readTickets()
      return tickets.length >= 2 && tickets.every((item) => item.ended !== undefined)
    },
    150_000, 500,
  )
  const tickets = await readTickets()
  const jobTicket = tickets.find((item) => item.title === JOB_TITLE)
  const teamTicket = tickets.find((item) => item.title === TEAM_TITLE)
  check('两张工单都自己跑完了（ended 有值）', bothEnded, bothEnded ? '' : tail(host.stderr, 12))
  check('后台作业单以完成收尾（outcome=completed）', jobTicket?.ended?.outcome === 'completed', JSON.stringify(jobTicket?.ended ?? null))
  check('子智能体单以完成收尾（outcome=completed）', teamTicket?.ended?.outcome === 'completed', JSON.stringify(teamTicket?.ended ?? null))

  // ── 后台作业链路的事实 ──────────────────────────────────────────────────
  check(
    'worker 被作业唤醒过（同一张工单至少两轮 worker 请求）',
    (llm.perTicketRequests.get(JOB_TITLE) ?? 0) >= 2,
    String(llm.perTicketRequests.get(JOB_TITLE) ?? 0),
  )
  const jobSession = jobTicket === undefined ? '' : readSessionText(join(stateDir, 'sessions', jobTicket.id))
  check('worker 真起了后台作业（转录含 run_in_background）', jobSession.includes('run_in_background'), jobSession === '' ? '会话目录为空' : '转录里没有后台作业调用')
  check('worker 真调了 job_output（转录含调用）', jobSession.includes('job_output'), jobSession === '' ? '会话目录为空' : '转录里没有 job_output')
  check('job_output 真读到了作业输出（转录含作业回显）', jobSession.includes(JOB_MARK), jobSession === '' ? '会话目录为空' : '转录里没有作业输出')
  const jobDir = jobTicket?.execution?.directory ?? ''
  check('后台作业单的提交进了工单目录', jobDir !== '' && git(['log', '--format=%s'], jobDir).out.includes(JOB_COMMIT), jobDir === '' ? '没有工单目录' : git(['log', '-1', '--format=%s'], jobDir).out.trim())

  // ── 子智能体链路的事实 ──────────────────────────────────────────────────
  const teamSession = teamTicket === undefined ? '' : readSessionText(join(stateDir, 'sessions', teamTicket.id))
  check('worker 真调了 subagent spawn（转录含调用）', teamSession.includes('spawn') && teamSession.includes('helper'), teamSession === '' ? '会话目录为空' : '转录里没有 spawn')
  check('队友真的回过话（转录含队友标记）', teamSession.includes(TEAMMATE_MARK), teamSession === '' ? '会话目录为空' : '转录里没有队友回复')
  const rosterPath = join(dsc, 'team', 'roster.json')
  // 名册的落盘形状：{ teammates: RosterRecord[] }（`subagent/index.ts:330` 落在 <DSC_HOME>/team/roster.json）。
  const rosterDoc = existsSync(rosterPath) ? JSON.parse(readFileSync(rosterPath, 'utf8')) : {}
  const roster = Array.isArray(rosterDoc?.teammates) ? rosterDoc.teammates : []
  check('队友记录落进了名册（roster.json）', roster.length >= 1, JSON.stringify(roster).slice(0, 200))
  check(
    '工单收尾时收了队友（名册里已是收工状态）',
    roster.some((item) => item?.state === 'idle'),
    JSON.stringify(roster).slice(0, 200),
  )
  const teamDir = teamTicket?.execution?.directory ?? ''
  check('子智能体单的提交进了工单目录', teamDir !== '' && git(['log', '--format=%s'], teamDir).out.includes(TEAM_COMMIT), teamDir === '' ? '没有工单目录' : git(['log', '-1', '--format=%s'], teamDir).out.trim())

  // ── 两张工单的目录都在执行根下、提交后干净 ───────────────────────────────
  const expectedRoot = join(stateDir, 'work')
  check(
    '两张工单的目录都在 <DSC_HOME>/superagent/work 下',
    [jobDir, teamDir].every((dir) => dir !== '' && resolve(dir).startsWith(resolve(expectedRoot)) && existsSync(dir)),
    jobDir + ' / ' + teamDir,
  )
  check(
    '两张工单的目录提交后都是干净的',
    [jobDir, teamDir].every((dir) => dir !== '' && git(['status', '--porcelain'], dir).out.trim() === ''),
    [jobDir, teamDir].map((dir) => git(['status', '--porcelain'], dir).out.trim() || '干净').join(' / '),
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
  console.log('[superagent-worker-e2e] ' + String(passed) + '/' + String(total) + ' 通过')
  process.exit(0)
}
console.log('[superagent-worker-e2e] ' + String(passed) + '/' + String(total) + ' 通过，' + String(failures.length) + ' 条失败：' + failures.join('；'))
process.exit(1)
