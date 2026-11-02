/**
 * 待发贴图「点一下看大图」的确定性探针（纯 Node，读源码做文本钉）。
 *
 * 为什么要有这一条：这个功能全靠一条**浏览器限制**支撑——待发贴图是 dataURL，
 * 顶层导航到 `data:` 会被拦，所以只能自己开浮层。这条限制不会在类型里表达出来，
 * 一旦有人「顺手」把缩略图改成 `<a href={item.previewUrl} target="_blank">`，
 * 编译照样过、页面照样不报错，只是点了没反应。这里把那条负向钉住。
 *
 * 五段：
 *   [1] `ui-primitives/image-lightbox.tsx`：门户、根 class、Esc、焦点归还；
 *   [2] 基元库真的把它转出（漏一行的表现是插件拿到的 `ImageLightbox` 是 undefined）；
 *   [3] 输入区：图片分支是按钮、点开写 `zoom`、关掉清空；**负向**：不再有 `<a href={item.previewUrl}>`；
 *   [4] 样式：`.attach-zoom` 的放大镜光标与「图片不接事件」；
 *   [5] **负向**：视频那条分支没被顺手包进按钮。
 *
 * 跑法：node scripts/ui-attach-preview-test.mjs
 *
 * @module dsc/scripts/ui-attach-preview-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

// ── [1] 浮层组件 ──────────────────────────────────────────────────────────────

console.log('[1] image-lightbox 组件')
{
  const rel = 'ui-shell/src/ui-primitives/image-lightbox.tsx'
  check('文件存在', existsSync(join(root, rel)))
  const src = existsSync(join(root, rel)) ? read(rel) : ''
  check('导出 ImageLightbox', /export function ImageLightbox\(/.test(src))
  check('入参是 src / alt / onClose', /src: string; alt: string; onClose\(\): void/.test(src))
  check('用 createPortal', /createPortal\(/.test(src) && src.includes("from 'react-dom'"))
  check('挂到 document.body', /document\.body/.test(src))
  check('根节点 class 是 .img-lightbox', /className="img-lightbox"/.test(src))
  check('无障碍属性齐', src.includes('role="dialog"') && src.includes('aria-modal="true"') && src.includes('aria-label="放大查看贴图"'))
  check('点根节点就关', /onClick=\{onClose\}/.test(src))
  check('Esc 关', src.includes("event.key === 'Escape'") && src.includes("window.addEventListener('keydown'"))
  check('卸载时摘掉监听', src.includes("window.removeEventListener('keydown'"))
  check('打开时记下焦点', /opener\.current = document\.activeElement/.test(src))
  check('关闭时还回去', /node\.focus\(\)/.test(src))
  check('只在原节点还在文档里时还', src.includes('.isConnected'))
  check('图片带 alt（读屏拿得到名字）', /<img src=\{props\.src\} alt=\{props\.alt\} \/>/.test(src))
  check('模块注释说清为什么要有它（dataURL / data:）', src.includes('dataURL') && src.includes("`data:`"))
}

// ── [2] 基元库转出 ────────────────────────────────────────────────────────────

console.log('[2] 基元库转出')
{
  const barrel = read('ui-shell/src/ui-primitives/index.ts')
  check("index.ts 有 export * from './image-lightbox'", /export \* from '\.\/image-lightbox'/.test(barrel))
}

// ── [3] 输入区的接法 ──────────────────────────────────────────────────────────

console.log('[3] 输入区接法')
{
  const src = read('ui-shell/src/plugins/composer/ui.tsx')
  check('从 @dsc/ui-primitives 取 ImageLightbox', /import \{[^}]*ImageLightbox[^}]*\} from '@dsc\/ui-primitives'/.test(src))
  check('图片缩略图是 <button className="attach-zoom"', /<button\s+type="button"\s+className="attach-zoom"/.test(src))
  check('按钮带 aria-label 与提示', /aria-label=\{`预览 \$\{item\.name\}`\}/.test(src) && src.includes('data-tip="点开看大图"'))
  check('点开写进 zoom 状态', src.includes('setZoom({ src: item.previewUrl, alt: item.name })'))
  check('zoom 状态声明', /const \[zoom, setZoom\] = useState<\{ src: string; alt: string \} \| null>\(null\)/.test(src))
  check('关掉清空 zoom', src.includes('setZoom(null)'))
  check('渲染 ImageLightbox', /<ImageLightbox/.test(src))
  check('ImageLightbox 的 onClose 清空 zoom', /onClose=\{\(\) => \{\s*setZoom\(null\)/.test(src))
  // 负向：dataURL 套 <a target="_blank"> 是无效路径，不许回来。
  check('不再用 <a href={item.previewUrl} 打开', !/href=\{item\.previewUrl\}/.test(src) && !/<a[^>]*previewUrl/.test(src))
  check('缩略图里不再有裸 <img>（图片只能走按钮）', !/<div className="attach-thumb">\s*<img/.test(src))
  check('移除钮仍在（.attach-remove）', src.includes('className="attach-remove"'))
  // 移除钮要是 `.attach-thumb` 的兄弟，不是它的孩子：`.attach-thumb` 到移除钮之间
  // 开合数量对得上，说明缩略图那格已经关掉了，点卷角不会冒泡到预览按钮。
  const removeAt = src.indexOf('className="attach-remove"')
  const between = src.slice(src.indexOf('<div className="attach-thumb">'), removeAt)
  check(
    '移除钮是 .attach-thumb 的兄弟（不嵌在缩略图里）',
    (between.match(/<div\b/g) ?? []).length === (between.match(/<\/div>/g) ?? []).length,
  )
}

// ── [4] 样式 ──────────────────────────────────────────────────────────────────

console.log('[4] 样式')
{
  const css = read('ui-shell/src/styles.css')
  const zoomRule = /\.attach-zoom \{([\s\S]*?)\}/.exec(css)
  check('styles.css 有 .attach-zoom 规则', zoomRule !== null)
  check('光标是放大镜', zoomRule !== null && zoomRule[1].includes('cursor: zoom-in'))
  check('.attach-zoom 铺满整格', zoomRule !== null && zoomRule[1].includes('height: 100%') && zoomRule[1].includes('width: 100%'))
  const imgRule = /\.attach-zoom img \{([\s\S]*?)\}/.exec(css)
  check('.attach-zoom img 不接事件', imgRule !== null && imgRule[1].includes('pointer-events: none'))
  check('焦点可见圈', /\.attach-zoom:focus-visible \{/.test(css))
  // 视觉复用旧界面那一套，不新造。
  const legacy = read('ui-shell/src/legacy/views.css')
  check('legacy 的 .img-lightbox 还在（视觉复用）', /\.img-lightbox \{/.test(legacy) && legacy.includes('var(--dsc-scrim)'))
}

// ── [5] 视频那支不许被包进按钮 ────────────────────────────────────────────────

console.log('[5] 视频分支没被顺手改掉')
{
  const src = read('ui-shell/src/plugins/composer/ui.tsx')
  const thumbAt = src.indexOf('className="attach-thumb"')
  const zoomAt = src.indexOf('className="attach-zoom"')
  const videoAt = src.indexOf('<video')
  const buttonEndAt = src.indexOf('</button>', zoomAt)
  check('.attach-thumb 在', thumbAt >= 0)
  check('.attach-zoom 在', zoomAt >= 0)
  check('<video> 在', videoAt >= 0)
  check('视频仍在 .attach-thumb 后面（同一块缩略图）', thumbAt >= 0 && videoAt > thumbAt)
  check('视频不在 .attach-zoom 那颗按钮里面', zoomAt >= 0 && buttonEndAt > zoomAt && !(videoAt > zoomAt && videoAt < buttonEndAt))
  check('视频没有自己的点击预览', !/onClick[\s\S]{0,80}<video/.test(src))
}

if (failures === 0) console.log('\n全部通过')
else console.log(`\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
