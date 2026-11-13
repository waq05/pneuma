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

/**
 * 造一份默认设置。
 *
 * 每次调用返回**新对象**，不共享可变单例：设置将来要能按分区保存（`save` 改一块），
 * 共享单例会让一次保存悄悄改掉所有读者的视图；测试里两个 runtime 共用一份设置时，
 * 也会互相污染。
 */
export function defaultSettings(): Settings {
  return SettingsSchema.parse({
    paused: false,
    // 来源实例表：P0 只登记 manual，表示「这个来源是开着的」。它不参与准入判定
    // （准入只看 policy.sources），但设置页与将来的来源管理要按它列。
    sources: { [MANUAL_SOURCE]: { enabled: true } },
    policy: {
      // 名单只有一个人：终端前敲命令的这个人。P1 接 GitHub 时按登录名往里加。
      sources: { [MANUAL_SOURCE]: { allowed: [{ id: DEFAULT_ACTOR }] } },
    },
    eval: { mode: 'observe' },
  })
}
