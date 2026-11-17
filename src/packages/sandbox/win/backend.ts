/**
 * Windows 受限令牌后端的探测与执行器：把 bash 工具的执行体换成
 * `node runner-entry.js … -- <原命令>`，由 runner 用受限令牌真正 spawn 子进程。
 *
 * 为什么换执行体而不是在守卫链上拦：守卫链只拦得住 dsc 自己发起的工具调用，
 * 拦不住命令内部的任意写（`node build.js` 里那行 fs.writeFile）。文件系统的
 * 强制这一层只有换执行体才拿得到：ACL 上的能力 SID 授权 + 受限令牌的
 * WRITE_RESTRICTED pass-2 交集检查，写根之外一律写不进去。
 *
 * 这一层**只管文件系统的写**，三处已知缺口如实写进 `describe()`，绝不假装管住了：
 *   1. 硬链接别名：在写根内建一个指向根外文件的硬链接，写它等于写根外（NTFS 硬链接
 *      不受路径判定约束）；
 *   2. 读不受限：WRITE_RESTRICTED 的 pass-2 只对写生效，读、网络、进程可见性
 *      与普通用户一样；
 *   3. 网络：真管控要「专用账号 + WFP + 白名单代理」那套提权 setup，本层只在
 *      网络开关关时叠一层代理环境变量软墙（codex env.rs 同款），拦不住铁了心的进程。
 *
 * 降级语义（刻意的，不是妥协）：ACL 授权任何一步失败 → 后端当场作废自己
 * （`plan()` 此后返回 null），命令回到策略围栏那条路，并把错误全文报给用户。
 * 半吊子的强制比明说「没强制」危险。
 *
 * @module dsc/core/sandbox/win/backend
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSC_HOME } from '../../../core/path-policy.js'
import type { CommandRunner, SpawnPlan } from '../../../core/tools/command-runner.js'
import { grantAccountAccess, grantWrite, revokeWrite, type GrantOutcome } from './acl.js'
import { type BoundWin32, bindAll, tryLoadFfi } from './ffi.js'
import { resolveRunnerInterpreter } from './interpreter.js'
import { rootWriteSid, tempWriteSid } from './workspace-sid.js'
import { createNetProxy, proxyEnvVars, type NetProxy } from '../net-proxy.js'
import { canonicalizePath, sandboxTmpDir } from '../policy.js'
import { errText as describeError } from '../../../core/err-text.js'

/** 执行器 id（宿主诊断与 `enforcement` 上报用这个键）。 */
export const WINDOWS_TOKEN_RUNNER_ID = 'sandbox-windows-token'

/** runner 自身失败的 stderr 签名：宿主与 win-token 冒烟探针靠它把「runner 挂了」与「命令失败了」分开。 */
export const RUNNER_FAILURE_SIGNATURE = 'dsc-sandbox-run: '

/** 询问顺序：与容器后端同档（策略围栏先问，它之后才轮到换执行体）。 */
const RUNNER_ORDER = 20

/**
 * pty 尺寸的兜底值：与 runner 的缺省一致（`runner-entry.ts` 的 `DEFAULT_PTY_COLS/ROWS`）。
 *
 * 刻意不从 runner-entry 里 import 那两个常量：那个模块的结尾无条件跑 `main()`，
 * 宿主 import 它等于让宿主按自己的 argv 去建令牌——所以数值在这里重复一份，
 * 由集成用例盯住两边不跑偏。
 */
const PTY_DEFAULT_COLS = 120
const PTY_DEFAULT_ROWS = 30

/**
 * 把计划里的尺寸折成一个 runner 认的正整数。
 *
 * runner 的 `--cols/--rows` 只认正整数（`runner-entry.ts` 的解析段），0、负数、小数、
 * NaN 会让它当场以 127 退出；而且 COORD 只有 16 位，超过 65535 会被静默截断。
 * 三类非法值一律当「没给」，回落缺省——工具层已经限过 20–500，这里只做最后一道兜底。
 */
function ptyDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 0xffff) return fallback
  return value
}

/** 授权锁文件目录：同目录并发授权要串行化，锁文件落在 dsc 家目录下。 */
const LOCK_DIR = join(DSC_HOME, 'sandbox', 'locks')

/** 网络开关关闭时叠的代理软墙（照 codex `env.rs` 的取值）。 */
const OFFLINE_ENV: Readonly<Record<string, string>> = {
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  all_proxy: 'http://127.0.0.1:9',
  NO_PROXY: 'localhost,127.0.0.1,::1',
  no_proxy: 'localhost,127.0.0.1,::1',
  PIP_NO_INDEX: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  NPM_CONFIG_OFFLINE: 'true',
  CARGO_NET_OFFLINE: 'true',
  GIT_SSH_COMMAND: 'cmd /c exit 1',
}

/** runner 入口脚本的构建产物（backend 编译后在 lib/ 里与 runner-entry.js 同目录）。 */
function runnerEntryPath(): string {
  return fileURLToPath(new URL('./runner-entry.js', import.meta.url))
}

/**
 * 探一次受限令牌后端可用性：Windows + koffi 装得上 + runner 构建产物在 +
 * `DSC_NODE`（若设了）真的指向一个存在的文件。
 * 不实际建令牌（探测要快且无副作用），真正的失败在 runner 里响亮报出来。
 */
export function probeWindowsToken(): { available: boolean; detail: string } {
  if (process.platform !== 'win32') return { available: false, detail: '非 Windows 平台' }
  const loaded = tryLoadFfi()
  if (!loaded.ok) return { available: false, detail: `Win32 FFI 底座不可用：${loaded.why}` }
  const entry = runnerEntryPath()
  if (!existsSync(entry)) {
    return { available: false, detail: `runner 入口没有构建产物：找不到 ${entry}（先跑 pnpm run build）` }
  }
  // DSC_NODE 是用户手填的解释器逃生口：指错了只有到 spawn 那一刻才会炸，报错还是
  // 「spawn 某某 ENOENT」这种看不出根因的形态。探测阶段就点名它，比等第一条命令
  // 失败再排查便宜得多。空白值等同于没给（与 resolveRunnerInterpreter 的口径一致）
  const nodeOverride = process.env.DSC_NODE?.trim()
  if (nodeOverride !== undefined && nodeOverride !== '' && !existsSync(nodeOverride)) {
    return { available: false, detail: `DSC_NODE 指向的解释器不存在：${nodeOverride}` }
  }
  // 解释器形态只作诊断：Electron 宿主下 runner 靠 ELECTRON_RUN_AS_NODE 才能跑，
  // 用户看到「electron」就该知道这是正常的，「node」则说明宿主是命令行版。
  const { kind } = resolveRunnerInterpreter({
    execPath: process.execPath,
    electron: process.versions.electron !== undefined,
    env: process.env,
  })
  return { available: true, detail: `受限令牌后端可用（koffi FFI + runner 子进程，解释器：${kind}）` }
}

/** 执行器构造入参（路径都要求是 realpath 规范化后的绝对路径）。 */
export interface WindowsTokenRunnerOptions {
  mode: 'read-only' | 'workspace-write'
  /**
   * 挂载时所在会话的工作目录：先把它授权好，第一次调用就不必等 ACL。
   *
   * 它只是**起点**：常驻多会话时每次调用都按 `run.cwd` 现算可写根（2026-10-30 修）。
   */
  cwd: string
  /** 附加可写根。 */
  extraRoots?: readonly string[]
  /** 网络开关（每次都现取，改设置立即生效）。 */
  networkAccess: () => boolean
  /**
   * 网络第二级账号分支（可选，来自 setup 状态文件）：给了它，runner 以专用离线
   * 账号跑命令（LogonUserW + 受限化账号令牌），可写根补账号读写执行 ACE；
   * 网络开关开时起本地白名单代理并把子进程指向它（WFP 已按账号 SID 堵死其余出口）。
   */
  account?: {
    readonly name: string
    readonly sid: string
    readonly dscHome: string
    /** 代理监听端口（与 setup 防火墙放行的端口一致，默认 3128）。 */
    readonly proxyPort: number
  }
  /** 出网白名单现取值（代理用；账号分支且开网时生效）。 */
  networkAllowlist?: () => readonly string[]
  /** 降级与回收失败的一句话，交给插件报给用户。 */
  onDetail?: (message: string) => void
}

/** 执行器句柄：runner 本体 + 收尾 + 一句话说明。 */
export interface WindowsTokenRunnerHandle {
  runner: CommandRunner
  /** 进程收尾：尽力回收临时目录的能力 ACE（工作区/附加根是常驻授权，不回收）。 */
  dispose(): void
  /** 给用户看的一句话：强制了什么、哪些不管。 */
  describe(): string
  /**
   * 网络第二级是否已随本执行器生效（账号分支在位）：插件据此把 enforcement
   * 报成 full（FS 由账号 ACL + 交集双重锁死，网络由 WFP + 白名单代理锁死）。
   */
  readonly networkEnforced: boolean
}

/** 一条目录 ↔ 能力 SID 的配对（`side` 决定它进不进 `--root`，见 `plan`）。 */
interface AuthorizedRoot {
  path: string
  sid: string
  /** root = 工作区/附加根；temp = 该工作区的私有临时目录。 */
  side: 'root' | 'temp'
}

/** 一次调用要授权的目录与它的能力 SID。 */
export interface SandboxWriteRoot {
  path: string
  sid: string
  /** root = 工作区/附加根（常驻授权，不回收）；temp = 该工作区的私有临时目录（收尾回收）。 */
  side: 'root' | 'temp'
}

/**
 * 一次命令调用该授权的可写根（2026-10-30 修：以前按挂载时那个会话钉死）。
 *
 * 常驻多会话时，后台会话的工作目录与当前查看的会话往往不是同一个：钉死之后，
 * 后台会话在自己的工作区里写东西会被 ACL 挡住（错误地当成「越界」），而当前会话的
 * 工作区反倒被永久授权。现在按 `run.cwd` 现算：工作区一个 root SID、它的私有临时目录
 * 一个 temp SID，附加可写根照配置带进来。
 *
 * 附加根里的**相对路径按 `cwd` 解析**（2026-11-17 修 BUG-0004）：策略层
 * （`policy.ts` 的 `createPolicy`）是拿同一个 `canonicalizePath(…, { cwd })` 展开的，
 * 这一层要是照收原始串，`mkdir`/打 ACL 会落到**宿主进程的 cwd**（打包版就是安装目录）——
 * 围栏说「可以写」、系统层仍然拒，还顺手在安装目录旁边造一个目录。两处必须用同一个函数、
 * 同一个 cwd。
 *
 * @param cwd - 这次调用所在会话的工作目录（realpath 后的绝对路径）。
 * @param extraRoots - 配置里的附加可写根（允许相对路径，按 `cwd` 展开）。
 */
export function writeRootsFor(cwd: string, extraRoots: readonly string[] = []): SandboxWriteRoot[] {
  const trim = (path: string): string => path.replace(/[\\/]+$/, '')
  const list: SandboxWriteRoot[] = []
  /** 同一个目录只出现一次：尾巴分隔符不同、或附加根与工作区重合，都算同一个。 */
  const add = (path: string, side: 'root' | 'temp'): void => {
    const key = path.toLowerCase()
    if (list.some((item) => item.path.toLowerCase() === key)) return
    list.push({ path, sid: side === 'root' ? rootWriteSid(path) : tempWriteSid(path), side })
  }
  const root = trim(cwd)
  add(root, 'root')
  add(sandboxTmpDir(DSC_HOME, root), 'temp')
  for (const extra of extraRoots) {
    const trimmed = trim(extra.trim())
    if (trimmed === '') continue
    // 绝对路径也过一遍同一个函数：大小写、8.3 短名、符号链接拼法不同会派生出另一个 SID 身份，
    // 而 runner 那边是按 realpath 复算的（`--root` 里 SID 与路径对不上会直接退 127）。
    const resolved = canonicalizePath(trimmed, { win32: process.platform === 'win32', cwd: root })
    add(trim(resolved.path), 'root')
  }
  return list
}

/**
 * 建一个受限令牌执行器。
 *
 * 授权是**惰性**的：第一次 `plan()` 才给目录打 ACL（大树首次传播要几十秒，
 * 挂载时不做）。按路径缓存结果，同一目录只授权一次；任一目录失败就整体降级。
 */
export function createWindowsTokenRunner(options: WindowsTokenRunnerOptions): WindowsTokenRunnerHandle {
  // 目录清单：工作目录、私有临时目录、附加可写根（工作区与附加根用 rootWriteSid，
  // temp 用 tempWriteSid，两种派生前缀不同，永不撞号）。`side` 记着它们该不该进 --root：
  // temp 只走 --temp，混进 --root 会让 runner 复算失败（见 plan 里那段注释）
  const roots: AuthorizedRoot[] = []
  /** 已经授权过的临时目录（收尾时逐个回收，见 dispose）。 */
  const tempPaths = new Set<string>()
  const push = (path: string, sid: string, side: 'root' | 'temp'): void => {
    const key = path.replace(/[\\/]+$/, '').toLowerCase()
    if (roots.some((root) => root.path.replace(/[\\/]+$/, '').toLowerCase() === key)) return
    roots.push({ path, sid, side })
    if (side === 'temp') tempPaths.add(path)
  }
  /**
   * 把一次调用的可写根补进清单（常驻多会话：每个会话的工作目录各授权一次）。
   * 已经在清单里的路径跳过，所以每次调用都调它也只有第一次付 ACL 的成本。
   */
  const scopeOf = (cwd: string): void => {
    if (options.mode !== 'workspace-write') return
    for (const root of writeRootsFor(cwd, options.extraRoots ?? [])) push(root.path, root.sid, root.side)
  }
  scopeOf(options.cwd)
  // read-only 刻意不做任何 ACL 授权：该档令牌不含能力 SID，写本来就全拒；
  // 授权只会「永久改用户工作区的 ACL + 强制标签」，是纯副作用零收益，违背最小惊扰

  const entry = runnerEntryPath()
  const grants = new Map<string, GrantOutcome>()
  let bound: BoundWin32 | null = null
  let authorized = false
  let degraded = false
  /** 本地白名单代理（账号分支且开网时惰性起，dispose 时收）。 */
  let proxy: NetProxy | null = null

  /**
   * 惰性物化授权：true = 可以换执行体，false = 已降级（此后 plan 一律返回 null）。
   *
   * 不能「授权过一次就短路」：清单会随着不同会话的调用继续增长（见 scopeOf），
   * 新补进来的根必须在这一次调用之前授权好。已授权的根在 grants 里有记录，重复调用只花几次查找。
   *
   * 授权前自己把**私有临时目录**建出来（`mkdirSync`）：ACL 能打的只有真实存在的路径，而那个目录
   * 在第一次调用之前谁都没建过。工作区与附加根不替用户建——它们是既有路径，配错了要让人看见。
   */
  const ensureAuthorized = (): boolean => {
    if (degraded) return false
    if (roots.length === 0) {
      // read-only：没有可授权目录，连 FFI 都不必加载（dispose 靠 bound===null 短路）
      authorized = true
      return true
    }
    if (authorized && roots.every((root) => grants.has(root.path))) return true
    try {
      if (bound === null) {
        const loaded = tryLoadFfi()
        if (!loaded.ok) throw new Error(`Win32 FFI 底座不可用：${loaded.why}`)
        bound = bindAll(loaded.ffi)
        mkdirSync(LOCK_DIR, { recursive: true })
      }
      const boundNow = bound
      for (const root of roots) {
        if (grants.has(root.path)) continue
        // 授权的前提是目录**真存在**：GetNamedSecurityInfoW 对不存在的路径返回 Win32 错误 2，
        // 整条后端当场降级。而私有临时目录 `<DSC_HOME>/sandbox/tmp/<工作区哈希>` 在第一次跑命令
        // 之前没有任何人建过（宿主建的临时目录带会话 id，是另一个路径），所以这一格由我们自己建
        // （2026-11-17 修 BUG-0001：全新安装后第一次跑命令，沙箱直接失效）。
        //
        // 只建 temp：工作区与附加根**都是既有路径**（工作区是用户打开的目录，附加根是用户配的
        // 可写目录）。替它们建目录属于多管闲事——配错的路径会被我们悄悄造出来、打成可继承的
        // 低完整性标签，而 root 侧的授权不回收；配成相对路径时还会按宿主进程的 cwd 落点，
        // 与策略层按会话 cwd 解析的口径对不上。它们的目录不存在就照旧让这次授权失败并降级，
        // 那是用户配置的问题，得让他看见。
        if (root.side === 'temp') {
          try {
            mkdirSync(root.path, { recursive: true })
          } catch (error) {
            throw new Error(`建可写根「${root.path}」（能力 SID ${root.sid}）失败：${describeError(error)}`)
          }
        }
        try {
          grants.set(root.path, grantWrite(boundNow, root.path, root.sid, LOCK_DIR))
        } catch (error) {
          throw new Error(`给可写根「${root.path}」（能力 SID ${root.sid}）打 ACL 失败：${describeError(error)}`)
        }
      }
      // 账号分支：每个可写根再补一条「账号 SID 读写执行」ACE——专用账号没有当前
      // 用户的权限，pass-1（普通 SID 检查）靠它才过得去；pass-2 仍走上面的能力 SID
      if (options.account !== undefined) {
        for (const root of roots) {
          grants.set(`${root.path}#account`, grantAccountAccess(boundNow, root.path, options.account.sid, LOCK_DIR))
        }
      }
      authorized = true
      return true
    } catch (error) {
      degraded = true
      options.onDetail?.(`受限令牌后端已降级为策略围栏（不再换执行体）：${describeError(error)}`)
      return false
    }
  }

  /**
   * 账号分支的网络出口：起本地白名单代理并返回要注入的环境变量。
   * 代理起不来时返回 null（调用方回落软墙）——此时 WFP 把账号的一切出口堵死，
   * 子进程等于离线，这是 fail-closed 的正确姿态，绝不静默放开。
   */
  const ensureProxy = async (): Promise<Record<string, string> | null> => {
    if (proxy !== null) return proxyEnvVars(proxy.url)
    if (options.account === undefined) return null
    try {
      proxy = await createNetProxy({
        port: options.account.proxyPort,
        online: () => options.networkAccess(),
        allowlist: () => options.networkAllowlist?.() ?? [],
      })
      options.onDetail?.(`出网白名单代理已起：${proxy.url}（账号的其余出口已被 WFP 堵死）`)
      return proxyEnvVars(proxy.url)
    } catch (error) {
      options.onDetail?.(`白名单代理起不来（账号出网将被 WFP 全拦，子进程等于离线）：${describeError(error)}`)
      return null
    }
  }

  const runner: CommandRunner = {
    id: WINDOWS_TOKEN_RUNNER_ID,
    order: RUNNER_ORDER,
    async plan(run, current): Promise<SpawnPlan | null> {
      // 先按这次调用所在会话的工作目录补齐可写根（常驻多会话：每个工作区各授权一次），
      // 再物化授权——顺序反了就会用「上一个会话的工作区」去跑这一条命令。
      scopeOf(run.cwd)
      if (!ensureAuthorized()) return null
      // 已经是本后端换过的计划（别人套第二次）：不套两层。
      // 只认 args[0] 是我们的入口：`file` 不可靠——Electron 宿主下它是 electron.exe，
      // 用户设了 DSC_NODE 时又是另一个路径，拿 file 跟 process.execPath 比会漏判。
      if (current.args[0] === entry) return null

      // 解释器先定：它给出的 env 里可能带着 ELECTRON_RUN_AS_NODE，
      // 网络变量必须叠在它之上，顺序反了就会把这个变量顶掉、runner 起不来
      const interpreter = resolveRunnerInterpreter({
        execPath: process.execPath,
        electron: process.versions.electron !== undefined,
        env: current.env,
      })
      // 网络：账号分支开网走白名单代理（WFP 只给账号留了回环代理口），关网或
      // 没有账号分支时叠一级软墙；不改调用方给的 env 对象，改复制品
      let env = interpreter.env
      const netOn = options.networkAccess()
      if (options.account !== undefined) {
        env = { ...env, ...(netOn ? (await ensureProxy()) ?? OFFLINE_ENV : OFFLINE_ENV) }
      } else if (!netOn) {
        env = { ...env, ...OFFLINE_ENV }
      }
      const args = [
        entry,
        '--mode', options.mode,
        // 临时目录按这次调用的工作区取（与 roots 里的 temp 同源）
        '--temp', sandboxTmpDir(DSC_HOME, run.cwd.replace(/[\\/]+$/, '')),
        // 只把**常驻**可写根（工作区 / 附加根）传 --root。私有临时目录绝不能混进来：
        // 清单是跨会话累积的，一旦把别的会话的 temp 也当 --root 传过去，runner 会拿
        // rootWriteSid 去复算那个路径 → 「SID 与路径对不上」→ 第二个工作区直接退 127。
        // temp 的唯一来源是 --temp，runner 自己按 tempWriteSid 把它加进 restricting 列表
        ...roots.filter((root) => root.side === 'root').flatMap((root) => ['--root', `${root.sid}=${root.path}`]),
        ...(options.account === undefined ? [] : ['--account', options.account.name, '--dsc-home', options.account.dscHome]),
        // 真终端：工具在计划里声明了 tty 才加这三项。runner 的契约是「--cols/--rows
        // 必须配 --pty」，所以它们只能跟 --pty 一起出现或一起不出现；非 tty 的计划
        // 在这里一个字节都不改（走原来的三对管道）
        ...(current.tty === true
          ? [
              '--pty',
              '--cols', String(ptyDimension(current.cols, PTY_DEFAULT_COLS)),
              '--rows', String(ptyDimension(current.rows, PTY_DEFAULT_ROWS)),
            ]
          : []),
        '--',
        current.file,
        ...current.args,
      ]
      // 普通解释器子进程：不需要自定义 spawn，file/args/env/cwd 表达得下。
      // file 用解释器算出来的值：Electron 宿主下是 electron.exe（配合 env 里的
      // ELECTRON_RUN_AS_NODE），设了 DSC_NODE 时是用户指定的 node。
      return { ...current, file: interpreter.file, args, env, cwd: run.cwd }
    },
  }

  return {
    runner,
    dispose(): void {
      // 代理先收（在途连接断掉，端口让出来）
      proxy?.close()
      proxy = null
      // 临时目录是会话级授权：回收能力 ACE。工作区与附加根是常驻授权，不回收。
      // 这里是尽力而为——回收失败只记一句，绝不影响会话结果（残留的假 SID ACE 惰性无害，
      // 没有任何真实账号持有它）
      if (bound === null) return
      try {
        // 每个工作区一个临时目录，逐个回收
        for (const temp of tempPaths) revokeWrite(bound, temp, tempWriteSid(temp), LOCK_DIR)
      } catch (error) {
        options.onDetail?.(`回收临时目录授权失败（不影响本次结果）：${describeError(error)}`)
      }
    },
    describe(): string {
      const net = options.account !== undefined
        ? '网络：账号分支在位——出网只过白名单代理，其余出口被 WFP 按账号 SID 堵死'
        : '网络真管控要第二级提权 setup（本层只在断网时叠代理环境变量软墙）'
      if (roots.length === 0) {
        return '文件系统写：read-only 档，令牌不含能力 SID，任何目录都写不了；未对工作区做任何 ACL 改动；读与进程可见性不受限'
      }
      const list = roots.map((root) => root.path).join('、')
      const readGap = options.account !== undefined
        ? '读与进程可见性被账号权限限死（账号只有可写根内的读执行）'
        : '读与进程可见性一概不受限'
      return `文件系统写：只允许写 ${list}（ACL 能力 SID + WRITE_RESTRICTED 交集检查，` +
        `命令在受限令牌的 runner 子进程里跑）；已知缺口：硬链接别名可指到写根外仍能写、` +
        `${readGap}；${net}`
    },
    networkEnforced: options.account !== undefined,
  }
}
