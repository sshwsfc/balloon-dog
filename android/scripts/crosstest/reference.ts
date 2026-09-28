import { evaluateSchedule, nextScheduleBoundary } from '../../../server/src/features/schedule/schedule.service';

type R = { id: string; name: string; action: string; daysOfWeek: number[]; startMinute: number; endMinute: number; enabled: boolean };
const R = (id: string, action: string, days: number[], s: number, e: number, name = ''): R =>
  ({ id, name, action, daysOfWeek: days, startMinute: s, endMinute: e, enabled: true });

const EVERY = [0,1,2,3,4,5,6];
const WEEKDAYS = [1,2,3,4,5];

const CASES: { name: string; rules: R[] }[] = [
  { name: '每天22:00-07:00锁', rules: [R('a','lock',EVERY,1320,420,'睡觉')] },
  { name: '仅周五22:00-07:00锁(跨天单日)', rules: [R('b','lock',[5],1320,420,'周五晚')] },
  { name: '工作日08:00-12:00锁+每天12:00-13:00放行', rules: [
      R('c','lock',WEEKDAYS,480,720,'上课'), R('d','unlock',EVERY,720,780,'午休')] },
  { name: '全天锁00:00-24:00', rules: [R('e','lock',EVERY,0,1440,'全天')] },
  { name: '周日全天放行+每天22:00-07:00锁', rules: [
      R('f','unlock',[0],0,1440,'周日自由'), R('g','lock',EVERY,1320,420,'睡觉')] },
  { name: '周六10:00-20:00放行+每天09:00-21:00锁', rules: [
      R('h','unlock',[6],600,1200,'周六'), R('i','lock',EVERY,540,1260,'白天')] },
];

// 从一个周一 00:00 开始，每 30 分钟采一次，共 7 天
const start = new Date(2026, 8, 28, 0, 0, 0, 0); // 2026-09-28 是周一
const out: any[] = [];
for (const c of CASES) {
  const points: any[] = [];
  for (let i = 0; i < 7 * 48; i++) {
    const t = new Date(start.getTime() + i * 30 * 60_000);
    const d = evaluateSchedule(c.rules as any, t);
    points.push({ t: t.getTime(), locked: d.locked, rule: d.ruleId });
  }
  const b = nextScheduleBoundary(c.rules as any, start);
  out.push({ case: c.name, points, boundaryAtStart: b ? { at: b.at.getTime(), locked: b.locked } : null });
}
console.log(JSON.stringify(out));
