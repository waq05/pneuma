/**
 * 受限令牌后端「按每次调用算可写根」（integration 层，原 `scripts/sandbox-write-roots-test.mjs`）。
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
 * ## 为什么归 integration
 *
 * `writeRootsFor` 读 `core/path-policy.ts` 的 `DSC_HOME`，那是模块加载时算定的常量；
 * 这里靠 integration 层的 `tests/setup/temp-home.ts` 保证导入前 HOME 已经是临时目录，
 * 真实 `~/.dsc` 一个字节都不动。
 *
 * 平台无关：路径拼接用 `node:path`，断言只看「两个路径不同 / 是前缀关系」，不写死
 * `\\` 或 `/`——这正是旧探针在 Linux 上会红的那类写法。
 *
 * @module @pneuma/sandbox/win/write-roots.int.spec
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { DSC_HOME } from '@pneuma/runtime/core/path-policy.js'
import { writeRootsFor } from './backend.js'

/** 本文件自己建的工作区目录（挂在临时 HOME 下，跑完删）。 */
const created: string[] = []
const wsA = join(DSC_HOME, '..', 'ws-a')
const wsB = join(DSC_HOME, '..', 'ws-b')
for (const dir of [wsA, wsB]) {
  mkdirSync(dir, { recursive: true })
  created.push(dir)
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

describe('① 两个会话各得一套可写根', () => {
  const a = writeRootsFor(wsA)
  const b = writeRootsFor(wsB)

  test('一个工作区得到 root + temp 两项', () => {
    expect(a).toHaveLength(2)
  })

  test('第一项是工作区（side=root）', () => {
    expect(a[0]?.path).toBe(wsA)
    expect(a[0]?.side).toBe('root')
  })

  test('两个会话的工作区不同', () => {
    expect(a[0]?.path).not.toBe(b[0]?.path)
  })

  test('两个会话的临时目录也不同（以前共用一个）', () => {
    // 共用一个临时目录意味着 A 会话能读 B 会话落盘的溢出/临时文件。
    expect(a[1]?.path).not.toBe(b[1]?.path)
  })
})

describe('② 临时目录的位置与 SID 区分', () => {
  const a = writeRootsFor(wsA)

  test('临时目录在 <DSC_HOME>/sandbox/tmp 下', () => {
    expect(a[1]?.path.startsWith(join(DSC_HOME, 'sandbox', 'tmp'))).toBe(true)
  })

  test('临时目录 side=temp', () => {
    expect(a[1]?.side).toBe('temp')
  })

  test('工作区与临时目录的能力 SID 不同', () => {
    // 同号会让 temp 目录同时拿到工作区的能力，temp 就不算「私有」了。
    expect(a[0]?.sid).not.toBe(a[1]?.sid)
  })

  test('同一路径的 SID 稳定（两次调用一致）', () => {
    expect(writeRootsFor(wsA)[1]?.sid).toBe(a[1]?.sid)
  })
})

describe('③ 附加可写根', () => {
  const extra = join(DSC_HOME, '..', 'extra-root')
  mkdirSync(extra, { recursive: true })
  created.push(extra)

  test('附加根带进来，空串跳过', () => {
    // 空白项来自设置页里一行没填完；把它当成路径会算出一个以 DSC_HOME 为基准的怪根。
    expect(writeRootsFor(wsA, [extra, '   ', extra + '/'])).toHaveLength(3)
  })

  test('附加根的 side=root', () => {
    expect(writeRootsFor(wsA, [extra])[2]?.side).toBe('root')
  })

  test('尾分隔符被归一（两种写法去重成一个根）', () => {
    const list = writeRootsFor(wsA, [extra, extra + '/'])
    expect(list.filter((item) => item.path === extra)).toHaveLength(1)
  })

  test('工作区带尾分隔符也认成同一个根', () => {
    expect(writeRootsFor(wsA + '/')[0]?.path).toBe(wsA)
  })
})
