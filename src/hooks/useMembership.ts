import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { api, getAuthToken, toUserMessage } from '@/services/api'
import type {
  MembershipEntitlement,
  MembershipStatus,
  MembershipTier,
  MembershipTierQuotes,
  PurchasableTier,
} from '@/types'

/**
 * 会员状态是**全站共享**的一份数据：首页要拿它决定要不要给高级功能加锁，
 * 洞察页要拿它决定显示升级卡片还是内容，付费成功后所有页面都得立刻跟着变。
 *
 * 所以用模块级 store + `useSyncExternalStore`，而不是每页各拉一次：
 * 各拉一次的问题是付费成功后已经打开的页面不会刷新，
 * 家长会看到「刚付完钱，那个功能还锁着」，只能手动刷一下。
 */

interface MembershipState {
  /** 是否至少成功拉取过一次（失败也算，避免无限重试） */
  loaded: boolean
  loading: boolean
  status: MembershipStatus | null
  entitlements: MembershipEntitlement[]
  tiers: MembershipTierQuotes[]
  /** 后端是否在跑模拟支付 */
  mockPay: boolean
  error: string | null
}

const EMPTY: MembershipState = {
  loaded: false,
  loading: false,
  status: null,
  entitlements: [],
  tiers: [],
  mockPay: false,
  error: null,
}

let state: MembershipState = EMPTY
/** 拉数据时用的令牌指纹：换了账号要重新拉，否则会把上一个账号的档位穿给下一个 */
let loadedForToken: string | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(next: MembershipState): void {
  state = next
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): MembershipState {
  return state
}

const TIER_RANK: Record<MembershipTier, number> = { ordinary: 0, member: 1, super: 2 }

async function load(force = false): Promise<void> {
  const token = getAuthToken()
  if (!token) {
    loadedForToken = null
    if (state !== EMPTY) emit(EMPTY)
    return
  }
  if (!force && state.loaded && loadedForToken === token) return
  if (inflight) return inflight

  emit({ ...state, loading: true, error: null })
  inflight = (async () => {
    try {
      const res = await api.getMembership()
      loadedForToken = token
      emit({
        loaded: true,
        loading: false,
        status: res.status ?? null,
        entitlements: res.entitlements ?? [],
        tiers: res.tiers ?? [],
        mockPay: Boolean(res.mockPay),
        error: null,
      })
    } catch (error: unknown) {
      emit({
        ...state,
        loaded: true,
        loading: false,
        error: toUserMessage(error, '会员信息加载失败'),
      })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 付费成功、登录/登出之后强制重拉。 */
export function refreshMembership(): Promise<void> {
  return load(true)
}

/** 登出时调用：把缓存清掉，别让下一个登录的人看到上一个账号的档位。 */
export function resetMembership(): void {
  loadedForToken = null
  inflight = null
  emit(EMPTY)
}

export interface UseMembershipResult extends MembershipState {
  tier: MembershipTier
  isMember: boolean
  isSuper: boolean
  /** 当前档位是否解锁了某项权益 */
  has: (entitlementKey: string) => boolean
  /** 该权益需要哪一档（用来写「开通会员即可使用」这类文案） */
  requiredTierOf: (entitlementKey: string) => PurchasableTier | null
  refresh: () => Promise<void>
}

export function useMembership(): UseMembershipResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    void load()
  }, [])

  const tier = snapshot.status?.tier ?? 'ordinary'

  const has = useCallback(
    (entitlementKey: string): boolean => {
      const def = snapshot.entitlements.find((e) => e.key === entitlementKey)
      // 未知权益不拦：少拦一次总比把基础功能误锁住强
      if (!def) return true
      return TIER_RANK[tier] >= TIER_RANK[def.minTier]
    },
    [snapshot.entitlements, tier],
  )

  const requiredTierOf = useCallback(
    (entitlementKey: string): PurchasableTier | null =>
      snapshot.entitlements.find((e) => e.key === entitlementKey)?.minTier ?? null,
    [snapshot.entitlements],
  )

  return {
    ...snapshot,
    tier,
    isMember: TIER_RANK[tier] >= TIER_RANK.member,
    isSuper: TIER_RANK[tier] >= TIER_RANK.super,
    has,
    requiredTierOf,
    refresh: refreshMembership,
  }
}
