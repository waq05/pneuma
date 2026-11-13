/**
 * 启动提示只展示一次（迁自 `scripts/boot-notices-test.mjs`）。
 *
 * ## 被测的是什么
 *
 * 「沙箱已就绪」「会话横幅」这类开机事实每次启动都无条件重发进转录，用户嫌刷屏。
 * `core/boot-notices.ts` 给它加了一道闸：同 key 同文不再说，文本变了（换模型、换会话）
 * 自动重说。这一层分两半：
 *   ① 纯闸门 `bootNoticeOnce`：同文不发、变文重发、不同 key 互不影响、状态落盘；
 *   ② 真内核：同一个临时主目录连续启动两次、恢复同一条会话，第二次的启动横幅被抑制。
 *
 * ## 为什么第二半要起真内核
 *
 * 横幅的正文由 `emitStartupNotes` 现算——`会话 <id 前 8 位> · 模型 <provider>/<model>`，
 * 还带着「恢复会话时先重放历史」这一串前置动作。少了真内核，验不到「第二次启动时
 * 同一条会话的横幅真的没被写进去」。
 *
 * ## 迁移时收窄的一条
 *
 * 原探针还钉「首次启动有『沙箱已就绪』提示、第二次被抑制」。harness 默认把 sandbox 插件
 * 关掉（台账 D16：它在 Windows 上启动时要 spawn PowerShell 体检，实测会挂住测试 worker），
 * 这一趟根本不产生沙箱提示。硬留着只能靠打开沙箱换一个不退出进程，不值；这里保留
 * 「横幅」这条同机制的端到端，沙箱那条按 D16 记为未覆盖。
 *
 * @module dsc/core/boot-notices.int.spec
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DscCoreConfig } from './config.js'
import { bootKernel, fakeLLM, tempHome, type BootedKernel, type FakeLLM } from '../../tests/harness.js'

/**
 * 临时主目录；必须在任何内核模块被加载之前换好。
 *
 * `core/path-policy.ts` 的 `DSC_HOME` 是模块顶层常量，一旦先被静态 import 就按老 HOME 算死，
 * 之后 boot-notices 的落盘位置与内核的会话根目录会分叉到两个临时目录（实测：断言在
 * 自己那份临时目录里找不到文件，而文件其实写进了 setup 那份）。所以内核侧模块一律
 * `await import()`，静态 import 只留 harness 与类型。
 */
const home = tempHome('dsc-boot-notices-')
const dscHome = join(home.home, '.dsc')

let llm: FakeLLM
/** 起过的内核：每一条用例用完自己收，谁也不留定时器给下一条。 */
const kernels: BootedKernel[] = []
/** 闸门函数：`boot-notices.ts` 在 `tempHome()` 之后才加载（理由见上）。 */
let bootNoticeOnce: typeof import('./boot-notices.js')['bootNoticeOnce']

beforeAll(async () => {
  ;({ bootNoticeOnce } = await import('./boot-notices.js'))
})

afterAll(async () => {
  for (const kernel of kernels) await kernel?.dispose()
  await llm?.close()
  home.restore()
})

/** 转录里当前所有系统行的正文（横幅、沙箱提示、迁移报告都在这类条目里）。 */
function systemTexts(kernel: BootedKernel): string[] {
  const ctx = kernel.ctx as unknown as {
    transcript: { getSnapshot(): { entries: ReadonlyArray<{ text?: string }> } }
  }
  return ctx.transcript.getSnapshot().entries.map((entry) => String(entry.text ?? ''))
}

/** 等到转录里出现含某段文本的条目（写进去是异步的），返回那一刻的全部正文。 */
async function waitForText(kernel: BootedKernel, needle: string, timeoutMs = 5_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const texts = systemTexts(kernel)
    if (texts.some((text) => text.includes(needle)) || Date.now() > deadline) return texts
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

/** `emitStartupNotes` 只看 providers 是不是空；空的话会多写一条「没有可用端点」的错误行。 */
const config = { providers: { test: {} } } as unknown as DscCoreConfig

describe('① 闸门本身：同文不发、变文重发、不同 key 互不影响', () => {
  test('首次展示返回 true', () => {
    expect(bootNoticeOnce('probe', '文本A')).toBe(true)
  })

  test('同 key 同文返回 false', () => {
    // 这一条就是整个功能：同一条开机事实第二次不再说。
    expect(bootNoticeOnce('probe', '文本A')).toBe(false)
  })

  test('同 key 变文返回 true（换模型、换会话要重说）', () => {
    expect(bootNoticeOnce('probe', '文本B')).toBe(true)
  })

  test('不同 key 互不影响', () => {
    // key 是「哪一类提示」，不是「这条文本」；混用会让换会话时该说的被别的提示挡掉。
    expect(bootNoticeOnce('probe2', '文本B')).toBe(true)
  })

  test('状态落在 ~/.dsc/boot-notices.json', () => {
    // 落盘才有「重启后也不再刷屏」；只活在内存里等于每次启动都刷一遍。
    expect(existsSync(join(dscHome, 'boot-notices.json'))).toBe(true)
  })

  test('落盘的内容记的是最后一次展示的文本', () => {
    const shown = JSON.parse(readFileSync(join(dscHome, 'boot-notices.json'), 'utf8')) as Record<string, string>
    expect(shown['probe']).toBe('文本B')
    expect(shown['probe2']).toBe('文本B')
  })
})

describe('② 真内核：恢复同一条会话，第二次启动的横幅被抑制', () => {
  /** 预置的那条可恢复会话的 id（横幅里取前 8 位）。 */
  const SESSION_ID = 'aa11bb22-cc33-dd44-ee55-ff6677889900'

  /** 第一次启动看到的系统正文。 */
  let firstTexts: string[] = []
  /** 第二次启动看到的系统正文。 */
  let secondTexts: string[] = []
  /** 两次启动的异常：放在用例里报，别在 hook 里炸成一行看不懂的栈。 */
  let bootError: unknown

  /**
   * 预置一条可恢复的会话。
   *
   * 必须写真实 jsonl 并让 `.last-session` 指过去：`resumeSessionPath: 'auto'` 找不到文件时
   * 会静默开一条新会话，而新会话的横幅文本本来就不一样——「重发」是正确行为，
   * 就测不出「同会话抑制」了。
   */
  function seedResumableSession(): string {
    const sessionDir = join(dscHome, 'sessions', 'D-w')
    mkdirSync(sessionDir, { recursive: true })
    const sessionFile = join(sessionDir, `${SESSION_ID}.jsonl`)
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'meta', id: SESSION_ID, cwd: 'D:\\w', createdAt: 1 })}\n` +
        `${JSON.stringify({ type: 'user', text: '你好' })}\n`,
      'utf8',
    )
    writeFileSync(join(dscHome, '.last-session'), sessionFile, 'utf8')
    return sessionFile
  }

  /**
   * 起一次内核、发一次启动提示，等转录里出现 `needle` 再返回这一次的系统正文。
   *
   * 每次用完立刻 dispose：会话文件有写租约（T30），两个内核同时开同一条会话会互相抢锁；
   * 而且「关掉再启动」正是真实的重启形态。
   */
  async function bootAndEmit(needle: string): Promise<string[]> {
    llm ??= await fakeLLM({ turns: ['收到'] })
    const kernel = await bootKernel({ providerBaseUrl: llm.baseUrl, resumeSessionPath: 'auto' })
    kernels.push(kernel)
    const startup = await import('../host/startup.js')
    startup.emitStartupNotes(kernel.ctx as unknown as Parameters<typeof startup.emitStartupNotes>[0], null, config)
    // 横幅是「会话 xxx · 模型 yyy」；第二次要靠「历史重放进来了」判断重启本身已经跑完。
    const texts = await waitForText(kernel, needle, 3_000)
    await kernel.dispose()
    return texts
  }

  test('两次启动都正常收尾', async () => {
    try {
      seedResumableSession()
      firstTexts = await bootAndEmit('· 模型')
      secondTexts = await bootAndEmit('你好')
    } catch (error) {
      bootError = error
    }
    expect(bootError).toBeUndefined()
  })

  test('首次启动有会话横幅（会话 xxx · 模型 yyy）', () => {
    expect(firstTexts.some((text) => text.includes('· 模型'))).toBe(true)
  })

  test('横幅里带的是恢复会话的 id 前 8 位', () => {
    // 恢复的必须是那一条会话，否则「第二次被抑制」证明的不是同一条会话的记忆。
    expect(firstTexts.some((text) => text.includes(SESSION_ID.slice(0, 8)))).toBe(true)
  })

  test('第二次启动横幅被抑制', () => {
    // 抑制是「写都没写」：第二次的转录里根本不该出现横幅那一行。
    expect(secondTexts.some((text) => text.includes('· 模型'))).toBe(false)
  })

  test('第二次启动仍然把历史重放进转录（抑制提示不等于抑制会话）', () => {
    // 恢复会话本身要走 replayHistory；只盯横幅容易被「整段启动都没跑」冒充通过。
    expect(secondTexts.some((text) => text.includes('你好'))).toBe(true)
  })
})
