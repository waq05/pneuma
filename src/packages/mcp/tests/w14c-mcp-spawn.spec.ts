/**
 * mcp 协议层的 W14-C 补测：`StdioChannel.request` 的「子进程输入口已经关了」分支。
 *
 * `packages/mcp/mcp.ts` 里这条分支只有父进程这一侧的 `child.stdin` 被毁时才走到；
 * 真子进程自己 destroy stdin 只会让父进程写到 EPIPE（走另一条写失败分支）。所以这里把
 * `node:child_process` 的 `spawn` 换成一个假的 ChildProcess：stdin 一创建就已经是
 * `destroyed`，其余管道挂空监听。
 *
 * 注入的是模块（`vi.mock`），不是产品代码；断言只看 `openConnection` 给出的失败原因。
 *
 * @module dsc/packages/mcp/tests/w14c-mcp-spawn
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'

/** 假 ChildProcess：只有 `StdioChannel` 构造与 request 会碰到的那些成员。 */
interface FakeChild {
  pid: number
  exitCode: number | null
  stdout: { on(): void }
  stderr: { on(): void }
  stdin: { destroyed: boolean; on(): void; write(): void }
  on(): void
  kill(): void
}

const spawnState = vi.hoisted(() => ({ child: undefined as unknown }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: () => spawnState.child,
  }
})

beforeEach(() => {
  const child: FakeChild = {
    pid: 4242,
    exitCode: null,
    stdout: { on() {} },
    stderr: { on() {} },
    stdin: { destroyed: true, on() {}, write() {} },
    on() {},
    kill() {},
  }
  spawnState.child = child as unknown as ChildProcess
})

afterEach(() => {
  spawnState.child = undefined
})

describe('stdio 通道的输入口', () => {
  test('父进程这侧的 stdin 已被毁：请求当场回「输入口已经关了」', async () => {
    const { openConnection } = await import('../mcp.js')
    await expect(
      openConnection(
        {
          name: 'fake',
          transport: 'stdio',
          command: process.execPath,
          args: [],
          cwd: '',
          env: {},
          url: '',
          headers: {},
          risk: {},
          defaultRisk: 'read',
        },
        { connectTimeoutMs: 2_000, callTimeoutMs: 2_000, onClose: () => {} },
      ),
    ).rejects.toThrow(/输入口已经关了/)
  })
})
