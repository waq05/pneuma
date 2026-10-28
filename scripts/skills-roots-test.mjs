/**
 * 技能发现根的探针：全局那几根（公共 Agent、~/.dsc、DSH）与「项目 / 全局」作用域。
 *
 * 背景（2026-10-27，用户：「技能这里需要能读取全局技能」「要和这个技能页一样区分全局、项目技能」）：
 * 原来只认四个根（项目两根 + config.yaml 自定义 + ~/.dsc/skills），用户在 dsh 里攒的全局技能
 * （`~/.dsh/skills`）与公共 Agent 目录（`~/.agents/skills`）根本没被读；技能页也是一条平铺的列。
 * 这个探针钉四件事：
 *   [1] dsh 全局目录怎么算（$DSH_HOME/skills，缺省 ~/.dsh/skills）
 *   [2] 发现根的集合、优先级（rank 小者赢）与作用域标记，同一个目录不许被扫两遍
 *   [3] 扫出来的技能带上 scope / root（技能页的分组就靠这两个字段）
 *   [4] 契约与界面：来源标签认新目录、页面上有「全部 / 全局 / 项目」与组头
 *
 * 运行：node scripts/skills-roots-test.mjs（check:core 自动带上）
 *
 * @module dsc/scripts/skills-roots-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readContractSource } from './_check-runner.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { DSC_SKILLS_DIR, dshSkillsDir, scanSkillRoot, skillRoots, toSkillInfoView } = await import('../lib/core/skills.js')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log('  ok  ' + name)
  } else {
    failures += 1
    console.log('FAIL  ' + name + (detail === undefined ? '' : '  <- ' + String(detail)))
  }
};

const root = mkdtempSync(join(tmpdir(), 'dsc-skills-'))
const writeSkill = (dir, name) => {
  mkdirSync(join(dir, name), { recursive: true })
  const body = '---\nname: ' + name + '\ndescription: 探针用的技能\n---\n\n正文\n'
  writeFileSync(join(dir, name, 'SKILL.md'), body, 'utf8')
};

console.log('[1] dsh 全局目录怎么算')
let savedDsh = process.env.DSH_HOME
process.env.DSH_HOME = join(root, 'dsh-home')
check('$DSH_HOME 设了就用 $DSH_HOME/skills', dshSkillsDir() === join(root, 'dsh-home', 'skills'), dshSkillsDir())
delete process.env.DSH_HOME
check('没设环境变量时回落到 ~/.dsh/skills', /[\\/]\.dsh[\\/]skills$/.test(dshSkillsDir()), dshSkillsDir())
if (savedDsh === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedDsh

console.log('[2] 发现根：集合、优先级、作用域')
const cwd = join(root, 'work')
writeSkill(join(cwd, '.dsc', 'skills'), 'proj-dsc')
writeSkill(join(cwd, '.agents', 'skills'), 'proj-agents')
writeSkill(join(root, 'custom'), 'custom-one')
const roots = skillRoots(cwd, [join(root, 'custom')])
const bySource = new Map(roots.map((item) => [item.source, item]))
check('项目两根都在且标成 project',
  bySource.get('project-dsc')?.scope === 'project' && bySource.get('project-agents')?.scope === 'project',
  JSON.stringify(roots.map((r) => [r.source, r.scope])))
check('自定义目录标成 global', bySource.get('custom')?.scope === 'global')
check('~/.dsc/skills 那根仍是 user-dsc（目录在就有）', bySource.has('user-dsc') === existsSync(DSC_SKILLS_DIR))
check('公共 Agent 目录在时是一根独立来源',
  existsSync(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.agents', 'skills')) ? bySource.get('user-agents')?.scope === 'global' : true)
check('dsh 全局目录在时是一根独立来源（user-dsh）',
  existsSync(dshSkillsDir()) ? bySource.get('user-dsh')?.scope === 'global' : true, dshSkillsDir())
const ranks = roots.map((item) => item.rank)
const sorted = ranks.every((value, index) => index === 0 || ranks[index - 1] <= value)
check('rank 升序：项目 100/200 → 自定义 300 → 公共 Agent 350 → 用户 400 → DSH 450',
  sorted && bySource.get('project-dsc')?.rank === 100 && bySource.get('project-agents')?.rank === 200 &&
    bySource.get('custom')?.rank === 300 && bySource.get('user-dsc')?.rank === 400,
  JSON.stringify(ranks))
const dirs = roots.map((item) => item.dir.toLowerCase())
check('同一目录不会出现两次（DSH_HOME 指到 ~/.dsc 时也不重复）', new Set(dirs).size === dirs.length, JSON.stringify(dirs))

console.log('[3] 扫出来的技能带 scope 与 root')
const projectRoot = join(cwd, '.dsc', 'skills')
const scanned = scanSkillRoot({ dir: projectRoot, source: 'project-dsc', rank: 100, scope: 'project' })
check('项目技能：名字、scope、root 都对',
  scanned.length === 1 && scanned[0].name === 'proj-dsc' && scanned[0].scope === 'project' && scanned[0].root === projectRoot,
  JSON.stringify(scanned.map((item) => [item.name, item.scope, item.root])))
const globalScanned = scanSkillRoot({ dir: join(root, 'custom'), source: 'custom', rank: 300, scope: 'global' })
check('全局技能：scope 是 global', globalScanned[0]?.scope === 'global')
const view = toSkillInfoView(globalScanned[0], new Set())
check('视图里透出 scope / root（界面靠这两个字段分组）',
  view.scope === 'global' && view.root === join(root, 'custom'), JSON.stringify({ scope: view.scope, root: view.root }))
check('停用的技能在视图里 enabled=false', toSkillInfoView(globalScanned[0], new Set(['custom-one'])).enabled === false)

console.log('[4] 契约与界面：来源标签、作用域筛选、分组头')
const contract = readContractSource()
check('SkillSourceLabel 认 user-agents 与 user-dsh', contract.includes("'user-agents'") && contract.includes("'user-dsh'"))
check('SkillInfoView 带 scope 与 root', contract.includes("scope?: 'project' | 'global'") && contract.includes('root?: string'))
const ui = readFileSync('ui-shell/src/plugins/skills/ui.tsx', 'utf8')
check('界面：公共 Agent 与 DSH 全局技能各有标签', ui.includes("'user-agents': '公共 Agent'") && ui.includes("'user-dsh': 'DSH 全局技能'"))
check('界面：三个作用域筛选项（全部 / 全局 / 项目）', ui.includes('skills-scope') && ui.includes("value: 'global', label: '全局'") && ui.includes("value: 'project', label: '项目'"))
check('界面：按发现根分组、组头带目录', ui.includes('skills-group-head') && ui.includes('skills-group-path') && ui.includes('group.items.map'))
check('界面：行内不再逐个打来源徽章（组头已经说了）', !ui.includes('SOURCE_LABELS[skill.source] !== undefined'))
const coreText = readFileSync('src/core/skills.ts', 'utf8')
check('内核：三类全局根写在 skillRoots 里',
  coreText.includes("source: 'user-agents'") && coreText.includes("source: 'user-dsc'") && coreText.includes("source: 'user-dsh'"))

rmSync(root, { recursive: true, force: true })
console.log('')
console.log('通过 ' + String(passed) + '/' + String(passed + failures))
process.exit(failures === 0 ? 0 : 1)
