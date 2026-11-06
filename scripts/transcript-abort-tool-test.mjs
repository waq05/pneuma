/**
 * 被中断那一轮里「没有结果的工具」探针（2026-11-06 报障的缺陷三）。
 *
 * 报障现场：被中断的 bash 永远显示「进行中」。根因在 `adapter/transcript.ts`：`tool/call`
 * 一律写 status: 'running'，只有 `tool/result` 才把它改成终态；一轮以 aborted / error 收尾时
 * 那些没收到结果的调用就永远停在 running。`turn/end` 以前只清「准备中」队列，一条工具行都
 * 没碰；恢复旧会话时重放同一条日志，自然也是同一副样子。
 *
 * 修后的口径：同一条判据（settleUnfinishedTools）在两处落定——
 *   - 实时：`turn/end` 的 reason 不是 completed 时，把还挂着 running / preparing 的工具行
 *     落到中止态；
 *   - 恢复：`replayHistory` 结尾按「日志里有发起、没有结果 = 没跑完」落定；宿主随后经
 *     `seedTurnState` 送进来的真值再对一次——说还在跑就把那批放回执行中（日志里没有
 *     「这一轮为什么结束」这条记录，光看重放分不出「被中断」与「还在跑」）。
 *   正常结束（completed）的轮一个都不动。
 *
 * 为什么中止态落成 `aborted` 而不是 `failed`：用户按停止、这一轮被放弃，与「工具真的跑挂了」
 * 是两件事——后者要排查日志，前者不用管。契约的 ToolStatus（`src/contract/transcript.ts:21`）
 * 为此单列了 aborted；状态词走本包外侧的 ui-primitives 词表（已中断 / Stopped），配色走中性，
 * 不再是失败那档红字。
 *
 * 运行：node --import ./scripts/_i18n-alias.mjs scripts/transcript-abort-tool-test.mjs
 *
 * @module dsc/scripts/transcript-abort-tool-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { Transcript } = await import(new URL('../src/adapter/transcript.ts', import.meta.url).href)
const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(root + rel, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log('  ok  ' + name)
  } else {
    failures += 1
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  <- ' + detail))
  }
}

const toolEntry = (transcript, callId) =>
  transcript.entries.find((entry) => entry.kind === 'tool' && entry.call.callId === callId)

/** 造一轮：用户说话 → 模型调一次工具（babash）→ 轮到给定原因收尾。 */
const turnWithRunningTool = (reason) => {
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: '跑一下构建' })
  transcript.reduce({ type: 'turn/start' })
  transcript.reduce({ type: 'message', text: '先跑一轮构建。', reasoning: '先想一下。' })
  transcript.reduce({ type: 'tool/call', callId: 'call_bash', name: 'bash', args: '{"command":"pnpm build"}' })
  transcript.reduce({ type: 'turn/end', reason })
  return transcript
}

console.log('[1] 实时：turn/end reason = aborted，没结果的工具不再「进行中」')
{
  const transcript = turnWithRunningTool('aborted')
  const entry = toolEntry(transcript, 'call_bash')
  check('工具行还在（不是被删掉）', entry !== undefined)
  check('状态不再是 running', entry?.call.status !== 'running', String(entry?.call.status))
  check('落成中止态 aborted（不是 failed：中断不是工具的错）', entry?.call.status === 'aborted', String(entry?.call.status))
  check('工具名与参数原样保留', entry?.call.name === 'bash' && entry?.call.argsText === '{"command":"pnpm build"}')
  check('这一轮的中断标记照旧落成条目', transcript.entries.some((item) => item.kind === 'turn-end' && item.reason === 'aborted'))
  check('思考与正文不受影响', transcript.entries.filter((item) => item.kind === 'thinking').length === 1
    && transcript.entries.filter((item) => item.kind === 'text').length === 1)
}

console.log('[2] 实时：turn/end reason = error 同样落定（这一轮被放弃，不是工具的错）')
{
  const transcript = turnWithRunningTool('error')
  check('跑挂的轮里没结果的工具落成 aborted', toolEntry(transcript, 'call_bash')?.call.status === 'aborted')
}

console.log('[2b] 真失败与真完成不受影响')
{
  // 工具自己抛错（tool-error）：这才是 failed——要排查的那一档。
  const broken = new Transcript()
  broken.reduce({ type: 'user', text: '跑一下构建' })
  broken.reduce({ type: 'tool/call', callId: 'call_x', name: 'bash', args: '{"command":"pnpm build"}' })
  broken.reduce({ type: 'tool/result', callId: 'call_x', text: '命令超时（30000ms）', error: 'tool-error' })
  broken.reduce({ type: 'turn/end', reason: 'aborted' })
  check('工具自己抛错仍是 failed（不会被收尾改成 aborted）', toolEntry(broken, 'call_x')?.call.status === 'failed')
  check('结果正文原样留着', toolEntry(broken, 'call_x')?.call.resultText === '命令超时（30000ms）')
}

console.log('[3] 实时：正常结束（completed）的会话不受影响')
{
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: '读一眼' })
  transcript.reduce({ type: 'turn/start' })
  transcript.reduce({ type: 'message', text: '读一下。', reasoning: '' })
  transcript.reduce({ type: 'tool/call', callId: 'call_read', name: 'read', args: '{"path":"a.ts"}' })
  transcript.reduce({ type: 'tool/result', callId: 'call_read', text: '内容' })
  transcript.reduce({ type: 'turn/end', reason: 'completed' })
  check('有结果的工具仍是 done', toolEntry(transcript, 'call_read')?.call.status === 'done')
  check('结果正文原样留着', toolEntry(transcript, 'call_read')?.call.resultText === '内容')
  check('没有多出 turn-end 条目（正常结束不落条目）', !transcript.entries.some((item) => item.kind === 'turn-end'))

  // 被用户拒绝审批的工具：那是 rejected，不是「没跑完」，不许被一起改成 failed。
  const rejected = new Transcript()
  rejected.reduce({ type: 'user', text: '删掉它' })
  rejected.reduce({ type: 'tool/call', callId: 'call_rm', name: 'bash', args: '{}' })
  rejected.reduce({ type: 'tool/result', callId: 'call_rm', text: '用户拒绝了这次工具调用。', error: 'rejected' })
  rejected.reduce({ type: 'turn/end', reason: 'completed' })
  check('用户拒绝审批保持 rejected', toolEntry(rejected, 'call_rm')?.call.status === 'rejected')
}

console.log('[4] 恢复旧会话：重放只复原、由宿主的回合状态落定')
{
  const messages = [
    { role: 'user', content: '跑一下构建' },
    {
      role: 'assistant',
      content: '先跑一轮构建。',
      reasoning_content: '先想一下。',
      tool_calls: [{ id: 'call_bash', type: 'function', function: { name: 'bash', arguments: '{"command":"pnpm build"}' } }],
    },
  ]
  // 4.1 还在跑的那一轮：重放先按「没结果 = 没跑完」暂定中止，宿主说还在跑就放回执行中
  const live = new Transcript()
  live.replayHistory(messages)
  check('重放里没有结果的工具不再停在 running', toolEntry(live, 'call_bash')?.call.status !== 'running')
  live.seedTurnState(true)
  check('宿主说这一轮还在跑 ⇒ 放回 running（切回正在跑工具的会话不会被误杀）', toolEntry(live, 'call_bash')?.call.status === 'running')

  // 4.2 被中断后重开的会话：宿主说不在跑 ⇒ 同一条判据落定
  const restored = new Transcript()
  restored.replayHistory(messages)
  restored.seedTurnState(false)
  const entry = toolEntry(restored, 'call_bash')
  check('重开后不再是「进行中」', entry?.call.status !== 'running', String(entry?.call.status))
  check('重开后落成 aborted', entry?.call.status === 'aborted', String(entry?.call.status))
  check('重放出来的工具名与参数还在', entry?.call.name === 'bash' && entry?.call.argsText === '{"command":"pnpm build"}')

  // 4.3 正常结束的旧会话：结果配上了，seedTurnState(false) 不许动它
  const normal = new Transcript()
  normal.replayHistory([
    messages[0],
    messages[1],
    { role: 'tool', content: 'build ok', tool_call_id: 'call_bash' },
  ])
  check('正常结束的旧会话：工具是 done', toolEntry(normal, 'call_bash')?.call.status === 'done')
  normal.seedTurnState(false)
  check('恢复后仍是 done（没有被当成中止）', toolEntry(normal, 'call_bash')?.call.status === 'done')
}

console.log('[5] 一次收尾把「同一会话里所有挂着的」都落定，不受条数影响')
{
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: '并行跑两个' })
  transcript.reduce({ type: 'tool/call', callId: 'a', name: 'bash', args: '{}' })
  transcript.reduce({ type: 'tool/call', callId: 'b', name: 'read', args: '{}' })
  transcript.reduce({ type: 'tool/result', callId: 'a', text: 'ok' })
  transcript.reduce({ type: 'turn/end', reason: 'aborted' })
  check('有结果的那条保持 done', toolEntry(transcript, 'a')?.call.status === 'done')
  check('没结果的那条落成 aborted', toolEntry(transcript, 'b')?.call.status === 'aborted')
}

console.log('[6] 状态词与配色：中断不是错误')
{
  const zh = JSON.parse(read('src/packages/ui-primitives/locale/ui.zh.json'))
  const en = JSON.parse(read('src/packages/ui-primitives/locale/ui.en.json'))
  const summary = read('src/packages/ui-primitives/ui/tool-summary.ts')
  const styles = read('src/packages/ui-renderer/ui/styles/styles.css')
  const views = read('src/packages/ui-renderer/ui/styles/legacy/views.css')
  const contract = read('src/contract/transcript.ts')

  check('中文词条：aborted = 已中断', zh['primitives.tool.status.aborted'] === '已中断', String(zh['primitives.tool.status.aborted']))
  check('英文词条：aborted = Stopped', en['primitives.tool.status.aborted'] === 'Stopped', String(en['primitives.tool.status.aborted']))
  check('中断与失败仍是两个词条（失败 = 失败 / Failed）',
    zh['primitives.tool.status.failed'] === '失败' && en['primitives.tool.status.failed'] === 'Failed')
  check('词表把 aborted 接到这一条', /aborted: t\('primitives\.tool\.status\.aborted'\)/.test(summary))
  check('契约的 ToolStatus 含 aborted',
    /'preparing' \| 'running' \| 'done' \| 'failed' \| 'aborted' \| 'rejected'/.test(contract))
  check('状态点走中性色（不是失败那档红）',
    /\.tool-card\.status-aborted \.tool-dot \{\s*\n\s*background: var\(--dsc-text-tertiary\);/.test(styles))
  check('状态字走中性色（不是失败那档红）',
    /\.tool-card\.status-aborted \.tool-head \.status \{\s*\n\s*color: var\(--dsc-text-tertiary\);/.test(views))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
if (failures !== 0) process.exitCode = 1
