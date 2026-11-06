/**
 * 审阅者探测（0.7.1 / 0.9.x）：auto-review 的结局、判官看见的历史、失败回退。
 *
 * 这一批把判官的输入从「工具名 + 参数 + 最后一句用户原话」换成了「保留历史 +
 * 来源角色 + 任务状态」，输出换成 dsh 那套闭集协议（`risk + decision`）。所以
 * 断言也换了两组：
 *
 *   ① 结局：allow 直接过；deny 弹卡；非法输出/网络错算「没跑完」，回到权限档；
 *   ② 输入：notice 是 fact（不能授权）、历史调用进历史、待审调用只出现一次。
 *
 * 跑法：node scripts/approval-review-fallback-test.mjs（先 pnpm run build）
 *
 * @module dsc/scripts/approval-review-fallback-test
 */
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 临时 HOME：规则文件、审计文件都落在里面，不碰真实 ~/.dsc。
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-review-')))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

const { approvalPlugin } = await import('../lib/packages/approval/index.js')
const { setAuditEnabled } = await import('../lib/core/audit.js')
setAuditEnabled(false)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-review-cwd-')))
const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-review-out-')))

/** 最近一次复核请求：断言判官到底看见了什么。 */
let reviewRequests = []

/**
 * 装一台只有审批插件的假宿主。
 *
 * @param reply 判官这一次怎么回答：字符串 = 原样当模型输出；Error = 抛出去
 * @param options.messages 会话里已有的消息
 * @param options.usage 判官这次请求的 usage
 * @param options.state 会话状态读取（todos / goal）
 */
function mount(reply, options = {}) {
  reviewRequests = []
  const messages = options.messages ?? [
    { role: 'user', content: '把 a.txt 里的 x 改成 y' },
    { role: 'user', content: '工作目录：…\n（本条是程序在每次请求时自动附上的当前环境快照，不是用户发言）' },
  ]
  // 状态条目按 id 存在 Map 里：权限三项（permissions）与任务状态（todos / goal）共用，
  // 读写必须一致——只给 state() 不给 appendState 会让 writePermissions 写进兜底槽，
  // 而读路径因为有 state() 又读不到它（见 core/permission-scope.ts:82-108）。
  const states = new Map()
  const session = {
    meta: { id: 'sess-1', cwd },
    filePath: join(cwd, 'sess.jsonl'),
    messages,
    state: (id) => states.get(id) ?? (options.state === undefined ? undefined : options.state[id]),
    appendState: (id, payload) => states.set(id, payload),
    setState: (id, payload) => states.set(id, payload),
  }
  const services = {}
  const ctx = {
    llm: {
      route: () => ({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'judge' }),
      routeForSession: () => ({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'judge' }),
      providerOf: () => 'test',
      modelOf: () => 'judge',
      stream: async (api, request) => {
        reviewRequests.push(request)
        if (reply instanceof Error) throw reply
        return { text: reply, ...(options.usage === undefined ? {} : { usage: options.usage }) }
      },
    },
    session: { current: () => session },
    guards: { register() {}, registerObserver() {} },
    surfaces: { register() {} },
    waiting: { register() {} },
    provide(name, service) {
      services[name] = service
    },
    on() {},
    emit() {},
    get(name) {
      if (name === 'interactive') return { reachable: () => true }
      if (name === 'tools') return { list: () => options.tools ?? [] }
      if (name === 'subagent') return options.subagent
      return undefined
    },
    effect: (execute) => {
      const off = execute()
      return typeof off === 'function' ? off : () => {}
    },
  }
  approvalPlugin.apply(ctx, options.config)
  const approval = services['approval']
  approval.setPolicy('auto-edit')
  approval.setReviewer('auto-review')
  return approval
}

/** 跑一次裁决；返回「决定」或「挂着卡」这个事实。 */
async function decide(approval, request, signal) {
  const pending = approval.decide(request, signal)
  let settled = null
  void pending.then((value) => {
    settled = value
  })
  // 卡片是异步登记的（await 里至少让出一次事件循环）。
  await new Promise((resolve) => setTimeout(resolve, 20))
  return { pending, settled: () => settled }
}

const writeRequest = (path) => ({
  toolName: 'write',
  argsSummary: '{"file_path":"…"}',
  args: { path, content: 'x' },
  cwd,
  sessionId: 'sess-1',
  sessionPath: join(cwd, 'sess.jsonl'),
})

/** 判官这次收到的全部 user 消息正文。 */
const reviewText = () => (reviewRequests.at(-1)?.messages ?? []).map((m) => m.content).join('\n')

console.log('[1] 判官放行 / 否决 / 缺席')

{
  const approval = mount('{"risk":"low","decision":"allow"}')
  const run = await decide(approval, writeRequest(join(cwd, 'a.txt')), new AbortController().signal)
  check('判官放行：直接过，不弹卡', run.settled() === 'allow-once' && approval.pendingView() === null, String(run.settled()))
  const request = reviewRequests.at(-1)
  const expectedEnv = `ENVIRONMENT\n${JSON.stringify({ cwd }, null, 2)}`
  check('第一条 user 消息是环境（只带 cwd）', request.messages[1].content === expectedEnv, request.messages[1].content.slice(0, 120))
  check('最后一条是待审调用', request.messages.at(-1).content.includes('"kind": "pending-call"') && request.messages.at(-1).content.includes('"tool": "write"'))
  check('系统提示用闭集协议', request.messages[0].content.includes('"risk":"low","decision":"allow"'))
}

{
  const approval = mount('{"risk":"high","decision":"deny","reason":"递归删目录"}')
  const run = await decide(approval, writeRequest(join(cwd, 'b.txt')), new AbortController().signal)
  check('判官判高风险：弹卡，不自动放行', run.settled() === null && approval.pendingView() !== null)
  check('卡上写明是判官判的高风险', (approval.pendingView()?.reason ?? '').includes('AI 复核判为高风险'))
  check('卡的风险档取判官的结论', approval.pendingView()?.risk === 'high')
  approval.answer('reject')
  check('答完卡就收', (await run.pending) === 'reject' && approval.pendingView() === null)
}

{
  const approval = mount('{"risk":"medium","decision":"deny","reason":"本轮只要求读日志，没有授权改迁移脚本"}')
  const run = await decide(approval, writeRequest(join(cwd, 'c.txt')), new AbortController().signal)
  check('判官说不放行：弹卡', run.settled() === null && approval.pendingView() !== null)
  check('卡上带出判官的原话', (approval.pendingView()?.reason ?? '').includes('没有授权改迁移脚本'))
  approval.answer('reject')
  await run.pending
}

console.log('[2] 传输错误回权限档；协议错弹卡')

{
  const approval = mount(new Error('fetch failed'))
  const run = await decide(approval, writeRequest(join(cwd, 'd.txt')), new AbortController().signal)
  check('网络错：工作区内的写按权限档放行', run.settled() === 'allow-once' && approval.pendingView() === null, String(run.settled()))
}

{
  const approval = mount('这不是 JSON，我是判官')
  const run = await decide(approval, writeRequest(join(cwd, 'e.txt')), new AbortController().signal)
  check('不是 JSON：协议错弹卡，不回落放行', run.settled() === null && approval.pendingView() !== null, String(run.settled()))
  check('卡上写明是协议问题', (approval.pendingView()?.reason ?? '').includes('不合协议'))
  approval.answer('reject')
  await run.pending
}

{
  const approval = mount('{"risk":"low","decision":"deny","reason":"低风险不许否决"}')
  const run = await decide(approval, writeRequest(join(cwd, 'e2.txt')), new AbortController().signal)
  check('low+deny 自相矛盾：按否决落卡，不从回落路径放行', run.settled() === null && approval.pendingView() !== null)
  check('卡上写明按否决处理', (approval.pendingView()?.reason ?? '').includes('按否决处理'))
  approval.answer('reject')
  await run.pending
}

{
  const approval = mount('{"risk":"high","decision":"allow"}')
  const run = await decide(approval, writeRequest(join(cwd, 'e3.txt')), new AbortController().signal)
  check('high+allow 自相矛盾：按高风险落卡', run.settled() === null && approval.pendingView() !== null)
  check('卡的风险档取 high', approval.pendingView()?.risk === 'high')
  approval.answer('reject')
  await run.pending
}

{
  const approval = mount('{"risk":"low","decision":"allow","reason":"多带理由也不行"}')
  const run = await decide(approval, writeRequest(join(cwd, 'e4.txt')), new AbortController().signal)
  check('allow 带 reason 非法：协议错弹卡', run.settled() === null && approval.pendingView() !== null, String(run.settled()))
  approval.answer('reject')
  await run.pending
}

{
  // 这一条钉死「协议错不许走回落」：完全访问档下回落就是放行，等于没审。
  const approval = mount('{"risk":"low","decision":"allow","reason":"x"}')
  approval.setPolicy('full-access')
  const run = await decide(approval, writeRequest(join(outside, 'e5.txt')), new AbortController().signal)
  check('完全访问档下协议错也弹卡（不回落）', run.settled() === null && approval.pendingView() !== null, String(run.settled()))
  approval.answer('reject')
  await run.pending
}

{
  const approval = mount(new Error('fetch failed'))
  const run = await decide(approval, writeRequest(join(outside, 'f.txt')), new AbortController().signal)
  check('工作区外的写：判官缺席也不放行，照旧弹卡', run.settled() === null && approval.pendingView() !== null)
  approval.answer('reject')
  await run.pending
}

{
  const approval = mount(new Error('fetch failed'))
  approval.setPolicy('full-access')
  const run = await decide(approval, writeRequest(join(outside, 'g.txt')), new AbortController().signal)
  check('完全访问档：判官缺席时按该档放行', run.settled() === 'allow-once' && approval.pendingView() === null, String(run.settled()))
}

{
  const approval = mount(new Error('fetch failed'))
  const controller = new AbortController()
  controller.abort()
  const run = await decide(approval, writeRequest(join(cwd, 'h.txt')), controller.signal)
  check('这一轮已被打断：判官缺席时也不放行', run.settled() === 'reject' && approval.pendingView() === null, String(run.settled()))
}

console.log('[3] 没有审阅者时行为不变')
{
  const approval = mount('{"risk":"low","decision":"allow"}')
  approval.setReviewer('user')
  const run = await decide(approval, writeRequest(join(cwd, 'i.txt')), new AbortController().signal)
  check('本人审阅 + 工作区内写：按自动编辑放行，不问', run.settled() === 'allow-once' && approval.pendingView() === null, String(run.settled()))
}

console.log('[4] 判官看得见历史与来源角色')
{
  const longWords = '读一下 src/plugins/approval.ts，告诉我它干什么。'.repeat(80)
  const approval = mount('{"risk":"low","decision":"allow"}', {
    messages: [
      { role: 'user', content: '把 a.txt 里的 x 改成 y' },
      { role: 'user', content: longWords },
      { role: 'user', content: '后台作业 job-1 成功完成。用 job_output 查看输出。', origin: 'notice' },
      { role: 'user', content: '<teammate-report id="t1">队友汇报</teammate-report>' },
      { role: 'assistant', content: '我先读一下文件。', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.txt"}' } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write', arguments: '{"file_path":"a.txt","content":"x"}' } }] },
    ],
    usage: { inputTokens: 120, outputTokens: 30, cacheHitTokens: 10, cacheMissTokens: 110 },
  })
  const run = await decide(approval, writeRequest(join(cwd, 'j.txt')), new AbortController().signal)
  check('判官放行照旧', run.settled() === 'allow-once', String(run.settled()))
  const text = reviewText()
  check('历史里有真人指令', text.includes('"role": "user-instruction"') && text.includes('把 a.txt 里的 x 改成 y'))
  check('后台作业通知标成 fact', /"role": "fact"[\s\S]{0,200}后台作业 job-1/.test(text))
  check('队友汇报标成 fact', /"role": "fact"/.test(text) && text.includes('队友汇报'))
  check('历史调用进了历史', text.includes('"kind": "tool-call"') && text.includes('"name": "read"'))
  check('待审调用只出现在最后一条', (text.match(/"name": "write"/g) ?? []).length === 0 && text.includes('"tool": "write"'))
  check('用户消息截到 1200 字', text.includes('…（已截断）'))
  const usageLine = readFileSync(join(home, '.dsc', 'usage', 'usage.jsonl'), 'utf8').trim().split('\n').at(-1)
  const record = JSON.parse(usageLine)
  check(
    '判官用量落一条（provider/model/sid/i/o）',
    record.provider === 'test' && record.model === 'judge' && record.sid === 'sess-1' && record.i === 120 && record.o === 30,
    usageLine,
  )
  check('判官用量带上缓存与墙钟读数', record.ch === 10 && record.cm === 110 && typeof record.lm === 'number', usageLine)
}

console.log('[5] 任务状态也进历史')
{
  const approval = mount('{"risk":"low","decision":"allow"}', {
    state: {
      todos: [
        { id: 't1', content: '按教师隔离文档', status: 'in_progress' },
        { id: 't2', content: '补测试', status: 'pending' },
        { id: 't3', content: '旧任务', status: 'completed' },
      ],
      goal: { id: 'g1', revision: 1, objective: '完成文档隔离', phase: 'active', maxRounds: 10, rounds: 2 },
    },
  })
  const run = await decide(approval, writeRequest(join(cwd, 'k.txt')), new AbortController().signal)
  check('判官放行', run.settled() === 'allow-once', String(run.settled()))
  const text = reviewText()
  check('带会话目标', text.includes('完成文档隔离'))
  check('带未完成清单项、不带已完成项', text.includes('按教师隔离文档') && text.includes('补测试') && !text.includes('旧任务'))
  check('任务状态是 fact 角色', /"kind": "task-state"[\s\S]{0,80}"role": "fact"/.test(text) || /"role": "fact"[\s\S]{0,80}"kind": "task-state"/.test(text))
  check('任务状态声明「不是用户原话」', text.includes('不是用户原话'))

  // 裁剪不能把最早那句用户指令挤掉：造 70 条历史，最早那条 user-instruction 必须还在。
  const many = [{ role: 'user', content: '这是最早的需求：把出题文档改成按班级隔离' }]
  for (let i = 0; i < 70; i += 1) {
    many.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${String(i)}`, type: 'function', function: { name: 'read', arguments: `{"file_path":"f${String(i)}.ts"}` } }] })
  }
  const trimmed = mount('{"risk":"low","decision":"allow"}', { messages: many })
  const run2 = await decide(trimmed, writeRequest(join(cwd, 'l.txt')), new AbortController().signal)
  check('历史裁剪后仍带最早的用户指令', run2.settled() === 'allow-once' && reviewText().includes('这是最早的需求'))
}

console.log('[6] 判官看得见项目规则、工具定义与子代理身份')
{
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(cwd, 'AGENTS.md'), '# 约定\n改代码前先读文件；不要动 dist/。')
  const approval = mount('{"risk":"low","decision":"allow"}', {
    tools: [{ name: 'write', description: '写文件到工作区', parameters: { type: 'object', properties: { path: { type: 'string' } } }, risk: 'write' }],
  })
  const run = await decide(approval, writeRequest(join(cwd, 'm.txt')), new AbortController().signal)
  check('判官放行', run.settled() === 'allow-once', String(run.settled()))
  const text = reviewText()
  check('历史里有项目规则（constraint）', text.includes('"role": "constraint"') && text.includes('改代码前先读文件'))
  check('历史里有工具定义（tool-schema）', text.includes('"kind": "tool-schema"') && text.includes('写文件到工作区'))
}

{
  // 子代理会话：同样一条用户消息，角色要降成「父级指令」，不能当成面前的用户。
  const approval = mount('{"risk":"low","decision":"allow"}', {
    subagent: { list: () => [{ file: join(cwd, 'sess.jsonl') }] },
  })
  const run = await decide(approval, writeRequest(join(cwd, 'n.txt')), new AbortController().signal)
  check('判官放行', run.settled() === 'allow-once', String(run.settled()))
  const text = reviewText()
  check('子代理会话：用户消息标成父级指令', text.includes('"role": "direct-parent-instruction"'))
  check('父级指令带来源说明', text.includes('来自派发这个子代理的父代理'))
}

console.log('[7] 失败即拒绝（approval.failClosed）')
{
  const approval = mount(new Error('fetch failed'), { config: { failClosed: true } })
  const run = await decide(approval, writeRequest(join(cwd, 'o.txt')), new AbortController().signal)
  check('打开后：判官没跑完弹卡，不回落', run.settled() === null && approval.pendingView() !== null, String(run.settled()))
  check('卡上写明「失败即拒绝」', (approval.pendingView()?.reason ?? '').includes('失败即拒绝'))
  approval.answer('reject')
  await run.pending
}

console.log('[8] 外层 run_code 不单独审')
{
  const approval = mount('{"risk":"low","decision":"allow"}')
  const run = await decide(approval, {
    toolName: 'run_code',
    argsSummary: '{"code":"…"}',
    args: { code: 'return 1' },
    cwd,
    sessionId: 'sess-1',
    sessionPath: join(cwd, 'sess.jsonl'),
  }, new AbortController().signal)
  check('auto-edit 下直接放行，不弹卡', run.settled() === 'allow-once' && approval.pendingView() === null, String(run.settled()))
  check('没有调用判官（省一次请求）', reviewRequests.length === 0, String(reviewRequests.length))
}
{
  const approval = mount('{"risk":"low","decision":"allow"}')
  approval.setPolicy('readonly')
  const run = await decide(approval, {
    toolName: 'run_code',
    argsSummary: '{"code":"…"}',
    args: { code: 'return 1' },
    cwd,
    sessionId: 'sess-1',
    sessionPath: join(cwd, 'sess.jsonl'),
  }, new AbortController().signal)
  check('仅查看模式仍然拒绝', run.settled() === 'reject', String(run.settled()))
}

if (failures > 0) {
  console.log(`\n${String(failures)} 项不通过`)
  process.exit(1)
}
console.log('\n全部通过')
