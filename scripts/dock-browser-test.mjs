/**
 * 「agent 驱动侧栏浏览器」这条链路的探针。
 *
 * 这条链路横跨三个包、两棵编译树（`src/**` → `lib/`、`desktop/electron/**` → `out/`、
 * `ui-shell/src/**` → 壳 bundle），任何一侧把同一件事各写一份，线上跑的是消息、错在
 * 编译期看不出来——所以这份探针按**四类手法**分别钉住，而不是只跑一遍链接：
 *
 *   1. **契约单一真源**（第 1、2 节）：协议版本、CDP 命令/事件白名单、`dockNavigateTarget`
 *      与「导航只认 Page.navigate」都在 `src/core/dock-browser.ts`。两侧从契约取（文本断言
 *      不许本地写死数字），命令白名单的必需项在场、危险项缺席。
 *   2. **桌面执行端的五道闸门**（第 3 节）：扫 `sendDockCommand` 的函数体，断言五道闸门
 *      **齐**（缺一道就是越权）且**有序**（顺序反了等于把复检放到白名单前面）。
 *   3. **真跑纯模块 / 真挂插件**（第 4、5、6 节）：`createDockSession` 路由与过滤、没有桌面壳
 *      时的「立刻抛人话」语义、工具面的注册与风险档（`lookWithoutApproval` 关着时
 *      `browser_dock_look` **不许注册**）。
 *   4. **壳侧不许手抄漂移**（第 7、8 节）：事件名字面量逐字等于契约常量、页签 id 只能从
 *      实参尾部加、`openBrowserTab` 同 id 只聚焦不新建（用类型擦除直读真源码跑）。
 *
 * 每一节的失败说明都写清「这条断言绿了代表什么、红了会出什么事」，不做空转断言。
 *
 * ## 负向验证的入口
 *
 * 设 `DSC_DOCK_PROBE_OVERLAY=<目录>` 时，`read()` / `modUrl()` 先从该目录下取同名相对路径
 * 的文件，取不到才回落真实工作树。**只影响这份探针的读取，不改工作树任何文件**——用来做
 * 「把源码改坏 → 探针必须红 → 还原」的变异核实（见第 3、7 节里引用它的那条断言）。
 *
 * 运行：pnpm run build && node scripts/dock-browser-test.mjs
 * 探针只读 `lib/`、`src/`、`ui-shell/src`、`desktop/electron/main`，并把 HOME 换到临时目录，
 * 真实 `~/.dsc` 一个字节都不动（成功时临时 HOME 自删）。
 *
 * @module dsc/scripts/dock-browser-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// HOME / DSC_HOME 隔离：dock-browser 插件的 readConfig 会读 ~/.dsc/plugins.json，
// 不隔离就会读到使用者真实的那份，`lookWithoutApproval` 的断言随环境飘。
const home = mkdtempSync(join(tmpdir(), 'dsc-dock-browser-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSC_HOME = join(home, '.dsc')
mkdirSync(join(home, '.dsc'), { recursive: true })

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * 变异核实用的源码覆盖层：`DSC_DOCK_PROBE_OVERLAY` 指到一份临时副本上，探针就从那儿读。
 * 空值时它不存在感——默认路径就是工作树本身。
 */
const OVERLAY = process.env.DSC_DOCK_PROBE_OVERLAY ?? ''
const resolvePath = (rel) => {
  const local = join(root, rel)
  if (OVERLAY === '') return local
  const alternate = join(OVERLAY, rel)
  return existsSync(alternate) ? alternate : local
}
/** 读一个源码文件的文本（受覆盖层影响）。 */
const read = (rel) => readFileSync(resolvePath(rel), 'utf8')
/** 把源码文件转成可 import 的 URL（受覆盖层影响；供类型擦除直跑 .ts 用）。 */
const modUrl = (rel) => pathToFileURL(resolvePath(rel)).href
/** 归一化换行 + 去注释：扫源码找标识符时必须先剔掉注释（注释里正写着「别这样写」）。 */
const uncomment = (text) =>
  text.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let passed = 0
let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === '' ? '' : `  <- ${detail}`}`)
}
/** 断言一段代码里某个标识符在场且该段本身不是空的（扫源码用；空字符串会让匹配永远为假）。 */
const has = (text, needle) => text !== '' && text.includes(needle)

// ── 契约（编译产物：线上跑的就是这一份）─────────────────────────────────────
// 这几条动态 import 也走 `resolvePath`（覆盖层），所以负向验证既能改源码文本，
// 也能改编译产物（例如把契约里的版本号改成别的），两类断言都验得了非空转。
const contract = await import(modUrl('lib/core/dock-browser.js'))
const {
  HOST_PROTOCOL_VERSION,
  DOCK_CDP_COMMANDS,
  DOCK_CDP_EVENTS,
  DOCK_ACTIONS,
  DOCK_LOOK_ACTIONS,
  DOCK_TAB_OPEN_EVENT,
  DOCK_TAB_CLOSE_EVENT,
  DOCK_CALL_TIMEOUT_MS,
  DOCK_OPEN_TIMEOUT_MS,
  isAllowedDockCommand,
  shouldForwardDockEvent,
  dockNavigateTarget,
  isAgentView,
} = contract
const { createDockSession } = await import(modUrl('lib/core/dock-session.js'))
const { HOST_BROWSER_SERVICE, DockBrowserUnavailableError } = await import(modUrl('lib/core/host-browser-link.js'))
const { hostStdioPlugin } = await import(modUrl('lib/plugins/host-stdio.js'))
const { dockBrowserPlugin } = await import(modUrl('lib/plugins/dock-browser.js'))
const { NATIVE_EVENTS, NATIVE_EVENT_SET, NATIVE_BRIDGE_VERSION } = await import(modUrl('lib/core/native-bridge.js'))

console.log('[1] 契约单一真源：协议版本只有一处定义')
{
  check(
    '契约里的协议版本是 3',
    HOST_PROTOCOL_VERSION === 3,
    `src/core/dock-browser.ts 定的版本是 ${String(HOST_PROTOCOL_VERSION)} 而不是 3：两侧握手按它比对 hello，值一变（或两边各取各的）桌面壳会直接丢消息，agent 这条链路整条不通`,
  )
  check(
    '契约是零依赖纯模块（没有 import）',
    !/^\s*import\s/m.test(read('src/core/dock-browser.ts')),
    'src/core/dock-browser.ts 出现了 import：它被宿主侧 `node lib/headless.js` 与桌面主进程两棵编译树同时引用，一旦拉进 electron 或带副作用的东西，探针也直读不了它',
  )

  const stdioSrc = uncomment(read('src/plugins/host-stdio.ts'))
  check(
    'host-stdio 从契约取版本（自己不许写死 = 2 / = 3）',
    !/HOST_PROTOCOL_VERSION\s*=\s*\d/.test(stdioSrc) && has(stdioSrc, "} from '../core/dock-browser.js'") && stdioSrc.includes('HOST_PROTOCOL_VERSION'),
    'src/plugins/host-stdio.ts 里出现了 `HOST_PROTOCOL_VERSION = <数字>` 这样的本地定义：契约升到 4 时这一侧不会跟着动，握手版本两边不同步',
  )
  check(
    'host-stdio 保留同名再导出（旧 import 入口不断）',
    stdioSrc.includes('export { HOST_PROTOCOL_VERSION }'),
    'src/plugins/host-stdio.ts 不再导出 HOST_PROTOCOL_VERSION：别处（握手、测试）的旧 import 会当场编不过',
  )
  check(
    'host-stdio 发出握手时用的是契约那个常量',
    stdioSrc.includes("type: 'hello', protocolVersion: HOST_PROTOCOL_VERSION"),
    'hello 的 protocolVersion 不是从契约取的：写死一个数字等于把「哪一版」这件事又抄了一份',
  )

  const protoSrc = uncomment(read('desktop/electron/main/protocol.ts'))
  check(
    '桌面 protocol.ts 从契约取版本（自己不许写死 = 2 / = 3）',
    !/HOST_PROTOCOL_VERSION\s*=\s*\d/.test(protoSrc) &&
      has(protoSrc, "} from '@dsc/runtime/core/dock-browser.js'") &&
      protoSrc.includes('HOST_PROTOCOL_VERSION'),
    'desktop/electron/main/protocol.ts 里出现了 `HOST_PROTOCOL_VERSION = <数字>` 这样的本地定义：桌面侧与宿主侧会各自认一版，握手失败时还看不出是谁抄的',
  )
  check(
    '桌面 protocol.ts 用契约常量比对 hello（不是字面量 3）',
    protoSrc.includes('message.protocolVersion !== HOST_PROTOCOL_VERSION'),
    '桌面侧比对协议版本用的不是契约常量：契约升版后这里会静默把新宿主的 hello 全丢掉',
  )
  check(
    '桌面 dock.ts 也从契约取白名单/导航判定（不在桌面侧另写一份）',
    has(read('desktop/electron/main/dock.ts'), "} from '@dsc/runtime/core/dock-browser.js'") &&
      read('desktop/electron/main/dock.ts').includes('isAllowedDockCommand') &&
      !/DOCK_CDP_COMMANDS\s*=\s*\[/.test(read('desktop/electron/main/dock.ts')),
    'desktop/electron/main/dock.ts 自己写了一份命令白名单：两侧白名单一旦不同，宿主以为能发的命令桌面会拒（或反过来放行危险命令）',
  )
}

console.log('\n[2] 命令白名单：必需项在场、危险项缺席、导航只认一条命令')
{
  const REQUIRED = [
    'Page.enable',
    'Page.navigate',
    'Page.captureScreenshot',
    'DOM.getBoxModel',
    'Accessibility.getFullAXTree',
    'Runtime.evaluate',
    'Input.dispatchMouseEvent',
  ]
  const missing = REQUIRED.filter((method) => !isAllowedDockCommand(method))
  check(
    '动作/快照那套真正用到的命令都在白名单里',
    missing.length === 0,
    `契约白名单缺了 ${missing.join('、')}：缺哪条，snapshot / click / screenshot 就在那一步被桌面侧当场拒（报「不允许的调试命令」）`,
  )

  const FORBIDDEN = ['Runtime.compileScript', 'Target.createTarget', 'Browser.close', 'Storage.getCookies', 'DOM.setFileInputFiles']
  const present = FORBIDDEN.filter((method) => isAllowedDockCommand(method))
  check(
    '危险命令一条都不在白名单里',
    present.length === 0,
    `白名单放进了 ${present.join('、')}：dock 视图带着用户自己的登录态，这些能越出这一页 / 读凭据 / 上传文件，等于把信任模型那条「只放用得到的域」拆了`,
  )
  const domains = ['Target.', 'Browser.', 'Storage.']
  const bleed = DOCK_CDP_COMMANDS.filter((method) => domains.some((prefix) => method.startsWith(prefix)) || /Cookie/i.test(method))
  check(
    '没有整个域被放开（Target./Browser./Storage./Cookie）',
    bleed.length === 0,
    `白名单里混进了 ${bleed.join('、')}：整域放开等于白名单只写了前缀，这一页之外的 target 与用户凭据都够得着`,
  )
  check(
    '白名单判定真的查表（表内真、表外假）',
    isAllowedDockCommand('Page.navigate') === true && isAllowedDockCommand('Runtime.compileScript') === false,
    'isAllowedDockCommand 对表内/表外的判定不对：桌面侧每一条命令都过它，判定错了就是闸门本身坏了',
  )

  check(
    'dockNavigateTarget 只对 Page.navigate 认地址',
    dockNavigateTarget('Page.navigate', { url: 'https://example.com/' }) === 'https://example.com/' &&
      dockNavigateTarget('Page.reload', { url: 'https://example.com/' }) === null,
    'dockNavigateTarget 对非 Page.navigate 的命令也返回了地址（或对 Page.navigate 返回 null）：它是导航复检的入口，认错命令要么漏检、要么把无关命令误判成导航',
  )
  check(
    'dockNavigateTarget 对缺 url / 非字符串 url 一律 null（fail-closed）',
    dockNavigateTarget('Page.navigate', undefined) === null &&
      dockNavigateTarget('Page.navigate', {}) === null &&
      dockNavigateTarget('Page.navigate', { url: 123 }) === null,
    '拿不到字符串地址时没回 null：桌面侧会因为「不是 null 且不是 http」而报错（运气好），或者干脆当成合法导航放过去（运气差）',
  )

  const overlap = DOCK_CDP_COMMANDS.filter((method) => DOCK_CDP_EVENTS.includes(method))
  check(
    '命令白名单与事件白名单不相交',
    overlap.length === 0,
    `两个白名单有交集 ${overlap.join('、')}：命令是往视图里送的、事件是从视图里推的，混在一起说明其中一张表的收口逻辑写错了`,
  )
  const eventBad = DOCK_CDP_EVENTS.filter((method) => !shouldForwardDockEvent(method))
  check(
    '事件白名单自洽（表内事件都判真）',
    eventBad.length === 0 && shouldForwardDockEvent('Page.enable') === false,
    `事件白名单判定与表不一致（${eventBad.join('、')}）：桌面侧只推白名单内的事件，判定错了就是控制台/网络缓冲永远空着`,
  )
  check(
    '动作枚举与只读枚举不重不漏（两档动作各归各的）',
    DOCK_ACTIONS.every((action) => !DOCK_LOOK_ACTIONS.includes(action)) && DOCK_ACTIONS.includes('navigate') && DOCK_LOOK_ACTIONS.includes('screenshot'),
    'DOCK_ACTIONS 与 DOCK_LOOK_ACTIONS 出现重叠或漏项：工具面按这两张表注册与开档，重了就会有动作同时出现在「动手」和「免审批」两个工具里',
  )
  check(
    '超时预算：通用 25s、开页签 8s（开页签比通用短）',
    DOCK_CALL_TIMEOUT_MS === 25_000 && DOCK_OPEN_TIMEOUT_MS === 8_000 && DOCK_OPEN_TIMEOUT_MS < DOCK_CALL_TIMEOUT_MS,
    `超时预算变了（call=${String(DOCK_CALL_TIMEOUT_MS)}ms, open=${String(DOCK_OPEN_TIMEOUT_MS)}ms）：开页签要等壳建页签+挂视图，给它通用预算会让「壳不认这条通路」这类失败拖满 25 秒才报`,
  )
  check(
    'agent 自开页签的 id 前缀判定在契约里（不在各处手抄 agent-）',
    isAgentView('agent-1') === true && isAgentView('main') === false && isAgentView('t123') === false,
    'isAgentView 判定不对：审批卡与工具输出靠它标「这张是 agent 自己开的」，判错会让用户分不清哪张页签是模型开的',
  )
}

console.log('\n[3] 桌面执行端：五道闸门在场且有序')
{
  const dockSrc = read('desktop/electron/main/dock.ts')
  const code = uncomment(dockSrc)

  /** 取一个具名函数的函数体（花括号配对；找不到返回 null）。 */
  function functionBody(source, signature) {
    const start = source.indexOf(signature)
    if (start < 0) return null
    const open = source.indexOf('{', start)
    if (open < 0) return null
    let depth = 0
    for (let index = open; index < source.length; index += 1) {
      const character = source[index]
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) return source.slice(open, index + 1)
      }
    }
    return null
  }

  /** 五道闸门各自的标志片段（顺序即要求的顺序）。 */
  const GATES = [
    ['① 台账 guests.get(viewId)', 'guests.get(viewId)'],
    ['② 白名单 isAllowedDockCommand(method)', 'isAllowedDockCommand(method)'],
    ['③ 导航复检 dockNavigateTarget(method, params)', 'dockNavigateTarget(method, params)'],
    ['③b http(s) 判定 isHttpUrl(navTarget)', 'isHttpUrl(navTarget)'],
    ['④ 截图可见性 Page.captureScreenshot && !guest.attached', "method === 'Page.captureScreenshot' && !guest.attached"],
    ['⑤a 惰性挂调试器 attachDebugger(viewId, guest)', 'attachDebugger(viewId, guest)'],
    ['⑤b 带超时发命令 sendWithTimeout(guest, method, params, timeoutMs)', 'sendWithTimeout(guest, method, params, timeoutMs)'],
  ]
  /** 扫一段函数体：返回各闸门的位置与缺失清单。 */
  const scanGates = (body) => {
    const text = body ?? ''
    const indexes = GATES.map(([, marker]) => text.indexOf(marker))
    return { text, indexes, missing: GATES.filter(([, marker], index) => indexes[index] < 0).map(([label]) => label) }
  }
  const inOrder = (indexes) => indexes.every((value, index) => value >= 0 && (index === 0 || value > indexes[index - 1]))

  const body = functionBody(code, 'export async function sendDockCommand(')
  check(
    'sendDockCommand 函数体取到了（扫描不是空转）',
    body !== null && body.length > 200,
    '在 desktop/electron/main/dock.ts 里找不到 `export async function sendDockCommand(` 的函数体：函数被改名/搬走，这份探针要跟着改，别当成绿的',
  )
  const gates = scanGates(body)
  check(
    '五道闸门一道不缺',
    gates.missing.length === 0,
    `sendDockCommand 里缺了闸门 ${gates.missing.join('、')}：任一道缺席都是越权——台账缺了能指名主窗口、白名单缺了能发任意 CDP、导航复检缺了能把带登录态的视图导去 file://、可见性缺了截图会挂到超时、超时缺了整次工具调用被拖死`,
  )
  check(
    '五道闸门的顺序是台账 → 白名单 → 导航复检 → 可见性 → 挂调试器+超时',
    inOrder(gates.indexes),
    `闸门顺序不对（实际位置 ${JSON.stringify(gates.indexes)}）：复检排到白名单之前会先跑判定再拒、或先挂调试器再判可见性，越权路径与挂死路径就都回来了`,
  )
  check(
    '每道闸门都 fail-closed（当场 return { ok: false }）',
    (gates.text.match(/ok: false/g) ?? []).length >= 5 &&
      gates.indexes.slice(0, 5).every((index) => gates.text.slice(index, index + 160).includes('ok: false')),
    '有闸门不是「当场回错」而是继续往下走：fail-closed 是这条链路的硬约束，继续走等于那道闸门没写',
  )
  check(
    '台账只有一处入账口（guests.set 只在 guestFor 里，界面自己的 webContents 进不来）',
    (code.match(/guests\.set\(/g) ?? []).length === 1 && has(code, 'function guestFor(') && has(code, 'export function hasDockView('),
    `guests.set 在 desktop/electron/main/dock.ts 里出现了 ${String((code.match(/guests\.set\(/g) ?? []).length)} 次：台账是「谁可以被指名」的唯一事实来源，多一个入账口就多一条把别的 webContents 写进台账的路径`,
  )

  const timeoutBody = functionBody(code, 'async function sendWithTimeout(')
  check(
    'sendWithTimeout 自己超时并回带方法名的人话（不把 promise 挂着）',
    has(timeoutBody ?? '', 'ok: false') && has(timeoutBody ?? '', '调试命令超时：${method}') && has(timeoutBody ?? '', 'Promise.race'),
    'sendWithTimeout 没有「到期就回错、带方法名」这条：桌面侧卡住时宿主会一直等到通用超时，用户看到的是「点了一下没反应」而不是具体哪条命令卡了',
  )
  check(
    'Page.navigate 的地址复检用的是契约函数 + isHttpUrl 两道都在',
    has(gates.text, 'const navTarget = dockNavigateTarget(method, params)') && has(gates.text, '!isHttpUrl(navTarget)'),
    'Page.navigate 只过了一道判定：它是绕开 navigateDockBrowser 那道闸门的直通车，少一道就能把用户的登录态视图导到 file://',
  )

  // 负向：扫描器本身不许空转——把白名单标记改坏，缺失清单必须认出来。
  const brokenBody = (body ?? '').replace('isAllowedDockCommand(method)', 'isAllowedDockCommandXX(method)')
  check(
    '负向：白名单标记被改坏后，缺失扫描认得出（证明这条闸不是空转）',
    scanGates(brokenBody).missing.length === 1,
    '把 `isAllowedDockCommand(method)` 改成别的写法后，缺失清单本应报 1 条却报了别的：说明「五道闸门一道不缺」这条是空转的',
  )
}

console.log('\n[4] createDockSession：按视图路由、按视图+方法双重过滤')
{
  const calls = []
  const handlers = new Set()
  const source = {
    call: (viewId, method, params) => {
      calls.push({ viewId, method, params })
      return Promise.resolve({ ok: true })
    },
    onEvent: (handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
  /** 推一条事件给所有订阅者（模拟桌面侧 push 到宿主的那些条）。 */
  const emit = (event) => {
    for (const handler of [...handlers]) handler(event)
  }

  const session = createDockSession(source, 'agent-5')
  check(
    'sessionId 就是视图 id（桌面侧按它找 webContents）',
    session.sessionId === 'agent-5',
    `sessionId 是 ${String(session.sessionId)} 而不是视图 id：桌面侧的 debugger 挂在具体一台上，sessionId 对不上就找不到目标`,
  )

  const withParams = await session.send('Page.navigate', { url: 'https://example.com/' })
  const withoutParams = await session.send('Page.reload')
  check(
    'send 原样透传 viewId / method / params',
    calls.length === 2 &&
      calls[0].viewId === 'agent-5' &&
      calls[0].method === 'Page.navigate' &&
      JSON.stringify(calls[0].params) === JSON.stringify({ url: 'https://example.com/' }) &&
      calls[1].method === 'Page.reload' &&
      calls[1].params === undefined,
    `透传的实参不对：${JSON.stringify(calls)}——动作层不带 params 的命令（如 Page.reload）必须原样传 undefined，不能补一个 {}`,
  )
  check(
    'send 把 source 的返回值原样交回',
    withParams.ok === true && withoutParams.ok === true,
    'send 没有把 source 的返回值透传回来：动作层拿到的就是 undefined，所有 CDP 结果都会读空',
  )

  const seen = []
  const off = session.on('Runtime.consoleAPICalled', (params) => seen.push(params))
  emit({ viewId: 'agent-6', method: 'Runtime.consoleAPICalled', params: { text: '别的视图' } })
  emit({ viewId: 'agent-5', method: 'Page.frameNavigated', params: { frame: {} } })
  check(
    '别的 viewId / 别的 method 的事件都不投递',
    seen.length === 0,
    `串台了：${JSON.stringify(seen)}——不过滤的话两台视图上同名的 consoleAPICalled 会互相污染，控制台缓冲里混进别人页面的输出`,
  )
  emit({ viewId: 'agent-5', method: 'Runtime.consoleAPICalled', params: { text: '自己这台' } })
  check('本视图 + 本方法的事件投递一次且只一次', seen.length === 1 && seen[0].text === '自己这台', `投递结果 ${JSON.stringify(seen)}`)
  off()
  emit({ viewId: 'agent-5', method: 'Runtime.consoleAPICalled', params: { text: '退订之后' } })
  check(
    '退订之后不再投递（退订函数真的从 source 摘掉）',
    seen.length === 1,
    '退订后仍收到事件：视图关掉再打开会叠订阅，同一台视图的事件会被重复处理 N 次',
  )
  check('on 的返回值是退订函数（不是空实现）', typeof off === 'function' && handlers.size === 0, `退订后 source 上还挂着 ${String(handlers.size)} 个订阅者`)
}

console.log('\n[5] 没有桌面壳时的语义：立刻抛人话，不等超时')
{
  // stdio 形态直挂 host-stdio：pickTransport 没有 process.parentPort 就走 stdio，
  // 而 available() 的判据就是传输形态——这正是「TUI / 无头 / 远程壳」的真实情景。
  const provided = new Map()
  const listeners = new Map()
  const fakeCtx = {
    ui: {
      subscribe: () => () => {},
      getSnapshot: () => ({}),
      exit: () => {},
    },
    provide: (name, value) => {
      provided.set(name, value)
      return () => {
        if (provided.get(name) === value) provided.delete(name)
      }
    },
    get: (name) => provided.get(name),
    on: (event, handler) => {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
      return () => set.delete(handler)
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }

  // host-stdio 的 stdio 传输就是把 JSON 行写进 process.stdout（这是它的协议面）。
  // 探针输出也走 stdout，所以挂载期间先截住写入，等断言收完再恢复：
  // 既不让协议行污染探针输出，也顺带把「线上真的发了什么」抓下来看。
  const wireLines = []
  const shown = []
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => {
    wireLines.push(String(chunk))
    return true
  }
  const later = (name, condition, detail = '') => shown.push([name, condition, detail])

  try {
    hostStdioPlugin.apply(fakeCtx, { snapshotThrottleMs: 1_000 })

    const link = fakeCtx.get(HOST_BROWSER_SERVICE)
    later(
      'hostBrowser 服务挂上了（工具面取得到，不会读到 undefined）',
      link !== undefined,
      'ctx.get(HOST_BROWSER_SERVICE) 是 undefined：host-stdio 没有 provide 这个服务，工具面会退化成「没有桌面壳」的报错，连「有壳但没用」都分不出来',
    )
    later(
      'stdio 形态下 available() 为假',
      link?.available() === false,
      `available() 回了 ${String(link?.available())}：判据只该认传输形态（parentPort 才可能接桌面主进程），回真会让工具面以为能用，接着每条命令都等到超时`,
    )

    /** 断言某个方法「立刻」抛 DockBrowserUnavailableError（不是等 DOCK_CALL_TIMEOUT_MS）。 */
    const immediate = async (label, run) => {
      const started = Date.now()
      try {
        await run()
      } catch (error) {
        const elapsed = Date.now() - started
        later(
          `${label} 立刻抛 DockBrowserUnavailableError`,
          error instanceof DockBrowserUnavailableError && elapsed < 100 && error.message.includes('没有桌面壳'),
          `实际：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}，用了 ${String(elapsed)}ms（通用超时是 ${String(DOCK_CALL_TIMEOUT_MS)}ms）——等超时会把「宿主里没有桌面壳」报成「桌面壳没响应」，是两回事`,
        )
        later(
          `${label} 的报错是人话（不带栈帧、说清没有壳）`,
          error instanceof Error && !error.message.includes('\n    at ') && error.message.includes('宿主里没有桌面壳'),
          `报错文本不该出现栈帧或含糊措辞：${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
        )
        return
      }
      later(`${label} 立刻抛 DockBrowserUnavailableError`, false, '没有抛错（没有桌面壳时应当当场拒绝）')
    }

    await immediate('views()', () => link.views())
    await immediate('open()', () => link.open('https://example.com/'))
    await immediate('close()', () => link.close('agent-1'))
    await immediate('call()', () => link.call('agent-1', 'Page.enable'))
    await immediate('session().send()', () => link.session('agent-1').send('Page.enable'))

    later(
      '不可用时一条 browser-* 请求都没发出去（不是发了再拒）',
      !wireLines.some((line) => line.includes('"browser-')),
      `抓到的协议行里出现了 browser-* 请求：${wireLines.filter((line) => line.includes('"browser-')).join('|')}——requireHost 必须挡在 transport.send 之前`,
    )

    const hello = wireLines
      .map((line) => {
        try {
          return JSON.parse(line.trim())
        } catch {
          return null
        }
      })
      .find((message) => message !== null && message.type === 'hello')
    later(
      '线上握手带的就是契约版本 3（不是本地另一个数字）',
      hello !== undefined && hello.protocolVersion === HOST_PROTOCOL_VERSION,
      `抓到的 hello：${JSON.stringify(hello)}——宿主发的版本与契约不一致时，桌面壳会按「协议版本对不上」丢掉整条链路`,
    )

    // 收尾：走插件自己的 dsc/exit 钩子，清掉快照计时器并 dispose 传输（否则 stdin 监听与
    // 定时器会挂到进程退出；也可顺带验证这条收尾路径真的把在飞的请求拒掉了）。
    for (const handler of [...(listeners.get('dsc/exit') ?? [])]) handler()
    later('宿主退出后服务摘掉了（offBrowser 真的生效）', fakeCtx.get(HOST_BROWSER_SERVICE) === undefined, 'dsc/exit 之后 hostBrowser 仍挂着：热卸载后残留的服务会被工具面当成「有壳」')
  } finally {
    process.stdout.write = realWrite
  }

  for (const [name, condition, detail] of shown) check(name, condition, detail)
}

console.log('\n[6] 工具面：注册、风险档与「没有桌面壳」时的报错')
{
  /** 桩 ctx 挂一次真插件（与 computer-use-test 同法：抓注册进来的工具条目）。 */
  function mountDock(withLook, link) {
    const tools = []
    const sections = []
    const ctx = {
      tools: {
        register: (entry) => {
          tools.push(entry)
          return () => {}
        },
      },
      settings: {
        registerSection: (section) => {
          sections.push(section)
          return () => {}
        },
      },
      get: (name) => (name === HOST_BROWSER_SERVICE ? link : undefined),
    }
    const off = dockBrowserPlugin.apply(ctx, withLook ? { lookWithoutApproval: true } : {})
    return { tools, sections, off }
  }

  const plain = mountDock(false, undefined)
  const act = plain.tools.find((tool) => tool.name === 'browser_dock')
  check(
    '免审批关着时只注册 browser_dock（动手那个）',
    plain.tools.length === 1 && act !== undefined && plain.tools.find((tool) => tool.name === 'browser_dock_look') === undefined,
    `实际注册了 ${plain.tools.map((tool) => tool.name).join('、')}：dock 视图跑在用户自己的持久分区里（带登录态），只读工具默认注册等于无条件免审批看用户的登录页面`,
  )
  check('browser_dock 的风险等级是 exec（每次过审批）', act?.risk === 'exec', `risk=${String(act?.risk)}：risk 不是 exec 就不会弹审批卡，agent 能直接点击/输入用户登录着的页面`)
  check(
    'browser_dock 的 action 枚举 === 契约 DOCK_ACTIONS',
    JSON.stringify(act?.parameters?.properties?.action?.enum) === JSON.stringify([...DOCK_ACTIONS]),
    `枚举 ${JSON.stringify(act?.parameters?.properties?.action?.enum)} 与契约 ${JSON.stringify([...DOCK_ACTIONS])} 不一致：模型看得到的动作集与插件真的会执行的动作集错开，多出来的会被「未知 action」拒、少了的模型根本不知道能用`,
  )
  const actProps = act?.parameters?.properties ?? {}
  check(
    'browser_dock 参数含可选 viewId（不在 required 里）',
    actProps.viewId?.type === 'string' && JSON.stringify(act?.parameters?.required) === JSON.stringify(['action']),
    `viewId 声明：type=${String(actProps.viewId?.type)}，required=${JSON.stringify(act?.parameters?.required)}——viewId 必须可选：不传时插件自己复用/开户，传了才是指名已有视图`,
  )

  const lookMount = mountDock(true, undefined)
  const look = lookMount.tools.find((tool) => tool.name === 'browser_dock_look')
  check(
    'lookWithoutApproval 打开后才注册 browser_dock_look',
    lookMount.tools.length === 2 && look !== undefined,
    `实际注册了 ${lookMount.tools.map((tool) => tool.name).join('、')}：开关翻不动说明设置项与注册不同步（界面切了、工具面没重挂）`,
  )
  check('browser_dock_look 的风险等级是 read（免审批）', look?.risk === 'read', `risk=${String(look?.risk)}：只读档写错会让「看」每次都弹审批卡，或让「看」绕过审批`)
  check(
    'browser_dock_look 的 action 枚举 === 契约 DOCK_LOOK_ACTIONS',
    JSON.stringify(look?.parameters?.properties?.action?.enum) === JSON.stringify([...DOCK_LOOK_ACTIONS]),
    `枚举 ${JSON.stringify(look?.parameters?.properties?.action?.enum)} 与契约 ${JSON.stringify([...DOCK_LOOK_ACTIONS])} 不一致：只读工具与契约漂移后，快照/截图这类动作会在工具面上消失或多出未实现的项`,
  )
  const section = lookMount.sections.find((item) => item.id === 'dock-browser')
  check(
    '设置分区声明了 lookWithoutApproval 开关（用户能自己关掉免审批）',
    section !== undefined && section.fields().some((field) => field.type === 'switch' && field.key === 'lookWithoutApproval'),
    '设置分区里没有 lookWithoutApproval 开关：用户没有关掉「免审批看自己登录着的浏览器」的入口',
  )

  // ── 没有桌面壳：两个工具都要回人话 ────────────────────────────────────────
  const noShell = mountDock(true, undefined)
  const noShellAct = noShell.tools.find((tool) => tool.name === 'browser_dock')
  const noShellLook = noShell.tools.find((tool) => tool.name === 'browser_dock_look')
  /** 跑一次工具调用并把人话报错抓出来。 */
  const humanError = async (run) => {
    try {
      await run()
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return null
  }
  const actMessage = await humanError(() => noShellAct.run({ action: 'open', url: 'https://example.com/' }, { signal: new AbortController().signal }))
  check(
    '没有桌面壳时 browser_dock 回一句人话（不抛栈）',
    actMessage !== null && actMessage.includes('宿主里没有桌面壳') && !actMessage.includes('\n    at '),
    `实际报错：${JSON.stringify(actMessage === null ? null : actMessage.slice(0, 160))}——抛栈会让模型看到一堆内部帧、也读不出「该去桌面端用」，静默不做事则会让它以为没开页签`,
  )
  const lookMessage = await humanError(() => noShellLook.run({ action: 'views' }, { signal: new AbortController().signal }))
  check(
    '没有桌面壳时 browser_dock_look 回同一句人话（不抛栈）',
    lookMessage !== null && lookMessage.includes('宿主里没有桌面壳') && !lookMessage.includes('\n    at '),
    `实际报错：${JSON.stringify(lookMessage === null ? null : lookMessage.slice(0, 160))}——两个工具必须同一口径，否则模型会以为「看能用、动手不能用」而反复重试`,
  )

  // ── 桩链路在场：地址闸门真的在拒 ─────────────────────────────────────────
  const stubLink = {
    available: () => true,
    views: async () => [{ id: 'agent-1', url: 'https://example.com/', title: '示例', loading: false, visible: true }],
    open: async (url, viewId) => ({ viewId: viewId ?? 'agent-2', attached: true, url }),
    close: async () => {},
    call: async () => ({}),
    onEvent: () => () => {},
    session: (viewId) => ({ sessionId: viewId, send: async () => ({}), on: () => () => {} }),
  }
  const linked = mountDock(true, stubLink)
  const linkedAct = linked.tools.find((tool) => tool.name === 'browser_dock')
  const linkedLook = linked.tools.find((tool) => tool.name === 'browser_dock_look')

  // 正对照：桩链路可用时只读动作要能正常返回，证明上面那些「拒」不是「什么都拒」。
  const viewsText = await linkedLook.run({ action: 'views' }, { signal: new AbortController().signal })
  check(
    '桩链路可用时 views 正常返回（拒地址不是「什么都拒」）',
    typeof viewsText === 'string' && viewsText.includes('agent-1'),
    `views 返回：${JSON.stringify(typeof viewsText === 'string' ? viewsText.slice(0, 120) : viewsText)}——正对照不成立的话，下面的「拒」可能只是链路根本不通`,
  )

  const metadata = await humanError(() => linkedAct.run({ action: 'navigate', viewId: 'agent-1', url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' }, { signal: new AbortController().signal }))
  check(
    'navigate 拒云元数据地址 169.254.169.254',
    metadata !== null && metadata.includes('云元数据地址'),
    `实际：${JSON.stringify(metadata === null ? null : metadata.slice(0, 140))}——这些地址给虚拟机发临时凭据，被网页内容牵着走的模型绝不该 GET 它们（与 browser.ts 同一道黑名单）`,
  )
  const gcpMetadata = await humanError(() => linkedAct.run({ action: 'navigate', viewId: 'agent-1', url: 'http://metadata.google.internal/computeMetadata/v1/' }, { signal: new AbortController().signal }))
  check(
    'navigate 拒 metadata.google.internal',
    gcpMetadata !== null && gcpMetadata.includes('云元数据地址'),
    `实际：${JSON.stringify(gcpMetadata === null ? null : gcpMetadata.slice(0, 140))}——GCP 的元数据主机名与 AWS 那个 IP 是同一档，漏一个等于留了半边口子`,
  )
  const fileUrl = await humanError(() => linkedAct.run({ action: 'navigate', viewId: 'agent-1', url: 'file:///C:/Windows/win.ini' }, { signal: new AbortController().signal }))
  check(
    'navigate 拒 file://（只允许 http/https）',
    fileUrl !== null && (fileUrl.includes('只允许 http/https') || fileUrl.includes('file:')),
    `实际：${JSON.stringify(fileUrl === null ? null : fileUrl.slice(0, 140))}——这是桌面侧那道复检的第一道；两道都在，「进审批之前就挡掉」与「真到桌面侧再挡」谁也不替谁省`,
  )
  const openFileUrl = await humanError(() => linkedAct.run({ action: 'open', url: 'file:///C:/Windows/win.ini' }, { signal: new AbortController().signal }))
  check(
    'open 同样拒 file://（开页签那条路也过同一道闸）',
    openFileUrl !== null && openFileUrl.includes('http/https'),
    `实际：${JSON.stringify(openFileUrl === null ? null : openFileUrl.slice(0, 140))}——open 是「先开户再导航」，不在这儿挡，用户会看到一个页签开出来又立刻失败`,
  )
}

console.log('\n[7] 壳侧不许手抄漂移：事件名、实参位置、页签去重')
{
  const uiSrc = read('ui-shell/src/plugins/browser/ui.tsx')
  const subscribed = [...uncomment(uiSrc).matchAll(/native\.on\(\s*'([^']+)'/g)].map((match) => match[1])
  check(
    'ui.tsx 订阅的两个全局事件名 === 契约常量（逐字相等）',
    subscribed.includes(DOCK_TAB_OPEN_EVENT) && subscribed.includes(DOCK_TAB_CLOSE_EVENT),
    `ui.tsx 订阅到的是 ${JSON.stringify(subscribed)}，契约是 ${JSON.stringify([DOCK_TAB_OPEN_EVENT, DOCK_TAB_CLOSE_EVENT])}：壳与桌面侧走的是事件名这条字符串通道，抄错一个字符桌面侧推来的开户请求就永远没人接，表现为「open 一直等到超时」`,
  )
  const tabish = subscribed.filter((name) => name.startsWith('browser-tab-'))
  check(
    '壳里没有第三个 browser-tab-* 的错拼（命名漂移会被当场抓住）',
    tabish.length === 2 && tabish.every((name) => name === DOCK_TAB_OPEN_EVENT || name === DOCK_TAB_CLOSE_EVENT),
    `扫到 ${JSON.stringify(tabish)}：除契约那两条之外还有别的 browser-tab-* 名字，说明壳侧出现了各自命名的第二份事件面`,
  )
  check(
    '开户事件把桌面发的号原样交给页签（不自己另起名字）',
    /openDockBrowserTab\([\s\S]{0,80}?,\s*id\s*\)/.test(uncomment(uiSrc)),
    'ui.tsx 收到 browser-tab-open-request 后没有把载荷里的 id 当第二个实参传给 openDockBrowserTab：壳自造 id 的话宿主台账与页签 id 对不上号，后续每条 browser-call 都指不到这一台',
  )

  const stateSrc = read('ui-shell/src/ui-dockkit/dock-state.ts')
  check(
    'openDockBrowserTab 的第二个形参就是 viewId（实参只能从尾部加）',
    /export function openDockBrowserTab\(\s*url\?:\s*string,\s*viewId\?:\s*string\s*\)/.test(stateSrc) &&
      /dockActions\.openBrowserTab\(url,\s*undefined,\s*viewId\)/.test(stateSrc),
    'dock-state.ts 里 openDockBrowserTab 的签名/转发与「url, viewId → openBrowserTab(url, undefined, viewId)」不一致：从中间插一个实参会让 label 被当成 id，页签 id 全乱',
  )

  // 真跑 dock-model 源码（Node 类型擦除直读 .ts）：同 id 重开只聚焦、不新建。
  const model = await import(modUrl('ui-shell/src/ui-dockkit/dock-model.ts'))
  const { makeTab, defaultSurface, openBrowserTab } = model
  check(
    'makeTab 支持第三个可选 id，给了就用它',
    makeTab('browser', 'https://example.com/', 'agent-9').id === 'agent-9' &&
      makeTab('browser', 'https://example.com/').id !== 'agent-9' &&
      makeTab('browser', undefined, 'agent-10').id === 'agent-10',
    'makeTab 的第三个 id 参数没生效：桌面侧指名的那台视图拿不到约定的 id，页签与原生视图对不上号',
  )
  const base = openBrowserTab(defaultSurface(), 'https://example.com/', '标题', 'agent-9')
  const browserTabs = base.panes.flatMap((pane) => pane.tabs).filter((tab) => tab.kind === 'browser')
  check(
    'openBrowserTab 用指定 id 建页签并带上地址与标题',
    browserTabs.length === 1 && browserTabs[0].id === 'agent-9' && browserTabs[0].path === 'https://example.com/' && browserTabs[0].label === '标题',
    `建出来的页签是 ${JSON.stringify(browserTabs)}：id 或 path 丢了，壳就认不出「桌面侧要我开的那一台」`,
  )
  const again = openBrowserTab(base, 'https://other.example.com/', undefined, 'agent-9')
  const againTabs = again.panes.flatMap((pane) => pane.tabs).filter((tab) => tab.kind === 'browser')
  check(
    '同 id 重开只聚焦不新建（页签数不变）',
    againTabs.length === 1,
    `重开后这个布局里有 ${String(againTabs.length)} 张浏览器页签：agent 的「开页签」与「导航」是两次调用、同一个 id，不去重会在页签条上堆出一排一模一样的页签`,
  )
  check(
    '同 id 重开不换地址（只聚焦）',
    againTabs[0].path === 'https://example.com/' && again.panes.some((pane) => pane.activeTabId === 'agent-9'),
    `重开后地址变成 ${JSON.stringify(againTabs[0].path)}：壳若顺手改地址，工具面里 open 那句「同 id 重开只聚焦、不会换地址」的承诺就是假的`,
  )
  const other = openBrowserTab(again, 'https://third.example.com/', undefined, 'agent-11')
  check(
    '不同 id 正常新开一张（去重不误伤）',
    other.panes.flatMap((pane) => pane.tabs).filter((tab) => tab.kind === 'browser').length === 2,
    '换了 id 却没开出新页签：去重条件写成了「已有浏览器页签就聚焦」，多开能力被吃掉',
  )
}

console.log('\n[8] 原生桥事件面：两条新事件进白名单（用常量而不是字面量）')
{
  check(
    'NATIVE_EVENTS 含契约那两条页签事件（同一个值的两个名字）',
    NATIVE_EVENTS.includes(DOCK_TAB_OPEN_EVENT) && NATIVE_EVENTS.includes(DOCK_TAB_CLOSE_EVENT) && NATIVE_EVENT_SET.has(DOCK_TAB_OPEN_EVENT) && NATIVE_EVENT_SET.has(DOCK_TAB_CLOSE_EVENT),
    `NATIVE_EVENTS=${JSON.stringify(NATIVE_EVENTS)}：桌面主进程推页签事件、壳经原生桥订阅，白名单漏一条壳就永远收不到（截图/关页签那两条路径直接不通）`,
  )
  check(
    '事件名互不相同且形如 browser-tab-*-request',
    DOCK_TAB_OPEN_EVENT !== DOCK_TAB_CLOSE_EVENT && /^browser-tab-.+-request$/.test(DOCK_TAB_OPEN_EVENT) && /^browser-tab-.+-request$/.test(DOCK_TAB_CLOSE_EVENT),
    `事件名是 ${DOCK_TAB_OPEN_EVENT} / ${DOCK_TAB_CLOSE_EVENT}：两条撞名或不合命名口径会让 preload 的频道名与壳的订阅名对不上`,
  )
  const bridgeSrc = uncomment(read('src/core/native-bridge.ts'))
  check(
    'native-bridge.ts 引用契约常量（不在白名单里手抄字符串）',
    bridgeSrc.includes("import { DOCK_TAB_CLOSE_EVENT, DOCK_TAB_OPEN_EVENT } from './dock-browser.js'") &&
      bridgeSrc.includes('DOCK_TAB_OPEN_EVENT,') &&
      bridgeSrc.includes('DOCK_TAB_CLOSE_EVENT,') &&
      !bridgeSrc.includes("'browser-tab-open-request'") &&
      !bridgeSrc.includes("'browser-tab-close-request'"),
    'src/core/native-bridge.ts 里出现了事件名字面量（或不再 import 契约常量）：这正是「手抄漂移」的形状——契约改了名这一份不会跟着改',
  )
  check(
    'NATIVE_EVENTS 无重复项（Set 化后不会少一条）',
    new Set(NATIVE_EVENTS).size === NATIVE_EVENTS.length,
    `NATIVE_EVENTS 里有重复：${JSON.stringify(NATIVE_EVENTS)}`,
  )
  check(
    'NATIVE_BRIDGE_VERSION 仍是 3（本次只加事件，按「加操作不涨」，没抬版）',
    NATIVE_BRIDGE_VERSION === 3,
    `桥版本是 ${String(NATIVE_BRIDGE_VERSION)}：它自己那条注释写着「加操作不涨，改实参/语义才涨」，而这次两条页签事件是纯新增（旧壳不认识就收不到，不会误判）——若这里被抬成 4，说明有人顺手改了别的东西，得单独核`,
  )
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
if (failures === 0) rmSync(home, { recursive: true, force: true })
else console.log(`（临时 HOME 留在 ${home} 供排查）`)
process.exit(failures === 0 ? 0 : 1)
