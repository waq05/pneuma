/**
 * 沙箱 runner 子进程入口：dsc 宿主 spawn 这个脚本（普通权限），由它在**本进程内**
 * 构造受限令牌并 `CreateProcessAsUserW` 真正的命令。
 *
 * 为什么隔一层 runner（三个理由都有实测依据）：
 *   1. `lpEnvironment` 经 koffi 传显式环境块必报 ERROR_INVALID_PARAMETER——子进程环境
 *      只能靠继承；TMP/TEMP 重定向要在「不污染宿主环境」的前提下生效，只能由一个
 *      短命进程改自己再 spawn（runner 干的就是这个）；
 *   2. runner 忽略 CTRL+C（SetConsoleCtrlHandler），保证被中断时能把子进程的收尾做完、
 *      把退出码原样镜像回去；
 *   3. 作业对象句柄随 runner 死亡而关闭（KILL_ON_JOB_CLOSE）：宿主 taskkill 杀 runner
 *      就等于整棵受限子树被内核收掉，不留孤儿。
 *
 * argv 契约（宿主负责拼，runner 负责逐项验）：
 *   node runner-entry.js --mode <read-only|workspace-write> --temp <dir>
 *     [--timeout <ms>] [--root <sid>=<dir> …] [--pty] [--cols <n>] [--rows <n>] -- <argv…>
 *
 * `--pty`（默认关）= 用 ConPTY 跑命令（全屏程序、真 tty）。为什么必须在 runner 里建：
 * 受限令牌带 WRITE_RESTRICTED，子进程自己调 CreatePseudoConsole 会在 `\\.\pipe\conpty-*`
 * 上报 EPERM；只有这一层不受限。子进程靠 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 挂上去，
 * 它自己一根管道都不用开（照 codex 的 `windows-sandbox-rs/src/conpty/mod.rs`）。
 *
 * `--timeout` 是 runner 自己的兜底：宿主那边杀掉 runner 虽然也能靠作业对象收掉整棵
 * 子树，但那条路要求宿主自己活着、且它拿到的超时时间与这里的一致；命令卡死这件事
 * 由真正持有子进程的这一层负责，退出码 124（与 GNU timeout 同义）告诉调用方
 * 「不是命令自己失败，是我们掐的」。
 *
 * 失败语义：runner 自身的问题打一行 `dsc-sandbox-run: …` 到 stderr 并退出 127；
 * 受限命令的退出码按**全宽 uint32** 原样镜像（NTSTATUS 不做有符号重映射）。
 *
 * 几处踩过坑的硬约束（都别改）：
 *   - 绝不用 CREATE_NO_WINDOW / CREATE_NEW_CONSOLE：受限令牌下 DLL 初始化会死
 *     0xC0000142，只能 STARTF_USESHOWWINDOW + SW_HIDE；
 *   - 排水必须先启动再 WaitForSingleObject（两者并行）：排水要等对端 EOF，而 EOF
 *     只在子进程退出后才来；先 await 排水则卡死的命令永远走不到超时分支；反过来说
 *     排水停下来等 wait 也不行——管道缓冲填满时子进程阻塞在写、永不退出，双方死锁；
 *   - AssignProcessToJobObject 必须在 ResumeThread **之前**：不受作业保护的受限进程
 *     一秒都不许跑。
 *
 * @module dsc/core/sandbox/win/runner-entry
 */
import {
  CREATE_SUSPENDED,
  JOBOBJ_LIMIT_FLAGS_OFFSET,
  JOBOBJECT_EXTENDED_LIMIT_SIZE,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  JobObjectExtendedLimitInformation,
  LOGON32_LOGON_INTERACTIVE,
  LOGON32_PROVIDER_DEFAULT,
  PI_OFFSETS,
  PROCESS_INFORMATION_SIZE,
  SI_OFFSETS,
  STARTF_USESHOWWINDOW,
  STARTF_USESTDHANDLES,
  STARTUPINFOW_SIZE,
  SW_HIDE,
  WAIT_OBJECT_0,
} from './abi.js'
import {
  type BoundWin32,
  type WinFfi,
  addressOf,
  bindAll,
  byteArea,
  isBrokenPipe,
  loadFfi,
  slotUint32,
  slotUintPtr,
  throwLastError,
  throwWin32,
} from './ffi.js'
import { buildRestrictedToken, type RestrictedToken } from './token.js'
import { rootWriteSid, tempWriteSid, verifySidForPath } from './workspace-sid.js'
import { accountBlobPath, unprotectSecret } from './account.js'
import { readFileSync } from 'node:fs'
import { utf16Buffer } from './utf16.js'

/** runner 自身失败签名（宿主诊断认这一行）。 */
export const RUNNER_SIGNATURE = 'dsc-sandbox-run: '
/** runner 自身失败的退出码。 */
export const RUNNER_EXIT_CODE = 127
/**
 * 超时分支的退出码：124 与 GNU `timeout(1)` 同义（命令因超时被终止）。
 * 不能沿用被杀进程的退出码——那样调用方分不出「命令自己失败了」与「我们把它掐了」。
 */
export const TIMEOUT_EXIT_CODE = 124

/** WaitForSingleObject 的「等到超时」返回值（0x102）。 */
const WAIT_TIMEOUT = 0x102

/** 管道排水每次最多读的字节数（64KB，够填一页还不够撑爆内存）。 */
const DRAIN_CHUNK = 65536

/** SetHandleInformation 的「可继承」标志位。 */
const HANDLE_FLAG_INHERIT = 1

// ── --pty（ConPTY）的 ABI 常量 ──────────────────────────────────────────────
// 都不放 abi.ts：那条文件是沙箱内核与探针共用的冻结契约，这一批的可写范围只有
// ffi.ts / runner-entry.ts，多一个导出就多一处别人依赖的东西。

/** STARTUPINFOEXW 在 x64 上 112 字节 = STARTUPINFOW(104) + lpAttributeList(8)。 */
const STARTUPINFOEXW_SIZE = 112
/** lpAttributeList 在 STARTUPINFOEXW 里的偏移（紧跟 STARTUPINFOW 的三个句柄）。 */
const STARTUPINFOEX_LPATTRIBUTELIST_OFFSET = 104
/**
 * 创建标志：启动信息按 STARTUPINFOEXW 解释。
 * 少了这一位，`lpAttributeList` 会被**静默忽略**——命令照跑，就是没有 pty。
 */
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
/** 进程属性：把新建进程挂到某个 ConPTY 上（HPCON 作为属性值）。 */
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
/**
 * STARTF_USESTDHANDLES 的三个句柄填这个值。
 *
 * 刻意不把 pty 的两根管道当 STD 句柄传（实测）：那样传子进程拿到的是管道，
 * `process.stdout.isTTY` 为 undefined、全屏程序的输出也走不到 pty；填 INVALID 值、
 * 同时 `bInheritHandles=0`，标准句柄才由 ConPTY 接管（isTTY=true）。
 */
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn
/** `--pty` 的默认列数。 */
export const DEFAULT_PTY_COLS = 120
/** `--pty` 的默认行数。 */
export const DEFAULT_PTY_ROWS = 30
/**
 * 子进程退出后，pty 输出还要再收多久的空读才算收干净（毫秒档）。
 *
 * ConPTY 在子进程退出后**不会**给 conout 管道 EOF（实测 PeekNamedPipe 一直返回
 * 「0 字节可读」而不是 ERROR_BROKEN_PIPE），所以「退出 + 连续空读超过这个窗口」才是终点；
 * 只等 EOF 会永远等下去。
 */
const PTY_DRAIN_QUIET_MS = 100
/** pty 轮询的让步间隔（毫秒）。 */
const PTY_POLL_MS = 5
/**
 * 每次 WaitForSingleObject 的等待片长（毫秒），PTY 与非 PTY 两条路共用。
 *
 * 不能一次等到底：`waitForSingleObject` 是**同步**的 FFI 调用，等 20 秒就冻住事件循环
 * 20 秒——排水拿不到 CPU（管道缓冲只有 4KB，填满后子进程阻塞在写、永不退出，`wait`
 * 也永不返回，这就是 >4KB 输出直接死锁的成因），stdin 泵也收不到字节（Ctrl+C 永远
 * 写不进去，中断等于失效）。切成 50ms 一片、片间把事件循环让出去，既保持「等到退出 /
 * 到点 124」的语义，又让两个循环真的并行跑。
 */
const WAIT_SLICE_MS = 50

/** 解析后的 runner 入参。 */
export interface RunnerArgs {
  mode: 'read-only' | 'workspace-write'
  /** 沙箱私有临时目录（runner 会把它设成自己的 TMP/TEMP）。 */
  tempDir: string
  /** 授权过的可写根：SID ↔ 路径成对（只装 `--root` 的工作区/附加根；temp 的 SID 由 main 另派）。 */
  roots: ReadonlyArray<{ sid: string; path: string }>
  /**
   * 受限命令的墙钟超时（毫秒）；0 = 不限（默认）。
   *
   * 默认不限是刻意的：长跑的构建/测试本来就可能跑几十分钟，runner 自己猜一个上限
   * 只会误杀；要不要设、设多少，由调用方一次性决定。
   */
  timeoutMs: number
  /**
   * 网络第二级账号分支（可选）：`--account <名> --dsc-home <目录>` 成对给。
   * 给了就以专用离线账号跑命令：解密 account.bin → LogonUserW → 受限化账号令牌。
   */
  account?: { name: string; dscHome: string }
  /**
   * `--pty` 的开关与窗口尺寸（默认关）。
   *
   * 关着的时候走原来的三对管道；开着走 ConPTY（`runPtyChild`）。尺寸只在 pty 模式有意义，
   * 所以给了 `--cols`/`--rows` 却没给 `--pty` 必须报错，不能让人以为它生效了。
   */
  pty?: { cols: number; rows: number }
  /** `--` 之后的受限命令 argv。 */
  childArgv: readonly string[]
}

/** 严格解析并校验 argv：任何不认识、缺项、对不上号的输入都算 runner 失败，绝不猜。 */
export function parseRunnerArgs(argv: readonly string[]): RunnerArgs {
  let mode: RunnerArgs['mode'] | undefined
  let tempDir: string | undefined
  let timeoutMs: number | undefined
  let account: { name: string; dscHome: string } | undefined
  let dscHome: string | undefined
  let ptySeen = false
  let cols: number | undefined
  let rows: number | undefined
  const roots: Array<{ sid: string; path: string }> = []

  const separator = argv.indexOf('--')
  if (separator < 0) throw new Error('argv 缺少 `--` 分隔符（后面必须跟受限命令）')
  const flags = argv.slice(0, separator)
  const childArgv = argv.slice(separator + 1)
  if (childArgv.length === 0) throw new Error('`--` 之后没有受限命令')
  if (childArgv[0] === undefined || childArgv[0] === '') throw new Error('`--` 之后的第一个参数必须是非空可执行文件名')

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === '--mode') {
      const value = flags[++index]
      if (value !== 'read-only' && value !== 'workspace-write') {
        throw new Error(`--mode 只认 read-only / workspace-write，收到「${String(value)}」`)
      }
      mode = value
      continue
    }
    if (flag === '--temp') {
      const value = flags[++index]
      if (value === undefined || value === '') throw new Error('--temp 需要一个非空目录')
      // 同一个 flag 给两次是调用方 bug：静默取后者等于悄悄换了 TMP/TEMP 落点
      if (tempDir !== undefined) throw new Error('--temp 给重复了')
      tempDir = value
      continue
    }
    if (flag === '--timeout') {
      const value = flags[++index]
      // 缺值与 `--timeout --` 都要拦在这里：`--` 会被当成值（正则不认），报错里带上原值
      if (value === undefined) throw new Error('--timeout 需要一个毫秒数（0 = 不限）')
      // 只认非负十进制整数：`-1`、`1e3`、`abc`、`1000ms` 全部拦下。
      // 放它们过去的话，koffi 会把它当 uint32 强转（-1 → 4294967295 = INFINITE），
      // 静默变成「不限」，与调用方的意图正好相反
      if (!/^\d+$/.test(value)) {
        throw new Error(`--timeout 只认非负十进制整数（毫秒），收到「${value}」`)
      }
      if (timeoutMs !== undefined) throw new Error('--timeout 给重复了')
      timeoutMs = Number(value)
      continue
    }
    if (flag === '--root') {
      const pair = flags[++index]
      if (pair === undefined) throw new Error('--root 需要 <sid>=<dir>')
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new Error(`--root 的值要写成 <sid>=<dir>，收到「${pair}」`)
      const sid = pair.slice(0, eq)
      const path = pair.slice(eq + 1)
      if (path === '') throw new Error(`--root 的目录是空的：「${pair}」`)
      roots.push({ sid, path })
      continue
    }
    if (flag === '--account') {
      const value = flags[++index]
      if (value === undefined || value === '') throw new Error('--account 需要一个账号名')
      if (account !== undefined) throw new Error('--account 给重复了')
      account = { name: value, dscHome: '' }
      continue
    }
    if (flag === '--dsc-home') {
      const value = flags[++index]
      if (value === undefined || value === '') throw new Error('--dsc-home 需要一个目录')
      if (dscHome !== undefined) throw new Error('--dsc-home 给重复了')
      dscHome = value
      continue
    }
    if (flag === '--pty') {
      // 不带值：`--pty true` 这种写法会被当成「不认识的参数 true」拦下，不猜
      if (ptySeen) throw new Error('--pty 给重复了')
      ptySeen = true
      continue
    }
    if (flag === '--cols' || flag === '--rows') {
      const target = flag === '--cols' ? '列数' : '行数'
      const value = flags[++index]
      if (value === undefined) throw new Error(`${flag} 需要一个正整数（${target}）`)
      // 只认正整数：0 与负数会被 koffi 按 int16 强转成怪值，`abc` 更是直接 NaN
      if (!/^\d+$/.test(value) || Number(value) === 0) {
        throw new Error(`${flag} 只认正整数（${target}），收到「${value}」`)
      }
      if (flag === '--cols') {
        if (cols !== undefined) throw new Error('--cols 给重复了')
        cols = Number(value)
        continue
      }
      if (rows !== undefined) throw new Error('--rows 给重复了')
      rows = Number(value)
      continue
    }
    throw new Error(`不认识的 runner 参数：「${flag}」`)
  }
  if (mode === undefined) throw new Error('缺少 --mode')
  if (tempDir === undefined) throw new Error('缺少 --temp')
  if (mode === 'workspace-write' && roots.length === 0) {
    throw new Error('workspace-write 模式至少要有一个 --root（可写根）')
  }
  // 账号分支成对校验：只给 --account 不给 --dsc-home（或反过来）都找不到密码文件，必拦
  if (account !== undefined || dscHome !== undefined) {
    if (account === undefined || dscHome === undefined) {
      throw new Error('--account 与 --dsc-home 必须成对给（密码文件按 <dsc-home>/sandbox/account.bin 定位）')
    }
    account = { name: account.name, dscHome }
  }
  // 尺寸是 pty 专用的：没开 pty 却给了尺寸，说明调用方以为它生效了，必须拦
  if (!ptySeen && (cols !== undefined || rows !== undefined)) {
    throw new Error('--cols/--rows 只对 --pty 有效：没有给 --pty，尺寸不会生效')
  }

  // SID ↔ 路径逐对复算：调用方把 SID 拼错就等于凭空多一个可写根（受限令牌的
  // restricting 列表按 SID 写死），必须在这里拦死。
  //
  // `--root` 只装工作区 / 附加根，**固定**按 rootWriteSid 口径复算：temp 目录的唯一
  // 来源是 `--temp`，由 main 自己派 tempWriteSid 加进 restricting 列表。以前这里靠
  // `samePath(root.path, tempDir)` 猜「这一条是不是 temp」，多工作区时会把它会话的
  // temp 目录按 root 口径复算 → 「SID 与路径对不上」→ 整条命令退 127
  for (const root of roots) {
    if (!verifySidForPath(root.sid, root.path, 'root')) {
      throw new Error(
        `--root 的 SID 与路径对不上（${root.path} 该派生 root 形状的 SID ${rootWriteSid(root.path)}，实际收到 ${root.sid}）`,
      )
    }
  }

  // temp 与每条可写根的双向不相交：可继承 ACE 会把能力串出去，这是真实的逃逸面
  for (const root of roots) {
    if (samePath(root.path, tempDir)) continue
    if (strictlyInside(tempDir, root.path) || strictlyInside(root.path, tempDir)) {
      throw new Error(`临时目录与可写根相交（${tempDir} ⊂⊃ ${root.path}）：可继承授权会串能力，拒绝这组参数`)
    }
  }

  // 重复的可写根：同一目录授权两次无害，但说明调用方拼重了，直接报出来
  const seen = new Set<string>()
  for (const root of roots) {
    const key = root.path.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) throw new Error(`--root 给重复了：「${root.path}」`)
    seen.add(key)
  }
  // temp 目录与某条 --root 是同一路径：现在 temp 只走 --temp，还把它写进 --root 说明
  // 调用方还在按旧契约拼参数——temp 的 SID 会在 main 里另派一份，这里直接拒，不猜
  if (roots.some((root) => samePath(root.path, tempDir))) {
    throw new Error(`--root 里不许出现临时目录「${tempDir}」：temp 只走 --temp`)
  }
  // ⚠ account 必须出现在返回值里：漏了它的话账号分支会被「静默跳过」——
  // 命令照常以当前用户受限令牌跑、退出码一切正常，网络第二级等于悄悄失效
  return {
    mode,
    tempDir,
    roots,
    timeoutMs: timeoutMs ?? 0,
    ...(account === undefined ? {} : { account }),
    ...(ptySeen ? { pty: { cols: cols ?? DEFAULT_PTY_COLS, rows: rows ?? DEFAULT_PTY_ROWS } } : {}),
    childArgv,
  }
}

/** 路径等价判定：大小写不敏感、末尾分隔符不算数（Windows 口径）。 */
function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()
}

/** 大小写不敏感的「真包含」：child 在 parent 里且不是 parent 本身（按分隔符边界判）。 */
export function strictlyInside(child: string, parent: string): boolean {
  const outer = parent.replace(/[\\/]+$/, '').toLowerCase()
  const inner = child.replace(/[\\/]+$/, '').toLowerCase()
  if (outer === inner) return false
  return inner.startsWith(`${outer}\\`) || inner.startsWith(`${outer}/`)
}

/**
 * Windows argv 引号化（CommandLineToArgvW 规则）：
 * 空串或含空白/引号才加引号；引号前的反斜杠翻倍再加一个转义反斜杠；
 * 结尾的连续反斜杠翻倍（它们在收尾引号前面）。
 */
export function quoteArgv(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let backslashes = 0
  for (const character of arg) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  out += '\\'.repeat(backslashes * 2) + '"'
  return out
}

/** 手工打包 STARTUPINFOW（104 字节，偏移见 abi.SI_OFFSETS）。 */
function packStartupInfo(stdinRead: number, stdoutWrite: number, stderrWrite: number): Buffer {
  const info = Buffer.alloc(STARTUPINFOW_SIZE)
  info.writeUInt32LE(STARTUPINFOW_SIZE, SI_OFFSETS.cb)
  info.writeUInt32LE(STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, SI_OFFSETS.dwFlags)
  info.writeUInt16LE(SW_HIDE, SI_OFFSETS.wShowWindow)
  info.writeBigUInt64LE(BigInt(stdinRead), SI_OFFSETS.hStdInput)
  info.writeBigUInt64LE(BigInt(stdoutWrite), SI_OFFSETS.hStdOutput)
  info.writeBigUInt64LE(BigInt(stderrWrite), SI_OFFSETS.hStdError)
  return info
}

/** 手工打包 JOBOBJECT_EXTENDED_LIMIT_INFORMATION（144 字节，只设 KILL_ON_JOB_CLOSE）。 */
function packJobLimits(): Buffer {
  const limits = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_SIZE)
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJ_LIMIT_FLAGS_OFFSET)
  return limits
}

/**
 * 读管道直到对端关闭（PeekNamedPipe 非阻塞探测 + 有数据才 ReadFile）。
 *
 * 为什么不用阻塞 ReadFile：stdout 与 stderr 要同时排，先排 A 会等 B 写满缓冲；
 * PeekNamedPipe 轮询 + 2ms 让步的写法在 dsh 上实证过，不烧 CPU 也不丢数据。
 */
async function drainPipe(bound: BoundWin32, handle: number, sink: NodeJS.WriteStream): Promise<void> {
  const available = slotUint32(bound)
  const area = byteArea(bound, DRAIN_CHUNK)
  for (;;) {
    if (Number(bound.peekNamedPipe(handle, null, 0, null, available.slot, null)) === 0) {
      const code = Number(bound.getLastLastError()) >>> 0
      if (isBrokenPipe(code)) return
      throwWin32(bound, 'PeekNamedPipe', code)
    }
    const count = available.get()
    if (count === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2))
      continue
    }
    const read = slotUint32(bound)
    if (Number(bound.readFile(handle, area.ptr, Math.min(count, DRAIN_CHUNK), read.slot, null)) === 0) {
      const code = Number(bound.getLastLastError()) >>> 0
      if (isBrokenPipe(code)) return
      throwWin32(bound, 'ReadFile', code)
    }
    const got = read.get()
    if (got === 0) return
    sink.write(Buffer.from(area.bytes().subarray(0, got)))
  }
}

/**
 * 打包 COORD（4 字节，X@0、Y@2）成 uint32：x64 下 4 字节按值结构体与整数同一个寄存器。
 *
 * 这是 CreatePseudoConsole / ResizePseudoConsole 唯一的入参结构体，没有别的传法。
 */
function packCoord(cols: number, rows: number): number {
  return ((cols & 0xffff) | ((rows & 0xffff) << 16)) >>> 0
}

/**
 * 手工打包 STARTUPINFOEXW（112 字节）：在 STARTUPINFOW 后面补 lpAttributeList。
 *
 * 三个标准句柄刻意填 INVALID_HANDLE_VALUE 且创建时 `bInheritHandles=0`——见
 * `INVALID_HANDLE_VALUE` 的注释：传 pty 那两根管道会让子进程拿管道当 STD，isTTY 就没了。
 */
function packStartupInfoEx(bound: BoundWin32, attributeList: Buffer): Buffer {
  const info = Buffer.alloc(STARTUPINFOEXW_SIZE)
  info.writeUInt32LE(STARTUPINFOEXW_SIZE, SI_OFFSETS.cb)
  // 只带 STARTF_USESTDHANDLES：EXTENDED_STARTUPINFO_PRESENT 是「创建标志」，混进 dwFlags
  // 不是它该待的地方（要它生效只能放 dwCreationFlags）
  info.writeUInt32LE(STARTF_USESTDHANDLES, SI_OFFSETS.dwFlags)
  info.writeBigUInt64LE(INVALID_HANDLE_VALUE, SI_OFFSETS.hStdInput)
  info.writeBigUInt64LE(INVALID_HANDLE_VALUE, SI_OFFSETS.hStdOutput)
  info.writeBigUInt64LE(INVALID_HANDLE_VALUE, SI_OFFSETS.hStdError)
  info.writeBigUInt64LE(BigInt(addressOf(bound, attributeList)), STARTUPINFOEX_LPATTRIBUTELIST_OFFSET)
  return info
}

/**
 * pty 输出排水：**不能**复用 `drainPipe`。
 *
 * 区别只有一个但致命：ConPTY 在子进程退出后不会给 conout 管道 EOF（实测 PeekNamedPipe 一直
 * 返回「可读 0 字节」），`drainPipe` 会一直转、`await` 它等于挂死。这里用「子进程已退出 +
 * 连续空读超过 PTY_DRAIN_QUIET_MS」当终点，既收得到尾部输出，又不会永远等下去。
 */
async function drainPtyOutput(
  bound: BoundWin32,
  handle: number,
  sink: NodeJS.WriteStream,
  state: { exited: boolean },
): Promise<void> {
  const available = slotUint32(bound)
  const area = byteArea(bound, DRAIN_CHUNK)
  let quietMs = 0
  for (;;) {
    if (Number(bound.peekNamedPipe(handle, null, 0, null, available.slot, null)) === 0) {
      const code = Number(bound.getLastLastError()) >>> 0
      if (isBrokenPipe(code)) return
      throwWin32(bound, 'PeekNamedPipe', code)
    }
    const count = available.get()
    if (count === 0) {
      if (state.exited) {
        quietMs += PTY_POLL_MS
        if (quietMs >= PTY_DRAIN_QUIET_MS) return
      }
      await new Promise((resolve) => setTimeout(resolve, PTY_POLL_MS))
      continue
    }
    quietMs = 0
    const read = slotUint32(bound)
    if (Number(bound.readFile(handle, area.ptr, Math.min(count, DRAIN_CHUNK), read.slot, null)) === 0) {
      const code = Number(bound.getLastLastError()) >>> 0
      if (isBrokenPipe(code)) return
      throwWin32(bound, 'ReadFile', code)
    }
    const got = read.get()
    if (got === 0) return
    sink.write(Buffer.from(area.bytes().subarray(0, got)))
  }
}

/**
 * pty 输入泵：把宿主写进 runner stdin 的字节原样写进 conin。
 *
 * 0x03 也照写——ConPTY/控制台会把它翻译成 CTRL_C_EVENT 发给挂在上面的进程；这一层
 * 绝不吞掉它、也不自己转成 TerminateProcess（那样中断就变成「杀进程」，语义不同）。
 */
function pumpPtyInput(bound: BoundWin32, handle: number): { stop: () => void } {
  const written = slotUint32(bound)
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    process.stdin.off('data', onData)
    process.stdin.pause()
  }
  const onData = (chunk: Buffer | string): void => {
    if (stopped) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (bytes.length === 0) return
    if (Number(bound.writeFile(handle, bytes, bytes.length, written.slot, null)) === 0) {
      // 对端已关（子进程退出）是正常终点；其它错误也只停泵：输入通道坏了不该让已经
      // 建好的子进程陪葬，退出码以子进程为准
      stop()
    }
  }
  process.stdin.on('data', onData)
  process.stdin.resume()
  return { stop }
}

/**
 * `--pty` 分支：ConPTY 在本进程（不受限）建，受限子进程靠属性列表挂上去。
 *
 * 与非 PTY 路径的三处刻意不同（都有实测依据）：
 *   1. `UpdateProcThreadAttribute` 的 lpValue 传 **HPCON 值本身**，不是 `&HPCON`。
 *      传 `&hpc` 时 CreateProcessAsUserW 照样成功，但 ConPTY 内部对象地址被当成句柄，
 *      子进程挂到的是一套死控制台：echo 写到父进程控制台、isTTY=undefined；
 *   2. 标准句柄填 INVALID_HANDLE_VALUE、`bInheritHandles=0`（pty 接管 STD 句柄）；
 *   3. 排水用 `drainPtyOutput`（ConPTY 不给 EOF），输入多一条 stdin → conin 的泵。
 */
async function runPtyChild(
  bound: BoundWin32,
  args: RunnerArgs,
  pty: { cols: number; rows: number },
  token: RestrictedToken,
  ownedHandles: Set<number>,
  closeOwned: (handle: number) => void,
): Promise<number> {
  // ① 两对管道：conin 的读端交给 ConPTY（父进程留写端），conout 的写端交给 ConPTY（父进程留读端）
  const coninRead = slotUintPtr(bound)
  const coninWrite = slotUintPtr(bound)
  const conoutRead = slotUintPtr(bound)
  const conoutWrite = slotUintPtr(bound)
  for (const pair of [[coninRead, coninWrite], [conoutRead, conoutWrite]] as const) {
    if (Number(bound.createPipe(pair[0].slot, pair[1].slot, null, 0)) === 0) throwLastError(bound, 'CreatePipe')
    ownedHandles.add(pair[0].get())
    ownedHandles.add(pair[1].get())
  }

  // ② ConPTY 本体。HPCON 不是普通句柄：只能用 ClosePseudoConsole 收，CloseHandle 收不掉它
  //    （漏了它就是漏一个 conhost），所以它不入 ownedHandles，单独在 finally 里关
  const hpcSlot = slotUintPtr(bound)
  const pseudoResult = Number(bound.createPseudoConsole(
    packCoord(pty.cols, pty.rows),
    coninRead.get(),
    conoutWrite.get(),
    0,
    hpcSlot.slot,
  )) | 0
  if (pseudoResult !== 0) throwWin32(bound, 'CreatePseudoConsole', pseudoResult)
  const hpc = hpcSlot.get()
  let attributeList: Buffer | undefined
  /**
   * 停输入泵的收尾函数（建泵后登记）。
   *
   * 为什么放在函数作用域、由本函数最外层 `finally` 无条件调用：stdin 只要还 resume 着、
   * data 监听还挂着，事件循环就永不空，runner 永远退不出去。而 `GetExitCodeProcess` /
   * `WaitForSingleObject` / `await draining` 抛错的路径都走不到「正常收尾」那一行——
   * 以前 stop() 只写在正常路径上，失败就是 runner 挂死（Ctrl+C 泵把进程钉住）。
   * `stop` 是幂等的，正常路径先停一次也没关系。
   */
  let stopInputPump: (() => void) | undefined
  try {
    // ③ 属性列表：先问大小（第一次调用必然「失败」，但会把所需字节数写进 size），再分配再初始化
    const sizeSlot = slotUintPtr(bound)
    bound.initializeProcThreadAttributeList(null, 1, 0, sizeSlot.slot)
    const listSize = sizeSlot.get()
    if (listSize === 0) throwLastError(bound, 'InitializeProcThreadAttributeList')
    attributeList = Buffer.alloc(listSize)
    if (Number(bound.initializeProcThreadAttributeList(attributeList, 1, 0, sizeSlot.slot)) === 0) {
      throwLastError(bound, 'InitializeProcThreadAttributeList')
    }
    // lpValue = HPCON 值本身（见函数注释第 1 条）
    if (Number(bound.updateProcThreadAttribute(
      attributeList,
      0,
      PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
      hpc,
      8,
      null,
      null,
    )) === 0) {
      throwLastError(bound, 'UpdateProcThreadAttribute')
    }

    const commandLine = Buffer.from(`${args.childArgv.map((arg) => quoteArgv(arg)).join(' ')}\0`, 'utf16le')
    const startup = packStartupInfoEx(bound, attributeList)
    const processInfo = Buffer.alloc(PROCESS_INFORMATION_SIZE)
    const created = Number(bound.createProcessAsUserW(
      token.handle,
      null, // lpApplicationName：NULL → 从命令行第一个 token 解析
      commandLine,
      null, // lpProcessAttributes
      null, // lpThreadAttributes
      0, // bInheritHandles：STD 句柄由 ConPTY 接管，一根都不用继承
      CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, // 挂起 + 按 STARTUPINFOEXW 解释
      null, // lpEnvironment：NULL（koffi 传显式块必失败），靠继承 runner 的环境
      null, // lpCurrentDirectory：NULL = 用 runner 的 cwd（宿主设成的会话目录）
      startup,
      processInfo,
    ))
    if (created === 0) throwLastError(bound, 'CreateProcessAsUserW')
    const hProcess = Number(processInfo.readBigUInt64LE(PI_OFFSETS.hProcess))
    const hThread = Number(processInfo.readBigUInt64LE(PI_OFFSETS.hThread))
    ownedHandles.add(hProcess)
    ownedHandles.add(hThread)

    // 作业与「挂起态入作业」的纪律与非 PTY 路径一致：任何一步失败当场杀，绝不放裸奔
    let job = 0
    try {
      job = Number(bound.createJobObjectW(null, null))
      if (job === 0) throwLastError(bound, 'CreateJobObjectW')
      ownedHandles.add(job)
      if (Number(bound.setInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        packJobLimits(),
        JOBOBJECT_EXTENDED_LIMIT_SIZE,
      )) === 0) {
        throwLastError(bound, 'SetInformationJobObject')
      }
      if (Number(bound.assignProcessToJobObject(job, hProcess)) === 0) {
        throwWin32(bound, 'AssignProcessToJobObject', Number(bound.getLastLastError()) >>> 0)
      }
    } catch (error) {
      bound.terminateProcess(hProcess, 1)
      throw error
    }
    const resumed = Number(bound.resumeThread(hThread)) >>> 0
    if (resumed === 0xffffffff) {
      const code = Number(bound.getLastLastError()) >>> 0
      bound.terminateProcess(hProcess, 1)
      throwWin32(bound, 'ResumeThread', code)
    }

    // 父进程立刻放掉 conin 读端与 conout 写端（ConPTY 自己已经持有它们）
    closeOwned(coninRead.get())
    closeOwned(conoutWrite.get())

    const state = { exited: false }
    // 排水先「启动」再等待，理由与非 PTY 路径相同；这里多接一个 catch 兜住收尾期
    // 关句柄导致的读失败，不让它在 finally 之后变成未处理的 rejection
    const draining = drainPtyOutput(bound, conoutRead.get(), process.stdout, state)
    draining.catch(() => {})
    const pump = pumpPtyInput(bound, coninWrite.get())
    stopInputPump = pump.stop

    // 分片等：片间让出事件循环（原因见 WAIT_SLICE_MS）。语义与一次等到底等价：
    // 子进程退出 → WAIT_OBJECT_0；整体超时预算用完 → WAIT_TIMEOUT；其余值照旧当失败抛
    const deadline = args.timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + args.timeoutMs
    let waited: number
    for (;;) {
      const slice = deadline === Number.POSITIVE_INFINITY
        ? WAIT_SLICE_MS
        : Math.min(WAIT_SLICE_MS, Math.max(1, deadline - Date.now()))
      waited = Number(bound.waitForSingleObject(hProcess, slice)) >>> 0
      if (waited !== WAIT_TIMEOUT) break
      // 片届满了还没退出：整体预算也用完了才算超时，否则先把事件循环让出去（排水的
      // 轮询、stdin 的 data 回调都在这里才有机会跑），再等下一片
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    let exitCode: number
    if (waited === WAIT_TIMEOUT) {
      process.stderr.write(`${RUNNER_SIGNATURE}超时 ${String(args.timeoutMs)}ms，已终止整个作业\n`)
      bound.terminateJobObject(job, 1)
      bound.waitForSingleObject(hProcess, 5000)
      exitCode = TIMEOUT_EXIT_CODE
    } else if (waited === WAIT_OBJECT_0) {
      const code = slotUint32(bound)
      if (Number(bound.getExitCodeProcess(hProcess, code.slot)) === 0) throwLastError(bound, 'GetExitCodeProcess')
      exitCode = code.get() >>> 0
    } else {
      throwLastError(bound, 'WaitForSingleObject')
    }

    // 子进程没了：先停输入泵（否则 stdin 让 runner 退不出去），再让排水把尾部输出收干净
    // （ConPTY 不给 EOF，由 drainPtyOutput 的「退出 + 空读窗口」判终点）
    pump.stop()
    state.exited = true
    closeOwned(coninWrite.get())
    await draining

    // 收尾顺序：线程/进程/作业，pty 与属性列表留给 finally
    closeOwned(hThread)
    closeOwned(hProcess)
    closeOwned(job)
    return exitCode
  } finally {
    // 停泵必须在关 pty 之前，而且**无条件**：任何一条提前退出的路径（等待/取退出码/
    // 排水抛错）都要把 stdin 还原成「不 resume、不挂 data 监听」，否则 runner 退不出去。
    // 这一步不能抛：收尾失败不许遮住真实错误。
    try {
      stopInputPump?.()
    } catch {
      /* 同上 */
    }
    // 属性列表只装了一个 HPCON 值，先删它再关 pty；任何一步失败都不许遮住真实错误
    if (attributeList !== undefined) {
      try {
        bound.deleteProcThreadAttributeList(attributeList)
      } catch {
        /* 收尾失败不遮真实错误 */
      }
    }
    try {
      bound.closePseudoConsole(hpc)
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 账号分支：解密 DPAPI 密码 → LogonUserW 拿专用离线账号的主令牌。
 *
 * 密码文件在 `<dsc-home>/sandbox/account.bin`（提权 setup 落盘的 DPAPI CurrentUser blob，
 * 同用户可解）。失败照 runner 语义抛（`dsc-sandbox-run: …` + 127）——绝不回落成当前用户。
 */
function logonAccount(bound: BoundWin32, account: { name: string; dscHome: string }): number {
  const blob = readFileSync(accountBlobPath(account.dscHome))
  const password = unprotectSecret(bound, blob)
  const slot = slotUintPtr(bound)
  if (Number(bound.logonUserW(
    utf16Buffer(account.name),
    utf16Buffer('.'),
    utf16Buffer(password),
    LOGON32_LOGON_INTERACTIVE,
    LOGON32_PROVIDER_DEFAULT,
    slot.slot,
  )) === 0) {
    throwLastError(bound, 'LogonUserW')
  }
  return slot.get()
}

/**
 * 入口：参数 → 环境 → 令牌 →（`--pty` 走 ConPTY / 否则三对管道）→ 挂起 spawn → 作业 →
 * 放行 → 排水 → 等待 → 镜像退出码。
 */
async function main(): Promise<number> {
  const args = parseRunnerArgs(process.argv.slice(2))
  const ffi = loadFfi()
  const bound = bindAll(ffi)

  // runner 忽略 CTRL+C：收尾（镜像退出码、让作业句柄自然关闭）必须做完。
  //
  // `--pty` 是例外，而且必须例外：本进程一旦忽略 CTRL+C，往 conin 写 0x03 就不再变成
  // 子进程的 CTRL_C_EVENT（实测：同一条 0x03 在「建 pty 的进程不忽略」时子进程以
  // 0xC000013A 退出，忽略后子进程照旧跑满）。pty 模式下 Ctrl+C 走的是 stdin 字节通道，
  // 不靠本进程的控制台事件；代价是本进程的控制台若收到真 Ctrl+C 会照默认处理（退出），
  // 靠作业的 KILL_ON_JOB_CLOSE 收掉子树——与非 -pty 的取舍不同，写在这里免得后人改回去
  if (args.pty === undefined) {
    if (Number(bound.setConsoleCtrlHandler(null, 1)) === 0) throwLastError(bound, 'SetConsoleCtrlHandler')
  }

  // TMP/TEMP 重定向到自己进程环境。lpEnvironment 必须传 NULL（koffi 传显式环境块
  // 必报 ERROR_INVALID_PARAMETER），子进程继承的就是改过的这一份
  if (Number(bound.setEnvironmentVariableW(utf16Buffer('TMP'), utf16Buffer(args.tempDir))) === 0) {
    throwLastError(bound, 'SetEnvironmentVariableW(TMP)')
  }
  if (Number(bound.setEnvironmentVariableW(utf16Buffer('TEMP'), utf16Buffer(args.tempDir))) === 0) {
    throwLastError(bound, 'SetEnvironmentVariableW(TEMP)')
  }

  // 令牌：restricting 列表 = [logon, Everyone, temp 的 SID, …--root 的 SID]。
  //
  // temp 的能力 SID 由这里**自己派生**（`--temp` 是它唯一的来源）：宿主只把工作区/附加根
  // 放进 --root，两边各按自己的口径算，少一次「猜哪条是 temp」——那个猜测在多工作区时
  // 必错，而且是 127 硬失败。去重是按 SID 串去重，重复的 restricting SID 没有意义。
  // 账号分支（--account）：解密 account.bin → LogonUserW → 在账号令牌上受限化——
  // pass-1 用账号的普通权限（可写根靠账号 ACE），pass-2 照旧走能力 SID 交集
  const capabilitySids: string[] = []
  const seenSids = new Set<string>()
  for (const sid of [tempWriteSid(args.tempDir), ...args.roots.map((root) => root.sid)]) {
    if (seenSids.has(sid)) continue
    seenSids.add(sid)
    capabilitySids.push(sid)
  }
  const accountToken = args.account === undefined ? undefined : logonAccount(bound, args.account)
  const token: RestrictedToken = buildRestrictedToken(bound, {
    mode: args.mode,
    rootSids: capabilitySids,
    ...(accountToken === undefined ? {} : { accountToken }),
  })

  /**
   * 本进程自己拿到、必须自己关的句柄：管道 + 子进程 + 主线程 + 作业（PTY 模式是两对管道，
   * HPCON 不在里面——它只能由 ClosePseudoConsole 收）。
   *
   * 统一登记在册，正常路径逐根关，`finally` 兜底把漏掉的关掉——CreateProcessAsUserW
   * 失败、ResumeThread 失败、排水抛错都在函数中途退出，指望每条分支自己记得收尾
   * 必然漏；而漏掉的管道读端会让排水永远等不到 EOF。
   */
  const ownedHandles = new Set<number>()
  /**
   * 关一根自己持有的句柄。Set 里已经没有它就说明关过了，直接跳过：句柄值会被系统
   * 立刻复用，同一个值关两次等于误关别的对象。
   */
  const closeOwned = (handle: number): void => {
    if (!ownedHandles.delete(handle)) return
    bound.closeHandle(handle)
  }

  try {
    // ── --pty：换 ConPTY 那条路（pty 由本进程建，受限子进程挂属性列表）──
    // 放在三对管道之前，非 PTY 路径的代码一个字节都不动
    if (args.pty !== undefined) {
      return await runPtyChild(bound, args, args.pty, token, ownedHandles, closeOwned)
    }

    // 三对匿名管道；只给子进程端打继承位（父端要立刻关掉，否则排水永远等不到 EOF）
    const stdinRead = slotUintPtr(bound)
    const stdinWrite = slotUintPtr(bound)
    const stdoutRead = slotUintPtr(bound)
    const stdoutWrite = slotUintPtr(bound)
    const stderrRead = slotUintPtr(bound)
    const stderrWrite = slotUintPtr(bound)
    for (const pair of [[stdinRead, stdinWrite], [stdoutRead, stdoutWrite], [stderrRead, stderrWrite]] as const) {
      if (Number(bound.createPipe(pair[0].slot, pair[1].slot, null, 0)) === 0) throwLastError(bound, 'CreatePipe')
      // 建一对登记一对：建到第三对失败时，前两对也已经拿到句柄了
      ownedHandles.add(pair[0].get())
      ownedHandles.add(pair[1].get())
    }
    for (const childEnd of [stdinRead.get(), stdoutWrite.get(), stderrWrite.get()]) {
      if (Number(bound.setHandleInformation(childEnd, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) === 0) {
        throwLastError(bound, 'SetHandleInformation')
      }
    }

    // 命令行按 CommandLineToArgvW 规则引号化：lpApplicationName 传 NULL，第一个 token 就是程序名
    const commandLine = Buffer.from(`${args.childArgv.map((arg) => quoteArgv(arg)).join(' ')}\0`, 'utf16le')
    const startup = packStartupInfo(stdinRead.get(), stdoutWrite.get(), stderrWrite.get())
    // Buffer 出参直接给 koffi 取地址；它必须活到调用返回（这里是局部变量，满足）
    const processInfo = Buffer.alloc(PROCESS_INFORMATION_SIZE)

    const created = Number(bound.createProcessAsUserW(
      token.handle,
      null, // lpApplicationName：NULL → 从命令行第一个 token 解析
      commandLine,
      null, // lpProcessAttributes
      null, // lpThreadAttributes
      1, // bInheritHandles：三个子进程端要传下去
      CREATE_SUSPENDED, // 先挂起：塞进作业前不许跑
      null, // lpEnvironment：NULL（koffi 传显式块必失败），靠继承 runner 的环境
      null, // lpCurrentDirectory：NULL = 用 runner 的 cwd（宿主设成的会话目录）
      startup,
      processInfo,
    ))
    // 这里以前直接抛，令牌与三对管道就漏了：现在照样抛，收尾由下面的 finally 统一做
    if (created === 0) throwLastError(bound, 'CreateProcessAsUserW')
    const hProcess = Number(processInfo.readBigUInt64LE(PI_OFFSETS.hProcess))
    const hThread = Number(processInfo.readBigUInt64LE(PI_OFFSETS.hThread))
    ownedHandles.add(hProcess)
    ownedHandles.add(hThread)

    // 作业：KILL_ON_JOB_CLOSE —— runner 死（含被 taskkill）= 整棵子树被内核收掉
    //
    // 从 CreateProcessAsUserW 成功到子进程真正入作业之间，它一直处于**挂起**态；
    // 这段窗口里任何一步失败，都必须当场把它杀掉：一个不受作业保护的受限进程
    // 一秒都不许活着（否则 runner 退出后会留下一个永远挂起的孤儿）。
    // 句柄本身不在这里关：登记过，finally 会收（包括 job 建到一半就失败的情况）
    let job = 0
    try {
      job = Number(bound.createJobObjectW(null, null))
      if (job === 0) throwLastError(bound, 'CreateJobObjectW')
      ownedHandles.add(job)
      if (Number(bound.setInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        packJobLimits(),
        JOBOBJECT_EXTENDED_LIMIT_SIZE,
      )) === 0) {
        throwLastError(bound, 'SetInformationJobObject')
      }
      if (Number(bound.assignProcessToJobObject(job, hProcess)) === 0) {
        const code = Number(bound.getLastLastError()) >>> 0
        throwWin32(bound, 'AssignProcessToJobObject', code)
      }
    } catch (error) {
      bound.terminateProcess(hProcess, 1)
      throw error
    }
    const resumed = Number(bound.resumeThread(hThread)) >>> 0
    if (resumed === 0xffffffff) {
      const code = Number(bound.getLastLastError()) >>> 0
      bound.terminateProcess(hProcess, 1)
      throwWin32(bound, 'ResumeThread', code)
    }

    // 父端立刻关掉三个写端/读端（继承副本已在子进程手里）：不关的话读端永远等不到
    // EOF，排水会一直转，命令跑完也回不来
    closeOwned(stdinWrite.get())
    closeOwned(stdoutWrite.get())
    closeOwned(stderrWrite.get())

    // 排水必须先「启动」再「等待」，不能先 await 排水：排水要等对端 EOF，而 EOF 只有
    // 子进程退出（或被杀）后才来；先 await 排水的话卡死的命令永远走不到超时分支。
    // 反过来也不会死锁：排水一直在读，管道缓冲填满时子进程阻塞在写、排水照旧推进
    const drained = Promise.all([
      drainPipe(bound, stdoutRead.get(), process.stdout),
      drainPipe(bound, stderrRead.get(), process.stderr),
    ])

    // 分片等，与 PTY 分支同一口径（原因见 WAIT_SLICE_MS）：
    // 同步 FFI 一次等到底会把事件循环冻住，排水一旦停摆，管道缓冲（默认 4KB）填满后
    // 子进程阻塞在写、永不退出 → `wait` 永不返回 → 整个 runner 死锁。片间必须
    // `await setImmediate`，排水与 stdin 才有机会跑。`--timeout` 语义不变：
    // 整体预算用完 → WAIT_TIMEOUT → 124。
    const deadline = args.timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + args.timeoutMs
    let waited: number
    for (;;) {
      const slice = deadline === Number.POSITIVE_INFINITY
        ? WAIT_SLICE_MS
        : Math.min(WAIT_SLICE_MS, Math.max(1, deadline - Date.now()))
      waited = Number(bound.waitForSingleObject(hProcess, slice)) >>> 0
      if (waited !== WAIT_TIMEOUT) break
      // 单片到点还没退出：整体预算也用完了才算超时，否则先让出事件循环再等下一片
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    let exitCode: number
    if (waited === WAIT_TIMEOUT) {
      // 超时分支要有自己的退出码（124）：调用方得能一眼分开「命令自己失败了（原码
      // 镜像）」与「我们把它掐了」，否则一个被掐死的进程留下什么码就只能认什么码
      process.stderr.write(`${RUNNER_SIGNATURE}超时 ${String(args.timeoutMs)}ms，已终止整个作业\n`)
      // 杀整个作业而不是单杀子进程：孙进程同样占着管道写端，只杀子进程的话排水
      // 等不到 EOF、runner 自己卡在这行；作业终止后所有写端一起关，排水才收得干净
      bound.terminateJobObject(job, 1)
      // 再等它真的死（作业已终止，它必然在毫秒级退出；5 秒只是兜底，超了也不再等）
      bound.waitForSingleObject(hProcess, 5000)
      exitCode = TIMEOUT_EXIT_CODE
    } else if (waited === WAIT_OBJECT_0) {
      const code = slotUint32(bound)
      if (Number(bound.getExitCodeProcess(hProcess, code.slot)) === 0) throwLastError(bound, 'GetExitCodeProcess')
      exitCode = code.get() >>> 0
    } else {
      // WAIT_FAILED 等：句柄本身出了问题，照旧按 runner 失败抛
      throwLastError(bound, 'WaitForSingleObject')
    }
    // 排水必须等干净再走：读端还在自己手里，此刻直接返回等于把管道里的输出丢掉
    await drained

    // 收尾顺序：先线程/进程，**作业最后关**。子进程已退出，关作业不会再杀人；
    // 而 runner 被外部 taskkill 时作业句柄随进程关闭 → 内核按 KILL_ON_JOB_CLOSE
    // 收掉整棵子树，这就是杀树语义（令牌由 finally 最后 dispose，与杀树无关）
    closeOwned(hThread)
    closeOwned(hProcess)
    closeOwned(job)
    return exitCode
  } finally {
    // 令牌必须在 finally 里关：dispose 收的是三根句柄（受限令牌、原令牌、OpenProcess
    // 的进程句柄），而「CreateProcessAsUserW 失败」「ResumeThread 失败」「排水抛错」
    // 这些分支都走不到函数末尾。runner 会被反复 spawn，每次漏三根句柄，
    // 迟早把「失败也照样干净退出」这个前提吃掉
    for (const handle of [...ownedHandles]) {
      try {
        closeOwned(handle)
      } catch {
        /* 收尾失败不遮真实错误 */
      }
    }
    token.dispose()
  }
}

main().then((code) => {
  process.exitCode = code
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${RUNNER_SIGNATURE}${message}\n`)
  process.exitCode = RUNNER_EXIT_CODE
})
