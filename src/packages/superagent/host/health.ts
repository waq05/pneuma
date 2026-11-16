/**
 * DSC 宿主的 doctor 四项体检：编排库、飞书来源、机器依赖、队友能力。
 *
 * ## 为什么单独一个文件
 *
 * `/doctor` 的登记表是 `ctx.health`（doctor 插件提供，见 `src/packages/doctor/index.ts`），
 * 登记进去的每一项只做「读一次、给一句结论」。把这段探测混进 `index.ts` 的装配里，会让
 * 那个文件从「接线」变成「也懂库和锁」。本批从旧 `health.ts` 搬过来，只换读数来源：
 *
 * | 旧读数 | 新树读数 |
 * | --- | --- |
 * | `adapters/store.ts` 的 `DscStore`（旧编排库句柄） | `runtime.store`（新树 `app/store.ts`，插件起来时就已打开；打不开插件根本不会 apply） |
 * | 旧运行期的 `runningStats()` | `runtime.health['worker']` + `runtime.store.tickets.open()` 按阶段计数 |
 * | 旧来源句柄的 `status()` | `runtime.health['feishu' | 'history']`（新树来源自己上报的体检格） |
 * | 旧 `plugins.json` 里的 `feishuCli` | `runtime.store.settings().sources.feishu.config.cli` |
 * | 旧锁探测 | 不再另探：新树的锁是状态目录 OS 锁，本进程在 `Runtime` 构造时拿到并一直持有，探一次只会重入自己 |
 *
 * `createTeammatesHealth` 读的还是 `plugins.json` 的条目树（`readPluginEntries`），那一项
 * 本来就不属于运行期；原样搬过来。
 *
 * 四项的 id / 标题 / 排序刻度与旧文件逐字一致（100–103），`/doctor` 的 JSON 键不会变。
 *
 * @module dsc/packages/superagent/host/health
 */
import { spawnSync } from 'node:child_process'
import { resolveExecutable } from '@pneuma/runtime/core/executable.js'
import type { HealthCheck, HealthResult } from '@pneuma/runtime/services/types.js'
import { readPluginEntries } from '@pneuma/runtime/core/plugin-registry.js'
import type { Runtime } from '../app/runtime.js'
import { ticketStage } from '../core/index.js'
import type { Health } from '../sources/host.js'

/** 把未知异常压成一行可读文本。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 体检项里一行「名字：状态 —— 细节」。 */
function healthLine(name: string, entry: Health | undefined): string {
  if (entry === undefined) return `${name}：没有上报`
  return `${name}：${entry.state}${entry.detail === '' ? '' : ` —— ${entry.detail}`}`
}

/**
 * 建编排库体检项。
 *
 * 旧版的四条判据（可写 / 锁 / 卡在 running 的工单 / 部署）在新树里的对应：
 *   - **可写**：`runtime.store.atomic` 跑一个空事务，失败就是盘满 / 只读 / 被独占；
 *   - **锁**：本进程在 `Runtime` 构造时拿到了状态目录锁（拿不到会当场抛，插件不会起来），
 *     所以这里只报「本进程持有」，不再做一次自欺欺人的探测；
 *   - **工单**：未结束工单按阶段计数（执行中 / 待你处理 / 空闲）；
 *   - **部署**：`runtime.configured()` 与 `runtime.setupProblem`（新树起来之前要先过部署检查）。
 *   其余组件状态直接列 `runtime.health` 的每一格（runtime / models / worker / evals / 来源）。
 */
export function createSuperagentHealth(runtime: Runtime): HealthCheck {
  return {
    // 域名/项名两段：doctor 的 `--json` 按这个 id 出键，撞名会当场抛错。
    id: 'superagent/orchestrator',
    title: 'Super Agent 编排库',
    // 内置九项占 10–90，插件从 100 起（`services/types.ts` 的 `HealthCheck`）。
    order: 100,
    run(): HealthResult {
      const stateDir = runtime.machine.stateDir
      const detail = [`状态目录：${stateDir}`]
      // 1. 可写：空事务只拿一次写锁，不写任何业务数据。失败时 `atomic` 自己会回滚。
      let writable = true
      let writeProblem = ''
      try {
        runtime.store.atomic(() => undefined)
      } catch (error) {
        writable = false
        writeProblem = describe(error)
      }
      detail.push(writable ? '写：可写' : `写：不可写（${writeProblem}）`)
      // 2. 锁：插件能 apply 就说明构造时拿到了状态目录锁；OS 锁随进程存活，没有「半路被抢」。
      detail.push('锁：本进程持有（插件启动时已拿到状态目录锁）')
      // 3. 部署检查。
      const problem = runtime.setupProblem
      detail.push(runtime.configured()
        ? `部署：已就绪（仓库 ${runtime.deployment.repository}）`
        : `部署：等待检查（${problem?.code ?? 'unknown'}：${problem?.detail ?? ''}）`)
      // 4. 运行期各组件的体检格。
      for (const [name, entry] of Object.entries(runtime.health)) detail.push(healthLine(name, entry))
      // 5. 工单计数：可操作的东西一眼看到。
      const open = runtime.store.tickets.open()
      const counts = { working: 0, person: 0, idle: 0 }
      for (const ticket of open) {
        const stage = ticketStage(ticket).stage
        if (stage === 'working') counts.working += 1
        else if (stage === 'person') counts.person += 1
        else if (stage === 'idle') counts.idle += 1
      }
      detail.push(`工单：${open.length} 张未结束（执行中 ${counts.working} / 待你处理 ${counts.person} / 空闲 ${counts.idle}）`)

      const base = { detail: detail.join('\n') }
      if (!writable) {
        return {
          ...base,
          status: 'fail',
          summary: '编排库不可写，工单派不出去',
          fix: `检查 ${stateDir} 所在磁盘是否满、文件是否只读，以及有没有别的程序独占它`,
        }
      }
      if (!runtime.configured()) {
        return {
          ...base,
          status: 'warn',
          summary: `Super Agent 等待部署检查（${problem?.code ?? 'unknown'}）`,
          fix: '到设置 → Super Agent 填好 GitHub 仓库与智能体 gh CLI（飞书可选）；保存后会重跑检查',
        }
      }
      const failing = Object.entries(runtime.health).filter(([, entry]) => entry.state === 'error').map(([name]) => name)
      if (failing.length > 0) {
        return {
          ...base,
          status: 'warn',
          summary: `运行时组件报错：${failing.join('、')}`,
          fix: '看 detail 里那一行：来源类错误先去来源设置排查，其余重启宿主再看',
        }
      }
      return { ...base, status: 'ok', summary: '正常（库可写、状态目录锁在本进程、部署已就绪）' }
    },
  }
}

/**
 * 建飞书来源的体检项。
 *
 * 判据只有来源自己上报的两格：`feishu`（长连接）与 `history`（历史补收）。不在这里重新
 * 探一次 CLI 或长连接：那会把「来源此刻是什么状态」变成第二次测量，doctor 与面板可能给出
 * 两个答案。默认关的来源报 skip，不报 ok——「没开」与「开了但收不到」必须分得开。
 */
export function createFeishuHealth(runtime: Runtime): HealthCheck {
  return {
    id: 'superagent/feishu',
    title: 'Super Agent 飞书来源',
    // 紧跟在编排库（100）后面：同一插件的几项排在一起。
    order: 101,
    run(): HealthResult {
      const settings = runtime.store.settings()
      const instance = runtime.sources.instance('feishu', settings)
      if (instance === undefined) {
        return { status: 'skip', summary: '飞书来源没有注册（插件的来源启动那一步没跑到）' }
      }
      const entries = (['feishu', 'history'] as const).map(name => [name, runtime.health[name]] as const)
      const detail = entries.filter(([, entry]) => entry !== undefined).map(([name, entry]) => healthLine(name, entry))
      const problem = runtime.feishuProblem
      if (problem !== undefined) detail.push(`部署检查：${problem.code} —— ${problem.detail}`)
      if (!instance.enabled) {
        return { status: 'skip', summary: '飞书来源未启用（默认关）', detail: detail.join('\n') }
      }
      const failing = entries.filter(([, entry]) => entry?.state === 'error')
      if (problem !== undefined || failing.length > 0) {
        return {
          status: 'warn',
          summary: problem !== undefined ? '飞书机器人检查没过：来源不会轮询' : '飞书来源报错',
          detail: detail.join('\n'),
          fix: '限流与断网会自己退避重试；持续不好时检查网络与群成员资格，并跑一次 lark-cli auth status 看机器人身份',
        }
      }
      const states = entries.flatMap(([, entry]) => entry === undefined ? [] : [entry.state])
      if (states.length === 0) {
        return { status: 'skip', summary: '飞书来源还没开始轮询（等待部署检查）' }
      }
      // 来源启用着但循环被部署检查挡住时，报 skip 而不是 ok：与旧体检「没启动报 skip」同一条口径。
      if (states.every(state => state === 'starting' || state === 'paused')) {
        return { status: 'skip', summary: '飞书来源还没开始轮询（等待部署检查）', detail: detail.join('\n') }
      }
      return { status: 'ok', summary: '飞书来源正常（来源自己上报的体检格没有错误）', detail: detail.join('\n') }
    },
  }
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
 * 为什么用内核那份 `resolveExecutable` 而不是直接 `spawnSync('gh')`：Windows 上 gh / lark-cli
 * 多半是 npm 装的 `.cmd` 包装脚本，Node 不挂 shell 直接 spawn 必然 EINVAL，会得出「没装」的
 * 假结论。那份解析器会带回 `shell` 标记与已转义的路径（`src/core/executable.ts`）。
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
      .map(line => line.trim())
      .find(line => line !== '') ?? ''
    if (done.error !== undefined) {
      // 超时与「进程起不来」分开说：前者是这台机器慢或 CLI 卡住，后者才是权限 / 包装脚本的问题。
      const code = (done.error as NodeJS.ErrnoException).code
      if (code === 'ETIMEDOUT') return { state: 'failed', why: `--version 超过 ${String(VERSION_TIMEOUT_MS / 1000)} 秒没结束` }
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

/** 从来源配置里读一个 CLI 名：配置是 `Record<string, unknown>`，类型不对按「没填」处理。 */
function cliOf(config: Record<string, unknown> | undefined): string {
  const value = config?.cli
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 建机器依赖体检项：git、智能体的 GitHub CLI、飞书的 lark-cli 能不能拉起。
 *
 * 判据只有 `--version` 跑不跑通，不探「登录没登录」「能不能推送」：那两件事归部署检查
 * （`runtime.setupProblem`）与来源体检，在这里再测一遍会得到第二份答案。
 *
 * CLI 名现读新树设置：GitHub 用 `sources.github.config.cli`，飞书用
 * `sources.feishu.config.cli`；GitHub CLI 没填时部署检查必然报 `agentCliUnset`，这里直接说清。
 * 缺任何一条都只报 `warn`，不抛也不报 `fail`：插件本身还能起来，不用飞书的人缺 lark-cli
 * 也该照常用其它功能。
 */
export function createDependenciesHealth(runtime: Runtime): HealthCheck {
  return {
    id: 'superagent/dependencies',
    title: 'Super Agent 依赖',
    // 紧跟在飞书（101）后面：同一插件的几项排在一起。
    order: 102,
    run(): HealthResult {
      try {
        const settings = runtime.store.settings()
        const githubCli = cliOf(settings.sources.github?.config)
        const feishuCli = cliOf(settings.sources.feishu?.config)
        const git = probeVersion('git')
        const github = githubCli === '' ? undefined : probeVersion(githubCli)
        const lark = probeVersion(feishuCli === '' ? 'lark-cli' : feishuCli)
        const lineOf = (name: string, result: VersionProbe | undefined, missingHint: string): string => {
          if (result === undefined) return `${name}：${missingHint}`
          if (result.state === 'ok') return `${name}：${result.version}`
          if (result.state === 'missing') return `${name}：未安装（${missingHint}）`
          return `${name}：装了，但探不到版本（${result.why}）`
        }
        const detail = [
          lineOf('git', git, 'PATH 上找不到 git'),
          lineOf('GitHub CLI', github, '设置 → Super Agent 里没填，或用 gh 但 PATH 上找不到'),
          lineOf('lark-cli', lark, 'PATH 上找不到 lark-cli；飞书来源要用它'),
        ]

        const missing: string[] = []
        if (git.state === 'missing') missing.push('git')
        if (github === undefined || github.state === 'missing') missing.push('GitHub CLI')
        if (lark.state === 'missing') missing.push('lark-cli')
        if (missing.length > 0) {
          const fix: string[] = []
          if (git.state === 'missing') fix.push('装 Git 并重开会话让 PATH 带上它；worker 提交与 worktree 操作要用它')
          if (github === undefined || github.state === 'missing') {
            fix.push('GitHub 来源要一个登录智能体账号的 gh（或等价包装脚本）：装好后在设置 → Super Agent 的「智能体的 GitHub CLI」填命令名或绝对路径')
          }
          if (lark.state === 'missing') {
            // 说清「不装也能用」：飞书默认关，这句能省掉用户的误判。装法写明出处。
            fix.push('飞书来源才需要它（不随插件分发）：npm install -g @larksuite/cli 装好后重开会话，或在设置里填 lark-cli 的完整路径；不用飞书可以不管')
          }
          return { status: 'warn', summary: `缺 ${missing.join(' 与 ')}`, detail: detail.join('\n'), fix: fix.join('；') }
        }

        // 不是「没装」，而是装了却跑不通：把原因原样带出去，用户才知道是超时还是退出码。
        const broken: string[] = []
        if (git.state === 'failed') broken.push('git')
        if (github !== undefined && github.state === 'failed') broken.push('GitHub CLI')
        if (lark.state === 'failed') broken.push('lark-cli')
        if (broken.length > 0) {
          return {
            status: 'warn',
            summary: `${broken.join(' 与 ')} 的版本号读不出来`,
            detail: detail.join('\n'),
            fix: '看 detail 里那句原因：超时说明 CLI 卡住了，退出码说明它不认 --version 参数；装坏的话重装一次再试',
          }
        }
        return { status: 'ok', summary: '正常（git 与两个来源的 CLI 都能跑）', detail: detail.join('\n') }
      } catch (error) {
        // 设置读不出来这类意外也只记一条：体检项抛错会把整轮 `/doctor` 的结论弄脏。
        return {
          status: 'warn',
          summary: '依赖探测没跑成',
          detail: describe(error),
          fix: '看 detail 里那句原因；多半是设置读不出来，去设置 → Super Agent 存一次再看',
        }
      }
    },
  }
}

/**
 * 建队友能力体检项：`subagent` 插件启没启用。
 *
 * 为什么值得单项：worker 派队友要求 `subagent` 插件在场，而它**默认关**——不启用时那一支
 * 静默短路，派工照常，症状只是「worker 调 subagent 派不出队友」，日志里翻不到根因。
 * 缺了只报 warn 不报 fail：不用队友的人关着它该照常用其它功能。
 *
 * 判据只有条目树一行（`plugins.json` 里 `file === 'subagent'` 的条目存在且 `disabled !== true`），
 * 与运行期无关，所以不接收 `runtime`。
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
        const subagent = entries.find(entry => entry.file === 'subagent')
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
