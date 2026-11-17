/**
 * Super Agent 全链路门禁（backlog O3）：`/sa new` 发一单 → 主会话模型回合接单 → worker 在
 * 独占工单目录里改 README → 真 `git commit` → worker 交 `ready` → 工单自己 `ended`。
 *
 * 为什么要有它：这条链路以前只有人工跑过（`scripts/_sa-resume-e2e.mjs` 下划线前缀不进测试电池，
 * 设计文档 §15 第 5 步只留了一段记录）。包级测试（`src/packages/superagent/tests/*.test.mjs`）
 * 只验包自己的契约，不起宿主、不建工单目录、不跑 git。于是「发一单真的改出东西」没有回归：
 * 执行器到工单之间任何一处接错，都要等人手工发现。本探针把这一段钉住。
 *
 * ## 移植后（feat/pluginization）的架构事实，以及本探针为此改了什么
 *
 * 1. **配置不再来自 `plugins.json` 的 `config.repoPath`**。新树把仓库、CLI、执行器都搬进了
 *    编排库的设置块（`core/policy.ts` 的 `SettingsSchema`）。所以探针在起宿主之前用构建产物
 *    `lib/packages/superagent/app/store.js` 的 `new Store(path)` + `saveSettings({...})` 播种，
 *    再 `close()`；`plugins.json` 只留「启用 superagent」这一件事。`stateDir` 由入口按
 *    `paths.ts` 的 `superagentRoot()` 取 `<DSC_HOME>/superagent`，与探针播种的库文件同一个坐标。
 * 2. **部署检查要求仓库和 CLI 真能跑**（`deployment.ts` 的 `resolveDeployment`）：依次执行
 *    `[cli, 'api', 'user']` 与 `[cli, 'api', 'repos/<owner>/name', '--jq', ...]`，用 node 原生
 *    `spawn` 直跑、cwd=`<DSC_HOME>/superagent`、不经过 shell。Windows 上 `spawn` 不能直跑
 *    `.cmd`，所以不能拿 `gh.cmd` 冒充 cli。这里的技巧是**把 cli 设成 node.exe 自己**，再在
 *    stateDir 放一个**无扩展名**的 node 脚本 `api`：`node api user` 让脚本收到 `argv[2]='user'`，
 *    `node api repos/... --jq ...` 收到 `argv[2]='repos/...'`，两份 JSON 都由脚本按参数打出来。
 *    这同时让 GitHub 来源的轮询调用（`gh api` 形状，被加上 `repos/<repo>/` 前缀）落到同一个
 *    假脚本上，探针不必联网。
 * 3. **判定由主会话的模型回合完成**：`/sa new` 走 `app/api.ts` 的 `publish` → 手动触发器（显式
 *    强度）→ 候选卡投给主会话 → 主会话调 `orchestrator_route`（`app/tools/main.ts`）接单。
 *    所以假端点要按**请求里的工具名单**分派：带 `orchestrator_route` 的是主会话回合（回
 *    接单工具调用），带 `orchestrator_report` 的是 worker 回合（回 read/write/bash/report）。
 * 4. **工单目录是普通目录，不是宿主自建 worktree**：`<DSC_HOME>/superagent/work/<短名>-<id12>`，
 *    由 `executor.prepare` 命令在父目录里跑出来（Windows 走 `cmd.exe /d /s /c`，环境变量含
 *    `DSH_SUPERAGENT_DIR` / `DSH_SUPERAGENT_NAME`），worker 的 cwd 就是它。
 * 5. **没有「开工」这行日志**：旧断言读宿主 stderr，新树不打这行。改成「假端点收到了 worker
 *    回合」+「库里分配有 startedAt」两件可验的事实。
 *
 * 为什么用假模型端点而不是真模型：CI 没有密钥，真模型还会让结果随模型措辞漂移。假端点只按
 * 工具名单与「历史里有几条 assistant tool_calls」回固定动作序列（主会话接单；worker
 * read → write → bash git commit → report ready），走的仍是宿主的真工具、真工单目录、真 git、
 * 真编排库——假只假在模型那一端。
 *
 * 判据（逐条打印 PASS / FAIL，退出码 0 / 1）：
 *   1. 临时 HOME / USERPROFILE / DSC_HOME + 临时 git 仓库，真实 `~/.dsc` 一个字节不碰；
 *   2. 编排库里的设置播种成功（仓库 + 假 CLI + prepare 命令）、superagent 插件启用、宿主 stdio 应答；
 *   3. `/sa new` 建出工单（`ticket` 表有行、标题是探针发的那张）；
 *   4. worker 真开工（假端点收到 worker 回合、工单分配有 startedAt）；
 *   5. 工单以 `completed` 收尾、最新分配 `ended`；
 *   6. 假端点按 read → write → bash 的顺序驱动了 worker（证明提交是模型动作驱动，不是巧合）；
 *   7. 工单目录在 `<DSC_HOME>/superagent/work` 下、README 有探针写的标记、`git log` 读得到那条提交、
 *      提交改的是 README.md、分支 `agent/<短名>` 领先 main、提交后目录干净；
 *   8. 执行会话文件里有工单标题与 `git commit` 调用（worker 真看见了、真调了）；
 *   9. 临时目录被清掉。
 *
 * 为什么落在这里而不是 `scripts/package-tests.mjs`：那套跑的是包自己的 `tests/*.test.mjs`，
 * 只验纯逻辑；本条要起宿主、建工单目录、跑 git，属于仓库级探针（`scripts/*-test.mjs`）。
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
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
/** 新树的超级智能体数据根：库、锁、会话、工单目录都在这一个目录下（`paths.ts` 的 `superagentRoot()`）。 */
const stateDir = join(dsc, 'superagent')
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

// ── 第 2 步：假 gh（真的是一个假 gh：一个按参数打 JSON 的 node 脚本）──────────
//
// 部署检查用 node 原生 spawn 直跑 `[cli, 'api', ...]`，cwd 是 stateDir。所以：
//   cli = process.execPath（node.exe 的绝对路径，`executable()` 认它）
//   脚本 = <stateDir>/api（无扩展名；node 把相对脚本路径按 cwd 解析，argv[2] 就是第一个参数）
// 调用形状 → 脚本看到的 argv：
//   `[node, 'api', 'user']`                          → argv[2] = 'user'
//   `[node, 'api', 'repos/owner/name', '--jq', ...]` → argv[2] = 'repos/owner/name'
//   `[node, 'api', 'repos/owner/name/notifications?...', '--include']`（来源轮询）
// Windows 上不能把 `.cmd` 当 cli（spawn 直跑不能执行 .cmd），所以才用「node + 无扩展名脚本」
// 这一招；两个平台通用，也不依赖 PATH。
const FAKE_REPO = 'owner/name'
const FAKE_API = [
  '// 探针的假 gh：按第一个参数回 resolveDeployment 与来源轮询要的形状。',
  "const args = process.argv.slice(2)",
  "const path = args[0] ?? ''",
  'const out = (text) => process.stdout.write(text)',
  "if (path === 'user') out(JSON.stringify({ login: 'sa-bot', id: 1 }))",
  `else if (path === 'repos/${FAKE_REPO}') out(JSON.stringify({ name: '${FAKE_REPO}', push: true }))`,
  // 来源轮询要「HTTP 头 + 空数组」：给一段够用的头和一个空列表，探针不联网。
  "else if (args.includes('--include')) out('HTTP/1.1 200 OK\\nx-poll-interval: 3600\\n\\n[]\\n')",
  // `pages()` 用 `--paginate --slurp`，要的是「页数组的数组」。
  "else if (args.includes('--slurp')) out('[]')",
  "else out('[]')",
  '',
].join('\n')
mkdirSync(stateDir, { recursive: true })
writeFileSync(join(stateDir, 'api'), FAKE_API, 'utf8')
check('假 gh 脚本就位（<DSC_HOME>/superagent/api，无扩展名，node 直跑）', existsSync(join(stateDir, 'api')))

// ── 第 3 步：假模型端点 ─────────────────────────────────────────────────────
//
// 动作序列与 `_fake-llm.mjs` 同一种 SSE 形状。两条分派线都**按请求里的工具名单**认，而不是按
// 「第几次请求」：
//   带 `orchestrator_route`（`app/tools/main.ts`） → 主会话回合：把候选卡接单。
//   带 `orchestrator_report`（`app/tools/executor.ts`）→ worker 回合：read → write → bash → report。
// 其余请求（队友、摘要类）回一段普通正文，不掺进任何动作序列。
const MARK = 'SA-E2E-OK'
const COMMIT_SUBJECT = 'test: superagent e2e README SA-E2E-OK'
const README_NEXT = '# demo\n\n' + MARK + '：Super Agent worker 改的这一行。\n'
const TITLE = 'SA-E2E 全链路'
const BODY = TITLE + '：在 README.md 末尾追加一行 ' + MARK + ' 并提交'

/**
 * 让 worker 用 `bash` 工具跑的那条提交命令（两个平台各一份）。
 *
 * 为什么带重试：宿主自己也在这个目录里跑 `git status`（`packages/git`、`checkpoint` 会随
 * 会话 cwd 刷新状态），`git status` 刷新 index 时要拿 `.git/index.lock`；worker 的
 * `git commit` 撞上它就会以退出码 128 报 `Unable to create '.git/index.lock': File exists`。
 * 这是探针与宿主共用同一个工作目录带来的真实并发，不是被测代码的错，所以重试几次而不是
 * 让门禁偶发红（实测不加就会约每 3 次红 1 次）。提交身份同样要显式给：worker 的 git 用隔离
 * 的全局配置并设了 `useConfigOnly = true`（`infra/environment.ts:126`），不给身份就不许提交。
 *
 * @param subject - 提交标题
 * @param allowEmpty - 这张单不改文件时用 `--allow-empty` 留一条提交当锚点
 */
function commitCommand(subject, allowEmpty = false) {
  const empty = allowEmpty ? ' --allow-empty' : ''
  return process.platform === 'win32'
    // PowerShell 5.1：`;` 顺序执行；`$?` 看上一条是否成功；失败就等 400ms 再来，最多三次。
    ? 'git config user.name sa-e2e; git config user.email sa-e2e@example.invalid; for ($i = 0; $i -lt 3; $i++) { git add -A; git commit' + empty + ' -m "' + subject + '"; if ($?) { break }; Start-Sleep -Milliseconds 400 }'
    : 'git config user.name sa-e2e; git config user.email sa-e2e@example.invalid; for i in 1 2 3; do git add -A; git commit' + empty + ' -m "' + subject + '" && break; sleep 0.4; done'
}

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

async function startFakeLlm() {
  const port = await freePort()
  /** 按顺序记下 worker 真发出去的工具名，最后据此断言动作序列。 */
  const workerTools = []
  /** worker 回合的次数（旧探针看宿主日志「开工」，新树没有那行日志，改成看这里）。 */
  let workerTurns = 0
  /** 已经接单过的候选 trigger_id：同一条候选卡重投时不重复接单。 */
  const routed = new Set()
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
          tool_calls: [{ index: 0, id: 'call_sa_e2e_' + String(Date.now() % 100000), type: 'function',
            function: { name, arguments: JSON.stringify(args) } }],
        }))
        send(frame({}, 'tool_calls'))
        finish()
      }
      /** 用户消息里可解析的 JSON 文本（候选卡、工单投递都是 JSON 字符串）。 */
      const jsonMessages = messages.flatMap((message) => {
        if (message.role !== 'user' || typeof message.content !== 'string') return []
        if (!message.content.trimStart().startsWith('{')) return []
        try { return [JSON.parse(message.content)] } catch { return [] }
      })

      // ── 主会话回合：接单。候选卡的 next_action 会明说要 orchestrator_route。 ──
      if (tools.has('orchestrator_route')) {
        const candidate = jsonMessages.find((item) => item?.kind === 'candidate' && item?.trigger_id && !routed.has(item.trigger_id))
        if (candidate === undefined) {
          plainReply('（没有待接的候选，收工。）')
          return
        }
        routed.add(candidate.trigger_id)
        toolCall('orchestrator_route', {
          decisions: [{
            kind: 'accept',
            trigger_id: candidate.trigger_id,
            // 标题与短名都由主会话给：工单标题就是这里写的，探针据此断言「标题对」。
            title: TITLE,
            worktree_name: 'sa-e2e',
            acknowledgement: '开始处理：README 追加一行并提交。',
          }],
        })
        return
      }

      // ── worker 回合：read → write → bash git commit → report ready → 收尾正文。 ──
      if (tools.has('orchestrator_report')) {
        workerTurns += 1
        const calls = messages.filter(
          (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
        ).length
        if (calls < 3) {
          const step = [
            { name: 'read', arguments: { path: 'README.md' } },
            { name: 'write', arguments: { path: 'README.md', content: README_NEXT } },
            { name: 'bash', arguments: { command: commitCommand(COMMIT_SUBJECT) } },
          ][calls]
          workerTools.push(step.name)
          toolCall(step.name, step.arguments)
          return
        }
        if (calls === 3) toolCall('orchestrator_report', { state: 'ready', summary: 'README.md 已加 ' + MARK + ' 一行并提交' })
        else plainReply('改好了：README.md 加了 ' + MARK + ' 一行，已在 agent 分支上提交。')
        return
      }

      plainReply('（探针不驱动这类请求）')
    })
  })
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok))
  return {
    port,
    workerTools,
    workerTurns: () => workerTurns,
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

// ── 第 4 步：启用插件（`plugins.json` 只管开关）────────────────────────────
//
// superagent 默认关（`cordis.patch.yml:6`），不显式启用它根本不会挂载。新树的仓库 / CLI /
// 执行器设置不在这里，而在编排库的设置块里（下面第 5 步播种）；入口的 `machineOfPlugin` 只认
// `stateDir` 等四个可选键，缺省就取 `<DSC_HOME>/superagent`。
writeFileSync(join(dsc, 'plugins.json'), JSON.stringify({
  version: 1,
  entries: [{ file: 'superagent', disabled: false }],
}, null, 2) + '\n', 'utf8')
const plugins = JSON.parse(readFileSync(join(dsc, 'plugins.json'), 'utf8'))
const entry = plugins.entries.find((item) => item.file === 'superagent')
check('superagent 插件已启用', entry?.disabled === false, JSON.stringify(entry))

// ── 第 5 步：用构建产物把设置播种进编排库 ──────────────────────────────────
//
// `Store` 是从构建产物里取的（宿主跑 lib，探针也读同一份 schema，免得手写 JSON 与 zod 漂移）。
// 播种完必须 `close()`：宿主起来时要拿状态目录锁并开同一个库文件。
//
// prepare 命令在**工单目录还不存在**时、于它的父目录执行；Windows 走 `cmd.exe /d /s /c`，
// 其余平台走 `sh -c`。环境变量 `DSH_SUPERAGENT_DIR` 是本单目录的绝对路径，
// `DSH_SUPERAGENT_NAME` 是短名（也是 `agent/<短名>` 分支名的最后一段）。
//
// Windows 上**不能给参数加引号**，这条是实测出来的，不是风格问题：执行器用 node 的
// `spawn('cmd.exe', ['/d','/s','/c', command])`，node 会把带空格的整个 command 再包一层
// 引号，而 cmd.exe 的 `/s` 只剥掉最外那一对，内层引号被当普通字符留在参数里。于是
// `git clone "src" "dst"` 里的 `"dst"` 真的变成带引号的路径（实测 `git` 报
// `could not create leading directories of '"…"': Invalid argument`），带空格的目录还会
// 被拆成两个参数（`fatal: Too many arguments`）。所以这里改成**相对路径 + 不加引号**的
// 写法：prepare 的 cwd 是工单目录的父目录（`<stateDir>/work`），临时仓库与它只差三层。
// 目标目录名来自 `DSH_SUPERAGENT_NAME`（小写 kebab + 12 位 id），本身不含空格。
// POSIX 走 `sh -c`，没有这层转义问题，照常加引号。
const PREPARE_CWD = join(stateDir, 'work')
const preparable = process.platform === 'win32'
  ? relative(PREPARE_CWD, repo)
  : "'" + relative(PREPARE_CWD, repo).replaceAll("'", "'\\''") + "'"
const PREPARE = process.platform === 'win32'
  ? 'git clone ' + preparable + ' %DSH_SUPERAGENT_NAME% && git -C %DSH_SUPERAGENT_NAME% checkout -b agent/%DSH_SUPERAGENT_NAME%'
  : 'git clone ' + preparable + ' "$DSH_SUPERAGENT_NAME" && git -C "$DSH_SUPERAGENT_NAME" checkout -b "agent/$DSH_SUPERAGENT_NAME"'
const SETTINGS = {
  paused: false,
  // `sources.github.config` 的字段名以 `sources/github.ts` 的 `fields` 为准：repository / cli。
  sources: { github: { enabled: true, config: { repository: FAKE_REPO, cli: process.execPath } } },
  policy: { sources: {} },
  eval: { mode: 'observe' },
  executor: { maxWorkers: 1, directory: '', prepare: PREPARE, blockedCommands: [] },
}

async function seedSettings(settings) {
  const storeUrl = pathToFileURL(join(root, 'lib', 'packages', 'superagent', 'app', 'store.js')).href
  const { Store } = await import(storeUrl)
  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  try {
    store.saveSettings(settings)
    return store.settings()
  } finally {
    store.close()
  }
}

const seeded = await seedSettings(SETTINGS)
check(
  '设置已播种进编排库（仓库、假 CLI、prepare 命令）',
  seeded.sources.github?.config?.repository === FAKE_REPO && seeded.sources.github?.config?.cli === process.execPath
    && seeded.executor.prepare === PREPARE,
  JSON.stringify(seeded.sources.github ?? null),
)

// ── 第 6 步：宿主（stdio 协议）──────────────────────────────────────────────
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
  const dbPath = join(stateDir, 'orchestrator.sqlite')
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

let llm = null
let host = null
try {
  check('宿主构建产物在（lib/headless.js，前置 pnpm run build）', existsSync(join(root, 'lib', 'headless.js')))
  if (!existsSync(join(root, 'lib', 'headless.js'))) throw new Error('没有 lib/headless.js，先构建')

  llm = await startFakeLlm()
  check('假模型端点已起（127.0.0.1:' + String(llm.port) + '）', llm.port > 0)
  writeConfig(llm.port)

  host = await startHost()
  check('宿主启动并用 stdio 协议应答（listModels）', host.alive, tail(host.stderr))
  if (!host.alive) throw new Error('宿主没应答')

  // `/sa new` 的输出走 `ui.notice`（`host/command.ts:239`），stdio 的 invoke 不直接带回它；
  // 而且新树的发布是异步的（等主会话模型回合接单），所以「建成没有」以编排库里的 ticket 行为准。
  await host.invoke('runCommand', ['/sa new ' + TITLE + ' | ' + BODY])
  const created = await until(async () => (await readTicket()) !== null, 60_000)
  const ticketAtStart = await readTicket()
  check('工单已建成（编排库里有 ticket 行）', created && ticketAtStart !== null, created ? String(ticketAtStart?.title ?? 'null') : '60s 内没读到')
  check('工单标题是主会话接单时写的那张', ticketAtStart?.title === TITLE, String(ticketAtStart?.title ?? 'null'))
  if (!created) throw new Error('工单没建成，后面的断言没有对象')

  // 「开工」的新证据：假端点收到了 worker 回合。旧树有一行「已在 … 开工」的日志，新树不打，
  // 所以看模型这一侧——worker 会话真被建起来、真拿到了工单投递，才会有这次请求。
  const started = await until(() => llm.workerTurns() >= 1, 90_000)
  check('worker 真的开工了（假端点收到 worker 回合）', started, tail(host.stderr))
  const assignment = (await readTicket())?.assignments?.at(-1)
  check('工单的分配真的开始了（assignment 有 startedAt）', assignment?.startedAt !== undefined, JSON.stringify(assignment ?? null).slice(0, 200))
  if (!started) throw new Error('worker 没有开工')

  const finished = await until(async () => (await readTicket())?.ended !== undefined, 120_000, 500)
  check('工单自己跑完了（ended 有值）', finished, finished ? '' : tail(host.stderr, 12))
  const ticket = await readTicket()
  check('工单以完成收尾（outcome=completed）', ticket?.ended?.outcome === 'completed', JSON.stringify(ticket?.ended ?? null))
  const lastAssignment = (ticket?.assignments ?? []).at(-1)
  check('最新分配已结束（state=ended）', lastAssignment?.state === 'ended', String(lastAssignment?.state ?? 'undefined'))

  // 动作序列：假端点按 read → write → bash 三次回的工具调用。这条断言把「提交是 worker
  // 真调出来的」与「碰巧目录里本来就有提交」分开——后者不可能出现，但动作序列能钉死归因。
  check(
    '假端点按 read → write → bash 的顺序驱动了 worker',
    llm.workerTools.join(',') === 'read,write,bash',
    llm.workerTools.join(',') || '一次工具调用都没发生',
  )

  // ── 工单目录里的事实 ──────────────────────────────────────────────────────
  const directory = ticket?.execution?.directory ?? ''
  const name = ticket?.execution?.name ?? ''
  const expectedRoot = join(stateDir, 'work')
  check('工单目录在 <DSC_HOME>/superagent/work 下', directory !== '' && resolve(directory).startsWith(resolve(expectedRoot)), String(directory))
  check('工单目录真的存在（prepare 命令建出来的）', directory !== '' && existsSync(directory), String(directory))
  if (directory !== '' && existsSync(directory)) {
    const readme = existsSync(join(directory, 'README.md')) ? readFileSync(join(directory, 'README.md'), 'utf8') : ''
    check('工单目录里的 README 被 worker 改过（含 ' + MARK + '）', readme.includes(MARK), JSON.stringify(readme.slice(0, 120)))

    const lastSubject = git(['log', '-1', '--format=%s'], directory)
    check('git log 能读到那条提交', lastSubject.code === 0 && lastSubject.out.trim() === COMMIT_SUBJECT, lastSubject.out.trim())

    const changed = git(['show', '--name-only', '--format=', 'HEAD'], directory)
    check('那条提交改的是 README.md', changed.out.split(String.fromCharCode(10)).map((line) => line.trim()).includes('README.md'), changed.out.trim())

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], directory)
    check(
      'worker 在 prepare 建的 agent/<短名> 分支上',
      branch.code === 0 && branch.out.trim() === 'agent/' + name,
      branch.out.trim() + ' / 期望 agent/' + name,
    )

    const ahead = git(['rev-list', '--count', 'main..HEAD'], directory)
    check('提交在 agent 分支上（领先 main 至少一个提交）', ahead.code === 0 && Number(ahead.out.trim()) >= 1, ahead.out.trim() || '读不到')

    const status = git(['status', '--porcelain'], directory)
    check('提交之后工单目录是干净的（改动全落进提交）', status.code === 0 && status.out.trim() === '', status.out.trim() || '干净')
  } else {
    check('工单目录里的 README 被 worker 改过（含 ' + MARK + '）', false, '没有工单目录')
    check('git log 能读到那条提交', false, '没有工单目录')
    check('那条提交改的是 README.md', false, '没有工单目录')
    check('worker 在 prepare 建的 agent/<短名> 分支上', false, '没有工单目录')
    check('提交在 agent 分支上（领先 main 至少一个提交）', false, '没有工单目录')
    check('提交之后工单目录是干净的（改动全落进提交）', false, '没有工单目录')
  }

  // ── 执行会话里的事实：worker 真看见了工单、真调了 git ────────────────────
  // 会话目录由 `paths.ts` 的 `sessionsDir(ticketId)` 给：<stateDir>/sessions/<ticketId>。
  if (ticket?.id !== undefined) {
    const sessionText = readSessionText(join(stateDir, 'sessions', ticket.id))
    check('执行会话文件里有工单标题（worker 真看见了）', sessionText.includes(TITLE), sessionText === '' ? '会话目录为空' : '会话里没这张工单')
    check('执行会话里有 git commit 调用（提交真是 worker 调出来的）', sessionText.includes('git commit'), sessionText === '' ? '会话目录为空' : '会话里没有 git commit')
  } else {
    check('执行会话文件里有工单标题（worker 真看见了）', false, '没读到工单 id')
    check('执行会话里有 git commit 调用（提交真是 worker 调出来的）', false, '没读到工单 id')
  }

  check('假模型端点至少收到 5 次请求（1 次接单 + 3 次工具 + 1 次收尾）', llm.requests() >= 5, String(llm.requests()))
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
