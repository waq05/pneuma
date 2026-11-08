/**
 * PTC 实拍的种子：只写 `desktop/shots/ptc-run-home`（临时 HOME + 临时 userData），
 * 用户真实的 `~/.dsc` 一个字节都不写。
 *
 * 为什么需要「复制配置」这一层：临时 HOME 是空的，模型端点与 key 都不在里面，
 * 真模型根本起不来。所以从真实 `~/.dsc` 只复制三样**配置**：
 *   config.yaml      —— 端点与模型（只当配置用，不打印内容）
 *   credentials.yaml —— 端点 key（复制、不读、不打印）
 *   presets/         —— 用户自己的模式文件（ptc.md 等；实拍就该用他本人那份模式）
 * 会话、审计、缓存、记忆、插件清单一概不复制——那些一旦复制进来，拍到的就不是干净现场，
 * 而且插件会带来额外的工具与审批卡。
 *
 * settings.json 自己造：把「模式 = ptc」「权限 = 完全访问」定死。为什么权限要给完全访问：
 * run_code 的风险标记是 exec，只读档会弹审批卡把整轮停在那里等人点，自检没法自动跑完。
 *
 * 用法（在 desktop/ 下）：node shots/_ptc-run-seed.mjs
 *
 * @module desktop/shots/_ptc-run-seed
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = 'D:\\dsc\\desktop\\shots\\ptc-run-home'
// 必须在任何写入之前读出真实用户目录：后面 HOME 与 USERPROFILE 都要换掉。
const realDsc = join(homedir(), '.dsc')

rmSync(home, { recursive: true, force: true })
mkdirSync(join(home, '.dsc'), { recursive: true })
// Chromium 在 app ready 之前会去 %USERPROFILE%\AppData\Roaming 找配置，缺这个目录会直接崩。
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })

const copied = []
for (const name of ['config.yaml', 'credentials.yaml']) {
  const from = join(realDsc, name)
  if (!existsSync(from)) continue
  cpSync(from, join(home, '.dsc', name))
  copied.push(name)
}
if (existsSync(join(realDsc, 'presets'))) {
  cpSync(join(realDsc, 'presets'), join(home, '.dsc', 'presets'), { recursive: true })
  copied.push('presets/')
}

// 实拍的第二个前提：把「建连 + 响应头」的时限放大。
// ptc 模式的系统提示比标准模式长得多，opencode 那个网关要等上游模型起完才吐响应头——
// 内置的 30 秒会连挂五次（2026-11-07 第一次实拍就是这么失败的）。这三个数写进隔离的
// config.yaml 的 llm 段（不再是环境变量），跑的就是用户真会用的那条配置路径。
const tuning = [
  '',
  '# 实拍专用：建连 + 响应头放宽到 3 分钟、重试给到 12 次（见 docs/development.md 的取值表）',
  'llm:',
  '  connectTimeoutMs: 180000',
  '  streamIdleMs: 300000',
  '  retryAttempts: 12',
  '',
].join('\n')
const copiedConfig = join(home, '.dsc', 'config.yaml')
if (existsSync(copiedConfig)) {
  const text = readFileSync(copiedConfig, 'utf8')
  // 用户自己写 llm 段时以他为准，别造出重复的顶层键（YAML 里那是错的）。
  if (!/^llm:/m.test(text)) writeFileSync(copiedConfig, text.replace(/\s*$/, '') + '\n' + tuning, 'utf8')
}

writeFileSync(
  join(home, '.dsc', 'settings.json'),
  `${JSON.stringify(
    {
      // run_code 的风险是 exec：只读档会弹审批卡，自检会卡在等人点。实拍要走完全访问。
      defaultPermissionPreset: 'full-access',
      defaultPolicy: 'full-access',
      defaultReviewer: 'user',
      // 这一条是这次实拍的重点：模式必须是 ptc，run_code 才会出现在模型面前。
      defaultPreset: 'ptc',
      defaultEffort: null,
      marketSources: [],
      closeToTray: false,
      ui: {
        sessionSort: 'recent',
        sessionGroup: 'workspace',
        archivedFilter: 'hide',
        workspaceOrder: ['D:\\dsc'],
        workspaceAliases: {},
        themeMode: 'dark',
        fontSize: 1,
        buttonScale: 1,
        density: 'standard',
        processFold: 'standard',
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

// 只报「复制了哪几样」与「默认模型叫什么」：config.yaml 里可能有端点地址，凭据文件一律不读。
let modelLine = '（未读到默认模型）'
try {
  const text = readFileSync(join(home, '.dsc', 'config.yaml'), 'utf8')
  const provider = /^default:\s*\n(?:.*\n)*?\s+provider:\s*(\S+)/m.exec(text)
  const model = /^default:\s*\n(?:.*\n)*?\s+model:\s*(\S+)/m.exec(text)
  if (provider !== null && model !== null) modelLine = `${provider[1]} / ${model[1]}`
} catch {
  // 读不到就不报，不影响实拍
}

console.log(`种子目录：${home}`)
console.log(`已复制：${copied.join('、')}`)
console.log(`默认模型：${modelLine}`)
console.log(`默认模式：ptc；权限：full-access`)
