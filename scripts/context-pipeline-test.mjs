/**
 * 上下文流水线整合自检（0.6.68 批次）：微压缩、图片卸载、环境快照、请求 invariant
 * 四层在**同一条请求**里共存的顺序、幂等与互不打架。
 *
 * 为什么单独一张网：这四条线各写各的探针，各自都绿；但它们挂在同一条投影链上，
 * 真正会出事的地方在**接缝**——
 *   ① 顺序：image-diet(550) 必须跑在 env-facts(600) 之前，否则 env 快照会白占
 *      image-diet 的「最近几个用户回合」一格，keepRounds 口径凭空保守一格；
 *      微压缩(650) 只碰文本工具结果、图片卸载(550) 只碰图像部件，两者不得互相吃掉；
 *   ② 幂等/可重建：整条链跑两遍必须逐字节同结果（WS4 的 invariant 就是靠二次派生比对，
 *      链一旦不确定，invariant 立刻误报）；
 *   ③ 日志不动：四层都只改「发给模型的那份副本」，会话日志原文一个字不能变；
 *   ④ 零误报：四层同时生效时 invariant 必须干净。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/context-pipeline-test.mjs
 *
 * @module dsc/scripts/context-pipeline-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-ctx-pipeline-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
// 假端点：内核装配需要一个能读的 config.yaml，不连真模型
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const { createKernel } = await import('../lib/host/kernel.js')
const { CLEARED_TOOL_RESULT_PREFIX } = await import('../lib/core/microcompact.js')
const { IMAGE_DIET_PLACEHOLDER } = await import('../lib/core/image-diet.js')
const { TODO_REMINDER_TEXT } = await import('../lib/core/todo-reminder.js')
const { checkReconstructable, snapshotMessages } = await import('../lib/core/request-invariant.js')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'k',
        models: [
          {
            id: 'm-img',
            name: 'm-img',
            contextWindow: 100000,
            maxTokens: 800,
            modalities: ['text', 'image'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm-img',
  },
  resumeSessionPath: null,
})
const session = ctx.session.current()

const t = (value) => ({ type: 'text', text: value })
const img = (u) => ({ type: 'image_url', image_url: { url: u } })
const userWith = (text, imageUrls = []) => ({
  role: 'user',
  content: imageUrls.length === 0 ? text : [t(text), ...imageUrls.map(img)],
})
const asstCall = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})
const toolOut = (id, body) => ({ role: 'tool', tool_call_id: id, content: body })
const asstText = (text) => ({ role: 'assistant', content: text })
const textOf = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
const imageUrlsOf = (message) =>
  (Array.isArray(message?.content) ? message.content : []).filter((part) => part.type === 'image_url').map((p) => p.image_url.url)

// ── 造一段混合历史 ───────────────────────────────────────────────────────────
// 四个真实用户回合：r1/r2/r3 各带一张图（r3 那张是顺序的判别点），r4 是当前轮。
// 八个工具结果：最旧三个要够大、够旧，才会被微压缩清掉（keepRecent 默认 5）。
// 末尾一个工具结果带图（模拟「当前正在看的那张截图」），必须活下来。
const BIG = 'x'.repeat(4000)
const history = []
history.push(userWith('第一轮：看看这个', ['data:image/png;base64,A1']))
for (let i = 1; i <= 2; i += 1) {
  history.push(asstCall(`c${i}`, 'bash', { command: `echo ${i}` }))
  history.push(toolOut(`c${i}`, `第${i}个结果 ${BIG}`))
}
history.push(userWith('第二轮：再看这个', ['data:image/png;base64,A2']))
for (let i = 3; i <= 4; i += 1) {
  history.push(asstCall(`c${i}`, 'read', { path: `f${i}.ts` }))
  history.push(toolOut(`c${i}`, `第${i}个结果 ${BIG}`))
}
history.push(userWith('第三轮：还有这个', ['data:image/png;base64,A3']))
for (let i = 5; i <= 6; i += 1) {
  history.push(asstCall(`c${i}`, 'grep', { pattern: `p${i}` }))
  history.push(toolOut(`c${i}`, `第${i}个结果 ${BIG}`))
}
history.push(userWith('第四轮：顺手看一眼屏幕'))
history.push(asstCall('c7', 'screenshot', {}))
history.push({
  role: 'tool',
  tool_call_id: 'c7',
  content: [t('屏幕截图'), img('data:image/png;base64,NEWEST')],
})
history.push(asstCall('c8', 'bash', { command: 'ok' }))
history.push(toolOut('c8', `第八个结果 ${BIG}`))
const pristine = JSON.parse(JSON.stringify(history))

// ── 跑真投影链 ───────────────────────────────────────────────────────────────
const systemText = ctx.prompt.systemPrompt(session.meta.cwd)
const sent = ctx.prompt.rewrite([{ role: 'system', content: systemText }, ...JSON.parse(JSON.stringify(history))], session)

console.log('── [1] 四层各自生效 ──')
const clearedTexts = sent.filter((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith(CLEARED_TOOL_RESULT_PREFIX))
check('微压缩：旧的工具结果被换成占位符', clearedTexts.length > 0, `cleared=${clearedTexts.length}`)
// 8 条工具结果，keepRecent=5 → 只清最旧 3 条（c1/c2/c3）；c7 是数组正文（截图），微压缩不碰它。
check('微压缩：恰好清掉最旧的 3 条', clearedTexts.length === 3, `cleared=${clearedTexts.length}`)
check(
  '微压缩：第 4 条（窗口内最早）仍是原文',
  sent.some((m) => typeof m.content === 'string' && m.content.includes('第4个结果')),
)
const allImages = sent.flatMap((m) => imageUrlsOf(m))
check('图片卸载：更早回合的图 A1 已卸载', !allImages.includes('data:image/png;base64,A1'))
check('图片卸载：最新那张截图仍在', allImages.includes('data:image/png;base64,NEWEST'))
check(
  '图片卸载：占位文本出现在被卸载的位置',
  sent.some((m) => (m.content ?? []).some?.((part) => part.type === 'text' && part.text === IMAGE_DIET_PLACEHOLDER)),
)

console.log('── [2] 顺序：image-diet 在 env-facts 之前 ──')
// 判别点：r3 那张图。image-diet 若跑在 env-facts 之后，末尾的合成快照会顶掉一个回合额度，
// keepRounds=2 的切点后移一格，r3 的图会被一起卸掉；跑在它之前则 r3 的图还在。
check('image-diet 先于 env-facts：第三轮的图 A3 仍在（快照没白占一格）', allImages.includes('data:image/png;base64,A3'))
const envSnapshots = sent.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('环境事实：'))
check('env-facts：环境快照恰好一条', envSnapshots.length === 1, `env=${envSnapshots.length}`)
check('env-facts：快照落在请求最后一条', sent[sent.length - 1] === envSnapshots[0])

console.log('── [3] 易变注入默认关 ──')
check('todo-reminder 默认不注入', !sent.some((m) => m.content === TODO_REMINDER_TEXT))

console.log('── [4] 日志不动 + 可重建 ──')
check('会话日志原文（构造的那份历史）一个字节没变', JSON.stringify(history) === JSON.stringify(pristine))
const sent2 = ctx.prompt.rewrite([{ role: 'system', content: systemText }, ...JSON.parse(JSON.stringify(history))], session)
check('整条链可重建：再跑一遍逐字节同结果', JSON.stringify(sent2) === JSON.stringify(sent))
const secondSystem = ctx.prompt.systemPrompt(session.meta.cwd)
check('系统提示词两次生成逐字节一致', secondSystem === systemText)

console.log('── [5] invariant 零误报 ──')
const before = snapshotMessages([{ role: 'system', content: systemText }, ...JSON.parse(JSON.stringify(history))])
const derived = ctx.prompt.rewrite(before, session)
const report = checkReconstructable(sent, derived, { before, after: before })
check('四层同链后 invariant 报 ok', report.ok === true, report.reason ?? '')
check('invariant digest 稳定（两次派生同摘要）', checkReconstructable(derived, derived, { before, after: before }).ok === true)

console.log(failures === 0 ? '\n上下文流水线整合自检：全部通过' : `\n上下文流水线整合自检：${failures} 条断言未过`)
process.exit(failures === 0 ? 0 : 1)
