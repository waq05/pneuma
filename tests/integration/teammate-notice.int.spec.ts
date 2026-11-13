/**
 * 待投递通知条：收件箱按来源拆两个面（迁自 `scripts/teammate-notice-test.mjs`）。
 *
 * 用户报障：智能体团队里别的智能体发消息回来时，那条消息出现在**输入框下方**的队列条，
 * 还带着「编辑 / 撤掉 / 插话」三颗钮，并且把 `<teammate-report …>` 的原始 XML 露了出来。
 *
 * 根因：收件箱（`async-inbox`）里只按「入箱顺序」排队，界面把整队都画成用户队列条，
 * 分不出「用户亲手发的」与「机器发起的唤醒」。修法（对照 dsh）：收件箱条目带来源，
 * 快照拆两个面——用户来源 → `queued`（输入框下方、可交互），机器来源 → `notices`
 * （输入框上方、只读）。出账（`drainInbox`）后两者都落成同一条 user 消息，模型侧无差别。
 *
 * ## 为什么用「注册进真注册表的慢工具 + fakeLLM 剧本」
 *
 * 「入箱未出账」这个窗口发生在**工具执行期间**：注册一个真的慢工具，在它自己的 `run`
 * 里投消息并当场拍快照，窗口就握在手里——不靠固定 sleep 赌时序。
 *
 * ## 为什么每个场景单独起一次内核
 *
 * `fakeLLM` 的剧本是**按请求序号**发的，而「回合收尾出账」会自己再起一轮（排在收件箱
 * 里的用户消息要等回合结束才落库、落库后自然接着跑）。把三个场景塞进同一个内核，序号
 * 会随着前一个场景多出来的那一轮整体错位——错位后断言红得毫无意义。一次内核一个剧本，
 * 序号与链路一一对应；每个剧本都写明「为什么是这几轮」。
 *
 * ## 没搬的部分
 *
 * 原探针第 [4] 段是三条**源码文本断言**（壳的 `readInboxCount`、终端状态栏的条数表达式、
 * StatusBar 的注释）。本批规矩不搬源码文本，缺口单列在交接里。
 *
 * @module dsc/tests/integration/teammate-notice.int.spec
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录；`DSC_HOME` 是模块级常量，必须先换好再加载内核（一个文件只能调一次）。 */
const home = tempHome('dsc-notice-strip-')

/** 快照里的一条排队项（`index` 是它在**整条收件箱**里的原始位置）。 */
interface QueuedView {
  text: string
  index: number
}
/** 快照里本文件用到的三个面。 */
interface SnapshotView {
  queued: QueuedView[]
  notices: QueuedView[]
  entries: Array<{ kind: string; text?: string; internal?: boolean }>
}
/** 收件箱条目（来源只有 `'notice'` 会显式写出来）。 */
interface InboxItem {
  text: string
  origin?: string
}
/** 内核里本文件用到的服务面。 */
interface SessionView {
  meta: { id: string; cwd: string }
  filePath: string
  messages: Array<{ role: string; content: unknown }>
  asyncInbox(): ReadonlyArray<InboxItem>
}
interface Services {
  session: { current(): SessionView }
  agent: {
    followup(text: string, images?: string[], sessionId?: string, origin?: 'user' | 'notice'): void
    steerQueued(index?: number): boolean
    isRunning(filePath: string): boolean
  }
  transcript: { getSnapshot(): SnapshotView }
  emit(event: 'dsc/changed'): void
  tools: {
    register(entry: {
      name: string
      description: string
      parameters: Record<string, unknown>
      risk: 'read'
      run(args: Record<string, unknown>): Promise<string>
    }): () => void
  }
}

/** 机器来源的那条通知：照 subagent 插件投的 `<teammate-report …>` 形状。 */
const USER_TEXT = '用户插话：别忘了看日志'
const NOTICE_TEXT = `<teammate-report from="mate-1" role="explorer" state="已完成">
派给它的任务：查一下 package.json 里的名字
它的汇报：
名字叫 @waq666/pneuma
</teammate-report>`

/** 插话场景的两条消息（用户那条要排到队首，机器那条占着第 0 位）。 */
const USER_STEER = '用户插话：这条要排到最前面'
const NOTICE_STEER = `<teammate-report from="mate-2" role="builder" state="已完成">
派给它的任务：跑一遍自检
它的汇报：
自检通过
</teammate-report>`

/** 等条件成立；超时返回 false，由断言报出可读错误。 */
async function until(condition: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** 一次起内核的产物：脚本用完就地卸载，三个场景互不影响。 */
interface Rig {
  kernel: BootedKernel
  fake: FakeLLM
  services: Services
  session: SessionView
  /** 读快照前先抖一下失效（transcript 监听 dsc/changed 清缓存）。 */
  snapshot(): SnapshotView
  /** 跑一个真回合，并等到**所有**由出账带出来的后续回合也停下。 */
  runTurn(text: string): Promise<void>
  /** 注册一个慢工具后返回的卸载函数集合。 */
  offs: Array<() => void>
  dispose(): Promise<void>
}

/**
 * 起一套「内核 + 假端点 + 一个慢工具」。
 *
 * @param turns - 假端点剧本，按请求序号。
 * @param registerTool - 往真注册表里登记慢工具的钩子（拿得到 Rig 里的服务）。
 */
async function bootRig(
  turns: Array<string | { toolCall: { name: string; args: unknown } }>,
  registerTool?: (services: Services, session: SessionView, snapshotNow: () => SnapshotView) => () => void,
): Promise<Rig> {
  const fake = await fakeLLM({ turns })
  const kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
  const services = kernel.ctx as unknown as Services
  const session = services.session.current()
  const snapshot = (): SnapshotView => {
    services.emit('dsc/changed')
    return services.transcript.getSnapshot()
  }
  const offs: Array<() => void> = registerTool === undefined ? [] : [registerTool(services, session, snapshot)]

  /** 等到「没有在跑的回合、收件箱空了、请求序号也不再变」，才算这一段链路走完。 */
  const settle = async (): Promise<void> => {
    let last = fake.requestCount
    let stableSince = Date.now()
    const deadline = Date.now() + 15_000
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      const now = fake.requestCount
      if (now !== last) {
        last = now
        stableSince = Date.now()
        continue
      }
      if (
        !services.agent.isRunning(session.filePath)
        && session.asyncInbox().length === 0
        && Date.now() - stableSince >= 300
      ) {
        return
      }
      if (Date.now() > deadline) return
    }
  }

  const runTurn = async (text: string): Promise<void> => {
    const before = fake.requestCount
    services.agent.followup(text)
    // 「回合真的开始了」的锚：模型请求次数涨了。比等 isRunning 稳（它可能立刻结束）。
    if (!(await until(() => fake.requestCount > before))) return
    await settle()
    // 写流是异步 flush 的：让最后一条记录落地再断言。
    await new Promise((resolve) => setTimeout(resolve, 80))
  }

  return {
    kernel,
    fake,
    services,
    session,
    snapshot,
    runTurn,
    offs,
    async dispose() {
      for (const off of offs) off()
      await kernel.dispose()
      await fake.close()
    },
  }
}

describe('①② 入箱的两个面：用户来源进 queued、机器来源进 notices', () => {
  let rig: Rig
  /** 工具执行期间拍下的现场（入箱了、还没画气泡）。 */
  let during: {
    queued: string[]
    notices: string[]
    queuedIndexes: number[]
    noticeIndexes: number[]
    inbox: Array<{ text: string; origin?: string }>
  } | null = null

  beforeAll(async () => {
    rig = await bootRig(
      // 三轮：① 工具调用；② 工具结果回来后的收尾正文；③ 收尾出账把排队的那条用户消息
      // 落库后自动起的下一轮（剧本最后一条会被复用，所以只写两个文本轮）。
      [{ toolCall: { name: 'slow_thing', args: {} } }, '收尾：都收到了', '收到'],
      (services, session, snapshot) =>
        services.tools.register({
          name: 'slow_thing',
          description: '测试用慢工具',
          parameters: { type: 'object', properties: {} },
          risk: 'read',
          run: async () => {
            // ④ 老调用点：不传来源 → 默认按用户算。
            services.agent.followup(USER_TEXT)
            // ② 机器来源：显式标 notice。
            services.agent.followup(NOTICE_TEXT, undefined, undefined, 'notice')
            const snap = snapshot()
            during = {
              queued: snap.queued.map((item) => item.text),
              notices: snap.notices.map((item) => item.text),
              queuedIndexes: snap.queued.map((item) => item.index),
              noticeIndexes: snap.notices.map((item) => item.index),
              inbox: session.asyncInbox().map((item) => ({ text: item.text, origin: item.origin })),
            }
            return 'slow ok'
          },
        }),
    )
    await rig.runTurn('开跑')
  })

  afterAll(async () => {
    await rig?.dispose()
  })

  test('慢工具跑起来了（入箱窗口出现）', () => {
    expect(during).not.toBeNull()
  })

  test('用户来源（不传来源的老调用点）进 queued', () => {
    expect(during?.queued).toEqual([USER_TEXT])
  })

  test('机器来源进 notices、不进 queued', () => {
    expect(during?.notices).toEqual([NOTICE_TEXT])
    expect(during?.queued).not.toContain(NOTICE_TEXT)
  })

  test('queued 里没有机器来源，notices 里没有用户来源', () => {
    expect(during?.queued.every((text) => !text.startsWith('<teammate-report'))).toBe(true)
    expect(during?.notices.every((text) => text !== USER_TEXT)).toBe(true)
  })

  test('收件箱条目带来源：老调用点无 origin、机器来源标 notice', () => {
    expect(during?.inbox[0]?.origin).toBeUndefined()
    expect(during?.inbox[1]?.origin).toBe('notice')
  })

  test('两面的 index 都是收件箱原始位置（0 / 1）', () => {
    expect(during?.queuedIndexes).toEqual([0])
    expect(during?.noticeIndexes).toEqual([1])
  })

  test('③ 出账后两个面都清掉', () => {
    const snap = rig.snapshot()
    expect(snap.queued).toHaveLength(0)
    expect(snap.notices).toHaveLength(0)
    expect(rig.session.asyncInbox()).toHaveLength(0)
  })

  test('③ 对话里两条 user 条目都在（机器那条落成同一条 user 消息）', () => {
    const userTexts = rig
      .snapshot()
      .entries.filter((entry) => entry.kind === 'user')
      .map((entry) => entry.text)
    expect(userTexts).toContain(USER_TEXT)
    expect(userTexts).toContain(NOTICE_TEXT)
    const sessionUsers = rig.session.messages
      .filter((message) => message.role === 'user')
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
    expect(sessionUsers).toContain(USER_TEXT)
    expect(sessionUsers).toContain(NOTICE_TEXT)
  })

  test('③ 机器汇报落库后被打 internal 标记（界面不拿它当人打的字）', () => {
    const noticeEntry = rig
      .snapshot()
      .entries.find((entry) => entry.kind === 'user' && entry.text === NOTICE_TEXT)
    expect(noticeEntry?.internal).toBe(true)
  })
})

/** ③ 插话下标场景的观察（整条收件箱 vs 只数 queued 两种算法各跑一次）。 */
interface SteerObservation {
  indexFixed: number
  indexLegacy: number
  done: boolean
  front: string | null
  order: string[]
}

describe('③ 插话下标 = 整条收件箱的位置（修好的算法）', () => {
  let rig: Rig
  let observation: SteerObservation | null = null

  beforeAll(async () => {
    rig = await bootRig(
      // 两轮：① 工具调用；② 插话打断后出账带起的下一轮。剧本最后一条会复用。
      [{ toolCall: { name: 'slow_steer', args: {} } }, '收到'],
      (services, session, snapshot) =>
        services.tools.register({
          name: 'slow_steer',
          description: '测试用慢工具（插话下标场景）',
          parameters: { type: 'object', properties: {} },
          risk: 'read',
          run: async () => {
            // 机器通知先入箱：它占着收件箱第 0 位，正是老公式漏掉的那一条。
            services.agent.followup(NOTICE_STEER, undefined, undefined, 'notice')
            const before = snapshot()
            const indexFixed = before.queued.length + before.notices.length
            const indexLegacy = before.queued.length
            // 界面第二步：提交用户那条（落在收件箱队尾 = 上面算出的下标），再按它插话。
            services.agent.followup(USER_STEER)
            const done = services.agent.steerQueued(indexFixed)
            const inbox = session.asyncInbox()
            observation = {
              indexFixed,
              indexLegacy,
              done,
              front: inbox[0]?.text ?? null,
              order: inbox.map((item) =>
                item.text === USER_STEER ? 'user' : item.origin === 'notice' ? 'notice' : 'other',
              ),
            }
            return 'steer ok'
          },
        }),
    )
    await rig.runTurn('插话场景：开跑')
  })

  afterAll(async () => {
    await rig?.dispose()
  })

  test('入箱观察：机器通知在前、两种算法差一条', () => {
    expect(observation?.indexFixed).toBe(1)
    expect(observation?.indexLegacy).toBe(0)
  })

  test('修好的算法把用户那条提到队首', () => {
    expect(observation?.done).toBe(true)
    expect(observation?.front).toBe(USER_STEER)
    expect(observation?.order.slice(0, 2)).toEqual(['user', 'notice'])
  })
})

describe('③ 只数 queued 的旧公式：宿主报成功，但提到的是别人那条', () => {
  let rig: Rig
  let observation: SteerObservation | null = null

  beforeAll(async () => {
    rig = await bootRig(
      [{ toolCall: { name: 'slow_steer', args: {} } }, '收到'],
      (services, session, snapshot) =>
        services.tools.register({
          name: 'slow_steer',
          description: '测试用慢工具（插话下标场景·旧公式）',
          parameters: { type: 'object', properties: {} },
          risk: 'read',
          run: async () => {
            services.agent.followup(NOTICE_STEER, undefined, undefined, 'notice')
            const before = snapshot()
            const indexFixed = before.queued.length + before.notices.length
            // 旧公式：只数用户来源的那一面，于是下标偏小一位。
            const indexLegacy = before.queued.length
            services.agent.followup(USER_STEER)
            const done = services.agent.steerQueued(indexLegacy)
            const inbox = session.asyncInbox()
            observation = {
              indexFixed,
              indexLegacy,
              done,
              front: inbox[0]?.text ?? null,
              order: inbox.map((item) =>
                item.text === USER_STEER ? 'user' : item.origin === 'notice' ? 'notice' : 'other',
              ),
            }
            return 'steer ok'
          },
        }),
    )
    await rig.runTurn('插话场景：开跑')
  })

  afterAll(async () => {
    await rig?.dispose()
  })

  test('宿主照样回 true（静默插错才是最坏的那种）', () => {
    expect(observation?.done).toBe(true)
  })

  test('队首还是机器通知：用户的插话没插上', () => {
    expect(observation?.front).not.toBe(USER_STEER)
    expect(observation?.order[0]).toBe('notice')
  })

  test('两种算法的下标差刚好是通知条数（这就是漏掉的那一位）', () => {
    expect(observation?.indexFixed).toBe(1)
    expect(observation?.indexLegacy).toBe(0)
  })
})
