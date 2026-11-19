/**
 * 队友会话「能当主会话打开」的探针（2026-11-18 方案 A，2026-11-19 补复活）。
 *
 * 钉住七件事，任何一条退化都会让「子智能体和主会话功能相同」重新变成只读浮层：
 *   1. 落盘位置与主会话同形：`<会话根>/<工作目录名>/<id>.jsonl`，meta 带 origin/parentSession，
 *      且 meta.id 与文件名一致（旧实现是两个 uuid，`Session.load` 会算出假路径）；
 *   2. 侧栏不列它（`listSessions()` 按 origin 跳过），入口只在状态面板的「子智能体」区；
 *   3. `session.open(队友文件)` 打开的是**同一个** Session 实例，且不另造常驻 agent
 *      （两条 agent 写同一份日志会互相踩）；
 *   4. 打开之后输入框那一句真的进了队友的收件箱（`agent.followup` 不带 sessionId 时按
 *      当前查看的会话投递，而不是「最后一个 active」）；
 *   5. 一次性队友收工后不再接话：打开它只有历史，投进去的话不会写进它的日志；
 *   6. 名册冻结工牌与角色说明书（收工时写着，不是靠角色文件现读）；
 *   7. `team.open(名字)` 把**收工但本进程没有循环**的可续接队友复活：打开后
 *      `agent.acceptsInput` 为真、`hasAgent` 仍为假（循环是 subagent 插件那份）、
 *      输入框里的话真的起了回合，且系统提示用的是冻结的说明书。
 *
 * 隔离：临时 HOME + DSC_HOME（两条都设，别只设一条——只设 HOME 时 DSC_HOME 从父进程继承，
 * 探针会写进用户真实的 ~/.dsc）。
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-teammate-open-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(process.env.DSC_HOME, { recursive: true })
writeFileSync(join(process.env.DSC_HOME, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
writeFileSync(
  join(process.env.DSC_HOME, 'plugins.json'),
  JSON.stringify(
    {
      version: 1,
      entries: [
        { file: 'subagent', disabled: false, config: { allowDelegation: true, notify: 'quiet' } },
        { file: 'memory', config: { enabled: false } },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

let failures = 0
const failed = []
const check = (label, condition, extra = '') => {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures += 1
    failed.push(label)
    console.log(`  FAIL  ${label}${extra === '' ? '' : ` — ${extra}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await sleep(25)
  }
}

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

let teammateCalls = 0
/** 复活后那一轮请求里带的系统提示（验「用的是不是名册里冻结的那份说明书」）。 */
const revivedSystems = []
/** 要派几个一次性队友（用当前这轮之前说过什么决定）。 */
let oneShotSpawned = false

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
    const system = messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    const realUser = [...messages]
      .reverse()
      .find((m) => m.role === 'user' && !(typeof m.content === 'string' && m.content.includes('不是用户发言')))
    const lastText = typeof realUser?.content === 'string' ? realUser.content : ''
    if (system.includes('会话标题生成器')) {
      res.end(sseText('队友会话探针'))
      return
    }
    if (system.includes('你在团队里的位置')) {
      teammateCalls += 1
      // 只认「复活后那一句」的请求：同一条链上别的队友随时可能也在跑（一次性队友收工前
      // 可能还有一拍），按全局最后一份比会把别人那份系统提示当成它的。
      if (lastText === '接着干') revivedSystems.push(system)
      res.end(sseText(`队友第 ${teammateCalls} 轮：查完了，包名叫 pneuma`))
      return
    }
    // 先认「这一轮用户说了什么」，再认历史里有没有工具结果：主会话派过队友之后，
    // 历史里永远躺着 tool 消息，按它分流会把后面的派活话术全吞掉。
    if (lastText.includes('一次性')) {
      oneShotSpawned = true
      res.end(
        sseToolCall(
          'ts2',
          'subagent',
          JSON.stringify({
            action: 'spawn',
            role: 'explorer',
            task: '一次性任务：查一下包名，一句话交差',
            background: true,
            keep: false,
          }),
        ),
      )
      return
    }
    if (lastText.includes('派队友')) {
      res.end(
        sseToolCall(
          'ts1',
          'subagent',
          JSON.stringify({
            action: 'spawn',
            role: 'explorer',
            task: '慢队友任务：查一下 package.json 里的包名，一句话交差',
            background: true,
          }),
        ),
      )
      return
    }
    if (messages.some((m) => m.role === 'tool')) {
      res.end(sseText('收到队友的汇报了。'))
      return
    }
    res.end(sseText('收到'))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const { createKernel } = await import('../lib/host/kernel.js')
const { listSessions } = await import('../lib/core/session.js')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'k',
        models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

const parent = ctx.session.current()
const team = ctx.get('team')
const mateOf = (name) => team.list().find((mate) => mate.name === name)

/**
 * 复活用的固定样本：一条「当年跑过、现在本进程里没有循环」的队友记录。
 *
 * 在派任何队友**之前**就造好：名册是整份读改写（`remember` 每次读一遍再写回），
 * 探针自己在中途往文件里追加一行会和那些写回撞车——撞上了这一位就被抹掉，
 * 后面的复活检查跟着假失败。提前造好，之后每次写回都会把它原样带上。
 */
const { randomUUID } = await import('node:crypto')
const { slugCwd } = await import('../lib/core/session.js')
const sessionsRoot = join(process.env.DSC_HOME, 'sessions')
const rosterPath = join(process.env.DSC_HOME, 'team', 'roster.json')
mkdirSync(join(process.env.DSC_HOME, 'team'), { recursive: true })
const deadId = randomUUID()
const deadDir = join(sessionsRoot, slugCwd(parent.meta.cwd))
mkdirSync(deadDir, { recursive: true })
const deadFile = join(deadDir, `${deadId}.jsonl`)
// 形状与 startTeammate 落盘的一致。直接写而不是走 Session.create：那条路的写入是流式的
// （close 之后还要等一拍），探针要的是当场可读的一份固定样本。
writeFileSync(
  deadFile,
  `${JSON.stringify({ type: 'meta', id: deadId, origin: 'subagent', parentSession: parent.meta.id, cwd: parent.meta.cwd, createdAt: Date.now() })}\n` +
    `${JSON.stringify({ type: 'user', text: '历史里的一句话', ts: Date.now() })}\n`,
  'utf8',
)
const deadSize = readFileSync(deadFile, 'utf8').length
writeFileSync(
  rosterPath,
  JSON.stringify(
    {
      teammates: [
        {
          name: 'dead-mate',
          role: 'explorer',
          state: 'idle',
          task: '查一下包名',
          file: deadFile,
          cwd: parent.meta.cwd,
          parent: 'lead',
          depth: 1,
          rounds: 1,
          startedAt: Date.now() - 60_000,
          finishedAt: Date.now() - 30_000,
          mode: 'continuable',
          sessionId: parent.meta.id,
          badge: { tools: null, maxTurns: 4, approval: 'ask', model: null, effort: null },
          prompt: '你是探子：只读，不写文件，只回一句话。',
        },
      ],
    },
    null,
    2,
  ),
  'utf8',
)

// ── 1. 派一个后台队友，等它收工 ─────────────────────────────────────────────
console.log('1. 派活：会话落在会话目录里，身份写进 meta')
ctx.agent.followup('派队友')
const spawned = await until(() => team.list().some((mate) => mate.attached === true))
check('队友派出且登记为「在册」（attached=true）', spawned, JSON.stringify(team.list()))
const mate = team.list().find((row) => row.name !== 'dead-mate') ?? {}
const name = mate.name ?? ''
const file = mate.file ?? ''
check('队友会话文件存在', file !== '' && existsSync(file), file)

check('落在会话根的目录下（与主会话同形）', file.startsWith(sessionsRoot), file)
check('不再落在 .teammates 里', !file.includes(join(sessionsRoot, '.teammates')), file)

/** 读首行的 meta（文件是新开的写流，meta 要等第一条日志落盘，所以轮询等它）。 */
const readMeta = () => {
  try {
    const first = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] ?? ''
    const record = JSON.parse(first)
    return record.type === 'meta' ? record : {}
  } catch {
    return {}
  }
}
const metaReady = await until(() => readMeta().id !== undefined)
let meta = metaReady ? readMeta() : {}
check('meta 首行写着 origin=subagent', meta.origin === 'subagent', JSON.stringify(meta))
check('meta 首行写着父会话 id', meta.parentSession === parent.meta.id, String(meta.parentSession))
check('meta.id 与文件名一致（load 不会再算出假路径）', meta.id === basename(file, '.jsonl'), String(meta.id))

// 冻结账（2026-11-19）：收工的队友要能按原样复活，工牌与说明书必须落在名册里。
const rosterRow = (who) => {
  try {
    const doc = JSON.parse(readFileSync(rosterPath, 'utf8'))
    return Array.isArray(doc.teammates) ? doc.teammates.find((row) => row.name === who) : undefined
  } catch {
    return undefined
  }
}
const frozen = rosterRow(name)
check('名册冻结了工牌（badge）', frozen !== undefined && typeof frozen.badge === 'object' && frozen.badge !== null, JSON.stringify(frozen?.badge))
check('名册冻结了角色说明书（prompt）', typeof frozen?.prompt === 'string' && frozen.prompt !== '', String(frozen?.prompt ?? '').slice(0, 40))

// ── 2. 侧栏不列它 ───────────────────────────────────────────────────────────
console.log('2. 会话列表：队友那条不进侧栏')
const listed = listSessions().map((item) => item.path)
check('侧栏列表里没有队友会话', !listed.some((path) => path === file), listed.slice(0, 3).join(' | '))

// ── 3. 打开它：同一个 Session 实例，不另造 agent ─────────────────────────────
console.log('3. 打开：复用队友自己的那条会话，不造第二个 agent')
await ctx.session.open(file)
const teammateId = ctx.session.current().meta.id
check('当前会话切成了队友那条', teammateId === meta.id, `${teammateId} vs ${String(meta.id)}`)
check('打开的是同一个 Session 对象（没重读、没抢租约）', ctx.agent.sessionFor(file) === ctx.session.current())
check('没有为它另造常驻 agent', ctx.agent.hasAgent(teammateId) === false, String(ctx.agent.hasAgent(teammateId)))

// ── 4. 输入框那一句真的进了队友的收件箱 ─────────────────────────────────────
console.log('4. 说话：不带 sessionId 的 followup 投给当前查看的会话')
const before = teammateCalls
ctx.agent.followup('再说一句')
check('队友又跑了一轮（假端点收到了新请求）', await until(() => teammateCalls > before), `${before} -> ${teammateCalls}`)
check('它跑完回到 idle', await until(() => mateOf(name)?.state === 'idle'), JSON.stringify(team.list().map((m) => [m.name, m.state])))

// ── 5. 切回父会话 ───────────────────────────────────────────────────────────
console.log('5. 回父会话：队友仍在册')
await ctx.session.open(parent.filePath)
check('当前会话回到主会话', ctx.session.current().meta.id === parent.meta.id, ctx.session.current().meta.id)
check('父会话重新有了常驻 agent', ctx.agent.hasAgent(parent.meta.id) === true)
check('队友仍在册且状态是 idle', mateOf(name)?.attached === true && mateOf(name)?.state === 'idle', JSON.stringify(team.list().map((m) => [m.name, m.state, m.attached])))

// ── 6. 一次性队友：收工后只读 ────────────────────────────────────────────────
console.log('6. 一次性队友：收工后打开只剩历史，说的话不写进它的日志')
const beforeOneShot = teammateCalls
ctx.agent.followup('派一个一次性队友')
const oneShotFound = await until(() => team.list().some((row) => row.mode === 'one-shot'), 15000)
check('一次性队友进了名册', oneShotFound, JSON.stringify(team.list().map((m) => [m.name, m.mode, m.state])))
const oneShotName = team.list().find((row) => row.mode === 'one-shot')?.name ?? ''
const oneShotSettled = await until(() => mateOf(oneShotName)?.state === 'idle')
check('假端点确实为它跑过一轮', teammateCalls > beforeOneShot && oneShotSettled, `${beforeOneShot} -> ${teammateCalls}`)
// 收工那一刻 settle 会把它从在队表摘掉（detach）：名册那一行留着，attached 变 false。
check('一次性队友收工后不在册（attached=false）', oneShotSettled && mateOf(oneShotName)?.attached === false, JSON.stringify(mateOf(oneShotName)))
const oneShot = mateOf(oneShotName) ?? {}
check('一次性队友拿得到会话文件', typeof oneShot.file === 'string' && oneShot.file !== '', String(oneShot.file))
await ctx.session.open(oneShot.file ?? '')
const oneShotId = ctx.session.current().meta.id
const notices = ctx.transcript
  .getSnapshot()
  .entries.filter((entry) => entry.kind === 'system')
  .slice(-3)
  .map((entry) => entry.text)
  .join(' / ')
check('打开它的会话不造 agent（没有工牌，不冒充主会话）', ctx.agent.hasAgent(oneShotId) === false, `file=${String(oneShot.file)} current=${oneShotId} notices=${notices}`)
// 2026-11-19：界面据此把输入框换成只读说明（status.acceptsInput）
check('一次性队友的会话不接受输入（acceptsInput=false）', ctx.agent.acceptsInput(oneShotId) === false)
const sizeBefore = readFileSync(oneShot.file, 'utf8').length
ctx.agent.followup('这句话不该写进一次性队友的日志')
await sleep(300)
const oneShotLog = readFileSync(oneShot.file, 'utf8')
// 判「那句话没进日志」而不是比字节数：队友自己的收尾记录（若有）会让文件长个几十字节，
// 那是它本来的回合写下的，与「往里塞用户发言」是两件事。
check('写进去的话被拦下了（日志里没有那句话）', !oneShotLog.includes('这句话不该写进一次性队友的日志'), `${sizeBefore} -> ${oneShotLog.length}`)

// ── 7. 移除：文件与登记一起收 ────────────────────────────────────────────────
console.log('7. 移除：名册、登记、文件一起收')
// 先等它真的闲下来：还在干活时 remove 会回一句「先停止」，那也是一种「移除」（回执里带这两个字），
// 但什么都没删——不先等，这条检查就会在机器慢的时候假通过假失败。
check('移除前它已经收工', await until(() => mateOf(name)?.state !== 'working'), JSON.stringify(mateOf(name)))
const removed = await team.remove(name)
check('移除有明确回执', removed.includes('移除') && !removed.includes('还在干活'), removed)
check('名册里没有它了', team.list().every((row) => row.name !== name))
check('文件被删除', !existsSync(file), file)
check('名字释放后不再有它的会话登记', ctx.agent.sessionFor(file) === undefined)

// ── 8. 收工的可续接队友：点开时按冻结工牌复活 ────────────────────────────────
console.log('8. 复活：本进程没有循环的收工队友，点开就能接着说话')
await ctx.session.open(parent.filePath)
check('造好的记录在名册里且不在册（attached=false）', mateOf('dead-mate')?.attached === false, JSON.stringify(mateOf('dead-mate')))

const beforeRevive = teammateCalls
revivedSystems.length = 0
await team.open('dead-mate')
check('打开的是它那条会话', ctx.session.current().meta.id === deadId, ctx.session.current().meta.id)
check('复活后能接话（acceptsInput=true）', ctx.agent.acceptsInput(deadId) === true, String(ctx.agent.acceptsInput(deadId)))
check('没有另造常驻 agent（循环是 subagent 插件自己那份）', ctx.agent.hasAgent(deadId) === false)
check('名册里它回到在册（attached=true）', mateOf('dead-mate')?.attached === true, JSON.stringify(mateOf('dead-mate')))
check('打开会话复用的是复活好的那个 Session', ctx.agent.sessionFor(deadFile) === ctx.session.current())
ctx.agent.followup('接着干')
// 按「这一句真的发给了模型」等，不按全局请求计数：同一条链上别的队友随时可能再跑一轮，
// 计数涨了不代表这一句走了。
check('输入框那句话真的起了回合', await until(() => revivedSystems.length > 0), `${beforeRevive} -> ${teammateCalls}`)
check(
  '它用的是名册里冻结的说明书',
  revivedSystems.some((system) => system.includes('你是探子')),
  `请求 ${revivedSystems.length} 次：${revivedSystems.map((system) => system.slice(0, 40)).join(' | ')}`,
)
check('跑完回到 idle', await until(() => mateOf('dead-mate')?.state === 'idle'), JSON.stringify(mateOf('dead-mate')))
check('回合写进了它自己的记录', readFileSync(deadFile, 'utf8').length > deadSize)

// ── 9. 一次性队友：点开只读，不复活 ─────────────────────────────────────────
console.log('9. 一次性队友：点开只读，不复活')
await team.open(oneShotName)
check('当前会话是一次性队友那条', ctx.session.current().meta.id === oneShotId, ctx.session.current().meta.id)
check('不接受输入（acceptsInput=false）', ctx.agent.acceptsInput(oneShotId) === false)
check('名册里仍不在册', mateOf(oneShotName)?.attached === false, JSON.stringify(mateOf(oneShotName)))

console.log('\n清理')
server.close()
await ctx.dispose?.()
// 收尾总账：放在最后一行，跑在总闸里时那 40 行窗口也能看见结论与失败项。
console.log(failures === 0 ? `队友会话探针：全部通过（${String(42)} 条断言）` : `队友会话探针：${String(failures)} 条失败 — ${failed.join('、')}`)
process.exit(failures === 0 ? 0 : 1)
