/**
 * @pneuma/lsp 的包级测试：钉 6 条不变量。
 *
 * 为什么只钉这些：跳转的正确性全靠位置换算与报文分帧这两块纯逻辑，所以额外钉它们
 * 而不是去起一个语言服务器——那要装一堆真服务，代价与收益完全不成比例。
 *
 * 迁移说明：原测试读 `lib/` 产物、自己打印 PASS/FAIL；现在直接 import src 源码。
 * 路径 fixture 不再依赖进程当前目录（原来写死 `resolve('src/packages/lsp/index.ts')`），
 * 改成按本文件位置取，从哪个目录跑都不会错位。
 *
 * @module @pneuma/lsp/tests
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { encodeMessage, MessageDecoder } from '../framing.js'
import { lspPlugin } from '../index.js'
import { pathToUri, samePath, toDisplayCharacter, toDisplayLine, toProtocolPosition } from '../uri.js'

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
test('cordis.patch.yml 的装配行认的是 @pneuma/lsp', () => {
  const patch = read('../cordis.patch.yml')
  expect(patch, '装配行的 id 必须正好是 lsp').toMatch(/^\s*-\s*id: lsp\s*$/m)
  expect(patch, "装配行的 name 必须是 '@pneuma/lsp'").toContain("name: '@pneuma/lsp'")
})

// 包形态：ESM + 两个导出入口 + 装配指向本目录的 cordis.patch.yml。
test('package.json 是 ESM 功能包，装配指向 cordis.patch.yml', () => {
  expect(pkg.name).toBe('@pneuma/lsp')
  expect(pkg.type).toBe('module')
  expect(pkg.exports?.['.'], 'exports 必须有 "."').toBeDefined()
  expect(pkg.exports?.['./package.json'], 'exports 必须有 "./package.json"').toBeDefined()
  expect(pkg.pneuma?.bundle?.patch).toBe('./cordis.patch.yml')
  expect(pkg.pneuma?.library, '功能包不该标成库包').not.toBe(true)
})

// 入口真能加载：插件名 = 包名去掉 @pneuma/ 前缀 = 装配行的 id。
test('入口能加载，插件名与 apply 对得上', () => {
  expect(typeof lspPlugin).toBe('object')
  expect(typeof lspPlugin.name).toBe('string')
  expect(lspPlugin.name).toBe(pkg.name.slice('@pneuma/'.length))
  expect(lspPlugin.name).toBe('lsp')
  expect(typeof lspPlugin.apply).toBe('function')
})

// 文档面：这两段是给模型和给维护者的固定入口，删掉就没人知道边界在哪。
test('README 的 Model Experience 与 Known Limitations 两段都在', () => {
  const readme = read('../README.md')
  expect(readme, '缺 ## Model Experience').toContain('## Model Experience')
  expect(readme, '缺 ## Known Limitations').toContain('## Known Limitations')
})

// 位置换算：路径与 URI 能来回转；一基与零基差一，零基行号是非法输入。
test('路径与 URI 能来回转，一基与零基换算不串位', () => {
  const path = fileURLToPath(new URL('../index.ts', import.meta.url))
  expect(samePath(pathToUri(path), path)).toBe(true)
  expect(toProtocolPosition(3, 4)).toStrictEqual({ line: 2, character: 3 })
  expect(toDisplayLine(0)).toBe(1)
  expect(toDisplayCharacter(0)).toBe(1)
  // 零基是非法输入：调用方传 0 说明它把两套坐标搞混了，必须当场炸而不是静默偏移。
  expect(() => toProtocolPosition(0, 1)).toThrow(/一基正整数/)
})

// 报文分帧：带 Content-Length 头，且能原样解回来（含一次喂两块的半包场景）。
test('报文带 Content-Length 头，且能原样解回来', () => {
  const encoded = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' })
  const text = encoded.toString('utf8')
  expect(text).toMatch(/^Content-Length: \d+\r\n\r\n/)
  const decoder = new MessageDecoder()
  // 半包：先喂前 10 个字节，此时不该吐出任何消息；补齐后才解出这一条。
  expect(decoder.push(encoded.subarray(0, 10))).toStrictEqual([])
  const decoded = decoder.push(encoded.subarray(10)) as Array<{ method?: string }>
  expect(decoded.length).toBe(1)
  expect(decoded[0]?.method).toBe('initialize')
})
