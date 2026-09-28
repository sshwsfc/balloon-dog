#!/usr/bin/env bash
#
# 交叉验证：Android 的 ScheduleEngine 与后端的 evaluateSchedule 是否给出完全一致的结果。
#
# 为什么值得单独做这件事：
#   「此刻该不该锁」这套语义被实现了两遍 —— 后端用它给家长端做预览，
#   Android 用它在本地强制执行。两份实现一旦漂移，就会出现
#   「家长端显示已解锁、孩子手机却锁着」这类最难排查的问题。
#   规则本身很简单，但跨天区间（22:00→次日 07:00）与 unlock 优先于 lock
#   这两处极易写错，所以用 2016 个采样点逐点比对。
#
# 用法：bash android/scripts/crosstest/run.sh
# 依赖：JDK 17、server/ 的依赖已安装（用到 tsx）

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "$HERE/../.." && pwd)"
REPO_DIR="$(cd "$ANDROID_DIR/.." && pwd)"
AGENT_SRC="$ANDROID_DIR/app/src/main/java/com/balloondog/agent"
WORK="$HERE/.work"

export TZ="${TZ:-Asia/Shanghai}"

rm -rf "$WORK"
mkdir -p "$WORK/out"

echo "==> 1/3 用后端实现生成参考结果（对外契约的权威定义）"
(cd "$REPO_DIR/server" && npx tsx "$HERE/reference.ts") > "$WORK/reference.json"

echo "==> 2/3 用真实的 Android ScheduleEngine 复算"
# ScheduleEngine / ScheduleRule 依赖 androidx 注解与 org.json，用最小桩类顶掉，
# 这样能在普通 JVM 上跑真实的业务代码，而不是把逻辑抄一遍来测。
javac -nowarn -d "$WORK/out" -encoding UTF-8 \
  "$HERE"/stubs/androidx/annotation/*.java \
  "$HERE"/stubs/org/json/*.java \
  "$AGENT_SRC/model/ScheduleRule.java" \
  "$AGENT_SRC/capability/ScheduleEngine.java" \
  "$HERE/CrossCheck.java"
java -Duser.timezone="$TZ" -cp "$WORK/out" CrossCheck > "$WORK/android.json"

echo "==> 3/3 逐点比对"
node "$HERE/compare.mjs" "$WORK/reference.json" "$WORK/android.json"
