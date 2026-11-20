/**
 * permission-core 收尾缺口（`packages/permission-core/permission-scope.ts:66-68,78,107,129`）：
 * 最小假会话的兜底存储——探针与老调用方给的对象没有 `state` / `appendState` / `setState`
 * 时，「同一个假对象读得到自己刚写的值」这条承诺靠两张兜底表（按 id / 按对象）兑现。
 *
 * 真实 Session 永远走日志条目（既有 `permission-core.spec.ts` 覆盖）；这里专门造三种残形：
 * 三项全无、只有 `meta.id`、有 `state` + `appendState` 但没有 `setState`（老调用方的补钉退路）。
 *
 * @module @pneuma/permission-core/tests/w14-fallback-sessions.spec
 */
import type { PermissionSession } from '../permission-scope.js'
import { expect, test } from 'vitest'
import { permissionOf, storedPermissions, writePermissions } from '../permission-scope.js'

test('三项全无的假会话：读按对象兜底，写也落同一张兜底表（无 meta.id 那支）', () => {
  const session = {} as unknown as PermissionSession
  expect(storedPermissions(session)).toEqual({ sandbox: null, policy: null, reviewer: null })

  // 没有 appendState：退回兜底表（第 107 行的 else 分支）。
  expect(writePermissions(session, { policy: 'auto-edit' })).toBe(true)
  expect(storedPermissions(session)).toEqual({ sandbox: null, policy: 'auto-edit', reviewer: null })

  // 同一个对象再改另一项：前面的值还在。
  expect(writePermissions(session, { reviewer: 'auto-review' })).toBe(true)
  expect(storedPermissions(session)).toMatchObject({ policy: 'auto-edit', reviewer: 'auto-review' })
})

test('只有 meta.id 的假会话：按 id 兜底，换一个对象也读得回同一个槽', () => {
  const first = { meta: { id: 'w14-fallback-session' } } as unknown as PermissionSession
  expect(permissionOf(first, 'sandbox', 'read-only')).toBe('read-only')
  expect(storedPermissions(first).sandbox).toBe('read-only')

  // 探针每次 current() 返回新对象：按 id 记才不丢。
  const again = { meta: { id: 'w14-fallback-session' } } as unknown as PermissionSession
  expect(permissionOf(again, 'sandbox', 'workspace-write')).toBe('read-only')
})

test('有 state + appendState 但没 setState：补默认值退回 appendState（老调用方那支）', () => {
  const appended: Array<{ id: string; payload: unknown }> = []
  let current: ReturnType<PermissionSession['state']>
  const session = {
    state: () => current,
    appendState: (id: 'permissions', payload: Parameters<PermissionSession['appendState']>[1]) => {
      current = payload
      appended.push({ id, payload })
    },
  } as unknown as PermissionSession

  expect(permissionOf(session, 'policy', 'auto-edit')).toBe('auto-edit')
  expect(appended).toHaveLength(1)
  expect(appended[0]!.id).toBe('permissions')
  expect(appended[0]!.payload).toMatchObject({ policy: 'auto-edit' })
  expect(permissionOf(session, 'policy', 'readonly')).toBe('auto-edit')
  expect(appended).toHaveLength(1)
})
