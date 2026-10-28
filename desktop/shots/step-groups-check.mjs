/**
 * 阶段分组的行为单测（对照 dsh 的 process-groups.ts + process-activity.ts + step-process.ts）。
 *
 * 为什么要有它：分组是「一轮里哪几条算一个阶段」这件事的唯一真相，规则里有好几处容易被后来的
 * 改动悄悄碰坏——正文封组、计划卡成界、system 不成界、尾组跟着轮次收口、直播中组序号不许变。
 * 这些在界面上都只表现为「多一行或者少一行」，肉眼很难发现，所以直接喂构造好的条目给纯函数、
 * 逐条断言结果。
 *
 * 为什么能直接跑 TypeScript 源码：process-groups.ts 是纯计算模块，import 全是 type-only
 * （TranscriptEntry / RoundInfo），Node 的 type stripping 会把它们整条抹掉，于是源码可以
 * 不经打包直接跑。这样这张网测的就是真源码，而不是某个被打包器揉过的产物。
 *
 * 只读：不写文件、不碰 ~/.dsc、不启动 Electron。
 *
 * 用法（仓库根目录）：
 *   node desktop/shots/step-groups-check.mjs
 * 退出码：0 = 全部通过；1 = 有断言没过（逐条打印实测与期望）。
 *
 * @module desktop/shots/step-groups-check
 */
import {
  PROCESS_TITLE_MINIMUM_MS,
  TURN_PROCESS_INDEPENDENT,
  activityOf,
  groupSteps,
  joinLiveDetail,
  liveTitleDecision,
  liveTitleOf,
  liveToolDetail,
  sameLiveTitle,
  stepGroupTitle,
} from '../src/renderer/process-groups.ts'
import { PROCESS_FOLD_POLICIES, processFoldPolicy } from '../src/renderer/fold-policy.ts'
import { roundInfos, turnStartedAt } from '../src/renderer/turn-timing.ts'

/** 断言表：{name, ok, detail}；detail 只在失败时打印。 */
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: ok === true, detail: String(detail ?? '') })
}
/** 标量相等。 */
const eq = (name, actual, expected) => {
  check(name, actual === expected, `实测 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}
/** 结构相等（比 JSON 文本；条目顺序也算在内）。 */
const deep = (name, actual, expected) => {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  check(name, left === right, `实测 ${left}，期望 ${right}`)
}

// ── 造条目：id 递增，形状照 contract.ts 的 TranscriptEntry（只造分组器真正会读的字段） ──
let seq = 0
const nextId = () => (seq += 1)
const user = (text) => ({ kind: 'user', id: nextId(), text })
const think = (text) => ({ kind: 'thinking', id: nextId(), text })
const reply = (text) => ({ kind: 'text', id: nextId(), text })
const liveReply = (text) => ({ kind: 'text', id: -1, text })
const tool = (name) => ({ kind: 'tool', id: nextId(), call: { callId: `call_${String(nextId())}`, name, argsText: '{}', status: 'done' } })
const toolRunning = (name) => ({ kind: 'tool', id: nextId(), call: { callId: `call_${String(nextId())}`, name, argsText: '{}', status: 'running' } })
const system = (text) => ({ kind: 'system', id: nextId(), text })
const plan = () => ({ kind: 'plan', id: nextId(), plan: {} })

/**
 * 跑一次分组。
 * @param entries 条目表
 * @param isRunning true/false = 所有轮统一；传函数 = 按轮序号区分
 */
function group(entries, isRunning = false) {
  const rounds = roundInfos(entries)
  const ask = typeof isRunning === 'function' ? isRunning : () => isRunning
  return groupSteps(entries, rounds, ask)
}

// ── 1) 边界：没有任何过程条目 ────────────────────────────────────────────────────
{
  const g = group([user('你好'), reply('你好，有什么可以帮你？')])
  eq('空轮：一句过程内容都没有时不产生组', g.groups.length, 0)
  eq('空轮：两张查找表也是空的', g.headAt.size + g.at.size, 0)
}

// ── 2) 单阶段：只有思考，没有工具 ────────────────────────────────────────────────
{
  const g = group([user('帮我看看'), think('先想想'), reply('答案是 42')])
  eq('单阶段：只有一组', g.groups.length, 1)
  eq('单阶段：组从那条思考开始', g.groups[0].startIndex, 1)
  eq('单阶段：组到那条思考结束（正文不进组）', g.groups[0].endIndex, 1)
  eq('单阶段：正文出现就收口', g.groups[0].closed, true)
  eq('单阶段：一类工具都没调过 → 标题「已完成分析」', stepGroupTitle(g.groups[0].counts, g.groups[0].closed), '已完成分析')
}

// ── 3) 三阶段：正文把一轮切成三段过程 ─────────────────────────────────────────────
{
  const entries = [
    user('重构会话区'),
    think('阶段一：先摸清现状'),
    tool('grep'), tool('read'),
    reply('阶段一结论：入口在 ChatView。'),
    think('阶段二：跑一遍测试'),
    tool('bash'),
    reply('阶段二结论：测试全过。'),
    think('阶段三：动手改'),
    tool('edit'), tool('write'),
    reply('最终回答：改完了。'),
  ]
  const g = group(entries)
  eq('三阶段：正文切出三组', g.groups.length, 3)
  deep('三阶段：第一组的类别与次数（按首次出现排）', g.groups[0].counts, [
    { kind: 'search', count: 1 }, { kind: 'read', count: 1 },
  ])
  eq('三阶段：第一组标题（两类都以「已」开头，第二个省略）', stepGroupTitle(g.groups[0].counts, true), '已搜索代码并读取文件')
  eq('三阶段：第二组标题', stepGroupTitle(g.groups[1].counts, true), '执行了命令')
  eq('三阶段：第三组标题（「修改了文件」不以「已」开头，第二个照原样）', stepGroupTitle(g.groups[2].counts, true), '修改了文件并已写入文件')
  eq('三阶段：组头分别画在 1 / 5 / 8 上', [...g.headAt.keys()].join(','), '1,5,8')
  eq('三阶段：三条阶段正文都不进组（下标 4 / 7 / 11）', [4, 7, 11].map((i) => g.at.get(i) === undefined).join(','), 'true,true,true')
  eq('三阶段：组序号从 0 连续排到 2', g.groups.map((item) => item.seq).join(','), '0,1,2')
}

// ── 4) 组头文案的拼法（照 dsh 的 processTitle，step-process.ts:11-27） ─────────────
{
  const c = (kind, count) => ({ kind, count })
  eq('标题：一个类别不带次数', stepGroupTitle([c('read', 3)], true), '已读取文件')
  eq('标题：两类共享「已」时省略第二个的「已」', stepGroupTitle([c('read', 1), c('search', 1)], true), '已读取文件并搜索代码')
  eq('标题：两类不共享前缀时第二个照原样', stepGroupTitle([c('edit', 1), c('write', 1)], true), '修改了文件并已写入文件')
  eq('标题：三类用中文逗号连接', stepGroupTitle([c('read', 3), c('search', 2), c('commands', 1)], true), '已读取文件，已搜索代码，执行了命令')
  eq('标题：超过三类只列前三并加「等」', stepGroupTitle([c('read', 4), c('search', 3), c('commands', 2), c('edit', 1)], true), '已读取文件，已搜索代码，执行了命令等')
  eq('标题：未结束的组报运行中的那一类', stepGroupTitle([c('read', 1)], false, 'read'), '正在读取文件')
  eq('标题：未结束且没有工具在跑 → 「正在分析请求」', stepGroupTitle([], false), '正在分析请求')
  eq('标题：已结束且没有工具 → 「已完成分析」', stepGroupTitle([], true), '已完成分析')
  eq('标题：未结束的组只报实时那一类，不报计数最多的那一类', stepGroupTitle([c('read', 5), c('commands', 1)], false, 'commands'), '正在运行命令')
  eq('标题：未结束但工具全结算了 → 仍报「正在分析请求」，不退回聚合', stepGroupTitle([c('read', 5), c('commands', 1)], false), '正在分析请求')
}

// ── 5) 计划卡成界（但不进组） ────────────────────────────────────────────────────
{
  const entries = [user('按这个计划改'), think('先想一下'), plan(), tool('read')]
  const g = group(entries)
  eq('计划卡：它自己成界，前后的过程各成一组', g.groups.length, 2)
  eq('计划卡：不归任何一组', g.at.get(2) === undefined, true)
  eq('计划卡：前面那组到思考为止', g.groups[0].endIndex, 1)
  eq('计划卡：后面那组从工具开始', g.groups[1].startIndex, 3)
}

// ── 6) system 提示既不成界也不进组 ───────────────────────────────────────────────
{
  const entries = [user('跑一下'), think('先想'), system('已恢复会话 ba233d8a'), tool('bash')]
  const g = group(entries)
  eq('system 提示：不切组', g.groups.length, 1)
  eq('system 提示：前后两条过程留在同一组里', [g.groups[0].startIndex, g.groups[0].endIndex].join(','), '1,3')
}

// ── 7) 尾组的收口状态跟着这一轮走 ────────────────────────────────────────────────
{
  const entries = [user('干活'), think('想'), toolRunning('bash')]
  const running = group(entries, true)
  eq('跑动中：尾组没有收口', running.groups[0].closed, false)
  eq('跑动中：标题报实时类别「正在运行命令」', stepGroupTitle(running.groups[0].counts, running.groups[0].closed, running.groups[0].running), '正在运行命令')
  const settled = group(entries, false)
  eq('收尾后：尾组收口', settled.groups[0].closed, true)
  eq('收尾后：标题换成聚合「执行了命令」', stepGroupTitle(settled.groups[0].counts, settled.groups[0].closed, settled.groups[0].running), '执行了命令')
}

// ── 7b) 未结束的组只报「此刻在干什么」（dsh 的 running 口径） ────────────────────
{
  const waiting = group([user('干活'), tool('bash'), toolRunning('read')], true)
  eq('实时类别：取最后一个还在跑的工具', waiting.groups[0].running, 'read')
  eq('实时类别：未结束的组头报它', stepGroupTitle(waiting.groups[0].counts, waiting.groups[0].closed, waiting.groups[0].running), '正在读取文件')
  const allDone = group([user('干活'), tool('bash'), tool('read')], true)
  eq('实时类别：工具全部结算后就没有实时类别了', allDone.groups[0].running, undefined)
  eq('实时类别：组头退回「正在分析请求」', stepGroupTitle(allDone.groups[0].counts, allDone.groups[0].closed, allDone.groups[0].running), '正在分析请求')
  const settled = group([user('干活'), toolRunning('read')], false)
  eq('实时类别：组收口后不再带实时类别', settled.groups[0].running, undefined)
  eq('实时类别：收口后回到聚合文案', stepGroupTitle(settled.groups[0].counts, settled.groups[0].closed), '已读取文件')
}

// ── 8) 直播中组序号必须稳（这是「用户点开的那一组不会被新增内容重置」的根） ────────
{
  const base = [user('干活'), think('阶段一'), reply('阶段一好了')]
  const before = group(base, true)
  const after = group([...base, think('阶段二'), tool('read')], true)
  eq('直播：新增内容前只有一组', before.groups.length, 1)
  eq('直播：新增内容后两组', after.groups.length, 2)
  eq('直播：第一组的序号没变（还是 0）', after.groups[0].seq, 0)
  eq('直播：新组拿到序号 1', after.groups[1].seq, 1)
  const grown = group([...base, think('阶段二')], true)
  const grown2 = group([...base, think('阶段二'), tool('read'), tool('grep')], true)
  eq('直播：尾组吸收新工具后序号仍是 1', [grown.groups[1].seq, grown2.groups[1].seq].join(','), '1,1')
  eq('直播：尾组确实在长（结束下标从 3 到 5）', [grown.groups[1].endIndex, grown2.groups[1].endIndex].join(','), '3,5')
  deep('直播：长出来的工具也计进这一组的类别计数', grown2.groups[1].counts, [
    { kind: 'read', count: 1 }, { kind: 'search', count: 1 },
  ])
}

// ── 9) 直播尾（负 id）的正文同样是收口信号 ───────────────────────────────────────
{
  const entries = [user('干活'), think('想'), liveReply('正在写…'), tool('read')]
  const g = group(entries, true)
  eq('直播尾正文：它把前面的组收口，后面的工具另起一组', g.groups.length, 2)
  eq('直播尾正文：自己不进组', g.at.get(2) === undefined, true)
  eq('直播尾正文：前面那组已收口', g.groups[0].closed, true)
  eq('直播尾正文：后面那组还没收口', g.groups[1].closed, false)
}

// ── 10) 工具名 → 类别（照 dsh 的 process-activity.ts:7-21，另加 dsc 自己的几个） ──
{
  const table = [
    ['read', 'read'],
    ['read_image', 'readImage'],
    ['grep', 'search'], ['glob', 'search'], ['search', 'search'], ['session_search', 'search'], ['lsp_inspect', 'search'],
    ['write', 'write'],
    ['edit', 'edit'], ['apply_patch', 'edit'],
    ['bash', 'commands'], ['pwsh', 'commands'], ['exec_command', 'commands'], ['write_stdin', 'commands'], ['terminal_open', 'commands'],
    ['run_code', 'code'],
    ['web_search', 'webSearch'], ['web_fetch', 'webFetch'], ['browser', 'browser'],
    ['subagent', 'subagents'], ['subagent_codex', 'subagents'],
    ['todo_write', 'plan'], ['create_goal', 'plan'], ['exit_plan_mode', 'plan'],
    ['ask_user', 'questions'], ['ask_user_question', 'questions'],
    ['skill', 'tools'], ['plugin_manager', 'tools'], ['认不出来的工具', 'tools'],
  ]
  for (const [name, want] of table) eq(`分类：${name} → ${want}`, activityOf(name), want)
  eq('分类：大小写不敏感（Read → read）', activityOf('Read'), 'read')
  eq('分类：_inspect 后缀先于 subagent_ 前缀命中（subagent_inspect → search）', activityOf('subagent_inspect'), 'search')
}

// ── 11) 类别计数：次数降序、同次数按首次出现 ─────────────────────────────────────
{
  const first = group([user('x'), tool('bash'), tool('read')])
  deep('计数：同次数时按首次出现排（bash 在前）', first.groups[0].counts, [
    { kind: 'commands', count: 1 }, { kind: 'read', count: 1 },
  ])
  const second = group([user('x'), tool('read'), tool('bash')])
  deep('计数：顺序换过来结果也跟着换', second.groups[0].counts, [
    { kind: 'read', count: 1 }, { kind: 'commands', count: 1 },
  ])
  const third = group([user('x'), tool('read'), tool('read'), tool('bash')])
  deep('计数：次数多的排前面', third.groups[0].counts, [
    { kind: 'read', count: 2 }, { kind: 'commands', count: 1 },
  ])
}

// ── 12) 多轮各自分组，序号各轮从 0 起 ────────────────────────────────────────────
{
  const entries = [
    user('第一件事'), think('想一'), tool('read'), reply('第一件好了'),
    user('第二件事'), think('想二'), reply('第二件好了'),
  ]
  const rounds = roundInfos(entries)
  eq('多轮：切出两轮', rounds.length, 2)
  const g = group(entries, false)
  eq('多轮：两组各属一轮', g.groups.map((item) => item.roundIndex).join(','), '0,1')
  eq('多轮：第二轮那组只有思考', g.groups[1].counts.length, 0)
  eq('多轮：序号各轮都从 0 起（存档键里带轮号，不会串味）', g.groups.map((item) => item.seq).join(','), '0,0')
  eq('多轮：第二轮那组的组头画在下标 5 上', g.groups[1].startIndex, 5)
}

// ── 13) 一轮中途插进一条新的用户消息前，分组先被这一轮的边界截断 ────────────────
{
  const entries = [user('干活'), think('想一'), tool('read'), user('打断一下'), think('想二')]
  const g = group([user('干活'), think('想一'), tool('read'), user('打断一下'), think('想二')], false)
  const rounds = roundInfos(entries)
  eq('轮边界：用户消息开新一轮', rounds.length, 2)
  eq('轮边界：第一轮那一组只含本轮的思考与工具', g.groups[0].endIndex, 2)
  eq('轮边界：第二轮从头起一组', g.groups[1].startIndex, 4)
}

// ── 14) 组头实时详情：取哪个参数、怎么截断（照 dsh 的 liveToolDetail） ─────────────
{
  eq('详情：有 command 时取命令原文', liveToolDetail('bash', '{"command":"pnpm build"}'), 'pnpm build')
  eq('详情：没有 command 时按表取 file_path', liveToolDetail('read', '{"file_path":"a.ts"}'), 'a.ts')
  eq('详情：表里靠前的键优先（description 在 file_path 之前）', liveToolDetail('read', '{"file_path":"a.ts","description":"读入口"}'), '读入口')
  eq('详情：pattern 也取得到', liveToolDetail('grep', '{"pattern":"roundFold","path":"src"}'), 'roundFold')
  eq('详情：全是字符串的数组拼成一行', liveToolDetail('web_search', '{"queries":["甲","乙"]}'), '甲, 乙')
  eq('详情：questions 取第一个问题的题干', liveToolDetail('ask_user', '{"questions":[{"question":"选哪个？"}]}'), '选哪个？')
  eq('详情：一个键都取不到时退回工具名', liveToolDetail('read', '{"other":1}'), 'read')
  eq('详情：参数不是完整 JSON（流式半截）时退回工具名', liveToolDetail('bash', '{"command":"pnpm'), 'bash')
  eq('详情：参数解析出来是数组时退回工具名', liveToolDetail('bash', '[]'), 'bash')
  eq('详情：空白折成一个空格', liveToolDetail('bash', '{"command":"pnpm   build\\n--watch"}'), 'pnpm build --watch')
  const clipped = liveToolDetail('bash', JSON.stringify({ command: 'x'.repeat(200) }))
  eq('详情：超长截断到 160 个字素簇（含省略号）', Array.from(clipped).length, 160)
  eq('详情：截断后以省略号收尾', clipped.endsWith('…'), true)
  const family = '👨‍👩‍👧‍👦'
  const emoji = liveToolDetail('bash', JSON.stringify({ command: family.repeat(60) }))
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(emoji)].map((part) => part.segment)
  eq('详情：按字素簇切，不切散 ZWJ 家族表情', segments.every((part) => part === family || part === '…'), true)
}

// ── 15) 未结束的组把实时详情带在组上（已结束的组清空） ────────────────────────────
{
  const entries = [user('干活'), {
    kind: 'tool',
    id: nextId(),
    call: { callId: 'c_detail', name: 'bash', argsText: '{"command":"pnpm build"}', status: 'running' },
  }]
  const running = group(entries, true)
  eq('详情挂在组上：未结束的组带上它', running.groups[0].runningDetail, 'pnpm build')
  eq('详情挂在组上：类别仍是 commands', running.groups[0].running, 'commands')
  eq(
    '组头文案：类别 + 分隔点 + 详情',
    joinLiveDetail(stepGroupTitle(running.groups[0].counts, false, running.groups[0].running), running.groups[0].runningDetail),
    '正在运行命令 · pnpm build',
  )
  const settled = group(entries, false)
  eq('详情挂在组上：收口后清空（组头改用聚合文案）', settled.groups[0].runningDetail, undefined)
  eq(
    '组头文案：收口后不留分隔点',
    joinLiveDetail(stepGroupTitle(settled.groups[0].counts, true), settled.groups[0].runningDetail ?? ''),
    '执行了命令',
  )
  eq('组头文案：没有详情时也不留分隔点', joinLiveDetail('正在运行命令', ''), '正在运行命令')
}

// ── 16) 没有运行中的工具时，实时详情取最后一段直播尾思考 ─────────────────────────
{
  const live = [user('干活'), { kind: 'thinking', id: -1, text: '第一段。\n\n**最后一段**：在看 roundFold。' }]
  const g = group(live, true)
  eq('思考详情：没有 running 工具时取最后一段', g.groups[0].runningDetail, '最后一段：在看 roundFold。')
  eq('思考详情：类别仍报「分析」（没有工具在跑）', g.groups[0].running, undefined)
  eq(
    '思考详情：组头拼成「正在分析请求 · …」',
    joinLiveDetail(stepGroupTitle(g.groups[0].counts, false, g.groups[0].running), g.groups[0].runningDetail),
    '正在分析请求 · 最后一段：在看 roundFold。',
  )
  const settled = group([user('干活'), think('早就写完了')], true)
  eq('思考详情：定稿的思考条目不参与（id >= 0）', settled.groups[0].runningDetail, undefined)
  const blank = group([user('干活'), { kind: 'thinking', id: -1, text: '   ' }], true)
  eq('思考详情：全空白时不带详情', blank.groups[0].runningDetail, undefined)
}

// ── 17) 组头实时标题的 150ms 最短保留（照 dsh 的 useStableLiveProcessTitle） ──────
{
  const a = { activity: 'read', detail: 'a.ts' }
  const b = { activity: 'commands', detail: 'pnpm build' }
  deep('防抖：想要的跟显示的一样 → 不必换，也不用等', liveTitleDecision(a, a, 0), { keep: true, waitMs: 0 })
  deep('防抖：刚换过（0ms）不许换，等满 150ms', liveTitleDecision(a, b, 0), { keep: true, waitMs: 150 })
  deep('防抖：已经显示了 100ms，还差 50ms', liveTitleDecision(a, b, 100), { keep: true, waitMs: 50 })
  deep('防抖：正好 150ms 就换', liveTitleDecision(a, b, 150), { keep: false, waitMs: 0 })
  deep('防抖：超过 150ms 立即换', liveTitleDecision(a, b, 900), { keep: false, waitMs: 0 })
  eq(
    '防抖：只有详情变也算换标题',
    liveTitleDecision({ activity: 'read', detail: 'a.ts' }, { activity: 'read', detail: 'b.ts' }, 10).keep,
    true,
  )
  eq('标题同源：类别相同、详情不同 → 不是同一个标题', sameLiveTitle(a, { activity: 'read', detail: 'b.ts' }), false)
  eq('标题同源：两项都相同 → 同一个标题', sameLiveTitle(a, { activity: 'read', detail: 'a.ts' }), true)
  eq('最短保留是 150ms（照抄 dsh）', PROCESS_TITLE_MINIMUM_MS, 150)
  deep('从组取实时标题：用 running + runningDetail', liveTitleOf({ running: 'commands', runningDetail: 'pnpm build' }), {
    activity: 'commands',
    detail: 'pnpm build',
    preparing: false,
  })
  deep('从组取实时标题：都没有 → 分析 + 空详情', liveTitleOf({}), {
    activity: 'thinking',
    detail: '',
    preparing: false,
  })
  deep('从组取实时标题：准备中的组带上 preparing', liveTitleOf({ running: 'read', preparing: true }), {
    activity: 'read',
    detail: '',
    preparing: true,
  })
  eq(
    '防抖：只有 preparing 变也算换标题（「准备读取文件」与「正在读取文件」是两句话）',
    sameLiveTitle({ activity: 'read', detail: '', preparing: true }, { activity: 'read', detail: '', preparing: false }),
    false,
  )
}

// ── 18) 只给历史轮分组（详细档的 stepGrouping: 'history'） ───────────────────────
{
  const entries = [
    user('第一件事'), think('想一'), tool('read'), reply('好了'),
    user('第二件事'), think('想二'), toolRunning('bash'),
  ]
  const rounds = roundInfos(entries)
  const isRunning = (index) => index === 1
  const all = groupSteps(entries, rounds, isRunning, false)
  eq('历史轮分组：两轮都给组头', all.groups.map((item) => item.roundIndex).join(','), '0,1')
  const history = groupSteps(entries, rounds, isRunning, true)
  eq('历史轮分组：运行中的那一轮直接摊开，连组头都不画', history.groups.map((item) => item.roundIndex).join(','), '0')
  eq(
    '历史轮分组：那一轮的条目也不进任何组',
    [history.at.get(5), history.at.get(6)].map((item) => item === undefined).join(','),
    'true,true',
  )
  eq('历史轮分组：每一轮都在跑时一组都不产生', groupSteps(entries, rounds, () => true, true).groups.length, 0)
  eq('历史轮分组：每一轮都定稿时两组都在', groupSteps(entries, rounds, () => false, true).groups.length, 2)
}

// ── 19) 档位能力表：四档各开哪几项（照 dsh 的 POLICIES，逐格核对） ───────────────
{
  const table = [
    ['compact', true, 'collapsed', false, false],
    ['standard', true, 'collapsed', true, true],
    ['detailed', true, 'history', true, true],
    ['verbose', false, 'none', false, true],
  ]
  for (const [mode, foldTurns, stepGrouping, liveDetail, reasoningPreview] of table) {
    const policy = processFoldPolicy(mode)
    eq(`档位 ${mode}：整轮折叠`, policy.foldTurns, foldTurns)
    eq(`档位 ${mode}：阶段分组模式`, policy.stepGrouping, stepGrouping)
    eq(`档位 ${mode}：组头带实时详情`, policy.liveDetail, liveDetail)
    eq(`档位 ${mode}：思考摘要预览`, policy.reasoningPreview, reasoningPreview)
  }
  eq('档位：不传按标准档（只读视图那条路）', processFoldPolicy(undefined), PROCESS_FOLD_POLICIES.standard)
  eq(
    '档位：同一档位拿到同一个对象（下游 memo 不会白算）',
    processFoldPolicy('detailed') === processFoldPolicy('detailed'),
    true,
  )
  eq(
    '档位：只有完全展开档不折整轮',
    ['compact', 'standard', 'detailed', 'verbose'].filter((mode) => !processFoldPolicy(mode).foldTurns).join(','),
    'verbose',
  )
  eq(
    '档位：只有完全展开档不给组头',
    ['compact', 'standard', 'detailed', 'verbose'].filter((mode) => processFoldPolicy(mode).stepGrouping === 'none').join(','),
    'verbose',
  )
}

// ── 20) 组头文案的边界（类别多、类别少、脏数据） ─────────────────────────────────
{
  const c = (kind, count) => ({ kind, count })
  eq(
    '文案边界：恰好三类不加「等」',
    stepGroupTitle([c('read', 1), c('search', 1), c('commands', 1)], true),
    '已读取文件，已搜索代码，执行了命令',
  )
  eq(
    '文案边界：四类加「等」',
    stepGroupTitle([c('read', 1), c('search', 1), c('commands', 1), c('code', 1)], true).endsWith('等'),
    true,
  )
  eq(
    '文案边界：十类仍只列前三 + 等',
    stepGroupTitle(
      ['read', 'readImage', 'search', 'write', 'edit', 'commands', 'code', 'webSearch', 'webFetch', 'subagents']
        .map((kind) => c(kind, 10)),
      true,
    ),
    '已读取文件，已读取图片，已搜索代码等',
  )
  const many = ['tools', 'subagents', 'webFetch', 'webSearch', 'code', 'commands', 'edit', 'write'].map((kind) => c(kind, 5))
  eq('文案边界：八个同次数类别按首次出现取前三', stepGroupTitle(many, true), '已调用工具，已协调子智能体，已访问网页等')
  eq(
    '文案边界：未结束时报 running，不看 counts 里有没有这一类',
    stepGroupTitle([c('read', 9)], false, 'commands'),
    '正在运行命令',
  )
  eq('文案边界：空 counts + 未结束 → 正在分析请求', stepGroupTitle([], false), '正在分析请求')
  eq('文案边界：空 counts + 已结束 → 已完成分析', stepGroupTitle([], true), '已完成分析')
  eq(
    '文案边界：第一类不以「已」开头时第二个也不省',
    stepGroupTitle([c('edit', 1), c('read', 1)], true),
    '修改了文件并已读取文件',
  )
  eq(
    '文案边界：两类都不以「已」开头',
    stepGroupTitle([c('edit', 1), c('questions', 1)], true),
    '修改了文件并向用户提出了问题',
  )
}

// ── 21) 轮中途插话（steering）留在原来那一轮里，且是二级分组的边界 ────────────────
{
  const entries = [
    { ...user('做这件事'), ts: 1000 },
    { ...think('想一'), ts: 1200 },
    { kind: 'user', id: nextId(), text: '顺便也看下那边', steering: true, ts: 5000 },
    { ...tool('read'), ts: 5400 },
    { ...reply('都做完了'), ts: 6000 },
  ]
  const rounds = roundInfos(entries)
  eq('插话：不另起一轮（对照 dsh 的 steering 节点）', rounds.length, 1)
  eq('插话：这一轮仍从第一条用户消息起', rounds[0].startIndex, 0)
  eq('插话：这一轮到末尾才结束', rounds[0].endIndex, 4)
  const g = group(entries)
  eq('插话：它把前面的组封掉', g.groups[0].closed, true)
  eq('插话：前面的组到思考为止', g.groups[0].endIndex, 1)
  eq('插话：自己不进组', g.at.get(2) === undefined, true)
  eq('插话：后面的工具另起一组', g.groups[1].startIndex, 3)
  // 计时不该被插话归零：turnStartedAt 跳过 steering，取的是第一条用户消息那一刻
  eq('插话：计时起点不被它重置（turnStartedAt 跳过 steering）', turnStartedAt(entries), 1000)
}

// ── 22) 轮尾标记与长度上限都是独立节点（封前面的组、自己不进组） ──────────────────
{
  const ended = [user('跑一下'), think('想'), { kind: 'turn-end', id: nextId(), reason: 'error' }]
  const g = group(ended)
  eq('轮尾标记：把前面的组封掉', g.groups[0].closed, true)
  eq('轮尾标记：自己不进组', g.at.get(2) === undefined, true)

  const capped = [user('写长的'), think('想'), tool('read'), { kind: 'turn-max-tokens', id: nextId() }]
  const g2 = group(capped)
  eq('长度上限：封掉前面那组', g2.groups[0].closed, true)
  eq('长度上限：自己不进组', g2.at.get(3) === undefined, true)

  const sys = [user('跑一下'), think('想'), system('错误：请求失败'), tool('read')]
  const g3 = group(sys)
  eq('system：既不封组也不进组', g3.groups.length, 1)
  eq('system：同一组跨越它（前后两条过程留在一起）', [g3.groups[0].startIndex, g3.groups[0].endIndex].join(','), '1,3')
}

// ── 23) 独立节点表：整轮折叠不许藏的那几种 ───────────────────────────────────────
{
  const wanted = ['user', 'plan', 'system', 'turn-end', 'turn-max-tokens']
  eq('独立节点表：五类都在（对照 dsh 的 TURN_PROCESS_INDEPENDENT_KINDS）',
    wanted.every((kind) => TURN_PROCESS_INDEPENDENT.has(kind)), true)
  eq('独立节点表：思考与工具不在表里（它们就是过程本身）',
    TURN_PROCESS_INDEPENDENT.has('thinking') || TURN_PROCESS_INDEPENDENT.has('tool'), false)
  eq('独立节点表：正文 text 不在表里（它是过程的收口信号，不是独立节点）',
    TURN_PROCESS_INDEPENDENT.has('text'), false)
}

// ── 24) 「准备中」：模型吐了工具名、参数还没到齐（对照 dsh 的 preparing 阶段） ────
{
  const prep = (name) => ({
    kind: 'tool',
    id: nextId(),
    call: { callId: '', name, argsText: '', status: 'preparing' },
  })
  const g = group([user('干活'), prep('read')], true)
  eq('准备中：类别照算（它也计一次调用）', g.groups[0].running, 'read')
  eq('准备中：组上带 preparing 标记', g.groups[0].preparing, true)
  eq(
    '准备中：组头文案用「准备…」',
    stepGroupTitle(g.groups[0].counts, false, g.groups[0].running, g.groups[0].preparing),
    '准备读取文件',
  )
  eq('准备中：参数没到齐，详情为空（「准备读取文件 · read」是废话）', g.groups[0].runningDetail, undefined)
  deep('准备中：类别计数把它算进去', g.groups[0].counts, [{ kind: 'read', count: 1 }])

  // 通用类别才补一句工具名（dsh 的原话：只有「准备调用工具」在标准模式中追加协议工具名）
  const unknown = group([user('干活'), prep('weird_tool')], true)
  eq('准备中：通用类别补一句工具名', unknown.groups[0].runningDetail, 'weird_tool')
  eq(
    '准备中：通用类别的组头文案',
    stepGroupTitle(unknown.groups[0].counts, false, unknown.groups[0].running, unknown.groups[0].preparing),
    '准备调用工具',
  )

  // 升级成 running 之后就回到「正在…」（adapter 是就地升级，同一个条目）
  const upgraded = group([user('干活'), toolRunning('read')], true)
  eq('升级后：没有 preparing 标记', upgraded.groups[0].preparing, undefined)
  eq(
    '升级后：文案回到「正在…」',
    stepGroupTitle(upgraded.groups[0].counts, false, upgraded.groups[0].running, upgraded.groups[0].preparing),
    '正在读取文件',
  )

  // 十四个类别各有一句准备文案（照 dsh 的 locale.ts:22-34，另加 dsc 自己的 browser）
  const prepareLabels = {
    read: '准备读取文件', readImage: '准备读取图片', search: '准备搜索代码', write: '准备写入文件',
    edit: '准备编辑文件', commands: '准备运行命令', code: '准备运行代码', webSearch: '准备搜索网页',
    webFetch: '准备访问网页', browser: '准备浏览网页', subagents: '准备协调子智能体',
    plan: '准备更新计划', questions: '准备提问', tools: '准备调用工具',
  }
  for (const [kind, want] of Object.entries(prepareLabels)) {
    eq(`准备文案：${kind}`, stepGroupTitle([], false, kind, true), want)
  }
  eq('准备文案：没有工具在跑时仍是「正在分析请求」', stepGroupTitle([], false, undefined, true), '正在分析请求')
}

// ── 25) 模型重试：二级分组的边界，但整轮折叠仍包含它 ─────────────────────────────
{
  const retry = { kind: 'model-retry', id: nextId(), attempt: 2, text: 'HTTP 429' }
  const entries = [user('干活'), think('想'), retry, tool('read')]
  const g = group(entries, true)
  eq('模型重试：它把前面的组封掉', g.groups[0].closed, true)
  eq('模型重试：自己不进组', g.at.get(2) === undefined, true)
  eq('模型重试：后面的过程另起一组', g.groups[1].startIndex, 3)
  eq(
    '模型重试：**不在**独立节点表里（dsh 的规矩是整轮折叠仍包含重试行）',
    TURN_PROCESS_INDEPENDENT.has('model-retry'),
    false,
  )
}

// ── 打印 ─────────────────────────────────────────────────────────────────────────
const passed = checks.filter((entry) => entry.ok).length
const failed = checks.filter((entry) => !entry.ok)
process.stdout.write('[step-groups-check] 直接跑 src/renderer/process-groups.ts（type stripping）\n')
for (const entry of checks) {
  process.stdout.write(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}\n`)
  if (!entry.ok && entry.detail !== '') process.stdout.write(`      实测：${entry.detail}\n`)
}
process.stdout.write(`[step-groups-check] 断言 ${String(checks.length)} 条，通过 ${String(passed)} 条，失败 ${String(failed.length)} 条\n`)
process.exit(failed.length === 0 ? 0 : 1)
