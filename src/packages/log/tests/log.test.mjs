/**
 * @pneuma/log 的包级测试：钉住三条真会出事的线。
 *
 * 1. **脱敏**：漏一条就是事故，所以四类外形逐条断言，外加「普通文本不被误伤」；
 * 2. **上限**：轮转与过期清理是唯一会动用户磁盘的地方，用临时目录真写一遍；
 * 3. **装配**：命令、设置分区、服务三样都挂上了，且 `apply` 的清理函数真能摘掉监听。
 *
 * 假 ctx 走 `scripts/_testkit.mjs`，不再各写一份。
 *
 * @module @pneuma/log/tests
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { expectRegistered, mountPlugin, readPackage, runCommand, snapshotJson } from '../../../../scripts/_testkit.mjs'

// 配置改成每次现读 `plugins.json`（见 index.ts 的 config()），测试必须有自己的 DSC_HOME：
// 否则会读走开发者真实的 ~/.dsc/plugins.json，断言随人而变，写配置还会碰到真文件。
// 必须在 import lib/ 之前设好：core/path-policy 的 DSC_HOME 是模块加载那一刻定死的。
const home = mkdtempSync(join(tmpdir(), 'dsc-log-home-'))
process.env['DSC_HOME'] = join(home, '.dsc')

const filter = await import('../../../../lib/packages/log/filter.js')
const { LogSink, dayKey } = await import('../../../../lib/packages/log/sink.js')

/** 造一条 cordis 形状的日志消息。 */
const message = (type, level, text) => ({ sn: 1, ts: Date.now(), name: 'probe', type, level, args: [text] })

// ── 1. 包形态 ───────────────────────────────────────────────────────────────

test('清单与装配行对得上', () => {
  const { pkg, patch } = readPackage('log')
  assert.equal(pkg.name, '@pneuma/log')
  assert.equal(pkg.pneuma.order, 5, '必须早于 llm（10），否则启动期日志接不住')
  assert.ok(patch.includes("name: '@pneuma/log'"))
})

// ── 2. 脱敏 ─────────────────────────────────────────────────────────────────

test('四类凭据都被抹掉', () => {
  const cases = [
    ['Authorization: Bearer abcdefgh12345678', 'Authorization: ***'],
    ['Bearer abcdefgh12345678', 'Bearer ***'],
    ['apiKey="abcdefgh12345678"', 'apiKey="***'],
    ['access_token: abcdefgh12345678', 'access_token: ***'],
    ['key is sk-abcdefgh12345678', 'sk-***'],
  ]
  for (const [input, expect] of cases) {
    const out = filter.redact(`x ${input} y`)
    assert.ok(out.includes(expect), `${input} → ${out}`)
    assert.ok(!out.includes('12345678'), `${input} 的密钥还在：${out}`)
  }
})

test('普通文本不被误伤', () => {
  assert.equal(filter.redact('read 12 files in 340ms'), 'read 12 files in 340ms')
})

test('级别名映射', () => {
  assert.equal(filter.levelNameOf(0), 'error')
  assert.equal(filter.levelNameOf(3), 'debug')
  assert.equal(filter.levelNameOf(99), 'info', '越界回落 info，不能丢这一条')
})

test('落盘记录的形状稳定（快照）', () => {
  // 钉的是格式：哪天有人把 `lvl` 改名成 `level`，读日志的脚本与体检就得跟着改。
  // 时间戳固定，快照才不会每跑一次就变。
  const record = filter.toRecord({ sn: 7, ts: 1700000000000, name: 'probe', type: 'warn', level: 1, args: ['%s 掉了一条', 'tool'] })
  snapshotJson(fileURLToPath(new URL('./log-record.snapshot.json', import.meta.url)), record)
})

// ── 3. 落盘上限 ─────────────────────────────────────────────────────────────

test('写满轮转到 .1，过期目录被整目录删', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-log-test-'))
  const sink = new LogSink({ dir, maxFileBytes: 400, keepDays: 10, sweepIntervalMs: 0 })
  // 每行约 60 字节，40 行 ≈ 2.4 KB，必然超过 400 的上限
  for (let i = 0; i < 40; i += 1) sink.write(JSON.stringify({ i, msg: 'x'.repeat(40) }))
  sink.flush()

  const day = dayKey(Date.now())
  const files = readdirSync(join(dir, day))
  assert.ok(files.some((name) => name.endsWith('.jsonl')), '当天文件不在')
  assert.ok(files.some((name) => name.endsWith('.jsonl.1')), '超上限却没轮转')

  const oldDay = dayKey(Date.now() - 40 * 24 * 60 * 60 * 1000)
  mkdirSync(join(dir, oldDay), { recursive: true })
  writeFileSync(join(dir, oldDay, 'dsc-1.jsonl'), 'x'.repeat(1024))
  const pruner = new LogSink({ dir, keepDays: 10, maxTotalBytes: 1 << 20, sweepIntervalMs: 0 })
  assert.ok(pruner.prune(true).dirs >= 1, '过期目录没删掉')
  assert.ok(!existsSync(join(dir, oldDay)), '过期目录还在')
  assert.ok(existsSync(join(dir, day)), '今天这份被误删')
  sink.close()
})

// ── 4. 装配 ─────────────────────────────────────────────────────────────────

test('apply 挂上命令、设置分区与服务，清理函数摘掉监听', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-log-apply-'))
  const { captured, dispose } = await mountPlugin('log', { config: { dir } })

  expectRegistered(captured, 'commands', 'log')
  expectRegistered(captured, 'sections', 'log')
  assert.equal(typeof captured.services['log'].tail, 'function')
  assert.equal(typeof captured.services['log'].file, 'function')

  captured.exporters[0].export(message('info', 2, 'hello %s', 'world'))
  captured.exporters[0].export(message('warn', 1, 'secret sk-abcdefgh12345678'))
  captured.services['log'].flush()

  const body = readFileSync(captured.services['log'].file(), 'utf8')
  assert.ok(body.includes('hello'), '正文没落盘')
  assert.ok(body.includes('sk-***'), '密钥没被抹')
  assert.ok(!body.includes('12345678'), '密钥原样落盘了')

  dispose()
  assert.ok(existsSync(captured.services['log'].file()), '文件不该被清理函数删掉')
})

test('级别 off 时一条都不落', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-log-off-'))
  const { captured, dispose } = await mountPlugin('log', { config: { dir, level: 'off' } })
  captured.exporters[0].export(message('error', 0, 'shut up'))
  captured.services['log'].flush()
  assert.ok(!existsSync(captured.services['log'].file()), 'off 了还在写')
  dispose()
})

test('/log 命令报出文件、级别与条数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-log-cmd-'))
  const { captured, dispose } = await mountPlugin('log', { config: { dir } })
  captured.exporters[0].export(message('info', 2, 'command probe'))
  captured.services['log'].flush()

  const notices = await runCommand(captured, 'log', ['5'])
  assert.equal(notices.length, 1, '应当只 notice 一次')
  assert.ok(notices[0].includes('日志文件'), '没报文件路径')
  assert.ok(notices[0].includes('信息') || notices[0].includes('info'), '没报级别')
  dispose()
})

// ── 5. 配置现读：设置页改完立刻生效 ──────────────────────────────────────────

test('readLogConfig 每次现读 plugins.json，不是挂载时的快照', async () => {
  const { readLogConfig } = await import('../../../../lib/core/log-config.js')
  const { writePluginConfig } = await import('../../../../lib/core/plugin-registry.js')
  // passed 代表装配时那份行配置：磁盘没写的键该继续用它作底
  const passed = { dir: mkdtempSync(join(tmpdir(), 'dsc-log-core-')), level: 'info' }
  assert.equal(readLogConfig(passed).level, 'info')

  writePluginConfig('log', { level: 'debug', maxFileBytes: 16 * 1024 * 1024 })
  assert.equal(readLogConfig(passed).level, 'debug', '磁盘上的新级别没有盖过 passed')
  assert.equal(readLogConfig(passed).maxFileBytes, 16 * 1024 * 1024, '磁盘上的新上限没读到')
  assert.equal(readLogConfig(passed).dir, passed.dir, '磁盘没写的目录该继续用 passed 作底')

  // 复位，免得这份临时 plugins.json 影响后面的用例
  writePluginConfig('log', { level: null, maxFileBytes: null })
})

test('设置页改级别/目录/上限，运行中立刻生效（不用重启宿主）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsc-log-live-'))
  const { captured, dispose } = await mountPlugin('log', { config: { dir, level: 'info' } })
  const section = captured.sections.get('log')
  assert.equal(captured.services['log'].level(), 'info')
  assert.equal(section.values().maxFileMB, 8, '缺省单文件上限该是 8 MiB')

  // 设置页点「保存」走的就是 section.save：写 plugins.json，下一次取值立刻按新值算
  section.save('level', 'debug')
  assert.equal(captured.services['log'].level(), 'debug', '改级别没立刻生效')

  section.save('maxFileMB', '16')
  assert.equal(section.values().maxFileMB, 16, '改单文件上限没立刻生效')

  const moved = mkdtempSync(join(tmpdir(), 'dsc-log-live-dir-'))
  section.save('dir', moved)
  assert.equal(captured.services['log'].dir(), moved, '改目录没立刻生效')
  assert.ok(captured.services['log'].file().startsWith(moved), `新日志仍落在旧目录：${captured.services['log'].file()}`)

  // 新级别真的作用在下一行上：debug 现在放行（缺省 info 时会丢掉）
  captured.exporters[0].export(message('debug', 3, 'after-save'))
  captured.services['log'].flush()
  const body = readFileSync(captured.services['log'].file(), 'utf8')
  assert.ok(body.includes('after-save'), '改级别后下一行 debug 日志仍被丢')
  dispose()
})
