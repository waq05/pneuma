/**
 * 「刷新会话后 dsh 的卡片还在」的重放链路（迁自 `scripts/ui-dsh-card-replay-test.mjs`）。
 *
 * 数据链路三段：落盘（`core/loop.ts` 把 `presentation` 写进会话日志的 tool 记录）→
 * 读回（`core/session.ts` 的 load 把它放进 `session.presentations`）→ 重放
 * （`adapter/transcript.ts` 的 replayHistory 折成 tool/presentation、按 callId 缝回工具卡）。
 * 原探针直接造一份最小会话日志走 2、3 两段——卡片的持久化形状与恢复路径都在这两段里；
 * 第 1 段（真回合写盘）由 `dsh-compat-check` 与真机截图覆盖，本文件同样不追。
 *
 * 为什么是 integration 而不是 unit：`Session.load` 经 `@pneuma/runtime` 别名解析到 src，
 * 但它的落盘路径由 `DSC_HOME`（HOME 派生）在模块加载时算定——integration 的
 * `tests/setup/temp-home.ts` 恰好做这件事，隔离免费且与其它集成用例同一口径。
 *
 * 隔离：临时 HOME（setup 自动），真实 `~/.dsc` 一个字节都不动。
 *
 * @module dsc/tests/integration/ui-dsh-card-replay
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Session, sessionsRoot, slugCwd } from '@pneuma/runtime/core/session.js'
import { Transcript } from '@pneuma/runtime/adapter/transcript.js'

const cwd = join(mkdtempSync(join(tmpdir(), 'dsc-card-replay-')), 'work')
mkdirSync(cwd, { recursive: true })

/** 探针原样的卡片数据：call / result / meta 三段。 */
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
function writeLog(name: string, withPresentation: boolean): string {
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

/** 走真实恢复路径：读日志 → 折 transcript，找出 call_1 那张工具卡。 */
function replay(file: string): { card: { call?: { presentation?: typeof presentation } } | undefined } {
  const session = Session.load(file, true, { lease: false })
  const transcript = new Transcript()
  transcript.replayHistory(session.messages, session.toolErrors, session.fileChanges, session.presentations)
  const card = transcript.entries.find(
    (entry): entry is Extract<typeof entry, { kind: 'tool' }> => entry.kind === 'tool' && entry.call.callId === 'call_1',
  )
  return { card: card as unknown as { call?: { presentation?: typeof presentation } } | undefined }
}

describe('重开会话：卡片数据从日志里回到工具卡上', () => {
  test('日志里的 presentation 被 session 读回（按 callId 索引）', () => {
    const file = writeLog('with-card.jsonl', true)
    const session = Session.load(file, true, { lease: false })
    expect(session.presentations.get('call_1')?.result?.card).toBe('diff')
  })

  test('工具卡找到了，result / call / meta 三个视图原样回到卡上', () => {
    const file = writeLog('with-card.jsonl', true)
    const first = replay(file)
    const view = first.card?.call?.presentation
    expect(first.card).toBeDefined()
    expect(view?.result?.card).toBe('diff')
    expect(view?.call?.title).toBe('写笔记')
    expect((view?.meta as { kind?: string } | undefined)?.kind).toBe('dsh-note')
    const diffs = (view?.result as { diffs?: Array<{ newText?: string }> } | undefined)?.diffs
    expect(diffs?.[0]?.newText).toBe('新内容\n')
  })

  test('同一份日志再读一次，卡片完全一致（没有内存态依赖）', () => {
    const file = writeLog('with-card.jsonl', true)
    const first = replay(file)
    const again = replay(file)
    expect(JSON.stringify(again.card?.call?.presentation)).toBe(JSON.stringify(first.card?.call?.presentation))
  })
})

describe('反向对照：日志里没有卡片数据时，工具卡也不该凭空长出来', () => {
  test('没有卡片数据就没有读回条目；工具卡照样在，只是没有 presentation', () => {
    const file = writeLog('no-card.jsonl', false)
    const session = Session.load(file, true, { lease: false })
    expect(session.presentations.size).toBe(0)
    const { card } = replay(file)
    expect(card).toBeDefined()
    expect(card?.call?.presentation).toBeUndefined()
  })
})
