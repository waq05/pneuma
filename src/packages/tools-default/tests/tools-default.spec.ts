/**
 * @pneuma/tools-default 的包级测试：钉 6 条不变量。
 * 为什么只钉这些：工具真跑要子进程与磁盘，留在集成探针里；能便宜钉住的是装配面、包形态、
 * 入口、文档，以及两个纯函数（glob 花括号展开、bash 输出截断）。
 * 导入面是源码入口（`../index.js` 等），不是 `lib/` 产物。
 * @module @pneuma/tools-default/tests
 */
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { toolsDefaultPlugin } from '../index.js'
import { expandBraces } from '../search-tools.js'
import { truncateBashOutput } from '../bash.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const pkg = JSON.parse(read('../package.json'))

// 装配行：id 或 name 写歪了，这个包就永远关不掉、也永远认不对，所以逐字比对。
test('cordis.patch.yml 的装配行认的是 @pneuma/tools-default', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch).toMatch(/^\s*-\s*id: tools-default\s*$/m)
  expect(patch).toContain("name: '@pneuma/tools-default'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml（库包则相反）。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.type).toBe('module')
  expect(pkg.exports['.'].default).toBeTruthy()
  expect(pkg.exports['./package.json']).toBeTruthy()
  if (pkg.pneuma.library === true) {
    expect(pkg.pneuma.bundle).toBeUndefined()
  } else {
    expect(pkg.pneuma.bundle.patch).toBe('./cordis.patch.yml')
  }
})

// 入口真能加载：直接 import 源码入口并检查插件对象的三件事。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof toolsDefaultPlugin).toBe('object')
  expect(typeof toolsDefaultPlugin.name).toBe('string')
  expect(toolsDefaultPlugin.name).toBe(pkg.name.split('/').pop())
  expect(toolsDefaultPlugin.name).toBe('tools-default')
  expect(typeof toolsDefaultPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme).toContain('## Model Experience')
  expect(readme).toContain('## Known Limitations')
})

// 花括号展开：只有真带逗号的多选才展开；单值按字面量处理；缺右括号直接报错，不静默空结果。
test('glob 花括号：{a,b} 展开，{a} 不展开，缺 } 报错', () => {
  expect(expandBraces('src/*.{js,ts}')).toEqual(['src/*.js', 'src/*.ts'])
  expect(expandBraces('src/{a}')).toEqual(['src/{a}'])
  expect(expandBraces('src/*.js')).toEqual(['src/*.js'])
  expect(() => expandBraces('src/*.{js')).toThrow(/没有配对的/)
})

// 输出截断：留头 60% + 尾 40%，中间写明省略多少字符；没超预算就原样返回。
test('bash 输出截断：头 60% + 尾 40%，短输出不动', () => {
  const out = truncateBashOutput('A'.repeat(100), 10)
  expect(out.startsWith('A'.repeat(6))).toBe(true)
  expect(out.endsWith('A'.repeat(4))).toBe(true)
  expect(out).toContain('中间省略 90 字符')
  expect(truncateBashOutput('短输出', 10)).toBe('短输出')
})
