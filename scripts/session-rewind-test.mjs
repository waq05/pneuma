/**
 * 「编辑并重发 = 在当前会话里截断重来」的宿主侧探针（真内核，临时 HOME）。
 *
 * 钉的口径（2026-11-03 用户报障「重新编辑不要切新会话，还在当前会话」）：
 *   ① 作废第 keep 条用户消息及其之后的回答，保留它之前的内容；
 *   ② 日志仍是 append-only：原文一条不少，只多一条 `rewind` 记录；
 *   ③ 重新从磁盘读回来（重放）得到与内存一致的截断结果——这是「重启之后还是这个样子」的保证；
 *   ④ 序号越界时如实返回失败，一个字节都不动（绝不静默截错地方）；
 *   ⑤ 截断之后写进去的新消息落在正确位置（= 第 keep 条的位置上）；
 *   ⑥ 不是当前会话时拒绝：别的会话没有常驻 agent 承接截断后的历史。
 *
 * 隔离：临时 HOME + 临时工作区，真实 ~/.dsc 不碰。
 * 运行：node scripts/session-rewind-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/session-rewind-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-rewind-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dsc = join(home, '.dsc')
mkdirSync(dsc, { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

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

const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })

const { Session, forkSession, readUserMessages, slugCwd, sessionsRoot } = await import('../lib/core/session.js')
const { createKernel } = await import('../lib/host/kernel.js')

// ── 种子：三轮人打的提问 + 各自的回答，中间夹一条机器投递的通知（不该被算作一轮）──
const seedDir = join(sessionsRoot(), slugCwd(ws))
mkdirSync(seedDir, { recursive: true })
const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const seedFile = join(seedDir, `${id}.jsonl`)
const seedLines = [
  { type: 'meta', id, cwd: ws, createdAt: 1 },
  { type: 'user', text: '第一问', ts: 10 },
  { type: 'assistant', text: '第一答', reasoning: '', ts: 11 },
  { type: 'user', text: '机器通知', origin: 'notice', ts: 12 },
  { type: 'assistant', text: '通知后的答', reasoning: '', ts: 13 },
  { type: 'user', text: '第二问', ts: 14 },
  { type: 'assistant', text: '第二答', reasoning: '', ts: 15 },
  { type: 'user', text: '第三问', ts: 16 },
  { type: 'assistant', text: '第三答', reasoning: '', ts: 17 },
]
writeFileSync(seedFile, `${seedLines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')

const kernel = await createKernel({ config: {}, resumeSessionPath: seedFile })
const runtime = kernel.get('ui')
const service = kernel.get('session')
const before = readFileSync(seedFile, 'utf8')

/** 日志是异步流写的：等一拍再读盘（真实使用里界面也是下一帧才看到）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 80))

console.log('\n[1] 起点：三轮提问都在会话里')
{
  const texts = service.current().messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
  checkEq('消息 8 条', texts.length, 8)
  checkEq('最后一条回答', texts.at(-1), '第三答')
}

console.log('\n[2] 作废第 2 条及之后（keep = 1）：只留第一轮')
{
  const result = service.rewind(seedFile, 1)
  checkEq('返回成功', result.ok, true)
  await flush()
  const current = service.current()
  const texts = current.messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
  checkEq('内存里还剩几条消息（第一轮：问 + 答 + 通知 + 答）', current.messages.length, 4)
  check('第一条是第一问', texts[0] === '第一问', texts.join(' / '))
  check('机器投递的通知还在（它在第一轮里）', texts.includes('机器通知'), texts.join(' / '))
  check('第二问没了', !texts.includes('第二问'), texts.join(' / '))
  check('第三答没了', !texts.includes('第三答'), texts.join(' / '))
}

console.log('\n[3] 日志 append-only：原文一条不少，只多一条 rewind')
{
  const after = readFileSync(seedFile, 'utf8')
  check('原文件内容是新文件的前缀（没有删改历史）', after.startsWith(before))
  const added = after.slice(before.length).trim().split('\n').filter((line) => line !== '')
  check('确实追加了记录', added.length >= 1, String(added.length))
  // 追加的可能是几条记账（启动时补的 state），但**最后一条必须是 rewind**
  const record = JSON.parse(added.at(-1) ?? '{}')
  checkEq('最后一条是 rewind', record.type, 'rewind')
  checkEq('rewind.keep', record.keep, 1)
}

console.log('\n[4] 重新从磁盘读回来（重放）与内存一致')
{
  const reloaded = Session.load(seedFile, true, { lease: false })
  const texts = reloaded.messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
  checkEq('重放后消息条数', reloaded.messages.length, 4)
  check('重放结果同样没有第二问', !texts.includes('第二问'), texts.join(' / '))
  check('重放结果同样保留机器通知', texts.includes('机器通知'), texts.join(' / '))
  reloaded.close()
}

console.log('\n[5] 截断之后写进去的新消息落在原位置')
{
  service.current().appendUser('改过的第二问')
  await flush()
  const reloaded = Session.load(seedFile, true, { lease: false })
  const texts = reloaded.messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
  checkEq('消息条数 = 4 + 1', reloaded.messages.length, 5)
  checkEq('新消息排在截断点上', texts[4], '改过的第二问')
  reloaded.close()
  // 复位：把第 5 节写进去的那条也作废，回到 4 条，后面的用例好算账
  service.rewind(seedFile, 1)
  await flush()
}

console.log('\n[6] 序号越界：如实失败，一个字节都不动')
{
  const beforeLines = readFileSync(seedFile, 'utf8')
  const result = service.rewind(seedFile, 9)
  checkEq('返回失败', result.ok, false)
  check('给了原因', typeof result.error === 'string' && result.error !== '')
  checkEq('日志没有被写', readFileSync(seedFile, 'utf8'), beforeLines)
}

console.log('\n[7] 不是当前会话：拒绝（别的会话没有常驻 agent 承接）')
{
  const other = join(seedDir, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff.jsonl')
  writeFileSync(
    other,
    `${JSON.stringify({ type: 'meta', id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', cwd: ws, createdAt: 2 })}\n` +
      `${JSON.stringify({ type: 'user', text: '别的会话' })}\n`,
    'utf8',
  )
  const result = service.rewind(other, 0)
  checkEq('返回失败', result.ok, false)
  check('原因说清了是当前会话', String(result.error ?? '').includes('当前会话'), String(result.error))
}

console.log('\n[9] 队友汇报不算「人打的一轮」：它跟着前一问一起留下')
{
  // 判据要与界面同一个口径：`internal` 那三类（机器通知 / 队友汇报 / 审查结论）都不开一轮。
  // 老写法只跳过 origin: notice，会把 <teammate-report> 当成人打的第二问——编辑第二问时
  // 就从汇报那里截断，汇报（模型还要看的上下文）会被一起作废。
  const file = join(seedDir, 'cccccccc-dddd-eeee-ffff-000000000000.jsonl')
  writeFileSync(
    file,
    [
      { type: 'meta', id: 'cccccccc-dddd-eeee-ffff-000000000000', cwd: ws, createdAt: 3 },
      { type: 'user', text: '第一问', ts: 21 },
      { type: 'assistant', text: '第一答', reasoning: '', ts: 22 },
      { type: 'user', text: '<teammate-report name="小明">做完了</teammate-report>', ts: 23 },
      { type: 'assistant', text: '收到汇报', reasoning: '', ts: 24 },
      { type: 'user', text: '第二问', ts: 25 },
      { type: 'assistant', text: '第二答', reasoning: '', ts: 26 },
    ]
      .map((line) => JSON.stringify(line))
      .join(String.fromCharCode(10)) + String.fromCharCode(10),
    'utf8',
  )
  const temp = Session.load(file)
  checkEq('内存里作废第二问成功', temp.rewindToUser(1), true)
  const kept = temp.messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
  check('汇报留下来了', kept.some((text) => text.startsWith('<teammate-report')), kept.join(' / '))
  check('第二问没了', !kept.includes('第二问'), kept.join(' / '))
  temp.close()
  await flush()
  const reloaded = Session.load(file, true, { lease: false })
  const replay = reloaded.messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
  check('重放同样保留汇报', replay.some((text) => text.startsWith('<teammate-report')), replay.join(' / '))
  check('重放同样没有第二问', !replay.includes('第二问'), replay.join(' / '))
  reloaded.close()
}

console.log('\n[10] 作废之后，分叉菜单与分叉结果都认这条 rewind')
{
  // 审查抓到：rewind 只改了内存与重放，`readUserMessages` / `forkSession` 仍是逐行扫原文，
  // 于是分叉菜单里还列着被作废的消息，从那儿分叉出来的新会话还会把 rewind 记录一起带过去、
  // 重放时把自己截空。
  const listed = readUserMessages(seedFile)
  check('分叉菜单里没有第二问', !listed.some((text) => text.includes('第二问')), listed.join(' / '))
  check('分叉菜单里第一问还在', listed.some((text) => text.includes('第一问')), listed.join(' / '))

  const forked = forkSession(seedFile, 1)
  const forkedText = readFileSync(forked, 'utf8')
  check('分叉结果里没有 rewind 记录', !forkedText.includes('"type":"rewind"'))
  const replayFork = Session.load(forked, true, { lease: false })
  const texts = replayFork.messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
  replayFork.close()
  check('分叉出来的会话不是空的', texts.length > 0, JSON.stringify(texts))
  check('分叉出来的会话里也没有第二问', !texts.includes('第二问'), texts.join(' / '))
}

console.log('\n[11] 压缩过的会话：界面数的轮数与宿主截的位置对得上')
{
  // 压缩之后宿主的内存消息是「摘要 + 尾巴」，而摘要在日志里就是一条 role:'user' 的记录；
  // 界面重放同样把它画成一条 user 条目。两边都把它当「人打的第一条」，截断位置才对得上——
  // 这条用例把那个口径钉死（审查怀疑过这里是错的，实测一致）。
  const file = join(seedDir, 'dddddddd-eeee-ffff-0000-111111111111.jsonl')
  writeFileSync(
    file,
    [
      { type: 'meta', id: 'dddddddd-eeee-ffff-0000-111111111111', cwd: ws, createdAt: 4 },
      { type: 'user', text: 'Q1', ts: 31 },
      { type: 'assistant', text: 'A1', reasoning: '', ts: 32 },
      { type: 'summary', text: '【历史已压缩】前面聊过 Q1', keep: 0, ts: 33 },
      { type: 'user', text: 'Q3', ts: 34 },
      { type: 'assistant', text: 'A3', reasoning: '', ts: 35 },
      { type: 'user', text: 'Q4', ts: 36 },
      { type: 'assistant', text: 'A4', reasoning: '', ts: 37 },
    ]
      .map((line) => JSON.stringify(line))
      .join(String.fromCharCode(10)) + String.fromCharCode(10),
    'utf8',
  )
  const temp = Session.load(file)
  const { Transcript } = await import('../lib/adapter/transcript.js')
  const transcript = new Transcript()
  transcript.replayHistory(temp.messages, temp.toolErrors, temp.fileChanges, temp.presentations)
  const target = transcript.entries.findIndex((entry) => entry.kind === 'user' && entry.text === 'Q4')
  const uiKeep = transcript.entries
    .slice(0, target)
    .filter((entry) => entry.kind === 'user' && entry.internal !== true).length
  check('界面在 Q4 之前数到 2 条（摘要 + Q3）', uiKeep === 2, String(uiKeep))
  checkEq('宿主按同一个数截断成功', temp.rewindToUser(uiKeep), true)
  const kept = temp.messages.map((message) => (typeof message.content === 'string' ? message.content : ''))
  check('Q3 还在（截在它之后）', kept.includes('Q3'), kept.join(' / '))
  check('Q4 被作废', !kept.includes('Q4'), kept.join(' / '))
  check('压缩摘要还在（没被顺手删掉）', kept.some((text) => text.startsWith('【历史已压缩】')), kept.join(' / '))
  temp.close()
}

console.log('\n[8] 界面通道认这条方法（白名单 + 参数校验都通）')
{
  const { UI_METHODS, UI_ARG_SPECS, validateUiArgs } = await import('../lib/core/ui-methods.js')
  check('在界面通道白名单里', UI_METHODS.includes('rewindSession'))
  check('有参数校验规则', Array.isArray(UI_ARG_SPECS['rewindSession']))
  checkEq('两个参数都合法时放行', validateUiArgs('rewindSession', [seedFile, 1]).ok, true)
  checkEq('keep 不是数字时拒掉', validateUiArgs('rewindSession', [seedFile, 'x']).ok, false)
  checkEq('少了参数时拒掉', validateUiArgs('rewindSession', [seedFile]).ok, false)
}

await kernel.dispose?.()
console.log(failures === 0 ? '\nPASS 编辑重发（当前会话截断重来）十一条口径全过' : `\nFAIL ${failures} 条`)
process.exit(failures === 0 ? 0 : 1)
