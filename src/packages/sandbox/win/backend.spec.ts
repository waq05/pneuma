/**
 * 受限令牌执行器（`win/backend.ts`）的黑盒自检。
 *
 * 这里**不装 koffi、不建令牌、不打 ACL、不起代理**：
 *   - `./ffi.js` / `./acl.js` / `../net-proxy.js` 全部换成可编排的假实现；
 *   - `../../../core/path-policy.js` 只把 `DSC_HOME` 换到临时目录（`isEnvFamily` 仍是真实现）；
 *   - `node:fs` 的 `existsSync` 可注入结论（探 runner 构建产物 / DSC_NODE 用），其余走真实现。
 *
 * 覆盖的是「计划怎么改写」与「授权失败怎么降级」：参数形状（--root/--temp/--pty/--account）、
 * 网络软墙与白名单代理、跨会话补授权、dispose 回收、describe 文案。
 *
 * @module @pneuma/sandbox/win/backend.spec
 */
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { expect, afterAll, afterEach, beforeEach, describe, test, vi } from 'vitest'
import type { CommandRun, SpawnPlan } from '../../../core/tools/command-runner.js'

/** FFI / ACL / 代理的可编排状态：`vi.mock` 工厂早于 import 执行，只能走 hoisted。 */
const st = vi.hoisted(() => ({
  dscHome: `${process.env.TEMP ?? 'C:\\Temp'}\\dsc-w11-backend-home`.replace(/[\\/]+$/, ''),
  ffiOk: true,
  ffiWhy: 'koffi 缺失',
  bindThrows: false,
  existsImpl: null as ((path: string) => boolean) | null,
  grantCalls: [] as Array<{ path: string; sid: string }>,
  grantAccountCalls: [] as Array<{ path: string; sid: string }>,
  revokeCalls: [] as string[],
  failPathPart: null as string | null,
  accountThrows: false,
  revokeThrows: false,
  proxyCalls: 0,
  proxyThrows: false,
  lastProxyOptions: null as Record<string, unknown> | null,
  details: [] as string[],
  proxy: {
    url: 'http://127.0.0.1:4321',
    port: 4321,
    log: () => [] as const,
    close: vi.fn(),
  },
}))

/* 不用真的 koffi 底座：绑定表是个占位对象，acl 模块已被换成假的。 */
vi.mock('./ffi.js', () => ({
  tryLoadFfi: () =>
    st.ffiOk ? ({ ok: true, ffi: { fake: true } } as const) : ({ ok: false, why: st.ffiWhy } as const),
  bindAll: () => {
    if (st.bindThrows) throw new Error('绑定失败')
    return { fake: true }
  },
}))

/* ACL 授权全换成记账函数：断言「授权了哪些目录」而不是真的改系统。 */
vi.mock('./acl.js', () => ({
  grantWrite: (_bound: unknown, path: string, sid: string) => {
    st.grantCalls.push({ path, sid })
    if (st.failPathPart !== null && path.includes(st.failPathPart)) throw new Error(`拒绝写 ${path}`)
    return { ok: true, already: false }
  },
  grantAccountAccess: (_bound: unknown, path: string, sid: string) => {
    st.grantAccountCalls.push({ path, sid })
    if (st.accountThrows) throw new Error('账号 ACE 打不上')
    return { ok: true }
  },
  revokeWrite: (_bound: unknown, path: string) => {
    st.revokeCalls.push(path)
    if (st.revokeThrows) throw new Error('回收失败')
  },
}))

/* 代理：可决定「起得来」还是「端口被占」，不起真监听。 */
vi.mock('../net-proxy.js', () => ({
  proxyEnvVars: (url: string) => ({ HTTP_PROXY: url, HTTPS_PROXY: url, NO_PROXY: '' }),
  createNetProxy: async (options: Record<string, unknown>) => {
    st.proxyCalls += 1
    st.lastProxyOptions = options
    if (st.proxyThrows) throw new Error('端口被占')
    return st.proxy
  },
}))

/* dsc 家目录换到临时目录：LOCK_DIR 的 mkdirSync 不碰真实 ~/.dsc。 */
vi.mock('../../../core/path-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/path-policy.js')>()
  return { ...actual, DSC_HOME: st.dscHome }
})

/* existsSync 可注入：探 runner 产物与 DSC_NODE 时给确定结论。 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: string) => (st.existsImpl === null ? actual.existsSync(path) : st.existsImpl(path)),
  }
})

import {
  createWindowsTokenRunner,
  probeWindowsToken,
  writeRootsFor,
  RUNNER_FAILURE_SIGNATURE,
  WINDOWS_TOKEN_RUNNER_ID,
} from './backend.js'
import { sandboxTmpDir } from '../policy.js'

const ORIGINAL_PLATFORM = process.platform
const ENTRY = fileURLToPath(new URL('./runner-entry.js', import.meta.url))

const sandboxHome = (): string => st.dscHome

function runAt(cwd: string): CommandRun {
  return { command: 'echo hi', cwd, timeoutMs: 1_000, signal: new AbortController().signal }
}

function basePlan(over: Partial<SpawnPlan> = {}): SpawnPlan {
  return {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/c', 'echo hi'],
    env: { PATH: 'C:\\bin' },
    cwd: 'C:\\ws-a',
    ...over,
  }
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  }
}

beforeEach(() => {
  st.ffiOk = true
  st.bindThrows = false
  st.existsImpl = null
  st.grantCalls.length = 0
  st.grantAccountCalls.length = 0
  st.revokeCalls.length = 0
  st.failPathPart = null
  st.accountThrows = false
  st.revokeThrows = false
  st.proxyCalls = 0
  st.proxyThrows = false
  st.lastProxyOptions = null
  st.details.length = 0
  st.proxy.close.mockClear()
  delete process.env.DSC_NODE
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  delete process.env.DSC_NODE
})

afterAll(() => {
  rmSync(st.dscHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const detailSink = (message: string): void => {
  st.details.push(message)
}

// ── probeWindowsToken：五条探测路径 ─────────────────────────────────────────

describe('probeWindowsToken', () => {
  test('非 Windows 平台：直接不可用，不加载 FFI', () => {
    const probe = withPlatform('linux', () => probeWindowsToken())
    expect(probe).toEqual({ available: false, detail: '非 Windows 平台' })
  })

  test('FFI 底座不可用：原因原样带进 detail', () => {
    st.ffiOk = false
    st.ffiWhy = 'koffi 装不上'
    const probe = probeWindowsToken()
    expect(probe.available).toBe(false)
    expect(probe.detail).toContain('koffi 装不上')
  })

  test('runner 构建产物缺失：点名路径并提示先 build', () => {
    st.existsImpl = () => false
    const probe = probeWindowsToken()
    expect(probe.available).toBe(false)
    expect(probe.detail).toContain('runner 入口没有构建产物')
    expect(probe.detail).toContain(ENTRY)
  })

  test('DSC_NODE 指向不存在的解释器：探测阶段就点名', () => {
    process.env.DSC_NODE = 'C:\\没有这个\\node.exe'
    st.existsImpl = (path) => path === ENTRY
    const probe = probeWindowsToken()
    expect(probe.available).toBe(false)
    expect(probe.detail).toContain('DSC_NODE 指向的解释器不存在')
  })

  test('DSC_NODE 是空白：等同没给，可用', () => {
    process.env.DSC_NODE = '   '
    st.existsImpl = () => true
    const probe = probeWindowsToken()
    expect(probe.available).toBe(true)
    expect(probe.detail).toContain('受限令牌后端可用')
    expect(probe.detail).toContain('解释器：node')
  })

  test('DSC_NODE 指向真实存在的文件：按 override 解释器报', () => {
    process.env.DSC_NODE = 'C:\\tools\\node.exe'
    st.existsImpl = () => true
    const probe = probeWindowsToken()
    expect(probe.available).toBe(true)
    expect(probe.detail).toContain('解释器：override')
  })
})

// ── writeRootsFor：工作区 / 临时目录 / 附加根的归并与 SID ──────────────────

describe('writeRootsFor', () => {
  test('工作区 + 私有临时目录，外加去重后的附加根', () => {
    const roots = writeRootsFor('C:\\ws\\', [' C:\\extra ', 'c:\\WS', '', 'D:\\extra2\\'])
    expect(roots.map((root) => root.side)).toEqual(['root', 'temp', 'root', 'root'])
    expect(roots[0]).toMatchObject({ path: 'C:\\ws', side: 'root' })
    expect(roots[1]).toMatchObject({ path: sandboxTmpDir(sandboxHome(), 'C:\\ws'), side: 'temp' })
    expect(roots[2]).toMatchObject({ path: 'C:\\extra', side: 'root' })
    expect(roots[3]).toMatchObject({ path: 'D:\\extra2', side: 'root' })
    // SID 由路径派生：同一个路径只有一条，且 root 与 temp 的 SID 不同。
    expect(new Set(roots.map((root) => root.sid)).size).toBe(4)
  })

  test('不给附加根时只有两条（工作区 + temp）', () => {
    expect(writeRootsFor('C:\\only')).toHaveLength(2)
  })
})

// ── read-only 档：不碰 FFI、不授权、仍换执行体 ─────────────────────────────

describe('createWindowsTokenRunner · read-only', () => {
  test('不加载 FFI、不授权，plan 仍返回 runner 参数（无 --root）', async () => {
    const handle = createWindowsTokenRunner({
      mode: 'read-only',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    const plan = await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    expect(plan).not.toBeNull()
    expect(plan!.file).toBe(process.execPath)
    expect(plan!.cwd).toBe('C:\\ws-a')
    expect(plan!.args.slice(0, 5)).toEqual([
      ENTRY,
      '--mode',
      'read-only',
      '--temp',
      sandboxTmpDir(sandboxHome(), 'C:\\ws-a'),
    ])
    expect(plan!.args).not.toContain('--root')
    expect(plan!.args.slice(-4)).toEqual(['--', 'C:\\Windows\\System32\\cmd.exe', '/c', 'echo hi'])
    expect(st.grantCalls).toHaveLength(0)
    expect(st.details).toHaveLength(0)
    expect(handle.networkEnforced).toBe(false)
    expect(handle.runner.id).toBe(WINDOWS_TOKEN_RUNNER_ID)
    expect(handle.runner.order).toBe(20)
    expect(RUNNER_FAILURE_SIGNATURE).toBe('dsc-sandbox-run: ')
    expect(handle.describe()).toContain('read-only 档')
    // 没有 bound：dispose 直接短路，不回收任何东西。
    handle.dispose()
    expect(st.revokeCalls).toHaveLength(0)
  })

  test('网络开：不改 env；网络关：叠 OFFLINE 软墙且不污染调用方对象', async () => {
    const online = createWindowsTokenRunner({
      mode: 'read-only',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    const openPlan = await online.runner.plan(runAt('C:\\ws-a'), basePlan())
    expect(openPlan!.env).toEqual({ PATH: 'C:\\bin' })

    const offline = createWindowsTokenRunner({
      mode: 'read-only',
      cwd: 'C:\\ws-a',
      networkAccess: () => false,
      onDetail: detailSink,
    })
    const callerEnv = { PATH: 'C:\\bin' }
    const closedPlan = await offline.runner.plan(runAt('C:\\ws-a'), basePlan({ env: callerEnv }))
    expect(closedPlan!.env.HTTP_PROXY).toBe('http://127.0.0.1:9')
    expect(closedPlan!.env.HTTPS_PROXY).toBe('http://127.0.0.1:9')
    expect(closedPlan!.env.GIT_SSH_COMMAND).toBe('cmd /c exit 1')
    expect(callerEnv).toEqual({ PATH: 'C:\\bin' })
  })

  test('DSC_NODE 在调用方 env 里：file 换成用户指定的解释器', async () => {
    const handle = createWindowsTokenRunner({
      mode: 'read-only',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    const plan = await handle.runner.plan(
      runAt('C:\\ws-a'),
      basePlan({ env: { PATH: 'C:\\bin', DSC_NODE: 'C:\\tools\\node.exe' } }),
    )
    expect(plan!.file).toBe('C:\\tools\\node.exe')
  })
})

// ── workspace-write：授权、跨会话补根、降级 ────────────────────────────────

describe('createWindowsTokenRunner · workspace-write 授权', () => {
  test('第一次 plan：给工作区与 temp 各授权一次，--root 只带常驻根', async () => {
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      extraRoots: ['C:\\extra'],
      networkAccess: () => true,
      onDetail: detailSink,
    })
    const expected = writeRootsFor('C:\\ws-a', ['C:\\extra'])
    const plan = await handle.runner.plan(runAt('C:\\ws-a'), basePlan({ cwd: 'C:\\ws-a' }))
    expect(st.grantCalls).toEqual(expected.map((root) => ({ path: root.path, sid: root.sid })))

    const rootArgs = plan!.args.filter((_arg, index, all) => all[index - 1] === '--root')
    expect(rootArgs).toEqual([
      `${expected[0]!.sid}=C:\\ws-a`,
      `${expected[2]!.sid}=C:\\extra`,
    ])
    // temp 绝不进 --root（runner 会拿 rootWriteSid 复算 → 退 127）。
    expect(rootArgs.join('\n')).not.toContain(expected[1]!.path)
    expect(plan!.args[plan!.args.indexOf('--temp') + 1]).toBe(expected[1]!.path)
  })

  test('同一工作区再 plan：授权缓存命中，不再调 grantWrite', async () => {
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    const afterFirst = st.grantCalls.length
    await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    expect(st.grantCalls.length).toBe(afterFirst)
  })

  test('第二个会话的工作目录：只补授权新的根，--root 累计、--temp 用本次 cwd', async () => {
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    await handle.runner.plan(runAt('C:\\ws-a'), basePlan({ cwd: 'C:\\ws-a' }))
    const firstCall = st.grantCalls.length
    const plan = await handle.runner.plan(runAt('C:\\ws-b'), basePlan({ cwd: 'C:\\ws-b' }))
    expect(st.grantCalls.length).toBe(firstCall + 2)
    expect(plan!.args.filter((_arg, index, all) => all[index - 1] === '--root')).toHaveLength(2)
    expect(plan!.args[plan!.args.indexOf('--temp') + 1]).toBe(sandboxTmpDir(sandboxHome(), 'C:\\ws-b'))
  })

  test('FFI 不可用：plan 返回 null、只报一次降级、后续不再重试', async () => {
    st.ffiOk = false
    st.ffiWhy = 'koffi 缺失'
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    expect(await handle.runner.plan(runAt('C:\\ws-a'), basePlan())).toBeNull()
    expect(st.details).toHaveLength(1)
    expect(st.details[0]).toContain('已降级为策略围栏')
    expect(st.details[0]).toContain('koffi 缺失')
    expect(st.grantCalls).toHaveLength(0)

    expect(await handle.runner.plan(runAt('C:\\other'), basePlan())).toBeNull()
    expect(st.details).toHaveLength(1)
  })

  test('bindAll 抛错：同样降级（错误文本进 detail）', async () => {
    st.bindThrows = true
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    expect(await handle.runner.plan(runAt('C:\\ws-a'), basePlan())).toBeNull()
    expect(st.details[0]).toContain('绑定失败')
  })

  test('某个根打 ACL 失败：整体降级并点名目录与 SID', async () => {
    st.failPathPart = 'ws-bad'
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-bad',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    expect(await handle.runner.plan(runAt('C:\\ws-bad'), basePlan())).toBeNull()
    expect(st.details[0]).toContain('打 ACL 失败')
    expect(st.details[0]).toContain('C:\\ws-bad')
  })

  test('onDetail 可省略：降级不抛错', async () => {
    st.ffiOk = false
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
    })
    expect(await handle.runner.plan(runAt('C:\\ws-a'), basePlan())).toBeNull()
  })

  test('已经被本后端换过的计划不再套第二层', async () => {
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    const already = basePlan({ file: process.execPath, args: [ENTRY, '--mode', 'workspace-write'] })
    expect(await handle.runner.plan(runAt('C:\\ws-a'), already)).toBeNull()
  })

  test('dispose：逐个回收 temp 授权；回收失败只记一句', async () => {
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    handle.dispose()
    expect(st.revokeCalls).toEqual([sandboxTmpDir(sandboxHome(), 'C:\\ws-a')])

    st.revokeCalls.length = 0
    st.revokeThrows = true
    const second = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    await second.runner.plan(runAt('C:\\ws-a'), basePlan())
    second.dispose()
    expect(st.details.some((text) => text.includes('回收临时目录授权失败'))).toBe(true)
  })
})

// ── pty：--cols/--rows 必须配 --pty，非法值回落缺省 ─────────────────────────

describe('createWindowsTokenRunner · tty', () => {
  const make = (): ReturnType<typeof createWindowsTokenRunner> =>
    createWindowsTokenRunner({
      mode: 'read-only',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })

  test('tty=true + 合法尺寸：带 --pty/--cols/--rows', async () => {
    const plan = await make().runner.plan(runAt('C:\\ws-a'), basePlan({ tty: true, cols: 100, rows: 50 }))
    expect(plan!.args.slice(plan!.args.indexOf('--pty'))).toEqual([
      '--pty',
      '--cols', '100',
      '--rows', '50',
      '--',
      'C:\\Windows\\System32\\cmd.exe',
      '/c',
      'echo hi',
    ])
  })

  test('非法尺寸（0 / 小数 / 超 16 位 / NaN / 负数）一律回落 120×30', async () => {
    for (const [cols, rows] of [
      [0, 0],
      [1.5, 2.5],
      [70000, 70000],
      [Number.NaN, Number.NaN],
      [-1, -2],
      [undefined, undefined],
    ] as const) {
      const plan = await make().runner.plan(runAt('C:\\ws-a'), basePlan({ tty: true, cols, rows }))
      const ptyAt = plan!.args.indexOf('--pty')
      expect(plan!.args.slice(ptyAt + 1, ptyAt + 5), `${String(cols)}x${String(rows)}`).toEqual([
        '--cols', '120',
        '--rows', '30',
      ])
    }
  })

  test('tty 缺省或 false：一个字节都不加', async () => {
    for (const tty of [undefined, false]) {
      const plan = await make().runner.plan(runAt('C:\\ws-a'), basePlan({ tty, cols: 100, rows: 50 }))
      expect(plan!.args).not.toContain('--pty')
      expect(plan!.args).not.toContain('--cols')
      expect(plan!.args).not.toContain('--rows')
    }
  })
})

// ── 账号分支：账号 ACE、白名单代理、网络软墙 ───────────────────────────────

describe('createWindowsTokenRunner · 账号分支', () => {
  const account = {
    name: 'dsc-sandbox-offline',
    sid: 'S-1-5-21-1-2-3',
    dscHome: 'C:\\dsc-home',
    proxyPort: 3128,
  }

  const make = (over: Partial<Parameters<typeof createWindowsTokenRunner>[0]> = {}) =>
    createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
      account,
      ...over,
    })

  test('每个可写根补一条账号 ACE；参数带 --account/--dsc-home', async () => {
    const handle = make({ networkAccess: () => false })
    const plan = await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    const roots = writeRootsFor('C:\\ws-a')
    expect(st.grantAccountCalls).toEqual(roots.map((root) => ({ path: root.path, sid: account.sid })))
    expect(plan!.args).toContain('--account')
    expect(plan!.args).toContain(account.name)
    expect(plan!.args).toContain('--dsc-home')
    expect(plan!.args).toContain(account.dscHome)
    expect(handle.networkEnforced).toBe(true)
    expect(handle.describe()).toContain('账号分支在位')
    expect(handle.describe()).toContain('读与进程可见性被账号权限限死')
  })

  test('账号 ACE 打不上：降级', async () => {
    st.accountThrows = true
    const handle = make({ networkAccess: () => false })
    expect(await handle.runner.plan(runAt('C:\\ws-a'), basePlan())).toBeNull()
    expect(st.details[0]).toContain('账号 ACE 打不上')
  })

  test('开网：起白名单代理、注入代理 env，第二次 plan 复用同一个代理', async () => {
    const handle = make({
      networkAllowlist: () => ['registry.npmjs.org'],
    })
    const plan = await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    expect(st.proxyCalls).toBe(1)
    expect(plan!.env.HTTP_PROXY).toBe('http://127.0.0.1:4321')
    expect(plan!.env.NO_PROXY).toBe('')
    expect(st.details.some((text) => text.includes('出网白名单代理已起'))).toBe(true)
    // 代理的 online/allowlist 是现取的闭包。
    const options = st.lastProxyOptions!
    expect((options.online as () => boolean)()).toBe(true)
    expect((options.allowlist as () => readonly string[])()).toEqual(['registry.npmjs.org'])

    await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    expect(st.proxyCalls).toBe(1)
    handle.dispose()
    expect(st.proxy.close).toHaveBeenCalledTimes(1)
  })

  test('没配白名单：代理的 allowlist 现取空数组', async () => {
    const handle = make()
    await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    const options = st.lastProxyOptions!
    expect((options.allowlist as () => readonly string[])()).toEqual([])
  })

  test('代理起不来：回落 OFFLINE 软墙并说明原因', async () => {
    st.proxyThrows = true
    const handle = make()
    const plan = await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    expect(plan!.env.HTTP_PROXY).toBe('http://127.0.0.1:9')
    expect(st.details.some((text) => text.includes('白名单代理起不来'))).toBe(true)
  })

  test('关网：不走代理，直接叠 OFFLINE 软墙', async () => {
    const handle = make({ networkAccess: () => false })
    const plan = await handle.runner.plan(runAt('C:\\ws-a'), basePlan())
    expect(st.proxyCalls).toBe(0)
    expect(plan!.env.HTTP_PROXY).toBe('http://127.0.0.1:9')
  })
})

// ── describe：四种文案形状 ─────────────────────────────────────────────────

describe('createWindowsTokenRunner · describe', () => {
  test('workspace-write 无账号：列可写根 + 结构性缺口', () => {
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
    })
    const text = handle.describe()
    expect(text).toContain('C:\\ws-a')
    expect(text).toContain('读与进程可见性一概不受限')
    expect(text).toContain('第二级提权 setup')
    expect(handle.networkEnforced).toBe(false)
  })

  test('账号分支：网络文案换成 WFP + 白名单代理', () => {
    const handle = createWindowsTokenRunner({
      mode: 'workspace-write',
      cwd: 'C:\\ws-a',
      networkAccess: () => true,
      onDetail: detailSink,
      account: { name: 'a', sid: 'S-1-5-21-9', dscHome: 'C:\\h', proxyPort: 3128 },
    })
    expect(handle.describe()).toContain('其余出口被 WFP 按账号 SID 堵死')
  })
})
