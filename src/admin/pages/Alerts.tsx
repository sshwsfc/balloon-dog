import { useState } from 'react'
import { PageHeader } from '../components/ui-kit'
import { OverviewTab } from './alerts/OverviewTab'
import { RulesTab } from './alerts/RulesTab'
import { AcksTab } from './alerts/AcksTab'

const TABS = [
  { key: 'overview', label: '告警总览' },
  { key: 'rules', label: '告警规则' },
  { key: 'acks', label: '确认记录' },
] as const

type TabKey = (typeof TABS)[number]['key']

/**
 * 告警大盘。
 *
 * 三块内容共用一套指标口径：总览回答「现在有没有事」，规则回答「这条线是怎么划的」，
 * 确认记录回答「谁看过、当时什么样」。排查一条告警会在这三块之间来回看，拆成三个
 * 侧栏入口反而要反复跳转。
 *
 * 口径提醒（`docs/PLAN-admin-ops.md`）：告警是**读时计算**，没有后台扫描任务；
 * 分母为 0 的比率类指标返回 `null`（界面显示「—」而不是「0%」）；样本最多 5 条，
 * 事故规模一律按真实分子条数展示。
 */
export default function AlertsPage() {
  const [tab, setTab] = useState<TabKey>('overview')

  return (
    <div>
      <PageHeader
        title="告警大盘"
        description="五个指标的实时口径：每个数字都写清分母是谁；比率类分母为 0 时显示「—」，表示暂无可统计对象，而不是 0%。"
      />

      <div className="mb-3 flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
              tab === t.key
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 每个标签自己拉数据：只会挂载当前这一个，不必为没看的标签发请求 */}
      {tab === 'overview' ? <OverviewTab /> : null}
      {tab === 'rules' ? <RulesTab /> : null}
      {tab === 'acks' ? <AcksTab /> : null}
    </div>
  )
}
