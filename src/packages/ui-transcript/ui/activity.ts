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
import type { TranscriptEntry } from '@dsc/ui'

/** 进行中状态行的一句话（对照 dsh 的 stepProcess 组头：类别 + 详情，只有一行）。 */
export interface LiveActivity {
  /** 一行文案：正在分析请求 / 正在调用 bash / 等待你的确认。 */
  text: string
  /**
   * true = 过程组头此刻已经在说同一件事（有工具在跑，组头画「正在运行命令 · bash」）。
   *
   * 为什么要有这一位（2026-10-30 报障）：组头与这条状态行曾经各画一遍，用户看到的是
   * 「正在调用工具 · job_output」下面又跟一条「正在调用 bash」——同一件事说两次。
   * 组头在的场合由它说，这条不画；组头不在（竖排未分组 / 没有过程条目）时才由它兜底。
   */
  covered: boolean
}

/**
 * 从快照能看到的线索推导「现在在干什么」：直播尾思考 → 分析请求；直播尾正文 → 整理回复；
 * 有 running 的工具卡 → 正在调用那个工具（用真名）；其余按 turnState 兜底。
 * 回合已结束（idle）返回 null：状态行该消失。
 */
export function liveActivity(
  entries: readonly TranscriptEntry[],
  turnState: string,
): LiveActivity | null {
  if (turnState === 'idle') return null
  if (turnState === 'awaiting-approval') {
    return { text: '等待你的确认', covered: false }
  }
  const tail = entries[entries.length - 1]
  if (tail !== undefined && tail.id < 0 && tail.kind === 'thinking') {
    return { text: '正在分析请求', covered: false }
  }
  if (tail !== undefined && tail.id < 0 && tail.kind === 'text') {
    return { text: '正在整理回复', covered: false }
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
    const name = typeof running.call.name === 'string' && running.call.name !== '' ? running.call.name : '未知工具'
    return {
      // 「准备中」是模型还在吐参数、「正在调用」是工具真的开跑了——两句话不同
      text: running.call.status === 'preparing' ? `正在准备 ${name}` : `正在调用 ${name}`,
      // 工具在跑 = 过程组头正在画同一件事（除非用户把过程折叠关成了竖排）
      covered: true,
    }
  }
  if (turnState === 'working') return { text: '正在执行工具', covered: false }
  return { text: '正在分析请求', covered: false }
}
