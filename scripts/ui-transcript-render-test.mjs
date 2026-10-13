/**
 * 消息流渲染的三条报障修复的确定性探针（0.6.67 第三轮）：
 *
 *   ① **组员被渲染两次**：一轮里除组头以外的组员，既在组体里铺一遍、又在外面单独铺
 *      一遍——用户看到「已写入文件 2 项」下面跟着两条一模一样的思考栏。修法是把
 *      「哪条行归哪儿」搬成纯函数 `seatPlan`（`process-groups.ts`），本探针断言它的
 *      不变量：**每条行恰好出现一次**。
 *   ③ **思考完毕闪屏折叠**：直播尾的思考行原来被强制展开（`live || …`），定稿后换成
 *      正 id 的新条目 → React key 变 → 重挂 → 按默认档位算成收起 → 用户眼前那段摊开的
 *      思考整体收拢。参考实现（dsh 的 ReasoningRow）从不这么做：推理行一律以收起态
 *      起步，running 只改折叠行右边那句预览的取法。
 *   ④ **编辑卡的展开体摊原始 JSON 参数**：write / edit 的正文（content / old / new）
 *      缩在 JSON 字符串里全是 `\n` 转义。参考实现（dsh 的 FileMutationRow）对这两个工具
 *      只画 diff；壳照同一口径分流——正文走 diff 块，其余字段走参数表。
 *
 * 四段：
 *   [1] 纯逻辑：`seatPlan`（每条行恰好一次 / 组员不单独出 / 组内顺序 / 空表 / 组头位置）
 *   [2] 纯逻辑：`toolArgFields`（会改文件的工具分流 + 正文字段剔除 + 半截参数的降级）
 *   [3] 形态钉：ui.tsx 的 seatPlan 消费点、ThinkRow 不再强制展开、factory 的 diff/参数表
 *   [4] 漂移钉：参数表的字段名与宿主工具真定义对得上（`src/core/tools/fs-tools.ts`）
 *
 * 运行：node scripts/ui-transcript-render-test.mjs
 *
 * @module dsc/scripts/ui-transcript-render-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const groups = await import(
  new URL('../ui-shell/src/plugins/transcript/process-groups.ts', import.meta.url).href
)
const args = await import(new URL('../ui-shell/src/ui-primitives/tool-args.ts', import.meta.url).href)
const { seatPlan, groupSteps } = groups
const { toolArgFields, MUTATION_CONTENT_FIELDS } = args

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 造一条条目（探针只喂 kind 与分组用得着的字段）。 */
const entry = (kind, extra = {}) => ({ kind, id: Math.floor(Math.random() * 100000) + 1, ...extra })

console.log('[1] seatPlan：每条行恰好出现一次')
{
  // 一轮：[user, thinking, tool, text, thinking, tool]——两个组各 2 员，正文把两组切开
  const entries = [
    entry('user', { text: '题面' }),
    entry('thinking', { text: '想一' }),
    entry('tool', { call: { callId: 'a', name: 'read', argsText: '{}', status: 'done' } }),
    entry('text', { text: '第一段答' }),
    entry('thinking', { text: '想二' }),
    entry('tool', { call: { callId: 'b', name: 'write', argsText: '{}', status: 'done' } }),
  ]
  const rounds = [{ index: 0, startIndex: 0, endIndex: 5, startTs: 1, endTs: 2, answered: true }]
  const grouping = groupSteps(entries, rounds, () => false)
  check('分组器切出两个组', grouping.groups.length === 2, String(grouping.groups.length))
  check('两组各两员', grouping.groups.every((group) => group.size === 2))

  const ats = entries.map((_, index) => index).slice(1)
  const items = seatPlan(ats, grouping)
  const seen = []
  for (const item of items) {
    if (item.kind === 'group') seen.push(...item.members)
    else seen.push(item.at)
  }
  check('每条行恰好出现一次（0.6.67 的重复就是这么来的）', seen.length === ats.length && new Set(seen).size === ats.length, JSON.stringify(seen))
  check('顺序与出现顺序一致', JSON.stringify(seen) === JSON.stringify([...seen].sort((a, b) => a - b)))
  check('两个组块（正文那条单独出）', items.filter((item) => item.kind === 'group').length === 2 && items.filter((item) => item.kind === 'row').length === 1)
  check('组员绝不出现在 row 项里（组体铺过就不再单独铺）', items.filter((item) => item.kind === 'row').every((item) => !grouping.at.has(item.at)))
  check('组块带全成员（升序）', items.filter((item) => item.kind === 'group').every((item) => JSON.stringify(item.members) === JSON.stringify([...item.members].sort((a, b) => a - b))))
  check('空表进空表出', seatPlan([], grouping).length === 0)
  // detailed 档的「运行中那一轮」：settledOnly 跳过它，于是一组都不成——全出 row 项
  const running = groupSteps(entries, rounds, () => true, true)
  check('没有分组的轮（detailed 档的运行中轮）全出 row 项', running.groups.length === 0 && seatPlan(ats, running).every((item) => item.kind === 'row'))
}

console.log('[2] toolArgFields：会改文件的工具走参数表')
{
  const write = toolArgFields('write', JSON.stringify({ path: 'a.md', justification: '因为', content: '# 标题\n正文' }))
  check('write 认成会改文件的工具', write.mutating === true)
  check('正文（content）不进参数表', !write.fields.some((field) => field.key === 'content') && write.omitted.includes('content'), JSON.stringify(write.omitted))
  check('其余字段按原序进表', write.fields.map((field) => field.key).join(',') === 'path,justification', write.fields.map((field) => field.key).join(','))
  check('值压成一行（正文之外的字段不留换行）', write.fields.every((field) => !field.value.includes('\n')))

  const edit = toolArgFields('edit', JSON.stringify({ path: 'a.ts', old: '一', new: '二' }))
  check('edit 的 old / new 都剔出去', edit.omitted.includes('old') && edit.omitted.includes('new') && edit.fields.length === 1)

  const mcp = toolArgFields('str_replace_editor', JSON.stringify({ path: 'a.ts', old_str: 'x', new_str: 'y', file_text: 'z' }))
  check('别家的写文件工具同样分流（str_replace_editor）', mcp.mutating === true && mcp.fields.length === 1)

  const bash = toolArgFields('bash', JSON.stringify({ command: 'ls' }))
  check('非文件工具不分流（照旧摊参数 JSON）', bash.mutating === false && bash.fields.length === 0)

  const half = toolArgFields('write', '{"path":"a.md","cont')
  check('半截参数（流式中）仍报 mutating、但参数表为空', half.mutating === true && half.fields.length === 0)
  const notObject = toolArgFields('write', '[1,2]')
  check('参数不是对象也照上面那条降级', notObject.mutating === true && notObject.fields.length === 0)

  const values = toolArgFields('write', JSON.stringify({ path: 'a.md', flags: [1, 2], meta: { a: 1 }, content: 'x' }))
  check('对象/数组的值压成一行 JSON', values.fields.some((field) => field.key === 'flags' && field.value === '[1,2]'))
  check('正文之外的字段一个不丢', values.fields.length === 3)
}

console.log('[3] 形态钉（ui.tsx / factory.tsx / status 的催拍）')
{
  const ui = read('ui-shell/src/plugins/transcript/ui.tsx')
  const factory = read('ui-shell/src/plugins/transcript/tool-card/factory.tsx')
  const pgs = read('ui-shell/src/plugins/transcript/process-groups.ts')
  const status = read('ui-shell/src/plugins/status/ui.tsx')

  check('ui.tsx 的排布走纯函数 seatPlan（规则不在渲染体里）', ui.includes('for (const item of seatPlan(') && ui.includes("import { groupSteps, seatPlan,"))
  check('process-groups.ts 的 seatPlan 是纯逻辑（不引 React）', !/from 'react'/.test(pgs) && pgs.includes('export function seatPlan('))

  // 「不该出现」的断言先剥注释：修法自己的注释里就引着旧写法，不剥会自己打脸。
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  check('③ 直播尾不再强制展开（readFold 的默认值只有用户的档位）', uiCode.includes('readFold(storeKey, prefs.reasoningOpen)') && !uiCode.includes('readFold(storeKey, live ||'))
  check('③ 直播的「还活着」由扫光/摘要/小圈承载（三样都在）', ui.includes('data-shimmer={live ? summary : undefined}') && ui.includes('think-status') && ui.includes('think-sr'))

  check('④ 展开体按「有没有 diff」分流参数', factory.includes('const paramsAsFields = patch !== null && argView.mutating'))
  check('④ 会改文件的工具渲染字段表（.arg-fields）', factory.includes('className="args arg-fields"') && factory.includes('argView.fields.map('))
  check('④ 没有 diff 时仍摊原始 JSON（不丢信息）', factory.includes('<div className="args">{prettyJson(call.argsText)}</div>'))
  check('④ 落地后的 diff 由 bodyExtra 的 fallback 接手（轨迹页也看得到）', factory.includes("useFactorySlot('bodyExtra', IntendedBody)") && factory.includes("data-tc-change=\"\""))

  check('⑤ git 轮询效果吃 gitNudge（自增即重拍）', status.includes('}, [channel, gitNudge])') && status.includes('lastGitPollRef.current = startedAt'))
  check('⑤ 换工作区催拍（会话路径 / 工作目录）', status.includes('}, [sessionPathKey, cwdKey, nudgeGit])'))
  check('⑤ 回合收工催拍（dsh 的 turn/end 同款）', status.includes("if (was !== 'idle' && turnState === 'idle') nudgeGit()"))
  check('⑤ 催拍有间隔下限（一拍刚跑过就不重拍）', status.includes('GIT_NUDGE_FLOOR_MS') && status.includes('Date.now() - lastGitPollRef.current < GIT_NUDGE_FLOOR_MS'))
}

console.log('[4] 漂移钉：参数表的字段名与宿主工具真定义对得上')
{
  const fsTools = read('src/core/tools/fs-tools.ts')
  // write 的 required 是 path + content；edit 的 required 是 path + old + new
  check('宿主 write 的正文参数确实叫 content', /name: 'write'[\s\S]{0,400}?content: \{ type: 'string'/.test(fsTools))
  check('宿主 edit 的两个参数确实叫 old / new', /name: 'edit'[\s\S]{0,600}?old: \{ type: 'string'/.test(fsTools) && /name: 'edit'[\s\S]{0,900}?new: \{ type: 'string'/.test(fsTools))
  check('壳的表与宿主口径一致（write→content、edit→old+new）', MUTATION_CONTENT_FIELDS['write'].join(',') === 'content' && MUTATION_CONTENT_FIELDS['edit'].join(',') === 'old,new')
  check('两张表都覆盖 write / edit', ['write', 'edit'].every((name) => name in MUTATION_CONTENT_FIELDS))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
