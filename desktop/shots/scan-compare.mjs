/** 对比任意两次扫描的分布：看 policy/exclusions 到底改变了什么。 */
import { readFileSync } from 'node:fs'

const root = 'C:/Users/waq/.mimosa/security-scans/project-112b43dfbc29e5b1acfb0d50'
const scanDir = process.argv[2] ?? `${root}/scan-2026-10-02T16-03-01.820Z-2691718804db`
const doc = JSON.parse(readFileSync(`${scanDir}/findings.json`, 'utf8'))
const arr = Array.isArray(doc) ? doc : (doc.findings ?? [])
console.log('total', arr.length)

const byDir = new Map()
for (const f of arr) {
  const p = String((f.location ?? {}).path ?? '').replaceAll('\\', '/')
  const key = p.split('/').slice(0, 3).join('/')
  byDir.set(key, (byDir.get(key) ?? 0) + 1)
}
for (const [key, count] of [...byDir.entries()].sort((a, b) => b[1] - a[1])) console.log(`${count}\t${key}`)

const src = arr.filter((f) => {
  const p = String((f.location ?? {}).path ?? '').replaceAll('\\', '/')
  return p.startsWith('src/') || p.startsWith('desktop/src/')
})
console.log('--- src/desktop-src:', src.length)
