/**
 * `llm/stream` 旁路事件自检：把一次调用的用量按 dsh 的 waterfall 约定发出去。
 *
 * 为什么要这条（而不是只靠真包验收）：真包验收要联网装 `dsh-cost-meter`，进不了默认门禁；
 * 而这条链路一旦断了，症状是「成本条又是空的」——必须有一条不用网络的钉子。
 *
 * 钉三件事：
 *   1. 事件名与参数：`llm/stream`，options 带 sessionId / provider / model；
 *   2. chunk 形状：`{ type:'usage', usage:{ inputTokens, outputTokens, cacheReadTokens,
 *      cacheWriteTokens, reasoningTokens } }`（缺省补 0，不给 undefined）；
 *   3. 旁路不伤人：ctx 没有 waterfall、监听者抛错、监听者不消费——都不能把调用方带崩。
 *
 * 跑法：cd D:\dsc && pnpm run build && node scripts/dsh-llm-event-check.mjs
 */
import { publishDshUsage, LLM_STREAM_EVENT } from '../lib/core/dsh-compat/llm-usage-event.js'

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

/** 造一个只会派发的假 ctx：记录一次 waterfall 调用，按监听者链算返回值。 */
function fakeCtx(listener) {
  const seen = { name: '', args: [] }
  return {
    seen,
    waterfall(name, ...args) {
      seen.name = name
      seen.args = args
      const next = args[args.length - 1]
      return listener === undefined ? next() : listener(args[0], next)
    },
  }
}

const base = {
  sessionId: 'sid-1',
  provider: 'deepseek',
  model: 'deepseek-chat',
  inputTokens: 120,
  outputTokens: 30,
}

console.log('派发形状')
{
  const ctx = fakeCtx()
  await publishDshUsage(ctx, { ...base, cacheReadTokens: 7, cacheWriteTokens: 3 })
  check('事件名是 llm/stream', ctx.seen.name === LLM_STREAM_EVENT && ctx.seen.name === 'llm/stream', ctx.seen.name)
  check('options 自带会话、供应商、模型', ctx.seen.args[0]?.sessionId === 'sid-1' && ctx.seen.args[0]?.provider === 'deepseek' && ctx.seen.args[0]?.model === 'deepseek-chat', JSON.stringify(ctx.seen.args[0]))
  check('第二个参数是 next（waterfall 约定）', typeof ctx.seen.args[1] === 'function')
}

console.log('chunk 形状（监听者看到什么）')
{
  let chunks = null
  let finished = false
  const ctx = fakeCtx((options, next) => {
    // 包一层，与 dsh-cost-meter 的 billing-stream 同构：读 chunk、记账、再吐给下游
    const downstream = next()
    return (async function* wrapper() {
      for await (const chunk of downstream) {
        chunks = chunks ?? []
        chunks.push(chunk)
        yield chunk
      }
      finished = true
    })()
  })
  await publishDshUsage(ctx, base)
  const usage = chunks?.[0]?.usage
  check('拿到一个 usage chunk', chunks?.length === 1 && chunks?.[0]?.type === 'usage', JSON.stringify(chunks?.[0]))
  check('token 数字原样带出', usage?.inputTokens === 120 && usage?.outputTokens === 30, JSON.stringify(usage))
  check('缓存字段缺省补 0（不是 undefined）', usage?.cacheReadTokens === 0 && usage?.cacheWriteTokens === 0, JSON.stringify(usage))
  check('reasoning 也补 0', usage?.reasoningTokens === 0, JSON.stringify(usage))
  check('监听者的 finally 有机会跑（迭代器被消费完）', finished === true)
}

console.log('旁路不伤人')
{
  check('ctx 没有 waterfall 时静默返回', await publishDshUsage({}, base).then(() => true, () => false))
  const throwing = {
    waterfall() {
      throw new Error('插件炸了')
    },
  }
  check('监听者抛错不往上冒', await publishDshUsage(throwing, base).then(() => true, () => false))
  const notIterator = { waterfall: () => ({}) }
  check('返回的不是迭代器也不崩', await publishDshUsage(notIterator, base).then(() => true, () => false))
  const lazy = fakeCtx(() => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }))
  check('监听者给个空流也能收场', await publishDshUsage(lazy, base).then(() => true, () => false))
}

console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
