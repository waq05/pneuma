/**
 * 系统提示卡与上下文注入卡的落盘 / 重放自检（本批新增的两类条目）。
 *
 * 为什么单独一张网：这两类内容**不在消息流里**——系统提示是请求头、上下文注入是投影
 * 往请求里塞的。它们能不能在重放时回到原位，取决于三件事必须同时成立：
 *   ① 现场真的发出了事件（循环在请求组装完、流还没开的时候发）；
 *   ② 日志里记下了**落位锚点**（`after` = 写它时日志里有几条消息），否则实时在轮中、
 *      重放只能放轮首，`sameEntries` 的全字段比对永远判不等 → 每次开会话整表重建；
 *   ③ 卡片上的字段都是确定性的（hash / 字符数 / 段清单 / 注入摘要），不塞时间戳与
 *      会变的顺序——不然重放出来的一比就不一样。
 *
 * 跑的是真内核（真 prompt 投影链、真 session 落盘、真 adapter），只把 fetch 桩成 SSE，
 * 全程临时 HOME，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/transcript-metadata-test.mjs
 *
 * @module dsc/scripts/transcript-metadata-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-transcript-meta-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
// 假端点：内核装配需要一个能读的 config.yaml，不连真模型（fetch 下面桩掉）
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 一小段 SSE：一句正文 + 收尾 + 用量（不调工具，一轮一次请求）。 */
const sseBody =
  `data: ${JSON.stringify({ choices: [{ delta: { content: '收到' } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n` +
  'data: [DONE]\n\n'
globalThis.fetch = async () =>
  new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })

const { createKernel } = await import('../lib/host/kernel.js')
const { Session } = await import('../lib/core/session.js')
const { Transcript } = await import('../lib/adapter/transcript.js')
const { promptHash } = await import('../lib/packages/session-core/prompt.js')
const { CONTEXT_INJECTION_KINDS } = await import('../lib/contract.js')

/** 读一份 jsonl 的全部记录（坏行跳过，与 Session.load 同口径）。 */
const readRecords = (file) => {
  const out = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 坏行跳过
    }
  }
  return out
}

/**
 * 条目内容的比较形状：剔除每次重建都会变、或重放造不出来的字段。
 *
 * 口径与 `packages/transcript/index.ts` 的 `shape()` 一致（那边是生产代码里的判据）：
 * id 每次重建从 1 重发；ts 是「最后写入时刻」；usage / durationMs / startedAt 是现场
 * 测出来的量，日志里没有。
 */
const shape = (entries) =>
  JSON.stringify(
    entries.map((entry) => {
      const rest = { ...entry }
      delete rest.id
      delete rest.ts
      delete rest.usage
      delete rest.durationMs
      if (entry.kind === 'tool') {
        const call = { ...rest.call }
        delete call.startedAt
        delete call.durationMs
        rest.call = call
      }
      return rest
    }),
  )

/** 两份形状串第一处不同在哪（失败时给一眼看得懂的现场）。 */
const firstDiff = (left, right) => {
  if (left === right) return ''
  let at = 0
  while (at < left.length && at < right.length && left[at] === right[at]) at += 1
  return `第 ${String(at)} 个字符起：实时「${left.slice(at, at + 120)}」／重放「${right.slice(at, at + 120)}」`
}

// ── [1] 一条纯 adapter 的确定性探针：同 hash 只刷时刻、不同 hash 才新增 ─────────
// 为什么先做这一层：真回合里两轮的间隔可能只有几毫秒，ts 很可能相同，断言「刷了时刻」
// 不可靠；这里显式给事件时刻，把去重规则本身钉死。
console.log('── [1] 条目层：同 hash 原地刷时刻 / 换 hash 才新增 ──')
{
  const transcript = new Transcript()
  const view = (hash) => ({ hash, chars: 10, sections: [], model: 'm-test' })
  const parts = [
    { kind: CONTEXT_INJECTION_KINDS.envFacts, source: 'env-facts', where: 'user-tail', chars: 5, preview: '环境' },
  ]
  transcript.reduce({ type: 'prompt/used', prompt: view('aaaaaaaaaaaaaaaa') }, 1000)
  transcript.reduce({ type: 'context/injected', parts }, 1000)
  transcript.reduce({ type: 'prompt/used', prompt: view('aaaaaaaaaaaaaaaa') }, 2000)
  transcript.reduce({ type: 'context/injected', parts: parts.map((part) => ({ ...part })) }, 2000)

  const prompts = transcript.entries.filter((entry) => entry.kind === 'system-prompt')
  const injections = transcript.entries.filter((entry) => entry.kind === 'context-injection')
  check('同 hash 两轮只留一条系统提示条目', prompts.length === 1, `count=${String(prompts.length)}`)
  check('同 hash 的第二轮把时刻刷成最后一次', prompts[0]?.ts === 2000, `ts=${String(prompts[0]?.ts)}`)
  check('同一份注入清单只留一条注入条目', injections.length === 1, `count=${String(injections.length)}`)
  check('注入条目也把时刻刷成最后一次', injections[0]?.ts === 2000, `ts=${String(injections[0]?.ts)}`)

  transcript.reduce({ type: 'prompt/used', prompt: view('bbbbbbbbbbbbbbbb') }, 3000)
  transcript.reduce({
    type: 'context/injected',
    parts: [{ kind: CONTEXT_INJECTION_KINDS.todoReminder, source: 'todo-reminder', where: 'user-tail', chars: 3, preview: '提醒' }],
  }, 3000)
  check('换了 hash 才新增第二条系统提示', transcript.entries.filter((entry) => entry.kind === 'system-prompt').length === 2)
  check('换了注入清单才新增第二条注入', transcript.entries.filter((entry) => entry.kind === 'context-injection').length === 2)
  const ids = transcript.entries.map((entry) => entry.id)
  check('新条目的 id 是稳定正整数（不借别的条目的号）', ids.every((id) => typeof id === 'number' && id > 0))
  check('新条目的 id 互不重复', new Set(ids).size === ids.length, JSON.stringify(ids))
}

// ── [2] 真回合：请求发出去那一刻，两类事件都真的发了、也真的落盘了 ──────────────
console.log('\n── [2] 真回合：日志里出现 system-prompt 与 context-injected ──')
const ctx = await createKernel({
  config: {
    providers: {
      test: {
        name: 'test',
        displayName: 'Test',
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'k',
        models: [
          {
            id: 'm-test',
            name: 'm-test',
            contextWindow: 100_000,
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
    defaultModel: 'm-test',
  },
  resumeSessionPath: null,
})
const sessionId = ctx.session.current().meta.id
const filePath = ctx.session.current().filePath

/** 跑一轮并等它收尾（收尾里还有异步落盘，稍等一下再读）。 */
const runTurn = async (text) => {
  const ended = new Promise((resolve) => {
    const off = ctx.on('dsc/turn-end', (reason, signal) => {
      if (signal.sessionId === sessionId) {
        off()
        resolve(reason)
      }
    })
  })
  ctx.agent.followup(text)
  const reason = await ended
  await sleep(200)
  return reason
}

/** 实时条目（去掉重放造不出来的 system / subagent，与生产代码的比对口径一致）。 */
const liveEntries = () =>
  ctx.transcript.getSnapshot().entries.filter((entry) => entry.kind !== 'system' && entry.kind !== 'subagent')

check('第一轮正常收尾', (await runTurn('第一轮：看看这一轮发了什么')) === 'completed')

const records = readRecords(filePath)
const promptRecords = records.filter((record) => record.type === 'state' && record.id === 'system-prompt')
const injectionRecords = records.filter((record) => record.type === 'state' && record.id === 'context-injected')

check('日志里出现一条 system-prompt 状态记录', promptRecords.length === 1, `count=${String(promptRecords.length)}`)
const promptPayload = promptRecords[0]?.payload ?? {}
check(
  '系统提示记录带 after 落位锚点（写它时日志里有几条消息）',
  promptPayload.after === 1,
  `after=${String(promptPayload.after)}`,
)
check(
  '系统提示记录带卡片视图（hash 与正文字符数与正文同口径）',
  promptPayload.view?.hash === promptHash(promptPayload.text ?? '') &&
    promptPayload.view?.chars === (promptPayload.text ?? '').length,
  JSON.stringify({ hash: promptPayload.view?.hash, expected: promptHash(promptPayload.text ?? ''), chars: promptPayload.view?.chars }),
)
const sectionIds = (promptPayload.view?.sections ?? []).map((section) => section.id)
// 指令文件段只在这个工作目录真有 AGENTS.md 时才出现（探针别把「跑的地方」当成断言前提）
const hasInstructions = existsSync(join(process.cwd(), 'AGENTS.md'))
if (!hasInstructions) console.log('        （当前目录没有 AGENTS.md：跳过「指令文件段」那两条断言）')
check(
  '段清单按拼装顺序含内核三段',
  ['identity', 'behavior', 'tool-rules'].every((id) => sectionIds.includes(id)),
  sectionIds.join(','),
)
const instructionSection = (promptPayload.view?.sections ?? []).find((section) => section.id === 'instructions')
check(
  hasInstructions ? '指令文件段的来源标成 file' : '没有指令文件时那一趟不出现 instructions 段',
  hasInstructions ? instructionSection?.from === 'file' : instructionSection === undefined,
  String(instructionSection?.from),
)
const identitySection = (promptPayload.view?.sections ?? []).find((section) => section.id === 'identity')
check('内核段的来源标成 core', identitySection?.from === 'core', String(identitySection?.from))
check('卡片记下了这一轮用的模型名', promptPayload.view?.model === 'm-test', String(promptPayload.view?.model))
check(
  '段清单里的段都是 {id, order, chars, from} 四件齐',
  (promptPayload.view?.sections ?? []).every(
    (section) =>
      typeof section.id === 'string' &&
      typeof section.order === 'number' &&
      typeof section.chars === 'number' &&
      typeof section.from === 'string',
  ),
)

check('日志里至少一条 context-injected 状态记录', injectionRecords.length >= 1, `count=${String(injectionRecords.length)}`)
const parts = injectionRecords[0]?.payload?.parts ?? []
const kinds = parts.map((part) => part.kind)
check(
  '注入种类含 env-facts / mode / sandbox（本仓现在真有的那几类）',
  ['env-facts', 'mode', 'sandbox'].every((kind) => kinds.includes(kind)),
  kinds.join(','),
)
check('每条注入都带 where / chars / preview', parts.every((part) =>
  (part.where === 'system' || part.where === 'user-tail') &&
  typeof part.chars === 'number' &&
  part.chars >= 0 &&
  typeof part.source === 'string' &&
  typeof part.preview === 'string'))
check('注入记录也带 after 落位锚点', typeof injectionRecords[0]?.payload?.after === 'number', String(injectionRecords[0]?.payload?.after))
check(
  '注入卡片的列表里不出现正文（预览最多 200 字）',
  parts.every((part) => (part.preview ?? '').length <= 200),
)

const firstLive = liveEntries()
check('实时条目里恰好一条系统提示卡', firstLive.filter((entry) => entry.kind === 'system-prompt').length === 1)
check('实时条目里至少一条上下文注入卡', firstLive.filter((entry) => entry.kind === 'context-injection').length >= 1)
check(
  '系统提示卡排在第一句用户消息之后（实时位置就是请求发出那一刻）',
  firstLive.findIndex((entry) => entry.kind === 'system-prompt') === 1,
  `index=${String(firstLive.findIndex((entry) => entry.kind === 'system-prompt'))}`,
)

// ── [3] 同 hash 再来一轮：不新增条目、不重复落盘，只把时刻往前挪 ────────────────
console.log('\n── [3] 第二轮（同一版提示词）：不新增条目 ──')
const tsBefore = firstLive.find((entry) => entry.kind === 'system-prompt')?.ts
check('第二轮正常收尾', (await runTurn('第二轮：提示词没变，应该不新增卡片')) === 'completed')
const secondLive = liveEntries()
const promptEntries2 = secondLive.filter((entry) => entry.kind === 'system-prompt')
check('同 hash 的第二轮没有新增系统提示卡', promptEntries2.length === 1, `count=${String(promptEntries2.length)}`)
check('时刻被刷新（只刷 ts，不换条目）', (promptEntries2[0]?.ts ?? 0) >= (tsBefore ?? 0), `${String(promptEntries2[0]?.ts)} < ${String(tsBefore)}`)

const records2 = readRecords(filePath)
const promptRecords2 = records2.filter((record) => record.type === 'state' && record.id === 'system-prompt')
check('同 hash 的第二轮也没有重复写 system-prompt 记录', promptRecords2.length === 1, `count=${String(promptRecords2.length)}`)
const injectionRecords2 = records2.filter((record) => record.type === 'state' && record.id === 'context-injected')
const injectionEntries2 = secondLive.filter((entry) => entry.kind === 'context-injection').length
check(
  '注入卡片数与落盘记录数一致（同一份清单不重复记）',
  injectionEntries2 === injectionRecords2.length,
  `entries=${String(injectionEntries2)} records=${String(injectionRecords2.length)}`,
)

// ── [4] 重放：新建实例读同一份 jsonl，条目数 / 顺序 / 锚点必须与实时一模一样 ──────
console.log('\n── [4] 重放：条目数、顺序、锚点与实时一致 ──')
const liveFinal = liveEntries()
// 先放掉写租约，再只读重放（跟编辑器里关掉文件再用别的程序读一个道理）
ctx.emit('dsc/exit')
const restored = Session.load(filePath, true, { lease: false })
const probe = new Transcript()
probe.replayHistory(
  restored.messages,
  restored.toolErrors,
  restored.fileChanges,
  restored.presentations,
  restored.notices(),
  restored.marks(),
)
const replayed = probe.entries.filter((entry) => entry.kind !== 'system' && entry.kind !== 'subagent')

check('重放读到了落位记录', restored.marks().length === promptRecords2.length + injectionRecords2.length, `marks=${String(restored.marks().length)}`)
check(
  '系统提示的 after 锚点从日志里读回来了',
  restored.marks().find((mark) => mark.kind === 'system-prompt')?.after === 1,
  String(restored.marks().find((mark) => mark.kind === 'system-prompt')?.after),
)
check('重放条目数与实时一致', replayed.length === liveFinal.length, `重放 ${String(replayed.length)} / 实时 ${String(liveFinal.length)}`)
check('重放条目顺序与内容逐条一致（全字段比对，剔除 id/ts/usage/耗时）', shape(replayed) === shape(liveFinal), firstDiff(shape(liveFinal), shape(replayed)))
check(
  '系统提示卡在重放里也排在第一句用户消息之后（锚点没丢）',
  replayed.findIndex((entry) => entry.kind === 'system-prompt') === liveFinal.findIndex((entry) => entry.kind === 'system-prompt'),
  `重放 ${String(replayed.findIndex((entry) => entry.kind === 'system-prompt'))} / 实时 ${String(liveFinal.findIndex((entry) => entry.kind === 'system-prompt'))}`,
)
const replayedPrompt = replayed.find((entry) => entry.kind === 'system-prompt')
check('重放出来的系统提示卡不标 bodyMissing（视图与正文都在日志里）', replayedPrompt?.prompt?.bodyMissing === undefined)
check(
  '重放出来的段清单与实时逐段一致',
  JSON.stringify(replayedPrompt?.prompt?.sections ?? []) ===
    JSON.stringify(firstLive.find((entry) => entry.kind === 'system-prompt')?.prompt?.sections ?? []),
)
check('重放时消息流本身没有多出东西（系统提示不进消息历史）', restored.messages.every((message) => message.role !== 'system'))

// ── [5] 老数据：没有 after 的 system-prompt 记录 → 落到轮首并标 bodyMissing ──────
console.log('\n── [5] 老数据（没有 after）：落到轮首 + bodyMissing ──')
{
  const legacyDir = join(home, '.dsc', 'sessions', 'legacy')
  mkdirSync(legacyDir, { recursive: true })
  const legacyFile = join(legacyDir, 'legacy-0001.jsonl')
  const legacyText = '老一版系统提示正文（2026-11 之前没有段清单与锚点）'
  const lines = [
    { type: 'meta', id: 'legacy-0001', cwd: join(home, 'work'), createdAt: 1_700_000_000_000 },
    { type: 'user', text: '老会话第一句', ts: 1_700_000_000_100 },
    { type: 'assistant', text: '老会话的回答', reasoning: '', ts: 1_700_000_000_200 },
    // 老形状：只有 hash + text，没有 after、没有 view
    { type: 'state', id: 'system-prompt', payload: { hash: 'deadbeefdeadbeef', text: legacyText } },
  ]
  writeFileSync(legacyFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')

  const legacy = Session.load(legacyFile, true, { lease: false })
  const legacyMark = legacy.marks().find((mark) => mark.kind === 'system-prompt')
  check('老记录也读成一条落位记录', legacyMark !== undefined)
  check('老记录没有 after 锚点', legacyMark?.after === undefined, String(legacyMark?.after))
  check('老记录标了 bodyMissing（段清单当年没记）', legacyMark?.prompt?.bodyMissing === true)
  check('老记录仍能拿到摘要与字符数', legacyMark?.prompt?.hash === 'deadbeefdeadbeef' && legacyMark?.prompt?.chars === legacyText.length)
  check('老记录的段清单是空的（编不出来就不编）', (legacyMark?.prompt?.sections ?? []).length === 0)

  const legacyTranscript = new Transcript()
  legacyTranscript.replayHistory(
    legacy.messages,
    legacy.toolErrors,
    legacy.fileChanges,
    legacy.presentations,
    legacy.notices(),
    legacy.marks(),
  )
  const legacyEntries = legacyTranscript.entries
  check('老记录重放后落在轮首（第 0 条）', legacyEntries[0]?.kind === 'system-prompt', legacyEntries.map((entry) => entry.kind).join(','))
  check('老记录重放仍标着 bodyMissing', legacyEntries[0]?.prompt?.bodyMissing === true)
  check('老会话的消息照常重放出来（两张卡不挤掉历史）', legacyEntries.length === 3)
}

console.log(failures === 0 ? '\n系统提示 / 上下文注入落盘自检：全部通过' : `\n系统提示 / 上下文注入落盘自检：${failures} 条断言未过`)
process.exit(failures === 0 ? 0 : 1)
