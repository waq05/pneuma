/**
 * 守卫侧「按入参取会话」的唯一口径：沙箱、协作模式、审批三处反查都走这里。
 *
 * 为什么单开一个模块：这三处原先各写一份 `sessionById → sessionFor → ctx.session.current()`
 * （`sandbox/index.ts:175-184`、`mode/index.ts:99-103`、`approval/index.ts:719-725`）。
 * 最后一跳是「用户正看着的那条会话」，而归属会话随时可能不在名册里：
 *   - 后台 / 定时会话的回合结束就被 `onIdle` 收摊（`agent/index.ts:179-184`）；
 *   - 用户切过 3 条以上会话，空闲会话被挤出名单（`agent/index.ts:218-222`，IDLE_KEEP=3）；
 *   - 队友的临时会话本来就不登记进名册（`subagent` 直接 `Session.create/load`）。
 * 落空后回落当前查看的会话 = 拿**用户眼前那条**的沙箱档、权限档、协作模式去判这次调用；
 * 那条正好是完全访问档时，队友的写就不再受围栏（P0-8 原症状复发）。
 *
 * 判定顺序（先便宜后贵）：
 *   1. `sessionId` 命中常驻名册：零读盘，最常走的路；
 *   2. `sessionPath` 命中常驻名册：跨重启恢复的会话按路径也能认出来；
 *   3. `sessionPath` 指向的 jsonl 按路径只读重放：会话已收摊，但日志还在，权限档还在里面；
 *   4. 都不成立返回 null——**由调用方按拒 / 最严档处理**，这里绝不回落当前查看的会话。
 *
 * 为什么不缓存第 3 步读出来的会话：缓存会把「那一刻的权限档」钉死，读不到文件的
 * 情况也会被一次成功的旧结果盖住；宁可多读一次盘，也不让一个会漂的副本参与安全判定。
 *
 * @module dsc/core/guard-session
 */
import { Session } from './session.js'

/** 一次调用自报的会话身份（`ToolGuardInput`、`ApprovalRequest` 都有这两项）。 */
export interface GuardSessionScope {
  /** 发起调用的会话 id（meta.id）。 */
  sessionId?: string
  /** 发起调用的会话 jsonl 路径。 */
  sessionPath?: string
}

/** 解析会话只需要上下文这两样（插件的 ctx 结构上满足它）。 */
export interface GuardSessionContext {
  /** 取插件服务（只用到 `agent` 的名册）。 */
  get(service: string): unknown
  session: { current(): Session }
}

/** 常驻名册这一角（`AgentService` 的两个查询）。 */
interface AgentRoster {
  sessionById(sessionId: string): Session | undefined
  sessionFor(filePath: string): Session | undefined
}

/**
 * 把一次调用的会话身份解析成一条会话；解析不到返回 null。
 *
 * 调用方拿到 null 时**不许**再回落 `ctx.session.current()`：沙箱按拒（判不清归属就不动手）、
 * 审批按拒并说明会话已结束、协作模式按最严档（只读）。
 *
 * @param ctx - 插件上下文（只读它的 `agent` 名册）。
 * @param scope - 这次调用自报的 `sessionId` / `sessionPath`。
 * @returns 归属会话；名册与日志都找不到时 null。
 */
export function resolveGuardSession(ctx: GuardSessionContext, scope: GuardSessionScope): Session | null {
  const agent = ctx.get('agent') as AgentRoster | undefined
  const sessionId = scope.sessionId
  if (sessionId !== undefined && sessionId !== '') {
    const byId = agent?.sessionById(sessionId)
    if (byId !== undefined) return byId
  }
  const sessionPath = scope.sessionPath
  if (sessionPath === undefined || sessionPath === '') return null
  const byPath = agent?.sessionFor(sessionPath)
  if (byPath !== undefined) return byPath
  try {
    // keepPath=true：之后若有人往这条会话写状态，写回读进来的这个路径。
    // lease=false：只读重放——解析会话这一步不抢写租约、不修复中断回合、不投递收件箱，
    // 没有副作用。文件不存在时 `load` 直接抛错（它从不建空文件），按解析不到处理。
    return Session.load(sessionPath, true, { lease: false })
  } catch {
    return null
  }
}
