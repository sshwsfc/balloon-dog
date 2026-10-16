/**
 * 客服工单（规划 §5.5）—— 家长端 + 管理端接口。
 *
 * 两端读同一张表、看到的东西不一样（见 `support.service.ts` 的两套 toXxxView）：
 * 家长只知道「客服回复了什么」，后台才知道「谁在处理、这个家长是谁」。
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { authenticate, authenticateAdmin, currentAdmin } from '../../middleware/auth';
import { currentUserId } from '../../shared/deviceScope';
import { ah } from '../../shared/asyncHandler';
import {
  adminTicketPatchSchema,
  adminTicketQuerySchema,
  createTicketSchema,
  ticketNoParamSchema,
  ticketReplySchema,
} from './support.dto';
import { supportService } from './support.service';

/** GET /api/support/config —— 入口开不开、有哪些分类、联系方式。 */
export async function getSupportConfig(_req: Request, res: Response) {
  res.json(await supportService.config());
}

/** POST /api/support/tickets —— 提交一张工单。 */
export async function createTicketHandler(req: Request, res: Response) {
  const input = createTicketSchema.parse(req.body);
  const userId = currentUserId(req);
  res.status(201).json({ success: true, ...(await supportService.createTicket(userId, input)) });
}

/** GET /api/support/tickets —— 我的工单。 */
export async function listMyTicketsHandler(req: Request, res: Response) {
  const userId = currentUserId(req);
  res.json(await supportService.listMyTickets(userId));
}

/** GET /api/support/tickets/:ticketNo —— 我的工单详情（别人的 404）。 */
export async function myTicketDetailHandler(req: Request, res: Response) {
  const { ticketNo } = ticketNoParamSchema.parse(req.params);
  const userId = currentUserId(req);
  res.json(await supportService.myTicketDetail(userId, ticketNo));
}

/** POST /api/support/tickets/:ticketNo/replies —— 家长补充信息（已关闭的不能回）。 */
export async function parentReplyHandler(req: Request, res: Response) {
  const { ticketNo } = ticketNoParamSchema.parse(req.params);
  const { body } = ticketReplySchema.parse(req.body);
  const userId = currentUserId(req);
  res.status(201).json({ success: true, ...(await supportService.addParentReply(userId, ticketNo, body)) });
}

export const supportRoutes = Router();
supportRoutes.use(authenticate);
supportRoutes.get('/config', ah(getSupportConfig));
supportRoutes.post('/tickets', ah(createTicketHandler));
supportRoutes.get('/tickets', ah(listMyTicketsHandler));
supportRoutes.get('/tickets/:ticketNo', ah(myTicketDetailHandler));
supportRoutes.post('/tickets/:ticketNo/replies', ah(parentReplyHandler));

// ---------------- 后台 ----------------

/** GET /api/admin/tickets —— 筛选 + 分页。 */
export async function adminListTicketsHandler(req: Request, res: Response) {
  const query = adminTicketQuerySchema.parse(req.query);
  res.json(await supportService.adminListTickets(query));
}

/** GET /api/admin/tickets/:ticketNo —— 详情（含家长账号与分派人）。 */
export async function adminTicketDetailHandler(req: Request, res: Response) {
  const { ticketNo } = ticketNoParamSchema.parse(req.params);
  res.json(await supportService.adminTicketDetail(ticketNo));
}

/** PATCH /api/admin/tickets/:ticketNo —— 改状态 / 优先级 / 分派人。 */
export async function adminUpdateTicketHandler(req: Request, res: Response) {
  const { ticketNo } = ticketNoParamSchema.parse(req.params);
  const patch = adminTicketPatchSchema.parse(req.body);
  res.json({ success: true, ...(await supportService.adminUpdateTicket(ticketNo, patch)) });
}

/** POST /api/admin/tickets/:ticketNo/replies —— 后台回复（推 open → waiting）。 */
export async function adminReplyTicketHandler(req: Request, res: Response) {
  const { ticketNo } = ticketNoParamSchema.parse(req.params);
  const { body } = ticketReplySchema.parse(req.body);
  const admin = currentAdmin(req);
  res
    .status(201)
    .json({ success: true, ...(await supportService.adminReplyTicket(ticketNo, admin, body)) });
}

export const ticketAdminRoutes = Router();
ticketAdminRoutes.use(authenticateAdmin);
ticketAdminRoutes.get('/', ah(adminListTicketsHandler));
ticketAdminRoutes.get('/:ticketNo', ah(adminTicketDetailHandler));
ticketAdminRoutes.patch('/:ticketNo', ah(adminUpdateTicketHandler));
ticketAdminRoutes.post('/:ticketNo/replies', ah(adminReplyTicketHandler));
