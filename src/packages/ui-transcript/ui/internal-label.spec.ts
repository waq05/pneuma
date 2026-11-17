/**
 * 机器通知压成一句人话（迁自 `scripts/notice-origin-test.mjs` 第 [5] 段）。
 *
 * 界面上一行「刚发生了什么」的取词：队友汇报、后台作业完成 / 失败、其它运行时通知。
 * 三条硬要求：
 *   1. 失败说失败——把失败说成「完成了」比不给标签更误导；
 *   2. 作业号要带上（用户要拿它去 `job_output` 查）；
 *   3. **绝不把原文当标签**：`<teammate-report …>` 的原始 XML 与作业命令行都得压掉。
 *
 * ## 为什么这条住 ui project
 *
 * `internalLabel` 在 `ui-transcript/ui/rounds.ts`：它 import `@dsc/ui`（取词器）与本包
 * 的 `locale/*.json`。根 `tsconfig.spec.json` 明确排除 `src/packages/*\/ui/**`，
 * integration 层的 spec 一旦 import 它，就把界面半拖进内核编译（`@dsc/ui` 解析不到、
 * JSON import 缺属性）。所以断言留在 ui 层，integration 那份只管落库 / 请求 / 重放。
 *
 * @module dsc-ui-shell/transcript/internal-label.spec
 */
import { expect, test } from 'vitest'
import { internalLabel } from './rounds.js'

const JOB_DONE =
  '后台作业 job-3（Set-Location group4\\最终项目\\frontend; npm run build）成功完成。用 job_output(job_id="job-3") 查看输出，job_list 清点全部作业。'
const JOB_FAILED = '后台作业 job-4（npm run pack）失败（退出码 1）。用 job_output(job_id="job-4") 查看输出，job_list 清点全部作业。'
const TEAMMATE = '<teammate-report from="mate-1" role="coder" state="已完成">\n搞定了\n</teammate-report>'

test('队友汇报沿用原标签', () => {
  expect(internalLabel(TEAMMATE)).toBe('队友 mate-1 汇报了运行结果')
})

test('作业完成：带作业号、只说完成', () => {
  expect(internalLabel(JOB_DONE)).toBe('后台作业 job-3 完成了')
})

test('作业失败：说失败（不是「完成」）', () => {
  expect(internalLabel(JOB_FAILED)).toBe('后台作业 job-4 失败了')
})

test('启动失败也归到失败', () => {
  expect(internalLabel('后台作业 job-5 启动失败：spawn ENOENT')).toBe('后台作业 job-5 失败了')
})

test('其它机器通知给通用话', () => {
  expect(internalLabel('定时任务「起来喝水」到点了')).toBe('运行时通知')
})

test('绝不把原文当标签', () => {
  expect(internalLabel(JOB_DONE)).not.toContain('job_output')
  expect(internalLabel(TEAMMATE)).not.toContain('<teammate-report')
})
