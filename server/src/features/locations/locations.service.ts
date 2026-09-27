import type { ChildDevice, SafeZone } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { NotFoundError } from '../../errors';

/**
 * 位置与安全区。
 *
 * 与 mock 版的差别：db.json 里那 3 条 locations / 2 条 safeZones 是死数据，
 * 既没有写入口也没有读接口，前端 LocationPage 完全写死在代码里。
 * 这里给出真实的读写链路：设备上报 → 落库 → 家长按时间范围查询 → 与安全区做归属判定。
 */

/** 两点球面距离（米）。用于判断一条定位是否落在某个安全区内。 */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 找出定位点命中的安全区（取最近的一个）。 */
export function matchSafeZone(
  zones: SafeZone[],
  latitude: number,
  longitude: number,
): SafeZone | null {
  let best: SafeZone | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const zone of zones) {
    const d = haversineMeters(latitude, longitude, zone.latitude, zone.longitude);
    if (d <= zone.radiusMeters && d < bestDistance) {
      best = zone;
      bestDistance = d;
    }
  }
  return best;
}

function toZoneView(zone: SafeZone) {
  return {
    id: zone.id,
    deviceId: zone.deviceId,
    name: zone.name,
    latitude: zone.latitude,
    longitude: zone.longitude,
    radiusMeters: zone.radiusMeters,
    address: zone.address,
    type: zone.type,
    createdAt: zone.createdAt,
  };
}

export const locationsService = {
  /**
   * 位置历史。
   * 每条记录都会带上「命中了哪个安全区」，前端因此可以直接区分家/学校/其它，
   * 不需要自己算距离。
   */
  async list(
    device: ChildDevice,
    options: { limit: number; from?: Date; to?: Date },
  ) {
    const [records, zones] = await Promise.all([
      prisma.locationRecord.findMany({
        where: {
          deviceId: device.id,
          ...(options.from || options.to
            ? {
                recordedAt: {
                  ...(options.from ? { gte: options.from } : {}),
                  ...(options.to ? { lte: options.to } : {}),
                },
              }
            : {}),
        },
        orderBy: { recordedAt: 'desc' },
        take: options.limit,
      }),
      prisma.safeZone.findMany({ where: { deviceId: device.id } }),
    ]);

    return records.map((r) => {
      const zone = matchSafeZone(zones, r.latitude, r.longitude);
      return {
        id: r.id,
        deviceId: r.deviceId,
        latitude: r.latitude,
        longitude: r.longitude,
        accuracy: r.accuracy,
        address: r.address,
        // 命中安全区则用安全区类型，否则用上报时的类型
        type: zone?.type ?? r.type,
        zoneId: zone?.id ?? null,
        zoneName: zone?.name ?? null,
        timestamp: r.recordedAt,
      };
    });
  },

  async latest(device: ChildDevice) {
    const record = await prisma.locationRecord.findFirst({
      where: { deviceId: device.id },
      orderBy: { recordedAt: 'desc' },
    });
    if (!record) return null;
    const zones = await prisma.safeZone.findMany({ where: { deviceId: device.id } });
    const zone = matchSafeZone(zones, record.latitude, record.longitude);
    return {
      id: record.id,
      deviceId: record.deviceId,
      latitude: record.latitude,
      longitude: record.longitude,
      accuracy: record.accuracy,
      address: record.address,
      type: zone?.type ?? record.type,
      zoneId: zone?.id ?? null,
      zoneName: zone?.name ?? null,
      timestamp: record.recordedAt,
    };
  },

  async listZones(device: ChildDevice) {
    const zones = await prisma.safeZone.findMany({
      where: { deviceId: device.id },
      orderBy: { createdAt: 'asc' },
    });
    return zones.map(toZoneView);
  },

  async createZone(
    device: ChildDevice,
    input: {
      name: string;
      latitude: number;
      longitude: number;
      radiusMeters: number;
      address?: string;
      type: string;
    },
  ) {
    const zone = await prisma.safeZone.create({
      data: {
        deviceId: device.id,
        name: input.name,
        latitude: input.latitude,
        longitude: input.longitude,
        radiusMeters: input.radiusMeters,
        address: input.address ?? '',
        type: input.type,
      },
    });
    logger.info({ msg: 'safe zone created', deviceId: device.id, zoneId: zone.id });
    return toZoneView(zone);
  },

  async updateZone(
    device: ChildDevice,
    zoneId: string,
    patch: Partial<{
      name: string;
      latitude: number;
      longitude: number;
      radiusMeters: number;
      address: string;
      type: string;
    }>,
  ) {
    // 先确认该安全区确实属于这台设备，避免换 id 改别人家的
    const existing = await prisma.safeZone.findFirst({ where: { id: zoneId, deviceId: device.id } });
    if (!existing) throw new NotFoundError('安全区', zoneId);
    const zone = await prisma.safeZone.update({ where: { id: zoneId }, data: patch });
    return toZoneView(zone);
  },

  async removeZone(device: ChildDevice, zoneId: string) {
    const existing = await prisma.safeZone.findFirst({ where: { id: zoneId, deviceId: device.id } });
    if (!existing) throw new NotFoundError('安全区', zoneId);
    await prisma.safeZone.delete({ where: { id: zoneId } });
    return { success: true };
  },
};

export { toZoneView };
