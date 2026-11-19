/**
 * desktop-dock 的工作区根授权判定：只钉纯函数，不起真桌面桥。
 *
 * 为什么钉在这：`fs-list` 的 `root` 只能从宿主侧清单里挑，这张清单（会话 cwd + 配置里的
 * `workspaceRoots`）就是全部授权来源。判定写错的方向只有两种——把没授权的目录放进来
 * （越权读盘），或者把配置里合法的根丢掉（功能白配）。两种都在这里用纯函数断言钉住。
 *
 * 迁移说明（D2）：旧文件用 `node:test` + `node:assert`，`pass` 计数与 `after` 里的打印
 * 一并删掉（Vitest 自己算）。装载面从 `lib/core/config.js`、`lib/packages/desktop-dock/
 * index.js` 这两个构建产物改成源码 `@pneuma/runtime/core/config.js` 与 `../index.js`。
 * `DSC_HOME` 仍必须在 import 前指向临时目录：`path-policy` 在模块加载时算它。
 * 七条用例与新文件一一对应，一条没删。
 *
 * @module @pneuma/desktop-dock/tests/workspace-roots
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { WorkspaceRootsConfig } from '@pneuma/runtime/core/config.js'
import { afterAll, beforeAll, expect, test } from 'vitest'

// 自检跑临时 DSC_HOME：绝不让测试碰到用户真实的 ~/.dsc/config.yaml。
const tempHome = mkdtempSync(join(tmpdir(), 'dsc-dock-roots-'))
const configFile = join(tempHome, 'config.yaml')
const cwd = join(tempHome, 'cwd')
const extra = join(tempHome, 'extra')
const missing = join(tempHome, 'missing')
mkdirSync(cwd, { recursive: true })
mkdirSync(extra, { recursive: true })

let config: typeof import('@pneuma/runtime/core/config.js')
let dock: typeof import('../index.js')

beforeAll(async () => {
  // 必须在设置 DSC_HOME 之后才 import：path-policy 的 DSC_HOME 是模块加载时算的。
  process.env.DSC_HOME = tempHome
  config = await import('@pneuma/runtime/core/config.js')
  // 路径围栏是纯函数，单独导出就是为了在这里钉住 UNC / \\?\ 这类绕过（2026-11 第二次审查）。
  dock = await import('../index.js')
})

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(tempHome, { recursive: true, force: true })
})

/** 写一份 config.yaml；传 null 表示不写这个键（整份只有 providers）。 */
function writeConfig(workspaceRoots: readonly string[] | null): void {
  if (workspaceRoots === null) {
    writeFileSync(configFile, 'providers: {}\n', 'utf8')
    return
  }
  const lines = ['workspaceRoots:', ...workspaceRoots.map((entry) => `  - ${JSON.stringify(entry)}`)]
  writeFileSync(configFile, `${lines.join('\n')}\n`, 'utf8')
}

/** 一次读取的规范化比较键（与实现的判定同口径，测试里单独写一遍防实现自证）。 */
const keyOf = (path: string): string => resolve(path).replace(/[\\/]+$/, '').toLowerCase()

test('cwd 恒在第一位，配置里存在的根跟在后头，不存在的被丢弃', () => {
  writeConfig([extra, missing])
  const roots = config.allowedWorkspaceRoots(cwd)
  expect(roots[0], '第一个根必须是会话 cwd').toBe(resolve(cwd))
  expect(roots.length, '只该多出配置里那个存在的根').toBe(2)
  expect(roots[1]).toBe(resolve(extra))
  const read = config.readWorkspaceRootsConfig()
  expect(read.roots).toEqual([resolve(extra)])
  expect(read.invalid, '不存在的条目要留原文给设置页提示').toEqual([missing])
})

test('大小写与尾分隔符归一后去重', () => {
  const variants =
    process.platform === 'win32' ? [extra, extra + sep, extra.toUpperCase()] : [extra, extra + sep, `${extra}/`]
  writeConfig(variants)
  expect(config.sameWorkspaceRoot(extra, extra + sep)).toBe(true)
  const roots = config.allowedWorkspaceRoots(cwd)
  expect(roots.length, `重复根没去掉：${roots.join(' | ')}`).toBe(2)
  expect(new Set(roots.map(keyOf)).size, '返回的根必须两两不同').toBe(roots.length)
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
    let read: WorkspaceRootsConfig | undefined
    expect(() => {
      read = config.readWorkspaceRootsConfig()
    }, `坏值 ${JSON.stringify(body)} 不该抛`).not.toThrow()
    expect(read?.roots, `坏值 ${JSON.stringify(body)} 不该产生根`).toEqual([])
    expect(read?.invalid, `坏值 ${JSON.stringify(body)} 不该进 invalid`).toEqual([])
    expect(config.allowedWorkspaceRoots(cwd)).toEqual([resolve(cwd)])
  }
  // 不存在目录：不抛、进 invalid、不授权。
  writeConfig([missing])
  const read = config.readWorkspaceRootsConfig()
  expect(read.roots).toEqual([])
  expect(read.invalid).toEqual([missing])
})

test('不在清单里的 root 被拒，清单里的根与 cwd 放行', () => {
  writeConfig([extra])
  expect(config.matchWorkspaceRoot(extra, cwd), '配置里的根应放行').toBe(resolve(extra))
  expect(config.matchWorkspaceRoot(extra + sep, cwd), '尾分隔符不该影响授权').toBe(resolve(extra))
  expect(config.matchWorkspaceRoot(cwd, cwd), '会话 cwd 恒放行').toBe(resolve(cwd))
  expect(config.matchWorkspaceRoot(missing, cwd), '不在清单里的路径必须拒').toBeNull()
  expect(config.matchWorkspaceRoot(join(extra, 'sub'), cwd), '子目录不能借根扩权').toBeNull()
})

test('workspacePathInside：UNC / \\\\?\\ / .. 都不算根内（2026-11 第二次审查的安全洞）', () => {
  expect(dock.workspacePathInside(join(cwd, 'a.txt'), cwd), '根内文件要放行').toBe(true)
  expect(dock.workspacePathInside(join(cwd, 'sub', 'b.txt'), cwd), '根内子目录要放行').toBe(true)
  expect(dock.workspacePathInside(join(cwd, '..', 'outside.txt'), cwd), '.. 越界要拒').toBe(false)
  // 这三条是这次的洞：`relative()` 对它们返回的是**绝对路径**（首段为空、也不带冒号），
  // 旧实现只看「首段有没有冒号」，于是判了 true，fs-list / fs-read 能列出、读到任意目录。
  const outside = ['\\\\srv\\share\\x', '\\\\?\\C:\\Windows', join(cwd, '..', '..', 'x')]
  for (const path of outside) {
    expect(dock.workspacePathInside(path, cwd), `${path} 不该算根内`).toBe(false)
  }
})

test('互相嵌套的根按 realpath 收成一份：主根保留，包住主根的根也保留', () => {
  const nested = join(cwd, 'inner')
  mkdirSync(nested, { recursive: true })
  writeConfig([nested, extra])
  const roots = config.allowedWorkspaceRoots(cwd)
  expect(roots, `被 cwd 包含的根不该单独列：${roots.join(' | ')}`).toEqual([resolve(cwd), resolve(extra)])
  // 反方向：配置根包住 cwd（父目录）时不丢——它是更大范围的授权，去掉会连带丢掉兄弟目录；
  // @ 补全列清单时由 core/mention.ts 跳过主根子树，不会把主根文件列两遍。
  writeConfig([tempHome])
  const outer = config.allowedWorkspaceRoots(cwd)
  expect(resolve(outer[0] as string), '主根必须仍在第一位').toBe(resolve(cwd))
  expect(outer.some((root) => resolve(root) === resolve(tempHome)), `包住 cwd 的根不该被丢：${outer.join(' | ')}`).toBe(
    true,
  )
})

test('文本保存写回 workspaceRoots，分号也能分隔', () => {
  const saved = config.writeWorkspaceRootsConfig(`${extra};${missing}`)
  expect(saved.roots).toEqual([resolve(extra)])
  expect(saved.invalid).toEqual([missing])
  const read = config.readWorkspaceRootsConfig()
  expect(read.raw, '原文要原样留着').toEqual([extra, missing])
  expect(readFileSync(configFile, 'utf8'), '配置里要真的落盘').toContain('workspaceRoots')
})
