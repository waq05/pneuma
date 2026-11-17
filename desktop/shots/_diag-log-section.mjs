/**
 * 验收 BUG-0003 的第二半：不只是「左栏有运行日志」，进去还得**画得出字段**。
 *
 * 看三样：
 *   1. 点开「运行日志」之后，主区出现了哪些字段标签
 *   2. 有没有报错/空白（比如字段类型设置页不认识 → 渲染成空）
 *   3. 「立即清理」这类 action 字段的按钮在不在
 *
 * 运行：node desktop/shots/_diag-log-section.mjs
 */
process.on('unhandledRejection', () => {})

import { withApp } from './_pkg-harness.mjs'

await withApp({ id: 'log-section', index: 190 }, async (ctx) => {
  const report = await ctx.evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const byText = (label) => [...document.querySelectorAll('button')].filter((n) => (n.textContent ?? '').trim() === label)[0]
    const settings = byText('设置')
    if (settings === undefined) return { error: '找不到设置钮' }
    settings.click()
    // 等分区出来
    for (let i = 0; i < 100; i += 1) {
      if (byText('运行日志') !== undefined) break
      await wait(150)
    }
    const navItem = byText('运行日志')
    if (navItem === undefined) return { error: '左栏没有运行日志' }
    navItem.click()
    await wait(1200)
    const panel = document.querySelector('.settings') ?? document.body
    // 设置页的字段标签用 .setting-label（不是 label 元素）：选错了会得出「一个字段都没画」的反结论。
    const labels = [...panel.querySelectorAll('.setting-label, .setting-field-label, label')]
      .map((n) => (n.textContent ?? '').trim())
      .filter((t) => t !== '')
    const buttons = [...panel.querySelectorAll('button')]
      .map((n) => (n.textContent ?? '').trim())
      .filter((t) => t !== '')
    return {
      labels: labels.slice(0, 24),
      buttons: buttons.slice(0, 24),
      hasLevel: labels.some((t) => t.includes('记录级别')),
      hasKeepDays: labels.some((t) => t.includes('保留')),
      hasCleanup: buttons.some((t) => t.includes('清理')),
      bodyHasLogDir: panel.innerText.includes('logs'),
      text: panel.innerText.slice(0, 700),
    }
  `)
  console.log(JSON.stringify(report, null, 2))
  await ctx.shot('diag-log-section.png')
})
process.exit(0)
