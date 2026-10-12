import { useCallback, useState } from 'react'

/**
 * 首页「快捷操作」栏的内容与顺序。
 *
 * 只存 **id 数组**，不存图标和名称：那些留在首页的动作目录里。
 * 这样将来把某个功能改个叫法或换个图标，用户存下的顺序不会跟着失效；
 * 反过来，真删掉某个功能时，这里的 id 会被 `sanitize` 过滤掉，不会渲染出一个空白按钮。
 *
 * 存储位置是 localStorage（这台设备）。快捷操作是「我这个家长的习惯」，
 * 不是「这个孩子账号的配置」，所以没必要也不应该同步到服务端。
 */
export const QUICK_ACTIONS_STORAGE_KEY = 'balloon_dog_quick_actions_v1'

/** 上限：一行四个，两行封顶。再多，首页首屏就被这一栏吃光了。 */
export const MAX_QUICK_ACTIONS = 8

/**
 * 清洗一份 id 列表。用户在 localStorage 里的东西不可信 ——
 * 可能是旧版本写的、可能被手工改过、可能是别的站点污染进来的。
 */
function sanitize(value: unknown, knownIds: string[], max: number): string[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    if (!knownIds.includes(item)) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= max) break
  }
  return out
}

function readStored(knownIds: string[], max: number): string[] | null {
  try {
    const raw = localStorage.getItem(QUICK_ACTIONS_STORAGE_KEY)
    if (raw === null) return null
    return sanitize(JSON.parse(raw), knownIds, max)
  } catch {
    // JSON 坏了 / localStorage 被禁用：当作没存过，回落到默认，别让首页白屏
    return null
  }
}

function writeStored(ids: string[]) {
  try {
    localStorage.setItem(QUICK_ACTIONS_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // 无痕模式下写入会抛；界面上的顺序本次会话仍然有效，不值得为它报错
  }
}

/**
 * `knownIds` / `defaultIds` 必须是**模块级常量**（引用稳定），
 * 否则每次渲染都会重建回调，白白让下游组件失效。
 */
export function useQuickActions(knownIds: string[], defaultIds: string[]) {
  // 注意用 `=== null` 而不是 `||`：用户把快捷操作**全删光**存下 `[]` 是合法状态，
  // 不能被当成「没存过」又弹回默认，那样就永远删不完了。
  const [ids, setIds] = useState<string[]>(
    () => readStored(knownIds, MAX_QUICK_ACTIONS) ?? defaultIds,
  )

  const commit = useCallback(
    (next: unknown) => {
      const clean = sanitize(next, knownIds, MAX_QUICK_ACTIONS)
      if (clean === null) return
      setIds(clean)
      writeStored(clean)
    },
    [knownIds],
  )

  const add = useCallback(
    (id: string) => {
      setIds((current) => {
        const next = sanitize([...current, id], knownIds, MAX_QUICK_ACTIONS) ?? current
        writeStored(next)
        return next
      })
    },
    [knownIds],
  )

  const remove = useCallback(
    (id: string) => {
      setIds((current) => {
        const next = current.filter((item) => item !== id)
        writeStored(next)
        return next
      })
    },
    [],
  )

  /** 上移 / 下移一格。已经在头尾时原样返回。 */
  const move = useCallback((id: string, delta: -1 | 1) => {
    setIds((current) => {
      const from = current.indexOf(id)
      const to = from + delta
      if (from < 0 || to < 0 || to >= current.length) return current
      const next = [...current]
      next[from] = next[to]
      next[to] = id
      writeStored(next)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    commit(defaultIds)
  }, [commit, defaultIds])

  return {
    ids,
    /** 当前顺序是否与默认不同（用来决定要不要显示「恢复默认」） */
    isDefault: ids.length === defaultIds.length && ids.every((id, i) => id === defaultIds[i]),
    isFull: ids.length >= MAX_QUICK_ACTIONS,
    add,
    remove,
    move,
    reset,
  }
}
