/**
 * superagent 的两项体检：编排库（可写 / 锁 / running 工单）与飞书来源（连上 / 最近一条错误）。
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
 * 探测本身只读：写探测是一次 `BEGIN IMMEDIATE` 后立刻提交的空事务，锁探测是拿一次
 * 再立刻放掉——不写任何业务数据，也不留锁。飞书那项连库都不碰。
 *
 * @module dsc/packages/superagent/health
 */
import type { HealthCheck, HealthResult } from '@pneuma/runtime/services/types.js'
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
