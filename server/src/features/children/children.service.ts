import type { Child, ChildDevice, ChildTask } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { notificationsService } from '../notifications/notifications.service';
import { CHILD_DEVICE_LIMIT, CHILD_LIMIT, CHILD_TASK_LIMIT } from './children.constants';

/**
 * 孩子档案与今日任务（规划 §5.2）。
 *
 * 为什么要一个独立于设备的「孩子」实体：此前系统里只有设备，于是
 * 「双胞胎的两台手机属于同一个孩子」这件事无从表达，周报和年龄适配也没有落脚点。
 *
 * 三条刻意的决定：
 * 1. **档案属于家长账号**（`Child.userId`），不属于设备。孩子是家长的孩子，设备只是入口。
 * 2. **档案与任务只有主人能碰**。家庭成员（§5.1 的 admin/viewer）能操作设备，
 *    但看不到、也改不了别人家孩子的档案 —— 一个被邀请来看设备的人，
 *    不该因此获得「给这个孩子改名/删档案」的权力。所以这里没有 `requireDeviceAccess`，
 *    只有 `requireOwned`（拿别人的 childId 一律 404，不泄露存在性）。
 * 3. **挂设备要求设备主人**（不是「可写成员」）。把设备改挂到另一个孩子身上是
 *    **结构性**变更，不是设置项的修改；admin 成员能把主人的设备挂到自己孩子名下，
 *    等于用「改设置」的权限做了一次归属搬迁。
 *
 * 任务挂在**孩子**身上而不是设备上：同一个孩子的两台设备应当看到同一份清单。
 */

/** 服务器本地日的 `YYYY-MM-DD`。 */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface ChildDeviceView {
  id: string;
  name: string;
  model: string;
  status: string;
  locked: boolean;
}

export interface ChildTaskView {
  id: string;
  childId: string;
  title: string;
  date: string;
  done: boolean;
  doneAt: Date | null;
  createdAt: Date;
}

export interface ChildView {
  id: string;
  name: string;
  birthYear: number | null;
  /** 现算的年龄（年份差）：存年龄必然会过期，见 schema.prisma */
  age: number | null;
  school: string;
  avatar: string;
  createdAt: Date;
  devices: ChildDeviceView[];
  todayTasks: { total: number; done: number };
}

/** 未完成在前、已完成在后；同组内保持创建顺序（Array#sort 是稳定的）。 */
function sortTasks(tasks: ChildTask[]): ChildTask[] {
  return [...tasks].sort((a, b) => Number(Boolean(a.doneAt)) - Number(Boolean(b.doneAt)));
}

export function toTaskView(task: ChildTask): ChildTaskView {
  return {
    id: task.id,
    childId: task.childId,
    title: task.title,
    date: task.date,
    done: Boolean(task.doneAt),
    doneAt: task.doneAt,
    createdAt: task.createdAt,
  };
}

function toDeviceView(device: {
  id: string;
  name: string;
  model: string;
  status: string;
  locked: boolean;
}): ChildDeviceView {
  return {
    id: device.id,
    name: device.name,
    model: device.model,
    status: device.status,
    locked: device.locked,
  };
}

export const childrenService = {
  /** 某个家长的孩子档案列表（含每台设备与「今日任务」进度）。 */
  async list(userId: number): Promise<ChildView[]> {
    const today = todayKey();
    const children = await prisma.child.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: {
        devices: {
          select: { id: true, name: true, model: true, status: true, locked: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (children.length === 0) return [];

    // 一次查回今天所有任务的完成情况，避免逐个孩子查（N+1）
    const tasks = await prisma.childTask.findMany({
      where: { childId: { in: children.map((c) => c.id) }, date: today },
      select: { childId: true, doneAt: true },
    });
    const progress = new Map<string, { total: number; done: number }>();
    for (const t of tasks) {
      const cur = progress.get(t.childId) ?? { total: 0, done: 0 };
      cur.total += 1;
      if (t.doneAt) cur.done += 1;
      progress.set(t.childId, cur);
    }

    const year = new Date().getFullYear();
    return children.map((child) => ({
      id: child.id,
      name: child.name,
      birthYear: child.birthYear,
      age: child.birthYear ? year - child.birthYear : null,
      school: child.school,
      avatar: child.avatar,
      createdAt: child.createdAt,
      devices: child.devices.map(toDeviceView),
      todayTasks: progress.get(child.id) ?? { total: 0, done: 0 },
    }));
  },

  /**
   * 取一份自己的档案。**不属于自己的一律 404**（不是 403）：
   * 403 等于告诉对方「这个 id 是存在的，只是不归你」。
   */
  async requireOwned(userId: number, childId: string): Promise<Child> {
    const child = await prisma.child.findFirst({ where: { id: childId, userId } });
    if (!child) throw new NotFoundError('孩子档案', childId);
    return child;
  },

  async create(
    userId: number,
    input: { name: string; birthYear?: number; school?: string; avatar?: string },
  ): Promise<Child> {
    const count = await prisma.child.count({ where: { userId } });
    if (count >= CHILD_LIMIT) {
      throw new ConflictError(`最多只能建 ${CHILD_LIMIT} 个孩子档案`);
    }
    const child = await prisma.child.create({
      data: {
        userId,
        name: input.name,
        birthYear: input.birthYear ?? null,
        school: input.school ?? '',
        avatar: input.avatar ?? '',
      },
    });
    logger.info({ msg: 'child created', userId, childId: child.id }, '孩子档案已创建');
    return child;
  },

  async update(
    userId: number,
    childId: string,
    patch: { name?: string; birthYear?: number; school?: string; avatar?: string },
  ): Promise<Child> {
    await childrenService.requireOwned(userId, childId);
    return prisma.child.update({
      where: { id: childId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.birthYear !== undefined ? { birthYear: patch.birthYear } : {}),
        ...(patch.school !== undefined ? { school: patch.school } : {}),
        ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
      },
    });
  },

  /**
   * 删档案。设备通过 `onDelete: SetNull` 只解除关联，**不会被删掉** ——
   * 「删掉一份档案」不该把家长的设备一起带走。
   */
  async remove(userId: number, childId: string): Promise<{ success: true }> {
    await childrenService.requireOwned(userId, childId);
    const detached = await prisma.childDevice.count({ where: { childId } });
    await prisma.child.delete({ where: { id: childId } });
    logger.info(
      { msg: 'child removed', userId, childId, detachedDevices: detached },
      '孩子档案已删除（设备仅解绑）',
    );
    return { success: true };
  },

  /** 整组替换这个孩子名下的设备。 */
  async setDevices(
    userId: number,
    childId: string,
    deviceIds: string[],
  ): Promise<ChildDeviceView[]> {
    await childrenService.requireOwned(userId, childId);
    const unique = [...new Set(deviceIds)];
    if (unique.length > CHILD_DEVICE_LIMIT) {
      throw new ConflictError(`一个孩子最多挂 ${CHILD_DEVICE_LIMIT} 台设备`);
    }

    const devices = unique.length
      ? await prisma.childDevice.findMany({
          where: { id: { in: unique } },
          select: { id: true, userId: true, name: true, model: true, status: true, locked: true },
        })
      : [];
    if (devices.length !== unique.length) {
      const missing = unique.find((id) => !devices.some((d) => d.id === id));
      throw new NotFoundError('设备', missing);
    }
    // `userId` 是 Int?：未绑定主人的设备同样不许挂（null !== userId）
    const notMine = devices.find((d) => d.userId !== userId);
    if (notMine) {
      throw new ForbiddenError('只有设备的主人可以把设备挂到孩子档案上');
    }

    // 先从这个孩子身上摘掉旧的，再挂上新的：一步 transaction，避免中途失败留下半套归属
    await prisma.$transaction([
      prisma.childDevice.updateMany({ where: { childId }, data: { childId: null } }),
      prisma.childDevice.updateMany({ where: { id: { in: unique } }, data: { childId } }),
    ]);
    return devices.map(toDeviceView);
  },

  /** 某个孩子某一天的任务（默认今天）。 */
  async listTasks(
    userId: number,
    childId: string,
    date?: string,
  ): Promise<{ date: string; total: number; done: number; tasks: ChildTaskView[] }> {
    await childrenService.requireOwned(userId, childId);
    return childrenService.listTasksOf(childId, date ?? todayKey());
  },

  /** 不做归属校验的内部版本（家长侧已校验；设备侧由 childId 相等保证）。 */
  async listTasksOf(
    childId: string,
    date: string,
  ): Promise<{ date: string; total: number; done: number; tasks: ChildTaskView[] }> {
    const tasks = await prisma.childTask.findMany({
      where: { childId, date },
      orderBy: { createdAt: 'asc' },
    });
    const sorted = sortTasks(tasks);
    return {
      date,
      total: tasks.length,
      done: tasks.filter((t) => t.doneAt).length,
      tasks: sorted.map(toTaskView),
    };
  },

  async createTask(
    userId: number,
    childId: string,
    input: { title: string; date?: string },
  ): Promise<ChildTaskView> {
    await childrenService.requireOwned(userId, childId);
    const date = input.date ?? todayKey();
    const count = await prisma.childTask.count({ where: { childId, date } });
    if (count >= CHILD_TASK_LIMIT) {
      throw new ConflictError(`一天最多布置 ${CHILD_TASK_LIMIT} 个任务`);
    }
    const task = await prisma.childTask.create({
      data: { childId, title: input.title, date, createdBy: userId },
    });
    return toTaskView(task);
  },

  /** 家长侧修改任务：改标题、或家长自己代勾/取消（不发通知 —— 家长自己点的）。 */
  async updateTask(
    userId: number,
    childId: string,
    taskId: string,
    patch: { title?: string; done?: boolean },
  ): Promise<ChildTaskView> {
    await childrenService.requireOwned(userId, childId);
    const task = await prisma.childTask.findFirst({ where: { id: taskId, childId } });
    if (!task) throw new NotFoundError('任务', taskId);
    return toTaskView(await childrenService.applyTaskPatch(task, patch));
  },

  async removeTask(
    userId: number,
    childId: string,
    taskId: string,
  ): Promise<{ success: true }> {
    await childrenService.requireOwned(userId, childId);
    const task = await prisma.childTask.findFirst({ where: { id: taskId, childId } });
    if (!task) throw new NotFoundError('任务', taskId);
    await prisma.childTask.delete({ where: { id: taskId } });
    return { success: true };
  },

  /**
   * 勾选/取消勾选：只在「真的一直是完成」时保留原来的 `doneAt`，
   * 因为家长关心的是「他什么时候做完的」，重复点击不该把时间刷成现在。
   */
  async applyTaskPatch(
    task: ChildTask,
    patch: { title?: string; done?: boolean },
  ): Promise<ChildTask> {
    const data: { title?: string; doneAt?: Date | null } = {};
    if (patch.title !== undefined) data.title = patch.title;
    if (patch.done !== undefined) {
      if (patch.done) {
        if (!task.doneAt) data.doneAt = new Date();
      } else {
        data.doneAt = null;
      }
    }
    return prisma.childTask.update({ where: { id: task.id }, data });
  },

  /**
   * 设备端读「孩子端主页」用的那一小块：孩子姓名 + 今天的任务。
   * 设备还没挂到孩子档案 → `childName: null, tasks: []`（不是报错：
   * 「家长还没建档案」是一个正常状态，不该让孩子的首页打不开）。
   */
  async todayForDevice(
    device: ChildDevice,
  ): Promise<{ childName: string | null; tasks: ChildTaskView[] }> {
    if (!device.childId) return { childName: null, tasks: [] };
    const child = await prisma.child.findUnique({
      where: { id: device.childId },
      select: { name: true },
    });
    if (!child) return { childName: null, tasks: [] };
    const { tasks } = await childrenService.listTasksOf(device.childId, todayKey());
    return { childName: child.name, tasks };
  },

  /**
   * 设备端勾掉任务。
   *
   * 任务必须属于**这台设备挂着的那个孩子**，否则 404 —— 设备 token 只能碰自己孩子的清单，
   * 不能拿着一个任务 id 去勾别人家孩子的任务。
   * 孩子第一次勾上时通知家长（重复勾选不重复发）。
   */
  async setTaskDone(
    device: ChildDevice,
    taskId: string,
    done: boolean,
  ): Promise<ChildTaskView> {
    if (!device.childId) throw new NotFoundError('任务', taskId);
    const task = await prisma.childTask.findFirst({
      where: { id: taskId, childId: device.childId },
    });
    if (!task) throw new NotFoundError('任务', taskId);
    const updated = await childrenService.applyTaskPatch(task, { done });
    if (done && !task.doneAt) {
      await childrenService.notifyTaskDone(device, task);
    }
    return toTaskView(updated);
  },

  /** 「孩子完成了任务」是家长最想知道的一类消息，但通知永不阻断主流程。 */
  async notifyTaskDone(device: ChildDevice, task: ChildTask): Promise<void> {
    const child = await prisma.child.findUnique({
      where: { id: task.childId },
      select: { name: true, userId: true },
    });
    if (!child) return;
    const remaining = await prisma.childTask.count({
      where: { childId: task.childId, date: task.date, doneAt: null, id: { not: task.id } },
    });
    await notificationsService.notify({
      userId: child.userId,
      type: 'child_task',
      title: '{{v0}} 完成了「{{v1}}」',
      titleParams: { v0: child.name, v1: task.title },
      body: '今天的任务还剩 {{v0}} 项没做。',
      bodyParams: { v0: remaining },
      linkPath: '/children',
      deviceId: device.id,
      // 一个任务只提醒一次。用完成时刻做键看起来「更准确」，实际会把
      // 「孩子反复勾上又取消」变成对家长的连续轰炸 —— 任务清单本身就在那儿，
      // 家长随时能看到当前状态，通知只负责说「他今天开始了/做完了」。
      dedupeKey: `child_task:${task.id}`,
    });
  },
};
