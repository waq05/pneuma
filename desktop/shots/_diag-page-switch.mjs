/**
 * 诊断：点「技能」之后，主区是**从来没换过**，还是**换了又被踢回对话页**。
 *
 * 做法：点下去之后每 50ms 采一次，连采 1.5 秒，记录
 *   - 按钮的 aria-pressed / class 里有没有 on
 *   - `.welcome` 还在不在
 *   - 正文长度
 * 换过又回来 = 守卫踢回；从头到尾没变 = 点击没生效或页面画不出来。
 *
 * 运行：node desktop/shots/_diag-page-switch.mjs
 */
process.on('unhandledRejection', () => {})

import { withApp } from './_pkg-harness.mjs'

for (const label of ['技能', '插件']) {
  await withApp({ id: 'page-switch-' + (label === '技能' ? 'skills' : 'plugins'), index: label === '技能' ? 21 : 22 }, async (ctx) => {
    const series = await ctx.evaluate(`
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const label = ${JSON.stringify(label)}
      const btn = [...document.querySelectorAll('button, a, [role="button"]')]
        .find((n) => (n.textContent ?? '').trim() === label)
      const read = () => ({
        welcome: document.querySelector('.welcome') !== null,
        len: document.body.innerText.length,
        pressed: btn === undefined ? null : btn.getAttribute('aria-pressed'),
        cls: btn === undefined ? null : String(btn.className),
      })
      const before = read()
      if (btn !== undefined) btn.click()
      const samples = []
      for (let i = 0; i < 30; i += 1) {
        await wait(50)
        samples.push(read())
      }
      return { before, samples }
    `)
    const changed = series.samples.filter((s) => s.welcome !== series.before.welcome || Math.abs(s.len - series.before.len) > 40)
    console.log('[' + label + '] 点击前: ' + JSON.stringify(series.before))
    console.log('  ' + label + ' 出现变化的采样数: ' + changed.length + ' / 30')
    if (changed.length > 0) {
      console.log('  首次变化: ' + JSON.stringify(changed[0]))
      console.log('  最后一次: ' + JSON.stringify(series.samples[series.samples.length - 1]))
    } else {
      console.log('  尾部样本: ' + JSON.stringify(series.samples.slice(-2)))
    }
  })
}
process.exit(0)
