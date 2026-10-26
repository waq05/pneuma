/**
 * dsh 服务桥（只读）自检：Pneuma 的会话历史 + 用量日志，能不能按 dsh 的
 * `sessionPersistence` / `sessions` 形状露给外部插件。
 *
 * 三段：
 *   [1] 纯模块：list / stat / open(read) / 分页游标 / 用量事件合并在正确位置 / 写方法响亮拒绝
 *   [2] 真挂载：一个 dsh 风格插件在 apply 里 `ctx.get('sessionPersistence')` 现取，
 *       不声明 inject（cost-meter 就是这种写法），走真实 loader + 兼容层 ctx
 *   [3] 反向：写方法抛出的那句话里必须说清「为什么不行、只读能做什么」
 *
 * 跑法：cd D:\dsc && pnpm run build && node scripts/dsh-session-bridge-check.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-session-bridge-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(join(dsc, 'plugins'), { recursive: true })
mkdirSync(join(dsc, 'sessions', 'proj'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

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

// ── 造一个会话：三行 jsonl（meta / user / assistant）+ 两次模型调用的用量 ────────
const sessionId = '11111111-2222-3333-4444-555555555555'
const lines = [
  { type: 'meta', id: sessionId, cwd: 'D:\\proj', createdAt: 1_700_000_000_000 },
  { type: 'user', text: '帮我看一下成本条为什么没数', ts: 1_700_000_000_100 },
  { type: 'assistant', text: '先读历史再说。', reasoning: '', ts: 1_700_000_000_900 },
]
writeFileSync(join(dsc, 'sessions', 'proj', `${sessionId}.jsonl`), lines.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
// 用量：两条，时间上一个在 user 之后、assistant 之前，一个在最后——合并后必须按时间插进去
writeFileSync(
  join(dsc, 'usage', 'usage.jsonl'),
  [
    { t: 1_700_000_000_500, provider: 'deepseek', model: 'deepseek-chat', i: 120, o: 30, sid: sessionId },
    { t: 1_700_000_001_200, provider: 'deepseek', model: 'deepseek-chat', i: 300, o: 90, sid: sessionId, ch: 100, cm: 20 },
    { t: 1_700_000_001_300, sid: sessionId, k: 'tool', n: 'read', ms: 12 },
    { t: 1_700_000_001_400, provider: 'other', model: 'x', i: 1, o: 2, sid: 'someone-else' },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  'utf8',
)

const { createSessionPersistenceBridge, createSessionsBridge, compatServiceOf } = await import(
  '../lib/core/dsh-compat/session-bridge.js'
)

console.log('会话桥：list / stat / open(read) 的形状')
{
  const persistence = createSessionPersistenceBridge()
  const list = persistence.list()
  check('list() 看得见这个会话', list.length === 1 && list[0].header.sessionId === sessionId, JSON.stringify(list))
  const stat = persistence.stat(sessionId)
  check('stat() 给 header / revision / eventCount / sizeBytes', stat !== undefined && typeof stat.revision === 'string' && stat.eventCount === 5, JSON.stringify(stat))
  check('formatStatus 是 current（不做迁移戏法）', stat?.formatStatus === 'current', String(stat?.formatStatus))
  check('stat 不存在的会话给 undefined', persistence.stat('nope') === undefined)

  const handle = persistence.open(sessionId, 'read')
  const all = handle.read()
  check('open(read) 读出全部事件', all.events.length === 5 && all.hasMore === false, JSON.stringify(all.events.length))
  check('事件按时间合并（用量插在 user 与 assistant 之间）',
    all.events[0].type === 'meta' && all.events[1].type === 'user' && all.events[2].type === 'llm/usage',
    all.events.map((e) => e.type).join(','))
  const usage = all.events.find((e) => e.type === 'llm/usage')
  check('用量事件带 inputTokens / outputTokens', usage?.data.inputTokens === 120 && usage?.data.outputTokens === 30, JSON.stringify(usage?.data))
  check('工具行不算事件（没有 token，算账用不上）', !all.events.some((e) => e.data['k'] === 'tool'))
  check('别的会话的用量不会串进来', !all.events.some((e) => e.data['model'] === 'x'))
  const cacheHit = all.events.filter((e) => e.type === 'llm/usage')[1]
  check('缓存命中字段也被带出来', cacheHit?.data.cacheReadTokens === 100 && cacheHit?.data.cacheWriteTokens === 20, JSON.stringify(cacheHit?.data))

  const page = handle.read({ maxMessages: 2 })
  check('maxMessages 分页', page.events.length === 2 && page.hasMore === true, JSON.stringify({ n: page.events.length, more: page.hasMore }))
  const through = handle.read({ throughSeq: 2 })
  check('throughSeq 截到第 2 条', through.events.length === 2 && through.events.every((e) => e.seq <= 2), JSON.stringify(through.events.map((e) => e.seq)))
  const before = handle.read({ beforeSeq: 2 })
  check('beforeSeq 不含第 2 条', before.events.length === 1, JSON.stringify(before.events.map((e) => e.seq)))
  handle.close()
}

console.log('会话桥：sessions 注册表')
{
  const sessions = createSessionsBridge()
  const rows = sessions.list()
  check('sessions.list() 有这一条', rows.length === 1 && rows[0].sessionId === sessionId)
  check('title 取首条用户消息', rows[0].title === '帮我看一下成本条为什么没数', String(rows[0].title))
  check('get() 按 id 取', sessions.get(sessionId)?.cwd === 'D:\\proj', JSON.stringify(sessions.get(sessionId)))
  check('has() 认与不认', sessions.has(sessionId) === true && sessions.has('nope') === false)
  check('live 不假装知道（一律 false）', rows[0].live === false && rows[0].persisted === true)
}

console.log('会话桥：写侧响亮拒绝')
{
  const persistence = createSessionPersistenceBridge()
  const refusal = (fn) => {
    try {
      fn()
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const writeOpen = refusal(() => persistence.open(sessionId, 'write'))
  check('open(…, "write") 抛错', writeOpen !== '', writeOpen)
  check('拒绝文案说清「为什么不行」', writeOpen.includes('内核') && writeOpen.includes('独占'), writeOpen)
  check('拒绝文案说清「只读能用什么」', writeOpen.includes('只读') && writeOpen.includes('list'), writeOpen)
  check('create() 抛同一句话', refusal(() => persistence.create()).includes('只读'))
  check('append() 抛同一句话', refusal(() => persistence.append()).includes('只读'))
}

console.log('compatServiceOf：名字到桥的映射')
{
  check('sessionPersistence → 只读桥', typeof compatServiceOf('sessionPersistence')?.stat === 'function')
  check('sessions → 注册表桥', typeof compatServiceOf('sessions')?.list === 'function')
  check('别的名字不归这座桥管', compatServiceOf('sessionProjections') === undefined && compatServiceOf('nonsense') === undefined)
}

console.log('真挂载：dsh 插件在 apply 里 ctx.get 现取')
{
  const { createKernel } = await import('../lib/host/kernel.js')
  const { mountAllExternalPlugins } = await import('../lib/core/plugin-loader.js')
  const { writePluginEnabled, writePluginConfig } = await import('../lib/core/plugin-registry.js')

  writeFileSync(
    join(dsc, 'plugins', 'dsh-needs-history.js'),
    `export const name = 'dsh-needs-history'

export function apply(ctx) {
  const persistence = ctx.get('sessionPersistence')
  const sessions = ctx.get('sessions')
  const first = sessions.list()[0]
  const stat = persistence.stat(first.sessionId)
  const handle = persistence.open(first.sessionId, 'read')
  const page = handle.read({ maxMessages: 3 })
  globalThis.__bridgeProbe = {
    hasPersistence: typeof persistence?.stat === 'function',
    hasSessions: typeof sessions?.list === 'function',
    sessionCount: sessions.list().length,
    eventCount: stat?.eventCount ?? -1,
    pageSize: page.events.length,
    usage: page.events.filter((event) => event.type === 'llm/usage').length,
  }
  handle.close()
  return () => {
    delete globalThis.__bridgeProbe
  }
}
`,
    'utf8',
  )
  writePluginEnabled('dsh-compat', true)
  writePluginEnabled('dsh-needs-history.js', true)
  writePluginConfig('dsh-needs-history.js', { risk: 'read' })

  const ctx = await createKernel({
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl: 'http://127.0.0.1:9',
          apiKey: 'k',
          models: [{ id: 'm', name: 'm', contextWindow: 1000, maxTokens: 100, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm',
    },
    resumeSessionPath: null,
  })
  const failures = await mountAllExternalPlugins(ctx, [])
  const pluginFailure = failures.find((f) => f.file === 'dsh-needs-history.js')
  check('不声明 inject 的插件也挂得上', pluginFailure === undefined, pluginFailure === undefined ? '' : pluginFailure.problem)
  const probe = globalThis.__bridgeProbe
  check('插件真的取到了 sessionPersistence', probe?.hasPersistence === true, JSON.stringify(probe))
  check('插件真的取到了 sessions', probe?.hasSessions === true, JSON.stringify(probe))
  check('读到的会话数与磁盘一致', probe?.sessionCount === 1, String(probe?.sessionCount))
  check('stat 的 eventCount 对（3 行 + 2 条用量）', probe?.eventCount === 5, String(probe?.eventCount))
  check('分页读回 3 条，其中有 1 条用量', probe?.pageSize === 3 && probe?.usage === 1, JSON.stringify(probe))

  ctx.emit('dsc/exit')
  const fiber = ctx?.fiber
  if (fiber !== null && fiber !== undefined && typeof fiber.dispose === 'function') await fiber.dispose()
}

console.log(String.fromCharCode(10) + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)
