/**
 * tui 插件：进程内 UI 插件——把 runtime 服务挂到 ink 终端界面。
 * 迁自 v2 boot.ts 的挂载逻辑；App 组件与 contract.ts 契约零改动。
 *
 * 阶段 6 起，终端壳也吃同一套界面插件：清单里 `platform: 'tui'` 的 bundle 装进
 * 这里新建的槽位注册表（与浏览器壳同一个 `SlotRegistry` 类），插件贡献的块渲染在
 * 通知盒下方（`tui.notice.extensions`）。同一份插件源码在两种载体下各跑一次，
 * 靠的是插件只站在 `@dsc/ui` 的载体基元与 `apply(ui)` 契约上。
 *
 * 0.6.66 起整帧跑在备用屏（DEC 1049，dsh-tui/codex 同款）：帧是「终端行数−1」
 * 的整屏视口，内联渲染一旦被滚动（历史输出、终端重排）挪了锚点，ink 卸载的
 * 擦除就擦错行——退出后残帧和 shell 提示交错。备用屏里随便折腾，1049l 一写
 * 主屏原样还原；`process.on('exit')` 兜底让崩溃路径也能退出备用屏（只还原、
 * 不告别——崩溃时「会话已保存」不一定是真话）。
 *
 * @module dsc/plugins/tui
 */
import React from 'react'
import { render, type Instance } from 'ink'
import type { Plugin } from '@deepseek-ai/cordis'
import { App } from '../app/App.js'
import { SlotRegistry } from '../ui/slots.js'
import { SlotOutlet } from '../ui/slots-ink.js'
import { loadTuiPlugins } from '../ui/tui-plugins.js'
import { TUI_SLOTS } from '../ui/tui-plugin-api.js'
import { DSC_VERSION } from '../core/version.js'
import type { InkComponent } from '../ui/tui-plugins.js'

const ENTER_ALT = '\x1b[?1049h\x1b[2J\x1b[H'
const LEAVE_ALT = '\x1b[?1049l'
const GOODBYE = 'Muse Code 已退出，会话已保存（/resume 可继续）。'

export const tuiPlugin: Plugin.Object = {
  name: 'tui',
  // transcript：界面插件装载失败的原因（没信任、api 不匹配…）进会话流——
  // 「插件怎么不见了」不能只写在 stderr 里。
  inject: ['ui', 'transcript'],
  apply(ctx) {
    const runtime = ctx.ui
    const stdout = process.stdout
    const altScreen = stdout.isTTY === true
    if (altScreen) stdout.write(ENTER_ALT)
    // 有人在看：审批插件据此弹人工审批卡；没有这个登记时它按「无人应答」立刻拒掉，不白等超时。
    const offInteractive = ctx.provide('interactive', { kind: 'tui' as const, reachable: () => true })

    // ── 界面插件（阶段 6）：槽位注册表 + tui 平台的 bundle ─────────────────────
    const registry = new SlotRegistry<InkComponent>()
    registry.declare(TUI_SLOTS.noticeExtensions, 'list')
    const load = loadTuiPlugins({
      registry,
      runtime,
      host: { name: 'Muse Code', version: DSC_VERSION, platform: 'tui' },
      // 终端没有诊断区：装没装上、为什么没装上，进会话流让用户看得见。
      onReport: (report) => {
        if (report.ok) return
        ctx.transcript.system(`界面插件 ${report.id} 没有装上：${report.error ?? '未知原因'}`)
      },
    })

    const tuiNoticeExtras = React.createElement(SlotOutlet, {
      slots: registry,
      slot: TUI_SLOTS.noticeExtensions,
    })

    // exitOnCtrlC=false：Ctrl+C 交给 App（一次打断 / 双击退出）。
    const instance: Instance = render(React.createElement(App, { runtime, tuiNoticeExtras }), {
      exitOnCtrlC: false,
    })

    const leaveAlt = (): void => {
      if (altScreen) stdout.write(LEAVE_ALT)
    }
    // 正常退出路径专用的告别（崩溃兜底走 process 'exit'，那里只还原屏幕）
    const leaveAltWithGoodbye = (): void => {
      if (!altScreen) return
      leaveAlt()
      stdout.write(`${GOODBYE}\n`)
    }
    if (altScreen) process.on('exit', leaveAlt)

    // dsc/exit 与 disposer 可能都跑（exit 先 emit、dispose 再收尾）：卸载只做一次
    let tornDown = false
    const teardown = (goodbye: boolean): void => {
      if (tornDown) return
      tornDown = true
      load.disposeAll()
      instance.unmount()
      if (goodbye) leaveAltWithGoodbye()
      else leaveAlt()
      if (altScreen) process.removeListener('exit', leaveAlt)
    }
    ctx.on('dsc/exit', () => teardown(true))
    return () => {
      offInteractive()
      teardown(false)
    }
  },
}
