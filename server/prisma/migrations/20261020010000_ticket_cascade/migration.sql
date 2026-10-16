-- 删除账号时把工单一起删掉。
--
-- 原来是 SET NULL：账号删了，工单留下来但没了归属 —— 后台还能读到家长写过的正文，
-- 与「删除账号是一次真实的数据删除」相矛盾（订单/同意记录都是级联删除）。
ALTER TABLE "SupportTicket" DROP CONSTRAINT "SupportTicket_userId_fkey";

ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
