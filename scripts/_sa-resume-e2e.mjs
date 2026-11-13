/**
 * Super Agent 崩溃接续真机用例（开发辅助，**不进测试电池**）：跑到一半把宿主硬杀，
 * 再起一个宿主，验「工单自己接着干、工作树与分支不重来」。
 *
 * 为什么不用假执行器：这条用例要证明的正是「真执行器 + 真工作树 + 真宿主进程」三件事在
 * 进程被杀之后还能接上。假执行器只能证到「恢复调了哪个方法」，证明不了「分支没重建」。
 *
 * 判据（对应设计文档 §1.3 的 P1 出口条件）：
 *   1. 重启后日志出现「启动恢复：1 张接续」；
 *   2. 工单多了一份分配，旧那份 `ended`（原因 `hostRestarted`），新那份接着跑；
 *   3. 新分配收到的第一条输入是「上次中断了，先看工作树和 git 状态」那条提示词；
 *   4. `git worktree list` 仍是 2 行（主工作区 + 一棵），`agent/*` 分支仍只有一条；
 *   5. 工单最后自己跑完（`ended`）。
 *
 * 隔离口径与 `_ui-shell-serve.mjs` 一致：临时 HOME / USERPROFILE / DSC_HOME 三件套，
 * 临时 git 仓库当真靶子，真实 `~/.dsc` 一个字节都不动。
 *
 * 通道走宿主 stdio 协议（每行一条 JSON，`bin/headless.cjs` 的默认传输）：**不走**页面那条
 * `/api/invoke`，那条按壳的口径排除了 `runCommand`。模型用 `scripts/_fake-llm.mjs`，
 * 第一段故意慢吐（留出杀进程的窗口），第二段秒回。
 *
 * 用法：`node scripts/_sa-resume-e2e.mjs`；失败退出码 1。
 *
 * @module dsc/scripts/sa-resume-e2e
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { console.log('  PASS ' + name); return }
  failures.push(name)
  console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail))
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const freePort = () => new Promise((ok) => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => ok(port)) })
})

// ── 隔离环境 ────────────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'sa-resume-'))
const dsc = join(home, '.dsc')
const repo = join(home, 'repo')
mkdirSync(dsc, { recursive: true })
mkdirSync(repo, { recursive: true })
process.env['HOME'] = home
process.env['USERPROFILE'] = home
process.env['DSC_HOME'] = dsc
console.log('[sa-resume] 隔离 HOME：' + home)

/** 跑一条 git 命令，返回 { code, out }。 */
function git(args, cwd = repo) {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: done.status, out: String(done.stdout ?? '') + String(done.stderr ?? '') }
}

git(['init', '-b', 'main'])
git(['config', 'user.email', 'e2e@example.invalid'])
git(['config', 'user.name', 'sa-resume-e2e'])
writeFileSync(join(repo, 'README.md'), '# demo\n', 'utf8')
git(['add', '-A'])
git(['commit', '-m', 'init'])
check('临时仓库建好了（一个 init 提交）', git(['log', '--oneline']).code === 0)

/** 写宿主配置：指向假模型端点。 */
function writeConfig(llmPort) {
  writeFileSync(join(dsc, 'config.yaml'), [
    'default:', '  provider: fake', '  model: fake-chat', 'providers:', '  fake:',
    '    displayName: 接续自检假端点', '    baseURL: http://127.0.0.1:' + String(llmPort) + '/v1',
    '    apiKeyEnv: DSC_FAKE_KEY', '    models:', '      - id: fake-chat', '        name: Fake Chat',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'), 'utf8')
}

/** 起一个假模型端点。 */
async function startLlm(delayMs) {
  const port = await freePort()
  const proc = spawn(process.execPath, [join(root, 'scripts', '_fake-llm.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      DSC_FAKE_LLM_PORT: String(port),
      DSC_FAKE_LLM_DELAY: String(delayMs),
      DSC_FAKE_LLM_TOOL: JSON.stringify({ name: 'read', arguments: { path: 'README.md' } }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await sleep(700)
  return { proc, port }
}

/**
 * 起一个宿主，用 stdio 协议跟它说话。
 *
 * 协议格式（`packages/host-stdio`）：发 `{type:'invoke', id, method, args}`，
 * 收 `{type:'result', id, ok, value|error}`；stdin 一关就当宿主那头没人了。
 *
 * 为什么先拿 `listModels` 探活：`getSnapshot` 是本地方法，协议不认；插件 `apply` 之前
 * 收到的消息会被静默丢掉，所以只能重发直到有回音。
 */
async function startHost() {
  const proc = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home, DSC_HOME: dsc, DSC_FAKE_KEY: 'sk-sa-resume-fake' },
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
  const send = (method, args) => new Promise((ok, no) => {
    seq += 1
    const id = seq
    pending.set(id, { ok, no })
    proc.stdin.write(JSON.stringify({ type: 'invoke', id, method, args }) + String.fromCharCode(10))
  })
  // 探活：插件装配完之前发过去的消息会被丢，重发到有回音为止。
  let alive = false
  for (let waited = 0; waited < 240 && !alive && proc.exitCode === null; waited += 1) {
    try {
      await Promise.race([send('listModels', []), sleep(700).then(() => Promise.reject(new Error('timeout')))])
      alive = true
    } catch {
      await sleep(300)
    }
  }
  if (!alive) throw new Error('宿主没应答：' + stderr.slice(-8).join(' | '))
  return { proc, stderr, invoke: send }
}

/**
 * 硬杀：模拟断电而不是优雅退出。
 *
 * Windows 上要 `taskkill /F /T` 连子进程一起收；POSIX 上直接 SIGKILL 进程组
 * （`detached` 没开，所以只杀自己这一个进程也够用）。
 */
function killHard(proc) {
  if (proc?.pid === undefined || proc.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' })
    return
  }
  try { proc.kill('SIGKILL') } catch { /* 已经退了 */ }
}

/** 等某个条件成立；返回是否等到。 */
async function until(predicate, timeoutMs, stepMs = 250) {
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return false
}

/** 直接读编排库（SQLite 允许多连接；插件那把是单实例锁，不占库）。 */
async function readTicket() {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dsc, 'superagent', 'orchestrator.sqlite'))
  try {
    const row = db.prepare('SELECT value FROM ticket').get()
    return row === undefined ? null : JSON.parse(row.value)
  } finally {
    db.close()
  }
}

// ── 第 1 段：跑到一半硬杀 ──────────────────────────────────────────────────
const registry = await import(pathToFileURL(join(root, 'lib', 'core', 'plugin-registry.js')).href)
registry.writePluginEnabled('superagent', true)
check('superagent 插件已启用（plugins.json）', registry.isPluginEnabled('superagent') === true)

let llm = await startLlm(45_000)
writeConfig(llm.port)
const host1 = await startHost()
console.log('[sa-resume] 宿主 A 起来了，PID ' + String(host1.proc.pid))

await host1.invoke('setSettingValue', ['superagent', 'repoPath', repo])
await host1.invoke('runCommand', ['/sa new RESUME-E2E | 在 README.md 末尾追加一行 RESUME-E2E'])
check('工单已发布（/sa new 返回 ok）', true)

const started = await until(() => host1.stderr.some((line) => line.includes('开工')), 90_000)
check('worker 真的开工了（日志出现「开工」）', started, host1.stderr.slice(-6).join(' | '))
const worktreesBefore = git(['worktree', 'list']).out.split(String.fromCharCode(10)).filter((line) => line.trim() !== '').length
check('开工后工作树 2 行（主工作区 + 一棵）', worktreesBefore === 2, String(worktreesBefore))

// 让 worker 停在模型的慢回复里，再硬杀。
await sleep(4_000)
const pid1 = host1.proc.pid
killHard(host1.proc)
const died = await until(() => host1.proc.exitCode !== null, 15_000)
check('宿主 A 被硬杀（进程已退出）', died, 'PID ' + String(pid1))
const crashed = await readTicket()
check('被杀的现场：最新分配还停在 running', crashed?.assignments?.at(-1)?.state === 'running', String(crashed?.assignments?.at(-1)?.state))

// ── 第 2 段：重启，看它自己接上 ────────────────────────────────────────────
killHard(llm.proc)
llm = await startLlm(0)
writeConfig(llm.port)
const host2 = await startHost()
console.log('[sa-resume] 宿主 B 起来了，PID ' + String(host2.proc.pid))

// 敲一次 /sa list 就会惰性建库并跑恢复（§9.1）。
await host2.invoke('runCommand', ['/sa list'])
const resumedLine = await until(
  () => host2.stderr.some((line) => line.includes('启动恢复') && line.includes('接续')),
  60_000,
)
check('重启后日志出现「启动恢复：N 张接续」', resumedLine, host2.stderr.slice(-10).join(' | '))

const finished = await until(async () => (await readTicket())?.ended !== undefined, 150_000, 500)
check('工单自己跑完了（ended 有值）', finished)

// ── 库里的事实 ──────────────────────────────────────────────────────────────
const ticket = await readTicket()
check('库里有一张工单', ticket !== null)
if (ticket !== null) {
  const assignments = ticket.assignments ?? []
  check('工单有两份分配（旧的 + 接续的）', assignments.length === 2, String(assignments.length))
  const oldOne = assignments[0]
  const next = assignments[1]
  check('旧分配已结束', oldOne?.state === 'ended', String(oldOne?.state))
  check('旧分配的结束原因是宿主重启', oldOne?.endedReason === 'hostRestarted', String(oldOne?.endedReason ?? 'undefined'))
  check('新分配是另一份（不是复用旧 id）', next !== undefined && next.id !== oldOne?.id)
  const note = (ticket.inputs ?? []).find((input) => String(input.text ?? '').includes('The host restarted during this ticket'))
  check('新分配收到「上次中断了」的提示词', note !== undefined)
  check('提示词已投给新分配（不在待投递里）', note !== undefined && !(ticket.undelivered ?? []).includes(note.id), JSON.stringify(ticket.undelivered ?? null))
  // 会话记录里能读到这句话，才说明 worker 真的看见了，而不只是库里记了一笔。
  const sessionDir = join(dsc, 'superagent', 'sessions', ticket.id)
  const sessionText = existsSync(sessionDir)
    ? readdirSync(sessionDir).map((file) => {
      try { return readFileSync(join(sessionDir, file), 'utf8') } catch { return '' }
    }).join(String.fromCharCode(10))
    : ''
  check('恢复提示词出现在执行会话里（worker 真看到了）', sessionText.includes('The host restarted during this ticket'), sessionText === '' ? '会话目录为空' : '会话里没这句话')
  check('工单以完成收尾', ticket.ended?.outcome === 'completed', JSON.stringify(ticket.ended ?? null))
}

// ── 仓库里的事实：不重复建树、不换分支 ──────────────────────────────────────
const worktreesAfter = git(['worktree', 'list']).out.split(String.fromCharCode(10)).filter((line) => line.trim() !== '')
check('工作树仍是 2 行（没有建第二棵）', worktreesAfter.length === 2, worktreesAfter.join(' | '))
const branches = git(['branch', '--format=%(refname:short)']).out.split(String.fromCharCode(10))
  .map((line) => line.trim()).filter((line) => line.startsWith('agent/'))
check('agent/* 分支仍只有一条（接续用同一分支）', branches.length === 1, branches.join(' | '))
const treeDirs = existsSync(join(dsc, 'superagent', 'worktrees'))
  ? readdirSync(join(dsc, 'superagent', 'worktrees')).length
  : 0
check('工作树目录仍只有一个', treeDirs === 1, String(treeDirs))

killHard(host2.proc)
killHard(llm.proc)

console.log('')
if (failures.length === 0) {
  console.log('[sa-resume] 全过')
  process.exit(0)
}
console.log('[sa-resume] 失败 ' + String(failures.length) + ' 项：' + failures.join('；'))
process.exit(1)
