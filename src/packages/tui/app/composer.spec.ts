/**
 * Composer 候补面板的确定性测试（迁自 `scripts/composer-test.mjs`）。
 *
 * ## 为什么这一层要这样测
 *
 * 候补面板的全部行为都挂在按键上：输入 `/` 弹命令、↑↓ 移选中项、Tab 补全、Esc 抑制、
 * Enter 执行或「只补全不执行」。这些只有用假 stdin 驱动真 ink、再读帧才能验——直接调
 * 内部函数要么拿不到状态机，要么把「按了键之后用户看到什么」这层整个跳过。
 *
 * 覆盖：命令候选 / 模型候选（`/model` 参数阶段）/ ↑↓ 选择 / Tab 补全 / Esc 抑制 /
 * 唯一前缀展开 / 输入框无占位文案 / 补全窗口（10 行视口越缘滑动）/ 要收输入的命令
 * （`/review` 回车只补全）/ 撞前缀时的归属。
 *
 * ## 帧的等待方式
 *
 * 原探针每个键固定 sleep 150ms。这里改成「最少等 150ms，且输出长度连续几拍不再变」：
 * 慢机器上不会读到半帧，快机器上也不比原来慢多少。一次写多个方向键是安全的（选中项用
 * 函数式更新）；但退格/清空不能用批量写（处理器闭包里拿的是上一帧的 value），所以清空
 * 输入改用 Ctrl+U 一个键——语义相同（清到光标前），而且少三十来次按键。
 *
 * ## 隔离
 *
 * Composer 会经 `history-store` 读 `~/.dsc/.tui-history`，提交时整表重写。所以
 * `tempHome()` + `DSC_HOME` 必须在模块被加载之前换好，Composer 一律动态 import。
 * 真实 `~/.dsc` 一个字节都不动。
 *
 * 归 `tui` project（`src/packages/tui/**` + node + 假 stdin/stdout）。
 *
 * @module dsc/packages/tui/app/composer.spec
 */
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { createElement } from 'react'
import { render } from 'ink'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ModelChoiceView } from '@pneuma/runtime/contract.js'
import { inputClaimOf } from '@pneuma/commands-core/commands-completion.js'
import { tempHome } from '../../../../tests/harness.js'

/** 临时主目录：`history-store` 的 `.tui-history` 落在它下面（真实 `~/.dsc` 不动）。 */
const home = tempHome('dsc-composer-')
/** 原来的 `DSC_HOME`（可能没设），afterAll 原样还回去。 */
const originalDscHome = process.env.DSC_HOME
process.env.DSC_HOME = join(home.home, '.dsc')

type ComposerModule = typeof import('./Composer.js')

/** 三个模型候选（`/model ` 阶段的面板就画这些）。 */
const MODELS: ModelChoiceView[] = [
  {
    value: 'ark/deepseek-v4-pro',
    provider: 'ark',
    providerDisplayName: '火山方舟',
    model: 'deepseek-v4-pro',
    description: '火山方舟 Agent Plan · 256k 上下文',
    contextWindow: 256_000,
    thinkingLevels: ['low', 'high'],
    modalities: ['text'],
  },
  {
    value: 'ark/glm-5.3-flash',
    provider: 'ark',
    providerDisplayName: '火山方舟',
    model: 'glm-5.3-flash',
    description: '火山方舟 Agent Plan · 1000k 上下文',
    contextWindow: 1_000_000,
    thinkingLevels: ['low', 'high'],
    modalities: ['text'],
  },
  {
    value: 'hy3-a/hy3-a',
    provider: 'hy3-a',
    providerDisplayName: 'hy3-a',
    model: 'hy3-a',
    description: 'hy3-a · 256k 上下文',
    contextWindow: 256_000,
    thinkingLevels: [],
    modalities: ['text'],
  },
]

/** 假 stdin：ink 的 useInput 从它拿键。 */
const stdin = new PassThrough() as PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}
stdin.isTTY = true
stdin.setRawMode = () => {}
stdin.ref = () => {}
stdin.unref = () => {}

/** 假 stdout：帧从这里收。 */
const stdout = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
stdout.columns = 110
stdout.rows = 40
stdout.isTTY = false

/** 累计输出（每次按键前清空）。 */
let output = ''
stdout.on('data', (chunk: Buffer) => {
  output += String(chunk)
})

/** 键序列。 */
const KEY = { down: '\u001b[B', up: '\u001b[A', tab: '\t', esc: '\u001b', enter: '\r', clear: '\u0015' }

/** 提交过的话（onSubmit 收到的原文）。 */
const submitted: string[] = []
/** 渲染实例。 */
let instance: ReturnType<typeof render> | null = null
/** 初始帧（空输入时那一帧）。 */
let initialFrame = ''

/** 等这一帧写完：最少 150ms，且输出长度连续几拍不再变。 */
async function settleFrame(): Promise<void> {
  const startedAt = Date.now()
  const deadline = startedAt + 2_000
  let previous = -1
  let stable = 0
  while (Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 25))
    if (output.length === previous) stable += 1
    else {
      stable = 0
      previous = output.length
    }
    if (Date.now() - startedAt >= 150 && stable >= 2) return
  }
}

/** 敲一串键，返回这一下之后新产出的帧。 */
async function press(keys: string): Promise<string> {
  output = ''
  stdin.write(keys)
  await settleFrame()
  return output
}

/** 清空输入框（Ctrl+U：清到光标前，光标此时总在末尾）。 */
async function clearInput(): Promise<void> {
  await press(KEY.clear)
}

beforeAll(async () => {
  const mod: ComposerModule = await import('./Composer.js')
  // 先清空再渲：`render()` 可能同步写出首帧，渲完再清会把首帧一起清掉。
  output = ''
  instance = render(createElement(mod.Composer, { disabled: false, models: MODELS, onSubmit: (text) => submitted.push(text) }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await settleFrame()
  initialFrame = output
})

afterAll(() => {
  instance?.unmount()
  stdin.end()
  if (originalDscHome === undefined) delete process.env.DSC_HOME
  else process.env.DSC_HOME = originalDscHome
  home.restore()
})

describe('① 空输入', () => {
  test('空输入无占位文案，只有提示符', () => {
    expect(initialFrame.includes('说点什么')).toBe(false)
    expect(initialFrame.includes('❯')).toBe(true)
  })
})

describe('② 输入 / 弹出命令面板', () => {
  /** 敲了 `/` 之后的那一帧（下面四条共用）。 */
  let frame = ''

  beforeAll(async () => {
    frame = await press('/')
  })

  test('面板出现（新会话 / 恢复会话都在）', () => {
    expect(frame.includes('新会话 new')).toBe(true)
    expect(frame.includes('恢复会话 resume')).toBe(true)
  })

  test('面板每行是中文名 + 英文名', () => {
    // 2026-10-29 改版：英文名不再带斜杠——斜杠只留在输入框里。
    expect(frame.includes('新会话 new')).toBe(true)
    expect(frame.includes('模型 model')).toBe(true)
  })

  test('参数占位不再进面板（选中后宿主已补空格）', () => {
    expect(frame.includes('<[端点/]模型名>')).toBe(false)
  })

  test('面板含操作提示', () => {
    expect(frame.includes('Tab 补全')).toBe(true)
  })
})

describe('③ ↑↓ 选择移动', () => {
  test('↓↓↓ 后选中项变为「压缩 compact」', async () => {
    const frame = await press(KEY.down + KEY.down + KEY.down)
    // 认「面板里被选中那一行」：行首是 ❯ 且还带着中文名（输入框那行只有一个 ❯ /）。
    const selected = frame.split('\n').find((line) => line.includes('❯') && line.includes('压缩'))
    expect(selected).toBeDefined()
    expect(selected).toContain('压缩 compact')
  })
})

describe('④ Tab 补全无参命令', () => {
  test('Tab 补全为 /compact（填满输入框）', async () => {
    expect(await press(KEY.tab)).toContain('❯ /compact')
  })
})

describe('⑤ Esc 关闭面板，且输入变化前不再出现', () => {
  test('Esc 后面板消失', async () => {
    expect(await press(KEY.esc)).not.toContain('恢复历史会话')
  })

  test('输入变化前面板保持关闭', async () => {
    expect(await press('q')).not.toContain('新建会话')
  })
})

describe('⑥ 命令前缀过滤', () => {
  test('/mo 命令过滤只剩「模型 model」', async () => {
    await clearInput()
    const frame = await press('/mo')
    expect(frame.includes('模型 model')).toBe(true)
    expect(frame.includes('新会话')).toBe(false)
  })
})

describe('⑦ Tab 补全 /model 后切到模型候选列表', () => {
  /** 补全 `/model` 之后的那一帧。 */
  let frame = ''

  beforeAll(async () => {
    frame = await press(KEY.tab)
  })

  test('空格后展示模型候选', () => {
    expect(frame.includes('ark/deepseek-v4-pro')).toBe(true)
    expect(frame.includes('hy3-a/hy3-a')).toBe(true)
  })

  test('模型候选带说明', () => {
    expect(frame.includes('256k 上下文')).toBe(true)
  })
})

describe('⑧ ↓ 选中第二个模型 + Tab 补全', () => {
  /** 按 ↓ 之后的帧。 */
  let downFrame = ''
  /** Tab 补全之后的帧（后两条共用）。 */
  let tabFrame = ''

  beforeAll(async () => {
    downFrame = await press(KEY.down)
    tabFrame = await press(KEY.tab)
  })

  test('↓ 后选中 ark/glm-5.3-flash', () => {
    const selected = downFrame.split('\n').find((line) => line.includes('❯') && line.includes('ark/'))
    expect(selected).toBeDefined()
    expect(selected).toContain('ark/glm-5.3-flash')
  })

  test('Tab 补全为 /model ark/glm-5.3-flash', () => {
    expect(tabFrame).toContain('❯ /model ark/glm-5.3-flash')
  })

  test('物理光标停靠序列存在（IME 预览落输入框）', () => {
    // 0.6.57 起假光标 ▏ 换成 ink useCursor 的物理光标（帧尾 G 序列 + ?25h）。
    expect(/\[\d+G/.test(tabFrame)).toBe(true)
    expect(tabFrame.includes('[?25h')).toBe(true)
  })

  test('补全后面板关闭', () => {
    expect(tabFrame).not.toContain('hy3-a/hy3-a')
  })
})

describe('⑨ 模型名前缀过滤', () => {
  test('/model deep 过滤只剩 deepseek-v4-pro', async () => {
    await clearInput()
    const frame = await press('/model deep')
    expect(frame.includes('deepseek-v4-pro')).toBe(true)
    expect(frame.includes('glm-5.3-flash')).toBe(false)
  })
})

describe('⑩ Enter 提交模型选择', () => {
  test('唯一前缀展开成 /model ark/deepseek-v4-pro', async () => {
    await press(KEY.enter)
    expect(submitted.at(-1)).toBe('/model ark/deepseek-v4-pro')
  })
})

describe('⑪ 命令唯一前缀展开', () => {
  test('/ne + Enter 自动展开为 /new', async () => {
    await clearInput()
    await press('/ne')
    await press(KEY.enter)
    expect(submitted.at(-1)).toBe('/new')
  })
})

describe('⑫ 补全面板窗口（0.6.64）：候全量入面板，视口 10 行越缘滑动', () => {
  /** 敲 `/` 之后的首屏帧。 */
  let frame = ''

  beforeAll(async () => {
    frame = await press('/')
  })

  test('首屏塞满 10 行（新会话 … 思考显示在、分叉已滑出）', () => {
    expect(frame.includes('新会话')).toBe(true)
    expect(frame.includes('权限预设')).toBe(true)
    expect(frame.includes('思考显示')).toBe(true)
    expect(frame.includes('分叉')).toBe(false)
  })

  test('footer 带窗口计数（1–10/总数）', () => {
    expect(/1–10\/\d+ 条/.test(frame)).toBe(true)
  })

  test('↓×11 窗口滑动（新会话滚出、分叉入窗）', async () => {
    const moved = await press(KEY.down.repeat(11))
    expect(moved.includes('新会话')).toBe(false)
    expect(moved.includes('分叉')).toBe(true)
  })

  test('Esc 关面板', async () => {
    expect(await press(KEY.esc)).not.toContain('↑↓ 选择')
  })
})

describe('⑬ 要收输入的命令（/review）：回车只补全成 `/review `、不执行', () => {
  test('输入 /review 时候选面板在（代码审查）', async () => {
    await clearInput()
    expect(await press('/review')).toContain('代码审查')
  })

  /** 按 Enter 之前的提交数（下面两条共用）。 */
  let beforeClaim = 0
  /** 第一次按 Enter 之后的那一帧（「补成 /review 」那条用）。 */
  let claimFrame = ''

  test('/review + Enter 不执行（没有提交）', async () => {
    beforeClaim = submitted.length
    claimFrame = await press(KEY.enter)
    expect(submitted.length).toBe(beforeClaim)
  })

  test('把输入补成「/review 」（尾空格已补）', () => {
    expect(claimFrame).toContain('/review ')
  })

  test('空参数的 /review 再按回车仍不执行', async () => {
    await press(KEY.enter)
    expect(submitted.length).toBe(beforeClaim)
  })

  test('/review 只看登录逻辑 仍照常执行', async () => {
    await press('只看登录逻辑')
    await press(KEY.enter)
    expect(submitted.at(-1)).toBe('/review 只看登录逻辑')
  })
})

describe('⑭ 撞前缀的归属（改造前口径）', () => {
  /** 选中 /review 之前已经提交了几条。 */
  let beforeSelect = 0

  test('/rev + Enter 执行面板高亮项 /reviewer', async () => {
    await clearInput()
    await press('/rev')
    beforeSelect = submitted.length
    await press(KEY.enter)
    expect(submitted.at(-1)).toBe('/reviewer')
  })

  test('/rev ↓ 选到 /review 再回车只补全、不执行', async () => {
    await clearInput()
    await press('/rev')
    await press(KEY.down)
    const frame = await press(KEY.enter)
    expect(submitted.length).toBe(beforeSelect + 1)
    expect(frame).toContain('/review ')
  })

  test('/review 补全后带参数执行', async () => {
    await press('看差异')
    await press(KEY.enter)
    expect(submitted.at(-1)).toBe('/review 看差异')
  })
})

describe('⑮ 没有 input 字段的命令：/diff 回车直接执行', () => {
  test('/diff 回车照旧直接执行', async () => {
    await clearInput()
    await press('/diff')
    await press(KEY.enter)
    expect(submitted.at(-1)).toBe('/diff')
  })
})

describe('⑯ 纯函数口径（TUI 与壳共用同一条规则）', () => {
  test('inputClaimOf(/review) 给出补全文本与提示语', () => {
    const claim = inputClaimOf('/review')
    expect(claim).not.toBeNull()
    expect(claim?.insert).toBe('/review ')
    expect(claim?.hint ?? '').toContain('关注点')
  })

  test('inputClaimOf(/rev) 认唯一前缀', () => {
    expect(inputClaimOf('/rev')?.insert).toBe('/review ')
  })

  test('inputClaimOf(/review 关注点) 返回 null（已经写了参数）', () => {
    expect(inputClaimOf('/review 关注点')).toBeNull()
  })

  test('inputClaimOf(/diff) 返回 null（没有 input 字段）', () => {
    expect(inputClaimOf('/diff')).toBeNull()
  })

  test('inputClaimOf(/review   ) 尾空格不算参数（仍给补全）', () => {
    expect(inputClaimOf('/review   ')?.insert).toBe('/review ')
  })

  test('inputClaimOf(普通消息) 返回 null', () => {
    expect(inputClaimOf('看看 /review')).toBeNull()
  })

  test('inputClaimOf(裸 /) 返回 null', () => {
    expect(inputClaimOf('/')).toBeNull()
  })
})
