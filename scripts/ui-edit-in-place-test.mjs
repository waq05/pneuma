/**
 * 「编辑并重发」改成**留在当前会话**之后的静态探针（2026-11-03 报障）。
 *
 * 报障原话：「重新编辑不要切新会话，还在当前会话」——旧实现是按这条消息分叉出一条新
 * 会话再重发，用户想改的是手头这条，结果人被搬到另一条会话里去了。
 *
 * 钉住五件事（少一条就不是这个行为）：
 *   [1] 内核有截断的记录类型与实现（`rewind` 记录 + `rewindToUser`）；
 *   [2] 重放认得这条记录（否则重启之后被作废的历史又回来了）；
 *   [3] 界面走的是 `rewindSession`，不再调 `forkSession` / `openSession` 换会话；
 *   [4] 宿主只对**当前会话**执行（别的会话没有常驻 agent 承接截断后的历史）；
 *   [5] 文案说实话：不再写「分叉出新会话」，改成「这条之后的回答会作废」。
 *
 * 每条判据都配一条“弄脏副本必须红”，红不了就是空转。
 *
 * 跑法：node scripts/ui-edit-in-place-test.mjs
 *
 * @module dsc/scripts/ui-edit-in-place-test
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
    failures += 1
  }
}
const read = (part) => readFileSync(join(root, part), 'utf8')
const dirty = (hay, from, to) => hay.split(from).join(to)

const core = read('src/core/session.ts')
const host = read('src/plugins/session.ts')
const runtime = read('src/plugins/runtime.ts')
const flow = read('ui-shell/src/plugins/transcript/ui.tsx')
const row = read('ui-shell/src/plugins/transcript/rows/user-row.tsx')
const shared = read('ui-shell/src/plugins/transcript/shared.ts')

// ── [1] 内核：记录类型 + 截断实现 ────────────────────────────────────────────────
const recordType = (s) => s.includes("type: 'rewind'")
const impl = (s) => s.includes('rewindToUser(keep: number): boolean') && s.includes('function cutIndexBeforeUser(')
check('[1] 日志有 rewind 记录类型', recordType(core))
check('[1] 有截断实现（按人打的用户消息数）', impl(core))
check('[1] 记录类型判据对脏副本必须红', !recordType(dirty(core, "type: 'rewind'", "type: 'rewindX'")))
check('[1] 实现判据对脏副本必须红', !impl(dirty(core, 'function cutIndexBeforeUser(', 'function cutIndexBeforeUserGone(')))

// ── [2] 重放认得它 ──────────────────────────────────────────────────────────────
const replay = (s) => s.includes("case 'rewind':")
check('[2] load 的 switch 里有 rewind 分支', replay(core))
check('[2] 重放判据对脏副本必须红', !replay(dirty(core, "case 'rewind':", "case 'rewindX':")))

// ── [3] 界面走 rewindSession，不再换会话 ────────────────────────────────────────
// 「分叉」这个动作本身还在（右键菜单的「从这里分叉」），所以只看编辑重发那一段
const editStart = flow.indexOf('const editAndResend')
const editEnd = flow.indexOf('const actions: FlowActions', editStart)
const editBody = editStart >= 0 && editEnd > editStart ? flow.slice(editStart, editEnd) : ''
const usesRewind = (s) => s.includes("invoke<{ ok: boolean; error?: string }>('rewindSession'")
const noFork = (s) => s !== '' && !s.includes("'forkSession'") && !s.includes("'openSession'")
const renamed = (s) => s.includes('editAndResend')
check('[3] 编辑重发调 rewindSession', usesRewind(editBody))
check('[3] 编辑重发不再分叉、不再换会话', noFork(editBody))
check('[3] 动作名已从 editRefork 改成 editAndResend', renamed(shared) && renamed(row) && renamed(flow))
check('[3] rewind 判据对脏副本必须红', !usesRewind(dirty(editBody, "'rewindSession'", "'forkSession'")))
// 「保留几轮」必须按**人打的用户消息**数，不能按 rounds 数：rounds.ts 的规则 3 让内部汇报
// 也占一枚刻度，那种会话里会多算，宿主就会截到更早的位置。
const keepByEntries = (s) => s.includes("item.kind === 'user' && item.internal !== true") && !s.includes('rounds.filter((round) => round.startIndex < at)')
check('[3] 保留轮数按人打的用户消息数（不按 rounds）', keepByEntries(editBody))
check('[3] 轮数判据对脏副本必须红', !keepByEntries(dirty(editBody, 'item.internal !== true', 'item.internal === true')))
check('[3] 不分叉判据对脏副本必须红', !noFork(`${flow}\nvoid channel.invoke('forkSession', [])`))

// ── [4] 宿主只认当前会话 ────────────────────────────────────────────────────────
const onlyCurrent = (s) => s.includes('path !== session.filePath') && s.includes('只能改当前会话里的消息')
check('[4] 非当前会话时拒绝并说明原因', onlyCurrent(host))
check('[4] 拒绝判据对脏副本必须红', !onlyCurrent(dirty(host, 'path !== session.filePath', 'false')))
check(
  '[4] 方法在界面通道与 runtime 上都接上了',
  /rewindSession\(path, keep(, text)?\)/.test(runtime) && runtime.includes('ctx.session.rewind(path, keep'),
)

// ── [5] 文案说实话 ──────────────────────────────────────────────────────────────
const honest = (s) => !s.includes('分叉出新会话，原会话保留') && s.includes('这条之后的回答会作废')
check('[5] 编辑提示不再说会分叉', honest(row))
check('[5] 文案判据对脏副本必须红', !honest(`${row}\n分叉出新会话，原会话保留`))

console.log(failures === 0 ? '\nPASS 编辑并重发（留在当前会话）五条口径全过' : `\nFAIL ${failures} 条`)
process.exit(failures === 0 ? 0 : 1)
