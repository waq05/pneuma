/**
 * 设置导航的分区筛选（`ui-shell/src/plugins/settings/ui.tsx`）的探针。
 *
 * 用户要求「把设置页的技能页去掉」。去掉的是**壳的导航里那一项**，不是宿主的分区：
 * 技能中心已经是侧栏的独立整页（`plugins/skills`，与旧桌面端 `SkillsView` 同构），而同一张
 * 分区表还被 TUI 的设置浮层与冻结的旧桌面版消费——宿主少一个分区等于悄悄改了另外两个界面。
 *
 * 四组断言：
 *
 *   1. **三处都过筛选**（导航列表 / 选中分区查找 / 侧栏请它开门的 target）：漏一处就会露出
 *      「分区加载失败：未知分区」；
 *   2. **技能那份实现整块撤掉**（SkillsGroup / SkillRow / listSkills / setSkillEnabled /
 *      那颗闪电图标）——设置里不再有第二份技能开关；
 *   3. **其余四个手画分区照旧在链上**（模式 / 模型 / 用量 / 归档），技能那一岔没把别人挤掉；
 *   4. **边界**：宿主仍发技能分区（TUI 与旧桌面版还要用），侧栏那个技能整页入口照旧。
 *
 * 实机（1440×900，壳伺服）：导航 = 通用 / 模型 / 模式 / 用量统计 / 归档 / 终端界面 / 远程控制 /
 * 关于——**没有技能**；接着逐个点开模型 / 模式 / 归档 / 用量统计，四个面板照常渲染，没有一处
 * 落到「分区加载失败：未知分区」。
 *
 * 运行：node scripts/ui-settings-nav-test.mjs（读源码，不需要先编译）
 *
 * @module dsc/scripts/ui-settings-nav-test
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(`${root}${rel}`, 'utf8')

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`  ok  ${name}`)
    return
  }
  failures += 1
  console.log(`FAIL  ${name}${detail === undefined ? '' : `  <- ${detail}`}`)
}

const shell = read('ui-shell/src/plugins/settings/ui.tsx')

// ── [1] 三处都过筛选 ─────────────────────────────────────────────────────────
console.log('[1] 滤掉的分区清单，三处都过')
{
  check("有一份壳自己的「不列」清单", /const HIDDEN_SECTIONS: ReadonlySet<string> = new Set\(\['skills'\]\)/.test(shell))
  check('导航列表过筛选', /\.filter\(\(section\) => !HIDDEN_SECTIONS\.has\(section\.id\)\)/.test(shell))
  check(
    '选中分区查找也过（否则点开就是「未知分区」）',
    /\.find\(\(item\) => item\.id === active && !HIDDEN_SECTIONS\.has\(item\.id\)\)/.test(shell),
  )
  check(
    '侧栏「开门并跳到某分区」的 target 也过（事件带 skills 时不跳进死分区）',
    /section !== '' && !HIDDEN_SECTIONS\.has\(section\)\) setActive\(section\)/.test(shell),
  )
  check('三处一共用到三次（少一处就会露出未列出的分区）', (shell.match(/HIDDEN_SECTIONS\.has\(/g) ?? []).length === 3, String((shell.match(/HIDDEN_SECTIONS\.has\(/g) ?? []).length))
  check(
    '清单里写了为什么不列（技能中心是侧栏的整页 + 宿主那份还有人用）',
    /技能中心已经是侧栏的独立整页/.test(shell) && /TUI 的设置浮层与冻结的旧桌面版/.test(shell),
  )
}

// ── [2] 技能那一份实现整块撤掉 ───────────────────────────────────────────────
console.log('[2] 设置里不再有第二份技能开关')
{
  check('SkillsGroup 组件已删', !shell.includes('SkillsGroup'))
  check('SkillRow 形状已删（宿主 listSkills 的投影）', !shell.includes('SkillRow'))
  check('不再调 listSkills', !shell.includes('listSkills'))
  check('不再调 setSkillEnabled', !shell.includes('setSkillEnabled'))
  check('那颗闪电图标不再 import（留着就是未使用的 import，tsc 会红）', !/\bIconBolt\b/.test(shell))
  check("sectionIcon 里不再有 skills 分支", !/id === 'skills'/.test(shell))
  check('手画分区那条链不再把 skills 岔出去', !/section\.id === 'skills' \?/.test(shell))
}

// ── [3] 其余四个手画分区照旧在链上 ───────────────────────────────────────────
console.log('[3] 其余手画分区没被挤掉')
{
  for (const [id, group, file] of [
    ['presets', 'PresetsGroup', './presets'],
    ['models', 'ModelsGroup', './models'],
    ['usage', 'UsageGroup', './usage'],
    ['archive', 'ArchiveGroup', './archive'],
  ]) {
    check(`分支还在：${id} → <${group} />`, shell.includes(`section.id === '${id}' ?`) && shell.includes(`<${group} />`))
    check(`${group} 仍从 ${file} 导入`, shell.includes(`from '${file}'`))
  }
  check('没手画的那几个照旧落回 NotYetPanel（说清去哪做，不假装有界面）', shell.includes('<NotYetPanel section={section} />'))
}

// ── [4] 边界：宿主与侧栏那两份照旧 ───────────────────────────────────────────
console.log('[4] 去掉的是哪一份')
{
  const host = read('src/plugins/settings.ts')
  check('宿主仍发技能分区（TUI 的设置浮层与旧桌面版消费同一张表）', /id: 'skills',\s*\n\s*title: '技能',/.test(host))
  check("它在宿主那张表里的 order 还是 20（TUI 里的位次没变）", /id: 'skills',[\s\S]{0,120}?order: 20,/.test(host))
  const skillsPage = read('ui-shell/src/plugins/skills/ui.tsx')
  check('侧栏那个技能整页入口还在（开关管这里）', /const PAGE = 'skills'/.test(skillsPage))
  check('技能整页照旧调 listSkills / setSkillEnabled（写口没跟着一起收）', skillsPage.includes('listSkills') && skillsPage.includes('setSkillEnabled'))
  check('壳仍按宿主给的分区表渲染（不是硬编一份清单）', /\(sections \?\? \[\]\)/.test(shell))
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 条失败`)
process.exit(failures === 0 ? 0 : 1)
