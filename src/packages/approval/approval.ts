/**
 * 审批通道：loop 在执行 write/exec 类工具前挂起等待决定。
 * 对齐现有 UI 的 one-shot y/n 语义（对应 dsh user-approval 的 'ask' 策略
 * 的个人版最小实现）。
 *
 * 四个类型的定义已搬进 `src/contract/approval.ts`（契约层不再依赖功能包）；
 * 这里只把名字转出去，老调用方的 import 面不变。
 *
 * @module dsc/core/approval
 */

export type { ApprovalDecision, ApprovalHandler, ApprovalOptions, ApprovalRequest } from '../../contract/approval.js'
