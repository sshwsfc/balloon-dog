/**
 * 分机型修复步骤（规划 §1.4）。
 *
 * 为什么要把「怎么修」做成数据而不是文案：
 *
 * 家长端能看见「电池优化白名单没开」，但**修不了** —— 那一步必须有人在孩子手机上
 * 点系统设置，而「设置 → 应用 → 电池」这条路径在小米、华为、OPPO、vivo 上全都不一样。
 * 只给一句「请关闭电池优化」，家长大概率走进一个看起来像、其实不对的开关，然后回来
 * 点「重新检测」，发现还是红的，于是不再相信这一页。
 *
 * 所以：能自动修的（`fixability: 'auto'`）不给步骤 —— 点「重新检测」就好，
 * 多写一步反而让人以为要手动；谁都修不了的（`'none'`）也不给步骤 —— 那种情况
 * 系统就是不允许，给步骤等于骗人。**只给 `'manual'` 的项**。
 *
 * 品牌从设备上报的 `model` 猜（`brandOf`）。猜不出来就给通用步骤，通用步骤本身
 * 也写成「路径 + 要点」两步，而不是只写一个设置项名字。
 */

/** 认得的机型家族。`generic` 是兜底，不是某个品牌。 */
export type OemBrand = 'xiaomi' | 'huawei' | 'oppo' | 'vivo' | 'samsung' | 'generic'

/**
 * 从 `model` 字符串认品牌。
 *
 * 设备端上报的是 `Build.MANUFACTURER + ' ' + Build.MODEL` 这类自由文本（例如
 * `Xiaomi 2211133C`、`HONOR ELP-AN00`），所以这里只能做**包含匹配**，并且要覆盖子品牌
 * —— 家长不知道「一加」的省电开关在「OPPO 系的设置」里，但系统就是这么排的。
 *
 * 认不出来一律 generic。宁可给通用步骤，也不要猜错品牌指错路。
 */
export function brandOf(model: string | null | undefined): OemBrand {
  const m = (model ?? '').toLowerCase()
  if (!m) return 'generic'
  // 子品牌按「设置路径的实际归属」归并：redmi/poco 在小米的菜单下，
  // honor 的设置项与华为同源，一加/realme 走 OPPO 的 ColorOS，iQOO 走 vivo 的 OriginOS。
  if (/(xiaomi|redmi|poco|mi\b|mii? \d)/.test(m)) return 'xiaomi'
  if (/(huawei|honor|hmd|nova|mate|p\d{2}|elp-|any-)/.test(m)) return 'huawei'
  if (/(oppo|oneplus|realme|pjc|pht|phb|cph|ne221)/.test(m)) return 'oppo'
  if (/(vivo|iqoo|v\d{4}|pd\d{4})/.test(m)) return 'vivo'
  if (/(samsung|sm-|galaxy)/.test(m)) return 'samsung'
  return 'generic'
}

/** 每个需要手动修的缺口：通用步骤 + 分机型覆盖。 */
const GAP_STEPS: Record<string, { generic: string[]; xiaomi?: string[]; huawei?: string[]; oppo?: string[]; vivo?: string[]; samsung?: string[] }> = {
  deviceOwner: {
    generic: [
      '设备所有者只能在手机「刚恢复出厂、还没登录任何账号」时设置；已经用过的手机系统会拒绝',
      '做法：在电脑上装 adb，用 USB 连上孩子手机并打开「开发者选项 → USB 调试」，执行：adb shell dpm set-device-owner com.balloondog.agent/.capability.AgentAdminReceiver',
      '设置成功前不要在这台手机上登录账号或装其它应用，否则只能恢复出厂重来',
      '没有设备所有者时，防卸载与防强停会失效，但锁定、限时、应用拦截仍然有效',
    ],
  },
  overlay: {
    generic: [
      '打开「设置 → 应用 → 气球狗 → 在其他应用上层显示」（部分机型在「特殊应用权限」里），打开开关',
      '打开后按一次返回键试试：锁定页应该盖在最上层，按返回也退不出去',
    ],
    xiaomi: [
      '打开「设置 → 应用设置 → 应用管理 → 气球狗 → 权限管理 → 显示悬浮窗」，选「始终允许」',
      '如果这项是灰的，先关掉「设置 → 更多设置 → 开发者选项 → 关闭权限监控」再回来打开',
    ],
    huawei: [
      '打开「设置 → 应用 → 应用管理 → 气球狗 → 权限 → 悬浮窗」，允许',
      '荣耀机型路径相同，可能在「设置 → 应用 → 权限管理 → 悬浮窗」下',
    ],
    oppo: [
      '打开「设置 → 应用 → 特殊应用权限 → 显示在其他应用上层」，允许气球狗',
      'ColorOS 还可能在「设置 → 应用管理 → 气球狗 → 权限 → 悬浮窗」下再要一次',
    ],
    vivo: [
      '打开「设置 → 更多设置 → 权限管理 → 气球狗 → 悬浮窗」，允许',
      'OriginOS 在「设置 → 应用与权限 → 权限管理 → 悬浮窗」下',
    ],
    samsung: ['打开「设置 → 应用程序 → 气球狗 → 在其他应用上显示」，允许'],
  },
  batteryWhitelist: {
    generic: [
      '打开「设置 → 应用 → 气球狗 → 电池」，把省电策略改成「无限制 / 不优化」',
      '再确认「设置 → 电池」里没有开着「超级省电 / 低电量模式」',
      '改完回到这一页点「重新检测」—— 设备要再报一次快照才算数',
    ],
    xiaomi: [
      '打开「设置 → 应用设置 → 应用管理 → 气球狗 → 省电策略」，选「无限制」',
      '同一页把「自启动」打开（MIUI 会单独掐后台）',
      '回到这一页点「重新检测」确认已生效',
    ],
    huawei: [
      '打开「设置 → 应用 → 应用启动管理」，关掉气球狗的「自动管理」',
      '在弹出的三个开关里全部允许：自启动、关联启动、后台活动',
      '再到「设置 → 电池 → 更多电池设置」，关掉「休眠时始终保持网络连接」的限制',
      '回到这一页点「重新检测」确认已生效',
    ],
    oppo: [
      '打开「设置 → 电池 → 更多设置 → 睡眠待机优化」，把气球狗设为「不优化」',
      '打开「设置 → 应用 → 应用管理 → 气球狗 → 耗电管理」，允许「后台运行」和「自启动」',
      '在最近任务里下拉气球狗卡片，点一下小锁图标把它锁住',
      '回到这一页点「重新检测」确认已生效',
    ],
    vivo: [
      '打开「设置 → 电池 → 后台高耗电」，允许气球狗',
      '打开「i 管家 → 应用管理 → 权限管理 → 自启动」，允许气球狗',
      '打开「设置 → 更多设置 → 权限管理 → 气球狗」，允许「后台运行」',
      '回到这一页点「重新检测」确认已生效',
    ],
    samsung: [
      '打开「设置 → 电池和设备维护 → 电池 → 后台使用限制」，把气球狗加入「永不休眠的应用」',
      '打开「设置 → 应用程序 → 气球狗 → 电池」，选「不受限制」',
      '关掉「设置 → 电池和设备维护 → 电池 → 更多电池设置 → 自适应电池」对它的限制',
      '回到这一页点「重新检测」确认已生效',
    ],
  },
  vpnConsent: {
    generic: [
      '打开「设置 → 网络和互联网 → VPN」，确认气球狗处于「已连接」；被撤销过的话这里会显示「已断开」',
      '如果被撤销了，先在手机上打开一次气球狗，系统会重新弹授权框，点「确定」',
      '永久 VPN 也要一起开：同一页点气球狗右侧的齿轮 → 打开「始终开启的 VPN」',
    ],
    huawei: ['「设置 → 更多连接 → VPN」下确认气球狗已连接；华为会额外要一次锁屏密码确认'],
    samsung: ['「设置 → 连接 → 更多连接设置 → VPN」下确认气球狗已连接'],
  },
  usageAccess: {
    generic: [
      '打开「设置 → 应用 → 特殊应用权限 → 使用情况访问权限」，允许气球狗',
      '部分机型叫「有权查看使用情况的应用」，同一个地方',
      '没有它，逐应用限时与「今日用了多久」都会是 0',
    ],
    xiaomi: ['打开「设置 → 隐私保护 → 特殊权限设置 → 使用情况访问」，允许气球狗'],
    huawei: ['打开「设置 → 隐私 → 更多隐私设置 → 使用情况访问」，允许气球狗'],
    oppo: ['打开「设置 → 应用 → 特殊应用权限 → 使用情况访问」，允许气球狗'],
    vivo: ['打开「设置 → 更多设置 → 权限管理 → 使用情况访问」，允许气球狗'],
  },
}

/** 运行时权限被拒时怎么开。键与 `HEALTH_PERMISSION_DEFS` 一致。 */
const PERMISSION_STEPS: Record<string, { generic: string[]; xiaomi?: string[]; huawei?: string[]; oppo?: string[]; vivo?: string[]; samsung?: string[] }> = {
  location: {
    generic: ['打开「设置 → 应用 → 气球狗 → 权限 → 位置信息」，选「始终允许」', '只选「仅在使用时允许」的话，后台定位会在息屏后停掉'],
    xiaomi: ['「设置 → 应用设置 → 应用管理 → 气球狗 → 权限管理 → 定位」选「始终允许」'],
  },
  camera: { generic: ['打开「设置 → 应用 → 气球狗 → 权限 → 相机」，允许'] },
  mic: { generic: ['打开「设置 → 应用 → 气球狗 → 权限 → 麦克风」，允许'] },
  callLog: { generic: ['打开「设置 → 应用 → 气球狗 → 权限 → 通话记录」，允许', '这个权限只有「默认电话应用」或设备所有者模式才能拿到，普通模式可能不给'] },
  sms: { generic: ['打开「设置 → 应用 → 气球狗 → 权限 → 短信」，允许', '同样受默认短信应用限制，拿不到时不要反复重试'] },
  notification: {
    generic: [
      '打开「设置 → 应用 → 气球狗 → 通知」，允许通知',
      'Android 13 及以上还要在应用内首次弹「是否允许通知」时点允许；错过就只能在这一页手动开',
      '部分机型有「通知分类」，要确保「管控提醒」这一类没有被单独关掉',
    ],
    xiaomi: ['「设置 → 应用设置 → 应用管理 → 气球狗 → 通知管理」允许；MIUI 还要关掉「通知过滤」'],
    huawei: ['「设置 → 通知 → 气球狗」允许；华为还要在「通知 → 更多通知设置」里关掉「智能分类」'],
  },
}

function pick(
  table: Record<string, { generic: string[] } & Partial<Record<OemBrand, string[]>>>,
  key: string,
  model: string | null | undefined,
): string[] {
  const entry = table[key]
  if (!entry) return []
  const brand = brandOf(model)
  // 先按品牌找覆盖，找不到就用通用步骤 —— 通用步骤不是「占位」，它本身是可执行的
  return entry[brand] ?? entry.generic
}

/**
 * 某个缺口的修复步骤。只有 `manual` 的项才该调用它（调用方判断 `fixability`）。
 */
export function gapFixSteps(gapId: string, model: string | null | undefined): string[] {
  // 加固项是 `restriction:<id>` 形式，全部能自动修，不该走到这里
  if (gapId.startsWith('restriction:')) return []
  return pick(GAP_STEPS, gapId, model)
}

/**
 * 某项运行时权限被拒时的开启步骤。
 *
 * `isDeviceOwner` 为真时不该调用：设备所有者模式下这些权限是静默自授的，
 * 显示成「被拒」只可能是快照过期，给步骤反而误导。
 */
export function permissionFixSteps(key: string, model: string | null | undefined): string[] {
  return pick(PERMISSION_STEPS, key, model)
}
