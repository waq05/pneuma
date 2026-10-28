/**
 * 轨迹页改版自检的种子数据：只写 `desktop/shots/trace-home`（临时 HOME + 临时 userData），
 * 用户真实的 `~/.dsc` 与真实 workspace 一个字节都不写。
 *
 * 为什么要手写 jsonl 而不是用 core.Session 的 append*：这份样张要的是**确定的**耗时与
 * 一个「结果没回来」的工具调用——`appendUser/appendTool` 用的是 `Date.now()`，两次调用之间
 * 只差几毫秒，量不出 `4.2s` 与 `1m03s` 这种读数；而 running 态在实时路径上根本写不进日志。
 * 手写 jsonl 走的是与「打开老会话」完全相同的那条重放路径（Session.load → replayHistory），
 * 正好把轨迹页的重放侧全部覆盖到：
 *
 *   - summary 记录（正文带 SUMMARY_BANNER）→ 重放出那条 user 摘要条目，渲染成压缩区段行；
 *   - 两次工具调用：结果分别在 4.2s / 1m03s 后到达 → 时间条上两条宽度不同的条；
 *   - 被拒（error: rejected）与报错（error: tool-error）各一次 → 行内元信息染成黄 / 红；
 *   - 一次**没有结果**的工具调用 → 卡片停在「进行中」，行内没有耗时，时间条只有起点刻度
 *     （这条就是「running 不虚构耗时」的实测样张）；
 *   - 第 3 轮的用户消息带两张贴图（data URL）→ 检查器的附件区与放大浮层。
 *
 * 环境变量：
 *   TRACE_THEME=dark|light  写进 settings.json 的 ui.themeMode（默认 dark）
 *
 * 用法：node desktop/shots/trace-seed.mjs（在仓库根目录）
 *
 * @module desktop/shots/trace-seed
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const home = 'D:\\dsc\\desktop\\shots\\trace-home'
const theme = process.env.TRACE_THEME === 'light' ? 'light' : 'dark'

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc', 'usage'), { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置；这个目录不存在时
// 它直接崩掉（0x80000003，stdout 一个字都留不下），所以隔离目录必须预先建好它。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

writeFileSync(
  join(home, '.dsc', 'config.yaml'),
  `# 轨迹页自检专用：这份样张只重放历史，不会真的发请求，端点指一个不存在的本机端口即可
default:
  provider: fake
  model: fake-chat
providers:
  fake:
    displayName: 自检假端点
    baseURL: http://127.0.0.1:18959/v1
    apiKeyEnv: TRACE_FAKE_KEY
    models:
      - id: fake-chat
        name: Fake Chat
        contextWindow: 128000
        maxTokens: 4096
`,
  'utf8',
)

writeFileSync(
  join(home, '.dsc', 'settings.json'),
  `${JSON.stringify(
    {
      defaultPolicy: 'readonly',
      defaultEffort: null,
      marketSources: [],
      closeToTray: false,
      ui: {
        sessionSort: 'recent',
        sessionGroup: 'workspace',
        archivedFilter: 'hide',
        workspaceOrder: ['D:\\dsc'],
        workspaceAliases: {},
        themeMode: theme,
        fontSize: 1,
        buttonScale: 1,
        density: 'standard',
        processFold: 'standard',
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

// ── 贴图：一小段自带的 PNG 编码器（不引第三方库），造两张看得清区别的渐变方块 ──────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, crc])
}

/** 生成 width×height 的渐变 PNG（pixel(x, y) 返回 [r,g,b]），返回 data URL。 */
function pngDataUrl(width, height, pixel) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let at = 0
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0 // 过滤器：none
    at += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x / (width - 1), y / (height - 1))
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
      at += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 颜色类型：真彩
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}

const shotOne = pngDataUrl(120, 80, (x, y) => [40 + Math.round(200 * x), 90, 160 + Math.round(80 * y)])
const shotTwo = pngDataUrl(120, 80, (x, y) => [180, 60 + Math.round(150 * y), 60 + Math.round(120 * x)])

// ── 会话日志：时间轴完全由 ts 定，行内读数因此是确定的 ──────────────────────────────
const SUMMARY_BANNER = '[先前对话的交接摘要（原文已压缩）]'
const id = '3f2a91c4-5d6e-4b71-9a02-000000000001'
// 起点定在 3 分钟前：重放历史的最后一条落在 26 秒前，而会话开场写下的
// 「已恢复会话」system 条目用 Date.now()——两者之差就是时间条的总跨度（约 3 分钟），
// 时间条的宽度因此落在「看得见、又不会把 4.2s 那条挤成一根线」的区间里。
const base = Date.now() - 180_000
const at = (offset) => base + offset

const records = [
  { type: 'meta', id, cwd: 'D:\\dsc', createdAt: at(-120_000) },
  // 压缩落点：正文以 SUMMARY_BANNER 开头，重放时被 adapter 认出来并盖上 compaction 标记
  {
    type: 'summary',
    text: `${SUMMARY_BANNER}\n自检样张：这一条之前的记录已被压缩，重放时它是一条 user 条目。`,
    keep: 0,
    ts: at(-60_000),
  },
  // ── 第 1 轮：两次工具调用，耗时 4.2s 与 1m03s ──
  { type: 'user', text: '把轨迹页的时间条按 dsh 的口径改一下，先说说你打算怎么投影。', ts: at(0) },
  {
    type: 'assistant',
    text: '',
    reasoning:
      '先看轨迹页现在怎么切轮：轮次边界是「用户消息到下一条用户消息」。\n时间条的宽度只能来自 durationMs，拿不到耗时的步骤只画起点刻度。',
    toolCalls: [
      { id: 'call_trace_read', name: 'read', arguments: JSON.stringify({ path: 'D:\\dsc\\desktop\\src\\renderer\\TraceView.tsx' }) },
      { id: 'call_trace_grep', name: 'grep', arguments: JSON.stringify({ pattern: 'durationMs', path: 'D:\\dsc\\desktop\\src\\renderer' }) },
    ],
    ts: at(1_000),
  },
  {
    type: 'tool',
    callId: 'call_trace_read',
    name: 'read',
    text: 'export function TraceView(props: { entries: TranscriptEntry[]; status: StatusView }): JSX.Element { … }',
    ts: at(5_200),
  },
  {
    type: 'tool',
    callId: 'call_trace_grep',
    name: 'grep',
    text: 'desktop/src/renderer/trace-format.ts:167: durationMs\ndesktop/src/renderer/TraceTimeline.tsx:96: mark.durationMs',
    ts: at(64_000),
  },
  {
    type: 'assistant',
    text: '最终回答：时间条按 (ts − 首条 ts) / 总时长 投影，只有拿到 durationMs 的工具才画宽度。',
    reasoning: '',
    ts: at(66_000),
  },
  // ── 第 2 轮：被拒 + 报错各一次 ──
  { type: 'user', text: '失败与被拒的调用在轨迹里怎么区分？耗时还显示吗？', ts: at(90_000) },
  {
    type: 'assistant',
    text: '',
    reasoning: '两种都要保留耗时：跑挂了与被审批拒掉同样占了这段时间。',
    toolCalls: [
      { id: 'call_trace_write', name: 'write', arguments: JSON.stringify({ path: 'D:\\dsc\\desktop\\src\\renderer\\TraceView.tsx', content: '…' }) },
      { id: 'call_trace_bash', name: 'bash', arguments: JSON.stringify({ command: 'pnpm --dir desktop typecheck' }) },
    ],
    ts: at(92_000),
  },
  {
    type: 'tool',
    callId: 'call_trace_write',
    name: 'write',
    text: '用户拒绝了这次工具调用。',
    error: 'rejected',
    ts: at(92_500),
  },
  {
    type: 'tool',
    callId: 'call_trace_bash',
    name: 'bash',
    text: '错误：命令退出码 1（tsc 报了一处类型错）',
    error: 'tool-error',
    ts: at(108_000),
  },
  {
    type: 'assistant',
    text: '最终回答：状态位沿用工具卡那套语义色，行内的时刻与耗时跟着染成同一档颜色，不重复那个词。',
    reasoning: '',
    ts: at(110_000),
  },
  // ── 第 3 轮：带两张贴图；末尾那次工具调用没有结果，卡片停在「进行中」 ──
  { type: 'user', text: '这两张是我截的时间条，你照着看下比例对不对。', images: [shotOne, shotTwo], ts: at(150_000) },
  {
    type: 'assistant',
    text: '',
    reasoning: '照片里两条都占了总时长的很小一段，说明投影是按真实时刻算的，不是把条数摊平。',
    toolCalls: [
      { id: 'call_trace_read2', name: 'read', arguments: JSON.stringify({ path: 'D:\\dsc\\desktop\\shots\\trace-seed.mjs' }) },
      { id: 'call_trace_bash2', name: 'bash', arguments: JSON.stringify({ command: 'pnpm --dir desktop build' }) },
    ],
    ts: at(152_000),
  },
  { type: 'tool', callId: 'call_trace_read2', name: 'read', text: '（读取成功：trace-seed.mjs 已按行返回，内容从略）', ts: at(152_300) },
  {
    type: 'assistant',
    text: '最终回答：比例没问题。最后那次 build 我还没看到结果，轨迹里它就停在「进行中」。',
    reasoning: '',
    ts: at(154_000),
  },
]

const dir = join(home, '.dsc', 'sessions', 'D-dsc')
mkdirSync(dir, { recursive: true })
const file = join(dir, `${id}.jsonl`)
writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')

writeFileSync(
  'D:\\dsc\\desktop\\shots\\trace-sessions.json',
  `${JSON.stringify({ home, theme, session: file }, null, 2)}\n`,
  'utf8',
)

console.log(`seeded ${home} (theme=${theme})`)
console.log(`trace session: ${file}`)
