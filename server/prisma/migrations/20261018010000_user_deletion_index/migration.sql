-- 注销清扫的索引（规划 §5.3）。
--
-- 注销到期清扫会按 deletionScheduledAt 找「该删的账号」。这个字段绝大多数行是 NULL，
-- 但清扫在隐私接口上**惰性兜底**（定时任务停了也不会永远不删），所以它会被反复查。
CREATE INDEX "User_deletionScheduledAt_idx" ON "User"("deletionScheduledAt");
