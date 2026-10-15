/**
 * 条目顺序的身份证不变量（0.6.70 修「思考内容行在工具调用行下面」）。
 *
 * 用户报障：会话里每一段的「思考过程」行都跑到了它那一步的工具卡**下面**，而那段思考
 * 明明先发生。根因不在渲染层，在两处约定的接缝上：
 *
 *   1. 宿主组帧时按 **id 正负**把条目分成两份（`plugins/webserver.ts` 的
 *      `entries.filter(id > 0)` / `liveEntries.filter(id < 0)`）；
 *   2. 壳把 `entries` **按 id 升序**归并（`ui/frames.ts` 的 applyHostFrame，文件头写明
 *      前提是「宿主发号递增，id 序就是时间序」）。
 *
 * 而 `src/adapter/transcript.ts` 的「准备中」工具曾经在 `tool/prepare` 那一刻就领正 id：
 * 它必然小于同一步稍后才定稿的思考行（`message` 那一刻才发号），于是壳按 id 一排，
 * 工具卡就插到了思考行前面。修法：**发号只许在条目真正进 list 的那一刻做**，准备中的
 * 那一条按直播尾发负 id。
 *
 * 断言五层（真内核 + 假端点跑真回合）：
 *   [1] 不变量：定稿条目数组严格按 id 递增（正 id 子序列即时间序）；
 *   [2] 逐步对账：每一步的思考行 id < 那一步的工具行 id（用户报的那一条）；
 *   [3] 准备中窗口：流还在跑时，liveEntries 里的「准备中」工具是负 id（直播尾）；
 *   [4] 接缝：真 `applyHostFrame` 归并一帧全量后，条目顺序与宿主数组逐项一致；
 *   [5] 源码钉（含反向对照）：`tool/prepare` 不再发号、`liveEntries` 给准备中的工具发负 id。
 *
 * 隔离：临时 HOME + 假模型端点，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm build && node scripts/transcript-order-test.mjs
 *
 * @module dsc/scripts/transcript-order-test
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'dsc-order-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')
writeFileSync(
  join(home, '.dsc', 'plugins.json'),
  JSON.stringify({ version: 1, entries: [{ file: 'memory', config: { enabled: false } }] }, null, 2),
  'utf8',
)

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : `  <- ${extra}`}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(15)
  }
}

// ── 假模型端点：三步，步内 2 个同名调用 / 步内带正文，形状对齐用户那次真回合 ────────────
const delta = (o) => `data: ${JSON.stringify({ choices: [{ delta: o }] })}\n\n`
const fin = (r) => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: r }] })}\n\n`
const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`
const call = (id, name, args) =>
  delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] })

/** 第三步留一段「准备中」窗口：工具名吐完先停 700ms 再收流，探针趁这段时间读快照。 */
const PREPARE_WINDOW_MS = 700
const STEPS = [
  {
    reason: '先搜一下 ts 文件。',
    tools: [call('c1', 'glob', '{"pattern":"**/*.ts"}'), call('c2', 'glob', '{"pattern":"*.json"}')],
  },
  { reason: '搜到了，读一下主文件。', tools: [call('c3', 'read', '{"path":"a.ts"}')] },
  {
    reason: '读完了，装上语言服务器再试。',
    text: '工具回了一句实话：本机没装 TypeScript 语言服务器。',
    tools: [call('c4', 'bash', '{"command":"npm i -g typescript"}')],
    hold: true,
  },
  { reason: '收尾。', text: '成了。', tools: [] },
]

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      payload = {}
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const isTitle = messages.some(
      (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('会话标题生成器'),
    )
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (isTitle) {
      res.end(delta({ content: '顺序探针的会话标题' }) + fin('stop') + usage + 'data: [DONE]\n\n')
      return
    }
    const step = Math.min(messages.filter((m) => m.role === 'tool').length, STEPS.length - 1)
    const spec = STEPS[step]
    let out = delta({ reasoning_content: spec.reason })
    if (spec.text !== undefined) out += delta({ content: spec.text })
    for (const tool of spec.tools) out += tool
    const tail = fin(spec.tools.length === 0 ? 'stop' : 'tool_calls') + usage + 'data: [DONE]\n\n'
    if (spec.hold === true) {
      res.write(out)
      setTimeout(() => {
        res.end(tail)
      }, PREPARE_WINDOW_MS)
      return
    }
    res.end(out + tail)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

const { createKernel } = await import('../lib/host/kernel.js')
const { applyHostFrame } = await import('../lib/ui/frames.js')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl,
        apiKey: 'k',
        models: [
          {
            id: 'm',
            name: 'm',
            contextWindow: 100000,
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
  },
  resumeSessionPath: null,
})

let bashRunning = false
for (const name of ['glob', 'read', 'bash']) {
  ctx.tools.register({
    name,
    description: '测试用工具',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    run: async () => {
      if (name === 'bash') {
        bashRunning = true
        await sleep(120)
      }
      return '结果：找到了 desktop/electron/main/dsc-core.ts'
    },
  })
}

const snapshot = () => {
  ctx.emit('dsc/changed')
  return ctx.transcript.getSnapshot()
}

// 趁「准备中」窗口读一次直播尾（那段窗口里工具名已经吐出来、tool/call 还没到）。
// 宿主快照把定稿条目与直播尾拼在同一个 `entries` 里，直播尾按负 id 认（组帧时也是这么分的）。
let preparingSeen = null
const watch = (async () => {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const live = snapshot().entries.filter((entry) => entry.id < 0)
    const preparing = live.filter((entry) => entry.kind === 'tool' && entry.call.status === 'preparing')
    if (preparing.length > 0) {
      preparingSeen = { ids: preparing.map((entry) => entry.id), statuses: preparing.map((entry) => entry.call.status) }
      return
    }
    await sleep(20)
  }
})()

console.log('[1] 定稿条目数组严格按 id 递增（正 id 子序列即时间序）')
{
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', () => {
      off()
      resolve()
    })
  })
  ctx.agent.followup('试一下')
  await ended
  await watch
  await until(() => !ctx.agent.isRunning)
  await sleep(200)
  const entries = snapshot().entries.filter((entry) => entry.id > 0)
  const ids = entries.map((entry) => entry.id)
  const ascending = ids.every((id, index) => index === 0 || ids[index - 1] < id)
  check('数组顺序就是 id 升序（壳按 id 归并的前提）', ascending, JSON.stringify(ids))
  check(
    '没有重复 id',
    new Set(ids).size === ids.length,
    JSON.stringify(ids),
  )
  const kinds = entries.map((entry) => (entry.kind === 'thinking' ? 'T' : entry.kind === 'tool' ? 'tool' : entry.kind))
  console.log(`     条目序列：${kinds.join(' → ')}`)

  console.log('[2] 逐步对账：每一步的思考行在它那一步的工具行之前（id 更小）')
  const steps = []
  let current = null
  for (const entry of entries) {
    if (entry.kind === 'user' || entry.kind === 'system') {
      current = null
      continue
    }
    if (entry.kind === 'thinking') {
      current = { thinking: entry.id, tools: [] }
      steps.push(current)
      continue
    }
    if (entry.kind === 'tool' && current !== null) current.tools.push(entry.id)
  }
  const pairs = steps.filter((step) => step.tools.length > 0)
  check('有 3 步「思考 + 工具」的配对', pairs.length === 3, JSON.stringify(steps))
  check(
    '每步的思考 id < 该步第一个工具 id（修好后：工具不再抢在思考前面）',
    pairs.every((step) => step.thinking < Math.min(...step.tools)),
    JSON.stringify(pairs),
  )
  check(
    '每一步的工具 id 都大于上一步的工具 id（跨步不会串位）',
    pairs.every((step, index) => index === 0 || Math.min(...step.tools) > Math.max(...pairs[index - 1].tools)),
    JSON.stringify(pairs),
  )
  const textStep = steps.find((step) => step.tools.length === 1)
  check('带正文那一步也在对账里（正文夹在思考与工具之间）', textStep !== undefined, JSON.stringify(steps))

  console.log('[3] 准备中窗口：直播尾里的「准备中」工具是负 id')
  check('抓到了准备中窗口', preparingSeen !== null, '窗口没出现（工具太快或太快收流）')
  check(
    '准备中的工具发的是负 id（直播尾身份）',
    preparingSeen !== null && preparingSeen.ids.every((id) => id < 0),
    JSON.stringify(preparingSeen),
  )
  check('那一刻的状态就是 preparing', preparingSeen?.statuses.every((s) => s === 'preparing') === true, JSON.stringify(preparingSeen))

  console.log('[4] 接缝：真 applyHostFrame 归并后顺序与宿主数组逐项一致')
  const raw = snapshot()
  const frame = {
    type: 'snapshot',
    full: true,
    seq: 1,
    ...raw,
    entries: raw.entries.filter((entry) => entry.id > 0),
    liveEntries: raw.entries.filter((entry) => entry.id < 0),
  }
  const merged = applyHostFrame(null, frame)
  check(
    '归并后的 entries 与宿主正 id 数组逐项同序（壳那一侧不再自己重排）',
    merged.entries.map((entry) => entry.id).join(',') === frame.entries.map((entry) => entry.id).join(','),
    `host=${frame.entries.map((entry) => entry.id).join(',')} shell=${merged.entries.map((entry) => entry.id).join(',')}`,
  )
  check(
    '归并后思考行仍在它那一步的工具行之前',
    merged.entries.every((entry, index) => {
      if (entry.kind !== 'tool') return true
      const previous = merged.entries[index - 1]
      return previous === undefined || previous.kind !== 'thinking' || previous.id < entry.id
    }),
    JSON.stringify(merged.entries.map((entry) => `${entry.id}:${entry.kind}`)),
  )
}

console.log('[5] 源码钉（含反向对照）')
{
  const root = fileURLToPath(new URL('..', import.meta.url))
  const adapter = readFileSync(`${root}src/adapter/transcript.ts`, 'utf8')
  const prepareCase = adapter.slice(adapter.indexOf("case 'tool/prepare'"), adapter.indexOf("case 'model/retry'"))
  check(
    'tool/prepare 不再给准备中的条目发号（没有 id: this.seq++）',
    prepareCase.includes('this.prepared.push({ name: event.name') && !prepareCase.includes('this.seq++'),
    prepareCase.slice(0, 160),
  )
  const liveFn = adapter.slice(adapter.indexOf('liveEntries(): TranscriptEntry[]'), adapter.indexOf('private takePrepared'))
  check(
    'liveEntries 给准备中的工具发负 id（接在直播尾之后）',
    /id:\s*-\(live\.length \+ offset \+ 1\)/.test(liveFn),
    liveFn.slice(0, 200),
  )
  check('tool/call 里发号（条目真正进 list 的那一刻）', /kind: 'tool',\s*id: this\.seq\+\+/.test(adapter), '')
  // 反向对照：把发号加回 prepare，源码钉必须红
  const broken = adapter.replace("this.prepared.push({ name: event.name", 'this.prepared.push({ id: this.seq++, name: event.name')
  const brokenPrepare = broken.slice(broken.indexOf("case 'tool/prepare'"), broken.indexOf("case 'model/retry'"))
  check(
    '反向对照：把发号塞回 prepare 这条钉子会红',
    brokenPrepare.includes('this.seq++'),
    '对照没生效',
  )
}

process.exit(failures === 0 ? 0 : 1)
