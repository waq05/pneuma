# remote（远程操控）

一句话：remote 包把这条会话开给同一局域网里的手机浏览器，管谁伺服、谁能进来、进来能做什么、有事怎么通知。

## Model Experience（模型体验）

- 不注册工具、不注册提示段、不做投影：它对模型没有直接贡献，全部工作在 HTTP / WebSocket 服务与界面快照上（index.ts:427-431）。
- 手机端默认拿到与桌面同源的插件壳；经典档（remote-web 自己的移动端应用）留在 `DSC_REMOTE_UI=classic` 或配置 `ui: 'classic'` 后面（文件头 37-42）。
- 唯一碰得到模型可见面的地方：命令输出经 `transcript.system` 落成会话条目，手机与桌面读同一份（index.ts:80）。
- 停用之后，模型侧没有变化：不注册工具与提示段，也就没有可少的东西；用户侧失去手机接入、审批卡与轮完成的推送（文件头 1-4、20-22）。

## Known Limitations（已知限制）

- 默认关：偏好里 `remote.enabled` 是 false，要用户在设置里打开（core/prefs.ts:316）。
- 进门的规矩：配对码 8 位、30 分钟有效、错 5 次锁 1 小时，明文码与 token 只落 sha256、码不进 transcript；所有路由都查 Host 头，必须是 IP 字面量或 localhost 且端口对得上，用来挡 DNS rebinding（文件头 11-14，core/remote/pairing.ts:26-38）。
- 只开一份方法白名单：凭据类（saveProvider / setProviderKey / setSettingValue / runSettingAction）与宿主生命周期（dock / exit）一律不开放（文件头 16-18）。
- 同一台机器只允许一个进程听端口：先抢 `~/.dsc/remote/.owner.json` 主控位，抢不到就完全休眠、每 30 秒回头看一次（文件头 6-9、index.ts:96）。
- 通知有节流：同类推送 10 秒一次，卡挂满 120 秒还没人理最多再提醒 3 声，短于 15 秒的轮不通报（index.ts:98-106）。
- 帧协议只留最近 120 帧：客户端带的 `lastSeq` 落在缓冲窗口外就回落成 hello + 一帧全量（文件头 24-32）。

## 行与开关

- 行 id `remote`，包名 `@pneuma/remote`，order 9020。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 插件默认挂载（`cordis.patch.yml` 里没有 `disabled`），但远程功能默认关，要开 `prefs.remote.enabled`（core/prefs.ts:316）。
- inject 六个服务：`session`、`transcript`、`agent`、`ui`、`approval`、`settings`（index.ts:431）。
- 设置分区 id `remote`，order 40；默认端口 17321，可填 1024..65535（index.ts:836-857，core/prefs.ts:101-103）。
- package.json 的 `pneuma.title` 现在写着包名 `remote`，没写中文名；设置页里它叫「远程控制」。
