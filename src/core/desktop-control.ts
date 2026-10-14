/**
 * 桌面操作实现（Windows）：截屏、点鼠标、敲键盘、拖拽、列窗口/应用/显示器，
 * 以及无障碍（UIA）元素观察与定向动作。全部通过一次 PowerShell 子进程 +
 * user32 P/Invoke + System.Windows.Automation + System.Drawing 完成，零 npm 依赖。
 *
 * 坐标系说明（重要）：一律用**虚拟屏幕物理像素**。每次动作前进程内先
 * `SetProcessDPIAware()`，于是截屏像素与屏幕像素一比一对齐；截图被缩放过时，
 * 调用方传进来的仍是图上的像素，本模块自己按缩放系数换算回去。
 *
 * 无障碍观察（0.6.68 parity 补齐）：新增 `get_app_state` 观察路径，用 UIA
 * 枚举窗口控件树，产出结构化 elements + 文本树 + state_id。
 * - 元素索引作用域 = 该窗口**最近一次观察**；元素消失一律 fail-closed（报错，
 *   绝不退回坐标去乱点）。
 * - 目标两种（判别字段 `type`）：`{type:'element', index}` 或
 *   `{type:'coordinate', x, y}`（与 ZCode 的 target 语义一致）。
 *
 * 两个自研坑（dsh 把桌面操作外包给 Rust driver，所以它没有这两个坑）：
 * - `Graphics.CopyFromScreen` 在 DPI 缩放下会拍到缩放过的图，所以必须先声明 DPI 感知；
 * - 文本输入走剪贴板粘贴，绕开 SendKeys 对中文和 `{}` 之类的限制，代价是覆盖剪贴板，
 *   因此这里会先把原来的**文本**剪贴板存回去（图片/文件类剪贴板内容保不住）。
 *
 * @module dsc/core/desktop-control
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DesktopElement, DesktopFrame, DesktopRiskTier, DesktopTarget, DesktopWindowRef } from '../contract.js'

/** 桌面动作（工具 action 枚举；名字尽量照 ZCode 语义）。 */
export const DESKTOP_ACTIONS = [
  'screenshot',
  'click',
  'type',
  'key',
  'scroll',
  'drag',
  'paste',
  'set_value',
  'select_text',
  'perform_action',
  'cursor',
  'list_windows',
  'list_apps',
  'screens',
  'get_app_state',
  'stop',
] as const

export type DesktopAction = (typeof DESKTOP_ACTIONS)[number]

/** 旧名兼容：`window_list` 是 `list_windows` 的历史叫法（老配置里可能还写着它）。 */
export const ACTION_ALIASES: Readonly<Record<string, DesktopAction>> = { window_list: 'list_windows' }

/** 把（可能是旧名的）动作名归一成规范名；不认识返回 null。 */
export function canonicalAction(name: string): DesktopAction | null {
  if ((DESKTOP_ACTIONS as readonly string[]).includes(name)) return name as DesktopAction
  return ACTION_ALIASES[name] ?? null
}

/** 只读观察动作（看，不动手）：免审批的那一档就是它们。 */
export const READ_ACTIONS: readonly DesktopAction[] = [
  'screenshot',
  'cursor',
  'list_windows',
  'list_apps',
  'screens',
  'get_app_state',
]

/** 屏幕矩形（虚拟屏幕物理像素；多显示器时 left/top 可负）。 */
export interface ScreenBounds {
  left: number
  top: number
  width: number
  height: number
}

/** 显示器描述。 */
export interface ScreenInfo {
  device: string
  primary: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

/** 桌面参数（x/y 为截图像素坐标；缩放由本模块换算）。 */
export interface DesktopArgs {
  x?: number
  y?: number
  /** 动作目标：元素索引或坐标（与旧版扁平 x/y 并列，二者都认）。 */
  target?: DesktopTarget
  /** 拖拽起点/终点目标。 */
  from?: DesktopTarget
  to?: DesktopTarget
  /** 绑定窗口：句柄（数字）或标题/进程序名片段；绑定后坐标按该窗口左上角解析。 */
  window?: number | string
  button?: string
  double?: boolean
  text?: string
  key?: string
  repeat?: number
  holdSeconds?: number
  amount?: number
  /** 截图裁切区域（相对虚拟屏左上角的像素）。 */
  clip?: { x: number; y: number; width: number; height: number }
  /** set_value 的值。 */
  value?: string
  /** perform_action 的 UIA 动作名。 */
  pattern?: string
  /** 元素/窗口动作：关闭增量观察，取全树。 */
  disableDiffing?: boolean
}

/** 一次动作的结果：文本，或文本 + 图像（data URL）。 */
export interface DesktopResult {
  text: string
  images?: string[]
  /** 这次截屏相对屏幕的缩放系数（1 = 一比一）；点坐标要按它换算。 */
  scale?: number
  /** get_app_state 顺带带出的结构化观察（内部用）。 */
  frame?: DesktopFrame
}

const DPI_A =
  "using System.Runtime.InteropServices; public class DscDpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }"

const MOUSE_TYPE = `using System; using System.Runtime.InteropServices; public class DscMouse {
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); public struct POINT { public int X; public int Y; } }`

/** 窗口查询/激活的 P/Invoke（前台判断、白名单、窗口绑定、激活都用它）。 */
const WINDOW_TYPE = `using System; using System.Diagnostics; using System.Runtime.InteropServices; public class DscWin {
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
static string Proc(IntPtr h) { uint pid = 0; GetWindowThreadProcessId(h, out pid); try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; } }
public static string Describe() { IntPtr h = GetForegroundWindow(); var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return Proc(h) + "|" + sb.ToString(); } }`

/** UIA 引导（观察与元素动作共用）。这段 PowerShell 里定义了 Walk / Patterns-Of / Value-Of 等小函数。 */
const UIA_BOOT = `Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -TypeDefinition '${DPI_A}'
[DscDpi]::SetProcessDPIAware() | Out-Null
Add-Type -TypeDefinition '${WINDOW_TYPE}'
$scopeChildren = [System.Windows.Automation.TreeScope]::Children
$cond = [System.Windows.Automation.Condition]::TrueCondition
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Resolve-Win([int]$winId, [string]$winText) {
  $w = $null
  if ($winId -gt 0) { try { $w = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$winId) } catch { $w = $null } }
  if ($null -eq $w -and $winText -ne '') {
    $all = [System.Windows.Automation.AutomationElement]::RootElement.FindAll($scopeChildren, $cond)
    foreach ($c in $all) { try { if ($c.Current.Name.IndexOf($winText, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $w = $c; break } } catch { } }
  }
  if ($null -eq $w) { try { $w = [System.Windows.Automation.AutomationElement]::FromHandle([DscWin]::GetForegroundWindow()) } catch { $w = $null } }
  return $w
}
function Proc-Of([int]$h) { $p = 0; [DscWin]::GetWindowThreadProcessId([IntPtr]$h, [ref]$p) | Out-Null; try { return [System.Diagnostics.Process]::GetProcessById($p).ProcessName } catch { return '?' } }
function Rect-Of($el) { try { $r = $el.Current.BoundingRectangle; if ($r.IsEmpty) { return $null }; return [pscustomobject]@{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height } } catch { return $null } }
function Patterns-Of($el) {
  $p = New-Object System.Collections.ArrayList
  $o = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { [void]$p.Add('Invoke') } } catch { }
  $o = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$o)) { [void]$p.Add('Toggle') } } catch { }
  $o = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o)) { [void]$p.Add('SelectionItem') } } catch { }
  $o = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) { [void]$p.Add('ExpandCollapse') } } catch { }
  $o = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) { [void]$p.Add('Value') } } catch { }
  $o = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$o)) { [void]$p.Add('Scroll') } } catch { }
  $o = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$o)) { [void]$p.Add('RangeValue') } } catch { }
  $o = $null
  try { if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$o)) { [void]$p.Add('Text') } } catch { }
  return $p
}
function Value-Of($el) { try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); return [string]$vp.Current.Value } catch { return '' } }
function Read-El($el, [int]$i) {
  $ct = ''; $nm = ''; $aid = ''; $val = ''; $en = $true; $off = $false
  try { $ct = [string]$el.Current.ControlType.ProgrammaticName; if ($ct.StartsWith('ControlType.')) { $ct = $ct.Substring(12) } } catch { }
  try { $nm = [string]$el.Current.Name } catch { }
  try { $aid = [string]$el.Current.AutomationId } catch { }
  try { $en = [bool]$el.Current.IsEnabled } catch { }
  try { $off = [bool]$el.Current.IsOffscreen } catch { }
  if (-not $off) { $val = Value-Of $el }
  return [pscustomobject]@{ index=$i; controlType=$ct; title=$nm; automaid=$aid; value=$val; bounds=(Rect-Of $el); patterns=(Patterns-Of $el); enabled=$en; offscreen=$off }
}`

/** 鼠标键 → 按下/抬起事件位。 */
const BUTTON_EVENT: Record<string, readonly [number, number]> = {
  left: [2, 4],
  right: [8, 16],
  middle: [32, 64],
}

/** SendKeys 键名白名单（不认识的键名一律拒绝，避免把任意文本当语法喂进去）。 */
const KEY_MAP: Record<string, string> = {
  enter: '{ENTER}',
  tab: '{TAB}',
  esc: '{ESC}',
  escape: '{ESC}',
  space: ' ',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  insert: '{INSERT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  f1: '{F1}',
  f2: '{F2}',
  f3: '{F3}',
  f4: '{F4}',
  f5: '{F5}',
  f6: '{F6}',
  f7: '{F7}',
  f8: '{F8}',
  f9: '{F9}',
  f10: '{F10}',
  f11: '{F11}',
  f12: '{F12}',
}

/**
 * 明确禁止的按键组合。SendKeys 本来就发不出 Win 键，这里再挡一层
 * 那些「一发出去就把人锁在门外」的组合。
 */
const BANNED_KEYS = ['win', 'cmd', 'super', 'meta']

/** 观察/遍历上限（防止一棵病态树把上下文撑爆；超了在文本里明说被截断）。 */
export const OBSERVE_MAX_ELEMENTS = 400

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** PowerShell 单引号字符串转义。 */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/** 正在跑的 PowerShell 子进程（急停时一次性杀掉）。 */
const activeChildren = new Set<ChildProcess>()

/**
 * 急停：杀掉所有在跑的 PowerShell 子进程。
 * @returns 实际尝试杀掉的进程数（0 = 当时没有在跑的）。
 */
export function killAllPowerShell(): number {
  const count = activeChildren.size
  for (const child of activeChildren) {
    try {
      child.kill()
    } catch {
      // 已经退出/杀不掉都无所谓，急停只求尽快
    }
  }
  activeChildren.clear()
  return count
}

/**
 * 跑一段 PowerShell 并取 stdout。
 * @param signal - 外部取消时立刻杀掉子进程（用户中断这一轮，不该留一个正在点鼠标的进程）。
 */
export function runPowerShell(script: string, timeoutMs = 20000, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    )
    activeChildren.add(child)
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`桌面操作超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    const abort = (): void => {
      child.kill()
      reject(new Error('桌面操作被取消'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    const clean = (): void => {
      activeChildren.delete(child)
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    child.on('close', (code) => {
      clean()
      if (code === 0) resolve(out)
      else reject(new Error(err.trim() !== '' ? err.trim() : `powershell 退出码 ${String(code)}`))
    })
    child.on('error', (error) => {
      clean()
      reject(error)
    })
  })
}

/** 把 `ctrl+shift+s` 这类键名翻成 SendKeys 语法。 */
export function toSendKeys(key: string): string {
  const parts = String(key)
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  let modifiers = ''
  const singles: string[] = []
  for (const part of parts) {
    if (part === 'ctrl') modifiers += '^'
    else if (part === 'alt') modifiers += '%'
    else if (part === 'shift') modifiers += '+'
    else if (BANNED_KEYS.includes(part)) {
      throw new Error(`不允许按 Win 键（${part}）：这类按键会把桌面切走，请用 click 点你要的地方`)
    } else if (KEY_MAP[part] !== undefined) singles.push(KEY_MAP[part])
    else if (part.length === 1) singles.push(part)
    else throw new Error(`不认识的按键「${part}」。认得的：${Object.keys(KEY_MAP).join(' / ')}，或单字符`)
  }
  if (singles.length === 0) throw new Error(`按键 ${key} 里没有可执行的键`)
  return modifiers + singles.join('')
}

// ── 脚本生成（全部导出，自检直接对文本断言） ─────────────────────────────

/** 截屏脚本：DPI 感知 → 抓虚拟屏（或裁切块）→ 需要时缩放 → 按质量存 JPEG/PNG → base64。 */
export function screenshotScript(
  maxEdge: number,
  format: 'jpeg' | 'png',
  quality: number,
  clip?: { x: number; y: number; width: number; height: number },
): string {
  const encode =
    format === 'jpeg'
      ? `$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${quality})
$bmp.Save($ms, $codec, $ep)`
      : '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)'
  const hasClip = clip !== undefined && clip.width > 0 && clip.height > 0
  const region = hasClip
    ? `$srcRect = New-Object System.Drawing.Rectangle ([int]($b.Left + ${Math.round(clip!.x)})), ([int]($b.Top + ${Math.round(clip!.y)})), ${Math.round(clip!.width)}, ${Math.round(clip!.height)}
$ox = ${Math.round(clip!.x)}; $oy = ${Math.round(clip!.y)}`
    : `$srcRect = New-Object System.Drawing.Rectangle $b.Left, $b.Top, $b.Width, $b.Height
$ox = 0; $oy = 0`
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition '${DPI_A}'
[DscDpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
${region}
$src = New-Object System.Drawing.Bitmap $srcRect.Width, $srcRect.Height
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($srcRect.Left, $srcRect.Top, 0, 0, $src.Size)
$max = ${maxEdge}
$w = $src.Width; $h = $src.Height
if ($w -gt $max -or $h -gt $max) {
  if ($w -ge $h) { $nh = [int]([double]$max * $h / $w); $nw = $max } else { $nw = [int]([double]$max * $w / $h); $nh = $max }
  $bmp = New-Object System.Drawing.Bitmap $nw, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($src, 0, 0, $w, $h)
} else { $bmp = $src; $nw = $w; $nh = $h }
$ms = New-Object System.IO.MemoryStream
${encode}
"$nw,$nh,$srcRect.Width,$srcRect.Height,$ox,$oy,$($b.Left),$($b.Top),$($b.Width),$($b.Height)|" + [Convert]::ToBase64String($ms.ToArray())
`
}

/** 观察脚本参数。 */
export interface ObserveOptions {
  windowId?: number
  windowText?: string
  maxElements?: number
}

/**
 * 无障碍观察脚本：枚举目标窗口（或前台窗口）的控件树，输出一行 JSON。
 * UIA 不可用时输出 `{ok:false,error:"…"}`（Node 侧抛成明确中文），绝不静默。
 */
export function observeScript(options: ObserveOptions = {}): string {
  const winId = Math.max(0, Math.round(options.windowId ?? 0))
  const winText = psQuote(String(options.windowText ?? ''))
  const max = Math.max(10, Math.round(options.maxElements ?? OBSERVE_MAX_ELEMENTS))
  return `
$ErrorActionPreference = 'Stop'
try {
${UIA_BOOT}
  $win = Resolve-Win ${winId} ${winText}
  if ($null -eq $win) { throw '拿不到目标窗口（前台窗口句柄无效，或标题没匹配上）' }
  $wh = [int]$win.Current.NativeWindowHandle
  $wtitle = ''; try { $wtitle = [string]$win.Current.Name } catch { }
  $proc = Proc-Of $wh
  $wb = Rect-Of $win
  $max = ${max}
  $script:idx = 0
  $items = New-Object System.Collections.ArrayList
  $lines = New-Object System.Collections.ArrayList
  function Walk($el, [int]$depth) {
    if ($script:idx -ge $max) { return }
    $i = $script:idx; $script:idx = $i + 1
    $o = Read-El $el $i
    [void]$items.Add($o)
    $line = ('  ' * $depth) + '[' + $i + '] ' + $o.controlType
    if ($o.title -ne '') { $line += ' "' + $o.title + '"' }
    if ($o.value -ne '') { $line += ' = "' + $o.value + '"' }
    if ($o.offscreen) { $line += ' (屏外)' }
    [void]$lines.Add($line)
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child) {
      if ($script:idx -ge $max) { break }
      Walk $child ($depth + 1)
      $child = $walker.GetNextSibling($child)
    }
  }
  Walk $win 0
  if ($script:idx -ge $max) { [void]$lines.Add('…（控件数超过 ' + $max + '，已截断）') }
  $obj = [pscustomobject]@{ ok=$true; error=''; app=$proc; window=[pscustomobject]@{ id=$wh; title=$wtitle; bounds=$wb }; elements=$items; text=($lines -join "\`n") }
  $obj | ConvertTo-Json -Depth 8 -Compress
} catch {
  [pscustomobject]@{ ok=$false; error=[string]$_.Exception.Message; app=''; window=$null; elements=@(); text='' } | ConvertTo-Json -Depth 8 -Compress
}
`
}

/**
 * 元素动作脚本：重新遍历到第 index 个控件，按 pattern 派发（set_value / select_text / perform_action）。
 * 输出 JSON `{ok, error, method}`；method='none' 表示该控件没有对应模式（Node 侧据此回退）。
 */
export function elementActionScript(
  kind: 'set_value' | 'select_text' | 'perform_action',
  options: ObserveOptions & { index: number; value?: string; pattern?: string },
): string {
  const winId = Math.max(0, Math.round(options.windowId ?? 0))
  const winText = psQuote(String(options.windowText ?? ''))
  const index = Math.max(0, Math.round(options.index))
  const dispatch = buildElementDispatch(kind, options.pattern, options.value)
  return `
$ErrorActionPreference = 'Stop'
try {
${UIA_BOOT}
  $win = Resolve-Win ${winId} ${winText}
  if ($null -eq $win) { throw '拿不到目标窗口，元素索引无法解析' }
  $target = ${index}
  $script:idx = 0
  $script:found = $null
  function Find($el) {
    if ($null -ne $script:found) { return }
    if ($script:idx -eq $target) { $script:found = $el; return }
    $script:idx = $script:idx + 1
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child) {
      if ($null -ne $script:found) { return }
      Find $child
      $child = $walker.GetNextSibling($child)
    }
  }
  Find $win
  if ($null -eq $script:found) { throw '元素 #' + $target + ' 已经不在了（界面可能变了，请重新 get_app_state）' }
  $method = ${dispatch}
  [pscustomobject]@{ ok=$true; error=''; method=$method } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok=$false; error=[string]$_.Exception.Message; method='error' } | ConvertTo-Json -Compress
}
`
}

/** 生成元素动作的 PowerShell 派发片段（返回值：'value' | 'invoke' | 'toggle' | 'expand' | 'collapse' | 'select' | 'selecttext' | 'scrollinto' | 'none'）。 */
function buildElementDispatch(kind: 'set_value' | 'select_text' | 'perform_action', pattern?: string, value?: string): string {
  if (kind === 'set_value') {
    return `$vp = $null
  if ($script:found.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { $vp.SetValue(${psQuote(String(value ?? ''))}); 'value' } else { 'none' }`
  }
  if (kind === 'select_text') {
    return `$tp = $null
  if ($script:found.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { $tp.DocumentRange.Select(); 'selecttext' }
  else { $si = $null; if ($script:found.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$si)) { $si.Select(); 'select' } else { 'none' } }`
  }
  const name = String(pattern ?? 'invoke').toLowerCase()
  const map: Record<string, string> = {
    invoke: `$p = $null; if ($script:found.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); 'invoke' } else { 'none' }`,
    toggle: `$p = $null; if ($script:found.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); 'toggle' } else { 'none' }`,
    expand: `$p = $null; if ($script:found.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); 'expand' } else { 'none' }`,
    collapse: `$p = $null; if ($script:found.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Collapse(); 'collapse' } else { 'none' }`,
    select: `$p = $null; if ($script:found.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); 'select' } else { 'none' }`,
    scrollintoview: `$p = $null; if ($script:found.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$p)) { $p.ScrollIntoView(); 'scrollinto' } else { 'none' }`,
  }
  const body = map[name]
  if (body === undefined) {
    return `throw '不认识的 action「${name}」。认得的：${Object.keys(map).join(' / ')}'`
  }
  return body
}

/** 拖拽脚本：起点按下 → 分步插值移动到终点 → **finally 里保证抬起**。 */
export function dragScript(from: { x: number; y: number }, to: { x: number; y: number }, steps: number, stepDelayMs: number): string {
  const n = Math.max(2, Math.round(steps))
  const delay = Math.max(0, Math.round(stepDelayMs))
  return `
Add-Type -TypeDefinition '${MOUSE_TYPE}'
[DscMouse]::SetCursorPos(${Math.round(from.x)}, ${Math.round(from.y)}) | Out-Null
Start-Sleep -Milliseconds 60
[DscMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
try {
  for ($i = 1; $i -le ${n}; $i++) {
    $px = [int](${Math.round(from.x)} + (${Math.round(to.x)} - ${Math.round(from.x)}) * $i / ${n})
    $py = [int](${Math.round(from.y)} + (${Math.round(to.y)} - ${Math.round(from.y)}) * $i / ${n})
    [DscMouse]::SetCursorPos($px, $py) | Out-Null
    Start-Sleep -Milliseconds ${delay}
  }
} finally {
  [DscMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
'Done'
`
}

/** 点击脚本：移动到点 → 单击/双击（可选先激活窗口）。 */
export function clickScript(point: { x: number; y: number }, button: string, double: boolean, activateLine: string, pauseMs: number): string {
  const events = BUTTON_EVENT[button] ?? BUTTON_EVENT.left!
  const pause = pauseMs > 0 ? `Start-Sleep -Milliseconds ${pauseMs}` : ''
  const clicks = double ? 2 : 1
  const clickLines = Array.from(
    { length: clicks },
    () =>
      `[DscMouse]::mouse_event(${events[0]},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [DscMouse]::mouse_event(${events[1]},0,0,0,[UIntPtr]::Zero)`,
  ).join(`; ${pause}; `)
  return `
Add-Type -TypeDefinition '${MOUSE_TYPE}'
Add-Type -TypeDefinition '${WINDOW_TYPE}'
${activateLine}
[DscMouse]::SetCursorPos(${Math.round(point.x)}, ${Math.round(point.y)}) | Out-Null
${pause}
${clickLines}
'Done'
`
}

/** 滚轮脚本：可选先把鼠标移到某点，再滚 amount 档。 */
export function scrollScript(amount: number, move: string, pauseMs: number): string {
  const pause = pauseMs > 0 ? `Start-Sleep -Milliseconds ${pauseMs}` : ''
  const step = amount > 0 ? '4294967176' : '120'
  return `
Add-Type -TypeDefinition '${MOUSE_TYPE}'
${move}
for ($i = 0; $i -lt ${Math.abs(amount)}; $i++) { [DscMouse]::mouse_event(0x0800, 0, 0, ${step}, [UIntPtr]::Zero); ${pause} }
'Done'
`
}

/** 按键脚本：按住 hold_seconds（可选）再松开，repeat 次。 */
export function keyScript(keys: string, repeat: number, holdSeconds: number): string {
  const hold = holdSeconds > 0 ? `Start-Sleep -Milliseconds ${Math.round(holdSeconds * 1000)}` : ''
  return `
Add-Type -AssemblyName System.Windows.Forms
for ($i = 0; $i -lt ${Math.max(1, Math.round(repeat))}; $i++) {
  [System.Windows.Forms.SendKeys]::SendWait(${psQuote(keys)})
  ${hold}
}
'Done'
`
}

/**
 * 粘贴脚本：把 text（可选）写进系统剪贴板，Ctrl+V，然后**还原用户原来的文本剪贴板**。
 * `text` 省略时直接用当前剪贴板（不动它，也不还原）。
 */
export function pasteScript(text: string | undefined): string {
  if (text === undefined) {
    return `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
'Done'
`
  }
  return `
Add-Type -AssemblyName System.Windows.Forms
$old = $null
try { $old = Get-Clipboard -TextFormatType Text } catch { }
Set-Clipboard -Value ${psQuote(text)}
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 80
if ($null -ne $old) { Set-Clipboard -Value $old }
'Done'
`
}

/** 文本输入脚本：写剪贴板 → 粘贴 → 还原原剪贴板。 */
export function typeScript(text: string): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
$old = $null
try { $old = Get-Clipboard -TextFormatType Text } catch { }
Set-Clipboard -Value ${psQuote(text)}
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 80
if ($null -ne $old) { Set-Clipboard -Value $old }
'Done'
`
}

/** 列窗口脚本（增强：window_id/title/app/bounds/main/focused/onscreen）。 */
export function listWindowsScript(): string {
  return `
$ErrorActionPreference = 'Stop'
try {
${UIA_BOOT}
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $fg = [int][DscWin]::GetForegroundWindow()
  $wins = $root.FindAll($scopeChildren, $cond)
  $out = New-Object System.Collections.ArrayList
  foreach ($w in $wins) {
    try {
      $h = [int]$w.Current.NativeWindowHandle
      if ($h -le 0) { continue }
      $mainH = 0
      try { $p = 0; [DscWin]::GetWindowThreadProcessId([IntPtr]$h, [ref]$p) | Out-Null; $mainH = [int]([System.Diagnostics.Process]::GetProcessById($p)).MainWindowHandle } catch { $mainH = 0 }
      $r = Rect-Of $w
      [void]$out.Add([pscustomobject]@{ window_id=$h; title=[string]$w.Current.Name; app=(Proc-Of $h); bounds=$r; main=($h -eq $mainH); focused=($h -eq $fg); onscreen=(-not [bool]$w.Current.IsOffscreen) })
    } catch { }
  }
  [pscustomobject]@{ ok=$true; error=''; windows=$out } | ConvertTo-Json -Depth 6 -Compress
} catch {
  [pscustomobject]@{ ok=$false; error=[string]$_.Exception.Message; windows=@() } | ConvertTo-Json -Depth 6 -Compress
}
`
}

/** 列应用脚本：进程名 + 主窗口 + 是否前台。 */
export function listAppsScript(): string {
  return `
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition '${DPI_A}'
[DscDpi]::SetProcessDPIAware() | Out-Null
Add-Type -TypeDefinition '${WINDOW_TYPE}'
  $fgh = [DscWin]::GetForegroundWindow()
  $fgp = 0
  [DscWin]::GetWindowThreadProcessId($fgh, [ref]$fgp) | Out-Null
  $out = New-Object System.Collections.ArrayList
  foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object ProcessName -Unique)) {
    [void]$out.Add([pscustomobject]@{ pid=$p.Id; app=$p.ProcessName; title=$p.MainWindowTitle; foreground=($p.Id -eq [int]$fgp) })
  }
  [pscustomobject]@{ ok=$true; error=''; apps=$out } | ConvertTo-Json -Depth 6 -Compress
} catch {
  [pscustomobject]@{ ok=$false; error=[string]$_.Exception.Message; apps=@() } | ConvertTo-Json -Depth 6 -Compress
}
`
}

/** 显示器枚举脚本（含负坐标）。 */
export function screensScript(): string {
  return `
$ErrorActionPreference = 'Stop'
try {
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition '${DPI_A}'
[DscDpi]::SetProcessDPIAware() | Out-Null
  $out = New-Object System.Collections.ArrayList
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    [void]$out.Add([pscustomobject]@{ device=$s.DeviceName; primary=$s.Primary; bounds=[pscustomobject]@{ x=[int]$s.Bounds.X; y=[int]$s.Bounds.Y; width=[int]$s.Bounds.Width; height=[int]$s.Bounds.Height } })
  }
  [pscustomobject]@{ ok=$true; error=''; screens=$out } | ConvertTo-Json -Depth 6 -Compress
} catch {
  [pscustomobject]@{ ok=$false; error=[string]$_.Exception.Message; screens=@() } | ConvertTo-Json -Depth 6 -Compress
}
`
}

/** 窗口探测脚本：解析 window 选择器，返回句柄 + 标题 + 矩形（绑定坐标与激活用）。 */
export function probeWindowScript(selector: number | string): string {
  const isHandle = typeof selector === 'number' || /^\d+$/.test(String(selector).trim())
  const winId = isHandle ? Math.max(0, Math.round(Number(selector))) : 0
  const winText = isHandle ? '' : String(selector)
  return `
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition '${DPI_A}'
[DscDpi]::SetProcessDPIAware() | Out-Null
Add-Type -TypeDefinition '${WINDOW_TYPE}'
  $h = [IntPtr]::Zero
  $winId = ${winId}
  $winText = ${psQuote(winText)}
  if ($winId -gt 0) { $h = [IntPtr]$winId }
  elseif ($winText -ne '') {
    foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })) {
      try { if ($p.MainWindowTitle.IndexOf($winText, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or $p.ProcessName.IndexOf($winText, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $h = $p.MainWindowHandle; break } } catch { }
    }
  }
  if ($h -eq [IntPtr]::Zero) { throw '找不到窗口「' + $winText + '」' }
  $r = New-Object DscWin+RECT
  [DscWin]::GetWindowRect($h, [ref]$r) | Out-Null
  $sb = New-Object System.Text.StringBuilder 512
  [DscWin]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
  [pscustomobject]@{ ok=$true; error=''; id=[int]$h; title=$sb.ToString(); bounds=[pscustomobject]@{ x=$r.Left; y=$r.Top; width=($r.Right - $r.Left); height=($r.Bottom - $r.Top) } } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok=$false; error=[string]$_.Exception.Message; id=0; title=''; bounds=$null } | ConvertTo-Json -Compress
}
`
}

// ── 纯函数：目标解析 / 帧解析 / 差分 / settle ─────────────────────────────

function assertInt(value: unknown, label: string): number {
  const num = Number(value)
  if (!Number.isInteger(num)) throw new Error(`${label} 必须是整数，收到 ${String(value)}`)
  return num
}

/**
 * 把截图像素坐标换算成屏幕物理坐标。
 * @throws 小数坐标，或换算后落在屏幕外（这里不靠 SetCursorPos 静默夹紧，越界就是要告诉模型）。
 */
export function resolveScreenPoint(
  args: DesktopArgs,
  bounds: ScreenBounds,
  scale: number,
): { x: number; y: number } {
  const rawX = args.x
  const rawY = args.y
  if (rawX === undefined || rawY === undefined) throw new Error('这个动作要带 x 与 y（截图上的像素坐标）')
  if (!Number.isInteger(rawX) || !Number.isInteger(rawY)) {
    throw new Error(`x 与 y 必须是整数，收到 (${String(rawX)}, ${String(rawY)})`)
  }
  return clampToScreen(Math.round(rawX / scale), Math.round(rawY / scale), bounds)
}

function clampToScreen(x: number, y: number, bounds: ScreenBounds): { x: number; y: number } {
  if (x < bounds.left || x >= bounds.left + bounds.width || y < bounds.top || y >= bounds.top + bounds.height) {
    throw new Error(
      `坐标 (${x}, ${y}) 在屏幕外（有效范围 ${bounds.left},${bounds.top} 到 ${bounds.left + bounds.width - 1},${bounds.top + bounds.height - 1}）。先 screenshot 看清界面再点`,
    )
  }
  return { x, y }
}

/** 目标解析结果。 */
export interface TargetResolution {
  x: number
  y: number
  label: string
  element?: DesktopElement
}

/**
 * 解析一个动作目标成屏幕物理坐标（纯函数，自检直接调）。
 *
 * - coordinate：图上的整数像素（按 scale 换算）；若绑定了窗口，则相对该窗口左上角。
 * - element：走该窗口**最近一次观察**（frame）里的 index；**元素不存在一律 fail-closed**
 *   （抛 ELEMENT_UNAVAILABLE，绝不退回坐标）；元素在屏外/无矩形同样报错。
 *
 * @param target - 元素或坐标目标。缺省时用 legacy 的扁平 x/y（兼容旧参数形状）。
 * @param frame - 该窗口最近一次观察（element 目标必须有）。
 * @param bounds - 虚拟屏幕矩形。
 * @param scale - 最近一张截图的缩放系数。
 * @param windowBounds - 绑定窗口的矩形（给了则坐标按窗口左上角解析）。
 */
export function resolveTarget(
  target: DesktopTarget | undefined,
  legacy: { x?: number; y?: number } | undefined,
  frame: DesktopFrame | undefined,
  bounds: ScreenBounds,
  scale: number,
  windowBounds?: { x: number; y: number; width: number; height: number } | null,
): TargetResolution {
  const actual: DesktopTarget | undefined =
    target ?? (legacy?.x !== undefined && legacy?.y !== undefined ? { type: 'coordinate', x: legacy.x, y: legacy.y } : undefined)
  if (actual === undefined) {
    throw new Error('这个动作要带 target（{type:\'element\', index} 或 {type:\'coordinate\', x, y}）')
  }
  if (actual.type === 'coordinate') {
    const x = assertInt(actual.x, 'coordinate.x')
    const y = assertInt(actual.y, 'coordinate.y')
    const ox = windowBounds?.x ?? 0
    const oy = windowBounds?.y ?? 0
    const point = clampToScreen(Math.round(x / scale) + ox, Math.round(y / scale) + oy, bounds)
    const label = windowBounds === undefined || windowBounds === null
      ? `坐标 (${point.x}, ${point.y})`
      : `窗口内坐标 (${x}, ${y}) → 屏幕 (${point.x}, ${point.y})`
    return { x: point.x, y: point.y, label }
  }
  // element
  const index = assertInt(actual.index, 'element.index')
  if (frame === undefined) {
    throw new Error(`元素目标要有该窗口的观察结果，先 get_app_state 观察一次再点（当前没有任何观察）`)
  }
  if (actual.state_id !== undefined && actual.state_id !== frame.state_id) {
    throw new Error(`ELEMENT_UNAVAILABLE：state_id「${actual.state_id}」不是该窗口最近的观察「${frame.state_id}」，索引已失效，请重新 get_app_state`)
  }
  if (index < 0 || index >= frame.elements.length) {
    throw new Error(`ELEMENT_UNAVAILABLE：元素 #${index} 不存在（该窗口最近一次观察有 ${frame.elements.length} 个控件），请重新 get_app_state`)
  }
  const element = frame.elements[index]!
  if (element.offscreen || element.bounds === null || element.bounds.width <= 0 || element.bounds.height <= 0) {
    throw new Error(`ELEMENT_UNAVAILABLE：元素 #${index}（${element.controlType}「${element.title}」）在屏外或没有矩形，无法定位`)
  }
  const cx = element.bounds.x + Math.floor(element.bounds.width / 2)
  const cy = element.bounds.y + Math.floor(element.bounds.height / 2)
  clampToScreen(cx, cy, bounds)
  return { x: cx, y: cy, label: `元素 #${index}（${element.controlType}「${element.title}」）`, element }
}

/** 把一次的 JSON 控件对象规整成 DesktopElement。 */
function normalizeElement(raw: unknown, fallbackIndex: number): DesktopElement {
  const item = (raw ?? {}) as Record<string, unknown>
  const boundsRaw = item.bounds as Record<string, unknown> | null | undefined
  const bounds =
    boundsRaw === null || boundsRaw === undefined
      ? null
      : {
          x: Number(boundsRaw.x ?? 0),
          y: Number(boundsRaw.y ?? 0),
          width: Number(boundsRaw.width ?? 0),
          height: Number(boundsRaw.height ?? 0),
        }
  const patternsRaw = item.patterns
  const patterns = Array.isArray(patternsRaw)
    ? patternsRaw.map((p) => String(p))
    : patternsRaw === undefined || patternsRaw === null
      ? []
      : [String(patternsRaw)]
  return {
    index: Number.isInteger(item.index) ? (item.index as number) : fallbackIndex,
    controlType: String(item.controlType ?? ''),
    title: String(item.title ?? ''),
    automaid: String(item.automaid ?? ''),
    value: String(item.value ?? ''),
    bounds,
    patterns,
    enabled: item.enabled !== false,
    offscreen: item.offscreen === true,
  }
}

/** 观察编号计数器（进程内单调递增）。 */
let stateCounter = 0

/** 观察结果缓存：窗口键 → 最近一次观察。 */
const framesByWindow = new Map<string, DesktopFrame>()
/** 最近一次观察（不指定窗口时的元素作用域与差分基线）。 */
let latestFrame: DesktopFrame | undefined

/** 自检用：清空观察缓存（生产路径不调用）。 */
export function resetFrames(): void {
  framesByWindow.clear()
  latestFrame = undefined
  stateCounter = 0
}

/** 该窗口最近一次观察。 */
export function frameForWindow(windowKey?: string | number): DesktopFrame | undefined {
  if (windowKey === undefined) return latestFrame
  return framesByWindow.get(String(windowKey))
}

/** 解析观察脚本的 JSON，产出 DesktopFrame 并写入缓存。 */
export function parseFrame(raw: string): DesktopFrame {
  const trimmed = raw.trim()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    throw new Error(`无障碍观察返回的不是 JSON：${trimmed.slice(0, 120)}`)
  }
  if (data.ok !== true) {
    throw new Error(`无障碍观察失败：${String(data.error ?? '未知原因')}（这台机器可能不支持 UIA，或目标窗口已关闭）`)
  }
  const winRaw = (data.window ?? {}) as Record<string, unknown>
  const boundsRaw = winRaw.bounds as Record<string, unknown> | null | undefined
  const window: DesktopWindowRef = {
    id: Number(winRaw.id ?? 0),
    title: String(winRaw.title ?? ''),
    bounds:
      boundsRaw === null || boundsRaw === undefined
        ? null
        : {
            x: Number(boundsRaw.x ?? 0),
            y: Number(boundsRaw.y ?? 0),
            width: Number(boundsRaw.width ?? 0),
            height: Number(boundsRaw.height ?? 0),
          },
  }
  const rawElements = data.elements
  const list = Array.isArray(rawElements) ? rawElements : rawElements === undefined || rawElements === null ? [] : [rawElements]
  const elements = list.map((item, i) => normalizeElement(item, i))
  stateCounter += 1
  const frame: DesktopFrame = {
    state_id: `st-${stateCounter}`,
    app: String(data.app ?? ''),
    window,
    elements,
    text: String(data.text ?? ''),
    snapshot_mode: 'full',
  }
  framesByWindow.set(String(window.id), frame)
  latestFrame = frame
  return frame
}

/** 帧差分：按 index 对齐（未变的索引仍有效），得出 added/removed/changed。 */
export function diffFrames(base: DesktopFrame, next: DesktopFrame): { removed: number[]; added: number[]; changed: number[] } {
  const removed: number[] = []
  const added: number[] = []
  const changed: number[] = []
  const max = Math.max(base.elements.length, next.elements.length)
  for (let i = 0; i < max; i += 1) {
    const a = base.elements[i]
    const b = next.elements[i]
    if (a === undefined && b !== undefined) added.push(i)
    else if (a !== undefined && b === undefined) removed.push(i)
    else if (a !== undefined && b !== undefined) {
      const same =
        a.controlType === b.controlType &&
        a.title === b.title &&
        a.value === b.value &&
        a.automaid === b.automaid &&
        JSON.stringify(a.bounds) === JSON.stringify(b.bounds)
      if (!same) changed.push(i)
    }
  }
  return { removed, added, changed }
}

/** 把差分结论写成给人/模型看的文本。 */
export function diffText(base: DesktopFrame, next: DesktopFrame, diff: { removed: number[]; added: number[]; changed: number[] }): string {
  const head = `观察 ${next.state_id}（相对 ${base.state_id} 的变化；未列出的索引按上次的树不变）：` +
    `新增 [${diff.added.join(', ')}]，移除 [${diff.removed.join(', ')}]，变化 [${diff.changed.join(', ')}]`
  const details: string[] = []
  for (const i of diff.changed) {
    const b = next.elements[i]
    if (b === undefined) continue
    details.push(`  [${i}] ${b.controlType} "${b.title}" = "${b.value}"`)
  }
  return details.length === 0 ? head : `${head}\n${details.join('\n')}`
}

/** settle 观察选项（自检可注入 now/sleep）。 */
export interface SettleOptions {
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** settle 结论。 */
export interface SettleResult {
  stable: boolean
  attempts: number
  waitedMs: number
  fingerprint: string
}

/** 默认 sleep（注入点之外的真实实现）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 观察稳定性判定：连续两次指纹相同即算稳定；超时上限到了就如实返回 stable:false。
 *
 * 为什么要 settle：动作发出去到界面真正变化之间有延迟，直接观察容易拍到中间态。
 * 禁止模型自己轮询/setTimeout，所以等待发生在这里，且必须有上限。
 */
export async function settleObserve<T>(
  snapshot: () => Promise<T>,
  fingerprint: (value: T) => string,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const intervalMs = Math.max(0, Math.round(options.intervalMs ?? 120))
  const timeoutMs = Math.max(intervalMs, Math.round(options.timeoutMs ?? 1500))
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const started = now()
  let previous = fingerprint(await snapshot())
  let attempts = 1
  while (now() - started < timeoutMs) {
    await sleep(intervalMs)
    const current = fingerprint(await snapshot())
    attempts += 1
    if (current === previous) {
      return { stable: true, attempts, waitedMs: now() - started, fingerprint: current }
    }
    previous = current
    if (now() - started >= timeoutMs) break
  }
  return { stable: false, attempts, waitedMs: now() - started, fingerprint: previous }
}

// ── 进程内动作 ────────────────────────────────────────────────────────────

/** 屏幕边界 + 前台窗口，一次进程问清楚（越界判断与白名单判断都要用）。 */
async function probeScreen(signal?: AbortSignal): Promise<ScreenBounds & { foreground: string }> {
  const out = await runPowerShell(
    `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition '${DPI_A}'
Add-Type -TypeDefinition '${WINDOW_TYPE}'
[DscDpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
"$($b.Left),$($b.Top),$($b.Width),$($b.Height)|" + [DscWin]::Describe()
`,
    12000,
    signal,
  )
  // 前台窗口那一段自己可能带竖线（进程|标题），所以只按第一个竖线切
  const parts = out.trim().split('|')
  const geom = parts.shift() ?? ''
  const foreground = parts.join('|')
  const [left, top, width, height] = geom.split(',').map((part) => Number.parseInt(part, 10))
  if ([left, top, width, height].some((value) => !Number.isFinite(value))) {
    throw new Error(`读屏幕边界失败，收到「${out.trim()}」`)
  }
  return { left: left!, top: top!, width: width!, height: height!, foreground }
}

/** 应用白名单：前台窗口的进程名或标题命中白名单才放行。 */
function assertAllowedApp(foreground: string, allowed: readonly string[]): void {
  if (allowed.length === 0) return
  const [processName = '', ...titleParts] = foreground.split('|')
  const title = titleParts.join('|')
  const hit = allowed.some((entry) => {
    const needle = entry.trim().toLowerCase()
    if (needle === '') return false
    return processName.toLowerCase().includes(needle) || title.toLowerCase().includes(needle)
  })
  if (!hit) {
    throw new Error(
      `当前前台窗口是「${title || processName}」，不在你设的应用白名单（${allowed.join('、')}）里，这一步被拦下了`,
    )
  }
}

/** 观察目标窗口的无障碍树（新动作 get_app_state 的实现）。 */
export async function observeAppState(
  options: { window?: number | string; disableDiffing?: boolean; maxElements?: number } = {},
  signal?: AbortSignal,
): Promise<DesktopResult> {
  const sel = options.window
  const isHandle = typeof sel === 'number' || (sel !== undefined && /^\d+$/.test(String(sel).trim()))
  const script = observeScript({
    windowId: isHandle ? Number(sel) : 0,
    windowText: isHandle || sel === undefined ? '' : String(sel),
    maxElements: options.maxElements,
  })
  const raw = await runPowerShell(script, 25000, signal).catch((error: unknown) => {
    throw new Error(`无障碍观察失败：${errText(error)}`)
  })
  // parseFrame 会把新帧写进缓存；基线要在写入之前快照下来（引用拷贝，parseFrame 只 set 不 mutate）。
  const before = new Map(framesByWindow)
  const beforeLatest = latestFrame
  const frame = parseFrame(raw)
  const base = options.disableDiffing === true ? undefined : before.get(String(frame.window.id)) ?? beforeLatest
  let text: string
  if (base !== undefined && base.state_id !== frame.state_id && base.window.id === frame.window.id) {
    const diff = diffFrames(base, frame)
    frame.snapshot_mode = 'diff'
    frame.base_state_id = base.state_id
    frame.diff = diff
    const quiet = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
    text =
      `窗口「${frame.window.title}」（进程 ${frame.app}，句柄 ${frame.window.id}），无障碍观察 ${frame.state_id}，共 ${frame.elements.length} 个控件。\n` +
      (quiet ? '与上次观察相比：**没有变化**（界面稳定）。' : diffText(base, frame, diff)) +
      (frame.snapshot_mode === 'diff' ? `\n（增量模式；需要全树就再调一次 get_app_state 带 disable_diffing:true）` : '')
  } else {
    text =
      `窗口「${frame.window.title}」（进程 ${frame.app}，句柄 ${frame.window.id}），无障碍观察 ${frame.state_id}，共 ${frame.elements.length} 个控件。\n` +
      `元素索引只对「这次观察」有效；界面一变就要重新观察。\n\n${frame.text}`
  }
  return { text, frame }
}

/** 解析窗口选择器，得到句柄 + 标题 + 矩形。 */
async function probeWindow(
  selector: number | string,
  signal?: AbortSignal,
): Promise<{ id: number; title: string; bounds: { x: number; y: number; width: number; height: number } }> {
  const raw = await runPowerShell(probeWindowScript(selector), 12000, signal)
  const data = JSON.parse(raw.trim()) as Record<string, unknown>
  if (data.ok !== true) throw new Error(String(data.error ?? '窗口解析失败'))
  const b = (data.bounds ?? {}) as Record<string, unknown>
  return {
    id: Number(data.id ?? 0),
    title: String(data.title ?? ''),
    bounds: { x: Number(b.x ?? 0), y: Number(b.y ?? 0), width: Number(b.width ?? 0), height: Number(b.height ?? 0) },
  }
}

/** 绑定窗口：解析 `args.window`，返回该窗口的观察帧、矩形与激活脚本片段。 */
async function bindWindow(
  args: DesktopArgs,
  signal?: AbortSignal,
): Promise<{
  frame?: DesktopFrame
  windowBounds?: { x: number; y: number; width: number; height: number } | null
  windowKey?: string
  activateLine: string
}> {
  if (args.window === undefined) return { frame: latestFrame, activateLine: '' }
  const info = await probeWindow(args.window, signal)
  const activateLine = `[DscWin]::SetForegroundWindow([IntPtr]${info.id}) | Out-Null; Start-Sleep -Milliseconds 80`
  return {
    frame: frameForWindow(String(info.id)) ?? latestFrame,
    windowBounds: info.bounds,
    windowKey: String(info.id),
    activateLine,
  }
}

/** 执行点击（内部复用：set_value 回退也要用）。 */
async function clickAt(point: { x: number; y: number }, button: string, double: boolean, activateLine: string, pauseMs: number, signal?: AbortSignal): Promise<void> {
  await runPowerShell(clickScript(point, button, double, activateLine, pauseMs), 15000, signal)
}

/** 执行文本输入（内部复用）。 */
async function typeText(text: string, signal?: AbortSignal): Promise<void> {
  await runPowerShell(typeScript(text), 15000, signal)
}

/**
 * 执行一个桌面动作。
 * @param scale - 上一次截屏的缩放系数（点/滚动的坐标按它换算回物理像素）。
 * @param allowedApps - 应用白名单（进程名或窗口标题的子串）；空数组 = 不限。
 */
export async function runDesktopAction(
  action: DesktopAction,
  args: DesktopArgs,
  options: { scale: number; allowedApps: readonly string[]; actionDelayMs: number },
  signal?: AbortSignal,
): Promise<DesktopResult> {
  const canonical = canonicalAction(String(action))
  if (canonical === null) {
    throw new Error(`不认识的 action「${String(action)}」。要用的值：${DESKTOP_ACTIONS.join(' / ')}`)
  }
  const pauseMs = options.actionDelayMs
  switch (canonical) {
    case 'screenshot': {
      throw new Error('内部错误：screenshot 要走 takeScreenshot()')
    }
    case 'get_app_state': {
      return await observeAppState(
        { window: args.window, disableDiffing: args.disableDiffing === true },
        signal,
      )
    }
    case 'click': {
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const bind = await bindWindow(args, signal)
      const point = resolveTarget(args.target, args, bind.frame, bounds, options.scale, bind.windowBounds)
      const button = String(args.button ?? 'left')
      if (BUTTON_EVENT[button] === undefined) throw new Error(`不认识的鼠标键「${button}」`)
      await clickAt(point, button, args.double === true, bind.activateLine, pauseMs, signal)
      return { text: `已在 ${point.label} ${args.double === true ? '双击' : '单击'}${button}。再截一张确认点中了什么。` }
    }
    case 'drag': {
      const steps = args.amount !== undefined ? Math.min(Math.max(Math.round(args.amount), 2), 200) : 24
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const bind = await bindWindow(args, signal)
      const from = resolveTarget(args.from, undefined, bind.frame, bounds, options.scale, bind.windowBounds)
      const to = resolveTarget(args.to, undefined, bind.frame, bounds, options.scale, bind.windowBounds)
      await runPowerShell(dragScript(from, to, steps, Math.max(8, Math.round(pauseMs / 4))), 20000, signal)
      return { text: `已从 ${from.label} 拖到 ${to.label}（分 ${steps} 步，鼠标已保证抬起）。` }
    }
    case 'type': {
      const text = String(args.text ?? '')
      if (text === '') throw new Error('type 要带 text')
      if (text.length > 4000) throw new Error(`一次最多输 4000 字，这次有 ${text.length} 字，拆开输`)
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const bind = await bindWindow(args, signal)
      if (bind.activateLine !== '') await runPowerShell(`Add-Type -TypeDefinition '${WINDOW_TYPE}'\n${bind.activateLine}\n'Done'`, 12000, signal)
      await typeText(text, signal)
      return { text: `已输入 ${text.length} 个字符（走剪贴板粘贴；原来的文本剪贴板已还原）。` }
    }
    case 'paste': {
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const bind = await bindWindow(args, signal)
      if (bind.activateLine !== '') await runPowerShell(`Add-Type -TypeDefinition '${WINDOW_TYPE}'\n${bind.activateLine}\n'Done'`, 12000, signal)
      const text = args.text === undefined ? undefined : String(args.text)
      await runPowerShell(pasteScript(text), 15000, signal)
      return {
        text: text === undefined
          ? '已按 Ctrl+V 粘贴当前剪贴板内容（没有改动剪贴板）。'
          : `已把 ${text.length} 个字符经剪贴板粘贴进去，并还原了你原来的文本剪贴板。`,
      }
    }
    case 'set_value': {
      const value = String(args.value ?? '')
      const index = args.target?.type === 'element' ? args.target.index : undefined
      if (index === undefined) throw new Error('set_value 要带 {type:\'element\', index} 目标')
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const bind = await bindWindow(args, signal)
      const frame = bind.frame
      // 先确认元素还在（fail-closed）
      resolveTarget(args.target, undefined, frame, bounds, options.scale, bind.windowBounds)
      const winSel = args.window
      const info = await elementAction('set_value', { window: winSel, frame, index, value, pattern: args.pattern }, signal)
      if (info.method === 'none') {
        // 落不到 ValuePattern：回退成「点一下元素再 type」
        const point = resolveTarget(args.target, undefined, frame, bounds, options.scale, bind.windowBounds)
        await clickAt(point, 'left', false, bind.activateLine, pauseMs, signal)
        await typeText(value, signal)
        return { text: `元素 #${index} 不支持直接设值，已回退为「点击后输入」${value.length} 个字符。` }
      }
      return { text: `已把元素 #${index} 的值设为「${value}」（ValuePattern）。` }
    }
    case 'select_text': {
      const index = args.target?.type === 'element' ? args.target.index : undefined
      if (index === undefined) throw new Error('select_text 要带 {type:\'element\', index} 目标')
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const bind = await bindWindow(args, signal)
      resolveTarget(args.target, undefined, bind.frame, bounds, options.scale, bind.windowBounds)
      const info = await elementAction('select_text', { window: args.window, frame: bind.frame, index }, signal)
      if (info.method === 'none') throw new Error(`元素 #${index} 不支持选择文本（没有 TextPattern / SelectionItemPattern）`)
      return { text: `已选中元素 #${index} 的文本（${info.method}）。` }
    }
    case 'perform_action': {
      const index = args.target?.type === 'element' ? args.target.index : undefined
      if (index === undefined) throw new Error('perform_action 要带 {type:\'element\', index} 目标')
      if (args.pattern === undefined || String(args.pattern).trim() === '') throw new Error('perform_action 要带 pattern，例如 invoke / toggle / expand / collapse / select')
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const bind = await bindWindow(args, signal)
      resolveTarget(args.target, undefined, bind.frame, bounds, options.scale, bind.windowBounds)
      const info = await elementAction('perform_action', { window: args.window, frame: bind.frame, index, pattern: args.pattern }, signal)
      if (info.method === 'none') throw new Error(`元素 #${index} 不支持 pattern「${String(args.pattern)}」对应的 UIA 模式`)
      return { text: `已对元素 #${index} 执行 ${String(args.pattern)}（${info.method}）。` }
    }
    case 'key': {
      const keys = toSendKeys(String(args.key ?? ''))
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const bind = await bindWindow(args, signal)
      if (bind.activateLine !== '') await runPowerShell(`Add-Type -TypeDefinition '${WINDOW_TYPE}'\n${bind.activateLine}\n'Done'`, 12000, signal)
      const repeat = args.repeat === undefined ? 1 : Math.min(Math.max(Math.round(args.repeat), 1), 50)
      const hold = args.holdSeconds === undefined ? 0 : Math.min(Math.max(Number(args.holdSeconds), 0), 10)
      await runPowerShell(keyScript(keys, repeat, hold), 15000, signal)
      return { text: `已按键 ${String(args.key)}${repeat > 1 ? ` × ${repeat}` : ''}。` }
    }
    case 'scroll': {
      const amount = assertInt(args.amount ?? 3, 'amount')
      if (Math.abs(amount) > 30) throw new Error('一次最多滚 30 档')
      const bounds = await probeScreen(signal)
      assertAllowedApp(bounds.foreground, options.allowedApps)
      const bind = await bindWindow(args, signal)
      let move = ''
      if (args.target !== undefined || (args.x !== undefined && args.y !== undefined)) {
        const point = resolveTarget(args.target, args, bind.frame, bounds, options.scale, bind.windowBounds)
        move = `[DscMouse]::SetCursorPos(${point.x}, ${point.y}) | Out-Null`
      }
      await runPowerShell(scrollScript(amount, move, pauseMs), 15000, signal)
      return { text: `已滚动 ${amount} 档（正数向上，负数向下）。` }
    }
    case 'cursor': {
      const out = await runPowerShell(
        `
Add-Type -TypeDefinition '${MOUSE_TYPE}'
$p = New-Object DscMouse+POINT
[DscMouse]::GetCursorPos([ref]$p) | Out-Null
"$($p.X),$($p.Y)"
`,
        12000,
        signal,
      )
      const [x = '?', y = '?'] = out.trim().split(',')
      return { text: `鼠标当前位置：屏幕 (${x}, ${y})。` }
    }
    case 'list_windows': {
      const raw = await runPowerShell(listWindowsScript(), 15000, signal)
      const data = JSON.parse(raw.trim()) as Record<string, unknown>
      if (data.ok !== true) throw new Error(`列窗口失败：${String(data.error ?? '未知原因')}`)
      const rawList = data.windows
      const list = Array.isArray(rawList) ? rawList : rawList === undefined || rawList === null ? [] : [rawList]
      if (list.length === 0) return { text: '（没找到带标题的窗口）' }
      const lines = list.map((item) => {
        const w = item as Record<string, unknown>
        const b = (w.bounds ?? {}) as Record<string, unknown>
        const flags = [w.focused === true ? '前台' : '', w.main === true ? '主窗口' : '', w.onscreen === false ? '最小化/屏外' : ''].filter((f) => f !== '')
        return `  id=${String(w.window_id)} [${String(w.app)}] ${w.title === '' ? '（无标题）' : String(w.title)} @ ${b.x},${b.y} ${b.width}×${b.height}${flags.length > 0 ? `（${flags.join('、')}）` : ''}`
      })
      return { text: `窗口清单（id 用作用户 window 参数）：\n${lines.join('\n')}` }
    }
    case 'list_apps': {
      const raw = await runPowerShell(listAppsScript(), 15000, signal)
      const data = JSON.parse(raw.trim()) as Record<string, unknown>
      if (data.ok !== true) throw new Error(`列应用失败：${String(data.error ?? '未知原因')}`)
      const rawList = data.apps
      const list = Array.isArray(rawList) ? rawList : rawList === undefined || rawList === null ? [] : [rawList]
      const lines = list.map((item) => {
        const a = item as Record<string, unknown>
        return `  ${String(a.app)}（pid ${String(a.pid)}）${a.title === '' ? '' : ` — ${String(a.title)}`}${a.foreground === true ? ' 【前台】' : ''}`
      })
      return { text: `有主窗口的应用（进程名 + 主窗口 + 是否前台）：\n${lines.join('\n')}` }
    }
    case 'screens': {
      const raw = await runPowerShell(screensScript(), 12000, signal)
      const data = JSON.parse(raw.trim()) as Record<string, unknown>
      if (data.ok !== true) throw new Error(`枚举显示器失败：${String(data.error ?? '未知原因')}`)
      const rawList = data.screens
      const list = Array.isArray(rawList) ? rawList : rawList === undefined || rawList === null ? [] : [rawList]
      const lines = list.map((item) => {
        const s = item as Record<string, unknown>
        const b = (s.bounds ?? {}) as Record<string, unknown>
        return `  ${String(s.device)}${s.primary === true ? '（主）' : ''} @ ${b.x},${b.y} ${b.width}×${b.height}`
      })
      return { text: `显示器（虚拟屏坐标，可含负坐标）：\n${lines.join('\n')}` }
    }
    case 'stop': {
      throw new Error('内部错误：stop 由插件处理（要联动取消信号与动作面）')
    }
    default: {
      throw new Error(`不认识的 action「${canonical satisfies never}」。要用的值：${DESKTOP_ACTIONS.join(' / ')}`)
    }
  }
}

/** 跑一次元素动作脚本（set_value / select_text / perform_action），返回 {method}。 */
async function elementAction(
  kind: 'set_value' | 'select_text' | 'perform_action',
  input: {
    window?: number | string
    frame?: DesktopFrame
    index: number
    value?: string
    pattern?: string
  },
  signal?: AbortSignal,
): Promise<{ method: string }> {
  const sel = input.window
  const isHandle = typeof sel === 'number' || (sel !== undefined && /^\d+$/.test(String(sel).trim()))
  const script = elementActionScript(kind, {
    windowId: isHandle ? Number(sel) : input.frame?.window.id ?? 0,
    windowText: isHandle || sel === undefined ? '' : String(sel),
    index: input.index,
    value: input.value,
    pattern: input.pattern,
  })
  const raw = await runPowerShell(script, 20000, signal)
  const data = JSON.parse(raw.trim()) as Record<string, unknown>
  if (data.ok !== true) throw new Error(String(data.error ?? '元素动作失败'))
  return { method: String(data.method ?? 'none') }
}

/**
 * 抓一张全屏图（或裁切块）。
 * @returns 图像 data URL + 缩放系数（点坐标要按它换算）。
 */
export async function takeScreenshot(
  options: { maxEdge: number; format: 'jpeg' | 'png'; quality: number; clip?: { x: number; y: number; width: number; height: number } },
  signal?: AbortSignal,
): Promise<DesktopResult> {
  const clip = options.clip
  if (clip !== undefined) {
    for (const [key, value] of Object.entries(clip)) {
      if (!Number.isFinite(Number(value))) throw new Error(`截图的 clip.${key} 要是数字，收到 ${String(value)}`)
    }
    if (clip.width <= 0 || clip.height <= 0) throw new Error('截图的 clip.width / clip.height 要大于 0')
  }
  const out = await runPowerShell(
    screenshotScript(
      Math.min(Math.max(Math.round(options.maxEdge), 640), 3840),
      options.format === 'png' ? 'png' : 'jpeg',
      Math.min(Math.max(Math.round(options.quality), 30), 100),
      clip,
    ),
    30000,
    signal,
  ).catch((error: unknown) => {
    throw new Error(`截屏失败：${errText(error)}`)
  })
  const trimmed = out.trim()
  const at = trimmed.indexOf('|')
  if (at < 0) throw new Error(`截屏返回看不懂的格式：${trimmed.slice(0, 60)}`)
  const head = trimmed.slice(0, at)
  const base64 = trimmed.slice(at + 1)
  const nums = head.split(',').map((part) => Number.parseInt(part, 10))
  const [imageWidth = 0, imageHeight = 0, clipWidth = 0, clipHeight = 0, originX = 0, originY = 0, vLeft = 0, vTop = 0, vWidth = 0, vHeight = 0] = nums
  if (base64 === '') throw new Error('截屏是空的')
  const sourceWidth = clipWidth || imageWidth || vWidth
  const scale = sourceWidth > 0 ? sourceWidth / (imageWidth || sourceWidth) : 1
  const mime = options.format === 'png' ? 'image/png' : 'image/jpeg'
  const regionText = clip === undefined
    ? `整个桌面`
    : `裁切区域（相对虚拟屏左上角 ${vLeft},${vTop}）起点 (${originX}, ${originY}) 大小 ${clipWidth}×${clipHeight}`
  return {
    text:
      `这是${regionText}的截图，图片尺寸 ${String(imageWidth)}×${String(imageHeight)}；` +
      `虚拟屏分辨率 ${String(vWidth)}×${String(vHeight)}，起点 (${String(vLeft)}, ${String(vTop)})。` +
      `要点的坐标用这张图上的像素值（坐标相对裁切区域左上角），Pneuma 会换算（当前换算系数 ${scale.toFixed(2)}）。` +
      `鼠标现在指的位置可用 cursor 查。`,
    images: [`data:${mime};base64,${base64}`],
    scale,
  }
}

/** 前台窗口是谁（白名单提示与自查用）。 */
export async function foregroundWindow(signal?: AbortSignal): Promise<string> {
  const bounds = await probeScreen(signal)
  return bounds.foreground
}

/** 枚举显示器（screens 动作的独立入口，自检/诊断用）。 */
export async function listScreens(signal?: AbortSignal): Promise<ScreenInfo[]> {
  const raw = await runPowerShell(screensScript(), 12000, signal)
  const data = JSON.parse(raw.trim()) as Record<string, unknown>
  if (data.ok !== true) throw new Error(String(data.error ?? '枚举显示器失败'))
  const rawList = data.screens
  const list = Array.isArray(rawList) ? rawList : rawList === undefined || rawList === null ? [] : [rawList]
  return list.map((item) => {
    const s = item as Record<string, unknown>
    const b = (s.bounds ?? {}) as Record<string, unknown>
    return {
      device: String(s.device ?? ''),
      primary: s.primary === true,
      bounds: { x: Number(b.x ?? 0), y: Number(b.y ?? 0), width: Number(b.width ?? 0), height: Number(b.height ?? 0) },
    }
  })
}

// ── 危险分级与独立审计 ────────────────────────────────────────────────────

/** 「系统级」动作的命中形状：任务管理器、注册表、命令解释器、系统配置工具这类。 */
const SYSTEM_HINTS =
  /(taskmgr|任务管理器|regedit|注册表|reg\.exe|reg\.exe|taskkill|cmd\.exe|powershell|pwsh|wscript|cscript|mshta|rundll32|control\.exe|services\.msc|gpedit|secpol|diskmgmt|bcdedit|diskpart|net\.exe|net\s+user|shutdown|format\.com|lusrmgr|userpasswords)/i

/**
 * 危险分级：
 *   - `read`：只读观察（截图/查鼠标/列窗口/列应用/列显示器/get_app_state），免审批那一档；
 *   - `input`：普通输入与点击（要审批）；
 *   - `system`：系统级（急停 stop，或目标/文本命中系统工具形状），最严。
 */
export function gradeDesktopAction(action: DesktopAction, args: Record<string, unknown> = {}): DesktopRiskTier {
  if (action === 'stop') return 'system'
  if (READ_ACTIONS.includes(action)) return 'read'
  let blob = ''
  try {
    blob = JSON.stringify(args ?? {})
  } catch {
    blob = String(args)
  }
  if (SYSTEM_HINTS.test(blob)) return 'system'
  return 'input'
}

/** 一行电脑操作审计记录。 */
export interface ComputerAuditRecord {
  /** 毫秒时间戳。 */
  ts: number
  action: string
  /** 危险分级（read/input/system）。 */
  risk: DesktopRiskTier
  /** 目标摘要（坐标/元素/窗口）。 */
  target: string
  /** 结果。 */
  result: 'ok' | 'error'
  /** 是否过了审批（只读观察 = false）。 */
  approved: boolean
  /** 失败原因或补充说明。 */
  detail?: string
}

/** 电脑操作审计文件：`<home>/audit/computer-use.jsonl`（home 来自 ctx.settings.about().home，不硬编码）。 */
export function computerAuditPath(home: string): string {
  return join(home, 'audit', 'computer-use.jsonl')
}

/** 把一条审计记录压成一行 JSON（含换行；自检直接断言这一行的形状）。 */
export function auditLine(record: ComputerAuditRecord): string {
  return `${JSON.stringify(record)}\n`
}

/** 追加一行审计（写失败吞掉：审计是辅助面，不该卡住动作）。 */
export function appendComputerAudit(home: string, record: ComputerAuditRecord): void {
  try {
    const path = computerAuditPath(home)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, auditLine(record), 'utf8')
  } catch {
    // 磁盘问题不影响动作本身
  }
}

/**
 * 沙箱接入结论（P2-8，如实记录）：
 *
 * 现有的沙箱执行缝是 `src/core/tools/command-runner.ts` 的 `planCommand`，
 * 它是为「命令执行工具」换执行体设计的。电脑操作的 PowerShell **不能**走这条缝，原因是
 * 结构性的、不是偷懒：
 *   1. 隔离后端（docker 容器 / Windows 受限令牌）拿不到**交互式用户桌面**——
 *      容器里没有 user32 的桌面对象，受限令牌换了会话也就没有输入注入能力，
 *      真接上去的结果是电脑操作直接不可用；
 *   2. `command-runner` 的 base 计划是「一条 shell 命令」，而电脑操作是一串
 *      P/Invoke 脚本，语义对不上（容器后端会把 `powershell -Command <脚本>` 再套一层 shell）；
 *   3. 沙箱守卫链按 `input.command` 判 exec 类，`computer` 工具没有 command 参数，
 *      策略层天然看不到它——它不是「漏判」，而是这类动作本就不该由命令沙箱兜。
 * 因此保持现状：电脑操作由审批卡 + 应用白名单 + 危险分级 + 独立审计兜底。
 */
export const SANDBOX_NOTE = '桌面控制的 PowerShell 不走命令沙箱执行缝（隔离后端拿不到交互式桌面）；由审批 + 白名单 + 危险分级 + 独立审计兜底。'
