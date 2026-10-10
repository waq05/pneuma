/**
 * 界面壳入口：建通道 → 建注册表 → 声明槽 → 装插件 → 挂载。
 *
 * 顺序不能反：槽必须**先声明**再让插件注册（注册到未声明的槽当场报错，
 * 这是刻意设计的——拼错槽名不该静默丢掉一整块界面）。所以这里的次序是
 * 声明 → 加载 → 渲染，而不是先渲染再补插件。
 *
 * 数据通道（SSE）与启动清单（`__DSC_BOOT__`）是两件事：清单决定装哪些插件，
 * 通道决定界面上显示什么状态。通道先建（它自己异步连），装插件时一并交给它们。
 *
 * @module dsc-ui-shell/main
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SlotRegistry, type UiBootGraph } from '@dsc/ui-core'
import { readBootGraph, loadUiPlugins } from './boot'
import { createHostChannel } from './host-channel'
import { RuntimeProvider } from './runtime-context'
import { SHELL_SLOTS } from './slots'
import { App } from './app'
import type { UiComponent, UiSlots } from './plugin-api'
import './styles.css'

async function bootstrap(): Promise<void> {
  const container = document.getElementById('root')
  if (container === null) throw new Error('页面里没有 #root')

  // 1. 槽位注册表：壳认识位置，不认识功能。
  const slots: UiSlots = new SlotRegistry<UiComponent>()
  const declared = Object.entries(SHELL_SLOTS).map(([slot, kind]) => slots.declare(slot, kind))

  // 2. 宿主数据通道（异步连，失败也会自己重连）。
  const channel = createHostChannel()

  // 3. 启动清单 + 装插件。清单取不到也要起壳：空壳 + 一条诊断，比白屏好查。
  let boot: UiBootGraph = { rev: 'unavailable', entries: [], host: { name: 'Muse Code', version: '未知版本' } }
  let reports: Awaited<ReturnType<typeof loadUiPlugins>> = []
  try {
    boot = await readBootGraph()
    reports = await loadUiPlugins(boot, { slots, host: boot.host, runtime: channel })
  } catch (error) {
    reports = [{ id: 'boot', ok: false, error: error instanceof Error ? error.message : String(error) }]
  }
  void declared

  // 4. 渲染。
  createRoot(container).render(
    <StrictMode>
      <RuntimeProvider channel={channel}>
        <App slots={slots} boot={boot} reports={reports} />
      </RuntimeProvider>
    </StrictMode>,
  )
}

void bootstrap()
