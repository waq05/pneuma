/**
 * bash 终端块的命令与退出码解析（ui 层）。
 *
 * 来源：`scripts/ui-tool-bash-test.mjs` 第 [1][2] 段的**行为**部分（退出码解析、命令解析）。
 *
 * ## 迁移时重新判过的前提（原探针抬头的第一问）
 *
 * 原探针说「只能钉源码 + 复刻纯函数，不能直接 import 产品模块」——那是因为裸 Node 载不动
 * `.tsx`、解析不了 `@dsc/*` 别名。现在这两样都不成立：`bash-view.tsx` 本来就把两个纯函数
 * **具名导出**（`bashCommandOf` / `bashOutcomeOf`，见该文件第 42 / 56 行），而 ui project
 * 有别名与 JSX 管线。所以按迁移手册 §2 方案 C 换成真判定：这里 import 的就是产品代码，
 * 不是复刻——产品侧改了正则或分支，下面的断言立刻红，不再依赖「源码钉先红」的接力。
 *
 * ## 渲染半边（组件渲染批补上）
 *
 * 徽章文案分支（`exitViewOf`）与「（无输出）」的 done 门槛没有具名导出，按原计划**不提成
 * 导出**（方案 E 不落地）：真渲染 `BashBody` 就接得上——跑动中 / 被拒 / 中止 / 跑挂的徽章
 * 文案、done 无退出码按 0 画、「（无输出）」只在 done 出现，全部从组件行为验，见下半段。
 *
 * 第 [3][4] 段（factory 装配写法、views.css 样式令牌）：装配写法已由 `factory.spec.tsx`
 * 的渲染断言覆盖；样式令牌是 CSS 文本钉（jsdom 不吃样式表），无渲染接缝，不迁。
 *
 * @module dsc-ui-transcript/ui/tool-card/bash-view.spec
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { ToolCallView } from '@dsc/ui'
import { BashBody, bashCommandOf, bashOutcomeOf } from './bash-view.js'

afterEach(cleanup)

/** 一条 bash 调用：命令固定，状态与结果按用例给。 */
function callOf(status: ToolCallView['status'], resultText?: string): ToolCallView {
  return { callId: 'c1', name: 'bash', argsText: '{"command":"echo hi"}', status, ...(resultText === undefined ? {} : { resultText }) }
}

// ── 退出码解析：宿主只在非 0 时写「退出码 N」那一行 ──────────────────────────

test('「退出码 3\\n输出」→ 3，正文去掉首行', () => {
  const outcome = bashOutcomeOf('退出码 3\n输出')
  expect(outcome.code).toBe(3)
  expect(outcome.body).toBe('输出')
})

test('成功时宿主不写这一行：「输出」→ 没有退出码，正文原样', () => {
  const outcome = bashOutcomeOf('输出')
  expect(outcome.code).toBeNull()
  expect(outcome.body).toBe('输出')
})

test('空串 → 没有退出码，正文也是空', () => {
  expect(bashOutcomeOf('')).toEqual({ code: null, body: '' })
})

test('「退出码 0\\n」→ 0，正文是空串（连它那个换行一起摘）', () => {
  expect(bashOutcomeOf('退出码 0\n')).toEqual({ code: 0, body: '' })
})

test('原因行可能排在退出码之前：「[超时] 已终止\\n退出码 124\\n输出」→ 124，正文保留原因行', () => {
  const outcome = bashOutcomeOf('[超时] 已终止\n退出码 124\n输出')
  expect(outcome.code).toBe(124)
  expect(outcome.body).toBe('[超时] 已终止\n输出')
})

test('正文不 trim（输出自己的缩进原样保留）', () => {
  expect(bashOutcomeOf('退出码 1\n    缩进两格\n').body).toBe('    缩进两格\n')
})

// ── 命令解析：参数键是 `command` ─────────────────────────────────────────────

test('正常参数 → 拿到命令原文', () => {
  expect(bashCommandOf('{"command":"echo hi"}')).toBe('echo hi')
})

test('没有 command 字段 → null（不是 bash 形态）', () => {
  expect(bashCommandOf('{"path":"a.txt"}')).toBeNull()
})

test('坏 JSON（流式半截参数）→ null，不抛', () => {
  expect(bashCommandOf('{"command":')).toBeNull()
})

test('多行命令原样保留（不折成一长条、不吞换行）', () => {
  expect(bashCommandOf('{"command":"echo 一\\necho 二"}')).toBe('echo 一\necho 二')
})

test('空命令 → null（画不出东西就不开终端块）', () => {
  expect(bashCommandOf('{"command":"   "}')).toBeNull()
})

// ── 渲染：徽章文案分支（exitViewOf）与「（无输出）」的 done 门槛 ───────────────
// 这两个分支没有具名导出（方案 E 不落地）；真渲染 BashBody，从 DOM 读文案与色档。

test('跑动中：徽章说「运行中」，不给色档（还没跑完不说 0）', () => {
  const card = render(<BashBody call={callOf('running', '半截输出')} />)
  const badge = card.container.querySelector('.tc-bash-exit') as HTMLElement
  expect(badge.textContent).toBe('运行中')
  expect(badge.getAttribute('data-exit')).toBe('none')
})

test('done + 宿主写了退出码 3：徽章「退出码 3」走坏档；正文不再重复那一行', () => {
  const card = render(<BashBody call={callOf('done', '退出码 3\n输出一行')} />)
  const badge = card.container.querySelector('.tc-bash-exit') as HTMLElement
  expect(badge.textContent).toBe('退出码 3')
  expect(badge.getAttribute('data-exit')).toBe('bad')
  const out = card.container.querySelector('.tc-bash-out')
  expect(out?.textContent).toBe('输出一行')
  expect(out?.textContent).not.toContain('退出码')
})

test('done + 退出码 0：徽章走正常档', () => {
  const card = render(<BashBody call={callOf('done', '退出码 0\n好了')} />)
  expect(card.container.querySelector('.tc-bash-exit')?.getAttribute('data-exit')).toBe('ok')
})

test('done + 没写退出码那一行：宿主成功时本来就不写，按 0 画', () => {
  const card = render(<BashBody call={callOf('done', '命令自己的输出')} />)
  const badge = card.container.querySelector('.tc-bash-exit') as HTMLElement
  expect(badge.textContent).toBe('退出码 0')
  expect(badge.getAttribute('data-exit')).toBe('ok')
})

test('被拒 / 中止 / 跑挂：三种文案各归各的档，都不是「退出码 0」', () => {
  for (const [status, text] of [
    ['rejected', '已拒绝'],
    ['aborted', '已中止'],
    ['failed', '执行失败'],
  ] as const) {
    const card = render(<BashBody call={callOf(status)} />)
    const badge = card.container.querySelector('.tc-bash-exit') as HTMLElement
    expect(badge.textContent, String(status)).toBe(text)
    expect(badge.getAttribute('data-exit'), String(status)).toBe('none')
    card.unmount()
  }
})

test('「（无输出）」只在 done 出现：跑动中真的一行都没有时什么都不画', () => {
  // done + 空正文：「命令执行过、它什么都没打印」。
  const done = render(<BashBody call={callOf('done', '')} />)
  expect(done.container.querySelector('.tc-bash-out')?.textContent).toBe('（无输出）')
  done.unmount()
  // running + 还没有输出：不画占位（写了等于断言一件还没发生的事），连 <pre> 都不挂。
  const running = render(<BashBody call={callOf('running')} />)
  expect(running.container.querySelector('.tc-bash-out')).toBeNull()
  expect(running.container.textContent).not.toContain('（无输出）')
})

test('终端块的三块都在：$ 命令行原样、data-bash-state 跟着状态走', () => {
  const card = render(<BashBody call={callOf('done', '退出码 0')} />)
  expect(card.container.querySelector('.tc-bash-cmd code')?.textContent).toBe('echo hi')
  expect((card.container.querySelector('.tc-bash') as HTMLElement).getAttribute('data-bash-state')).toBe('done')
})
