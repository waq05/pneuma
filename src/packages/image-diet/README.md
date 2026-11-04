# image-diet（图片卸载）

一句话：image-diet 包把「每轮图片按龄、按预算卸载」的四个旋钮交给设置界面，卸载本体是一条内核投影。

## Model Experience（模型体验）

- 不注册工具，也不加提示词：它只注册一个设置分区，四个控件——总开关、用户图预算、工具图预算、保留回合数（index.ts:32-66、68-102）。
- 真正的卸载在内核投影里：名称 `image-diet`、order 550，排在 env-facts（600）与 drop-images（900）之前（prompt/index.ts:208-215）。
- 卸载方式对模型可见：把 `image_url` 部件原地换成一句「（图片已卸载，原文里这里是一张图）」，不删消息、不改 role 序列（core/image-diet.ts:16、24、145-160）。
- 省下来的量：一张 JPEG 截图的 base64 有 100~300KB，换成一句 19 个字的占位（core/image-diet.ts:4-6、24）；缺省口径是留最近 2 个用户回合、用户图 4 张、工具图 2 张（core/image-diet.ts:37、52）。
- 停用之后：设置页里这一块消失，但卸载照常按缺省口径跑——投影登记在 prompt 插件里，不依赖这个包。

## Known Limitations（已知限制）

- 只动发给模型的那一份副本：日志原文一个字不改，删消息会留下配不上对的 tool_call，端点会直接 400（core/image-diet.ts:13-16）。
- 只认 user 与 tool 两种角色的图；assistant 里出现的图不在契约范围内，原样留着（core/image-diet.ts:88-90）。
- 四个控件有硬区间：两张数各 0~20、回合数 0~50，超出被夹回来；配置读不出来就回落缺省，不让一轮请求失败（core/image-diet.ts:40-44、58-68）。
- keepRounds 按「用户消息条数」算，不是按真人回合数：它排在 env-facts 之前，所以那条合成的环境快照不会白占一格；顺序颠倒时口径会偏保守一格（prompt/index.ts:205-207、core/image-diet.ts:104-105）。
- 卸载是幂等的：再跑一遍找不到 `image_url`，输出逐字节相同（core/image-diet.ts:88）。

## 行与开关

- 行 id `image-diet`，包名 `@pneuma/image-diet`，order 170。
- resolution 是 overridable（core/plugin-loader.ts:1394）。
- 默认开：cordis.patch.yml 里没有 `disabled`，配置里 `enabled` 缺省也是 true（core/image-diet.ts:52）。
- inject 一个服务 `settings`（index.ts:27），不 provide 任何东西。
- 设置分区 id `image-diet`、order 38（index.ts:68-72）；配置落在 `~/.dsc/plugins.json` 的 `image-diet` 条目，投影每轮现读，保存后下一轮就生效（index.ts:6-8；prompt/index.ts:210-213）。
