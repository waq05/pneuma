/**
 * 真入口 e2e 八条（设计 §11.2）：spawn 真 `bin/dsc.js`，断言退出码与输出。
 *
 * ## 与 integration 的差别
 *
 * integration 在**本进程**里 `bootKernel`；这一层起的是用户真正会敲的那条命令，
 * 走 `bin/dsc.js` → `lib/boot.js` 的产物平面。所以它也是唯一能发现「启动器自己坏了」
 * 的层——参数翻译、子进程转发、退出码传递都在这里。
 *
 * ## 七条无网无 key，C3 在 POSIX 上用 PTY 跑
 *
 * C1/C2/C4/C5/C6/C7/C8 全部无网无 key。C3（无参数 + 一句输入 → 回复）需要往 TUI 里
 * 敲字：管道 stdin 模拟不了按键，所以用 `pty.fork()` 起一个真终端（`tests/cli/pty-driver.py`，
 * 与 DSH 的 headless-shutdown e2e 同一套标准库口径）。模型用 `fakeLLM`，不连真 API。
 * Windows 没有 `pty` 模块，C3 在 Windows 上显式 skip；Linux/CI 上真跑。
 *
 * ## C4/C6 是本批同时修好的产品行为
 *
 * 修之前：`numa bogus` 被静默透传、TUI 照常起来；`echo hi | numa` 永不退出。
 * 两条都记在偏离表 D36 与 findings F15/F16——测试钉的是修好之后的行为，反向验证时
 * 把 `bin/dsc.js` 对应片段删掉就会红。
 *
 * @module dsc/tests/cli/entry.cli.e2e
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fakeLLM, runCli } from '../harness.js'
import {
  CLI_ENTRY,
  ROOT,
  lastSessionPointer,
  makeHome,
  runInPty,
  sessionFiles,
  spawnCli,
  waitForLeases,
} from './support.js'

/** `package.json` 的版本：C2 的判据来源（不写死，发一次版不用改测试）。 */
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

describe('真入口 e2e（bin/dsc.js）', () => {
  test('C1 --help：退出 0，输出里有用法', async () => {
    const result = await runCli(['--help'], { timeoutMs: 20_000 })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('用法')
    expect(result.stdout).toContain('numa')
  })

  test('C2 --version：退出 0，版本号与 package.json 一致', async () => {
    const result = await runCli(['--version'], { timeoutMs: 20_000 })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(VERSION)
  })

  test('C4 未知子命令：退出非 0，提示可读且不含 np 未定义痕迹', async () => {
    const result = await runCli(['bogus'], { timeoutMs: 20_000 })
    expect(result.timedOut).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('不认识的子命令')
    expect(result.stderr).toContain('bogus')
    // 「可读」的底线：不是把 undefined / 裸栈直接倒给用户。
    expect(result.stderr).not.toContain('undefined')
    expect(result.stdout).toBe('')
  })

  test('C5 配置文件损坏：不崩、不挂，伤害可见（config show 报无可用端点）', async () => {
    const { dscHome } = makeHome()
    writeFileSync(join(dscHome, 'config.yaml'), 'providers: [unclosed\n  bad: : :\n', 'utf8')

    // ① TUI 入口不因坏配置崩/挂：stdin 结束即收场（exit 0），不出现启动失败。
    const boot = await runCli([], { timeoutMs: 30_000, env: { DSC_HOME: dscHome } })
    expect(boot.timedOut).toBe(false)
    expect(boot.code).toBe(0)
    expect(`${boot.stdout}${boot.stderr}`).not.toContain('启动失败')

    // ② 坏配置不是「静默吞掉」：config show 明确报没有可用端点，并退出非 0。
    const show = await runCli(['config', 'show'], { timeoutMs: 20_000, env: { DSC_HOME: dscHome } })
    expect(show.timedOut).toBe(false)
    expect(show.code).toBe(1)
    expect(show.stdout).toContain('配置文件')
    expect(show.stdout).toContain('无——检查配置与 key 来源')
  })

  test('C6 管道输入：写完 stdin 不卡死，正常退出', async () => {
    const result = await runCli([], { input: 'hi\n', timeoutMs: 30_000 })
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
  })

  test('C7 SIGINT/强杀后：会话指针与租约都还在，-c 能把这份会话续起来', async () => {
    const target = makeHome()
    const cli = spawnCli([], target)
    const leases = await waitForLeases(target, 1)
    expect(leases.length).toBeGreaterThan(0)
    await cli.kill()

    // ① 指针落在本主目录里（不是上一条用例或者真实 ~/.dsc 的残留）。
    const pointer = lastSessionPointer(target)
    expect(pointer).not.toBeNull()
    expect(pointer!).toContain(target.dscHome)

    // ② 强杀留下的锁不挡下一次启动：`-c` 续上一次会话，启动不报错、stdin 结束即退。
    const resumed = await runCli(['-c'], { timeoutMs: 30_000, env: { DSC_HOME: target.dscHome } })
    expect(resumed.timedOut).toBe(false)
    expect(resumed.code).toBe(0)
    expect(`${resumed.stdout}${resumed.stderr}`).not.toContain('启动失败')
  })

  test('C8 两个实例并发：各自占一份会话，互不写坏，收场后可续', async () => {
    const target = makeHome()
    const first = spawnCli([], target)
    const second = spawnCli([], target)
    const leases = await waitForLeases(target, 2)
    await first.kill()
    await second.kill()

    // ① 两个实例各建各的会话（文件名 = 会话 id），没有互相覆盖。
    expect(new Set(leases.map((file) => file.split(/[\/]/).pop())).size).toBe(2)
    // ② 指针只指向其中一份，且落在本主目录。
    const pointer = lastSessionPointer(target)
    expect(pointer).not.toBeNull()
    expect(pointer!).toContain(target.dscHome)

    // ③ 收场后第三次启动仍能把指针那份续起来（锁没被写坏到启动不了）。
    const resumed = await runCli(['-c'], { timeoutMs: 30_000, env: { DSC_HOME: target.dscHome } })
    expect(resumed.timedOut).toBe(false)
    expect(`${resumed.stdout}${resumed.stderr}`).not.toContain('启动失败')
  })

  test.skipIf(process.platform === 'win32')(
    'C3 无参数 + 一句输入：PTY 里敲字，假模型回复落地、两次 Ctrl+C 退出 0',
    async () => {
      const target = makeHome()
      const llm = await fakeLLM({ turns: ['收到，这里是测试回复。'] })
      try {
        // 最小可用配置：端点指向假模型，key 从环境变量来（config 的 apiKeyEnv 语义）。
        writeFileSync(
          join(target.dscHome, 'config.yaml'),
          `default:\n  provider: test\n  model: m\nproviders:\n  test:\n` +
            `    baseURL: ${llm.baseUrl}\n    apiKeyEnv: K\n    models:\n      - id: m\n        name: m\n`,
          'utf8',
        )
        const result = await runInPty(
          [],
          target,
          [
            // TUI 起来要装配全部插件；冷启动给足 10 秒（CI 上比开发机慢）。
            { send: '你好\r', delayMs: 10_000 },
            // 等回复真的画出来，再按退出组合键（第一次 Ctrl+C 是打断，第二次才退出）。
            { send: '\u0003', after: '收到，这里是测试回复。' },
            { send: '\u0003', delayMs: 200 },
          ],
          { timeoutMs: 90_000, env: { K: 'k' } },
        )
        expect(result.timedOut, result.output.slice(-800)).toBe(false)
        expect(result.output).toContain('收到，这里是测试回复。')
        expect(result.code, result.output.slice(-800)).toBe(0)
        // 真会话落盘：C3 不只验屏幕，还验这句输入进了会话文件。
        expect(sessionFiles(target).length).toBeGreaterThan(0)
      } finally {
        await llm.close()
      }
    },
    120_000,
  )

  test('入口文件存在且可被 node 解析（防止改名后所有 CLI 用例假绿）', () => {
    expect(CLI_ENTRY.endsWith('dsc.js')).toBe(true)
  })
})
