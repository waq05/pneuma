/**
 * 长期记忆对齐（memory parity）回归探针：真内核 + 临时 HOME + 临时 git 工作区。
 *
 * 钉住六件事（每件都对应一条本轮补齐）：
 *   ① 记忆当轮生效——写入后同一个会话的下一次请求（systemPrompt）里就有那条记忆；
 *   ② `# agentsMd` 合并注入——AGENTS.md 与记忆索引在同一个块；只有记忆时标题仍在；
 *   ③ 老 `§` 纯文本格式向后兼容——能读、能写、写回形状合法（事实不加 `[fact]` 前缀）；
 *   ④ 类型解析——`feedback` / `reference` / 缺省（fact）在存储与注入里的呈现；
 *   ⑤ 整理（prune）保守性——只移不删、未被引用的优先被移、归档文件收得下；
 *   ⑥ 抽取跳过规则——本段直写过记忆、或没有 ≥3 词的独立用户文本块时不发起复盘；
 *      另加一条正向对照：条件满足时复盘确实会起（否则前两条的「没起」不算数）。
 *
 * 隔离：临时 HOME + 临时工作区（真 `git init`），不碰真实 ~/.dsc。
 *
 * 运行：node scripts/memory-parity-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/memory-parity-test
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-memory-parity-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')
// 记忆插件的可调值走条目树：关掉会话打开时的自动整理（本探针自己控时机），
// 陈旧阈值压到 0（只要没被引用过就具备被移的资格），复盘节拍压到 1（跳过规则才验得了）。
writeFileSync(
  join(dsc, 'plugins.json'),
  JSON.stringify(
    { version: 1, entries: [{ file: 'memory', config: { pruneEnabled: false, pruneAfterDays: 0, reviewEnabled: true, reviewEveryTurns: 1 } }] },
    null,
    2,
  ),
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

// ── 老格式记忆文件：内核起来之前就摆在盘上（不然后续读会被当成「外部改动」）──────
const memGlobal = join(dsc, 'memory', 'global')
mkdirSync(memGlobal, { recursive: true })
const globalFile = join(memGlobal, 'MEMORY.md')
writeFileSync(globalFile, '老格式条目甲\n§\n老格式条目乙\n', 'utf8')

// ── 工作区：一个真 git 仓库（指令文件按仓库根锚定）──────────────────────────────
const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: ws, stdio: 'pipe', windowsHide: true })
git('init', '-q')
git('config', 'user.email', 'probe@local')
git('config', 'user.name', 'probe')
writeFileSync(join(ws, 'a.txt'), 'one\n', 'utf8')
git('add', 'a.txt')
git('commit', '-qm', 'init')

const sessionDir = join(dsc, 'sessions', ws.replace(/[:\\/]+/g, '-'))
mkdirSync(sessionDir, { recursive: true })
const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000'
const sessionFile = join(sessionDir, `${sessionId}.jsonl`)
writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: 'meta', id: sessionId, cwd: ws, createdAt: 1 })}\n${JSON.stringify({ type: 'user', text: '这是一条足够长的探针发言' })}\n`,
  'utf8',
)
// 短应答会话（没有 ≥3 词的独立用户文本块）：⑥ 的负向素材
const shortId = 'bbbbbbbb-cccc-dddd-eeee-ffff00001111'
const shortFile = join(sessionDir, `${shortId}.jsonl`)
writeFileSync(
  shortFile,
  `${JSON.stringify({ type: 'meta', id: shortId, cwd: ws, createdAt: 2 })}\n${JSON.stringify({ type: 'user', text: '嗯' })}\n`,
  'utf8',
)

const { createKernel } = await import('../lib/host/kernel.js')
const core = await import('../lib/core/memory.js')
const kernel = await createKernel({ config: {}, resumeSessionPath: sessionFile })
const memory = kernel.get('memory')
const prompt = kernel.get('prompt')
const session = kernel.get('session')
const memoryTool = kernel.tools.list().find((tool) => tool.name === 'memory')
const runCtx = () => ({ cwd: ws, sessionId: session.current().meta.id, signal: new AbortController().signal })
const systemPrompt = () => prompt.systemPrompt(ws)
const readCellFile = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
const messagesText = () => JSON.stringify(session.current().messages)

console.log('[前提] memory 插件与工具就位')
check('memory 服务在册', memory !== undefined)
check('memory 工具在册', memoryTool !== undefined)
check('老格式文件读成两条 fact', memory.cells().find((cell) => cell.target === 'global')?.entries.length === 2, JSON.stringify(memory.cells().find((c) => c.target === 'global')?.entries))

// ── ③ 老 `§` 纯文本向后兼容：读 → 写 → 形状合法 ────────────────────────────────
console.log('\n[③] 老格式读取 / 写入 / 形状合法')
{
  const cell = memory.cells().find((item) => item.target === 'global')
  check('老条目都解析成 fact（无前缀）', cell.entries.every((entry) => core.entryType(entry) === 'fact'), JSON.stringify(cell.entries))
  const result = await memoryTool.run({ target: 'global', action: 'add', content: '老格式新增丙' }, runCtx())
  check('在老格式文件上继续写成功', result.includes('已更新') || result.includes('已记下'), result.slice(0, 80))
  const after = memory.cells().find((item) => item.target === 'global')
  check('写回后三条都在、每条仍是 fact', after.entries.length === 3 && after.entries.every((entry) => core.entryType(entry) === 'fact'), JSON.stringify(after.entries))
  const onDisk = readCellFile(globalFile)
  check('磁盘形状合法（§ 分隔、结尾换行、事实不带 [fact] 前缀）', onDisk.includes('\n§\n') && onDisk.endsWith('\n') && !onDisk.includes('[fact]'), JSON.stringify(onDisk))
  check('core.splitEntries 读回同样三条', core.splitEntries(onDisk).length === 3, JSON.stringify(core.splitEntries(onDisk)))
}

// ── ① 记忆当轮生效：写入后同一个会话的下一次请求里就有它 ────────────────────────
console.log('\n[①] 写入后同一会话的下一次注入快照里就有（不等新会话/压缩）')
{
  const marker = '同轮生效标记XYZ-2026'
  check('写入前注入里没有这条标记', !systemPrompt().includes(marker))
  const result = await memoryTool.run({ target: 'global', action: 'add', content: marker }, runCtx())
  check('写入回执说已记下', result.includes('已记下') || result.includes('已更新'), result.slice(0, 80))
  // 关键：没有新会话、没有压缩，直接再拼一次系统提示（= 下一步请求要发的那份）
  check('同一会话的下一次 systemPrompt 里立刻有这条标记', systemPrompt().includes(marker), systemPrompt().slice(0, 120))
  check('服务快照（memory.snapshot）也换了新的一份', memory.snapshot().includes(marker))
}

// ── ⑦ 过期提醒：写入后下一次请求挂一次，随即消失（别常驻）──────────────────────
console.log('\n[⑦] 一次性「记忆副本已过期」提醒（P1-6）')
{
  await memoryTool.run({ target: 'global', action: 'add', content: '过期提醒探针条目' }, runCtx())
  const first = systemPrompt()
  const second = systemPrompt()
  check('写入后紧接着的一次请求带上过期提醒', first.includes('记忆副本已过期'), first.slice(-160))
  check('读过一次就不再出现（不是常驻）', !second.includes('记忆副本已过期'), second.slice(-160))
}

// ── ② 与 AGENTS.md 合并注入 `# agentsMd`：只有记忆时标题仍在 ────────────────────
console.log('\n[②] `# agentsMd` 同块 + 只有记忆时标题仍在')
{
  const base = systemPrompt()
  check('只有记忆、没有 AGENTS.md 时 `# agentsMd` 标题仍在', base.includes('# agentsMd'), base.slice(0, 80))
  check('恰好一个 `# agentsMd`（没有重复注入）', (base.match(/# agentsMd/g) ?? []).length === 1, String((base.match(/# agentsMd/g) ?? []).length))

  const marker = 'AGENTS-合并块标记-7788'
  writeFileSync(join(ws, 'AGENTS.md'), `项目说明：${marker}\n`, 'utf8')
  const merged = systemPrompt()
  const titleAt = merged.indexOf('# agentsMd')
  const agentsAt = merged.indexOf(marker)
  const memoryAt = merged.indexOf('全局事实记忆')
  check('AGENTS.md 进了 `# agentsMd` 块（标题在先）', titleAt >= 0 && agentsAt > titleAt, JSON.stringify({ titleAt, agentsAt }))
  check('记忆索引与 AGENTS.md 在同一个块（同一标题之后）', memoryAt > titleAt && memoryAt > agentsAt, JSON.stringify({ titleAt, agentsAt, memoryAt }))
  check('合并后仍只有一个 `# agentsMd`', (merged.match(/# agentsMd/g) ?? []).length === 1, String((merged.match(/# agentsMd/g) ?? []).length))

  rmSync(join(ws, 'AGENTS.md'), { force: true })
  const only = systemPrompt()
  check('撤掉 AGENTS.md 后标题仍在、记忆仍在', only.includes('# agentsMd') && only.includes('全局事实记忆'), only.slice(0, 80))
}

// ── ④ 类型解析与注入呈现 ───────────────────────────────────────────────────────
console.log('\n[④] 类型 feedback / reference / 缺省 fact')
{
  await memoryTool.run({ target: 'global', action: 'add', type: 'feedback', content: '用户要求提交信息用中文。Why：团队约定。How to apply：commit message 一律中文。' }, runCtx())
  await memoryTool.run({ target: 'global', action: 'add', type: 'reference', content: '参考 docs/deploy.md 记录了部署口径，不是结论。' }, runCtx())
  const cell = memory.cells().find((item) => item.target === 'global')
  const types = cell.entries.map((entry) => core.entryType(entry))
  check('存储里三条类型解析正确（fact / feedback / reference 都在）', types.includes('feedback') && types.includes('reference') && types.includes('fact'), JSON.stringify(types))
  const text = systemPrompt()
  check('注入里把 feedback 条目的类型标记打在正文前', text.includes('[feedback] 用户要求提交信息用中文'), text.slice(0, 200))
  check('注入里把 reference 条目的类型标记打在正文前', text.includes('[reference] 参考 docs/deploy.md'), text.slice(0, 200))
  check('缺省类型不写前缀（事实保持老写法）', !text.includes('[fact]'))
}

// ── ⑤ 整理保守性：只移不删、未被引用的优先被移 ─────────────────────────────────
console.log('\n[⑤] prune 只移不删 + 未被引用优先被移')
{
  const before = memory.cells().find((item) => item.target === 'global')
  const keepEntry = '老格式条目甲'
  const keepKey = core.entryUsageKey('global', keepEntry)
  // 直接写台账：把「甲」标成被引用过（模拟隐式反馈命中）。
  writeFileSync(core.usageFile(), JSON.stringify({ [keepKey]: { count: 3, last: Date.now() } }), 'utf8')

  const message = memory.prune('global')
  const after = memory.cells().find((item) => item.target === 'global')
  const archive = core.archiveFileOf('global', ws)
  const archived = core.splitEntries(readCellFile(archive))

  check('被引用过的那条留下', after.entries.includes(keepEntry), JSON.stringify(after.entries))
  check('未被引用的都从格子里移走', after.entries.length === 1, JSON.stringify(after.entries))
  check('移走的条数 = 整理前条数 − 1', archived.length === before.entries.length - 1, JSON.stringify({ before: before.entries.length, archived: archived.length }))
  check('移走的是「只移不删」——归档文件里找得到它们', archived.length > 0 && !archived.includes(keepEntry), JSON.stringify(archived))
  check('归档文件与格子同目录（*.archive.md）', archive.endsWith('MEMORY.archive.md') && existsSync(archive), archive)
  check('整理回执给了人话', typeof message === 'string' && message.includes('整理完成'), message)
}

// ── ⑥ 抽取跳过规则：直写过 / 无 ≥3 词独立文本块 都不起复盘；满足条件才起 ──────────
console.log('\n[⑥] 复盘跳过规则（+ 正向对照）')
{
  const emitTurnEnd = (id, file) => kernel.emit('dsc/turn-end', 'completed', { sessionId: id, sessionPath: file })
  const reviewStarted = () => messagesText().includes('【记忆复盘】')

  // A. 本段已经直写过记忆 → 跳过
  await memoryTool.run({ target: 'global', action: 'add', content: '跳过规则探针-直写过' }, runCtx())
  emitTurnEnd(sessionId, sessionFile)
  check('A：本段直写过记忆时不发起复盘', !reviewStarted())

  // B. 没有 ≥3 词的独立用户文本块（「嗯」）→ 跳过
  await session.open(shortFile)
  emitTurnEnd(shortId, shortFile)
  check('B：短应答（无 ≥3 词文本块）时不发起复盘', !reviewStarted())

  // C. 正向对照：没直写过 + 有实质用户发言 → 复盘确实会起
  await session.open(sessionFile)
  emitTurnEnd(sessionId, sessionFile)
  check('C：条件满足时复盘会起（对照，证明 A/B 的「没起」有效）', reviewStarted(), messagesText().slice(-200))
}

console.log('')
if (failures === 0) {
  console.log('长期记忆对齐电池：全部通过')
  // ⑥ 的正向对照起了一轮复盘（假端点），后台可能还捏着文件句柄：清理尽力而为，
  // 删不掉就把临时 HOME 留在盘上（不影响结论）。
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    console.log(`（临时 HOME 未清掉，留在 ${home}，可手动删除）`)
  }
} else {
  console.log(`长期记忆对齐电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
