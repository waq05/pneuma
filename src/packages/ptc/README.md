# ptc（PTC 代码调用）

一句话：ptc 包注册 `run_code` 工具，让模型写一段 JavaScript 在代码里批量调工具，只把结论交回上下文。

## Model Experience（模型体验）

- 注册工具 `run_code`：参数 `code` 是一段 JavaScript 函数体（可以直接 await、可以 return），risk 标 exec，并带 `presets: ['ptc']`——只在 PTC 模式下露头（index.ts:362-384）。
- 脚本里用 `sdk.<工具名>(参数)` 调工具，另有两个查目录的助手 `sdk.list()` 与 `sdk.describe(name)`（index.ts:306-321）。
- 提示词贡献：工具说明本身就约 20 行，写清怎么调、被拒长什么样、三条硬上限，以及「同进程 vm、出口只有 sdk」（index.ts:38-55）。
- 每次内部调用照旧过守卫链与审批卡：被拒的那条返回「【被拒绝】原因」给脚本，脚本自己决定停不停（index.ts:261-268）。
- 每次调用的名字、参数、成败、耗时与 console.log 都进 `run_code` 的结果正文，不各插一条 tool 记录，保证重放出来的请求成对（文件头 11-13、index.ts:358）。
- 停用之后，模型侧少掉 `run_code`：PTC 模式里只能一轮调一个原生工具，批量任务的结果要逐个进上下文（index.ts:362-384）。

## Known Limitations（已知限制）

- 隔离是进程内 `node:vm`：拿不到 process / require / 文件系统，但没有进程级隔离，dsh 那边用的是子进程沙箱（文件头 17-19）。
- 硬上限五个：一段脚本最多 200 次工具调用、同步段 15 秒、整段 300 秒（可配 30 秒..15 分钟）、交回正文 20000 字符、console 只留最后 50 行（core/ptc.ts:29-46、index.ts:124）。
- 等人时停表只认得出的等待：声明了 `waitsForHuman` 的工具与守卫链弹卡才停，脚本自己 `await sleep(60000)` 照样计入时限（index.ts:57-66、273-275）。
- 写与执行调用独占：脚本里 `Promise.all([sdk.write(…), sdk.write(…)])` 不会并发落盘；读调用之间才并发（index.ts:176-181）。
- 图进不到脚本：工具返回的图脚本里看不到，只在记录里注一句「返回了 N 张图」（index.ts:288-295）。

## 行与开关

- 行 id `ptc`，包名 `@pneuma/ptc`，order 150。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认开：`cordis.patch.yml` 里没有 `disabled`；但工具带 `presets: ['ptc']`，别的模式里模型看不见它（index.ts:378）。
- inject 三个服务：`tools`、`guards`、`transcript`（index.ts:143）。
- 没有设置分区：时限从条目树 config 的 `deadlineMs` 读，下一次跑脚本就生效（index.ts:120-139）。
