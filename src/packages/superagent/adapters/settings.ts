/**
 * P0 的默认设置：只有 `manual` 一个来源，名单里一个占位发送者 `operator`。
 *
 * 为什么用 `SettingsSchema.parse(...)` 而不是手写裸对象：`Settings` 有五个必填块
 * （`paused` / `sources` / `policy` / `eval` / `executor`），少一块 zod 就拒；每块内部还有
 * 一串默认值（规则表、取单模式、并发数、超时秒数）。手写裸对象等于把这些默认值抄一遍，
 * 抄漏一个字段的症状不是编译错误，而是启动时 `zod` 报「required」——那时候已经装到
 * `lib/` 里了。parse 让 schema 自己补齐，这里只写「P0 与默认值不同的地方」。
 *
 * `eval.mode` 取 `observe`：核心的接单模式只有 `off` / `observe` / `auto` 三档
 * （`core/model.ts:103`），没有 `explicit` 这一档。P0 说的「explicit」是**准入强度**
 * （`Trigger.addressed` + 名单命中，见 `core/policy.ts:209`），不是可配置的模式；
 * 因此这里不需要为它加开关。`observe` 的语义是「推断出来的候选只记不做」——P0 本来
 * 也不产生推断候选，但万一将来误开，它不会自己建工单。
 *
 * @module dsc/packages/superagent/adapters/settings
 */
import { SettingsSchema, type Settings } from '../core/policy.js'

/**
 * 占位发送者的 id。
 *
 * 必须与 `manual.ts` 里 `ManualRequest.actor` 的缺省值逐字一致：准入闸拿
 * `Settings.policy.sources[source].allowed` 的每一项与 `Trigger.actor.id` 做
 * 大小写不敏感比较（`core/policy.ts:132`）。两边差一个字母，用户的第一条消息就会
 * 以 `not_a_member` 被拒，症状是「命令没报错，但工单没出来」。
 */
export const DEFAULT_ACTOR = 'operator'

/** 手动来源的名字；同时是 `policy.sources` 的键与 `Trigger.source` 的值。 */
export const MANUAL_SOURCE = 'manual'

/** GitHub 来源的名字；同样同时用作 `sources` / `policy.sources` 的键与 `Trigger.source`（上游 `kind.ts:7` 同名）。 */
export const GITHUB_SOURCE = 'github'

/**
 * 飞书来源的名字。
 *
 * 必须与 `adapters/feishu/trigger.ts` 里 `Trigger.source` 的取值逐字一致，也必须与
 * `policy.sources` 的键一致——三处差一个字母，症状是「消息收得到、一条工单也建不出来」，
 * 而准入闸只会回一句 `not_a_member`，看不出是键写错了。
 */
export const FEISHU_SOURCE = 'feishu'

/**
 * 一个接进来的 GitHub 仓库。
 *
 * 为什么只有这三样：`repository` 决定轮询哪个仓库，`login` 是机器人自己的登录名（用来丢掉
 * 它自己发的评论，否则它会把「工单已开始」当成一条新需求再派一遍），`allowed` 是能被接单的
 * 人的 GitHub 登录名。令牌不在这里——它按名字从环境变量取，见 `index.ts` 的设置分区。
 */
export interface GithubAccount {
  /** `owner/name`。 */
  repository: string
  /** 机器人自己的登录名。 */
  login: string
  /** 允许派活的人（大小写不敏感，比对逻辑在 `core/policy.ts:132`）。 */
  allowed: readonly string[]
}

/**
 * 接进来的飞书来源。
 *
 * 只有一样：允许派活的飞书用户（`open_id`，`ou_` 开头）。
 *
 * 为什么必须显式给名单、不能「群里谁 @ 都算」：核心的准入闸只认
 * `policy.sources[source].allowed` 里的精确 id（`core/policy.ts:132` 的 `allowedSender`），
 * 没有通配。不登记这个来源，每条飞书人类消息都会以 `not_a_member` 被拒——这正是修之前
 * 的状态：消息收得到，工单一张也建不出来。
 */
export interface FeishuAccount {
  /** 允许派活的飞书 `open_id`。 */
  allowed: readonly string[]
}

/**
 * 造一份默认设置。
 *
 * 每次调用返回**新对象**，不共享可变单例：设置将来要能按分区保存（`save` 改一块），
 * 共享单例会让一次保存悄悄改掉所有读者的视图；测试里两个 runtime 共用一份设置时，
 * 也会互相污染。
 *
 * @param github - 配了就把 GitHub 来源登记进来。**不配就一个字节都不加**：没配仓库却把来源
 *   记成「开着」，设置页会显示一个永远不工作的来源，准入闸也会多出一条空名单。
 * @param feishu - 配了就把飞书来源登记进来。判据是「名单里至少一个人」：空名单等于
 *   「谁也不许派活」，登记它只会让准入闸对每条消息都回 `not_a_member`，不如不登记。
 * @param evalMode - 接单模式（`off` / `observe` / `auto`）。缺省 `observe`：推断候选只记不做，
 *   与 P0 一样保守。**候选收件箱（backlog G1）要有内容必须 `auto`**——推断强度的 accept
 *   只在 auto 下才会落进收件箱等人点头（`core/policy.ts:67`），observe 下降级成
 *   `would_accept` 记录了事。
 */
export function defaultSettings(github?: GithubAccount, feishu?: FeishuAccount, evalMode?: Settings['eval']['mode']): Settings {
  const account = normalizeGithubAccount(github)
  const chat = normalizeFeishuAccount(feishu)
  return SettingsSchema.parse({
    paused: false,
    // 来源实例表：登记「这个来源是开着的」。它不参与准入判定（准入只看 policy.sources），
    // 但设置页与将来的来源管理要按它列。
    sources: {
      [MANUAL_SOURCE]: { enabled: true },
      ...(account === undefined ? {} : { [GITHUB_SOURCE]: { enabled: true } }),
      ...(chat === undefined ? {} : { [FEISHU_SOURCE]: { enabled: true } }),
    },
    policy: {
      // 名单只有一个人：终端前敲命令的这个人。
      sources: {
        [MANUAL_SOURCE]: { allowed: [{ id: DEFAULT_ACTOR }] },
        // GitHub 的名单是「谁的 @ 能被接单」。空名单不等于「谁都可以」——准入闸对没命中名单的
        // 人会走准入表，那一格默认给 ignore，症状正好是「轮询在跑、就是没有工单」。
        ...(account === undefined ? {} : { [GITHUB_SOURCE]: { allowed: account.allowed.map((id) => ({ id })) } }),
        // 飞书同理：不登记这个来源，飞书消息会被判 `not_a_member`（不是「没连上」）。
        ...(chat === undefined ? {} : { [FEISHU_SOURCE]: { allowed: chat.allowed.map((id) => ({ id })) } }),
      },
    },
    eval: { mode: evalMode ?? 'observe' },
  })
}

/**
 * 把外面的飞书配置收成一个能直接进设置的值；名单空就是「没配」。
 *
 * 为什么不给默认值：默认放行任何人是授权边界上的大洞，默认拒绝至少是安全的失败方式。
 */
export function normalizeFeishuAccount(input: FeishuAccount | undefined): FeishuAccount | undefined {
  if (input === undefined) return undefined
  const allowed = input.allowed.map((id) => id.trim()).filter((id) => id !== '')
  if (allowed.length === 0) return undefined
  return { allowed }
}

/**
 * 把外面的 GitHub 配置收成一个能直接进设置的值；缺项一律当「没配」。
 *
 * 三条必须同时成立才算配好了：仓库写成 `owner/name`、登录名非空、名单至少一个人。
 * 少一条就当没配（宁可不接这个来源，也不让它以半残状态进准入闸）。
 */
export function normalizeGithubAccount(input: GithubAccount | undefined): GithubAccount | undefined {
  if (input === undefined) return undefined
  const repository = input.repository.trim()
  const login = input.login.trim()
  const allowed = input.allowed.map((id) => id.trim()).filter((id) => id !== '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || login === '' || allowed.length === 0) return undefined
  return { repository, login, allowed }
}
