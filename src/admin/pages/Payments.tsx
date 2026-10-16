import { useState } from 'react'
import { PageHeader } from '../components/ui-kit'
import { StatsTab } from './payments/StatsTab'
import { OrdersTab } from './payments/OrdersTab'
import { RefundsTab } from './payments/RefundsTab'
import { InvoicesTab } from './payments/InvoicesTab'

const TABS = [
  { key: 'stats', label: '收款统计' },
  { key: 'orders', label: '订单' },
  { key: 'refunds', label: '退款' },
  { key: 'invoices', label: '发票' },
] as const

type TabKey = (typeof TABS)[number]['key']

/**
 * 支付。
 *
 * 四块内容放在一个页面里用标签切换：它们回答的是同一个问题（钱收进来了没有、
 * 收错的钱退回去没有），排查一笔异常订单时要在统计、订单流水、退款、发票之间来回看，
 * 拆成四个侧栏入口反而要反复跳转。
 */
export default function PaymentsPage() {
  const [tab, setTab] = useState<TabKey>('stats')

  return (
    <div>
      <PageHeader
        title="支付"
        description="真实支付接入的后台：渠道配置体检、订单与渠道流水、人工退款、开票申请。金额一律以「分」记账，展示时换算成元。"
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
      {tab === 'stats' ? <StatsTab /> : null}
      {tab === 'orders' ? <OrdersTab /> : null}
      {tab === 'refunds' ? <RefundsTab /> : null}
      {tab === 'invoices' ? <InvoicesTab /> : null}
    </div>
  )
}
