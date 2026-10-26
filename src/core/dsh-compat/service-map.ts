/**
 * dsh 服务名 → Pneuma 的判定表（兼容层拒绝插件时用来说人话）。
 *
 * 为什么要有这张表：插件 `inject` 里出现 Pneuma 不认识的服务名时，一句「超出兼容层范围」
 * 对插件作者没有用——他不知道差在哪、也不知道该换成什么。这张表给每个常见 dsh 服务名
 * 一句判定：**能直传**（同名同义，本来就在 Pneuma 的服务清单里）、**有对应但语义不同**
 * （必须写适配器，直接透传会静默错）、**没有对应**（拒绝并说明）。
 *
 * 口径来自对 dsh 源码的逐条核对（服务定义文件与 Pneuma 的方法签名两侧对照），
 * 判定有分歧时以「照原名直传会不会静默错」为准——宁可拒绝，不要装上一个一调就炸的服务。
 *
 * @module dsc/core/dsh-compat/service-map
 */

/** 一个 dsh 服务名在 Pneuma 这边的判定。 */
export type DshServiceVerdict =
  /** 同名同义：Pneuma 也有这个服务，形状由兼容层/适配器吸收。 */
  | { tier: 'same' }
  /** 有对应物但语义或 API 不同：必须先有适配器，直接透传会静默错。 */
  | { tier: 'adapted'; pneuma: string; note: string }
  /** Pneuma 没有对应，或对应物根本不是一回事：拒绝。 */
  | { tier: 'missing'; note: string }

/**
 * 判定表。键是 dsh 的服务名。
 *
 * 只收「插件真会 inject 的」那些；dsh 的客户端（界面）服务不在此列——那是阶段 D 的事。
 *
 * `sessionPersistence` 与 `sessions` 走的是「兼容层 `ctx.get` 兜底」：真挂载时它们由
 * core/dsh-compat/session-bridge 现造一个只读桥交出去。写进 `inject` 仍会被拒（cordis
 * 的服务表里没有这两个名字，等不到）——插件改成 `ctx.get` 即可，dsh 自己的 cost-meter
 * 就是这种写法。
 */
export const DSH_SERVICE_MAP: Readonly<Record<string, DshServiceVerdict>> = {
  // ── 同名同义（Pneuma 有同名服务，本来就不算 foreign） ──────────────────────
  tools: { tier: 'same' },
  commands: { tier: 'same' },
  approval: { tier: 'same' },
  skills: { tier: 'same' },
  compaction: { tier: 'adapted', pneuma: 'compact', note: 'dsh 的压缩服务带 agent 参数，Pneuma 只压当前会话' },
  permissionPresets: { tier: 'adapted', pneuma: 'permissionPresets', note: 'dsh 按会话写预设，Pneuma 写的是用户偏好' },

  // ── 有对应但语义不同 ──────────────────────────────────────────────────────
  llm: { tier: 'adapted', pneuma: 'llm', note: 'dsh 的 llm 不存当前模型，Pneuma 的 llm 是选路单例；读 provider 会拿到不同东西' },
  sessions: { tier: 'adapted', pneuma: 'sessions（只读桥）', note: 'dsh 是多会话注册表；Pneuma 给一份只读的会话清单（list / get / has），没有 fork、prompt 这些写口' },
  sessionPersistence: { tier: 'adapted', pneuma: 'sessions（只读桥）', note: 'dsh 是事件溯源的持久化（create / open / stat + 读写句柄）；Pneuma 只给 list / stat / open(read) / read，写方法响亮拒绝——会话由内核独占写入' },
  agents: { tier: 'adapted', pneuma: 'agent', note: 'dsh 是 agent 注册表，Pneuma 只有当前回合循环；子智能体走 team' },
  settings: { tier: 'adapted', pneuma: 'settings', note: '同名不同物：dsh 是插件 Config 表单，Pneuma 是应用设置' },
  systemPrompt: { tier: 'adapted', pneuma: 'prompt', note: 'dsh 是结构化 section，Pneuma 是 register(id, text, order)' },
  goals: { tier: 'adapted', pneuma: 'goal', note: 'dsh 的调用都带 agent，Pneuma 是单例 store' },
  planMode: { tier: 'adapted', pneuma: 'plan', note: 'dsh 是计划模式开关，Pneuma 是「交计划等批」' },
  sandbox: { tier: 'adapted', pneuma: 'sandbox', note: 'dsh 包进程执行，Pneuma 只判路径能不能写' },
  userQuestions: { tier: 'adapted', pneuma: 'ask', note: '异名近义，按 ask 的接口改写' },
  sessionQuery: { tier: 'adapted', pneuma: 'sessionSearch', note: '异名近义，按全文检索改写' },
  agentPresets: { tier: 'adapted', pneuma: 'presets', note: '异名近义，Pneuma 的模式是 md 文件' },
  subagents: { tier: 'adapted', pneuma: 'team', note: '异名近义，Pneuma 只有队友名册' },
  mcpResources: { tier: 'adapted', pneuma: 'mcp', note: 'dsh 只给资源，Pneuma 有 servers/tools/call' },

  // ── 没有对应 ──────────────────────────────────────────────────────────────
  sessionProjections: { tier: 'missing', note: 'Pneuma 没有事件投影系统' },
  schedule: { tier: 'missing', note: 'Pneuma 的 schedule 只在服务名单里登记过名字，没有实现' },
  jobs: { tier: 'missing', note: 'Pneuma 没有作业服务（后台活只到 backgroundWorks 快照）' },
  storage: { tier: 'missing', note: 'Pneuma 让插件自己落盘' },
  fs: { tier: 'missing', note: '请改用 node:fs' },
  shell: { tier: 'missing', note: 'Pneuma 没有 shell 服务' },
  terminal: { tier: 'missing', note: 'Pneuma 的终端是界面插件，不是宿主服务' },
  workspaces: { tier: 'missing', note: 'Pneuma 没有工作区注册表' },
  web: { tier: 'missing', note: 'Pneuma 没有 web 服务' },
  clientModules: { tier: 'missing', note: 'Pneuma 没有前端模块注册表' },
  agentLoop: { tier: 'missing', note: 'Pneuma 的回合循环是 agent 插件内部实现' },
  tokenMeter: { tier: 'missing', note: 'Pneuma 没有 token 计量服务' },
  spillStore: { tier: 'missing', note: 'Pneuma 的大输出溢出是 DSL 插件自己的事' },
}

/** 查一个 dsh 服务名的判定；没收录给 undefined。 */
export function dshServiceVerdict(name: string): DshServiceVerdict | undefined {
  return DSH_SERVICE_MAP[name]
}

/**
 * 把一批不认识的服务名折成一句人话（插件挂不上时写进诊断）。
 *
 * @param names - 插件 inject 里 Pneuma 不认识的名字
 * @returns 中文说明（一行一条，分号隔开）
 * @example
 * // "sessionProjections（Pneuma 没有事件投影系统）；sessions（dsh 是多会话注册表，Pneuma 只有当前会话）"
 */
export function describeForeignServices(names: readonly string[]): string {
  return names
    .map((name) => {
      const verdict = DSH_SERVICE_MAP[name]
      if (verdict === undefined) return `${name}（Pneuma 不认识这个服务名）`
      if (verdict.tier === 'same') return `${name}（同名同义，但这次挂载没走到它，可能是加载顺序问题）`
      if (verdict.tier === 'adapted') return `${name}（dsh 侧有对应：${verdict.pneuma}。${verdict.note}）`
      return `${name}（${verdict.note}）`
    })
    .join('；')
}
