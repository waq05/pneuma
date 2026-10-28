/**
 * 只读探针：量一量真实会话的加载开销（`Session.load` + `replayHistory`）。
 *
 * 为什么要有它：讨论「要不要做数据源分页」时，唯一的硬依据是真实开销。
 * 这个脚本**只读** `~/.dsc/sessions`，不写任何文件、不改任何状态。
 *
 * 用法（在仓库根目录）：node desktop/shots/load-bench.mjs
 *
 * @module desktop/shots/load-bench
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.env.USERPROFILE ?? '', '.dsc', 'sessions')

/** 递归收集所有 jsonl。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.jsonl')) out.push({ file: full, size: statSync(full).size })
  }
  return out
}

const all = walk(root).sort((left, right) => right.size - left.size)
const core = await import('../../lib/core/session.js')
const { Transcript } = await import('../../lib/adapter/transcript.js')

console.log(`会话文件 ${String(all.length)} 个，总 ${(all.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)} MB`)

const picked = all.slice(0, 3)
for (const item of picked) {
  globalThis.gc?.()
  const before = process.memoryUsage().heapUsed
  const t0 = performance.now()
  const session = core.Session.load(item.file)
  const t1 = performance.now()
  const transcript = new Transcript()
  transcript.replayHistory(session.messages, session.toolErrors)
  const t2 = performance.now()
  const after = process.memoryUsage().heapUsed
  console.log(
    `${(item.size / 1024).toFixed(0).padStart(6)} KB · 消息 ${String(session.messages.length).padStart(3)} 条 · ` +
    `条目 ${String(transcript.entries.length).padStart(3)} 条 · ` +
    `load ${(t1 - t0).toFixed(1)}ms · replay ${(t2 - t1).toFixed(1)}ms · ` +
    `堆增量 ${((after - before) / 1048576).toFixed(2)} MB`,
  )
}

// 把全部会话都加载一遍：模拟「最坏情况」（用户把每条会话都打开过）
globalThis.gc?.()
const heapBefore = process.memoryUsage().heapUsed
const t3 = performance.now()
let messages = 0
let entries = 0
let broken = 0
for (const item of all) {
  // 真实目录里有坏文件（缺 meta 行、写到一半）：探针不该被它们掀翻，只记一笔
  try {
    const session = core.Session.load(item.file)
    const transcript = new Transcript()
    transcript.replayHistory(session.messages, session.toolErrors)
    messages += session.messages.length
    entries += transcript.entries.length
  } catch {
    broken += 1
  }
}
const t4 = performance.now()
const heapAfter = process.memoryUsage().heapUsed
console.log(
  `全部 ${String(all.length)} 个会话加载一遍：${String(messages)} 条消息 / ${String(entries)} 条条目 · ` +
  `${(t4 - t3).toFixed(0)}ms · 堆增量 ${((heapAfter - heapBefore) / 1048576).toFixed(1)} MB · ` +
  `跳过坏文件 ${String(broken)} 个`,
)
