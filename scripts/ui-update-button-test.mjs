/**
 * 品牌行那颗「更新」按钮的形态探针。
 *
 * 它钉的是**壳这一侧的出口**（宿主与桥的规格在 `update-check-test.mjs` 与
 * `ui-native-bridge-test.mjs` 里钉过了）。三件最容易漏、漏了又最难发现的：
 *   1. **只在真有新版时出现**——按钮挂在品牌行上，画错了就是「一直在那儿占着地方」；
 *   2. **两种取数都要**——挂载时问一次（`checkUpdate`）**加上**订阅 `update-status`。
 *      只订阅会错过开机那一次（那时页面还没建好），只问一次则之后的变化永远不来；
 *   3. **点下去真的走 `installUpdate`**，并把下载进度画出来（不然用户点了像没反应）。
 *
 * 最后两段钉产物与样式：产物里找不到就等于没打进去；样式缺 `no-drag` 会被窗口拖拽区
 * 吞掉点击（「点了没反应」的老坑，见 app.tsx 的注释）。
 *
 * 运行：node scripts/ui-update-button-test.mjs
 *
 * @module dsc/scripts/ui-update-button-test
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let passed = 0
let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
  }
}

/** 数一段文本里某个片段出现几次（钉子要「只此一处」时用）。 */
const count = (text, piece) => text.split(piece).length - 1

const button = read('ui-shell/src/ui-layout/update-button.tsx')
const app = read('ui-shell/src/ui-layout/app.tsx')
const settings = read('ui-shell/src/plugins/settings/ui.tsx')
const css = read('ui-shell/src/styles.css')

console.log('[1] 挂在品牌行：Pneuma 右边、收起钮左边')
{
  // 顺序靠 indexOf 比：同一行里的三件（名字 / 更新钮 / 收起钮）谁在前谁在后。
  const brand = app.indexOf('className="brand"')
  const update = app.indexOf('<UpdateButton />')
  const rail = app.indexOf('icon-btn rail-toggle')
  check('品牌行里有 <UpdateButton />', update > 0)
  check('更新钮在名字右边', brand > 0 && update > brand, `brand=${String(brand)} update=${String(update)}`)
  check('更新钮在收起钮左边', rail > 0 && update < rail, `update=${String(update)} rail=${String(rail)}`)
  check('导入了 UpdateButton（同包相对边）', /import \{ UpdateButton \} from '\.\/update-button'/.test(app))
  check('ui-layout 的出口转出它（@dsc/ui-layout 取得到）', read('ui-shell/src/ui-layout/index.ts').includes("export * from './update-button'"))
}

console.log('[2] 只有真有新版才出现')
{
  check('非 available 一律不渲染（正向出口）', /status\.status !== 'available'[\s\S]{0,80}?return null/.test(button))
  check('桥缺席时也不渲染（浏览器页签 / 远程页没有它）', button.includes('!native.available'))
  check('按钮上带版本号（画得出「哪个版本」）', button.includes('data-update-version={version}'))
  check('按钮文案就是「更新」', button.includes("'更新'"))
}

console.log('[3] 两种取数都要：问一次 + 订阅')
{
  check('挂载时问一次当前状态', button.includes("invoke<UpdateStatusView>('checkUpdate')"))
  check('订阅状态变化', button.includes("native.on('update-status'"))
  check('订阅下载进度', button.includes("native.on('update-progress'"))
  check('订阅在卸载时退掉（两条都退）', /return \(\) => \{[\s\S]{0,200}?offStatus\(\)[\s\S]{0,60}?offProgress\(\)/.test(button))
  check('两条订阅各只挂一次', count(button, "native.on('update-status'") === 1 && count(button, "native.on('update-progress'") === 1)
}

console.log('[4] 点下去走 installUpdate，并画进度')
{
  check('点击调 installUpdate', button.includes("invoke<{ ok: boolean; error?: string }>('installUpdate')"))
  check('失败退回可点并把原因挂上（不静默）', button.includes('setInstalling(false)') && button.includes('setFault('))
  check('进度用百分比画（percent 为 null 时给「更新中」）', button.includes('${String(percent)}%') && button.includes("'更新中'"))
}

console.log('[5] 设置页「关于」的 kind:update 分出口')
{
  check('收到 kind:update 记下版本', /data\?\.kind === 'update'[\s\S]{0,40}?setUpdateReady\(data\.version\)/.test(settings))
  check('就地给一颗「立即更新」', settings.includes('立即更新'))
  check('那颗按钮走同一条 installUpdate', settings.includes("invoke<{ ok: boolean; error?: string }>('installUpdate')"))
  check('无桥时如实说明去哪做（不静默）', settings.includes('就地更新要用桌面外壳的原生桥'))
  check('有新版时不再打开发布页（两条出口互斥）', !/kind === 'update'[\s\S]{0,120}?openExternal/.test(settings))
}

console.log('[6] 产物钉：真打进 lib/ui/assets 了')
{
  const dir = join(root, 'lib', 'ui', 'assets')
  const files = readdirSync(dir).filter((name) => name.endsWith('.js'))
  const bundle = files.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')
  check('产物里有 update-btn（按钮真打进去了）', bundle.includes('update-btn'))
  check('产物里有 checkUpdate / installUpdate', bundle.includes('checkUpdate') && bundle.includes('installUpdate'))
  check('产物里订阅了两个更新事件', bundle.includes('update-status') && bundle.includes('update-progress'))
}

console.log('[7] 样式：能点得到、不硬编码颜色')
{
  check('有 .update-btn 规则', /\.update-btn \{/.test(css))
  check('带 no-drag（否则点击被窗口拖拽区吞掉）', /\.update-btn \{[\s\S]{0,200}?-webkit-app-region: no-drag/.test(css))
  // 令牌扫描：本段规则里不该出现裸色值（与 ui-review-notice-test 同一口径）。
  const block = css.slice(css.indexOf('.update-btn {'))
  const segment = block.slice(0, block.indexOf('.update-btn:disabled'))
  check('颜色全走 --dsc-* 令牌（无裸 #rrggbb / rgb()）', !/#[0-9a-fA-F]{3,8}\b/.test(segment) && !/\brgba?\(/.test(segment))
}

console.log('')
console.log(`通过 ${String(passed)}/${String(passed + failures)}`)
process.exit(failures === 0 ? 0 : 1)
