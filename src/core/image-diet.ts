/**
 * 每轮图片按龄/按预算卸载（WS2）。
 *
 * 为什么要有这一层：图像一旦进了请求体，就是每一轮都要重发的一坨 base64——一张
 * JPEG 截图 100~300KB，用户贴的照片更大。长会话里老图既烧 token 又早已过期
 * （界面被后面的操作改掉了、贴的图上下文已经翻篇）。现在 dsc 只有两处图片处理：
 * `drop-images`（模型根本不声明收图时全剥，是**能力门**）与电脑控制自己的
 * `prune-stale-screenshots`（只管自己的截图、只留最新一张）。用户贴的图、工具结果里的图
 * 都没有人管。这一层管的就是「留着，但只留该留的那几张」——与能力门职责分开，
 * 所以它跑在 `env-facts`（600）与 `drop-images`（900）**之前**（投影 order 550）：先按真实用户回合卸图，再让 env-facts 往末尾补环境快照，`keepRounds` 的口径才不会被那条合成快照白占一格。
 *
 * 三条铁律：
 *   1. 只动发给模型的那一份副本，**不删消息、不改 role 序列**——删掉一条工具结果会留下
 *      配不上对的 tool_call（端点直接 HTTP 400 拒掉整轮请求）；日志里的原文一个字不动，
 *      「模型可见 ⟺ 日志可重建」照样成立（日志原文 + 这条命名投影就能复算）。
 *   2. 卸载只是把 `image_url` 部件**原地**换成一句占位文本，前后文本部件的顺序与内容都不动。
 *   3. **攒够一批再卸**（P2a，2026-11-18）：每卸一张图，缓存从那张图起整段失效——逐张
 *      越线逐次断点。改成「本会话第一次真正卸图之前，先把候选攒着；新增候选的 url 字符数
 *      合计 ≥ {@link IMAGE_DIET_BATCH_SAVED_CHARS} 才一次卸一批」。已卸过的图按 url 的
 *      sha256 前 16 位记进粘性集合，之后每轮继续卸（前缀保持稳定，只断这一次）。
 *
 * @module dsc/core/image-diet
 */
import { createHash } from 'node:crypto'
import type { ChatContentPart, ChatMessage } from './llm.js'
import { clampIntIn as clamp } from './clamp.js'

/** 卸载后留在原位的那句话：模型看得见「这里本来有图」，只是它不再随请求发送。 */
export const IMAGE_DIET_PLACEHOLDER = '（图片已卸载，原文里这里是一张图）'

/** 卸载口径：三类预算，都可由设置分区覆盖。 */
export interface ImageDietOptions {
  /** 最近还在用的用户消息里最多留几张图（更早的用户图卸载）。 */
  userImageBudget: number
  /** 最近还在用的工具结果里最多留几张图（旧的卸载）。 */
  toolImageBudget: number
  /** 保留最近几个用户回合；比这更早的历史里的图全部卸载（不管来源）。 */
  keepRounds: number
}

/** 缺省口径：用户图 4 张、工具图 2 张、保留最近 2 个用户回合。 */
export const DEFAULT_IMAGE_DIET: ImageDietOptions = { userImageBudget: 4, toolImageBudget: 2, keepRounds: 2 }

/**
 * 批量卸载阈值（字符）：新增候选的 url 字符数合计到这么多，才把这一批图一起卸掉。
 *
 * 为什么是 16384：卸一张 = 缓存从那张起整段失效一次。图片在历史前部时一次断点能丢掉
 * 十几 K token 的前缀（见 docs/research/cache-vs-dsh.md §3）；攒批期间多发的图是这段
 * 时间的唯一成本。阈值取「一次断点的量级」——低于它不值当断，高于它断一次回本。
 *
 * 单张图自己的 url 字符数 ≥ 阈值时，这一批立即成立：真实截图 / 照片的 data URL 通常
 * 一张就超过它，所以「一张大图」不会被压着不卸。
 */
export const IMAGE_DIET_BATCH_SAVED_CHARS = 16_384

/** 设置分区里三个数字控件的取值区间（超出就夹回来）。 */
export const IMAGE_DIET_RANGES = {
  userImageBudget: { min: 0, max: 20 },
  toolImageBudget: { min: 0, max: 20 },
  keepRounds: { min: 0, max: 50 },
} as const

/** 完整的卸载配置：三个预算 + 总开关。 */
export interface ImageDietConfig extends ImageDietOptions {
  enabled: boolean
}

/** 没配过时的完整缺省（`enabled` 默认开：图片本来就该按龄卸载，不用用户先来点一下）。 */
export const DEFAULT_IMAGE_DIET_CONFIG: ImageDietConfig = { enabled: true, ...DEFAULT_IMAGE_DIET }

/** 一张待卸载的图：key 用于跨请求认「同一张图」，savedChars 是它占的 url 字符数。 */
export interface ImageDietCandidate {
  /** `image_url.url` 的 sha256 前 16 位：同 url 视为同一张图。 */
  key: string
  /** 卸掉它省下的字符数（就是 url 的长度）。 */
  savedChars: number
  /** 候选所在的部件位置；不带跨请求记忆的一次性卸载按它精确落点（同 url 出现两次也能分开）。 */
  messageIndex: number
  partIndex: number
}

/** 一次批量卸载的结果。 */
export interface ImageDietBatch {
  /** 投影后的消息（没有本批与已卸条目时原样返回同一个引用）。 */
  messages: ChatMessage[]
  /** 新的粘性集合（只增不减）；没到阈值时就是传入的那个引用。 */
  kept: ReadonlySet<string>
  /** 本次新并入集合的 key（没到阈值时为空）。 */
  added: readonly string[]
}

/**
 * 一张图的稳定 key：url 的 sha256 前 16 位。
 *
 * 为什么用 hash 不用 url 本身：url 是几百 KB 的 base64，拿它当 Map 的 key 等于每轮
 * 都把这些字再存一遍；16 位十六进制够区分（同一会话里总图数远小于碰撞量级）。
 */
export function imageDietKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16)
}

/**
 * 从插件配置（`resolvePluginConfig('image-diet')` 的结果）读卸载口径，并把区间外的值夹回来。
 * 值非法就回落缺省，读不出来绝不该让一轮请求整个失败。
 */
export function readImageDietConfig(raw: unknown): ImageDietConfig {
  const source: Record<string, unknown> =
    raw === null || typeof raw !== 'object' || Array.isArray(raw) ? {} : (raw as Record<string, unknown>)
  return {
    // 只认字面 false 关：设置分区写的就是布尔；缺省（undefined/没配过）按「开」算。
    enabled: source.enabled === undefined ? DEFAULT_IMAGE_DIET_CONFIG.enabled : source.enabled !== false,
    userImageBudget: clamp(source.userImageBudget, IMAGE_DIET_RANGES.userImageBudget, DEFAULT_IMAGE_DIET.userImageBudget),
    toolImageBudget: clamp(source.toolImageBudget, IMAGE_DIET_RANGES.toolImageBudget, DEFAULT_IMAGE_DIET.toolImageBudget),
    keepRounds: clamp(source.keepRounds, IMAGE_DIET_RANGES.keepRounds, DEFAULT_IMAGE_DIET.keepRounds),
  }
}

/** 数一份消息里还剩多少张图（探针与诊断用）。 */
export function countImageParts(messages: readonly ChatMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (message.content === null || typeof message.content === 'string') continue
    for (const part of message.content) if (part.type === 'image_url') count += 1
  }
  return count
}

/**
 * 算本轮该卸哪些图（按龄/按预算，纯函数，不读任何外部状态）。
 *
 * 判定优先级（从硬到软）：
 *   1. 老回合：历史里比最近 `keepRounds` 个用户消息更早的部分，图**全卸载**（不管来源）；
 *   2. 工具结果：最近 `toolImageBudget` 张之外的卸载（保住「当前正在看的那张截图」）；
 *   3. 用户消息：最近 `userImageBudget` 张之外的卸载。
 *
 * 只认 user / tool 两种角色的图；assistant 正常历史里不带图（正文落库时只存文本），
 * 出现了也不属于这条契约的范围，原样留着。
 *
 * @param messages - 组装好的请求消息（fold-system 之后的形状）。
 * @param options - 卸载口径；不传用缺省。
 */
export function collectImageDietCandidates(
  messages: readonly ChatMessage[],
  options: ImageDietOptions = DEFAULT_IMAGE_DIET,
): ImageDietCandidate[] {
  const { userImageBudget, toolImageBudget } = options
  const keepRounds = Math.max(0, Math.round(options.keepRounds))

  // 老回合的边界：从末尾数 keepRounds 个用户消息，那一轮之前（下标更小）的整段算历史。
  // keepRounds 为 0 时没有「最近回合」，全部算历史。
  // 注意：env-facts（order 600）在请求末尾追加的那条环境快照也是 user 消息，会占掉一格，
  // 所以同一条链上的 keepRounds 口径比「真人回合数」略保守——宁可多卸一张，不留过期图。
  const userIndexes: number[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]!.role === 'user') userIndexes.push(index)
  }
  const cut =
    keepRounds <= 0
      ? messages.length
      : userIndexes.length <= keepRounds
        ? 0
        : userIndexes[userIndexes.length - keepRounds]!

  // 预算只作用在「最近回合」那一段：从末尾往前数，各角色留够最近的张数，多出来的是要卸载的。
  const dropBudget = new Map<number, boolean[]>()
  let userLeft = Math.max(0, userImageBudget)
  let toolLeft = Math.max(0, toolImageBudget)
  for (let index = messages.length - 1; index >= cut; index -= 1) {
    const message = messages[index]!
    const parts = message.content
    if (parts === null || typeof parts === 'string') continue
    const flags = new Array<boolean>(parts.length).fill(false)
    let dropped = false
    // 同一角色内从后往前：后面（更新）的先占额度，先占满的就保住。
    for (let part = parts.length - 1; part >= 0; part -= 1) {
      if (parts[part]!.type !== 'image_url') continue
      if (message.role === 'tool' && toolLeft > 0) {
        toolLeft -= 1
        continue
      }
      if (message.role === 'user' && userLeft > 0) {
        userLeft -= 1
        continue
      }
      if (message.role !== 'tool' && message.role !== 'user') continue
      flags[part] = true
      dropped = true
    }
    if (dropped) dropBudget.set(index, flags)
  }

  // 按消息 / 部件顺序产出候选：同一张图（同 url）可能出现多次，各自算一份字符数，
  // 批量判断按 key 去重（见 pruneImagesBatch）。
  const candidates: ImageDietCandidate[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const parts = messages[index]!.content
    if (parts === null || typeof parts === 'string') continue
    const dropAll = index < cut
    const flags = dropBudget.get(index)
    if (!dropAll && flags === undefined) continue
    for (let part = 0; part < parts.length; part += 1) {
      const piece = parts[part]!
      if (piece.type !== 'image_url') continue
      if (!dropAll && flags?.[part] !== true) continue
      const url = piece.image_url.url
      candidates.push({ key: imageDietKey(url), savedChars: url.length, messageIndex: index, partIndex: part })
    }
  }
  return candidates
}

/** 把指定位置的图片换成占位（一次性卸载用；同 url 出现两次也只动点名的那个位置）。 */
function applyImageDietAt(messages: readonly ChatMessage[], positions: ReadonlySet<string>): ChatMessage[] {
  if (positions.size === 0) return messages as ChatMessage[]
  let changed = false
  const out = messages.map((message, messageIndex) => {
    const parts = message.content
    if (parts === null || typeof parts === 'string') return message
    if (!parts.some((part) => part.type === 'image_url')) return message
    let replaced = false
    const nextParts: ChatContentPart[] = parts.map((part, partIndex) => {
      if (part.type !== 'image_url') return part
      if (!positions.has(`${String(messageIndex)}:${String(partIndex)}`)) return part
      replaced = true
      return { type: 'text', text: IMAGE_DIET_PLACEHOLDER }
    })
    if (!replaced) return message
    changed = true
    return { ...message, content: nextParts }
  })
  return changed ? out : (messages as ChatMessage[])
}

/** 把集合里这些 key 对应的图片换成占位；一个都没命中就原样返回同一个数组。 */
function applyImageDiet(messages: readonly ChatMessage[], dropped: ReadonlySet<string>): ChatMessage[] {
  if (dropped.size === 0) return messages as ChatMessage[]
  let changed = false
  const out = messages.map((message) => {
    const parts = message.content
    if (parts === null || typeof parts === 'string') return message
    if (!parts.some((part) => part.type === 'image_url')) return message
    let replaced = false
    const nextParts: ChatContentPart[] = parts.map((part) => {
      if (part.type !== 'image_url') return part
      if (!dropped.has(imageDietKey(part.image_url.url))) return part
      replaced = true
      return { type: 'text', text: IMAGE_DIET_PLACEHOLDER }
    })
    if (!replaced) return message
    changed = true
    return { ...message, content: nextParts }
  })
  return changed ? out : (messages as ChatMessage[])
}

/**
 * 批量落点：先算候选，只有「新增候选的 url 字符数合计 ≥ 阈值」才把它们并进粘性集合并卸掉；
 * 已卸过的图（`kept` 里的 key）每轮继续卸。
 *
 * 同一份历史、同一份集合调两次，输出逐字节相同（loop.ts 的 invariant 会把投影链跑两遍）：
 * 第一次并集之后，第二次的新增候选为空，阈值判断落到「不改」；已卸条目照旧卸。
 *
 * @param messages 组装好的请求消息
 * @param options 卸载口径；不传用缺省
 * @param kept 该会话的粘性已卸集合（只增不减）
 * @param minSaved 批量阈值（url 字符数）；缺省用 {@link IMAGE_DIET_BATCH_SAVED_CHARS}
 */
export function pruneImagesBatch(
  messages: readonly ChatMessage[],
  options: ImageDietOptions = DEFAULT_IMAGE_DIET,
  kept: ReadonlySet<string> = new Set(),
  minSaved: number = IMAGE_DIET_BATCH_SAVED_CHARS,
): ImageDietBatch {
  const candidates = collectImageDietCandidates(messages, options)
  const added: string[] = []
  const seen = new Set<string>()
  let saved = 0
  for (const candidate of candidates) {
    if (kept.has(candidate.key) || seen.has(candidate.key)) continue
    seen.add(candidate.key)
    added.push(candidate.key)
    saved += candidate.savedChars
  }
  if (added.length === 0 || saved < minSaved) {
    // 没到阈值：本批一张都不卸，但已卸的图必须继续卸（前缀稳定）。
    return { messages: applyImageDiet(messages, kept), kept, added: [] }
  }
  const next = new Set(kept)
  for (const key of added) next.add(key)
  return { messages: applyImageDiet(messages, next), kept: next, added }
}

/**
 * 按龄/按预算卸载图片，返回新数组（原数组与原消息对象都不动）。
 *
 * 幂等：卸载后的位置只剩占位文本，再跑一遍找不到 image_url，输出逐字节相同。
 * 批量落点请用 {@link pruneImagesBatch}；这个入口留给不需要跨请求记忆的调用方与单测。
 * 给了 `kept` 就只卸集合里的图（候选仍未到阈值时保持原样），这样同一个函数既能单独用，
 * 也能给批量流程当「应用」那一半。
 *
 * @param messages - 组装好的请求消息（fold-system 之后的形状）。
 * @param options - 卸载口径；不传用缺省。
 * @param kept - 粘性已卸集合；省略时等价于「本轮候选全部卸」。
 */
export function pruneImages(
  messages: readonly ChatMessage[],
  options: ImageDietOptions = DEFAULT_IMAGE_DIET,
  kept?: ReadonlySet<string>,
): ChatMessage[] {
  if (kept !== undefined) return applyImageDiet(messages, kept)
  const candidates = collectImageDietCandidates(messages, options)
  if (candidates.length === 0) return messages as ChatMessage[]
  const positions = new Set(candidates.map((candidate) => `${String(candidate.messageIndex)}:${String(candidate.partIndex)}`))
  return applyImageDietAt(messages, positions)
}
