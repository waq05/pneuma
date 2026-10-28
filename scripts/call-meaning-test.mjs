/**
 * 审批卡「中文含义」探针（0.7.1）：`core/call-meaning` 的解读对不对。
 *
 * 这一行字是用户点「允许」之前唯一的依据（命令原文他多半读不懂），所以按真值表钉：
 * 删除 / 读文件 / 列目录、Git 子命令、包管理器、解释器、复制两个端点、管道只报段数、
 * 认不出来的程序名直说、空命令给 null。
 *
 * 反例也钉了几条，因为「错得离谱」比「不说」更糟：
 *   `git commit -m "修一处标点"` 不能把提交信息当成要动的东西；
 *   `pnpm --version` 不能把 `--version` 当成子命令；
 *   `sudo rm -rf /` 要穿过包装词认出 rm；
 *   网址不能被「只留最后两级」的规则切掉协议头。
 *
 * 跑法：node scripts/call-meaning-test.mjs（先 pnpm run build，探针跑的是 lib/）
 *
 * @module dsc/scripts/call-meaning-test
 */
const { commandMeaning, callMeaning } = await import('../lib/core/call-meaning.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

console.log('[1] 命令 → 中文')
/** 命令 → 期望的中文（null = 空命令）。 */
const CASES = [
  ['Remove-Item -Recurse -Force D:\\dsc\\.tmp', '删除 D:\\dsc\\.tmp'],
  ['Get-Content package.json', '读文件内容 package.json'],
  ['Set-Content -Path a.txt -Value hi', '写文件内容 a.txt'],
  ['Get-ChildItem -Force', '列目录'],
  ['ls -la', '列目录'],
  ['Select-String -Pattern foo src/a.ts', '在文件里搜文本 foo'],
  ['cp a.txt D:\\backup\\a.txt', '复制 a.txt → D:\\backup\\a.txt'],
  ['git status --porcelain', '看 Git 状态'],
  ['git add src/plugins/approval.ts', '暂存改动 src/plugins/approval.ts'],
  ['git commit -m "fix: x"', '提交改动'],
  ['git push origin main', '推送提交'],
  ['pnpm install', 'pnpm 装依赖'],
  ['npm run build', '跑脚本 build'],
  ['pnpm --version', '跑 pnpm 包管理命令'],
  ['node scripts/x.mjs', '跑 Node 脚本 scripts/x.mjs'],
  ['python -m pytest tests', '跑 Python 模块 pytest'],
  ['curl -s https://example.com', '发网络请求 https://example.com'],
  ['sudo rm -rf /', '删除 /'],
  ['frobnicate --fast x', '运行 frobnicate 命令'],
  ['', null],
]
for (const [command, want] of CASES) {
  const got = commandMeaning(command)
  check(`${command === '' ? '（空命令）' : command} → ${want === null ? 'null' : want}`, got === want, JSON.stringify(got))
}

// 管道：只细说第一段，其余报段数（整条解读会变成一篇小作文）。
{
  const got = commandMeaning('Get-Content $f | ForEach-Object { ($_ | ConvertFrom-Json).Key }')
  check('管道只细说第一段并报段数', got === '读文件内容 $f（共 2 段命令）', got)
}

// 长句截断：卡片上一行放不下，宁可断在省略号上也不换行。
{
  const got = commandMeaning(`curl -s ${'https://example.com/'.repeat(6)}`)
  check('超长句子被截断', typeof got === 'string' && got.length <= 61 && got.endsWith('…'), got)
  check('网址不被「只留两级」切成残片', typeof got === 'string' && got.includes('https://'), got)
}

console.log('[2] 工具调用 → 中文')
check('write → 写文件', callMeaning({ toolName: 'write', target: 'D:\\dsc\\src\\a.ts' }) === '写文件 D:\\dsc\\src\\a.ts')
check('edit → 改文件', callMeaning({ toolName: 'edit', target: 'D:\\dsc\\src\\a.ts' }) === '改文件 D:\\dsc\\src\\a.ts')
check('带命令的工具走命令解读', callMeaning({ toolName: 'pwsh', command: 'git status' }) === '看 Git 状态')
check('认不出来的工具给 null', callMeaning({ toolName: 'mcp_thing' }) === null)
check('没有命令也没有目标时只说动词', callMeaning({ toolName: 'write' }) === '写文件')

if (failures > 0) {
  console.log(`\n${String(failures)} 项不通过`)
  process.exit(1)
}
console.log('\n全部通过')
