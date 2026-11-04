/**
 * 内置插件：会话目标条（对照旧桌面界面 GoalBar 的那一块）。
 *
 * 数据来自宿主快照的 `surfaces.goal`（goal 插件登记的那块），动作走界面通道的
 * `goalAction`（在放行面上）。没设目标时整条不渲染，与旧界面同一口径——「没有数据就不画」。
 *
 * 挂在 `shell.composer` 槽里、审批卡之后输入框之前（order 22，见桌面端 composer-zone
 * 的顺序：审批 → 计划 → 提问 → 目标条 → 输入框）。
 *
 * **任务清单条（TaskDock）已撤**：状态面板的「进程」区（`plugins/status`）报的是同一份
 * `surfaces.todos`，而且带聚焦窗口、折叠桶与预览卡——同一件事留两个入口就是两份要维护的
 * 真相。旧任务条上那颗「清空清单」没丢，搬进了面板的进程区（那里是清单现在唯一的脸）。
 *
 * @module dsc-ui-shell/plugins/tasks
 */
import { type ReactNode } from 'react'
import { toastErr, toastOk, useHostChannel, useHostSelector, type GoalView } from '@dsc/ui'
import { createT, defineUiPlugin } from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
// 构建时 JSON 直接内联进 `client.js`，运行期不需要宿主下发文件。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

export default defineUiPlugin({
  name: t('tasks.plugin.name'),
  apply(ui) {
    // order 22：排在审批/计划/提问卡（prompt，order 10）之后、输入框（composer，order 50）之前。
    ui.slots.register('shell.composer', { id: 'tasks.goal', order: 22 }, GoalBarSlot)
  },
})

/** 从快照里取会话目标面；没设目标（宿主给 null）或缺面时返回 null。 */
function readGoal(snapshot: Record<string, unknown> | null): GoalView | null {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return null
  const goal = (surfaces as Record<string, unknown>)['goal']
  return typeof goal === 'object' && goal !== null ? (goal as GoalView) : null
}

/** 会话目标条：目标内容 + 状态（自动续跑中/已建立/已暂停/已阻塞/已完成）+ 轮数 + 动作按钮。 */
function GoalBarSlot(): ReactNode {
  const goal = useHostSelector(readGoal)
  const channel = useHostChannel()
  if (goal === null) return null
  const phase =
    goal.phase === 'active'
      ? goal.armed
        ? t('tasks.phase.armed')
        : t('tasks.phase.disarmed')
      : goal.phase === 'paused'
        ? t('tasks.phase.paused')
        : goal.phase === 'blocked'
          ? t('tasks.phase.blocked')
          : t('tasks.phase.complete')
  const action = (name: 'pause' | 'resume' | 'clear' | 'extend', tip: string): void => {
    void channel
      .invoke('goalAction', [name])
      .then(() => toastOk(tip))
      .catch((reason: unknown) =>
        toastErr(t('tasks.actionFailed', { message: reason instanceof Error ? reason.message : String(reason) })),
      )
  }
  return (
    <div className="entry-row">
      <div className={`goal-bar phase-${goal.phase}`}>
        <span className="goal-label">{t('tasks.goal.label')}</span>
        <span className="goal-text" title={goal.blockedReason ?? goal.objective}>
          {goal.objective}
        </span>
        <span className="goal-state">{t('tasks.state', { phase, rounds: goal.rounds, max: goal.maxRounds })}</span>
        {goal.phase === 'active' ? (
          <button
            type="button"
            className="goal-btn"
            onClick={() => action('pause', t('tasks.toast.paused'))}
            title={t('tasks.tip.pause')}
          >
            {t('tasks.btn.pause')}
          </button>
        ) : goal.phase !== 'complete' ? (
          <button type="button" className="goal-btn" onClick={() => action('resume', t('tasks.toast.resumed'))} title={t('tasks.tip.resume')}>
            {t('tasks.btn.resume')}
          </button>
        ) : null}
        {goal.phase === 'blocked' && goal.blockedReason?.startsWith('轮次已达上限') === true ? ( // i18n-keep 宿主写进 blockedReason 的中文前缀，用来认「轮次已达上限」这一种阻塞，不能跟着界面语言变
          <button type="button" className="goal-btn" onClick={() => action('extend', t('tasks.toast.extended'))} title={t('tasks.tip.extend', { count: 8 })}>
            {t('tasks.btn.extend')}
          </button>
        ) : null}
        <button type="button" className="goal-btn ghost" onClick={() => action('clear', t('tasks.toast.cleared'))} title={t('tasks.tip.clear')}>
          ✕
        </button>
      </div>
    </div>
  )
}
