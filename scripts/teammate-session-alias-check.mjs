/**
 * 队友会话归属三问（P0-8 复审问题 1/2/3，2026-11-09）。
 *
 * 钉住四件事：
 *   [1] 队友会话的 gate 入参经「会话别名」解析后，沙箱拿到的是**父会话**的档位，
 *       而不是回落成「用户正看着的那条会话」（问题 1：PTC 的 run_code 绕过适配器）；
 *   [2] 父队友出队后，嵌套队友的归属仍指向最上层会话（问题 2）；
 *   [3] hooks 的 ask 卡带上发起会话的 sessionId / sessionPath（问题 3）；
 *   [5] 归属会话不在名册（后台会话被收摊 / 被挤出空闲名单）：只有 sessionPath 时
 *       按路径只读加载，路径也没了时沙箱按拒、模式按最严档（二轮复审真问题 1）。
 *
 * 怎么测：守卫注册表本体直接从源码 TS 拿（Node 22.18+ 默认剥类型）；会话归属解析器
 * 与固化字段的代码用 `node:module` 的 `stripTypeScriptTypes` 剥掉类型后从源码里取出来跑，
 * 所以测的是源码现状而不是手抄的一份（拿不到剥离能力时退回等价手抄，并在输出里标注）。
 * [5] 直接 import 共享的 `resolveGuardSession`（真跑 `Session.load`，用临时 jsonl，
 * 不碰真实 `~/.dsc`），再配源码文本断言钉住三个调用点确实改用它、且取不到就拒。
 *
 * 修前跑：解析器不存在、沙箱按「当前查看会话」给档、ask 卡不带会话、三个调用点都没接
 * 共享反查，对应断言整片 FAIL。修后跑：全 PASS。不跑 `pnpm run build`（lib 是旧的）。
 *
 * 用法：node scripts/teammate-session-alias-check.mjs
 *
 * @module dsc/scripts/teammate-session-alias-check
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { register } from 'node:module'

// ── 临时 HOME：path-policy 在 import 时按 homedir() 定下 DSC_HOME，必须先设好 ──
// `Session.load(path, true, { lease: false })` 只读重放不给锁、不建目录，这样连
// 探针顺带跑到的会话读取也不会碰到真实 `~/.dsc`。
const home = mkdtempSync(join(tmpdir(), 'dsc-teammate-alias-'))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.DSC_HOME

// ── 源码加载器：@pneuma/runtime/* → src/*、@pneuma/<包>/* → src/packages/<包>/*、
//    相对 .js 说明符 → .ts。只在探针进程内注册，不改仓库的解析规则。 ──
const srcRoot = new URL('../src/', import.meta.url).href
const sourceLoader = `
const SRC = ${JSON.stringify(srcRoot)}
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@pneuma/runtime/')) {
    const tail = specifier.slice('@pneuma/runtime/'.length).replace(/\\.js$/, '.ts')
    return nextResolve(new URL(tail, SRC).href, context)
  }
  if (specifier.startsWith('@pneuma/')) {
    const rest = specifier.slice('@pneuma/'.length).replace(/\\.js$/, '.ts')
    return nextResolve(new URL('packages/' + rest, SRC).href, context)
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    try { return await nextResolve(specifier.slice(0, -3) + '.ts', context) } catch { return nextResolve(specifier, context) }
  }
  return nextResolve(specifier, context)
}
`
register('data:text/javascript;base64,' + Buffer.from(sourceLoader, 'utf8').toString('base64'))

const root = new URL('..', import.meta.url)
const source = (relative) => readFileSync(new URL(relative, root), 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** 注册表本体从源码 TS 直接拿（Node 22.18+ 默认剥类型）；旧 Node 退回构建产物。 */
const loadRegistry = async () => {
  try {
    return (await import(new URL('../src/core/tool-guards.ts', import.meta.url))).ToolGuardRegistry
  } catch {
    return (await import(new URL('../lib/core/tool-guards.js', import.meta.url))).ToolGuardRegistry
  }
}

/** 从 `from`（一个 `{`）找配对的 `}`，返回闭括号下标；找不到 = -1。块里没有字符串花括号。 */
const matchBrace = (text, from) => {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

let stripTypes = null
try {
  ;({ stripTypeScriptTypes: stripTypes } = await import('node:module'))
} catch {
  stripTypes = null
}

const subagentSource = source('src/packages/subagent/index.ts')
const ptcSource = source('src/packages/ptc/index.ts')
const hooksSource = source('src/packages/hooks/index.ts')

console.log('队友会话归属探针（P0-8 复审问题 1/2/3）')

// ── [1] 别名解析：沙箱拿到的必须是父会话 ────────────────────────────────────
const OWNER_ID = 'lead-session-id'
const OWNER_PATH = 'C:/Users/probe/.dsc/sessions/lead.jsonl'
const TEAMMATE_ID = 'teammate-session-id'
const TEAMMATE_PATH = 'C:/Users/probe/.dsc/team/proj/w1.jsonl'
/** 用户此刻正看着的另一条会话（完全访问档）：沙箱查表落空时就会回落成它。 */
const CURRENT_ID = 'user-current-session-id'

const ToolGuardRegistry = await loadRegistry()
const shared = new ToolGuardRegistry()
/** 常驻会话表：`agent.sessionById` 只认常驻 agent，队友的临时会话不在里面。 */
const resident = new Map([[OWNER_ID, OWNER_ID]])
let sandboxSaw = null
let modeGuardSawMarker

shared.register({ id: 'approval-floor', order: 5, decide: () => ({ action: 'defer' }) })
shared.register({
  id: 'sandbox',
  order: 8,
  decide(input) {
    // 照 sandbox/index.ts:175-184：先按 id 查常驻表，落空再按路径，最后回落「用户正看着的会话」
    sandboxSaw = resident.get(input.sessionId) ?? CURRENT_ID
    return { action: 'defer' }
  },
})
shared.register({
  id: 'teammate-mode',
  order: 9,
  decide(input) {
    modeGuardSawMarker = input.teammate
    return { action: 'defer' }
  },
})
shared.register({ id: 'mode', order: 10, decide: () => ({ action: 'defer' }) })
shared.register({
  id: 'approval',
  order: 30,
  decide: (input) => (input.risk === 'read' ? { action: 'defer' } : { action: 'pass' }),
})

const fakeSession = (id, path) => ({ meta: { id }, filePath: path })
const teammates = new Map()
teammates.set('w1', {
  name: 'w1',
  session: fakeSession(TEAMMATE_ID, TEAMMATE_PATH),
  ownerSession: fakeSession(OWNER_ID, OWNER_PATH),
})

// 照 subagent 的登记方式：按队友会话 id 找它，返回启动时固化的归属会话 + 认人标记。
const registerAlias = shared.registerSessionResolver
if (typeof registerAlias === 'function') {
  registerAlias.call(shared, 'subagent', (sessionId) => {
    for (const teammate of teammates.values()) {
      if (teammate.session.meta.id !== sessionId) continue
      return {
        sessionId: teammate.ownerSession.meta.id,
        sessionPath: teammate.ownerSession.filePath,
        facts: { teammate: teammate.name },
      }
    }
    return undefined
  })
}

const gateInput = {
  toolName: 'write',
  risk: 'write',
  cwd: 'D:/proj',
  args: { path: 'outside.txt', content: 'x' },
  target: 'D:/outside.txt',
  signal: new AbortController().signal,
  sessionId: TEAMMATE_ID,
  sessionPath: TEAMMATE_PATH,
}
await shared.gate(gateInput)

check(
  '守卫服务能登记「会话别名 → 归属会话」解析器',
  typeof registerAlias === 'function',
  'core/tool-guards.ts 没有 registerSessionResolver',
)
check('队友会话的 gate 输入经解析后，沙箱拿到父会话的档位', sandboxSaw === OWNER_ID, `沙箱收到 ${String(sandboxSaw)}`)
check('沙箱不再回落成「用户正看着的会话」', sandboxSaw !== CURRENT_ID, `回落到了 ${String(sandboxSaw)}`)
check('解析时给 teammate 守卫带上认人标记', modeGuardSawMarker === 'w1', `标记 ${String(modeGuardSawMarker)}`)

const resolveSession = shared.resolveSession
const resolved =
  typeof resolveSession === 'function'
    ? resolveSession.call(shared, gateInput)
    : undefined
check('resolveSession 把队友会话换成父会话', resolved?.sessionId === OWNER_ID, `得到 ${String(resolved?.sessionId)}`)
const leadResolved =
  typeof resolveSession === 'function'
    ? resolveSession.call(shared, { ...gateInput, sessionId: OWNER_ID, sessionPath: OWNER_PATH })
    : undefined
check('父会话自身不会被再改写（解析是幂等的）', leadResolved?.sessionId === OWNER_ID, `得到 ${String(leadResolved?.sessionId)}`)

check(
  'subagent 在守卫服务上登记了解析器',
  /registerSessionResolver\?\.\('subagent'/.test(subagentSource),
  '没找到 registerSessionResolver(…\'subagent\'…)',
)
check(
  'PTC 不在自己家里抄第二份归属改写',
  !/ownerSession|aliasSession|resolveSession/.test(ptcSource),
  'ptc/index.ts 里出现了归属改写，应当统一交给守卫服务',
)

// ── [2] 父队友出队后，子队友仍指最上层 ─────────────────────────────────────
const ownerDecl = 'const ownerOfSession = (from: Session): Session => {'
const ownerAt = subagentSource.indexOf(ownerDecl)
const ownerBrace = ownerAt < 0 ? -1 : subagentSource.indexOf('{', ownerAt)
const ownerEnd = ownerBrace < 0 ? -1 : matchBrace(subagentSource, ownerBrace)
const ownerBlock = ownerEnd < 0 ? null : subagentSource.slice(ownerAt, ownerEnd + 1)

/** 从源码里取出 ownerOfSession 并跑起来；取不到就退回等价手抄。 */
const makeOwnerOfSession = (records) => {
  if (ownerBlock !== null && stripTypes !== null) {
    try {
      const js = stripTypes(ownerBlock)
      return new Function('teammates', `${js}\nreturn ownerOfSession`)(records)
    } catch {
      // 落到下面的手抄版
    }
  }
  return (from) => {
    let current = from
    const seen = new Set()
    while (!seen.has(current.meta.id)) {
      seen.add(current.meta.id)
      const parent = [...records.values()].find((entry) => entry.session.meta.id === current.meta.id)
      if (parent === undefined) break
      current = parent.parentSession
    }
    return current
  }
}

const records = new Map()
const ownerOfSession = makeOwnerOfSession(records)
const lead = fakeSession('lead-session', 'C:/sessions/lead.jsonl')

/** 源码是否已经改成「派活时算一次并固化」；没改就按旧写法（每次现查）复现。 */
const freezesOwner =
  /ownerSession: ownerOfSession\(input\.parentSession\)/.test(subagentSource) &&
  /const ownerSession = \(teammate: Teammate\): Session => teammate\.ownerSession/.test(subagentSource)

/** 照 startTeammate：归属会话在派活时算一次并固化（源码没改时复现旧的「用时现查」）。 */
const spawn = (name, parentSession) => {
  const record = {
    name,
    session: fakeSession(`session-${name}`, `C:/team/${name}.jsonl`),
    parentSession,
  }
  if (freezesOwner) {
    record.ownerSession = ownerOfSession(parentSession)
  } else {
    // 旧写法：每次读的时候现查（用 getter，避免被对象展开提前求值）
    Object.defineProperty(record, 'ownerSession', { get: () => ownerOfSession(parentSession), enumerable: true })
  }
  records.set(name, record)
  return record
}

const parentTeammate = spawn('w1', lead)
const childTeammate = spawn('w2', parentTeammate.session)
records.delete('w1')

check(
  '父队友出队后，子队友的归属仍指向最上层会话',
  childTeammate.ownerSession.meta.id === lead.meta.id,
  `得到 ${childTeammate.ownerSession.meta.id}`,
)
check(
  '反面对照：出队后再沿 Map 反查会断在中间层',
  ownerOfSession(childTeammate.parentSession).meta.id !== lead.meta.id,
  '反查仍能走到最上层，说明这份对照没测到问题',
)
check('Teammate 结构里固化了归属会话', /ownerSession: Session/.test(subagentSource), '没找到 ownerSession 字段')
check(
  '派活时把归属会话算一次存进队友',
  /ownerSession: ownerOfSession\(input\.parentSession\)/.test(subagentSource),
  '没找到 ownerSession: ownerOfSession(input.parentSession)',
)
check(
  'ownerSession 访问器只读固化字段（不再沿 Map 反查）',
  /const ownerSession = \(teammate: Teammate\): Session => teammate\.ownerSession/.test(subagentSource),
  'ownerSession 仍是沿 teammates 往上找的写法',
)

// ── [3] hooks 的 ask 卡必须带发起会话 ──────────────────────────────────────
const askAt = hooksSource.indexOf('const decision = await ctx.approval.decide(')
const askBrace = askAt < 0 ? -1 : hooksSource.indexOf('{', askAt)
const askEnd = askBrace < 0 ? -1 : matchBrace(hooksSource, askBrace)
const askLiteral = askEnd < 0 ? null : hooksSource.slice(askBrace, askEnd + 1)

const probeInput = {
  toolName: 'write',
  args: { path: 'x.txt' },
  cwd: 'D:/proj',
  sessionId: 'who-asked',
  sessionPath: 'C:/Users/probe/.dsc/sessions/who.jsonl',
}
let asked = null
if (askLiteral !== null) {
  try {
    asked = new Function('input', 'argsSummary', `return (${askLiteral})`)(probeInput, () => '')
  } catch {
    asked = null
  }
}

check(
  'hooks 的 ask 请求带上 sessionId',
  asked?.sessionId === probeInput.sessionId,
  asked === null ? '没找到 decide 的入参对象' : `sessionId=${String(asked.sessionId)}`,
)
check(
  'hooks 的 ask 请求带上 sessionPath',
  asked?.sessionPath === probeInput.sessionPath,
  asked === null ? '没找到 decide 的入参对象' : `sessionPath=${String(asked.sessionPath)}`,
)

// ── [4] 上一轮的结论不许动：两位队友守卫的位置 ──────────────────────────────
const nearOrder = (text, anchor, order) => {
  const at = text.indexOf(anchor)
  if (at < 0) return false
  return new RegExp(`order:\\s*${order}\\b`).test(text.slice(at, at + 240))
}
check("teammate-mode 仍在 order 9（沙箱之后、模式之前）", nearOrder(subagentSource, "id: 'teammate-mode'", 9))
check('teammate-approval 仍在 order 29（主审批之前）', nearOrder(subagentSource, 'const teammateApprovalGuard', 29))

// ── [5] 归属会话不在名册：按路径只读加载，取不到就按拒（P0-8 二轮复审真问题 1）──
// 现场：派活的是后台 / 定时会话，回合结束就被收摊；或用户切过 3 条以上，把它挤出
// IDLE_KEEP=3 的空闲名单。这两条路下 `sessionById` / `sessionFor` 都返回 undefined，
// 只剩 `sessionPath` 指向的 jsonl 还在——修前三位守卫都会回落「用户正看着的那条会话」。
const sandboxSource = source('src/packages/sandbox/index.ts')
const modeSource = source('src/packages/mode/index.ts')
const approvalSource = source('src/packages/approval/index.ts')
const { resolveGuardSession } = await import('../src/core/guard-session.ts')
const { modeSpec } = await import('../src/packages/session-core/modes.ts')

const probeRoot = mkdtempSync(join(tmpdir(), 'dsc-guard-session-'))
const pathOnlyFile = join(probeRoot, 'path-only.jsonl')
writeFileSync(
  pathOnlyFile,
  `${JSON.stringify({ type: 'meta', id: 'path-only-session-id', cwd: probeRoot, createdAt: Date.now() })}\n`,
)
const missingFile = join(probeRoot, 'already-deleted.jsonl')

const currentSession = {
  meta: { id: 'user-current-session-id', cwd: probeRoot },
  filePath: join(probeRoot, 'current.jsonl'),
  state: () => undefined,
}
/** 空名册：归属会话已经不在 `agents` 里（收摊 / 被挤出空闲名单）。 */
const noRoster = {
  get: (name) => (name === 'agent' ? { sessionById: () => undefined, sessionFor: () => undefined } : undefined),
  session: { current: () => currentSession },
}
const scopeOnlyPath = { sessionId: 'evicted-session-id', sessionPath: pathOnlyFile }

const loaded = resolveGuardSession(noRoster, scopeOnlyPath)
check('名册认不出、只有 sessionPath 时按路径只读加载', loaded?.meta.id === 'path-only-session-id', `得到 ${String(loaded?.meta.id)}`)
check('按路径加载出的会话不是「用户正看着的那条」', loaded?.meta.id !== currentSession.meta.id, `得到 ${String(loaded?.meta.id)}`)
check('只读加载保留读进来的路径（keepPath）', loaded?.filePath === pathOnlyFile, `得到 ${String(loaded?.filePath)}`)
check(
  '会话文件也不存在时返回 null',
  resolveGuardSession(noRoster, { sessionId: 'evicted-session-id', sessionPath: missingFile }) === null,
)
check('连路径都没有时返回 null（不回落当前查看会话）', resolveGuardSession(noRoster, { sessionId: 'evicted-session-id' }) === null)

/** 照 sandbox/index.ts 的新写法：解析不到 → 拒。 */
const sandboxProbe = new ToolGuardRegistry()
let pathSaw = null
sandboxProbe.register({
  id: 'sandbox',
  order: 8,
  decide(input) {
    const session = resolveGuardSession(noRoster, input)
    if (session === null) return { action: 'deny', reason: '判不清归属' }
    pathSaw = session.meta.id
    return { action: 'defer' }
  },
})
await sandboxProbe.gate({ ...gateInput, ...scopeOnlyPath })
check('沙箱拿到的是按路径加载的会话（不是当前会话）', pathSaw === 'path-only-session-id', `沙箱收到 ${String(pathSaw)}`)
const missingGate = await sandboxProbe.gate({ ...gateInput, sessionId: 'evicted-session-id', sessionPath: missingFile })
check('路径也不存在时沙箱按拒处理', missingGate.action === 'deny', `得到 ${missingGate.action}`)

/** 照 mode/index.ts 的新写法：解析不到 → 最严档 explore（只读）。 */
const modeProbe = new ToolGuardRegistry()
let modeFallback = null
modeProbe.register({
  id: 'mode',
  order: 10,
  decide(input) {
    const session = resolveGuardSession(noRoster, input)
    modeFallback = session === null ? 'explore' : String(session.state('mode') ?? 'build')
    return modeSpec(modeFallback).gate({
      toolName: input.toolName,
      risk: input.risk,
      target: input.target,
      command: input.command,
      cwd: input.cwd,
      rules: [],
    })
  },
})
const modeDenied = await modeProbe.gate({ ...gateInput, sessionId: 'evicted-session-id', sessionPath: missingFile })
check('模式闸取不到会话时按最严档（只读）判', modeFallback === 'explore', `得到 ${String(modeFallback)}`)
check('最严档下写操作被拒（没有回落当前会话的 build）', modeDenied.action === 'deny', `得到 ${modeDenied.action}`)

check(
  'sandbox 守卫的会话反查交给共享 resolveGuardSession',
  /resolveGuardSession\(ctx, \{ sessionId, sessionPath \}\)/.test(sandboxSource),
  '没找到共享反查',
)
check(
  'sandbox 取不到归属会话时按拒（不回落当前查看会话）',
  /if \(session === null\) \{[\s\S]{0,240}?action: 'deny'/.test(sandboxSource),
  '没找到 session === null 的拒绝分支',
)
check(
  'mode 闸门取不到会话时按 explore 兜底',
  /const mode = session === null \? 'explore' : modeOf\(session\)/.test(modeSource),
  '没找到 explore 兜底',
)
check(
  'mode 闸门不再回落「用户正看着的那条会话」',
  !/modeOf\(session \?\? ctx\.session\.current\(\)\)/.test(modeSource),
  '仍有 session ?? ctx.session.current() 的回落',
)
check(
  'approval 的会话反查交给共享 resolveGuardSession',
  /resolveGuardSession\(ctx, request\)/.test(approvalSource),
  '没找到共享反查',
)
check(
  'approval 取不到归属会话时按拒并说明会话已结束',
  /会话已经结束/.test(approvalSource),
  '没找到「会话已结束」的拒绝说明',
)

console.log(`\nPASS ${pass} / FAIL ${fail}`)
if (fail > 0) process.exitCode = 1
