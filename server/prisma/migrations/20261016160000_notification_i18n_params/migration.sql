-- 通知标题/正文的插值参数（规划 §2.1 的收尾）。
--
-- 背景：这个项目「中文即 i18n key」，所以固定句子只要在 src/i18n/locales/en.ts 里
-- 加一条就能翻译。但带变量的句子（"小明的小米手机 已失联"）整体不可能是一个 key，
-- 于是英文界面会直接露出中文 —— 这是浏览器 e2e 的英文界面扫描真的抓到过的一类缺陷。
--
-- 做法：库里存**模板**（"{{v0}} 已失联"，它本身就是 key），变量值单独存一列；
-- 前端渲染时 t(title, titleParams)。中文界面因为 zh 没有词典文件，
-- i18next 会原样回显 key 并完成插值，行为和以前完全一样；
-- 英文界面则查得到对应的英文模板。
ALTER TABLE "Notification" ADD COLUMN "titleParams" JSONB;
ALTER TABLE "Notification" ADD COLUMN "bodyParams" JSONB;
