import { useSyncExternalStore } from 'react'

/**
 * 功能小提示的关闭状态。
 *
 * 每个功能页第一次打开时，在底部浮出一条一句话说明（这个功能到底改了什么、
 * 有什么前提条件），用户可以随时关掉，关掉后不再出现；个人中心有「重置提示」
 * 可以全部恢复。
 *
 * 用模块级 store + useSyncExternalStore 而不是 localStorage + useState：
 * 同一个提示可能在页面里出现多处，且跨页面切换时不该重新读盘。
 */

/** 提示 id 用小而稳定的英文串，**不要用中文文案** —— 改文案不该把用户的关闭状态丢掉。 */
export const TIP_IDS = [
  'home',
  'location',
  'schedule',
  'mode',
  'eyeCare',
  'appPlugins',
  'appAudit',
  'callSms',
  'remoteHelp',
  'insights',
  'media',
  'quiz',
  'devices',
] as const

export type TipId = (typeof TIP_IDS)[number]

const STORAGE_KEY = 'balloon_dog_dismissed_tips_v1'

let cache: Set<string> | null = null
const listeners = new Set<() => void>()

function getSnapshot(): Set<string> {
  if (cache === null) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(STORAGE_KEY)
    } catch {
      // 隐私模式下读不到，按「都没关过」处理
    }
    try {
      const parsed = raw ? (JSON.parse(raw) as unknown) : []
      cache = new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      cache = new Set()
    }
  }
  return cache
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function commit(next: Set<string>): void {
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // 存不下也不影响本次会话
  }
  for (const listener of listeners) listener()
}

export function dismissTip(id: TipId): void {
  const current = getSnapshot()
  if (current.has(id)) return
  commit(new Set([...current, id]))
}

export function resetTips(): void {
  commit(new Set())
}

export function useDismissedTips(): Set<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useFeatureTip(id: TipId): { visible: boolean; dismiss: () => void } {
  const dismissed = useDismissedTips()
  return { visible: !dismissed.has(id), dismiss: () => dismissTip(id) }
}
