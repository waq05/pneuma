/**
 * desktop-dock 的工作区根授权判定：只钉纯函数，不起真桌面桥。
 *
 * 为什么钉在这：`fs-list` 的 `root` 只能从宿主侧清单里挑，这张清单（会话 cwd + 配置里的
 * `workspaceRoots`）就是全部授权来源。判定写错的方向只有两种——把没授权的目录放进来
 * （越权读盘），或者把配置里合法的根丢掉（功能白配）。两种都在这里用纯函数断言钉住。
 *
 * 依赖 lib 产物：先 `pnpm run build`，再 `node --test` 或 `node scripts/package-tests.mjs`。
 *
 * @module @pneuma/desktop-dock/tests/workspace-roots
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { after, test } from 'node:test'

// 自检跑临时 DSC_HOME：绝不让测试碰到用户真实的 ~/.dsc/config.yaml。
const tempHome = mkdtempSync(join(tmpdir(), 'dsc-dock-roots-'))
process.env.DSC_HOME = tempHome
const configFile = join(tempHome, 'config.yaml')
const cwd = join(tempHome, 'cwd')
const extra = join(tempHome, 'extra')
const missing = join(tempHome, 'missing')
mkdirSync(cwd, { recursive: true })
mkdirSync(extra, { recursive: true })

// 必须在设置 DSC_HOME 之后才 import：path-policy 的 DSC_HOME 是模块加载时算的。
const config = await import('../../../../lib/core/config.js')

let passed = 0

/** 写一份 config.yaml；传 null 表示不写这个键（整份只有 providers）。 */
function writeConfig(workspaceRoots) {
  if (workspaceRoots === null) {
    writeFileSync(configFile, 'providers: {}\n', 'utf8')
    return
  }
  const lines = ['workspaceRoots:', ...workspaceRoots.map((entry) => `  - ${JSON.stringify(entry)}`)]
  writeFileSync(configFile, `${lines.join('\n')}\n`, 'utf8')
}

/** 一次读取的规范化比较键（与实现的判定同口径，测试里单独写一遍防实现自证）。 */
const keyOf = (path) => resolve(path).replace(/[\\/]+$/, '').toLowerCase()

test('cwd 恒在第一位，配置里存在的根跟在后头，不存在的被丢弃', () => {
  writeConfig([extra, missing])
  const roots = config.allowedWorkspaceRoots(cwd)
  assert.equal(roots[0], resolve(cwd), '第一个根必须是会话 cwd')
  assert.equal(roots.length, 2, '只该多出配置里那个存在的根')
  assert.equal(roots[1], resolve(extra))
  const read = config.readWorkspaceRootsConfig()
  assert.deepEqual(read.roots, [resolve(extra)])
  assert.deepEqual(read.invalid, [missing], '不存在的条目要留原文给设置页提示')
  passed += 1
})

test('大小写与尾分隔符归一后去重', () => {
  const variants =
    process.platform === 'win32'
      ? [extra, extra + sep, extra.toUpperCase()]
      : [extra, extra + sep, `${extra}/`]
  writeConfig(variants)
  assert.equal(config.sameWorkspaceRoot(extra, extra + sep), true)
  const roots = config.allowedWorkspaceRoots(cwd)
  assert.equal(roots.length, 2, `重复根没去掉：${roots.join(' | ')}`)
  assert.equal(new Set(roots.map(keyOf)).size, roots.length, '返回的根必须两两不同')
  passed += 1
})

test('坏值不抛：非数组、空串、不存在目录都被丢弃', () => {
  const bodies = [
    'workspaceRoots: 42',
    'workspaceRoots: ""',
    'workspaceRoots: {}',
    'workspaceRoots:',
    'workspaceRoots:\n  - 42\n  - null',
    'workspaceRoots: [""]',
  ]
  for (const body of bodies) {
    writeFileSync(configFile, `${body}\n`, 'utf8')
    let read
    assert.doesNotThrow(() => {
      read = config.readWorkspaceRootsConfig()
    }, `坏值 ${JSON.stringify(body)} 不该抛`)
    assert.deepEqual(read.roots, [], `坏值 ${JSON.stringify(body)} 不该产生根`)
    assert.deepEqual(read.invalid, [], `坏值 ${JSON.stringify(body)} 不该进 invalid`)
    assert.deepEqual(config.allowedWorkspaceRoots(cwd), [resolve(cwd)])
  }
  // 不存在目录：不抛、进 invalid、不授权。
  writeConfig([missing])
  const read = config.readWorkspaceRootsConfig()
  assert.deepEqual(read.roots, [])
  assert.deepEqual(read.invalid, [missing])
  passed += 1
})

test('不在清单里的 root 被拒，清单里的根与 cwd 放行', () => {
  writeConfig([extra])
  assert.equal(config.matchWorkspaceRoot(extra, cwd), resolve(extra), '配置里的根应放行')
  assert.equal(config.matchWorkspaceRoot(extra + sep, cwd), resolve(extra), '尾分隔符不该影响授权')
  assert.equal(config.matchWorkspaceRoot(cwd, cwd), resolve(cwd), '会话 cwd 恒放行')
  assert.equal(config.matchWorkspaceRoot(missing, cwd), null, '不在清单里的路径必须拒')
  assert.equal(config.matchWorkspaceRoot(join(extra, 'sub'), cwd), null, '子目录不能借根扩权')
  passed += 1
})

test('文本保存写回 workspaceRoots，分号也能分隔', () => {
  const saved = config.writeWorkspaceRootsConfig(`${extra};${missing}`)
  assert.deepEqual(saved.roots, [resolve(extra)])
  assert.deepEqual(saved.invalid, [missing])
  const read = config.readWorkspaceRootsConfig()
  assert.deepEqual(read.raw, [extra, missing], '原文要原样留着')
  assert.ok(readFileSync(configFile, 'utf8').includes('workspaceRoots'), '配置里要真的落盘')
  passed += 1
})

after(() => {
  rmSync(tempHome, { recursive: true, force: true })
  console.log(`通过 ${String(passed)} 项`)
})
