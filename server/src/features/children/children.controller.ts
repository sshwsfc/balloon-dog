import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { currentUserId } from '../../shared/deviceScope';
import { childrenService } from './children.service';
import {
  assignDevicesSchema,
  childIdSchema,
  createChildSchema,
  createTaskSchema,
  listTasksQuerySchema,
  taskIdSchema,
  updateChildSchema,
  updateTaskSchema,
} from './children.dto';

/**
 * 孩子档案与今日任务（规划 §5.2）。挂 `/api/children`。
 *
 * 这里**不需要** `resolveDevice`：档案属于家长账号（`Child.userId`），
 * 不是设备作用域的。（设备侧那一条 `POST /api/agent/tasks/:taskId` 在 agent.controller 里。）
 */

/** GET /api/children */
export async function listChildren(req: Request, res: Response) {
  res.json({ children: await childrenService.list(currentUserId(req)) });
}

/** POST /api/children */
export async function createChild(req: Request, res: Response) {
  const input = createChildSchema.parse(req.body);
  res.status(201).json({ success: true, child: await childrenService.create(currentUserId(req), input) });
}

/** PATCH /api/children/:childId */
export async function updateChild(req: Request, res: Response) {
  const { childId } = childIdSchema.parse(req.params);
  const patch = updateChildSchema.parse(req.body);
  const child = await childrenService.update(currentUserId(req), childId, patch);
  res.json({ success: true, child });
}

/** DELETE /api/children/:childId —— 设备只是解绑，不会被删。 */
export async function removeChild(req: Request, res: Response) {
  const { childId } = childIdSchema.parse(req.params);
  res.json(await childrenService.remove(currentUserId(req), childId));
}

/** PUT /api/children/:childId/devices —— 整组替换这个孩子名下的设备。 */
export async function setChildDevices(req: Request, res: Response) {
  const { childId } = childIdSchema.parse(req.params);
  const { deviceIds } = assignDevicesSchema.parse(req.body);
  const devices = await childrenService.setDevices(currentUserId(req), childId, deviceIds);
  res.json({ success: true, devices });
}

/** GET /api/children/:childId/tasks?date=YYYY-MM-DD（默认今天） */
export async function listChildTasks(req: Request, res: Response) {
  const { childId } = childIdSchema.parse(req.params);
  const { date } = listTasksQuerySchema.parse(req.query);
  res.json(await childrenService.listTasks(currentUserId(req), childId, date));
}

/** POST /api/children/:childId/tasks */
export async function createChildTask(req: Request, res: Response) {
  const { childId } = childIdSchema.parse(req.params);
  const input = createTaskSchema.parse(req.body);
  const task = await childrenService.createTask(currentUserId(req), childId, input);
  res.status(201).json({ success: true, task });
}

/** PATCH /api/children/:childId/tasks/:taskId */
export async function updateChildTask(req: Request, res: Response) {
  const { childId } = childIdSchema.parse(req.params);
  const { taskId } = taskIdSchema.parse(req.params);
  const patch = updateTaskSchema.parse(req.body);
  const task = await childrenService.updateTask(currentUserId(req), childId, taskId, patch);
  res.json({ success: true, task });
}

/** DELETE /api/children/:childId/tasks/:taskId */
export async function removeChildTask(req: Request, res: Response) {
  const { childId } = childIdSchema.parse(req.params);
  const { taskId } = taskIdSchema.parse(req.params);
  res.json(await childrenService.removeTask(currentUserId(req), childId, taskId));
}

/** /api/children */
export const childrenRoutes = Router();
childrenRoutes.use(authenticate);
childrenRoutes.get('/', ah(listChildren));
childrenRoutes.post('/', ah(createChild));
childrenRoutes.patch('/:childId', ah(updateChild));
childrenRoutes.delete('/:childId', ah(removeChild));
childrenRoutes.put('/:childId/devices', ah(setChildDevices));
childrenRoutes.get('/:childId/tasks', ah(listChildTasks));
childrenRoutes.post('/:childId/tasks', ah(createChildTask));
childrenRoutes.patch('/:childId/tasks/:taskId', ah(updateChildTask));
childrenRoutes.delete('/:childId/tasks/:taskId', ah(removeChildTask));
