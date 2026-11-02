process.on('unhandledRejection', () => {})

/**
 * 轮尾「复制 / 分叉」的显隐探针（2026-11-02）。
 *
 * 口径：这一轮**停下之后**才有这两颗钮；停下之后它们也默认透明，鼠标压在这一轮的输出上
 * （或键盘焦点进这一轮、或压在页脚这一行上）才现。跑动中一颗都不该有。
 *
 * 做法：真宿主 + 真界面壳（CDP 驱动），假端点吐一句思考 + 两段正文后正常收尾；四个时刻各
 * 读一次计算后的 opacity：
 *   ① 跑动中：DOM 里有没有 .round-act / .user-act（应当没有）
 *   ② 刚收尾、鼠标还停在别处：opacity 应当是 0
 *   ③ 鼠标移到正文上：opacity 应当是 1（并截图）
 *   ④ 鼠标移到用户那条提问上：opacity 应当回到 0（那不算「输出内容」）
 *
 * 运行：node desktop/shots/_verify-round-actions.mjs（依赖桌面产物 desktop/out/）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'D:/dsc'
const shots = join(root, 'desktop/shots')
const home = join(shots, '_verify-round-actions-home')
const dsc = join(home, '.dsc')
const userData = join(home, 'electron-userdata')
const fakePort = 18981
const debugPort = 9342

rmSync(home, { recursive: true, force: true })
mkdirSync(join(dsc, 'sessions'), { recursive: true })
mkdirSync(join(dsc, 'usage'), { recursive: true })
writeFileSync(join(dsc, 'config.yaml'), [
  'default:', '  provider: fake', '  model: fake-act', 'providers:', '  fake:',
  '    displayName: 自检假端点',
  '    baseURL: http://127.0.0.1:' + fakePort + '/v1',
  '    apiKeyEnv: DSC_FAKE_KEY',
  '    models:', '      - id: fake-act', '        name: Fake Act',
  '        contextWindow: 128000', '        maxTokens: 4096', '',
].join('\n'))

const env = {
  ...process.env, DSC_HOME: dsc, USERPROFILE: home, HOME: home,
  DSC_FAKE_KEY: 'sk-selfcheck-fake', DSC_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

const fake = spawn(process.execPath, [join(shots, '_verify-round-actions-fake-llm.mjs'), String(fakePort)], { env, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 800))

const electron = spawn(join(root, 'desktop/node_modules/electron/dist/electron.exe'), [
  join(root, 'desktop/out/main/index.js'), '--remote-debugging-port=' + debugPort,
], { cwd: join(root, 'desktop'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
electron.stdout.on('data', (d) => { log += String(d) })
electron.stderr.on('data', (d) => { log += String(d) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listPages() {
  try {
    const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json()
    return (list ?? []).filter((p) => p.type === 'page')
  } catch { return [] }
}

let seq = 0
const pending = new Map()
let ws = null
const send = (method, params) => {
  seq += 1
  const promise = new Promise((resolve, reject) => {
    pending.set(seq, { resolve, reject })
    ws.send(JSON.stringify({ id: seq, method, params }))
  })
  promise.catch(() => {})
  return promise
}

let page = null
for (let i = 0; i < 80; i += 1) {
  const candidate = (await listPages()).find((p) => String(p.url).startsWith('http'))
  if (candidate) {
    try {
      ws = new WebSocket(candidate.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', reject, { once: true })
      })
      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          const waiter = pending.get(msg.id)
          if (!waiter) return
          pending.delete(msg.id)
          if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
          else waiter.resolve(msg.result)
        } catch {}
      })
      await send('Runtime.enable')
      await send('Page.enable')
      page = candidate
      break
    } catch {
      // ⑥ 第二轮：分叉钮只从第 2 轮起才有（第 1 轮没有分叉对象），单独验一遍它也在同一套显隐里
await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '再来一轮，看分叉那颗。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return { sent: true }
`)
const second = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 200; i += 1) {
    if (document.querySelectorAll('.round-foot .user-act').length > 0) break
    await wait(100)
  }
  await wait(600)
  const acts = [...document.querySelectorAll('.round-foot .round-act, .round-foot .user-act')]
  return {
    feet: document.querySelectorAll('.round-foot').length,
    acts: acts.map((node) => ({ cls: node.className, opacity: getComputedStyle(node).opacity })),
  }
`)
console.log('second-rest', JSON.stringify(second))
await hover('.entry-text')
const secondHover = await evaluate(`
  const acts = [...document.querySelectorAll('.round-foot .round-act, .round-foot .user-act')]
  return acts.map((node) => ({ cls: node.className, opacity: getComputedStyle(node).opacity }))
`)
console.log('second-hover-body', JSON.stringify(secondHover))
await shot('_verify-round-actions-second.png')

try { ws.close() } catch {}
    }
  }
  await sleep(800)
}
if (page === null) throw new Error('connect failed: ' + log.slice(-600))

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression: '(async () => { ' + expression + ' })()',
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
  return result.result?.value
}
const shot = async (name) => {
  const data = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(shots, name), Buffer.from(data.data, 'base64'))
}
/** 把鼠标移到某个元素正中（CDP 的坐标就是 CSS 像素）。 */
const hover = async (selector, index = -1) => {
  const box = await evaluate(`
    const nodes = document.querySelectorAll(${JSON.stringify(selector)})
    const node = nodes[${index < 0 ? 'nodes.length - 1' : String(index)}]
    if (node === undefined) return null
    const rect = node.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  `)
  if (box === null) return null
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0 })
  await sleep(400)
  return box
}
/** 读一次页脚两颗钮的存在与计算后 opacity。 */
const readFoot = () => evaluate(`
  const foot = document.querySelectorAll('.round-foot')
  const last = foot[foot.length - 1] ?? null
  const acts = last === null ? [] : [...last.querySelectorAll('.round-act, .user-act')]
  return {
    feet: foot.length,
    acts: acts.length,
    classes: acts.map((node) => node.className),
    opacities: acts.map((node) => getComputedStyle(node).opacity),
    text: last === null ? null : last.textContent,
  }
`)

const start = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 40; i += 1) {
    if (document.querySelector('.composer textarea') !== null) break
    await wait(500)
  }
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '随便答两句，我要看轮尾的两颗钮。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return { sent: true }
`)
console.log('start', JSON.stringify(start))

// ① 跑动中：正文已经开始流，但还没收尾
const running = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 100; i += 1) {
    if (document.querySelector('.entry-text.live') !== null) break
    await wait(100)
  }
  await wait(200)
  return {
    liveText: document.querySelectorAll('.entry-text.live').length,
    actsInDom: document.querySelectorAll('.round-foot .round-act, .round-foot .user-act').length,
    feetInDom: document.querySelectorAll('.round-foot').length,
    footText: document.querySelector('.round-foot')?.textContent ?? null,
  }
`)
console.log('running', JSON.stringify(running))

// ② 收尾后鼠标仍停在别处（此时鼠标默认在 (0,0) 附近，不在任何一轮上）
const rest = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 150; i += 1) {
    if (document.querySelectorAll('.round-foot .round-act').length > 0) break
    await wait(100)
  }
  await wait(600)
  return { ok: document.querySelectorAll('.round-foot .round-act').length > 0 }
`)
console.log('rest-ready', JSON.stringify(rest))
console.log('rest', JSON.stringify(await readFoot()))
await shot('_verify-round-actions-rest.png')

// ③ 鼠标压到正文上
const bodyBox = await hover('.entry-text')
console.log('hover-body', JSON.stringify(bodyBox))
console.log('body', JSON.stringify(await readFoot()))
await shot('_verify-round-actions-hover-body.png')

// ④ 鼠标压到用户那条提问上（第一块，不算输出）
const userBox = await hover('.entry-user')
console.log('hover-user', JSON.stringify(userBox))
console.log('user', JSON.stringify(await readFoot()))

// ⑤ 鼠标压到页脚这一行上（自己就在按钮边上，得能现）
const footBox = await hover('.round-foot .round-clock')
console.log('hover-foot', JSON.stringify(footBox))
console.log('foot', JSON.stringify(await readFoot()))

// ⑥ 第二轮：分叉钮只从第 2 轮起才有（第 1 轮没有分叉对象），单独验一遍它也在同一套显隐里
await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const input = document.querySelector('.composer textarea')
  if (input === null) return { error: 'no textarea' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '再来一轮，看分叉那颗。')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wait(120)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return { sent: true }
`)
const second = await evaluate(`
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 200; i += 1) {
    if (document.querySelectorAll('.round-foot .user-act').length > 0) break
    await wait(100)
  }
  await wait(600)
  const acts = [...document.querySelectorAll('.round-foot .round-act, .round-foot .user-act')]
  return {
    feet: document.querySelectorAll('.round-foot').length,
    acts: acts.map((node) => ({ cls: node.className, opacity: getComputedStyle(node).opacity })),
  }
`)
console.log('second-rest', JSON.stringify(second))
await hover('.entry-text')
const secondHover = await evaluate(`
  const acts = [...document.querySelectorAll('.round-foot .round-act, .round-foot .user-act')]
  return acts.map((node) => ({ cls: node.className, opacity: getComputedStyle(node).opacity }))
`)
console.log('second-hover-body', JSON.stringify(secondHover))
await shot('_verify-round-actions-second.png')

try { ws.close() } catch {}
try { electron.kill() } catch {}
try { fake.kill() } catch {}
await sleep(600)
