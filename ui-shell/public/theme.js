/**
 * 首帧的主题与画布底色：**必须内联执行、必须在样式之前**——晚一步就会白闪/深闪。
 *
 * 为什么要单独一个文件而不是写在 `index.html` 里：界面服务的 CSP 是 `script-src 'self'`
 * （见 `src/core/ui-server.ts` 的 `UI_CONTENT_SECURITY_POLICY`），内联脚本会被浏览器拦掉。
 * 拦掉的表现不是报错页，而是**主题回到默认色、启动占位的兜底计时器不跑**——只有控制台里
 * 一行 CSP 警告。所以搬成同源外链：普通脚本（不带 defer/async）仍会在样式之前执行。
 *
 * 桌面端在地址上带 theme（主进程读 ~/.dsc/settings.json，见 THEME_PAINT）；
 * 手机浏览器里没有这个参数，就按系统深浅走。三套颜色与主进程那份保持一致：
 * 深色 #151517 / 浅色 #f8f9fe / 米白 #faf9f5。
 */
;(function () {
  var colors = { dark: '#151517', light: '#f8f9fe', claude: '#faf9f5' }
  var accents = { dark: '#5686fe', light: '#0053fd', claude: '#d97757' }
  var match = /[?&]theme=(dark|light|claude)/.exec(window.location.search)
  var mode = match === null ? null : match[1]
  if (mode === null) mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  var root = document.documentElement
  root.dataset.theme = mode
  root.style.backgroundColor = colors[mode]
  root.style.setProperty('--boot-page', colors[mode])
  root.style.setProperty('--boot-ink', mode === 'dark' ? '255,255,255' : '0,0,0')
  root.style.setProperty('--boot-accent', accents[mode])
  // 兜底：界面脚本要是没起来（打包坏了 / 解析失败），8 秒后把占位让开，
  // 别让它一直盖着错误提示。
  window.setTimeout(function () {
    var splash = document.getElementById('boot-splash')
    if (splash !== null) splash.remove()
  }, 8000)
})()
