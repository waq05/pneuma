/**
 * B3 压缩耗时：灌 100 轮历史 → compact 完成。
 *
 * ## 口径
 *
 * 起点 = 调用 `ctx.compact.run()` 前一刻；终点 = 它 resolve（摘要调用返回、历史已替换）。
 * 不含内核启动：先 `createKernel`，再直接往 `session.messages` 灌 100 轮（200 条）历史，
 * 计时只覆盖「手动 `/compact` 这条真实入口」。
 *
 * 为什么走 `ctx.compact.run()` 而不是自动压缩：自动检查由回合前的 `check()` 触发，要先
 * 搭一轮真回合，量到的是「回合开销 + 压缩」；`run()` 是 `/compact` 命令背后的同一条实现，
 * 同样调 `compactSession`（摘要请求、锚点抽取、read-state、原样携带、写回摘要都包含）。
 *
 * 假端点只回一段短摘要：摘要估算必须小于被折叠的内容，否则 `compactSession` 会按
 * 「压缩没有意义」抛错（这是产品行为，不是基准故障）。`run()` 把异常收成一条
 * 「压缩失败」通知而不是抛出，所以失败路径靠通知与 `dsc/compacted` 事件判。
 *
 * ## 输出
 *
 * 一行 `BENCH_RESULT {id,label,metric,value,detail}`。value 单位毫秒；
 * `detail.afterMessages` 应显著小于 200（缺省 keepRecent=20，压完约 21 条）。
 *
 * @module tests/bench/b3-compact
 */
import {
  createTempHome,
  disposeKernel,
  emitResult,
  fail,
  libUrl,
  prepareHome,
  startSSEServer,
  testConfig,
} from './helpers.mjs'

const ID = 'b3-compact'
const LABEL = 'B3 压缩耗时'
const ROUNDS = 100

/** 摘要正文：必须短于被折叠的 200 条历史，否则 compactSession 判「压了反而更大」。 */
const SUMMARY = [
  '## 用户要什么',
  '- 性能基准批：压缩一条 100 轮历史。',
  '## 技术要点',
  '- plain node + 构建产物 lib/**。',
  '## 文件与代码',
  '- tests/bench/b3-compact.mjs',
  '## 报错与修法',
  '- （无）',
  '## 待办',
  '- （无）',
  '## 现在在做什么',
  '- 量压缩耗时。',
  '## 下一步',
  '- 写基线。',
  '## 关键上下文',
  '- 假端点只回这段摘要。',
].join('\n')

createTempHome('dsc-bench-b3-')
prepareHome(process.env.HOME ?? process.env.USERPROFILE)

const server = await startSSEServer({ content: SUMMARY })
let ctx
try {
  const { createKernel } = await import(libUrl('host/kernel.js'))
  ctx = await createKernel({ config: testConfig(server.baseUrl), resumeSessionPath: null, surface: 'none' })
  const session = ctx.session?.current?.()
  if (session === undefined || session === null) throw new Error('内核起好后拿不到当前会话')

  // 灌历史：真实回合会产生 user/assistant 交替与工具消息；压缩只关心条数与 token 估算，
  // 这里给等长的纯文本轮次，避免假端点被工具调用剧本拖慢。
  for (let round = 1; round <= ROUNDS; round += 1) {
    session.messages.push({
      role: 'user',
      content: `第 ${round} 轮：检查 src/packages/foo/index.ts 第 ${round} 行的实现，报错 ENOENT 必须原文保留。`,
    })
    session.messages.push({
      role: 'assistant',
      content: `第 ${round} 轮结论：路径 src/packages/foo/index.ts:${round}，函数 build${round} 已处理。`,
    })
  }

  const notices = []
  ctx.on('dsc/notice', (text) => notices.push(String(text)))
  let compactedEvents = 0
  ctx.on('dsc/compacted', () => {
    compactedEvents += 1
  })

  const beforeMessages = session.messages.length
  const startedAt = performance.now()
  await ctx.compact.run()
  const elapsedMs = performance.now() - startedAt
  const afterMessages = session.messages.length

  const failure = notices.find((text) => text.includes('压缩失败'))
  if (failure !== undefined) throw new Error(`压缩入口报错：${failure}`)
  if (compactedEvents !== 1) throw new Error(`dsc/compacted 触发 ${compactedEvents} 次，期望 1 次`)
  if (!(afterMessages < beforeMessages)) {
    throw new Error(`压缩没有缩短历史：${beforeMessages} → ${afterMessages} 条`)
  }

  emitResult({
    id: ID,
    label: LABEL,
    metric: 'ms',
    value: Math.round(elapsedMs * 1000) / 1000,
    detail: { beforeMessages, afterMessages, compactedEvents },
  })
} catch (error) {
  fail(`${LABEL}：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await server.close()
  if (ctx !== undefined) await disposeKernel(ctx)
}
