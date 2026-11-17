/**
 * 移植自 dsh-superagent/src/infra/health.ts（35 行，逐字）。
 * 改动只有一处：import 路径 `../sources/host.ts` → `../sources/host.js`（本仓 NodeNext 要求带扩展名；
 * 目录已按上游镜像，相对深度与上游一致）。
 *
 * 组件体检登记表：管理面板与来源状态区都在读这块板子。
 *
 * @module dsc/packages/superagent/infra/health
 */
/** Component health registry displayed in the overview and source status panels. */
import type { Health } from '../sources/host.js'

export interface HealthEntry {
  get(): Health | undefined
  set(health: Health): void
  /** Unregisters the entry from the board (such as when a Source kind unregisters); subsequent `set` calls become no-ops. */
  release(): void
}

/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by Runtime, Effects, Sessions, DshExecutor, Settings, and SourceRegistry, and read by management HTTP routes.
 */
export class HealthBoard {
  private readonly entries: Record<string, Health> = {}
  private readonly claimed = new Set<string>()
  claim(name: string, initial?: Health): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`)
    this.claimed.add(name)
    if (initial) this.entries[name] = initial
    let held = true
    return {
      get: () => this.entries[name],
      set: health => { if (held) this.entries[name] = health },
      release: () => {
        if (!held) return
        held = false
        this.claimed.delete(name)
        delete this.entries[name]
      },
    }
  }
  get all(): Readonly<Record<string, Health>> { return this.entries }
}
