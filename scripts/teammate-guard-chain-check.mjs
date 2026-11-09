/**
 * 队友与主会话共用同一条工具守卫链（P0-8，2026-11-09）。
 *
 * 钉住四件事：
 *   [1] subagent 不再为每个队友 `new ToolGuardRegistry()` 另起一条链；
 *   [2] MiniAgent 的 `guards:` 转发到共享的 `ctx.guards`（只改写会话归属）；
 *   [3] 队友特有的闸门注册在共享链上（teammate-mode / teammate-approval）；
 *   [4] 行为上：hooks.json 禁止的 read / write，队友这条链会命中同一条 hooks 守卫。
 *
 * 链按**源码现状**搭：修复前 subagent 自建链，探针就搭一条只有模式与审批的链，
 * 断言失败；修复后共用 `ctx.guards`，探针直接拿主链判定，断言通过。这样不跑
 * `pnpm run build`（lib 是旧的）测的也是源码，不是构建产物。
 *
 * hooks 规则匹配照 `src/packages/session-core/hooks.ts` 的 `ruleHits` 写（工具名清单、
 * 字段、不区分大小写的正则，写坏时退化成字面量子串），只保留探针要用的那一段。
 *
 * 用法：node scripts/teammate-guard-chain-check.mjs
 *
 * @module dsc/scripts/teammate-guard-chain-check
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** 临时 HOME：hooks.json 只写在这里，真实 ~/.dsc 一个字节都不动。 */
const home = mkdtempSync(join(tmpdir(), 'dsc-teammate-guard-'))
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
const hooksFile = join(dsc, 'hooks.json')
writeFileSync(
  hooksFile,
  JSON.stringify(
    {
      version: 1,
      settings: { enabled: true },
      rules: [
        {
          id: 'probe-read',
          enabled: true,
          tool: 'read',
          field: 'target',
          pattern: '\\.env$',
          action: 'deny',
          reason: '本项目禁止读 .env',
        },
        {
          id: 'probe-write',
          enabled: true,
          tool: 'write',
          field: 'target',
          pattern: 'migrations',
          action: 'deny',
          reason: '本项目禁止碰 migrations/',
        },
      ],
      scripts: [],
    },
    null,
    2,
  ),
  'utf8',
)

/** 工具名清单：`*`/空 = 全部，否则 `|` 或 `,` 分隔的字面量（照 hooks.ts 的 toolListHit）。 */
const toolListHit = (list, toolName) => {
  const trimmed = String(list ?? '').trim()
  if (trimmed === '' || trimmed === '*') return true
  return trimmed
    .split(/[|,]/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
    .includes(toolName.toLowerCase())
}

/** 一条规则是否命中这次调用（照 hooks.ts 的 ruleHits）。 */
const ruleHits = (rule, facts) => {
  if (!toolListHit(rule.tool, facts.toolName)) return false
  let regex = null
  try {
    regex = new RegExp(rule.pattern, 'i')
  } catch {
    regex = null
  }
  const fields = rule.field === 'any' ? ['command', 'target', 'args'] : [rule.field]
  for (const field of fields) {
    const text = field === 'command' ? facts.command : field === 'target' ? facts.target : facts.argsText
    if (text === '') continue
    if (regex !== null ? regex.test(text) : text.toLowerCase().includes(String(rule.pattern).toLowerCase())) return true
  }
  return false
}

/** 探针里的 hooks 守卫：id 与 order 照 `src/packages/hooks/index.ts:379-381` 的真实注册。 */
const hooksGuard = () => ({
  id: 'hooks',
  order: 20,
  decide(input) {
    let doc
    try {
      doc = JSON.parse(readFileSync(hooksFile, 'utf8'))
    } catch {
      return { action: 'defer' }
    }
    if (doc.settings?.enabled === false) return { action: 'defer' }
    const facts = {
      toolName: input.toolName,
      command: input.command ?? '',
      target: input.target ?? '',
      argsText: JSON.stringify(input.args ?? {}),
    }
    for (const rule of doc.rules ?? []) {
      if (rule.enabled === false) continue
      if (!ruleHits(rule, facts)) continue
      return rule.action === 'deny'
        ? { action: 'deny', reason: rule.reason || '这条操作被用户登记的规则禁止' }
        : { action: 'deny', reason: '钩子要求确认，但这个位置没有审批卡可弹，先按拒绝处理' }
    }
    return { action: 'defer' }
  },
})

const TEAMMATE_SESSION = 'teammate-session-id'
const baseInput = {
  cwd: 'D:/proj',
  signal: new AbortController().signal,
  sessionId: TEAMMATE_SESSION,
  sessionPath: 'C:/Users/probe/.dsc/team/proj/teammate.jsonl',
}

const main = async () => {
  const ToolGuardRegistry = await loadRegistry()

  // ── 主链：与真实插件同 id、同 order（地板 5 / 沙箱 8 / 模式 10 / 钩子 20 / 审批 30）──
  const shared = new ToolGuardRegistry()
  shared.register({ id: 'approval-floor', order: 5, decide: () => ({ action: 'defer' }) })
  shared.register({ id: 'sandbox', order: 8, decide: () => ({ action: 'defer' }) })
  shared.register({ id: 'mode', order: 10, decide: () => ({ action: 'defer' }) })
  shared.register(hooksGuard())
  shared.register({ id: 'lifecycle-hooks', order: 25, decide: () => ({ action: 'defer' }) })
  shared.register({ id: 'file-review', order: 25, decide: () => ({ action: 'defer' }) })
  shared.register({
    id: 'approval',
    order: 30,
    decide: (input) => (input.risk === 'read' ? { action: 'defer' } : { action: 'pass' }),
  })

  // ── 修复前的队友链：`new ToolGuardRegistry()` + 模式 5 + 审批 30（没有沙箱/钩子）──
  const legacyTeammateChain = () => {
    const chain = new ToolGuardRegistry()
    chain.register({ id: 'teammate-mode', order: 5, decide: () => ({ action: 'defer' }) })
    chain.register({
      id: 'teammate-approval',
      order: 30,
      // 探针按「全局与工牌都允许队友请求授权」这一档跑：旧链对写类给 pass，
      // 于是 hooks.json 的禁令完全没机会说话。
      decide: (input) => (input.risk === 'read' ? { action: 'defer' } : { action: 'pass' }),
    })
    return chain
  }

  // ── 源码现状：队友到底用哪条链 ────────────────────────────────────────────
  const subagent = source('src/packages/subagent/index.ts')
  const hooksPlugin = source('src/packages/hooks/index.ts')
  const ownsRegistry = /new\s+ToolGuardRegistry\s*\(/.test(subagent)
  // 共享方式：MiniAgent 拿一层薄适配器，适配器把 gate 原样转给 `ctx.guards.gate`。
  const usesShared = /ctx\.guards\.gate\(/.test(subagent) && /guards:\s*teammateGuardChain\(teammate\)/.test(subagent)
  const registersTeammateMode = /id:\s*'teammate-mode'/.test(subagent)
  const teammateChain = usesShared && !ownsRegistry ? shared : legacyTeammateChain()

  console.log('队友守卫链探针（P0-8）')

  // ── 结构断言 ─────────────────────────────────────────────────────────────
  check('subagent 不再自建 ToolGuardRegistry', !ownsRegistry, '仍有 new ToolGuardRegistry()')
  check('MiniAgent 的 guards 转发到共享的 ctx.guards', usesShared, '没找到转发到 ctx.guards.gate 的适配器')
  check('队友特有闸门 teammate-mode 注册在共享链上', registersTeammateMode, "没找到 id: 'teammate-mode'")
  check(
    '主链 hooks 守卫的 id/order 与探针模拟一致（hooks@20）',
    /id:\s*'hooks'/.test(hooksPlugin) && /order:\s*20/.test(hooksPlugin),
    'hooks 插件里的 id/order 变了，探针要跟着改',
  )
  check(
    '工具白名单仍在 toolsFor 里筛选（共享守卫不放宽工具面）',
    subagent.includes('teammate.badge.tools!.includes(entry.name)'),
    'toolsFor 的白名单筛选不见了',
  )
  check(
    '队友审批仍按归属会话归属（不落到用户正看着的会话）',
    subagent.includes('ownerSession(teammate)') && subagent.includes('sessionId: owner.meta.id'),
    '审批归属行不见了',
  )

  const teammateChainIds = teammateChain.chain.map((guard) => guard.id)
  check('队友链上有 hooks 守卫', teammateChainIds.includes('hooks'), teammateChainIds.join(','))
  check(
    '队友链上有灾难地板与沙箱',
    teammateChainIds.includes('approval-floor') && teammateChainIds.includes('sandbox'),
    teammateChainIds.join(','),
  )

  // ── 行为断言：hooks.json 的禁令真的落到队友这条链上 ──────────────────────
  const readVerdict = await teammateChain.gate({
    ...baseInput,
    toolName: 'read',
    risk: 'read',
    args: { path: 'secrets/.env' },
    target: 'D:/proj/secrets/.env',
  })
  check(
    '队友读 .env 时被 hooks.json 的 deny 规则拦下',
    readVerdict.action === 'deny' && readVerdict.reason.includes('.env'),
    JSON.stringify(readVerdict),
  )

  const writeVerdict = await teammateChain.gate({
    ...baseInput,
    toolName: 'write',
    risk: 'write',
    args: { path: 'migrations/001.sql', content: 'x' },
    target: 'D:/proj/migrations/001.sql',
  })
  check(
    '队友写 migrations/ 时被 hooks.json 的 deny 规则拦下',
    writeVerdict.action === 'deny' && writeVerdict.reason.includes('migrations'),
    JSON.stringify(writeVerdict),
  )

  // 主会话自己的调用不该被队友专属守卫影响：共享链上它们对非队友会话 defer。
  const mainVerdict = await shared.gate({
    ...baseInput,
    sessionId: 'lead-session-id',
    sessionPath: 'C:/Users/probe/.dsc/sessions/lead.jsonl',
    toolName: 'read',
    risk: 'read',
    args: { path: 'README.md' },
    target: 'D:/proj/README.md',
  })
  check('主会话读普通文件不被队友规则误伤', mainVerdict.action === 'defer', JSON.stringify(mainVerdict))

  rmSync(home, { recursive: true, force: true })
  console.log(`\nPASS ${pass} / FAIL ${fail}`)
  if (fail > 0) process.exitCode = 1
}

await main()
