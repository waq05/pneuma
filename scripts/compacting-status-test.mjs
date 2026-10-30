/**
 * 压缩活动行与占用刷新的探针（2026-10-30）：`/compact` 跑着的时候界面该看得见。
 *
 * 为什么单开一份：这两件事都是「事件 → 快照字段」的约定，没有任何纯函数能保证它——
 * 压缩插件发的 `dsc/compacting` / `dsc/context-used` 若没被转录插件接住，界面就还是
 * 一片安静、百分比还是停在压缩前，而这恰恰是用户最初报的那个现象。
 *
 * 验四件事：
 *   1. 开始压缩 → 快照 status.compactingSince 是数字；结束 → 字段消失（不残留）；
 *   2. 别的会话开始的压缩，不改当前会话的字段（后台 agent 压缩不该冒到当前视图）；
 *   3. `dsc/context-used` 把 status.contextUsed 换掉（压完百分比立刻动）；
 *   4. 别的会话的读数不覆盖当前会话。
 *
 * 用临时 HOME，绝不碰真实 ~/.dsc；跑之前先 `pnpm run build`（读 lib/ 产物）。
 *
 * 运行：node scripts/compacting-status-test.mjs
 *
 * @module dsc/scripts/compacting-status-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-compacting-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dscHome = join(home, '.dsc')
mkdirSync(dscHome, { recursive: true })
writeFileSync(join(dscHome, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) console.log('  ok  ' + label)
  else {
    failures += 1
    console.log('FAIL  ' + label + (extra === '' ? '' : '  <- ' + extra))
  }
}

const config = {
  providers: {
    test: {
      name: 'test',
      displayName: 'Test',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'k',
      models: [
        {
          id: 'm',
          name: 'm',
          contextWindow: 512000,
          maxTokens: 500,
          modalities: ['text'],
          thinkingLevels: [],
          thinkingParam: 'none',
          effortMap: {},
        },
      ],
    },
  },
  defaultProvider: 'test',
  defaultModel: 'm',
}

const dir = join(home, 'ws')
mkdirSync(dir, { recursive: true })
const sid = '33333333-3333-4333-8333-333333333333'
const file = join(home, 'session-compact.jsonl')
writeFileSync(
  file,
  [
    { type: 'meta', id: sid, cwd: dir, createdAt: Date.now() - 60000 },
    { type: 'user', text: '压一下', ts: Date.now() - 50000 },
    { type: 'assistant', text: '好', reasoning: '', ts: Date.now() - 40000 },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n') + '\n',
  'utf8',
)

const { createKernel } = await import(new URL('../lib/host/kernel.js', import.meta.url).href)
const ctx = await createKernel({ config, resumeSessionPath: null })
await ctx.session.open(file)
const path = ctx.session.current().filePath
const other = join(home, 'session-other.jsonl')

console.log('[1] 开始 → 有字段；结束 → 字段消失')
{
  const before = ctx.transcript.getSnapshot()
  check('压缩前没有 compactingSince', before.status.compactingSince === undefined, String(before.status.compactingSince))
  ctx.emit('dsc/compacting', true, path)
  const running = ctx.transcript.getSnapshot()
  check('开始压缩后拿到开始时刻', typeof running.status.compactingSince === 'number', String(running.status.compactingSince))
  ctx.emit('dsc/compacting', false, path)
  const done = ctx.transcript.getSnapshot()
  check('结束后字段被清掉（界面不会一直转圈）', done.status.compactingSince === undefined, String(done.status.compactingSince))
}

console.log('[2] 别的会话在压，当前视图不受影响')
{
  ctx.emit('dsc/compacting', true, other)
  const snap = ctx.transcript.getSnapshot()
  check('当前会话没有冒出一条别人的压缩状态', snap.status.compactingSince === undefined, String(snap.status.compactingSince))
  ctx.emit('dsc/compacting', false, other)
}

console.log('[3] 压完的估算读数立刻进快照')
{
  ctx.emit('dsc/context-used', 4321, path)
  const snap = ctx.transcript.getSnapshot()
  check('contextUsed 换成了估算值', snap.status.contextUsed === 4321, String(snap.status.contextUsed))
}

console.log('[4] 别人的读数不覆盖当前会话')
{
  ctx.emit('dsc/context-used', 999999, other)
  const snap = ctx.transcript.getSnapshot()
  check('当前会话的读数没被改', snap.status.contextUsed === 4321, String(snap.status.contextUsed))
}

if (failures > 0) {
  console.log(`\n${String(failures)} 条用例失败`)
  process.exit(1)
}

// ── 5. 源码钉：三处接线少一处，上面的事件就白发了 ─────────────────────────
console.log('[5] 接线还在（压缩插件发、转录插件收、壳画）')
{
  const { readFileSync } = await import('node:fs')
  const compactSource = readFileSync(new URL('../src/plugins/compact.ts', import.meta.url), 'utf8')
  const transcriptSource = readFileSync(new URL('../src/plugins/transcript.ts', import.meta.url), 'utf8')
  const shellSource = readFileSync(new URL('../ui-shell/src/plugins/transcript/ui.tsx', import.meta.url), 'utf8')
  check('压缩插件在 finally 里清状态', /whileCompacting[\s\S]*?finally[\s\S]*?'dsc\/compacting', false/.test(compactSource))
  check('压完发一次估算读数', /'dsc\/context-used'/.test(compactSource))
  check('转录插件收这两个事件', /'dsc\/compacting'/.test(transcriptSource) && /'dsc\/context-used'/.test(transcriptSource))
  check('壳按 compactingSince 画状态行', /compactingSince !== null[\s\S]*?TurnStatusLine/.test(shellSource))
}

console.log('\n全部通过')
process.exit(0)
