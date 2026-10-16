import { z } from 'zod';
import { TICKET_BODY_MAX, TICKET_SUBJECT_MAX } from './support.constants';

export const createTicketSchema = z
  .object({
    category: z.string().min(1).max(32),
    subject: z.string().trim().min(2).max(TICKET_SUBJECT_MAX),
    body: z.string().trim().min(5).max(TICKET_BODY_MAX),
    contact: z.string().trim().max(64).optional(),
    deviceId: z.string().min(1).max(64).optional(),
  })
  .strict();

export const ticketNoParamSchema = z.object({
  ticketNo: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[A-Za-z0-9-]+$/, '工单号格式不对'),
});

export const ticketReplySchema = z
  .object({ body: z.string().trim().min(1).max(TICKET_BODY_MAX) })
  .strict();

export const adminTicketQuerySchema = z.object({
  status: z.string().max(16).optional(),
  category: z.string().max(32).optional(),
  priority: z.string().max(16).optional(),
  keyword: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const adminTicketPatchSchema = z
  .object({
    status: z.enum(['open', 'processing', 'waiting', 'closed']).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
    assigneeId: z.number().int().positive().nullable().optional(),
  })
  .strict();
