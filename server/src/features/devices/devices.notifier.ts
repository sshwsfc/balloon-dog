import { logger } from '../../logger';

/**
 * 进程内「有新指令了」通知器，用于设备端长轮询。
 *
 * ⚠️ 仅单实例有效：多实例部署时，命中另一个实例的长轮询不会被唤醒，
 * 但它会在 wait 超时后正常返回 pending=null，设备端进入下一轮轮询 —— 即
 * 优雅退化为短轮询，不会丢指令（指令本身在数据库里）。
 */

type Resolver = () => void;

const waiters = new Map<string, Set<Resolver>>();

/** 有新指令入队时唤醒该设备所有等待者。 */
export function notifyDevice(deviceId: string): void {
  const set = waiters.get(deviceId);
  if (!set || set.size === 0) return;
  for (const resolve of set) {
    try {
      resolve();
    } catch (err) {
      logger.warn({ msg: 'notifyDevice resolver threw', error: (err as Error).message });
    }
  }
  waiters.delete(deviceId);
}

/**
 * 等待该设备被唤醒，或超时返回。
 * 调用方拿到控制权后应重新查一次数据库（不要假设一定有指令）。
 */
export function waitForDevice(deviceId: string, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let set = waiters.get(deviceId);
    if (!set) {
      set = new Set();
      waiters.set(deviceId, set);
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const current = waiters.get(deviceId);
      if (current) {
        current.delete(finish);
        if (current.size === 0) waiters.delete(deviceId);
      }
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    set.add(finish);
  });
}
