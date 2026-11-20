/**
 * `core/remote/**` 里只在集成层跑过、单元层看不见的几行（W14）。
 *
 * 这几支（票据表、主控位、帧表、上传目录、配对码计数）都不碰网络也不起服务，
 * 构造出来直接调就行；之所以单元报告上是空白，是因为它们先前的探针都写成
 * `*.int.spec.ts`（走 integration project，不计入 `--project unit` 的覆盖率）。
 *
 * 所有落盘都指到 `createTempDir` 的临时目录，不碰真实 `~/.dsc`。
 *
 * @module dsc/core/remote/w14-remote-gaps.spec
 */
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createTempDir } from '../../../tests/support/tmp-dir.js'
import { RemoteFrameHub } from './frames.js'
import { RemoteOwnerLock } from './owner.js'
import { RemotePairing } from './pairing.js'
import { TicketStore } from './tickets.js'
import { RemoteUploads } from './uploads.js'

const HOME = createTempDir('dsc-w14-remote-')
let seq = 0

/** 每个用例一份子目录（远程数据文件互不干扰）。 */
function subDir(): string {
  seq += 1
  return join(HOME, `case-${String(seq)}`)
}

describe('帧表：还没造过帧时的读数', () => {
  test('新表 lastSeq 是 0', () => {
    expect(new RemoteFrameHub().lastSeq).toBe(0)
  })
})

describe('主控位：本进程没抢之前不是 mine', () => {
  test('新锁 mine 为 false（peek 读不到主人时给 null）', () => {
    const lock = new RemoteOwnerLock({ dir: subDir(), now: () => 1_000 })
    expect(lock.mine).toBe(false)
    expect(lock.peek()).toBeNull()
  })
})

describe('一次性票据表', () => {
  test('size 只看还没过期的票；取走即焚，第二次拿不到', () => {
    let now = 1_000
    const store = new TicketStore(30_000, () => now)
    expect(store.size).toBe(0)
    const ticket = store.issue('dev-1')
    expect(store.size).toBe(1)
    expect(store.redeem(ticket)).toEqual({ deviceId: 'dev-1' })
    expect(store.redeem(ticket)).toBeNull()
    expect(store.size).toBe(0)
    // 过期票在 size 里先被 prune 掉。
    const stale = store.issue('dev-2')
    now += 30_001
    expect(store.size).toBe(0)
    expect(store.redeem(stale)).toBeNull()
  })
})

describe('上传目录', () => {
  test('root 就是构造时给的目录；目录不存在时 files() 给空表而不是抛错', () => {
    const dir = subDir()
    const uploads = new RemoteUploads({ dir, now: () => 0 })
    expect(uploads.root).toBe(dir)
    // 一次都没写过：readdirSync 必然 ENOENT，被吞成空表。
    expect(uploads.files()).toEqual([])
    expect(uploads.totalBytes()).toBe(0)
  })
})

describe('配对码：活码计数', () => {
  test('没有码时是 0；发一张后是 1（过期后回到 0）', () => {
    let now = 1_000
    const dir = subDir()
    const pairing = new RemotePairing({ dir, now: () => now })
    expect(pairing.liveCodeCount()).toBe(0)
    const issued = pairing.issueCode({ replace: true })
    expect(issued).not.toBeNull()
    expect(pairing.liveCodeCount()).toBe(1)
    now += 24 * 60 * 60_000
    expect(pairing.liveCodeCount()).toBe(0)
  })
})
