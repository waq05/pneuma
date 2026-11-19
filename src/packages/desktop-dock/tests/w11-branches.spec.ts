/**
 * desktop-dock 的补盲（`packages/desktop-dock/index.ts`）：git 读数与未跟踪预览的边角、
 * 终端 shell 白名单、文件面板的二进制/超大判定，以及参数净化的拒绝路径。
 *
 * 假 ctx 与真 git 仓库（临时目录）；终端只起本机存在的 shell，收尾统一 kill。
 * `DSC_HOME` 在任何 import 之前指进临时目录（配置模块求值时算定）。
 *
 * @module dsc/packages/desktop-dock/tests/w11-branches.spec
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'

const HOME = mkdtempSync(join(tmpdir(), 'dsc-dock-w11-'))
process.env['DSC_HOME'] = HOME
const SESSION = join(HOME, 'session')
const FALLBACK = join(HOME, 'fallback')
mkdirSync(SESSION, { recursive: true })
mkdirSync(FALLBACK, { recursive: true })

const dock = await import('../index.js')
const { desktopDockPlugin, workspacePathInside } = dock

const created: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(HOME, prefix))
  created.push(dir)
  return dir
}

const gitRun = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true })
}

function makeRepo(): string {
  const dir = tempDir('repo-')
  gitRun(dir, ['init', '-b', 'main'])
  gitRun(dir, ['config', 'user.email', 'w11@example.com'])
  gitRun(dir, ['config', 'user.name', 'W11'])
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n', 'utf8')
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]))
  gitRun(dir, ['add', '.'])
  gitRun(dir, ['commit', '-m', 'init'])
  return dir
}

interface Harness {
  service: { handle(op: string, payload: Record<string, unknown>): Promise<unknown> }
  dispose(): void
}

const harnesses: Harness[] = []

function mount(sessionCwd: string): Harness {
  const services = new Map<string, unknown>()
  const ctx = {
    get(name: string) {
      if (name === 'session') return { current: () => ({ meta: { id: 's1', cwd: sessionCwd }, filePath: join(sessionCwd, 's.jsonl') }) }
      if (name === 'approval') return { decide: async () => 'allow-once' }
      if (name === 'settings') return { registerSection: () => () => undefined }
      if (name === 'git') return { refresh: () => undefined }
      return services.get(name)
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    emit() {
      // 事件只用于观察，这里不取
    },
  }
  const dispose = desktopDockPlugin.apply?.(ctx as never, { cwd: FALLBACK, workspaceRoots: [] })
  const harness: Harness = {
    service: services.get('dock') as Harness['service'],
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
      // 已经收过
    }
  }
})

afterAll(() => {
  delete process.env['DSC_HOME']
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // Windows 上终端子进程可能还占着目录
    }
  }
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('workspacePathInside：相对路径/另一个盘/UNC 都不算根内', () => {
  const root = process.platform === 'win32' ? 'C:\\ws' : '/ws'
  expect(workspacePathInside('relative/path', root)).toBe(false)
  if (process.platform === 'win32') {
    expect(workspacePathInside('D:\\ws\\a', 'C:\\ws')).toBe(false)
    expect(workspacePathInside('\\\\srv\\share\\a', 'C:\\ws')).toBe(false)
    expect(workspacePathInside('C:\\ws\\a\\b', 'C:\\ws')).toBe(true)
  } else {
    expect(workspacePathInside('/other/a', '/ws')).toBe(false)
    expect(workspacePathInside('/ws/a/b', '/ws')).toBe(true)
  }
})

test('git-status：rename 走新路径、二进制 0/0、空未跟踪不进列表', async () => {
  const repo = makeRepo()
  const h = mount(repo)

  gitRun(repo, ['mv', 'a.txt', 'renamed.txt'])
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x61, 0x00, 0x63]))
  writeFileSync(join(repo, 'empty.txt'), '', 'utf8')
  writeFileSync(join(repo, 'inside.txt'), 'a\nb\n', 'utf8')

  const status = (await h.service.handle('git-status', { stats: true })) as {
    staged: string[]
    unstaged: string[]
    untracked: string[]
    untrackedStats?: Record<string, { added: number; removed: number }>
    unstagedStats?: Record<string, { added: number; removed: number }>
  }
  expect(status.staged.some((line) => line.includes('renamed.txt'))).toBe(true)
  expect(status.untracked).toContain('inside.txt')
  expect(status.untracked).not.toContain('empty.txt')
  expect(status.untrackedStats?.['inside.txt']).toEqual({ added: 2, removed: 0 })
  expect(status.unstagedStats?.['bin.dat']).toEqual({ added: 0, removed: 0 })
})

test('git-status：会话 cwd 在子目录时，仓库根那侧的改动整条不列', async () => {
  const repo = makeRepo()
  const sub = join(repo, 'sub')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, 'keep.txt'), 'k\n', 'utf8')
  const h = mount(sub)
  writeFileSync(join(repo, 'outside.txt'), 'outside\n', 'utf8')
  writeFileSync(join(sub, 'inside.txt'), 'in\n', 'utf8')

  const status = (await h.service.handle('git-status', { stats: true })) as {
    staged: string[]
    unstaged: string[]
    untracked: string[]
    dirtyFileCount: number
  }
  expect(status.dirtyFileCount).toBe(1)
  expect(status.untracked).toEqual([])
  expect(status.staged).toEqual([])
  expect(status.unstaged).toEqual([])
})

test('git-status：空仓库（HEAD 未出生）照常返回分支与未跟踪列表', async () => {
  const repo = tempDir('repo-empty-')
  gitRun(repo, ['init', '-b', 'main'])
  const h = mount(repo)
  writeFileSync(join(repo, 'new.txt'), 'x\n', 'utf8')
  const status = (await h.service.handle('git-status', { stats: false })) as { untracked: string[] }
  expect(status.untracked).toContain('new.txt')
})

test('git-diff：未跟踪条目的缺失/目录/超大/二进制/空文件各给说明', async () => {
  const repo = makeRepo()
  mkdirSync(join(repo, 'dir'), { recursive: true })
  writeFileSync(join(repo, 'dir', 'inner.txt'), 'x\n', 'utf8')
  writeFileSync(join(repo, 'big.txt'), 'x'.repeat(512 * 1024 + 10), 'utf8')
  writeFileSync(join(repo, 'bin2.bin'), Buffer.from([0x00, 0x01]))
  writeFileSync(join(repo, 'empty2.txt'), '', 'utf8')
  const h = mount(repo)

  const missing = (await h.service.handle('git-diff', { file: 'gone.txt' })) as { diff: string; note?: string }
  expect(missing.diff).toBe('')

  const dir = (await h.service.handle('git-diff', { file: 'dir' })) as { note?: string }
  expect(dir.note).toContain('未跟踪目录')

  const big = (await h.service.handle('git-diff', { file: 'big.txt' })) as { note?: string }
  expect(big.note).toContain('不合成预览')

  const bin = (await h.service.handle('git-diff', { file: 'bin2.bin' })) as { note?: string }
  expect(bin.note).toContain('二进制')

  const empty = (await h.service.handle('git-diff', { file: 'empty2.txt' })) as { note?: string }
  expect(empty.note).toContain('空文件')
})

test('git-diff：超过 40 个未跟踪条目时跳过其余并计数', async () => {
  const repo = makeRepo()
  for (let i = 0; i < 42; i += 1) writeFileSync(join(repo, `u${String(i)}.txt`), `line ${String(i)}\n`, 'utf8')
  const h = mount(repo)
  const result = (await h.service.handle('git-diff', {})) as { note?: string }
  expect(result.note).toMatch(/另有 \d+ 个未跟踪条目/)
})

test('git-diff：空仓库没有 HEAD 时也能出 tracked + 未跟踪合成段', async () => {
  const repo = tempDir('repo-no-head-')
  gitRun(repo, ['init', '-b', 'main'])
  gitRun(repo, ['config', 'user.email', 'w11@example.com'])
  gitRun(repo, ['config', 'user.name', 'W11'])
  writeFileSync(join(repo, 'tracked.txt'), 'a\n', 'utf8')
  gitRun(repo, ['add', 'tracked.txt'])
  writeFileSync(join(repo, 'tracked.txt'), 'a\nb\n', 'utf8')
  writeFileSync(join(repo, 'untracked.txt'), 'u\n', 'utf8')
  const h = mount(repo)
  const result = (await h.service.handle('git-diff', {})) as { diff: string }
  expect(result.diff).toContain('untracked.txt')
  expect(result.diff).toContain('+b')
})

test('fs-read：超大图片 / 超大 PDF 标 tooLarge；图片与二进制扩展名走对应 kind', async () => {
  const repo = tempDir('fs-')
  writeFileSync(join(repo, 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 1))
  writeFileSync(join(repo, 'big.pdf'), Buffer.alloc(10 * 1024 * 1024 + 1))
  writeFileSync(join(repo, 'pic.png'), Buffer.from([1, 2, 3]))
  writeFileSync(join(repo, 'tool.exe'), Buffer.from([0x4d, 0x5a]))
  writeFileSync(join(repo, 'big.txt'), 'x'.repeat(600 * 1024), 'utf8')
  const h = mount(repo)

  expect(await h.service.handle('fs-read', { file: 'big.png' })).toMatchObject({ kind: 'image', tooLarge: true })
  expect(await h.service.handle('fs-read', { file: 'big.pdf' })).toMatchObject({ kind: 'bytes', tooLarge: true })
  expect(await h.service.handle('fs-read', { file: 'pic.png' })).toMatchObject({ kind: 'image', tooLarge: false })
  expect(await h.service.handle('fs-read', { file: 'tool.exe' })).toMatchObject({ kind: 'binary' })
  expect(await h.service.handle('fs-read', { file: 'big.txt' })).toMatchObject({ kind: 'text', tooLarge: true })
})

test('参数净化：换行与选项注入位都拒；空分支名也拒', async () => {
  const repo = makeRepo()
  const h = mount(repo)
  await expect(h.service.handle('fs-read', { file: 'a\nb.txt' })).rejects.toThrow(/含换行/)
  await expect(h.service.handle('git-diff', { file: '--no-index' })).rejects.toThrow(/以 - 开头/)
  await expect(h.service.handle('git-branch-create', { branch: '  ' })).rejects.toThrow(/没有指定新分支名/)
  await expect(h.service.handle('git-checkout', { branch: '' })).rejects.toThrow(/没有指定要切到哪个分支/)
})

test('git-log 与终端：白名单内 shell 能起、未知值回落 powershell、term-kill 收干净', async () => {
  const repo = makeRepo()
  const h = mount(repo)
  const log = (await h.service.handle('git-log', {})) as { log: string }
  expect(log.log).toContain('init')

  if (process.platform === 'win32') {
    const spawn = async (shell: string): Promise<string> => {
      const out = (await h.service.handle('term-spawn', { shell, cwd: '.' })) as { id: string; shell: string }
      await h.service.handle('term-kill', { id: out.id })
      return out.shell
    }
    expect(await spawn('cmd')).toBe('cmd')
    expect(await spawn('node')).toBe('node')
    expect(await spawn('no-such-shell')).toBe('powershell')
    expect(await spawn('powershell')).toBe('powershell')
  }
})
