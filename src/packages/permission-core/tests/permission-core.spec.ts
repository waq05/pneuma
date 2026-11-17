/**
 * `@pneuma/permission-core` 的包级测试：钉库包身份、桶文件转出与两项纯函数行为。
 *
 * 原来「index.ts 逐行转出全部模块」读的是 `index.ts` 源码文本（`includes("export * from './x.js'")`），
 * 改引号或换行就假红、把导出删掉但留着注释就假绿。现在直接 `import * as core from '../index.js'`，
 * 断言两个模块的公开函数/常量真的出现在命名空间上，并用真实入参跑 permission-scope 与预设表：
 * 「没钉过就补默认值」「预设三项全等才匹配」这两条谁被读成什么，才是这层库的安全语义。
 *
 * 也不再依赖构建产物：旧版从 `lib/packages/permission-core/index.js` 加载，没构建就打印「待构建」
 * 并跳过，等于把一条用例静默吞掉；现在直接 import 源码，没有 skip。
 *
 * @module @pneuma/permission-core/tests
 */
import { existsSync, readFileSync } from 'node:fs'
import type { PermissionSession, PermissionKnobs } from '../permission-scope.js'
import { expect, test } from 'vitest'
import * as core from '../index.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json')) as {
  name: string
  version: string
  private?: boolean
  type: string
  exports: Record<string, string>
  pneuma?: { library?: boolean; bundle?: unknown }
}

/** 桶文件应当转出的两个模块的全部公开成员。 */
const SCOPE_EXPORTS = [
  'PERMISSION_FIELD_LABEL',
  'permissionOf',
  'resolvePermissions',
  'samePermissionKnobs',
  'storedPermissions',
  'writePermissions',
] as const

const PRESET_EXPORTS = [
  'BUILTIN_PERMISSION_PRESETS',
  'CUSTOM_PERMISSION_PRESET',
  'DEFAULT_PERMISSION_PRESET',
  'derivedPresetLabel',
  'findPermissionPreset',
  'matchPermissionPreset',
] as const

/** 一个最小假会话：state 存盘、appendState 记真写、setState 记补钉。 */
function fakeSession(): PermissionSession & { appended: number; pinned: number } {
  let current: ReturnType<PermissionSession['state']> = undefined
  const session = {
    appended: 0,
    pinned: 0,
    state: (_id: 'permissions') => current,
    appendState: (_id: 'permissions', payload: Parameters<PermissionSession['appendState']>[1]) => {
      current = payload
      session.appended += 1
    },
    setState: (_id: 'permissions', payload: Parameters<PermissionSession['appendState']>[1]) => {
      current = payload
      session.pinned += 1
    },
  }
  return session
}

test('库包身份：private + pneuma.library，没有装配行', () => {
  expect(pkg.name).toBe('@pneuma/permission-core')
  expect(pkg.version).toBe((JSON.parse(read('../../../../package.json')) as { version: string }).version)
  expect(pkg.private).toBe(true)
  expect(pkg.type).toBe('module')
  expect(pkg.pneuma?.library).toBe(true)
  expect(pkg.pneuma?.bundle).toBeUndefined()
  expect(existsSync(new URL('../cordis.patch.yml', import.meta.url))).toBe(false)
})

test('exports 的模块子路径键与目标一字不差', () => {
  expect(pkg.exports['.']).toBeDefined()
  expect((pkg.exports['.'] as { default?: string }).default).toBe('./index.js')
  expect(pkg.exports['./package.json']).toBe('./package.json')
  for (const name of ['permission-scope', 'permission-presets']) {
    expect(pkg.exports[`./${name}.js`]).toBe(`./${name}.js`)
  }
})

test('桶文件真的转出了两个模块的公开面', () => {
  for (const name of SCOPE_EXPORTS) expect(core[name], `缺 ${name}`).toBeDefined()
  for (const name of PRESET_EXPORTS) expect(core[name], `缺 ${name}`).toBeDefined()
  expect(typeof core.permissionOf).toBe('function')
  expect(typeof core.matchPermissionPreset).toBe('function')
  expect(Array.isArray(core.BUILTIN_PERMISSION_PRESETS)).toBe(true)
})

test('会话没钉过权限项时补默认值并钉住，真改档位才落盘', () => {
  const session = fakeSession()
  // 读路径：没有值就用调用方给的默认值，并只记内存（不 append 日志）。
  expect(core.permissionOf(session, 'policy', 'auto-edit')).toBe('auto-edit')
  expect(core.storedPermissions(session).policy).toBe('auto-edit')
  expect(session.appended).toBe(0)
  expect(session.pinned).toBe(1)

  // 已经钉过就按会话值走，不被新的默认值顶掉：这正是「A 会话切档不影响 B」的根据。
  expect(core.permissionOf(session, 'policy', 'readonly')).toBe('auto-edit')

  // 用户真的改档位：写一次，重复写同一值返回 false（不往日志里塞重复行）。
  expect(core.writePermissions(session, { policy: 'readonly' })).toBe(true)
  expect(session.appended).toBe(1)
  expect(core.writePermissions(session, { policy: 'readonly' })).toBe(false)
  expect(session.appended).toBe(1)
})

test('预设表：三项全等才匹配，拼不出预设读作 custom', () => {
  expect(core.BUILTIN_PERMISSION_PRESETS).toHaveLength(4)
  expect(core.DEFAULT_PERMISSION_PRESET).toBe('workspace')
  expect(core.findPermissionPreset('workspace')?.sandbox).toBe('workspace-write')
  expect(core.findPermissionPreset(core.CUSTOM_PERMISSION_PRESET)).toBeNull()
  // 表里 read-only 预设的权限模式是 auto-edit（Pneuma 没有单独的 ask 档）。
  expect(core.matchPermissionPreset('read-only', 'auto-edit', 'user')).toBe('read-only')
  expect(core.matchPermissionPreset('danger-full-access', 'full-access', 'auto-review')).toBe('auto-review')
  // 只差一项就不算任何预设：这决定了设置页显示「自定义」而不是悄悄套一档。
  expect(core.matchPermissionPreset('read-only', 'readonly', 'user')).toBe(core.CUSTOM_PERMISSION_PRESET)
})

test('三项一次解析：缺哪项补哪项，缺省值互不串门', () => {
  const session = fakeSession()
  const defaults: PermissionKnobs = { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user' }
  expect(core.resolvePermissions(session, defaults)).toEqual({
    sandbox: 'workspace-write',
    policy: 'auto-edit',
    reviewer: 'user',
  })
  // 只改一项之后，另外两项仍是各自的会话值。
  core.writePermissions(session, { reviewer: 'auto-review' })
  expect(core.resolvePermissions(session, defaults)).toEqual({
    sandbox: 'workspace-write',
    policy: 'auto-edit',
    reviewer: 'auto-review',
  })
  expect(core.samePermissionKnobs(
    { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'auto-review' },
    { sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'auto-review' },
  )).toBe(true)
})

test('README 两段都在', () => {
  const text = read('../README.md')
  expect(text).toMatch(/^## Model Experience/m)
  expect(text).toMatch(/^## Known Limitations/m)
})
