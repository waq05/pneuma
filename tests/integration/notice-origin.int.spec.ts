/**
 * 机器来源的消息不再长成用户气泡（迁自 `scripts/notice-origin-test.mjs`）。
 *
 * 报障现场：后台作业收工后，对话页里冒出两个灰色**用户气泡**，正文是
 * 「后台作业 job-3（…）成功完成。用 job_output(job_id="job-3") 查看输出」那句机器话，
 * 还带着编辑铅笔——那是机器投的消息，不是人打的字。
 *
 * 根因是「来源」在落库那一刻被丢掉：`loop.followup` / `drainInbox` 只把
 * text / images / files 交给 `appendUser`，`appendUser` 也只写这三样；界面只能靠两种
 * 正文前缀（`<teammate-report`、`<review-findings`）认机器消息，作业通知没有前缀。
 *
 * 修法是把 `origin` 一路带下去：日志（只有 `'notice'` 才写）→ 内存消息 → `user` 事件
 * → 重放 → 适配器判 internal；请求侧由 `serializeMessages` 剥掉（协议里没有这一项）。
 *
 * ## 五段各自的接缝
 *
 * 1. 落库：真 `Session`，读写同一份 jsonl（不经过内核，落盘就是被测对象）；
 * 2. 请求侧：`serializeMessages` 纯函数，喂一条带 origin 的消息看它出不出现在线上；
 * 3. 适配器判据：`Transcript.reduce` 的 user 分支；
 * 4. 重放：`Transcript.replayHistory` 走同一条判据（重开旧会话仍是触发行）。
 *
 * 原探针第 [5] 段（界面标签 `internalLabel`）搬去了 ui 层
 * （`src/packages/ui-transcript/ui/internal-label.spec.ts`）：那是界面半模块，integration
 * 层的 spec 一旦 import 它，就把 `@dsc/ui` 与 JSON import 拖进内核编译。
 *
 * @module dsc/tests/integration/notice-origin.int.spec
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Transcript } from '../../src/adapter/transcript.js'
import { serializeMessages } from '../../src/core/llm.js'
import { Session } from '../../src/core/session.js'

/** 三段真实形状的正文：后台作业通知（无前缀）、队友汇报（有前缀）、人打的字。 */
const JOB_DONE =
  '后台作业 job-3（Set-Location group4\\最终项目\\frontend; npm run build）成功完成。用 job_output(job_id="job-3") 查看输出，job_list 清点全部作业。'
const HUMAN = '把后端改成 CRLF 行尾'
const TEAMMATE = '<teammate-report from="mate-1" role="coder" state="已完成">\n搞定了\n</teammate-report>'

/** 一段工作目录：每次跑都不同，但同一文件内复用（只为让会话落到临时目录）。 */
const WORK = mkdtempSync(join(tmpdir(), 'dsc-notice-origin-work-'))

test('① 落库：机器投递写 origin，人打的字一个字节都不多写', async () => {
  const file = join(WORK, 'persist.jsonl')
  const session = Session.create(WORK, file)
  session.appendUser(HUMAN)
  session.appendUser(JOB_DONE, undefined, undefined, 'notice')
  // 落盘是流式写：close 的 stream.end() 是异步 flush，等它写完再读。
  session.close()
  await new Promise((resolve) => setTimeout(resolve, 120))

  const records = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const users = records.filter((record) => record.type === 'user')
  expect(users).toHaveLength(2)
  // 老形状不变：人打的字那条记录里没有 origin 键（不是 origin: 'user'）。
  expect(Object.hasOwn(users[0]!, 'origin')).toBe(false)
  expect(users[1]?.origin).toBe('notice')
})

test('① 重开日志：origin 读得回来，人打的字仍是 undefined', () => {
  const reopened = Session.load(join(WORK, 'persist.jsonl'), true)
  const users = reopened.messages.filter((message) => message.role === 'user')
  expect(users[0]?.origin).toBeUndefined()
  expect(users[1]?.origin).toBe('notice')
  reopened.close()
})

test('② 请求侧：origin 与 ts / files 一样被剥掉（协议里没有这三项）', () => {
  const wire = serializeMessages([
    { role: 'user', content: 'x', origin: 'notice', ts: 1, files: [] },
    { role: 'user', content: 'y' },
  ]) as Array<Record<string, unknown>>
  const first = wire[0]!
  expect(Object.hasOwn(first, 'origin')).toBe(false)
  expect(Object.hasOwn(first, 'ts')).toBe(false)
  expect(Object.hasOwn(first, 'files')).toBe(false)
  // 人打的字那条本来就没有 origin，剥不剥都一样。
  expect(Object.hasOwn(wire[1]!, 'origin')).toBe(false)
})

test('③ 适配器判据：origin 命中就是 internal，老消息不是', () => {
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: JOB_DONE, origin: 'notice' }, 1)
  transcript.reduce({ type: 'user', text: HUMAN }, 2)
  const entries = transcript.entries
  expect(entries[0]?.kind === 'user' ? entries[0].internal : undefined).toBe(true)
  expect(entries[1]?.kind === 'user' ? entries[1].internal : undefined).toBeUndefined()
})

test('③ 老判据不破：没有 origin 的队友汇报仍靠前缀认成 internal', () => {
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: TEAMMATE }, 3)
  expect(transcript.entries[0]?.kind === 'user' ? transcript.entries[0].internal : undefined).toBe(true)
})

test('③ 诚实边界：老日志里的作业通知（无 origin、无前缀）仍按人打的字渲染', () => {
  // 本次修的是「新写入的来源」，改不了历史记录里已经丢掉的来源——这里如实钉住。
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: JOB_DONE }, 4)
  expect(transcript.entries[0]?.kind === 'user' ? transcript.entries[0].internal : undefined).toBeUndefined()
})

test('④ 重放：带 origin 的通知仍是触发行，人打的字还是气泡', () => {
  const transcript = new Transcript()
  transcript.replayHistory([
    { role: 'user', content: JOB_DONE, origin: 'notice', ts: 10 },
    { role: 'user', content: HUMAN, ts: 20 },
  ])
  const entries = transcript.entries
  expect(entries[0]?.kind === 'user' ? entries[0].internal : undefined).toBe(true)
  expect(entries[1]?.kind === 'user' ? entries[1].internal : undefined).toBeUndefined()
})

test('④ 重放老日志：不猜，仍按人打的字', () => {
  const legacy = new Transcript()
  legacy.replayHistory([{ role: 'user', content: JOB_DONE, ts: 30 }])
  expect(legacy.entries[0]?.kind === 'user' ? legacy.entries[0].internal : undefined).toBeUndefined()
})

