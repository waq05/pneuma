/**
 * 受限令牌后端「按每次调用算可写根」（2026-10-30）。
 *
 * 以前可写根在挂载时按当时那个会话钉死：常驻多会话里，后台会话在**自己**的工作区写东西
 * 会被 ACL 挡住（当成越界），而当前查看会话的工作区反倒被永久授权。现在每次调用按
 * `run.cwd` 现算：工作区一个 root SID、它的私有临时目录一个 temp SID，附加根照配置带进来。
 *
 * 这一节只钉「算出来的清单对不对」（纯函数，不建令牌、不动 ACL）：
 *   [1] 两个不同会话的工作区各得一套根，临时目录不同（不再共用一个）；
 *   [2] 临时目录落在 <DSC_HOME>/sandbox/tmp 下，且与工作区是两个不同的能力 SID；
 *   [3] 附加可写根按配置带进来，重复/带尾分隔符的写法归一；
 *   [4] root 与 temp 两种 SID 永不同号（同一路径也不会撞）。
 *
 * 隔离：临时 DSC_HOME，真实 ~/.dsc 一个字节都不动。
 * 用法：pnpm run build && node scripts/sandbox-write-roots-test.mjs
 *
 * @module dsc/scripts/sandbox-write-roots-test
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsc-sandbox-roots-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
const dscHome = process.env.DSC_HOME

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

const { writeRootsFor } = await import('../lib/core/sandbox/win/backend.js')

const wsA = join(home, 'ws-a')
const wsB = join(home, 'ws-b')

console.log('受限令牌的可写根按调用算')

// ── [1] 两个会话各得一套 ─────────────────────────────────────────────────────
{
  const a = writeRootsFor(wsA)
  const b = writeRootsFor(wsB)
  check('一个工作区得到 root + temp 两项', a.length === 2, JSON.stringify(a))
  check('第一项是工作区（side=root）', a[0].path === wsA && a[0].side === 'root', JSON.stringify(a[0]))
  check('两个会话的工作区不同', a[0].path !== b[0].path)
  check('两个会话的临时目录也不同（以前共用一个）', a[1].path !== b[1].path, `${a[1].path} / ${b[1].path}`)
}

// ── [2] 临时目录的位置与 SID 区分 ───────────────────────────────────────────
{
  const a = writeRootsFor(wsA)
  check('临时目录在 <DSC_HOME>/sandbox/tmp 下', a[1].path.startsWith(join(dscHome, 'sandbox', 'tmp')), a[1].path)
  check('临时目录 side=temp', a[1].side === 'temp')
  check('工作区与临时目录的能力 SID 不同', a[0].sid !== a[1].sid, `${a[0].sid} / ${a[1].sid}`)
  check('同一路径的 SID 稳定（两次调用一致）', writeRootsFor(wsA)[1].sid === a[1].sid)
}

// ── [3] 附加可写根 ──────────────────────────────────────────────────────────
{
  const extra = join(home, 'extra-root')
  const list = writeRootsFor(wsA, [extra, '   ', extra + '/'])
  check('附加根带进来（空串跳过）', list.length === 3, JSON.stringify(list.map((item) => item.path)))
  check('附加根的 side=root', list[2].side === 'root')
  check('尾分隔符被归一（两种写法去重成一个根）', list.filter((item) => item.path === extra).length === 1, JSON.stringify(list.map((item) => item.path)))
  check('工作区带尾分隔符也认成同一个根', writeRootsFor(wsA + '/')[0].path === wsA, writeRootsFor(wsA + '/')[0].path)
}

console.log('')
console.log(`${String(pass)} PASS / ${String(fail)} FAIL`)
process.exit(fail === 0 ? 0 : 1)
