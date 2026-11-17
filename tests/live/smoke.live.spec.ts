/**
 * 真模型冒烟五条（设计 §10.4）：单轮 / 工具调用 / 多轮上下文 / 流式中断 / 压缩后继续。
 *
 * ## 什么时候跑
 *
 * 没配 `DSC_LIVE_API_KEY` 时整层 `describe.skipIf` 跳过——**跳过不算失败**（不变量 5）。
 * 配了 key 就一条都不许跳：`test-live.yml` 里另有「key 在但 0 条执行 = 红」的判据，
 * 防的是「workflow 跑了、用例悄悄没跑」这种假绿。
 *
 * ## 断言取向
 *
 * 真模型的输出不可逐字比对，所以每条只钉**结构事实**：回复非空、用量 > 0、工具真的
 * 被调用、第二轮拿得到第一轮的词、打断后没有孤儿 tool_call、压缩后还能继续。
 * 文案内容一律不比——那是在测模型的随机性，不在测这条产品的链。
 *
 * ## 为什么五条共用一个内核
 *
 * 每条单起一次内核要重复装配 + 铺 HOME（~1.5s），而且真请求本身才是大头；共用内核
 * 还能顺带覆盖「同一会话里多轮之间的状态延续」。`sequence.concurrent` 为 false，
 * 用例按声明顺序串行跑。
 *
 * @module dsc/tests/live/smoke.live
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import type { BootedKernel } from '../harness.js'
import { readSessionJsonl } from '../harness.js'
import { readUsageRecords } from '@pneuma/runtime/core/usage-log.js'
import { sanitizeToolOrphans } from '@pneuma/runtime/core/llm.js'
import {
  assistantText,
  bootLiveKernel,
  currentMessages,
  liveKeyConfigured,
  runTurnAndInterrupt,
  surfaceOf,
  toolText,
} from './helpers.js'

/** 没配 key 就整层跳过；配了就必须全部跑到（见文件头的防假绿口径）。 */
describe.skipIf(!liveKeyConfigured())('live: 真模型冒烟', () => {
  let kernel: BootedKernel

  beforeAll(async () => {
    kernel = await bootLiveKernel()
  }, 90_000)

  afterAll(async () => {
    await kernel?.dispose()
  }, 60_000)

  test('L1 单轮问答：回复非空，用量两项都 > 0', async () => {
    await kernel.runTurn('只回复两个字：收到')

    expect(assistantText(kernel).trim()).not.toBe('')

    const usage = readUsageRecords()
    expect(usage.length).toBeGreaterThan(0)
    const last = usage[usage.length - 1]
    expect(last.i).toBeGreaterThan(0)
    expect(last.o).toBeGreaterThan(0)
    // 请求确实落到了我们配的那个端点/模型上（不是悄悄退回某个默认）。
    expect(last.provider).toBe('live')
    expect(last.model).toBe(process.env.DSC_LIVE_MODEL ?? 'deepseek-chat')
  })

  test('L2 工具调用：模型真的发起调用，结果回灌后完成这一轮', async () => {
    await kernel.runTurn('请调用 bash 工具，执行命令 echo LIVE-42，然后把命令输出原样告诉我。')

    const called = currentMessages(kernel).some(
      (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
    )
    expect(called).toBe(true)
    expect(toolText(kernel)).not.toBe('')
  })

  test('L3 多轮上下文：第二轮回复里带得回第一轮的词', async () => {
    await kernel.runTurn('请记住数字 7391。只回复「记住了」三个字。')
    await kernel.runTurn('我刚才让你记住的数字是多少？只回复那个数字。')

    const messages = currentMessages(kernel)
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
    expect(lastAssistant).toBeDefined()
    expect(assistantText(kernel)).toContain('7391')
  })

  test('L4 流式中断：打断后没有孤儿 tool_call，会话文件仍可重读', async () => {
    await runTurnAndInterrupt(kernel, '请写一篇约 800 字的散文，主题是「测试夹具的修养」，一小段一小段地写。', 1_200)

    const messages = currentMessages(kernel)
    // 判据与产品同源：llm 插件每次请求前都过 sanitizeToolOrphans，这里不另写一套孤儿定义。
    expect(sanitizeToolOrphans(messages as never)).toEqual(messages)

    const path = surfaceOf(kernel).session.current().filePath
    expect(existsSync(path)).toBe(true)
    const records = readSessionJsonl(path)
    expect(records.length).toBeGreaterThan(0)
  })

  test('L5 压缩后继续：压缩真的发生，且之后还能正常回复', async () => {
    const compact = surfaceOf(kernel).compact
    expect(compact).toBeDefined()
    const compacted = await compact!.forceCompact()
    // forceCompact 忽略触发线与「历史太短」检查，所以 false = 压缩链本身没跑通。
    expect(compacted).toBe(true)

    await kernel.runTurn('压缩之后还能收到吗？只回复「在」。')
    expect(assistantText(kernel).trim()).not.toBe('')
  })
})
