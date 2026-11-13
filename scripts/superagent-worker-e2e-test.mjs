/**
 * worker 深能力全链路门禁（backlog D 表第二、三条，合并一条）：真 worker 里
 *   1. 起后台作业（bash `run_in_background`）→ 回合结束因作业在跑不交付 → 作业完成
 *      自动通知 → worker 被唤醒读 `job_output` → 交付；
 *   2. 调 `subagent(action=spawn)` 起一个队友 → 队友真的跑了一回合回了话 → 工单收尾。
 *
 * 为什么要有它：这两条此前各有「零件级」测试——执行器用假 jobs 表测过等待逻辑（注入
 * `backgroundLimitMs`）、`JobTable` 真子进程测过 list/running/wait/kill、worker 白名单里
 * 有 `subagent`、父会话查不到会抛错——但「真 worker 会话里真的调了这些工具、真的被
 * 唤醒、队友真的回了话」没有走过一遍。工具目录漏挂、唤醒链路接错，都要等人手工发现。
 *
 * 为什么用假模型端点：与 `superagent-e2e-test.mjs` 同一条理由。假端点按工单标题区分
 * 两张工单、按「历史里几条 assistant tool_calls」在各自序列内分派（请求重试不错位）。
 * 队友的请求落到兜底分支（回一段正文）——正是一次性队友需要的全部。
 *
 * 判据（逐条打印 PASS / FAIL，退出码 0 / 1）：
 *   1. 临时 HOME / USERPROFILE / DSC_HOME + 临时 git 仓库 + 角色文件，真实 ~/.dsc 不碰；
 *   2. 宿主 stdio 应答，两张工单都建成；
 *   3. 后台作业单：worker 被唤醒过（同一张工单至少两轮 worker 请求）、
 *      `job_output` 真读到了作业输出（转录含作业回显标记）、工单 completed；
 *   4. 子智能体单：spawn 的结果真进了会话（转录含队友回话标记）、
 *      队友记录落进 roster.json、工单 completed 且收队友的日志出现过；
 *   5. 两张工单的提交都在各自工作树里，工作树干净；
 *   6. 临时目录被清掉。
 *
 * 与 `superagent-e2e-test.mjs` / `superagent-candidate-e2e-test.mjs` 的分工：那条验
 * 「明确请求直接交付」、这条验「收件箱等人点头」，本条验「worker 干活时的两个深能力」。
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

// ── 第 1 步：临时 git 仓库 + 角色文件 ────────────────────────────────────────
git(['init', '-b', 'main'])
git(['config', 'user.email', 'sa-worker-e2e@example.invalid'])
git(['config', 'user.name', 'superagent-worker-e2e'])
writeFileSync(join(repo, 'README.md'), '# demo\n', 'utf8')
git(['add', '-A'])
git(['commit', '-m', 'init'])
check('临时仓库建好了（一个 init 提交）', git(['log', '--oneline']).code === 0)

// 队友的角色文件：subagent 的 spawn 按 `~/.dsc/agents/<name>.md` 找角色（`agent-roles.ts:287`）。
// tools: none = 一个工具都不给，队友一回合正文就收工。
writeFileSync(join(dsc, 'agents', 'helper.md'), [
  '---', 'name: helper', 'description: 回一句话就收工的帮手', 'tools: none', '---', '',
  '你只做一件事：把任务里要求的文字原样回复出来，不要使用任何工具。', '',
].join('\n'), 'utf8')
check('队友角色文件就位（agents/helper.md）', existsSync(join(dsc, 'agents', 'helper.md')))

// ── 第 2 步：假模型端点 ─────────────────────────────────────────────────────
//
// 两张工单的动作序列不同，按「这条请求的 user 消息里是哪张工单的标题」选序列；
// 序列内按「历史里几条 assistant tool_calls」分派（重试、压缩探测都不错位）。
// 队友（helper，tools:none）的请求不带 worker 的 system 句，落到兜底分支——正文的
// 正文就是 spawn 要的结果，所以兜底文案里带上队友标记。
const JOB_MARK = 'SA-WORKER-E2E-JOB-OUTPUT'
const TEAMMATE_MARK = 'SA-TEAMMATE-E2E-OK'
const JOB_TITLE = '后台作业链路 SA-WORKER-E2E'
const TEAM_TITLE = '子智能体链路 SA-TEAMMATE-E2E'
const JOB_COMMIT = 'test: worker e2e job README'
const TEAM_COMMIT = 'test: worker e2e teammate README'

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
      const system = String(messages.find((message) => message.role === 'system')?.content ?? '')
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
      const toolCall = (index, name, args) => {
        send(frame({ role: 'assistant', content: '' }))
        send(frame({
          tool_calls: [{ index, id: 'call_wkr_' + String(index + 1) + '_' + String(Date.now() % 100000), type: 'function',
            function: { name, arguments: JSON.stringify(args) } }],
        }))
        send(frame({}, 'tool_calls'))
        finish()
      }

      // worker 的请求按工单分派；其余（判定器、队友、摘要类）全走兜底正文。
      const userText = messages.filter((message) => message.role === 'user')
        .map((message) => String(message.content ?? '')).join('\n')
      const isWorker = system.includes('超级智能体的执行者')
      if (!isWorker) {
        plainReply('队友回复：' + TEAMMATE_MARK + '。任务已了解，无需工具，到此收工。')
        return
      }
      const which = userText.includes(JOB_TITLE) ? JOB_TITLE : userText.includes(TEAM_TITLE) ? TEAM_TITLE : null
      if (which === null) {
        plainReply('（探针找不到工单标题，不驱动）')
        return
      }
      bump(which)
      const calls = messages.filter(
        (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
      ).length

      if (which === JOB_TITLE) {
        // 后台作业：起后台作业 → （唤醒后）job_output 读 → git commit → report + 收尾。
        if (calls === 0) {
          toolCall(0, 'bash', { command: 'Start-Sleep -Seconds 2; echo ' + JOB_MARK, run_in_background: true })
          return
        }
        if (calls === 1) {
          // 作业 id 不知道，先 list 再读——两步合成一步会让序列脆，list 的返回里就有 id。
          toolCall(0, 'job_list', {})
          return
        }
        if (calls === 2) {
          // 这张单没写文件，用 --allow-empty 留一条提交当锚点（与交付语义无关，只验「提交发生」）。
          toolCall(0, 'bash', { command: 'git add -A; git commit -m "' + JOB_COMMIT + '" --allow-empty' })
          return
        }
        if (calls === 3) {
          toolCall(0, 'superagent_report', { state: 'ready', summary: '后台作业完成，输出已读，README 已提交' })
          return
        }
        plainReply('后台作业跑完了：' + JOB_MARK + ' 已读到，README 已提交。')
        return
      }

      // 子智能体：spawn 一个 helper（前台等结果）→ git commit → report + 收尾。
      if (calls === 0) {
        toolCall(0, 'subagent', { action: 'spawn', role: 'helper', task: '请原样回复：' + TEAMMATE_MARK, background: false })
        return
      }
      if (calls === 1) {
        toolCall(0, 'bash', { command: 'git add -A; git commit -m "' + TEAM_COMMIT + '" --allow-empty' })
        return
      }
      if (calls === 2) {
        toolCall(0, 'superagent_report', { state: 'ready', summary: '队友已回复，README 提交完成' })
        return
      }
      plainReply('队友回复过了：' + TEAMMATE_MARK + '，README 已提交。')
    })
  })
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok))
  return { port, perTicketRequests, close: () => new Promise((ok) => server.close(() => ok())) }
}

// ── 第 3 步：插件配置 + 宿主（照 `superagent-candidate-e2e-test.mjs`）────────
writeFileSync(join(dsc, 'plugins.json'), JSON.stringify({
  version: 1,
  // subagent 默认关（`subagent/cordis.patch.yml:5`）：不显式启用它，`team` 服务不在场，
  // 执行器收队友那一支（`hostFromContext` 的 `ctx.get('team')`）就永远是 undefined。
  entries: [
    { file: 'superagent', disabled: false, config: { repoPath: repo } },
    { file: 'subagent', disabled: false },
  ],
}, null, 2) + '\n', 'utf8')

let sqlite = null
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

  // 两张工单并发派（maxWorkers 缺省 2）：各自走各自的序列。
  await host.invoke('runCommand', ['/sa new ' + JOB_TITLE + ' | 后台跑一条命令，读它的输出，然后提交 README'])
  await host.invoke('runCommand', ['/sa new ' + TEAM_TITLE + ' | 派一个 helper 队友回一句话，然后提交 README'])
  const bothBuilt = await until(async () => (await readTickets()).length >= 2, 30_000)
  check('两张工单都建成了', bothBuilt && (await readTickets()).length >= 2, String((await readTickets()).length))
  if (!bothBuilt) throw new Error('工单没建成，后面的断言没有对象')

  const bothEnded = await until(
    async () => {
      const tickets = await readTickets()
      return tickets.length >= 2 && tickets.every((item) => item.ended !== undefined)
    },
    120_000, 500,
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
  const jobSession = jobTicket === undefined ? '' : readSessionText(join(dsc, 'superagent', 'sessions', jobTicket.id))
  check('worker 真起了后台作业（转录含 run_in_background）', jobSession.includes('run_in_background'), jobSession === '' ? '会话目录为空' : '转录里没有后台作业调用')
  check('job_output 真读到了作业输出（转录含作业回显）', jobSession.includes(JOB_MARK), jobSession === '' ? '会话目录为空' : '转录里没有作业输出')
  check('后台作业单的提交进了工作树', git(['log', '--all', '--format=%s']).out.includes(JOB_COMMIT), git(['log', '--all', '--format=%s']).out.trim())

  // ── 子智能体链路的事实 ──────────────────────────────────────────────────
  const teamSession = teamTicket === undefined ? '' : readSessionText(join(dsc, 'superagent', 'sessions', teamTicket.id))
  check('worker 真调了 subagent spawn（转录含调用）', teamSession.includes('spawn') && teamSession.includes('helper'), teamSession === '' ? '会话目录为空' : '转录里没有 spawn')
  check('队友真的回过话（转录含队友标记）', teamSession.includes(TEAMMATE_MARK), teamSession === '' ? '会话目录为空' : '转录里没有队友回复')
  const rosterPath = join(dsc, 'team', 'roster.json')
  // 名册的落盘形状：{ teammates: RosterRecord[] }（`subagent/index.ts:371`）。
  const rosterDoc = existsSync(rosterPath) ? JSON.parse(readFileSync(rosterPath, 'utf8')) : {}
  const roster = Array.isArray(rosterDoc?.teammates) ? rosterDoc.teammates : []
  check('队友记录落进了名册（roster.json）', Array.isArray(roster) && roster.length >= 1, JSON.stringify(roster).slice(0, 200))
  check(
    '工单收尾时收了队友（名册里已是收工状态）',
    roster.some((item) => item?.state === 'idle'),
    JSON.stringify(roster).slice(0, 200),
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
