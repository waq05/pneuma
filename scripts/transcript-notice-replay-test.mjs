/**
 * 模型重试提示「刷新之后还在」的探针（真内核 + 临时 HOME）。
 *
 * 钉的口径（2026-11-07 报障「这个报错在刷新后就看不到了，需要留着」）：
 *   ① 重试提示先落盘再等——`notice` 记录写在会话 jsonl 里，字段一个不少；
 *   ② 从磁盘读回来，`Session.notices()` 原样交还（attempt / maxRetries / delayMs / 原因）；
 *   ③ 重放按 ts 把它插回**消息之间**：用户问 → 重试提示 → 答案，不是堆在末尾；
 *   ④ 这一轮失败的原因（turn-error）重放成一条 system 条目，刷新后仍读得到；
 *   ⑤ 没有 notice 的老日志照旧重放，不多出一条空提示。
 *
 * 隔离：临时 HOME，真实 ~/.dsc 不碰。
 * 运行：node scripts/transcript-notice-replay-test.mjs（先 pnpm build）
 *
 * @module dsc/scripts/transcript-notice-replay-test
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-notice-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

const { Session } = await import('../lib/core/session.js')
const { Transcript } = await import('../lib/adapter/transcript.js')

const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })

console.log('模型重试提示落盘与重放')

// ── [1] 写：重试提示先落盘，再往后才是那条答案 ──────────────────────────────
const session = Session.create(ws)
session.appendUser('为什么报 429')
session.appendNotice({
  kind: 'model-retry',
  attempt: 3,
  maxRetries: 5,
  delayMs: 1847,
  text: 'HTTP 429：[prefill_cap_refused] the cell is at capacity',
})
session.appendAssistant('这次成功了', '', [])
session.appendNotice({ kind: 'turn-error', text: 'HTTP 429：配额不够' })
const file = session.filePath
session.close()

// 写入流是异步的：等最后一笔（turn-error）真的落到盘上再读，别跟 fs 抢跑
const waitForLog = async (path, needle) => {
  for (let i = 0; i < 100; i += 1) {
    try {
      if (readFileSync(path, 'utf8').includes(needle)) return true
    } catch {
      // 文件还没建出来：继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}
check('日志落盘（等得到 turn-error 那条）', await waitForLog(file, '"kind":"turn-error"'), file)

const raw = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line !== '')
const notices = raw.map((line) => JSON.parse(line)).filter((record) => record.type === 'notice')
check('日志里落了两条 notice 记录', notices.length === 2, String(notices.length))
const retryRecord = notices.find((record) => record.notice.kind === 'model-retry')
check(
  '重试记录带齐 attempt / maxRetries / delayMs / 原因',
  retryRecord !== undefined &&
    retryRecord.notice.attempt === 3 &&
    retryRecord.notice.maxRetries === 5 &&
    retryRecord.notice.delayMs === 1847 &&
    retryRecord.notice.text.includes('prefill_cap_refused'),
  JSON.stringify(retryRecord?.notice),
)
check(
  '重试记录排在答案之前（先持久、后等待）',
  raw.findIndex((line) => line.includes('"type":"assistant"')) > raw.findIndex((line) => line.includes('"type":"notice"')),
)

// ── [2] 读：重开这一轮，提示原样回来，时间戳排得出先后 ────────────────────
const restored = Session.load(file)
const back = restored.notices()
check('读回两条提示', back.length === 2, String(back.length))
check(
  '读回的字段与原样一致',
  back[0]?.kind === 'model-retry' && back[0]?.delayMs === 1847 && back[0]?.maxRetries === 5,
  JSON.stringify(back[0]),
)
const userTs = restored.messages[0]?.ts ?? 0
const answerTs = restored.messages[1]?.ts ?? 0
check(
  '第一条提示夹在问与答之间',
  (back[0]?.ts ?? 0) >= userTs && (back[0]?.ts ?? 0) <= answerTs,
  JSON.stringify({ userTs, noticeTs: back[0]?.ts, answerTs }),
)

// ── [3] 重放：提示插回原位，不是堆到末尾 ──────────────────────────────────
const transcript = new Transcript()
transcript.replayHistory(
  restored.messages,
  restored.toolErrors,
  restored.fileChanges,
  restored.presentations,
  restored.notices(),
)
const kinds = transcript.entries.map((entry) => entry.kind)
check(
  '重放出「问 → 重试 → 答案 → 失败原因」的顺序',
  JSON.stringify(kinds) === JSON.stringify(['user', 'model-retry', 'text', 'system']),
  kinds.join(' / '),
)
const retryEntry = transcript.entries.find((entry) => entry.kind === 'model-retry')
check(
  '重放出来的重试行带着界面要的全部读数',
  retryEntry !== undefined && retryEntry.attempt === 3 && retryEntry.maxRetries === 5 && retryEntry.delayMs === 1847,
  JSON.stringify(retryEntry),
)
const errorEntry = transcript.entries.find((entry) => entry.kind === 'system' && entry.text.includes('配额不够'))
check('这一轮的失败原因也重放回来了', errorEntry !== undefined, JSON.stringify(transcript.entries.map((entry) => entry.kind)))
restored.close()

// ── [4] 老日志：没有 notice 记录时不多出一条空提示 ────────────────────────
{
  const legacy = new Transcript()
  legacy.replayHistory([{ role: 'user', content: '老会话', ts: 10 }, { role: 'assistant', content: '老答案', ts: 11 }])
  check('老日志不产出重试行', legacy.entries.every((entry) => entry.kind !== 'model-retry'), legacy.entries.map((entry) => entry.kind).join(' / '))
}


// ── [5] 连着重试：同一条行原地更新，不叠成一摞（2026-11-08 报障） ────────────
{
  const live = new Transcript()
  for (const retry of [1, 2, 3]) {
    live.reduce(
      { type: 'model/retry', attempt: retry, maxRetries: 5, delayMs: 500 * retry, reason: `HTTP 429 #${String(retry)}` },
      1000 + retry * 10,
    )
  }
  const rows = live.entries.filter((entry) => entry.kind === 'model-retry')
  check('三次重试只留下一行', rows.length === 1, String(rows.length))
  check(
    '那一行是最新一次的数据（3/5、等了 1500 毫秒）',
    rows[0]?.attempt === 3 && rows[0]?.delayMs === 1500,
    JSON.stringify(rows[0]),
  )
  // 中间隔了正文（流中断后先落半截回复、或者下一轮请求又失败）：那是新的一段，另起一行
  live.reduce({ type: 'message', text: '接着干', reasoning: '' }, 1100)
  live.reduce({ type: 'model/retry', attempt: 1, maxRetries: 5, delayMs: 500, reason: 'HTTP 429' }, 1200)
  const after = live.entries.filter((entry) => entry.kind === 'model-retry')
  check('中间隔了正文就另起一行', after.length === 2, String(after.length))
}
process.exit(failures === 0 ? 0 : 1)
