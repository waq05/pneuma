/**
 * ptc 插件：注册 `run_code` 工具——模型写一段 JavaScript，在代码里批量调工具。
 *
 * 这是 dsh「PTC 模式」的个人版：模型不再一轮轮地调工具，而是写一段程序，
 * 在程序里筛选、去重、统计、汇总，只把结论交回上下文。**只属于 PTC 模式**
 * （工具条目上的 `presets: ['ptc']`），标准模式里它不会露头。
 *
 * 三条不肯让步的规矩：
 *   1. **脚本里的每次工具调用照旧过守卫链**：模式闸门、安全钩子、审批卡一个不少，
 *      被拒的那条不会执行，拒因原样回到脚本里，脚本可以自己决定要不要接着跑。
 *   2. **模型看到的必须能落进日志**：每次调用的名字、参数、成败、耗时都进 run_code
 *      的结果正文。它们不各自成为一条 tool 记录——jsonl 里 tool 记录必须与 assistant
 *      的 tool_call 成对，凭空插一条会让重放出来的请求 400。
 *   3. **跑飞了要能停下来**：同步死循环由 vm 的超时掐断，异步拖时间由总时限掐断，
 *      调用次数也有上限（见 core/ptc.ts 的 PTC_LIMITS）。
 *
 * 隔离强度的诚实说明：脚本跑在同进程的 `node:vm` 上下文里，拿不到 `process` /
 * `require` / 文件系统，出口只有 sdk 这一个；但**没有进程级隔离**（dsh 用的是子进程
 * 沙箱）。能做的事 = 它能调用的工具，而工具本身仍受审批与守卫约束。
 *
 * @module dsc/plugins/ptc
 */
import vm from 'node:vm'
import type { Plugin } from '@deepseek-ai/cordis'
import { argsSummary, callFacts, type ToolEntry } from '../core/tools.js'
import {
  PTC_LIMITS,
  PTC_SDK_SIGNATURE,
  type PtcCallRecord,
  ptcDescribe,
  ptcResultBody,
} from '../core/ptc.js'
import { resolvePluginConfig } from '../core/plugin-registry.js'

/** PTC 的模式名（与 core/presets.ts 的 PTC_PRESET 同一个值）。 */
const PTC_PRESET = 'ptc'

const RUN_CODE_DESCRIPTION = (deadlineMs: number): string => `用一段 JavaScript 批量调用工具，在代码里筛选汇总，只把结论交回来。

怎么写：code 是一段 JavaScript 的**函数体**（可以直接 await、可以 return）。里面用 sdk 调工具：
  ${PTC_SDK_SIGNATURE}
每个工具函数返回它原来的输出文本；参数与它单独调用时完全一样。
  const found = await sdk.grep({ pattern: 'TODO', path: 'src' })
  return found.split('\\n').slice(0, 20).join('\\n')

拿不准有哪些工具、某个工具要什么参数时，直接在脚本里问：
  return Object.keys(sdk)             // 当前能用的全部工具名
  return sdk.describe('read')         // 某个工具的说明与参数 schema

规矩：
- 每次 sdk.xxx() 都照旧过审批与安全钩子，被拒的那条返回“【被拒绝】原因”，脚本接着跑。
- console.log 的输出会随结果一起交回来（只留最后 ${PTC_LIMITS.consoleLines} 行）。
- 一段脚本最多调 ${PTC_LIMITS.maxCalls} 次工具，最多跑 ${Math.round(deadlineMs / 1000)} 秒。
- 交回的内容超过 ${PTC_LIMITS.resultMax} 字符会被截断：先在代码里把结果压小，再 return 摘要。
- 同进程 vm 里跑：拿不到 process / require / 文件系统，唯一的出口就是 sdk。`

/**
 * 可暂停的脚本时限。
 *
 * 为什么不能只用一个 `setTimeout`：脚本里 `await sdk.ask_user(...)`、等待审批卡的时候，
 * 那是在**等人**，不该算进「脚本跑了多久」。用户在一张卡上想三分钟，120 秒的表先响，
 * 脚本被掐死；他把答案点完，交回来的答案已经没有人在接了——2026-10-29 报障的形状。
 *
 * 停表是协作式的：只有认得出来的等待（工具声明了 `waitsForHuman`、守卫链弹审批卡）
 * 才走 `hold()`；脚本自己 `await sleep(60000)` 照样计入时限，跑飞了还是会被掐断。
 * @param ms - 脚本的总时限（毫秒）。
 */
function createDeadline(ms: number): {
  /** 到点就 reject 的 Promise：与脚本、中断信号一起 race。 */
  promise: Promise<never>
  /** 在这段等待期间停表，结束后接着走（嵌套调用按最外层计）。 */
  hold<T>(fn: () => Promise<T>): Promise<T>
  /** 收尾：撤掉计时器，之后的 resume 不再重新上表。 */
  stop(): void
} {
  let expire: (error: Error) => void = () => {}
  const promise = new Promise<never>((_resolve, reject) => {
    expire = reject
  })
  /** 还剩多少毫秒。停表时扣掉已经走过的部分，续表时按它重新上表。 */
  let remaining = ms
  /** 当前嵌了几层等待（守卫链与工具本体可能同时停表）。 */
  let waiting = 0
  /** 本次上表的起点（算「已经走了多久」用）。 */
  let startedAt = 0
  let timer: NodeJS.Timeout | undefined
  let closed = false
  const arm = (): void => {
    startedAt = Date.now()
    timer = setTimeout(() => {
      timer = undefined
      expire(new Error(`脚本跑了超过 ${Math.round(ms / 1000)} 秒，被掐断了`))
    }, Math.max(0, remaining))
  }
  arm()
  return {
    promise,
    async hold<T>(fn: () => Promise<T>): Promise<T> {
      waiting += 1
      if (waiting === 1 && timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
        remaining = Math.max(0, remaining - (Date.now() - startedAt))
      }
      try {
        return await fn()
      } finally {
        waiting -= 1
        if (waiting === 0 && !closed && timer === undefined) arm()
      }
    },
    stop(): void {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/** 插件在条目树（`~/.dsc/plugins.json`）里的键，也是 `deadlineMs` 的归属。 */
const CONFIG_KEY = 'ptc'

/** 脚本总时限的可调区间（毫秒）：低于 30 秒连装个依赖都不够，高于 15 分钟等于没有时限。 */
export const PTC_DEADLINE_RANGE = { min: 30_000, max: 900_000 } as const

/**
 * 取脚本总时限：插件配置里的 `deadlineMs`，没有就用 {@link PTC_LIMITS.deadlineMs}。
 *
 * 为什么可配（2026-10-29 报障）：默认 120 秒时，一条 `npm install` 或一次 12 秒的 pytest
 * 加上前后几步就把额度用光，脚本被掐断后只能跨轮轮询，每轮都在烧额度。
 * @param passed - 装配时传进来的配置（内核挂载时的第二参数）。
 */
export function readDeadlineMs(passed: unknown): number {
  const raw = resolvePluginConfig(CONFIG_KEY, passed)
  const num = Number(raw.deadlineMs)
  // 没配置就用常量，不再夹一次：常量是代码里的决定，夹取只用来约束用户填进来的数。
  if (!Number.isFinite(num)) return PTC_LIMITS.deadlineMs
  return Math.min(Math.max(Math.round(num), PTC_DEADLINE_RANGE.min), PTC_DEADLINE_RANGE.max)
}

export const ptcPlugin: Plugin.Object = {
  name: 'ptc',
  inject: ['tools', 'guards', 'transcript'],
  apply(ctx, passed) {
    /** 每次跑脚本现读：改完配置不必重启宿主。 */
    const deadlineMs = (): number => readDeadlineMs(passed)
    /**
     * 跑一段脚本。
     * @param code - 函数体源码。
     * @param cwd - 会话工作目录（内部工具调用按它解析相对路径）。
     * @param signal - 这一轮的取消信号（用户打断时脚本连同内部调用一起停）。
     * @param session - 发起脚本的会话身份：内部工具调用过守卫链/落台账都按它归属（0.6.48）。
     */
    const runScript = async (
      code: string,
      cwd: string,
      signal: AbortSignal,
      session: { id: string; path: string },
    ): Promise<string> => {
      // 注册表在这一刻快照：脚本跑的过程中插件热挂载不会让 SDK 中途变样
      const registry = new Map<string, ToolEntry>(
        ctx.tools
          .list()
          .filter((entry) => entry.name !== 'run_code')
          .map((entry) => [entry.name, entry]),
      )
      const records: PtcCallRecord[] = []
      const logs: string[] = []
      let calls = 0
      let trouble: string | undefined
      // 整段脚本的时限（等人时停表，见 createDeadline 的注释）
      const deadline = createDeadline(deadlineMs())

      /**
       * T38 读写闸（对齐 dsh 的「mutating calls run alone」）：写/执行调用独占——
       * 跑的时候读也得等，排队写也挡着新读（不让写饿死）；读调用互相并发。
       * 没有它，脚本里一句 `Promise.all([sdk.write(…), sdk.write(…)])` 就能并发落盘。
       * 守卫链（审批卡）在进闸**之前**问：等人不该挡住别的读。
       */
      const gate = (() => {
        let activeReads = 0
        let writes = 0 // 在跑的 + 排队的写
        let holder = false
        let waiters: Array<() => void> = []
        const notify = (): void => {
          const waiting = waiters
          waiters = []
          for (const wake of waiting) wake()
        }
        const wait = (): Promise<void> => new Promise((resolve) => waiters.push(resolve))
        return {
          async read<T>(fn: () => Promise<T>): Promise<T> {
            while (writes > 0) await wait()
            activeReads += 1
            try {
              return await fn()
            } finally {
              activeReads -= 1
              notify()
            }
          },
          async write<T>(fn: () => Promise<T>): Promise<T> {
            writes += 1
            try {
              while (holder || activeReads > 0) await wait()
              holder = true
              try {
                return await fn()
              } finally {
                holder = false
              }
            } finally {
              writes -= 1
              notify()
            }
          },
        }
      })()

      /** 脚本调一次工具：守卫链 → 执行 → 遮红 → 记日志。 */
      const callTool = async (rawName: unknown, rawArgs: unknown): Promise<string> => {
        const name = String(rawName ?? '')
        const entry = registry.get(name)
        if (entry === undefined) {
          throw new Error(`没有名为「${name}」的工具。可用：${[...registry.keys()].join('、')}`)
        }
        if (calls >= PTC_LIMITS.maxCalls) {
          throw new Error(`一段脚本最多调 ${PTC_LIMITS.maxCalls} 次工具，已经用完了`)
        }
        const args =
          rawArgs === undefined || rawArgs === null
            ? {}
            : typeof rawArgs === 'string'
              ? (JSON.parse(rawArgs) as Record<string, unknown>) // 模型偶尔把参数写成 JSON 串
              : (rawArgs as Record<string, unknown>)
        calls += 1
        const seq = `${calls}`
        const callId = `ptc-${Date.now().toString(36)}-${seq}`
        const started = Date.now()
        // 界面上的实时卡片：让用户看见脚本正在调什么（这一条不进会话日志，
        // 原因见文件头第 2 条；日志靠结果正文里的调用清单留底）。
        // 带归属：脚本可能是后台会话在跑，卡片只能落在它自己的视图里（切走了就不画）。
        ctx.transcript.emit({ type: 'tool/call', callId, name, args: JSON.stringify(args) }, session.id)
        // 守卫链可能弹审批卡：等人点卡的时间同样不算脚本时间
        const verdict = await deadline.hold(() =>
          ctx.guards.gate({
            toolName: name,
            risk: entry.risk,
            cwd,
            args,
            signal,
            sessionId: session.id,
            sessionPath: session.path,
            ...callFacts(args, cwd),
          }),
        )
        if (verdict.action === 'deny') {
          records.push({ name, args: argsSummary(args), ms: Date.now() - started, ok: false, note: verdict.reason })
          ctx.transcript.emit(
            { type: 'tool/result', callId, text: `【被拒绝】${verdict.reason}`, error: 'rejected' },
            session.id,
          )
          return `【被拒绝】${verdict.reason}`
        }
        try {
          // T38：写/执行走独占闸，只读走并发闸（闸的规矩见上面的注释）
          const run = (): ReturnType<typeof entry.run> =>
            entry.run(args, { cwd, signal, sessionId: session.id, sessionPath: session.path })
          // 声明了 waitsForHuman 的工具（提问卡）整段等待停表：用户想多久都不算脚本时间
          const execute = (): ReturnType<typeof entry.run> =>
            entry.waitsForHuman === true ? deadline.hold(run) : run()
          const output = entry.risk === 'read' ? await gate.read(execute) : await gate.write(execute)
          const raw = typeof output === 'string' ? output : output.text
          // 工具结果里的密钥形状字符串不进脚本、不进日志（遮红挂在观察者链上）
          const text = ctx.guards.observe(name, raw)
          const images = typeof output === 'string' ? 0 : (output.images?.length ?? 0)
          records.push({
            name,
            args: argsSummary(args),
            ms: Date.now() - started,
            ok: true,
            ...(images > 0 ? { note: `返回了 ${images} 张图，脚本里拿不到图（本轮已忽略）` } : {}),
          })
          ctx.transcript.emit({ type: 'tool/result', callId, text }, session.id)
          return text
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          records.push({ name, args: argsSummary(args), ms: Date.now() - started, ok: false, note: message })
          ctx.transcript.emit({ type: 'tool/result', callId, text: message, error: 'tool-error' }, session.id)
          return `【执行失败】${message}`
        }
      }

      const sdk: Record<string, unknown> = {}
      for (const name of registry.keys()) {
        // 名字不合法（MCP 那种带 `__`、插件名带 `-`）的工具照样能用，写成 sdk["名字"] 就是了
        sdk[name] = (args: unknown) => callTool(name, args)
      }
      // 两个查目录的入口放在工具之后：万一某个工具真叫 describe / list，那个工具优先，
      // 助手让位（宁可少两个助手，也不能把一个真工具挡掉）
      if (!('describe' in sdk)) {
        sdk.describe = (name: unknown) => {
          const entry = registry.get(String(name ?? ''))
          return entry === undefined
            ? `没有名为「${String(name ?? '')}」的工具。可用：${[...registry.keys()].join('、')}`
            : ptcDescribe(entry)
        }
      }
      if (!('list' in sdk)) sdk.list = () => [...registry.keys()]

      const sandboxConsole = {
        log: (...parts: unknown[]): void => {
          logs.push(parts.map((part) => (typeof part === 'string' ? part : safeJson(part))).join(' '))
          if (logs.length > PTC_LIMITS.consoleLines) logs.shift()
        },
      }
      const sandbox = {
        sdk,
        console: sandboxConsole,
        sleep: (ms: unknown) =>
          new Promise<void>((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 5_000))),
      }
      const context = vm.createContext(sandbox, { name: 'dsc-ptc' })

      let value: unknown
      try {
        // 脚本就是一段函数体，套一层异步立即执行函数之后顶层可以直接 await
        const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'dsc-ptc.js' })
        const started = script.runInContext(context, { timeout: PTC_LIMITS.syncTimeoutMs }) as Promise<unknown>
        // runInContext 的 timeout 只管同步段；await 之后的时间靠这条总时限兜住
        value = await Promise.race([
          Promise.resolve(started),
          deadline.promise,
          new Promise((_resolve, reject) => {
            const abort = (): void => reject(new Error('用户打断了这一轮，脚本停止'))
            if (signal.aborted) abort()
            else signal.addEventListener('abort', abort, { once: true })
          }),
        ])
      } catch (error) {
        trouble = error instanceof Error ? error.message : String(error)
      } finally {
        deadline.stop()
      }

      return ptcResultBody({ value, calls: records, logs, ...(trouble !== undefined ? { trouble } : {}) })
    }

    ctx.tools.register({
      name: 'run_code',
      description: RUN_CODE_DESCRIPTION(deadlineMs()),
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: '一段 JavaScript 的函数体。用 sdk.<工具名>(参数) 调工具，return 要交回的内容。',
          },
        },
        required: ['code'],
        additionalProperties: false,
      },
      risk: 'exec',
      // 只属于 PTC 模式：切到别的模式时它不会出现在模型面前
      presets: [PTC_PRESET],
      run: async (args, runCtx) =>
        runScript(String(args.code ?? ''), runCtx.cwd, runCtx.signal, {
          id: runCtx.sessionId,
          path: runCtx.sessionPath,
        }),
    })
  },
}

/** 控制台里打印对象时的兜底（循环引用不该让脚本挂掉）。 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
