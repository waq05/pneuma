/**
 * Super Agent 全链路门禁（backlog O3）：`/sa new` 发一单 → worker 在真 worktree 里改 README →
 * 真 `git commit` → 工单自己 `ended`。
 *
 * 为什么要有它：这条链路以前只有人工跑过（`scripts/_sa-resume-e2e.mjs` 下划线前缀不进测试电池，
 * 设计文档 §15 第 5 步只留了一段记录）。包级测试（`src/packages/superagent/tests/*.test.mjs`）
 * 只验包自己的契约，不起宿主、不建 worktree、不跑 git。于是「发一单真的改出东西」没有回归：
 * 执行器到工单之间任何一处接错，都要等人手工发现。本探针把这一段钉住。
 *
 * 为什么用假模型端点而不是真模型：CI 没有密钥，真模型还会让结果随模型措辞漂移。假端点只按
 * 「历史里有几条 assistant tool_calls」回固定动作序列（read → write → bash git commit → 收尾正文），
 * 走的仍是宿主的真工具、真 worktree、真 git、真编排库——假只假在模型那一端。
 *
 * 判据（逐条打印 PASS / FAIL，退出码 0 / 1）：
 *   1. 临时 HOME / USERPROFILE / DSC_HOME + 临时 git 仓库，真实 `~/.dsc` 一个字节不碰；
 *   2. superagent 插件启用、repoPath 指到临时仓库，宿主的 stdio 协议能应答；
 *   3. `/sa new` 建出工单，worker 真开工（宿主日志出现「开工」），工作树只有一棵；
 *   4. 假端点按顺序收到 read / write / bash 三次工具调用（证明是「模型动作」驱动，不是巧合）；
 *   5. 工单以 `completed` 收尾、最新分配 `ended`；
 *   6. 工作树里的 README 有探针写的标记，`git log` 读得到那条提交，提交改的是 README.md，
 *      提交之后工作树是干净的；
 *   7. 执行会话文件里有工单文本与 `git commit` 调用（worker 真看见了、真调了）；
 *   8. 临时目录被清掉。
 *
 * 为什么落在这里而不是 `scripts/package-tests.mjs`：那套跑的是包自己的 `tests/*.test.mjs`，
 * 只验纯逻辑；本条要起宿主、建 worktree、跑 git，属于仓库级探针（`scripts/*-test.mjs`）。
 *
 * 与 `_sa-resume-e2e.mjs` 的分工：那条验「进程被杀之后接续」，要真模型 + 真硬杀；本条验
 * 「一单从头到尾能交付」，用假模型就能定性。硬杀窗口那种用例刻意不进来——太慢、太重。
 *
 * 前置：先 `pnpm run build`（宿主跑的是 `lib/`，与其它基于 lib 的探针同一条前提）。
 * 用法：`node scripts/superagent-e2e-test.mjs`；被 `scripts/check-core.mjs` 按
 * `<话题>-test.mjs` 自动发现（发现规则见 `scripts/_check-runner.mjs:95-100`）。
 *
 * @module dsc/scripts/superagent-e2e-test
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── 判据与公共小工具（输出风格照 `_sa-resume-e2e.mjs` / 其余 `*-test.mjs`）──────────
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

/** 等一个条件成立；返回是否等到。异步谓词每拍重新求值（读库/读文件都要现读）。 */
async function until(predicate, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(stepMs)
  }
}

/** 让系统挑一个空闲端口（先 listen 0 再关掉，紧接着给假端点/宿主用）。 */
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

// ── 隔离环境 ────────────────────────────────────────────────────────────────
//
// 真实家目录要在改环境变量**之前**取：`homedir()` 读 USERPROFILE，先改再取就取成临时目录，
// 「不是 ~/.dsc」这条自检会永远为真、等于没验。
const realHome = homedir()
/** 排障用：`DSC_SA_E2E_KEEP=1` 时保留临时目录（默认一律清掉，见收摊段）。 */
const KEEP = process.env['DSC_SA_E2E_KEEP'] === '1'
const home = mkdtempSync(join(tmpdir(), 'dsc-superagent-e2e-'))
const dsc = join(home, '.dsc')
const repo = join(home, 'repo')
mkdirSync(dsc, { recursive: true })
mkdirSync(repo, { recursive: true })
// 隔离三件套照 `_sa-resume-e2e.mjs:52-54`：宿主与它起的子进程都只看得见这个家。
process.env['HOME'] = home
process.env['USERPROFILE'] = home
process.env['DSC_HOME'] = dsc
console.log('[superagent-e2e] 隔离 HOME：' + home)

check(
  '临时 DSC_HOME 在系统临时目录里，不是真实的 ~/.dsc',
  resolve(dsc).startsWith(resolve(tmpdir())) && resolve(dsc) !== resolve(join(realHome, '.dsc')),
  dsc,
)

/** 跑一条 git 命令，返回 { code, out }（stdout 与 stderr 合并，出错时好贴）。 */
function git(args, cwd = repo) {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: done.status, out: String(done.stdout ?? '') + String(done.stderr ?? '') }
}

/** 把进程连同它的子进程一起硬杀（Windows 上 taskkill /T，POSIX 上 SIGKILL）。 */
function killHard(proc) {
  if (proc?.pid === undefined || proc.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' })
    return
  }
  try { proc.kill('SIGKILL') } catch { /* 已经退了 */ }
}

/** 读一棵目录下所有 `.jsonl` 的正文（会话文件的落点随实现变，按内容找不按文件名找）。 */
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

// ── 第 1 步：临时 git 仓库当真靶子 ──────────────────────────────────────────
git(['init', '-b', 'main'])
git(['config', 'user.email', 'sa-e2e@example.invalid'])
git(['config', 'user.name', 'superagent-e2e'])
writeFileSync(join(repo, 'README.md'), '# demo\n', 'utf8')
git(['add', '-A'])
git(['commit', '-m', 'init'])
const initLog = git(['log', '--oneline'])
check('临时仓库建好了（一个 init 提交）', initLog.code === 0, initLog.out.trim())

// ── 第 2 步：假模型端点 ─────────────────────────────────────────────────────
//
// 动作序列与 `_fake-llm.mjs` 同一种 SSE 形状，但这里要**三步**：读 README（write 工具要求
// 先读过才许整写覆盖）→ 整写 README → bash 里 git commit。按「历史里已有几条 assistant
// tool_calls」分派，而不是按请求计数：请求重试、压缩探测都不会让序列错位。
const MARK = 'SA-E2E-OK'
const COMMIT_SUBJECT = 'test: superagent e2e README SA-E2E-OK'
const README_NEXT = '# demo\n\n' + MARK + '：Super Agent worker 改的这一行。\n'

/** 一帧 OpenAI SSE chunk。 */
function frame(delta, finish = null) {
  return {
    id: 'chatcmpl-sa-e2e',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

/**
 * 起假模型端点。
 *
 * 只驱动 worker：别的请求（宿主里可能有的摘要类请求）一律回一段普通正文，不掺进动作序列。
 * 判定「这是 worker 的请求」看系统提示里的固定句，而不是工单标题——标题可能被宿主改写。
 */
async function startFakeLlm() {
  const port = await freePort()
  /** 按顺序记下真正发出去的工具名，最后据此断言动作序列。 */
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
      const workerRequest = messages.some(
        (message) => message.role === 'system' && String(message.content ?? '').includes('超级智能体的执行者'),
      )
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n')
      const finish = () => { res.write('data: [DONE]\n\n'); res.end() }

      if (!workerRequest) {
        send(frame({ role: 'assistant', content: '' }))
        send(frame({ content: '（探针不驱动这类请求）' }))
        send(frame({}, 'stop'))
        finish()
        return
      }

      const calls = messages.filter(
        (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
      ).length
      if (calls < 3) {
        const step = [
          { name: 'read', arguments: { path: 'README.md' } },
          { name: 'write', arguments: { path: 'README.md', content: README_NEXT } },
          // 用 `;` 而不是 `&&`：宿主的 bash 工具在 Windows 上落到 Windows PowerShell 5.1，
          // 它不认 `&&`（实测报「标记"&&"不是此版本中的有效语句分隔符」，退出码 1）；
          // `;` 在 PowerShell 与 POSIX shell 里都能用，探针不必按平台写两条命令。
          { name: 'bash', arguments: { command: 'git add -A; git commit -m "' + COMMIT_SUBJECT + '"' } },
        ][calls]
        servedTools.push(step.name)
        send(frame({ role: 'assistant', content: '' }))
        send(frame({
          tool_calls: [{
            index: 0,
            id: 'call_sa_e2e_' + String(calls + 1),
            type: 'function',
            function: { name: step.name, arguments: JSON.stringify(step.arguments) },
          }],
        }))
        send(frame({}, 'tool_calls'))
        finish()
        return
      }
      send(frame({ role: 'assistant', content: '' }))
      send(frame({ content: '改好了：README.md 加了 ' + MARK + ' 一行，已在 agent 分支上提交。' }))
      send(frame({}, 'stop'))
      finish()
    })
  })
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok))
  return {
    port,
    servedTools,
    requests: () => requests,
    close: () => new Promise((ok) => server.close(() => ok())),
  }
}

/** 写宿主配置：指向假模型端点（形状与 `_sa-resume-e2e.mjs:72-79` 一致）。 */
function writeConfig(llmPort) {
  writeFileSync(join(dsc, 'config.yaml'), [
    'default:', '  provider: fake', '  model: fake-chat', 'providers:', '  fake:',
    '    displayName: 全链路自检假端点', '    baseURL: http://127.0.0.1:' + String(llmPort) + '/v1',
    '    apiKeyEnv: DSC_FAKE_KEY', '    models:', '      - id: fake-chat', '        name: Fake Chat',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'), 'utf8')
}

// ── 第 3 步：启用插件并写 repoPath ─────────────────────────────────────────
//
// 直接写 `plugins.json`，不走 `lib/core/plugin-registry.js` 的 `writePluginEnabled`：
// 本探针不需要 import 任何 lib 模块（那会让「测试进程自己也可能碰 ~/.dsc」多一条路径），
// 而 `plugins.json` 的条目树是文档化的落盘形状（`src/core/plugin-registry.ts:5`）。
// superagent 默认关（`cordis.patch.yml:7`），不显式启用它根本不会挂载。
writeFileSync(join(dsc, 'plugins.json'), JSON.stringify({
  version: 1,
  entries: [{ file: 'superagent', disabled: false, config: { repoPath: repo } }],
}, null, 2) + '\n', 'utf8')
const plugins = JSON.parse(readFileSync(join(dsc, 'plugins.json'), 'utf8'))
const entry = plugins.entries.find((item) => item.file === 'superagent')
check(
  'superagent 插件已启用，repoPath 指到临时仓库',
  entry?.disabled === false && entry?.config?.repoPath === repo,
  JSON.stringify(entry),
)

// ── 第 4 步：宿主（stdio 协议）──────────────────────────────────────────────
//
// 协议照 `_sa-resume-e2e.mjs:107-163`：发 `{type:'invoke', id, method, args}`，收
// `{type:'result', id, ok, value|error}`；插件 `apply` 之前发过去的消息会被静默丢掉，
// 所以只能用 `listModels` 反复探活，直到有回音。
async function startHost() {
  const proc = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, DSC_HOME: dsc, DSC_FAKE_KEY: 'sk-superagent-e2e' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr = []
  /** @type {Map<number, {ok: (value: unknown) => void, no: (error: Error) => void}>} */
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

/** 直接读编排库里的最新一张工单。库还没建/表还没建都按「还没有」处理。 */
let sqlite = null
async function readTicket() {
  const dbPath = join(dsc, 'superagent', 'orchestrator.sqlite')
  if (!existsSync(dbPath)) return null
  try {
    sqlite ??= await import('node:sqlite')
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare('SELECT value FROM ticket ORDER BY rowid DESC LIMIT 1').get()
      return row === undefined ? null : JSON.parse(row.value)
    } finally {
      db.close()
    }
  } catch {
    // 宿主正在建库/建表的那一拍读不到，不算失败：下一拍再读。
    return null
  }
}

const TITLE = 'SA-E2E 全链路'
const BODY = '在 README.md 末尾追加一行 ' + MARK + ' 并提交'

let llm = null
let host = null
let worktree = null
try {
  check('宿主构建产物在（lib/headless.js，前置 pnpm run build）', existsSync(join(root, 'lib', 'headless.js')))
  if (!existsSync(join(root, 'lib', 'headless.js'))) throw new Error('没有 lib/headless.js，先构建')

  llm = await startFakeLlm()
  check('假模型端点已起（127.0.0.1:' + String(llm.port) + '）', llm.port > 0)
  writeConfig(llm.port)

  host = await startHost()
  check('宿主启动并用 stdio 协议应答（listModels）', host.alive, tail(host.stderr))
  if (!host.alive) throw new Error('宿主没应答')

  // `/sa new` 的输出走 `ui.notice`（`commands.ts:243-245`），stdio 的 invoke 不直接带回它；
  // 所以「建成没有」以编排库里的 ticket 行为准，而不是拿命令返回值猜。
  await host.invoke('runCommand', ['/sa new ' + TITLE + ' | ' + BODY])
  const created = await until(async () => (await readTicket()) !== null, 30_000)
  const ticketAtStart = await readTicket()
  check('工单已建成（编排库里有 ticket 行）', created && ticketAtStart !== null, created ? String(ticketAtStart?.title ?? 'null') : '30s 内没读到')
  check('工单标题是探针发的那张', ticketAtStart?.title === TITLE, String(ticketAtStart?.title ?? 'null'))
  if (!created) throw new Error('工单没建成，后面的断言没有对象')

  // 「开工」是执行器把工单文本投给 worker、并把分配标成 running 之后打的那行日志
  // （`executor.ts` 的 `已在 … 开工`）。等到它，才说明链路真的走到执行器而不是只建了库行。
  const started = await until(() => host.stderr.some((line) => line.includes('开工')), 60_000)
  check('worker 真的开工了（宿主日志出现「开工」）', started, tail(host.stderr))
  if (!started) throw new Error('worker 没有开工')

  const worktreesDir = join(dsc, 'superagent', 'worktrees')
  const worktreeDirs = existsSync(worktreesDir)
    ? readdirSync(worktreesDir, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)
    : []
  check('开工后工作树只有一棵', worktreeDirs.length === 1, worktreeDirs.join('、'))
  worktree = worktreeDirs.length === 1 ? join(worktreesDir, worktreeDirs[0]) : null

  const finished = await until(async () => (await readTicket())?.ended !== undefined, 100_000, 500)
  check('工单自己跑完了（ended 有值）', finished, finished ? '' : tail(host.stderr, 12))
  const ticket = await readTicket()
  check('工单以完成收尾（outcome=completed）', ticket?.ended?.outcome === 'completed', JSON.stringify(ticket?.ended ?? null))
  const assignment = (ticket?.assignments ?? []).at(-1)
  check('最新分配已结束（state=ended）', assignment?.state === 'ended', String(assignment?.state ?? 'undefined'))

  // 动作序列：假端点按 read → write → bash 三次回的工具调用。这条断言把「提交是 worker
  // 真调出来的」与「碰巧工作树里本来就有提交」分开——后者不可能出现，但动作序列能钉死归因。
  check(
    '假端点按 read → write → bash 的顺序驱动了 worker',
    llm.servedTools.join(',') === 'read,write,bash',
    llm.servedTools.join(',') || '一次工具调用都没发生',
  )

  // ── 仓库里的事实 ──────────────────────────────────────────────────────────
  check('拿到了工作树目录', worktree !== null, String(worktree))
  if (worktree !== null) {
    const readme = existsSync(join(worktree, 'README.md')) ? readFileSync(join(worktree, 'README.md'), 'utf8') : ''
    check('工作树里的 README 被 worker 改过（含 ' + MARK + '）', readme.includes(MARK), JSON.stringify(readme.slice(0, 120)))

    const lastSubject = git(['log', '-1', '--format=%s'], worktree)
    check('git log 能读到那条提交', lastSubject.code === 0 && lastSubject.out.trim() === COMMIT_SUBJECT, lastSubject.out.trim())

    const changed = git(['show', '--name-only', '--format=', 'HEAD'], worktree)
    check('那条提交改的是 README.md', changed.out.split(String.fromCharCode(10)).map((line) => line.trim()).includes('README.md'), changed.out.trim())

    const ahead = git(['rev-list', '--count', 'main..HEAD'], worktree)
    check('提交在 agent 分支上（领先 main 至少一个提交）', ahead.code === 0 && Number(ahead.out.trim()) >= 1, ahead.out.trim() || '读不到')

    const status = git(['status', '--porcelain'], worktree)
    check('提交之后工作树是干净的（改动全落进提交）', status.code === 0 && status.out.trim() === '', status.out.trim() || '干净')
  } else {
    check('工作树里的 README 被 worker 改过（含 ' + MARK + '）', false, '没有工作树目录')
    check('git log 能读到那条提交', false, '没有工作树目录')
    check('那条提交改的是 README.md', false, '没有工作树目录')
    check('提交在 agent 分支上（领先 main 至少一个提交）', false, '没有工作树目录')
    check('提交之后工作树是干净的（改动全落进提交）', false, '没有工作树目录')
  }

  // ── 执行会话里的事实：worker 真看见了工单、真调了 git ────────────────────
  if (ticket?.id !== undefined) {
    const sessionText = readSessionText(join(dsc, 'superagent', 'sessions', ticket.id))
    check('执行会话文件里有工单文本（worker 真看见了）', sessionText.includes(TITLE), sessionText === '' ? '会话目录为空' : '会话里没这张工单')
    check('执行会话里有 git commit 调用（提交真是 worker 调出来的）', sessionText.includes('git commit'), sessionText === '' ? '会话目录为空' : '会话里没有 git commit')
  } else {
    check('执行会话文件里有工单文本（worker 真看见了）', false, '没读到工单 id')
    check('执行会话里有 git commit 调用（提交真是 worker 调出来的）', false, '没读到工单 id')
  }

  check('假模型端点至少收到 4 次请求（3 次工具调用 + 1 次收尾）', llm.requests() >= 4, String(llm.requests()))
} catch (error) {
  // 中途抛错时也要留一条可读的 FAIL，而不是只让 runner 看到退出码 1。
  check('链路没有中途抛错', false, error instanceof Error ? error.message : String(error))
} finally {
  // 收摊：先杀宿主（连同子进程），再关假端点，最后删临时目录。真实 ~/.dsc 从未进入这条路径。
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
  console.log('[superagent-e2e] ' + String(passed) + '/' + String(total) + ' 通过')
  process.exit(0)
}
console.log('[superagent-e2e] ' + String(passed) + '/' + String(total) + ' 通过，' + String(failures.length) + ' 条失败：' + failures.join('；'))
process.exit(1)
