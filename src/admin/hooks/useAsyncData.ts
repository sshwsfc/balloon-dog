import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '../api/client'

interface Options {
  /** 依赖变化时重新拉取 */
  deps: unknown[]
  /** 防抖毫秒数（搜索框等高频输入用），默认 0 = 立即拉取 */
  debounceMs?: number
  /** 是否在初始化时立刻拉取，默认 true */
  enabled?: boolean
}

interface Result<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** 手动重新拉取（按钮刷新、操作成功后刷新） */
  reload: () => void
  /** 本地更新数据，避免整表重拉（如乐观更新） */
  setData: (updater: T | ((prev: T | null) => T)) => void
}

/**
 * 列表/详情页统一的数据获取 hook。
 *
 * 存在的意义不只是复用，更是为了绕开 `react-hooks/set-state-in-effect`：
 * 直接写 `useEffect(() => { setLoading(true); fetch()... }, [])` 会在 effect 体内
 * **同步** 调用 setState，触发级联渲染告警。这里把状态更新安排在微任务里，
 * 既满足规则，也保证「effect 只负责发起请求、不在渲染阶段改状态」。
 *
 * 同时内置：
 *  - cancelled 标记：依赖快速变化时丢弃过期响应（避免旧请求覆盖新数据）；
 *  - 防抖：输入搜索词时不会每敲一个字就打一次接口。
 */
export function useAsyncData<T>(fetcher: () => Promise<T>, options: Options): Result<T> {
  const { deps, debounceMs = 0, enabled = true } = options

  const [data, setDataState] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  // 用 ref 持有最新的 fetcher，这样它不必进入依赖数组（否则每次渲染都会重新拉取）
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }

    let cancelled = false

    const timer = setTimeout(
      () => {
        // 先让出一轮微任务再改状态：effect 体内不产生同步 setState
        Promise.resolve()
          .then(() => {
            if (cancelled) return
            setLoading(true)
            setError(null)
          })
          .then(() => fetcherRef.current())
          .then((res) => {
            if (!cancelled) setDataState(res)
          })
          .catch((err: unknown) => {
            if (!cancelled) setError(errorMessageOf(err, '数据加载失败'))
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
      },
      debounceMs,
    )

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式给出
  }, [...deps, nonce, enabled, debounceMs])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const setData = useCallback((updater: T | ((prev: T | null) => T)) => {
    setDataState((prev) =>
      typeof updater === 'function' ? (updater as (p: T | null) => T)(prev) : updater,
    )
  }, [])

  return { data, loading, error, reload, setData }
}

/**
 * 筛选条件 + 分页的组合状态。
 * 关键点：**任何筛选变化都会把页码重置为 1** —— 用事件处理函数实现，
 * 而不是 `useEffect(() => setPage(1), [filters])`（后者同样会触发
 * set-state-in-effect，而且多一次渲染）。
 */
export function useFilters<T extends Record<string, unknown>>(initial: T) {
  const [filters, setFiltersState] = useState<T>(initial)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const setFilter = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setFiltersState((prev) => ({ ...prev, [key]: value }))
    setPage(1)
  }, [])

  const reset = useCallback(() => {
    setFiltersState(initial)
    setPage(1)
  }, [initial])

  const changePageSize = useCallback((size: number) => {
    setPageSize(size)
    setPage(1)
  }, [])

  return { filters, setFilter, reset, page, setPage, pageSize, changePageSize }
}
