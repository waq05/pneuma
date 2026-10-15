/**
 * 待投递通知条（0.6.67 对齐 dsh 的 turn-trigger）：收件箱按来源拆两个面的真内核端到端。
 *
 * 用户报障：智能体团队里别的智能体发消息回来时，那条消息出现在**输入框下方**的队列条，
 * 还带着「编辑 / 撤掉 / 插话」三颗钮，并且把 `<teammate-report …>` 的原始 XML 露了出来。
 * 根因：收件箱（`async-inbox`）里只按「入箱顺序」排队，界面把整队都画成用户队列条，
 * 分不出「用户亲手发的」与「机器发起的唤醒」。修法（对照 dsh）：收件箱条目带来源，
 * 快照拆两个面——用户来源 → `queued`（输入框下方、可交互），机器来源 → `notices`
 * （输入框上方、只读）。出账（drainInbox）后两者都落成同一条 user 消息，模型侧无差别。
 *
 * 断言六层（真内核 + 假端点驱动真回合，取数走 `kernel.transcript.getSnapshot()`）：
 *   ① 用户来源入箱 → `queued` 有、`notices` 没有；
 *   ② 机器来源入箱 → `notices` 有、`queued` 没有；
 *   ③ 出账后两个面都清掉，且对话里出现那两条 user 条目；
 *   ④ 老调用点（不传来源）默认按用户算（进 `queued`）；
 *   ⑤ 插话下标 = **整条收件箱**的位置（拆面之后的账）：收件箱里排着机器通知时，只数
 *      `queued` 算出的下标会把错的那条提到队首——而且宿主照样回 `true`（静默插错）。
 *      这里用一个真回合把两种算法各跑一次，把「修好的提到用户那条 / 旧的插错还报成功」
 *      钉成行为；
 *   ⑥ 三处消费者都按收件箱原始位置算（源码钉）：壳的 `readInboxCount`、回落层
 *      `desktop/src/renderer/App.tsx` 的插话下标、终端状态栏的条数。
 *
 * 隔离：临时 HOME + 假模型端点，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm build && node scripts/teammate-notice-test.mjs
 *
 * @module dsc/scripts/teammate-notice-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsc-notice-strip-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 关掉长期记忆：它会在回合结束时投「记忆复盘」的机器通知，与本探针要观察的两条抢镜头
// （探针要的是确定性的两条，不受无关插件投递影响）。
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'memory', config: { enabled: false } }] }, null, 2),
  'utf8',
)

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(20)
  }
}

// ── 假模型端点（真 SSE）：按请求形状分派，驱动真回合 ─────────────────────────────
const sseText = (text) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'
const sseToolCall = (id, name, args) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n` +
  'data: [DONE]\n\n'

/** 插话场景的一次性闸门：置真之后，下一个含「插话场景」的请求才回工具调用（防重复触发）。 */
let scenarioArmed = false

async function serve() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const realUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && !(typeof m.content === 'string' && m.content.includes('不是用户发言')))
      const lastText =
        typeof realUser?.content === 'string'
          ? realUser.content
          : Array.isArray(realUser?.content)
            ? realUser.content.filter((p) => p.type === 'text').map((p) => p.text).join('')
            : ''
      const hasToolResult = messages.some((m) => m.role === 'tool')
      const isTitleRequest = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('会话标题生成器'),
      )
      let reply
      if (isTitleRequest) reply = sseText('通知条探针的会话标题')
      // 插话场景：靠一个一次性闸门认这一轮（`插话场景：开跑` 里也含 `开跑`，而历史里
      // 从第 1 段起就带着 tool 结果，`hasToolResult` 到后面已分不出「哪一轮的」）。
      else if (scenarioArmed && lastText.includes('插话场景')) reply = sseToolCall('t2', 'slow_steer', '{}')
      else if (hasToolResult) reply = sseText('收尾：都收到了')
      else if (lastText.includes('开跑')) reply = sseToolCall('t1', 'slow_thing', '{}')
      else reply = sseText('收到')
      res.end(reply)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const site = await serve()
const { createKernel } = await import('../lib/host/kernel.js')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: site.baseUrl,
        apiKey: 'k',
        models: [
          {
            id: 'm',
            name: 'm',
            contextWindow: 100000,
            maxTokens: 500,
            modalities: ['text'],
            thinkingLevels: [],
            thinkingParam: 'none',
            effortMap: {},
          },
        ],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

/** 机器来源的那条通知：照 subagent 插件投的 `<teammate-report …>` 形状。 */
const USER_TEXT = '用户插话：别忘了看日志'
const NOTICE_TEXT = `<teammate-report from="mate-1" role="explorer" state="已完成">
派给它的任务：查一下 package.json 里的名字
它的汇报：
名字叫 @waq666/pneuma
</teammate-report>`

/** 读快照前先抖一下失效（transcript 监听 dsc/changed 清缓存）。 */
const snapshot = () => {
  ctx.emit('dsc/changed')
  return ctx.transcript.getSnapshot()
}

// 慢工具：在它跑动期间投两条（一条用户来源、一条机器来源），此刻就是「入箱未出账」。
let during = null
const offTool = ctx.tools.register({
  name: 'slow_thing',
  description: '测试用慢工具',
  parameters: { type: 'object', properties: {} },
  risk: 'read',
  run: async () => {
    // ④ 老调用点：不传来源 → 默认按用户算。
    ctx.agent.followup(USER_TEXT)
    // ② 机器来源：显式标 notice。
    ctx.agent.followup(NOTICE_TEXT, undefined, undefined, 'notice')
    const snap = snapshot()
    during = {
      queued: snap.queued.map((item) => item.text),
      notices: snap.notices.map((item) => item.text),
      queuedIndexes: snap.queued.map((item) => item.index),
      noticeIndexes: snap.notices.map((item) => item.index),
      inbox: ctx.session.current().asyncInbox().map((item) => ({ text: item.text, origin: item.origin })),
    }
    await sleep(60)
    return 'slow ok'
  },
})

console.log('[1] 入箱期间：用户来源进 queued、机器来源进 notices（①②④）')
{
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', () => {
      off()
      resolve()
    })
  })
  ctx.agent.followup('开跑')
  const got = await until(() => during !== null)
  check('慢工具跑起来了（入箱窗口出现）', got, 'during=null')
  check('用户来源（不传来源的老调用点）进 queued', during?.queued.join('|') === USER_TEXT, JSON.stringify(during?.queued))
  check('机器来源进 notices、不进 queued', during?.notices.join('|') === NOTICE_TEXT && !during?.queued.includes(NOTICE_TEXT), JSON.stringify(during))
  check('queued 里没有机器来源', during !== null && during.queued.every((text) => !text.startsWith('<teammate-report')), JSON.stringify(during?.queued))
  check('notices 里没有用户来源', during !== null && during.notices.every((text) => text !== USER_TEXT), JSON.stringify(during?.notices))
  check(
    '收件箱条目带来源：老调用点无 origin、机器来源标 notice',
    during?.inbox[0]?.origin === undefined && during?.inbox[1]?.origin === 'notice',
    JSON.stringify(during?.inbox.map((item) => item.origin)),
  )
  check(
    '两面的 index 都是收件箱原始位置（0 / 1）',
    JSON.stringify(during?.queuedIndexes) === '[0]' && JSON.stringify(during?.noticeIndexes) === '[1]',
    JSON.stringify({ queued: during?.queuedIndexes, notices: during?.noticeIndexes }),
  )
  await ended
  await until(() => !ctx.agent.isRunning)
  await sleep(120)
}

console.log('[2] 出账后：两个面都清掉，对话里出现那两条 user 条目（③）')
{
  const snap = snapshot()
  check('出账后 queued 清空', snap.queued.length === 0, JSON.stringify(snap.queued))
  check('出账后 notices 清空', snap.notices.length === 0, JSON.stringify(snap.notices))
  check('收件箱状态条目也空了', (ctx.session.current().asyncInbox() ?? []).length === 0)
  const userEntries = snap.entries.filter((entry) => entry.kind === 'user')
  const userTexts = userEntries.map((entry) => entry.text)
  check('对话里有用户来源那条 user 条目', userTexts.includes(USER_TEXT), JSON.stringify(userTexts))
  check('对话里有机器来源那条（落成同一条 user 消息）', userTexts.includes(NOTICE_TEXT), JSON.stringify(userTexts))
  check(
    '机器汇报落库后被打 internal 标记（界面不拿它当人打的字）',
    userEntries.some((entry) => entry.text === NOTICE_TEXT && entry.internal === true),
    JSON.stringify(userEntries.map((entry) => ({ text: entry.text.slice(0, 20), internal: entry.internal }))),
  )
  const sessionUsers = ctx.session.current().messages.filter((message) => message.role === 'user').map((message) => message.content)
  check(
    '会话消息里两条都在（模型侧就是普通 user 消息）',
    sessionUsers.includes(USER_TEXT) && sessionUsers.includes(NOTICE_TEXT),
    JSON.stringify(sessionUsers.map((text) => (typeof text === 'string' ? text.slice(0, 20) : '[]'))),
  )
}

// ── ⑤ 插话下标 = 整条收件箱的位置（拆面之后的账）───────────────────────────────
/**
 * 用户插话（Ctrl+Enter）那条消息走两步：界面先算「提交那一刻队列有多长」当下标，
 * 提交之后再让宿主按这个下标把新那条提到队首。收件箱里排着机器通知时，**只数 `queued`**
 * 算出的下标会偏小 → `steerQueued` 提到的是别人那条，而宿主照样回 `true`（静默插错）。
 * 这里用一个真回合把两种算法各跑一次，把行为钉住。
 */
const USER_STEER = '用户插话：这条要排到最前面'
const NOTICE_STEER = `<teammate-report from="mate-2" role="builder" state="已完成">
派给它的任务：跑一遍自检
它的汇报：
自检通过
</teammate-report>`

/** 这一跑用哪种算法算下标：`'fixed'` = queued + notices，`'legacy'` = 只数 queued。 */
let steerMode = 'fixed'
let steerObservation = null
const offSteerTool = ctx.tools.register({
  name: 'slow_steer',
  description: '测试用慢工具（插话下标场景）',
  parameters: { type: 'object', properties: {} },
  risk: 'read',
  run: async () => {
    scenarioArmed = false
    // 机器通知先入箱：它占着收件箱第 0 位，正是老公式漏掉的那一条。
    ctx.agent.followup(NOTICE_STEER, undefined, undefined, 'notice')
    const before = snapshot()
    const indexFixed = before.queued.length + before.notices.length
    const indexLegacy = before.queued.length
    const index = steerMode === 'fixed' ? indexFixed : indexLegacy
    // 界面第二步：提交用户那条（必然落在收件箱队尾 = 上面算出的下标），再按它插话。
    ctx.agent.followup(USER_STEER)
    const done = ctx.agent.steerQueued(index)
    const inbox = ctx.session.current().asyncInbox()
    steerObservation = {
      indexFixed,
      indexLegacy,
      index,
      done,
      front: inbox[0]?.text ?? null,
      order: inbox.map((item) => (item.text === USER_STEER ? 'user' : item.origin === 'notice' ? 'notice' : 'other')),
    }
    return 'steer ok'
  },
})

/** 跑一次插话场景（真回合），返回那一刻的收件箱观察。 */
async function runSteerScenario(mode) {
  steerMode = mode
  steerObservation = null
  scenarioArmed = true
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', () => {
      off()
      resolve()
    })
  })
  ctx.agent.followup('插话场景：开跑')
  const got = await until(() => steerObservation !== null, 15000)
  await ended
  await until(() => !ctx.agent.isRunning, 30000)
  await sleep(80)
  return { got, observation: steerObservation }
}

console.log('[3] 插话下标：只数 queued 会插错（旧回落层的老公式）')
{
  const fixed = await runSteerScenario('fixed')
  check('插话场景跑起来了（慢工具进入回合）', fixed.got, JSON.stringify(fixed.observation))
  check(
    '入箱观察：机器通知在前、两种算法差一条',
    fixed.observation?.indexFixed === 1 && fixed.observation?.indexLegacy === 0,
    JSON.stringify(fixed.observation),
  )
  check(
    '修好的算法把**用户那条**提到队首（queued + notices）',
    fixed.observation?.done === true && fixed.observation?.front === USER_STEER,
    JSON.stringify(fixed.observation),
  )
  check(
    '提到的确实是新提交那条（收件箱首条 = user，机器通知退到后面）',
    fixed.observation?.order[0] === 'user' && fixed.observation?.order[1] === 'notice',
    JSON.stringify(fixed.observation?.order),
  )

  const legacy = await runSteerScenario('legacy')
  check('老算法那一跑也跑起来了', legacy.got && legacy.observation?.done === true, JSON.stringify(legacy.observation))
  check(
    '老算法：宿主照样报成功，但队首还是机器通知（用户的插话没插上）',
    legacy.observation?.front !== USER_STEER && legacy.observation?.order[0] === 'notice',
    JSON.stringify(legacy.observation),
  )
  check(
    '两种算法的下标差刚好是通知条数（这条就是漏掉的那一位）',
    legacy.observation?.indexFixed === 1 && legacy.observation?.indexLegacy === 0,
    JSON.stringify(legacy.observation),
  )
}

console.log('[4] 三处消费者都按「整条收件箱」算（源码钉）')
{
  const root = fileURLToPath(new URL('..', import.meta.url))
  const read = (rel) => readFileSync(join(root, rel), 'utf8')
  const legacyApp = read('desktop/src/renderer/App.tsx')
  const tuiApp = read('src/app/App.tsx')
  const shellComposer = read('ui-shell/src/plugins/composer/ui.tsx')
  const statusBar = read('src/app/StatusBar.tsx')

  check(
    '回落层插话下标 = queued + notices（两行写法都认）',
    /snapshot\.queued\.length\s*\+\s*\(?snapshot\.notices \?\? \[\]\)?\.length/.test(legacyApp),
    legacyApp.split('\n').find((line) => line.includes('steerIndex')) ?? '',
  )
  check(
    '壳的 readInboxCount 也是两面相加',
    (() => {
      const at = shellComposer.indexOf('function readInboxCount')
      if (at === -1) return false
      const body = shellComposer.slice(at, at + 400)
      return body.includes("snapshot?.['queued']") && body.includes("snapshot?.['notices']") && body.includes('+')
    })(),
    'readInboxCount',
  )
  check(
    '终端状态栏的条数 = queued + notices（整条收件箱）',
    /\(snapshot\.queued \?\? \[\]\)\.length\s*\+\s*\(snapshot\.notices \?\? \[\]\)\.length/.test(tuiApp),
    tuiApp.split('\n').find((line) => line.includes('queued={')) ?? '',
  )
  check(
    '状态栏那段的说明也说清数的是整条收件箱',
    statusBar.includes('整条收件箱') && statusBar.includes('`notices`'),
    'StatusBar 的 queued 注释',
  )
  check('回落层那条改动带「回落路径修复」标注（FROZEN 规矩 3）', legacyApp.includes('回落路径修复'), '注释锚点')
}

offTool()
offSteerTool()
await ctx.dispose?.()
await site.close()
console.log('')
if (failures === 0) console.log('待投递通知条电池：全部通过')
else console.log(`待投递通知条电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
process.exit(failures === 0 ? 0 : 1)
