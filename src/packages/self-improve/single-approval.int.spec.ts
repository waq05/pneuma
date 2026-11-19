/**
 * 技能写入只弹一张审批卡的内核级用例（integration 层，原
 * `scripts/self-improve-single-approval-test.mjs`）。
 *
 * 旧行为：`skill_write` 是 write 档，循环先按它问一遍通用审批卡（卡上只说「工作区外的改动
 * 需要确认」），点过之后工具自己执行前又按「create 哪个技能」问一遍——同一件事两张卡。
 * 现在自我改进插件在守卫链 order 29 让 `skill_write` 跳过 order 30 的审批（只跳这一格），
 * 由工具自己那张信息更全的卡把关。
 *
 * 钉三件事：**只弹一张**、**卡上是 `skill_write` 且摘要带技能名**（证明留下的是插件自己那张）、
 * **点「这次允许」之后技能真的落盘**（没被两层卡夹成「批了也没写」）。
 *
 * ## 与探针的差别
 *
 * 探针手写 SSE 端点；这里用 harness 的 `fakeLLM`，按请求序号给剧本（工具调用 → 收尾）。
 * 探针自己轮询 `pendingView` 点卡，这里同法（审批服务没有「卡出现」事件，轮询是唯一接缝）。
 *
 * ## 隔离
 *
 * HOME 由 integration 层提供；技能写在 `DSC_HOME/skills/` 下，跑完删掉。真实 `~/.dsc` 不碰。
 *
 * @module dsc/packages/self-improve/single-approval.int.spec
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { bootKernel, fakeLLM, type BootedKernel, type FakeLLM } from '../../../tests/harness.js'

/** 探针用的技能正文（写在临时 HOME 里）。 */
const SKILL_MARKDOWN = [
  '---',
  'name: probe-skill',
  'description: 探针用技能（只写在临时 HOME 里）',
  'whenToUse: 自检时',
  '---',
  '',
  '# 探针技能',
  '',
  '这段正文是自检写的。',
].join('\n')

/** 内核里本文件用到的服务面。 */
interface KernelSurface {
  provide(name: string, value: unknown): void
  guards: { chain: Array<{ id: string; order: number }> }
  approval: {
    pendingView(): { id: string; toolName: string; argsSummary?: string } | null | undefined
    answer(answer: 'reject' | 'allow-once'): void
  }
  session: { current(): { messages: Array<{ role: string; content: unknown }> } }
}

let llm: FakeLLM
let kernel: BootedKernel
let surface: KernelSurface
/** 这一轮冒出来的卡（按出现顺序）。 */
let cards: Array<{ id: string; tool: string; summary: string }> = []
/** 多出来的卡一律按拒收掉：多出来的那张恰恰是回归本身，不能让它把用例挂到审批超时。 */
let rejectExtras = false
let watcher: NodeJS.Timeout | undefined
/** 技能目录：跑完删。 */
const skillDir = join(DSC_HOME, 'skills', 'probe-skill')

beforeAll(async () => {
  // 插件清单：打开 self-improve；沙箱与记忆照 harness 的口径关掉；标题插件会在回合之间
  // 多发一次模型请求，吃掉剧本里的下一轮，一并关掉。
  mkdirSync(DSC_HOME, { recursive: true })
  writeFileSync(
    join(DSC_HOME, 'plugins.json'),
    JSON.stringify(
      {
        version: 1,
        entries: [
          { file: 'sandbox', disabled: true },
          { file: 'memory', config: { enabled: false } },
          { file: 'session-title', disabled: true },
          { file: 'self-improve', disabled: false },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
  llm = await fakeLLM({
    turns: [
      { toolCall: { name: 'skill_write', args: { action: 'create', name: 'probe-skill', content: SKILL_MARKDOWN } } },
      '好了',
    ],
  })
  kernel = await bootKernel({ providerBaseUrl: llm.baseUrl })
  surface = kernel.ctx as unknown as KernelSurface
  // 装一个「有人在看」的界面信号：没有它，审批插件判定「没人能答」，卡根本不弹（直接按拒）。
  surface.provide('interactive', { kind: 'tui', reachable: () => true })
  watcher = setInterval(() => {
    const view = surface.approval.pendingView()
    if (view !== null && view !== undefined && !cards.some((card) => card.id === view.id)) {
      cards.push({ id: view.id, tool: view.toolName, summary: view.argsSummary ?? '' })
      if (rejectExtras) surface.approval.answer('reject')
    }
  }, 10)
  watcher.unref?.()
})

afterAll(async () => {
  if (watcher !== undefined) clearInterval(watcher)
  rmSync(skillDir, { recursive: true, force: true })
  await kernel?.dispose()
  await llm?.close()
})

/** 轮询到条件成立；超时返回 false，由断言决定红在哪。 */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolveTick) => setTimeout(resolveTick, 20))
  }
}

test('前提：自我改进的守卫挂在 order 29（它才是让 skill_write 跳过通用审批的那一格）', () => {
  expect(surface.guards.chain.map((guard) => `${guard.id}@${String(guard.order)}`)).toContain('self-improve@29')
})

test('一次技能写入只弹一张卡，卡上是 skill_write 且带技能名；点允许后真的落盘', async () => {
  const before = surface.session.current().messages.length
  const running = kernel.runTurn('建一个技能')
  // 卡是异步登记的：等它出现，再等一拍让人点。
  expect(await until(() => cards.length > 0)).toBe(true)
  await new Promise((resolveTick) => setTimeout(resolveTick, 150))
  surface.approval.answer('allow-once')
  // 之后冒出来的多余卡一律按拒收掉：多出来的那张恰恰是回归本身，不能让它把用例挂到审批超时。
  rejectExtras = true
  await running

  // 只弹一张：两张就是「通用卡 + 工具自己那张」的旧实现。
  expect(cards).toHaveLength(1)
  expect(cards[0]?.tool).toBe('skill_write')
  expect(cards[0]?.summary).toContain('probe-skill')

  const texts = surface.session
    .current()
    .messages.slice(before)
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content))
  expect(texts.some((text) => /新建|创建|probe-skill/.test(text))).toBe(true)
  expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)})
