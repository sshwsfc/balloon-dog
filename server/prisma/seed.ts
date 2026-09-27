/**
 * 种子数据。
 *
 * 幂等：可重复执行。演示账号与演示设备会先清理再重建，
 * 题库只在为空时灌入（避免把你自己加的题冲掉）。
 *
 * 运行：npm run seed
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { FEATURE_DEFS } from '../src/features/devices/devices.constants';

const DEMO_PHONE = '13800138000';
const DEMO_PASSWORD = 'balloon123';

/** 内置管理员。⚠️ 上线前必须登录后台改掉这个密码。 */
const DEMO_ADMIN_USERNAME = 'admin';
const DEMO_ADMIN_PASSWORD = 'balloon-admin-2026';

/** 题库：类型 × 年级。迁移自 mock 数据，并补齐多个年级。 */
interface SeedQuestion {
  type: 'english' | 'poetry';
  grade: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
}

const QUESTIONS: SeedQuestion[] = [
  // ---- 英文单词（三年级起）----
  { type: 'english', grade: 'grade3', question: "What does 'apple' mean?", options: ['苹果', '香蕉', '橙子', '西瓜'], correctAnswer: 0, explanation: 'apple 是苹果' },
  { type: 'english', grade: 'grade3', question: "What does 'book' mean?", options: ['书', '笔', '桌子', '椅子'], correctAnswer: 0, explanation: 'book 是书' },
  { type: 'english', grade: 'grade3', question: "What does 'cat' mean?", options: ['狗', '猫', '鸟', '鱼'], correctAnswer: 1, explanation: 'cat 是猫' },
  { type: 'english', grade: 'grade3', question: "What does 'sun' mean?", options: ['月亮', '星星', '太阳', '云'], correctAnswer: 2, explanation: 'sun 是太阳' },
  { type: 'english', grade: 'grade3', question: "What does 'water' mean?", options: ['火', '土', '空气', '水'], correctAnswer: 3, explanation: 'water 是水' },
  { type: 'english', grade: 'grade3', question: "What does 'teacher' mean?", options: ['学生', '老师', '医生', '司机'], correctAnswer: 1, explanation: 'teacher 是老师' },
  { type: 'english', grade: 'grade4', question: "What does 'hospital' mean?", options: ['学校', '医院', '银行', '公园'], correctAnswer: 1, explanation: 'hospital 是医院' },
  { type: 'english', grade: 'grade4', question: "What does 'weather' mean?", options: ['星期', '天气', '时间', '季节'], correctAnswer: 1, explanation: 'weather 是天气' },
  { type: 'english', grade: 'grade4', question: "What does 'favourite' mean?", options: ['最喜欢的', '害怕的', '无聊的', '困难的'], correctAnswer: 0, explanation: 'favourite 是最喜欢的' },
  { type: 'english', grade: 'grade5', question: "What does 'because' mean?", options: ['但是', '因为', '所以', '虽然'], correctAnswer: 1, explanation: 'because 是因为' },
  { type: 'english', grade: 'grade5', question: "What does 'different' mean?", options: ['相同的', '不同的', '困难的', '有趣的'], correctAnswer: 1, explanation: 'different 是不同的' },
  { type: 'english', grade: 'grade5', question: "What does 'usually' mean?", options: ['从不', '通常', '偶尔', '总是'], correctAnswer: 1, explanation: 'usually 是通常' },
  { type: 'english', grade: 'grade6', question: "What does 'environment' mean?", options: ['实验', '环境', '设备', '成绩'], correctAnswer: 1, explanation: 'environment 是环境' },
  { type: 'english', grade: 'grade6', question: "What does 'succeed' mean?", options: ['失败', '成功', '放弃', '尝试'], correctAnswer: 1, explanation: 'succeed 是成功' },

  // ---- 古诗填空（各年级）----
  { type: 'poetry', grade: 'grade1', question: '春眠不觉晓，__闻啼鸟。', options: ['处处', '时时', '夜夜', '声声'], correctAnswer: 0, explanation: '孟浩然《春晓》：春眠不觉晓，处处闻啼鸟。' },
  { type: 'poetry', grade: 'grade1', question: '床前明月光，疑是地上__。', options: ['霜', '雪', '冰', '水'], correctAnswer: 0, explanation: '李白《静夜思》：床前明月光，疑是地上霜。' },
  { type: 'poetry', grade: 'grade1', question: '举头望明月，低头思__。', options: ['故乡', '家乡', '故里', '家园'], correctAnswer: 0, explanation: '李白《静夜思》：举头望明月，低头思故乡。' },
  { type: 'poetry', grade: 'grade2', question: '白日依山尽，黄河入海__。', options: ['流', '去', '走', '归'], correctAnswer: 0, explanation: '王之涣《登鹳雀楼》：白日依山尽，黄河入海流。' },
  { type: 'poetry', grade: 'grade2', question: '野火烧不尽，春风吹又__。', options: ['生', '长', '出', '来'], correctAnswer: 0, explanation: '白居易《赋得古原草送别》：野火烧不尽，春风吹又生。' },
  { type: 'poetry', grade: 'grade2', question: '锄禾日当午，汗滴禾下__。', options: ['土', '地', '田', '泥'], correctAnswer: 0, explanation: '李绅《悯农》：锄禾日当午，汗滴禾下土。' },
  { type: 'poetry', grade: 'grade3', question: '两个黄鹂鸣翠柳，一行白鹭上__。', options: ['青天', '蓝天', '云间', '长空'], correctAnswer: 0, explanation: '杜甫《绝句》：两个黄鹂鸣翠柳，一行白鹭上青天。' },
  { type: 'poetry', grade: 'grade3', question: '停车坐爱枫林晚，霜叶红于二月__。', options: ['花', '春', '枝', '霞'], correctAnswer: 0, explanation: '杜牧《山行》：停车坐爱枫林晚，霜叶红于二月花。' },
  { type: 'poetry', grade: 'grade4', question: '不知细叶谁裁出，二月春风似__。', options: ['剪刀', '画笔', '丝线', '轻纱'], correctAnswer: 0, explanation: '贺知章《咏柳》：不知细叶谁裁出，二月春风似剪刀。' },
  { type: 'poetry', grade: 'grade4', question: '孤帆远影碧空尽，唯见长江天际__。', options: ['流', '来', '去', '游'], correctAnswer: 0, explanation: '李白《黄鹤楼送孟浩然之广陵》：孤帆远影碧空尽，唯见长江天际流。' },
  { type: 'poetry', grade: 'grade5', question: '不要人夸好颜色，只留清气满__。', options: ['乾坤', '人间', '天地', '山河'], correctAnswer: 0, explanation: '王冕《墨梅》：不要人夸好颜色，只留清气满乾坤。' },
  { type: 'poetry', grade: 'grade6', question: '千磨万击还坚劲，任尔东西南北__。', options: ['风', '方', '行', '吹'], correctAnswer: 0, explanation: '郑燮《竹石》：千磨万击还坚劲，任尔东西南北风。' },
];

/** 演示设备（绑定到演示家长）。 */
const DEMO_DEVICES = [
  {
    deviceCode: 'DEMO0001',
    name: '小明的小米手机',
    model: 'Xiaomi 14 Pro',
    os: 'Android',
    osVersion: '14',
    battery: 85,
    network: 'wifi',
    locked: true,
    status: 'online',
    lastActiveMinutesAgo: 1,
  },
  {
    deviceCode: 'DEMO0002',
    name: '小明的 iPad',
    model: 'iPad Pro 12.9',
    os: 'iPadOS',
    osVersion: '17',
    battery: 60,
    network: 'wifi',
    locked: false,
    status: 'offline',
    lastActiveMinutesAgo: 90,
  },
];

/** 未认领设备：用来演示「家长输入绑定码认领」的完整流程。 */
const UNBOUND_DEVICE = {
  deviceCode: 'PAIRME01',
  name: '待绑定的手机',
  model: 'Redmi Note 13',
  os: 'Android',
  osVersion: '14',
  battery: 42,
  network: 'cellular',
};

/** 安全区（带真实坐标，便于验证「定位是否落在安全区内」的判定）。 */
const SAFE_ZONES = [
  { name: '家', address: '北京市朝阳区望京西园四区', latitude: 39.9955, longitude: 116.4709, radiusMeters: 300, type: 'home' },
  { name: '学校', address: '北京市海淀区中关村第一小学', latitude: 39.9836, longitude: 116.3164, radiusMeters: 400, type: 'school' },
];

/** 位置轨迹：一部分在家/学校内（应被判为 home/school），一部分在其它地方。 */
const LOCATION_TRAIL = [
  { latitude: 39.9956, longitude: 116.471, address: '北京市朝阳区望京西园四区', minutesAgo: 8 },
  { latitude: 39.9968, longitude: 116.4813, address: '北京市朝阳区望京SOHO', minutesAgo: 45 },
  { latitude: 39.9837, longitude: 116.3165, address: '北京市海淀区中关村第一小学', minutesAgo: 180 },
  { latitude: 39.9835, longitude: 116.316, address: '北京市海淀区中关村第一小学', minutesAgo: 240 },
  { latitude: 39.9954, longitude: 116.4708, address: '北京市朝阳区望京西园四区', minutesAgo: 600 },
];

function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * 60_000);
}

async function main() {
  console.log('🌱 开始写入种子数据...');

  // ---------- 题库（只在为空时灌入）----------
  const questionCount = await prisma.quizQuestion.count();
  if (questionCount === 0) {
    await prisma.quizQuestion.createMany({ data: QUESTIONS });
    console.log(`   ✓ 题库：写入 ${QUESTIONS.length} 道题`);
  } else {
    console.log(`   · 题库已有 ${questionCount} 道题，跳过`);
  }

  // ---------- 演示家长 ----------
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const parent = await prisma.user.upsert({
    where: { phone: DEMO_PHONE },
    update: { passwordHash, nickname: '张小明', status: 'active' },
    create: {
      phone: DEMO_PHONE,
      passwordHash,
      nickname: '张小明',
      avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${DEMO_PHONE}`,
    },
  });
  console.log(`   ✓ 演示家长：${DEMO_PHONE} / ${DEMO_PASSWORD}（id=${parent.id}）`);

  // ---------- 演示设备（先删后建，保证可重复执行）----------
  await prisma.childDevice.deleteMany({ where: { deviceCode: { in: DEMO_DEVICES.map((d) => d.deviceCode) } } });

  const createdDevices = [];
  for (const spec of DEMO_DEVICES) {
    const device = await prisma.childDevice.create({
      data: {
        userId: parent.id,
        boundAt: minutesAgo(60 * 24 * 7),
        name: spec.name,
        model: spec.model,
        os: spec.os,
        osVersion: spec.osVersion,
        battery: spec.battery,
        network: spec.network,
        locked: spec.locked,
        status: spec.status,
        deviceCode: spec.deviceCode,
        // 演示设备的密钥是固定的（仅用于本地联调，生产环境由设备本地随机生成）
        deviceSecretHash: await bcrypt.hash(`secret-${spec.deviceCode}`, 10),
        agentVersion: '1.0.0',
        lastActiveAt: minutesAgo(spec.lastActiveMinutesAgo),
        avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=${spec.deviceCode}`,
      },
    });
    createdDevices.push(device);

    // 功能开关：按 FEATURE_DEFS 的默认值建立，但演示设备把高级功能打开几个，便于界面演示
    await prisma.deviceFeature.createMany({
      data: FEATURE_DEFS.map((f) => ({
        deviceId: device.id,
        key: f.key,
        enabled:
          f.group === 'basic'
            ? f.defaultEnabled
            : ['quizUnlock', 'remotePhoto'].includes(f.key),
      })),
      skipDuplicates: true,
    });
  }

  const primary = createdDevices[0];
  const secondary = createdDevices[1];

  await prisma.user.update({ where: { id: parent.id }, data: { activeDeviceId: primary.id } });
  console.log(`   ✓ 演示设备：${createdDevices.length} 台（当前设备：${primary.name}）`);

  // ---------- 未认领设备 ----------
  const unbound = await prisma.childDevice.upsert({
    where: { deviceCode: UNBOUND_DEVICE.deviceCode },
    update: { userId: null, boundAt: null, name: UNBOUND_DEVICE.name },
    create: {
      userId: null,
      name: UNBOUND_DEVICE.name,
      model: UNBOUND_DEVICE.model,
      os: UNBOUND_DEVICE.os,
      osVersion: UNBOUND_DEVICE.osVersion,
      battery: UNBOUND_DEVICE.battery,
      network: UNBOUND_DEVICE.network,
      status: 'online',
      deviceCode: UNBOUND_DEVICE.deviceCode,
      deviceSecretHash: await bcrypt.hash(`secret-${UNBOUND_DEVICE.deviceCode}`, 10),
      lastActiveAt: new Date(),
    },
  });
  await prisma.deviceFeature.createMany({
    data: FEATURE_DEFS.map((f) => ({ deviceId: unbound.id, key: f.key, enabled: f.defaultEnabled })),
    skipDuplicates: true,
  });
  console.log(`   ✓ 待认领设备：绑定码 ${UNBOUND_DEVICE.deviceCode}`);

  // ---------- 时间规划 / 应用限制 / 网址拦截 ----------
  for (const device of createdDevices) {
    await prisma.timePlan.upsert({
      where: { deviceId: device.id },
      create: {
        deviceId: device.id,
        enabled: true,
        dailyLimitMinutes: device.id === primary.id ? 120 : 180,
        usedTodayMinutes: device.id === primary.id ? 45 : 20,
      },
      update: {
        enabled: true,
        dailyLimitMinutes: device.id === primary.id ? 120 : 180,
        usedTodayMinutes: device.id === primary.id ? 45 : 20,
        resetAt: new Date(),
      },
    });

    await prisma.quizConfig.upsert({
      where: { deviceId: device.id },
      create: {
        deviceId: device.id,
        enabled: true,
        quizType: 'random',
        grade: 'grade3',
        correctRewardMinutes: 3,
        randomMode: true,
      },
      update: { enabled: true, quizType: 'random', grade: 'grade3', correctRewardMinutes: 3 },
    });
  }

  await prisma.appLimit.deleteMany({ where: { deviceId: primary.id } });
  await prisma.appLimit.createMany({
    data: [
      { deviceId: primary.id, appName: '抖音', packageName: 'com.ss.android.ugc.aweme', dailyLimitMinutes: 15 },
      { deviceId: primary.id, appName: '游戏', packageName: 'com.tencent.tmgp.sgame', dailyLimitMinutes: 30 },
      { deviceId: primary.id, appName: '微信', packageName: 'com.tencent.mm', dailyLimitMinutes: 120 },
    ],
  });

  await prisma.blockedUrl.deleteMany({ where: { deviceId: primary.id } });
  await prisma.blockedUrl.createMany({
    data: [
      { deviceId: primary.id, url: 'gambling.com' },
      { deviceId: primary.id, url: 'adult-example.com' },
    ],
  });

  // 待审核应用（让「应用审核」界面有内容）
  await prisma.appAuditRequest.deleteMany({ where: { deviceId: primary.id, status: 'pending' } });
  await prisma.appAuditRequest.createMany({
    data: [
      { deviceId: primary.id, appName: '某短视频', packageName: 'com.example.shortvideo' },
      { deviceId: primary.id, appName: '某对战游戏', packageName: 'com.example.arena' },
    ],
  });
  console.log('   ✓ 时间规划 / 应用限制 / 网址拦截 / 待审核应用');

  // ---------- 安全区与位置轨迹 ----------
  await prisma.safeZone.deleteMany({ where: { deviceId: primary.id } });
  await prisma.safeZone.createMany({
    data: SAFE_ZONES.map((z) => ({ ...z, deviceId: primary.id })),
  });

  await prisma.locationRecord.deleteMany({ where: { deviceId: primary.id } });
  await prisma.locationRecord.createMany({
    data: LOCATION_TRAIL.map((l) => ({
      deviceId: primary.id,
      latitude: l.latitude,
      longitude: l.longitude,
      address: l.address,
      accuracy: 25,
      type: 'other', // 真实类型由服务端按安全区匹配推导
      recordedAt: minutesAgo(l.minutesAgo),
    })),
  });
  console.log(`   ✓ 安全区 ${SAFE_ZONES.length} 个，位置轨迹 ${LOCATION_TRAIL.length} 条`);

  // ---------- 答题记录 ----------
  await prisma.quizRecord.deleteMany({ where: { deviceId: primary.id } });
  const bank = await prisma.quizQuestion.findMany({ take: 8, orderBy: { createdAt: 'asc' } });
  let rewardTotal = 0;
  for (let i = 0; i < bank.length; i++) {
    const q = bank[i];
    const isCorrect = i % 3 !== 0; // 大约 2/3 正确率
    const rewardMinutes = isCorrect ? 3 : 0;
    rewardTotal += rewardMinutes;
    await prisma.quizRecord.create({
      data: {
        userId: parent.id,
        deviceId: primary.id,
        questionId: q.id,
        type: q.type,
        questionText: q.question,
        userAnswer: isCorrect ? q.correctAnswer : (q.correctAnswer + 1) % q.options.length,
        isCorrect,
        rewardMinutes,
        createdAt: minutesAgo(30 * (bank.length - i)),
      },
    });
  }
  console.log(`   ✓ 答题记录 ${bank.length} 条（累计奖励 ${rewardTotal} 分钟）`);

  // ---------- 指令队列演示数据 ----------
  await prisma.deviceCommand.deleteMany({
    where: { deviceId: { in: [primary.id, secondary.id] } },
  });
  await prisma.deviceCommand.createMany({
    data: [
      {
        deviceId: primary.id,
        type: 'lock',
        status: 'succeeded',
        payload: { __revert: { locked: false, tempUnlockUntil: null } },
        result: { locked: true },
        requestedBy: parent.id,
        expiresAt: minutesAgo(-5),
        dispatchedAt: minutesAgo(32),
        finishedAt: minutesAgo(31),
        createdAt: minutesAgo(33),
      },
      {
        deviceId: primary.id,
        type: 'remote_photo',
        status: 'succeeded',
        result: { mediaId: null, note: '演示记录：设备已回传照片' },
        requestedBy: parent.id,
        expiresAt: minutesAgo(-5),
        dispatchedAt: minutesAgo(12),
        finishedAt: minutesAgo(11),
        createdAt: minutesAgo(13),
      },
      {
        deviceId: secondary.id,
        type: 'sync_config',
        status: 'pending',
        payload: {},
        requestedBy: parent.id,
        // 将来的过期时间：这是一条「等设备上线后执行」的排队指令
        expiresAt: new Date(Date.now() + 5 * 60_000),
        createdAt: minutesAgo(2),
      },
    ],
  });
  console.log('   ✓ 指令队列演示数据（2 条已完成 + 1 条待设备领取）');

  // ---------- 内置管理员 ----------
  const adminPasswordHash = await bcrypt.hash(DEMO_ADMIN_PASSWORD, 10);
  const admin = await prisma.admin.upsert({
    where: { username: DEMO_ADMIN_USERNAME },
    update: { passwordHash: adminPasswordHash, role: 'super', status: 'active' },
    create: {
      username: DEMO_ADMIN_USERNAME,
      passwordHash: adminPasswordHash,
      name: '超级管理员',
      role: 'super',
      status: 'active',
    },
  });
  // 再补一个只读运营账号，用来演示角色差异（operator 不能管理管理员账号）
  const operatorPasswordHash = await bcrypt.hash('balloon-operator-2026', 10);
  await prisma.admin.upsert({
    where: { username: 'operator' },
    update: { passwordHash: operatorPasswordHash, role: 'operator', status: 'active' },
    create: {
      username: 'operator',
      passwordHash: operatorPasswordHash,
      name: '运营账号',
      role: 'operator',
      status: 'active',
    },
  });
  console.log(`   ✓ 管理员：${admin.username}（超级管理员）/ operator（运营）`);

  console.log('\n✅ 种子数据写入完成');
  console.log('   家长端：' + DEMO_PHONE + ' / ' + DEMO_PASSWORD);
  console.log('   管理后台：' + DEMO_ADMIN_USERNAME + ' / ' + DEMO_ADMIN_PASSWORD + '  ⚠️ 上线前务必修改');
  console.log('   运营账号：operator / balloon-operator-2026');
  console.log(`   绑定码演示：${UNBOUND_DEVICE.deviceCode}`);
}

main()
  .catch((err) => {
    console.error('❌ 种子数据写入失败：', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
