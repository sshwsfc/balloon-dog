import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, toUserMessage } from '@/services/api'

/**
 * 读一个功能开关的状态，并支持就地开启。
 *
 * <p>为什么和 `FeatureGate` 分开放在这里：`react-refresh/only-export-components`
 * 要求一个文件只导出组件，导出 hook 会让 HMR 退化。而按钮禁用（`CallSmsPage`
 * 的页头刷新）和卡片门禁（`FeatureGate`）需要共享同一份状态，所以 hook 单独成文件。
 *
 * <p>三处「不确定就别拦」的取舍，和 `RequireDevice` 一致：
 *  - 还在读开关状态 → `loading`，不先判定「没开」
 *  - 读取失败（网络/服务端问题）→ 放行，让真实请求去报错。把网络故障说成
 *    「功能没开」会让家长在设置里白找一圈。
 *  - 后端没返回这个标识（`enabled` 不是布尔）→ 放行。开关是白名单接口，
 *    前端多列一个不存在的标识时不该把整个功能锁死。
 */
export function useFeatureToggle(feature: string) {
  const { t } = useTranslation()
  const [state, setState] = useState<'loading' | 'on' | 'off'>('loading')
  const [enabling, setEnabling] = useState(false)

  const readState = useCallback(async () => {
    try {
      const features = await api.getFeatures()
      const entry = (features as unknown as Record<string, { enabled?: boolean } | undefined>)[feature]
      // 拿不到这个标识（或它没有 enabled 字段）时按「开着」处理，别把功能锁死
      setState(typeof entry?.enabled === 'boolean' && !entry.enabled ? 'off' : 'on')
    } catch {
      setState('on')
    }
  }, [feature])

  useEffect(() => {
    void readState()
  }, [readState])

  const enable = useCallback(async () => {
    setEnabling(true)
    try {
      await api.enableFeature(feature, true)
      setState('on')
      toast.success(t('已开启'))
    } catch (error: unknown) {
      toast.error(toUserMessage(error))
    } finally {
      setEnabling(false)
    }
  }, [feature, t])

  return { state, enabling, enable }
}
