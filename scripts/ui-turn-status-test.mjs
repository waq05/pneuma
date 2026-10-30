/**
 * 状态行只留一行、用时挪到底部（2026-10-30 报障）。
 *
 * 三条钉子：
 *   ① 工具在跑时 `liveActivity` 明确说「这一条由过程组头负责」（covered），界面据此不再画第二行；
 *      没有组头可依的阶段（思考 / 整理回复 / 等确认）仍然由它兜底。
 *   ② 状态行组件里不存在第二行与分割线（`turn-status-rule` / `turn-status-activity` 已删掉），
 *      样式是横向 flex 而不是纵向 column——回退成两行时这里会亮红灯。
 *   ③ 用时在底部状态栏：宿主快照里带 `turnStartedAt`，状态栏读它并画「· 用时」。
 *   ④ 右栏拉宽时正文保底 480（样式）且拖拽上限按窗口现算（dock.tsx 的 dockDragLimit）。
 *
 * 运行：node scripts/ui-turn-status-test.mjs
 *
 * @module dsc/scripts/ui-turn-status-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 零依赖模块（timing.ts 会 import 平台种子库，Node 解析不了工作区别名）
const timing = await import(
  new URL('../ui-shell/src/plugins/transcript/activity.ts', import.meta.url).href
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

console.log('\n[1] liveActivity：工具在跑时交给组头，其余阶段一句话')
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
  check('工具在跑：covered = true（组头已经在说同一件事）', live?.covered === true, JSON.stringify(live))
  check('工具在跑：文案只有一句「正在调用 bash」', live?.text === '正在调用 bash', String(live?.text))

  const preparing = [{ id: 1, kind: 'tool', call: { id: 'c2', name: 'write', status: 'preparing', args: '{}' } }]
  check('准备阶段说「正在准备 write」', timing.liveActivity(preparing, 'working')?.text === '正在准备 write')

  const thinking = [{ id: -1, kind: 'thinking', text: '嗯' }]
  const think = timing.liveActivity(thinking, 'thinking')
  check('思考阶段：一句话且不交给组头', think?.text === '正在分析请求' && think.covered === false, JSON.stringify(think))

  check('空闲时没有状态行', timing.liveActivity([], 'idle') === null)
  const approval = timing.liveActivity([], 'awaiting-approval')
  check('等确认时说「等待你的确认」', approval?.text === '等待你的确认')
  check('返回的是单行文本，不再是 stage/activity 两段', live !== null && !('stage' in live) && !('activity' in live))
}

console.log('\n[2] 状态行组件只剩一行')
{
  const foot = read('../ui-shell/src/plugins/transcript/rows/foot.tsx')
  check('不再渲染分割线', !foot.includes('turn-status-rule'))
  check('不再有第二行的活动名', !foot.includes('turn-status-activity'))
  check('不再自己算用时（没有每秒 interval）', !foot.includes('setInterval'))
  check('接受的是单行文本 text', /TurnStatusLine\(props: \{ text: string \}\)/.test(foot), foot.slice(0, 0))
}

console.log('\n[3] 样式是横向一行')
{
  const css = read('../ui-shell/src/legacy/views.css')
  const block = css.slice(css.indexOf('.turn-status {'), css.indexOf('.turn-status {') + 400)
  check('.turn-status 是横向 flex', /display: flex/.test(block) && !/flex-direction: column/.test(block), block.slice(0, 200))
  check('分割线样式已删除', !css.includes('.turn-status-rule'))
  check('第二行的活动名样式已删除', !css.includes('.turn-status-activity'))
}

console.log('\n[4] 用时在底部状态栏')
{
  const statusbar = read('../ui-shell/src/plugins/statusbar/ui.tsx')
  check('状态栏读 turnStartedAt', statusbar.includes('readTurnStartedAt'))
  // 第一轮进行中时 steps 还是 0，此时不再摆「0 轮 0 步」，只报用时——分隔符是条件渲染的，
  // 所以断「用时 {elapsed}」这个本体，外加「steps 为 0 也画」这条行为。
  check('主文案里有「用时」', /用时 \{elapsed\}/.test(statusbar))
  check('第一轮（steps 为 0）也报用时', statusbar.includes('props.steps > 0'))
  check('悬浮卡里有本轮用时一行', statusbar.includes('本轮用时（进行中）'))
  const contract = read('../src/contract/runtime.ts')
  check('契约里有 turnStartedAt 字段', contract.includes('turnStartedAt?: number'))
  const host = read('../src/plugins/transcript.ts')
  check('宿主快照填了 turnStartedAt', host.includes('turnStartedAt: turnStartOf('))
}

console.log('\n[5] 右栏拉宽不挤扁正文')
{
  const css = read('../ui-shell/src/legacy/views.css')
  check('正文有 480 的最小宽', css.includes('min-width: min(480px, 100%)'))
  const dock = read('../ui-shell/src/ui-dockkit/dock.tsx')
  check('拖拽上限按窗口现算', dock.includes('dockDragLimit') && dock.includes('THREAD_FLOOR'))
  check('上限里扣掉了侧栏宽', dock.includes('window.innerWidth - sidebarWidth() - THREAD_FLOOR'))
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`)
process.exit(failures === 0 ? 0 : 1)
