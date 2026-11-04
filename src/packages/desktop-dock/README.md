# desktop-dock（桌面能力桥）

一句话：desktop-dock 包提供 `dock` 服务，把当前会话工作目录内的文件系统、git 与终端三档能力开给桌面端的 dock 面板。

## Model Experience（模型体验）

- 不注册工具：它 provide 一个 `dock` 服务，调用方是渲染层的 `DscRuntime.dock(op, payload)`（index.ts:269-271）。
- 提示词贡献为零：没有 `ctx.prompt` 调用，也没有注册任何投影或环境事实。
- 对模型唯一的影响在闸门：写类 op 走 `approval.decide`，与工具调用同一套裁决，所以面板里点一下暂存也会占用审批卡（index.ts:312-325）。
- 三档：读类直接放行，写类先过审批，终端那档不进界面 HTTP 面、只从桌面窗口的原生桥进来（core/dock-ops.ts:12-21）。
- 停用之后，模型侧什么都不少；少掉的是桌面端的文件面板、差异页与终端（`dock` 服务没人 provide）。

## Known Limitations（已知限制）

- 路径限定在当前会话的工作目录内：越界读写与起终端一律报「路径超出工作目录」（index.ts:5、333、366）。
- 硬上限：fs-read 文本 ≤512KB、图片 ≤5MB、PDF/XLSX 整读 ≤10MB、fs-list 默认 2000 条（index.ts:5-6、367）。
- 「全部改动」里合成的未跟踪段：单文件 512KB，合计最多 40 个文件 / 2MB，防一次点开撑爆 payload（index.ts:98-100）。
- 终端是管道模式、没有 tty，交互式全屏程序不可用（index.ts:329）。
- 审批服务没起来时写操作直接拒，不在没有闸门的情况下改仓库（index.ts:310、317-318）。
- 参数净化拒绝空字节、换行与以 `-` 开头的值，挡的是选项注入（index.ts:26-32）。

## 行与开关

- 行 id `desktop-dock`，包名 `@pneuma/desktop-dock`，order 310。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认开：cordis.patch.yml 里没有 `disabled`。
- inject 零个服务：它不声明 inject，用 `ctx.get('session')` / `ctx.get('approval')` 现场取，取不到就落回启动目录或直接拒绝（index.ts:271、290-296、312-318）。
- 工作目录基准是当前会话的 cwd，取不到才用挂载时的进程目录——常驻多会话下进程 cwd 只是「宿主从哪启动的」（index.ts:279-296）。
