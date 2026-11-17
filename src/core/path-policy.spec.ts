/**
 * 路径护栏要跟真实路径走（迁自 `scripts/path-symlink-test.mjs`，纯函数，不需要 build）。
 *
 * ## 为什么单开一条
 *
 * 以前 `readBlockReason` 只看字面路径的 basename 与目录片段：把 `~/.ssh/id_rsa` 软链成
 * `notes.txt` 再读，整张读禁清单就形同虚设；写侧同理——一条指到 `~/.dsc/settings.json`
 * 的软链能让「改配置文件必须当面确认」失效。
 *
 * Windows 上**文件**软链要管理员或开发者模式，**目录 junction** 不需要，所以这条洞在
 * 默认环境里真实可达。这里用 junction 复现，不依赖提权；POSIX 上退化成普通目录软链。
 *
 * ## 钉住四件事
 *
 *   ① junction 指到含禁用目录片段的真实目录：读要拒，理由里点名那截目录；
 *      普通文件照旧放行（修复不能变成「一律拒」）。
 *   ② 写硬拒：经 junction 写到 dsc 的凭据文件同样拦（字面路径看不出来）。
 *   ③ 「说明书必确认」：经 junction 指到 `<DSC_HOME>/settings.json` 要按 dsc 控制文件拦，
 *      不能因为字面路径在工作区外就当成「别的软件的 settings.json」豁免掉。
 *   ④ 读账本按真实路径记：从软链读、按真实路径整写，不再误报「没读过就整写」。
 *
 * ## 隔离
 *
 * `DSC_HOME` 是 `path-policy` 的模块顶层常量，所以 `tempHome()` 必须在它被加载之前调用，
 * 模块一律动态 import；临时目录里的 `~/.dsc` 就是这一跑的 DSC_HOME，真实 `~/.dsc` 不动。
 *
 * @module dsc/core/path-policy.spec
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录：DSC_HOME 从它派生，必须在动态 import 之前换好。 */
const home = tempHome('dsc-path-link-')
/** dsc 自己的配置目录 = 这一跑的 `~/.dsc`。 */
const dscHome = join(home.home, '.dsc')
/** 工作目录（正常读写都在这儿）。 */
const ws = join(home.home, 'ws')
/** 真实路径里带一个读禁片段（`vault`）的目录。 */
const vaultDir = join(home.home, 'secrets', 'vault')
/** 和 vaultDir 指向同一个真实目录的 junction。 */
const vaultLink = join(ws, 'vault-link')
/** 指到 `<DSC_HOME>` 的 junction：凭据文件与 settings.json 都从这里走。 */
const dscLink = join(ws, 'dsc-link')

type PathPolicy = typeof import('./path-policy.js')
let policy: PathPolicy

/** 建一个目录 junction（Windows 不需要提权；非 Windows 用普通目录软链）。 */
function linkDir(target: string, link: string): void {
  // 链接本身的父目录要先存在。
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

beforeAll(async () => {
  process.env['DSC_HOME'] = dscHome
  // 铺现场：工作区、带读禁片段的真实目录、以及指向 DSC_HOME 的 junction。
  mkdirSync(ws, { recursive: true })
  mkdirSync(vaultDir, { recursive: true })
  mkdirSync(dscHome, { recursive: true })
  writeFileSync(join(vaultDir, 'notes.txt'), '真实内容', 'utf8')
  linkDir(vaultDir, vaultLink)
  linkDir(dscHome, dscLink)
  policy = await import('./path-policy.js')
  // 先确认隔离真的生效，否则下面的断言全在真实主目录上跑。
  expect(policy.DSC_HOME).toBe(dscHome)
})

afterAll(() => {
  delete process.env['DSC_HOME']
  home.restore()
})

describe('① 读禁：junction 指向禁用目录时读数要拒', () => {
  test('对照：工作区里的普通文件照旧允许读（修复没有变成「一律拒」）', () => {
    expect(policy.readBlockReason(join(ws, 'notes.txt'))).toBeNull()
  })

  test('junction 指到 vault 目录：读被拒', () => {
    expect(policy.readBlockReason(join(vaultLink, 'notes.txt'))).not.toBeNull()
  })

  test('拒绝理由点名那截禁用目录（模型据此知道换条路也没用）', () => {
    const reason = policy.readBlockReason(join(vaultLink, 'notes.txt'))
    expect(reason).toContain('vault')
  })
})

describe('② 写硬拒：经 junction 写 dsc 的凭据文件同样拦', () => {
  test('对照：工作区里的普通文件写入不硬拒', () => {
    expect(policy.writeHardBlockReason(join(ws, '普通.txt'))).toBeNull()
  })

  test('junction 指到 <DSC_HOME>/credentials.yaml：写被硬拒', () => {
    expect(policy.writeHardBlockReason(join(dscLink, 'credentials.yaml'))).not.toBeNull()
  })

  test('理由说明这是 dsc 的凭据文件（不是泛泛一句「不允许」）', () => {
    expect(policy.writeHardBlockReason(join(dscLink, 'credentials.yaml'))).toContain('凭据')
  })
})

describe('③ 说明书必确认：junction 指到 <DSC_HOME>/settings.json 不能豁免', () => {
  beforeAll(() => {
    writeFileSync(join(dscHome, 'settings.json'), '{}', 'utf8')
  })

  test('对照：工作区外的 settings.json 仍按「别的软件的」豁免', () => {
    expect(policy.isProtectedInstruction(join(home.home, 'other-app', 'settings.json'), ws)).toBeNull()
  })

  test('junction 指到 dsc 的 settings.json：按 dsc 控制文件拦', () => {
    expect(policy.isProtectedInstruction(join(dscLink, 'settings.json'), ws)).not.toBeNull()
  })

  test('理由说明这是 dsc 的控制文件', () => {
    expect(policy.isProtectedInstruction(join(dscLink, 'settings.json'), ws)).toContain('控制文件')
  })
})

describe('④ 读账本按真实路径记', () => {
  /** 真实文件与指向它所在目录的 junction。 */
  const realDir = join(home.home, 'shared')
  const realFile = join(realDir, 'real.txt')
  const aliasLink = join(ws, 'shared-link')

  beforeAll(() => {
    mkdirSync(realDir, { recursive: true })
    writeFileSync(realFile, '原始内容', 'utf8')
    linkDir(realDir, aliasLink)
  })

  test('从软链读、按真实路径整写：不再误报「没读过」', () => {
    policy.noteRead(join(aliasLink, 'real.txt'), 'sess-1')
    expect(policy.staleOverwriteReason(realFile, 'sess-1')).toBeNull()
  })

  test('对照：存在但完全没读过的文件照样要拦', () => {
    const neverRead = join(home.home, 'other.txt')
    writeFileSync(neverRead, '没读过', 'utf8')
    expect(policy.staleOverwriteReason(neverRead, 'sess-1')).not.toBeNull()
  })

  test('软链目标确实在工作区外（isInsideCwd 跟着真实路径判）', () => {
    expect(policy.isInsideCwd(ws, join(aliasLink, 'real.txt'))).toBe(false)
  })
})
