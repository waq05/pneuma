/**
 * 沙箱 runner 的解释器解析：明确「用哪个程序跑 runner 入口」，不再假设
 * `process.execPath` 恰好是 node。
 *
 * 为什么需要这一步：runner 是一个 JS 入口，宿主要自己找个解释器去执行它。
 * 命令行版 dsc 的宿主就是 node，`process.execPath` 真能当 node 用；但桌面端
 * 的宿主是 Electron 的 `utilityProcess.fork`（desktop/electron/main/protocol.ts:91），
 * 这时 `process.execPath` 是 `electron.exe`。把 electron.exe 当 node 用必须显式
 * 置 `ELECTRON_RUN_AS_NODE=1`，否则它会按 GUI 应用启动，runner 连第一行都跑不到。
 * 过去这件事只靠父进程环境碰巧带着那个变量（例如自己是 Electron 子进程），
 * 一旦宿主换启动方式、或者环境被清过，runner 就静默起不来——换执行体失败属于
 * 安全降级，必须显式算、不能继承。
 *
 * 所以这里把「用哪个程序、带哪些环境」算成一份执行计划的一部分，而不是寄望
 * 运行时恰好对：换执行体失败属于安全降级，必须能解释清楚、也能被自检覆盖。
 *
 * 纯函数、不读 `process`：自检可以把三份入参直接喂进来，不需要真的起进程。
 *
 * @module dsc/core/sandbox/win/interpreter
 */

/** 解释器形态：`override` 是用户用 `DSC_NODE` 指定的，`electron` 要走 RUN_AS_NODE，`node` 直接用。 */
export type InterpreterKind = 'node' | 'electron' | 'override'

/** 解析结果：要执行的程序 + 形态 + 给子进程的环境。 */
export interface RunnerInterpreter {
  /** 要执行的程序路径。 */
  file: string
  kind: InterpreterKind
  /** 交给子进程的环境（在传入的那份基础上改）。 */
  env: Record<string, string | undefined>
}

/** 解析入参：入参全部由调用方给，方便纯函数自检。 */
export interface InterpreterInput {
  execPath: string
  /** 当前进程是不是 Electron 运行时（调用方传 `process.versions.electron !== undefined`）。 */
  electron: boolean
  env: Record<string, string | undefined>
}

/**
 * 按优先级挑解释器：用户指定 > Electron 运行时 > 普通 node。
 *
 * `DSC_NODE` 是逃生口：宿主既不是 node、又不想用打包进来的 electron 时，
 * 用户指一个真 node 就能跑。
 */
export function resolveRunnerInterpreter(input: InterpreterInput): RunnerInterpreter {
  const { execPath, electron, env } = input
  // 空白字符串等于没给：用户可能只写了 `DSC_NODE=` 或者一堆空格，
  // 拿这种值去当可执行文件路径只会得到一句莫名其妙的 spawn 失败。
  const override = env.DSC_NODE?.trim()
  if (override !== undefined && override !== '') {
    // 显式指定的就是真 node（或用户自认能跑的等价物）：env 原样带过去。
    // 这里绝不注入 ELECTRON_RUN_AS_NODE——它能干的事由 `file` 决定，与宿主无关；
    // 硬塞一个只会让排查时误以为这次跑在 Electron 里。
    return { file: override, kind: 'override', env: { ...env } }
  }
  if (electron) {
    // 必须无条件覆盖成 '1'：这个分支下 `file` 是 electron.exe，没有它子进程
    // 会当 GUI 应用启动。原环境里是 '0' 也照改——'0' 只会让 runner 起不来，
    // 而用户想跑的是命令，不是第二个 dsc 窗口。
    return { file: execPath, kind: 'electron', env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  // 宿主本来就是 node，process.execPath 能直接当解释器用，不必加任何变量。
  // 仍然复制一份 env：调用方后面还会叠网络变量，不能把它的对象改掉。
  return { file: execPath, kind: 'node', env: { ...env } }
}
