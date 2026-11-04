# ui-preview（文件预览）

一句话：ui-preview 是文件预览这个界面单元的宿主半，在右侧 dock 里画两种页签——预览（按类型渲染一个文件）与补丁（画某次 write/edit 的差异快照）。

## Model Experience（模型体验）

- 不注册工具，也不贡献提示词：宿主半只有空 `apply`，界面半只报名两个 dock 页签（index.ts:29，ui/ui.tsx:63、66）。
- 模型改过的文件在这里能整块看：预览页签经 `dock` 的 `fs-read` 拿回 text / image / bytes / binary 四种形状，markdown、PDF、表格、代码、图片各走一条渲染（ui/ui.tsx:9-17、46-55、228-260）。
- 补丁页签不读盘：它画的是随工具结果来的 unified hunks，模型改了哪个文件、哪几行，用户看到的就是那份快照（ui/ui.tsx:64-66）。
- 模型侧没有任何输入来自这里：停用后模型照常跑，少的只是这两个页签（index.ts:7-9）。

## Known Limitations（已知限制）

- 图片超过 5MB、PDF 与表格超过 10MB 时只显示大小，不读内容（ui/ui.tsx:229-234、src/packages/desktop-dock/index.ts:391、397）。
- 二进制文件、以及没有专门视图的 bytes 只给一句「用系统打开」，不猜内容（ui/ui.tsx:243-257）。
- CSV/TSV 首行当表头，超过 500 行 × 100 列的部分被截断（ui/ui.tsx:15）。
- 预览页签不 keepMounted：切走就卸、切回重读盘，省一份常驻监听（ui/ui.tsx:62）。
- 「系统打开」走桌面原生桥，浏览器页签与远程页里没有这条桥（ui/ui.tsx:83、111、168）。

## 行与开关

- 行 id `ui-preview`，包名 `@pneuma/ui-preview`，order 357（package.json:2、15）。
- resolution 是 overridable（package.json:16）；默认开，cordis.patch.yml 里没有 `disabled`。
- `dsh.client`：platform `pneuma`、api `^0.8.1`，没有 phase 与 inject（package.json:20-24）。
- 宿主半 inject 零个服务：`apply` 不碰 `ctx`（index.ts:29）。
- 停用后在插件中心少这一行，内置产物按 `isPluginEnabled('ui-preview')` 被滤掉（index.ts:7-9，core/ui-bundles.ts:903）。
