/**
 * 界面壳侧的帧归并：把宿主推来的全量/增量帧并进一份快照。
 *
 * 线协议与遥控端（`remote-web/src/lib/reduce.ts`）是**同一份**（`core/remote/frames.ts` 定的
 * 契约：全量 `{type:'snapshot', seq, full:true, ...字段铺平}`、增量
 * `{type:'delta', seq, full:false, meta, added, updated, removedIds, liveEntries}`）。
 *
 * 与遥控端那份的区别只有一个，而且是有意的：**这里是严格版**。遥控端要容忍版本漂移
 * （客户端的页面可能是旧构建、宿主可能是旧版本，字段形状对不上也得画出来），所以它有一整套
 * `normalize*` 兜底；界面壳与宿主永远同一次构建一起发（壳就是从宿主的 `/` 里取回来的），
 * 认不出的帧直接当错误处理——把「容忍」换成「早暴露」，省掉的兜底代码不再需要维护两遍口径。
 *
 * 条目按 id 合并后统一按 id 升序：宿主发号递增，id 序就是时间序，比维护插入序少一处状态。
 *
 * @module dsc/ui/frames
 */

/** 帧里的条目：id 是宿主发的正数（负 id 是直播尾，走 liveEntries）。 */
export interface HostEntry {
  id: number
  [key: string]: unknown
}

/** 归并后的快照：`meta`（除 entries / liveEntries 之外的字段）+ 条目 + 直播尾。 */
export interface HostSnapshot {
  seq: number
  entries: HostEntry[]
  liveEntries: HostEntry[]
  [key: string]: unknown
}

/** 认不出的帧抛这个（严格版：宁可报错也不要画出一份半对不对的状态）。 */
export class HostFrameError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** 帧顶层是不是全量（先看 `full`，再看 `type`）。 */
export function isFullFrame(raw: unknown): boolean {
  const frame = asRecord(raw)
  if (frame === null) return false
  if (frame['full'] === true) return true
  if (frame['full'] === false) return false
  return frame['type'] === 'snapshot'
}

/** 帧顶层的 seq。 */
export function readFrameSeq(raw: unknown): number | null {
  const frame = asRecord(raw)
  if (frame === null) return null
  const value = frame['seq']
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 收下一段条目：只认带有限数字 id 的对象。 */
function readEntries(raw: unknown): HostEntry[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new HostFrameError('条目字段不是数组')
  const out: HostEntry[] = []
  for (const item of raw) {
    const entry = asRecord(item)
    const id = entry?.['id']
    if (entry === null || typeof id !== 'number' || !Number.isFinite(id)) {
      throw new HostFrameError('条目缺少数字 id')
    }
    out.push(entry as HostEntry)
  }
  return out
}

/** 收下 removedIds：只认有限数字。 */
function readRemovedIds(raw: unknown): number[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new HostFrameError('removedIds 不是数组')
  const out: number[] = []
  for (const item of raw) {
    if (typeof item === 'number' && Number.isFinite(item)) out.push(item)
  }
  return out
}

/**
 * 把一帧并进当前快照。
 * @param previous - 当前快照（首帧传 null）
 * @param raw - 宿主推来的一帧（已 JSON 解析）
 * @returns 新的快照
 * @throws {HostFrameError} 帧认不出（不是对象、全量帧缺 seq、条目形状不对）
 */
export function applyHostFrame(previous: HostSnapshot | null, raw: unknown): HostSnapshot {
  const frame = asRecord(raw)
  if (frame === null) throw new HostFrameError('帧不是对象')
  const seq = readFrameSeq(frame)
  if (seq === null) throw new HostFrameError('帧缺少 seq')

  if (isFullFrame(frame)) {
    const meta: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(frame)) {
      if (key === 'entries' || key === 'liveEntries' || key === 'type' || key === 'full') continue
      meta[key] = value
    }
    return { ...meta, seq, entries: readEntries(frame['entries']), liveEntries: readEntries(frame['liveEntries']) }
  }

  const meta = asRecord(frame['meta'])
  if (meta === null) throw new HostFrameError('增量帧缺少 meta')
  const byId = new Map<number, HostEntry>()
  for (const entry of previous?.entries ?? []) byId.set(entry.id, entry)
  for (const id of readRemovedIds(frame['removedIds'])) byId.delete(id)
  for (const entry of readEntries(frame['updated'])) byId.set(entry.id, entry)
  for (const entry of readEntries(frame['added'])) byId.set(entry.id, entry)
  const entries = [...byId.values()].sort((left, right) => left.id - right.id)
  // liveEntries 每帧全量给：缺这个字段时保留旧值（兜底，契约里不缺）。
  const liveEntries = 'liveEntries' in frame ? readEntries(frame['liveEntries']) : (previous?.liveEntries ?? [])
  return { ...(previous ?? {}), ...meta, seq, entries, liveEntries }
}
