/**
 * 打包产物的页面冒烟：侧栏三个入口（设置 / 插件 / 技能）逐个开，一次一个新进程。
 *
 * 为什么一次一个进程：设置是**弹窗**，它开着的时候侧栏点击被遮罩挡住，接着点「插件」「技能」
 * 其实点的是遮罩底下的旧页面——第一版探针就这么假绿了两次（两张截图一模一样）。这里改成
 * 每页单独起一次应用，点完就截图、杀进程，互不干扰。
 *
 * 判据（只看「有没有画出来」）：
 *   1. 点开后主区文字 > 150 字；
 *   2. 文字里有该页自己的特征词；
 *   3. 没有「加载失败 / 页面出错」；
 *   4. 截图落盘，人工再看一眼。
 *
 * 运行：node desktop/shots/_verify-pages-packaged.mjs
 * 产物：desktop/shots/out/page-{settings,plugins,skills}.png
 */
process.on('unhandledRejection', () => {})

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const outDir = join(shots, 'out')
const DEBUG_PORT = 9384

const PAGES = [
  { label: '设置', file: 'page-settings.png', words: ['通用', '模型', '外观'] },
  { label: '插件', file: 'page-plugins.png', words: ['插件'] },
  { label: '技能', file: 'page-skills.png', words: ['技能'] },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(outDir, { recursive: true })

let failed = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (ok ? '' : '  <- ' + String(detail)))
  if (!ok) failed += 1
}

const connect = async () => {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + String(DEBUG_PORT) + '/json/list')).json()
      const page = (list ?? []).find((p) => p.type === 'page' && String(p.url).startsWith('http'))
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(600)
  }
  return null
}

// 一页一次：隔离 HOME → 起打包产物 → 点一下 → 截图 → 收进程
const runPage = async (page) => {
  const home = join(shots, '_verify-pages-home-' + page.file.replace(/\W/g, ''))
  const dsc = join(home, '.dsc')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(join(dsc, 'sessions'), { recursive: true })
  mkdirSync(join(dsc, 'usage'), { recursive: true })
  writeFileSync(join(dsc, 'config.yaml'), [
    'default:', '  provider: fake', '  model: fake-code', 'providers:', '  fake:',
    '    displayName: 自检假端点', '    baseURL: http://127.0.0.1:18999/v1',
    '    apiKeyEnv: DSC_FAKE_KEY', '    models:', '      - id: fake-code', '        name: Fake Code',
    '        contextWindow: 128000', '        maxTokens: 4096', '',
  ].join('\n'))

  const env = { ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home, DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: join(home, 'electron-userdata') }
  delete env.ELECTRON_RUN_AS_NODE

  const app = spawn(join(root, 'desktop/dist/win-unpacked/Pneuma.exe'), ['--remote-debugging-port=' + String(DEBUG_PORT)], {
    cwd: join(root, 'desktop/dist/win-unpacked'), env, stdio: 'ignore',
  })

  const wsUrl = await connect()
  if (wsUrl === null) {
    try { app.kill() } catch {}
    check('起应用（' + page.label + '）', false, '连不上 CDP')
    return
  }

  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(String(event.data))
      const waiter = pending.get(msg.id)
      if (waiter === undefined) return
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
    } catch {}
  })
  const send = (method, params) => {
    seq += 1
    const promise = new Promise((resolve, reject) => {
      pending.set(seq, { resolve, reject })
      ws.send(JSON.stringify({ id: seq, method, params }))
    })
    promise.catch(() => {})
    return promise
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1423, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression: '(async () => { ' + expression + ' })()', awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
    return result.result?.value
  }

  const result = await evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    for (let i = 0; i < 160; i += 1) { if (document.querySelector('.welcome') !== null) break; await wait(250) }
    await wait(600)
    const label = ${JSON.stringify(page.label)}
    const hit = [...document.querySelectorAll('button, a, [role="button"], li')]
      .find((n) => (n.textContent ?? '').trim() === label)
    if (hit === undefined) return { clicked: false, why: '侧栏没有「' + label + '」', tags: [...document.querySelectorAll('button, a, [role="button"], li')].map((n) => n.tagName + ':' + (n.textContent ?? '').trim().slice(0, 12)).slice(0, 40) }
    hit.click()
    // 等到主区不再是首屏（.welcome 消失），或最多 6 秒
    for (let i = 0; i < 60; i += 1) {
      await wait(200)
      if (document.querySelector('.welcome') === null && document.body.innerText.length > 150) break
    }
    await wait(800)
    return { clicked: true, text: document.body.innerText.slice(0, 2000), length: document.body.innerText.length, welcomeGone: document.querySelector('.welcome') === null }
  `)

  if (result.clicked !== true) {
    check('点开「' + page.label + '」', false, JSON.stringify(result).slice(0, 300))
    try { app.kill() } catch {}
    return
  }
  const text = String(result.text ?? '')
  const hasWord = page.words.some((w) => text.includes(w))
  const bad = /加载失败|页面出错|Something went wrong/.test(text)
  check('点开「' + page.label + '」', true)
  check('「' + page.label + '」画出了内容（' + String(result.length) + ' 字）', result.length > 150, String(result.length))
  check('「' + page.label + '」含自己的特征词', hasWord, text.slice(0, 160))
  check('「' + page.label + '」没有加载失败', !bad, text.match(/加载失败[^\n]*/)?.[0])

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, page.file), Buffer.from(shot.data, 'base64'))
  console.log('  截图: ' + join(outDir, page.file) + ' | 首行: ' + text.split('\n')[0].slice(0, 40))

  try { app.kill() } catch {}
  await sleep(1200)
}

for (const page of PAGES) {
  await runPage(page)
}

console.log('')
console.log(failed === 0 ? '打包产物页面冒烟：全部通过' : '打包产物页面冒烟：' + String(failed) + ' 条失败')
process.exit(failed === 0 ? 0 : 1)
