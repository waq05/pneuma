/**
 * ops 插件的外壳：把 dsh-ops 的 Rust worker 当**独立程序**用。
 *
 * 为什么不直接把 dsh-ops 这个 npm 包装进来：它是 dsh 的宿主插件，注册工具那一步
 * 要 `sandboxPolicy` / `subprocess` 两个宿主服务、还要按 agent 逐个发布（见
 * docs/dsh-plugin-porting.md 的判定表）。但它真正的活儿——编码识别、行号切片、
 * docx/pdf/csv 解析、revision 并发校验——全在 `dsh-ops-worker` 这个 exe 里，
 * 输入是一段 JSON、输出是一段 JSON，跟 dsh 的进程模型没有关系（2026-11-03 手工
 * 喂 JSON 实测：读、写、越界拒绝三条路都通）。
 *
 * 所以这里只做三件事：找到 exe、拼请求、把结果收回来。进程用 `node:child_process`
 * 自己起，不依赖任何宿主服务；超时、取消、输出上限都在这一层兜住。
 *
 * 协议（dsh-ops 0.4.x，字段名与语义照抄它的 worker-protocol）：
 *   { version: 1, requestId, component: 'file',
 *     budget: { timeoutMs, maxBytes },
 *     request: { root, scope, tool, args, read_only, deny_roots,
 *                deny_credential_names, write_roots? } }
 *
 * @module dsc/core/ops/worker
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dscPath } from '../path-policy.js'

/**
 * worker 支持的目标平台：照 dsh-ops 的发布矩阵列（0.4.x 实际发的是前三档；
 * darwin-x64 列在这里只是「上游声明过」，目录不存在时照样按没找到报错）。
 */
export const OPS_WORKER_TARGETS: readonly string[] = ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64']

/** 单次调用的默认时限：与 dsh-ops 内部的上限同一个值，超过它 worker 自己也按超时收场。 */
export const OPS_TIMEOUT_MS = 30_000

/** 单次调用回给模型的默认字节上限（128 KiB）：先由 worker 卡，再由这里兜一次。 */
export const OPS_MAX_BYTES = 128 * 1024

/** 单次请求的体积上限（2 MiB）：与 dsh-ops 调用层同一个口径，超了当场说清楚。 */
export const OPS_REQUEST_MAX_BYTES = 2 * 1024 * 1024

/** worker 可执行文件名：Windows 带 .exe。 */
export function opsWorkerName(platform: string = process.platform): string {
  return platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker'
}

/** 一次查找的结果：要么找到 exe 与出处，要么给出人话原因。 */
export type OpsWorkerLookup =
  | { ok: true; file: string; source: string }
  | { ok: false; reason: string }

/**
 * 找 worker：显式配置 > 环境变量 > 插件目录里的 dsh-ops > dsh 的 profile 目录。
 *
 * 为什么按这个顺序：显式配置是用户最后的兜底；插件目录（`~/.dsc/plugins/node_modules`）
 * 是 numa 自己的依赖区，装一次就固定；dsh 的 profile 只是「用户机器上已经装了 dsh-ops」
 * 的便利路径。
 *
 * 注意：这里只认路径，不做二进制身份校验——dsh-ops 的 provenance 校验在它自己的 JS 里，
 * Rust 侧只读 stdin。所以「显式配置的路径」等于用户授权起哪个 exe，别在文案里假装校验过。
 */
export function resolveOpsWorker(explicit?: string): OpsWorkerLookup {
  const target = `${process.platform}-${process.arch}`
  if (!OPS_WORKER_TARGETS.includes(target)) {
    return {
      ok: false,
      reason: `这个平台是 ${target}，不在 ops 支持的平台里（${OPS_WORKER_TARGETS.join(' / ')}）`,
    }
  }
  const name = opsWorkerName()
  const wanted = (file: string, source: string): OpsWorkerLookup | null => {
    try {
      if (!existsSync(file)) return null
      if (!statSync(file).isFile()) return null
      return { ok: true, file, source }
    } catch {
      return null
    }
  }
  const configured = explicit !== undefined && explicit.trim() !== '' ? explicit.trim() : undefined
  if (configured !== undefined) {
    const found = wanted(configured, '你在设置里填的路径')
    return found ?? { ok: false, reason: `设置里填的 worker 不存在：${configured}` }
  }
  const fromEnv = process.env['DSC_OPS_WORKER']
  if (fromEnv !== undefined && fromEnv !== '') {
    const found = wanted(fromEnv, '环境变量 DSC_OPS_WORKER')
    return found ?? { ok: false, reason: `DSC_OPS_WORKER 指的 worker 不存在：${fromEnv}` }
  }
  const fromPlugins = wanted(join(dscPath('plugins'), 'node_modules', 'dsh-ops', 'runtime', target, name), 'numa 插件目录里的 dsh-ops')
  if (fromPlugins !== null) return fromPlugins
  for (const profile of dshProfiles()) {
    const found = wanted(join(profile, 'node_modules', 'dsh-ops', 'runtime', target, name), `dsh profile：${profile}`)
    if (found !== null) return found
  }
  return {
    ok: false,
    reason:
      `没找到 dsh-ops 的 worker（找过 ${join(dscPath('plugins'), 'node_modules', 'dsh-ops')} 与 ${join(homedir(), '.dsh', 'profiles', '*', 'node_modules', 'dsh-ops')}）。` +
      '装一次 dsh-ops 就行：npm install dsh-ops（装进 ~/.dsc/plugins），或在设置里直接填 worker 的绝对路径',
  }
}

/** dsh 各 profile 的 dsh-ops 安装位置：只读列目录，出错就当没有。 */
function dshProfiles(): string[] {
  const root = join(homedir(), '.dsh', 'profiles')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

/** 调一次 worker 需要的全部输入。 */
export interface OpsCallOptions {
  /** worker 可执行文件。 */
  file: string
  /** 工具名（worker 侧叫 rawName，不带 ops_ 前缀）。 */
  tool: string
  /** 工具参数，原样进 request.args。 */
  args: Record<string, unknown>
  /** 本次调用的工作目录；worker 用它解析相对路径，也写进 response 的 root。 */
  cwd: string
  /** 会话标识：worker 拿它区分缓存与结果归属。 */
  scope: string
  /** 只读模式：写类工具会被 worker 当场拒掉（多一道闸，不靠调用方自觉）。 */
  readOnly: boolean
  /** 可写根；只读模式不用传。 */
  writeRoots?: readonly string[]
  /** 时限与输出上限，缺省用模块常量。 */
  timeoutMs?: number
  maxBytes?: number
  /** 取消信号：到点或用户取消都走它。 */
  signal?: AbortSignal
}

let sequence = 0

/** 拼一个 requestId：worker 只收 ASCII 字母数字下划线连字符，且长度 1..128。 */
function nextRequestId(): string {
  sequence = (sequence + 1) % 1_000_000
  return `numa-${Date.now().toString(36)}-${String(sequence)}`
}

/**
 * 调一次 worker，返回它交出来的结构（Outcome）。
 *
 * 失败口径：进程起不来、超时、输出超限、JSON 坏掉、退出码非 0，一律**抛错**；
 * 业务上的失败（POLICY_DENIED、NOT_FOUND 这些）是**正常返回值**，由调用方渲染成
 * 模型能读的文字——那属于「这次没做成」，不是「插件坏了」。
 */
export async function callOpsWorker(options: OpsCallOptions): Promise<Record<string, unknown>> {
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? OPS_TIMEOUT_MS))
  // 上下都要夹：worker 只收 1024..131072，越界会直接 INVALID_ARGUMENT。
  const maxBytes = Math.min(OPS_MAX_BYTES, Math.max(1024, Math.trunc(options.maxBytes ?? OPS_MAX_BYTES)))
  const request: Record<string, unknown> = {
    root: options.cwd,
    scope: options.scope,
    tool: options.tool,
    args: options.args,
    read_only: options.readOnly,
    // 七个只读工具都走显式路径，不遍历目录，所以这里先给空数组；
    // 凭据名字的拦截由 deny_credential_names 与工具层的 readBlockReason 各管一道。
    deny_roots: [],
    deny_credential_names: true,
    ...(options.writeRoots === undefined || options.readOnly ? {} : { write_roots: [...options.writeRoots] }),
  }
  const envelope = JSON.stringify({
    version: 1,
    requestId: nextRequestId(),
    component: 'file',
    budget: { timeoutMs: Math.min(timeoutMs, OPS_TIMEOUT_MS), maxBytes },
    request,
  })
  const bytes = Buffer.byteLength(envelope, 'utf8')
  if (bytes > OPS_REQUEST_MAX_BYTES) {
    throw new Error(
      `这次请求有 ${String(bytes)} 字节，超过 ${String(OPS_REQUEST_MAX_BYTES)} 字节上限；` +
        'ops 一次只能收这么大的参数（diff 的 content 太大时改用 edit，或分段比对）',
    )
  }
  const raw = await runWorker(options.file, envelope, { cwd: options.cwd, timeoutMs, maxBytes, signal: options.signal })
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('ops worker 交回来的不是 JSON：这次调用的结果不可信，先看看目标文件当前状态再重试')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ops worker 交回来的不是对象：这次调用的结果不可信，先看看目标文件当前状态再重试')
  }
  return parsed as Record<string, unknown>
}

/** 起进程、喂 stdin、收 stdout；超时与取消都在这里收场。 */
function runWorker(
  file: string,
  input: string,
  options: { cwd: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal },
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    if (options.signal?.aborted === true) {
      rejectPromise(new Error('这次调用在开始前就被取消了'))
      return
    }
    let child
    try {
      child = spawn(file, [], { cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      rejectPromise(new Error(`起不来 ops worker：${errorText(error)}`))
      return
    }
    const chunks: Buffer[] = []
    let kept = 0
    let lossy = false
    let stderr = ''
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
      fn()
    }
    const kill = (): void => {
      if (child.pid === undefined) return
      try {
        if (process.platform === 'win32') {
          // taskkill 本身是异步进程：起不来（ENOENT）或失败都要有兜底，
          // 否则 worker 会变成孤儿进程，一直挂着 stdin。
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          killer.on('error', () => child.kill())
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        try {
          child.kill()
        } catch {
          // 进程可能已经自己退了：这里只求别抛
        }
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish(() => rejectPromise(new Error(`ops worker 超过 ${String(options.timeoutMs)} 毫秒没交结果，已放弃这次调用`)))
    }, options.timeoutMs)
    const onAbort = (): void => {
      kill()
      finish(() => rejectPromise(new Error('这次调用被取消了')))
    }
    options.signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      if (kept >= options.maxBytes) {
        lossy = true
        return
      }
      const room = options.maxBytes - kept
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
      chunks.push(Buffer.from(slice))
      kept += slice.length
      if (chunk.length > room) lossy = true
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8').slice(0, 16 * 1024 - stderr.length)
    })
    child.on('error', (error: Error) => {
      finish(() => rejectPromise(new Error(`ops worker 起不来：${error.message}（路径：${file}）`)))
    })
    child.on('close', (code: number | null) => {
      finish(() => {
        if (lossy) {
          rejectPromise(new Error(`ops worker 的输出超过 ${String(options.maxBytes)} 字节上限，这次结果不完整；把范围调小再读`))
          return
        }
        if (code === 124) {
          rejectPromise(new Error(`ops worker 自己判了超时（超过 ${String(options.timeoutMs)} 毫秒）；把范围调小，或到设置里放宽时限`))
          return
        }
        if (code !== 0) {
          rejectPromise(new Error(`ops worker 没正常收场（退出码 ${String(code)}）：${stderr.slice(0, 300)}`))
          return
        }
        resolvePromise(Buffer.concat(chunks).toString('utf8'))
      })
    })
    child.stdin?.on('error', () => {
      // worker 提前退出时写 stdin 会 EPIPE：真正的结论由 close 事件给，这里不抢话
    })
    child.stdin?.end(input, 'utf8')
  })
}

/** 把任意异常折成一句人话（error.message 可能为空）。 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}
