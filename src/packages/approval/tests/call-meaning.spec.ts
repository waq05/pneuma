/**
 * 审批卡「中文含义」的真值表（迁自 `scripts/call-meaning-test.mjs`）。
 *
 * 这一行字是用户点「允许」之前唯一的依据（命令原文他多半读不懂），所以按真值表钉：
 * 删除 / 读文件 / 列目录、Git 子命令、包管理器、解释器、复制两个端点、管道只报段数、
 * 认不出来的程序名直说、空命令给 null。
 *
 * 反例也钉了几条，因为「错得离谱」比「不说」更糟：
 *   `git commit -m "修一处标点"` 不能把提交信息当成要动的东西；
 *   `pnpm --version` 不能把 `--version` 当成子命令；
 *   `sudo rm -rf /` 要穿过包装词认出 rm；
 *   网址不能被「只留最后两级」的规则切掉协议头。
 *
 * 纯函数、零依赖，归 unit 层（不需要先 `pnpm run build`）。
 *
 * @module dsc/packages/approval/tests/call-meaning.spec
 */
import { describe, expect, test } from 'vitest'
import { callMeaning, commandMeaning } from '../call-meaning.js'

/** 一条命令 → 期望的中文（null = 空命令）。 */
const CASES: ReadonlyArray<readonly [string, string | null]> = [
  ['Remove-Item -Recurse -Force D:\\dsc\\.tmp', '删除 D:\\dsc\\.tmp'],
  ['Get-Content package.json', '读文件内容 package.json'],
  ['Set-Content -Path a.txt -Value hi', '写文件内容 a.txt'],
  ['Get-ChildItem -Force', '列目录'],
  ['ls -la', '列目录'],
  ['Select-String -Pattern foo src/a.ts', '在文件里搜文本 foo'],
  ['cp a.txt D:\\backup\\a.txt', '复制 a.txt → D:\\backup\\a.txt'],
  ['git status --porcelain', '看 Git 状态'],
  ['git add src/plugins/approval.ts', '暂存改动 src/plugins/approval.ts'],
  // 反例：提交信息不是「要动的东西」。
  ['git commit -m "fix: x"', '提交改动'],
  ['git push origin main', '推送提交'],
  ['pnpm install', 'pnpm 装依赖'],
  ['npm run build', '跑脚本 build'],
  // 反例：`--version` 不是子命令。
  ['pnpm --version', '跑 pnpm 包管理命令'],
  ['node scripts/x.mjs', '跑 Node 脚本 scripts/x.mjs'],
  ['python -m pytest tests', '跑 Python 模块 pytest'],
  ['curl -s https://example.com', '发网络请求 https://example.com'],
  // 反例：包装词要穿过去，认出真正的 rm。
  ['sudo rm -rf /', '删除 /'],
  ['frobnicate --fast x', '运行 frobnicate 命令'],
  ['', null],
]

describe('命令 → 中文', () => {
  test.each(CASES)('%j → %j', (command, want) => {
    expect(commandMeaning(command)).toBe(want)
  })

  test('管道只细说第一段并报段数（整条解读会变成一篇小作文）', () => {
    expect(commandMeaning('Get-Content $f | ForEach-Object { ($_ | ConvertFrom-Json).Key }')).toBe(
      '读文件内容 $f（共 2 段命令）',
    )
  })

  test('超长句子截断在省略号上（卡片一行放不下，宁可不换行）', () => {
    const got = commandMeaning(`curl -s ${'https://example.com/'.repeat(6)}`)
    expect(typeof got).toBe('string')
    expect((got ?? '').length).toBeLessThanOrEqual(61)
    expect(got?.endsWith('…')).toBe(true)
  })

  test('网址不被「只留两级」的规则切成残片', () => {
    const got = commandMeaning(`curl -s ${'https://example.com/'.repeat(6)}`)
    expect(got).toContain('https://')
  })
})

describe('工具调用 → 中文', () => {
  test('写类工具点明动哪个文件', () => {
    expect(callMeaning({ toolName: 'write', target: 'D:\\dsc\\src\\a.ts' })).toBe('写文件 D:\\dsc\\src\\a.ts')
    expect(callMeaning({ toolName: 'edit', target: 'D:\\dsc\\src\\a.ts' })).toBe('改文件 D:\\dsc\\src\\a.ts')
  })

  test('带命令的工具走命令解读', () => {
    expect(callMeaning({ toolName: 'pwsh', command: 'git status' })).toBe('看 Git 状态')
  })

  test('认不出来的工具给 null（界面就不画那一行）', () => {
    expect(callMeaning({ toolName: 'mcp_thing' })).toBeNull()
  })

  test('没有命令也没有目标时只说动词', () => {
    expect(callMeaning({ toolName: 'write' })).toBe('写文件')
  })
})
