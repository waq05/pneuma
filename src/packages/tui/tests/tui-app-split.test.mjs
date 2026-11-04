/**
 * 终端界面搬家（src/app → tui 功能包）的静态门禁。
 *
 * 钉三件事：
 *   [a] 组件树在 `src/packages/tui/app/`，旧根 `src/app` 已经不存在；
 *   [b] app 目录里没有任何 `../` 形式的 import——逃出目录就等于把「终端界面」又摊回 src/ 根，
 *       跨界依赖一律走 `@pneuma/runtime/*` 适配包裸名；
 *   [c] 宿主半（tui/index.ts）用相对路径引自己的组件树，不走运行时包的老地址。
 *
 * 只读源文件文本，不跑构建。用法：node --test src/packages/tui/tests/tui-app-split.test.mjs
 *
 * @module dsc/packages/tui/tests/tui-app-split
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const appDir = join(root, 'src/packages/tui/app')
const hostFile = join(root, 'src/packages/tui/index.ts')

/** 递归列出目录下所有 .ts/.tsx 文件（绝对路径）。 */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path)
  }
  return out
}

test('组件树搬进了 tui 包，旧根 src/app 不再存在', () => {
  assert.ok(statSync(appDir).isDirectory(), 'src/packages/tui/app 应当存在且是目录')
  assert.ok(existsSync(join(appDir, 'App.tsx')), 'src/packages/tui/app/App.tsx 应当存在')
  assert.equal(existsSync(join(root, 'src/app')), false, 'src/app 目录必须已经不存在')
})

test('app 目录里没有逃出目录的相对 import', () => {
  const files = walk(appDir)
  assert.ok(files.length > 0, 'app 目录里应当有源文件')
  const offenders = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // '..' 开头就是从 app 目录往外跑（from '../x.js'）。
    const escape = /from '\.\.\//.exec(source)
    if (escape !== null) {
      offenders.push(file + ': ' + escape[0])
      continue
    }
    // 兜底：所有相对说明符都必须是 './' 形式。
    const relative = /from '(\.\.?\/[^']*)'/g
    let match = relative.exec(source)
    while (match !== null) {
      if (!match[1].startsWith('./')) offenders.push(file + ": from '" + match[1] + "'")
      match = relative.exec(source)
    }
  }
  assert.deepEqual(offenders, [], '这些 import 逃出了 app 目录：\n' + offenders.join('\n'))
})

test('宿主半用相对路径引自己的组件树', () => {
  const host = readFileSync(hostFile, 'utf8')
  assert.ok(host.includes("'./app/App.js'"), "tui/index.ts 应当 import './app/App.js'")
  assert.equal(
    host.includes("'@pneuma/runtime/app/App.js'"),
    false,
    'tui/index.ts 不该再走 @pneuma/runtime/app/App.js（组件树已经在自己包里）',
  )
})
