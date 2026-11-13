/**
 * 技能发现根的单元测试（迁自 `scripts/skills-roots-test.mjs` 的 [1][2][3]）。
 *
 * ## 钉什么
 *
 * 发现根是「技能从哪几个目录收」的唯一事实源。它一旦漂了，症状不是报错，是技能页
 * 悄悄少几条、或者同一条技能出现两次。所以三件事逐条钉住：
 *
 *   1. dsh 全局目录怎么算：`$DSH_HOME/skills`，没设环境变量时 `~/.dsh/skills`；
 *   2. 发现根的集合、优先级（rank 小者赢，同一目录只留 rank 小的那条）与作用域；
 *   3. 扫出来的技能带上 `scope` / `root`，视图层把它们投影给界面。
 *
 * ## 为什么不搬 [4]
 *
 * 原探针最后一段读的是 `contract.ts` / `ui.tsx` / `core/skills.ts` 的**源码字符串**
 * （`'user-agents'` 在不在、界面上有没有 `skills-scope`）。按本批规矩源码文本断言一律
 * 不搬：改引号就红、留字符串就绿，它盯的是写法不是行为。它要保的那件事——「三类全局根
 * 都在发现根集合里」——第 2 节的 `user-agents` / `user-dsc` / `user-dsh` 三条已经用
 * 行为验到了，缺口只落在界面渲染与契约字面量上，已写进交付报告的删除清单。
 *
 * ## 隔离
 *
 * `DSC_SKILLS_DIR` 是模块级常量（import 那一刻由 `dscPath('skills')` 算定），所以
 * `tempHome()` 必须在任何 skills 模块被加载之前调用，模块一律动态 import。
 */
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { tempHome } from '../../tests/harness.js'

/** 临时主目录：技能根全部从它派生，必须在动态 import 之前换好。 */
const home = tempHome('dsc-skills-spec-')
/** 两个候选工作目录（只有 `cwd` 里会造项目技能）。 */
const cwd = join(home.home, 'work')
/** config.yaml 里 `skills:` 段那种自定义目录。 */
const customDir = join(cwd, 'custom')
/** `~/.dsc/skills`：`DSC_SKILLS_DIR` 的缺省位置。 */
const dscSkills = join(home.home, '.dsc', 'skills')
/** `~/.agents/skills`：公共 Agent 目录。 */
const userAgents = join(home.home, '.agents', 'skills')
/** `$DSH_HOME` 与它下面的技能目录。 */
const dshHome = join(home.home, 'dsh-home')
const dshSkills = join(dshHome, 'skills')

/** skills 模块的类型：动态 import 后由 beforeAll 赋值。 */
type SkillsModule = typeof import('./skills.js')
let skills: SkillsModule
/** 这一次的发现根（第 2 节整节读它）。 */
let roots: ReturnType<SkillsModule['skillRoots']>

/** 造一个 `<dir>/<name>/SKILL.md`；返回技能正文，便于需要时核对。 */
function writeSkill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  const body = `---\nname: ${name}\ndescription: 单元测试用的技能\n---\n\n正文\n`
  writeFileSync(join(dir, name, 'SKILL.md'), body, 'utf8')
}

/** 按来源查一根（找不到时 undefined，断言里直接报出来）。 */
function rootOf(source: string): ReturnType<SkillsModule['skillRoots']>[number] | undefined {
  return roots.find((item) => item.source === source)
}

beforeAll(async () => {
  // 先铺目录再看发现根：`skillRoots` 只返回**真的存在**的目录。
  writeSkill(join(cwd, '.dsc', 'skills'), 'proj-dsc')
  writeSkill(join(cwd, '.agents', 'skills'), 'proj-agents')
  writeSkill(customDir, 'custom-one')
  writeSkill(dscSkills, 'user-one')
  writeSkill(userAgents, 'agents-one')
  writeSkill(dshSkills, 'dsh-one')
  process.env.DSH_HOME = dshHome
  skills = await import('./skills.js')
  roots = skills.skillRoots(cwd, [customDir])
})

afterAll(() => {
  delete process.env.DSH_HOME
  home.restore()
})

describe('① dsh 全局目录怎么算', () => {
  test('$DSH_HOME 设了就用 $DSH_HOME/skills', () => {
    expect(skills.dshSkillsDir()).toBe(dshSkills)
  })

  test('没设环境变量时回落到 ~/.dsh/skills', () => {
    const saved = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      expect(skills.dshSkillsDir()).toBe(join(home.home, '.dsh', 'skills'))
    } finally {
      process.env.DSH_HOME = saved
    }
  })

  test('$DSH_HOME 是空串时也回落（空串不是有效主目录）', () => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = ''
    try {
      expect(skills.dshSkillsDir()).toBe(join(home.home, '.dsh', 'skills'))
    } finally {
      process.env.DSH_HOME = saved
    }
  })
})

describe('② 发现根：集合、优先级、作用域', () => {
  test('项目两根都在且标成 project', () => {
    expect(rootOf('project-dsc')?.scope).toBe('project')
    expect(rootOf('project-agents')?.scope).toBe('project')
  })

  test('自定义目录标成 global', () => {
    expect(rootOf('custom')?.scope).toBe('global')
  })

  test('~/.dsc/skills 是 user-dsc、rank 400、scope global', () => {
    expect(rootOf('user-dsc')).toMatchObject({ scope: 'global', rank: 400, dir: dscSkills })
  })

  test('公共 Agent 目录是 user-agents、rank 350、scope global', () => {
    expect(rootOf('user-agents')).toMatchObject({ scope: 'global', rank: 350, dir: userAgents })
  })

  test('dsh 全局目录是 user-dsh、rank 450、scope global', () => {
    expect(rootOf('user-dsh')).toMatchObject({ scope: 'global', rank: 450, dir: dshSkills })
  })

  test('rank 升序：项目 100/200 → 自定义 300 → 公共 Agent 350 → 用户 400 → DSH 450', () => {
    const ranks = roots.map((item) => item.rank)
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right))
    expect([rootOf('project-dsc')?.rank, rootOf('project-agents')?.rank, rootOf('custom')?.rank]).toEqual([100, 200, 300])
  })

  test('返回的每一根都是真的存在的目录（不存在的目录不进清单）', () => {
    expect(roots.every((item) => existsSync(item.dir))).toBe(true)
  })

  test('同一目录不会出现两次（去重后每根 dir 唯一）', () => {
    const dirs = roots.map((item) => item.dir.toLowerCase())
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  test('$DSH_HOME 指到 ~/.dsc 时同一目录只算一根（留 rank 小的 user-dsc）', () => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = join(home.home, '.dsc')
    try {
      const deduped = skills.skillRoots(cwd, [customDir])
      const matched = deduped.filter((item) => item.dir.toLowerCase() === dscSkills.toLowerCase())
      expect(matched).toHaveLength(1)
      expect(matched[0]?.source).toBe('user-dsc')
    } finally {
      process.env.DSH_HOME = saved
    }
  })

  test('目录被删掉之后就不再是一根（发现根按磁盘现状算）', () => {
    rmSync(customDir, { recursive: true, force: true })
    try {
      expect(skills.skillRoots(cwd, [customDir]).some((item) => item.source === 'custom')).toBe(false)
    } finally {
      writeSkill(customDir, 'custom-one')
    }
  })
})

describe('③ 扫出来的技能带 scope 与 root', () => {
  test('项目技能：名字、scope、root 都对', () => {
    const projectRoot = join(cwd, '.dsc', 'skills')
    const scanned = skills.scanSkillRoot({ dir: projectRoot, source: 'project-dsc', rank: 100, scope: 'project' })
    expect(scanned).toHaveLength(1)
    expect(scanned[0]).toMatchObject({ name: 'proj-dsc', scope: 'project', root: projectRoot })
  })

  test('全局技能：scope 是 global', () => {
    const scanned = skills.scanSkillRoot({ dir: customDir, source: 'custom', rank: 300, scope: 'global' })
    expect(scanned[0]?.scope).toBe('global')
  })

  test('视图里透出 scope / root（界面靠这两个字段分组）', () => {
    const scanned = skills.scanSkillRoot({ dir: customDir, source: 'custom', rank: 300, scope: 'global' })
    const view = skills.toSkillInfoView(scanned[0]!, new Set<string>())
    expect(view.scope).toBe('global')
    expect(view.root).toBe(customDir)
  })

  test('停用的技能在视图里 enabled=false', () => {
    const scanned = skills.scanSkillRoot({ dir: customDir, source: 'custom', rank: 300, scope: 'global' })
    expect(skills.toSkillInfoView(scanned[0]!, new Set(['custom-one'])).enabled).toBe(false)
  })

  test('来源标成根上的来源，不由技能文件自己说（前缀是 project-dsc）', () => {
    const scanned = skills.scanSkillRoot({ dir: join(cwd, '.dsc', 'skills'), source: 'project-dsc', rank: 100, scope: 'project' })
    expect(scanned[0]?.source).toBe('project-dsc')
    expect(scanned[0]?.rank).toBe(100)
  })
})
