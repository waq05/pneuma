/**
 * session-title-live.js —— 任务进行中动态刷新会话标题。
 *
 * 内置的 session-title（src/packages/session-title/index.ts）只在**首回合正常结束后**
 * 起一次标题，写 meta.json 的 `autoTitle`，之后定型（index.ts:57-78、109-114）。
 * 于是长任务跑到一半、方向已经变了，标题还停在用户第一句话上。
 *
 * 本插件补「过程」这一段：
 * 1. `dsc/turn-start` 记下这一轮的会话，按固定节拍巡检它的消息增长；
 * 2. 有实质进展（至少一条助手消息，且比上次起名后又多了消息）才发一次小请求；
 * 3. 请求内容 = 首条用户消息 + 最近几条进展摘要 + 当前标题（没变就要求原样返回）；
 * 4. 结果写 `autoTitle`；用户改过名（`meta.title` 存在）的会话一个字节都不碰；
 * 5. 新标题与旧的一样就不写盘、不刷新；失败完全静默，回合结束就收摊。
 *
 * 为什么不监听工具结果：内核对外只有 turn-start / turn-end / agent-status 这些
 * 回合级事件；工具观察者（ctx.guards.registerObserver）拿不到会话归属，多个会话
 * 并行时会串台。回合进行中唯一权威的进展读数，就是会话自己的 messages
 * （常驻 agent 的内存会话最新，收摊了的只读重放磁盘）。
 *
 * 与内置插件的关系：本插件在回合中间先写了 autoTitle，内置插件在 turn-end 时
 * 见到已有 autoTitle 就跳过（index.ts:76-78），所以最终留下的是过程里最后一次
 * 按最新进展起的标题；本插件一次都没写成功时，内置的兜底照常工作。
 *
 * 装法：放进 `~/.dsc/plugins/`（宿主启动时自动发现），或用 config.yaml 的
 * `plugins: [...]` 声明路径。
 */
import { Session } from '@pneuma/runtime/core/session.js'
import { patchSessionMeta, readSessionMeta } from '@pneuma/runtime/core/session-meta.js'
import { contentText } from '@pneuma/runtime/core/llm.js'

export const name = '会话标题·动态'
export const description = '任务进行中按进展持续刷新会话标题；用户改过名的不动'
export const inject = ['session', 'llm']

/** 巡检节拍（毫秒）：够密到跟得上任务阶段，又不会把起标题变成负担。 */
const TICK_MS = 15_000
/** 单回合最多更新几次：长任务不至于无限烧小请求。 */
const MAX_UPDATES = 8
/** 单次标题请求超时：起标题不值得让用户等。 */
const TITLE_TIMEOUT_MS = 20_000
/** 标题长度上限（清洗后截断，展示层还会再截）。 */
const TITLE_CHARS = 24
/** 送给标题模型的材料预算。 */
const FIRST_PROMPT_CHARS = 400
const RECENT_MESSAGES = 8
const RECENT_CHARS = 200

const TITLE_PROMPT =
  '你是会话标题生成器。根据会话的任务内容与当前进展，给这个会话起标题。'
  + '要求：中文，不超过 14 个字；直接输出标题本身——不要引号、不要句号、'
  + '不要「会话：」「关于」这类前缀；保留关键名词（文件名、功能名、报错关键词）。'
  + '如果「当前标题」已经能概括任务方向，就原样输出当前标题，不要为了换个说法而改。'

/** 洗掉模型手痒加的引号、前缀和换行；洗完是空的返回 undefined。 */
export function cleanTitle(raw) {
  const text = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/^["'「『《【（(]+|["'」』》】）)』]+$/g, '')
    .replace(/^(?:标题|会话|主题)[:：]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_CHARS)
  return text === '' ? undefined : text
}

/** 一条协议消息折成一行摘要；工具结果截短，标题模型只需要知道「在干什么」。 */
function summarize(message, limit) {
  if (message.role === 'assistant') {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    const names = calls
      .map((call) => call?.function?.name)
      .filter((tool) => typeof tool === 'string' && tool !== '')
    const text = contentText(message.content).replace(/\s+/g, ' ').trim()
    const parts = [text, names.length > 0 ? `[调用工具：${names.join('、')}]` : '']
      .filter((part) => part !== '')
      .join(' ')
    return parts === '' ? '' : `助手：${parts.slice(0, limit)}`
  }
  if (message.role === 'tool') {
    const text = contentText(message.content).replace(/\s+/g, ' ').trim()
    return text === '' ? '' : `工具结果：${text.slice(0, limit)}`
  }
  if (message.role === 'user') {
    const text = contentText(message.content).replace(/\s+/g, ' ').trim()
    return text === '' ? '' : `用户：${text.slice(0, limit)}`
  }
  return ''
}

export function apply(ctx, config) {
  /** 巡检节拍与单回合上限可以在 plugins.json 的 config 里覆盖（自测也用这条路）。 */
  const intervalMs = Number(config?.intervalMs) > 0 ? Number(config.intervalMs) : TICK_MS
  const maxUpdates = Number(config?.maxUpdates) > 0 ? Number(config.maxUpdates) : MAX_UPDATES
  /** 正在跟踪的会话：path → 巡检状态。 */
  const running = new Map()

  /** 目标会话的最新读数：常驻 agent 在就用内存会话，收摊了就只读重放磁盘。 */
  function loadSession(path) {
    const resident = ctx.get('agent')?.sessionFor?.(path)
    if (resident) return resident
    return Session.load(path, true, { lease: false })
  }

  function stop(path) {
    const state = running.get(path)
    if (!state) return
    clearInterval(state.timer)
    running.delete(path)
  }

  function start(path) {
    if (typeof path !== 'string' || path === '') return
    if (running.has(path)) return
    const state = { timer: null, updates: 0, lastCount: 0, inflight: false }
    // 首次不立刻跑：回合刚开始只有用户那一句，起出来还是原话
    state.timer = setInterval(() => { void tick(path, state) }, intervalMs)
    running.set(path, state)
  }

  /** 一次巡检：没有新消息就什么都不做（本地读数，不花请求）。 */
  async function tick(path, state) {
    if (state.inflight) return
    if (state.updates >= maxUpdates) { stop(path); return }
    state.inflight = true
    try {
      const session = loadSession(path)
      const messages = Array.isArray(session.messages) ? session.messages : []
      // 只有用户那一条时不起名（等于把第一句话抄一遍）
      if (messages.length < 2 || messages.length <= state.lastCount) return
      const id = session.meta?.id
      if (typeof id !== 'string' || id === '') return

      const record = readSessionMeta()[id]
      // 用户手动改过名：立刻收摊，这个会话永远不再自动改
      if (typeof record?.title === 'string' && record.title !== '') {
        stop(path)
        return
      }

      // 先记账再发请求：同一份消息状态不重复请求（失败了也等下一批进展）
      state.lastCount = messages.length
      state.updates += 1

      const firstUser = messages.find((message) => message.role === 'user')
      const firstText = firstUser
        ? contentText(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, FIRST_PROMPT_CHARS)
        : ''
      if (firstText === '') { stop(path); return }

      const recent = messages
        .slice(-RECENT_MESSAGES)
        .map((message) => summarize(message, RECENT_CHARS))
        .filter((line) => line !== '')
        .join('\n')
      const current = typeof record?.autoTitle === 'string' ? record.autoTitle : '（还没有）'

      const route = ctx.llm.routeForSession(session)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
      let result
      try {
        result = await ctx.llm.stream(
          route.api,
          {
            baseUrl: route.baseUrl,
            apiKey: route.apiKey,
            model: route.model,
            sessionId: id,
            maxTokens: 200,
            temperature: 0.2,
            signal: controller.signal,
            messages: [
              { role: 'system', content: TITLE_PROMPT },
              {
                role: 'user',
                content: [
                  `[首条用户消息] ${firstText}`,
                  `[当前标题] ${current}`,
                  `[最近进展]\n${recent}`,
                ].join('\n\n'),
              },
            ],
          },
          { onDelta() {} },
        )
      } finally {
        clearTimeout(timer)
      }

      const title = cleanTitle(result?.text ?? '')
      if (title === undefined) return
      // 写之前再查一次：等待期间用户可能自己改了名
      const latest = readSessionMeta()[id]
      if (typeof latest?.title === 'string' && latest.title !== '') { stop(path); return }
      // 没变化就不写盘、不刷新，侧栏也不闪
      if (latest?.autoTitle === title) return

      patchSessionMeta(id, { autoTitle: title })
      // 列表缓存里这份会话的摘要还是旧的，不刷侧栏永远显示旧标题
      if (typeof ctx.session.refresh === 'function') await ctx.session.refresh()
      else ctx.emit('dsc/changed')
    } catch {
      // 静默：标题是展示属性，失败不值得打扰用户；兜底还有内置插件与首句截断
    } finally {
      state.inflight = false
    }
  }

  const offStart = ctx.on('dsc/turn-start', (payload) => {
    start(payload?.sessionPath ?? ctx.session.current().filePath)
  })
  const offEnd = ctx.on('dsc/turn-end', (_reason, payload) => {
    stop(payload?.sessionPath ?? ctx.session.current().filePath)
  })
  // 兜底：回合以别的方式收尾（审批卡被撤销、会话被关）时状态位也会转 idle
  const offStatus = ctx.on('dsc/agent-status', (payload) => {
    if (payload?.state === 'idle' && typeof payload.path === 'string') stop(payload.path)
  })

  return () => {
    for (const path of [...running.keys()]) stop(path)
    offStart()
    offEnd()
    offStatus()
  }
}
