/**
 * 安装器实装走查（Windows）：nsis 静默装 → 隔离启动读界面读数 → 静默卸 → portable 直跑。
 *
 * 为什么要它：win-unpacked 自检验的是「打包产物」，而用户双击的是**安装器**——装到哪、
 * 界面产物（`lib/ui/assets`、`lib/ui/plugins`）有没有随 extraResources 落进
 * `resources/dsc-core`、卸载干不干净，这三件事只有真装一遍才知道。此前这三件都欠着：
 * 仓库里两个安装器还是 10 月 8 日那一版。
 *
 * 隔离口径与桌面自检同一条：HOME / USERPROFILE / DSC_HOME / APPDATA / LOCALAPPDATA /
 * DSC_DESKTOP_STATE / DSC_DESKTOP_USER_DATA 全钉在一次性目录；跑前跑后对真实 `~/.dsc`
 * 做「文件数 + 内容聚合 SHA256」比对（安装器直接装，这一步是唯一能证明「没动真实档案」的）。
 * 安装器自己写的那条开始菜单快捷方式落在真实档案里（Shell API 不看环境变量），所以走查
 * 顺带核一遍「装时出现、卸后消失」。
 *
 * 界面读数分两条路：
 *
 *   - **nsis 那份**：桌面自检那套 `DSC_DESKTOP_SHOT` + `DSC_DESKTOP_SHOT_EVAL`（内联一段
 *     eval：等启动落定后回报 `__DSC_UI_BOOT_STATE__` 读数），再核 stderr 上的
 *     「界面形态=shell」「窗口来自宿主界面服务」「已写出 …png」；
 *   - **portable 那份**：NSIS 启动器（ExecWait）不把 stdio 交给子进程，stderr 拿不到——
 *     于是改用**截图指纹**：把 portable 的截图与 nsis 的截图在同一区域做粗采样比对，
 *     同一套壳渲染出来的两张图差得很小，退到旧界面就会差一大截。这条断言就是为了堵住
 *     「portable 到底起的是哪套界面」这个没法用日志回答的问题。
 *
 * 用法：
 *   pnpm -C desktop dist           # 先造出 dist/pneuma-setup-<v>.exe 与 -portable-<v>.exe
 *   node desktop/scripts/installer-walkthrough.mjs
 *   DSC_WALKTHROUGH_EXE=<exe> 跳过装/卸只走「启动 + 读数」（迭代断言用）；
 *   DSC_SKIP_INSTALL=1 / DSC_SKIP_PORTABLE=1 各跳一段。
 *
 * @module pneuma-desktop/installer-walkthrough
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shotSignature, signatureDiff } from './png-tools.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const desktop = join(root, 'desktop')
const shots = join(desktop, 'shots')
const version = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).version
const dist = join(desktop, 'dist')
const setup = join(dist, `pneuma-setup-${version}.exe`)
const portable = join(dist, `pneuma-portable-${version}.exe`)

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
const shell = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...options })

/** 真 `~/.dsc` 的指纹：文件数 + 「相对路径|内容摘要」逐行聚合的 SHA256（锁定文件记 LOCKED）。 */
function fingerprint(dir) {
  if (!existsSync(dir)) return { count: 0, digest: '(不存在)' }
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  walk(dir)
  files.sort()
  const lines = files.map((file) => {
    let digest = 'LOCKED'
    try {
      digest = createHash('sha256').update(readFileSync(file)).digest('hex')
    } catch {
      // 被占用：记 LOCKED，与自检脚本同一条口径
    }
    return `${relative(dir, file)}|${digest}`
  })
  return {
    count: files.length,
    digest: createHash('sha256').update(lines.join('\n')).digest('hex'),
  }
}

/**
 * 卸载项：键名是 appId 的 v5 GUID（不是 appId 本身），所以按**显示名**在整棵 Uninstall
 * 树里搜数据；返回命中的键路径列表（空数组 = 没登记）。
 */
function uninstallEntries() {
  const found = shell('reg', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    '/s',
    '/f',
    'Pneuma',
    '/d',
  ])
  if (found.status !== 0) return []
  return (found.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('HKEY_CURRENT_USER'))
}


/** 页内读数：等启动落定，回报账本 + 诊断 DOM（与真机热更走查同一套读面）。 */
const EVAL = `(async () => {
  const startedAt = Date.now()
  let state = null
  for (;;) {
    state = globalThis.__DSC_UI_BOOT_STATE__ ?? null
    if (state !== null) {
      const rows = Object.values(state.plugins)
      const settled = rows.length > 0
        && rows.every((row) => row.state === 'loaded' || row.state === 'failed' || row.state === 'removed')
        && state.batches.every((b) => b.state === 'done' || b.state === 'failed')
      if (settled) break
    }
    if (Date.now() - startedAt > 20000) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const attr = (selector, name) => {
    const el = document.querySelector(selector)
    return el === null ? null : el.getAttribute(name)
  }
  const root = document.getElementById('root')
  const diag = document.querySelector('details.diagnostics')
  return {
    waitedMs: Date.now() - startedAt,
    boot: state === null ? null : {
      host: state.host,
      rev: state.rev,
      batches: state.batches.map((b) => b.phase + ':' + b.state + ':' + b.entries.length),
      loaded: Object.values(state.plugins).filter((row) => row.state === 'loaded').length,
      failed: Object.entries(state.plugins).filter(([, row]) => row.state !== 'loaded').map(([id]) => id),
      requests: state.requests.map((r) => r.kind + ':' + r.id),
      ids: Object.keys(state.plugins),
    },
    channel: attr('[data-channel]', 'data-channel'),
    services: attr('[data-services]', 'data-services'),
    rootChildren: root === null ? 0 : root.childElementCount,
    diagSummary: diag === null || diag.querySelector('summary') === null ? null : diag.querySelector('summary').textContent,
    // 诊断区的行：**钉在 details.diagnostics 里**——插件面板的列表也有 data-plugin（值是文件名），
    // 不钉范围会把它的行算进来。
    diagRows: [...document.querySelectorAll('details.diagnostics li[data-plugin]')].map((el) => el.getAttribute('data-plugin') + (el.classList.contains('ok') ? '' : '!')),
    otherRows: [...document.querySelectorAll('[data-plugin]')]
      .filter((el) => el.closest('details.diagnostics') === null)
      .map((el) => el.getAttribute('data-plugin')),
  }
})()`

/** stderr 尾部（失败时贴证据，别把整份日志倒出来）。 */
const tail = (text, lines = 6) => text.split('\n').filter((line) => line.trim() !== '').slice(-lines).join(' | ')

/** 拉起一份界面（装好的那份或 portable），收 stderr、解析预跑脚本的读数。 */
function launchUi(exe, { home, label, timeoutMs = 300000 }) {
  const shot = join(shots, `installer-walkthrough-${label}.png`)
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DSC_HOME: join(home, '.dsc'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    DSC_DESKTOP_STATE: join(home, '.dsc', 'desktop.json'),
    DSC_DESKTOP_USER_DATA: join(home, 'electron-userdata'),
    DSC_UI_SHELL: '1',
    DSC_UI_QUERY: 'diag=1',
    DSC_DESKTOP_SHOT: shot,
    // 自检时序：加载完 15 秒后跑预跑脚本（够内核与宿主起来），再有 30 秒窗口；到 45 秒截图并退出。
    DSC_DESKTOP_SHOT_DELAY: '45000',
    DSC_DESKTOP_SHOT_EVAL_LEAD: '30000',
    DSC_DESKTOP_SHOT_EVAL: EVAL,
    // 默认**不打扰**：不开 TOPMOST，窗口不弹到前台（读数走页内 eval，不依赖可见窗口）。
    // 想在屏幕上看着它跑、或想让证据图一定是活帧时，DSC_WALKTHROUGH_SHOW=1。
    ...(process.env['DSC_WALKTHROUGH_SHOW'] === '1' ? { DSC_DESKTOP_SHOT_TOPMOST: '1' } : {}),
    // 可选：连原生控件条一起抓（那条日志会回报「窗口可见=」，是「这条走查打不打扰人」的读数）。
    ...(process.env['DSC_WALKTHROUGH_STRIP'] === '1'
      ? { DSC_DESKTOP_SHOT_STRIP: join(shots, `installer-walkthrough-${label}-strip.png`) }
      : {}),
  }
  const args = (process.env['DSC_WALKTHROUGH_ENTRY'] ?? '') === '' ? [] : [process.env['DSC_WALKTHROUGH_ENTRY']]
  const result = spawnSync(exe, args, { encoding: 'utf8', env, timeout: timeoutMs, windowsHide: true })
  const stderr = result.stderr ?? ''
  const evalLine = /\[selfcheck\] 预跑脚本完成：(.*)/.exec(stderr)
  let reading = null
  if (evalLine !== null) {
    try {
      reading = JSON.parse(evalLine[1])
    } catch {
      reading = null
    }
  }
  return { status: result.status, stderr, shot, reading, spawnError: result.error }
}

/** 一份界面启动之后的共同断言（两条路都做得了的那半）。 */
function verifyUi(label, launched, { expectReading = true } = {}) {
  const { stderr, reading } = launched
  check(`${label}：进程正常退出（截图后 app.exit(0)）`, launched.status === 0, `code=${String(launched.status)} ${String(launched.spawnError ?? '')}`)
  check(`${label}：截图落盘`, existsSync(launched.shot) && statSync(launched.shot).size > 0, launched.shot)
  if (!expectReading) return
  check(`${label}：窗口伺服的是插件壳`, stderr.includes('界面形态=shell'), tail(stderr))
  check(`${label}：窗口来自宿主界面服务`, stderr.includes('窗口来自宿主界面服务'), tail(stderr))
  const visible = /控件条[^；]*；窗口可见=(\S+)/.exec(stderr)
  if (visible !== null) console.log(`  ..    ${label} 窗口可见=${visible[1]}（DSC_WALKTHROUGH_STRIP=1 时的读数）`)
  // 原生桥在场的证据：桌面形态（带 preload）会打出主题来源；裸 Electron / 走查包里也可能有，
  // 有没有都打印出来——这条读的是「桥这条路上有没有话」。
  const theme = /原生主题源 (\S+)/.exec(stderr)
  if (theme !== null) console.log(`  ..    ${label} 原生主题源=${theme[1]}`)
  if (reading === null) {
    check(`${label}：预跑脚本回报了读数`, false, tail(stderr))
    return
  }
  check(`${label}：预跑脚本回报了读数`, true)
  const boot = reading.boot
  check(`${label}：页内账本在`, boot !== null)
  if (boot === null) return
  console.log(`  ..    ${label} 读数：${JSON.stringify({ host: boot.host, batches: boot.batches, loaded: boot.loaded, failed: boot.failed, requests: boot.requests, waitedMs: reading.waitedMs })}`)
  check(`${label}：宿主版本 = ${version}`, boot.host?.version === version, String(boot.host?.version))
  check(`${label}：16 条内置插件全部装上`, boot.loaded === 16 && boot.failed.length === 0, JSON.stringify(boot.failed))
  check(`${label}：两批都 done（early 2 + application 14）`, boot.batches.join('、') === 'early:done:2、application:done:14', boot.batches.join('、'))
  check(`${label}：数据通道已连上`, reading.channel === 'open', String(reading.channel))
  check(
    `${label}：取数走 combo（≤3 条请求、全是批）`,
    boot.requests.length <= 3 && boot.requests.length >= 1 && boot.requests.every((row) => row.startsWith('batch:')),
    JSON.stringify(boot.requests),
  )
  // 诊断区的名单必须覆盖清单里每一条、且没有一条是失败的（界面读数之外的第二条独立证据）。
  const rows = reading.diagRows ?? []
  const ids = rows.map((row) => row.replace(/!$/, ''))
  const missing = (boot.ids ?? []).filter((id) => !ids.includes(id))
  console.log(`  ..    ${label} 诊断区：${String(reading.diagSummary ?? '—')}；区外带 data-plugin 的 ${JSON.stringify(reading.otherRows ?? [])}`)
  check(
    `${label}：诊断区列全 ${String((boot.ids ?? []).length)} 条且都装着（实测 ${String(rows.length)} 行，缺 ${missing.join('、') || '无'}）`,
    rows.length === (boot.ids ?? []).length && missing.length === 0 && rows.every((row) => !row.endsWith('!')),
    JSON.stringify(rows),
  )
}

// ── 0. 前置 ─────────────────────────────────────────────────────────────────
console.log(`[installer-walkthrough] Pneuma ${version}：nsis 装/卸 + portable 直跑`)
const realDsc = join(process.env['USERPROFILE'] ?? '', '.dsc')
const shortcutDir = join(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
const shortcuts = () => (existsSync(shortcutDir) ? readdirSync(shortcutDir).filter((name) => name.includes('Pneuma')) : [])
const before = fingerprint(realDsc)
console.log(`\n[0] 前置（真实 ~/.dsc：${String(before.count)} 个文件；开始菜单现有 ${String(shortcuts().length)} 条 Pneuma 快捷方式）`)
check('nsis 安装器在（先跑 pnpm -C desktop dist）', existsSync(setup), setup)
check('portable 在（先跑 pnpm -C desktop dist）', existsSync(portable), portable)
if (existsSync(setup)) {
  console.log(`  ..    nsis ${new Date(statSync(setup).mtimeMs).toLocaleString()} / portable ${existsSync(portable) ? new Date(statSync(portable).mtimeMs).toLocaleString() : '缺'}`)
}

const work = mkdtempSync(join(tmpdir(), 'dsc-installer-walkthrough-'))
const home = join(work, 'home')
const installDir = join(work, 'installed')
const shotFinal = join(shots, 'installer-walkthrough-nsis.png')
let installed = false
try {
  // `DSC_WALKTHROUGH_EXE` 指到一份现成的 exe（例如 dist/win-unpacked/Pneuma.exe）时，
  // 跳过装/卸只走「启动 + 读数」那一段——迭代断言时不必每次都真装一遍。
  if ((process.env['DSC_WALKTHROUGH_EXE'] ?? '') !== '') {
    console.log(`\n[1] 跳过装/卸，直接走查 ${process.env['DSC_WALKTHROUGH_EXE']}`)
    verifyUi('指定的那份', launchUi(process.env['DSC_WALKTHROUGH_EXE'], { home, label: 'direct' }))
  } else if (process.env['DSC_SKIP_INSTALL'] !== '1') {
    // ── 1. 静默装 ───────────────────────────────────────────────────────────
    console.log('\n[1] nsis 静默安装')
    const install = shell(setup, ['/S', `/D=${installDir}`], { timeout: 300000 })
    check('安装器退出码 0', install.status === 0, `code=${String(install.status)} ${tail(install.stderr ?? '')}`)
    const exe = join(installDir, 'Pneuma.exe')
    installed = existsSync(exe)
    check(`装到指定目录（${installDir}）`, installed, installDir)
    check('卸载器在（Uninstall …exe）', installed && readdirSync(installDir).some((name) => name.startsWith('Uninstall')))
    check(`开始菜单出现快捷方式（${shortcuts().join('、') || '无'}）`, shortcuts().length > 0)
    // extraResources 把整个 lib/ 拷进 resources/dsc-core：界面产物必须在 asar 之外，
    // 否则宿主读不到插件目录（打包态白屏的头号原因）。
    const core = join(installDir, 'resources', 'dsc-core')
    check('界面壳产物随 extraResources 落位（resources/dsc-core/lib/ui/assets）', existsSync(join(core, 'lib', 'ui', 'assets', 'index.html')))
    const manifestPath = join(core, 'lib', 'ui', 'plugins', 'manifest.json')
    check('插件清单随 extraResources 落位', existsSync(manifestPath), manifestPath)
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      check(
        `清单 apiVersion = 1.2.0 且 16 条都带 api（装出来这份实测 ${String(manifest.plugins?.length ?? 0)} 条）`,
        manifest.apiVersion === '1.2.0' && manifest.plugins.length === 16 && manifest.plugins.every((row) => typeof row.api === 'string'),
        `apiVersion=${String(manifest.apiVersion)}`,
      )
    }
    const entries = uninstallEntries()
    check(`注册表里登记了卸载项（${entries[0] ?? '没找到'}）`, entries.length > 0)

    // ── 2. 启动装了的那份 ────────────────────────────────────────────────────
    console.log('\n[2] 启动装了的那份（隔离档案 + 自检读数）')
    verifyUi('nsis 那份', launchUi(exe, { home, label: 'nsis' }))

    // ── 3. 静默卸 ───────────────────────────────────────────────────────────
    console.log('\n[3] nsis 静默卸载')
    const uninstaller = readdirSync(installDir).find((name) => name.startsWith('Uninstall'))
    const uninstall = shell(join(installDir, uninstaller), ['/S'], { timeout: 120000 })
    check('卸载器受理（退出码 0）', uninstall.status === 0, `code=${String(uninstall.status)}`)
    // NSIS 卸载器会把自己复制到临时目录再干活：命令返回 ≠ 卸完。三段清理**不是同一刻**完成的
    // （实测：安装目录先没，注册表项与快捷方式晚几秒才走），所以要等三件都落定再断言，
    // 不然就是拿「抢先」当「没卸干净」。
    const deadline = Date.now() + 90000
    const uninstallState = () => ({
      dir: existsSync(installDir),
      entries: uninstallEntries().length,
      shortcuts: shortcuts().length,
    })
    let state = uninstallState()
    while ((state.dir || state.entries > 0 || state.shortcuts > 0) && Date.now() < deadline) {
      await sleep(1500)
      state = uninstallState()
    }
    check('安装目录被清掉', !state.dir, installDir)
    check('卸载项从注册表里消失', state.entries === 0, `还剩 ${String(state.entries)} 项`)
    check(`开始菜单快捷方式被收走（现存 ${String(state.shortcuts)} 条）`, state.shortcuts === 0, shortcuts().join('、'))
    installed = false
  }

  if (process.env['DSC_SKIP_PORTABLE'] !== '1') {
    // ── 4. portable 直跑 ────────────────────────────────────────────────────
    console.log('\n[4] portable 直跑（自解压到临时目录再拉起）')
    const launched = launchUi(portable, { home, label: 'portable' })
    // 启动器的 stdio 到不了应用（ExecWait 不继承），所以这里只断言「跑完 + 出图」，
    // 界面形态由下面那张图跟 nsis 的图比对。
    verifyUi('portable 那份', launched, { expectReading: false })
    if (existsSync(shotFinal) && existsSync(launched.shot)) {
      const reference = shotSignature(shotFinal)
      const contrast = Math.max(...reference) - Math.min(...reference)
      const diff = signatureDiff(shotFinal, launched.shot)
      check(
        `portable 起的是同一套壳界面（与 nsis 截图粗采样差 ${diff.toFixed(2)} < 12）`,
        diff < 12,
        `Δ=${diff.toFixed(2)}`,
      )
      // 判据自检：参照图得真有明暗对比——不然解码坏成一片常数也会「差 0」蒙混过关。
      check(`截图指纹有明暗（对比 ${contrast.toFixed(0)} > 40）`, contrast > 40, `contrast=${contrast.toFixed(0)}`)
    } else {
      check('portable 界面对比（需要上一段 nsis 的截图）', false, '缺截图')
    }
  }
} finally {
  if (installed) {
    console.log('  ..    走查中断：把装上的那份补卸一次')
    const uninstaller = existsSync(installDir) ? readdirSync(installDir).find((name) => name.startsWith('Uninstall')) : undefined
    if (uninstaller !== undefined) shell(join(installDir, uninstaller), ['/S'], { timeout: 120000 })
  }
  console.log(`  ..    走查工作目录 ${work}（隔离档案；不自动删，验收完可手工清）`)
}

// ── 5. 真实档案没被动过 ─────────────────────────────────────────────────────
console.log('\n[5] 真实档案核对')
const after = fingerprint(realDsc)
check(
  `真实 ~/.dsc 文件数不变（${String(before.count)} → ${String(after.count)}）`,
  after.count === before.count,
  `${String(before.count)} → ${String(after.count)}`,
)
check('真实 ~/.dsc 内容指纹不变', after.digest === before.digest, `${before.digest} → ${after.digest}`)
console.log(`\n[installer-walkthrough] ${failures === 0 ? '全部通过' : `${String(failures)} 项红`}`)
process.exit(failures === 0 ? 0 : 1)
