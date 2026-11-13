/**
 * 来源的接收范围：手动来源全收，GitHub 只收配好的那个仓库。
 *
 * 为什么要有「范围」这一层而不是让每个来源自己判断：准入闸拿它决定「这条消息算不算这个
 * 来源收到的」（`core/policy.ts:186-187` 的 `listened` / `observed`），并把结果记进工单的
 * `MandateBasis.scope`——将来改设置时 `revalidate` 会重读这一位。也就是说，范围判错不会
 * 报错，只会让某类事件从此不再被观察，或者让一张单在授权变更后仍以为自己有授权。
 *
 * 为什么 GitHub 还要比一次仓库：同一个机器人登录名可以出现在任何仓库里。只按来源名放行，
 * 等于「任何仓库里 @ 它一下都能给本机派活」——那是把授权面从「我配的仓库」放大到「全
 * GitHub」。比对用的是 `Trigger.meta.repository`（形状照上游 `github.ts:32-37` 的 `scopeOf`）；
 * 取不到这个字段时按「在范围内」处理，因为本适配器只轮询一个仓库，轮询结果本身就带仓库。
 *
 * @module dsc/packages/superagent/adapters/scope
 */
import type { ScopeResult, SourceScope } from '../core/ports.js'
import { manualScope } from './manual.js'
import { GITHUB_SOURCE } from './settings.js'

/** 大小写不敏感地比两个仓库名（GitHub 的 `Owner/Name` 本身不区分大小写）。 */
function sameRepository(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/**
 * 造一个组合范围。
 *
 * @param github - 现读 GitHub 配置（getter）。用 getter 而不是值：设置页改了仓库名之后，
 *   范围判定要跟着变，否则「换了个仓库，旧那个仓库的消息还算在范围内」。
 *   不传 = 没接 GitHub，这个来源的一切消息都判「没连上」。
 */
export function superagentScope(github?: () => { repository: string } | undefined): SourceScope {
  return {
    scope({ source, meta }): ScopeResult {
      if (source === GITHUB_SOURCE) {
        const account = github?.()
        if (account === undefined) return { listened: false, reason: 'source_not_connected' }
        const repository = typeof meta['repository'] === 'string' ? meta['repository'] : ''
        if (repository !== '' && !sameRepository(repository, account.repository)) return { listened: false, reason: 'source_not_connected' }
        // GitHub 上由人发出的评论都算「对着这个仓库说的」，`observed` 记这一位。
        return { listened: true, observed: true }
      }
      return manualScope.scope({ source, meta })
    },
  }
}
