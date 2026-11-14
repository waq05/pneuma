/**
 * superagent 的三项体检：编排库（可写 / 锁 / running 工单）、飞书来源（连上 / 最近一条错误）、
 * 机器依赖（git 与 lark-cli 在不在）。
 *
 * 为什么单独一个文件：`/doctor` 的登记表是 `ctx.health`（doctor 插件提供，见
 * `src/packages/doctor/index.ts:144`），登记进去的每一项只做「读一次、给一句结论」。
 * 把这段探测混进 `index.ts` 的装配里，会让那个文件从「接线」变成「也懂库和锁」。
 *
 * 编排库那项的三条判据各自对应一类真会出的事：
 *   - **不可写**：盘满、文件只读、被别的进程用独占方式打开——这时派工全部会失败，
 *     而面板上只会看到「派工失败」，看不到根因；
 *   - **锁被占**：另一个 Pneuma 正握着编排库（设计文档 §5.4）。本进程这次能打开库
 *     不代表两边同时写是安全的，早点说出来比等数据打架好；
 *   - **卡在 running**：分配说在跑、进程里却没有 worker。正常路径上 `recover()` 会
 *     给它起一份新分配接着干；还留在 running 的，说明恢复没跑到（或恢复之后又丢了 worker）。
 *
 * 飞书那项只读来源自己的 `status()`。没启动时**报 skip 而不是 ok**：「默认关」与「开了
 * 但一条消息也收不到」在面板上必须能分辨，两者都报 ok 等于把后者藏起来。
 *
 * 依赖那项查 git 与 lark-cli 能不能拉起。为什么值得单项：缺 git 时症状是「派工失败」，
 * 缺 lark-cli 时症状是「飞书来源没启动」——两处日志里都只有一句话，用户翻不到「其实是
 * 没装命令行工具」。为什么缺了只报 warn 不报 fail：插件本身还能起来、编排队列还在，
 * 而且飞书默认关，不用飞书的人缺 lark-cli 也该照常用其它功能。
 *
 * 探测本身只读：写探测是一次 `BEGIN IMMEDIATE` 后立刻提交的空事务，锁探测是拿一次
 * 再立刻放掉——不写任何业务数据，也不留锁。飞书那项连库都不碰；依赖那项只起两个
 * `--version` 子进程（各 5 秒上限），读不到就记一句原因，不抛。
 *
 * @module dsc/packages/superagent/health
 */
import { spawnSync } from 'node:child_process'
import type { HealthCheck, HealthResult } from '@pneuma/runtime/services/types.js'
import { resolveExecutable } from '@pneuma/runtime/core/executable.js'
import { readPluginEntries } from '../../core/plugin-registry.js'
import { acquireInstanceLock, StoreError, type DscStore } from './adapters/store.js'
import { orchestratorDbPath } from './paths.js'

/** 体检项从装配处拿的两样读数。 */
export interface SuperagentHealthProbe {
  /** 当前打开着的编排库；null = 插件还没启动（懒启动，还没人用过）。 */
  store(): DscStore | null
  /** 未结束、最新分配还在 running 的工单：总数，以及其中进程里没有 worker 的。 */
  running(): { total: number; orphaned: number }
}

/** 飞书来源的体检只读来源自己的三样；`null` = 来源没启动。 */
export interface SuperagentFeishuProbe {
  /**
   * 已启动来源的 `status()`（`adapters/feishu/loops.ts:191`）。
   *
   * 没启动（默认关、没配群、CLI 找不到，或启动失败）时给 `null`：这一项据此报 skip，
   * 而不是把「没这回事」说成「正常」。
   */
  status(): { connected: boolean; lastPollAt: string | null; lastError: string | null } | null
}

/** 把未知异常压成一行可读文本。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 锁的一次探测结果。 */
type LockState = { state: 'free' } | { state: 'busy' } | { state: 'unknown'; why: string }

/**
 * 拿一次单实例锁再立刻放掉，用「拿不拿得到」判锁有没有被别人占着。
 *
 * 为什么不看锁文件在不在：OS 锁的持有者是内核对象，进程一死就没了，但文件可能还在
 * （`src/core/os-lock.ts` 记过这个坑）。只有真去拿一次，结论才与「另一个进程能不能启动」
 * 一致。窗口只有几微秒，代价是极小概率让另一个正在启动的进程失败一次。
 */
function probeLock(): LockState {
  let held: ReturnType<typeof acquireInstanceLock>
  try {
    held = acquireInstanceLock()
  } catch (error) {
    if (error instanceof StoreError && error.code === 'instance_lock_busy') return { state: 'busy' }
    return { state: 'unknown', why: describe(error) }
  }
  try {
    return { state: 'free' }
  } finally {
    held.release()
  }
}

/**
 * 建一条体检项。
 *
 * @param probe - 装配处给的两个读数（库句柄、running 工单计数）
 * @returns 可以直接 `ctx.health.register(...)` 的一项
 */
export function createSuperagentHealth(probe: SuperagentHealthProbe): HealthCheck {
  return {
    // 域名/项名两段：doctor 的 `--json` 按这个 id 出键，撞名会当场抛错。
    id: 'superagent/orchestrator',
    title: 'Super Agent 编排库',
    // 内置九项占 10–90，插件从 100 起（`services/types.ts:1528`）。
    order: 100,
    run(): HealthResult {
      const dbPath = orchestratorDbPath()
      const detail = [`库：${dbPath}`]
      const store = probe.store()
      if (store === null) {
        return {
          status: 'skip',
          summary: 'Super Agent 还没启动（编排库没打开，还没有工单）',
          detail: detail.join('\n'),
        }
      }

      // 1. 可写：空事务只拿一次写锁，不写任何业务数据。失败时 `atomic` 自己会回滚。
      let writable = true
      let writeProblem = ''
      try {
        store.atomic(() => undefined)
      } catch (error) {
        writable = false
        writeProblem = describe(error)
      }
      detail.push(writable ? '写：可写' : `写：不可写（${writeProblem}）`)

      // 2. 锁：另开一次探测，拿不到就是别的进程正握着。
      const lock = probeLock()
      if (lock.state === 'free') detail.push('锁：空着（本进程能拿到）')
      else if (lock.state === 'busy') detail.push('锁：被另一个进程占着')
      else detail.push(`锁：探不了（${lock.why}）`)

      // 3. 卡在 running 的工单。
      let running = { total: 0, orphaned: 0 }
      try {
        running = probe.running()
      } catch (error) {
        detail.push(`running 工单：读不出来（${describe(error)}）`)
      }
      if (running.total > 0 || running.orphaned > 0) {
        detail.push(`running 工单：${String(running.total)} 张（其中 ${String(running.orphaned)} 张进程里没有 worker）`)
      } else {
        detail.push('running 工单：没有')
      }

      const base = { detail: detail.join('\n') }
      if (!writable) {
        return {
          ...base,
          status: 'fail',
          summary: '编排库不可写，工单派不出去',
          fix: `检查 ${dbPath} 所在磁盘是否满、文件是否只读，以及有没有别的程序独占打开它`,
        }
      }
      if (lock.state === 'busy') {
        return {
          ...base,
          status: 'warn',
          summary: '编排库的锁被另一个进程占着',
          fix: '确认是不是开了第二个 Pneuma；同时开两个会互相踩库，关掉多余的那个再试',
        }
      }
      if (lock.state === 'unknown') {
        return {
          ...base,
          status: 'warn',
          summary: '锁探测失败（库本身可写）',
          fix: '看 detail 里那句原因；多半是锁目录没有权限',
        }
      }
      if (running.orphaned > 0) {
        return {
          ...base,
          status: 'warn',
          summary: `${String(running.orphaned)} 张工单卡在 running，进程里没有 worker`,
          fix: '重启宿主会触发恢复：还没报结论的单会被自动接续；报过失败或卡住的单要人按 /sa retry 继续',
        }
      }
      return { ...base, status: 'ok', summary: '正常（库可写、锁空着、没有卡住的工单）' }
    },
  }
}

/**
 * 建飞书来源的体检项。
 *
 * 判据只有两条，都是来源自己记的：`connected` 与 `lastError`。不在这里重新探一次 CLI 或
 * 长连接：那会把「来源此刻是什么状态」变成第二次测量，doctor 与面板可能给出两个答案。
 *
 * @param probe - 装配处给的 `status()` 读数
 * @returns 可以直接 `ctx.health.register(...)` 的一项
 */
export function createFeishuHealth(probe: SuperagentFeishuProbe): HealthCheck {
  return {
    // 与编排库那项同域不同项：`--json` 按 id 出键，两项都登记时不会撞。
    id: 'superagent/feishu',
    title: 'Super Agent 飞书来源',
    // 紧跟在编排库（100）后面：同一插件的两项排在一起。
    order: 101,
    run(): HealthResult {
      const status = probe.status()
      if (status === null) {
        return {
          status: 'skip',
          summary: '飞书来源未启动（没配群或没装 CLI）',
          detail: '设置里打开「飞书来源」并填上群 chat_id，且 lark-cli 能解析（PATH 上或在设置里给路径）时才启动；默认关。',
        }
      }
      const detail = [status.lastPollAt === null ? '补收：还没跑过一轮' : `补收：上一轮在 ${status.lastPollAt}`]
      if (status.lastError !== null) {
        detail.push(`最近一条错误：${status.lastError}`)
        return {
          status: 'warn',
          summary: status.connected ? '飞书长连接连着，但最近一轮读取失败' : '飞书长连接没连上',
          detail: detail.join('\n'),
          fix: '看 detail 里那条错误：限流与断网会自己退避重试；持续不好时检查网络，并跑一次 lark-cli auth status',
        }
      }
      if (!status.connected) {
        return {
          status: 'warn',
          summary: '飞书来源在补收，但长连接没连上',
          detail: detail.join('\n'),
          fix: '常见原因是机器人没被加进群，或 CLI 没登录；跑一次 lark-cli auth status 看机器人身份是否 ready',
        }
      }
      return { status: 'ok', summary: '飞书来源正常（长连接已连上）', detail: detail.join('\n') }
    },
  }
}

/** 依赖体检从装配处拿的一件读数。 */
export interface SuperagentDependenciesProbe {
  /** 设置里的 `feishuCli`（命令名或路径）；空串由装配层补默认名，这里只认非空。 */
  larkCli(): string
}

/** 一条命令的 `--version` 探测结局。 */
type VersionProbe =
  | { state: 'ok'; version: string }
  | { state: 'missing' }
  | { state: 'failed'; why: string }

/** 版本探测的超时（毫秒）：查「装没装」不该让 `/doctor` 站住更久。 */
const VERSION_TIMEOUT_MS = 5_000

/**
 * 起一次 `--version`，只要版本号那一行。
 *
 * 为什么用内核那份 `resolveExecutable` 而不是直接 `spawnSync('lark-cli')`：Windows 上
 * lark-cli 多半是 npm 装的 `.cmd` 包装脚本，Node 不挂 shell 直接 spawn 必然 EINVAL，
 * 会得出「没装」的假结论。那份解析器会带回 `shell` 标记与已转义的路径
 * （`src/core/executable.ts:50`），全仓库只有这一份，设置页与实际启动才不会是两套答案。
 *
 * @param command - 命令名或路径
 * @returns 三种结局：跑通了带版本号、找不到、装了但跑不通
 */
function probeVersion(command: string): VersionProbe {
  const target = resolveExecutable(command, process.env, process.cwd())
  if (!target.found) return { state: 'missing' }
  try {
    const done = spawnSync(target.spawnFile, ['--version'], {
      // `.cmd` / `.bat` 只能经 shell 起。参数是写死的 `--version`，没有外部输入拼进来。
      shell: target.shell,
      encoding: 'utf8',
      windowsHide: true,
      timeout: VERSION_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // 版本号有的 CLI 写 stdout、有的写 stderr，两边都收。
    const firstLine = `${done.stdout ?? ''}\n${done.stderr ?? ''}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
    if (done.error !== undefined) {
      // 超时与「进程起不来」分开说：前者是这台机器慢或 CLI 卡住，后者才是权限 / 包装脚本的问题。
      const code = (done.error as NodeJS.ErrnoException).code
      if (code === 'ETIMEDOUT') {
        return { state: 'failed', why: `--version 超过 ${String(VERSION_TIMEOUT_MS / 1000)} 秒没结束` }
      }
      return { state: 'failed', why: `起不来（${done.error.message}）` }
    }
    if (done.status !== 0) {
      const printed = firstLine === '' ? '' : `：${firstLine.slice(0, 120)}`
      return { state: 'failed', why: `--version 退出码 ${String(done.status ?? -1)}${printed}` }
    }
    return { state: 'ok', version: firstLine === '' ? '（没打印版本号）' : firstLine.slice(0, 120) }
  } catch (error) {
    return { state: 'failed', why: describe(error) }
  }
}

/**
 * 建依赖体检项：git 与 lark-cli 能不能拉起。
 *
 * 判据只有 `--version` 跑不跑通，不探「git 能不能提交」「lark-cli 登没登录」：那两件事
 * 各有自己的失败面（工作树、飞书来源的 `status()`），在这里再测一遍会得到第二份答案。
 *
 * 缺任何一条都只报 `warn`，不抛也不报 `fail`：插件本身还能起来，飞书默认关着，不用飞书
 * 的人缺 lark-cli 也该照常用其它功能。detail 里写明「未安装」与后果，用户才知道要不要装。
 *
 * @param probe - 装配处给的 lark-cli 读数
 * @returns 可以直接 `ctx.health.register(...)` 的一项
 */
export function createDependenciesHealth(probe: SuperagentDependenciesProbe): HealthCheck {
  return {
    // 与前两项同域不同项：`--json` 按 id 出键，三项都登记时不会撞。
    id: 'superagent/dependencies',
    title: 'Super Agent 依赖',
    // 紧跟在飞书（101）后面：同一插件的三项排在一起。
    order: 102,
    run(): HealthResult {
      try {
        const git = probeVersion('git')
        const lark = probeVersion(probe.larkCli())
        const lineOf = (name: string, result: VersionProbe, missingHint: string): string => {
          if (result.state === 'ok') return `${name}：${result.version}`
          if (result.state === 'missing') return `${name}：未安装（${missingHint}）`
          return `${name}：装了，但探不到版本（${result.why}）`
        }
        const detail = [
          lineOf('git', git, 'PATH 上找不到 git'),
          lineOf('lark-cli', lark, 'PATH 上找不到 lark-cli；飞书来源要用它'),
        ]

        const missing: string[] = []
        if (git.state === 'missing') missing.push('git')
        if (lark.state === 'missing') missing.push('lark-cli')
        if (missing.length > 0) {
          const fix: string[] = []
          if (git.state === 'missing') {
            fix.push('装 Git 并重开会话让 PATH 带上它；没 git 建不出工作树，派工必然失败')
          }
          if (lark.state === 'missing') {
            // 说清「不装也能用」：飞书默认关，这句能省掉用户的误判。装法写明出处：
            // lark-cli 不随插件分发（2026-11-14 拍板），npm 包是官方仓库 @larksuite/cli。
            fix.push('飞书来源才需要它（不随插件分发）：npm install -g @larksuite/cli 装好后重开会话，或在设置 → Super Agent 里填 lark-cli 的完整路径；不用飞书可以不管')
          }
          return {
            status: 'warn',
            summary: `缺 ${missing.join(' 与 ')}`,
            detail: detail.join('\n'),
            fix: fix.join('；'),
          }
        }

        // 不是「没装」，而是装了却跑不通：把 reason 原样带出去，用户才知道是超时还是退出码。
        const broken: string[] = []
        if (git.state === 'failed') broken.push('git')
        if (lark.state === 'failed') broken.push('lark-cli')
        if (broken.length > 0) {
          return {
            status: 'warn',
            summary: `${broken.join(' 与 ')} 的版本号读不出来`,
            detail: detail.join('\n'),
            fix: '看 detail 里那句原因：超时说明 CLI 卡住了，退出码说明它不认 --version 参数；装坏的话重装一次再试',
          }
        }
        return { status: 'ok', summary: '正常（git 与 lark-cli 都能跑）', detail: detail.join('\n') }
      } catch (error) {
        // 设置读不出来这类意外也只记一条：体检项抛错会把整轮 `/doctor` 的结论弄脏。
        return {
          status: 'warn',
          summary: '依赖探测没跑成',
          detail: describe(error),
          fix: '看 detail 里那句原因；多半是设置文件读不出来，去设置 → Super Agent 存一次再看',
        }
      }
    },
  }
}

/**
 * 建队友能力体检项：`subagent` 插件启没启用。
 *
 * 为什么值得单项：收队友与 spawn 都要求 `subagent` 插件在场（执行器 `hostFromContext` 的
 * `ctx.get('team')`），而它**默认关**（`subagent/cordis.patch.yml:5`）——不启用时那一支
 * 静默短路，派工照常，症状只是「worker 调 subagent 派不出队友」，日志里翻不到根因。
 * 缺了只报 warn 不报 fail：不用队友的人关着它该照常用其它功能。
 *
 * 判据只有条目树一行：`readPluginEntries()` 里 `file === 'subagent'` 的条目**存在且
 * `disabled !== true`** 才算开——条目缺失也是关（它默认关，`plugin-registry.ts:499`）。
 * 只读，不写盘。
 *
 * @returns 可以直接 `ctx.health.register(...)` 的一项
 */
export function createTeammatesHealth(): HealthCheck {
  return {
    id: 'superagent/teammates',
    title: 'Super Agent 队友能力',
    // 紧跟在依赖（102）后面：同一插件四项排在一起。
    order: 103,
    run(): HealthResult {
      try {
        const entries = readPluginEntries()
        const subagent = entries.find((entry) => entry.file === 'subagent')
        if (subagent !== undefined && subagent.disabled !== true) {
          return { status: 'ok', summary: '可用（subagent 插件已启用）' }
        }
        return {
          status: 'warn',
          summary: 'subagent 插件没启用：worker 派不出队友',
          detail: subagent === undefined
            ? 'plugins.json 里没有 subagent 条目——它默认关，没在插件中心动过就是这个状态'
            : 'plugins.json 里 subagent 条目标着 disabled',
          fix: '要队友就去插件中心打开 subagent 并重开宿主；不用队友可以不管——派工与其余功能不受影响',
        }
      } catch (error) {
        return {
          status: 'warn',
          summary: '队友能力探测没跑成',
          detail: describe(error),
          fix: '看 detail 里那句原因；多半是 plugins.json 读不出来，去插件中心确认 subagent 的开关',
        }
      }
    },
  }
}
