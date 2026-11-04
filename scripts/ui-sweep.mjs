/**
 * 功能走查：起一个隔离宿主（临时 HOME + 假模型端点）+ 真 Electron，按清单逐项点、逐项断言、逐项截图。
 *
 * 为什么要有它：单元测试证明「每块能画」，证明不了「点下去真的发生」。这一条走的是
 * 用户视角——侧栏点开、设置翻页、输入框打字、发一条消息、开关一个插件——每步一张截图。
 *
 * 与 `ui-boot-e2e.mjs` 的分工：那条只验「壳在不在、诊断页对不对」；这条验**功能**。
 *
 * 跑法：node scripts/ui-sweep.mjs [--only 名字前缀] [--head]
 * 依赖：先 `pnpm run build` 与 `pnpm run build:ui`（产物在 lib/ 与 lib/ui/）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'scripts', '_ui-sweep-main.cjs')
const FAKE_LLM = join(root, 'desktop', 'shots', 'conv-fake-llm.mjs')
/** 截图落点：按语言分目录（中英两套截图不会互相覆盖）。 */
const SHOTS = join(root, 'desktop', 'shots', 'sweep')

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null
/** 走查哪种语言：`zh`（缺省）或 `en`。语言在 config.yaml 里，页面启动时读一次。 */
const lang = process.argv.includes('--lang') ? process.argv[process.argv.indexOf('--lang') + 1] : 'zh'
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

/** 让系统挑一个空闲端口。 */
function freePort() {
  return new Promise((ok, bad) => {
    const probe = createServer()
    probe.once('error', bad)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => ok(port))
    })
  })
}

/**
 * 走查用的步骤清单。
 *
 * 每步可以带 `clickText`（按可见文字点，最稳）、`click`（CSS）、`type`（填输入框）、
 * `key`（按键）、`js`（直接求值）、`expect`（断言表达式）、`shot`（截图名）、`wait`。
 */
function stepsFor(lang) {
  const zh = lang !== 'en'
  const steps = []
  /** 加一步：`name` 里的「/」只是给人看的分组。 */
  const add = (step) => steps.push(step)
  /** 页面文字断言。 */
  const has = (text) => 'document.body.innerText.includes(' + JSON.stringify(text) + ')'
  /** 有选择器的元素。 */
  const exists = (selector) => 'document.querySelector(' + JSON.stringify(selector) + ') !== null'
  /** 点一个元素。 */
  const click = (selector) => 'document.querySelector(' + JSON.stringify(selector) + ').click()'
  /** 按可见文字点设置页左侧的导航项（精确匹配，避免点中正文里同样的词）。 */
  const nav = (text) =>
    '(() => { const item = [...document.querySelectorAll(".settings-nav-item")].find((node) => (node.innerText || "").trim() === ' +
    JSON.stringify(text) + '); if (!item) throw new Error("设置导航里没有：" + ' + JSON.stringify(text) + '); item.click(); return true })()'
  /** 设置页右栏的标题（`.settings-head` 里的第一行）。 */
  const headText = '(() => { const head = document.querySelector(".settings-head"); return head === null ? "" : head.innerText.trim() })()'

  add({ name: '启动/首帧：骨架画出来了', expect: 'document.querySelectorAll(".app").length === 1', shot: '01-boot' })
  add({ name: '启动/侧栏：新会话入口在', expect: has(zh ? '新会话' : 'New session') })
  add({ name: '启动/启动图：host.language 有值', expect: 'typeof (globalThis.__DSC_BOOT__ || {}).host === "object"' })

  // ── 骨架：侧栏折叠 ──
  add({ name: '骨架/侧栏折叠（Ctrl+B）', key: { key: 'b', ctrlKey: true } })
  add({ name: '骨架/折叠成窄栏', expect: exists('.rail'), shot: '02-rail' })
  add({ name: '骨架/再按 Ctrl+B 展开', key: { key: 'b', ctrlKey: true } })
  add({ name: '骨架/侧栏回来了', expect: exists('.sidebar') })

  // ── 会话与输入 ──
  add({ name: '输入/新建会话', click: '.btn-new', wait: 700 })
  add({ name: '输入/输入框可见', expect: exists('.composer textarea') })
  add({ name: '输入/打一句话发出去', type: '.composer textarea', text: zh ? '你好，走查一下输入框' : 'hello, sweeping the composer' })
  add({ name: '输入/发送', click: '.send-btn', wait: 4000 })
  add({ name: '输入/模型回了话（假端点）', expect: '/收到第 [0-9]+ 次请求|request #?[0-9]/i.test(document.body.innerText)', shot: '03-chat' })
  add({ name: '输入/消息留在会话里', expect: has(zh ? '你好，走查一下输入框' : 'hello, sweeping the composer') })

  // ── 底栏三颗 chip ──
  add({ name: '底栏/模型菜单', click: '.composer-model-chip', wait: 600 })
  add({ name: '底栏/模型菜单列出端点与模型', expect: has('Fake Chat') && exists('.composer-model-chip'), shot: '04-model-menu' })
  add({ name: '底栏/关模型菜单', key: { key: 'Escape' }, wait: 300 })
  add({ name: '底栏/思考强度', click: '.composer-effort-chip', wait: 600 })
  add({ name: '底栏/思考强度有显示', expect: 'document.querySelector(".composer-effort-chip").innerText.trim().length > 0', shot: '05-effort' })
  add({ name: '底栏/关思考强度', key: { key: 'Escape' }, wait: 300 })
  add({
    name: '底栏/权限预设菜单',
    js: '(() => { const button = [...document.querySelectorAll(".composer button")].find((node) => node.getAttribute("aria-haspopup") === "menu" && (node.getAttribute("aria-label") || "").length > 0 && /只读|工作区|完全|AI|Read|Workspace|Full/i.test(node.innerText || "")); if (!button) throw new Error("找不到权限那颗 chip"); button.click(); return true })()',
    wait: 700,
  })
  add({ name: '底栏/权限菜单四项', expect: 'document.querySelectorAll(".policy-pop [role=menuitem], .policy-pop button").length >= 4', shot: '06-policy' })
  add({ name: '底栏/关权限菜单', key: { key: 'Escape' }, wait: 300 })

  // ── 斜杠与 @ ──
  add({ name: '输入/斜杠菜单', type: '.composer textarea', text: '/' })
  add({ name: '输入/斜杠菜单列出来了', expect: exists('.slash-pop'), shot: '07-slash' })
  add({ name: '输入/清空', type: '.composer textarea', text: '' })
  add({ name: '输入/@ 提及菜单', type: '.composer textarea', text: '@' })
  add({ name: '输入/@ 列出工作区文件', expect: exists('.mention-pop'), shot: '08-mention' })
  add({ name: '输入/清空并收菜单', key: { key: 'Escape' }, wait: 200 })
  add({ name: '输入/再清空一次', type: '.composer textarea', text: '' })

  // ── 整页：技能、插件 ──
  add({ name: '侧栏/技能页', click: '.sidebar-nav .nav-item:nth-child(1)', wait: 1000 })
  add({ name: '侧栏/技能中心画出来了', expect: has(zh ? '技能' : 'Skills'), shot: '09-skills' })
  add({ name: '侧栏/插件页', click: '.sidebar-nav .nav-item:nth-child(2)', wait: 1000 })
  add({ name: '侧栏/插件中心有分组', expect: has(zh ? '运行内核' : 'Runtime kernel'), shot: '10-plugins' })

  // ── 界面插件开关：真热更（不刷新页面） ──
  // 命令面板只在对话页接 Ctrl+K，所以开关前后都要回到对话页再按键——否则「打不开」
  // 可能只是那一页没绑，测不到热更。
  add({ name: '热更/回对话页', click: '.sess-item', wait: 900 })
  add({ name: '热更/先确认命令面板能开', key: { key: 'k', ctrlKey: true }, wait: 900 })
  add({ name: '热更/面板在', expect: exists('.palette'), shot: '11-palette' })
  add({ name: '热更/关掉面板', key: { key: 'Escape' }, wait: 400 })
  add({ name: '热更/去插件页', click: '.sidebar-nav .nav-item:nth-child(2)', wait: 1000 })
  add({
    name: '热更/停用「命令面板」这条界面插件',
    js: '(() => { const button = [...document.querySelectorAll("button.switch[role=switch]")].find((node) => (node.getAttribute("aria-label") || "").toLowerCase().includes("命令面板") || (node.getAttribute("aria-label") || "").toLowerCase().includes("palette")); if (!button) throw new Error("找不到命令面板的开关"); button.click(); return true })()',
    wait: 2500,
  })
  add({
    name: '热更/开关真的翻成停用',
    expect: '(() => { const button = [...document.querySelectorAll("button.switch[role=switch]")].find((node) => (node.getAttribute("aria-label") || "").toLowerCase().includes("命令面板") || (node.getAttribute("aria-label") || "").toLowerCase().includes("palette")); return button !== undefined && button.getAttribute("aria-checked") === "false" })()',
    probe: '({ switches: [...document.querySelectorAll("button.switch[role=switch]")].filter((node) => (node.getAttribute("aria-label") || "").includes("命令面板")).map((node) => ({ label: node.getAttribute("aria-label"), checked: node.getAttribute("aria-checked"), disabled: node.disabled })) })',
  })
  add({ name: '热更/停用后回对话页', click: '.sess-item', wait: 900 })
  add({ name: '热更/停用后按 Ctrl+K', key: { key: 'k', ctrlKey: true }, wait: 900 })
  add({
    name: '热更/面板确实没开（页面没有重载）',
    expect: 'document.querySelectorAll(".palette").length === 0 && document.querySelectorAll(".app").length === 1',
    probe: '({ palette: ((globalThis.__DSC_UI_BOOT_STATE__ || {}).plugins || {}).palette || null, entries: ((globalThis.__DSC_BOOT__ || {}).entries || []).length, disabled: (globalThis.__DSC_BOOT__ || {}).disabled || null })',
    shot: '12-palette-off',
  })
  add({ name: '热更/再回插件页', click: '.sidebar-nav .nav-item:nth-child(2)', wait: 1000 })
  add({
    name: '热更/再启用回来',
    js: '(() => { const button = [...document.querySelectorAll("button.switch[role=switch]")].find((node) => (node.getAttribute("aria-label") || "").toLowerCase().includes("命令面板") || (node.getAttribute("aria-label") || "").toLowerCase().includes("palette")); if (!button) throw new Error("找不到命令面板的开关"); button.click(); return true })()',
    wait: 2500,
  })
  add({ name: '热更/启用后回对话页', click: '.sess-item', wait: 900 })
  add({ name: '热更/启用后 Ctrl+K 又能开', key: { key: 'k', ctrlKey: true }, wait: 900 })
  add({ name: '热更/面板回来了', expect: exists('.palette'), shot: '13-palette-back' })
  add({ name: '热更/关掉面板', key: { key: 'Escape' }, wait: 400 })

  // ── 回到会话、轨迹页 ──
  add({ name: '会话/点回会话', click: '.sess-item', wait: 800 })
  add({ name: '会话/输入框回来了', expect: exists('.composer textarea') })
  add({
    name: '会话/切到轨迹页',
    js: '(() => { const tab = [...document.querySelectorAll(".tabs button")].find((node) => (node.innerText || "").trim() === ' + JSON.stringify(zh ? '轨迹' : 'Trace') + '); if (!tab) throw new Error("没有轨迹页签"); tab.click(); return true })()',
    wait: 1200,
  })
  add({ name: '会话/轨迹页有时间线', expect: exists('.trace') || has(zh ? '全部展开' : 'Expand all'), shot: '13-trace' })
  add({
    name: '会话/切回对话页',
    js: '(() => { const tab = [...document.querySelectorAll(".tabs button")].find((node) => (node.innerText || "").trim() === ' + JSON.stringify(zh ? '对话' : 'Chat') + '); if (!tab) throw new Error("没有对话页签"); tab.click(); return true })()',
    wait: 800,
  })

  // ── 设置页逐个分区 ──
  add({ name: '设置/打开', js: '(() => { const buttons = [...document.querySelectorAll(".sidebar .row-btn")]; const target = buttons[buttons.length - 1]; if (!target) throw new Error("侧栏没有设置行"); target.click(); return true })()', wait: 1000 })
  add({ name: '设置/弹层画出来了', expect: exists('.settings[role=dialog]'), shot: '14-settings' })
  add({ name: '设置/左侧导航至少六项', expect: 'document.querySelectorAll(".settings-nav-item").length >= 6' })
  const count = 7
  for (let index = 1; index <= count; index += 1) {
    add({
      name: '设置/第 ' + String(index) + ' 个分区',
      js: '(() => { const item = document.querySelectorAll(".settings-nav-item")[' + String(index - 1) + ']; if (!item) throw new Error("没有第 ' + String(index) + ' 个分区"); item.click(); return true })()',
      wait: 800,
      expect:
        '(() => { const head = document.querySelector(".settings-head"); const on = document.querySelector(".settings-nav-item.on"); const main = document.querySelector(".settings-main"); return head !== null && main !== null && on !== null && head.innerText.trim().length > 0 && main.innerText.length > 20' +
        (zh ? ' && /[\u4e00-\u9fff]/.test(head.innerText)' : ' && !/[\u4e00-\u9fff]/.test(head.innerText)') +
        ' })()',
      ...(index === 1 ? { shot: '15-settings-general' } : {}),
    })
  }
  add({ name: '设置/关掉', key: { key: 'Escape' }, wait: 600 })
  add({ name: '设置/弹层没了', expect: 'document.querySelectorAll(".settings").length === 0' })

  // ── 命令面板 ──
  add({ name: '面板/Ctrl+K 打开', key: { key: 'k', ctrlKey: true }, wait: 900 })
  add({ name: '面板/有搜索框', expect: 'document.querySelectorAll(".palette").length === 1 && document.querySelectorAll(".palette input").length >= 1', shot: '16-palette' })
  add({ name: '面板/关掉', key: { key: 'Escape' }, wait: 400 })

  return steps.filter((step) => only === null || step.name.startsWith(only))
}

/**
 * 造一份隔离的 HOME：一份指向本机假端点的 config.yaml、一份界面偏好、一份启停记录。
 * @param dir - 临时 HOME
 * @param llmPort - 假端点端口
 */
function seedHome(dir, llmPort, language) {
  mkdirSync(join(dir, '.dsc', 'sessions'), { recursive: true })
  writeFileSync(
    join(dir, '.dsc', 'config.yaml'),
    'language: ' + language + '\n' +
      'default:\n  provider: fake\n  model: fake-chat\nproviders:\n  fake:\n    displayName: 自检假端点\n' +
      '    baseURL: http://127.0.0.1:' + String(llmPort) + '/v1\n    apiKeyEnv: DSC_FAKE_KEY\n    models:\n' +
      '      - id: fake-chat\n        name: Fake Chat\n        contextWindow: 128000\n        maxTokens: 4096\n',
    'utf8',
  )
  writeFileSync(
    join(dir, '.dsc', 'settings.json'),
    JSON.stringify({ defaultPolicy: null, defaultEffort: null, marketSources: [], closeToTray: false, ui: { themeMode: 'dark', fontSize: 'md', density: 'standard', sessionGroup: 'workspace' } }, null, 2) + '\n',
    'utf8',
  )
  writeFileSync(
    join(dir, '.dsc', 'plugins.json'),
    JSON.stringify({ version: 1, entries: [{ file: 'subagent', disabled: false, config: {} }] }, null, 2) + '\n',
    'utf8',
  )
}

async function main() {
  if (!existsSync(ELECTRON)) throw new Error('没有 Electron：先 pnpm -C desktop install')
  const work = mkdtempSync(join(tmpdir(), 'numa-sweep-'))
  const home = join(work, 'home')
  const dsc = join(home, '.dsc')
  const llmPort = await freePort()
  const port = await freePort()
  seedHome(home, llmPort, lang)

  const fake = spawn(process.execPath, [FAKE_LLM, String(llmPort)], { stdio: 'ignore' })
  const host = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSC_HOME: dsc,
      DSC_UI_SERVER: '1',
      DSC_UI_PORT: String(port),
      DSC_UI_HMR: '0',
      DSC_FAKE_KEY: 'sk-selfcheck-fake',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tail = []
  host.stderr.setEncoding('utf8')
  host.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split(String.fromCharCode(10))) if (line.trim() !== '') tail.push(line)
    if (tail.length > 60) tail.splice(0, tail.length - 60)
  })
  let url = null
  host.stdout.setEncoding('utf8')
  host.stdout.on('data', (chunk) => {
    const text = String(chunk)
    const hit = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(text)
    if (hit !== null) url = hit[0]
    // 宿主的 stdout 也留一份尾巴：失败时最想知道的就是「宿主到底做了什么」。
    for (const line of text.split(String.fromCharCode(10))) {
      const trimmed = line.trim()
      // 快照帧每轮一条、几十 KB：留着会把真正的诊断行挤出去。
      if (trimmed === '' || trimmed.includes('"type":"snapshot"')) continue
      tail.push('[out] ' + trimmed)
    }
    if (tail.length > 200) tail.splice(0, tail.length - 200)
  })
  const startedAt = Date.now()
  while (url === null && Date.now() - startedAt < 90000 && host.exitCode === null) await sleep(200)
  const stop = () => {
    try { host.kill() } catch {}
    try { fake.kill() } catch {}
  }
  if (url === null) {
    stop()
    throw new Error('宿主没给出界面地址：' + tail.slice(-6).join(' | '))
  }
  console.log('宿主就绪（' + String(Date.now() - startedAt) + 'ms）：' + url.replace(/token=[^&]+/, 'token=***'))

  const steps = stepsFor(lang)
  const shotsDir = join(SHOTS, lang)
  mkdirSync(shotsDir, { recursive: true })
  const stepsFile = join(work, 'steps.json')
  const outFile = join(work, 'result.json')
  writeFileSync(stepsFile, JSON.stringify(steps, null, 2), 'utf8')

  // 这个环境变量会让 electron.exe 退化成纯 Node：那样 require('electron') 直接找不到模块。
  const electronEnv = { ...process.env }
  delete electronEnv['ELECTRON_RUN_AS_NODE']
  const driver = spawn(ELECTRON, [DRIVER, url], {
    env: { ...electronEnv, DSC_SWEEP_STEPS: stepsFile, DSC_SWEEP_OUT: outFile, DSC_SWEEP_SHOTS: shotsDir, DSC_SWEEP_USER_DATA: join(work, 'user-data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  driver.stdout.setEncoding('utf8')
  driver.stdout.on('data', (chunk) => process.stdout.write(String(chunk)))
  driver.stderr.setEncoding('utf8')
  driver.stderr.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text !== '') console.log('  [electron] ' + text.slice(0, 200))
  })
  const code = await new Promise((ok) => driver.once('exit', (value) => ok(value ?? 1)))
  stop()
  if (!existsSync(outFile)) {
    console.log('走查没有产出结果（driver 退出码 ' + String(code) + '）')
    process.exit(1)
  }
  const report = JSON.parse(readFileSync(outFile, 'utf8'))
  if (report.fail > 0 && tail.length > 0) {
    console.log('')
    console.log('宿主日志（最后 40 行）：')
    for (const line of tail.slice(-40)) console.log('  | ' + line.slice(0, 220))
  }
  console.log('')
  console.log('功能走查：' + String(report.pass) + '/' + String(report.total) + ' 通过，截图在 ' + shotsDir)
  if (Array.isArray(report.console) && report.console.length > 0) {
    console.log('页面报错 ' + String(report.console.length) + ' 条：')
    for (const line of report.console.slice(0, 8)) console.log('  ! ' + line)
  }
  process.exit(report.fail === 0 ? 0 : 1)
}

await main()
