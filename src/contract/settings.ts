/**
 * 契约分域：settings
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/settings
 */
import type { EffortMap, Modality, ThinkingLevel, ThinkingParam } from './mode.js'

// ── 设置界面 ──────────────────────────────────────────────────────────────────

/**
 * 设置项的值类型（要过 IPC，必须可 JSON 序列化）。
 *
 * 前三种是标量控件（text / number / select / switch）的值。数组有两支：
 *   - {@link SettingsRowValue}`[]`：`rows` 字段的整张记录表（一组记录）；
 *   - `string[]`：`checks` 字段选中的那一组值（元素就是选项声明的 `value`）。
 * 两支都是普通数组、元素都是 JSON 能表达的东西，所以 `setSettingValue` 那个
 * `kind: 'json'` 通道不用动，宿主存盘时也不必再编码一层。
 */
export type SettingsValue = string | number | boolean | SettingsRowValue[] | string[]

/**
 * 记录表（`rows` 字段）的一行：列 key → 单元格文本。
 *
 * 为什么单元格统一是字符串：表格控件的输入框本来就产出文本，下拉的值也是字符串；
 * 宿主收到后自己转数字/布尔（与 `setSettingValue` 老链路一致——插件给声明与回调）。
 */
export type SettingsRowValue = Record<string, string>

/** 下拉选项。 */
export interface SettingsOption {
  value: string
  label: string
}

/**
 * 分组多选（`checks` 字段）里的一个可勾选项。
 *
 * `detail` 是行内的灰色副说明（典型用法写 `provider/model` 路径，告诉用户
 * 这个值指向哪个端点的哪个模型）；它只用于展示，回写给宿主的是 `value`。
 */
export interface SettingsCheckOption {
  value: string
  label: string
  detail?: string
}

/**
 * 一组可勾选项（`checks` 字段按它分块画）。
 *
 * 分组只为「一眼能找到」，不影响值：所有组的选中值仍然是同一个扁平的
 * `string[]`（见 {@link SettingsValue}），组的边界不写进值里——不然宿主改动
 * 分组（提供方改名、换一组模型）时，用户已存的选择就对不上了。
 */
export interface SettingsCheckGroup {
  title: string
  options: SettingsCheckOption[]
}

/**
 * `rows` 字段的一列：文本列画输入框，下拉列画选择器。
 *
 * 与 {@link SettingsField} 同一条边界：这张表要过 IPC，所以列只给声明，不给组件。
 */
export type SettingsRowColumn =
  | {
      key: string
      label: string
      type: 'text'
      placeholder?: string
      /**
       * 校验正则（字符串形式，因为要 JSON 序列化；界面用 `new RegExp(pattern)` 现编）。
       * 界面只在非空时拿它做一次提示性检查，**最终校验仍在宿主 save()**。
       */
      pattern?: string
      /** true = 这一格允许空着。壳今天不拦空值（新加的行本来就全是空格），由宿主判。 */
      optional?: boolean
      /** 这一格建议从候选里挑（如目录 / 仓库名）；壳可给提示，今天不改变控件形状。 */
      choose?: boolean
      /** 改这一格要重新读一次分区（值由宿主现算，例如部署检查结果）。 */
      refresh?: boolean
    }
  | { key: string; label: string; type: 'select'; options: SettingsOption[] }

/**
 * 设置分区里的一个控件。内置分区与外部插件声明的分区共用这一张渲染表，
 * 所以字段必须可 JSON 序列化——插件给的是声明和回调，不是 React 组件。
 */
export type SettingsField =
  | { type: 'text'; key: string; label: string; placeholder?: string; help?: string; mono?: boolean; group?: string }
  | { type: 'number'; key: string; label: string; min?: number; max?: number; step?: number; help?: string; group?: string }
  /**
   * 下拉。`derivedLabelKey` 是给**派生值**用的：当前值不在 `options` 里时（如权限预设的
   * `custom`——它是三根旋钮拼出来的状态，不是可选项），壳去 `values[derivedLabelKey]` 读
   * 显示名，并把这一行渲染成**置灰只读**。派生值本来就选不了（宿主 `use('custom')` 会当场拒），
   * 画成能点的下拉只会让人以为能选、点了还报错。
   */
  | {
      type: 'select'
      key: string
      label: string
      options: SettingsOption[]
      derivedLabelKey?: string
      help?: string
      group?: string
    }
  | { type: 'switch'; key: string; label: string; help?: string; group?: string }
  /**
   * 分组多选（`checks`）：一块按组排列的复选框清单，值是一组选中的 `value`。
   *
   * 为什么值是数组：勾选本来就是「一组值」，数组能原样过 IPC（JSON 可序列化，
   * 见 {@link SettingsValue}），宿主存盘/读盘不必自己编码；不用对象或位掩码，
   * 是因为那样既没有可读性，也没法把「没选」和「值缺失」写成同一种语义。
   *
   * 空数组 = 一个都没选（不是「用默认」）：宿主声明这个字段时就把默认值给全，
   * 壳只负责把勾选状态读写回去——界面不猜缺省，猜了两次就会有两套缺省。
   *
   * 为什么分组在声明里（`groups`）：提供方 / 来源这类清单会越来越长，平铺一列
   * 找不到东西；分组只影响画法，值仍是扁平的一组 `value`，分组改组了旧选择也还在。
   */
  | {
      type: 'checks'
      key: string
      label: string
      groups: SettingsCheckGroup[]
      help?: string
      group?: string
    }
  /**
   * 只读事实行（`fact`）：值来自分区 `values()` 的 `values[key]`，没有就画占位。
   * 它不是输入框——用户改不了，宿主也不收它的写入（写不回时界面只展示）。
   *
   * `settings: 'deployment'` 是从上游来源设置卡带过来的标记：这个值由**部署检查结果**
   * 算出来（上游 `kind.facts(deployment)`），不是用户填的。本仓的分工不变：宿主负责把
   * 检查结果算进 `values[key]`，壳只负责画那一行。
   */
  | {
      type: 'fact'
      key: string
      label: string
      help?: string
      /** 值来自部署检查结果（上游同名字段；值仍由分区 values() 给）。 */
      settings?: 'deployment'
      /** 高级项标记（上游同名字段；壳今天不折叠，保留声明免得转换层丢信息）。 */
      advanced?: boolean
      group?: string
    }
  /**
   * 记录表（`rows`）：值是一组记录，第一列习惯当键（如「准入表」「多仓库表」）。
   * 每行按 `columns` 出输入框/下拉、可增删行；写回 `values[key]` 的是
   * {@link SettingsRowValue}`[]`（元素是 `Record<string,string>`）。
   */
  | {
      type: 'rows'
      key: string
      label: string
      columns: SettingsRowColumn[]
      help?: string
      /** 高级项标记（同 fact）。 */
      advanced?: boolean
      group?: string
    }
  | {
      type: 'info'
      label?: string
      text: string
      mono?: boolean
      copyable?: boolean
      /**
       * 行内动作（画在「复制 / 打开」右边）。**壳认得 id 才画**，认不出的整条跳过——
       * 这样宿主多声明一条不会让旧壳画出点不动的按钮。
       *
       * 现有的两个：`switch-config-file`（选一份配置文件当活动配置）、
       * `reset-config-file`（改回出厂那份）。它们要在桌面端开系统文件对话框，
       * 所以由壳就地处理（不经宿主动作表）。
       */
      actions?: readonly SettingsInfoAction[]
      help?: string
      group?: string
    }
  | { type: 'button'; action: string; label: string; style?: 'primary' | 'ghost'; help?: string; group?: string }

/** 信息行上的一个动作按钮（见 `SettingsField` 的 info 分支）。 */
export interface SettingsInfoAction {
  /** 壳认得的动作 id；认不出的不画。 */
  id: string
  /** 按钮文字（2–4 字动词，无标点）。 */
  label: string
  /** 悬浮说明。 */
  tip?: string
}

/**
 * 分区内的一个分组（dsh 同款机制）：`fields` 里带 `group: id` 的字段收进这组，
 * TUI 在根页只画一行「组标题 … ›」，Enter 进子页才见到组内字段；桌面端不做
 * 子页导航，渲染成组头（相邻同组字段聚在一张组标题下）。组的 key 仍是分区里
 * 的扁平键，values/save 链路与顶层字段零差别。
 */
export interface SettingsGroupView {
  id: string
  title: string
  /** 聚焦组行时提示条里的一句话说明。 */
  description?: string
}

/** 一个设置分区的投影（顺序由 order 决定，小者在前）。 */
export interface SettingsSectionView {
  id: string
  title: string
  /** nav 行下方的一句话说明。 */
  subtitle?: string
  order: number
  /** 分组声明（display 顺序）；字段按 `group` id 归组，没进组的字段留在根页。 */
  groups?: SettingsGroupView[]
  /**
   * 内核内置分区，或声明了 inSettings 的插件代管分区（插件里的内核级功能，
   * 例如远程控制：它登记在插件上，但界面归设置页）。
   */
  builtin: boolean
  /**
   * true = 内容要由桌面端自己画（模型、技能这类结构化界面），
   * 此时 fields 为空，数据走 getModelConfig / listSkills 等专门的方法。
   */
  custom: boolean
  fields: SettingsField[]
  /**
   * 并进哪一页（2026-11-06 的「终端环境」）：声明了 parent 的分区**不单独占导航**，
   * 父页在末尾按 order 把它整块画出来（自带标题与说明，与父页原本的内容分开）。
   *
   * 控件的读、写、按钮动作仍走**这个子分区自己的 id**（getSectionValues /
   * setSettingValue / runSettingAction 都按它调），所以并在父页里与单独成页逐项等价。
   * 只在父分区确实存在时才并入；父分区没了就当独立分区，内容不会凭空消失。
   */
  parent?: string
}

/** 分区控件的值表。 */
export type SettingsValues = Record<string, SettingsValue>

/**
 * 配对数据的结构化载荷：桌面端据此弹「连接手机」弹窗（画码与二维码），
 * 手机端也可以扫 {@link PairShareData.url} 直接把码带进登录框。
 *
 * 为什么不是只给一句 notice 文案：文案里的码一闪就没了，用户错过就得重新生成；
 * 弹窗要一直挂在屏幕上，界面就必须拿到「码 + 可扫地址 + 过期时刻」这三个字段。
 */
export interface PairShareData {
  /** 载荷种类；今天只有配对码这一种，将来加别的一起收在这条判别位上。 */
  kind: 'pair-code'
  /** 8 位配对码。明文只在宿主内存与这条载荷里出现，绝不落盘、不进日志。 */
  code: string
  /** 带 `?code=` 的完整访问地址：手机扫码打开即带上码，也可以整串复制。 */
  url: string
  /** 过期时刻（epoch 毫秒）；到点这张码就用不了了。 */
  expiresAt: number
  /**
   * 这个地址对手机来说到底通不通（界面据此决定画码还是画引导）：
   *   - `'lan'`：服务监听 `0.0.0.0`，`url` 是局域网地址，手机扫得开；
   *   - `'local'`：服务只听 `127.0.0.1`，`url` 里是回环地址，只有这台电脑能打开；
   *   - `'down'`：服务根本没在跑（开关关着、端口被占、或本进程让出了主控位）。
   *
   * 为什么要有这个字段：`lan` 关着时二维码里编的是 `http://127.0.0.1:<端口>/`，
   * 手机浏览器只会报「网页暂时无法打开」，而弹窗文案写着「扫这个码即可连接」——
   * 界面拿不到真相就只能继续骗人。老宿主不给这个字段，界面按 `'lan'` 处理（老行为，
   * 它那时确实只出局域网地址或回环地址，没有第三种可能）。
   */
  reach?: 'lan' | 'local' | 'down'
}

/**
 * 「用系统浏览器打开一个链接」的载荷：检查更新发现新版时随回执带给桌面端，
 * 界面据此打开发布页（宿主自己够不着 shell）。
 */
export interface LinkShareData {
  kind: 'url'
  /** 要打开的地址；桌面端只放行 http/https。 */
  url: string
}

/**
 * 「有一个能就地装的新版」的载荷：检查更新发现新版、且发布资产里挑得出安装器时随回执带给界面，
 * 界面据此在行内给一颗「立即更新」。
 *
 * 与 {@link LinkShareData} 的分工：挑得出安装器就就地更新（下载与启动安装程序由桌面主进程做，
 * 见原生桥的 `installUpdate`）；挑不出安装器才退回打开发布页。
 */
export interface UpdateShareData {
  kind: 'update'
  /** 更新源上的新版本号（原样，可能带 `v` 前缀）。 */
  version: string
}

/** 写入或动作成功时的载荷：提示条文案之外，还可以带一份结构化数据给界面画弹窗。 */
export interface SettingsMutationOk {
  notice?: string
  data?: PairShareData | LinkShareData | UpdateShareData
}

/** 写入或动作的结果：失败原因直接显示在控件下方。 */
export type SettingsMutation = ({ ok: true } & SettingsMutationOk) | { ok: false; error: string }

// ── 模型配置（设置「模型」分区的数据源） ──────────────────────────────────────

/** 端点里的一个模型。 */
export interface ProviderModelView {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** 这个模型支持的思考档位；空数组 = 没有思考开关，界面只留「默认」。 */
  thinkingLevels: ThinkingLevel[]
  /** 档位走哪个请求字段（见 {@link ThinkingParam}）。 */
  thinkingParam: ThinkingParam
  /** `reasoning-effort` 时档位 → 线上值；没写的档用内置缺省值。 */
  effortMap: EffortMap
  /** 能接受的输入类型；没勾照片就不能往这个模型发图。 */
  modalities: Modality[]
}

/** 一个端点（API key 只报告状态，永不回传值）。 */
export interface ProviderView {
  name: string
  displayName: string
  baseUrl: string
  /** config.yaml 里 apiKeyEnv 指向的环境变量名 / 凭据库 key 名。 */
  keyRef: string
  /** 该 key 是否已取得（环境变量或凭据库）。 */
  keyConfigured: boolean
  models: ProviderModelView[]
}

/** 模型配置全貌。 */
export interface ModelConfigView {
  providers: ProviderView[]
  defaultProvider: string
  defaultModel: string
  /** 采样温度；null = 跟随端点默认。 */
  temperature: number | null
  /** 配置文件绝对路径（关于分区与错误提示都要用）。 */
  configFile: string
  credentialsFile: string
}

/**
 * 一次端点连接测试的结果（设置 → 模型每张卡上的「测试连接」）。
 *
 * 判定口径在 packages/settings/connection-test.ts：**流正常收尾即通**；失败一律带一句可直接展示的
 * 说明（永不包含 key）。
 */
export interface ConnectionTestOutcome {
  ok: boolean
  /** 从发出到收尾花了多久（毫秒）。失败时也报——「等 20 秒才断」本身有诊断价值。 */
  ms: number
  /** 模型回的话（单行、截断到 80 字；可能为空：输出被预算截断时就是这样）。 */
  reply: string
  /** 失败原因（可直接展示）。 */
  error?: string
}

/** 连接测试结果 + 测的是哪个模型（界面要把它写在那张卡上）。 */
export interface ConnectionTestView extends ConnectionTestOutcome {
  model: string
}

/** 新增或编辑一个端点的入参（apiKey 单独走 setProviderKey）。 */
export interface ProviderDraft {
  /** null = 新增；否则为被编辑端点的原名字（支持改名）。 */
  oldName: string | null
  name: string
  displayName: string
  baseUrl: string
  models: ProviderModelView[]
}

