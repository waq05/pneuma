/**
 * 发版正文生成器的静态探针（2026-11-03）。
 *
 * 背景：`release.yml` 原来只让 GitHub 自动生成一行 “Full Changelog”，发布页看不出改了什么；
 * 0.8.1 是手工补的。现在正文由 `scripts/release-notes.mjs` 从 CHANGELOG 里取，钉住五件事：
 *
 *   [1] 只取目标版本那一节——上一版（更新的）内容不会混进来；
 *   [2] `## 版本 — 日期` 这条标题不进正文；
 *   [3] 开头是「装哪个」，三个安装入口都带当前版本号；
 *   [4] CHANGELOG 里没有这一版时不炸：给兜底正文，不出现 `undefined`；
 *   [5] 结尾链回 CHANGELOG。
 *
 * 跑法：node scripts/release-notes-test.mjs
 *
 * @module dsc/scripts/release-notes-test
 */
import { renderReleaseNotes } from './release-notes.mjs'

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
    failures += 1
  }
}

const changelog = [
  '# 更新日志',
  '',
  '## 0.9.0 — 2026-12-01',
  '',
  '### 未来版本',
  '',
  '- 下一版才有的条目。',
  '',
  '## 0.8.1 — 2026-11-03',
  '',
  '### 对话界面',
  '',
  '- **切会话更快** — 高亮立即切换。',
  '',
  '### 升级提醒',
  '',
  '- 覆盖安装即可。',
  '',
  '## 0.8.0 — 2026-10-31',
  '',
  '旧版本条目。',
  '',
].join('\n')

const { body, found } = renderReleaseNotes({
  changelog,
  version: 'v0.8.1',
  packageName: '@waq666/pneuma',
  repo: 'waq05/pneuma',
})

check('[1] 认得出这一版', found === true)
check('[1] 含本版条目', body.includes('**切会话更快**'))
check('[1] 不含下一版条目', !body.includes('下一版才有的条目'), body.slice(0, 80))
check('[1] 不含上一版条目', !body.includes('旧版本条目'))
check('[2] 标题行没进正文', !body.includes('## 0.8.1'))
check('[3] 开头是安装方式', body.startsWith('### 装哪个'))
check('[3] 安装版文件名带版本', body.includes('pneuma-setup-0.8.1.exe'))
check('[3] 免安装文件名带版本', body.includes('pneuma-portable-0.8.1.exe'))
check('[3] npm 命令带包名与版本', body.includes('npm i -g @waq666/pneuma@0.8.1'))
check('[5] 结尾链回 CHANGELOG', body.includes('github.com/waq05/pneuma/blob/main/CHANGELOG.md'))

const missing = renderReleaseNotes({ changelog, version: '0.9.9', packageName: '@waq666/pneuma', repo: 'waq05/pneuma' })
check('[4] 缺版本时用兜底', missing.found === false)
check('[4] 兜底里也有安装方式', missing.body.startsWith('### 装哪个'))
check('[4] 兜底不出现 undefined', !missing.body.includes('undefined'))
check('[4] 兜底说明缺日志', missing.body.includes('没有单独写在 CHANGELOG'))

console.log('')
if (failures > 0) {
  console.log(`FAIL 共 ${failures} 条`)
  process.exitCode = 1
} else {
  console.log('PASS 发版正文五条口径全过')
}
