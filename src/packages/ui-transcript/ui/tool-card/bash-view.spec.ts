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
 * ## 不迁的部分
 *
 * - 徽章文案分支（`exitViewOf`）与「（无输出）」的 done 门槛：**没有具名导出**，行为要真渲染
 *   组件才接得上——归组件渲染批（缺口清单；提成具名导出属源码改动，待拍板）。
 * - 第 [3][4] 段（factory 装配写法、views.css 样式令牌）：源码文本钉，无行为接缝，不迁。
 *
 * @module dsc-ui-transcript/ui/tool-card/bash-view.spec
 */
import { expect, test } from 'vitest'
import { bashCommandOf, bashOutcomeOf } from './bash-view.js'

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
