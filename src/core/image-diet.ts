/**
 * 每轮图片按龄/按预算卸载（WS2）。
 *
 * 为什么要有这一层：图像一旦进了请求体，就是每一轮都要重发的一坨 base64——一张
 * JPEG 截图 100~300KB，用户贴的照片更大。长会话里老图既烧 token 又早已过期
 * （界面被后面的操作改掉了、贴的图上下文已经翻篇）。现在 dsc 只有两处图片处理：
 * `drop-images`（模型根本不声明收图时全剥，是**能力门**）与电脑控制自己的
 * `prune-stale-screenshots`（只管自己的截图、只留最新一张）。用户贴的图、工具结果里的图
 * 都没有人管。这一层管的就是「留着，但只留该留的那几张」——与能力门职责分开，
 * 所以它跑在 `drop-images` 之前（投影 order 700 < 900）。
 *
 * 两条铁律：
 *   1. 只动发给模型的那一份副本，**不删消息、不改 role 序列**——删掉一条工具结果会留下
 *      配不上对的 tool_call（端点直接 HTTP 400 拒掉整轮请求）；日志里的原文一个字不动，
 *      「模型可见 ⟺ 日志可重建」照样成立（日志原文 + 这条命名投影就能复算）。
 *   2. 卸载只是把 `image_url` 部件**原地**换成一句占位文本，前后文本部件的顺序与内容都不动。
 *
 * @module dsc/core/image-diet
 */
import type { ChatContentPart, ChatMessage } from './llm.js'

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

/**
 * 从插件配置（`resolvePluginConfig('image-diet')` 的结果）读卸载口径，并把区间外的值夹回来。
 * 值非法就回落缺省，读不出来绝不该让一轮请求整个失败。
 */
export function readImageDietConfig(raw: unknown): ImageDietConfig {
  const source: Record<string, unknown> =
    raw === null || typeof raw !== 'object' || Array.isArray(raw) ? {} : (raw as Record<string, unknown>)
  const clamp = (value: unknown, range: { min: number; max: number }, fallback: number): number => {
    const num = Number(value)
    return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), range.min), range.max) : fallback
  }
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
 * 按龄/按预算卸载图片，返回新数组（原数组与原消息对象都不动）。
 *
 * 判定优先级（从硬到软）：
 *   1. 老回合：历史里比最近 `keepRounds` 个用户消息更早的部分，图**全卸载**（不管来源）；
 *   2. 工具结果：最近 `toolImageBudget` 张之外的卸载（保住「当前正在看的那张截图」）；
 *   3. 用户消息：最近 `userImageBudget` 张之外的卸载。
 *
 * 幂等：卸载后的位置只剩占位文本，再跑一遍找不到 image_url，输出逐字节相同。
 * 只认 user / tool 两种角色的图；assistant 正常历史里不带图（正文落库时只存文本），
 * 出现了也不属于这条契约的范围，原样留着。
 *
 * @param messages - 组装好的请求消息（fold-system 之后的形状）。
 * @param options - 卸载口径；不传用缺省。
 */
export function pruneImages(
  messages: readonly ChatMessage[],
  options: ImageDietOptions = DEFAULT_IMAGE_DIET,
): ChatMessage[] {
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

  return messages.map((message, index) => {
    const parts = message.content
    if (parts === null || typeof parts === 'string') return message
    if (!parts.some((part) => part.type === 'image_url')) return message
    const dropAll = index < cut
    const flags = dropBudget.get(index)
    if (!dropAll && flags === undefined) return message
    let replaced = false
    const nextParts: ChatContentPart[] = parts.map((part, partIndex) => {
      if (part.type !== 'image_url') return part
      if (!dropAll && flags?.[partIndex] !== true) return part
      replaced = true
      return { type: 'text', text: IMAGE_DIET_PLACEHOLDER }
    })
    return replaced ? { ...message, content: nextParts } : message
  })
}
