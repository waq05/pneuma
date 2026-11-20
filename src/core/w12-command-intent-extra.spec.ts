/**
 * 命令意图（`core/command-intent.ts`）的边界补齐：`-Destination` / `-Path` 开关认写目标、
 * `cp -Path` 不把源当写目标、内联 shell 的粘连写法 `sh -c'rm x'` 拆解。
 *
 * 全部是纯函数，不跑任何外部命令。
 *
 * @module dsc/core/w12-command-intent-extra.spec
 */
import { describe, expect, test } from 'vitest'
import type { CommandSegment } from './command-policy.js'
import { inlineShellOf, isNetworkSegment, writeTargetsOf } from './command-intent.js'

/** 按词元造一段命令（原文只用来做展示，被测逻辑只读 tokens）。 */
function segment(tokens: string[]): CommandSegment {
  return { tokens, raw: tokens.join(' '), ruleUnfriendly: false, redirect: false, subst: false }
}

describe('writeTargetsOf 的开关口径', () => {
  test('-Destination 指名目标：位置参数不再当路径', () => {
    // Move-Item 在 MOVE_HEADS 里，-Destination 的值算写目标；后面的位置参数被 explicit 挡掉。
    const targets = writeTargetsOf(segment(['move-item', '-Destination', 'dst.txt', 'extra.txt']), false)
    expect(targets).toContain('dst.txt')
    expect(targets).not.toContain('extra.txt')
  })

  test('-Path 对非 copy 命令算写目标（rm -Path x）', () => {
    expect(writeTargetsOf(segment(['rm', '-Path', 'a.txt']), false)).toEqual(['a.txt'])
  })

  test('cp 的 -Path 是源不算写，-Destination 才算', () => {
    const targets = writeTargetsOf(segment(['cp', '-Path', 'src.txt', '-Destination', 'dst.txt']), false)
    expect(targets).not.toContain('src.txt')
    expect(targets).toContain('dst.txt')
  })

  test('CONTENT_HEADS 只取第一个位置参数（Set-Content x -Value hello 的 hello 不算）', () => {
    expect(writeTargetsOf(segment(['Set-Content', 'x.txt', '-Value', 'hello']), false)).toEqual(['x.txt'])
  })

  test('重定向目标与 dd of= 都收；2>&1 不算文件', () => {
    expect(writeTargetsOf(segment(['echo', 'hi', '>', 'out.txt', '2>&1']), false)).toEqual(['out.txt'])
    expect(writeTargetsOf(segment(['dd', 'if=a.img', 'of=b.img']), false)).toEqual(['b.img'])
  })
})

describe('inlineShellOf 的粘连写法', () => {
  test("sh -c'rm -rf /' 词元化后粘连成 -crm…，按前缀认出内层脚本", () => {
    const inline = inlineShellOf(segment(['sh', "-crm -rf /tmp/x"]), false)
    expect(inline).toMatchObject({ head: 'sh', flag: '-c', command: 'rm -rf /tmp/x', parseable: true })
  })

  test('普通 -c 仍是独立开关；编码命令标记 parseable=false', () => {
    expect(inlineShellOf(segment(['bash', '-c', 'ls -la']), false)).toMatchObject({
      flag: '-c',
      command: 'ls -la',
      parseable: true,
    })
    expect(inlineShellOf(segment(['powershell', '-EncodedCommand', 'ZQBjAGgAbwA=']), false)).toMatchObject({
      parseable: false,
    })
  })

  test('不是内联 shell 形态返回 null；只有 -c 没脚本时 parseable=false', () => {
    expect(inlineShellOf(segment(['git', 'push']), false)).toBeNull()
    expect(inlineShellOf(segment(['bash', '-c']), false)).toMatchObject({ command: '', parseable: false })
  })
})

describe('isNetworkSegment 的容错', () => {
  test('空段/认不出程序时不联网；npx 任意子命令都算联网', () => {
    expect(isNetworkSegment(segment(['sudo', 'env', 'A=1']), false)).toBe(false)
    expect(isNetworkSegment(segment(['npx', 'anything']), false)).toBe(true)
    expect(isNetworkSegment(segment(['pnpm', '--dir', '.', 'install']), false)).toBe(true)
    expect(isNetworkSegment(segment(['pnpm', '--dir', '.', 'run', 'build']), false)).toBe(false)
  })
})
