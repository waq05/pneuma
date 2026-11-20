/**
 * runtime-api 收尾缺口（`packages/runtime-api/index.ts:41,147`）：插件清单与头部计数。
 *
 * 这两行都要真的读到插件注册表才有内容，而单测进程里注册目录通常为空（既有的
 * `w12-runtime-api-branches.spec.ts` 因此只验到「插件 0 个」）。这里把注册表模块包一层，
 * 只为 `listPluginInfos` 给一份固定清单，`KERNEL_API_VERSION` 等其余导出原样交给真实现；
 * 钉的是「启用/停用」「内核」两个标记和头部的启用计数，不是注册表本身。
 *
 * @module @pneuma/runtime-api/tests/w14-plugin-list.spec
 */
import { expect, test, vi } from 'vitest'

/** 固定插件清单：一个内核档（不可开关）、一个启用、一个停用。 */
const infos = vi.hoisted(() => [
  { file: 'session-core', name: '会话内核', description: '', enabled: true, source: 'builtin', toggleable: false },
  { file: 'goal.js', name: '目标', description: '', enabled: true, source: 'external', toggleable: true },
  { file: 'probe.js', name: '探针', description: '', enabled: false, source: 'external', toggleable: true },
])

vi.mock('@pneuma/runtime/core/plugin-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/plugin-registry.js')>()
  return { ...actual, listPluginInfos: () => infos }
})

const { runtimeApiPlugin } = await import('../index.js')

interface RegisteredTool {
  name: string
  run: (args: Record<string, unknown>) => Promise<string>
}

/** 假宿主：只实现 apply 与 run 会碰到的面。 */
function fakeHost(): RegisteredTool {
  let tool!: RegisteredTool
  const ctx = {
    tools: {
      list: () => [
        { name: 'bash', risk: 'exec', description: '运行命令', presets: undefined },
        { name: 'read', risk: 'read', description: '读文件', presets: undefined },
      ],
      register: (entry: RegisteredTool) => {
        tool = entry
        return () => undefined
      },
    },
    guards: { chain: [] },
    prompt: { sections: () => [] },
    surfaces: { ids: [] },
    presets: { surface: () => ({ current: 'standard', defaultName: 'standard', options: [] }) },
    effect: (execute: () => unknown) => execute(),
  }
  ;(runtimeApiPlugin.apply as unknown as (host: unknown) => void)(ctx)
  return tool
}

test('topic=plugins：启用/停用与「内核」标记逐行给全', async () => {
  const out = await fakeHost().run({ topic: 'plugins' })
  expect(out).toContain('插件 3 个：')
  expect(out).toContain('- goal.js｜目标｜启用｜external')
  expect(out).toContain('- probe.js｜探针｜停用｜external')
  expect(out).toContain('- session-core｜会话内核｜启用｜builtin（内核）')
})

test('头部计数：已挂插件只数启用的，工具与模式同样报数', async () => {
  const out = await fakeHost().run({})
  expect(out).toContain('已挂插件 2 个、工具 2 个、模式 0 个')
})
