/**
 * 动作表（`ui-actions/ui/ui.tsx`）的登记面（ui 层）。
 *
 * 插件不导出句柄：照壳装载插件那条路 `apply`，从 `provide(ACTIONS_SERVICE, …)` 收下
 * 动作表。钉的是「摊平顺序、同 owner 整组替换、id 去重告警、订阅通知、空组即注销、
 * 旧句柄不误摘新登记」——命令面板看到的顺序与内容全由这几条决定。
 *
 * @module dsc-ui-actions/ui/ui.spec
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ACTIONS_SERVICE, type ActionsHandle, type UiAction, type UiPluginApi } from '@dsc/ui'
import plugin from './ui.js'

/** `apply` 里 provide 出来的动作表句柄。 */
let captured: ActionsHandle | undefined
plugin.apply({
  provide: (service: string, value: unknown): void => {
    if (service === ACTIONS_SERVICE) captured = value as ActionsHandle
  },
} as unknown as UiPluginApi)

if (captured === undefined) throw new Error('actions 插件没有 provide 动作表')
const actions: ActionsHandle = captured

/** 本文件用过的 owner：每个用例结束按空组注销，模块级 Map 不串味。 */
const owners = new Set<string>()

/** 一条动作（只给去重/顺序需要的字段）。 */
const actionOf = (id: string): UiAction => ({ id, label: id, run: () => undefined })

/** 登记并记下 owner，交给 afterEach 清理。 */
const register = (owner: string, list: readonly UiAction[]): (() => void) => {
  owners.add(owner)
  return actions.register(owner, list)
}

const idsOf = (): string[] => actions.list().map((action) => action.id)

afterEach(() => {
  for (const owner of owners) actions.register(owner, [])
  owners.clear()
  vi.restoreAllMocks()
})

describe('摊平与去重', () => {
  test('按 owner 首次登记顺序摊平；同 owner 再登记整组替换但保持位置', () => {
    register('owner-a', [actionOf('one'), actionOf('two')])
    register('owner-b', [actionOf('three')])

    expect(idsOf()).toEqual(['one', 'two', 'three'])
    const before = actions.list()
    expect(actions.list()).toBe(before)
    expect(Object.isFrozen(before)).toBe(true)

    register('owner-a', [actionOf('four')])
    expect(idsOf()).toEqual(['four', 'three'])
    expect(actions.list()).not.toBe(before)
  })

  test('id 重复只留先登记的一条，并告警点出 id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    register('owner-a', [actionOf('dup')])
    register('owner-b', [actionOf('dup')])

    expect(idsOf()).toEqual(['dup'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('dup')
  })

  test('订阅在每次重建时通知；空组等于注销 owner；退订后不再通知', () => {
    const listener = vi.fn()
    const off = actions.subscribe(listener)

    register('owner-e', [actionOf('x')])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(idsOf()).toEqual(['x'])

    register('owner-e', [])
    expect(listener).toHaveBeenCalledTimes(2)
    expect(idsOf()).toEqual([])

    off()
    register('owner-f', [actionOf('y')])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  test('旧句柄不摘掉同 owner 的新登记', () => {
    const offOld = register('owner-c', [actionOf('old')])
    const offNew = register('owner-c', [actionOf('new')])

    expect(idsOf()).toEqual(['new'])
    offOld()
    expect(idsOf()).toEqual(['new'])

    offNew()
    expect(idsOf()).toEqual([])
  })
})
