/**
 * 「刷新会话后 dsh 的卡片还在」的自动化断言。
 *
 * 这条以前只有代码路径与真机截图，没有测试。数据链路三段：
 *   1. 落盘：`core/loop.ts` 的工具结果把 `presentation` 写进会话日志的 tool 记录；
 *   2. 读回：`core/session.ts` 的 buildFromLog 把它放进 `session.presentations`；
 *   3. 重放：`adapter/transcript.ts` 的 replayHistory 折成 `tool/presentation`，按 callId 缝回工具卡。
 *
 * 本脚本直接造一份最小会话日志走 2、3 两段——卡片的持久化形状与恢复路径都在这两段里；
 * 第 1 段（真回合写盘）由 `dsh-compat-check` 与真机截图覆盖。
 *
 * 隔离：临时 HOME，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/ui-dsh-card-replay-test.mjs
 *
 * @module dsc/scripts/ui-dsh-card-replay-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-card-replay-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })

const { Session, sessionsRoot, slugCwd } = await import('../lib/core/session.js')
const { Transcript } = await import('../lib/adapter/transcript.js')

let failures = 0
const check = (label, ok, extra = '') => {
  if (ok) {
    console.log(`  PASS ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${extra === '' ? '' : ` — ${extra}`}`)
}

const cwd = join(home, 'work')
mkdirSync(cwd, { recursive: true })

const presentation = {
  call: { card: 'generic', title: '写笔记' },
  result: {
    card: 'diff',
    title: '笔记变更',
    diffs: [{ path: 'note.txt', oldText: '旧内容\n', newText: '新内容\n' }],
  },
  meta: { kind: 'dsh-note' },
}

/** 造一份会话日志；withPresentation 决定 tool 记录带不带卡片数据（反向对照用）。 */
function writeLog(name, withPresentation) {
  const file = join(sessionsRoot(), slugCwd(cwd), name)
  const records = [
    { type: 'meta', id: `card-${name}`, cwd, createdAt: 1730000000000 },
    { type: 'user', text: '把笔记改一下', ts: 1730000001000 },
    {
      type: 'assistant',
      text: '',
      reasoning: '',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'dsh_write_note', arguments: '{"path":"note.txt"}' } }],
      ts: 1730000002000,
    },
    {
      type: 'tool',
      callId: 'call_1',
      name: 'dsh_write_note',
      text: '已写入',
      ...(withPresentation ? { presentation } : {}),
      ts: 1730000003000,
    },
  ]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
  return file
}

/** 走真实恢复路径：读日志 → 折 transcript。 */
function replay(file) {
  const session = Session.load(file, true, { lease: false })
  const transcript = new Transcript()
  transcript.replayHistory(session.messages, session.toolErrors, session.fileChanges, session.presentations)
  const card = transcript.entries.find((entry) => entry.kind === 'tool' && entry.call.callId === 'call_1')
  return { session, transcript, card }
}

console.log('重开会话：卡片数据从日志里回到工具卡上')
{
  const file = writeLog('with-card.jsonl', true)
  const first = replay(file)
  check('日志里的 presentation 被 session 读回', first.session.presentations?.get('call_1')?.result?.card === 'diff', JSON.stringify([...first.session.presentations.entries()]))
  check('工具卡找到了', first.card !== undefined, JSON.stringify(first.transcript.entries.map((e) => e.kind)))
  check('卡片的 result 视图原样回到工具卡', first.card?.call?.presentation?.result?.card === 'diff', JSON.stringify(first.card?.call?.presentation))
  check('卡片的 call 视图也回来了', first.card?.call?.presentation?.call?.title === '写笔记', JSON.stringify(first.card?.call?.presentation))
  check('presentationMeta 也回来了（可重放的那份数据）', first.card?.call?.presentation?.meta?.kind === 'dsh-note', JSON.stringify(first.card?.call?.presentation?.meta))
  check('diff 内容是「改前全文 + 改后全文」', first.card?.call?.presentation?.result?.diffs?.[0]?.newText === '新内容\n', JSON.stringify(first.card?.call?.presentation?.result?.diffs))

  // 再读一遍：刷新第二次不该有任何差别（没有内存态依赖）。
  const again = replay(file)
  check('同一份日志再读一次，卡片完全一致', JSON.stringify(again.card?.call?.presentation) === JSON.stringify(first.card?.call?.presentation), JSON.stringify(again.card?.call?.presentation))
}

console.log('反向对照：日志里没有卡片数据时，工具卡也不该凭空长出来')
{
  const file = writeLog('no-card.jsonl', false)
  const { session, card } = replay(file)
  check('没有卡片数据就没有读回条目', session.presentations.size === 0, String(session.presentations.size))
  check('工具卡照样在，只是没有 presentation', card !== undefined && card.call.presentation === undefined, JSON.stringify(card?.call))
}

console.log(`\n${failures === 0 ? 9 : 9 - failures} PASS / ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
