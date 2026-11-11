/**
 * @pneuma/self-improve 的自修订测试：钉住「读过」的两条证据与 patch 回答的解析。
 *
 * 为什么钉这几条：
 *   - `skillNamesReadInMessages` 少认 `<skill_content>` 标签，「用 /技能名 干活 → 报错 →
 *     想改它」就会一直被 read-before-write 挡在门外；
 *   - `parseDraftAnswer` 多认一种 patch 形状，不能把原来的 create 形状弄坏。
 *
 * 隔离：只 import lib 产物里的纯函数，不碰会话、模型与 ~/.dsc。
 * 用法：pnpm run build && node --test "src/packages/self-improve/tests/*.test.mjs"
 *
 * @module @pneuma/self-improve/tests/revision
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

const mod = await import('../../../../lib/packages/self-improve/index.js')
const sw = await import('../../../../lib/packages/self-improve/skill-write.js')
let passed = 0

/** `/技能名` 注入正文那条路：正文里带着 `<skill_content name="X">` 标签。 */
const userWithSkillContent = (name) => ({
  role: 'user',
  content: `请使用技能 ${name} 处理下面的需求。\n\n<skill_content name="${name}">\n# 正文\n</skill_content>`,
})

// 第 1 条：`/技能名` 注入的标签也算「读过」，且 read-before-write 因此放行。
test('skillNamesReadInMessages：认 user 消息里的 <skill_content name>', () => {
  const names = sw.skillNamesReadInMessages([userWithSkillContent('git-flow')])
  assert.deepEqual(names, ['git-flow'])
  const check = sw.readBeforeWriteCheck({
    readSkills: [],
    createdSkills: [],
    messages: [userWithSkillContent('git-flow')],
    name: 'git-flow',
  })
  assert.equal(check.ok, true, check.error)
  passed += 1
})

// 第 2 条：同一条消息里两个同名标签只算一次（同一个技能被贴两遍不该出现两个名字）。
test('skillNamesReadInMessages：同一段落两个标签去重', () => {
  const message = {
    role: 'user',
    content:
      '看这份技能\n<skill_content name="alpha">第一段</skill_content>\n' +
      '再贴一遍\n<skill_content name="alpha">第二段</skill_content>\n',
  }
  assert.deepEqual(sw.skillNamesReadInMessages([message]), ['alpha'])
  passed += 1
})

// 第 3 条：`skill` 工具那条路（tool_calls）没有被改坏（回归）。
test('skillNamesReadInMessages：skill 工具的 tool_calls 照样认', () => {
  const names = sw.skillNamesReadInMessages([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'skill', arguments: '{"name":"beta"}' } }],
    },
  ])
  assert.deepEqual(names, ['beta'])
  passed += 1
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
  assert.equal(answer.kind, 'revision')
  assert.equal(answer.revision.name, 'git-flow')
  assert.equal(answer.revision.old_string, '- 先跑 pnpm test')
  assert.equal(answer.revision.new_string, '- 先跑 pnpm run typecheck，再跑 pnpm test')
  assert.equal(answer.revision.reason, '少了一步类型检查')
  passed += 1
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
  assert.equal(answer.kind, 'invalid')
  assert.match(answer.error, /old_string/u)
  passed += 1
})

// 第 6 条：缺字段判 invalid，且错误信息点名缺哪一项。
test('parseDraftAnswer：patch 缺字段判 invalid 并点名缺哪项', () => {
  const missingNew = mod.parseDraftAnswer(
    JSON.stringify({ action: 'patch', name: 'git-flow', old_string: 'a', reason: 'r' }),
  )
  assert.equal(missingNew.kind, 'invalid')
  assert.match(missingNew.error, /new_string/u, missingNew.error)

  const missingReason = mod.parseDraftAnswer(
    JSON.stringify({ action: 'patch', name: 'git-flow', old_string: 'a', new_string: 'b' }),
  )
  assert.equal(missingReason.kind, 'invalid')
  assert.match(missingReason.error, /reason/u, missingReason.error)
  passed += 1
})

// 第 7 条：原来的 create 形状仍解析成 draft（回归），显式 action:create 也一样。
test('parseDraftAnswer：create 形状仍解析成 draft（回归）', () => {
  const plain = mod.parseDraftAnswer(
    '{"name":"git-flow","description":"整理提交","whenToUse":"提交前","content":"# 步骤"}',
  )
  assert.equal(plain.kind, 'draft')
  assert.equal(plain.draft.name, 'git-flow')
  const explicit = mod.parseDraftAnswer(
    '{"action":"create","name":"git-flow","description":"整理提交","whenToUse":"提交前","content":"# 步骤"}',
  )
  assert.equal(explicit.kind, 'draft')
  assert.equal(explicit.draft.content, '# 步骤')
  passed += 1
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
  assert.equal(answer.kind, 'revision')
  assert.equal(answer.revision.reason, '原文过期')
  passed += 1
})

// 第 11 条：候选里的名字来自模型输出，`../evil` 不许被 patchSkill 拼到技能根之外。
test('patchSkill：技能名不合法直接拒（../evil）', () => {
  const result = sw.patchSkill({
    name: '../evil',
    oldString: 'a',
    newString: 'b',
    actor: 'user',
    readConfirmed: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /kebab-case/u, result.error)
  passed += 1
})

// 第 12 条：归档要 rename 整个目录，`..` 与绝对路径都必须被名字校验拦下。
test('archiveSkill：名字是 .. 或绝对路径都拒', () => {
  const dotdot = sw.archiveSkill('..\\evil', 'user')
  assert.equal(dotdot.ok, false)
  assert.match(dotdot.error, /kebab-case/u, dotdot.error)
  const absolute = sw.archiveSkill('C:\\Windows\\System32', 'user')
  assert.equal(absolute.ok, false)
  assert.match(absolute.error, /kebab-case/u, absolute.error)
  passed += 1
})

// 第 13 条：附属文件那条路同样先校验技能名，别让 `../` 把文件写到技能根之外。
test('writeSkillFile：技能名不合法直接拒（../../outside）', () => {
  const result = sw.writeSkillFile({
    name: '../../outside',
    filePath: 'references/a.md',
    content: 'x',
    actor: 'user',
    readConfirmed: true,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /kebab-case/u, result.error)
  passed += 1
})

after(() => {
  console.log('通过 ' + String(passed) + ' 项')
})
