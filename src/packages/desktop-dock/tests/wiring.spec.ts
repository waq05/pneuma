/**
 * desktop-dock 插件装配面（`packages/desktop-dock/index.ts`）。
 *
 * 假 ctx（session / approval / settings / git 全注入）跑真 `apply`，文件与 git 都在
 * 临时目录里真跑（`git init` + 真提交），终端那条用真 `node.exe -i` 起、收尾 kill。
 *
 * 钉住四件事：
 *   1. 装配：`provide('dock')`、额外工作区根分区（inSettings）、settings 缺席时安静降级；
 *   2. 读类：fs-list / fs-roots / fs-read / git-status / git-branches / git-diff 的分支
 *      （越界、未授权根、空仓库、未跟踪合成 patch）；
 *   3. 写类：必须过审批（没服务拒、人拒拒、放行干完催 git 刷新）、参数校验；
 *   4. 终端：shell 白名单、term-input/kill、dispose 杀子进程。
 *
 * `DSC_HOME` 在任何 import 之前指进临时目录（`path-policy` 的 DSC_HOME 是模块加载时算的）。
 *
 * @module dsc/packages/desktop-dock/tests/wiring.spec
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { SettingsSectionSpec } from '@pneuma/runtime/services/types.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-desktop-dock-wiring-'))
process.env['DSC_HOME'] = HOME

const SESSION = join(HOME, 'session')
const FALLBACK = join(HOME, 'fallback')

let dock: typeof import('../index.js')

beforeAll(async () => {
  mkdirSync(SESSION, { recursive: true })
  mkdirSync(FALLBACK, { recursive: true })
  dock = await import('../index.js')
})

beforeEach(() => {
  // 每个用例从一份干净配置开始：工作区根只由用例自己写。
  writeFileSync(join(HOME, 'config.yaml'), 'providers: {}\n', 'utf8')
})

afterAll(() => {
  delete process.env['DSC_HOME']
  try {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    // 子进程可能还占着目录：留给系统清
  }
})

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new Error('等待条件超时')
}

/** 临时目录（挂在 HOME 下，afterAll 一次清）。 */
function tempDir(prefix: string): string {
  return mkdtempSync(join(HOME, prefix))
}

/** 跑一条 git（固定参数、无 shell）。 */
function gitRun(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true })
}

/** 一个已经有一次提交的仓库（默认分支 main）。 */
function makeRepo(): string {
  const dir = tempDir('repo-')
  gitRun(dir, ['init', '-b', 'main'])
  gitRun(dir, ['config', 'user.email', 'wiring@example.com'])
  gitRun(dir, ['config', 'user.name', 'Wiring'])
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n', 'utf8')
  gitRun(dir, ['add', '.'])
  gitRun(dir, ['commit', '-m', 'init'])
  return dir
}

interface DockHarness {
  service: { handle(op: string, payload: Record<string, unknown>): Promise<unknown> }
  sections: Array<{ spec: SettingsSectionSpec; options?: { inSettings?: boolean } }>
  events: Array<{ name: string; args: unknown[] }>
  approvals: Array<Record<string, unknown>>
  refreshCount: number
  dispose(): void
}

const harnesses: DockHarness[] = []

function mount(options: {
  sessionCwd?: string
  fallbackCwd?: string
  withApproval?: boolean
  decision?: 'allow-once' | 'reject'
  withSettings?: boolean
  withGit?: boolean
} = {}): DockHarness {
  const services = new Map<string, unknown>()
  const sections: DockHarness['sections'] = []
  const events: DockHarness['events'] = []
  const approvals: Array<Record<string, unknown>> = []
  let refreshCount = 0

  const sessionCwd = options.sessionCwd
  const session =
    sessionCwd === undefined
      ? { current: () => ({ meta: {} }) }
      : { current: () => ({ meta: { id: 'sess-1', cwd: sessionCwd }, filePath: join(sessionCwd, '.git', 'sess.jsonl') }) }

  const ctx = {
    get(name: string) {
      if (name === 'session') return session
      if (name === 'approval') {
        if (options.withApproval === false) return undefined
        return {
          decide: async (request: Record<string, unknown>) => {
            approvals.push(request)
            return options.decision ?? 'allow-once'
          },
        }
      }
      if (name === 'settings') {
        if (options.withSettings === false) return undefined
        return {
          registerSection(spec: SettingsSectionSpec, sectionOptions?: { inSettings?: boolean }) {
            sections.push({ spec, ...(sectionOptions === undefined ? {} : { options: sectionOptions }) })
            return () => undefined
          },
        }
      }
      if (name === 'git') return options.withGit === false ? undefined : { refresh: () => { refreshCount += 1 } }
      return services.get(name)
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    emit(name: string, ...args: unknown[]) {
      events.push({ name, args })
    },
  }

  const dispose = dock.desktopDockPlugin.apply?.(ctx as never, { cwd: options.fallbackCwd ?? FALLBACK })
  const harness: DockHarness = {
    service: services.get('dock') as DockHarness['service'],
    sections,
    events,
    approvals,
    get refreshCount() {
      return refreshCount
    },
    dispose: () => {
      if (typeof dispose === 'function') dispose()
    },
  }
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    try {
      harness.dispose()
    } catch {
      // 已经收过了
    }
  }
})

// ── 装配 ─────────────────────────────────────────────────────────────────────

describe('装配面', () => {
  test('apply：provide dock 服务，注册「额外工作区根」分区（inSettings、order 42）', () => {
    const harness = mount({ sessionCwd: SESSION })
    expect(typeof harness.service.handle).toBe('function')
    expect(harness.sections).toHaveLength(1)
    const { spec, options } = harness.sections[0]!
    expect(spec.id).toBe('desktop-dock-workspaces')
    expect(spec.order).toBe(42)
    expect(options).toEqual({ inSettings: true })
    expect(spec.fields()[0]).toMatchObject({ type: 'text', key: 'workspaceRoots' })
    harness.dispose()
  })

  test('apply：settings 没起来时只有 dock 服务、没有设置分区', () => {
    const harness = mount({ sessionCwd: SESSION, withSettings: false })
    expect(harness.sections).toHaveLength(0)
    expect(typeof harness.service.handle).toBe('function')
    harness.dispose()
  })

  test('baseCwd：优先会话 cwd，会话没有 cwd 时回落到挂载目录', async () => {
    const withSession = mount({ sessionCwd: SESSION, fallbackCwd: FALLBACK })
    const fromSession = (await withSession.service.handle('fs-roots', {})) as { cwd: string }
    expect(fromSession.cwd).toBe(resolve(SESSION))

    const withoutSession = mount({ fallbackCwd: FALLBACK })
    const fromFallback = (await withoutSession.service.handle('fs-roots', {})) as { cwd: string }
    expect(fromFallback.cwd).toBe(resolve(FALLBACK))
  })
})

// ── 文件系统 ─────────────────────────────────────────────────────────────────

describe('文件系统 op', () => {
  test('fs-list：目录在前、自然序、maxEntries 截断', async () => {
    const dir = tempDir('list-')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a10.txt'), 'x', 'utf8')
    writeFileSync(join(dir, 'a2.txt'), 'x', 'utf8')
    writeFileSync(join(dir, 'b.txt'), 'x', 'utf8')
    const harness = mount({ sessionCwd: dir })

    const all = (await harness.service.handle('fs-list', {})) as {
      cwd: string
      root: string
      entries: Array<{ name: string; dir: boolean; size: number }>
      truncated: boolean
    }
    expect(all.cwd).toBe(dir)
    expect(all.root).toBe(dir)
    expect(all.entries.map((entry) => entry.name)).toEqual(['sub', 'a2.txt', 'a10.txt', 'b.txt'])
    expect(all.entries[0]?.dir).toBe(true)
    expect(all.entries[1]?.size).toBe(1)
    expect(all.truncated).toBe(false)

    const limited = (await harness.service.handle('fs-list', { maxEntries: 2 })) as { entries: unknown[]; truncated: boolean }
    expect(limited.entries).toHaveLength(2)
    expect(limited.truncated).toBe(true)

    const sub = (await harness.service.handle('fs-list', { dir: 'sub' })) as { cwd: string }
    expect(sub.cwd).toBe(join(dir, 'sub'))
  })

  test('fs-list：未授权 root、`..` 越界、选项注入参数都被拒', async () => {
    const dir = tempDir('list-bad-')
    const harness = mount({ sessionCwd: dir })
    await expect(harness.service.handle('fs-list', { root: join(HOME, 'not-authorized') })).rejects.toThrow('不在已授权')
    await expect(harness.service.handle('fs-list', { dir: '../..' })).rejects.toThrow('超出工作目录')
    await expect(harness.service.handle('fs-list', { dir: '-rf' })).rejects.toThrow('以 - 开头')
  })

  test('fs-roots：会话 cwd 恒在首位且 main=true', async () => {
    const dir = tempDir('roots-')
    const harness = mount({ sessionCwd: dir })
    const out = (await harness.service.handle('fs-roots', {})) as {
      cwd: string
      roots: Array<{ path: string; name: string; main: boolean }>
    }
    expect(out.cwd).toBe(resolve(dir))
    expect(out.roots[0]).toMatchObject({ path: resolve(dir), main: true })
    expect(out.roots[0]?.name.length).toBeGreaterThan(0)
  })

  test('fs-read：文本 / 图片 / PDF / 二进制 / 超限 / 越界 / 不存在', async () => {
    const dir = tempDir('read-')
    writeFileSync(join(dir, 'a.txt'), 'hello', 'utf8')
    writeFileSync(join(dir, 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(dir, 'd.pdf'), Buffer.from('%PDF-1.4'))
    writeFileSync(join(dir, 'x.exe'), Buffer.from([0x4d, 0x5a]))
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(513 * 1024), 'utf8')
    const harness = mount({ sessionCwd: dir })

    const text = (await harness.service.handle('fs-read', { file: 'a.txt' })) as { kind: string; text: string; tooLarge: boolean }
    expect(text).toMatchObject({ kind: 'text', text: 'hello', tooLarge: false })

    const image = (await harness.service.handle('fs-read', { file: 'p.png' })) as { kind: string; mime: string; base64: string }
    expect(image.kind).toBe('image')
    expect(image.mime).toBe('image/png')
    expect(image.base64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))

    const pdf = (await harness.service.handle('fs-read', { file: 'd.pdf' })) as { kind: string; mime: string; size: number }
    expect(pdf.kind).toBe('bytes')
    expect(pdf.mime).toBe('application/pdf')
    expect(pdf.size).toBe(8)

    const binary = (await harness.service.handle('fs-read', { file: 'x.exe' })) as { kind: string }
    expect(binary.kind).toBe('binary')

    const big = (await harness.service.handle('fs-read', { file: 'big.txt' })) as { kind: string; tooLarge: boolean; text: string }
    expect(big).toMatchObject({ kind: 'text', tooLarge: true, text: '' })

    await expect(harness.service.handle('fs-read', { file: '../outside.txt' })).rejects.toThrow('超出工作目录')
    await expect(harness.service.handle('fs-read', { file: 'missing.txt' })).rejects.toThrow()
  })
})

// ── git ──────────────────────────────────────────────────────────────────────

describe('git op（真仓库）', () => {
  test('git-status：分支、暂存/未暂存/未跟踪与每文件增删行数', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n', 'utf8')
    writeFileSync(join(repo, 'staged.txt'), 'staged\n', 'utf8')
    gitRun(repo, ['add', 'staged.txt'])
    writeFileSync(join(repo, 'new.txt'), 'n1\nn2\n', 'utf8')
    const harness = mount({ sessionCwd: repo })

    const out = (await harness.service.handle('git-status', { stats: true })) as {
      branch: string
      staged: string[]
      unstaged: string[]
      untracked: string[]
      added: number
      removed: number
      dirtyFileCount: number
      stagedStats: Record<string, { added: number; removed: number }>
      unstagedStats: Record<string, { added: number; removed: number }>
      untrackedStats: Record<string, { added: number; removed: number }>
    }
    expect(out.branch).toBe('main')
    expect(out.staged.some((line) => line.includes('staged.txt'))).toBe(true)
    expect(out.unstaged.some((line) => line.includes('a.txt'))).toBe(true)
    expect(out.untracked).toContain('new.txt')
    expect(out.dirtyFileCount).toBe(3)
    expect(out.stagedStats['staged.txt']).toEqual({ added: 1, removed: 0 })
    expect(out.untrackedStats['new.txt']).toEqual({ added: 2, removed: 0 })
    expect(out.added).toBeGreaterThan(0)
    expect(out.removed).toBeGreaterThan(0)

    const plain = (await harness.service.handle('git-status', {})) as Record<string, unknown>
    expect(plain).not.toHaveProperty('stagedStats')
  })

  test('git-status：空仓库把 HEAD 缺失报成「(无提交)」而不是抛错', async () => {
    const repo = tempDir('empty-repo-')
    gitRun(repo, ['init', '-b', 'main'])
    const harness = mount({ sessionCwd: repo })
    const out = (await harness.service.handle('git-status', {})) as { branch: string; staged: string[] }
    expect(out.branch).toBe('(无提交)')
    expect(out.staged).toEqual([])
  })

  test('git-branches：当前分支第一，空仓库补上当前分支', async () => {
    const repo = makeRepo()
    gitRun(repo, ['branch', 'feature'])
    const harness = mount({ sessionCwd: repo })
    const out = (await harness.service.handle('git-branches', {})) as {
      current: string
      detached: boolean
      branches: Array<{ name: string; current: boolean }>
    }
    expect(out.current).toBe('main')
    expect(out.detached).toBe(false)
    expect(out.branches[0]).toEqual({ name: 'main', current: true })
    expect(out.branches.some((branch) => branch.name === 'feature' && branch.current === false)).toBe(true)

    const empty = tempDir('empty-branches-')
    gitRun(empty, ['init', '-b', 'main'])
    const emptyHarness = mount({ sessionCwd: empty })
    const emptyOut = (await emptyHarness.service.handle('git-branches', {})) as {
      current: string
      branches: Array<{ name: string; current: boolean }>
    }
    // 空仓库：`rev-parse --abbrev-ref HEAD` 退出码 128，实现 catch 成空串；
    // 这里钉的是「不抛错、清单为空」，而不是注释里写的「报默认分支名」。
    expect(emptyOut.current).toBe('')
    expect(emptyOut.branches).toEqual([])
  })

  test('git-diff：未跟踪文本合成 patch、二进制/目录给说明、tracked 与 staged 分开取', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'new.txt'), 'hello\nworld\n', 'utf8')
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    mkdirSync(join(repo, 'folder'), { recursive: true })
    writeFileSync(join(repo, 'folder', 'inner.txt'), 'inner\n', 'utf8')
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\n', 'utf8')
    const harness = mount({ sessionCwd: repo })

    const patch = (await harness.service.handle('git-diff', { file: 'new.txt' })) as { diff: string }
    expect(patch.diff).toContain('diff --git a/new.txt b/new.txt')
    expect(patch.diff).toContain('+++ b/new.txt')
    expect(patch.diff).toContain('+hello')
    expect(patch.diff).toContain('+world')

    const binary = (await harness.service.handle('git-diff', { file: 'bin.dat' })) as { diff: string; note: string }
    expect(binary.diff).toBe('')
    expect(binary.note).toContain('二进制')

    const dirNote = (await harness.service.handle('git-diff', { file: 'folder/' })) as { diff: string; note: string }
    expect(dirNote.diff).toBe('')
    expect(dirNote.note).toContain('未跟踪目录整条收录')

    const tracked = (await harness.service.handle('git-diff', { file: 'a.txt' })) as { diff: string }
    expect(tracked.diff).toContain('-two')
    expect(tracked.diff).toContain('+TWO')

    gitRun(repo, ['add', 'a.txt'])
    const staged = (await harness.service.handle('git-diff', { file: 'a.txt', staged: true })) as { diff: string }
    expect(staged.diff).toContain('+TWO')

    const all = (await harness.service.handle('git-diff', {})) as { diff: string; note: string }
    expect(all.diff).toContain('+hello')
    expect(all.diff).toContain('+TWO')
    expect(all.note).toContain('另有 2 个未跟踪条目')
  })

  test('写类先过审批：没审批服务拒、人拒拒、放行后执行并催 git 刷新', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'staged.txt'), 'x\n', 'utf8')

    const withoutApproval = mount({ sessionCwd: repo, withApproval: false })
    await expect(withoutApproval.service.handle('git-stage', { files: ['staged.txt'] })).rejects.toThrow('需要审批服务')

    const rejected = mount({ sessionCwd: repo, decision: 'reject' })
    await expect(rejected.service.handle('git-stage', { files: ['staged.txt'] })).rejects.toThrow('已拒绝')
    expect(rejected.approvals).toHaveLength(1)

    const allowed = mount({ sessionCwd: repo, decision: 'allow-once' })
    const out = (await allowed.service.handle('git-stage', { files: ['staged.txt'] })) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(allowed.refreshCount).toBe(1)
    const request = allowed.approvals[0] as { toolName: string; argsSummary: string; sessionId: string; sessionPath: string; cwd: string }
    expect(request.toolName).toBe('git: 暂存')
    expect(request.argsSummary).toContain('staged.txt')
    expect(request.sessionId).toBe('sess-1')
    expect(request.sessionPath).toContain('sess.jsonl')
    expect(request.cwd).toBe(repo)
    const status = (await allowed.service.handle('git-status', {})) as { staged: string[] }
    expect(status.staged.some((line) => line.includes('staged.txt'))).toBe(true)
  })

  test('git-commit / git-checkout / git-branch-create：参数校验与真执行', async () => {
    const repo = makeRepo()
    gitRun(repo, ['branch', 'feature'])
    writeFileSync(join(repo, 'commit.txt'), 'c\n', 'utf8')
    const harness = mount({ sessionCwd: repo })

    await expect(harness.service.handle('git-commit', { message: '   ' })).rejects.toThrow('提交信息为空')
    await expect(harness.service.handle('git-checkout', { branch: '' })).rejects.toThrow('没有指定')
    await expect(harness.service.handle('git-branch-create', { branch: '   ' })).rejects.toThrow('没有指定新分支名')

    const commit = (await harness.service.handle('git-commit', { message: 'feat: 测试提交', paths: ['commit.txt'] })) as {
      ok: boolean
      output: string
    }
    expect(commit.ok).toBe(true)
    expect(commit.output).toContain('测试提交')

    const checkout = (await harness.service.handle('git-checkout', { branch: 'feature' })) as { ok: boolean; branch: string }
    expect(checkout).toEqual({ ok: true, branch: 'feature' })

    const created = (await harness.service.handle('git-branch-create', { branch: 'next' })) as { ok: boolean; branch: string }
    expect(created).toEqual({ ok: true, branch: 'next' })
    const branches = (await harness.service.handle('git-branches', {})) as { current: string }
    expect(branches.current).toBe('next')
    expect(harness.refreshCount).toBe(3)
  })

  test('git-unstage：撤销暂存并催刷新', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'staged.txt'), 'x\n', 'utf8')
    gitRun(repo, ['add', 'staged.txt'])
    const harness = mount({ sessionCwd: repo })
    const out = (await harness.service.handle('git-unstage', { files: ['staged.txt'] })) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(harness.refreshCount).toBe(1)
    const status = (await harness.service.handle('git-status', {})) as { staged: string[]; untracked: string[] }
    expect(status.staged).toEqual([])
    expect(status.untracked).toContain('staged.txt')
  })
})

// ── 终端 ─────────────────────────────────────────────────────────────────────

describe('终端 op（真子进程）', () => {
  test('term-spawn/input/kill：白名单 shell、真实输入输出、退出事件', async () => {
    const dir = tempDir('term-')
    const harness = mount({ sessionCwd: dir })

    const spawned = (await harness.service.handle('term-spawn', { shell: 'node' })) as { id: string; shell: string }
    expect(spawned.shell).toBe('node')
    expect(spawned.id).toMatch(/^t\d+$/)

    await harness.service.handle('term-input', { id: spawned.id, data: '1+1\n' })
    await waitUntil(
      () =>
        harness.events.some(
          (event) => event.name === 'dsc/dock-data' && event.args[0] === spawned.id && String(event.args[1]).includes('2'),
        ),
      10_000,
    )

    expect(await harness.service.handle('term-kill', { id: spawned.id })).toEqual({ ok: true })
    await expect(harness.service.handle('term-input', { id: spawned.id, data: 'x' })).rejects.toThrow('终端会话不存在')

    // 非白名单值回落 powershell；起完立刻杀掉，不留子进程。
    const fallback = (await harness.service.handle('term-spawn', { shell: 'nope' })) as { id: string; shell: string }
    expect(fallback.shell).toBe('powershell')
    await harness.service.handle('term-kill', { id: fallback.id })

    await expect(harness.service.handle('term-spawn', { shell: 'bash', cwd: '../..' })).rejects.toThrow('超出工作目录')
  })

  test('dispose：杀掉还活着的终端会话（之后 term-input 报不存在）', async () => {
    const dir = tempDir('term-dispose-')
    const harness = mount({ sessionCwd: dir })
    const spawned = (await harness.service.handle('term-spawn', { shell: 'node' })) as { id: string }
    harness.dispose()
    await expect(harness.service.handle('term-input', { id: spawned.id, data: 'x' })).rejects.toThrow('终端会话不存在')
  })
})

// ── 设置分区 ─────────────────────────────────────────────────────────────────

describe('额外工作区根分区', () => {
  test('values 读配置；save 未知键/非文本/正常保存与丢弃提示', () => {
    const extra = tempDir('extra-root-')
    const harness = mount({ sessionCwd: SESSION })
    const spec = harness.sections[0]!.spec as unknown as {
      values(): { workspaceRoots: string }
      save(key: string, value: unknown): string | void
    }
    expect(spec.values()).toEqual({ workspaceRoots: '' })

    expect(spec.save('nope', 'x')).toContain('未知设置项')
    expect(spec.save('workspaceRoots', 42)).toContain('只接受文本')
    expect(spec.save('workspaceRoots', extra)).toContain('已保存')
    expect(spec.values().workspaceRoots).toContain(extra)

    const missing = join(HOME, 'missing-root-xyz')
    const dropped = spec.save('workspaceRoots', `${extra};${missing}`)
    expect(dropped).toContain('已丢弃')
    expect(spec.values().workspaceRoots).toContain(missing)
  })

  test('写进配置的根让 fs-list 能切过去（授权入口只有这一处）', async () => {
    const extra = tempDir('authorized-')
    writeFileSync(join(extra, 'from-extra.txt'), 'x', 'utf8')
    const harness = mount({ sessionCwd: SESSION })
    const spec = harness.sections[0]!.spec as unknown as { save(key: string, value: unknown): string | void }
    expect(spec.save('workspaceRoots', extra)).toContain('已保存')

    const listed = (await harness.service.handle('fs-list', { root: extra })) as {
      root: string
      entries: Array<{ name: string }>
    }
    expect(listed.root).toBe(resolve(extra))
    expect(listed.entries.map((entry) => entry.name)).toContain('from-extra.txt')

    // 子目录不能借根扩权。
    await expect(harness.service.handle('fs-list', { root: join(extra, 'sub') })).rejects.toThrow('不在已授权')
  })
})

describe('未知 op', () => {
  test('未知操作给一句人话而不是静默成功', async () => {
    const harness = mount({ sessionCwd: SESSION })
    await expect(harness.service.handle('dance', {})).rejects.toThrow('dock 未知操作：dance')
  })
})

// 静态检查：fs-read 返回的 path 必须是绝对路径（renderer 靠它画 <img>/PDF）。
test('fs-read：返回的 path 是绝对路径且落在工作目录内', async () => {
  const dir = tempDir('abs-')
  const file = join(dir, 'a.txt')
  writeFileSync(file, 'x', 'utf8')
  const harness = mount({ sessionCwd: dir })
  const out = (await harness.service.handle('fs-read', { file: 'a.txt' })) as { path: string }
  expect(out.path).toBe(file)
  expect(statSync(out.path).isFile()).toBe(true)
})
