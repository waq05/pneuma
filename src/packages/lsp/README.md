# lsp（代码跳转与报错）

一句话：lsp 包给模型一个按符号位置查询语言服务器的工具，并在它写完文件后把这次新引入的报错补进下一次请求。

## Model Experience（模型体验）

- 注册工具 `lsp`：operation 四选一（goToDefinition / findReferences / goToImplementation / hover），line 与 character 都从 1 数，risk 标 read 因此免审批直接放行；结果每条形如 `path:line:character`（index.ts:273-304）。
- 提示词贡献一：系统提示一段，order 42，共六行，讲清「普通导航先用 grep / glob / read，文本匹配有歧义才用 lsp」与一基坐标；总开关关掉时这段返回空串（index.ts:704-711、218-226）。
- 提示词贡献二：投影 `lsp-write-diagnostics`，把本次改动新引入的 ERROR 以 user 角色补在请求末尾，同时 `appendNote` 落一条日志，保证模型看见的都进得了会话记录（index.ts:202-214、486-492）。
- 只算差值：写前由守卫 order 7 同步读下文件内容并把基线诊断入队，写后由观察者 order 46 取一次，按行位移映射做集合差，被插入行推下去的旧报错不算新错误（index.ts:410-439、467-493）。
- 停用之后，模型侧少掉：`lsp` 工具与那六行用法说明，以及每次写文件后的报错提醒；已起的语言服务器子进程随插件卸载收掉（index.ts:230-241）。

## Known Limitations（已知限制）

- 只做导航四件事，rename / codeAction / format 一概不做（文件头 6-8）。
- 同步策略是「读盘 → didOpen 全量 → 请求 → didClose」，所以它只看得见落盘的内容，编辑器里未保存的改动它不知道（文件头 9）。
- 硬上限：单次定位 100 条（可调 1..1000）且总计 16000 字符；诊断每文件 20 条、整块 4000 字符、消息 300 字（index.ts:72-89、355-382）。
- 语言服务器 idle 600 秒回收（下限 30 秒），启动失败对破键退避，单次请求预算 60 秒；返回慢或起不来时只会降级，不会重试到成功（文件头 10-11）。
- 降级永不抛错：没装、起不来、没有项目根都回「没有数据：原因 + stderr 尾巴 30 行」，模型只能改走 grep 与 read 这类文本搜索（文件头 12-13、337-341）。

## 行与开关

- 行 id `lsp`，包名 `@pneuma/lsp`，order 3730。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认关：`cordis.patch.yml` 第 5 行写着 `disabled: true`，文件头第 2 行也注明了默认关的理由（会拉起语言服务器子进程）。
- inject 六个服务：`tools`、`settings`、`transcript`、`guards`、`prompt`、`session`（index.ts:165）；对外提供 `lsp` 服务（index.ts:228）。
- 设置分区 id `lsp`，order 33，五项可改（总开关、服务器清单 JSON、idle 秒数、编辑后是否注入诊断、单次条数）加一个「看服务器状态」按钮（index.ts:533-644）。
