import { useSyncExternalStore } from 'react'

/**
 * 首次使用引导的进度。
 *
 * 进度只记「哪些步骤做完了」，不记当前停在第几步 —— 当前步骤由「第一个没做完的」
 * 推出来，这样用户在任意入口（首页空态、我的、引导页）看到的状态一定一致，
 * 也不会出现「存的是第 3 步、但第 2 步其实没做」的错位。
 *
 * 状态放在模块级 store 里而不是组件内：引导页、首页空态、个人中心都要读它，
 * 用 useSyncExternalStore 订阅可以避免各自 useState 造成的不同步，
 * 也天然绕开「在 effect 里同步 setState」的 lint 问题。
 */

export type OnboardingStepId = 'welcome' | 'install' | 'authorize' | 'bind' | 'done'

/**
 * 引导一共四步：认识它并下载安装包 → 装到孩子手机上 → **在孩子手机上开启授权**
 * → 输入绑定码完成配对。
 *
 * 'authorize' 是后补的一步，起因是用户实测反馈「长按桌面图标就直接把守护软件卸载了」：
 * 装完 APK 只是把应用放进手机，**会不会被卸掉取决于孩子端首页那份授权清单**，
 * 尤其是「设备管理器」——没开它，非设备所有者时卸载前连一句提醒都没有。
 * 这一步原先只是「安装说明」里的一句附注，家长十有八九会跳过，所以提成了独立一步。
 *
 * 'done' 刻意不放在这个数组里：它是走完四步之后的庆功页，不是「一步」，
 * 放进去会让顶部进度点变成 5 个、并且让「第 x / y 步」的分母虚高。
 * firstPendingStep 在四步都做完时会返回 'done'，页面据此渲染庆功页。
 */
export const ONBOARDING_STEPS: OnboardingStepId[] = ['welcome', 'install', 'authorize', 'bind']

interface OnboardingState {
  /** 已完成的步骤 */
  completed: string[]
  /** 走完全部步骤的时间 */
  finishedAt?: string
  /** 用户主动跳过引导的时间；跳过之后不再自动跳转到引导页 */
  skippedAt?: string
}

const STORAGE_KEY = 'balloon_dog_onboarding_v1'
const EMPTY: OnboardingState = { completed: [] }

let cache: OnboardingState | null = null
const listeners = new Set<() => void>()

function parse(raw: string | null): OnboardingState {
  if (!raw) return EMPTY
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingState>
    return {
      completed: Array.isArray(parsed.completed) ? parsed.completed.filter((x) => typeof x === 'string') : [],
      finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : undefined,
      skippedAt: typeof parsed.skippedAt === 'string' ? parsed.skippedAt : undefined,
    }
  } catch {
    // 存储被写坏时当作没走过引导，不要让它把整个页面卡住
    return EMPTY
  }
}

function getSnapshot(): OnboardingState {
  if (cache === null) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(STORAGE_KEY)
    } catch {
      // 隐私模式下读不到，按空处理
    }
    cache = parse(raw)
  }
  return cache
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function commit(next: OnboardingState): void {
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 存不下也不影响本次会话
  }
  for (const listener of listeners) listener()
}

export function markStepDone(step: OnboardingStepId): void {
  const state = getSnapshot()
  if (state.completed.includes(step)) return
  commit({ ...state, completed: [...state.completed, step] })
}

/** 回退一步：把该步骤从「已完成」里摘掉（进度条与当前步骤都是推导出来的）。 */
export function markStepUndone(step: OnboardingStepId): void {
  const state = getSnapshot()
  if (!state.completed.includes(step)) return
  commit({
    ...state,
    completed: state.completed.filter((s) => s !== step),
    // 往回退就意味着还没走完，清掉完成标记，否则「已结束」的状态会拦住再次前进
    finishedAt: undefined,
  })
}

export function finishOnboarding(): void {
  const state = getSnapshot()
  commit({ completed: [...ONBOARDING_STEPS], finishedAt: new Date().toISOString(), skippedAt: state.skippedAt })
}

export function skipOnboarding(): void {
  const state = getSnapshot()
  commit({ ...state, skippedAt: new Date().toISOString() })
}

export function resetOnboarding(): void {
  commit(EMPTY)
}

/** 第一个还没完成的步骤；全做完时返回 'done'。 */
export function firstPendingStep(state: OnboardingState): OnboardingStepId {
  return ONBOARDING_STEPS.find((step) => !state.completed.includes(step)) ?? 'done'
}

export function stepIndex(state: OnboardingState): number {
  return ONBOARDING_STEPS.indexOf(firstPendingStep(state))
}

/**
 * 该不该自动把用户带到引导页：从没走过任何一步、也没主动跳过时才算「首次」。
 * 一旦用户跳过或走过，就只在首页空态里安静地提示，不再抢跳转。
 */
export function shouldAutoStart(state: OnboardingState): boolean {
  return state.completed.length === 0 && !state.skippedAt && !state.finishedAt
}

export function useOnboarding(): OnboardingState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
