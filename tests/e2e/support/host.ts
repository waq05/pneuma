/**
 * e2e 层共享外壳：起真宿主、等界面地址、驱真 Electron、等读数文件，外加构建新鲜度预检。
 *
 * ## 这一层和 integration 层的根本差别
 *
 * integration 的 `bootKernel` 在**本进程**里起内核（宿主来自 src，混合平面，见 D25）；
 * e2e 是 spawn 真 `bin/headless.cjs` + 真 Electron——被测对象全是 lib 平面的产物，
 * 所以这里没有 `@pneuma/*` 的源码别名，也没有 temp-home setup：隔离 HOME 是
 * `mkdtempHome()` 建出来、显式写进子进程 env 的，本进程的 HOME 不动。
 *
 * ## 构建新鲜度（为什么不静默跑）
 *
 * e2e 跑的是 `lib/` 与 `lib/ui/` 的**产物**。改了 `src/` 或 `ui-shell/` 却没 build，
 * 探针照样绿——验的是旧代码。所以每个 spec 在 collection 时调 `probeFreshness()`，
 * 产物缺失或比源码旧就 `describe.skipIf` 整文件跳过，并把原因打出来（不静默绿）。
 * 判据与 `tests/harness.ts` 的 `assertBuildIsFresh` 同一思路：mtime 比较，源比产物新
 * 就是没构建；测试文件与类型声明不参与构建，不唤醒守卫。
 *
 * ## 产物落盘
 *
 * 原探针把截图与读数写 `desktop/shots/`（夜跑通道 `check:ui:e2e` 仍走那条路）。
 * vitest 这条入口把所有产物写 `os.tmpdir()` 的临时目录——不进库，`.gitignore` 不用改。
 *
 * @module dsc/tests/e2e/support/host
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（`tests/e2e/support/host.ts` 往上三级）。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Electron 二进制：正常 `pnpm install` 会经 postinstall 下载到 desktop 的依赖里。
 *
 * `DSC_E2E_ELECTRON` 是逃生门不是新口径：默认仍是 `desktop/node_modules/electron`（设计
 * §7.2）。留给同一仓库多份工作树共用一份 dist 的机器——worktree 里新落盘的 exe 会被
 * 实时防护按路径拦（2026-11-14 实测），指向主树的 dist 就能跑真机。
 */
export const ELECTRON =
  process.env['DSC_E2E_ELECTRON'] ?? join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')

/** 内核产物标记（与 harness.ts 的 assertBuildIsFresh 同款）。 */
const CORE_MARKER = join(ROOT, 'lib', 'core', 'session.js')

/** 界面壳产物标记（`pnpm -C ui-shell build` 的 vite 产物）。 */
const UI_MARKER = join(ROOT, 'lib', 'ui', 'assets', 'index.html')

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** 让宿主自己挑一个空闲端口（原探针同款：避开手写端口撞车）。 */
export function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const probe = createServer()
    probe.once('error', bad)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        bad(new Error('拿不到空闲端口（监听地址是管道名？）'))
        return
      }
      probe.close(() => ok(address.port))
    })
  })
}

/**
 * 临时隔离 HOME：e2e 全程不碰真实 `~/.dsc`。
 *
 * 返回 `{ home, dsc }`；`dsc` 不自动建——boot/dsh-card 探针要自己控制 `.dsc` 的初始
 * 内容（config.yaml、plugins.json），two-halves 还要往里写 profile，各 spec 自己 mkdir。
 */
export function mkdtempHome(prefix: string): { home: string; dsc: string } {
  const home = mkdtempSync(join(tmpdir(), prefix))
  return { home, dsc: join(home, '.dsc') }
}

export interface UiHost {
  proc: ReturnType<typeof spawn>
  url: string
  stderr: string[]
}

/**
 * 起真宿主（`bin/headless.cjs`），等它在 stdout 打印带令牌的界面地址。
 *
 * 90 秒等不到就杀掉并抛错（错误里带 stderr 末尾，红得有原因，不是裸超时）。
 *
 * @param opts.envExtra - 追加进子进程 env（DSC_UI_PORT / DSC_PROFILE / 假 key 等）
 * @param opts.label - 场景名（超时信息里用）
 */
export async function startUiHost(opts: {
  envExtra?: Record<string, string | undefined>
  label?: string
}): Promise<UiHost> {
  const port = await freePort()
  const proc = spawn(process.execPath, [join(ROOT, 'bin', 'headless.cjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSC_UI_SERVER: '1',
      DSC_UI_PORT: String(port),
      DSC_UI_HMR: '0',
      ...opts.envExtra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderr: string[] = []
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk) => {
    stderr.push(
      ...String(chunk)
        .split('\n')
        .filter((line) => line.trim() !== ''),
    )
    if (stderr.length > 80) stderr.splice(0, stderr.length - 80)
  })
  let url: string | null = null
  proc.stdout?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk) => {
    const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(String(chunk))
    if (found !== null) url = found[0]
  })
  for (let waited = 0; waited < 90_000 && url === null && proc.exitCode === null; waited += 250) {
    await sleep(250)
  }
  if (url === null) {
    proc.kill()
    throw new Error(`[${opts.label ?? 'e2e'}] 宿主没给出界面地址（90s）：${stderr.slice(-8).join(' | ')}`)
  }
  return { proc, url, stderr }
}

/** 关掉宿主并等它真的退（boot 探针的教训：不等会让下一段抢同一份 plugins.json 的读写时序）。 */
export async function stopHost(host: UiHost | null): Promise<void> {
  if (host === null || host.proc.exitCode !== null) return
  host.proc.kill()
  for (let waited = 0; waited < 10_000 && host.proc.exitCode === null; waited += 100) await sleep(100)
}

/**
 * 跑一次 Electron 驱动（`scripts/_*.cjs` 的 DRIVER），等它写出读数文件。
 *
 * ELECTRON_RUN_AS_NODE 必须摘掉，否则 electron.exe 退回普通 node，主进程一上来就崩
 * （ui-cordis-test.mjs 踩过的坑）；命令行只带入口地址一个位置参数（多带一个它退出码 127），
 * 产物路径全走环境变量——所以这段外壳与 DRIVER 之间的契约就是：驱动从 env 拿路径。
 *
 * 超时杀掉 Electron 再抛错：留一个窗口在那儿，下次运行会多一份 userData 锁的麻烦。
 */
export async function runElectronDriver(opts: {
  driver: string
  url: string
  resultPath: string
  envExtra: Record<string, string>
  timeoutMs?: number
}): Promise<unknown> {
  const env: Record<string, string | undefined> = { ...process.env, ...opts.envExtra }
  delete env['ELECTRON_RUN_AS_NODE']
  const electron = spawn(ELECTRON, [opts.driver, opts.url], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  try {
    const timeoutMs = opts.timeoutMs ?? 240_000
    for (let waited = 0; waited < timeoutMs && !existsSync(opts.resultPath); waited += 500) {
      await sleep(500)
    }
    if (!existsSync(opts.resultPath)) {
      throw new Error(`驱动没写出读数文件（等了 ${String(timeoutMs)}ms）：${opts.resultPath}`)
    }
    return JSON.parse(readFileSync(opts.resultPath, 'utf8')) as unknown
  } finally {
    try {
      electron.kill()
    } catch {
      // 已经退了
    }
  }
}

/** 新建一个 electron 专属 userData 目录（隔离真身的配置与锁）。 */
export function electronUserData(home: string, label?: string): string {
  return join(home, label === undefined ? 'electron-user-data' : `electron-user-data-${label}`)
}

export interface Freshness {
  ok: boolean
  /** 人类可读的缺失/过期清单；`ok` 为 true 时为空数组。 */
  problems: string[]
}

/**
 * Electron 可执行预检：文件在 ≠ 跑得起来。
 *
 * 实测（2026-11-14）：`.worktrees` 路径下字节级一致的 electron.exe 会被本机的实时防护
 * 间歇拦截，CreateProcess 直接退出码 3——不预检的话，八个文件各自白等 180 秒驱动超时
 * 才红。`--version` 不开窗口（主仓实测 ~2s），15 秒兜底。
 */
function electronRuns(): boolean {
  try {
    const result = spawnSync(ELECTRON, ['--version'], { timeout: 15_000, windowsHide: true })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * e2e 的构建新鲜度预检（collection 阶段跑一次，`describe.skipIf` 消费）。
 *
 * 四层判据：
 *   1. Electron 二进制在（没有它一条真机都跑不了）；
 *   2. `lib/` 与 `lib/ui/` 的产物在；
 *   3. `lib/` 不比 `src/` 旧（core/host/packages/services/contract 五区，口径同 harness）；
 *   4. `lib/ui/` 不比 `ui-shell/` 的源码旧（src 全部 + 构建期输入的清单文件）。
 *
 * 任一条不满足就是「先去构建」的信号，跳过并写原因——e2e 每条 10-60 秒，
 * 红在「跑的是旧产物」上比红在断言上冤得多。
 */
export function probeFreshness(): Freshness {
  const problems: string[] = []

  if (!existsSync(ELECTRON)) {
    problems.push(`Electron 二进制不在（${ELECTRON}）。重装 desktop 依赖或跑 node desktop/node_modules/electron/install.js`)
  } else if (!electronRuns()) {
    problems.push('Electron 二进制在但跑不起来（`--version` 预检非 0 退出，多为实时防护拦截新路径的二进制）。解锁后重试，或先跑主树验证')
  }
  if (!existsSync(CORE_MARKER)) {
    problems.push('lib/ 构建产物不在。先跑 `pnpm run build`')
  }
  if (!existsSync(UI_MARKER)) {
    problems.push('lib/ui/ 界面壳产物不在。先跑 `pnpm run build:ui`')
  }

  // mtime 检查不做提前返回：存在性与新鲜度两类问题一次说全，免得修完一样冒下一个。
  if (existsSync(CORE_MARKER)) {
    const builtCoreAt = statSync(CORE_MARKER).mtimeMs
    let newestSrc = { file: '', at: 0 }
    for (const area of ['core', 'host', 'packages', 'services', 'contract']) {
      const dir = join(ROOT, 'src', area)
      if (!existsSync(dir)) continue
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
        // 测试文件与类型声明不参与构建（同 harness 口径），别让它们唤醒守卫。
        if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.int.spec.ts') || entry.name.endsWith('.e2e.ts') || entry.name.endsWith('.d.ts')) continue
        const file = join(entry.parentPath, entry.name)
        const at = statSync(file).mtimeMs
        if (at > newestSrc.at) newestSrc = { file, at }
      }
    }
    if (newestSrc.at > builtCoreAt) {
      problems.push(
        `lib/ 比 src/ 旧（最新源文件 ${newestSrc.file.slice(ROOT.length).replace(/\\/g, '/')}），内核会跑旧产物。先跑 \`pnpm run build\``,
      )
    }
  }

  if (existsSync(UI_MARKER)) {
    const builtUiAt = statSync(UI_MARKER).mtimeMs
    const uiSources: Array<{ file: string; at: number }> = []
    const uiSrcDir = join(ROOT, 'ui-shell', 'src')
    if (existsSync(uiSrcDir)) {
      for (const entry of readdirSync(uiSrcDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (!/\.(ts|tsx|css|html)$/.test(entry.name)) continue
        if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.spec.tsx') || entry.name.endsWith('.d.ts')) continue
        const file = join(entry.parentPath, entry.name)
        uiSources.push({ file, at: statSync(file).mtimeMs })
      }
    }
    // 构建期输入：别名表、入口 HTML、vite 配置，改了任一个都要重跑 build:ui。
    for (const rel of ['packages.json', 'index.html', 'vite.config.ts', 'build-plugins.mjs']) {
      const file = join(ROOT, 'ui-shell', rel)
      if (existsSync(file)) uiSources.push({ file, at: statSync(file).mtimeMs })
    }
    for (const row of uiSources) {
      if (row.at > builtUiAt) {
        problems.push(
          `lib/ui/ 比 ui-shell 源码旧（${row.file.slice(ROOT.length).replace(/\\/g, '/')}）。先跑 \`pnpm run build:ui\``,
        )
        break
      }
    }
  }

  return { ok: problems.length === 0, problems }
}

/**
 * skip 说明文案：freshness 不通过时打进 stdout，让「为什么整文件跳过」留在输出里。
 *
 * `describe.skipIf` 本身只显示 skipped，不带原因；这个函数把原因写出来补齐。
 */
export function skipReason(fresh: Freshness): string {
  return `[e2e] 跳过本文件（先跑 \`pnpm run build && pnpm run build:ui\`，并确认 desktop 依赖装好）：${fresh.problems.join('；')}`
}
