/**
 * 移植自 dsh-superagent/src/app/versions.ts（34 行，逐字）。
 * 改动只有 import 路径（与上游只差 NodeNext 的 `.js` 扩展名）：
 *   `../kv.ts` → `../kv.js`；`./store.ts` → `./store.js`。
 * 逻辑一行未改，上游英文 doc 注释保留原文。
 *
 * 版本化记录存储：编号快照 + Store KV 表里的当前修订指针。
 *
 * @module dsc/packages/superagent/app/versions
 */
/** Versioned record storage backed by numbered snapshots and a current-revision pointer in the Store KV table. */
import type { Family, Key } from '../kv.js'
import type { Store } from './store.js'

/**
 * Manages numbered snapshots of a versioned record in the `Store` key-value table with a pointer key tracking the active revision.
 * Each save writes a new snapshot and advances the pointer atomically, keeping full history without duplicating the active record.
 * Used by `Store` for settings history and by `Prompts` for versioned prompt configuration.
 */
export class Versions<V extends { revision: number }> {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>, private readonly pointer: Key<number>,
    private readonly family: Family<V, [revision: number]>) {}
  /** Current revision number, or `0` before the first save. */
  revision(): number { return this.store.get(this.pointer) ?? 0 }
  /** Current snapshot, or `undefined` before the first save. */
  current(): V | undefined {
    const revision = this.store.get(this.pointer)
    return revision === undefined ? undefined : this.get(revision)
  }
  get(revision: number): V | undefined { return this.store.get(this.family(revision)) }
  save(make: (revision: number) => V): V {
    return this.store.atomic(() => {
      const version = make(this.revision() + 1)
      this.store.set(this.family(version.revision), version)
      this.store.set(this.pointer, version.revision)
      return version
    })
  }
  /** Stores a snapshot without advancing the current revision pointer (e.g., to record an initial built-in baseline). */
  keep(version: V): void { this.store.set(this.family(version.revision), version) }
  list(limit = Infinity): V[] {
    return this.store.keys(this.family).flatMap(name => this.store.get(name) ?? []).sort((a, b) => b.revision - a.revision).slice(0, limit)
  }
}
