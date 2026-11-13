/**
 * @pneuma/self-improve 的自修订测试：钉住「读过」的两条证据与 patch 回答的解析。
 *
 * 为什么钉这几条：
 *   - `skillNamesReadInMessages` 少认 `<skill_content>` 标签，「用 /技能名 干活 → 报错 →
 *     想改它」就会一直被 read-before-write 挡在门外；
 *   - `parseDraftAnswer` 多认一种 patch 形状，不能把原来的 create 形状弄坏。
 *
 * 迁移说明：原文件从 `lib/packages/self-improve/*.js` 取模块，现在直接 import 源码入口
 * `../index.js` 与 `../skill-write.js`；另外把 `DSC_HOME` 指到临时目录——本文件只跑纯函数与
 * 「非法名字必须被拒」这几条，不该碰到真实的 `~/.dsc`。
 *
 * @module @pneuma/self-improve/tests/revision
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'dsc-revision-'))
process.env.DSC_HOME = join(home, '.dsc')

const mod = await import('../index.js')
const sw = await import('../skill-write.js')

afterAll(() => {
  delete process.env.DSC_HOME
  rmSync(home, { recursive: true, force: true })
})

/** `/技能名` 注入正文那条路：正文里带着 `<skill_content name="X">` 标签。 */
const userWithSkillContent = (name: string): { role: 'user'; content: string } => ({
  role: 'user',
  content: `请使用技能 ${name} 处理下面的需求。\n\n<skill_content name="${name}">\n# 正文\n</skill_content>`,
})

// 第 1 条：`/技能名` 注入的标签也算「读过」，且 read-before-write 因此放行。
test('skillNamesReadInMessages：认 user 消息里的 <skill_content name>', () => {
  const names = sw.skillNamesReadInMessages([userWithSkillContent('git-flow')] as never)
  expect(names).toEqual(['git-flow'])
  const check = sw.readBeforeWriteCheck({
    readSkills: [],
    createdSkills: [],
    messages: [userWithSkillContent('git-flow')] as never,
    name: 'git-flow',
  })
  expect(check.ok).toBe(true)
})

// 第 2 条：同一条消息里两个同名标签只算一次（同一个技能被贴两遍不该出现两个名字）。
test('skillNamesReadInMessages：同一段落两个标签去重', () => {
  const message = {
    role: 'user',
    content:
      '看这份技能\n<skill_content name="alpha">第一段</skill_content>\n' +
      '再贴一遍\n<skill_content name="alpha">第二段</skill_content>\n',
  }
  expect(sw.skillNamesReadInMessages([message] as never)).toEqual(['alpha'])
})

// 第 3 条：`skill` 工具那条路（tool_calls）没有被改坏（回归）。
test('skillNamesReadInMessages：skill 工具的 tool_calls 照样认', () => {
  const names = sw.skillNamesReadInMessages([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'skill', arguments: '{"name":"beta"}' } }],
    },
  ] as never)
  expect(names).toEqual(['beta'])
})

// 第 4 条：patch 形状的四个字段都要原样解析出来。
test('parseDraftAnswer：patch 形状解析成 revision，四个字段都在', () => {
  const line = JSON.stringify({
    action: 'patch',
    name: 'git-flow',
    old_string: '- 先跑 pnpm test',
    new_string: '- 先跑 pnpm run typecheck，再跑 pnpm test',
    reason: '少了一步类型检查',
  })
  const answer = mod.parseDraftAnswer(line)
  expect(answer.kind).toBe('revision')
  if (answer.kind !== 'revision') return
  expect(answer.revision.name).toBe('git-flow')
  expect(answer.revision.old_string).toBe('- 先跑 pnpm test')
  expect(answer.revision.new_string).toBe('- 先跑 pnpm run typecheck，再跑 pnpm test')
  expect(answer.revision.reason).toBe('少了一步类型检查')
})

// 第 5 条：old_string 与 new_string 相同 = 什么都没改，判 invalid。
test('parseDraftAnswer：old_string 与 new_string 相同判 invalid', () => {
  const line = JSON.stringify({
    action: 'patch',
    name: 'git-flow',
    old_string: '- 先跑 pnpm test',
    new_string: '- 先跑 pnpm test',
    reason: '重复',
  })
  const answer = mod.parseDraftAnswer(line)
  expect(answer.kind).toBe('invalid')
  expect(answer.kind === 'invalid' ? answer.error : '').toMatch(/old_string/u)
})

// 第 6 条：缺字段判 invalid，且错误信息点名缺哪一项。
test('parseDraftAnswer：patch 缺字段判 invalid 并点名缺哪项', () => {
  const missingNew = mod.parseDraftAnswer(
    JSON.stringify({ action: 'patch', name: 'git-flow', old_string: 'a', reason: 'r' }),
  )
  expect(missingNew.kind).toBe('invalid')
  expect(missingNew.kind === 'invalid' ? missingNew.error : '').toMatch(/new_string/u)

  const missingReason = mod.parseDraftAnswer(
    JSON.stringify({ action: 'patch', name: 'git-flow', old_string: 'a', new_string: 'b' }),
  )
  expect(missingReason.kind).toBe('invalid')
  expect(missingReason.kind === 'invalid' ? missingReason.error : '').toMatch(/reason/u)
})

// 第 7 条：原来的 create 形状仍解析成 draft（回归），显式 action:create 也一样。
test('parseDraftAnswer：create 形状仍解析成 draft（回归）', () => {
  const plain = mod.parseDraftAnswer(
    '{"name":"git-flow","description":"整理提交","whenToUse":"提交前","content":"# 步骤"}',
  )
  expect(plain.kind).toBe('draft')
  expect(plain.kind === 'draft' ? plain.draft.name : '').toBe('git-flow')
  const explicit = mod.parseDraftAnswer(
    '{"action":"create","name":"git-flow","description":"整理提交","whenToUse":"提交前","content":"# 步骤"}',
  )
  expect(explicit.kind).toBe('draft')
  expect(explicit.kind === 'draft' ? explicit.draft.content : '').toBe('# 步骤')
})

// 第 8 条：patch 回答套在 ```json 代码块里也认（与 create 的两种写法一致）。
test('parseDraftAnswer：代码块里的 patch JSON 也认', () => {
  const line = JSON.stringify({
    action: 'patch',
    name: 'alpha',
    old_string: '旧',
    new_string: '新',
    reason: '原文过期',
  })
  const answer = mod.parseDraftAnswer('```json\n' + line + '\n```')
  expect(answer.kind).toBe('revision')
  expect(answer.kind === 'revision' ? answer.revision.reason : '').toBe('原文过期')
})

// 第 9 条：候选里的名字来自模型输出，`../evil` 不许被 patchSkill 拼到技能根之外。
test('patchSkill：技能名不合法直接拒（../evil）', () => {
  const result = sw.patchSkill({
    name: '../evil',
    oldString: 'a',
    newString: 'b',
    actor: 'user',
    readConfirmed: true,
  })
  expect(result.ok).toBe(false)
  expect(result.ok ? '' : result.error).toMatch(/kebab-case/u)
})

// 第 10 条：归档要 rename 整个目录，`..` 与绝对路径都必须被名字校验拦下。
test('archiveSkill：名字是 .. 或绝对路径都拒', () => {
  const dotdot = sw.archiveSkill('..\\evil', 'user')
  expect(dotdot.ok).toBe(false)
  expect(dotdot.ok ? '' : dotdot.error).toMatch(/kebab-case/u)
  const absolute = sw.archiveSkill('C:\\Windows\\System32', 'user')
  expect(absolute.ok).toBe(false)
  expect(absolute.ok ? '' : absolute.error).toMatch(/kebab-case/u)
})

// 第 11 条：附属文件那条路同样先校验技能名，别让 `../` 把文件写到技能根之外。
test('writeSkillFile：技能名不合法直接拒（../../outside）', () => {
  const result = sw.writeSkillFile({
    name: '../../outside',
    filePath: 'references/a.md',
    content: 'x',
    actor: 'user',
    readConfirmed: true,
  })
  expect(result.ok).toBe(false)
  expect(result.ok ? '' : result.error).toMatch(/kebab-case/u)
})
