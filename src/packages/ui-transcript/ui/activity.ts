/**
 * 「这一轮现在在干什么」的推导（零依赖纯函数，从 timing.ts 抽出来）。
 *
 * 为什么单独一个文件：timing.ts 会 import 平台种子库（`@dsc/ui-primitives` 的时间格式化），
 * 而 Node 里的回归探针解析不了工作区别名——把这段纯逻辑放在不带值导入的模块里，
 * 探针才能直接 import 它核对分支（scripts/ui-turn-status-test.mjs）。
 *
 * 文案只有一个方向（对照 dsh 的 stepProcess 组头）：**一句话**。
 * @module dsc-ui-shell/plugins/transcript/activity
 */
import { createT, type TranscriptEntry } from '@dsc/ui'
// 本包自己的中英对照：`locale/ui.zh.json` 是语义真源（中文原文），`ui.en.json` 是译本。
import zh from '../locale/ui.zh.json'
import en from '../locale/ui.en.json'

/** 本包的取词器：语言由启动图的 `host.language` 决定（见 `@dsc/ui` 的 `createT`）。 */
const t = createT({ zh, en })

/**
 * 「此刻在干什么」的一句话（直播行拿它当悬停提示，等确认时直接当行面文案）。
 *
 * 对照 dsh 的 stepProcess 组头：类别 + 详情，只有一行。
 *
 * 2026-11-08 去掉了 `covered`：它原本判断「过程组头是否已经在说同一件事」，界面据此把
 * 直播行整条藏起来。那条禁令拆掉之后（dsh 是组头与直播行两行并存），这个判断没有消费方，
 * 留着只会让下一个人以为它还在生效。
 */
export interface LiveActivity {
  /** 一行文案：正在分析请求 / 正在调用 bash / 等待你的确认。 */
  text: string
}

/**
 * 从快照能看到的线索推导「现在在干什么」：直播尾思考 → 分析请求；直播尾正文 → 整理回复；
 * 有 running 的工具卡 → 正在调用那个工具（用真名）；其余按 turnState 兜底。
 * 回合已结束（idle）返回 null：直播行该消失。
 */
export function liveActivity(
  entries: readonly TranscriptEntry[],
  turnState: string,
): LiveActivity | null {
  if (turnState === 'idle') return null
  if (turnState === 'awaiting-approval') {
    return { text: t('transcript.activity.approval') }
  }
  const tail = entries[entries.length - 1]
  if (tail !== undefined && tail.id < 0 && tail.kind === 'thinking') {
    return { text: t('transcript.activity.analyzing') }
  }
  if (tail !== undefined && tail.id < 0 && tail.kind === 'text') {
    return { text: t('transcript.activity.answering') }
  }
  const running = [...entries]
    .reverse()
    .find(
      (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> =>
        entry.kind === 'tool' && (entry.call.status === 'running' || entry.call.status === 'preparing'),
    )
  if (running !== undefined) {
    // 名字可能为空：模型偶尔发出一条没有名字的工具调用（网关把它回成 null，
    // 见 core/llm.ts 的 applyToolCallDelta）。空名字时别画出「正在调用 」这种半句话。
    const name = typeof running.call.name === 'string' && running.call.name !== '' ? running.call.name : t('transcript.activity.unknownTool')
    return {
      // 「准备中」是模型还在吐参数、「正在调用」是工具真的开跑了——两句话不同
      text: running.call.status === 'preparing' ? t('transcript.activity.preparing', { name }) : t('transcript.activity.calling', { name }),
    }
  }
  if (turnState === 'working') return { text: t('transcript.activity.working') }
  return { text: t('transcript.activity.analyzing') }
}
