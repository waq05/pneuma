/**
 * 移植自 dsh-superagent/src/app/cache.ts（27 行，逐字）。
 * 改动：无（这个文件本来就没有 import）。
 *
 * 按合计 UTF-16 码元数封顶的内存 LRU 文本缓存，最近插入的那一条始终保留。
 *
 * @module dsc/packages/superagent/app/cache
 */
/**
 * In-memory LRU cache bounded by total UTF-16 code units, always retaining the most recently inserted entry.
 * Runtime uses separate instances to cache paginated resource snapshots for `orchestrator_read` and resolved Feishu message links for search and cards.
 */
export class TextCache {
  private readonly texts = new Map<string, string>()
  private size = 0
  constructor(private readonly limit: number) {}
  get(key: string): string | undefined {
    const text = this.texts.get(key)
    if (text !== undefined) { this.texts.delete(key); this.texts.set(key, text) }
    return text
  }
  set(key: string, text: string): void {
    this.size -= this.texts.get(key)?.length ?? 0
    this.texts.delete(key)
    this.texts.set(key, text)
    this.size += text.length
    for (const [oldest, value] of this.texts) {
      if (this.size <= this.limit || oldest === key) break
      this.texts.delete(oldest)
      this.size -= value.length
    }
  }
  /** Entries ordered from least to most recently used. */
  entries(): IterableIterator<[string, string]> { return this.texts.entries() }
}
