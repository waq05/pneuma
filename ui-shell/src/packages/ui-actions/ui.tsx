/**
 * 动作表：全局、无参动作的唯一登记处（契约见 `@dsc/ui` 的 `UiAction`）。
 *
 * 为什么不放在壳里：登记的人都是插件（会话页的「新会话」、设置的各分区、首屏提示词），
 * 壳只该管位置与渲染。这个插件只做一件事——把别人交来的动作按 id 去重后排队，并在变化时
 * 通知订阅者；它自己一条动作都不提供。
 *
 * 顺序为什么按登记顺序而不是按组：组只影响命令面板怎么分段画，动作之间的先后由登记顺序
 * 决定，这样同一个 owner 的几条永远挨着，重登记也不会在面板里跳位（Map.set 保留首次插入位）。
 *
 * @module dsc-ui-shell/plugins/actions
 */
import { ACTIONS_SERVICE, createSignal, defineUiPlugin, type ActionsHandle, type UiAction } from '@dsc/ui'

/** owner → 它登记的那组动作（同一个 owner 再登记就整组换掉）。 */
const byOwner = new Map<string, readonly UiAction[]>()

/** 当前冻结的那一份；没有变化时引用不变（`useSyncExternalStore` 靠它判等）。 */
const snapshot = createSignal<readonly UiAction[]>(Object.freeze([]))

/** 重新摊平：按 owner 首次出现的顺序、组内按登记顺序，id 重复的只留第一条。 */
function rebuild(): void {
  const seen = new Set<string>()
  const next: UiAction[] = []
  for (const actions of byOwner.values()) {
    for (const action of actions) {
      if (seen.has(action.id)) {
        console.warn(`动作表：${action.id} 被重复登记，后一条已忽略`)
        continue
      }
      seen.add(action.id)
      next.push(Object.freeze({ ...action }))
    }
  }
  snapshot.set(Object.freeze(next))
}

const handle: ActionsHandle = {
  register(owner, actions) {
    const stored = actions.length === 0 ? undefined : [...actions]
    if (stored === undefined) byOwner.delete(owner)
    else byOwner.set(owner, stored)
    rebuild()
    // 注销只在「还是我这一份」时生效：同一个 owner 先注销旧的、再登记新的时，
    // 旧句柄不该把新登记的那组一起摘掉。
    return () => {
      if (stored !== undefined && byOwner.get(owner) !== stored) return
      if (byOwner.delete(owner)) rebuild()
    }
  },
  list: () => snapshot.get(),
  subscribe: snapshot.subscribe,
}

export default defineUiPlugin({
  name: '动作表',
  apply(ui) {
    ui.provide<ActionsHandle>(ACTIONS_SERVICE, handle)
  },
})
