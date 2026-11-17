/**
 * B1 会话启动：`createKernel` → 会话服务就绪。
 *
 * ## 口径
 *
 * 计时起点 = 调用 `createKernel()` 前一刻；终点 = 它 resolve、且
 * `ctx.session.current()` 交回一条带 `filePath` 的可用会话（服务面也逐项点过名）。
 * 插件行、外部插件、`~/.dsc` 首启铺设、会话文件创建都在这个区间里；进程启动、
 * 模块图加载**不算**——`lib/host/kernel.js` 在计时前已经 import 好，否则每条基准
 * 都在量 Node 的模块解析，而不是内核装配。
 *
 * 为什么不用 harness 的 `bootKernel`：它是 TS，量化的是「宿主来自 src、插件来自 lib」
 * 的混合平面，还要经过 Vite 别名。基准只认构建产物 `lib/**`，跑前先 `pnpm run build`；
 * lib 比源码旧时测到的是旧代码，这是基准层刻意接受的代价。
 *
 * ## 输出
 *
 * 一行 `BENCH_RESULT {id,label,metric,value,detail}`。value 单位毫秒。
 *
 * @module tests/bench/b1-session-start
 */
import { createTempHome, disposeKernel, emitResult, fail, libUrl, prepareHome, testConfig } from './helpers.mjs'

const ID = 'b1-session-start'
const LABEL = 'B1 会话启动'

createTempHome('dsc-bench-b1-')
prepareHome(process.env.HOME ?? process.env.USERPROFILE)

const { createKernel } = await import(libUrl('host/kernel.js'))
const config = testConfig('http://127.0.0.1:9')

let ctx
try {
  const startedAt = performance.now()
  ctx = await createKernel({ config, resumeSessionPath: null, surface: 'none' })
  const session = ctx.session?.current?.()
  const elapsedMs = performance.now() - startedAt

  if (typeof ctx.agent?.followup !== 'function') throw new Error('会话服务就绪后 ctx.agent.followup 不可用')
  if (typeof ctx.session?.current !== 'function') throw new Error('会话服务就绪后 ctx.session.current 不可用')
  if (session === undefined || session === null || typeof session.filePath !== 'string' || session.filePath === '') {
    throw new Error('会话服务就绪后拿不到带 filePath 的会话')
  }
  if (!Array.isArray(session.messages)) throw new Error('会话服务就绪后 session.messages 不是数组')

  emitResult({
    id: ID,
    label: LABEL,
    metric: 'ms',
    value: Math.round(elapsedMs * 1000) / 1000,
    detail: { messages: session.messages.length },
  })
} catch (error) {
  fail(`${LABEL}：${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (ctx !== undefined) await disposeKernel(ctx)
}
