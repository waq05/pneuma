/**
 * 会话费用回填探针（P0-5）：切走会话再切回来，状态栏的「本会话费用」不该消失。
 *
 * 为什么单开一份：这个 bug 只在「有历史、有 usage 日志、但内存里的费用桶被 clear() 清过」
 * 的现场出现——纯看代码能说得通，但得真写一份 usage.jsonl、真发两次 session-open、
 * 真的读快照里的 status.cost，才能确认总数与「按模型的峰谷分桶」都回到磁盘记录的精度，
 * 且重复打开同一条会话不会把费用翻倍。
 *
 * 口径（与 core/usage-log、core/pricing 一致，本探针不另算一份乘法）：
 * - 磁盘：usage.jsonl 每次模型请求一行（t/provider/model/i/o/ch/cm/sid），按 sid 过滤；
 * - 分桶：按每笔发生的时刻判峰谷（isPeakHour），按模型归桶；
 * - 钱：estimateSessionCostCny 逐模型查价求和，探针只断言 token 桶与它算出的总额。
 * - 判官行：同一份日志里的请求行，但带 `k: 'judge'`——判官不走会话 loop、实时桶里
 *   没有它，回填也不折它（1b 节对拍）。
 *
 * 为什么不用 lib/ 产物：这条路径改的是源码，本探针直接按 .ts 加载（Node 24 的类型擦除 +
 * 一个只在探针内注册的解析钩子），这样不依赖 `pnpm run build` 的时点；跑完立刻能验。
 *
 * 用临时 HOME，绝不碰真实 ~/.dsc。
 *
 * 运行：node scripts/session-cost-restore-check.mjs
 *
 * @module dsc/scripts/session-cost-restore-check
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { register } from 'node:module'

// ── 临时 HOME：DSC_HOME 由 path-policy 在 import 时按 homedir() 定下，必须先设 ──
const home = mkdtempSync(join(tmpdir(), 'dsc-session-cost-'))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.DSC_HOME
const dscHome = join(home, '.dsc')
mkdirSync(dscHome, { recursive: true })

// ── 源码加载器：@pneuma/runtime/* → src/*，相对 .js 说明符 → .ts ─────────────
// 只在探针进程内注册，不改仓库解析规则；其它探针仍走 lib/ 产物。
const srcRoot = new URL('../src/', import.meta.url).href
const sourceLoader = `
const SRC = ${JSON.stringify(srcRoot)}
const PREFIX = '@pneuma/runtime/'
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(PREFIX)) {
    const tail = specifier.slice(PREFIX.length).replace(/\\.js$/, '.ts')
    return nextResolve(new URL(tail, SRC).href, context)
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch { return nextResolve(specifier, context) }
  }
  return nextResolve(specifier, context)
}
`
register('data:text/javascript;base64,' + Buffer.from(sourceLoader, 'utf8').toString('base64'))

let failures = 0
let total = 0
const check = (label, condition, extra = '') => {
  total += 1
  if (condition) {
    console.log('  ok  ' + label)
    return
  }
  failures += 1
  console.log('FAIL  ' + label + (extra === '' ? '' : '  <- ' + extra))
}

const src = (path) => new URL('../src/' + path, import.meta.url).href

const { emptyCostBuckets, estimateSessionCostCny, isPeakHour } = await import(src('core/pricing.ts'))
const usageLog = await import(src('core/usage-log.ts'))
const { Transcript } = await import(src('adapter/transcript.ts'))
const { transcriptPlugin } = await import(src('packages/transcript/index.ts'))

// ── 造盘：usage.jsonl（临时 HOME 下），三条会话 + 一行工具行 + 一行半截行 ──────
const sidA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const sidB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const sidC = 'cccccccc-3333-4333-8333-cccccccccccc'
const sidOther = 'dddddddd-4444-4444-8444-dddddddddddd'

/** 找最近一个「峰 / 谷」的整点时刻（北京时间工作日 9-12、14-18 为峰）。 */
const stampFor = (wantPeak) => {
  const base = Math.floor((Date.now() - 6 * 86_400_000) / 3_600_000) * 3_600_000
  for (let step = 0; step < 24 * 9; step += 1) {
    const at = base + step * 3_600_000
    if (isPeakHour(new Date(at)) === wantPeak) return at
  }
  throw new Error('找不到 ' + (wantPeak ? '峰' : '谷') + ' 时段的时间戳')
}
const peakTs = stampFor(true)
const idleTs = stampFor(false)

const usageFile = join(dscHome, 'usage', 'usage.jsonl')
mkdirSync(join(dscHome, 'usage'), { recursive: true })
const rowsA = [
  // 峰时段一笔：缓存命中/未命中都上报（ch/cm 成对）
  { t: peakTs, provider: 'deepseek', model: 'deepseek-v4-flash', i: 1_000_000, o: 200_000, ch: 400_000, cm: 600_000, sid: sidA },
  // 谷时段一笔、另一个模型：没上报缓存明细，输入全部按未命中价计
  { t: idleTs, provider: 'deepseek', model: 'deepseek-flash', i: 500_000, o: 100_000, sid: sidA },
  // 别的会话的行：不许算进本会话
  { t: peakTs, provider: 'deepseek', model: 'deepseek-v4-flash', i: 99_000_000, o: 99_000_000, sid: sidOther },
  // 工具行：没有 token，只记耗时
  { t: peakTs, sid: sidA, k: 'tool', n: 'bash', ms: 12 },
]
// 末尾那条是「写盘中断留下的半截行」：它自己不合法，但不影响前面几行与后面追加的行
writeFileSync(usageFile, rowsA.map((row) => JSON.stringify(row)).join('\n') + '\n' + '{"t":1,"sid":"' + sidA + '"\n', 'utf8')

const expectedA = new Map()
{
  const peak = emptyCostBuckets()
  peak.peak.hit = 400_000
  peak.peak.miss = 600_000
  peak.peak.output = 200_000
  expectedA.set('deepseek-v4-flash', peak)
  const idle = emptyCostBuckets()
  idle.idle.miss = 500_000
  idle.idle.output = 100_000
  expectedA.set('deepseek-flash', idle)
}
const priceOf = (map) => estimateSessionCostCny([...map.entries()].map(([model, buckets]) => ({ model, buckets })))
const expectedATotal = priceOf(expectedA)?.total
const sameBuckets = (left, right) =>
  left !== null &&
  left.size === right.size &&
  [...right.entries()].every(([model, buckets]) => JSON.stringify(left.get(model)) === JSON.stringify(buckets))

// ── 1. 磁盘读取入口：只扫本会话，按模型分峰谷 ─────────────────────────────
const readBuckets = (sid) =>
  typeof usageLog.readSessionCostBuckets === 'function' ? usageLog.readSessionCostBuckets(sid) : null
const loaded = readBuckets(sidA)
check('usage-log 提供 readSessionCostBuckets（按会话读费用分桶）', typeof usageLog.readSessionCostBuckets === 'function')
check('按会话过滤 + 按模型分峰谷：两个模型的桶都回到记录值', sameBuckets(loaded, expectedA), JSON.stringify(loaded && [...loaded.entries()]))
check('同一会话再读一次结果不变（读取是纯函数）', sameBuckets(readBuckets(sidA), expectedA))
check('没有请求行的会话返回 null（不把没账画成 0 元）', readBuckets(sidB) === null)
check('空 sessionId 返回 null', readBuckets('') === null)
const readerSource = readFileSync(new URL('../src/core/usage-log.ts', import.meta.url), 'utf8')
const readerStart = readerSource.indexOf('export function readSessionCostBuckets')
const readerBody = readerStart < 0 ? '' : readerSource.slice(readerStart, readerSource.indexOf('\n}\n', readerStart))
check(
  '大文件不全量加载：新入口按块读（readSync），不整份 readFileSync',
  readerBody !== '' && /readSync\(/.test(readerBody) && !/readFileSync\(/.test(readerBody),
)

// ── 1b. 判官行（k: 'judge'）：回填不折它 ───────────────────────────────────
// 判官这次请求按会话 sid 记一笔，但它不走会话 loop、没有 transcript.emit，实时费用桶
// 里从来没有它。造两条同会话的账对拍：sidD =「会话 loop 行 + 判官行」，sidF =「同样的
// 会话 loop 行、没有判官行」。回填结果必须一模一样；修前会把判官那几笔折进来，金额
// 与模型集合都会多出来。
const sidD = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'
const sidF = 'ffffffff-6666-4666-8666-ffffffffffff'
const sidG = '99999999-7777-4777-8777-999999999999'
const loopRows = [
  { t: peakTs, provider: 'deepseek', model: 'deepseek-v4-flash', i: 200_000, o: 40_000, ch: 80_000, cm: 120_000 },
  { t: idleTs, provider: 'deepseek', model: 'deepseek-flash', i: 60_000, o: 10_000 },
]
const judgeRows = [
  // 与会话 loop 同模型：修前会被折进来，总额直接变大
  { t: peakTs, provider: 'deepseek', model: 'deepseek-v4-flash', i: 900_000, o: 150_000, ch: 10_000, cm: 890_000, k: 'judge' },
  // 判官专属模型：修前还会多出一个模型桶
  { t: idleTs, provider: 'deepseek', model: 'deepseek-v4-flash-judge', i: 400_000, o: 30_000, k: 'judge' },
]
appendFileSync(
  usageFile,
  [
    ...loopRows.map((row) => ({ ...row, sid: sidD })),
    ...judgeRows.map((row) => ({ ...row, sid: sidD })),
    ...loopRows.map((row) => ({ ...row, sid: sidF })),
    // 只有判官行的会话：没有会话 loop 的账，回填该给 null
    { t: peakTs, provider: 'deepseek', model: 'deepseek-v4-flash', i: 5_000, o: 500, k: 'judge', sid: sidG },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  'utf8',
)
const mixedD = readBuckets(sidD)
const loopOnlyF = readBuckets(sidF)
check('判官行不进回填：含判官行的账与只有会话 loop 行的账，分桶一致', sameBuckets(mixedD, loopOnlyF), JSON.stringify(mixedD && [...mixedD.entries()]))
check(
  '判官行不进回填：两者算出的总额相等（切回不比切走前大）',
  priceOf(loopOnlyF)?.total !== undefined && priceOf(mixedD)?.total === priceOf(loopOnlyF)?.total,
  String(priceOf(mixedD)?.total) + ' vs ' + String(priceOf(loopOnlyF)?.total),
)
check(
  '判官专属模型不因回填出现在费用桶里',
  mixedD !== null && !mixedD.has('deepseek-v4-flash-judge'),
  JSON.stringify(mixedD && [...mixedD.keys()]),
)
check('只有判官行的会话回填为 null（没有会话 loop 的账就不填）', readBuckets(sidG) === null)

// ── 2. adapter：回填入口整表替换，且不共享调用方的桶对象 ───────────────────
const probeTranscript = new Transcript()
check('adapter 提供 seedCostBuckets 回填入口', typeof probeTranscript.seedCostBuckets === 'function')
if (typeof probeTranscript.seedCostBuckets === 'function') {
  probeTranscript.seedCostBuckets(readBuckets(sidA))
  check('回填后 adapter 的费用桶等于磁盘记录值', sameBuckets(probeTranscript.costBuckets, expectedA))
  check('回填后的费用总额等于按价目表算出的总额', priceOf(probeTranscript.costBuckets)?.total === expectedATotal)
  const handed = readBuckets(sidA)
  probeTranscript.seedCostBuckets(handed)
  probeTranscript.seedCostBuckets(handed)
  check('重复回填同一份账不翻倍（整表替换，不是累加）', priceOf(probeTranscript.costBuckets)?.total === expectedATotal)
}

// ── 3. 插件路径：session-open → clear → 重放 → 按磁盘回填 status.cost ─────────
/** 最小会话形状：会话插件之外只读这几项（meta / messages / notices / asyncInbox）。 */
const makeSession = (id, filePath, text) => ({
  meta: { id, cwd: home, createdAt: Date.now() - 60_000 },
  filePath,
  messages: text === null ? [] : [{ role: 'user', content: text }],
  toolErrors: new Map(),
  fileChanges: new Map(),
  presentations: new Map(),
  notices: () => [],
  asyncInbox: () => [],
})

const fileA = join(home, 'session-a.jsonl')
const fileB = join(home, 'session-b.jsonl')
const fileC = join(home, 'session-c.jsonl')
const sessionA = makeSession(sidA, fileA, '这条会话有历史用量')
const sessionB = makeSession(sidB, fileB, '这条会话一行用量都没有')
const sessionC = makeSession(sidC, fileC, '这条会话先实时累计再切走')

const handlers = new Map()
const sessionApi = { current: () => sessionA, sessions: [], loading: false }
let service = null
const ctx = {
  on(name, fn) {
    const list = handlers.get(name) ?? []
    list.push(fn)
    handlers.set(name, list)
    return () => {}
  },
  get: () => undefined,
  provide(_name, value) {
    service = value
  },
  session: sessionApi,
  llm: { provider: 'deepseek', model: 'deepseek-v4-flash', effort: '', contextWindow: 128_000 },
  surfaces: { build: () => ({ pendingApproval: null }) },
}
transcriptPlugin.apply(ctx)
const open = (session) => {
  sessionApi.current = () => session
  for (const fn of handlers.get('dsc/session-open') ?? []) fn({ filePath: session.filePath, session })
  return service.getSnapshot()
}

let snap = open(sessionA)
check('切到有历史用量的会话：status.cost 存在（不是整格消失）', snap.status.cost !== undefined, JSON.stringify(snap.status.cost))
check('回填后的总额等于按磁盘记录算出的总额', snap.status.cost?.total === expectedATotal, String(snap.status.cost?.total) + ' vs ' + String(expectedATotal))
check('峰谷标记与当前时段一致', snap.status.cost?.peakNow === isPeakHour())

// ── 4. 切走（clear）再切回：先到没有用量的会话，再回来 ────────────────────
snap = open(sessionB)
check('切到没有用量行的会话：不要瞎填一个 0 元', snap.status.cost === undefined, JSON.stringify(snap.status.cost))
snap = open(sessionA)
check('切回有历史用量的会话：status.cost 又出现且数额不变', snap.status.cost?.total === expectedATotal, String(snap.status.cost?.total))
check('切回后按模型分桶仍与磁盘一致', sameBuckets(readBuckets(sidA), expectedA))
snap = open(sessionB)
snap = open(sessionA)
check('再切一遍（clear + 回填走第二次）不翻倍', snap.status.cost?.total === expectedATotal, String(snap.status.cost?.total))

// ── 5. 实时增量：切走前的值 = 切回后的值 ─────────────────────────────────
snap = open(sessionC)
check('新会话还没有用量：status.cost 缺席', snap.status.cost === undefined)
service.emit({ type: 'usage', inputTokens: 300_000, outputTokens: 60_000, cacheHitTokens: 100_000, cacheMissTokens: 200_000, model: 'deepseek-v4-flash' })
service.emit({ type: 'usage', inputTokens: 40_000, outputTokens: 20_000, model: 'deepseek-flash' })
snap = service.getSnapshot()
const liveTotal = snap.status.cost?.total
check('实时累计出费用', typeof liveTotal === 'number' && liveTotal > 0, String(liveTotal))
// 这两笔在真实流程里由 agent 插件落盘（agent/index.ts:110），这里补齐同样的两行。
appendFileSync(
  usageFile,
  [
    { t: Date.now(), provider: 'deepseek', model: 'deepseek-v4-flash', i: 300_000, o: 60_000, ch: 100_000, cm: 200_000, sid: sidC },
    { t: Date.now(), provider: 'deepseek', model: 'deepseek-flash', i: 40_000, o: 20_000, sid: sidC },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  'utf8',
)
snap = open(sessionB)
snap = open(sessionC)
check('切走再切回：费用回到切走前的数（磁盘精度内完全相等）', snap.status.cost?.total === liveTotal, String(snap.status.cost?.total) + ' vs ' + String(liveTotal))
snap = open(sessionB)
snap = open(sessionC)
check('再切一遍不翻倍', snap.status.cost?.total === liveTotal, String(snap.status.cost?.total))
service.emit({ type: 'usage', inputTokens: 1_000, outputTokens: 1_000, model: 'deepseek-v4-flash' })
snap = service.getSnapshot()
check('回填之后实时增量接着累加（不是每次 open 都重置）', typeof snap.status.cost?.total === 'number' && snap.status.cost.total > liveTotal)

// ── 6. 宿主重启：新内核（新 transcript）+ 启动收尾回填 ────────────────────
const { emitStartupNotes } = await import(src('host/startup.ts'))

/** 再装一台「刚启动」的内核：转录是新的，内存里一笔累计都没有。 */
const bootKernel = (session) => {
  const bootHandlers = new Map()
  const bootSessionApi = { current: () => session, sessions: [], loading: false }
  let bootService = null
  transcriptPlugin.apply({
    on(name, fn) {
      const list = bootHandlers.get(name) ?? []
      list.push(fn)
      bootHandlers.set(name, list)
      return () => {}
    },
    get: () => undefined,
    provide(_name, value) {
      bootService = value
    },
    session: bootSessionApi,
    llm: { provider: 'deepseek', model: 'deepseek-v4-flash', effort: '', contextWindow: 128_000 },
    surfaces: { build: () => ({ pendingApproval: null }) },
  })
  // 启动收尾只要这三样：转录服务、会话（resumedStartup 为真）、模型信息。
  const root = {
    transcript: bootService,
    session: { startupNote: null, resumedStartup: true, current: () => session },
    llm: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  }
  return { root, boot: () => emitStartupNotes(root, null, { providers: { deepseek: {} } }), service: bootService }
}

const bootA = bootKernel(sessionA)
bootA.boot()
let bootSnap = bootA.service.getSnapshot()
check('重启恢复这条会话：费用按磁盘回填（内存起点为空）', bootSnap.status.cost?.total === expectedATotal, String(bootSnap.status.cost?.total) + ' vs ' + String(expectedATotal))
bootA.boot()
bootSnap = bootA.service.getSnapshot()
check('重启路径再跑一次（重复恢复）不翻倍', bootSnap.status.cost?.total === expectedATotal, String(bootSnap.status.cost?.total))

const bootB = bootKernel(sessionB)
bootB.boot()
bootSnap = bootB.service.getSnapshot()
check('重启恢复到没有请求行的会话：仍然不填 0 元', bootSnap.status.cost === undefined, JSON.stringify(bootSnap.status.cost))

const startupSource = readFileSync(new URL('../src/host/startup.ts', import.meta.url), 'utf8')
check(
  '启动收尾的接线：先重放、再上下文、再费用（与前台切会话同一条口径）',
  /replayHistory\([\s\S]*?readSessionUsage\(root\.session\.current\(\)\.meta\.id\)[\s\S]*?seedContextUsage\([\s\S]*?readSessionCostBuckets\(root\.session\.current\(\)\.meta\.id\)[\s\S]*?seedCostBuckets/.test(
    startupSource,
  ),
)
check('启动收尾没有请求行时不填（null 判断，不写 0）', /if \(costBuckets !== null\)/.test(startupSource))
const bootEntries = ['../src/boot.ts', '../src/headless.ts'].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
check(
  '两个入口（boot / headless）都走同一个启动收尾',
  bootEntries.every((source) => /emitStartupNotes\(root, migration, config\)/.test(source)),
)

console.log('\nPASS ' + (total - failures) + ' / FAIL ' + failures)
if (failures !== 0) process.exitCode = 1
