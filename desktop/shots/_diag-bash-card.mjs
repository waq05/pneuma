/**
 * 诊断：`echo hi-from-numa` 跑完之后，工具卡里到底画了什么（带不带命令原文、带不带 `$`）。
 *
 * 运行：node desktop/shots/_diag-bash-card.mjs
 */
process.on('unhandledRejection', () => {})

import { withApp } from './_pkg-harness.mjs'

const fake = {
  tool: { name: 'bash', args: { command: 'echo hi-from-numa' } },
  script: { content: ['命令跑完了。'] },
}

await withApp({ id: 'bash-card', index: 2, fake }, async (ctx) => {
  await ctx.type('跑一下 echo')
  const done = await ctx.waitText('命令跑完了', 40000)
  const report = await ctx.evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    await wait(400)
    const cards = [...document.querySelectorAll('.tool-card, [class*="tool-card"], .run-card, [class*="run-"]')]
    const first = cards[0] ?? null
    return {
      bodyLength: document.body.innerText.length,
      hasCommandInBody: document.body.innerText.includes('echo hi-from-numa'),
      hasDollar: /\\$\\s*echo hi-from-numa/.test(document.body.innerText),
      cards: cards.length,
      cardClasses: first === null ? null : String(first.className),
      cardText: first === null ? null : first.innerText,
      cardHtml: first === null ? null : first.innerHTML.slice(0, 800),
      tail: document.body.innerText.slice(-500),
    }
  `)
  console.log('回合结束=' + String(done))
  console.log(JSON.stringify(report, null, 2))
  await ctx.shot('diag-bash-card.png')
})
process.exit(0)
