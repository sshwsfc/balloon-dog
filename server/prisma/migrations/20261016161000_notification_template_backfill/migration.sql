-- 把历史通知里「已经拼好的中文句子」回填成模板 + 参数。
--
-- 背景见 20261016160000_notification_i18n_params：带变量的句子整句没法当 i18n key，
-- 所以现在改成「模板（`'{{v0}} 已失联'`，它本身就是一个 key）+ 参数」。这条迁移负责
-- 把改造之前已经落库的那几行也搬过去 —— 否则英文界面上它们会一直是中文。
--
-- 匹配条件写得很窄：标题必须正好等于「该设备当前的名字 + 固定后缀」，正文也必须对得上
-- 我们自己的固定格式。认不出来的行**原样保留** —— 历史数据宁可留着中文，
-- 也不要靠猜把变量猜错。设备改名过的老行也因此不会被误改。
--
-- 只覆盖真的产生过历史数据的两种类型（失联、进出安全区）；其余类型此前没有落库过，
-- 徒增的改写分支只是风险，不写。

-- ── 1. 失联（升级到「超过一天无法联系」那一档）──
UPDATE "Notification" n
SET "title" = '{{v0}} 已超过一天无法联系',
    "titleParams" = jsonb_build_object('v0', d."name"),
    "body" = '设备已超过 {{v0}} 小时没有任何心跳，可能已关机或卸载了本应用',
    "bodyParams" = jsonb_build_object('v0', (substring(n."body" from '设备已超过 ([0-9]+) 小时'))::int)
FROM "ChildDevice" d
WHERE n."deviceId" = d."id"
  AND n."type" = 'agent_offline'
  AND n."title" = d."name" || ' 已超过一天无法联系'
  AND n."body" ~ '^设备已超过 [0-9]+ 小时没有任何心跳';

-- ── 2. 失联（「最后一次心跳是 N 分钟/小时/天前」）──
-- 注意：不能在 FROM 里用 LATERAL 拿更新目标表的列（PostgreSQL 明确禁止，
-- 报 `invalid reference to FROM-clause entry`）。所以这里把 regexp_match 在 SET 里写两遍。
UPDATE "Notification" n
SET "title" = '{{v0}} 已失联',
    "titleParams" = jsonb_build_object('v0', d."name"),
    "body" = CASE (regexp_match(n."body", '最后一次心跳是([0-9]+)(分钟|小时|天)前'))[2]
               WHEN '分钟' THEN '设备已失联：最后一次心跳是 {{v0}} 分钟前'
               WHEN '小时' THEN '设备已失联：最后一次心跳是 {{v0}} 小时前'
               ELSE '设备已失联：最后一次心跳是 {{v0}} 天前'
             END,
    "bodyParams" = jsonb_build_object(
      'v0',
      ((regexp_match(n."body", '最后一次心跳是([0-9]+)(分钟|小时|天)前'))[1])::int
    )
FROM "ChildDevice" d
WHERE n."deviceId" = d."id"
  AND n."type" = 'agent_offline'
  AND n."title" = d."name" || ' 已失联'
  AND (regexp_match(n."body", '最后一次心跳是([0-9]+)(分钟|小时|天)前'))[1] IS NOT NULL;

-- ── 3. 失联（「刚刚」/「从未活跃」两种没有数字的形式）──
UPDATE "Notification" n
SET "title" = '{{v0}} 已失联',
    "titleParams" = jsonb_build_object('v0', d."name"),
    "body" = '设备已失联：最后一次心跳就在刚刚',
    "bodyParams" = NULL
FROM "ChildDevice" d
WHERE n."deviceId" = d."id"
  AND n."type" = 'agent_offline'
  AND n."title" = d."name" || ' 已失联'
  AND n."body" = '设备已失联：最后一次心跳是刚刚';

UPDATE "Notification" n
SET "title" = '{{v0}} 已失联',
    "titleParams" = jsonb_build_object('v0', d."name"),
    "body" = '设备已失联：这台设备还没有上报过心跳',
    "bodyParams" = NULL
FROM "ChildDevice" d
WHERE n."deviceId" = d."id"
  AND n."type" = 'agent_offline'
  AND n."title" = d."name" || ' 已失联'
  AND n."body" = '设备已失联：最后一次心跳是从未活跃';

-- ── 4. 进出安全区（正文是设备端拼的「进入 学校」/「离开 学校」）──
UPDATE "Notification" n
SET "title" = CASE WHEN n."type" = 'geofence_enter' THEN '{{v0}} 进入了安全区' ELSE '{{v0}} 离开了安全区' END,
    "titleParams" = jsonb_build_object('v0', d."name"),
    "body" = CASE WHEN n."type" = 'geofence_enter' THEN '进入了 {{v0}}' ELSE '离开了 {{v0}}' END,
    "bodyParams" = jsonb_build_object('v0', substring(n."body" from '^(?:进入|离开)[[:space:]]*(.+)$'))
FROM "ChildDevice" d
WHERE n."deviceId" = d."id"
  AND n."type" IN ('geofence_enter', 'geofence_exit')
  AND n."title" IN (d."name" || ' 进入了安全区', d."name" || ' 离开了安全区')
  AND n."body" ~ '^(进入|离开)[[:space:]]*.+$';
