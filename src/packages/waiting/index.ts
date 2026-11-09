/**
 * waiting 插件：provide `waiting` 服务——「正在等用户做决定」的登记表。
 *
 * 为什么要有这一层：目标自动续跑之前必须确认没有卡片挂着等用户点（不隔着一张审批卡硬推）。
 * 原先那段是任务面服务里一行 `ctx.approval.pendingView() !== null || plan !== null || question !== null`——
 * 一个功能点挨个认识其他三个功能点的卡片。改成登记制之后，每张卡自己登记「我在等人」，
 * 想往下推的人只问一句「有没有人在等」，谁也不认识谁。
 *
 * 0.6.48 起一个宿主同时养多条会话（后台 agent、队友、定时任务），「有没有人在等」因此有
 * 两个口径：`any` 是**全进程**有没有卡（界面、诊断用），`anyFor(会话 id)` 是**这条会话**
 * 有没有卡（目标续跑、定时投递用）。后台会话挂着一张审批卡，不该把用户正看着那条会话的
 * 自动续跑一起钉死（P0-6）。
 *
 * @module dsc/plugins/waiting
 */
import type { Plugin } from '@deepseek-ai/cordis'
import type { WaitingService } from '@pneuma/runtime/services/types.js'

export const waitingPlugin: Plugin.Object = {
  name: 'waiting',
  provide: 'waiting',
  apply(ctx) {
    /**
     * 登记表：id → 「我在等人」的判定。
     *
     * 判定可以收一个**会话归属**（会话 id）：`undefined` = 问「全进程有没有卡」，
     * 给了就只算那条会话的卡。老登记方（不区分会话的第三方插件）照旧写 `() => boolean`，
     * 它对任何会话都算「在等」——按会话查询不会把它漏掉。
     */
    const waiters = new Map<string, (owner?: string) => boolean>()

    /**
     * 逐个问过去。
     *
     * 一个卡片自己算崩了不算「有人在等」：它已经答不了任何东西，拿这个当挡箭牌会把
     * 用户的续跑永久钉死。
     */
    const pendingFor = (owner?: string): boolean => {
      for (const pending of waiters.values()) {
        try {
          if (pending(owner)) return true
        } catch {
          // 见上：算崩的卡片按「没在等」处理
        }
      }
      return false
    }

    const service: WaitingService = {
      register(id, pending) {
        waiters.set(id, pending)
        return () => {
          if (waiters.get(id) === pending) waiters.delete(id)
        }
      },
      get ids() {
        return [...waiters.keys()]
      },
      /** 全进程口径：界面上「有没有卡」这类粗判定用它。 */
      get any() {
        return pendingFor()
      },
      /** 单会话口径：goal 的自动续跑、schedule 的投递只问自己那条会话。 */
      anyFor(owner) {
        return pendingFor(owner)
      },
    }
    ctx.provide('waiting', service)
  },
}
