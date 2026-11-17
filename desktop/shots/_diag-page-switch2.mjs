/**
 * 诊断 BUG-0002：侧栏「技能 / 插件」点下去主区不换页。
 *
 * 分三步取证，把三种可能分开：
 *   1. 按钮找得到吗、点得到吗（命中测试：中心点的 elementFromPoint 是不是它自己/后代）
 *   2. 真实鼠标点击（CDP Input.dispatchMouseEvent，走完整命中链）之后主区有没有变
 *   3. 直接 JS `btn.click()` 之后主区有没有变（绕过命中链，只验 React 回调）
 *
 * 运行：node desktop/shots/_diag-page-switch2.mjs
 */
process.on('unhandledRejection', () => {})

import { withApp } from './_pkg-harness.mjs'

for (const label of ['技能', '插件']) {
  await withApp({ id: 'ps2-' + (label === '技能' ? 's' : 'p'), index: label === '技能' ? 31 : 32 }, async (ctx) => {
    const info = await ctx.evaluate(`
      const btns = [...document.querySelectorAll('button')].filter((n) => (n.textContent ?? '').includes(${JSON.stringify(label)}))
      return btns.map((n) => {
        const r = n.getBoundingClientRect()
        const cx = Math.round(r.left + r.width / 2)
        const cy = Math.round(r.top + r.height / 2)
        const top = document.elementFromPoint(cx, cy)
        return {
          text: (n.textContent ?? '').trim().slice(0, 20),
          cls: String(n.className),
          pressed: n.getAttribute('aria-pressed'),
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          hitSelf: top === n || n.contains(top),
          hitTag: top === null ? null : top.tagName + '.' + String(top.className).slice(0, 30),
          center: [cx, cy],
        }
      })
    `)
    console.log('[' + label + '] 候选按钮 ' + info.length + ' 个')
    for (const one of info) console.log('   ' + JSON.stringify(one))
    if (info.length === 0) return

    const target = info[0]
    const sample = async (tag) => {
      const series = await ctx.evaluate(`
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        const read = () => ({
          welcome: document.querySelector('.welcome') !== null,
          len: document.body.innerText.length,
          pressed: (() => {
            const b = [...document.querySelectorAll('button')].filter((n) => (n.textContent ?? '').includes(${JSON.stringify(label)}))[0]
            return b === undefined ? null : b.getAttribute('aria-pressed')
          })(),
        })
        const before = read()
        const out = []
        for (let i = 0; i < 20; i += 1) {
          await wait(50)
          out.push(read())
        }
        return { before, out }
      `)
      const changed = series.out.filter((s) => s.welcome !== series.before.welcome || Math.abs(s.len - series.before.len) > 40)
      console.log('   [' + tag + '] 变化采样 ' + changed.length + '/20  before=' + JSON.stringify(series.before) + '  last=' + JSON.stringify(series.out[series.out.length - 1]))
    }

    // ① 真实鼠标点击（按下 + 抬起，走命中链与事件冒泡）
    await ctx.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.center[0], y: target.center[1], button: 'left', clickCount: 1 })
    await ctx.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.center[0], y: target.center[1], button: 'left', clickCount: 1 })
    await sample('真实鼠标点击后')
    await ctx.shot('diag-ps2-' + (label === '技能' ? 'skills' : 'plugins') + '-mouse.png')

    // ② JS click（绕过命中链）
    const clicked = await ctx.evaluate(`
      const b = [...document.querySelectorAll('button')].filter((n) => (n.textContent ?? '').includes(${JSON.stringify(label)}))[0]
      if (b === undefined) return false
      b.click()
      return true
    `)
    console.log('   JS click 派发成功=' + String(clicked))
    await sample('JS click 后')
    await ctx.shot('diag-ps2-' + (label === '技能' ? 'skills' : 'plugins') + '-js.png')
  })
}
process.exit(0)
