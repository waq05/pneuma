/**
 * 路径护栏要跟真实路径走（2026-10-30）：软链/junction 不能绕过读禁、写硬拒与「说明书必确认」。
 *
 * 为什么单开一条：以前 `readBlockReason` 只看字面路径的basename与目录片段，
 * 把 `~/.ssh/id_rsa` 软链成 `notes.txt` 再读就整张读禁清单形同虚设；写侧同理——
 * 一条指到 `~/.dsc/settings.json` 的软链能让「改配置文件必须当面确认」失效。
 * Windows 上**文件**软链要管理员或开发者模式，**目录 junction** 不需要，所以这条洞
 * 在默认环境里真实可达（本探针就用 junction 复现，不依赖提权）。
 *
 * 钉住五件事：
 *   [1] junction 指到含禁用目录片段的真实目录：读要拒，理由里点名那截目录；
 *   [2] 普通文件照旧放行（修复不能变成「一律拒」）；
 *   [3] 写硬拒：经 junction 写到 dsc 的凭据文件同样拦（字面路径看不出来）；
 *   [4] 「说明书必确认」：经 junction 指到 `<DSC_HOME>/settings.json` 要按 dsc 控制文件拦，
 *       不能因为字面路径在工作区外就当成「别的软件的 settings.json」豁免掉；
 *   [5] 读账本按真实路径记：从软链读、按真实路径整写，不再误报「没读过就整写」。
 *
 * 隔离：临时 HOME（DSC_HOME 也跟着它），真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/path-symlink-test.mjs
 *
 * @module dsc/scripts/path-symlink-test
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-path-link-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
const dscHome = process.env.DSC_HOME
mkdirSync(dscHome, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`  PASS ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

/** 建一个目录 junction（Windows 不需要提权；非 Windows 用普通软链）。 */
function linkDir(target, link) {
  // 链接本身的父目录要先存在
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

const ws = join(home, 'ws')
mkdirSync(ws, { recursive: true })
// 真实目录的路径里带一个读禁片段（凭据存放区）
const vaultDir = join(home, 'secrets', 'vault')
mkdirSync(vaultDir, { recursive: true })
writeFileSync(join(vaultDir, 'notes.txt'), '真实内容', 'utf8')

const { isInsideCwd, isProtectedInstruction, noteRead, readBlockReason, staleOverwriteReason, writeHardBlockReason } = await import(
  '../lib/core/path-policy.js'
)

console.log('路径护栏跟随真实路径')

// ── [1] junction 指向禁用目录：读要拒 ────────────────────────────────────────
const vaultLink = join(ws, 'vault-link')
linkDir(vaultDir, vaultLink)
{
  const literalOnly = join(ws, 'notes.txt')
  const viaLink = join(vaultLink, 'notes.txt')
  check('对照：工作区里的普通文件照旧允许读', readBlockReason(literalOnly) === null, String(readBlockReason(literalOnly)))
  const verdict = readBlockReason(viaLink)
  check('junction 指到 vault 目录：读被拒', verdict !== null, String(verdict))
  check('拒绝理由点名那截禁用目录', typeof verdict === 'string' && verdict.includes('vault'), String(verdict))
}

// ── [2] 写硬拒：经 junction 写 dsc 凭据文件 ─────────────────────────────────
const dscLink = join(ws, 'dsc-link')
linkDir(dscHome, dscLink)
{
  const viaLink = join(dscLink, 'credentials.yaml')
  check('对照：工作区里的普通文件写入不硬拒', writeHardBlockReason(join(ws, '普通.txt')) === null)
  const verdict = writeHardBlockReason(viaLink)
  check('junction 指到 <DSC_HOME>/credentials.yaml：写被硬拒', verdict !== null, String(verdict))
  check('理由说明这是 dsc 的凭据文件', typeof verdict === 'string' && verdict.includes('凭据'), String(verdict))
}

// ── [3] 说明书必确认：junction 指到 <DSC_HOME>/settings.json ────────────────
{
  writeFileSync(join(dscHome, 'settings.json'), '{}', 'utf8')
  const viaLink = join(dscLink, 'settings.json')
  const literal = join(home, 'other-app', 'settings.json')
  check('对照：工作区外的 settings.json 仍按「别的软件的」豁免', isProtectedInstruction(literal, ws) === null, String(isProtectedInstruction(literal, ws)))
  const verdict = isProtectedInstruction(viaLink, ws)
  check('junction 指到 dsc 的 settings.json：按 dsc 控制文件拦', verdict !== null, String(verdict))
  check('理由说明这是 dsc 的控制文件', typeof verdict === 'string' && verdict.includes('控制文件'), String(verdict))
}

// ── [4] 读账本按真实路径记 ───────────────────────────────────────────────────
{
  const realDir = join(home, 'shared')
  mkdirSync(realDir, { recursive: true })
  const realFile = join(realDir, 'real.txt')
  writeFileSync(realFile, '原始内容', 'utf8')
  const aliasLink = join(ws, 'shared-link')
  linkDir(realDir, aliasLink)
  const viaLink = join(aliasLink, 'real.txt')
  noteRead(viaLink, 'sess-1')
  check('从软链读、按真实路径整写：不再误报「没读过」', staleOverwriteReason(realFile, 'sess-1') === null, String(staleOverwriteReason(realFile, 'sess-1')))
  const neverRead = join(home, 'other.txt')
  writeFileSync(neverRead, '没读过', 'utf8')
  check('对照：存在但完全没读过的文件照样要拦', staleOverwriteReason(neverRead, 'sess-1') !== null, String(staleOverwriteReason(neverRead, 'sess-1')))
  check('软链目标确实在工作区外（isInsideCwd 跟着真实路径判）', isInsideCwd(ws, join(aliasLink, 'real.txt')) === false)
}

console.log('')
console.log(`${String(pass)} PASS / ${String(fail)} FAIL`)
process.exit(fail === 0 ? 0 : 1)
