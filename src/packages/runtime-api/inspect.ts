/**
 * runtime_api 的反射底座：从 cordis 的注册表里抽出「服务清单」与「事件清单」。
 *
 * 为什么单独一个纯函数文件：`ctx.reflect.store` 与 `ctx.events._hooks` 是运行期才有的
 * 内部结构，逻辑一旦写在闭包里就只能靠起真宿主验证；抽成纯函数之后，用一份假表就能
 * 钉住「去重 / 过滤原型方法 / 跳过 internal 事件」这几条口径。
 *
 * @module dsc/plugins/runtime-api/inspect
 */

/** 一个服务的能力面（只列方法名，不读值、不调用）。 */
export interface ServiceInfo {
  name: string
  methods: string[]
}

/** 一个挂着监听者的事件。 */
export interface EventInfo {
  name: string
  listeners: number
}

/** 服务对象上的方法名：自有 + 两层原型，止步于 Object.prototype（那里是通用方法）。 */
function methodNames(value: unknown): string[] {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return []
  const methods: string[] = []
  let cursor: object | null = value as object
  let depth = 0
  while (cursor !== null && cursor !== Object.prototype && depth < 3) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name === 'constructor' || methods.includes(name)) continue
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name)
      // 只认数据属性里的函数：getter 可能偷偷算东西，探查不该触发它。
      if (descriptor?.value !== undefined && typeof descriptor.value === 'function') methods.push(name)
    }
    cursor = Object.getPrototypeOf(cursor) as object | null
    depth += 1
  }
  return methods
}

/**
 * 从 `ctx.reflect.store` 抽服务清单。
 * 同一服务在多个 isolation 作用域里可能有几份实现，保留方法最多的那一份。
 */
export function listServices(store: Record<symbol, unknown> | undefined): ServiceInfo[] {
  const seen = new Map<string, string[]>()
  for (const key of Object.getOwnPropertySymbols(store ?? {})) {
    const impl = (store ?? {})[key] as { name?: unknown; value?: unknown } | undefined
    if (impl === undefined || typeof impl.name !== 'string') continue
    const methods = methodNames(impl.value)
    const previous = seen.get(impl.name)
    if (previous === undefined || methods.length > previous.length) seen.set(impl.name, methods)
  }
  return [...seen.entries()]
    .map(([name, methods]) => ({ name, methods }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 从 `ctx.events._hooks` 抽事件清单。
 * 只列此刻至少有一个监听的事件；框架内部的 `internal/*` 跳过（写插件用不上）。
 */
export function listEvents(hooks: Record<string, unknown> | undefined): EventInfo[] {
  const out: EventInfo[] = []
  const table = (hooks ?? {}) as Record<string | symbol, unknown>
  for (const key of Object.keys(table)) {
    if (key.startsWith('internal/')) continue
    const listeners = table[key]
    if (!Array.isArray(listeners) || listeners.length === 0) continue
    out.push({ name: key, listeners: listeners.length })
  }
  // 符号事件名（插件内部约定）也要列：它们是真实挂钩点，只是名字不是字符串。
  for (const key of Object.getOwnPropertySymbols(table)) {
    const listeners = table[key]
    if (!Array.isArray(listeners) || listeners.length === 0) continue
    out.push({ name: String(key), listeners: listeners.length })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
