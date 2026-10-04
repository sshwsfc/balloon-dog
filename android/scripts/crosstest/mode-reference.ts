/**
 * 模式求值的后端参考结果。
 *
 * 采样点与 ModeCrossCheck.java 完全一致（同一周、同一批配置、每 30 分钟一点），
 * 由 compare.mjs 逐点比对两边是否给出同一个模式。
 */
import { evaluateMode } from '../../../server/src/features/mode/mode.service';

type Cfg = { manual: string | null; scheduleOn: boolean; slots: [number, number][] };

const cfg = (manual: string | null, scheduleOn: boolean, slots: [number, number][] = []): Cfg =>
  ({ manual, scheduleOn, slots });

const sundayAllDay = (): [number, number][] => {
  const out: [number, number][] = [];
  for (let h = 0; h < 24; h++) out.push([0, h]);
  return out;
};

const CASES: { name: string; cfg: Cfg }[] = [
  { name: '手动学习模式', cfg: cfg('study', false) },
  { name: '手动普通模式', cfg: cfg('normal', false) },
  { name: '未设置且不按时间', cfg: cfg(null, false) },
  // 这条是最容易两边写不一致的：开启时段规划却一格都没选 → 全天学习模式
  { name: '开启时段但一格没选(全天学习)', cfg: cfg(null, true) },
  { name: '周一8/9点+周二10点为学习', cfg: cfg(null, true, [[1, 8], [1, 9], [2, 10]]) },
  { name: '手动学习覆盖时段规划', cfg: cfg('study', true, [[1, 8]]) },
  { name: '手动普通覆盖时段规划', cfg: cfg('normal', true, [[1, 8]]) },
  { name: '周日全天为学习', cfg: cfg(null, true, sundayAllDay()) },
  {
    name: '每天0点与23点为学习',
    cfg: cfg(null, true, [
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0],
      [0, 23], [1, 23], [2, 23], [3, 23], [4, 23], [5, 23], [6, 23],
    ]),
  },
];

// 2026-09-28 是周一
const start = new Date(2026, 8, 28, 0, 0, 0, 0);
const out = CASES.map((c) => {
  const slots = c.cfg.slots.map(([dayOfWeek, hour]) => ({ dayOfWeek, hour }));
  const config = { manualMode: c.cfg.manual, scheduleEnabled: c.cfg.scheduleOn };
  const points: { t: number; mode: string }[] = [];
  for (let i = 0; i < 7 * 48; i++) {
    const t = new Date(start.getTime() + i * 30 * 60_000);
    points.push({ t: t.getTime(), mode: evaluateMode(config, slots, t) });
  }
  return { case: c.name, points };
});
console.log(JSON.stringify(out));
