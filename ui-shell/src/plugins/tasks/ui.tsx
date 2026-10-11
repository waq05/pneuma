/**
 * 内置插件：任务清单条与会话目标条（对照旧桌面界面 TaskDock.tsx 的两块）。
 *
 * 数据都来自宿主快照的 surfaces（todo 贡献 `todos`、goal 贡献 `goal`——
 * `src/core/todo.ts` / `src/core/goal.ts` 各自登记的那块），动作走界面通道的
 * `clearTodos` / `goalAction`（都在放行面上）。没有任务 / 没设目标时整条不渲染，
 * 与旧界面同一口径——「没有数据就不画」。
 *
 * 挂在 `shell.composer` 槽里、审批卡之后输入框之前（order 20/22，见桌面端
 * composer-zone 的顺序：审批 → 计划 → 提问 → 目标条 → 任务条 → 输入框）。
 *
 * @module dsc-ui-shell/plugins/tasks
 */
import { useState, type ReactNode } from 'react'
import { toastErr, toastOk, useHostChannel, useHostSelector, type GoalView, type TodoView } from '@dsc/ui'
import { defineUiPlugin } from '@dsc/ui'

/** 任务清单勾选符号（桌面端 MARK 同款）。 */
const MARK: Readonly<Record<string, string>> = { pending: '○', running: '◐', done: '●', cancelled: '✕' }

export default defineUiPlugin({
  name: '任务与目标',
  apply(ui) {
    // order 20/22：排在审批/计划/提问卡（prompt，order 10）之后、输入框（composer，order 50）之前。
    ui.slots.register('shell.composer', { id: 'tasks.dock', order: 20 }, TaskDock)
    ui.slots.register('shell.composer', { id: 'tasks.goal', order: 22 }, GoalBarSlot)
  },
})

/** 从快照里取任务清单面；没有这个面（老宿主）给 null。 */
function readTodos(snapshot: Record<string, unknown> | null): TodoView | null {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return null
  const todos = (surfaces as Record<string, unknown>)['todos']
  if (typeof todos !== 'object' || todos === null) return null
  const record = todos as Record<string, unknown>
  if (!Array.isArray(record['items'])) return null
  return todos as TodoView
}

/** 从快照里取会话目标面；没设目标（宿主给 null）或缺面时返回 null。 */
function readGoal(snapshot: Record<string, unknown> | null): GoalView | null {
  const surfaces = snapshot?.['surfaces']
  if (typeof surfaces !== 'object' || surfaces === null) return null
  const goal = (surfaces as Record<string, unknown>)['goal']
  return typeof goal === 'object' && goal !== null ? (goal as GoalView) : null
}

/** 任务清单条：done/total + 进度条 + 当前步骤，展开看全部（子任务缩进），尾部「清空清单」。 */
function TaskDock(): ReactNode {
  const todos = useHostSelector(readTodos)
  const channel = useHostChannel()
  const [open, setOpen] = useState(false)
  if (todos === null || todos.items.length === 0) return null
  const percent = todos.total > 0 ? Math.round((todos.done / todos.total) * 100) : 0
  const clear = (): void => {
    void channel
      .invoke('clearTodos', [])
      .then(() => toastOk('任务清单已清空'))
      .catch((reason: unknown) => toastErr(`清空失败：${reason instanceof Error ? reason.message : String(reason)}`))
  }
  return (
    <div className="entry-row">
      <div className={`task-dock${open ? ' open' : ''}`}>
        <button
          type="button"
          className="task-dock-head"
          onClick={() => {
            setOpen((current) => !current)
          }}
          title={open ? '收起任务清单' : '展开看全部任务'}
        >
          <span className="task-count">
            任务 {todos.done}/{todos.total}
          </span>
          <span className="task-progress">
            <span className="task-progress-fill" style={{ width: `${String(percent)}%` }} />
          </span>
          {open ? null : <span className="task-active">{todos.active ?? '没有在做的步骤'}</span>}
          <span className="task-caret">{open ? '▴' : '▾'}</span>
        </button>
        {open ? (
          <div className="task-dock-body">
            <ul className="task-list">
              {todos.items.map((item) => (
                <li key={item.id} className={`task-item status-${item.status}${item.parent !== undefined ? ' child' : ''}`}>
                  <span className="task-mark">{MARK[item.status] ?? '○'}</span>
                  <span className="task-text">{item.content}</span>
                </li>
              ))}
            </ul>
            <button type="button" className="task-clear" onClick={clear} title="清空任务清单">
              清空清单
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
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
