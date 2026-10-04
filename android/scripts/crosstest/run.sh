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

echo "==> 3/4 逐点比对（作息时间表）"
node "$HERE/compare.mjs" "$WORK/reference.json" "$WORK/android.json"

echo "==> 4/4 逐点比对（学习模式求值）"
# 同一套思路：模式求值也实现了两遍（后端给家长端展示、Android 本地强制执行），
# 漂移的症状是「家长端显示普通模式、孩子手机却在学习模式」。
(cd "$REPO_DIR/server" && npx tsx "$HERE/mode-reference.ts") > "$WORK/mode-reference.json"
# -cp 指向第 2 步编译出的桩类目录：ModeConfig 依赖 org.json，
# 而那套桩已经躺在 $WORK/out 里了
javac -nowarn -cp "$WORK/out" -d "$WORK/out" -encoding UTF-8 \
  "$AGENT_SRC/model/ModeConfig.java" \
  "$AGENT_SRC/capability/StudyModeEngine.java" \
  "$HERE/ModeCrossCheck.java"
java -Duser.timezone="$TZ" -cp "$WORK/out" ModeCrossCheck > "$WORK/mode-android.json"
node "$HERE/compare-mode.mjs" "$WORK/mode-reference.json" "$WORK/mode-android.json"

echo "==> 5/5 学习模式 / 插件管控的判定逻辑"
# 这两套判定依赖界面可见文本，而模拟器里没装微信/QQ，端到端复现不出来，
# 所以把判定抽成纯函数在这里逐条覆盖（尤其是「绝不能拦桌面/电话」这类要命的边界）。
javac -nowarn -cp "$WORK/out" -d "$WORK/out" -encoding UTF-8 \
  "$AGENT_SRC/model/PluginRule.java" \
  "$AGENT_SRC/capability/GuardRules.java" \
  "$HERE/GuardCheck.java"
java -Duser.timezone="$TZ" -cp "$WORK/out" GuardCheck
