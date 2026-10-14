/**
 * 把截图的一块裁出来放大（自检证据看不清时用；只认 Electron toPNG 的 8 位 PNG）。
 *
 * 为什么要它：自检的读数常常是**图里的一行小字**，在缩略图上会看错——踩过：
 * 「诊断（16 个插件 / 11 个槽）」在缩略图上读成了「15 个插件」，白查了半天根因。
 *
 * 用法：node desktop/scripts/crop-shot.mjs <源.png> <出.png> <x0> <x1> <y0> <y1> [放大倍数]
 *   比例都写 0–1。例：左下角那一块放大 3 倍——
 *   node desktop/scripts/crop-shot.mjs desktop/shots/a.png desktop/shots/a-crop.png 0.10 0.42 0.90 1.0 3
 *
 * @module pneuma-desktop/crop-shot
 */
import { cropAndScale } from './png-tools.mjs'

const [source, target, x0, x1, y0, y1, scale] = process.argv.slice(2)
if (source === undefined || target === undefined) {
  console.error('用法：node desktop/scripts/crop-shot.mjs <源.png> <出.png> <x0> <x1> <y0> <y1> [放大倍数]')
  process.exit(1)
}
const result = cropAndScale(
  source,
  target,
  { x0: Number(x0 ?? 0), x1: Number(x1 ?? 1), y0: Number(y0 ?? 0), y1: Number(y1 ?? 1) },
  Number(scale ?? 4),
)
console.log(`源图 ${result.source} → 裁 ${result.crop} → 放大写出 ${target}（${result.out}）`)
