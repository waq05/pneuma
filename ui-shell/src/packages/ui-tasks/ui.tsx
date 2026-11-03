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
import { defineUiPlugin } from '@dsc/ui'

export default defineUiPlugin({
  name: '任务与目标',
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
        ? '自动续跑中'
        : '已建立（未上膛）'
      : goal.phase === 'paused'
        ? '已暂停'
        : goal.phase === 'blocked'
          ? '已阻塞'
          : '已完成'
  const action = (name: 'pause' | 'resume' | 'clear' | 'extend', tip: string): void => {
    void channel
      .invoke('goalAction', [name])
      .then(() => toastOk(tip))
      .catch((reason: unknown) => toastErr(`目标操作失败：${reason instanceof Error ? reason.message : String(reason)}`))
  }
  return (
    <div className="entry-row">
      <div className={`goal-bar phase-${goal.phase}`}>
        <span className="goal-label">目标</span>
        <span className="goal-text" title={goal.blockedReason ?? goal.objective}>
          {goal.objective}
        </span>
        <span className="goal-state">
          {phase} · {goal.rounds}/{goal.maxRounds} 轮
        </span>
        {goal.phase === 'active' ? (
          <button
            type="button"
            className="goal-btn"
            onClick={() => action('pause', '目标已暂停')}
            title="暂停自动续跑（不会打断当前这一轮）"
          >
            暂停
          </button>
        ) : goal.phase !== 'complete' ? (
          <button type="button" className="goal-btn" onClick={() => action('resume', '目标已继续')} title="继续自动续跑">
            继续
          </button>
        ) : null}
        {goal.phase === 'blocked' && goal.blockedReason?.startsWith('轮次已达上限') === true ? (
          <button type="button" className="goal-btn" onClick={() => action('extend', '已放宽轮次')} title="再加 8 轮">
            放宽轮次
          </button>
        ) : null}
        <button type="button" className="goal-btn ghost" onClick={() => action('clear', '目标已清除')} title="清空目标">
          ✕
        </button>
      </div>
    </div>
  )
}
