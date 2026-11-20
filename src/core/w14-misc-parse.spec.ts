/**
 * 两个纯解析入口的补测（W14）：技能文件的 frontmatter 归一，以及界面通道的参数校验。
 *
 * 这些函数不碰磁盘、不起进程，缺口全是「带引号的布尔值」「坏 YAML」「中间参数省略」
 * 这类少见但会从网络/用户文件进来的形状，直接喂输入就能走到。
 *
 * @module dsc/core/w14-misc-parse.spec
 */
import { describe, expect, test } from 'vitest'
import { expandSkillDir, parseSkillMarkdown } from './skills.js'
import { validateUiArgs } from './ui-methods.js'

describe('skills：frontmatter 归一', () => {
  test('带引号的 yes / no 也认成布尔（明细 123-124）', () => {
    const parsed = parseSkillMarkdown(
      ['---', 'name: 演示', 'disable-model-invocation: "yes"', 'user-invocable: "no"', '---', '正文'].join('\n'),
    )
    expect(parsed.modelInvocable).toBe(false)
    expect(parsed.userInvocable).toBe(false)
  })

  test('frontmatter 不是合法 YAML：给出 problem，正文照收（明细 138）', () => {
    const parsed = parseSkillMarkdown(['---', 'name: [没闭合', '---', '正文'].join('\n'))
    expect(parsed.problem).toContain('frontmatter 不是合法 YAML')
  })

  test('相对技能目录按 cwd 解析（明细 85）', () => {
    const resolved = expandSkillDir('skills/demo', '/work/repo')
    expect(resolved).toMatch(/skills[/\\]demo$/)
    expect(expandSkillDir('   ', '/work/repo')).toBe('')
  })
})

describe('ui-methods：可选实参的省略规则', () => {
  test('中间实参省略、后面却还有值：拒绝并说明省略只能从尾部开始（明细 497-499）', () => {
    const check = validateUiArgs('submit', ['你好', null, { kind: 'file' }])
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.error).toContain('省略')
  })

  test('合法的字符串数组通过校验（明细 545）', () => {
    expect(validateUiArgs('archiveSessions', [['s1', 's2']]).ok).toBe(true)
  })
})
