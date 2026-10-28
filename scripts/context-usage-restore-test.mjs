/**
 * 上下文占用回填探针（2026-10-29）：切会话 / 重启宿主后，状态栏不该掉成 0%。
 *
 * 为什么单开一份：这个 bug 只在「有历史、有 usage 日志、但当前进程没收到过 usage
 * 事件」的现场出现。纯看代码能说得通，但得真起内核、真写一份 usage.jsonl、真开
 * 两次会话，才能确认快照里的 status.contextUsed 跟着回来、且没有样本的会话不被瞎填。
 *
 * 口径：usage 日志里同一 sid 的最后一条请求行（按 t 取最大）的 i 就是此刻的上下文占用；
 * 会话 jsonl 不存 token，回填只能来自这份日志。
 *
 * 用临时 HOME，绝不碰真实 ~/.dsc；跑之前先 `pnpm run build`（读 lib/ 产物）。
 *
 * 运行：node scripts/context-usage-restore-test.mjs
 *
 * @module dsc/scripts/context-usage-restore-test
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-context-usage-'))
process.env.HOME = home
process.env.USERPROFILE = home
const dscHome = join(home, '.dsc')
mkdirSync(dscHome, { recursive: true })
writeFileSync(join(dscHome, 'config.yaml'), 'model:\n  name: test\n', 'utf8')

let failures = 0
let total = 0
const check = (label, condition, extra = '') => {
  total += 1
  if (condition) {
    console.log('  ok  ' + label)
    return
  }
  failures += 1
  console.log('FAIL  ' + label + (extra === '' ? '' : '  <- ' + extra))
}

const config = {
  providers: {
    test: {
      name: 'test',
      displayName: 'Test',
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'k',
      models: [{ id: 'm', name: 'm', contextWindow: 512000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
    },
  },
  defaultProvider: 'test',
  defaultModel: 'm',
}

const dirRestore = join(home, 'ws-restore')
const dirEmpty = join(home, 'ws-empty')
const dirFresh = join(home, 'ws-fresh')
for (const dir of [dirRestore, dirEmpty, dirFresh]) mkdirSync(dir, { recursive: true })

/** 手写一份最小会话日志（meta + 一问一答）：回放只要这三种记录。 */
const writeSession = (file, id, cwd, text) => {
  const lines = [
    { type: 'meta', id, cwd, createdAt: Date.now() - 60000 },
    { type: 'user', text, ts: Date.now() - 50000 },
    { type: 'assistant', text: '收到：' + text, reasoning: '', ts: Date.now() - 40000 },
  ]
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
}

const sidRestore = '11111111-1111-4111-8111-111111111111'
const sidEmpty = '22222222-2222-4222-8222-222222222222'
const fileRestore = join(home, 'session-restore.jsonl')
const fileEmpty = join(home, 'session-empty.jsonl')
writeSession(fileRestore, sidRestore, dirRestore, '恢复这条会话')
writeSession(fileEmpty, sidEmpty, dirEmpty, '没有用量行的会话')

// 同一 sid 两行：最后一行（t 更大）才是「此刻占用」；即使它先出现也不能被前一行盖掉。
const usageFile = join(dscHome, 'usage', 'usage.jsonl')
mkdirSync(join(dscHome, 'usage'), { recursive: true })
const usageRows = [
  { t: 1_000, provider: 'test', model: 'm', i: 999, o: 10, sid: sidRestore },
  { t: 2_000, provider: 'test', model: 'm', i: 5000, o: 20, sid: sidRestore },
  // 别的会话的行不参与本会话的折叠
  { t: 3_000, provider: 'test', model: 'm', i: 88888, o: 30, sid: sidEmpty + '-other' },
]
writeFileSync(usageFile, usageRows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')

const { createKernel, emitStartupNotes } = await import(new URL('../lib/host/kernel.js', import.meta.url).href)
const { readSessionUsage } = await import(new URL('../lib/core/usage-log.js', import.meta.url).href)

// ── 0. 折叠口径先自检：最后一行获胜，没行返回 null ─────────────────────────
const folded = readSessionUsage(sidRestore)
check('usage 日志折叠：取最后一行的 input tokens', folded !== null && folded.lastInputTokens === 5000, String(folded?.lastInputTokens))
check('用量日志里没有这条会话时返回 null', readSessionUsage(sidEmpty) === null)
check('读取入口不会把别的会话的行算进来', folded !== null && folded.inputTokens === 5999, String(folded?.inputTokens))

// ── 1. 会话打开：clear + replay 之后回填总数 ──────────────────────────────
const ctx = await createKernel({ config, resumeSessionPath: null })
const fresh = ctx.session.current()
await ctx.session.open(fileRestore)
let snap = ctx.transcript.getSnapshot()
check('打开有用量行的会话：快照 status.contextUsed = 5000', snap.status.contextUsed === 5000, String(snap.status.contextUsed))
check('快照 sessionId 是这条会话', snap.status.sessionId === sidRestore, snap.status.sessionId)
const seg = snap.status.contextSegments
check(
  '回填只给总数：分段仍全为 0（等下一次 context 事件）',
  seg.system === 0 && seg.prompt === 0 && seg.assistant === 0 && seg.thinking === 0 && seg.tools === 0,
  JSON.stringify(seg),
)

// ── 2. 没有用量行的会话：0，不能拿上一条会话的数凑 ────────────────────────
await ctx.session.open(fileEmpty)
snap = ctx.transcript.getSnapshot()
check('打开没有用量行的会话：contextUsed 仍是 0', snap.status.contextUsed === 0, String(snap.status.contextUsed))
check('并且快照换成了这条会话', snap.status.sessionId === sidEmpty, snap.status.sessionId)

// ── 3. 再切回有量会话：重新 clear + replay，值不丢 ────────────────────────
await ctx.session.open(fileRestore)
snap = ctx.transcript.getSnapshot()
check('重新 open 一次（clear + replay）后 contextUsed 仍是 5000', snap.status.contextUsed === 5000, String(snap.status.contextUsed))
check('会话条目确实重放出来了', snap.entries.some((entry) => entry.kind === 'user' && entry.text === '恢复这条会话'))

// 会话 jsonl 只存消息，不许因为这次修复多出 token 字段
const jsonl = readFileSync(fileRestore, 'utf8')
check('会话 jsonl 没有被塞进 usage / token 字段', !/inputTokens|lastInputTokens|contextUsed|"usage"/.test(jsonl))

// ── 4. 启动恢复：重启后第一眼就有值 ───────────────────────────────────────
ctx.session.current().close()
fresh.close()
const booted = await createKernel({ config, resumeSessionPath: fileRestore })
check('启动路径确实走了 resumedStartup', booted.session.resumedStartup === true)
emitStartupNotes(booted, null, config)
const bootSnap = booted.transcript.getSnapshot()
check('启动恢复后快照 status.contextUsed = 5000', bootSnap.status.contextUsed === 5000, String(bootSnap.status.contextUsed))
check('启动恢复也重放了历史条目', bootSnap.entries.some((entry) => entry.kind === 'user' && entry.text === '恢复这条会话'))
booted.session.current().close()

// 没有用量行的会话重启：仍是 0，不瞎填
const bootedEmpty = await createKernel({ config, resumeSessionPath: fileEmpty })
emitStartupNotes(bootedEmpty, null, config)
const emptySnap = bootedEmpty.transcript.getSnapshot()
check('启动恢复没有用量行的会话：contextUsed 仍是 0', emptySnap.status.contextUsed === 0, String(emptySnap.status.contextUsed))
bootedEmpty.session.current().close()

// ── 5. 源文件断言：入口在哪、有没有绕开日志 ───────────────────────────────
const adapterSource = readFileSync(new URL('../src/adapter/transcript.ts', import.meta.url), 'utf8')
const pluginSource = readFileSync(new URL('../src/plugins/transcript.ts', import.meta.url), 'utf8')
const kernelSource = readFileSync(new URL('../src/host/kernel.ts', import.meta.url), 'utf8')
const statusbarSource = readFileSync(new URL('../ui-shell/src/plugins/statusbar/ui.tsx', import.meta.url), 'utf8')
check('adapter 提供 seedContextUsage 回填入口', /seedContextUsage\(used: number\)/.test(adapterSource))
check(
  'session-open 在重放之后调用回填',
  /replayHistory\([\s\S]*?readSessionUsage\(current\.meta\.id\)[\s\S]*?seedContextUsage\(usage\.lastInputTokens\)/.test(pluginSource),
)
check('session-open 一行用量都没有时不填（null 判断）', /if \(usage !== null\) transcript\.seedContextUsage/.test(pluginSource))
check(
  'kernel 启动恢复同样回填',
  /readSessionUsage\(root\.session\.current\(\)\.meta\.id\)[\s\S]*?root\.transcript[\s\S]*?seedContextUsage/.test(kernelSource),
)
check('usage 没有被写进会话日志（core/session 的写入记录里没有 token 字段）', !/contextUsed|lastInputTokens/.test(readFileSync(new URL('../src/core/session.ts', import.meta.url), 'utf8')))
check(
  '界面：没有样本时上下文段整段不画',
  /hasContextSample = logged !== null \|\| settledTokens > 0 \|\| contextUsed > 0/.test(statusbarSource) &&
    /contextWindow > 0 && hasContextSample/.test(statusbarSource),
)

console.log(failures === 0 ? '\nPASS ' + total + '/' + total : '\nFAIL ' + failures + '/' + total)
process.exit(failures === 0 ? 0 : 1)
