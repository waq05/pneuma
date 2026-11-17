/**
 * 诊断 BUG-0003 第二版：设置弹窗是不是根本没加载出分区（骨架屏一直挂着）。
 *
 * 采集：
 *   1. 从点开到出分区/字段的耗时（最多等 10 秒）
 *   2. 分区导航项的真实文本
 *   3. 期间 console 的 error / warn（含 invoke 失败的报错）
 *
 * 运行：node desktop/shots/_diag-settings-sections2.mjs
 */
process.on('unhandledRejection', () => {})

import { withApp } from './_pkg-harness.mjs'

await withApp({ id: 'settings-sections2', index: 99 }, async (ctx) => {
  const report = await ctx.evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const logs = []
    for (const level of ['error', 'warn']) {
      const original = console[level].bind(console)
      console[level] = (...args) => {
        try { logs.push(level + ': ' + args.map((a) => String(a && a.message ? a.message : a)).join(' ').slice(0, 240)) } catch {}
        original(...args)
      }
    }
    window.addEventListener('unhandledrejection', (event) => logs.push('unhandled: ' + String(event.reason).slice(0, 240)))

    const started = performance.now()
    const btn = [...document.querySelectorAll('button')].filter((n) => (n.textContent ?? '').trim() === '设置')[0]
    btn.click()
    let navAt = null
    for (let i = 0; i < 100; i += 1) {
      const items = [...document.querySelectorAll('.settings .nav-item, .settings nav button, .settings-nav button')]
      if (items.length > 0) { navAt = Math.round(performance.now() - started); break }
      await wait(100)
    }
    await wait(400)
    const settings = document.querySelector('.settings')
    const allButtons = settings === null ? [] : [...settings.querySelectorAll('button')].map((n) => (n.textContent ?? '').trim().slice(0, 20))
    return {
      navAt,
      elapsed: Math.round(performance.now() - started),
      settingsFound: settings !== null,
      settingsClasses: settings === null ? null : String(settings.className),
      buttons: allButtons.slice(0, 40),
      skeletons: settings === null ? 0 : settings.querySelectorAll('[class*="skeleton"], [class*="loading"]').length,
      htmlSnippet: settings === null ? null : settings.innerHTML.slice(0, 600),
      logs: logs.slice(0, 10),
    }
  `)
  console.log(JSON.stringify(report, null, 2))
  await ctx.shot('diag-settings-sections2.png')
})
process.exit(0)
