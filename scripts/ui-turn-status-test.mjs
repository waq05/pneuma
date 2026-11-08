/**
 * 直播行与底部状态栏的用时口径（2026-11-08 改版）。
 *
 * 五条钉子：
 *   ① `liveActivity` 仍然一句话说清「此刻在干什么」；`covered` 这一位已经删掉——它原本是
 *      「有阶段组头就把直播行藏起来」的判据，那条禁令拆了，它就没有消费方。
 *   ② 直播行是**一行**：转圈 + 状态 + 用时 + 三点，自己带一个每秒时钟（不带着消息流重排），
 *      整句挂 `data-shimmer` 扫光；第二行与旧分割线（`turn-status-rule` / `turn-status-activity`）
 *      不许回来，回退时这里亮红灯。
 *   ③ 有阶段组头时**也要画**（对齐 dsh 的两行），`ui.tsx` 里不许再出现
 *      `!stepGrouping.groups.some(...)` 这个旧条件。
 *   ④ 样式上它是横贯正文列的一条尾巴：顶 0.5px 分隔线、比普通轮间距小一档。
 *   ⑤ 底部状态栏的用时**保留**（滚到上面去时它是唯一还看得见的读数）；右栏拉宽时正文保底
 *      480（样式）且拖拽上限按窗口现算（dock.tsx 的 dockDragLimit）。
 *
 * 运行：node scripts/ui-turn-status-test.mjs
 *
 * @module dsc/scripts/ui-turn-status-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveUiHalf } from './_check-runner.mjs'

// 界面半的新旧根由 resolveUiHalf 判：transcript 已搬进宿主包，旧根那条只剩兜底。
const UI = resolveUiHalf('transcript')

// 零依赖模块（timing.ts 会 import 平台种子库，Node 解析不了工作区别名）
const timing = await import(
  new URL('../' + UI + '/activity.ts', import.meta.url).href
)

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

console.log('\n[1] liveActivity：一句话说清此刻在干什么')
{
  const running = [
    { id: 1, kind: 'user', text: '看看', ts: 1 },
    {
      id: 2,
      kind: 'tool',
      call: { id: 'c1', name: 'bash', status: 'running', args: '{}' },
    },
  ]
  const live = timing.liveActivity(running, 'working')
  check('工具在跑：文案只有一句「正在调用 bash」', live?.text === '正在调用 bash', String(live?.text))

  const preparing = [{ id: 1, kind: 'tool', call: { id: 'c2', name: 'write', status: 'preparing', args: '{}' } }]
  check('准备阶段说「正在准备 write」', timing.liveActivity(preparing, 'working')?.text === '正在准备 write')

  const thinking = [{ id: -1, kind: 'thinking', text: '嗯' }]
  const think = timing.liveActivity(thinking, 'thinking')
  check('思考阶段一句话', think?.text === '正在分析请求', JSON.stringify(think))

  check('空闲时没有直播行', timing.liveActivity([], 'idle') === null)
  const approval = timing.liveActivity([], 'awaiting-approval')
  check('等确认时说「等待你的确认」', approval?.text === '等待你的确认')
  check('返回的是单行文本，不再是 stage/activity 两段', live !== null && !('stage' in live) && !('activity' in live))
  // covered 是 2026-11-08 之前的「组头在场就藏起来」判据，拆禁令后没有消费方，一并删掉。
  check('不再有 covered 这一位', live !== null && !('covered' in live))
}

console.log('\n[2] 直播行：一行、自带时钟、挂扫光')
{
  const foot = read('../' + UI + '/rows/foot.tsx')
  check('不再渲染分割线', !foot.includes('turn-status-rule'))
  check('不再有第二行的活动名', !foot.includes('turn-status-activity'))
  check('自己带一个每秒时钟（用时跟着这一行走，不带着消息流重排）',
    foot.includes('setInterval') && foot.includes('LIVE_CLOCK_INTERVAL_MS'))
  check('收得到本轮起点 startedAt', /startedAt: number \| null/.test(foot))
  check('行面文案是「状态 + 用时」一句', foot.includes("t('transcript.status.withDuration'"))
  check('整句挂了扫光属性', /data-shimmer=\{line\}/.test(foot))
  check('具体活动收进悬停提示（行面不重复组头）', foot.includes('title={props.hint}'))

  // 2026-11-08 拆掉的禁令：以前「有未收口的阶段组头就不画这条」，dsh 是两行并存。
  const flow = read('../' + UI + '/ui.tsx')
  check('有组头时也画直播行', !flow.includes('!stepGrouping.groups.some'))
  check('把本轮起点传给直播行', flow.includes('startedAt={startedAt}'))
  check('等确认时不说「工作中」', flow.includes("turnState === 'awaiting-approval'"))
}

console.log('\n[3] 样式：横向一行 + 顶部分隔线 + 扫光')
{
  const css = read('../src/packages/ui-renderer/ui/styles/legacy/views.css')
  const block = css.slice(css.indexOf('.turn-status {'), css.indexOf('.turn-status {') + 600)
  check('.turn-status 是横向 flex', /display: flex/.test(block) && !/flex-direction: column/.test(block), block.slice(0, 200))
  check('顶上有 0.5px 分隔线（对齐 dsh 的 runningDivider）', /border-top: 0\.5px solid var\(--dsc-stroke-3\)/.test(block))
  check('分隔线横贯正文列', /align-self: stretch/.test(block))
  check('与上方间距比普通轮间距小一档', /margin-top: calc\(12px - var\(--dsc-turn-gap\)\)/.test(block))
  check('分割线样式已删除', !css.includes('.turn-status-rule'))
  check('第二行的活动名样式已删除', !css.includes('.turn-status-activity'))
  // 扫光要挂两处：正常态那条规则 + reduced-motion 里的降级。
  const shimmerHits = css.split('.turn-status-stage[data-shimmer]::after').length - 1
  check('扫光规则与少动降级都挂上了直播行', shimmerHits >= 2, `命中 ${shimmerHits} 次`)
}

console.log('\n[4] 底部状态栏不报本轮用时（对齐 dsh 的 ActivityPill）')
{
  const statusbar = read('../src/packages/ui-statusbar/ui/ui.tsx')
  check('状态栏不再读 turnStartedAt', !statusbar.includes('readTurnStartedAt'))
  // 第一轮进行中时 steps 还是 0：那一档不再有「用时」可报，于是恢复成「步数为 0 整段不画」。
  check('主文案里没有「用时」', !statusbar.includes('statusbar.turn.elapsed'))
  check('步数为 0 时整段不画', statusbar.includes('Number(steps) > 0 &&') || statusbar.includes('Number(steps) > 0)'))
  check('卡片里没有「本轮用时（进行中）」', !statusbar.includes('statusbar.card.elapsedRunning'))
  check(
    '卡片仍列模型用时 / 工具调用用时 / 首 token / 速度',
    ['statusbar.card.modelTime', 'statusbar.card.toolTime', 'statusbar.card.ttft', 'statusbar.card.tps']
      .every((key) => statusbar.includes(key)),
  )
  // 快照里那个为状态栏准备的字段没有消费方了，一并删掉（宿主也不再填）。
  const contract = read('../src/contract/runtime.ts')
  check('契约里不再有 turnStartedAt', !contract.includes('turnStartedAt'))
  const host = read('../src/packages/transcript/index.ts')
  check('宿主快照不再填 turnStartedAt', !host.includes('turnStartedAt'))
  const zh = read('../src/packages/ui-statusbar/locale/ui.zh.json')
  check(
    '两条没用的文案键已删',
    !zh.includes('statusbar.turn.elapsed') && !zh.includes('statusbar.card.elapsedRunning'),
  )
}

console.log('\n[5] 右栏拉宽不挤扁正文')
{
  const css = read('../src/packages/ui-renderer/ui/styles/legacy/views.css')
  check('正文有 480 的最小宽', css.includes('min-width: min(480px, 100%)'))
  const dock = read('../src/packages/ui-dockkit/ui/dock.tsx')
  check('拖拽上限按窗口现算', dock.includes('dockDragLimit') && dock.includes('THREAD_FLOOR'))
  check('上限里扣掉了侧栏宽', dock.includes('window.innerWidth - sidebarWidth() - THREAD_FLOOR'))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
