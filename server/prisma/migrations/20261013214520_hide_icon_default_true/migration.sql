-- 桌面图标默认隐藏（需求：「不应该在桌面显示图标，桌面的图标可以直接长按卸载应用」）。
--
-- 建表时的默认值是 false，于是新绑定的设备图标一律显示在桌面上，
-- 孩子长按即可卸载 —— 与产品预期相反。这里把默认值改成 true。

-- AlterTable
ALTER TABLE "ChildDevice" ALTER COLUMN "hideIcon" SET DEFAULT true;

-- 回填存量设备：原来默认 false 建出来的行同样应该是「隐藏」。
-- 家长端「隐藏图标」开关依旧可以把这个字段改回 false（图标重新显示），
-- 所以回填不会封死家长的恢复路径。
UPDATE "ChildDevice" SET "hideIcon" = true;
