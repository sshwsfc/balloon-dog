import { logger } from '../../logger';

/**
 * 进程内「有新指令了」通知器，用于设备端长轮询。
 *
 * ⚠️ 仅单实例有效：多实例部署时，命中另一个实例的长轮询不会被唤醒，
 * 但它会在 wait 超时后正常返回 pending=null，设备端进入下一轮轮询 —— 即
 * 优雅退化为短轮询，不会丢指令（指令本身在数据库里）。
 *
 * ── 为什么接口里带 abortSignal（2026-10 修）─────────────────────────────
 * 设备端 Agent 被 {@code kill -9} 时，那条长轮询的 TCP 连接会消失，但服务端
 * **不会**因此把等待者摘掉：旧版 waitForDevice 只把 finish 塞进 Set，靠定时器
 * 或 notifyDevice 才会清理。于是「已死连接的 resolver」会一直挂在 Set 里，
 * 而 notifyDevice 一次唤醒**整组**等待者 —— 死 resolver 和新连接同时去
 * claimNext，CAS 谁先抢到谁赢。抢到的是死连接时，指令被标成 dispatched 却
 * 写进了空气，设备永远收不到，只能干等 COMMAND_TTL_SECONDS 被清成 expired。
 *
 * 所以等待者必须**知道自己的连接死了**并能主动摘除。请求处理器把
 * req/res 的 close/aborted 信号转成 AbortSignal 传进来。
 *
 * 另外：**一个设备同时只保留一个等待者**（单飞）。真机上一个设备只有一条
 * Agent 长轮询，出现第二个等待者只可能是旧连接没被及时摘除（例如设备与服务端
 * 之间隔着 NAT/代理，FIN 没有送达）。此时新连接顶掉旧的：旧的那条立刻返回
 * pending=null 并重新轮询 —— 代价是它多跑一轮，但保证「有活人接手」。
 * 反过来若允许多个等待者，死连接就总有机会抢到指令。
 */

type Resolver = () => void;

interface Waiter {
  finish: Resolver;
  /** 摘掉 abort 监听，避免信号源上堆积监听器。 */
  cleanupAbort: () => void;
}

/**
 * 等待者集合。
 *
 * 用 Set 而不是单个 resolver：正常路径下集合里只会有一个成员（单飞），
 * 但 notifyDevice 在 resolve 时是同步遍历，遍历过程中新的等待者可能被
 * 加入（新连接恰好此时到达）。用 Set 能容忍这种重入，不会踩到迭代中的 Map。
 */
const waiters = new Map<string, Set<Waiter>>();

/** 有新指令入队时唤醒该设备所有等待者。 */
export function notifyDevice(deviceId: string): void {
  const set = waiters.get(deviceId);
  if (!set || set.size === 0) return;
  // 先摘掉整组再唤醒：这样被唤醒的 handler 若在拿到控制权前又被通知一次，
  // 不会重复 resolve 同一批 finish（finish 自己也有幂等保护，这里只是更干净）。
  const snapshot = [...set];
  waiters.delete(deviceId);
  for (const waiter of snapshot) {
    try {
      waiter.finish();
    } catch (err) {
      logger.warn({ msg: 'notifyDevice resolver threw', error: (err as Error).message });
    }
  }
}

/** 等待该设备被唤醒，或超时返回，或连接断开时提前返回。 */
export function waitForDevice(
  deviceId: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (timeoutMs <= 0 || abortSignal?.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    // 单飞：先顶掉同设备的旧等待者（旧的多半是已经死掉、服务端还不知道的连接）
    const existing = waiters.get(deviceId);
    if (existing) {
      for (const previous of [...existing]) {
        logger.warn({ msg: 'displacing stale device long-poll waiter', deviceId });
        previous.finish();
      }
    }

    let settled = false;
    // 先占位再补实现：finish 与 cleanupAbort 互相引用，且 finish 会同步
    // 遍历到 waiter，所以 waiter 必须先于两者存在。
    const waiter: Waiter = {
      finish: () => {},
      cleanupAbort: () => {},
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiter.cleanupAbort();
      const current = waiters.get(deviceId);
      if (current) {
        current.delete(waiter);
        if (current.size === 0) waiters.delete(deviceId);
      }
      resolve();
    };

    // 注意顺序：timer 必须先赋值再 add 监听。若 abortSignal 在赋值前就已经
    // abort，finish 会被同步调用，那时 timer 还在 TDZ —— 不过 68 行的
    // `abortSignal?.aborted` 已经拦掉了这种情况。
    const timer = setTimeout(finish, timeoutMs);
    waiter.finish = finish;
    waiter.cleanupAbort = () => abortSignal?.removeEventListener('abort', finish);

    // 顶替过程中旧成员可能把整个 Set 删空，所以这里重新取一次。
    let set = waiters.get(deviceId);
    if (!set) {
      set = new Set();
      waiters.set(deviceId, set);
    }
    set.add(waiter);
    // 连接断开 → 立刻把自己摘掉。这不是「有指令了」，只是提前返回，
    // 调用方拿到控制权后会重新查库（见 nextCommand）。
    abortSignal?.addEventListener('abort', finish, { once: true });
  });
}

/** 诊断用：某设备当前挂起的长轮询数量。 */
export function waiterCount(deviceId: string): number {
  return waiters.get(deviceId)?.size ?? 0;
}
