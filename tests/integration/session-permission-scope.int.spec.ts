/**
 * 权限三项的「按会话」读写与预设默认值（integration 层，原
 * `scripts/session-permissions-test.mjs` 的第 [1][2][3][4] 号口径 + 用量进位）。
 *
 * 用户报障（2026-10-28）：在 A 会话切「只读」，B 会话与后台 agent 一起变。根因是三项权限
 * 存在进程级变量里。现在值存在会话日志的 `permissions` 状态条目，读时缺项才补默认值并钉住
 * （口径照 dsh 的 permission-presets）。
 *
 * ## 与旁边那份 `session-permissions.int.spec.ts` 的分工
 *
 * 那份（迁自 `session-permissions-kernel-test.mjs`）在**真内核 + 开着沙箱**的条件下验
 * 「A 切只读 → B 不受影响 → 切回 A 还是只读」。本文件验它没碰的两层：
 *
 * - **真实 Session 的纯逻辑**：合并写、重复写不落库、三项互不覆盖、钉住语义；
 * - **补默认值不写盘**：`core/permission-scope.ts` 2026-11-03 的修复（点开看一眼不该刷新
 *   文件 mtime，否则侧栏「最近使用」会跳成刚刚）；
 * - **预设的两条写入口**：`use()` 只改当前会话、`setDefault()` 三根一起落默认；
 * - **用量数字进位**（`formatTokens`，状态栏口径）。
 *
 * ## 为什么源码文本断言一条都没搬
 *
 * 探针第 [4] 段有 11 条 `readFileSync('src/packages/.../index.ts')` + `includes(...)`：
 * 「approval 里不再有 `let policy`」「apply 不写偏好」「settings 那行只改会话」。
 * 文本断言改引号就假红、逻辑改坏但留着字面量就假绿（迁移手册第 2 节）。能换成行为的
 * 换成了行为（见下）；换不掉的四条（settings 页两行的接线、队友审批的父会话归属、
 * 沙箱守卫判不清归属就拒绝、沙箱 `setMode`/`setDefaultMode`）**没有可测接缝**，
 * 已写进报告，原探针因此保留未删。
 *
 * ## 隔离
 *
 * HOME 由 integration 层的 `tests/setup/temp-home.ts` 提供。本文件不调 `tempHome()`：
 * `DSC_HOME` 是 `core/path-policy.ts:23` 的模块顶层常量，而本文件静态 import 了
 * `core/session.js`，模块加载早于任何测试代码——那时再换 HOME 只会让 `homedir()` 与
 * `DSC_HOME` 分裂成两个临时目录（比不换更糟）。旁边的 kernel 用例能安全用 `tempHome()`，
 * 是因为它把内核模块的加载推迟到了 `bootKernel()` 内部。
 *
 * @module dsc/tests/integration/session-permission-scope.int.spec
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ApprovalPolicy, ApprovalReviewer, SandboxMode } from '@pneuma/runtime/contract.js'
import {
  permissionOf,
  resolvePermissions,
  samePermissionKnobs,
  storedPermissions,
  writePermissions,
} from '@pneuma/permission-core/permission-scope.js'
import { Session, sessionsRoot, slugCwd } from '@pneuma/runtime/core/session.js'
import { bootKernel, fakeLLM, readSessionJsonl, type BootedKernel, type FakeLLM } from '../../tests/harness.js'
import { formatTokens } from '../../src/packages/ui-primitives/ui/tokens.js'

/** 内核里本文件用到的两个服务面。 */
interface PresetSurface {
  use(name: string): string
  setDefault(name: string): void
}

interface PrefsSurface {
  defaultPermissionPreset: string
  defaultPolicy: ApprovalPolicy
  defaultReviewer: ApprovalReviewer
}

interface SettingsSurface {
  prefs(): PrefsSurface
}

interface SessionSurface {
  current(): { filePath: string; state(id: string): unknown }
}

let work: string
/** 会话文件所在的规范目录：`sessions/<slugCwd(cwd)>/`（会话层按 meta.cwd 重算路径）。 */
let sessionDir: string
let llm: FakeLLM
let kernel: BootedKernel
/** 会话文件序号：每个用例一份夹具，互不影响。 */
let counter = 0

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'dsc-permission-scope-'))
  sessionDir = join(sessionsRoot(), slugCwd(work))
  mkdirSync(sessionDir, { recursive: true })
  llm = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
})

function presets(): PresetSurface {
  return (kernel.ctx as unknown as { permissionPresets: PresetSurface }).permissionPresets
}

function settings(): SettingsSurface {
  return (kernel.ctx as unknown as { settings: SettingsSurface }).settings
}

function session(): SessionSurface {
  return (kernel.ctx as unknown as { session: SessionSurface }).session
}

/** 等会话日志里出现满足条件的一条记录（写流是异步的，不固定 sleep）。 */
async function waitForRecord(
  file: string,
  match: (record: Record<string, unknown>) => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (readSessionJsonl(file).some(match) || Date.now() > deadline) return
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/** 写一条最小会话到规范目录并 load 起来；返回会话与文件路径。 */
function openSession(text: string): { session: Session; file: string } {
  counter += 1
  const id = `30000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
  const file = join(sessionDir, `${id}.jsonl`)
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'meta', id, cwd: work, createdAt: 1 })}\n${JSON.stringify({ type: 'user', text })}\n`,
    'utf8',
  )
  return { session: Session.load(file), file }
}

describe('① 纯逻辑：缺项读默认值、只钉一次、三项互不覆盖（真实 Session）', () => {
  test('没有任何权限状态时三项都是 null', () => {
    const { session: s } = openSession('空权限')
    try {
      expect(storedPermissions(s)).toEqual({ sandbox: null, policy: null, reviewer: null })
    } finally {
      s.close()
    }
  })

  test('缺项时用默认值，再给别的默认值也不顶掉已钉的那项', () => {
    const { session: s } = openSession('钉默认值')
    try {
      expect(permissionOf(s, 'policy', 'auto-edit')).toBe('auto-edit')
      expect(permissionOf(s, 'policy', 'readonly')).toBe('auto-edit')
    } finally {
      s.close()
    }
  })

  test('补默认值只改内存，不往日志里写', async () => {
    // 2026-11-03 的修复：补钉只改内存，等下一次真正写日志时顺带落盘。
    // 老探针断言的是「第一次读会钉住（写一条）」——那是旧行为，现在写盘反而是缺陷。
    const { session: s, file } = openSession('不写盘')
    try {
      permissionOf(s, 'policy', 'auto-edit')
      permissionOf(s, 'sandbox', 'workspace-write')
      // 内存里已经生效。
      expect(storedPermissions(s).policy).toBe('auto-edit')
    } finally {
      s.close()
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 120))
    expect(readSessionJsonl(file).some((record) => record.type === 'state')).toBe(false)
  })

  test('三项各自钉、互不覆盖', () => {
    const { session: s } = openSession('互不覆盖')
    try {
      expect(permissionOf(s, 'sandbox', 'workspace-write')).toBe('workspace-write')
      expect(permissionOf(s, 'policy', 'auto-edit')).toBe('auto-edit')
      expect(storedPermissions(s).policy).toBe('auto-edit')
      expect(storedPermissions(s).sandbox).toBe('workspace-write')
    } finally {
      s.close()
    }
  })

  test('writePermissions 合并而不是整份替换', () => {
    const { session: s } = openSession('合并写')
    try {
      expect(writePermissions(s, { sandbox: 'workspace-write' })).toBe(true)
      expect(writePermissions(s, { reviewer: 'user' })).toBe(true)
      expect(storedPermissions(s)).toEqual({ sandbox: 'workspace-write', policy: null, reviewer: 'user' })
    } finally {
      s.close()
    }
  })

  test('写同样的值不再产生新条目', async () => {
    const { session: s, file } = openSession('重复写')
    try {
      expect(writePermissions(s, { reviewer: 'user' })).toBe(true)
      expect(writePermissions(s, { reviewer: 'user' })).toBe(false)
    } finally {
      s.close()
    }
    await waitForRecord(file, (record) => record.type === 'state' && record.id === 'permissions')
    const states = readSessionJsonl(file).filter((record) => record.type === 'state' && record.id === 'permissions')
    expect(states).toHaveLength(1)
  })

  test('resolvePermissions 一次补齐三项，缺哪项补哪项', () => {
    const { session: s } = openSession('一次补齐')
    try {
      writePermissions(s, { sandbox: 'read-only' })
      expect(resolvePermissions(s, { sandbox: 'workspace-write', policy: 'readonly', reviewer: 'auto-review' })).toEqual({
        sandbox: 'read-only',
        policy: 'readonly',
        reviewer: 'auto-review',
      })
    } finally {
      s.close()
    }
  })

  test('samePermissionKnobs 比三项，差一项就不算同一档', () => {
    const knobs = {
      sandbox: 'workspace-write' as SandboxMode,
      policy: 'auto-edit' as ApprovalPolicy,
      reviewer: 'user' as ApprovalReviewer,
    }
    expect(samePermissionKnobs(knobs, { ...knobs })).toBe(true)
    expect(samePermissionKnobs(knobs, { ...knobs, policy: 'full-access' })).toBe(false)
  })
})

describe('② 两会话隔离与钉住语义（真实日志）', () => {
  test('A 设只读不影响 B，B 改权限模式也不影响 A', () => {
    const a = openSession('A 会话')
    const b = openSession('B 会话')
    try {
      permissionOf(a.session, 'sandbox', 'workspace-write')
      permissionOf(b.session, 'sandbox', 'workspace-write')
      writePermissions(a.session, { sandbox: 'read-only' })
      expect(permissionOf(a.session, 'sandbox', 'workspace-write')).toBe('read-only')
      expect(permissionOf(b.session, 'sandbox', 'workspace-write')).toBe('workspace-write')
      writePermissions(b.session, { policy: 'full-access' })
      expect(permissionOf(a.session, 'sandbox', 'workspace-write')).toBe('read-only')
      expect(permissionOf(a.session, 'policy', 'auto-edit')).toBe('auto-edit')
    } finally {
      a.session.close()
      b.session.close()
    }
  })

  test('钉住之后改默认值，老会话保持原值；新会话拿新默认值', () => {
    const old = openSession('老会话')
    try {
      expect(permissionOf(old.session, 'policy', 'auto-edit')).toBe('auto-edit')
      // 用户在设置里把默认值改成 readonly：这个会话已经钉过，应该还是 auto-edit。
      expect(permissionOf(old.session, 'policy', 'readonly')).toBe('auto-edit')
    } finally {
      old.session.close()
    }
    const fresh = openSession('新会话')
    try {
      expect(permissionOf(fresh.session, 'policy', 'readonly')).toBe('readonly')
    } finally {
      fresh.session.close()
    }
  })

  test('写进去的权限能从日志重放回来（换进程也带得走）', async () => {
    const { session: s, file } = openSession('重放权限')
    writePermissions(s, { sandbox: 'read-only', policy: 'readonly', reviewer: 'auto-review' })
    s.close()
    // 写流是异步的：读到状态记录为止（不固定 sleep）。
    const deadline = Date.now() + 3_000
    for (;;) {
      const replayed = Session.load(file, true, { lease: false })
      try {
        const state = replayed.state('permissions')
        if (state !== undefined || Date.now() > deadline) {
          expect(state).toEqual({ sandbox: 'read-only', policy: 'readonly', reviewer: 'auto-review' })
          break
        }
      } finally {
        replayed.close()
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 20))
    }
  })
})

describe('③ 权限预设的两条写入口（真内核）', () => {
  test('use() 只改当前会话三项，偏好里的默认值一字未变', () => {
    const before = { ...settings().prefs() }
    const notice = presets().use('workspace')
    expect(typeof notice).toBe('string')
    // 会话侧：三项已经落到当前会话。
    expect(session().current().state('permissions')).toMatchObject({
      sandbox: 'workspace-write',
      policy: 'auto-edit',
      reviewer: 'user',
    })
    // 偏好侧：apply 这条路不写偏好（老实现会顺手把「新会话默认」也改掉）。
    expect(settings().prefs()).toEqual(before)
  })

  test('setDefault() 三根一起落默认（预设名 + 模式 + 审阅者）', () => {
    presets().setDefault('read-only')
    const prefs = settings().prefs()
    expect(prefs.defaultPermissionPreset).toBe('read-only')
    // read-only 这一档的两根：与 permission-core 的预设表一致。
    expect(prefs.defaultPolicy).toBe('auto-edit')
    expect(prefs.defaultReviewer).toBe('user')
  })
})

describe('④ 用量数字自动进位（状态栏口径）', () => {
  test('大数缩写成 K/M，千以下原样', () => {
    expect(formatTokens(1238946)).toBe('1.2M')
    expect(formatTokens(335048)).toBe('335K')
    expect(formatTokens(29530)).toBe('29.5K')
    expect(formatTokens(999)).toBe('999')
  })
})
