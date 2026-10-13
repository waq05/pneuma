/**
 * 真机走查：开发态热更的整条链（改源码 → 构建 → 宿主换代 → SSE 帧 → 壳换装），
 * 全程在**真浏览器**里跑。
 *
 * 与 `scripts/ui-hmr-test.mjs` 的分工：那条探针钉宿主侧（轮询、内容摘要门槛、帧形状），
 * 不需要浏览器；这条补的是**壳侧真机行为**——真 Electron（真 Chromium）加载真宿主伺服的
 * 页面，改真插件源码、跑真构建，然后断言：
 *
 *   1. 换代：目标插件的 rev 变，**别的插件一条都不动**，且页内 rev 与宿主图当下那份一致；
 *   2. **没有刷新**：页内哨兵、`performance.timeOrigin`、账本 startedAt/firstFrameAt 全不变；
 *   3. **新代码真的执行了**：改动里带一枚随机标记，断言它出现在页面 DOM 上；
 *   4. **取数口径**：每轮只多一条单资源请求（`kind:'single'` + 目标 id + 成功），批请求一条不加；
 *   5. 第二轮同规格；还原轮之后 rev 回到初始值（构建对同一份源码字节稳定）；
 *   6. 全程页内没有同步失败、没有槽位故障。
 *
 * 为什么要有它：热更的验收欠账一直卡在「没有一条入库的真机脚本」——此前只在
 * `desktop/shots/` 下的临时脚本里走查过（那目录不入库），换台机器就没了。
 *
 * 用法：npx tsc -p tsconfig.json && node scripts/ui-hmr-machine.mjs
 * 依赖：`lib/ui/assets`（缺了会自动构建一次）、`desktop/node_modules/electron`、
 *   一个能起 GUI 的会话（窗口是隐藏的，但 Chromium 仍要能起）。产物证据落在
 *   `desktop/shots/ui-hmr-machine.{png,json}`（不入库）。
 *
 * @module dsc/scripts/ui-hmr-machine
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 走查的靶子：改动落点（一个**首屏批**里的小插件，apply 只有一行，改它不牵动别人）。 */
const TARGET = {
  id: 'statusbar',
  file: join(root, 'ui-shell', 'src', 'plugins', 'statusbar', 'ui.tsx'),
}
/** 标记插在 apply 体第一行：锚不到就报错退出（源码结构变了要有人看一眼）。 */
const ANCHOR = 'apply(ui) {'
const markerLine = (nonce) => `    document.documentElement.dataset['hmrProbe'] = ${JSON.stringify(nonce)}`

const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'scripts', '_ui-hmr-machine-main.cjs')
const EVIDENCE_PNG = join(root, 'desktop', 'shots', 'ui-hmr-machine.png')
const EVIDENCE_JSON = join(root, 'desktop', 'shots', 'ui-hmr-machine.json')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  PASS  ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** 跑一次插件构建，返回 {code, text, written, kept}（读数从构建自己的那行汇总里摘）。 */
function runBuild() {
  const result = spawnSync(process.execPath, [join(root, 'ui-shell', 'build-plugins.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return {
    code: result.status,
    text,
    written: /重写 (\d+) 份/.exec(text)?.[1] ?? '?',
    kept: /字节未变保留 (\d+) 份/.exec(text)?.[1] ?? '?',
  }
}

/** 由系统挑一个空闲端口（钉住端口是为了诊断时能直接 curl，不必从日志里找）。 */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer()
    probe.once('error', rejectPort)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolvePort(port))
    })
  })
}

/** 连上驱动的命令通道（回环 TCP；驱动 ready 时报了端口）。 */
function connectPort(port) {
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      rejectConnect(new Error(`连不上驱动命令通道（:${String(port)}）`))
    }, 10000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.setNoDelay(true)
      resolveConnect(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      rejectConnect(error)
    })
  })
}

/**
 * 驱动（Electron 主进程）的客户端。
 *
 * 命令走**回环 TCP**：Windows 上 Electron 主进程收不到父进程给的 stdin 管道（实测过：
 * stdout 的 ready 到得了、stdin 的行永远不来），所以驱动自己起一条本机连接、把端口
 * 随 ready 打在 stdout 上；stdout 只留单向下行。
 */
class Driver {
  constructor(child) {
    this.child = child
    this.seq = 0
    this.pending = new Map()
    this.console = []
    this.socket = null
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') this.note(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => process.stderr.write(`[驱动] ${String(chunk)}`))
    this.ready = new Promise((resolveReady) => {
      this.readyResolve = resolveReady
    })
    this.exited = new Promise((resolveExit) => {
      this.exitedResolve = resolveExit
    })
    child.on('exit', (code) => {
      this.exitedResolve(code ?? 0)
    })
  }

  /** stdout 上的下行：ready 认领，其余（gone / fail-load 之类）当证据打印。 */
  note(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      console.log(`[驱动] ${line}`)
      return
    }
    if (message.type === 'ready') {
      this.readyResolve(message)
      return
    }
    console.log(`[驱动] ${JSON.stringify(message)}`)
  }

  /** 接上命令通道（ready 之后才有端口）。 */
  async attach(port) {
    this.socket = await connectPort(port)
    this.socket.setEncoding('utf8')
    let buffer = ''
    this.socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') this.dispatch(line)
      }
    })
    const fail = (reason) => {
      for (const waiter of this.pending.values()) waiter({ ok: false, error: reason })
      this.pending.clear()
    }
    this.socket.on('error', (error) => fail(`命令通道出错：${error.message}`))
    this.socket.on('close', () => fail('命令通道已关闭'))
  }

  /** 通道上的消息：console 留档（error/warning 直接带出来），result 兑回等待者。 */
  dispatch(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      console.log(`[驱动] ${line}`)
      return
    }
    if (message.type === 'console') {
      this.console.push(message)
      // 页面的 error/warning 直接带出来：CSP 拒绝脚本、React 报错都在这一档现形。
      if (message.level === 'error' || message.level === 'warning') {
        console.log(`  [页面/${message.level}] ${message.message}`)
      }
      return
    }
    if (message.type === 'result') {
      const waiter = this.pending.get(message.id)
      if (waiter !== undefined) {
        this.pending.delete(message.id)
        waiter(message)
      }
      return
    }
    console.log(`[驱动] ${JSON.stringify(message)}`)
  }

  call(cmd, extra = {}) {
    const id = ++this.seq
    // 两个超时分家：`timeoutMs` 是**页内**等的上限（读数更具体），`clientTimeoutMs` 是这一侧
    // 等回复的上限，必须比页内那个大——同刻到点会把页内的失败读数盖成一句「驱动命令超时」。
    const timeoutMs = extra.clientTimeoutMs ?? 60000
    return new Promise((resolveCall, rejectCall) => {
      if (this.socket === null) {
        rejectCall(new Error(`命令通道还没接上：${cmd}`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectCall(new Error(`驱动命令超时：${cmd}`))
      }, timeoutMs)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.ok === true) resolveCall(message.value)
        else rejectCall(new Error(`驱动命令失败：${cmd} — ${String(message.error ?? '')}`))
      })
      this.socket.write(`${JSON.stringify({ id, cmd, ...extra })}\n`)
    })
  }
}

/** 起隔离宿主（临时 HOME + 一次性端口；HMR 轮询压到 250ms 让走查快些）。 */
function startHost({ port, home }) {
  const child = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSC_HOME: join(home, '.dsc'),
      DSC_UI_SERVER: '1',
      DSC_UI_HMR: '1',
      DSC_UI_HMR_POLL_MS: '250',
      DSC_UI_PORT: String(port),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderr = []
  const waitUrl = new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(`等界面地址超时（宿主 stderr 尾部：${stderr.slice(-3).join(' | ')}）`))
    }, 40000)
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(line)
        if (found !== null) {
          clearTimeout(timer)
          resolveUrl(found[0])
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr.push(...String(chunk).split('\n').filter((line) => line.trim() !== ''))
      if (stderr.length > 40) stderr.splice(0, stderr.length - 40)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectUrl(new Error(`宿主提前退出（code=${String(code)}）：${stderr.slice(-3).join(' | ')}`))
    })
  })
  return { child, port, waitUrl, stderr }
}

/** 带标记的那一份源码（还原轮用原始字节写回，因此这里只做纯函数变换）。 */
function sourceWithMarker(original, nonce) {
  const lines = original.split('\n')
  const at = lines.findIndex((line) => line.trim() === ANCHOR)
  if (at < 0) throw new Error(`目标插件源码里找不到锚点「${ANCHOR}」：${relative(root, TARGET.file)}`)
  return [...lines.slice(0, at + 1), markerLine(nonce), ...lines.slice(at + 1)].join('\n')
}

/** 一轮换装的共同断言：没刷新、只换一行、取数一条、无失败。 */
function verifySwap(label, before, after, graph, expectedProbe) {
  const b = before.boot
  const a = after.boot
  check(`${label}：页内哨兵没丢（页面没刷新）`, after.sentinel !== null && after.sentinel === before.sentinel)
  check(`${label}：timeOrigin 未变（页面没刷新）`, after.timeOrigin === before.timeOrigin)
  check(
    `${label}：账本 startedAt/firstFrameAt 未变（壳没重建）`,
    a.startedAt === b.startedAt && a.firstFrameAt === b.firstFrameAt,
  )
  const others = Object.keys(b.plugins).filter((id) => id !== TARGET.id)
  const touched = others.filter((id) => a.plugins[id].rev !== b.plugins[id].rev)
  check(`${label}：只有 ${TARGET.id} 一行换代（别的 ${String(others.length)} 条 rev 不动）`, touched.length === 0, touched.join('、'))
  check(
    `${label}：目标 rev 与宿主图当下那一份一致`,
    a.plugins[TARGET.id].rev === graph.revs[TARGET.id],
    `页=${String(a.plugins[TARGET.id].rev)} 图=${String(graph.revs[TARGET.id])}`,
  )
  check(`${label}：目标状态是 loaded`, a.plugins[TARGET.id].state === 'loaded', String(a.plugins[TARGET.id].state))
  const added = a.requests.slice(b.requests.length)
  check(
    `${label}：这一轮只多一条单资源请求（目标 id、成功）——批没被重放`,
    added.length === 1 && added[0].kind === 'single' && added[0].id === TARGET.id && added[0].ok === true,
    JSON.stringify(added),
  )
  if (expectedProbe !== null) {
    check(`${label}：新代码真的执行了（DOM 标记=${expectedProbe}）`, after.probe === expectedProbe, String(after.probe))
  }
  check(`${label}：页内没有同步失败`, after.syncFailures.length === 0, after.syncFailures.join('、'))
  check(`${label}：DOM 里目标插件的装载行还在`, after.pluginRows.includes(TARGET.id))
}

async function main() {
  console.log('[ui-hmr-machine] 真机热更走查（Electron + 真宿主 + 真构建 + 真源码改动）')

  // ── 0. 前置：工具、产物、干净的目标文件 ──────────────────────────────────────
  console.log('\n[0] 前置检查')
  check('Electron 在（desktop/node_modules）', existsSync(ELECTRON), ELECTRON)
  check('浏览器侧驱动在', existsSync(DRIVER), DRIVER)
  const assets = join(root, 'lib', 'ui', 'assets', 'index.html')
  if (!existsSync(assets)) {
    console.log('  ..    界面壳产物不在，先构建一次（pnpm -C ui-shell build:app）')
    const build = spawnSync('pnpm', ['-C', 'ui-shell', 'build:app'], { cwd: root, encoding: 'utf8', shell: true })
    check('界面壳产物构建成功', build.status === 0 && existsSync(assets), `${String(build.status)}`)
  } else {
    check('界面壳产物在（lib/ui/assets）', true)
  }
  const targetRel = relative(root, TARGET.file)
  const dirty = spawnSync('git', ['status', '--porcelain', '--', targetRel], { cwd: root, encoding: 'utf8' })
  check(`目标文件入库前是干净的（${targetRel}）`, (dirty.stdout ?? '').trim() === '', (dirty.stdout ?? '').trim())
  const original = readFileSync(TARGET.file, 'utf8')
  const baselineBuild = runBuild()
  check('基线构建成功', baselineBuild.code === 0, baselineBuild.text.split('\n').slice(-2).join(' / '))
  console.log(`  ..    基线构建：重写 ${baselineBuild.written} 份，保留 ${baselineBuild.kept} 份`)

  // ── 1. 起隔离宿主 + 真浏览器 ────────────────────────────────────────────────
  console.log('\n[1] 起宿主与浏览器')
  const home = mkdtempSync(join(tmpdir(), 'dsc-ui-hmr-machine-'))
  const port = await freePort()
  const host = startHost({ port, home })
  console.log(`  ..    宿主 PID ${String(host.child.pid ?? '?')}，端口 ${String(port)}，隔离 HOME ${home}`)
  let driver = null
  let edited = false
  let restored = false
  const evidence = { startedAt: Date.now(), port, rounds: [] }

  try {
    const url = await host.waitUrl
    check(`宿主报出界面地址（:${String(port)}）`, url.includes(`:${String(port)}/`), url)

    const child = spawn(ELECTRON, [DRIVER, url], {
      cwd: root,
      env: { ...process.env, DSC_UI_HMR_USER_DATA: join(home, 'electron-user-data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    driver = new Driver(child)
    const ready = await Promise.race([
      driver.ready,
      // 驱动自己挂了要马上失败，别干等超时（第一次踩过：BrowserWindow 建早了，
      // 只有 stderr 里一行，走查硬等 90 秒）。
      driver.exited.then((code) => {
        throw new Error(`浏览器提前退出（code=${String(code)}）`)
      }),
      sleep(40000).then(() => {
        throw new Error('浏览器 40 秒没就绪')
      }),
    ])
    check('浏览器加载了宿主伺服的页面', typeof ready.url === 'string' && ready.url.includes(`:${String(port)}/`), String(ready.url))
    await driver.attach(Number(ready.port))
    check('命令通道已接上（回环 TCP）', driver.socket !== null && Number(ready.port) > 0, `port=${String(ready.port)}`)

    const peek = await driver.call('describe')
    console.log(`  ..    页面：${peek.url}（${peek.title} / ${peek.readyState} / #root 子节点 ${String(peek.rootChildren)} / 脚本 ${peek.scripts.join('、')}）`)
    if (peek.boot === null) {
      console.log(`  ..    页内还没有启动账本；正文开头：「${peek.bodyText}」`)
    }

    // 页内自带的等 30 秒，客户端多等 15 秒：两个超时同刻会变成「驱动命令超时」，
    // 把页内那份更具体的读数（谁还 pending、谁 failed）盖掉。
    const settled = await driver.call('wait-boot', { timeoutMs: 30000, clientTimeoutMs: 45000 })
    if (settled.ok !== true) {
      const diag = await driver.call('describe')
      console.log(`  ..    没装上的原因：${JSON.stringify(diag.failedRows ?? [])}`)
      console.log(`  ..    页内同步失败：${JSON.stringify(diag.syncFailureText ?? [])}`)
      console.log(`  ..    账本明细：${JSON.stringify(Object.fromEntries(Object.entries(diag.boot.plugins).filter(([, row]) => row.state !== 'loaded').map(([id, row]) => [id, row])))}`)
      console.log(`  ..    取数明细：${JSON.stringify(diag.boot.requests)}`)
    }
    check(`全部插件启动落定（${String(settled.loaded ?? 0)} 条装上）`, settled.ok === true, JSON.stringify(settled))

    const graph0 = await driver.call('graph')
    const base = await driver.call('describe')
    check('页内账本已就位', base.boot !== null)
    check(`清单条数与页内一致（${String(graph0.entries.length)} 条）`, Object.keys(base.boot.plugins).length === graph0.entries.length)
    check('两批都是 done（early + application）', base.boot.batches.length >= 2 && base.boot.batches.every((b) => b.state === 'done'), JSON.stringify(base.boot.batches.map((b) => `${b.phase}:${b.state}`)))
    check('数据通道已连上', base.channel === 'open', String(base.channel))
    check('诊断区在 DOM 里（?diag=1 生效）', base.diagnostics === true)
    check(
      '诊断区读数与账本一致（每批 N/N、插件行数对得上）',
      base.batches.every((b) => {
        const [loaded, total] = String(b.loaded).split('/')
        return loaded === total && b.state === 'done'
      }) && base.pluginRows.length === graph0.entries.length,
      JSON.stringify(base.batches),
    )
    check('服务表非空（诊断区 data-services 有值）', typeof base.services === 'string' && base.services !== '', String(base.services))
    check('页内没有同步失败', base.syncFailures.length === 0, base.syncFailures.join('、'))
    check('页内没有槽位故障', base.faults.length === 0, base.faults.join('、'))
    console.log(`  ..    基线 rev：${TARGET.id}=${String(base.boot.plugins[TARGET.id].rev)}，请求数 ${String(base.boot.requests.length)}，首帧 @${String((base.boot.firstFrameAt ?? 0) - base.boot.startedAt)}ms`)

    const sentinel = randomBytes(8).toString('hex')
    await driver.call('mark', { value: sentinel })
    // 打点之后再取一次「换装前」基线：哨兵要在这份里（第一版拿了打点之前那一份，
    // 于是第一轮永远红——哨兵当时还是 null）。
    const marked = await driver.call('describe')
    check('页内哨兵已就位（刷新就丢的标记）', marked.sentinel === sentinel, String(marked.sentinel))
    evidence.baseline = {
      rev: marked.boot.plugins[TARGET.id].rev,
      requests: marked.boot.requests.length,
      timeOrigin: marked.timeOrigin,
      loaded: Object.keys(marked.boot.plugins).length,
    }

    // ── 2. 第一轮：改源码 → 构建 → 等壳换装 ────────────────────────────────────
    console.log('\n[2] 第一轮换装（插入标记 nonce1）')
    const nonce1 = randomBytes(4).toString('hex')
    writeFileSync(TARGET.file, sourceWithMarker(original, nonce1), 'utf8')
    edited = true
    const build1 = runBuild()
    check('构建成功且只重写目标那一份', build1.code === 0 && build1.written === '1', `code=${String(build1.code)} 重写=${build1.written}`)
    const swap1 = await driver.call('wait-change', { plugin: TARGET.id, from: marked.boot.plugins[TARGET.id].rev, timeoutMs: 30000, clientTimeoutMs: 45000 })
    check(`壳等到换装（${String(marked.boot.plugins[TARGET.id].rev)} → ${String(swap1.rev ?? '?')}，${String(swap1.waitedMs ?? '?')}ms）`, swap1.ok === true, JSON.stringify(swap1))
    const after1 = await driver.call('describe')
    const graph1 = await driver.call('graph')
    verifySwap('第一轮', marked, after1, graph1, nonce1)
    evidence.rounds.push({ label: '第一轮', build: { written: build1.written, kept: build1.kept }, rev: after1.boot.plugins[TARGET.id].rev, probe: after1.probe, waitedMs: swap1.waitedMs })
    const shot = await driver.call('shot', { file: EVIDENCE_PNG })
    console.log(`  ..    证据图：${EVIDENCE_PNG}（隐藏窗口，可能是空图：${String(shot.empty)}）`)

    // ── 3. 第二轮：再改一次 → 再换装（证明可重复，且每次都执行新代码） ─────────
    console.log('\n[3] 第二轮换装（标记换成 nonce2）')
    const nonce2 = randomBytes(4).toString('hex')
    writeFileSync(TARGET.file, sourceWithMarker(original, nonce2), 'utf8')
    const build2 = runBuild()
    check('构建成功且只重写目标那一份', build2.code === 0 && build2.written === '1', `code=${String(build2.code)} 重写=${build2.written}`)
    const swap2 = await driver.call('wait-change', { plugin: TARGET.id, from: after1.boot.plugins[TARGET.id].rev, timeoutMs: 30000, clientTimeoutMs: 45000 })
    check(`壳等到第二次换装（→ ${String(swap2.rev ?? '?')}）`, swap2.ok === true, JSON.stringify(swap2))
    const after2 = await driver.call('describe')
    const graph2 = await driver.call('graph')
    verifySwap('第二轮', after1, after2, graph2, nonce2)
    evidence.rounds.push({ label: '第二轮', build: { written: build2.written, kept: build2.kept }, rev: after2.boot.plugins[TARGET.id].rev, probe: after2.probe, waitedMs: swap2.waitedMs })

    // ── 4. 还原轮：写回原始字节 → 构建 → rev 该回到原值 ────────────────────────
    console.log('\n[4] 还原轮（写回原始源码）')
    writeFileSync(TARGET.file, original, 'utf8')
    edited = false
    const build3 = runBuild()
    check('构建成功且只重写目标那一份', build3.code === 0 && build3.written === '1', `code=${String(build3.code)} 重写=${build3.written}`)
    const swap3 = await driver.call('wait-change', { plugin: TARGET.id, from: after2.boot.plugins[TARGET.id].rev, timeoutMs: 30000, clientTimeoutMs: 45000 })
    check(`壳等到还原轮换装（→ ${String(swap3.rev ?? '?')}）`, swap3.ok === true, JSON.stringify(swap3))
    const after3 = await driver.call('describe')
    const graph3 = await driver.call('graph')
    verifySwap('还原轮', after2, after3, graph3, null)
    check(
      '还原轮：rev 回到初始值（同一份源码字节 → 同一份产物字节）',
      after3.boot.plugins[TARGET.id].rev === base.boot.plugins[TARGET.id].rev,
      `初=${String(base.boot.plugins[TARGET.id].rev)} 现=${String(after3.boot.plugins[TARGET.id].rev)}`,
    )
    evidence.rounds.push({ label: '还原轮', build: { written: build3.written, kept: build3.kept }, rev: after3.boot.plugins[TARGET.id].rev, probe: after3.probe, waitedMs: swap3.waitedMs })
    restored = true

    const pageErrors = driver.console.filter((line) => line.level === 'error')
    check('页面控制台没有 error 级消息', pageErrors.length === 0, pageErrors.map((line) => line.message).slice(0, 3).join(' | '))
  } finally {
    // 清理：源码一定要还原（构建也要跑一次，别把带标记的产物留在 lib/ 里）。
    if (edited && !restored) {
      writeFileSync(TARGET.file, original, 'utf8')
      const undo = runBuild()
      console.log(`  ..    收尾还原源码并重建：重写 ${undo.written} 份（code=${String(undo.code)}）`)
    }
    if (driver !== null) {
      try {
        await driver.call('quit', { timeoutMs: 5000 })
        await Promise.race([driver.exited, sleep(5000)])
      } catch {
        // 驱动已经不回话了就直接杀
      }
      try {
        driver.child.kill()
      } catch {
        // 已经退了
      }
    }
    try {
      host.child.stdin.end()
      host.child.kill()
    } catch {
      // 已经退了
    }
    await sleep(300)
    rmSync(home, { recursive: true, force: true })
    const dirtyAfter = spawnSync('git', ['status', '--porcelain', '--', relative(root, TARGET.file)], { cwd: root, encoding: 'utf8' })
    check('目标文件已还原（工作区里不留痕）', (dirtyAfter.stdout ?? '').trim() === '', (dirtyAfter.stdout ?? '').trim())
    evidence.failures = failures
    evidence.console = driver === null ? [] : driver.console.slice(-20)
    mkdirSync(dirname(EVIDENCE_JSON), { recursive: true })
    writeFileSync(EVIDENCE_JSON, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    console.log(`\n[ui-hmr-machine] 证据：${EVIDENCE_JSON}`)
  }
}

await main().catch((error) => {
  failures += 1
  console.log(`  FAIL  走查中断：${error instanceof Error ? error.message : String(error)}`)
})
console.log(`\n[ui-hmr-machine] ${failures === 0 ? '全部通过' : `${String(failures)} 项红`}`)
process.exit(failures === 0 ? 0 : 1)
