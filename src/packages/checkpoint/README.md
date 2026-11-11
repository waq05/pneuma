# checkpoint（回合快照）

一句话：checkpoint 包在每个回合开始前与收工后各拍一张影子 git 快照，仓库放在 `~/.dsc/checkpoints/`，不碰用户工作区里自己的 `.git`。

## Model Experience（模型体验）

- 不注册工具、不写系统提示：模型看不到快照，也拿不到快照内容；它照常读写工作区。
- 回合开始与结束各拍一张（`index.ts` 的 `dsc/turn-start` / `dsc/turn-end` 两个监听），回合号存在影子目录的 `state.json` 里，每回合显式 +1，不从消息数推算（压缩会改消息数）。
- 快照是旁路：同一时刻只跑一张，撞上了就跳过并记一条 debug；任何失败都不会让回合失败，会话流里最多提醒一次。
- 影子仓库超过设置的上限后自动停用，并往会话流说一次；模型与用户都会看到那一句，之后 `/checkpoint` 里仍能查到已有快照。
- 用户敲 `/checkpoint` 时才会看到仓库路径、回合数与占用；这一批 `restore` 只回一句「下一批才可用」，不会动任何文件。

## Known Limitations（已知限制）

- 读不受限：`git add -A` 会读工作区里所有没被 `info/exclude` 排除的文件（`node_modules`、`dist`、`.git`、`<DSC_HOME>` 等除外），不按内核的读禁清单过滤；快照只落在本机 `~/.dsc`。
- 不覆盖 bash 直接改写但未提交的中间态：一个回合里连续改十次文件，也只有回合前、回合后两张快照，中间那九次没有单独记录。
- 大文件与二进制按原样存：不压缩、不跳过，仓库占用会随文件体积上涨；超过上限（默认 512MB）就停用。
- `restore` 下一批才有：这一批只做仓库与快照，三方合并（保住用户手改的部分）还没做。
- 只拍当前会话的回合：回合事件带别的会话归属时直接跳过（`inject` 里没有按 id 找会话的服务），后台会话的回合不会在这里留下快照。

## 行与开关

- 行 id `checkpoint`，包名 `@pneuma/checkpoint`，order 335。
- resolution 是 overridable；默认开：cordis.patch.yml 里没有 `disabled`。
- inject 四个服务：`session`、`commands`、`settings`、`transcript`；设置分区 id `checkpoint`，`/checkpoint` 命令支持 `status`、`list [条数]`、`restore <回合>`。
- 影子仓库的路径口径在 `shadow.ts` 的 `shadowRoot()`：`<DSC_HOME>/checkpoints/<目录名>-<路径 sha1 前 8 位>`。
