/**
 * 移植自 dsh-superagent/src/app/links.ts（68 行，逐字）。
 * 改动只有 import 路径（目录已按上游镜像，与上游只差 NodeNext 的 `.js` 扩展名）：
 *   `../core/index.ts` → `../core/index.js`；`../infra/commands.ts` → `../infra/commands.js`
 *   `../sources/feishu-read.ts` → `../sources/feishu-read.js`；`../sources/feishu.ts` → `../sources/feishu.js`
 *   `../sources/registry.ts` → `../sources/registry.js`；`../executor/dsh.ts` → `../executor/dsh.js`
 *   `./cards.ts` → `./cards.js`；`./store.ts` → `./store.js`；`./cache.ts` → `./cache.js`
 *
 * 来源消息链接解析（带缓存，失败退回可读资源路径）与主会话候选卡片组装。
 *
 * @module dsc/packages/superagent/app/links
 */
/** Source message link resolution and candidate card assembly for the main Session. */
import type { Candidate, Ticket, Trigger } from '../core/index.js'
import type { Commands } from '../infra/commands.js'
import { readFeishuLink } from '../sources/feishu-read.js'
import { feishuRef, feishuSettings } from '../sources/feishu.js'
import type { SourceRegistry } from '../sources/registry.js'
import { triggerMessage } from '../executor/dsh.js'
import { relatedTickets, ticketCard, triggerCard } from './cards.js'
import type { Store } from './store.js'
import type { TextCache } from './cache.js'

export interface LinkHost {
  readonly store: Pick<Store, 'settings' | 'triggers' | 'threads' | 'tickets'>
  readonly links: TextCache
  readonly commands: Commands
  readonly sources: SourceRegistry
  readonly lifetime: AbortSignal
}

/** Resolves and caches a trigger's external message URL, falling back to a readable resource path when lookup fails. */
export async function sourceLink(host: LinkHost, trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }> {
  if (trigger.url) return { source_url: trigger.url }
  const ref = feishuRef(trigger)
  if (!ref) return {}
  const cacheKey = `${ref.chatId}:${ref.messageId}`
  const cached = host.links.get(cacheKey)
  if (cached) return { source_url: cached }
  let url: string
  try {
    const timeout = AbortSignal.timeout(feishuSettings(host.sources).linkTimeoutMs)
    url = await readFeishuLink(host.commands.withSignal(AbortSignal.any([signal ?? host.lifetime, timeout])), ref)
  } catch {
    host.lifetime.throwIfAborted()
    signal?.throwIfAborted()
    // Optional link enrichment may fail independently of the retained source message.
    return { source_url_read: `feishu/${trigger.id}/message` }
  }
  host.links.set(cacheKey, url)
  return { source_url: url }
}

export function repliedTo({ store, sources }: { store: Pick<Store, 'triggers'>; sources: Pick<SourceRegistry, 'repliesTo'> },
  trigger: Trigger): Trigger | undefined {
  const parent = sources.repliesTo(trigger)
  return parent === undefined ? undefined : store.triggers.get(parent)
}
/** Finds tickets subscribed to threads referenced in `trigger.text` (such as `#12` or URLs) that are not already in `known`. */
function referencedTickets(host: LinkHost, trigger: Trigger, known: readonly Ticket[]): Ticket[] {
  const threads = (trigger.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap(reference => host.sources.find(reference).threads)
  const ids = new Set(threads.flatMap(thread => host.store.threads.get(thread)?.subscriptions ?? []))
  for (const ticket of known) ids.delete(ticket.id)
  return [...ids].flatMap(id => host.store.tickets.get(id) ?? []).slice(0, 4)
}
/** Builds the main Session's candidate card with routing metadata, handback history, and related or referenced tickets. */
export async function candidateCard(host: LinkHost, candidate: Candidate) {
  const primary = candidate.triggers.at(-1)!
  const settings = host.store.settings()
  const delivered = host.store.triggers.disposition(primary.id)?.fanout ?? []
  const referenced = referencedTickets(host, primary, candidate.tickets)
  // Triggers that a worker Session handed back as outside its ticket's scope, with the worker's reason.
  const handedBack = candidate.triggers.flatMap(trigger => (host.store.triggers.disposition(trigger.id)?.handbacks ?? [])
    .map(item => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })))
  // Format the primary trigger like a worker input (including the message it replies to) and summarize earlier batch triggers as cards.
  const others = candidate.triggers.filter(trigger => trigger.id !== primary.id)
  return { ...triggerMessage(primary, await sourceLink(host, primary), undefined, repliedTo(host, primary)), strength: candidate.strength,
    mode: settings.eval.mode, ...others.length ? { batch: others.map(trigger => triggerCard(trigger)) } : {},
    ...handedBack.length ? { handed_back: handedBack } : {}, ...relatedTickets(candidate.tickets),
    ...(delivered.length ? { delivered_to: delivered } : {}), ...(referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {}),
    next_action: candidate.strength === 'explicit' ? 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.'
      : 'Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide.' }
}
