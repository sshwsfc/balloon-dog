import { useState } from 'react'
import { PageHeader } from '../components/ui-kit'
import { PlansTab } from './membership/PlansTab'
import { RulesTab } from './membership/RulesTab'
import { ReferralPriceTab } from './membership/ReferralPriceTab'
import { OrdersTab } from './membership/OrdersTab'
import { StatsTab } from './membership/StatsTab'

const TABS = [
  { key: 'stats', label: '统计' },
  { key: 'plans', label: '套餐' },
  { key: 'rules', label: '定价规则' },
  { key: 'referral', label: '受邀用户定价' },
  { key: 'orders', label: '订单' },
] as const

type TabKey = (typeof TABS)[number]['key']

/**
 * 会员管理。
 *
 * 五块内容放在一个页面里用标签切换，而不是拆成五个侧栏入口：
 * 它们共同描述同一个对象（家长花多少钱买到什么），改规则时要顺手看订单和统计，
 * 分成五个菜单会让人来回跳。
 */
export default function MembershipPage() {
  const [tab, setTab] = useState<TabKey>('stats')

  return (
    <div>
      <PageHeader
        title="会员管理"
        description="三档账号：普通 / 会员 / 超级会员。会员 = 答题解锁 + 远程监控全部功能 + 绑定多台手机；超级会员 = 全部会员功能 + AI 洞察。「受邀用户定价」给被邀请注册的家长定更高的价 —— 他们要承担邀请人的分享返现成本。"
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
      {tab === 'stats' ? <StatsTab active /> : null}
      {tab === 'plans' ? <PlansTab /> : null}
      {tab === 'rules' ? <RulesTab /> : null}
      {tab === 'referral' ? <ReferralPriceTab /> : null}
      {tab === 'orders' ? <OrdersTab /> : null}
    </div>
  )
}
