/**
 * 临时工具（gitignored）：对真源码做定点变异，看 `ui-mobile-shell-test.mjs` 是否恰好报红。
 * 每条变异：改 → 跑 → 数失败条数 → 还原。（仓里是 CRLF，匹配串一律用 \r\n。）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const root = 'D:/dsc/'
const run = () => {
  try {
    const out = execFileSync('node', ['scripts/ui-mobile-shell-test.mjs'], { cwd: root, encoding: 'utf8' })
    return { failed: 0, out }
  } catch (error) {
    const out = String(error.stdout ?? '')
    return { failed: (out.match(/^FAIL/gm) ?? []).length, out }
  }
}

const NL = '\r\n'
let count = 0
const mutate = (file, from, to) => {
  count += 1
  const path = root + file
  const original = readFileSync(path, 'utf8')
  if (!original.includes(from)) throw new Error(`变异没命中：${file} <- ${JSON.stringify(from.slice(0, 60))}`)
  writeFileSync(path, original.replace(from, to))
  const { failed, out } = run()
  writeFileSync(path, original)
  const lines = out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/^FAIL\s+/, '').split('  <- ')[0])
  console.log(`${failed === 0 ? '没红 ✗' : '红了 ✓'}  ${file}  ->  ${String(failed)} 条  ${JSON.stringify(from.split(NL)[0].trim().slice(0, 46))}`)
  for (const line of lines.slice(0, 4)) console.log(`        · ${line}`)
}

const j = (...lines) => lines.join(NL)
const results = []

// 1. 藏掉那条（`.ws-open`）挪到 860 块外 →「只藏在手机档」的检查器要抓到
{
  const path = root + 'ui-shell/src/styles.css'
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, `${original.replace(j('  .ws-open {', '    display: none;', '  }', ''), '')}${NL}.ws-open {${NL}  display: none;${NL}}${NL}`)
  const { failed, out } = run()
  writeFileSync(path, original)
  count += 1
  const lines = out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/^FAIL\s+/, '').split('  <- ')[0])
  console.log(`${failed === 0 ? '没红 ✗' : '红了 ✓'}  styles.css  ->  ${String(failed)} 条  ".ws-open 挪到 860 块外"`)
  for (const line of lines.slice(0, 4)) console.log(`        · ${line}`)
  results.push(failed)
}

// 2. 遮罩 z-index 39 → 41（会盖住抽屉）
results.push(mutate('ui-shell/src/styles.css', `    z-index: 39;${NL}`, `    z-index: 41;${NL}`))
// 3. min-height 拿掉（桌面输入框回到 30px）
results.push(mutate('ui-shell/src/legacy/views.css', `  min-height: var(--dsc-input-box-h, 40px);${NL}`, ''))
// 4. 右组不再整行（手机底栏退回撞运气换行）
results.push(
  mutate('ui-shell/src/styles.css', j('  .composer-bar .bar-right {', '    flex: 1 1 100%;', '    margin-left: 0;', '  }', ''), ''),
)
// 5. 发送键不再贴右缘
results.push(mutate('ui-shell/src/styles.css', j('  .composer-bar .send-btn {', '    margin-left: auto;', '  }', ''), ''))
// 6. 窄栏在手机上也画（收起态又冒出那条 56px 竖栏）
results.push(mutate('ui-shell/src/ui-layout/app.tsx', '{sidebarCollapsed && !narrow ? <SidebarRail', '{sidebarCollapsed ? <SidebarRail'))
// 7. 顶栏两颗钮漏到桌面档（去掉 narrow 条件）
results.push(mutate('ui-shell/src/ui-layout/app.tsx', j('{narrow ? (', '                    <button', '                      type="button"'), j('{true ? (', '                    <button', '                      type="button"')))
// 8. 点容器聚焦的守卫漏掉 button
results.push(
  mutate(
    'ui-shell/src/plugins/composer/ui.tsx',
    "target.closest('button, textarea, input, .model-pop, .pop-mask')",
    "target.closest('textarea, input, .model-pop, .pop-mask')",
  ),
)
// 9. 手机档也给轨迹页签（把手机那一支换成桌面那套）
results.push(mutate('ui-shell/src/ui-layout/app.tsx', j('{narrow ? (', "                  threadView === 'trace' ? ("), j('{true ? (', "                  threadView === 'trace' ? (")))
// 10. 遮罩条件漏掉 narrow（桌面档也渲染遮罩）
results.push(mutate('ui-shell/src/ui-layout/app.tsx', '{narrow && !sidebarCollapsed ? (', '{!sidebarCollapsed ? ('))
// 11. 输入框高度令牌写死成 40px（不走令牌）
results.push(mutate('ui-shell/src/legacy/views.css', 'min-height: var(--dsc-input-box-h, 40px)', 'min-height: 40px'))
// 12. 手机档不再覆写 44px
results.push(mutate('ui-shell/src/styles.css', `    --dsc-input-box-h: 44px;${NL}`, ''))
// 13. 页头带的「返回对话」钮拿掉（进整页又回不来）
results.push(mutate('ui-shell/src/ui-layout/app.tsx', j('                  <button', '                    type="button"', '                    className="icon-btn topbar-nav-btn"', '                    data-tip="返回对话"', '                    aria-label="返回对话"'), j('                  <button', '                    type="button"', '                    className="icon-btn topbar-nav-btn"', '                    data-tip="返回对话"', '                    aria-label="对话"')))
// 14. 模式那颗不再挂 sheet（浮层又锚回 chip、又探出屏幕）
results.push(
  mutate(
    'ui-shell/src/plugins/composer/ui.tsx',
    j('            <div className="model-anchor model-anchor-sheet">', '              <button', '                type="button"', '                className={`model-btn${presetOpen'),
    j('            <div className="model-anchor">', '              <button', '                type="button"', '                className={`model-btn${presetOpen'),
  ),
)
// 15. sheet 那条 CSS 挪出 560 档（桌面也被改）
results.push(
  mutate(
    'ui-shell/src/styles.css',
    j('  .composer-bar .model-anchor-sheet > .model-pop {', '    left: 8px;', '    right: 8px;', '    width: auto;', '  }', ''),
    '',
  ),
)
// 16. 锚点不交回卡片（position 不改，面板仍按 chip 定位）
results.push(
  mutate(
    'ui-shell/src/styles.css',
    j('  .composer-bar .model-anchor-sheet {', '    position: static;', '  }'),
    j('  .composer-bar .model-anchor-sheet {', '    position: relative;', '  }'),
  ),
)

console.log('')
console.log(`变异 ${String(count)} 条，其中「没红」的：${results.filter((n) => n === 0).length}`)
