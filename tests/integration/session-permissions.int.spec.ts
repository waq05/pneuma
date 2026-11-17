/**
 * 权限按会话隔离的内核集成用例（迁自 `scripts/session-permissions-kernel-test.mjs`）。
 *
 * 2026-10-28 的报障形状：在 A 会话切「只读」，B 会话和后台 agent 一起变。纯函数探针
 * 证明不了「插件读的是自己会话」——它只能证明算术对。这里用真内核、真会话文件跑
 * 「A 切只读 → B 不受影响 → 切回 A 还是只读」。
 *
 * ## 为什么必须把沙箱插件打开
 *
 * harness 默认清单把 `sandbox` 关了（Windows 上它会 spawn 一个 PowerShell 体检子进程，
 * 见 `tests/harness.ts` 的 `prepareIsolatedHome`）。但这一组测的正是「沙箱档位跟着会话走」，
 * 关了它，`permissionPresets.use('read-only')` 只会落到权限模式那一半，沙箱那一半静默
 * 不落地（`src/packages/permission-presets/index.ts:118-123`）——断言会变绿，但测的是
 * 另一件事。所以这里预置 `plugins.json`，只关记忆、不关沙箱。harness 只在文件不存在时
 * 才写默认清单，预置的被完整保留。
 *
 * ## 隔离
 *
 * `tempHome()` + `fakeLLM()` + `bootKernel()`；每条用例一只内核，互不串味。
 *
 * @module dsc/tests/integration/session-permissions.int.spec
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../harness.js'

/** 权限三项在会话里的形状（`src/packages/permission-core/permission-scope.ts`）。 */
interface PermissionState {
  sandbox: string | null
  policy: string | null
  reviewer: string | null
}

interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  appendUser(text: string): void
  state(id: 'permissions'): PermissionState | undefined
}

interface Services {
  session: { current(): SessionView; open(filePath?: string, cwd?: string): Promise<void> }
  approval: { readonly policy: string }
  sandbox: { readonly mode: string }
  permissionPresets: { use(name: string): string }
  settings: { setPrefs(prefs: Record<string, unknown>): void }
}

let home: ReturnType<typeof tempHome>
let kernel: BootedKernel
let fake: FakeLLM
let services: Services

beforeEach(async () => {
  home = tempHome()
  // 只关记忆：沙箱插件保持开启，这一组才有「沙箱档位」可测。
  const dsc = join(home.home, '.dsc')
  mkdirSync(dsc, { recursive: true })
  writeFileSync(
    join(dsc, 'plugins.json'),
    `${JSON.stringify({ version: 1, entries: [{ file: 'memory', config: { enabled: false } }] }, null, 2)}\n`,
    'utf8',
  )
  fake = await fakeLLM({ turns: ['收到'] })
  kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  services = kernel.ctx as unknown as Services
})

afterEach(async () => {
  await kernel.dispose()
  await fake.close()
  home.restore()
})

/** 建一个工作目录并返回（新建会话要求目录真实存在）。 */
function workspace(name: string): string {
  const dir = join(home.home, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 等会话日志里出现某个特征串：会话状态是异步落盘的，切走之前必须等它写出来。 */
async function waitForText(file: string, needle: string): Promise<void> {
  const deadline = Date.now() + 3_000
  for (;;) {
    try {
      if (readFileSync(file, 'utf8').includes(needle)) return
    } catch {
      // 文件还没建出来：继续等。
    }
    if (Date.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** 让当前会话真落盘（会话要有一条对话记录才建文件）。 */
async function persistCurrent(name: string): Promise<string> {
  const current = services.session.current()
  current.appendUser(`让 ${name} 落盘`)
  await waitForText(current.filePath, '"type":"user"')
  return current.filePath
}

describe('① 默认三项：读一次就钉进会话', () => {
  test('权限模式 auto-edit、沙箱 workspace-write，且都记进会话状态', () => {
    expect(services.approval.policy).toBe('auto-edit')
    expect(services.sandbox.mode).toBe('workspace-write')
    const state = services.session.current().state('permissions')
    expect(state?.policy).toBe('auto-edit')
    expect(state?.sandbox).toBe('workspace-write')
    expect(state?.reviewer).toBe('user')
  })
})

describe('② 预设「只读」：只把沙箱那一半关住', () => {
  test('沙箱变 read-only，权限模式仍是 auto-edit', () => {
    services.permissionPresets.use('read-only')
    expect(services.sandbox.mode).toBe('read-only')
    // 出厂只读档 = 沙箱 read-only + 权限模式 auto-edit：沙箱兜住写，审批管要不要问。
    expect(services.approval.policy).toBe('auto-edit')
  })

  test('只读档记进会话状态（切走也带得走）', () => {
    services.permissionPresets.use('read-only')
    expect(services.session.current().state('permissions')?.sandbox).toBe('read-only')
  })
})

describe('③ 换会话：B 拿自己的默认值，不继承 A 的', () => {
  test('A 只读之后新建 B：B 是默认的 auto-edit / workspace-write', async () => {
    services.permissionPresets.use('read-only')
    await services.session.open(undefined, workspace('ws-b'))
    expect(services.session.current().meta.cwd).toBe(join(home.home, 'ws-b'))
    expect(services.approval.policy).toBe('auto-edit')
    expect(services.sandbox.mode).toBe('workspace-write')
  })

  test('B 切完全访问：权限模式与沙箱一起变', async () => {
    await services.session.open(undefined, workspace('ws-b'))
    services.permissionPresets.use('full-access')
    expect(services.approval.policy).toBe('full-access')
    expect(services.sandbox.mode).toBe('danger-full-access')
  })

  test('切回 A 还是只读：值来自 A 自己的会话状态', async () => {
    const aPath = await persistCurrent('A')
    services.permissionPresets.use('read-only')
    // 状态异步落盘：切走之前等它写出来，否则切回来读到的是旧值。
    await waitForText(aPath, '"sandbox":"read-only"')

    await services.session.open(undefined, workspace('ws-b'))
    expect(services.sandbox.mode).toBe('workspace-write')

    await services.session.open(aPath)
    expect(services.approval.policy).toBe('auto-edit')
    expect(services.sandbox.mode).toBe('read-only')
  })
})

describe('④ 改默认值：不动已钉住的会话，只影响新会话', () => {
  test('改默认权限模式不动 A；新会话拿改过的默认值', async () => {
    services.permissionPresets.use('read-only')
    await persistCurrent('A')
    services.settings.setPrefs({ defaultPolicy: 'readonly' })
    expect(services.approval.policy).toBe('auto-edit')

    await services.session.open(undefined, workspace('ws-c'))
    expect(services.approval.policy).toBe('readonly')
  })
})
