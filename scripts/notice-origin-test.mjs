/**
 * 机器来源的消息不再长成用户气泡（2026-11-02 报障）。
 *
 * 报障现场：后台作业收工后，对话页里冒出两个灰色**用户气泡**，正文是
 * 「后台作业 job-3（…）成功完成。用 job_output(job_id="job-3") 查看输出，job_list 清点全部作业。」，
 * 还带编辑铅笔——那是机器投的消息，不是人打的字。
 *
 * 根因是「来源」在落库那一刻被丢掉：`loop.followup` / `drainInbox` 只把 text/images/files
 * 交给 `appendUser`，而 `appendUser` 也只写这三样；界面侧只靠两种正文前缀
 * （`<teammate-report`、`<review-findings`）认机器消息，作业通知没有前缀 → 当成人打的字。
 *
 * 修法：把 `origin` 落进日志（只有 `'notice'` 才写）、带进 `user` 事件、带进重放，
 * adapter 用「前缀命中 或 origin === 'notice'」判 internal；请求侧由 serializeMessages 剥掉。
 *
 * 五段：
 *   [1] 落库：机器投递写 origin、人打的字一个字节都不多写；重开日志读得回来
 *   [2] 请求侧：serializeMessages 把 origin 剥掉（协议里没有这一项）
 *   [3] 适配器判据：origin 命中 → internal；老日志/人打的字 → 不是 internal
 *   [4] 重放：replayHistory 带着 origin 走同一条判据（重开旧会话仍是触发行）
 *   [5] 界面标签：队友汇报 / 后台作业完成 / 后台作业失败 / 其它运行时通知
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/notice-origin-test.mjs
 *
 * @module dsc/scripts/notice-origin-test
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-notice-origin-home-'))
process.env.HOME = home
process.env.USERPROFILE = home

const { Session } = await import('../lib/core/session.js')
const { Transcript } = await import('../lib/adapter/transcript.js')
const { serializeMessages } = await import('../lib/core/llm.js')
const { internalLabel } = await import(
  new URL('../ui-shell/src/plugins/transcript/rounds.ts', import.meta.url).href
)

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

const JOB_DONE = '后台作业 job-3（Set-Location group4\\最终项目\\frontend; npm run build）成功完成。用 job_output(job_id="job-3") 查看输出，job_list 清点全部作业。'
const JOB_FAILED = '后台作业 job-4（npm run pack）失败（退出码 1）。用 job_output(job_id="job-4") 查看输出，job_list 清点全部作业。'
const HUMAN = '把后端改成 CRLF 行尾'
const TEAMMATE = '<teammate-report from="mate-1" role="coder" state="已完成">\n搞定了\n</teammate-report>'

console.log('[1] 落库：机器投递写 origin，人打的字一个字节都不多写')
{
  const work = mkdtempSync(join(tmpdir(), 'dsc-notice-origin-work-'))
  const file = join(work, 's.jsonl')
  const session = Session.create(work, file)
  session.appendUser(HUMAN)
  session.appendUser(JOB_DONE, undefined, undefined, 'notice')
  // 落盘是流式写：close 的 stream.end() 是异步 flush，等它把文件写完再读。
  session.close()
  await new Promise((resolve) => setTimeout(resolve, 120))

  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
  const records = lines.map((line) => JSON.parse(line))
  const users = records.filter((record) => record.type === 'user')
  check('两条 user 记录都落库了', users.length === 2, String(users.length))
  check('人打的字不带 origin（老形状不变）', users[0]?.origin === undefined, JSON.stringify(users[0]?.origin))
  check('机器投递的写着 origin: notice', users[1]?.origin === 'notice', JSON.stringify(users[1]?.origin))

  const reopened = Session.load(file)
  const userMessages = reopened.messages.filter((message) => message.role === 'user')
  check('重开日志：人打的字 origin 仍是 undefined', userMessages[0]?.origin === undefined)
  check('重开日志：机器投递的 origin 读得回来', userMessages[1]?.origin === 'notice', JSON.stringify(userMessages[1]?.origin))
  reopened.close()
}

console.log('[2] 请求侧：serializeMessages 把 origin 剥掉（协议里没有这一项）')
{
  const wire = serializeMessages([
    { role: 'user', content: 'x', origin: 'notice', ts: 1, files: [] },
    { role: 'user', content: 'y' },
  ])
  const first = wire[0]
  const keys = Object.keys(first).join(',')
  check('origin 不出现在请求体里', !('origin' in first), keys)
  check('ts / files 也照旧剥掉（原有纪律没破）', !('ts' in first) && !('files' in first), keys)
  check('人打的字那条本来就没 origin', !('origin' in wire[1]))
}

console.log('[3] 适配器判据：origin 命中就是 internal，老消息不是')
{
  const transcript = new Transcript()
  transcript.reduce({ type: 'user', text: JOB_DONE, origin: 'notice' }, 1)
  transcript.reduce({ type: 'user', text: HUMAN }, 2)
  const entries = transcript.entries
  check('机器投递那条带 internal 标记', entries[0]?.kind === 'user' && entries[0].internal === true)
  check('人打的字没有 internal 标记', entries[1]?.kind === 'user' && entries[1].internal === undefined)

  // 前缀那条老判据不能破：老日志里没有 origin，靠前缀仍认得出队友汇报
  const second = new Transcript()
  second.reduce({ type: 'user', text: TEAMMATE }, 3)
  check('没有 origin 的队友汇报仍靠前缀认成 internal', second.entries[0]?.kind === 'user' && second.entries[0].internal === true)

  // 前缀没命中、origin 也没有：老会话里的作业通知（本次修不了的历史）就是人打的字
  const third = new Transcript()
  third.reduce({ type: 'user', text: JOB_DONE }, 4)
  check('老日志（没有 origin）里的作业通知仍按人打的字渲染（诚实边界）', third.entries[0]?.kind === 'user' && third.entries[0].internal === undefined)
}

console.log('[4] 重放：replayHistory 带着 origin 走同一条判据')
{
  const transcript = new Transcript()
  transcript.replayHistory([
    { role: 'user', content: JOB_DONE, origin: 'notice', ts: 10 },
    { role: 'user', content: HUMAN, ts: 20 },
  ])
  const entries = transcript.entries
  check('重放：带 origin 的通知仍是触发行', entries[0]?.kind === 'user' && entries[0].internal === true)
  check('重放：人打的字还是气泡', entries[1]?.kind === 'user' && entries[1].internal === undefined)

  // 老会话日志（user 记录里没有 origin）重放：不能凭空猜成 internal
  const legacy = new Transcript()
  legacy.replayHistory([{ role: 'user', content: JOB_DONE, ts: 30 }])
  check('重放老日志：不猜，仍按人打的字', legacy.entries[0]?.kind === 'user' && legacy.entries[0].internal === undefined)
}

console.log('[5] 界面标签：一行说清刚发生了什么')
{
  check('队友汇报沿用原标签', internalLabel(TEAMMATE) === '队友 mate-1 汇报了运行结果', internalLabel(TEAMMATE))
  check('作业完成：带作业号、只说完成', internalLabel(JOB_DONE) === '后台作业 job-3 完成了', internalLabel(JOB_DONE))
  check('作业失败：说失败（不是「完成」）', internalLabel(JOB_FAILED) === '后台作业 job-4 失败了', internalLabel(JOB_FAILED))
  check('启动失败也归到失败', internalLabel('后台作业 job-5 启动失败：spawn ENOENT') === '后台作业 job-5 失败了', internalLabel('后台作业 job-5 启动失败：spawn ENOENT'))
  check('其它机器通知给通用话', internalLabel('定时任务「起来喝水」到点了') === '运行时通知', internalLabel('定时任务「起来喝水」到点了'))
  check('绝不把原文当标签', !internalLabel(JOB_DONE).includes('job_output') && !internalLabel(TEAMMATE).includes('<teammate-report'))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
