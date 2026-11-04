/**
 * 「界面壳停用渲染器 / 骨架」真机走查：起真宿主 + 真 Electron，证明停用之后画的是
 * 诊断页，而不是白屏。
 *
 * 为什么要有这一条：引导（`ui-boot/ui/main.tsx`）与渲染器（`ui-renderer/ui/ui.tsx`）
 * 各有一块「缺席诊断页」，但它们只在**真的被停用**时才走。纯函数测试只能证明
 * 「组件能渲染」，证明不了「开关→启动图→页面」这三跳接上了——2026-11-04 拆包时
 * 这一条恰好只验到七成。
 *
 * 三段（每段都重开宿主与浏览器，互不污染）：
 *   [1] 正常态：临时 HOME 里没有停用记录 → 骨架 `.app` 在、没有诊断文案；
 *   [2] 停用骨架：`plugins.json` 里 `ui-layout` 标 disabled → 诊断页含「界面布局 /
 *       ui-layout」，且**没有** `.app`；
 *   [3] 停用渲染器：`ui-renderer` 标 disabled → 诊断页含「界面渲染器」。
 *
 * 截图落 `desktop/shots/ui-boot-*.png`，每段的标题 / 断言 / 截图路径落
 * `desktop/shots/ui-boot.json`。
 *
 * 跑法：cd D:\dsc && pnpm run build && pnpm run build:ui && node scripts/ui-boot-e2e.mjs
 * 依赖：`lib/` 与 `lib/ui/`（先构建）、`desktop/node_modules/electron`。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'scripts', '_ui-boot-e2e-main.cjs')
const SHOTS = join(root, 'desktop', 'shots')
const REPORT = join(SHOTS, 'ui-boot.json')

/** 全局失败清单（跨三段累计；最后按它定退出码）。 */
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log('  PASS ' + name)
    return true
  }
  failures.push(name)
  console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail))
  return false
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 让宿主自己挑一个空闲端口（同 _ui-dsh-card-main 的做法，避开手写端口撞车）。 */
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
 * 起一个宿主，等它在 stdout 打印带令牌的界面地址。
 *
 * @param home - 临时 HOME（隔离，不碰真身）
 * @param dsc - 临时 DSC_HOME
 * @param label - 场景名（日志用）
 * @returns { proc, url, stderr }
 */
async function startHost(home, dsc, label) {
  const port = await freePort()
  const proc = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
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
  const stderr = []
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk) => {
    stderr.push(...String(chunk).split(String.fromCharCode(10)).filter((line) => line.trim() !== ''))
    if (stderr.length > 80) stderr.splice(0, stderr.length - 80)
  })
  let url = null
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => {
    const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(String(chunk))
    if (found !== null) url = found[0]
  })
  const startedAt = Date.now()
  for (let waited = 0; waited < 90000 && url === null && proc.exitCode === null; waited += 250) await sleep(250)
  if (url === null) {
    proc.kill()
    throw new Error('[' + label + '] 宿主没给出界面地址：' + stderr.slice(-8).join(' | '))
  }
  console.log('  [' + label + '] 宿主起来了，用时 ' + String(Date.now() - startedAt) + 'ms')
  return { proc, url, stderr }
}

/** 关掉宿主并等它真的退（不等的话下一段会抢同一份 plugins.json 的读写时序）。 */
async function stopHost(host) {
  if (host === undefined || host.proc === undefined) return
  if (host.proc.exitCode !== null) return
  host.proc.kill()
  for (let waited = 0; waited < 10000 && host.proc.exitCode === null; waited += 100) await sleep(100)
}

/**
 * 把某几条插件标成停用（其余条目原样保留）。
 *
 * 走宿主自己的读写口（`plugin-registry` 的 readPluginEntries / writePluginEntries），
 * 不手抄 JSON：条目树还有 `version`、`config` 与其它顶层段（uiTrust 等），
 * 手写一份容易把别人的段抹掉。
 *
 * @param registry - 已 import 的 `lib/core/plugin-registry.js`
 * @param files - 要停用的插件行 id（`ui-layout` / `ui-renderer`）
 */
function writeDisabled(registry, files) {
  const entries = registry.readPluginEntries()
  // 先全部回正：三段共用同一份 plugins.json，上一段的停用不该漏进下一段的判断。
  for (const entry of entries) entry.disabled = false
  for (const file of files) {
    const index = entries.findIndex((entry) => entry.file === file)
    if (index < 0) entries.push({ file, disabled: true, config: {} })
    else entries[index] = { ...entries[index], disabled: true }
  }
  registry.writePluginEntries(entries)
  return entries
}

/** 跑一次 Electron 探针；读数写进 resultPath，返回解析后的对象。 */
async function runDriver({ url, home, label, resultPath, shotPath }) {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  env['DSC_BOOT_RESULT'] = resultPath
  env['DSC_BOOT_SHOT'] = shotPath
  env['DSC_BOOT_LABEL'] = label
  env['DSC_BOOT_USER_DATA'] = join(home, 'electron-user-data-' + label)
  const electron = spawn(ELECTRON, [DRIVER, url], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })
  const startedAt = Date.now()
  for (let waited = 0; waited < 240000 && !existsSync(resultPath); waited += 250) await sleep(250)
  const waitedMs = Date.now() - startedAt
  if (!existsSync(resultPath)) {
    electron.kill()
    throw new Error('[' + label + '] 驱动没写出读数文件（等了 ' + String(waitedMs) + 'ms）')
  }
  let result
  try {
    result = JSON.parse(readFileSync(resultPath, 'utf8'))
  } finally {
    // 解析失败也要收掉 Electron：留一个窗口在那儿，下一次运行会多一份 userData 锁的麻烦。
    electron.kill()
  }
  return { result, waitedMs }
}

/** 截图在不在、有没有内容（一张纯黑 PNG 也有几 KB，所以门槛取 8KB，防的是空帧）。 */
function shotOk(path) {
  if (!existsSync(path)) return false
  try {
    return statSync(path).size > 8000
  } catch {
    return false
  }
}

/** 摘要进报告：正文截一段，够事后看懂「页面上到底有什么」。 */
function textPeek(probe) {
  return String(probe.text || '').replace(/\s+/g, ' ').trim().slice(0, 700)
}

/** 一段场景的通用外壳：起宿主 → 开页面 → 断言 → 收摊。 */
async function runScene(registry, scene) {
  console.log(String.fromCharCode(10) + '[' + scene.key + '] ' + scene.title)
  const startedAt = Date.now()
  const resultPath = join(scene.home, 'boot-' + scene.key + '.json')
  const assertions = []
  const record = (name, ok, detail = '') => {
    assertions.push({ name, ok, detail })
    check(name, ok, detail)
  }
  let host = null
  let probe = null
  let error = null
  try {
    if (scene.disabled.length === 0) {
      // 正常态：清掉停用记录（三段之间的文件是同一份，必须显式回正）。
      const entries = registry.readPluginEntries()
      for (const entry of entries) entry.disabled = false
      registry.writePluginEntries(entries)
    } else {
      writeDisabled(registry, scene.disabled)
    }
    host = await startHost(scene.home, scene.dsc, scene.key)
    const { result, waitedMs } = await runDriver({
      url: host.url,
      home: scene.home,
      label: scene.key,
      resultPath,
      shotPath: scene.shot,
    })
    if (result.error !== undefined) {
      throw new Error('[' + scene.key + '] 驱动报错：' + String(result.error).split(String.fromCharCode(10))[0])
    }
    probe = result.probe
    console.log('  [' + scene.key + '] 落定用时 ' + String(result.settleMs) + 'ms，网页用时 ' + String(waitedMs) + 'ms')
    scene.assert(record, probe, scene, result)
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
    console.log('  FAIL 整段跑通 —— ' + error)
    failures.push('[' + scene.key + '] 整段跑通')
    assertions.push({ name: '整段跑通', ok: false, detail: error })
  } finally {
    await stopHost(host)
    if (error !== null && host !== null) {
      console.log('  ── 宿主 stderr（最后 10 行）──')
      console.log(host.stderr.slice(-10).join(String.fromCharCode(10)))
    }
  }
  const built = { key: scene.key, title: scene.title, shot: scene.shot, durationMs: Date.now() - startedAt, assertions }
  if (probe !== null) {
    built.probe = {
      app: probe.app,
      appBox: probe.appBox,
      splash: probe.splash,
      hasRendererDiag: probe.hasRendererDiag,
      hasLayoutDiag: probe.hasLayoutDiag,
      boot: probe.boot,
      bootPlugins: probe.bootPlugins,
      firstFrameAt: probe.firstFrameAt,
      text: textPeek(probe),
    }
  }
  if (error !== null) built.error = error
  const pass = assertions.filter((row) => row.ok).length
  const fail = assertions.length - pass
  console.log('  [' + scene.key + '] PASS ' + String(pass) + ' / FAIL ' + String(fail))
  return built
}

async function main() {
  console.log('[ui-boot] 真机走查：停用渲染器 / 骨架时画的是诊断页')
  const electronOk = check('Electron 在', existsSync(ELECTRON), ELECTRON)
  const shellOk = check('界面壳产物在', existsSync(join(root, 'lib', 'ui', 'assets', 'index.html')))
  check('渲染器产物在', existsSync(join(root, 'lib', 'ui', 'plugins', 'renderer', 'client.js')))
  check('骨架产物在', existsSync(join(root, 'lib', 'ui', 'plugins', 'layout', 'client.js')))
  // [0] 产物形态：骨架的实现必须**真在这个 bundle 里**（2026-11-04 夜搬完之后的判据）。
  // 1.3 KB 那种「转手 require 平台种子」的薄入口正是这一轮要消灭的东西，所以按体积与
  // 依赖两条一起看：体积证明实现进来了，require 清单证明共享状态还是从种子里取的。
  const layoutCode = readFileSync(join(root, 'lib', 'ui', 'plugins', 'layout', 'client.js'), 'utf8')
  check(
    '骨架产物体积说明实现真在里面（> 30 KB）',
    Buffer.byteLength(layoutCode) > 30 * 1024,
    String(Buffer.byteLength(layoutCode)) + ' B',
  )
  check(
    '骨架产物从平台种子取共享状态（require @dsc/ui-runtime）',
    layoutCode.includes('require("@dsc/ui-runtime")'),
  )
  check(
    '骨架产物不把布局包留成 require（实现是内联的）',
    !layoutCode.includes('require("@dsc/ui-layout")'),
  )
  // 所有产物都不许 require 这两个：前者不提供给插件，后者只属于布局自己。
  const pluginDir = join(root, 'lib', 'ui', 'plugins')
  const offenders = readdirSync(pluginDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ id: entry.name, code: readFileSync(join(pluginDir, entry.name, 'client.js'), 'utf8') }))
    .filter((row) => row.code.includes('require("@dsc/ui-core")') || (row.id !== 'layout' && row.code.includes('require("@dsc/ui-layout")')))
    .map((row) => row.id)
  check('没有产物 require 内核或布局包', offenders.length === 0, offenders.join(','))
  if (!electronOk || !shellOk) {
    writeReport([], Date.now())
    process.exit(1)
  }
  mkdirSync(SHOTS, { recursive: true })

  const home = mkdtempSync(join(tmpdir(), 'dsc-ui-boot-'))
  const dsc = join(home, '.dsc')
  mkdirSync(dsc, { recursive: true })
  // 宿主与探针进程都要看到同一个临时 HOME / DSC_HOME；registry 的 DSC_HOME 在 import
  // 那一刻就定下了，所以先设环境变量再动态 import。
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  process.env['DSC_HOME'] = dsc
  // 给界面一个「有端点」的假 provider：本探针不发起对话，只是让正常态那张截图里
  // 不出现「没有可用的模型端点」的提示条（那是配置问题，不是本探针要证的事）。
  writeFileSync(
    join(dsc, 'config.yaml'),
    [
      '# 自检专用：一个指向本机 discard 端口的假 provider（不联网、不花钱、不发请求）',
      'default:',
      '  provider: fake',
      '  model: fake-chat',
      'providers:',
      '  fake:',
      '    displayName: 自检假端点',
      '    baseURL: http://127.0.0.1:9/v1',
      '    apiKeyEnv: DSC_FAKE_KEY',
      '    models:',
      '      - id: fake-chat',
      '        name: Fake Chat',
      '        contextWindow: 128000',
      '        maxTokens: 4096',
      '',
    ].join(String.fromCharCode(10)),
    'utf8',
  )

  const registry = await import(new URL('../lib/core/plugin-registry.js', import.meta.url).href)
  console.log('  临时 HOME：' + home)

  const scenes = [
    {
      key: 'normal',
      title: '正常态：骨架画出来了，没有诊断文案',
      home,
      dsc,
      disabled: [],
      shot: join(SHOTS, 'ui-boot-normal.png'),
      assert: (record, probe) => {
        record('页面里有骨架根节点 .app', probe.app >= 1, '.app 个数=' + String(probe.app))
        record(
          '.app 有可见尺寸（不是 0×0 的空壳）',
          probe.appBox !== null && probe.appBox.width >= 200 && probe.appBox.height >= 200,
          JSON.stringify(probe.appBox),
        )
        record('没有渲染器诊断文案（「界面渲染器」）', probe.hasRendererDiag === false, textPeek(probe))
        record('没有布局诊断文案（「界面布局」）', probe.hasLayoutDiag === false, textPeek(probe))
        record(
          '启动图里有 layout 与 renderer 两条',
          probe.boot !== null && probe.boot.entries.includes('layout') && probe.boot.entries.includes('renderer'),
          JSON.stringify(probe.boot === null ? null : probe.boot.entries),
        )
        record(
          '启动图 disabled 里没有 layout / renderer',
          probe.boot !== null && !probe.boot.disabled.includes('layout') && !probe.boot.disabled.includes('renderer'),
          JSON.stringify(probe.boot === null ? null : probe.boot.disabled),
        )
        record('启动占位 #boot-splash 已退场', probe.splash === false, String(probe.splash))
      },
    },
    {
      key: 'layout-off',
      title: '停用骨架：画布局诊断页，没有 .app',
      home,
      dsc,
      disabled: ['ui-layout'],
      shot: join(SHOTS, 'ui-boot-layout-off.png'),
      assert: (record, probe) => {
        record('页面文字里有「界面布局」', probe.hasLayoutDiag === true, textPeek(probe))
        record('页面文字里有「ui-layout」', probe.hasUiLayout === true, textPeek(probe))
        record('页面里没有骨架根节点 .app', probe.app === 0, '.app 个数=' + String(probe.app))
        record(
          '启动图 disabled 里记着 layout',
          probe.boot !== null && probe.boot.disabled.includes('layout'),
          JSON.stringify(probe.boot === null ? null : probe.boot.disabled),
        )
        record(
          '启动图 entries 里没有 layout、仍有 renderer',
          probe.boot !== null && !probe.boot.entries.includes('layout') && probe.boot.entries.includes('renderer'),
          JSON.stringify(probe.boot === null ? null : probe.boot.entries),
        )
        record('诊断页不是空白（正文长度 > 40）', String(probe.text || '').trim().length > 40, '长度=' + String(String(probe.text || '').trim().length))
        record('启动占位 #boot-splash 已退场（诊断页没被盖住）', probe.splash === false, String(probe.splash))
      },
    },
    {
      key: 'renderer-off',
      title: '停用渲染器：画渲染器诊断页',
      home,
      dsc,
      disabled: ['ui-renderer'],
      shot: join(SHOTS, 'ui-boot-renderer-off.png'),
      assert: (record, probe) => {
        record('页面文字里有「界面渲染器」', probe.hasRendererDiag === true, textPeek(probe))
        record('页面文字里有「ui-renderer」', probe.hasUiRenderer === true, textPeek(probe))
        record('页面里没有骨架根节点 .app', probe.app === 0, '.app 个数=' + String(probe.app))
        record(
          '启动图 disabled 里记着 renderer',
          probe.boot !== null && probe.boot.disabled.includes('renderer'),
          JSON.stringify(probe.boot === null ? null : probe.boot.disabled),
        )
        record(
          '启动图 entries 里没有 renderer、骨架 layout 仍在',
          probe.boot !== null && !probe.boot.entries.includes('renderer') && probe.boot.entries.includes('layout'),
          JSON.stringify(probe.boot === null ? null : probe.boot.entries),
        )
        record('诊断页不是空白（正文长度 > 40）', String(probe.text || '').trim().length > 40, '长度=' + String(String(probe.text || '').trim().length))
        record('启动占位 #boot-splash 已退场（诊断页没被盖住）', probe.splash === false, String(probe.splash))
      },
    },
  ]

  const startedAt = Date.now()
  const rows = []
  for (const scene of scenes) {
    const row = await runScene(registry, scene)
    // 截图单独断言：驱动写没写、写出来是不是一张有内容的图。
    const ok = shotOk(scene.shot)
    row.assertions.push({ name: '截图在且不是空帧', ok, detail: scene.shot })
    check('截图在且不是空帧（' + scene.key + '）', ok, scene.shot)
    const pass = row.assertions.filter((item) => item.ok).length
    console.log('  [' + scene.key + '] 本段合计 PASS ' + String(pass) + ' / FAIL ' + String(row.assertions.length - pass))
    rows.push(row)
  }
  const totalMs = Date.now() - startedAt
  const report = writeReport(rows, totalMs)
  console.log(String.fromCharCode(10) + '耗时 ' + String(totalMs) + 'ms，报告：' + report)
  if (failures.length > 0) console.log('失败项：' + failures.join('、'))
}

/** 写 `desktop/shots/ui-boot.json`：每段的标题、断言、截图路径与关键读数都在里面。 */
function writeReport(rows, totalMs) {
  const pass = rows.reduce((sum, row) => sum + row.assertions.filter((item) => item.ok).length, 0)
  const total = rows.reduce((sum, row) => sum + row.assertions.length, 0)
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        electron: ELECTRON,
        driver: DRIVER,
        durationMs: totalMs,
        pass,
        fail: total - pass,
        ok: total === pass && rows.length === 3,
        scenes: rows.map((row) => ({
          ...row,
          shot: row.shot.startsWith(root) ? row.shot.slice(root.length + 1).replace(/\\/g, '/') : row.shot,
        })),
      },
      null,
      2,
    ) + String.fromCharCode(10),
    'utf8',
  )
  return REPORT
}

await main()
console.log(String.fromCharCode(10) + (failures.length === 0 ? '全部通过' : failures.length + ' 条失败：' + failures.join('、')))
process.exit(failures.length === 0 ? 0 : 1)
