/**
 * harness 的 integration 层用例：真内核、真入口 CLI。
 *
 * 这里的第一条用例是 `scripts/todo-reminder-test.mjs` 的「起假服务 + 抓请求体」那段的
 * 移植（第 154-203 行的假端点、第 239-250 行的跑回合逻辑）。为什么要移植而不是照抄断言：
 * 探针验的是 todo 提醒的行为，本文件验的是「harness 起的假端点与真内核能对上」这件更底层
 * 的事——协议只要有一处形状不对，这条用例先红，而不是等某个业务探针红在别处。
 *
 * @module dsc/tests/harness.int.spec
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { bootKernel, fakeLLM, readSessionJsonl, runCli, tempHome, type FakeLLM } from './harness.js'

/** 临时 HOME 的还原栈；用例中途失败时由 afterEach 兜底，免得串味到本文件后面的用例。 */
const restores: Array<() => void> = []

/**
 * 仓库是否落在系统临时目录里：决定「真实主目录」那条反向用例能不能成立。
 *
 * 不能只写 `relative(...).startsWith('..')`：Windows 上仓库与临时目录常常不在同一个盘，
 * `relative()` 此时返回的是绝对路径（`D:\...`），不以前缀 `..` 开头，会被误判成
 * 「在临时目录里」，于是这条用例永远跳过——一条永远不跑的守卫用例比没有更糟。
 */
const REPO_IN_TEMP = (() => {
  const rel = relative(tmpdir(), process.cwd())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
})()

afterEach(() => {
  while (restores.length > 0) restores.pop()!()
})

/** 关假端点；正常路径由用例自己关，这里只兜「用例提前抛了」的底。 */
async function closeQuietly(fake: FakeLLM | undefined): Promise<void> {
  if (fake === undefined) return
  try {
    await fake.close()
  } catch {
    // 主断言已经红了，清理阶段的二次失败只会掩盖原始错误。
  }
}

describe('bootKernel', () => {
  test('真内核 + 假端点：抓到请求体、工具结果回到第二轮、会话落在临时 HOME', async () => {
    const home = tempHome()
    restores.push(home.restore)
    const fake = await fakeLLM({
      turns: [
        // 第一轮让模型立清单：照抄探针里那条真实工具调用（todo_write 的 args 形状）。
        { toolCall: { name: 'todo_write', args: { todos: [{ content: '修掉登录 bug', status: 'in_progress' }] } } },
        '收到',
      ],
    })
    const kernel = await bootKernel({ providerBaseUrl: fake.baseUrl })
    try {
      await kernel.runTurn('第一步：先立清单再动手')
      await kernel.runTurn('第二步')

      // 请求真的发到了假端点，而且带着用户原话：只断言 requestCount 会漏掉「发是发了，
      // 但 messages 被清空」这种请求组装的坏法。
      expect(fake.requestCount).toBeGreaterThanOrEqual(2)
      const first = fake.bodies[0] as Array<{ role?: string; content?: unknown }>
      expect(first.some((message) => message.role === 'user' && String(message.content).includes('第一步'))).toBe(true)

      // 第二轮请求里必须出现第一轮的工具调用与结果：说明工具真执行了、结果回填了。
      const second = JSON.stringify(fake.bodies[1])
      expect(second).toContain('todo_write')
      expect(second).toContain('"role":"tool"')
      expect(second).toContain('call_fake_1')

      // 会话落盘：路径必须在临时 HOME 里，读回来能看到 user 与 tool 记录。
      const sessionPath = (kernel.ctx as { session: { current(): { filePath: string } } }).session.current().filePath
      expect(relative(home.home, sessionPath).startsWith('..')).toBe(false)
      const records = readSessionJsonl(sessionPath)
      expect(records.some((record) => record.type === 'user')).toBe(true)
      expect(records.some((record) => record.type === 'tool' && record.callId === 'call_fake_1')).toBe(true)
    } finally {
      await kernel.dispose()
      await closeQuietly(fake)
    }
    // 内核只允许往临时 HOME 里写。仓库根出现 `.dsc`，说明隔离守卫被绕过（或 cwd 被当成了
    // home）——这条断言直接钉住那个事故形态。
    expect(existsSync(join(process.cwd(), '.dsc'))).toBe(false)
  })

  test.skipIf(REPO_IN_TEMP)('没先建临时 HOME 时拒绝起内核：防止写真实 ~/.dsc', async () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    restores.push(() => {
      if (saved.HOME === undefined) delete process.env.HOME
      else process.env.HOME = saved.HOME
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = saved.USERPROFILE
    })
    // 工作目录不是临时目录：这正是「忘记调 tempHome」时的真实形态。
    process.env.HOME = process.cwd()
    process.env.USERPROFILE = process.cwd()
    await expect(bootKernel({ providerBaseUrl: 'http://127.0.0.1:1' })).rejects.toThrow(/真实主目录/)
  })

  test('providerBaseUrl 不是 http(s) 地址时拒绝', async () => {
    const home = tempHome()
    restores.push(home.restore)
    await expect(bootKernel({ providerBaseUrl: 'file:///tmp/x' })).rejects.toThrow(/providerBaseUrl/)
    await expect(bootKernel({ providerBaseUrl: '' })).rejects.toThrow(/providerBaseUrl/)
  })
})

describe('runCli', () => {
  test('--version 走真入口 bin/dsc.js：退出码 0、无信号、仓库里不留 .dsc', async () => {
    const result = await runCli(['--version'])
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/Pneuma numa \d+\.\d+\.\d+/)
    expect(result.stderr).toBe('')
    // 回归断言：真入口按 HOME（Windows 按 USERPROFILE）找 `~/.dsc`；spawn 时漏传这两个
    // 环境变量、或 cwd 用了仓库根，它就会在仓库里造一个 `.dsc`。这个目录曾经在反向验证
    // 里被造出来过——只靠 `.gitignore` 兜住，会让「测试往仓库里写」这件事长期看不见。
    expect(existsSync(join(process.cwd(), '.dsc'))).toBe(false)
  })

  test('超时后 SIGKILL 并返回，不抛（红不红交给断言）', async () => {
    // 10ms 一定早于 node 冷启动完成；这里验的是「超时路径有返回」而不是 CLI 多快。
    const result = await runCli(['--version'], { timeoutMs: 10 })
    expect(result.timedOut).toBe(true)
    // Windows 的杀树走 `spawnSync('taskkill', …)`，这本身是几十毫秒的外部进程；`--version`
    // 的 node 冷启动同样几十毫秒，谁先到是赛跑（实测会有一小部分概率进程自己以 0 退出，
    // 2026-11-20 本机连跑三次都是这条形态）。所以 Windows 只钉「超时路径有返回、timedOut
    // 为真、没有被信号名骗到」，POSIX 才钉 SIGKILL（`process.kill(-pid, 'SIGKILL')` 是同步的）。
    if (process.platform === 'win32') {
      expect(result.signal).toBeNull()
    } else {
      expect(result.signal).toBe('SIGKILL')
    }
  })

  test('参数或选项传错时同步抛可读的错，不静默起进程', () => {
    expect(() => runCli('--version' as never)).toThrow(/字符串数组/)
    expect(() => runCli(['--version'], { timeoutMs: 0 })).toThrow(/timeoutMs/)
    expect(() => runCli(['--version'], { env: { X: 1 as never } })).toThrow(/环境变量/)
  })
})
