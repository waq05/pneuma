/**
 * @pneuma/doctor 的包级测试：钉住登记表的四条语义与两种输出。
 *
 * 为什么不去跑那九项真检查：它们会探 shell、发网络请求、扫整个 `~/.dsc`，
 * 在单测里既慢又依赖机器状态。这里验的是**登记表本身**——排序、计数、单项抛错不扩散、
 * 重复 id 拒绝——以及渲染出的文本形状。九项各自的行为留给真机冒烟（README 的验证一节）。
 *
 * @module @pneuma/doctor/tests
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { expectRegistered, mountPlugin, readPackage } from '../../../../scripts/_testkit.mjs'

const { createHealthRegistry, renderJson, renderText } = await import('../../../../lib/packages/doctor/index.js')

/** 造一条检查。 */
const check = (id, order, result) => ({ id, title: id.toUpperCase(), order, run: () => result })

test('清单与装配行对得上', () => {
  const { pkg, patch } = readPackage('doctor')
  assert.equal(pkg.name, '@pneuma/doctor')
  assert.ok(Number.isInteger(pkg.pneuma.order))
  assert.ok(patch.includes("name: '@pneuma/doctor'"))
})

test('装起来之后 health 服务与 /doctor 命令都在', async () => {
  // 只验「挂上了」，不去跑那九项：terminal 会真起子进程、reachability 会真发请求，
  // 那些属于真机冒烟（见包 README 的验证一节）。
  const { captured, dispose } = await mountPlugin('doctor')
  assert.equal(typeof captured.services['health']?.run, 'function', 'health 服务没登记')
  assert.equal(typeof captured.services['health']?.register, 'function', 'health.register 不在')
  expectRegistered(captured, 'commands', 'doctor')
  dispose()
})

test('按 order 排序，缺省排最后', async () => {
  const health = createHealthRegistry()
  health.register(check('b', 20, { status: 'ok', summary: 'b' }))
  health.register(check('c', undefined, { status: 'ok', summary: 'c' }))
  health.register(check('a', 10, { status: 'ok', summary: 'a' }))
  const report = await health.run()
  assert.deepEqual(report.entries.map((entry) => entry.id), ['a', 'b', 'c'])
})

test('四种状态分别计数', async () => {
  const health = createHealthRegistry()
  health.register(check('one', 1, { status: 'ok', summary: 'ok' }))
  health.register(check('two', 2, { status: 'warn', summary: 'warn' }))
  health.register(check('three', 3, { status: 'fail', summary: 'fail' }))
  health.register(check('four', 4, { status: 'skip', summary: 'skip' }))
  const report = await health.run()
  assert.deepEqual([report.ok, report.warn, report.fail, report.skip], [1, 1, 1, 1])
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
  assert.equal(report.fail, 1, '抛错的那项要算 fail')
  assert.ok(report.entries.some((entry) => entry.id === 'boom' && entry.summary.includes('抛错')))
  assert.ok(report.entries.some((entry) => entry.id === 'after' && entry.status === 'ok'), '后面的项还要跑')
})

test('重复 id 当场抛错', () => {
  const health = createHealthRegistry()
  health.register(check('dup', 1, { status: 'ok', summary: '' }))
  assert.throws(() => health.register(check('dup', 2, { status: 'ok', summary: '' })), /重复/)
})

test('退订之后不再出现在报告里', async () => {
  const health = createHealthRegistry()
  const off = health.register(check('gone', 1, { status: 'ok', summary: '' }))
  off()
  const report = await health.run()
  assert.equal(report.entries.length, 0)
})

test('人读版有标题、标记与汇总', async () => {
  const health = createHealthRegistry()
  health.register(check('okitem', 1, { status: 'ok', summary: '一切正常' }))
  health.register(check('baditem', 2, { status: 'fail', summary: '坏了', fix: '这样修' }))
  const text = renderText(await health.run())
  assert.ok(text.includes('Pneuma Doctor'))
  assert.ok(text.includes('✓'), '缺 ok 标记')
  assert.ok(text.includes('✗'), '缺 fail 标记')
  assert.ok(text.includes('修复：这样修'), '失败项没带修复建议')
  assert.ok(text.includes('1 项失败'), '汇总行不对')
})

test('--json 可解析且家目录被抹成 ~', async () => {
  const home = homedir()
  const health = createHealthRegistry()
  health.register(check('probe', 1, { status: 'ok', summary: `在 ${home}`, detail: `路径 ${home}` }))
  const json = JSON.parse(renderJson(await health.run()))
  assert.equal(json.checks.probe.status, 'ok')
  assert.ok(typeof json.version === 'string' || json.version === null)
  assert.ok(json.counts.ok >= 1, 'counts 不对')
  assert.ok(!JSON.stringify(json).includes(home), '家目录没被脱敏')
})

// ── 锁的判定：`.lock` 常驻是设计（flock 锚点），只有「主人不在了」才算残留 ──
test('锁的主人活着 / 死了 / 认不出，三种结论分明', async () => {
  const { lockIsStale } = await import('../../../../lib/packages/doctor/checks/data.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsc-doctor-lock-'))
  const write = (name, body) => {
    const path = join(dir, name)
    writeFileSync(path, body, 'utf8')
    return path
  }

  assert.equal(lockIsStale(write('self.lock', JSON.stringify({ pid: process.pid }))), false, '自己的锁不该算残留')
  assert.equal(lockIsStale(write('alive.lock', JSON.stringify({ pid: 4242 })), () => true), false, '活着的进程不该算残留')
  assert.equal(lockIsStale(write('dead.lock', JSON.stringify({ pid: 4242 })), () => false), true, '主人不在了才算残留')
  assert.equal(lockIsStale(write('broken.lock', '{半截')), undefined, '半截 JSON 要报认不出，不能猜')
  assert.equal(lockIsStale(write('nopid.lock', JSON.stringify({ at: 1 }))), undefined, '没 pid 也要报认不出')
  rmSync(dir, { recursive: true, force: true })
})

// ── 诊断包：给出去的东西必须是能贴的 ────────────────────────────────────────

const { buildBundle } = await import('../../../../lib/packages/doctor/bundle.js')

/** 造一份够真的体检结果。 */
function sampleReport(extra = {}) {
  return {
    at: Date.now(),
    entries: [
      { id: 'install', title: '安装', status: 'ok', summary: '0.9.1', detail: `应用根：${homedir()}\\dsc` },
      { id: 'session', title: '会话', status: 'warn', summary: `最近会话在 ${homedir()}\\dsc\\sessions`, fix: '删掉残留锁' },
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
  assert.ok(!text.includes(homedir()), '家目录没被脱敏')
  assert.ok(text.includes('~'), '脱敏后应当出现 ~')
  assert.ok(bundle.excluded.some((item) => item.includes('密钥')), 'excluded 没写清不含密钥')
  assert.deepEqual(bundle.doctor.counts, { ok: 1, warn: 1, fail: 0, skip: 0 })
  assert.equal(bundle.logs.lines, 1)
})

test('诊断包只留最后 300 行日志', () => {
  const tail = Array.from({ length: 500 }, (_, index) => `line ${index}`)
  const bundle = buildBundle({ report: sampleReport(), logTail: tail })
  assert.equal(bundle.logs.lines, 300)
  assert.equal(bundle.logs.tail[0], 'line 200', '应当从第 300 条之后开始留')
  assert.equal(bundle.logs.tail.at(-1), 'line 499')
})

// ── 会话摘要：只有在用户明确加 --with-session 时才进包 ──────────────────────

const { readSessionExcerpt } = await import('../../../../lib/packages/doctor/bundle.js')

/** 造一份临时会话日志。 */
function writeSession(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-excerpt-'))
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
  assert.deepEqual(excerpt.events.map((event) => event.role), ['user', 'assistant', 'tool'])
  assert.equal(excerpt.events[2].name, 'read')
  assert.equal(excerpt.total, 3)
  assert.equal(excerpt.truncated, false)
  rmSync(file, { recursive: true, force: true })
})

test('会话摘要里的密钥被抹、长文被截断', () => {
  const long = `开头 sk-abcdefgh12345678 ${'x'.repeat(600)}`
  const file = writeSession([{ type: 'meta', id: 'x', cwd: 'D:\\w', createdAt: 1 }, { type: 'assistant', text: long }])
  const excerpt = readSessionExcerpt(file)
  const text = excerpt.events[0].text
  assert.ok(!text.includes('12345678'), '密钥没被抹掉')
  assert.ok(text.includes('sk-***'), '抹掉的形状不对')
  assert.ok(text.endsWith('…（截断）'), '超长正文没被截断')
  rmSync(file, { recursive: true, force: true })
})

test('带了会话摘要就不能再说「不含会话内容」', () => {
  const base = buildBundle({ report: sampleReport(), logTail: [] })
  assert.ok(base.excluded.includes('会话的完整内容'))

  const withExcerpt = buildBundle({
    report: sampleReport(),
    logTail: [],
    sessionExcerpt: { file: '~/x.jsonl', total: 1, truncated: false, events: [{ role: 'user', text: '你好' }] },
  })
  assert.ok(!withExcerpt.excluded.includes('会话的完整内容'), '说明与实际不符')
  assert.equal(withExcerpt.sessionExcerpt?.events[0].text, '你好')
})
