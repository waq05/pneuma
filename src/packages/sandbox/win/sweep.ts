/**
 * 残留授权清扫：进程被强杀时 `dispose()` 没跑到，会话临时目录上的能力 ACE 会永久留着。
 *
 * 为什么需要它：`<DSC_HOME>/sandbox/tmp/<工作区哈希>` 的读写权是靠一条能力 SID
 * （`tempWriteSid`）授给受限令牌的，回收只在 `backend.ts` 的 `dispose()` 里做。
 * 宿主被任务管理器结束、断电、蓝屏——这些路径都不会走 dispose，于是目录与那条 ACE
 * 一起留在盘上。下次挂载时扫一遍，把**明显过期的**目录连 ACE 一起清掉即可。
 *
 * 两条纪律：
 *   1. **活会话绝不动**：按目录 mtime 判断年龄，不到 24 小时的目录一律进 `kept`。
 *      多会话常驻时，别的会话的临时目录可能正在被写，删了就是数据丢失。
 *   2. **单个目录失败不中断整轮**：某个目录被占用（EBUSY/EPERM）只记一条 `failed`，
 *      继续处理下一个；清扫是收尾动作，绝不能把插件挂载拖垮。
 *
 * 时钟（`now`）与删除器（`onSweep`）都可注入：自检里换成固定时间与记录器，
 * 不碰真实 ACL、不删真实目录。
 *
 * @module dsc/packages/sandbox/win/sweep
 */
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { revokeWrite } from './acl.js'
import { bindAll, tryLoadFfi, type BoundWin32 } from './ffi.js'
import { tempWriteSid } from './workspace-sid.js'
import { errText as errorText } from '../../../core/err-text.js'

/** 默认年龄门槛：超过 24 小时的临时目录才清（默认值也写进挂载时那句提示）。 */
export const DEFAULT_SWEEP_AGE_MS = 24 * 60 * 60 * 1000

/** `sweepSandboxTemps` 的入参。 */
export interface SweepOptions {
  /** 临时目录根（`<DSC_HOME>/sandbox/tmp`）。 */
  root: string
  /** 超过这个年龄的目录才删（默认 24 小时）。 */
  olderThanMs?: number
  /** 现在（毫秒），默认 Date.now。 */
  now?: () => number
  /**
   * 真实回收（默认走 acl.ts 的 revokeWrite + rmSync）。自检里换成记录器。
   * 只在目录确实超龄时调用；抛错会被记进 `failed`。
   */
  onSweep?: (entry: { path: string; sid: string; ageMs: number }) => void
}

/** 一轮清扫的结论：清掉的、留着的、失败的（各自给绝对路径）。 */
export interface SweepResult {
  swept: string[]
  kept: string[]
  failed: Array<{ path: string; why: string }>
}

/** 懒加载的绑定表：整轮清扫只初始化一次（koffi 加载不便宜）。 */
let cachedBound: BoundWin32 | null = null

/** 取（或首次创建）绑定表；FFI 不可用时给 null（非 Windows / koffi 缺失）。 */
function boundOrNull(): BoundWin32 | null {
  if (cachedBound !== null) return cachedBound
  const loaded = tryLoadFfi()
  if (!loaded.ok) return null
  try {
    cachedBound = bindAll(loaded.ffi)
    return cachedBound
  } catch {
    return null
  }
}

/**
 * 把一个目录的路径规范化成派生 SID 用的形状。
 *
 * `tempWriteSid` 的入参必须是 `realpathSync.native` 的结果（大小写、8.3 短名、符号链接
 * 拼法不同会派生出另一个身份）。规范化失败（目录刚好被删掉）就退回原路径——
 * 反正下一步 rmSync 也会失败，进 `failed` 里说明白。
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * 默认的回收动作：先摘能力 ACE，再删目录。
 *
 * 顺序有意义：ACE 挂在目录本体上，删目录其实也会带走它；先 revoke 是为了「删目录失败时
 * 授权已经收回」——那正是残留授权的根因。FFI 不可用（非 Windows / koffi 缺失）时跳过
 * revoke：那种环境根本产不出这种 ACE，目录本身还是要删的。
 */
function realSweep(path: string, sid: string, lockDir: string): void {
  const bound = boundOrNull()
  if (bound !== null) {
    mkdirSync(lockDir, { recursive: true })
    revokeWrite(bound, path, sid, lockDir)
  }
  rmSync(path, { recursive: true, force: true })
}

/**
 * 扫一遍临时目录根，清掉超龄的会话目录。
 *
 * 根不存在 → 返回三份空结果（首次启动、从没跑过受限令牌后端都是这种情形），**不抛**。
 * 其它读目录错误同样按空结果处理：清扫是尽力而为的收尾，不该有本事让挂载失败。
 */
export function sweepSandboxTemps(options: SweepOptions): SweepResult {
  const root = options.root
  const olderThanMs = options.olderThanMs ?? DEFAULT_SWEEP_AGE_MS
  const now = options.now ?? Date.now
  const result: SweepResult = { swept: [], kept: [], failed: [] }

  let names: string[]
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return result
  }

  // 年龄基准取一次：一轮清扫用同一个「现在」，避免长轮次里先算的目录被算得比后算的年轻
  const at = now()
  // 授权锁目录与 backend.ts 同口径：`<dscHome>/sandbox/locks`（root 是 `<dscHome>/sandbox/tmp`）
  const lockDir = join(dirname(root), 'locks')

  for (const name of names) {
    const raw = join(root, name)
    let mtimeMs: number
    try {
      mtimeMs = statSync(raw).mtimeMs
    } catch (error) {
      result.failed.push({ path: raw, why: `读 mtime 失败：${errorText(error)}` })
      continue
    }
    const ageMs = at - mtimeMs
    // 负年龄（mtime 在未来，比如系统时间被改过）也按「年轻」处理：绝不动
    if (ageMs < olderThanMs) {
      result.kept.push(raw)
      continue
    }

    const path = canonical(raw)
    const sid = tempWriteSid(path)
    try {
      if (options.onSweep !== undefined) {
        options.onSweep({ path, sid, ageMs })
      } else {
        realSweep(path, sid, lockDir)
      }
      result.swept.push(path)
    } catch (error) {
      // 单个目录失败（被占用、权限、目录里有正在执行的程序）只记一条，继续下一个
      result.failed.push({ path, why: errorText(error) })
    }
  }

  return result
}
