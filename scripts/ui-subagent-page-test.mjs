/**
 * 子智能体页签「改用主会话那套行渲染」的确定性探针。
 *
 * 背景：右栏的子智能体页签原来把队友会话条目直排成 `<p class="peek-*">`（简版），
 * 与主会话的消息流是两套观感。这一批让它走**同一套行渲染**（markdown / 思考 / 工具卡 /
 * 子代理卡 / 计划卡 / system 行），只读；数据仍是 `peekTranscript`（宿主用同一个 Transcript
 * 类重放队友会话文件）。
 *
 * 两条渲染组件之间不 import（插件 bundle 各自独立），跨插件只走服务表：
 * transcript 插件 `ui.provide('transcriptFlow', …)`，team 插件 `useService('transcriptFlow')`。
 * 服务缺席时团队页签退回原来的 {@link PeekView}（不许白屏）。
 *
 * 四段（每段一条负向锚点，改掉锚点该段必须红）：
 *   [1] `transcriptFlow` 服务的两端：transcript provide 有、team useService 有（含 Component 字段）
 *   [2] 兜底仍在：PeekView 与它那三条 `settings-empty` 人话没被删，且是服务缺席时的出口
 *   [3] 轮询只在队友 working 时开、卸载清定时器、`document.hidden` 不发请求
 *   [4] 页签头部不再只画文件名：角色 / 状态 / 轮数 / 时长都上屏（拿不到名册行才只留文件名）
 *
 * 模板同 `scripts/ui-transcript-render-test.mjs`：Node 类型擦除直读零依赖 `.ts`；
 * `.tsx` 读不了，所以钉源码文本 + 走构建产物（`lib/ui/plugins/<id>/client.js`）。
 *
 * 运行：pnpm -C ui-shell build && node scripts/ui-subagent-page-test.mjs
 *
 * @module dsc/scripts/ui-subagent-page-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 零依赖直读一个 `.ts`（Node 类型擦除），证明本探针走的就是模板那条路。
const { seatPlan } = await import(
  new URL('../ui-shell/src/plugins/transcript/process-groups.ts', import.meta.url).href
)

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

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

const transcript = read('ui-shell/src/plugins/transcript/ui.tsx')
const team = read('ui-shell/src/plugins/team/ui.tsx')

// 模板那条零依赖 .ts 导入确实可用（本探针只拿它做一次存在性自检，不重复测它的语义）。
check('零依赖 .ts 可直读（process-groups.ts 的 seatPlan 是个函数）', typeof seatPlan === 'function')

console.log('[1] transcriptFlow 服务的两端（provide / useService）')
{
  // transcript 端：provide，且交出去的是 { Component, slot } 这个形状（组件本身当值传）。
  check(
    'transcript 插件 provide 了 transcriptFlow（组件 + 槽名）',
    transcript.includes("ui.provide<TranscriptFlowService>('transcriptFlow'") && transcript.includes('Component: SubagentFlow'),
  )
  // team 端：useService 读它，服务名常量的值是 'transcriptFlow'。
  check(
    'team 插件 useService 读 transcriptFlow',
    team.includes("const TRANSCRIPT_FLOW_SERVICE = 'transcriptFlow'") &&
      team.includes('useService<TranscriptFlowService>(TRANSCRIPT_FLOW_SERVICE)'),
  )
  // 两端都认 Component 字段：团队那边经 <flow.Component …/> 渲染只读条目流。
  check('team 用 flow.Component 渲染只读条目流', team.includes('<flow.Component entries={entries} sessionKey={file} />'))
}

console.log('[2] 兜底仍在：服务缺席退回 PeekView（不白屏、不删）')
{
  check('PeekView 组件还在', team.includes('function PeekView('))
  check(
    'PeekView 的三条 settings-empty 人话没被删',
    team.includes('读不了运行记录：') && team.includes('正在读运行记录…') && team.includes('它还没开始干活。'),
  )
  check(
    '服务缺席时确实是 PeekView 出口（flow === undefined ? PeekView : FlowHost）',
    /flow === undefined\s*\?\s*<PeekView/.test(team) && team.includes('<FlowHost flow={flow} file={file} working={working} />'),
  )
}

console.log('[3] 轮询：只在 working 开、卸载清理、页面不可见不发请求')
{
  const hookStart = team.indexOf('function usePeekTranscript(')
  const hookEnd = team.indexOf('function PeekView(', hookStart)
  const hook = hookStart === -1 || hookEnd === -1 ? '' : team.slice(hookStart, hookEnd)
  check('有 usePeekTranscript 这条读取/轮询的 hook', hook !== '')
  check('轮询间隔是 2-3 秒一档（PEEK_POLL_MS）', /const PEEK_POLL_MS = \d+/.test(team))
  check('只在 working 时才起定时器（!working 直接返回，不轮询）', hook.includes('if (!working)'))
  check(
    '定时器在「working 才开」那条分支之后',
    hook.indexOf('if (!working)') !== -1 && hook.indexOf('if (!working)') < hook.indexOf('window.setInterval('),
  )
  check('卸载 / 依赖变化清定时器', hook.includes('window.clearInterval(timer)'))
  check('页面不可见时不发请求（document.hidden）', hook.includes('document.hidden'))
  // 两条出口（PeekView 与 FlowHost）共用同一份读取/轮询。
  check('PeekView 与 FlowHost 共用这份 hook', (team.match(/usePeekTranscript\(file, working\)/g) ?? []).length === 2)
}

console.log('[4] 页签头部不再只画文件名（角色 / 状态 / 轮数 / 时长）')
{
  check('头部标题：页签名 → 名册名 → 文件名三级回落', team.includes('const title = tab.label ?? mate?.name ?? basename(file)'))
  check('头部画角色（sub-tab-role）', team.includes('className="sub-tab-role"') && team.includes('{mate.role}'))
  check('头部画状态（sub-tab-state，带状态类）', team.includes('sub-tab-state') && team.includes('STATE_LABEL[mate.state]'))
  check('头部画轮数', team.includes('第 {mate.rounds} 轮'))
  check('头部画时长（复用 UsedTime）', /<UsedTime mate=\{mate\} \/>/.test(team))
  // 名册行匹配不到时（mate === undefined）整块元信息不画——不许编造。
  check('匹配不到名册行时元信息整块不画', team.includes('{mate === undefined ? null : ('))
  check('按 tab.path 匹配名册行（含分隔符归一的 sameFile）', team.includes('sameFile(row.file, file)') && team.includes('function sameFile('))
}

console.log('[5] 构建产物（改完壳要重建）')
{
  const teamBundle = `${root}lib/ui/plugins/team/client.js`
  const transcriptBundle = `${root}lib/ui/plugins/transcript/client.js`
  if (!existsSync(teamBundle) || !existsSync(transcriptBundle)) {
    console.log('  SKIP  插件产物不在——先跑 pnpm -C ui-shell build')
  } else {
    const t = readFileSync(teamBundle, 'utf8')
    const tr = readFileSync(transcriptBundle, 'utf8')
    check('team 产物含 transcriptFlow 服务名与 useService', t.includes('transcriptFlow') && t.includes('useService'))
    check('team 产物含头部元信息锚点（sub-tab-role / sub-tab-state）', t.includes('sub-tab-role') && t.includes('sub-tab-state'))
    check('team 产物含轮询与兜底文案', t.includes('peekTranscript') && t.includes('它还没开始干活。'))
    check('transcript 产物含 transcriptFlow 与只读流槽名', tr.includes('transcriptFlow') && tr.includes('shell.subagent.flow') && tr.includes('subagent-flow'))
  }
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
