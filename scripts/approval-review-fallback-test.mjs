/**
 * 审阅者探测（0.7.1）：auto-review 的三种结局各自去了哪儿。
 *
 * 起因是一个真实困惑：「选了 AI 复核，为什么还让我点」。0.7.1 之前判官超时、网络断、
 * 返回的不是 JSON，全都**一律**落回人工卡——对家网络抖一下，用户就得多点一张卡。
 * 现在改成分开看：
 *
 *   allow  判官放行                → 直接过；
 *   deny   判官看了、不同意        → 照旧弹卡（AI 不许替用户扛这个责任）；
 *   failed 判官压根没看上          → 回到用户自己选的权限档，那一档本来放行就放行。
 *
 * 这一批同时钉住两条别改坏的边界：
 *   ① 判官缺席时的放行**只走权限档原来的结论**，不是「一律放行」——
 *      工作区外的写照样弹卡；
 *   ② 这一轮被打断时不放行（打断是取消，不是允许）。
 *
 * 跑法：node scripts/approval-review-fallback-test.mjs（先 pnpm run build）
 *
 * @module dsc/scripts/approval-review-fallback-test
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 临时 HOME：规则文件、审计文件都落在里面，不碰真实 ~/.dsc。
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsc-review-')))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')

const { approvalPlugin } = await import('../lib/plugins/approval.js')
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

/**
 * 装一台只有审批插件的假宿主。
 *
 * @param reply 判官这一次怎么回答：字符串 = 原样当模型输出；Error = 抛出去；'garbage' = 非 JSON
 */
function mount(reply) {
  const services = {}
  const ctx = {
    llm: {
      route: () => ({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'judge' }),
      stream: async () => {
        if (reply instanceof Error) throw reply
        return { text: reply }
      },
    },
    // 真实会话对象上层有 filePath、下层有 meta（插件两处都读）。
    session: { current: () => ({ meta: { id: 'sess-1', cwd }, filePath: join(cwd, 'sess.jsonl') }) },
    guards: { register() {}, registerObserver() {} },
    surfaces: { register() {} },
    waiting: { register() {} },
    provide(name, service) {
      services[name] = service
    },
    on() {},
    emit() {},
    get(name) {
      // 「有人能回答审批卡」：探针里当真有人在看，否则卡根本不会登记。
      if (name === 'interactive') return { reachable: () => true }
      return undefined
    },
  }
  approvalPlugin.apply(ctx, undefined)
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
  args: { file_path: path, content: 'x' },
  cwd,
  sessionId: 'sess-1',
  sessionPath: join(cwd, 'sess.jsonl'),
})

console.log('[1] 判官放行 / 否决 / 缺席')

{
  const approval = mount('{"risk":"low","authorized":true,"reason":"用户要求的改动"}')
  const run = await decide(approval, writeRequest(join(cwd, 'a.txt')), new AbortController().signal)
  check('判官放行：直接过，不弹卡', run.settled() === 'allow-once' && approval.pendingView() === null, String(run.settled()))
}

{
  const approval = mount('{"risk":"high","authorized":true,"reason":"递归删目录"}')
  const run = await decide(approval, writeRequest(join(cwd, 'b.txt')), new AbortController().signal)
  check('判官判高风险：弹卡，不自动放行', run.settled() === null && approval.pendingView() !== null)
  check('卡上写明是判官判的高风险', (approval.pendingView()?.reason ?? '').includes('AI 复核判为高风险'))
  approval.answer('reject')
  check('答完卡就收', (await run.pending) === 'reject' && approval.pendingView() === null)
}

{
  const approval = mount('{"risk":"low","authorized":false,"reason":"用户没要求这么干"}')
  const run = await decide(approval, writeRequest(join(cwd, 'c.txt')), new AbortController().signal)
  check('判官说不放行：弹卡', run.settled() === null && approval.pendingView() !== null)
  check('卡上带出判官的原话', (approval.pendingView()?.reason ?? '').includes('用户没要求这么干'))
  approval.answer('reject')
  await run.pending
}

console.log('[2] 判官没给意见时回到权限档')

{
  const approval = mount(new Error('fetch failed'))
  const run = await decide(approval, writeRequest(join(cwd, 'd.txt')), new AbortController().signal)
  check('工作区内的写：按权限档放行，不弹卡', run.settled() === 'allow-once' && approval.pendingView() === null, String(run.settled()))
}

{
  const approval = mount('这不是 JSON，我是判官')
  const run = await decide(approval, writeRequest(join(cwd, 'e.txt')), new AbortController().signal)
  check('判官返回的不是 JSON：同样按权限档放行', run.settled() === 'allow-once' && approval.pendingView() === null, String(run.settled()))
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
  const approval = mount('{"risk":"low","authorized":true}')
  approval.setReviewer('user')
  const run = await decide(approval, writeRequest(join(cwd, 'i.txt')), new AbortController().signal)
  check('本人审阅 + 工作区内写：按自动编辑放行，不问', run.settled() === 'allow-once' && approval.pendingView() === null, String(run.settled()))
}

if (failures > 0) {
  console.log(`\n${String(failures)} 项不通过`)
  process.exit(1)
}
console.log('\n全部通过')
