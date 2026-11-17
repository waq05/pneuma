/**
 * read_image 工具卡的判据与回执解析（ui 层）。
 *
 * 来源：`scripts/ui-tool-read-image-test.mjs` 第 [1][2][2b] 段（判据、回执解析、回执 → 状态）
 * 与第 [4] 段的字典键。`read-image-model.ts` 零 import，直接 import 跑的就是产品代码。
 * 原探针第 [3] 段的渲染体源码钉（fs-read 现读、invoke 只出现一次、可点性）没有行为接缝，
 * 不迁——归组件渲染批，逐条见交付报告的缺口清单。
 *
 * @module dsc-ui-transcript/ui/tool-card/read-image-model.spec
 */
import { expect, test } from 'vitest'
import en from '../../locale/ui.en.json'
import zh from '../../locale/ui.zh.json'
import { readImageCallOf, readImageFactsOf, stateOfRead } from './read-image-model.js'

// ── 判据：名字是 read_image 且参数里有非空路径（path 与 file_path 都认） ──────

test('read_image + path → 一张图片卡', () => {
  expect(readImageCallOf('read_image', '{"path":"shot.png"}')).toEqual({ path: 'shot.png' })
})

test('read_image + file_path（dsh 那边的参数名）→ 也是一张图片卡', () => {
  expect(readImageCallOf('read_image', '{"file_path":"C:\\\\work\\\\a.png"}')).toEqual({
    path: 'C:\\work\\a.png',
  })
})

test('空串 / 空白 path → 不是这张卡', () => {
  expect(readImageCallOf('read_image', '{"path":""}')).toBeNull()
  expect(readImageCallOf('read_image', '{"path":"   "}')).toBeNull()
})

test('名字不是 read_image → 不是这张卡', () => {
  expect(readImageCallOf('read', '{"path":"shot.png"}')).toBeNull()
})

test('半截 JSON 不抛；参数是数组 → 不是这张卡；两个参数名都没给 → 不是这张卡', () => {
  expect(readImageCallOf('read_image', '{"path":')).toBeNull()
  expect(readImageCallOf('read_image', '[]')).toBeNull()
  expect(readImageCallOf('read_image', '{"file":"a.png"}')).toBeNull()
})

// ── 回执解析：只认宿主那句固定回执 ──────────────────────────────────────────

test('真句子 → { mime, bytes }', () => {
  const facts = readImageFactsOf('已加载图片 D:\\work\\shot.png（image/png，12345 字节），图在附件里。')
  expect(facts?.mime).toBe('image/png')
  expect(facts?.bytes).toBe(12345)
})

test('路径带空格与括号也解析得对', () => {
  const facts = readImageFactsOf('已加载图片 D:\\my work\\a (1).png（image/png，4096 字节），图在附件里。')
  expect(facts?.mime).toBe('image/png')
  expect(facts?.bytes).toBe(4096)
})

test('CRLF 行尾不影响解析', () => {
  const facts = readImageFactsOf('已加载图片 D:\\work\\shot.png（image/svg+xml，321 字节），图在附件里。\r\n')
  expect(facts?.mime).toBe('image/svg+xml')
  expect(facts?.bytes).toBe(321)
})

test('报错散文与「只接受图片」那句说明 → null（不能画成「看了一张 0 字节的图」）', () => {
  expect(readImageFactsOf('这张图有 7MB，超过 6MB 上限；先压缩或缩小再看')).toBeNull()
  expect(readImageFactsOf('read_image 只接受图片（png/jpg/gif/webp/bmp/svg）；文本文件请用 shell 命令读')).toBeNull()
})

test('undefined / 空串 → null（还在跑）；字节数不是十进制整数 → null', () => {
  expect(readImageFactsOf(undefined)).toBeNull()
  expect(readImageFactsOf('')).toBeNull()
  expect(readImageFactsOf('已加载图片 D:\\a.png（image/png，1e3 字节），图在附件里。')).toBeNull()
})

// ── 回执 → 状态：太大 / 不是图片 / 缺字段 / 正常 ─────────────────────────────

test('tooLarge 先判（超 5MB 说「太大」，即使 base64 是空串）', () => {
  expect(stateOfRead({ kind: 'image', tooLarge: true, mime: 'image/png', base64: '' }).kind).toBe('tooLarge')
})

test('kind 不是 image（文本 / PDF / 二进制）→ 读不到', () => {
  expect(stateOfRead({ kind: 'text', tooLarge: false }).kind).toBe('unavailable')
})

test('缺 mime / base64 空串 → 读不到（不拿 image/png 去猜）', () => {
  expect(stateOfRead({ kind: 'image', base64: 'AAAA' }).kind).toBe('unavailable')
  expect(stateOfRead({ kind: 'image', mime: 'image/png', base64: '' }).kind).toBe('unavailable')
})

test('正常回执 → image 状态，带出 mime 与 base64；空对象（跨进程缺字段）→ 读不到，不抛', () => {
  const ok = stateOfRead({ kind: 'image', tooLarge: false, mime: 'image/png', base64: 'AAAA' })
  expect(ok.kind).toBe('image')
  expect(ok.kind === 'image' && ok.mime).toBe('image/png')
  expect(ok.kind === 'image' && ok.base64).toBe('AAAA')
  expect(stateOfRead({}).kind).toBe('unavailable')
})

// ── 本卡字典键（数据断言） ───────────────────────────────────────────────────

const IMAGE_KEYS = [
  'transcript.tool.imageMeta',
  'transcript.tool.imageDims',
  'transcript.tool.imageLoading',
  'transcript.tool.imageTooLarge',
  'transcript.tool.imageUnavailable',
] as const

test('图片卡用到的五个键两份字典都在（非空字符串，英文真译过）', () => {
  for (const key of IMAGE_KEYS) {
    expect(typeof zh[key] === 'string' && (zh[key] as string).trim() !== '', `zh 有 ${key}`).toBe(true)
    expect(typeof en[key] === 'string' && (en[key] as string).trim() !== '', `en 有 ${key}`).toBe(true)
    expect(/[\u4e00-\u9fff]/.test(String(en[key] ?? '')), `${key} 的英文里没有汉字`).toBe(false)
  }
})
