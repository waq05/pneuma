/**
 * 客户端服务表（A1）：插件之间「谁提供、谁消费」的值表。
 *
 * 与参考实现的语义差，如实写清：dsh 的客户端服务是 cordis 的 `Service`（挂 fiber 生命周期、
 * `ctx.inject` 动态等待）；dsc 这份是**装载期的值表**——没有 fiber，等待语义在装载循环里
 * 实现（`inject` 名单解析 + 失败重试一轮，两个装载器共用 {@link unmetInjections}）。
 * 表本身只负责三件事：提供、读取、订阅（服务出现/消失时让界面换数据源）。
 *
 * 一个名字只能有一个提供者：第二次 `provide` 抛 {@link ServiceConflictError}（人话里带
 * 两个插件 id）——「跨插件重名冲突必须报出来」落在这一处，席位（D3）本身没有字符串键。
 *
 * @module dsc/ui/services
 */

/** 同一个服务名有两个提供者时抛这个（谁提供必须唯一，不能靠加载顺序偷偷决定）。 */
export class ServiceConflictError extends Error {
  constructor(name: string, first: string, second: string) {
    super(`服务「${name}」已经由插件 ${first} 提供，插件 ${second} 不能重复提供（一个名字只能有一个提供者）`)
  }
}

/** `provide` 的名字不合法（空串或非字符串）时抛这个：空名字读不出来，等于静默丢东西。 */
export class UndeclaredServiceError extends Error {
  constructor(name: unknown) {
    const shown = typeof name === 'string' ? `「${name}」` : String(name)
    super(`服务名必须是非空字符串，收到的是 ${shown}`)
  }
}

/** 一条已提供的服务。 */
interface ServiceRecord {
  name: string
  value: unknown
  /** 提供它的插件 id（诊断与冲突文案用）。 */
  provider: string
}

/**
 * 服务表。装载器每次装载建一张（不是模块级单例——探针与多轮装载各自隔离）。
 */
export class ServiceRegistry {
  private readonly records = new Map<string, ServiceRecord>()
  private readonly listeners = new Set<() => void>()

  /**
   * 提供一个服务。
   * @param name - 服务名（非空字符串）
   * @param value - 服务值（任意）
   * @param provider - 提供者的插件 id
   * @returns 退订函数：撤掉这次提供（进插件账本，卸载/重试回滚时调用）
   * @throws {UndeclaredServiceError} 名字为空/非字符串
   * @throws {ServiceConflictError} 同名已有提供者
   */
  provide<T>(name: string, value: T, provider: string): () => void {
    if (typeof name !== 'string' || name === '') throw new UndeclaredServiceError(name)
    const existing = this.records.get(name)
    if (existing !== undefined) throw new ServiceConflictError(name, existing.provider, provider)
    const record: ServiceRecord = { name, value, provider }
    this.records.set(name, record)
    this.notify()
    let released = false
    return () => {
      if (released) return
      released = true
      // 迟到的退订不能撤掉后来者：重试后同一名字可能已由新一次 provide 顶上。
      if (this.records.get(name) !== record) return
      this.records.delete(name)
      this.notify()
    }
  }

  /** 读一个服务；缺席给 undefined。 */
  consume<T>(name: string): T | undefined {
    return this.records.get(name)?.value as T | undefined
  }

  /** 这个服务现在有没有提供者。 */
  has(name: string): boolean {
    return this.records.has(name)
  }

  /** 当前的服务名（诊断行与装载结果快照用）。 */
  names(): string[] {
    return [...this.records.keys()]
  }

  /** 某个服务的提供者插件 id；没有给 undefined。 */
  providerOf(name: string): string | undefined {
    return this.records.get(name)?.provider
  }

  /** 订阅提供/撤销（`useService` 与诊断用）。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        // 一个订阅者炸了不该拖垮别的订阅者，但也不能静默。
        console.error('服务表订阅者抛异常：', error)
      }
    }
  }
}

/**
 * 解析一条 `inject` 名单，返回未满足的原因（空数组 = 可以装）。
 *
 * `inject` 是**双关**：先按「清单里另一个插件的 id」解（既有拓扑排序用的就是它），
 * 再按「服务名」解（提供者还没装上/被停用）。两档失败文案分开——没有提供者 vs
 * 提供者没装上；插件 id 在清单里时以它为准（见 `manifest.ts` 的注释）。
 * @param names - 插件声明的 inject 名单
 * @param reportOf - 查另一个插件的装载报告（按插件 id）
 * @param services - 当前的服务表
 */
export function unmetInjections(
  names: readonly string[] | undefined,
  reportOf: (id: string) => { ok: boolean; error?: string } | undefined,
  services: ServiceRegistry,
): string[] {
  const unmet: string[] = []
  for (const name of names ?? []) {
    const dependency = reportOf(name)
    if (dependency !== undefined) {
      if (dependency.ok !== true) unmet.push(`插件 ${name} 没装上：${dependency.error ?? '未知原因'}`)
      continue
    }
    if (!services.has(name)) unmet.push(`服务 ${name} 还没有提供者`)
  }
  return unmet
}
