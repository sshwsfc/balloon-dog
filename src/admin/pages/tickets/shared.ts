import type { TicketPriority, TicketRow, TicketStatus } from '../../api'
import type { Tone } from '../../components/status'

/**
 * 工单的分类 / 状态 / 优先级中文标签。
 *
 * **为什么在前端又抄了一份**（评审会问）：这三个映射的权威定义在
 * `server/src/features/support/support.constants.ts`，但后台路由只暴露了
 * `GET /`、`GET /:ticketNo`、`PATCH /:ticketNo`、`POST /:ticketNo/replies`，
 * 那份常量只通过**家长**路由 `GET /api/support/config`（需要家长 token）下发。
 * 后台拿不到，所以：
 *   1. 列表与详情里的**状态**优先用后端返回的 `statusLabel`（`toAdminView` 会带），
 *      下面的映射只作为兜底；
 *   2. 后端**没有**返回 `categoryLabel` / `priorityLabel`，筛选下拉又必须在数据到达前
 *      就能渲染，所以这两份映射是必需的。
 * 一旦后端在后台路由上补了 label，这里的映射应当删掉。
 */

export const TICKET_STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: 'open', label: '待处理' },
  { value: 'processing', label: '处理中' },
  { value: 'waiting', label: '等待家长回复' },
  { value: 'closed', label: '已关闭' },
]

export const TICKET_PRIORITY_OPTIONS: { value: TicketPriority; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'normal', label: '普通' },
  { value: 'high', label: '紧急' },
]

/** 与 `TICKET_CATEGORIES` 一一对应（key 是家长端提交时用的固定枚举）。 */
export const TICKET_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'device', label: '设备连接 / 绑定' },
  { value: 'control', label: '管控不生效' },
  { value: 'payment', label: '支付 / 退款 / 发票' },
  { value: 'account', label: '账号与登录' },
  { value: 'suggestion', label: '功能建议' },
  { value: 'other', label: '其他问题' },
]

export const TICKET_STATUS_TONE: Record<TicketStatus, Tone> = {
  open: 'amber',
  processing: 'blue',
  waiting: 'purple',
  closed: 'gray',
}

export const TICKET_PRIORITY_TONE: Record<TicketPriority, Tone> = {
  low: 'gray',
  normal: 'blue',
  high: 'red',
}

export function statusLabelOf(ticket: Pick<TicketRow, 'status' | 'statusLabel'>): string {
  if (ticket.statusLabel) return ticket.statusLabel
  return TICKET_STATUS_OPTIONS.find((o) => o.value === ticket.status)?.label ?? ticket.status
}

export function categoryLabelOf(category: string): string {
  return TICKET_CATEGORY_OPTIONS.find((o) => o.value === category)?.label ?? category
}

export function priorityLabelOf(priority: string): string {
  return TICKET_PRIORITY_OPTIONS.find((o) => o.value === priority)?.label ?? priority
}

export function statusToneOf(status: string): Tone {
  return TICKET_STATUS_TONE[status as TicketStatus] ?? 'gray'
}

export function priorityToneOf(priority: string): Tone {
  return TICKET_PRIORITY_TONE[priority as TicketPriority] ?? 'gray'
}

/** 家长身份：昵称 > 手机号 > 账号已注销（工单 userId 可空，删号时工单会一并删）。 */
export function parentTextOf(ticket: Pick<TicketRow, 'userNickname' | 'userPhone'>): string {
  return ticket.userNickname || ticket.userPhone || '账号已注销'
}
