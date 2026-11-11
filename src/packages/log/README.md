# @pneuma/log — 运行日志

> 把内核日志落到 `~/.dsc/logs`，给 `/log` 与后续的 `/doctor` 一个读入口。

## 为什么要有这个包

没有它的时候，`ctx.logger` 只往内存环形缓冲里写 1000 条，进程一退就没了。用户报「刚才闪退」
时，能拿到的只有一句话。这个包做三件事：

1. **落盘**：按天分目录、写满轮转、总量封顶，不会把磁盘写满；
2. **脱敏**：`sk-`、`Authorization:`、`Bearer`、`api_key=` 四类外形在写盘前就被抹掉；
3. **留现场**：`uncaughtException` / `unhandledRejection` 会先同步落一条再退出。

## 装在哪

`cordis.patch.yml` 只有一行，`pneuma.order` = 5——比 `llm`（10）还早，启动期那几行才接得住。

`inject: ['commands', 'settings']`：这两个服务就绪之前它不 apply，所以 order 100 / 160 之前
的启动日志目前记不到。这是已知取舍，不是 bug。

## 写在哪

```
~/.dsc/logs/<YYYY-MM-DD>/dsc-<pid>.jsonl
```

- 一天一个目录，删旧数据就是整目录删；
- 一个进程一份文件（桌面主进程 / utilityProcess / TUI 各写各的，不争句柄）；
- 每行一条 JSON：`{ t, lvl, name, sn, msg }`。

## 上限

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 级别 | `info` | `error` / `warn` / `info` / `debug` / `off` |
| 单文件 | 8 MiB | 写满轮转到 `.jsonl.1`，只留一份历史 |
| 保留 | 10 天 | 按天目录整目录删 |
| 总量 | 64 MiB | 超了从最旧的一天删起，今天永远不删 |

级别、目录、天数、两个上限都能在**设置 → 运行日志**里改；`DSC_LOG` 环境变量优先于设置，
排障时人手敲的那一条不会被上次点过的设置盖掉。

## 接口

```ts
ctx.log.file()          // 当前文件绝对路径
ctx.log.dir()           // 根目录
ctx.log.level()         // 'info' | … | 'off'
ctx.log.tail(20)        // 最近 n 条，已脱敏、已渲染成一行
ctx.log.flush()         // 立刻刷盘
```

`ctx.log` 声明为可选（`log?: LogService`）：这个插件允许被停用，别的插件读它要用 `ctx.get('log')`。

## 命令

`/log [条数]` —— 打印当前文件、级别、保留策略，再列最近几条（最多 200）。

## 验证

```powershell
# 有内容
dir "$env:USERPROFILE\.dsc\logs" -Recurse -Filter *.jsonl

# 不该有密钥（期望 0 命中）
Select-String -Path "$env:USERPROFILE\.dsc\logs\*\*.jsonl" -Pattern 'sk-[A-Za-z0-9]{8}'

# 包内测试
node --test src/packages/log/tests/log.test.mjs
```

## Model Experience（模型体验）

- **模型碰不到这个包**：它不注册任何工具，也不往提示词里加一个字。`/log` 是给人用的命令，
  模型既看不见日志文件，也不会收到它的内容。
- 模型那一轮产生的工具调用与耗时，会由内核自己的 `ctx.logger` 记下来进日志——那是**观测**，
  不是给模型看的上下文，所以不占 token，也不改变请求。
- `debug` 级别会连请求正文一起落盘。开它之前要想清楚：正文里可能有用户贴进来的代码与数据，
  日志文件是明文的（只抹凭据，不脱敏业务内容）。

## Known Limitations（已知限制）

- **启动早期的日志接不到**：`inject` 了 `commands` / `settings`，这两个服务就绪（order 100 / 160）
  之前的日志只留在内存环形缓冲里，不落盘。要补这一段，得把这个包拆成「采集」与「面板」两个包。
- **只留一份历史**：单文件写满只轮转到 `.jsonl.1`，更早的覆盖掉。要按「这一次运行」整段回看，
  得在轮转前先把文件另存——现在没有这个入口。
- **脱敏是外形匹配**：认的是 `sk-` / `Authorization:` / `Bearer` / `api_key=` 四类写法。
  自定义凭据格式（例如放在 URL query 里的 token）不在覆盖范围内，`debug` 级别尤其要注意。
- **桌面端三进程各写一份**：主进程、utilityProcess、TUI 各自一份 `dsc-<pid>.jsonl`，
  看一次完整的启动要按时间把几份并起来，没有合并视图。
- **不做 SQLite 索引**：只按天目录 + 文本检索，跨天关键词搜索要自己 `Select-String` 扫目录。

## 已知不做

- 不做 SQLite 日志库：个人版每天 MB 级，JSONL + 文本检索够用；
- 不做远程上报：默认把日志上传出去，对个人工具是惊吓不是功能；
- 不做按小时分片：一天一个目录已经够小，再细清理逻辑就会长成一棵树。
