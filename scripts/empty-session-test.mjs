/**
 * 「新会话没发消息就不留文件、不进列表」探针（任务 A）。
 *
 * 事故形状：点一下「新会话」，权限与模型插件立刻往会话状态里补默认值，每条 state
 * 都经 write() 建出 jsonl——磁盘上多一个零消息文件，侧栏列表也跟着多一行；用户
 * 机器上已经攒了一堆这种垃圾行。
 *
 * 断言分五层：
 *   [1] 新建会话：id / 路径当场就有，磁盘上没有文件，列表里也没有它；
 *   [2] 第一条用户消息落地：meta → 攒下的 state → user 按序一次写出；
 *       权限、模型默认值确实进了文件，并能被重放恢复；
 *   [3] 零消息历史文件（只有 meta）不进列表；
 *   [4] 只有 meta + state 的文件也不进列表（存量垃圾行的清理口径）；
 *   [5] 有 user / 有 assistant 的文件照常出现；头行损坏但幸存 user 文本的文件
 *       仍按 T31 露脸（零消息过滤不能把它一起误伤）。
 *
 * 隔离：临时 HOME + 临时工作区，真实 ~/.dsc 一个字节都不动。
 * 运行：pnpm run build && node scripts/empty-session-test.mjs
 *
 * @module dsc/scripts/empty-session-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-empty-session-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}
const checkEq = (label, actual, expected) =>
  check(label, actual === expected, `实际 ${String(actual)} ≠ 期望 ${String(expected)}`)

const { createKernel } = await import('../lib/host/kernel.js')
const { Session, listSessions, sessionsRoot, slugCwd } = await import('../lib/core/session.js')

const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** 等到文件里真的出现某段文本（写流是异步的，existsSync 会先真后假）。 */
const waitForText = async (file, needle, timeout = 3000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes(needle)) return true
    await sleep(20)
  }
  return false
}
/** 一个目录下所有 jsonl（含子目录），验「磁盘上一个文件都没有」。 */
const jsonlFiles = (root) => {
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...jsonlFiles(path))
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}
const model = (id) => ({
  id,
  name: id,
  contextWindow: 100000,
  maxTokens: 500,
  modalities: ['text'],
  thinkingLevels: [],
  thinkingParam: 'thinking',
  effortMap: {},
})

const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'k',
        models: [model('m1'), model('m2')],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm1',
  },
  resumeSessionPath: null,
})
// 启动会话（宿主 cwd）也是新建会话：补默认值同样只该留在内存里
await ctx.session.open(undefined, ws)
const current = ctx.session.current()

console.log('\n[1] 新建会话：身份当场就有，文件与列表都不该出现')
{
  check('会话 id 在 create 时就生成', typeof current.meta.id === 'string' && current.meta.id.length > 0, String(current.meta.id))
  check('jsonl 路径也当场定下', current.filePath.endsWith(`${current.meta.id}.jsonl`), current.filePath)
  check('磁盘上没有这条会话的文件', !existsSync(current.filePath))
  check('整个会话根目录下没有任何 jsonl', jsonlFiles(sessionsRoot()).length === 0, jsonlFiles(sessionsRoot()).join(', '))
  check('列表里没有它', listSessions().every((item) => item.id !== current.meta.id))
  checkEq('列表是空的（启动会话也没落盘）', listSessions().length, 0)
  check('内存里已经拿到权限默认值（只是没写盘）', current.state('permissions')?.policy !== undefined, JSON.stringify(current.state('permissions')))
  checkEq('内存里已经拿到模型默认值', current.state('model')?.model, 'm1')
}

console.log('\n[2] 第一条用户消息落地：meta → 攒下的 state → user 按序写出')
{
  current.appendUser('第一句话')
  check('用户消息确实让它出现了', await waitForText(current.filePath, '"type":"user"'))
  const records = readFileSync(current.filePath, 'utf8').split(/\r?\n/).filter((line) => line !== '').map((line) => JSON.parse(line))
  checkEq('首行是 meta', records[0]?.type, 'meta')
  checkEq('末行是 user', records[records.length - 1]?.type, 'user')
  checkEq('用户消息只有一条', records.filter((record) => record.type === 'user').length, 1)
  const stateRecords = records.filter((record) => record.type === 'state')
  check('攒下的 state 不止一条（权限 + 模型）', stateRecords.length >= 2, String(stateRecords.length))
  check(
    'state 全在 user 之前（meta → state → user）',
    records.findIndex((record) => record.type === 'state') > 0 &&
      records.every((record, index) => record.type !== 'state' || index < records.length - 1),
  )
  // 每次钉权限只写真正变了的那几项，同一 id 可能有好几条：最后一条才生效
  const permissions = records.filter((record) => record.type === 'state' && record.id === 'permissions').at(-1)
  check('权限默认值进了文件', permissions !== undefined, JSON.stringify(stateRecords.map((record) => record.id)))
  check(
    '权限模式与审阅者都有值（沙箱按需在首次读取时钉，这里不强求）',
    permissions !== undefined &&
      typeof permissions.payload.policy === 'string' &&
      typeof permissions.payload.reviewer === 'string',
    JSON.stringify(permissions?.payload),
  )
  const modelState = records.find((record) => record.type === 'state' && record.id === 'model')
  check('模型默认值进了文件', modelState !== undefined, JSON.stringify(stateRecords.map((record) => record.id)))
  checkEq('文件里的模型就是配置默认 m1', modelState?.payload?.model, 'm1')
  // 重放：state 与首条消息都要恢复得回来（lease: false 只读，不跟当前会话抢写租约）
  const restored = Session.load(current.filePath, true, { lease: false })
  checkEq('重放后模型状态还是 m1', restored.state('model')?.model, 'm1')
  check('重放后权限状态还在', restored.state('permissions')?.policy !== undefined, JSON.stringify(restored.state('permissions')))
  checkEq('重放后首条消息还在', restored.messages.length, 1)
}

console.log('\n[2b] 记账缓冲严格保序：多次 state 按产生顺序排在 user 之前')
{
  const path = join(home, 'order', 'order.jsonl')
  const session = Session.create(ws, path)
  session.appendState('model', { provider: 'test', model: 'm1', effort: 'default' })
  session.appendState('permissions', { sandbox: 'workspace-write', policy: 'on-request', reviewer: 'user' })
  session.appendState('model', { provider: 'test', model: 'm1', effort: 'high' })
  check('攒着的时候磁盘上还是没有文件', !existsSync(path))
  session.appendUser('按序落盘')
  check('首条用户消息把它一次写出来', await waitForText(path, '"type":"user"'))
  const records = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => line !== '').map((line) => JSON.parse(line))
  checkEq('记录条数 = meta + 3 条 state + user', records.length, 5)
  checkEq('顺序 1：meta', records[0]?.type, 'meta')
  check('顺序 2-4：state 保持产生顺序', records.slice(1, 4).every((record, index) => record.type === 'state' && record.id === ['model', 'permissions', 'model'][index]))
  checkEq('顺序 5：user 最后', records[4]?.type, 'user')
  checkEq('同名 state 后者生效（重放读到 high）', Session.load(path, true, { lease: false }).state('model')?.effort, 'high')
}

console.log('\n[2c] 发消息前选过的权限与模型：不建文件，但首条消息落地时一并写进日志')
{
  const ws2 = join(home, 'ws-2')
  mkdirSync(ws2, { recursive: true })
  await ctx.session.open(undefined, ws2)
  const picked = ctx.session.current()
  ctx.permissionPresets.use('read-only')
  ctx.llm.setModel('test', 'm2')
  check('选完权限与模型后磁盘上仍然没有文件', !existsSync(picked.filePath))
  checkEq('内存里权限已是只读', picked.state('permissions')?.sandbox, 'read-only')
  checkEq('内存里模型已是 m2', picked.state('model')?.model, 'm2')
  picked.appendUser('选完再发')
  check('首条消息让文件出现', await waitForText(picked.filePath, '"type":"user"'))
  const records = readFileSync(picked.filePath, 'utf8').split(/\r?\n/).filter((line) => line !== '').map((line) => JSON.parse(line))
  const lastPermissions = records.filter((record) => record.type === 'state' && record.id === 'permissions').at(-1)
  const lastModel = records.filter((record) => record.type === 'state' && record.id === 'model').at(-1)
  checkEq('选过的权限（只读）进了日志', lastPermissions?.payload?.sandbox, 'read-only')
  checkEq('选过的模型（m2）进了日志', lastModel?.payload?.model, 'm2')
  check('user 仍然排在所有 state 之后', records[records.length - 1]?.type === 'user')
  const restored = Session.load(picked.filePath, true, { lease: false })
  checkEq('重放恢复选过的权限', restored.state('permissions')?.sandbox, 'read-only')
  checkEq('重放恢复选过的模型', restored.state('model')?.model, 'm2')
}

console.log('\n[3] 零消息历史文件（只有 meta）不进列表')
{
  const dir = join(sessionsRoot(), slugCwd(ws))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, '00000000-0000-0000-0000-000000000001.jsonl')
  writeFileSync(path, `${JSON.stringify({ type: 'meta', id: '00000000-0000-0000-0000-000000000001', cwd: ws, createdAt: 1 })}\n`, 'utf8')
  const listed = listSessions()
  check('只有 meta 的文件不在列表里', listed.every((item) => item.path !== path))
}

console.log('\n[4] 只有 meta + state 的文件也不进列表（存量垃圾行）')
{
  const dir = join(sessionsRoot(), slugCwd(ws))
  const id = '00000000-0000-0000-0000-000000000002'
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'meta', id, cwd: ws, createdAt: 1 })}\n` +
      `${JSON.stringify({ type: 'state', id: 'model', payload: { provider: 'test', model: 'm1', effort: 'default' } })}\n`,
    'utf8',
  )
  check('只有 meta + state 的文件不在列表里', listSessions().every((item) => item.path !== path))
}

console.log('\n[5] 真说过话的文件照常出现（含 T31 头行损坏）')
{
  const dir = join(sessionsRoot(), slugCwd(ws))
  const userId = '00000000-0000-0000-0000-000000000003'
  const userPath = join(dir, `${userId}.jsonl`)
  writeFileSync(
    userPath,
    `${JSON.stringify({ type: 'meta', id: userId, cwd: ws, createdAt: 1 })}\n` +
      `${JSON.stringify({ type: 'user', text: '有用户消息的会话' })}\n`,
    'utf8',
  )
  const userItem = listSessions().find((item) => item.path === userPath)
  check('有 user 记录的文件出现在列表里', userItem !== undefined)
  checkEq('标题取首条用户消息', userItem?.title, '有用户消息的会话')

  const assistantId = '00000000-0000-0000-0000-000000000004'
  const assistantPath = join(dir, `${assistantId}.jsonl`)
  writeFileSync(
    assistantPath,
    `${JSON.stringify({ type: 'meta', id: assistantId, cwd: ws, createdAt: 1 })}\n` +
      `${JSON.stringify({ type: 'assistant', text: '先说话的是助手', reasoning: '' })}\n`,
    'utf8',
  )
  check('有 assistant 记录的文件也出现在列表里', listSessions().some((item) => item.path === assistantPath))

  // T31：首行 meta 坏了，但幸存一条 user —— 仍然要露脸，标题从 user 里救
  const brokenId = '00000000-0000-0000-0000-000000000005'
  const brokenPath = join(dir, `${brokenId}.jsonl`)
  writeFileSync(
    brokenPath,
    `{"type":"meta",\n` + `${JSON.stringify({ type: 'user', text: '头坏了也要露脸' })}\n`,
    'utf8',
  )
  const brokenItem = listSessions().find((item) => item.path === brokenPath)
  check('头行损坏但有 user 文本的文件仍出现在列表里（T31）', brokenItem !== undefined)
  checkEq('损坏文件按文件名当 id', brokenItem?.id, brokenId)
  checkEq('损坏文件的标题从幸存 user 里救', brokenItem?.title, '头坏了也要露脸')

  // 同一口径的另一面：头坏、只剩 state 的文件没有对话，依旧不进列表
  const brokenStateId = '00000000-0000-0000-0000-000000000006'
  const brokenStatePath = join(dir, `${brokenStateId}.jsonl`)
  writeFileSync(
    brokenStatePath,
    `{"type":"meta",\n` +
      `${JSON.stringify({ type: 'state', id: 'model', payload: { provider: 'test', model: 'm1' } })}\n`,
    'utf8',
  )
  check('头坏且只有 state 的文件不进列表', listSessions().every((item) => item.path !== brokenStatePath))
}

console.log('\n[6] 说过话之后，一次 dsc/changed 就把它补进列表快照')
{
  // 新会话不再补虚拟行，于是「文件刚出现」与「列表下一次重扫」之间有一段空窗；
  // 宿主在 dsc/changed 里看到「当前会话的文件在了、缓存里却没有」时自己补刷一次。
  ctx.emit('dsc/changed')
  await sleep(120)
  const seen = ctx.transcript.getSnapshot().sessions.filter((item) => item.id === current.filePath)
  check('说过话的会话在列表快照里', seen.length === 1, String(seen.length))
  // 补刷的闸门只认「同一条路径一次」：重复广播既不该补成两条，也不该来回刷。
  ctx.emit('dsc/changed')
  await sleep(60)
  const again = ctx.transcript.getSnapshot().sessions.filter((item) => item.id === current.filePath)
  check('再广播一次也不会补成两条', again.length === 1, String(again.length))
}

console.log('')
console.log(failures === 0 ? '新会话不落盘 / 零消息不进列表：全部通过' : `${String(failures)} 项失败`)
process.exit(failures === 0 ? 0 : 1)
