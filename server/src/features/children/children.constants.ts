/**
 * 孩子档案与今日任务的规模上限。
 *
 * 全部写在这里而不是散在 DTO / service 里：「一个孩子最多挂 10 台设备」这种数字
 * 一旦出现在两个地方，迟早会出现「DTO 拦在 10、服务层拦在 5」这种自相矛盾。
 */

/** 一个家长最多几个孩子档案 */
export const CHILD_LIMIT = 5;

/** 一个孩子最多挂几台设备 */
export const CHILD_DEVICE_LIMIT = 10;

/** 一天最多布置几个任务 */
export const CHILD_TASK_LIMIT = 20;
