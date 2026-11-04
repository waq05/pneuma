# ops（文档与批量读取）

一句话：ops 包把 dsh-ops 的 Rust worker 包成十三个工具，让模型能读 PDF / Word / CSV、一次读多段文件、动手前先看差异。

## Model Experience（模型体验）

- 注册十三个工具：只读七个 `ops_read_pdf`、`ops_read_docx`、`ops_read_table`、`ops_read_files`、`ops_diff`、`ops_stat`、`ops_inspect_local_file`（tools.ts:203-393）。
- 写类六个 `ops_write_file`、`ops_edit_file`、`ops_copy`、`ops_move`、`ops_remove`、`ops_replace`，全部 risk 标 write，并带修订锚与 `dryRun`（tools.ts:426-625、index.ts:59）。
- 提示词贡献：一段 order 60 的系统提示，说清「文档与批量读优先用 ops，普通代码仍用内置 read」，只在 worker 真的找到时才挂（index.ts:124-133）。
- 找不到 worker 时一个工具都不注册，往会话流里说一句缺什么、怎么补，并在设置页列出找过的位置（index.ts:11-12、115-119）。
- 停用之后，模型侧少掉这十三个工具与那段「优先用 ops」的提示；内置 `read` 照常可用，只是读不了 PDF / Word / CSV（index.ts:128-130）。

## Known Limitations（已知限制）

- 默认关：它会拉起外部进程，哪怕只是只读（文件头 8-9）；`cordis.patch.yml` 第 5 行写着 `disabled: true`。
- 必须先装 dsh-ops：查找顺序是 `~/.dsc/plugins/node_modules/dsh-ops` → `~/.dsh/profiles/*/node_modules/dsh-ops`，也认环境变量 `DSC_OPS_WORKER`（index.ts:155、worker.ts:53-62）。
- 只认路径、不做二进制身份校验：显式填一条路径等于授权起那个 exe，文案里不许假装校验过（worker.ts:60-61）。
- 平台只支持四个：win32-x64、linux-x64、darwin-arm64、darwin-x64，别的平台直接报不支持（worker.ts:32、63-70）。
- 硬上限三个：单次 30 秒、回给模型 128 KiB、请求体 2 MiB；设置里时限只能填 2000..30000 毫秒（worker.ts:35-41、index.ts:30）。
- 换 worker 路径解析失败时不撤旧批次，免得打错一个字就把十三个能用的工具全收走（index.ts:98-113、189-199）。

## 行与开关

- 行 id `ops`，包名 `@pneuma/ops`，order 3770。
- resolution 是 overridable（package.json 的 `pneuma.resolution`）。
- 默认关：`cordis.patch.yml` 第 5 行 `disabled: true`。
- inject 四个服务：`tools`、`settings`、`prompt`、`transcript`（index.ts:63）。
- 设置分区 id `ops`，order 48，两项可改：worker 路径与单次时限；其余是只读状态说明，找到 worker 时会多一行它的路径（index.ts:137-211）。
