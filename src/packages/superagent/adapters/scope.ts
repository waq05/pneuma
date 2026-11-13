/**
 * 来源的接收范围：手动来源全收，GitHub 在「配了仓库」时全收。
 *
 * 为什么要有「范围」这一层而不是让每个来源自己判断：准入闸拿它决定「这条消息算不算这个
 * 来源收到的」（`core/policy.ts:186-187` 的 `listened` / `observed`），并把结果记进工单的
 * `MandateBasis.scope`——将来改设置时 `revalidate` 会重读这一位。也就是说，范围判错不会
 * 报错，只会让某类事件从此不再被观察，或者让一张单在授权变更后仍以为自己有授权。
 *
 * **GitHub 这边不比仓库名**。`Trigger.meta` 与上游逐字段一致，里面没有仓库这个键
 * （`adapters/github/trigger.ts` 照 `sources/github.ts:32-37` 的 `scopeOf`）；早先这里读
 * `meta.repository` 做比对，读到的永远是空串，那条「仓库不符就拒」其实是一道空闸——空的
 * 防线比没有防线更糟，它让人以为有保护。
 *
 * 仓库边界本来就不该落在这一层：轮询器只轮询一个仓库
 * （`adapters/github/source.ts` 的 `createGithubSource({ repository })`），而
 * `adapters/github/api.ts` 把所有请求路径限制在 `repos/<repository>/` 下、翻页只认
 * `api.github.com`。别的仓库的消息进不了这条管线，也就轮不到范围判定。
 *
 * @module dsc/packages/superagent/adapters/scope
 */
import type { ScopeResult, SourceScope } from '../core/ports.js'
import { manualScope } from './manual.js'
import { FEISHU_SOURCE, GITHUB_SOURCE } from './settings.js'

/**
 * 造一个组合范围。
 *
 * @param github - 现读 GitHub 配置（getter）。用 getter 而不是值：设置页改了仓库名之后，
 *   范围判定要跟着变。返回 `undefined` = 没接 GitHub，这个来源的一切消息都判「没连上」。
 * @param feishu - 现读飞书配置（getter）。判据是「名单里至少一个人」——名单空等于没接这个来源，
 *   与 `defaultSettings` 的登记条件同一个判据，两处不能分叉。
 */
export function superagentScope(
  github?: () => { repository: string } | undefined,
  feishu?: () => { allowed: readonly string[] } | undefined,
): SourceScope {
  return {
    scope({ source, meta }): ScopeResult {
      if (source === GITHUB_SOURCE) {
        if (github?.() === undefined) return { listened: false, reason: 'source_not_connected' }
        // 仓库里由人发出的评论都算「对着这个仓库说的」，`observed` 记这一位。
        return { listened: true, observed: true }
      }
      if (source === FEISHU_SOURCE) {
        const chat = feishu?.()
        if (chat === undefined || chat.allowed.length === 0) return { listened: false, reason: 'source_not_connected' }
        // 与 GitHub 同一条理由：轮询器只补收设置里点名的群，别的群的消息进不了这条管线，
        // 所以「能收到的都算这个来源看到的」。群清单本身不在这里比——`Trigger.meta` 里没有
        // 可比的键，读一个不存在的键做闸只会得到一道永远放行的空防线（GitHub 那边踩过）。
        return { listened: true, observed: true }
      }
      return manualScope.scope({ source, meta })
    },
  }
}
