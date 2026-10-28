/**
 * 契约分域：mode
 *
 * 从 `src/contract.ts` 拆出来的一个域（纯搬移，逐字未改）。调用方照旧 import
 * `../contract.js`——那份文件现在只做转出，导出面一个没少。
 *
 * @module dsc/contract/mode
 */
import type { UserFileAttachment } from '../core/attachments.js'

export type { UserFileAttachment }

/** deepseek adapter 的思考强度档位。default = 不声明思考字段（跟随端点默认）。 */
export type EffortLevel = 'default' | 'off' | 'low' | 'high' | 'max'

/** 思考强度档位里可被模型声明的四档（default 不是模型能力，是「不发字段」）。 */
export type ThinkingLevel = Exclude<EffortLevel, 'default'>

/**
 * 思考档位用哪个请求字段发给端点：
 *   thinking          —— DeepSeek / GLM 的 `thinking:{type}`，只有开关，低/高/最大都发 enabled；
 *   reasoning-effort —— OpenAI 与多数网关的 `reasoning_effort`，按档位发线上值（见 EffortMap）；
 *   none              —— 端点没有思考参数，选哪档都不发字段。
 */
export type ThinkingParam = 'thinking' | 'reasoning-effort' | 'none'

/** 模型能接受的输入类型（text 恒含；video 目前只作声明，dsc 还没有发视频的通道）。 */
export type Modality = 'text' | 'image' | 'video'

/** `reasoning-effort` 下每档要发的线上值；null = 该档不发字段。 */
export type EffortMap = Partial<Record<ThinkingLevel, string | null>>

/**
 * 权限模式——「问出来的那些事，怎么裁」。**只决定自动放行集**：
 *   readonly     —— 仅查看：读类命令放行，write/exec 类一律拒绝（连卡都不弹）；
 *   auto-edit    —— 工作区自动编辑：工作目录内的 write/edit 与只读命令自动放行，
 *                   其余（工作区外写入、exec 类）成为「要问的事」；
 *   full-access  —— 完全访问：全部工具自动放行（灾难地板仍拒）。
 *
 * 「要问的事」交给谁答，是**另一根轴**（{@link ApprovalReviewer}），不再混在这一档里：
 * 上一版把「AI 审查」做成第四档，逼出的是四个互相排斥的选项——「只读 + AI 复核」
 * 这种用户真实想要的组合根本表达不出来。codex 的 `approvals_reviewer` 与参考实现的
 * `auto` 都是把「谁来审」抽出来的做法，这里跟齐。
 */
export type ApprovalPolicy = 'readonly' | 'auto-edit' | 'full-access'

/**
 * 审批审阅者——「要问的事，先给谁看」：
 *   user         —— 本人：弹审批卡等用户点（出厂默认）；
 *   auto-review  —— AI 复核：先给模型判官看一眼，判 allow 就放行，判 deny 或判不出来
 *                   再落回人工卡。复核**发生在自动放行之前**，所以「完全访问 + AI 复核」
 *                   等价于旧版的「AI 审查」档（每一次调用都过模型，codex 的
 *                   `strict_auto_review` 同义）。
 *
 * 与权限模式正交：任何一档都能配上这两位中的任何一位（只读档下没有事情可问，
 * 复核者自然不会被问到——这不是特例，是「无可问之事」的正常结果）。
 */
export type ApprovalReviewer = 'user' | 'auto-review'

/**
 * 沙箱档位（「能不能写」这一轴；形制照 codex 的 `sandbox_mode`，与参考实现逐字相同）：
 *   read-only            只读：任何写盘与越界命令都拒；
 *   workspace-write      工作区可写：工作区 + 沙箱私有临时目录可写，越界拒（默认档）；
 *   danger-full-access   不设围栏（等同关掉沙箱）。
 *
 * 定义住这里而不是 `services/types.ts`：打包权限预设（{@link PermissionPresetView}）
 * 要把它和权限模式一起投影给界面，而界面只依赖契约模块——两边各写一份迟早会漂。
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * 协作模式（这一轮允许模型把手伸多远）。与权限模式是两根独立的旋钮：
 * 模式决定要不要问、能问什么；权限模式决定问出来之后怎么裁。
 *   build   执行    —— 默认档，闸门不拦，全交给权限模式与审批卡；
 *   plan    计划    —— 只读 + 只读命令，产出 .dsc/plans 下的计划文件等用户批；
 *   explore 探索    —— 只读答疑，任何改动当场拒；
 *   quiet   免打扰  —— 不弹审批卡：工作区内写自动放行，需要问的一律当场拒。
 */
export type CollaborationMode = 'build' | 'plan' | 'explore' | 'quiet'

