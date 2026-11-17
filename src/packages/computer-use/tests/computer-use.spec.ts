/**
 * @pneuma/computer-use 的包级测试：钉 6 条不变量。
 *
 * 为什么只钉这些：桌面控制的成本全在「动手」上，只读动作表与旧截图丢弃是两条纯逻辑，
 * 写错会让「看」也变成动手、或让历史被图片撑爆。
 *
 * 迁移说明：原测试读 `lib/` 产物并扫模块导出键猜插件名；现在直接 import 插件对象，
 * 名字与 apply 都从源码拿。断言库从 node:assert 换成 Vitest。
 *
 * @module @pneuma/computer-use/tests
 */
import { readFileSync } from 'node:fs'
import type { ChatContentPart, ChatMessage } from '@pneuma/runtime/core/llm.js'
import { expect, test } from 'vitest'
import { canonicalAction } from '../desktop-control.js'
import { computerUsePlugin, dropStaleScreenshots, LOOK_ACTIONS } from '../index.js'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  type?: string
  exports?: Record<string, unknown>
  pneuma?: { library?: boolean; bundle?: { patch?: string } }
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/computer-use', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch, '装配行的 id 必须正好是 computer-use').toMatch(/^\s*-\s*id: computer-use\s*$/m)
  expect(patch, "装配行的 name 必须是 '@pneuma/computer-use'").toContain("name: '@pneuma/computer-use'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.name).toBe('@pneuma/computer-use')
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], 'exports 必须有 "."').toBeDefined()
  expect(pkg.exports?.['./package.json'], 'exports 必须有 "./package.json"').toBeDefined()
  expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma?.library, '功能包不该标成库包').not.toBe(true)
})

// 入口真能加载：插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof computerUsePlugin).toBe('object')
  expect(typeof computerUsePlugin.name).toBe('string')
  expect(computerUsePlugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(computerUsePlugin.name).toBe('computer-use')
  expect(typeof computerUsePlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})

// 只读表：看的那一档必须含截图与状态，且绝不能含 click 这类动手动作；旧名窗口动作归一。
test('只读动作表不含动手动作，窗口别名归一', () => {
  expect(LOOK_ACTIONS).toContain('screenshot')
  expect(LOOK_ACTIONS).toContain('get_app_state')
  expect(LOOK_ACTIONS, 'click 是动手动作，不该在只读表里').not.toContain('click')
  expect(canonicalAction('window_list')).toBe('list_windows')
})

// 旧截图：只留最新一张，旧的那张换成一句文本说明；非工具消息原样返回。
test('旧截图只留最新一张，旧的换成一句说明', () => {
  const shot = (mark: string): ChatMessage => ({
    role: 'tool',
    content: [
      { type: 'image_url', image_url: { url: 'data:x' } },
      { type: 'text', text: `屏幕物理分辨率 ${mark}` },
    ],
  })
  const dropped = dropStaleScreenshots([shot('a'), shot('b')])
  const oldest = dropped[0]!.content as ChatContentPart[]
  expect(oldest.length, '旧截图该被换成纯文本').toBe(1)
  expect(oldest[0]?.type).toBe('text')
  expect((dropped[1]!.content as ChatContentPart[]).length, '最新那张要原样保留').toBe(2)
  expect(dropStaleScreenshots([{ role: 'user', content: 'x' }]).length).toBe(1)
})
