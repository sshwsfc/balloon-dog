import { useEffect, useState } from 'react'
import { api } from '@/services/api'
import type { DeviceApp } from '@/types'

/**
 * 「应用名 / 包名 → 图标地址」的共享映射。
 *
 * <h3>为什么需要一张映射表</h3>
 * 后端只在 `GET /api/device-apps` 的响应里给 `iconUrl`，但家长端展示应用的
 * 地方五花八门：有的拿得到包名（模式白名单、插件清单、逐应用限额），
 * 有的只有一个应用名字符串（洞察明细、用量上限、最近活跃应用）。
 * 与其让每个接口都多带一个图标地址，不如在客户端建一张表 ——
 * 应用清单本来就不大（最多 500 条，且不含图标字节），一次请求全站复用。
 *
 * <h3>缓存策略</h3>
 * 模块级缓存 + 5 分钟 TTL：一个页面里可能有七八处 `<AppIcon>`，
 * 不能让它们各自去请求一次。图标本身几乎不变，所以除了首次加载之外，
 * 后续都是白拿。孩子端重新上报图标后点「刷新应用列表」会走
 * {@link invalidateAppIcons} 立刻作废。
 */
export interface AppIconMap {
  byPackage: Map<string, string>
  byName: Map<string, string>
  /** 取不到就返回 null，调用方自己退回「首字徽标」那一档 */
  urlFor: (key: { packageName?: string | null; appName?: string | null }) => string | null
}

const CACHE_TTL_MS = 5 * 60 * 1000

const EMPTY_MAP: AppIconMap = {
  byPackage: new Map(),
  byName: new Map(),
  urlFor: () => null,
}

let cache: { at: number; map: AppIconMap } | null = null
let inflight: Promise<void> | null = null

/** 应用名归一化：不同接口给的同一个应用可能多一个空格、大小写不同。 */
function normalizeAppName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '')
}

function buildMap(apps: DeviceApp[]): AppIconMap {
  const byPackage = new Map<string, string>()
  const byName = new Map<string, string>()

  for (const app of apps) {
    if (!app.iconUrl) continue
    byPackage.set(app.packageName, app.iconUrl)
    // 同名不同包时认第一个：给谁都算合理，但别让后一个把前一个覆盖掉
    const key = normalizeAppName(app.appName || app.packageName)
    if (key && !byName.has(key)) byName.set(key, app.iconUrl)
  }

  return {
    byPackage,
    byName,
    urlFor: ({ packageName, appName }) => {
      if (packageName) {
        const hit = byPackage.get(packageName)
        if (hit) return hit
      }
      if (appName) {
        const hit = byName.get(normalizeAppName(appName))
        if (hit) return hit
      }
      return null
    },
  }
}

/** 作废缓存：设备重新上报应用/图标之后调用，下一次渲染会重新拉。 */
export function invalidateAppIcons(): void {
  cache = null
}

async function loadAppIcons(): Promise<void> {
  if (!inflight) {
    inflight = api
      // 必须带上系统应用：孩子端给相机、时钟、设置这些预装应用也抓了图标
      // （它们全是 FLAG_SYSTEM），不带的话「显示系统应用」一打开就全掉回文字块。
      // 列表响应里只有名字和 URL，没有字节，多这几百条很便宜。
      .getDeviceApps({ includeSystem: true })
      .then((res) => {
        cache = { at: Date.now(), map: buildMap(res.apps ?? []) }
      })
      .catch(() => {
        // 图标是展示层的锦上添花：拿不到就继续用首字徽标。
        // 这里刻意不往外抛，免得一个图标请求把页面的错误态点亮。
      })
      .finally(() => {
        inflight = null
      })
  }
  await inflight
}

export function useAppIcons(): AppIconMap {
  // 初值直接读缓存：同一个页面里后续挂载的组件不用等 effect 就有图
  const [map, setMap] = useState<AppIconMap>(() => cache?.map ?? EMPTY_MAP)

  useEffect(() => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return
    let alive = true
    void loadAppIcons().then(() => {
      if (alive && cache) setMap(cache.map)
    })
    return () => {
      alive = false
    }
  }, [])

  return map
}
