/**
 * 转录归属的隔离探针（2026-10-28）：后台会话的工具卡 / 提示不许写进当前视图。
 *
 * 为什么单开一份：这次的现场是「A 会话在跑 PTC，用户切到新建的 B，A 的'查找文件'
 * 卡片落在 B 的空白页上」。纯看代码看不出，得真起内核、真开两个会话、真往转录里
 * 写一条带归属的事件，再看当前快照里有没有它。
 *
 * 用临时 HOME，绝不碰真实 ~/.dsc；跑之前先 `pnpm run build`（读 lib/ 产物）。
 *
 * 运行：node scripts/session-transcript-isolation-test.mjs
 *
 * @module dsc/scripts/session-transcript-isolation-test
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-transcript-iso-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log('  ok  ' + label)
    return
  }
  failures += 1
  console.log('FAIL  ' + label + (extra === '' ? '' : '  <- ' + extra))
}

const { createKernel } = await import(new URL('../lib/host/kernel.js', import.meta.url).href)
const dirs = ['ws-a', 'ws-b', 'ws-c'].map((name) => join(home, name))
for (const dir of dirs) mkdirSync(dir, { recursive: true })

const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'k',
        models: [{ id: 'm', name: 'm', contextWindow: 100000, maxTokens: 500, modalities: ['text'], thinkingLevels: [], thinkingParam: 'none', effortMap: {} }],
      },
    },
    defaultProvider: 'test',
    defaultModel: 'm',
  },
  resumeSessionPath: null,
})

const entries = () => ctx.transcript.getSnapshot().entries
const card = (callId) => ({ type: 'tool/call', callId, name: 'glob', args: '{"pattern":"**/*.ts"}' })

// ── 1. 当前是 A：A 的卡片照进，别的会话的卡片丢掉 ──────────────────────────
const a = ctx.session.current()
let before = entries().length
ctx.transcript.emit(card('a-1'), a.meta.id)
check('当前会话 A 的卡片照常进', entries().length === before + 1, String(entries().length - before))

before = entries().length
ctx.transcript.emit(card('ghost-1'), 'no-such-session')
check('不属于任何当前会话的卡片被丢掉', entries().length === before, String(entries().length - before))

// ── 2. 切到 B：A 的卡片不许进，B 的照进 ────────────────────────────────────
await ctx.session.open(undefined, dirs[1])
const b = ctx.session.current()
check('换到 B 会话说的是 B 的会话', b.meta.cwd === dirs[1], b.meta.cwd)

before = entries().length
ctx.transcript.emit(card('a-2'), a.meta.id)
check('后台会话 A 的卡片不进当前视图 B', entries().length === before, String(entries().length - before))

ctx.transcript.emit(card('b-1'), b.meta.id)
check('当前会话 B 的卡片照常进', entries().length === before + 1, String(entries().length - before))

before = entries().length
ctx.transcript.system('A 的提示', undefined, undefined, a.meta.id)
check('后台会话 A 的 system 行不进当前视图', entries().length === before, String(entries().length - before))

ctx.transcript.system('全局提示')
check('不带归属的全局提示照写（启动横幅这类不能误伤）', entries().length === before + 1, String(entries().length - before))

// ── 3. 再切到 C：B 的卡片不许进，C 的照进 ──────────────────────────────────
await ctx.session.open(undefined, dirs[2])
const c = ctx.session.current()
check('换到 C 会话说的是 C 的会话', c.meta.cwd === dirs[2], c.meta.cwd)

before = entries().length
ctx.transcript.emit(card('b-2'), b.meta.id)
check('上一个会话 B 的卡片不进当前视图 C', entries().length === before, String(entries().length - before))

ctx.transcript.emit(card('c-1'), c.meta.id)
check('当前会话 C 的卡片照常进', entries().length === before + 1, String(entries().length - before))

process.exit(failures === 0 ? 0 : 1)
