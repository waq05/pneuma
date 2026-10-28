/**
 * 斜杠命令电池（0.6.63）：新命令 fork/thinking/plugins/update/permission 的
 * handler 直测 + PresetPicker/SkillsPicker/两级 SessionPicker 的渲染冒烟。
 *
 * 起真内核让命令插件挂上 serviceRef（/preset /skills 的 handler 在 presets/skills
 * 插件里，内核装配时一并注册），派发走 runCommand 兼容导出——与 App/桌面同一条链。
 * /fork 用真实 core forkSession 落盘验证「整本分叉」哨兵（顺带回归选择器 Ctrl+F
 * 传 messages.length 的存量炸点）；/update 用本地假更新源（DSC_UPDATE_CHECK_URL 缝）。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/commands-battery.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import React from 'react'

const home = mkdtempSync(join(tmpdir(), 'dsc-commands-'))
process.env.HOME = home
process.env.USERPROFILE = home
mkdirSync(join(home, '.dsc'), { recursive: true })
// 假端点：内核装配需要一个能读的 config.yaml，不连真模型
writeFileSync(join(home, '.dsc', 'config.yaml'), 'model:\n  name: test\n', 'utf8')

const { createKernel } = await import('../lib/host/kernel.js')
const { runCommand } = await import('../lib/plugins/commands.js')
const { allSpecs } = await import('../lib/core/commands-completion.js')
const { forkSession, readUserMessages } = await import('../lib/core/session.js')

// 起内核：presets/skills/commands 插件在此挂载，serviceRef 与 /preset /skills handler 就位
await createKernel({ config: {}, resumeSessionPath: undefined })

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('── spec 表：九个命令全部可补全 ──')
const specNames = new Set(allSpecs().map((spec) => spec.name))
for (const name of ['fork', 'export', 'preset', 'thinking', 'skills', 'plugins', 'update', 'policy', 'reviewer', 'permission']) {
  check(`/Command ${name} 在 spec 表里`, specNames.has(name))
}
const forkSpec = allSpecs().find((spec) => spec.name === 'fork')
const updateSpec = allSpecs().find((spec) => spec.name === 'update')
check('fork 与 update 声明 duringTask=deny', forkSpec?.duringTask === 'deny' && updateSpec?.duringTask === 'deny')
// 0.6.68 起权限拆成三根旋钮三个入口：/policy（权限模式单档）、/reviewer（审阅者）、
// /permission（打包预设）。三者各管一根，**permission 不再是 policy 的别名**（旧断言作废）。
const policySpec = allSpecs().find((spec) => spec.name === 'policy')
const reviewerSpec = allSpecs().find((spec) => spec.name === 'reviewer')
const permissionSpec = allSpecs().find((spec) => spec.name === 'permission')
check(
  'policy / reviewer / permission 三个 spec 各管一根旋钮（permission 已不是 policy 别名）',
  policySpec?.args === '[readonly|auto-edit|full-access]' &&
    reviewerSpec?.args === '[user|auto-review]' &&
    permissionSpec?.args === '[预设名]',
  JSON.stringify([policySpec?.args, reviewerSpec?.args, permissionSpec?.args]),
)

/** 派发一条命令：收 notice 与回调命中的假 CommandContext。 */
const makeUi = (overrides = {}) => {
  const calls = { notices: [], openModels: 0, openPresets: 0, openSkills: 0, toggleThinking: [] }
  const ui = {
    openPicker() {},
    openModels() {
      calls.openModels += 1
    },
    openPresets() {
      calls.openPresets += 1
    },
    openSkills() {
      calls.openSkills += 1
    },
    toggleThinking(visible) {
      calls.toggleThinking.push(visible)
    },
    notice(text) {
      calls.notices.push(text)
    },
    ...overrides,
  }
  return { ui, calls }
}

console.log('── /fork：整本分叉落盘，现场会话不动 ──')
mkdirSync(join(home, '.dsc', 'sessions', 'w'), { recursive: true })
const sourceLines = [
  JSON.stringify({ type: 'meta', id: 'src-1', cwd: 'D:\\w', createdAt: 1 }),
  JSON.stringify({ type: 'user', text: '第一问' }),
  JSON.stringify({ type: 'assistant', text: '第一答' }),
  JSON.stringify({ type: 'user', text: '第二问' }),
  JSON.stringify({ type: 'assistant', text: '第二答' }),
]
const sourcePath = join(home, '.dsc', 'sessions', 'w', 'src-1.jsonl')
writeFileSync(sourcePath, `${sourceLines.join('\n')}\n`, 'utf8')
const forkRuntime = {
  // 真机快照形状：sessionId 是 uuid，sessionPath 才是 jsonl 路径（0.6.65 之前
  // mock 把 uuid 造成了路径，/fork 拿 uuid 落盘时按 cwd 解析出 ENOENT 没被测出）
  getSnapshot: () => ({
    status: { turnState: 'idle', sessionId: '01890a5e-aaaa-4bbb-8ccc-ddddeeeeffff', sessionPath: sourcePath },
  }),
  listUserMessages: (path) => Promise.resolve(readUserMessages(path)),
  forkSession: (path, index) => Promise.resolve({ ok: true, path: forkSession(path, index) }),
}
{
  const { ui, calls } = makeUi()
  runCommand('/fork', forkRuntime, ui)
  await sleep(200)
  check('/fork 成功回执提到副本与 /resume', (calls.notices[0] ?? '').includes('已分叉出副本') && (calls.notices[0] ?? '').includes('/resume'), JSON.stringify(calls.notices))
  // 副本落在 slugCwd(源 cwd) = 'D-w' 目录（不是源所在的 w/）
  const forkedDir = join(home, '.dsc', 'sessions', 'D-w')
  const forkedName = readdirSync(forkedDir)[0]
  check('分叉出了新 jsonl（整本哨兵修复生效）', forkedName !== undefined && forkedName.endsWith('.jsonl'), JSON.stringify(readdirSync(forkedDir)))
  const forkedLines = readFileSync(join(forkedDir, forkedName ?? ''), 'utf8').trim().split('\n')
  check('副本含全部问答（meta 换新 id）', forkedLines.length === 5 && forkedLines[3]?.includes('第二问') && JSON.parse(forkedLines[0]).id !== 'src-1', String(forkedLines.length))
  check('副本首行 meta 标了 forkedFrom', JSON.parse(readFileSync(join(home, '.dsc', 'sessions', 'meta.json'), 'utf8')).sessions[JSON.parse(forkedLines[0]).id]?.forkedFrom === 'src-1')
}
{
  const { ui, calls } = makeUi()
  runCommand('/fork', { getSnapshot: () => ({ status: { turnState: 'idle', sessionId: null } }) }, ui)
  await sleep(50)
  check('空会话 /fork 给人话提示', (calls.notices[0] ?? '').includes('还没有可分叉的会话'), JSON.stringify(calls.notices))
}

console.log('── 裸 /model：只开选择器，不再发常驻用法提示（0.6.66）──')
{
  const { ui, calls } = makeUi()
  runCommand('/model', { getSnapshot: () => ({ status: { turnState: 'idle' } }) }, ui)
  check('裸 /model 开模型选择器', calls.openModels === 1, JSON.stringify(calls))
  check('裸 /model 不再发用法 notice', calls.notices.length === 0, JSON.stringify(calls.notices))
}

console.log('── /thinking：toggleThinking 回调（缺省翻转、显式 on/off）──')
{
  const { ui, calls } = makeUi()
  runCommand('/thinking', {}, ui)
  check('无参数 = 翻转（visible 传 undefined）', calls.toggleThinking.length === 1 && calls.toggleThinking[0] === undefined, JSON.stringify(calls.toggleThinking))
  runCommand('/thinking on', {}, ui)
  runCommand('/thinking off', {}, ui)
  check('on/off 显式传值', calls.toggleThinking[1] === true && calls.toggleThinking[2] === false, JSON.stringify(calls.toggleThinking))
  runCommand('/thinking sideways', {}, ui)
  check('未知参数给用法', (calls.notices[0] ?? '').includes('用法：/thinking'), JSON.stringify(calls.notices))
}
{
  const { ui, calls } = makeUi({ toggleThinking: undefined })
  runCommand('/thinking', {}, ui)
  check('没接回调的端给兜底提示不炸', (calls.notices[0] ?? '').includes('当前界面不支持会话内切换思考块'), JSON.stringify(calls.notices))
}

console.log('── /plugins：清单走多行 notice ──')
{
  const { ui, calls } = makeUi()
  const pluginsRuntime = {
    listPlugins: () => [
      { file: 'commands', name: 'commands', description: '命令注册表', enabled: true, source: 'builtin', toggleable: false },
      { file: 'my-plugin.js', name: 'my-plugin', description: '外部示例', enabled: false, source: 'external', toggleable: true, problem: 'apiVersion 过新' },
    ],
  }
  runCommand('/plugins', pluginsRuntime, ui)
  const text = calls.notices[0] ?? ''
  check('插件清单含两个插件与启停标记', text.includes('commands（内核）') && text.includes('my-plugin（外部 · 已停用）'), JSON.stringify(text))
  check('problem 上了屏', text.includes('apiVersion 过新'))
  check('头部有总数', text.includes('已挂载插件（2 个）'))
}

console.log('── /policy 与 /reviewer：单档两根轴（三档 + 两位审阅者，前缀匹配）──')
// 假 surface 照新契约形状补全：policy 带 reviewer / reviewerOptions（正交的审阅者轴），
// 另有恒在场的 permissionPresets（打包预设投影）。缺了会读到 undefined 当场炸。
const policySurface = {
  current: 'auto-edit',
  options: [
    { id: 'readonly', label: '仅查看', hint: '只看不改' },
    { id: 'auto-edit', label: '自动编辑', hint: '文件自动放行' },
    { id: 'full-access', label: '完全访问', hint: '全部自动放行' },
  ],
  reviewer: 'user',
  reviewerOptions: [
    { id: 'user', label: '本人审阅', hint: '弹审批卡等你点' },
    { id: 'auto-review', label: 'AI 复核', hint: '先给模型判官看' },
  ],
}
const presetSurface = {
  current: 'custom',
  defaultName: 'workspace',
  options: [
    { name: 'read-only', label: '只读', description: '写盘与执行一律拒', sandbox: 'read-only', policy: 'readonly', reviewer: 'user', builtin: true },
    { name: 'workspace', label: '工作区可写', description: '区内自动放行', sandbox: 'workspace-write', policy: 'auto-edit', reviewer: 'user', builtin: true },
    { name: 'full-access', label: '完全访问', description: '什么都不问', sandbox: 'danger-full-access', policy: 'full-access', reviewer: 'user', builtin: true },
    { name: 'auto-review', label: 'AI 复核', description: '每个调用先过判官', sandbox: 'danger-full-access', policy: 'full-access', reviewer: 'auto-review', builtin: true },
  ],
}
const policyRuntime = (overrides = {}) => ({
  getSnapshot: () => ({ status: { turnState: 'idle' }, surfaces: { policy: policySurface, permissionPresets: presetSurface } }),
  setPolicy(policy) {
    policyRuntime.lastPolicy = policy
  },
  setReviewer(reviewer) {
    policyRuntime.lastReviewer = reviewer
  },
  usePermissionPreset(name) {
    policyRuntime.lastPreset = name
    return { ok: true, notice: `权限预设切到「${name}」` }
  },
  ...overrides,
})
policyRuntime.lastPolicy = undefined
policyRuntime.lastReviewer = undefined
policyRuntime.lastPreset = undefined
{
  const { ui, calls } = makeUi()
  runCommand('/policy', policyRuntime(), ui)
  check(
    '裸 /policy 列出三档与当前档（四档的 ai-review 已删）',
    (calls.notices[0] ?? '').includes('当前权限模式：auto-edit') &&
      (calls.notices[0] ?? '').includes('readonly') &&
      (calls.notices[0] ?? '').includes('full-access') &&
      !(calls.notices[0] ?? '').includes('ai-review'),
    JSON.stringify(calls.notices),
  )
  runCommand('/policy full', policyRuntime(), ui)
  check('/policy full 前缀匹配切档', policyRuntime.lastPolicy === 'full-access', String(policyRuntime.lastPolicy))
  runCommand('/policy nope', policyRuntime(), ui)
  check('未知权限档位报可选清单', (calls.notices[1] ?? '').includes('未知权限档位'), JSON.stringify(calls.notices))
}
{
  const { ui, calls } = makeUi()
  runCommand('/reviewer', policyRuntime(), ui)
  check(
    '裸 /reviewer 列出两位审阅者与当前',
    (calls.notices[0] ?? '').includes('当前审阅者：user') && (calls.notices[0] ?? '').includes('auto-review'),
    JSON.stringify(calls.notices),
  )
  runCommand('/reviewer auto', policyRuntime(), ui)
  check('/reviewer auto 前缀匹配切审阅者', policyRuntime.lastReviewer === 'auto-review', String(policyRuntime.lastReviewer))
  runCommand('/reviewer nope', policyRuntime(), ui)
  check('未知审阅者报可选清单', (calls.notices[1] ?? '').includes('未知审阅者'), JSON.stringify(calls.notices))
}

console.log('── /permission：打包预设选择器（不再是 /policy 的别名）──')
{
  const { ui, calls } = makeUi()
  runCommand('/permission', policyRuntime(), ui)
  const bareText = calls.notices[0] ?? ''
  check(
    '裸 /permission 列出当前预设（custom 带说明）与四个预设',
    bareText.includes('当前权限预设：custom') &&
      bareText.includes('三根旋钮的组合不匹配任何预设') &&
      ['read-only', 'workspace', 'full-access', 'auto-review'].every((name) => bareText.includes(name)),
    JSON.stringify(bareText),
  )
  runCommand('/permission full', policyRuntime(), ui)
  check(
    '/permission full 前缀匹配到 full-access 并调用 usePermissionPreset',
    policyRuntime.lastPreset === 'full-access',
    String(policyRuntime.lastPreset),
  )
  runCommand('/permission readonly', policyRuntime(), ui)
  check(
    '档位名被误当预设名时给出「这是档位不是预设」的指路提示',
    (calls.notices[1] ?? '').includes('是权限档位不是预设') && (calls.notices[1] ?? '').includes('/policy readonly'),
    JSON.stringify(calls.notices),
  )
  runCommand('/permission nope', policyRuntime(), ui)
  check('未知预设报可选清单', (calls.notices[2] ?? '').includes('未知权限预设'), JSON.stringify(calls.notices))
}
{
  // usePermissionPreset 失败（例如沙箱插件缺席时那一半没落地）要把错误照原话上屏
  const failUi = makeUi()
  runCommand('/permission auto-review', policyRuntime({ usePermissionPreset: () => ({ ok: false, error: '沙箱插件没开，danger-full-access 这一半没落地' }) }), failUi.ui)
  check('usePermissionPreset 报错时把错误原话上屏', (failUi.calls.notices[0] ?? '').includes('没落地'), JSON.stringify(failUi.calls.notices))
}

console.log('── /update：假更新源（DSC_UPDATE_CHECK_URL 缝），只查不装 ──')
{
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ version: '999.0.0', url: 'http://127.0.0.1:1/page' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  process.env.DSC_UPDATE_CHECK_URL = `http://127.0.0.1:${port}/releases/latest`
  const { ui, calls } = makeUi()
  runCommand('/update', { getSnapshot: () => ({ status: { turnState: 'idle' } }) }, ui)
  await sleep(400)
  check('有新版时给出版本与发布页', (calls.notices[0] ?? '').includes('发现新版 999.0.0') && (calls.notices[0] ?? '').includes('发布页'), JSON.stringify(calls.notices))
  const { DSC_VERSION } = await import('../lib/core/version.js')
  server.close()
  const server2 = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ version: DSC_VERSION, url: '' }))
  })
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve))
  process.env.DSC_UPDATE_CHECK_URL = `http://127.0.0.1:${server2.address().port}/releases/latest`
  const again = makeUi()
  runCommand('/update', { getSnapshot: () => ({ status: { turnState: 'idle' } }) }, again.ui)
  await sleep(400)
  check('已是最新给版本号', (again.calls.notices[0] ?? '').includes('已是最新'), JSON.stringify(again.calls.notices))
  server2.close()
  delete process.env.DSC_UPDATE_CHECK_URL
}

console.log('── 裸 /preset /skills：有选择器的端开浮层，没接的端 notice 兜底 ──')
{
  const withPicker = makeUi()
  runCommand('/preset', {}, withPicker.ui)
  check('裸 /preset 走 openPresets 回调', withPicker.calls.openPresets === 1 && withPicker.calls.notices.length === 0, JSON.stringify(withPicker.calls))
  const withSkills = makeUi()
  runCommand('/skills', {}, withSkills.ui)
  check('裸 /skills 走 openSkills 回调', withSkills.calls.openSkills === 1 && withSkills.calls.notices.length === 0, JSON.stringify(withSkills.calls))
  const fallback = makeUi({ openPresets: undefined, openSkills: undefined })
  runCommand('/preset', {}, fallback.ui)
  check('没接回调时 /preset 落回 notice 清单', (fallback.calls.notices[0] ?? '').includes('当前模式：'), JSON.stringify(fallback.calls.notices))
  runCommand('/skills', {}, fallback.ui)
  check('没接回调时 /skills 落回 notice 清单', (fallback.calls.notices[1] ?? '').includes('技能'), JSON.stringify(fallback.calls.notices))
}

console.log('── duringTask 闸：deny 命令回合中挡下 ──')
{
  const { ui, calls } = makeUi()
  const busyRuntime = {
    getSnapshot: () => ({ status: { turnState: 'working', sessionId: sourcePath } }),
    listUserMessages: () => Promise.resolve([]),
    forkSession: () => Promise.resolve({ ok: true, path: '/tmp/x.jsonl' }),
  }
  runCommand('/fork', busyRuntime, ui)
  check('回合中 /fork 被派发闸挡下', (calls.notices[0] ?? '').includes('要等当前回合结束'), JSON.stringify(calls.notices))
}

console.log('── 渲染冒烟：三个浮层组件 ──')
const { PresetPicker } = await import('../lib/app/PresetPicker.js')
const { SkillsPicker } = await import('../lib/app/SkillsPicker.js')
const { SessionPicker } = await import('../lib/app/SessionPicker.js')
const { render } = await import('ink')

// statusbar-test 的经验：render 的 stdout 选项要带 columns（组件 useStdout 看到的那份），
// 帧内容用 \x1b[2K 尾部截取再剥 ANSI（这版 ink 没有 lastFrame）。列数给足 200，
// 提示行很长，110 列会被 truncate-end 截掉 Esc 提示。
const renderFrame = async (element) => {
  const stdout = new PassThrough()
  stdout.columns = 200
  stdout.rows = 30
  let output = ''
  stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  const instance = render(element, { stdout, exitOnCtrlC: false, patchConsole: false })
  await sleep(120)
  instance.unmount()
  const idx = output.lastIndexOf('\x1b[2K')
  const tail = idx >= 0 ? output.slice(idx) : output
  return tail.replace(/\x1b\[[0-9;?<]*[A-Za-z]/g, '')
}

{
  const frame = await renderFrame(
    React.createElement(PresetPicker, {
      presets: [
        { name: 'standard', label: '标准', description: '全量工具', builtin: true },
        { name: 'maker', label: '创造', description: '写作向', builtin: true },
        { name: 'mine', label: '我的', description: '自编', builtin: false },
      ],
      current: 'maker',
      defaultName: 'standard',
      index: 1,
      query: '',
    }),
  )
  check('PresetPicker：标题与条数', frame.includes('模式选择（3 个）'))
  check('PresetPicker：当前/默认/内置标记', frame.includes('✓ 当前') && frame.includes('默认') && frame.includes('内置'))
  check('PresetPicker：选中行高亮（❯ 在创造上）', (frame.split('\n').find((line) => line.includes('❯')) ?? '').includes('创造'))
}
{
  const frame = await renderFrame(
    React.createElement(SkillsPicker, {
      skills: [
        { name: 'review-pr', description: '审查 PR', source: 'user-dsc', enabled: true, modelInvocable: true, userInvocable: true, toggleable: true },
        { name: 'legacy', description: '老技能', source: 'custom', enabled: false, modelInvocable: false, userInvocable: false, toggleable: true },
      ],
      index: 0,
      query: '',
    }),
  )
  check('SkillsPicker：清单与斜杠名', frame.includes('技能（2 个）') && frame.includes('/review-pr'))
  check('SkillsPicker：已停用与不进目录标记', frame.includes('已停用') && frame.includes('不进目录'))
  check('SkillsPicker：来源标签', frame.includes('user-dsc'))
}
{
  const frame = await renderFrame(
    React.createElement(SessionPicker, {
      level: 'workspaces',
      workspaces: [
        { cwd: '/proj/beta', name: 'beta', count: 5, latest: 1_800_000_500_000, current: true },
        { cwd: '/proj/alpha', name: 'alpha', count: 8, latest: 1_800_000_000_000, current: false },
      ],
      sessions: [],
      total: 2,
      start: 0,
      index: 0,
      page: 'active',
      query: '',
      buffer: null,
      armed: false,
      loading: false,
      sessionStates: {},
    }),
  )
  check('SessionPicker：工作区层标题与个数', frame.includes('恢复会话 · 选工作区') && frame.includes('2 个工作区'))
  check('SessionPicker：行带条数与当前标记', frame.includes('5 条') && frame.includes('← 当前'))
  check('SessionPicker：工作区层提示进工作区', frame.includes('Enter 进入工作区') && frame.includes('Esc 关闭'))
}
{
  const frame = await renderFrame(
    React.createElement(SessionPicker, {
      level: 'sessions',
      workspaceTitle: 'beta',
      sessions: [{ id: '/tmp/tb/b-0.jsonl', cwd: '/proj/beta', createdAt: 1_700_000_000_000, updatedAt: 1_800_000_000_000, title: '乙' }],
      total: 1,
      start: 0,
      index: 0,
      page: 'active',
      query: '',
      buffer: null,
      armed: false,
      loading: false,
      sessionStates: {},
    }),
  )
  check('SessionPicker：会话层面包屑', frame.includes('恢复会话 › beta'))
  check('SessionPicker：提示 Esc 返回工作区列表', frame.includes('Esc 返回工作区列表'))
}

console.log('')
if (failures === 0) {
  console.log('命令电池：全部通过')
} else {
  console.log(`命令电池：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
