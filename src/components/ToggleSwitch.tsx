import { Loader2 } from 'lucide-react'

/**
 * 通用开关。
 *
 * 抽成组件而不是每页复制一遍：HomePage / SchedulePage / InsightsPage 里
 * 已经出现过三份一模一样的实现，新的模式 / 护眼 / 插件页面还要用更多次，
 * 复制粘贴迟早会在某一处漏掉 `role="switch"` 或 `aria-checked`。
 *
 * 注意它**不阻止事件冒泡**：放在可点击卡片里时，调用方要自己包一层
 * `onClick={(e) => e.stopPropagation()}`，否则点开关会同时触发卡片动作。
 */
export function ToggleSwitch({
  checked,
  disabled,
  busy,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  /** 请求进行中：显示小转圈，避免家长以为没点中而连点 */
  busy?: boolean
  /** 无障碍标签，必填：开关本身没有可见文字 */
  label: string
  onChange: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className="w-11 h-6 rounded-full relative flex-shrink-0 disabled:opacity-50"
    >
      <span
        className={`absolute w-5 h-5 rounded-full top-0.5 bg-white shadow transition-all ${
          checked ? 'right-0.5' : 'left-0.5'
        }`}
      />
      <span className={`block w-full h-full rounded-full ${checked ? 'bg-[#07c160]' : 'bg-gray-300'}`} />
      {busy && (
        <Loader2 className="w-3 h-3 absolute inset-0 m-auto animate-spin text-white mix-blend-difference" />
      )}
    </button>
  )
}
