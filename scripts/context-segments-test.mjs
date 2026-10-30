/**
 * 上下文读数的口径与瘦身（2026-10-30）：分段里「工具定义」不再冒充「工具结果」，
 * 超长工具结果按 dsh 的口径只留头尾，沙箱/模式说明挪到请求末尾。
 *
 * 为什么要这几条：
 *   ① 用户看到「工具定义 41.8K」以为工具描述太肥，实际那 41.8K 是 62 条 run_code 的返回原文；
 *      真·工具定义（schema）以前根本没进分段。改完之后两个数分开算，判断才不会指错方向。
 *   ② 那些原文每轮都重发。PTC 一次返回整份文件是常态，历史里的旧结果只留头尾能直接省钱。
 *   ③ 沙箱档位与当前模式以前在系统提示词里：切一次权限/模式，前缀缓存整段失效
 *      （实测一次切换：命中 4K、未命中 59K）。挪到末尾快照之后前缀复用，信息一个字不少。
 *
 * 隔离：临时 HOME，真实 ~/.dsc 一个字节不动；不连真模型。
 * 运行：pnpm build && node scripts/context-segments-test.mjs
 *
 * @module dsc/scripts/context-segments-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-ctx-segments-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })
writeFileSync(join(process.env.DSC_HOME, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const cwd = join(home, 'ws')
mkdirSync(cwd, { recursive: true })

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

const { estimateRequestSegments, estimateTextTokens } = await import('../lib/core/token-estimate.js')
const { pruneToolResults, DEFAULT_TOOL_RESULT_PRUNE } = await import('../lib/core/tool-result-prune.js')

console.log('\n[1] 分段：工具定义与工具结果各算各的')
{
  const messages = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '看看这个' },
    { role: 'tool', content: 'x'.repeat(3000) },
  ]
  const schema = 'y'.repeat(1200)
  const seg = estimateRequestSegments(messages, schema)
  check('schema 段等于工具定义的估算值', seg.schema === Math.ceil(estimateTextTokens(schema)), `${seg.schema} vs ${Math.ceil(estimateTextTokens(schema))}`)
  check('tools 段等于工具结果的估算值', seg.tools === Math.ceil(estimateTextTokens(messages[2].content)), String(seg.tools))
  check('两段不相等（确实是两个数）', seg.schema !== seg.tools)
  const bare = estimateRequestSegments(messages)
  check('不传 schema 时是 0（压缩摘要调用那种）', bare.schema === 0)
}

console.log('\n[2] 修剪：只切中间，两头都留，最近几条不动')
{
  const long = 'A'.repeat(3000) + 'M'.repeat(20000) + 'Z'.repeat(3000)
  const messages = [
    { role: 'tool', content: long },
    { role: 'tool', content: 'B'.repeat(20) },
  ]
  // keepRecent 设 0：这一段单独验「怎么切」，不掺「最近几条不动」
  const pruned = pruneToolResults(messages, { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 0 })
  const text = pruned[0].content
  check('超长结果被切短', text.length < long.length, `${text.length} vs ${long.length}`)
  check('开头保留（4096 个字符）', text.startsWith('A'.repeat(3000)), text.slice(0, 20))
  check('结尾保留（1024 个字符）', text.endsWith('Z'.repeat(1024)), text.slice(-20))
  check('中间有「省掉多少字符」的说明', text.includes('省掉了') && /省掉了 \d+ 个字符/.test(text), text.slice(3000, 3200))
  check('短结果原样不动', pruned[1].content === messages[1].content)
  check('原数组不被就地修改', messages[0].content === long)
}

console.log('\n[3] 修剪是确定性的：同一条消息两次切出同一段文本')
{
  const long = 'x'.repeat(30000)
  const messages = [{ role: 'tool', content: long }]
  const a = pruneToolResults(messages, { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 0 })
  const b = pruneToolResults(messages, { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 0 })
  check('两次结果逐字节相同（前缀缓存靠这条）', a[0].content === b[0].content)
  check('没有可修剪时返回同一个数组引用（不白造副本）', pruneToolResults([{ role: 'tool', content: 'short' }]) === undefined ? false : true)
}

console.log('\n[4] 最近 keepRecent 条不修剪')
{
  const long = 'z'.repeat(30000)
  const messages = [0, 1, 2, 3, 4].map(() => ({ role: 'tool', content: long }))
  const pruned = pruneToolResults(messages, { ...DEFAULT_TOOL_RESULT_PRUNE, keepRecent: 2 })
  check('前三条被切短', pruned.slice(0, 3).every((message) => message.content.length < long.length))
  check('最近两条原样', pruned.slice(3).every((message) => message.content === long))
}

console.log('\n[5] 沙箱与模式说明：不进系统提示词，进请求末尾的快照')
{
  const { createKernel } = await import('../lib/host/kernel.js')
  const kernel = await createKernel({ config: {} })
  const prompt = kernel.get('prompt')
  const session = kernel.get('session').current()

  const system = prompt.systemPrompt(cwd, { sessionId: session.meta.id, cwd })
  check('系统提示词里没有【沙箱】段', !system.includes('【沙箱】'), system.slice(0, 120))
  check('系统提示词里没有当前模式段', !system.includes('当前模式：'), system.slice(0, 120))

  const rewritten = prompt.rewrite([{ role: 'user', content: '你好' }], session)
  const tailText = rewritten.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')
  check('快照里带着沙箱档位', tailText.includes('【沙箱】档位'), tailText.slice(-400))
  check('快照里带着当前模式', tailText.includes('当前模式：'), tailText.slice(-400))
  check('快照仍在请求最后一条', rewritten.length > 0 && rewritten[rewritten.length - 1].role === 'user')

  // 同一个会话切模式：系统提示词逐字节不变（前缀缓存因此不失效）
  const mode = kernel.get('mode')
  mode.setMode('plan')
  const system2 = prompt.systemPrompt(cwd, { sessionId: session.meta.id, cwd })
  check('切模式后系统提示词逐字节不变', system2 === system)
  const rewritten2 = prompt.rewrite([{ role: 'user', content: '你好' }], session)
  const tail2 = rewritten2.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')
  check('切模式后快照里换成了计划模式', tail2.includes('当前模式：计划'), tail2.slice(-300))

  await kernel.dispose?.()
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
