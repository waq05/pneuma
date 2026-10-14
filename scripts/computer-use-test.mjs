/**
 * 电脑操作（Computer Use）parity 自检：**不操作这台电脑**，只对纯函数、生成的
 * PowerShell 脚本文本、危险分级/审计、settle 逻辑做断言，另用桩 ctx 挂一次插件
 * 核对工具名与 schema 形状。
 *
 * 为什么单独一张网：电脑操作是「看 → 定位 → 动手 → 再确认」的闭环，任何一环写错
 * 都可能是灾难性的（点错位置、元素没了却按旧坐标点、粘贴没还原用户剪贴板）。
 * 全部断言都钉在**可离线验证的契约**上：脚本长什么样、目标怎么解析、审计行什么形状。
 *
 * 断言五组：
 *   ① 工具名与 schema 形状（枚举项 / 必填 / {type:'element'|'coordinate'} 判别）；
 *   ② 目标解析纯函数（element 越界/不存在/state_id 不匹配 → fail-closed；coordinate 越界 → 报错）；
 *   ③ 脚本生成（UIA 枚举 / 点击 / 拖拽分步（finally 保证抬起）/ 滚轮 / 粘贴还原剪贴板）；
 *   ④ 危险分级与审计（审计行格式、路径来自 home、只读观察不进审批）；
 *   ⑤ settle/超时（注入假时钟与假观察函数）。
 *
 * 全部跑在临时 HOME 上，真实 ~/.dsc 一个字节都不动。
 *
 * 用法：pnpm run build && node scripts/computer-use-test.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'dsc-computer-use-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(join(home, '.dsc'), { recursive: true })

const {
  DESKTOP_ACTIONS,
  READ_ACTIONS,
  canonicalAction,
  resolveTarget,
  parseFrame,
  diffFrames,
  resetFrames,
  settleObserve,
  gradeDesktopAction,
  computerAuditPath,
  auditLine,
  appendComputerAudit,
  screenshotScript,
  observeScript,
  elementActionScript,
  dragScript,
  clickScript,
  scrollScript,
  pasteScript,
  typeScript,
  keyScript,
  listWindowsScript,
  listAppsScript,
  screensScript,
  killAllPowerShell,
} = await import('../lib/core/desktop-control.js')
const { computerUsePlugin, LOOK_ACTIONS, computerToolParameters, computerLookParameters, argProps } = await import(
  '../lib/plugins/computer-use.js'
)

let failures = 0
function check(label, condition, extra = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${label}${extra === '' ? '' : ` → ${extra}`}`)
}
function throws(label, fn, pattern) {
  try {
    fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check(label, pattern === undefined || pattern.test(message), message)
    return
  }
  check(label, false, '没有抛错（应当 fail-closed）')
}

// ── ① 工具名与 schema 形状 ─────────────────────────────────────────────────
console.log('① 工具名与 schema 形状')

/** 用桩 ctx 挂一次插件，抓注册进来的工具条目（不碰真内核）。 */
function mount(withLook) {
  const tools = []
  const sections = []
  const ctx = {
    tools: { register: (entry) => (tools.push(entry), () => {}) },
    prompt: { register: () => () => {}, registerProjection: () => () => {} },
    settings: {
      registerSection: (section) => (sections.push(section), () => {}),
      about: () => ({ version: '0', apiVersion: 0, home, skillsDir: '', pluginsDir: '' }),
    },
  }
  computerUsePlugin.apply(ctx, withLook ? { lookWithoutApproval: true } : {})
  return { tools, sections }
}

const plain = mount(false)
const actPlain = plain.tools.find((t) => t.name === 'computer')
check('注册了动手工具 computer', actPlain !== undefined)
check('computer 的风险等级是 exec（每次过审批）', actPlain?.risk === 'exec', String(actPlain?.risk))
const enumPlain = actPlain?.parameters?.properties?.action?.enum ?? []
check('computer 的 action 枚举含新增动作', ['click', 'drag', 'get_app_state', 'list_windows', 'list_apps', 'screens', 'paste', 'set_value', 'select_text', 'perform_action', 'stop'].every((a) => enumPlain.includes(a)), JSON.stringify(enumPlain))
check('免审批关时 computer 含只读观察动作', enumPlain.includes('screenshot') && enumPlain.includes('get_app_state'))
check('computer 参数 required 只有 action', JSON.stringify(actPlain?.parameters?.required) === JSON.stringify(['action']))
const target = actPlain?.parameters?.properties?.target
check("target 判别字段 type 的枚举是 ['coordinate','element']", JSON.stringify(target?.properties?.type?.enum) === JSON.stringify(['coordinate', 'element']), JSON.stringify(target?.properties?.type?.enum))
check("target 必填只有 type（其余二选一）", JSON.stringify(target?.required) === JSON.stringify(['type']))
check('target 的 index 是 integer（element 用）', target?.properties?.index?.type === 'integer')
check('target 的 x/y 是 integer（coordinate 用）', target?.properties?.x?.type === 'integer' && target?.properties?.y?.type === 'integer')
check('drag 的 from/to 也是 target 形状', argProps().from?.properties?.type?.enum?.join(',') === 'coordinate,element')
check('clip 参数声明了 x/y/width/height 四个必填', JSON.stringify(argProps().clip?.required) === JSON.stringify(['x', 'y', 'width', 'height']))

const look = mount(true)
const lookTool = look.tools.find((t) => t.name === 'computer_look')
check('免审批开时另注册 computer_look', lookTool !== undefined)
check('computer_look 的风险等级是 read（免审批）', lookTool?.risk === 'read', String(lookTool?.risk))
const lookEnum = lookTool?.parameters?.properties?.action?.enum ?? []
check('computer_look 覆盖全部只读观察动作', LOOK_ACTIONS.every((a) => lookEnum.includes(a)), JSON.stringify(lookEnum))
const actLook = look.tools.find((t) => t.name === 'computer')
const actLookEnum = actLook?.parameters?.properties?.action?.enum ?? []
check('免审批开时动手工具不再留只读观察动作', !actLookEnum.includes('screenshot') && !actLookEnum.includes('get_app_state'), JSON.stringify(actLookEnum))
check('免审批开时 get_app_state 归 computer_look（只读观察免审批）', lookEnum.includes('get_app_state') && !actLookEnum.includes('get_app_state'))
check('两个参数表都带上 target 判别（computer/look 一致）', computerToolParameters(['click'], true).properties.target.properties.type.enum.includes('element') && computerLookParameters(['screenshot']).properties.target.properties.type.enum.includes('element'))

// ── ② 目标解析纯函数 ───────────────────────────────────────────────────────
console.log('\n② 目标解析纯函数（fail-closed）')

resetFrames()
const bounds = { left: 0, top: 0, width: 1920, height: 1080 }
const frame = parseFrame(
  JSON.stringify({
    ok: true,
    app: 'notepad',
    window: { id: 42, title: '无标题 - 记事本', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    elements: [
      { index: 0, controlType: 'Window', title: '无标题 - 记事本', automaid: '', value: '', bounds: { x: 0, y: 0, width: 800, height: 600 }, patterns: [], enabled: true, offscreen: false },
      { index: 1, controlType: 'Edit', title: '文本编辑器', automaid: '15', value: 'hi', bounds: { x: 10, y: 60, width: 760, height: 480 }, patterns: ['Text', 'Value'], enabled: true, offscreen: false },
      { index: 2, controlType: 'Button', title: '保存', automaid: 'save', value: '', bounds: { x: 100, y: 200, width: 40, height: 20 }, patterns: ['Invoke'], enabled: true, offscreen: false },
    ],
    text: '[0] Window "无标题 - 记事本"',
  }),
)
check('parseFrame 产出 state_id = st-1', frame.state_id === 'st-1', frame.state_id)
check('parseFrame 规范化元素数量', frame.elements.length === 3)
check('parseFrame 读出窗口进程名', frame.app === 'notepad')

const hit = resolveTarget({ type: 'element', index: 2 }, undefined, frame, bounds, 1)
check('element #2 解析到控件中心', hit.x === 120 && hit.y === 210, `(${hit.x},${hit.y})`)
check('element 解析带出控件标签', /元素 #2/.test(hit.label), hit.label)

throws('element 越界（#99）→ ELEMENT_UNAVAILABLE', () => resolveTarget({ type: 'element', index: 99 }, undefined, frame, bounds, 1), /ELEMENT_UNAVAILABLE/)
throws('element 索引为负 → 报错', () => resolveTarget({ type: 'element', index: -1 }, undefined, frame, bounds, 1), /ELEMENT_UNAVAILABLE/)
throws('element 但没有观察结果 → fail-closed', () => resolveTarget({ type: 'element', index: 0 }, undefined, undefined, bounds, 1), /观察结果/)
throws(
  'element 带了过期 state_id → ELEMENT_UNAVAILABLE（索引已失效）',
  () => resolveTarget({ type: 'element', index: 0, state_id: 'st-99' }, undefined, frame, bounds, 1),
  /ELEMENT_UNAVAILABLE/,
)

const coord = resolveTarget({ type: 'coordinate', x: 200, y: 100 }, undefined, frame, bounds, 2)
check('coordinate 按缩放系数换算（200/2=100）', coord.x === 100 && coord.y === 50, `(${coord.x},${coord.y})`)
throws('coordinate 越界（图外）→ 报错', () => resolveTarget({ type: 'coordinate', x: 99999, y: 5 }, undefined, frame, bounds, 1), /在屏幕外/)
throws('coordinate 非整数 → 报错', () => resolveTarget({ type: 'coordinate', x: 1.5, y: 5 }, undefined, frame, bounds, 1), /整数/)
throws('没有 target → 报错', () => resolveTarget(undefined, undefined, frame, bounds, 1), /要带 target/)

const bound = resolveTarget({ type: 'coordinate', x: 30, y: 40 }, undefined, frame, bounds, 1, { x: 500, y: 300, width: 800, height: 600 })
check('绑定窗口后坐标按窗口左上角偏移（500+30, 300+40）', bound.x === 530 && bound.y === 340, `(${bound.x},${bound.y})`)

// 差分：索引对齐
const frame2 = parseFrame(
  JSON.stringify({
    ok: true,
    app: 'notepad',
    window: { id: 42, title: '无标题 - 记事本', bounds: { x: 0, y: 0, width: 800, height: 600 } },
    elements: [
      frame.elements[0],
      { index: 1, controlType: 'Edit', title: '文本编辑器', automaid: '15', value: 'hello world', bounds: { x: 10, y: 60, width: 760, height: 480 }, patterns: ['Text', 'Value'], enabled: true, offscreen: false },
      frame.elements[2],
      { index: 3, controlType: 'Button', title: '取消', automaid: 'cancel', value: '', bounds: { x: 150, y: 200, width: 40, height: 20 }, patterns: ['Invoke'], enabled: true, offscreen: false },
    ],
    text: '...',
  }),
)
const diff = diffFrames(frame, frame2)
check('差分识别出变化的索引 [1]', JSON.stringify(diff.changed) === JSON.stringify([1]), JSON.stringify(diff))
check('差分识别出新增的索引 [3]', JSON.stringify(diff.added) === JSON.stringify([3]), JSON.stringify(diff))

// ── ③ 脚本生成 ─────────────────────────────────────────────────────────────
console.log('\n③ 脚本生成（PowerShell 文本断言）')

const obs = observeScript({ windowId: 12345, maxElements: 50 })
check('UIA 枚举脚本加载 UIAutomationClient', obs.includes('UIAutomationClient'))
check('UIA 枚举脚本用 TryGetCurrentPattern 探测模式', obs.includes('TryGetCurrentPattern'))
check('UIA 枚举脚本递归遍历控件树（Walk）', obs.includes('function Walk'))
check('UIA 枚举脚本注入窗口句柄', /Resolve-Win 12345/.test(obs))
check('UIA 枚举脚本输出 JSON（ConvertTo-Json）', obs.includes('ConvertTo-Json'))
check('UIA 枚举脚本有失败分支（ok=false，不静默）', obs.includes('ok=$false'))
check('UIA 枚举脚本带元素上限并写明截断', obs.includes("'…（控件数超过 '") && obs.includes('$max = 50'))

const setv = elementActionScript('set_value', { windowId: 7, index: 2, value: "he'llo" })
check('set_value 脚本用 ValuePattern.SetValue 并转义单引号', setv.includes('SetValue(') && setv.includes("he''llo"))
check('set_value 落不到时返回 none（供回退）', setv.includes("'value'") && setv.includes("'none'"))
const perf = elementActionScript('perform_action', { windowId: 7, index: 1, pattern: 'toggle' })
check('perform_action=toggle 用 TogglePattern', perf.includes('TogglePattern') && perf.includes("'toggle'"))
const sel = elementActionScript('select_text', { windowId: 7, index: 1 })
check('select_text 优先 TextPattern，回退 SelectionItemPattern', sel.includes('TextPattern') && sel.includes('SelectionItemPattern') && sel.includes('selecttext'))
check('元素动作找不到索引时报错（fail-closed）', perf.includes('已经不在了'))

const drag = dragScript({ x: 10, y: 10 }, { x: 100, y: 50 }, 20, 5)
check('拖拽按下左键（mouse_event(2,…)）', /mouse_event\(2,0,0,0/.test(drag))
check('拖拽分步插值（for 到 20 步）', /for \(\$i = 1; \$i -le 20/.test(drag))
check('拖拽按下与抬起之间在 try 里', /try \{[\s\S]*for \(\$i = 1/.test(drag))
check('拖拽抬键在 finally 里（失败也保证抬起）', /finally \{[\s\S]*mouse_event\(4,0,0,0/.test(drag))

const click = clickScript({ x: 5, y: 6 }, 'left', false, '', 0)
check('点击脚本 SetCursorPos 到目标点', click.includes('SetCursorPos(5, 6)'))
check('点击脚本按下再抬起', /mouse_event\(2,0,0,0[\s\S]*mouse_event\(4,0,0,0/.test(click))
check('双击 = 两次按下抬起', (clickScript({ x: 1, y: 1 }, 'left', true, '', 0).match(/mouse_event\(2,0,0,0/g) ?? []).length === 2)

const scrollUp = scrollScript(3, '', 0)
const scrollDown = scrollScript(-3, '', 0)
check('滚轮向上用正 delta（4294967176）', scrollUp.includes('4294967176'))
check('滚轮向下用负 delta（120）', scrollDown.includes(' 120,'))
check('滚轮循环次数 = |amount|', scrollUp.includes('$i -lt 3'))

const pasteWithText = pasteScript('机密内容')
check('粘贴脚本先读旧剪贴板', pasteWithText.includes('Get-Clipboard -TextFormatType Text'))
check('粘贴脚本写入给定文本', pasteWithText.includes("Set-Clipboard -Value '机密内容'"))
check('粘贴脚本 Ctrl+V', pasteWithText.includes("SendWait('^v')"))
check('粘贴脚本事后还原用户原剪贴板', /if \(\$null -ne \$old\) \{ Set-Clipboard -Value \$old \}/.test(pasteWithText))
const pasteRaw = pasteScript(undefined)
check('不带 text 的粘贴不动剪贴板（不写也不还原）', !pasteRaw.includes('Set-Clipboard -Value'))
check('type 脚本同样还原剪贴板', /Set-Clipboard -Value \$old/.test(typeScript('x')))
check('key 脚本支持 repeat', /for \(\$i = 0; \$i -lt 3/.test(keyScript('{TAB}', 3, 0)))

check('list_windows 脚本输出 window_id/focused/onscreen', listWindowsScript().includes('window_id') && listWindowsScript().includes('focused') && listWindowsScript().includes('onscreen'))
check('list_apps 脚本输出 foreground 标记', listAppsScript().includes('foreground'))
check('screens 脚本枚举 AllScreens（含负坐标能力）', screensScript().includes('AllScreens'))
const shot = screenshotScript(1568, 'jpeg', 80, { x: 10, y: 20, width: 400, height: 300 })
check('裁切截图脚本 CopyFromScreen 用裁切矩形', shot.includes('CopyFromScreen($srcRect.Left, $srcRect.Top'))
check('裁切截图脚本输出裁切原点', shot.includes('$ox = 10; $oy = 20'))
check('全屏截图脚本无裁切时原点为 0', screenshotScript(1568, 'jpeg', 80).includes('$ox = 0; $oy = 0'))

// ── ④ 危险分级与审计 ───────────────────────────────────────────────────────
console.log('\n④ 危险分级与审计')

check('只读观察全部归 read 档', LOOK_ACTIONS.every((a) => gradeDesktopAction(a) === 'read'))
check('screenshot 归 read', gradeDesktopAction('screenshot') === 'read')
check('click 归 input', gradeDesktopAction('click') === 'input')
check('type 归 input', gradeDesktopAction('type') === 'input')
check('stop 归 system（最严）', gradeDesktopAction('stop') === 'system')
check('目标是任务管理器 → system', gradeDesktopAction('click', { window: '任务管理器' }) === 'system')
check('文本命中 regedit → system', gradeDesktopAction('type', { text: 'regedit' }) === 'system')
check('旧名 window_list 归一成 list_windows', canonicalAction('window_list') === 'list_windows' && canonicalAction('nope') === null)

const auditHome = join(home, '.dsc')
check('审计路径来自 home（~/.dsc/audit/computer-use.jsonl）', computerAuditPath(auditHome) === join(auditHome, 'audit', 'computer-use.jsonl'), computerAuditPath(auditHome))
const record = { ts: 1700000000000, action: 'click', risk: 'input', target: 'element#2', result: 'ok', approved: true }
const line = auditLine(record)
check('审计行以换行结尾（一行一条）', line.endsWith('\n') && line.split('\n').length === 2)
const parsed = JSON.parse(line.trim())
check('审计行字段齐全（ts/action/risk/target/result/approved）', parsed.ts === record.ts && parsed.action === 'click' && parsed.risk === 'input' && parsed.target === 'element#2' && parsed.result === 'ok' && parsed.approved === true, JSON.stringify(parsed))
appendComputerAudit(auditHome, record)
appendComputerAudit(auditHome, { ...record, action: 'screenshot', risk: 'read', approved: false, target: '整个桌面' })
const written = readFileSync(join(auditHome, 'audit', 'computer-use.jsonl'), 'utf8').trim().split('\n')
check('审计落盘两行且可逐行解析', written.length === 2 && written.every((l) => JSON.parse(l).ts === record.ts))
check('只读观察那行 approved=false（没进审批）', JSON.parse(written[1]).approved === false && JSON.parse(written[1]).risk === 'read')

check('killAllPowerShell 是函数（急停入口）', typeof killAllPowerShell === 'function')

// ── ⑤ settle / 超时（注入假时钟） ──────────────────────────────────────────
console.log('\n⑤ 观察 settle / 超时（注入假时钟）')

/** 造一个受控时钟 + 快照序列。 */
function fakeWorld(sequence) {
  let clock = 0
  let calls = 0
  return {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    snapshot: async () => {
      const value = sequence[Math.min(calls, sequence.length - 1)]
      calls += 1
      return value
    },
    calls: () => calls,
  }
}

{
  const world = fakeWorld(['a', 'a'])
  const result = await settleObserve(world.snapshot, (v) => v, { intervalMs: 10, timeoutMs: 500, sleep: world.sleep, now: world.now })
  check('连续两帧相同 → stable=true', result.stable === true, JSON.stringify(result))
  check('稳定时只观察 2 次（不轮询）', result.attempts === 2, String(result.attempts))
  check('stable 的 waitedMs 受假时钟控制', result.waitedMs === 10, String(result.waitedMs))
}
{
  const world = fakeWorld(['a', 'b', 'b'])
  const result = await settleObserve(world.snapshot, (v) => v, { intervalMs: 10, timeoutMs: 500, sleep: world.sleep, now: world.now })
  check('变化后再稳定 → stable=true（3 次）', result.stable === true && result.attempts === 3, JSON.stringify(result))
}
{
  let n = 0
  const world = {
    now: () => n * 10,
    sleep: async () => {
      n += 1
    },
    snapshot: async () => `帧-${n}`,
  }
  const result = await settleObserve(world.snapshot, (v) => v, { intervalMs: 10, timeoutMs: 30, sleep: world.sleep, now: world.now })
  check('一直变化 → 到超时上限后 stable=false（不无限等）', result.stable === false, JSON.stringify(result))
  check('超时结论带上限内观察次数', result.attempts > 1, String(result.attempts))
}

console.log('')
if (failures === 0) {
  console.log('电脑操作 parity 自检：全部通过')
  rmSync(home, { recursive: true, force: true })
} else {
  console.log(`电脑操作 parity 自检：${failures} 条失败（临时 HOME 留在 ${home} 供排查）`)
}
process.exit(failures === 0 ? 0 : 1)
