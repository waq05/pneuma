/**
 * 阶段分组的端到端检查：真会话日志 → Transcript 折叠 → 阶段分组。
 *
 * 为什么要有它：行为单测（step-groups-check.mjs）喂的是手工构造的条目，验的是分组算法本身；
 * 这一支从**种子的 jsonl** 出发，走完「core 的 Session.load → adapter 的 Transcript.replayHistory
 * → process-groups 的分组」整条链，验的是「真实重放出来的条目形状能被分组器正确切开」。
 * 两边一起才算闭环：算法对但条目顺序理解错了，只有这一支能发现。
 *
 * 它自己先重建夹具（跑一遍 step-seed.mjs）再检查：实时截图用例会往实时样张的会话里追加一轮
 * 真对话，夹具因此不是幂等的——不重建的话，这张网会在「刚跑过截图用例」之后假红。
 * 重建与检查都只碰 desktop/shots/step-home 这个隔离目录，用户真实的 ~/.dsc 一个字节不写，
 * 也不启动 Electron。
 *
 * 用法（一条命令自持）：node desktop/shots/step-seed-check.mjs
 * 退出码：0 = 全部通过；1 = 有断言没过。
 *
 * @module desktop/shots/step-seed-check
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const shots = 'D:\\dsc\\desktop\\shots'
const home = `${shots}\\step-home`
// 会话根目录按 homedir 算，必须在 import core 之前换掉（虽然这里传的是绝对路径，但保持一致）
process.env.HOME = home
process.env.USERPROFILE = home

const seeded = spawnSync(process.execPath, [`${shots}\\step-seed.mjs`], { encoding: 'utf8' })
if (seeded.status !== 0) {
  process.stdout.write(`[step-seed-check] 夹具重建失败（退出码 ${String(seeded.status)}）：\n${seeded.stderr ?? ''}\n`)
  process.exit(1)
}

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: ok === true, detail: String(detail ?? '') })
const eq = (name, actual, expected) => {
  check(name, actual === expected, `实测 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}

const sessions = JSON.parse(readFileSync(`${shots}\\step-sessions.json`, 'utf8'))
const core = await import('../../lib/core/session.js')
const { Transcript } = await import('../../lib/adapter/transcript.js')
const { roundInfos } = await import('../src/renderer/turn-timing.ts')
const { groupSteps, stepGroupTitle } = await import('../src/renderer/process-groups.ts')

/** 把一份会话日志折成条目并分好组。 */
function load(file) {
  const session = core.Session.load(file)
  const transcript = new Transcript()
  transcript.replayHistory(session.messages, session.toolErrors)
  const entries = transcript.entries
  const rounds = roundInfos(entries)
  const grouping = groupSteps(entries, rounds, () => false)
  return { entries, rounds, grouping }
}

const staticRun = load(sessions.static)
const { entries, rounds, grouping } = staticRun

/** 条目形态摘要，失败时打印用。 */
const shape = entries
  .map((entry, index) => `${String(index)}:${entry.kind}${entry.kind === 'tool' ? `(${entry.call.name})` : ''}`)
  .join(' ')
check('种子：四轮对话（末轮是「压着 32 条调用」那一组，验组体限高用）', rounds.length === 4, `实测 ${String(rounds.length)} 轮：${shape}`)
if (rounds.length === 4) {
  eq('种子：第 1 轮 12 条（用户 + 3 段过程 + 3 条正文）', rounds[0].endIndex - rounds[0].startIndex + 1, 12)
  eq('种子：第 4 轮 35 条（用户 + 思考 + 32 条工具 + 正文）', rounds[3].endIndex - rounds[3].startIndex + 1, 35)
}

// ── 实时路径的条目顺序：一条 assistant 消息折成「思考 + 正文 + 工具…」 ─────────────
// 这是分组正确性的前提：正文必须排在它前面那批工具之后，否则「正文封组」会把同一阶段劈成两半。
{
  const kinds = entries.slice(0, 5).map((entry) => entry.kind).join(',')
  eq('重放：第 1 轮开头是 用户 → 思考 → 工具 → 工具 → 正文', kinds, 'user,thinking,tool,tool,text')
}

// ── 第 1 轮：三段阶段 ────────────────────────────────────────────────────────────
{
  const first = grouping.groups.filter((group) => group.roundIndex === 0)
  eq('第 1 轮：切出三组', first.length, 3)
  eq('第 1 轮：三组的组头下标是 1 / 5 / 8', first.map((group) => group.startIndex).join(','), '1,5,8')
  eq(
    '第 1 轮：第一组组头文案（两类都以「已」开头，第二个省略）',
    first[0] === undefined ? '(缺)' : stepGroupTitle(first[0].counts, first[0].closed),
    '已搜索代码并读取文件',
  )
  eq('第 1 轮：第二组组头文案', first[1] === undefined ? '(缺)' : stepGroupTitle(first[1].counts, first[1].closed), '执行了命令')
  eq(
    '第 1 轮：第三组组头文案（「修改了文件」不以「已」开头，第二个照原样）',
    first[2] === undefined ? '(缺)' : stepGroupTitle(first[2].counts, first[2].closed),
    '修改了文件并已写入文件',
  )
  eq('第 1 轮：定稿轮三组全部收口', first.every((group) => group.closed).toString(), 'true')
}

// ── 第 2 轮：只有思考的组 ────────────────────────────────────────────────────────
{
  const second = grouping.groups.filter((group) => group.roundIndex === 1)
  eq('第 2 轮：一组', second.length, 1)
  eq('第 2 轮：组头文案「已完成分析」', second[0] === undefined ? '(缺)' : stepGroupTitle(second[0].counts, second[0].closed), '已完成分析')
}

// ── 第 3 轮：没有最终正文，组以工具收尾 ──────────────────────────────────────────
{
  const third = grouping.groups.filter((group) => group.roundIndex === 2)
  eq('第 3 轮：一组', third.length, 1)
  eq('第 3 轮：组头落在思考上（下标 16）', third[0] === undefined ? '(缺)' : third[0].startIndex, 16)
  eq(
    '第 3 轮：组头文案「已搜索代码」（末轮以工具收尾，仍报聚合）',
    third[0] === undefined ? '(缺)' : stepGroupTitle(third[0].counts, third[0].closed),
    '已搜索代码',
  )
  const lastRound = rounds[2]
  eq('第 3 轮：页脚落在轮内最后一条上（组内最后一条）', third[0] === undefined ? '(缺)' : lastRound?.endIndex, third[0]?.endIndex)
}

// ── 第 4 轮：一个压着几十条调用的阶段（验组体限高与组内滚动） ────────────────────
{
  const fourth = grouping.groups.filter((group) => group.roundIndex === 3)
  eq('第 4 轮：一组（32 条 read 挤在同一段过程里，中间没有正文）', fourth.length, 1)
  eq('第 4 轮：这一组收了 33 条（1 条思考 + 32 条工具）', fourth[0] === undefined ? -1 : fourth[0].endIndex - fourth[0].startIndex + 1, 33)
  eq(
    '第 4 轮：组头文案「已读取文件」',
    fourth[0] === undefined ? '(缺)' : stepGroupTitle(fourth[0].counts, fourth[0].closed),
    '已读取文件',
  )
}

// ── 计划卡：jsonl 里那条老格式的 plan 记录必须被读回来（D3 的截图用例靠它） ────────
// 重放路径（Transcript.replayHistory）看不到它——那条卡是 plan 插件在 dsc/session-open 时
// emit 回会话流的（src/plugins/plan.ts:114-121）。所以这里验的是**前提**：
// Session.load 认得这条老记录并把它放进了 state('plan')。
{
  const session = core.Session.load(sessions.static)
  const restored = session.state('plan')
  eq('计划卡：Session.load 把老格式的 plan 记录读回 state', restored?.title, '渲染层清点计划')
  eq('计划卡：批没批也读得回来（这张卡是已批准的历史卡）', restored?.decision, 'approved')
  eq(
    '计划卡：重放路径的会话流里本来没有它（要靠插件 emit）',
    entries.some((entry) => entry.kind === 'plan').toString(),
    'false',
  )
}

// ── 分页样张：12 轮，比一页的 8 轮多，且每轮都有可折的过程 ──────────────────────
{
  const pagingRun = load(sessions.paging)
  eq('分页样张：12 轮（比一页的 8 轮多出 4 轮）', pagingRun.rounds.length, 12)
  eq(
    '分页样张：每轮都有可折的过程（思考 + 回答各一条，共 12 组）',
    pagingRun.grouping.groups.length,
    12,
  )
  eq(
    '分页样张：每轮的过程从思考开始（整轮总开关才是可点的）',
    pagingRun.grouping.groups.every((group) => group.counts.length === 0).toString(),
    'true',
  )
}

// ── 实时样张：一条已定稿的短会话 ─────────────────────────────────────────────────
{
  const liveRun = load(sessions.live)
  eq('实时样张：一轮', liveRun.rounds.length, 1)
  eq('实时样张：一组（思考 + 正文，没调工具）', liveRun.grouping.groups.length, 1)
  eq(
    '实时样张：组头文案「已完成分析」',
    liveRun.grouping.groups[0] === undefined
      ? '(缺)'
      : stepGroupTitle(liveRun.grouping.groups[0].counts, liveRun.grouping.groups[0].closed),
    '已完成分析',
  )
}

const passed = checks.filter((entry) => entry.ok).length
const failed = checks.filter((entry) => !entry.ok)
process.stdout.write('[step-seed-check] 端到端：jsonl → Transcript → 阶段分组\n')
for (const entry of checks) {
  process.stdout.write(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}\n`)
  if (!entry.ok && entry.detail !== '') process.stdout.write(`      实测：${entry.detail}\n`)
}
process.stdout.write(`[step-seed-check] 断言 ${String(checks.length)} 条，通过 ${String(passed)} 条，失败 ${String(failed.length)} 条\n`)
process.exit(failed.length === 0 ? 0 : 1)
