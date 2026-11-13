/**
 * @pneuma/doctor 的包级测试：钉住登记表的四条语义与两种输出。
 *
 * 为什么不去跑那九项真检查：它们会探 shell、发网络请求、扫整个 `~/.dsc`，
 * 在单测里既慢又依赖机器状态。这里验的是**登记表本身**——排序、计数、单项抛错不扩散、
 * 重复 id 拒绝——以及渲染出的文本形状。九项各自的行为留给真机冒烟（README 的验证一节）。
 *
 * 迁移说明：原来 `apply` 那一层靠 `scripts/_testkit.mjs` 的 `mountPlugin` / `expectRegistered` /
 * `readPackage`，现在改成测试自己的假 ctx（只实现 apply 会碰的 `settings` / `provide` / `get` /
 * `commands`），并直接读 `package.json` 与 `cordis.patch.yml`——脚本层将来删掉不影响本文件。
 * 其余断言本来就是运行时值，只换断言库。
 *
 * @module @pneuma/doctor/tests
 */
import type { HealthCheck, HealthReport } from '@pneuma/runtime/services/types.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { buildBundle, readSessionExcerpt } from '../bundle.js'
import { lockIsStale } from '../checks/data.js'
import { createHealthRegistry, doctorPlugin, renderJson, renderText } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 造一条检查。 */
const check = (
  id: string,
  order: number | undefined,
  result: { status: 'ok' | 'warn' | 'fail' | 'skip'; summary: string; fix?: string; detail?: string },
): HealthCheck => ({ id, title: id.toUpperCase(), order, run: () => result })

/** 本文件写的临时目录，统一在 afterAll 删。 */
const tempDirs: string[] = []

/** 建一个临时目录并登记清理。 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

test('清单与装配行对得上', () => {
  const pkg = JSON.parse(read('../package.json')) as { name: string; pneuma: { order?: number } }
  const patch = read('../cordis.patch.yml')
  expect(pkg.name).toBe('@pneuma/doctor')
  expect(Number.isInteger(pkg.pneuma.order)).toBe(true)
  expect(patch).toContain("name: '@pneuma/doctor'")
})

test('装起来之后 health 服务与 /doctor 命令都在', () => {
  // 只验「挂上了」，不去跑那九项：terminal 会真起子进程、reachability 会真发请求，
  // 那些属于真机冒烟（见包 README 的验证一节）。假 ctx 只实现 apply 会碰的面。
  const services: Record<string, { run?: unknown; register?: unknown }> = {}
  const commands: string[] = []
  const ctx = {
    settings: {},
    get: () => undefined,
    provide: (name: string, value: { run?: unknown; register?: unknown }) => {
      services[name] = value
      return () => {}
    },
    commands: {
      register: (spec: { name: string }) => {
        commands.push(spec.name)
        return () => {}
      },
    },
  }
  const dispose = doctorPlugin.apply(ctx as never) as unknown
  expect(typeof services['health']?.run).toBe('function')
  expect(typeof services['health']?.register).toBe('function')
  expect(commands).toContain('doctor')
  if (typeof dispose === 'function') dispose()
})

test('按 order 排序，缺省排最后', async () => {
  const health = createHealthRegistry()
  health.register(check('b', 20, { status: 'ok', summary: 'b' }))
  health.register(check('c', undefined, { status: 'ok', summary: 'c' }))
  health.register(check('a', 10, { status: 'ok', summary: 'a' }))
  const report = await health.run()
  expect(report.entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
})

test('四种状态分别计数', async () => {
  const health = createHealthRegistry()
  health.register(check('one', 1, { status: 'ok', summary: 'ok' }))
  health.register(check('two', 2, { status: 'warn', summary: 'warn' }))
  health.register(check('three', 3, { status: 'fail', summary: 'fail' }))
  health.register(check('four', 4, { status: 'skip', summary: 'skip' }))
  const report = await health.run()
  expect([report.ok, report.warn, report.fail, report.skip]).toEqual([1, 1, 1, 1])
})

test('单项抛错只算该项失败，其余照跑', async () => {
  const health = createHealthRegistry()
  health.register({
    id: 'boom',
    title: 'BOOM',
    order: 1,
    run() {
      throw new Error('炸了')
    },
  })
  health.register(check('after', 2, { status: 'ok', summary: '照跑' }))
  const report = await health.run()
  expect(report.fail).toBe(1)
  expect(report.entries.some((entry) => entry.id === 'boom' && entry.summary.includes('抛错'))).toBe(true)
  expect(report.entries.some((entry) => entry.id === 'after' && entry.status === 'ok')).toBe(true)
})

test('重复 id 当场抛错', () => {
  const health = createHealthRegistry()
  health.register(check('dup', 1, { status: 'ok', summary: '' }))
  expect(() => health.register(check('dup', 2, { status: 'ok', summary: '' }))).toThrow(/重复/)
})

test('退订之后不再出现在报告里', async () => {
  const health = createHealthRegistry()
  const off = health.register(check('gone', 1, { status: 'ok', summary: '' }))
  off()
  const report = await health.run()
  expect(report.entries.length).toBe(0)
})

test('人读版有标题、标记与汇总', async () => {
  const health = createHealthRegistry()
  health.register(check('okitem', 1, { status: 'ok', summary: '一切正常' }))
  health.register(check('baditem', 2, { status: 'fail', summary: '坏了', fix: '这样修' }))
  const text = renderText(await health.run())
  expect(text).toContain('Pneuma Doctor')
  expect(text).toContain('✓')
  expect(text).toContain('✗')
  expect(text).toContain('修复：这样修')
  expect(text).toContain('1 项失败')
})

test('--json 可解析且家目录被抹成 ~', async () => {
  const home = homedir()
  const health = createHealthRegistry()
  health.register(check('probe', 1, { status: 'ok', summary: `在 ${home}`, detail: `路径 ${home}` }))
  const json = JSON.parse(renderJson(await health.run())) as {
    version: string | null
    counts: { ok: number }
    checks: Record<string, { status: string }>
  }
  expect(json.checks['probe']?.status).toBe('ok')
  expect(typeof json.version === 'string' || json.version === null).toBe(true)
  expect(json.counts.ok).toBeGreaterThanOrEqual(1)
  expect(JSON.stringify(json)).not.toContain(home)
})

// ── 锁的判定：`.lock` 常驻是设计（flock 锚点），只有「主人不在了」才算残留 ──
test('锁的主人活着 / 死了 / 认不出，三种结论分明', () => {
  const dir = tempDir('dsc-doctor-lock-')
  const write = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, body, 'utf8')
    return path
  }

  expect(lockIsStale(write('self.lock', JSON.stringify({ pid: process.pid })))).toBe(false)
  expect(lockIsStale(write('alive.lock', JSON.stringify({ pid: 4242 })), () => true)).toBe(false)
  expect(lockIsStale(write('dead.lock', JSON.stringify({ pid: 4242 })), () => false)).toBe(true)
  expect(lockIsStale(write('broken.lock', '{半截'))).toBeUndefined()
  expect(lockIsStale(write('nopid.lock', JSON.stringify({ at: 1 })))).toBeUndefined()
})

// ── 诊断包：给出去的东西必须是能贴的 ────────────────────────────────────────

/** 造一份够真的体检结果。 */
function sampleReport(extra: Partial<HealthReport> = {}): HealthReport {
  return {
    at: Date.now(),
    entries: [
      { id: 'install', title: '安装', status: 'ok', summary: '0.9.1', detail: `应用根：${homedir()}\\dsc` },
      {
        id: 'session',
        title: '会话',
        status: 'warn',
        summary: `最近会话在 ${homedir()}\\dsc\\sessions`,
        fix: '删掉残留锁',
      },
    ],
    ok: 1,
    warn: 1,
    fail: 0,
    skip: 0,
    ...extra,
  }
}

test('诊断包把家目录抹成 ~，并且明说没收录什么', () => {
  const bundle = buildBundle({
    report: sampleReport(),
    logTail: [`warn 在 ${homedir()} 下出错了`],
    sessionPaths: [join(homedir(), 'dsc', 'sessions', 'a.jsonl')],
  })
  const text = JSON.stringify(bundle)
  expect(text).not.toContain(homedir())
  expect(text).toContain('~')
  expect(bundle.excluded.some((item: string) => item.includes('密钥'))).toBe(true)
  expect({ ...bundle.doctor.counts }).toEqual({ ok: 1, warn: 1, fail: 0, skip: 0 })
  expect(bundle.logs.lines).toBe(1)
})

test('诊断包只留最后 300 行日志', () => {
  const tail = Array.from({ length: 500 }, (_, index) => `line ${index}`)
  const bundle = buildBundle({ report: sampleReport(), logTail: tail })
  expect(bundle.logs.lines).toBe(300)
  expect(bundle.logs.tail[0]).toBe('line 200')
  expect(bundle.logs.tail.at(-1)).toBe('line 499')
})

// ── 会话摘要：只有在用户明确加 --with-session 时才进包 ──────────────────────

/** 造一份临时会话日志（目录登记给 afterAll 清理）。 */
function writeSession(lines: unknown[]): string {
  const dir = tempDir('dsc-excerpt-')
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  return file
}

test('会话摘要跳过 meta / state，只留对话与工具名', () => {
  const file = writeSession([
    { type: 'meta', id: 'x', cwd: 'D:\\w', createdAt: 1 },
    { type: 'state', id: 'mode', payload: 'plan' },
    { type: 'user', text: '你好' },
    { type: 'assistant', text: '在' },
    { type: 'tool', callId: 'c1', name: 'read', text: '文件内容' },
  ])
  const excerpt = readSessionExcerpt(file)
  expect(excerpt.events.map((event) => event.role)).toEqual(['user', 'assistant', 'tool'])
  expect(excerpt.events[2]?.name).toBe('read')
  expect(excerpt.total).toBe(3)
  expect(excerpt.truncated).toBe(false)
})

test('会话摘要里的密钥被抹、长文被截断', () => {
  const long = `开头 sk-abcdefgh12345678 ${'x'.repeat(600)}`
  const file = writeSession([
    { type: 'meta', id: 'x', cwd: 'D:\\w', createdAt: 1 },
    { type: 'assistant', text: long },
  ])
  const excerpt = readSessionExcerpt(file)
  const text = excerpt.events[0]?.text ?? ''
  expect(text).not.toContain('12345678')
  expect(text).toContain('sk-***')
  expect(text.endsWith('…（截断）')).toBe(true)
})

test('带了会话摘要就不能再说「不含会话内容」', () => {
  const base = buildBundle({ report: sampleReport(), logTail: [] })
  expect(base.excluded).toContain('会话的完整内容')

  const withExcerpt = buildBundle({
    report: sampleReport(),
    logTail: [],
    sessionExcerpt: { file: '~/x.jsonl', total: 1, truncated: false, events: [{ role: 'user', text: '你好' }] },
  })
  expect(withExcerpt.excluded).not.toContain('会话的完整内容')
  expect(withExcerpt.sessionExcerpt?.events[0]?.text).toBe('你好')
})
