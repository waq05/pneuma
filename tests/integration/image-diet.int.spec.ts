/**
 * 图片按龄卸载的真投影链与真回合（迁自 `scripts/image-diet-test.mjs` 的 [6]–[11]）。
 *
 * ## 为什么要真内核
 *
 * 纯函数在 `src/core/image-diet.spec.ts` 已经钉过。这一层要验的是**接上投影链之后**还成
 * 不成立：`image-diet` 必须排在 `drop-images` 之前（否则占位根本没机会留下）、设置改了要
 * 立刻生效（现读配置）、电脑控制正在跑时最新那张截图不许被卸载。这些只在真插件装配 +
 * 真 `prompt.rewrite` 里才看得见。
 *
 * ## 最后一段为什么必须真回合
 *
 * 请求体是「投影链跑完之后的成品」：工具结果里的三张图只该留最近两张。用假消息喂
 * `rewrite` 只能验本测试的夹具；真回合里工具结果的形状（`role: 'tool'` + text + 多张
 * image 块）是工具层拼出来的。所以用 harness 的 `fakeLLM`：第一轮答工具调用，第二轮
 * 的请求体就是断言对象。
 *
 * ## 迁移差异
 *
 * - 假端点从探针自写的 `createServer` 换成 `fakeLLM`（同一个 SSE 形状，harness 里只有
 *   一份实现）；请求体直接读 `fakeLLM.bodies`，探针里那份 `captured` 数组不再需要；
 * - 模型名沿用 harness 的 `m-img` / `m-text`（探针自造的名字只是为了区分两个模型）；
 * - 设置复原那几步保留：`save()` 是落盘的，不复原会污染同一文件里后面的用例。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatContentPart, ChatMessage } from '@pneuma/runtime/core/llm.js'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/** 临时主目录：设置与插件配置都落这里。 */
const home = tempHome('dsc-image-diet-int-')

/** 内核里本文件用到的服务面：只声明用到的成员。 */
interface SettingsField {
  key?: string
  type: string
  label?: string
  action?: string
  text?: string
}

interface SettingsSectionView {
  id: string
  fields: SettingsField[]
}

interface Services {
  prompt: { rewrite(messages: readonly ChatMessage[], session: unknown): ChatMessage[] }
  settings: {
    sections(): SettingsSectionView[]
    values(id: string): Promise<Record<string, unknown>>
    save(id: string, key: string, value: unknown): Promise<{ ok: boolean }>
  }
  llm: { setModel(provider: string, model: string): void }
  session: { current(): unknown }
  tools: { register(entry: Record<string, unknown>): () => void }
}

type ImageDietModule = typeof import('@pneuma/runtime/core/image-diet.js')
type ComputerUseModule = typeof import('@pneuma/runtime/packages/computer-use/index.js')

let llm: FakeLLM
let kernel: BootedKernel
let services: Services
let imageDiet: ImageDietModule
/** 内核的根 Context（挂电脑操作插件、注册临时工具都走它）。 */
let ctx: { plugin(plugin: unknown, config: unknown): Promise<unknown>; on(event: string, listener: () => void): () => void }

/** 一个纯文本片段。 */
const text = (value: string): ChatContentPart => ({ type: 'text', text: value })
/** 一张图（data URL，够断言用，不解码）。 */
const image = (url: string): ChatContentPart => ({ type: 'image_url', image_url: { url } })
/**
 * 夹具里的第 n 张图。
 *
 * P2a 起批量卸载按**张数**攒批（`IMAGE_DIET_BATCH_MIN_IMAGES` = 2）：一张先等，凑够两张
 * 才一起卸。这里验的是按预算/按龄的判定与投影链顺序，所以每一段都保证有 ≥ 2 张候选
 * （候选张数在 batch spec 里单独钉）；url 本身长短与判据无关。
 */
const url = (n: number): string => `data:image/png;base64,IMG${String(n)}`
/** 消息的内容片段。 */
const parts = (message: ChatMessage | undefined): ChatContentPart[] =>
  Array.isArray(message?.content) ? message.content : []
/** 一条消息里还剩几张图。 */
const imageUrls = (message: ChatMessage | undefined): string[] =>
  parts(message)
    .filter((part): part is Extract<ChatContentPart, { type: 'image_url' }> => part.type === 'image_url')
    .map((part) => part.image_url.url)
/** 一条消息里有几个卸载占位。 */
const placeholders = (message: ChatMessage | undefined): number =>
  parts(message).filter((part) => part.type === 'text' && part.text === imageDiet.IMAGE_DIET_PLACEHOLDER).length
/** 消息的纯文本（content 是数组时拼 text 片段），用来找护栏留在正文里的那几句话。 */
const textOf = (message: ChatMessage | undefined): string =>
  typeof message?.content === 'string'
    ? message.content
    : parts(message)
        .filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('')
/** 电脑控制截图的形状：tool 消息，text 里带截图标记，后面跟一张图。 */
const shot = (marker: string, urlValue: string): ChatMessage => ({
  role: 'tool',
  tool_call_id: `call-${marker}`,
  content: [text(`屏幕截图 ${marker}`), image(urlValue)],
})

/** 跑一次真投影链。 */
function rewrite(messages: readonly ChatMessage[]): ChatMessage[] {
  return services.prompt.rewrite(messages, services.session.current())
}

beforeAll(async () => {
  imageDiet = await import('@pneuma/runtime/core/image-diet.js')
  // 全文件只有最后一段会发模型请求（前面的 rewrite / 设置 / 挂插件都不走网络）：
  // 剧本按请求序号发，所以第一条就是工具调用、第二条是收尾正文。
  llm = await fakeLLM({ turns: [{ toolCall: { name: 'shot_probe', args: {} } }, '完成'] })
  kernel = await bootKernel({
    providerBaseUrl: llm.baseUrl,
    config: {
      providers: {
        test: {
          name: 'test',
          displayName: 'Test',
          baseUrl: llm.baseUrl,
          apiKey: 'k',
          models: [
            {
              id: 'm-img',
              name: 'm-img',
              contextWindow: 100000,
              maxTokens: 800,
              modalities: ['text', 'image'],
              thinkingLevels: [],
              thinkingParam: 'none',
              effortMap: {},
            },
            {
              id: 'm-text',
              name: 'm-text',
              contextWindow: 100000,
              maxTokens: 800,
              modalities: ['text'],
              thinkingLevels: [],
              thinkingParam: 'none',
              effortMap: {},
            },
          ],
        },
      },
      defaultProvider: 'test',
      defaultModel: 'm-img',
    },
  })
  ctx = kernel.ctx as unknown as typeof ctx
  services = kernel.ctx as unknown as Services
})

afterAll(async () => {
  await kernel?.dispose()
  await llm?.close()
  home.restore()
})

describe('⑥ 投影链：登记与顺序', () => {
  test('设置分区 image-diet 已注册，四个控件齐全', () => {
    const view = services.settings.sections().find((section) => section.id === 'image-diet')
    expect(view).toBeDefined()
    expect(view?.fields.map((field) => field.key)).toEqual(['enabled', 'userImageBudget', 'toolImageBudget', 'keepRounds'])
  })

  test('分区缺省值与 core 口径一致', async () => {
    const values = await services.settings.values('image-diet')
    expect(values).toMatchObject({ enabled: true, userImageBudget: 4, toolImageBudget: 2, keepRounds: 2 })
  })
})

describe('⑦ 投影链：模型收图时按预算卸载（真 rewrite）', () => {
  test('保留 4 张、卸载 2 张，消息不被删除', () => {
    const input: ChatMessage[] = [
      { role: 'user', content: [text('看这几张'), ...Array.from({ length: 6 }, (_, index) => image(url(index + 1)))] },
    ]
    const out = rewrite(input)
    const userMessage = [...out].reverse().find((message) => message.role === 'user' && imageUrls(message).length > 0)
    expect(imageUrls(userMessage)).toHaveLength(4)
    expect(placeholders(userMessage)).toBe(2)
    expect(out.length).toBeGreaterThanOrEqual(input.length)
  })

  test('输入 role 序列是输出 role 序列的子序列（无丢条/无重排）', () => {
    const input: ChatMessage[] = [{ role: 'user', content: [text('看图'), image(url(1))] }]
    const out = rewrite(input)
    expect(out.map((message) => message.role).join(',')).toContain(input.map((message) => message.role).join(','))
  })
})

describe('⑧ 投影链：电脑控制正在跑时最新那张截图不许被卸载', () => {
  /** 挂上电脑操作插件之后的一次 rewrite 结果。 */
  let out: ChatMessage[]

  beforeAll(async () => {
    // 电脑操作插件默认关着（`cordis.patch.yml` 里 disabled: true），它原来那条「只留最新一张
    // 截图」的投影已降级为不登记。挂上它才能钉住「截图走通用规则而不是专有文案」。
    const computerUse: ComputerUseModule = await import('@pneuma/runtime/packages/computer-use/index.js')
    await ctx.plugin(computerUse.computerUsePlugin, {})
    // 用 2x 号段的 url：粘性已卸集合按会话记，和前面 ⑦ 的图错开，免得「已卸」把本段要留的图也带走。
    // 4 张截图：工具图预算 2 张 → 前两张是候选，凑够一批（2 张）才会一起卸。
    out = rewrite([
      { role: 'user', content: '点一下那个按钮' },
      shot('s1', url(21)),
      shot('s2', url(22)),
      shot('s3', url(23)),
      shot('s4', url(24)),
    ])
  })

  test('最新那张截图仍在（图像本身随请求发送）', () => {
    const shots = out.filter((message) => parts(message).some((part) => part.type === 'text' && part.text.startsWith('屏幕截图')))
    expect(imageUrls(shots[shots.length - 1])).toEqual([url(24)])
  })

  test('更老的截图被卸载成占位，用的是通用占位文案', () => {
    const shots = out.filter((message) => parts(message).some((part) => part.type === 'text' && part.text.startsWith('屏幕截图')))
    // 两张老截图（第 1、2 张）都换成占位：批量按位置落点，不会把最新那张同 url 的图带走。
    expect(imageUrls(shots[0])).toHaveLength(0)
    expect(placeholders(shots[0])).toBe(1)
    expect(placeholders(shots[1])).toBe(1)
    expect(textOf(shots[0])).toContain(imageDiet.IMAGE_DIET_PLACEHOLDER)
    expect(textOf(shots[0])).not.toContain('已被更新的截图取代')
  })

  test('挂上电脑操作后截图仍按 toolImageBudget=2 保留 2 张', () => {
    expect(imageDiet.countImageParts(out)).toBe(2)
  })
})

describe('⑨ 投影链：与 drop-images 并存（模型不收图 → 最终无图，且 image-diet 先跑）', () => {
  test('最终没有 image_url，但 image-diet 的占位与 drop-images 的说明都在', () => {
    services.llm.setModel('test', 'm-text')
    try {
      const out = rewrite([
        { role: 'user', content: [text('看图'), ...Array.from({ length: 6 }, (_, index) => image(url(31 + index)))] },
      ])
      expect(imageDiet.countImageParts(out)).toBe(0)
      const userMessage = out.find((message) => message.role === 'user')
      expect(textOf(userMessage)).toContain(imageDiet.IMAGE_DIET_PLACEHOLDER)
      expect(textOf(userMessage)).toContain('没有声明照片输入能力')
    } finally {
      services.llm.setModel('test', 'm-img')
    }
  })
})

describe('⑩ 投影链：设置改了就生效（现读配置）', () => {
  test('预算改成 1 → 只留最近 1 张；总开关关掉 → 一张都不动；越界写入被夹到 20', async () => {
    const input: ChatMessage[] = [{ role: 'user', content: [text('三张'), image(url(41)), image(url(42)), image(url(43))] }]
    try {
      await services.settings.save('image-diet', 'userImageBudget', 1)
      expect(imageDiet.countImageParts(rewrite(input))).toBe(1)

      await services.settings.save('image-diet', 'enabled', false)
      const off = rewrite(input)
      expect(imageDiet.countImageParts(off)).toBe(3)
      expect(JSON.stringify(off)).not.toContain(imageDiet.IMAGE_DIET_PLACEHOLDER)

      const saved = await services.settings.save('image-diet', 'userImageBudget', 999)
      expect(saved.ok).toBe(true)
      expect((await services.settings.values('image-diet'))['userImageBudget']).toBe(20)
    } finally {
      // 复原缺省，别影响后面的真回合。
      await services.settings.save('image-diet', 'enabled', true)
      await services.settings.save('image-diet', 'userImageBudget', 4)
      await services.settings.save('image-diet', 'toolImageBudget', 2)
      await services.settings.save('image-diet', 'keepRounds', 2)
    }
  })
})

describe('⑪ 真回合端到端：第二轮请求体里的旧截图已卸载、最新那张还在', () => {
  /** 最后一个请求体（第二轮：带工具结果）。 */
  let sent: ChatMessage[]

  beforeAll(async () => {
    // 临时工具：返回一段文字与四张图（照 computer-use 截图工具的形状）。
    // 4 张才够一批：工具图预算 2 张 → 前两张是候选，凑够 2 张一起卸。
    // 必须在跑回合**之前**注册：假模型的剧本按请求序号发，第一条就是这条工具的调用。
    const offTool = services.tools.register({
      name: 'shot_probe',
      description: '测试用截图工具：返回一张文字说明与四张图',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      run: async () => ({ text: '屏幕快照', images: [url(11), url(12), url(13), url(14)] }),
    })
    try {
      await kernel.runTurn('给我截个图')
    } finally {
      offTool()
    }
    sent = (llm.bodies[llm.bodies.length - 1] ?? []) as ChatMessage[]
  })

  test('第二轮请求体里带上了工具结果', () => {
    expect(sent.some((message) => message.role === 'tool')).toBe(true)
  })

  test('工具结果里的 4 张图只留最近 2 张，最新的那张一定在', () => {
    const toolMessage = sent.find(
      (message) =>
        message.role === 'tool' &&
        parts(message).some((part) => part.type === 'image_url' || (part.type === 'text' && part.text === imageDiet.IMAGE_DIET_PLACEHOLDER)),
    )
    expect(imageUrls(toolMessage)).toHaveLength(2)
    expect(imageUrls(toolMessage)).toContain(url(14))
  })

  test('被卸载的两张留了占位，最老的两张（第 1、2 张）没有发出去', () => {
    const toolMessage = sent.find(
      (message) =>
        message.role === 'tool' &&
        parts(message).some((part) => part.type === 'image_url' || (part.type === 'text' && part.text === imageDiet.IMAGE_DIET_PLACEHOLDER)),
    )
    expect(placeholders(toolMessage)).toBe(2)
    expect(imageUrls(toolMessage)).not.toContain(url(11))
    expect(imageUrls(toolMessage)).not.toContain(url(12))
  })
})
