/**
 * 「dsh 插件的 diff 卡」真机走查：起真宿主 + 假模型端点 + 真 Chromium，
 * 让一个 dsh 风格工具在真对话里跑一次，然后核对它的工具卡上真的画出了 diff。
 *
 * 为什么要这一条：卡片这条链路过三跳（插件 presentResult → 宿主按 callId 缝回工具卡 →
 * 事件流 → 界面适配器挑渲染形态）。只测纯函数时，第三跳断了也看不出来——2026-10-26
 * 就断过一次：数据到了卡上，展开体只认 `call.change`，于是「有卡片、画不出来」。
 *
 * 三段：
 *   [1] 环境：隔离 HOME、示例插件、plugins.json（开兼容层）、假端点配置
 *   [2] 真跑：宿主提交一句话 → 假端点回工具调用 → 工具真的写文件 → 模型收尾
 *   [3] 读数 + 截图：卡展开后 .diff-body 在、加了行、结果里有投影文字
 *
 * 跑法：cd D:\dsc && pnpm run build && node scripts/ui-dsh-card-e2e.mjs
 * 依赖：`lib/`（先 build）、`desktop/node_modules/electron`、示例插件 examples/plugins/dsh-style-clock.js
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(root, 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')
const DRIVER = join(root, 'scripts', '_ui-dsh-card-main.cjs')
const FAKE = join(root, 'scripts', '_fake-llm.mjs')
const EXAMPLE = join(root, 'examples', 'plugins', 'dsh-style-clock.js')
const SHOT = join(root, 'desktop', 'shots', 'dsh-diff-card.png')
const RESULT = join(root, 'desktop', 'shots', 'dsh-diff-card.json')

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) { console.log('  PASS ' + name); return }
  failures.push(name)
  console.log('  FAIL ' + name + (detail === '' ? '' : ' — ' + detail))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function main() {
  console.log('[dsh-card] 真机走查：dsh 插件的 diff 卡')
  check('Electron 在', existsSync(ELECTRON), ELECTRON)
  check('界面壳产物在', existsSync(join(root, 'lib', 'ui', 'assets', 'index.html')))
  check('示例插件在', existsSync(EXAMPLE), EXAMPLE)

  const home = mkdtempSync(join(tmpdir(), 'dsc-dsh-card-'))
  const dsc = join(home, '.dsc')
  const plugins = join(dsc, 'plugins')
  mkdirSync(plugins, { recursive: true })
  copyFileSync(EXAMPLE, join(plugins, 'dsh-style-clock.js'))
  const noteFile = join(dsc, 'dsh-note.txt')

  const port = await freePort()
  const llmPort = await freePort()
  writeFileSync(
    join(dsc, 'config.yaml'),
    [
      '# 自检专用：一个指向本机假端点的 provider（不联网、不花钱）',
      'default:',
      '  provider: fake',
      '  model: fake-chat',
      'providers:',
      '  fake:',
      '    displayName: 自检假端点',
      '    baseURL: http://127.0.0.1:' + String(llmPort) + '/v1',
      '    apiKeyEnv: DSC_FAKE_KEY',
      '    models:',
      '      - id: fake-chat',
      '        name: Fake Chat',
      '        contextWindow: 128000',
      '        maxTokens: 4096',
      '',
    ].join('\n'),
    'utf8',
  )

  // plugins.json 用宿主自己的写盘口生成：条目树有两个字段（disabled / config），
  // 手抄 JSON 容易漏掉 config 那一层的合并语义。
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  process.env['DSC_HOME'] = dsc
  const registry = await import(new URL('../lib/core/plugin-registry.js', import.meta.url).href)
  registry.writePluginEnabled('dsh-compat', true)
  registry.writePluginEnabled('dsh-style-clock.js', true)
  // 这条探针只验卡片，不验审批：工具本身是写文件的，缺省按 exec 处理会停在审批卡上。
  // 把 dsh_write_note 单条放宽到 read，别的工具不受影响（risks 是按工具名覆盖的）。
  registry.writePluginConfig('dsh-style-clock.js', { risks: { dsh_write_note: 'read' } })

  const toolCall = {
    name: 'dsh_write_note',
    arguments: { path: noteFile, text: '第一行：这条备注由 dsh 风格插件写入\n第二行：它带着一张 diff 卡片' },
  }

  const llm = spawn(process.execPath, [FAKE], {
    cwd: root,
    env: {
      ...process.env,
      DSC_FAKE_LLM_PORT: String(llmPort),
      DSC_FAKE_LLM_DELAY: '0',
      DSC_FAKE_LLM_TOOL: JSON.stringify(toolCall),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const llmLog = []
  llm.stdout.setEncoding('utf8')
  llm.stdout.on('data', (chunk) => llmLog.push(String(chunk).trim()))
  llm.stderr.setEncoding('utf8')
  llm.stderr.on('data', (chunk) => llmLog.push(String(chunk).trim()))
  await sleep(600)

  if (existsSync(RESULT)) rmSync(RESULT, { force: true })
  const host = spawn(process.execPath, [join(root, 'bin', 'headless.cjs')], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DSC_HOME: dsc,
      DSC_FAKE_KEY: 'sk-selfcheck-fake',
      DSC_UI_SERVER: '1',
      DSC_UI_PORT: String(port),
      DSC_UI_HMR: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const hostErr = []
  host.stderr.setEncoding('utf8')
  host.stderr.on('data', (chunk) => {
    hostErr.push(...String(chunk).split(String.fromCharCode(10)).filter((line) => line.trim() !== ''))
    if (hostErr.length > 60) hostErr.splice(0, hostErr.length - 60)
  })
  let url = null
  host.stdout.setEncoding('utf8')
  host.stdout.on('data', (chunk) => {
    const found = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(String(chunk))
    if (found !== null) url = found[0]
  })
  for (let waited = 0; waited < 90000 && url === null; waited += 250) await sleep(250)
  check('宿主起来了并给出界面地址', url !== null, hostErr.slice(-5).join(' | '))
  if (url === null) {
    host.kill()
    llm.kill()
    return
  }

  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  env['DSC_CARD_RESULT'] = RESULT
  env['DSC_CARD_SHOT'] = SHOT
  env['DSC_CARD_USER_DATA'] = join(home, 'electron-user-data')
  env['DSC_CARD_QUESTION'] = '把这条备注写进文件，我要看它改了哪几行。'
  env['DSC_CARD_EXPECT'] = '已写入'
  const electron = spawn(ELECTRON, [DRIVER, url], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })

  for (let waited = 0; waited < 240000; waited += 500) {
    if (existsSync(RESULT)) break
    await sleep(500)
  }
  check('驱动写出读数文件', existsSync(RESULT), RESULT)
  if (existsSync(RESULT)) {
    const result = JSON.parse(readFileSync(RESULT, 'utf8'))
    if (result.error !== undefined) {
      check('驱动没有报错', false, String(result.error).split(String.fromCharCode(10))[0])
    } else {
      const probe = result.probe ?? {}
      check('对话里出现了工具卡', Number(probe.cards ?? 0) >= 1, JSON.stringify(probe.cards))
      check('工具卡能展开', probe.opened === true, JSON.stringify(probe.opened))
      check('展开体里画出了 diff（.diff-body）', probe.hasDiffBody === true, JSON.stringify(probe.hasDiffBody))
      check('diff 有新增行', Number(probe.diffAdded ?? 0) >= 2, String(probe.diffAdded))
      check('结果里有插件的投影文字', String(probe.resultText ?? '').includes('已写入'), String(probe.resultText))
      check('截图在', existsSync(SHOT), SHOT)
      check('文件真的被写了（卡片不是假的）', existsSync(noteFile) && readFileSync(noteFile, 'utf8').includes('第二行'), noteFile)
    }
  }

  electron.kill()
  host.kill()
  llm.kill()
  if (failures.length > 0) {
    console.log('── 宿主 stderr（最后 12 行）──')
    console.log(hostErr.slice(-12).join(String.fromCharCode(10)))
    console.log('── 假端点日志（最后 4 行）──')
    console.log(llmLog.slice(-4).join(String.fromCharCode(10)))
  }
}

await main()
console.log(String.fromCharCode(10) + (failures.length === 0 ? '全部通过' : failures.length + ' 条失败：' + failures.join('、')))
process.exit(failures.length === 0 ? 0 : 1)
