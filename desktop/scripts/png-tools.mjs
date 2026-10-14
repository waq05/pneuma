/**
 * 截图工具（只认 Electron `toPNG()` 出来的 8 位 RGB/RGBA、非隔行 PNG）。
 *
 * 为什么自己解：自检拿到的证据是一张张截图，而「这张图里那行小字写的是 15 还是 16」这类
 * 问题靠肉眼在缩略图上看会看错（踩过：把「16 个插件」读成「15 个插件」，白查半天）。
 * 这里给两件东西：**裁一小块放大**（人看）与**粗采样指纹**（脚本比）。不引入图像库。
 *
 *   node desktop/scripts/crop-shot.mjs <源.png> <出.png> <x0> <x1> <y0> <y1> [放大倍数]
 *   比例都写 0–1（例如 0.10 0.42 0.90 1.0 就是左下角那一块）。
 *
 * @module pneuma-desktop/png-tools
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

/** 解一张 PNG：返回 {width, height, channels, pixels}（pixels 是已还原滤波的 RGB/RGBA）。 */
export function decodePng(file) {
  const buffer = readFileSync(file)
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`不是 PNG：${file}`)
  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  const chunks = []
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') chunks.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`这个 PNG 解不了（depth=${String(depth)} color=${String(colorType)} interlace=${String(interlace)}）`)
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(chunks))
  const pixels = Buffer.alloc(stride * height)
  let read = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read]
    read += 1
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0
      const b = prev === null ? 0 : prev[x]
      const c = x >= channels && prev !== null ? prev[x - channels] : 0
      let value = raw[read + x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[x] = value & 0xff
    }
    read += stride
  }
  return { width, height, channels, pixels }
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** 编一张 8 位 RGB PNG（只写不筛的行，够小图用）。 */
export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 裁一块（比例给 0–1）并最近邻放大写出。
 * @returns 实际写出的尺寸（给命令行回话）
 */
export function cropAndScale(source, target, box, scale = 4) {
  const image = decodePng(source)
  const x0 = Math.floor(image.width * box.x0)
  const x1 = Math.ceil(image.width * box.x1)
  const y0 = Math.floor(image.height * box.y0)
  const y1 = Math.ceil(image.height * box.y1)
  const w = (x1 - x0) * scale
  const h = (y1 - y0) * scale
  const out = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = x0 + Math.floor(x / scale)
      const sy = y0 + Math.floor(y / scale)
      const at = (sy * image.width + sx) * image.channels
      out[(y * w + x) * 3] = image.pixels[at]
      out[(y * w + x) * 3 + 1] = image.pixels[at + 1]
      out[(y * w + x) * 3 + 2] = image.pixels[at + 2]
    }
  }
  writeFileSync(target, encodePng(w, h, out))
  return { source: `${String(image.width)}x${String(image.height)}`, crop: `${String(x1 - x0)}x${String(y1 - y0)}`, out: `${String(w)}x${String(h)}` }
}

/** 粗采样指纹：默认取左侧 420×860（侧栏那一带）压成 24×24 灰度格。 */
export function shotSignature(file, { width = 420, height = 860, grid = 24 } = {}) {
  const image = decodePng(file)
  const w = Math.min(width, image.width)
  const h = Math.min(height, image.height)
  const cellW = Math.max(1, Math.floor(w / grid))
  const cellH = Math.max(1, Math.floor(h / grid))
  const out = []
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      let sum = 0
      let count = 0
      for (let y = 0; y < cellH; y += 3) {
        for (let x = 0; x < cellW; x += 3) {
          const at = ((gy * cellH + y) * image.width + gx * cellW + x) * image.channels
          sum += (image.pixels[at] + image.pixels[at + 1] + image.pixels[at + 2]) / 3
          count += 1
        }
      }
      out.push(count === 0 ? 0 : sum / count)
    }
  }
  return out
}

/** 两张图的平均逐格差（0–255）：同一套界面渲染出来的两张通常 < 10；换一套界面远大于此。 */
export function signatureDiff(fileA, fileB, options) {
  const a = shotSignature(fileA, options)
  const b = shotSignature(fileB, options)
  const sum = a.reduce((total, value, index) => total + Math.abs(value - b[index]), 0)
  return sum / a.length
}
