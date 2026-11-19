/**
 * skills 包的生命周期读取测试：钉住「读档位只读不抛，坏数据当没有」。
 *
 * 为什么单独一条：`readSkillLifecycles` 是目录过滤的输入，它一旦抛错，
 * 技能发现会连带瘫掉（整页技能消失）；文件不在、JSON 坏、字段乱写都必须退回空 Map。
 *
 * 隔离：临时 DSC_HOME，真实 ~/.dsc 一个字节都不碰。`DSC_SKILLS_DIR` 在模块求值那一刻
 * 就定下来了，所以必须先设环境变量、再动态 import。
 *
 * @module @pneuma/skills/tests/lifecycle
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-skills-lifecycle-'))
const dscHome = join(home, '.dsc')
const skillsDir = join(dscHome, 'skills')

let readSkillLifecycles: typeof import('@pneuma/runtime/core/skills.js')['readSkillLifecycles']

beforeAll(async () => {
  process.env.DSC_HOME = dscHome
  process.env.HOME = home
  process.env.USERPROFILE = home
  mkdirSync(skillsDir, { recursive: true })
  const skills = await import('@pneuma/runtime/core/skills.js')
  expect(skills.DSC_SKILLS_DIR).toBe(skillsDir)
  readSkillLifecycles = skills.readSkillLifecycles
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 写 `.usage.json`。 */
function writeUsage(text: string): void {
  writeFileSync(join(skillsDir, '.usage.json'), text, 'utf8')
}

// 第 1 条：文件不在 → 空 Map（调用方按 active 处理，技能照常出现在目录里）。
test('readSkillLifecycles：文件不在返回空 Map', () => {
  rmSync(join(skillsDir, '.usage.json'), { force: true })
  const map = readSkillLifecycles()
  expect(map instanceof Map).toBe(true)
  expect(map.size).toBe(0)
})

// 第 2 条：正常文件里三种档位都读得出来，乱写的档位丢掉。
test('readSkillLifecycles：读出 active / stale / archived，脏数据跳过', () => {
  writeUsage(
    JSON.stringify({
      version: 1,
      skills: {
        alpha: { state: 'active' },
        beta: { state: 'stale' },
        gamma: { state: 'archived' },
        delta: { state: 'whatever' },
        epsilon: null,
      },
    }),
  )
  const map = readSkillLifecycles()
  expect(map.get('alpha')).toBe('active')
  expect(map.get('beta')).toBe('stale')
  expect(map.get('gamma')).toBe('archived')
  expect(map.has('delta'), '认不出的档位不该往上传').toBe(false)
  expect(map.has('epsilon'), 'null 记录跳过').toBe(false)
})

// 第 3 条：文件坏掉 / 形状不对 → 空 Map，绝不抛（抛了整份技能目录都会读不出来）。
test('readSkillLifecycles：JSON 坏掉 / 形状不对都返回空 Map 且不抛', () => {
  writeUsage('{ 这不是 JSON')
  expect(readSkillLifecycles().size).toBe(0)
  writeUsage(JSON.stringify({ version: 1, skills: ['not', 'an', 'object'] }))
  expect(readSkillLifecycles().size).toBe(0)
  writeUsage(JSON.stringify({ version: 1, skills: { alpha: 'active' } }))
  expect(readSkillLifecycles().size, '档位值不是对象时跳过').toBe(0)
})
