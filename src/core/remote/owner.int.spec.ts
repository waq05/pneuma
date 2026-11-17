/**
 * 主控位（.owner.json）：第二进程拿不到、让出后可再拿、主人死掉的锁能接管——真起子进程验
 * （迁自 `scripts/remote-host-test.mjs` 第 4 节）。
 *
 * ## 被测的是什么
 *
 * `RemoteOwnerLock` 的 `pid + 进程启动时刻指纹`：同一台机器上多个 Pneuma 进程抢同一个
 * `.owner.json`，谁先拿到谁伺服（owner.ts 文件头）。三条事实：
 *   - 同一进程重复 `tryAcquire` 是「本来就是自己的」（刷新端口）；
 *   - 活着的第二个进程抢不到（这就是休眠的依据）——这条**必须起真子进程**验，进程内造
 *     不出「另一个进程」；
 *   - 前任已经死了（或 pid 被回收复用）的锁能被接管：判据不是 pid 还活着，而是
 *     「pid + 启动指纹」这对是否还成立。
 *
 * ## 子进程为什么走 lib 平面（探针原样保留）
 *
 * 子进程要独立 import `RemoteOwnerLock`。spec 自身 import `src`（`@pneuma/runtime` 别名），
 * 但 `src` 的 `.ts` 文件给不了子进程一个可直接 import 的说明符；子进程走
 * `lib/core/remote/owner.js` 的文件 URL（由 `pnpm run build` 保证新鲜）。指纹是
 * `pid + 进程启动时刻`，与模块来自 src 还是 lib 无关，两侧实例读写的是同一份
 * `.owner.json`——这正是探针的原样机制。
 *
 * ## 隔离
 *
 * 锁目录是 tempHome 下的子目录（显式传 dir）；子进程的 HOME/USERPROFILE 也指向它。
 *
 * @module dsc/core/remote/owner.int.spec
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../../tests/harness.js'

/** 临时主目录：必须在任何内核模块被加载之前换好（理由见 prefs.int.spec 文件头）。 */
const home = tempHome('dsc-remote-owner-')

delete process.env['DSC_HOME']

afterAll(() => {
  home.restore()
})

type OwnerModule = typeof import('@pneuma/runtime/core/remote/owner.js')
let mod: OwnerModule

/** 锁目录与子进程要 import 的 lib 模块文件 URL（探针原样：`<cwd>/lib/core/remote/owner.js`）。 */
const lockDir = join(home.home, 'lock')
const ownerUrl = pathToFileURL(join(process.cwd(), 'lib', 'core', 'remote', 'owner.js')).href

/**
 * 起一个真子进程去抢同一把锁：拿得到打 yes、拿不到打 no。
 * 指纹判据在子进程与父进程两侧一致（pid + 进程启动时刻），抢不抢得到由 `.owner.json` 决定。
 */
const childTry = (): { stdout: string; stderr: string } => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { RemoteOwnerLock } = await import(${JSON.stringify(ownerUrl)});` +
        `const lock = new RemoteOwnerLock({ dir: ${JSON.stringify(lockDir)} });` +
        `process.stdout.write(lock.tryAcquire(17321) ? 'yes' : 'no')`,
    ],
    { env: { ...process.env, HOME: home.home, USERPROFILE: home.home }, encoding: 'utf8' },
  )
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 本进程的锁实例（beforeAll 里构造）：探针同款——「同一进程再抢一次还是自己」靠的是
 * **这一个实例**的启动指纹（`birth` 在构造时算定，另造一个实例可能差几毫秒，
 * 就不再是「同一个自己」了）。 */
let lock: InstanceType<OwnerModule['RemoteOwnerLock']>

beforeAll(async () => {
  mod = await import('@pneuma/runtime/core/remote/owner.js')
  lock = new mod.RemoteOwnerLock({ dir: lockDir })
})

describe('主控位（.owner.json）', () => {
  test('本进程先抢到主控位', () => {
    expect(lock.tryAcquire(17321)).toBe(true)
  })

  test('同一进程再抢一次还是自己（刷新端口）', () => {
    expect(lock.tryAcquire(17321)).toBe(true)
  })

  test('第二个进程抢不到（这就是休眠的依据）', () => {
    const second = childTry()
    expect(second.stdout.trim(), second.stdout + second.stderr).toBe('no')
  })

  test('本进程让出之后，第二个进程能拿到', () => {
    lock.release()
    const third = childTry()
    expect(third.stdout.trim(), third.stdout + third.stderr).toBe('yes')
  })

  test('主人已经不在的锁能被接管（pid 回收也骗不过启动指纹）', () => {
    // 子进程已经退出：它留下的锁的 pid 已经死了，新实例必须能接管
    expect(new mod.RemoteOwnerLock({ dir: lockDir }).tryAcquire(17321)).toBe(true)
  })
})
