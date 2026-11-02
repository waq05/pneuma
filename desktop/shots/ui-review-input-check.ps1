# /review 回车先落输入框（打包产物冒烟，2026-11-02）。
#
# 验三件事：
#   ① 在输入框里打 `/review` 再按回车，**不发送**、输入框内容变成 `/review `（尾空格）；
#   ② 输入框下方出现提示行（`.shell-composer-hint`），文案里有「关注点」；
#   ③ 真正的提交一条都没发生（输入框没被清空、没有用户气泡）。
#
# 为什么单独一份：这是本批唯一「只在真界面里才成立」的改动——探针能把纯逻辑
# （inputClaimOf / claim）钉死，但「React 受控输入框 + 原生 keydown」这一层只有
# 真壳跑得出来。用打包产物跑，顺带证明 asar 里的界面产物是这一版。
#
# 隔离：USERPROFILE/HOME + DSC_DESKTOP_STATE + DSC_DESKTOP_USER_DATA 全钉在隔离目录。
# 不需要假模型端点：全程不发消息。
#
# 用法：
#   pwsh -NoProfile -File ui-review-input-check.ps1
#   pwsh -NoProfile -File ui-review-input-check.ps1 -ExePath D:\dsc\desktop\dist\win-unpacked\Pneuma.exe
param(
  [string]$ExePath = ''
)

$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$swShots = 'D:\dsc\desktop\shots'
$swElectron = Join-Path $swShots '..\node_modules\electron\dist\electron.exe'
$swEntry = Join-Path $swShots '..\out\main\index.js'
$swHome = Join-Path $swShots 'review-input-home'
$swDsc = Join-Path $swHome '.dsc'
$swWs = Join-Path $swShots 'review-input-ws'
$swPackaged = $ExePath -ne ''
if ($swPackaged -and -not (Test-Path -LiteralPath $ExePath)) { throw "没有这个 exe：$ExePath" }

foreach ($dir in @($swHome, $swWs)) {
  if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $swWs | Out-Null
New-Item -ItemType Directory -Force -Path $swDsc | Out-Null

Set-Content -LiteralPath (Join-Path $swDsc 'desktop.json') -Encoding UTF8 -Value (@{
  lastCwd = $swWs
  recentCwds = @($swWs)
  ui = 'shell'
} | ConvertTo-Json -Depth 4)
Set-Content -LiteralPath (Join-Path $swDsc 'config.yaml') -Encoding UTF8 -Value @"
default:
  provider: probe
  model: probe-model
providers:
  probe:
    displayName: 探针端点（自检）
    baseURL: http://127.0.0.1:17422
    apiKeyEnv: DSC_PROBE_KEY
    api: openai-completions
    models:
      - id: probe-model
        name: probe-model
        contextWindow: 128000
        maxTokens: 4096
"@

# ── 渲染层预跑脚本 ────────────────────────────────────────────────────────────
$swEval = @'
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const v = pred(); if (v) return v; await wait(120); }
    return null;
  };
  const area = await waitFor(() => document.querySelector('textarea'), 30000);
  if (area === null) return { ok: false, why: '没找到输入框' };
  area.focus();
  // React 受控输入：必须走原生 value setter + input 事件，直接赋值不触发 onChange。
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(area, '/review');
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(250);
  const typed = area.value;
  // 回车：React 的 onKeyDown 挂在根上，从输入框冒泡即可。
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  await wait(600);
  const afterEnter = area.value;
  const hint = document.querySelector('.shell-composer-hint');
  const bubbles = document.querySelectorAll('.entry-user, .user-bubble, [data-entry-kind="user"]').length;
  return {
    ok: true,
    typed,
    afterEnter,
    caret: typeof area.selectionStart === 'number' ? area.selectionStart : -1,
    hint: hint === null ? '' : hint.textContent.trim(),
    userBubbles: bubbles,
  };
})()
'@

$env:DSC_DESKTOP_USER_DATA = Join-Path $swHome 'electron-userdata'
$env:USERPROFILE = $swHome
$env:HOME = $swHome
$env:DSC_DESKTOP_STATE = Join-Path $swDsc 'desktop.json'
$env:DSC_PROBE_KEY = 'sk-fake-selftest'
$env:DSC_DESKTOP_SHOT = Join-Path $swShots 'ui-review-input.png'
$env:DSC_DESKTOP_SHOT_DELAY = '26000'
$env:DSC_DESKTOP_SHOT_EVAL_LEAD = '18000'
$env:DSC_DESKTOP_SHOT_EVAL = $swEval
Remove-Item Env:DSC_UI_SHELL -ErrorAction SilentlyContinue
Remove-Item Env:DSC_UI_QUERY -ErrorAction SilentlyContinue

$outLog = Join-Path $swShots 'ui-review-input.out.log'
$errLog = Join-Path $swShots 'ui-review-input.err.log'
Remove-Item -LiteralPath $outLog, $errLog -ErrorAction SilentlyContinue

try {
  $swProc = if ($swPackaged) {
    Start-Process -FilePath $ExePath -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  } else {
    Start-Process -FilePath $swElectron -ArgumentList $swEntry -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  }
  $swProc.WaitForExit()
} finally {
  if ($null -ne $swProc -and -not $swProc.HasExited) {
    & taskkill /PID $swProc.Id /T /F 2>&1 | Out-Null
  }
  Remove-Item Env:DSC_DESKTOP_SHOT, Env:DSC_DESKTOP_SHOT_DELAY, Env:DSC_DESKTOP_SHOT_EVAL_LEAD,
    Env:DSC_DESKTOP_SHOT_EVAL, Env:DSC_DESKTOP_USER_DATA, Env:DSC_DESKTOP_STATE,
    Env:DSC_PROBE_KEY -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $errLog) {
  Select-String -LiteralPath $errLog -Pattern '预跑脚本完成|预跑脚本失败|截图失败|页面加载失败' |
    ForEach-Object { '  ' + $_.Line.Trim() }
}
Write-Output 'ui-review-input-check 完成'
