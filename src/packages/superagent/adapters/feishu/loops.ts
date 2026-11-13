/**
 * 飞书来源的两个后台循环：长连接收事件，和每 60 秒一轮的历史补收（含话题轮询）。
 *
 * 进出的口子全是注入的：`run` 跑一次 lark-cli，`consume` 起常驻的 `event consume`，`engine`
 * 收 Trigger，`store.handle` 是 `kv` 表。适配器不 spawn、不读配置、不判断来源开没开——
 * 那三件事分别属于接线层与设置层（`feishu-loops.ts:20-40` 的 `enabled` / `bot` / `available`
 * 就是这三件事，本文件一个都没搬）。
 *
 * **没搬的，逐条说清：**
 *
 * - `watch` 里的 `enabled(ctx)` 与 `available(ctx)`（`feishu-loops.ts:35-66`）：前者是「设置里
 *   这个来源开着吗」，后者是「CLI 与机器人探活过了吗」。两者都是接线层的事；缺了它们，本模块
 *   被叫起来就会一直收，谁决定不启动由接线层负责（本来源默认关，见插件设置）。
 * - `refreshChatNames` / `chatNamesLoop`（`feishu-loops.ts:107-127`）：拉 `im +chat-list` 写
 *   群名。群名只用于界面展示（`ctx.threads.describe`），DSC 的话题没有那个展示面；缺了它
 *   只是界面上群显示成 `oc_...`，不影响事件、准入与派活。
 * - `receive` 里给话题写 URL 与事实的那几行（`feishu-loops.ts:26-34`）：要 `ctx.threads.describe`。
 *   缺了它是界面上的话题没标题、没群名，同上。
 * - `pollThreads` 的「哪些订阅话题还在 14 天视野内」（上游 `sources/poll.ts:8-14` 的 `polled`）：
 *   判断要「这张话题上有没有活着的工单」，而本模块拿不到工单表。办法是把过滤放在注入的
 *   `threads.subscribed()` 里——接线层传进来的必须已经按视野筛过（与 `adapters/github/source.ts:22-26`
 *   同一条取舍）。缺了这层过滤，轮询会一直读早就结束的老话题，多花配额，但不会读错。
 *
 * **加了一段上游没有的：已投递名单。** 游标每次回退 5 秒（`cursorAt`，`sources/poll.ts:16`），
 * 为的是不漏掉迟到的事件；代价是下一轮会把重叠段再读一遍。上游靠核心 `Intake` 按 Trigger id
 * 去重（`core/intake.ts:23`）兜住，本模块照样不赌：窗口内已交给 `engine.receive` 的消息 id 记在
 * `feishu-delivered:<chat>`，下一轮读到同一条直接跳过。少了它也不会丢事件或重复入库，只是每轮
 * 把重叠段重新投递一遍——`receive` 的调用次数会虚高，`status()` 与测试也就说不清「这轮到底进了
 * 几条新消息」。
 *
 * @module dsc/packages/superagent/adapters/feishu/loops
 */
import type { Trigger } from '../../core/model.js'
import {
  lark, validItems, type CliConsume, type CliRun, type CliStream, type Tally,
} from './cli.js'
import { readFeishu } from './read.js'
import {
  feishuRef, feishuTime, feishuTrigger, historyEvent, HistoryPageSchema, HistoricalMessageSchema,
  SOURCE, topicEvent, type FeishuRef, type HistoricalMessage,
} from './trigger.js'

/** 一条订阅话题还值不值得轮询的时长：14 天（上游 `sources/poll.ts:6`）。 */
export const POLL_HORIZON_MS = 14 * 24 * 3600_000

/** 长连接就绪的超时：45 秒没打出 `[event] ready` 就当这次启动失败（`feishu-loops.ts:78`）。 */
const READY_TIMEOUT_MS = 45_000

/** 单条事件的字节上限；超过就丢弃，免得一条畸形事件把内存吃满（`feishu-loops.ts:88`）。 */
const MAX_EVENT_BYTES = 1_048_576

/** `node:sqlite` 的语句对象在本层用到的那几个方法（同 `adapters/github/state.ts:16-20`）。 */
export interface FeishuKvStatement {
  get(...args: unknown[]): unknown
  run(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}

/** `DscStore.handle`（`adapters/store.ts:360`）的结构子集，只取 `prepare`。 */
export interface FeishuKvHandle {
  prepare(sql: string): FeishuKvStatement
}

/**
 * 键名照上游 `kv.ts:46-50` 写。
 *
 * 冒号后缀是跨版本契约：改了它，升级后旧游标读不到，症状是「第一次补收把整段历史又读一遍」，
 * 而且不报错。`delivered` 是本适配器新增的，所以另起一段前缀，不与上游的键混。
 */
export const FEISHU_KEYS = {
  /** 见过的群：`chatId -> 是不是私聊`。补收私聊靠它（`feishu-loops.ts:138-140`）。 */
  chats: 'feishu-chats',
  /** 某个群的历史补收游标。 */
  history: (chatId: string): string => `feishu-history:${chatId}`,
  /** 某个群里还活跃的话题：`threadId -> 最后一次读到的时间`。 */
  topics: (chatId: string): string => `feishu-history-threads:${chatId}`,
  /** 某个订阅话题已轮询过的消息 id。 */
  seen: (threadKey: string): string => `thread-seen:${threadKey}`,
  /** 某个订阅话题是否跑过首轮（首轮只建立已读基线）。 */
  initialized: (threadKey: string): string => `thread-initialized:${threadKey}`,
  /** 某个群在重叠窗口内已经交给核心的消息 id（上游没有这一段，见文件头）。 */
  delivered: (chatId: string): string => `feishu-delivered:${chatId}`,
} as const

/** 一行的 `value` 列；不是字符串就当没读到（同 `adapters/github/state.ts:78-82`）。 */
function column(row: unknown): string | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const value = (row as { value?: unknown }).value
  return typeof value === 'string' ? value : undefined
}

/**
 * `kv` 表上的读写。
 *
 * 读不出来（手改过库、旧版本写坏）时返回 `undefined` 而不是抛：一条坏游标不该让整个来源停摆，
 * 退回「从这一拍开始」比崩溃好（与 `adapters/github/state.ts:99-107` 同一条取舍）。
 * `set(key, undefined)` 表示删除。
 */
export class FeishuKv {
  private readonly handle: FeishuKvHandle

  constructor(handle: FeishuKvHandle) {
    this.handle = handle
  }

  get<T>(key: string): T | undefined {
    const raw = column(this.handle.prepare('SELECT value FROM kv WHERE key = ?').get(key))
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  set<T>(key: string, value: T | undefined): void {
    if (value === undefined) {
      this.handle.prepare('DELETE FROM kv WHERE key = ?').run(key)
      return
    }
    this.handle.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, JSON.stringify(value))
  }
}

/** 轮询里用得到的话题字段（`core/model.ts:156-182` 的 `Thread` 子集，接线层可直接传 `Thread`）。 */
export interface FeishuThread {
  key: string
  ref: { source: string; id: string }
  createdAt: string
  meta: Record<string, unknown>
}

/**
 * 「当前订阅了哪些话题」的注入端口。
 *
 * 只列本模块会调的三件事。`subscribed` 必须只返回还值得轮询的话题（14 天视野内或有活工单），
 * 因为「哪些工单还活着」只有接线层知道，见文件头。
 */
export interface FeishuThreads {
  subscribed(source: string): FeishuThread[]
  latest(key: string): Trigger | undefined
  patch(key: string, meta: Record<string, unknown>): unknown
}

/** 补收要看的那部分来源设置（`sources/feishu.ts:21-29` 的 `chats` / `directMessages` / `readPageSize`）。 */
export interface FeishuLoopConfig {
  /** 设置里列出的群；监听「仅 @」还是「全部消息」由准入层决定，补收看的是「要不要补」。 */
  chats: readonly { chatId: string }[]
  /** 收到过的私聊要不要一起补。 */
  directMessages: boolean
  /** 话题轮询每页几条，默认 20（上游默认值也是 20）。 */
  readPageSize?: number
}

/** `createFeishuSource` 的入参。 */
export interface FeishuLoopOptions {
  /** 跑一次 lark-cli；不带 `--as bot --format json`，由 `lark` 统一补。 */
  run: CliRun
  /** 起常驻的 `event consume`。不传就只做补收轮询，`status().connected` 恒为 false。 */
  consume?: CliConsume
  /** 机器人自己：两种 id 都要，跳过自己发的消息靠它们（`feishu-trigger.ts:89-91`）。 */
  bot: { id: string; appId: string }
  /** 收到一条 Trigger 交给核心。只取一个方法：来源不该看见评估与派工。 */
  engine: { receive(trigger: Trigger): unknown }
  /** 持久层，只取 `kv` 表要用的 `handle`。 */
  store: { handle: FeishuKvHandle }
  /** 补收范围。 */
  config: FeishuLoopConfig
  /** 订阅话题轮询；不传就不轮询（缺哪块见文件头）。 */
  threads?: FeishuThreads
  /** 当前时刻，`Date#toISOString` 形式。 */
  now: () => string
  log: (line: string) => void
  /** 两轮补收之间等多久，默认 60 秒（`feishu-loops.ts:159`）。 */
  backfillEveryMs?: number
}

/**
 * 来源对外的窄接口。`start` / `stop` 管后台循环，`tick` 手跑一轮补收，`status` 读上一轮。
 *
 * `tick()` 不因某个群 / 某条话题读失败而抛：一轮里各群各自失败，原因汇总进
 * `status().lastError`。这样定时器与手动触发看到的是同一件事，调度层不必为「抛了要不要重试」
 * 再写一份判断（上游也是把错误报进 health，`feishu-loops.ts:156-158`）。
 */
export interface FeishuSource {
  start(): void
  stop(): void
  tick(): Promise<void>
  status(): { connected: boolean; lastPollAt: string | null; lastError: string | null }
}

/** 游标每次回退 5 秒，迟到的远端事件才不会被漏掉（`sources/poll.ts:16`）。 */
export const cursorAt = (started: string): string => new Date(Date.parse(started) - 5000).toISOString()

/**
 * 长连接重启的等待时间：跑满一分钟以上的算「站住了」，重启等 1 秒；一启动就崩的按指数退避，
 * 最多 60 秒（`feishu-loops.ts:67-69`）。
 */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

/** 等到 `ms` 毫秒，或信号先停。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = (): void => {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * 造一个飞书来源。
 *
 * @param options - CLI 的两个注入、机器人、核心的 `receive`、持久层、补收范围与时钟
 * @returns `start()` 起后台循环，`stop()` 停，`tick()` 手跑一轮补收，`status()` 读上一轮
 */
export function createFeishuSource(options: FeishuLoopOptions): FeishuSource {
  const { run, bot, engine, now, log } = options
  const kv = new FeishuKv(options.store.handle)
  const every = options.backfillEveryMs ?? 60_000
  const delivered = new Map<string, Record<string, string>>()
  let controller: AbortController | null = null
  let stream: CliStream | null = null
  let halted = false
  let connected = false
  let watchError: string | null = null
  let pollError: string | null = null
  let lastPollAt: string | null = null
  let round: Promise<void> | null = null

  /** 已投递名单：先读进内存，一轮结束再按窗口裁剪后写回。 */
  function deliveredFor(chatId: string): Record<string, string> {
    let map = delivered.get(chatId)
    if (!map) {
      map = { ...(kv.get<Record<string, string>>(FEISHU_KEYS.delivered(chatId)) ?? {}) }
      delivered.set(chatId, map)
    }
    return map
  }

  /** 只留窗口内的 id：更早的消息下一轮不会再被接口返回，留着只会让这份名单长胖。 */
  function pruneDelivered(map: Record<string, string>, since: string): void {
    const floor = Date.parse(since)
    for (const [id, at] of Object.entries(map)) if (!(Date.parse(at) >= floor)) delete map[id]
  }

  /** 要补的群：设置里列出的，加上事件里见过的私聊（`feishu-loops.ts:138-140`）。 */
  function chats(): [string, boolean][] {
    const seen = kv.get<Record<string, boolean>>(FEISHU_KEYS.chats) ?? {}
    const learned = Object.entries(seen).filter(([, direct]) => direct && options.config.directMessages)
    return Object.entries({
      ...Object.fromEntries(options.config.chats.map(chat => [chat.chatId, false])),
      ...Object.fromEntries(learned),
    })
  }

  /** 被订阅话题跟着的话题 id：这些即使静了两周也还要读（`feishu-loops.ts:197-199`）。 */
  function followedThreads(): Set<string> {
    const ids = new Set<string>()
    for (const thread of options.threads?.subscribed(SOURCE) ?? []) {
      const meta = thread.meta as { threadId?: unknown }
      const latest = options.threads?.latest(thread.key)?.meta['threadId']
      const id = typeof meta.threadId === 'string' ? meta.threadId : latest
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
    return ids
  }

  /**
   * 补一个群：先扫群消息，再扫这个群里还活跃的话题。
   *
   * 话题表要「扫描前先落盘、扫完再落盘」：第一段写进去的是本轮新发现的话题，第二段写的是
   * 裁剪后的结果——中途进程死掉时，至少下一轮还知道去扫哪些话题（`feishu-loops.ts:196-205`）。
   */
  async function backfillChat(chatId: string, direct: boolean, since: string, until: string): Promise<void> {
    const topicsKey = FEISHU_KEYS.topics(chatId)
    const topics: Record<string, string> = { ...(kv.get<Record<string, string>>(topicsKey) ?? {}) }
    const tally: Tally = { skipped: 0 }
    const seen = deliveredFor(chatId)

    /** 一条读到的历史消息 → 一条 Trigger；窗口内已投递过的直接跳过（上游没有这一段，见文件头）。 */
    const deliver = async (message: HistoricalMessage, at: string): Promise<void> => {
      if (seen[message.message_id] !== undefined) return
      const trigger = feishuTrigger(historyEvent(message, chatId, direct), bot.id, bot.appId)
      if (trigger) await engine.receive(trigger)
      seen[message.message_id] = at
    }

    const scan = async (kind: 'chat' | 'thread', id: string): Promise<void> => {
      let page: string | undefined
      const pages = new Set<string>()
      do {
        if (halted) throw new Error('Feishu backfill stopped')
        const seconds = (time: string): string => String(Math.floor(Date.parse(time) / 1000))
        const parameters = {
          container_id_type: kind, container_id: id, start_time: seconds(since), end_time: seconds(until),
          sort_type: 'ByCreateTimeAsc', page_size: 50, ...page ? { page_token: page } : {},
        }
        const request = ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(parameters)]
        const result = HistoryPageSchema.parse(await lark(run, request))
        for (const message of validItems(HistoricalMessageSchema, result.items, tally)) {
          // 接口偶尔会混进别的群 / 别的消息：宁可报错，也不把别人的消息算进这个话题。
          const outside = message.chat_id !== chatId || (kind === 'thread' && message.thread_id !== id)
          if (outside) throw new Error('Feishu history returned a message outside the requested chat or thread')
          if (message.deleted) continue
          const at = feishuTime(message.create_time)
          if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? '') >= Date.parse(at))) {
            topics[message.thread_id] = at
          }
          await deliver(message, at)
        }
        // 游标原地打转时宁可报错：假装读完的后果是这段历史以后不会再被读（`feishu-loops.ts:190-191`）。
        const stuck = result.has_more && (!result.page_token || pages.has(result.page_token))
        if (stuck) throw new Error('Feishu history pagination did not advance')
        page = result.has_more ? result.page_token : undefined
        if (page) pages.add(page)
      } while (page)
    }

    try {
      await scan('chat', chatId)
      // 静了两周、又没有订阅话题跟着的话题，不再扫：它们翻不出新回复（`feishu-loops.ts:197-202`）。
      const followed = followedThreads()
      for (const [id, at] of Object.entries(topics)) {
        if (!followed.has(id) && Date.parse(until) - Date.parse(at) >= POLL_HORIZON_MS) delete topics[id]
      }
      kv.set(topicsKey, topics)
      for (const id of Object.keys(topics)) await scan('thread', id)
      kv.set(topicsKey, topics)
    } finally {
      // 失败也要回写已投递名单：下一轮重扫同一段时不该把已经交出去的消息再交一遍。
      pruneDelivered(seen, since)
      kv.set(FEISHU_KEYS.delivered(chatId), seen)
    }
  }

  /** 订阅话题的锚：话题自己带的来源字段优先，其次退回它最新那条 Trigger（`feishu-loops.ts:208-216`）。 */
  function threadRef(thread: FeishuThread): FeishuRef | undefined {
    const meta = thread.meta as { sourceTriggerId?: unknown; chatId?: unknown; messageId?: unknown }
    if (typeof meta.chatId === 'string' && typeof meta.messageId === 'string' && typeof meta.sourceTriggerId === 'string') {
      return { triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId, at: thread.createdAt }
    }
    const trigger = options.threads?.latest(thread.key)
    return trigger ? feishuRef(trigger) : undefined
  }

  /**
   * 轮询一条订阅话题（`feishu-loops.ts:221-267`）。
   *
   * 首轮不投递：先读根消息与父消息，把它们记成已读，再按 `createdAt` 截断——订阅之前的历史
   * 上下文不该变成新需求。之后每轮从新到旧读，碰到一条早就见过的就停：更早的一定也见过。
   */
  async function pollThread(thread: FeishuThread): Promise<void> {
    const port = options.threads
    const ref = threadRef(thread)
    if (!ref || !port) throw new Error('Subscribed thread has no retained source message')
    const pageSize = options.config.readPageSize ?? 20
    const checkpoint = FEISHU_KEYS.seen(thread.key)
    const known = new Set(kv.get<string[]>(checkpoint) ?? [])
    const initialized = kv.get<boolean>(FEISHU_KEYS.initialized(thread.key))
    if (!initialized) {
      for (const section of ['root', 'parent'] as const) {
        const result = await readFeishu(run, ref, `feishu/${ref.triggerId}/${section}`, pageSize)
        if ('message' in result && result.message) known.add(result.message.message_id)
      }
      kv.set(checkpoint, [...known])
    }
    const direct = (kv.get<Record<string, boolean>>(FEISHU_KEYS.chats) ?? {})[ref.chatId] === true
    const since = Date.parse(thread.createdAt)
    // 话题 id 是 `<chatId>:<rootId|messageId>`，取冒号后面那段当根消息。
    const root = thread.ref.id.slice(thread.ref.id.indexOf(':') + 1)
    let resource: string | null = `feishu/${ref.triggerId}/thread`
    while (resource) {
      if (halted) return
      const result = await readFeishu(run, ref, resource, pageSize, 'desc')
      if (!('messages' in result)) throw new Error('Expected Feishu thread messages')
      if (result.thread_id && thread.meta['threadId'] !== result.thread_id) port.patch(thread.key, { threadId: result.thread_id })
      const encounteredKnown = result.messages.some(message => known.has(message.message_id))
      for (const message of result.messages.filter(item => !known.has(item.message_id) && !item.deleted).reverse()) {
        if (halted) return
        const trigger = feishuTrigger(topicEvent(message, ref.chatId, direct, root), bot.id, bot.appId)
        // 首轮里比订阅还早的消息不算：那是上下文，不是新需求（`feishu-loops.ts:257-258`）。
        if (!trigger || (!initialized && Date.parse(trigger.at) < since)) continue
        await engine.receive(trigger)
      }
      result.messages.forEach(message => known.add(message.message_id))
      kv.set(checkpoint, [...known])
      if (initialized && encounteredKnown) break
      resource = result.next_resource
    }
    kv.set(FEISHU_KEYS.initialized(thread.key), true)
  }

  /** 一轮话题轮询：一条失败只记在它自己身上，不打断其它话题（`feishu-loops.ts:218-220`）。 */
  async function pollThreads(failures: string[]): Promise<void> {
    const port = options.threads
    if (!port) return
    for (const thread of port.subscribed(SOURCE)) {
      if (halted) return
      try {
        await pollThread(thread)
        port.patch(thread.key, { pollError: undefined })
      } catch (error) {
        if (halted) return
        failures.push(`${thread.key}: ${String(error)}`)
        port.patch(thread.key, { pollError: String(error) })
      }
    }
  }

  /** 一轮补收。各群各自失败、各自记录：一个群读不通不该让同轮已经读到的群白读（`feishu-loops.ts:141-158`）。 */
  async function runRound(): Promise<void> {
    const started = now()
    lastPollAt = started
    const failures: string[] = []
    for (const [chatId, direct] of chats()) {
      if (halted) break
      const key = FEISHU_KEYS.history(chatId)
      const since = kv.get<string>(key)
      // 第一次见到这个群只记下起点、不读：否则一装好就把整段历史倒进来（`feishu-loops.ts:148`）。
      if (since === undefined) {
        kv.set(key, started)
        continue
      }
      try {
        await backfillChat(chatId, direct, since, started)
        if (!halted) kv.set(key, cursorAt(started))
      } catch (error) {
        if (!halted) failures.push(`${chatId}: ${String(error)}`)
      }
    }
    await pollThreads(failures)
    pollError = failures.length
      ? `${String(failures.length)} Feishu reads failed: ${failures.slice(0, 3).join('; ')}`
      : null
    if (pollError) log(`feishu: ${pollError}`)
  }

  /** 一轮补收并发只有一份：定时器与手工 `tick()` 撞在一起时，两边等到的是同一轮。 */
  function tick(): Promise<void> {
    round ??= runRound().finally(() => {
      round = null
    })
    return round
  }

  /** 记一条长连接的错：只留最近一条，`status()` 读它。 */
  function failWatch(error: unknown): void {
    watchError = error instanceof Error ? error.message : String(error)
    log(`feishu: ${watchError}`)
  }

  /** 一行事件 → 一条 Trigger。读不懂的那行只记错，不让整条长连接死掉（`feishu-loops.ts:86-97`）。 */
  async function handleEvent(line: string): Promise<void> {
    if (line.length > MAX_EVENT_BYTES) throw new Error('Feishu event exceeds 1 MiB')
    const trigger = feishuTrigger(JSON.parse(line), bot.id, bot.appId)
    // 机器人自己发的消息不进来：`feishuTrigger` 已经返回 undefined（`feishu-trigger.ts:89-91`）。
    if (!trigger) return
    const chatId = String(trigger.meta['chatId'] ?? '')
    if (chatId) {
      const seen = kv.get<Record<string, boolean>>(FEISHU_KEYS.chats) ?? {}
      // 私聊标记跟着事件记下来：补收要靠它决定哪些私聊该一起补（`feishu-loops.ts:92-94`）。
      kv.set(FEISHU_KEYS.chats, { ...seen, [chatId]: trigger.meta['direct'] === true })
    }
    await engine.receive(trigger)
  }

  /**
   * 一次长连接的完整生命周期（`feishu-loops.ts:70-105`）。
   *
   * 三件事原样保留：stderr 第一行 `[event] ready` 之前不算连上；45 秒没 ready 就掐掉重来；
   * 正常退出（被我们停的）不算错，异常退出才算。stdout 串成一条链，保证同一批事件按到达顺序
   * 进核心，而不是谁先 await 完谁先入库。
   */
  function consumeOnce(signal: AbortSignal): Promise<void> {
    const consume = options.consume
    if (!consume) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let ready = false
      let diagnostic = ''
      let settled = false
      let chain: Promise<void> = Promise.resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: () => void
      let current: CliStream
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      onAbort = (): void => {
        current.stop()
        connected = false
        // 和正常退出一样等处理链走完再收尾：已经读到的事件不该因为「刚按下停止」被拦腰截断
        // （上游 `feishu-loops.ts:104` 的 `await chain`）。
        void chain.then(() => finish())
      }
      timer = setTimeout(() => {
        diagnostic = 'Feishu event consumer did not become ready within 45 seconds'
        current.stop()
      }, READY_TIMEOUT_MS)
      try {
        current = consume(['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
          stdout(line: string): void {
            chain = chain
              .then(() => handleEvent(line))
              .catch((error: unknown) => {
                failWatch(error)
              })
          },
          stderr(line: string): void {
            diagnostic = line.slice(0, 4000)
            if (line.startsWith('[event] ready')) {
              ready = true
              connected = true
              watchError = null
              if (timer !== undefined) clearTimeout(timer)
            } else if (/WARN|drop|error/.test(line)) {
              failWatch(diagnostic)
            }
          },
        })
      } catch (error) {
        // 长连接根本没起来（命令名写错、参数类型不对）：按一次失败收尾，别把 45 秒定时器留下。
        if (timer !== undefined) clearTimeout(timer)
        finish(error instanceof Error ? error : new Error(String(error)))
        return
      }
      stream = current
      signal.addEventListener('abort', onAbort, { once: true })
      current.done.then(() => {
        void chain.then(() => {
          if (settled) return
          if (signal.aborted) {
            finish()
            return
          }
          connected = false
          finish(new Error(`Feishu event consumer exited (ready=${String(ready)}): ${diagnostic}`))
        })
      }, (error: unknown) => {
        connected = false
        finish(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** 长连接的看护：跑着、崩了就退避重来；被叫停就退出（`feishu-loops.ts:43-66`）。 */
  async function watch(signal: AbortSignal): Promise<void> {
    if (!options.consume) return
    let retry: number | undefined
    while (!signal.aborted) {
      const began = Date.now()
      try {
        await consumeOnce(signal)
      } catch (error) {
        if (!signal.aborted) failWatch(error)
      }
      if (signal.aborted) return
      retry = consumerRetry(retry, Date.now() - began)
      await sleep(retry, signal)
    }
  }

  /** 补收的看护：每 60 秒一轮，失败只记不改节奏（`feishu-loops.ts:128-161`）。 */
  async function backfillLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await tick()
      } catch (error) {
        pollError = String(error)
        log(`feishu: ${pollError}`)
      }
      await sleep(every, signal)
    }
  }

  return {
    start(): void {
      if (controller) return
      const local = new AbortController()
      controller = local
      halted = false
      void watch(local.signal)
      void backfillLoop(local.signal)
    },
    stop(): void {
      halted = true
      controller?.abort()
      controller = null
      stream?.stop()
      stream = null
      connected = false
    },
    tick,
    status(): { connected: boolean; lastPollAt: string | null; lastError: string | null } {
      return { connected, lastPollAt, lastError: watchError ?? pollError }
    },
  }
}
