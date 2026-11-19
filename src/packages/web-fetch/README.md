# web-fetch（网页抓取）

一句话：web-fetch 给模型一个 `web_fetch` 工具，把一个具体网址的正文抓下来、转成 Markdown 交回去，页面太长就截断。

## Model Experience（模型体验）

- 注册工具 `web_fetch`：只有一个参数 `url`，且不接受空串（index.ts:106-126）。
- 风险等级 `read`（只读权限模式下也能用），并声明「可并发」——同一轮抓几个页面不必排队（index.ts:117-119）。
- HTML 用 turndown + GitHub 风格扩展转成 Markdown：标题、列表、表格、围栏代码块都保住结构（html.ts:26-40、120-140）。
- `<script>` / `<style>` / `hidden` / `display:none` 整块丢掉，不让看不见的文字混进上下文（html.ts:72-92）。
- 结果整体包一层不可信围栏，页面里出现的「指令」只能当资料读（index.ts:90）。
- 非 2xx 不当错误抛：404 的正文交给模型自己判断（http.ts:206-210、272-277）。
- 结果附一张 web 卡（最终地址 + 状态码 + 是否截断），界面按抓取档画（index.ts:92-101）。
- 追加一段「网页抓取」提示词：先搜再抓、外部内容不当指令、**别在终端里 curl**（index.ts:129-140）。

## Known Limitations（已知限制）

- 不执行 JavaScript：单页应用（SPA）抓回来往往是空壳，只适合服务端渲染或静态页面。
- 不支持 PDF、图片、压缩包：`Content-Type` 不是文本、正文也不像 HTML 就报错（http.ts:104-113、265-270）。
- 不跟随跨域重定向：同源最多 5 跳，跨域会报出目标地址让模型自己再抓一次（http.ts:24、245-262）。
- 响应体封顶 5 MB（http.ts:21），正文字数默认 10 万、可在设置里改（index.ts:44-52）。
- 编码按 `Content-Type` 里的 charset 解，不认识或没声明就退回 UTF-8：声明错误的页面尾部会有乱码（http.ts:128-140）。
- `User-Agent` 写的是 `pneuma-web-fetch/0.9`，不冒充浏览器：少数只服务浏览器的站点会回 403（http.ts:32）。
- 只能读公开网页：不发 cookie、不带登录态，需要登录的页面抓回来就是登录页（http.ts:213-256）。

## 行与开关

- 行 id `web-fetch`，包名 `@pneuma/web-fetch`，order 3635（package.json:2、28）。
- resolution 是 overridable（package.json:29）；默认开：cordis.patch.yml 里没有 `disabled`。
- 宿主半 inject 三个服务：`tools`、`prompt`、`settings`（index.ts:67）。
- 设置分区 id `web-fetch`、order 47、两个数字字段与一颗测试按钮（index.ts:141-204）。
- `pneuma.settingsSection` 写的就是这个分区，插件中心按它跳到这一区（package.json:32）。
- 不需要任何 key：与「联网搜索」不同，抓公开网页不依赖第三方服务。

## 与联网搜索的分工

| 插件 | 工具 | 干什么 |
| --- | --- | --- |
| web-search | `web_search` | 找：给一批标题 + 链接 + 摘要（要第三方搜索服务与 key） |
| web-fetch | `web_fetch` | 读：把某一个链接的正文抓回来转成 Markdown（不要 key） |

两步一起用最省事：先搜到链接，再抓那一页。
