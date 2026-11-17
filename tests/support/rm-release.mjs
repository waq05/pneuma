/**
 * Restart Manager 的独立执行体：查出「谁打开着这些文件」，把这些进程收掉。
 *
 * 由 `tmp-clean.ts` 用 `spawnSync(process.execPath, [本文件])` 调起，**不在 vitest
 * 进程里直接调 koffi**。原因见下。
 *
 * ## 为什么必须隔一个进程
 *
 * Restart Manager 是原生 API，参数与系统库 ABI 不符时，越界写坏的是**调用进程的原生堆**。
 * 堆损坏当场不报错，要等下一次堆操作或进程退出时才以 `0xC0000374`
 * （STATUS_HEAP_CORRUPTION）炸掉——落在 vitest 主进程上就是把退出码改成
 * `-1073740940`，测试全绿也看起来像崩了（2026-11-17 复现：6/10 次）。
 *
 * 隔到子进程后，最坏情况只是这个子进程死；父进程读 stdout 拿到崩溃前已经落盘的
 * `killed`，读不到就当「这轮收不掉」，走跨轮登记表兜底。
 *
 * ## 为什么这里不用 koffi 的 struct / alloc（第二条坑）
 *
 * 实测（Windows 11 26100，2026-11-17）：`RmGetList` 每条 `RM_PROCESS_INFO` 原生写
 * **668 字节**，而公开头文件按字段算出来是 652（`12 + 512 + 128`）。koffi 的 struct
 * 按 652 算，缓冲也只分配 652×条数，于是每条越界 16 字节写进原生堆——这正是上面那个
 * 崩溃的直接来源（第二次 `RmGetList` 填缓冲那一步 10/10 崩）。
 *
 * 所以这段代码不猜结构体大小，也不让 koffi 管理输出缓冲：
 *
 * 1. 输出缓冲用 Node 的 `Buffer`（涂 `0xCC` 哨兵），按文档值 652 再加 128 字节/条的余量
 *    分配，原生多写的那 16 字节落在余量里，不会越界；
 * 2. 调用后用「实际被改写的字节数 ÷ 条数」反推**本机原生步长**（这一步实测得到 668），
 *    步长不是整数、超出合理区间就直接报告失败、不杀任何进程（宁可少杀，不可错杀）；
 * 3. 只从每条记录的偏移 0 读 `dwProcessId`（三个 Windows 版本里它都在最前面），
 *    不用 koffi 解码 `char16_t` 数组；
 * 4. 会话密钥传 64 个 wchar 的字符串缓冲——系统只写 `CCH_RM_SESSION_KEY + 1`（33）个。
 *
 * ## 输入输出
 *
 * stdin（一行 JSON）：`{"paths": string[], "exclude"?: number[]}`
 *   - `paths`：要查占用者的文件（或目录）路径；
 *   - `exclude`：绝不杀的 pid（父进程、父进程的上层进程、本轮已经收掉的进程）。
 *
 * stdout（一行 JSON，先 `writeSync` 再退出，崩溃也不丢）：
 *   - 正常：`{"killed": number[], "failed": false}`
 *   - 非 Windows / koffi 不可用：`{"killed": [], "failed": false, "skipped": "…"}`
 *   - 查询失败：`{"killed": [], "failed": true, "reason": "…"}`
 *
 * 任何情况下都以退出码 0 退出：父进程只认 stdout 的 JSON，不认退出码——子进程即使被
 * 堆损坏带崩（退出码 `0xC0000374`），已经写出去的 `killed` 仍然有效。
 *
 * @module dsc/tests/support/rm-release
 */
import { readFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 公开头文件算出来的 `sizeof(RM_PROCESS_INFO)`；本机实测 668，所以只当分配下限。 */
const DOC_STRIDE = 652

/** 单条记录的分配余量：容纳不同 Windows 版本比文档多出来的尾巴（本机多 16 字节）。 */
const STRIDE_SLACK = 128

/** 条数上限。正常情况下只有一两个孤儿 git；超过这个数说明注册的东西不对。 */
const MAX_ENTRIES = 64

/** 会话密钥缓冲的 wchar 数：系统写 `CCH_RM_SESSION_KEY + 1 = 33` 个，这里多给一倍。 */
const SESSION_KEY_WCHARS = 64

/** 哨兵字节：标记缓冲里「原生没写过」的位置。 */
const SENTINEL = 0xcc

/** 把回话写到 stdout。用 `writeSync`：进程被堆损坏带崩时管道里的内容不会丢。 */
function reply(payload) {
  writeSync(1, `${JSON.stringify(payload)}\n`)
}

/** 失败回话：不算异常，父进程按「这轮收不掉」处理。 */
function fail(reason) {
  reply({ killed: [], failed: true, reason })
}

/** 不支持 / 不可用：也是正常退出，父进程同样当「没收到」。 */
function skip(reason) {
  reply({ killed: [], failed: false, skipped: reason })
}

/**
 * 读并校验 stdin 里的请求。返回 `null` 表示请求不合法（父进程的实现有 bug 或 stdin 被占）。
 */
function readRequest() {
  let text
  try {
    text = readFileSync(0, 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { paths, exclude } = parsed
  if (!Array.isArray(paths) || paths.length === 0) return null
  if (!paths.every((path) => typeof path === 'string' && path !== '')) return null
  const excluded = Array.isArray(exclude) ? exclude.filter((pid) => Number.isInteger(pid)) : []
  return { paths, exclude: excluded }
}

/**
 * 查这些文件正被哪些进程打开，返回 pid 列表。
 *
 * 返回 `null` 表示查不出来（会话建不起来、注册失败、步长反推不成立）；调用方据此
 * 报告失败、**不杀任何进程**。返回空数组表示确实没有占用者。
 */
function collectHolders(koffi, files) {
  const lib = koffi.load('rstrtmgr.dll')
  const RmStartSession = lib.func(
    'uint32 RmStartSession(_Out_ uint32_t *pSessionHandle, int dwSessionFlags, char16_t *strSessionKey)',
  )
  const RmEndSession = lib.func('uint32 RmEndSession(uint32_t pSessionHandle)')
  const RmRegisterResources = lib.func(
    'uint32 RmRegisterResources(uint32_t pSessionHandle, uint32_t nFiles, const char16_t **rgsFilenames, uint32_t nApplications, void *rgApplications, uint32_t nServices, char16_t **rgsServiceNames)',
  )
  const RmGetList = lib.func(
    'uint32 RmGetList(uint32_t dwSessionHandle, _Out_ uint32_t *pnProcInfoNeeded, _Inout_ uint32_t *pnProcInfo, void *rgAffectedApps, _Inout_ uint32_t *lpdwRebootReasons)',
  )

  // 会话密钥是**输出**缓冲（系统往里写 32 个 hex + NUL）：传 64 个 wchar 的字符串缓冲，
  // 传普通 JS 字符串只有十几个字符，系统一写就越界。
  const session = [0]
  const sessionKey = ['\0'.repeat(SESSION_KEY_WCHARS)]
  if (Number(RmStartSession(session, 0, sessionKey)) !== 0) return null
  try {
    if (Number(RmRegisterResources(session[0], files.length, files, 0, null, 0, null)) !== 0) return null
    const needed = [0]
    const count = [0]
    const reasons = [0]
    // 第一次只查条数：不传缓冲，系统不会写任何 RM_PROCESS_INFO，返回 234（ERROR_MORE_DATA）。
    const first = Number(RmGetList(session[0], needed, count, null, reasons))
    if (first === 0) return []
    if (first !== 234) return null
    const entries = Number(needed[0])
    if (!Number.isInteger(entries) || entries <= 0 || entries > MAX_ENTRIES) return null

    // 余量按条给足：原生可能按 668 而不是 652 写（见文件头），越界写进的是原生堆。
    const capacity = (DOC_STRIDE + STRIDE_SLACK) * entries + 256
    const buffer = Buffer.alloc(capacity, SENTINEL)
    count[0] = entries
    if (Number(RmGetList(session[0], needed, count, buffer, reasons)) !== 0) return null

    // 反推原生步长：最后被改写的字节位置 ÷ 条数。
    let written = 0
    for (let i = 0; i < capacity; i += 1) {
      if (buffer[i] !== SENTINEL) written = i + 1
    }
    if (written === 0) return null
    const stride = written / entries
    if (!Number.isInteger(stride) || stride < DOC_STRIDE - 8 || stride > DOC_STRIDE + STRIDE_SLACK) return null

    // 每条记录的偏移 0 是 dwProcessId（三个版本的结构里都在最前）。
    const pids = []
    for (let i = 0; i < entries; i += 1) pids.push(buffer.readInt32LE(i * stride))
    return pids
  } finally {
    RmEndSession(session[0])
  }
}

/** 主流程：读请求 → 查占用者 → 收掉 → 写回话。任何异常都变成失败的 JSON，不让 stderr 噪音变成父进程的误判。 */
function main() {
  const request = readRequest()
  if (request === null) {
    fail('bad-request')
    return
  }
  if (process.platform !== 'win32') {
    skip('unsupported-platform')
    return
  }
  let koffi
  try {
    koffi = createRequire(import.meta.url)('koffi')
  } catch {
    // 裁剪安装 / 只装了运行期依赖：不是错误，交给登记表兜底。
    skip('koffi-unavailable')
    return
  }
  let holders
  try {
    holders = collectHolders(koffi, request.paths)
  } catch (error) {
    fail(`rm-error: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (holders === null) {
    fail('rm-query-failed')
    return
  }

  // 父进程自己（和父进程的上层）可能正握着临时目录：绝不收，否则等于替测试进程自杀。
  const excluded = new Set([process.pid, process.ppid, ...request.exclude])
  const killed = []
  for (const raw of holders) {
    const pid = Number(raw)
    if (!Number.isInteger(pid) || pid <= 0 || excluded.has(pid) || killed.includes(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // 已经自己退了 / 没权限：忽略，父进程下一轮或下一轮运行再试。
    }
  }
  reply({ killed, failed: false })
}

try {
  main()
} catch (error) {
  fail(`unexpected: ${error instanceof Error ? error.message : String(error)}`)
}
