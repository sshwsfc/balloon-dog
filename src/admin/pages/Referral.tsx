import { useState } from 'react'
import { PageHeader } from '../components/ui-kit'
import { StatsTab } from './referral/StatsTab'
import { WithdrawalsTab } from './referral/WithdrawalsTab'
import { InviteesTab } from './referral/InviteesTab'
import { RewardsTab } from './referral/RewardsTab'
import { CouponsTab } from './referral/CouponsTab'
import { ConfigTab } from './referral/ConfigTab'
import { RulesTab } from './referral/RulesTab'
import { RiskTab } from './referral/RiskTab'

const TABS = [
  { key: 'stats', label: '统计概览' },
  { key: 'withdrawals', label: '提现审核' },
  { key: 'invitees', label: '邀请记录' },
  { key: 'rewards', label: '返现明细' },
  { key: 'coupons', label: '优惠券' },
  { key: 'config', label: '活动配置' },
  { key: 'rules', label: '规则与阶梯' },
  { key: 'risk', label: '风险排查' },
] as const

type TabKey = (typeof TABS)[number]['key']

/**
 * 分享提成 / 邀请返现。
 *
 * 八块内容放在一个页面里用标签切换，而不是拆成八个侧栏入口：
 * 它们共同描述同一个活动（家长邀请好友能拿多少、我们怎么审、钱发没发出去），
 * 运营改规则时要顺手看统计和提现，分成八个菜单会让人来回跳。
 *
 * 口径提醒（页面到处都在用，先说清楚免得看数的人误会）：
 *  - 所有金额在前后端之间一律用「分」传递，只在展示和输入时换算成元；
 *  - 「返现」和「提现」是两个独立状态机：返现 pending→settled，提现 pending→approved→paid；
 *  - 风控页只列可疑清单，没有处罚按钮，判断必须由人工做出。
 */
export default function ReferralPage() {
  const [tab, setTab] = useState<TabKey>('stats')

  return (
    <div>
      <PageHeader
        title="分享提成 / 邀请返现"
        description="家长邀请好友注册并充值后按阶梯返现，返现按当月统计、次月发放，发放后可申请提现。这里管规则、配置、审核与风控。"
      />

      <div className="mb-3 flex flex-wrap gap-1 border-b">
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
      {tab === 'withdrawals' ? <WithdrawalsTab /> : null}
      {tab === 'invitees' ? <InviteesTab /> : null}
      {tab === 'rewards' ? <RewardsTab /> : null}
      {tab === 'coupons' ? <CouponsTab /> : null}
      {tab === 'config' ? <ConfigTab /> : null}
      {tab === 'rules' ? <RulesTab /> : null}
      {tab === 'risk' ? <RiskTab /> : null}
    </div>
  )
}
