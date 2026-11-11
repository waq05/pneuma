/**
 * skills 包的生命周期读取测试：钉住「读档位只读不抛，坏数据当没有」。
 *
 * 为什么单独一条：`readSkillLifecycles` 是目录过滤的输入，它一旦抛错，
 * 技能发现会连带瘫掉（整页技能消失）；文件不在、JSON 坏、字段乱写都必须退回空 Map。
 *
 * 隔离：临时 DSC_HOME，真实 ~/.dsc 一个字节都不碰。
 * 读 lib/ 产物，先 pnpm run build。
 *
 * @module @pneuma/skills/tests/lifecycle
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// 先隔离再加载 lib：`DSC_SKILLS_DIR` 在模块求值那一刻就定下来了。
const home = mkdtempSync(join(tmpdir(), 'dsc-lifecycle-'))
process.env.DSC_HOME = join(home, '.dsc')
process.env.HOME = home
process.env.USERPROFILE = home
const skillsDir = join(process.env.DSC_HOME, 'skills')
mkdirSync(skillsDir, { recursive: true })

const { readSkillLifecycles } = await import('../../../../lib/core/skills.js')
let passed = 0

function writeUsage(text) {
  writeFileSync(join(skillsDir, '.usage.json'), text, 'utf8')
}

// 第 1 条：文件不在 → 空 Map（调用方按 active 处理，技能照常出现在目录里）。
test('readSkillLifecycles：文件不在返回空 Map', () => {
  const map = readSkillLifecycles()
  assert.equal(map instanceof Map, true)
  assert.equal(map.size, 0)
  passed += 1
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
  assert.equal(map.get('alpha'), 'active')
  assert.equal(map.get('beta'), 'stale')
  assert.equal(map.get('gamma'), 'archived')
  assert.equal(map.has('delta'), false, '认不出的档位不该往上传')
  assert.equal(map.has('epsilon'), false, 'null 记录跳过')
  passed += 1
})

// 第 3 条：文件坏掉 → 空 Map，绝不抛（抛了整份技能目录都会读不出来）。
test('readSkillLifecycles：JSON 坏掉 / 形状不对都返回空 Map 且不抛', () => {
  writeUsage('{ 这不是 JSON')
  assert.equal(readSkillLifecycles().size, 0)
  writeUsage(JSON.stringify({ version: 1, skills: ['not', 'an', 'object'] }))
  assert.equal(readSkillLifecycles().size, 0)
  passed += 1
})

after(() => {
  rmSync(home, { recursive: true, force: true })
  console.log(`通过 ${String(passed)} 项`)
})
