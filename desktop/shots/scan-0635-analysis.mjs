/** 0.6.35 重扫结果分布（v2）：先看记录形状，再按真实路径字段统计。 */
import { readFileSync } from 'node:fs'

const dir = 'C:/Users/waq/.mimosa/security-scans/project-112b43dfbc29e5b1acfb0d50/scan-2026-10-02T15-46-21.830Z-ed45f0d7e50e'
const doc = JSON.parse(readFileSync(`${dir}/findings.json`, 'utf8'))
const arr = Array.isArray(doc) ? doc : (doc.findings ?? [])
console.log('total', arr.length)
console.log('sample keys:', Object.keys(arr[0]))
for (const key of ['location', 'primaryLocation', 'site', 'occurrences']) {
  if (arr[0][key] !== undefined) console.log(key, '→', JSON.stringify(arr[0][key]).slice(0, 200))
}

const pathOf = (f) => {
  const l = f.location ?? f.primaryLocation ?? f.site ?? {}
  return String(l.path ?? l.file ?? f.path ?? f.file ?? '(unknown)').replaceAll('\\', '/')
}

const byDir = new Map()
for (const f of arr) {
  const key = pathOf(f).split('/').slice(0, 3).join('/')
  byDir.set(key, (byDir.get(key) ?? 0) + 1)
}
console.log('--- 分布（前三段路径）---')
for (const [key, count] of [...byDir.entries()].sort((a, b) => b[1] - a[1])) console.log(`${count}\t${key}`)

const src = arr.filter((f) => {
  const p = pathOf(f)
  return p.startsWith('src/') || p.startsWith('desktop/src/')
})
console.log('--- src/desktop-src:', src.length)
for (const f of src) console.log(pathOf(f), '::', f.title, '::', String(f.message).slice(0, 80))
