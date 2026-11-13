/**
 * 四项工具层修复（integration 层，原 `scripts/tool-output-fixes-test.mjs`）。
 *
 * 每条用例都对着一份真实报障写：
 *   1. 溢出预览只给前 30 行，报错和结论全在末尾，模型被迫再读一次（`~/.dsc/spill` 里
 *      落着 8 份「这里只显示前 30 行，还有 317 行」）；
 *   2. `Test-Path .env` 被判「命中用户 deny 黑名单」，写 `.env.example` 也被 `*.env.*` 拦；
 *   3. `Get-ChildItem` 的中文文件名在会话里是一串乱码（25 条结果含替换字符）；
 *   4. `{vue,ts,js,json}` 这种模式一条都不匹配，而且不报错，看起来像目录是空的；
 *   5. `edit` 的参数名传成旧名字时，报错要直接说清楚正确参数名。
 *
 * ## 平台相关的只有一条
 *
 * 第 3 节里「中文文件名回显」用 `Get-ChildItem -Name`，它是 PowerShell 命令，只在
 * Windows 成立；非 Windows 上 skip 并写明原因。同一节的退出码透传用 `exit 3`，
 * sh 与 PowerShell 都认，两种平台都跑。
 *
 * ## 为什么归 integration
 *
 * 五段分属五个模块（spill / approval-floor / bash / search-tools / fs-tools），没有单一
 * 被测模块；第 3、4 节还要真起子进程、真写临时目录。按 D23 的跨领域口径放这里。
 *
 * @module dsc/tests/integration/tool-output-fixes.int.spec
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import type { ToolContext } from '@pneuma/runtime/core/tools.js'
import type { ToolGuardVerdict } from '@pneuma/runtime/core/tool-guards.js'
import { editTool } from '@pneuma/runtime/core/tools/fs-tools.js'
import { parseSpillConfig, spillPreview } from '@pneuma/runtime/core/spill.js'
import { createApprovalFloor, DEFAULT_FLOOR_CONFIG } from '@pneuma/runtime/packages/approval-floor/approval-floor.js'
import { createBashTool } from '@pneuma/runtime/packages/tools-default/bash.js'
import { expandBraces, globTool } from '@pneuma/runtime/packages/tools-default/search-tools.js'

/** 本文件建出来、跑完要删的临时目录（失败现场靠 vitest 的用例名定位，不留盘）。 */
const tempDirs: string[] = []

/** 建一个临时目录并登记清理。 */
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** 工具调用上下文：只填被测工具真正会读到的字段。 */
function toolContext(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    sessionId: 'tool-output-fixes-int-spec',
    sessionPath: 'tool-output-fixes-int-spec.jsonl',
  }
}

describe('① 溢出预览：开头和结尾都要给', () => {
  const config = parseSpillConfig({ dir: join(tmpdir(), 'dsc-spill-fixes-int-spec') })
  const lines = Array.from({ length: 300 }, (_, index) => `line-${String(index + 1)}`)
  const preview = spillPreview('C:\\fake\\spill.log', lines.join('\n'), config)

  test('保留第一行与最后一行', () => {
    // 只给开头时，报错与结论（都在末尾）永远看不到，模型只能再 read 一次。
    expect(preview.includes('line-1\n') || preview.startsWith('line-1')).toBe(true)
    expect(preview).toContain('line-300')
  })

  test('写清中间省略多少行', () => {
    expect(preview).toContain('中间省略 240 行')
  })

  test('续读从第 31 行开始（跳过已经看过的开头 30 行）', () => {
    expect(preview).toContain('offset=31')
  })

  test('仍给出落盘路径', () => {
    expect(preview).toContain('C:\\fake\\spill.log')
  })

  test('短文本不写「省略」', () => {
    // 未超阈值的文本被写「省略 N 行」会让模型以为内容被截过。
    const short = spillPreview('C:\\fake\\spill2.log', 'a\nb\nc', config)
    expect(short).not.toContain('省略')
  })
})

describe('② deny 黑名单：模板放行、只读探测放行、读内容仍拒', () => {
  const floor = createApprovalFloor({
    readConfig: () => ({ config: DEFAULT_FLOOR_CONFIG, problems: [] }),
    rules: () => [],
  })

  /** 按探针同一形状组织一次判定输入；地板这一位是同步判定，按同步结论读。 */
  const judge = (input: { command?: string; toolName?: string; risk?: 'read' | 'write' | 'exec'; target?: string }) =>
    floor.guard.decide({
      toolName: 'bash',
      risk: 'exec',
      cwd: process.cwd(),
      args: {},
      signal: new AbortController().signal,
      sessionId: 'tool-output-fixes-int-spec',
      sessionPath: 'tool-output-fixes-int-spec.jsonl',
      ...input,
    } as Parameters<typeof floor.guard.decide>[0]) as ToolGuardVerdict

  const verdict = (command: string): ReturnType<typeof judge> => judge({ command })
  const writeVerdict = (target: string): ReturnType<typeof judge> => judge({ toolName: 'write', risk: 'write', target })

  test('Test-Path .env 不再被拒（只泄漏「在不在」一位信息）', () => {
    expect(verdict('Test-Path .env').action).not.toBe('deny')
  })

  test('Get-Content .env 仍然被拒（内容才是密钥本体）', () => {
    expect(verdict('Get-Content .env').action).toBe('deny')
  })

  test('type .env 仍然被拒', () => {
    expect(verdict('type .env').action).toBe('deny')
  })

  test('写 .env.example 放行（模板不是密钥）', () => {
    expect(writeVerdict(join(process.cwd(), '.env.example')).action).not.toBe('deny')
  })

  test('写 .env 仍然被拒', () => {
    expect(writeVerdict(join(process.cwd(), '.env')).action).toBe('deny')
  })

  test('Test-Path id_rsa 不跟着放行（口子只对 .env 一族开）', () => {
    // 这条是「例外不许扩大」的边界：探测放行若按命令名一刀切，`Test-Path id_rsa`
    // 会一起放行，等于默认暴露私钥存在性。
    expect(verdict('Test-Path id_rsa').action).toBe('deny')
  })
})

describe('③ bash：中文文件名的回显与退出码透传', () => {
  const dir = makeTemp('dsc-bash-encoding-int-spec-')
  const bash = createBashTool()

  test.skipIf(process.platform !== 'win32')('PowerShell 输出的中文文件名不是乱码', async () => {
    // 只在 Windows 跑：`Get-ChildItem` 是 PowerShell 命令；Linux 上它根本不存在。
    const context = toolContext(dir)
    writeFileSync(join(dir, '中文测试.txt'), 'hello', 'utf8')
    const output = await bash.run({ command: 'Get-ChildItem -Name' }, context)
    expect(output).toContain('中文测试.txt')
  })

  test('退出码仍然透传（exit 3）', async () => {
    // `exit 3` 在 sh 与 PowerShell 里都成立，所以不按平台 skip。
    const output = await bash.run({ command: 'exit 3' }, toolContext(dir))
    expect(output).toContain('退出码 3')
  })
})

describe('④ glob：大括号展开', () => {
  const dir = makeTemp('dsc-glob-brace-int-spec-')

  test('两个值展开成两条', () => {
    expect(expandBraces('src/**/*.{ts,tsx}')).toHaveLength(2)
  })

  test('单值不展开', () => {
    expect(expandBraces('a{b}c')).toHaveLength(1)
  })

  test('没配对的 { 直接报错（不静默当成字面量去匹配）', () => {
    expect(() => expandBraces('a{b')).toThrow()
  })

  test('真正的 glob 里 .vue 与 .json 都命中，.ts 不混进来', async () => {
    for (const name of ['a.vue', 'b.json', 'c.ts']) writeFileSync(join(dir, name), '', 'utf8')
    const output = await globTool.run({ pattern: '**/*.{vue,json}' }, toolContext(dir))
    expect(output).toContain('a.vue')
    expect(output).toContain('b.json')
    expect(output).not.toContain('c.ts')
  })
})

describe('⑤ edit：参数名传成旧名字时，报错直接说清正确名字', () => {
  const context = toolContext(tmpdir())

  /** 跑一次 edit，返回它的错误文本；没抛错返回空串（调用方会因断言空串而红）。 */
  async function messageOf(args: Record<string, unknown>): Promise<string> {
    try {
      await editTool.run(args, context)
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  test('old_string / new_string 被认出来，并给出正确参数名', async () => {
    const message = await messageOf({ path: 'nope.txt', old_string: 'a', new_string: 'b' })
    expect(message).toContain('old_string')
    expect(message).toContain('path / old / new')
  })

  test('file_path 同样给出提示', async () => {
    const message = await messageOf({ file_path: 'nope.txt', old: 'a', new: 'b' })
    expect(message).toContain('file_path')
    expect(message).toContain('path / old / new')
  })
})
