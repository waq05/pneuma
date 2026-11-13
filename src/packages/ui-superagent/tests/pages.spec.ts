/**
 * `@pneuma/ui-superagent` 的页面级测试：钉「页面接上去之后」仍然成立的静态事实。
 *
 * 只测不渲染 React 的东西（与其它界面包的包级测试同一档）：字典完整性、清单落点、
 * 界面半文件都在、可单独停用。界面真的能不能点开要整套壳，归 `scripts/` 的集成探针，
 * 以及 `scripts/ui-locale-test.mjs`。
 *
 * 迁移说明（D2）——旧文件六条里有五条是读 `.ts`/`.tsx` 源码文本再 `assert.match`，
 * 按迁移手册第 2 节与本批硬性规矩逐条处理：
 *   - 「源码里每个字面量 t('…') 的键都在字典里」：`scripts/ui-locale-test.mjs` 已经用
 *     TypeScript AST 对全部界面半做同一件事（它同时查硬编码中文与英文缺译），删掉重复闸；
 *   - 「侧栏 order 2 / 整页 order 30 / 页条目比对 shellPage」：测的是 `ui.tsx` 的写法，
 *     壳内运行时行为要整套壳才能验，删；换成清单层面的落点与 order（本包真实契约）；
 *   - 「三页状态是 state.ts 的模块级信号」「写动作入参形状」「清理按钮可用条件」：
 *     全是组件/模块源码文本。`ui/state.ts` 顶层 `import … from '@dsc/ui'`，在 unit 层
 *     （node 环境）装载就要 `@dsc/*` 解析与浏览器条件——按本批规矩不硬跑；纯函数
 *     （stageGroupOf / formatAt / readSuperagent）若要测，得先把它们从 `@dsc/ui` 拆出来，
 *     那要动 `ui/**` 源码（本批禁改），留作后续。
 *   换成能真验的：清单（order / ./client / toggleable）与界面半文件存在性。
 *
 * @module @pneuma/ui-superagent/tests
 */
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

/** 按相对本文件的路径读文本。 */
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 汉字范围：与 `scripts/ui-locale-test.mjs` 同一档（只判常用区）。 */
const CJK = /[\u4e00-\u9fff]/

/** 本包 package.json 里测试用得到的字段。 */
interface PackageJson {
  name: string
  exports: { './client': string }
  pneuma: {
    order: number
    toggleable?: boolean
    client: { api: string }
  }
}

const pkg = JSON.parse(read('../package.json')) as PackageJson

/** 界面半的六个文件：整页入口、读面状态、三个页与详情页。 */
const UI_FILES = ['ui.tsx', 'state.ts', 'publish.tsx', 'tickets.tsx', 'settings.tsx', 'detail.tsx']

test('字典：zh / en 键集完全一致，中文非空，英文里没有汉字', () => {
  const zh = JSON.parse(read('../locale/ui.zh.json')) as Record<string, string>
  const en = JSON.parse(read('../locale/ui.en.json')) as Record<string, string>
  expect(Object.keys(zh).sort(), 'zh 与 en 的键集不一致').toEqual(Object.keys(en).sort())
  for (const [key, value] of Object.entries(zh)) {
    expect(typeof value, `ui.zh.json 的 ${key} 不是字符串`).toBe('string')
    expect(value.trim(), `ui.zh.json 的 ${key} 是空串`).not.toBe('')
  }
  for (const [key, value] of Object.entries(en)) {
    expect(typeof value, `ui.en.json 的 ${key} 不是字符串`).toBe('string')
    expect(CJK.test(value), `ui.en.json 的 ${key} 还是中文`).toBe(false)
  }
})

test('清单：order 369 接在界面专用段（350–368）之后，./client 指向 ui/ui.tsx', () => {
  // 为什么钉 369：350–368 被 21 个界面单元占满且没有空号，本包接在段尾之后，
  // 不为一个号去动别人的包（见 index.ts 文件头）。
  expect(pkg.pneuma.order).toBe(369)
  expect(pkg.exports['./client'], './client 要指到界面半的入口').toBe('./ui/ui.tsx')
  expect(existsSync(new URL('../ui/ui.tsx', import.meta.url)), 'ui/ui.tsx 不见了').toBe(true)
})

test('界面半的六个文件都在', () => {
  for (const file of UI_FILES) {
    expect(existsSync(new URL(`../ui/${file}`, import.meta.url)), `ui/${file} 不见了`).toBe(true)
  }
})

test('可单独停用：toggleable 为真（停用它只影响这个界面单元）', () => {
  expect(pkg.pneuma.toggleable, '界面单元要能在插件中心单独停用').toBe(true)
  expect(pkg.name).toBe('@pneuma/ui-superagent')
})
