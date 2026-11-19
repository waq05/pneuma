/**
 * 审批地板的 shell 口径与工具预算（integration 层，原 `scripts/floor-shell-and-budget-test.mjs`）。
 *
 * 三条断言来自同一份使用反馈，各钉一个具体的误伤：
 *
 *   1. **PowerShell 的 `"\"` 不该被判「引号没闭合」**：转义符是反引号不是反斜杠。那次会话里
 *      5 条 `Get-ChildItem … .Replace(… + "\","")` 全被误伤，喂进来的原始命令直接从会话
 *      jsonl 还原，不是编的。
 *   2. **`$(...)` 仍然拒，但理由要能照着改**：两半都只读的组合能把路径藏进替换里、绕过 deny
 *      黑名单，所以不能改成「问人」；能改的是理由文案。
 *   3. **bash 超时文案与 PTC 时限**：原文案「已终止进程」在开始收进程树时就发了，模型以为
 *      活已经死了就重跑一遍；PTC 120 秒在「单条 bash 就能跑 120 秒」的现场必然不够。
 *
 * 为什么放在 integration 而不在 unit：第 3 条要**真起一个 PowerShell 子进程**跑到超时，
 * 断言的是「进程真被杀、文案说的是正在终止」。纯函数测不到这个过程。
 *
 * @module dsc/tests/integration/approval-floor.int.spec
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  createApprovalFloor,
  DEFAULT_FLOOR_CONFIG,
} from '@pneuma/approval-floor/approval-floor.js'
import { createBashTool } from '@pneuma/tools-default/bash.js'
import { PTC_LIMITS } from '@pneuma/runtime/core/ptc.js'
import { readDeadlineMs, PTC_DEADLINE_RANGE } from '@pneuma/ptc/index.js'

const cwd = mkdtempSync(join(tmpdir(), 'dsc-floor-int-'))
const signal = new AbortController().signal

/** 地板守卫：配置用出厂值、没有用户规则（与探针同一份）。 */
const floor = createApprovalFloor({
  readConfig: () => ({ config: DEFAULT_FLOOR_CONFIG, problems: [] }),
  rules: () => [],
})

/** 地板的裁决（守卫的返回值可能是 Promise，也可能是同步的 pass 变体）。 */
interface FloorVerdict {
  action: string
  reason?: string
}

/** 问一次地板：只给命令，其余字段固定。 */
async function decide(command: string): Promise<FloorVerdict> {
  return (await floor.guard.decide({
    toolName: 'bash',
    risk: 'exec',
    cwd,
    args: {},
    command,
    signal,
    sessionId: 'floor-shell-int',
    sessionPath: 'floor-shell-int.jsonl',
  })) as FloorVerdict
}

/** 从 1e79386c 会话还原的真实命令（PowerShell，路径结尾带反斜杠）。 */
const REAL_POWERSHELL =
  String.raw`Get-ChildItem backend -Recurse -Filter *.py | ForEach-Object { $n=(Get-Content $_.FullName | Measure-Object -Line).Lines; "{0}` +
  '`t' +
  String.raw`{1}" -f $n, $_.FullName.Replace((Get-Location).Path + "\","") } | Sort-Object -Descending | Select-Object -First 25`

// [1][2] 钉的是 PowerShell 的引号语义：门槛判据按平台选 shell，CI 的 Linux 分片跑不了
// （那边 `shellOf` 走 posix，`"\` 不是转义符，两条必然按另一种口径判）。跳过不算放水：
// Windows 车道照跑同一条。
const describePowershell = process.platform === 'win32' ? describe : describe.skip

describePowershell('[1] PowerShell 的 `"\"` 不再被当成「引号没闭合」', () => {
  test('那条真实命令不再被拒', async () => {
    const verdict = await decide(REAL_POWERSHELL)
    expect(verdict.action).not.toBe('deny')
  })

  test('更不是以「引号没闭合」为由拒的', async () => {
    expect((await decide(REAL_POWERSHELL)).reason ?? '').not.toContain('引号没闭合')
  })

  test('单独一个 P"\\" 也判得开', async () => {
    const simple = await decide(String.raw`Write-Output "C:\temp\"`)
    expect(simple.action).not.toBe('deny')
  })
})

describePowershell('[2] 命令替换照旧拒，但给出可照做的改法', () => {
  test('内层是只读命令也拒（fail-closed），理由里说明怎么拆', async () => {
    const verdict = await decide('echo $(Get-Date)')
    expect(verdict.action).toBe('deny')
    expect(verdict.reason).toContain('改成两步')
  })

  test('替换里藏密钥路径仍按 deny 黑名单拒', async () => {
    const smuggled = await decide('echo $(Get-Content .env)')
    expect(smuggled.action).toBe('deny')
    expect(smuggled.reason).toContain('deny 黑名单')
  })

  test('灾难命令仍按灾难拒', async () => {
    const disaster = await decide('echo $(rm -rf /)')
    expect(disaster.action).toBe('deny')
    expect(disaster.reason).toContain('灾难')
  })
})

describe('[3] bash 超时的文案：说清楚「正在终止」与下一步', () => {
  test('超时后不再说「已终止进程」，而是「已请求终止」，并给出两条出路', async () => {
    const bash = createBashTool({ timeoutMs: 1_000, maxTimeoutMs: 2_000, outputChars: 8_000 })
    const output = await bash.run(
      { command: 'Start-Sleep -Seconds 5' },
      { cwd, signal, sessionId: 'floor-bash-int', sessionPath: 'floor-bash-int.jsonl' },
    )
    expect(output).not.toContain('已终止进程')
    expect(output).toContain('已请求终止')
    expect(output).toContain('run_in_background')
    expect(output).toContain('timeoutMs')
  })
})

describe('[4] PTC 脚本时限：默认放宽，可配、夹取', () => {
  test('默认时限 300 秒', () => {
    expect(PTC_LIMITS.deadlineMs).toBe(300_000)
    expect(readDeadlineMs(undefined)).toBe(300_000)
  })

  test('配置值照用', () => {
    expect(readDeadlineMs({ deadlineMs: 480_000 })).toBe(480_000)
  })

  test('小于下限夹到 30 秒，大于上限夹到 15 分钟', () => {
    expect(readDeadlineMs({ deadlineMs: 1 })).toBe(PTC_DEADLINE_RANGE.min)
    expect(readDeadlineMs({ deadlineMs: 99_999_999 })).toBe(PTC_DEADLINE_RANGE.max)
    expect(PTC_DEADLINE_RANGE).toEqual({ min: 30_000, max: 900_000 })
  })
})
