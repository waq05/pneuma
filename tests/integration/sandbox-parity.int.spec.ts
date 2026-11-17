/**
 * 权限与沙箱对齐 dsh 的回归用例（integration 层，原 `scripts/sandbox-parity-test.mjs`）。
 *
 * 迁的是两条**有行为接缝**的：
 *   [1] 命令判定：`git -c …` 不再把写子命令看成只读；网络开关不再被带值开关绕过；
 *       嵌套 shell 拆得比两层更深。
 *   [4] 模式四档：出厂预设的清单与顺序、PTC / 极简档的字段，以及 `read_image` 的归属。
 *
 * ## 没有搬的断言（源码文本，按本批规矩不搬）
 *
 * 探针第 [2][3][5] 节与第 [4] 节的一部分读 `src/**` 的源码字符串（`code.includes(...)`）。
 * 它们没有行为接缝：断定的是「某段代码里出现了某个标识符 / 某个比较在前」。这些断言
 * 只要改个变量名就红、而行为可以完全不变；反过来，它们也不能证明用户点下去真的会怎样。
 * 逐条列表收在交接里，需要保留的话应改写成行为用例（起内核 + 真审批 / 真沙箱），
 * 或者留在 check-core 的源码检查里。
 *
 * 属于这一类的原文断言（共 24 条，未迁）：
 *   - 第 [2] 节：ASKABLE_RULES 的内容、`askableRule(...) && ctx.get('approval')` 的写法、
 *     `return refuse(...)`、`check(target, command)` 的签名；
 *   - 第 [3] 节：审批里沙箱 check / AI 复核 / 自动放行的源码位置与顺序、`if (fenced)`、
 *     `writable = ...` 的组合式；
 *   - 第 [4] 节：替换式骨架过滤器那一行、持久 shell 的 `presets` / 哨兵 / 分块解码；
 *   - 第 [5] 节：permission-presets 与 permission-scope 的调用写法。
 *
 * ## 平台
 *
 * `evaluateCommand` 显式传 `win32: true`：被测的是「按 Windows 口径怎么判」，不随
 * 宿主平台变；这也让同一份断言在 Linux CI 上成立（探针原来就是这么做的）。
 *
 * @module dsc/tests/integration/sandbox-parity.int.spec
 */
import { describe, expect, test } from 'vitest'
import { classifyCommand } from '@pneuma/runtime/core/command-policy.js'
import { ensureBuiltinPresets, listPresets } from '@pneuma/runtime/packages/config-core/presets.js'
import { readImageTool } from '@pneuma/runtime/packages/tools-default/image-tool.js'
import { evaluateCommand } from '@pneuma/runtime/packages/sandbox/execpolicy.js'
import type { PathCheck } from '@pneuma/runtime/packages/sandbox/policy.js'

/**
 * 写目标判定：只有 `D:/dsc` 下面算可写。
 *
 * 显式写死一份判定而不是复用路径策略：这一节要钉的是「命令解析出了哪个写目标」，
 * 不是「路径策略对不对」（那有它自己的用例）。
 */
function checkWrite(raw: string): PathCheck {
  return {
    allowed: raw.toLowerCase().startsWith('d:/dsc'),
    rule: 'outside-writable-roots',
    reason: 'outside',
    resolved: raw,
  }
}

/** 按 Windows 口径、网络关闭判一条命令。 */
function sandbox(command: string): ReturnType<typeof evaluateCommand> {
  return evaluateCommand(command, { networkAccess: false, checkWrite, win32: true })
}

describe('[1] 命令判定：git 全局开关、网络开关、嵌套 shell', () => {
  test('git -c x=y reset --hard 不再被判只读', () => {
    // `-c` 是 git 的全局开关，后面还可以跟写子命令；只看到 `git` 就放行等于绕过审批。
    expect(classifyCommand('git -c x=y reset --hard').decision).toBe('ask')
  })

  test('git -c x=y clean -fd 不再被判只读', () => {
    expect(classifyCommand('git -c x=y clean -fd').decision).toBe('ask')
  })

  test('git -c core.pager=calc log 仍是只读（子命令还是 log）', () => {
    expect(classifyCommand('git -c core.pager=calc log').decision).toBe('allow')
  })

  test('git -C dir status 仍是只读', () => {
    expect(classifyCommand('git -C sub status').decision).toBe('allow')
  })

  test('pnpm --dir . install 网络关时被拒', () => {
    expect(sandbox('pnpm --dir . install').decision).toBe('forbidden')
  })

  test('npm --registry=https://x install 网络关时被拒', () => {
    expect(sandbox('npm --registry=https://x install').decision).toBe('forbidden')
  })

  test('git -c http.x=y clone https://x 网络关时被拒', () => {
    // 带值的全局开关不能把后面的 clone/网络动作藏起来。
    expect(sandbox('git -c http.x=y clone https://x').decision).toBe('forbidden')
  })

  test('pnpm --dir . test 不因带值开关被当成联网', () => {
    expect(sandbox('pnpm --dir . test').network).toBe(false)
  })

  test('三层嵌套 shell 认得出越界写目标', () => {
    const three = sandbox(`bash -c "bash -c 'rm -rf D:/outside/x'"`)
    expect(three.decision).toBe('forbidden')
    expect(three.rule).toContain('outside-writable-roots')
  })

  test('四层嵌套 shell 也认得出越界写目标', () => {
    expect(sandbox(`bash -c "bash -c 'bash -c \\'rm -rf D:/outside/x\\''"`).decision).toBe('forbidden')
  })
})

describe('[4] 模式四档对齐 dsh', () => {
  test('四个出厂档都在，顺序对齐 dsh：standard → ptc → minimal → maker', () => {
    ensureBuiltinPresets()
    const list = listPresets()
    expect(list.length).toBeGreaterThanOrEqual(4)
    // 顺序就是设置页的展示顺序；改了顺序用户会以为某一档被删了。
    expect(list.slice(0, 4).map((item) => item.name)).toEqual(['standard', 'ptc', 'minimal', 'maker'])
  })

  test('标准档是全量工具，不替换人格', () => {
    const byName = Object.fromEntries(listPresets().map((item) => [item.name, item]))
    expect(byName.standard?.tools).toBeNull()
    expect(byName.standard?.replace).toBe(false)
  })

  test('PTC 档是全量工具 + run_code + 禁插件管理，正文为空', () => {
    // 2026-11-06 按 dsh 的 ptc.patch.yml 对齐：正文为空（用法在 run_code 的工具描述里），
    // 并用 deny 关掉插件管理工具。
    const ptc = listPresets().find((item) => item.name === 'ptc')
    expect(ptc?.tools).toBeNull()
    expect(ptc?.deny).toContain('plugin_manager')
    expect(ptc?.prompt).toBe('')
  })

  test('极简档只有 shell 与 read_image、替换式人格、只有一句人格', () => {
    // 2026-11-06：极简档从一次性 bash 换成持久 shell（对齐 dsh 的 persistent-pwsh）。
    const minimal = listPresets().find((item) => item.name === 'minimal')
    expect(minimal?.tools).toEqual(['shell', 'read_image'])
    expect(minimal?.replace).toBe(true)
    expect(minimal?.prompt).toBe('You are a helpful software engineer assistant.')
  })

  test('read_image 工具存在、只挂极简档、是只读风险', () => {
    expect(readImageTool.name).toBe('read_image')
    expect(readImageTool.presets).toEqual(['minimal'])
    expect(readImageTool.risk).toBe('read')
  })
})
