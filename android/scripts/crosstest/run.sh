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

echo "==> 1/7 用后端实现生成参考结果（对外契约的权威定义）"
(cd "$REPO_DIR/server" && npx tsx "$HERE/reference.ts") > "$WORK/reference.json"

echo "==> 2/7 用真实的 Android ScheduleEngine 复算"
# ScheduleEngine / ScheduleRule 依赖 androidx 注解与 org.json，用最小桩类顶掉，
# 这样能在普通 JVM 上跑真实的业务代码，而不是把逻辑抄一遍来测。
javac -nowarn -d "$WORK/out" -encoding UTF-8 \
  "$HERE"/stubs/androidx/annotation/*.java \
  "$HERE"/stubs/org/json/*.java \
  "$AGENT_SRC/model/ScheduleRule.java" \
  "$AGENT_SRC/capability/ScheduleEngine.java" \
  "$HERE/CrossCheck.java"
java -Duser.timezone="$TZ" -cp "$WORK/out" CrossCheck > "$WORK/android.json"

echo "==> 3/7 逐点比对（作息时间表）"
node "$HERE/compare.mjs" "$WORK/reference.json" "$WORK/android.json"

echo "==> 4/7 逐点比对（学习模式求值）"
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

echo "==> 5/7 学习模式 / 插件管控的判定逻辑"
# 这两套判定依赖界面可见文本，而模拟器里没装微信/QQ，端到端复现不出来，
# 所以把判定抽成纯函数在这里逐条覆盖（尤其是「绝不能拦桌面/电话」这类要命的边界）。
# GuardRules 还引用了 AppLimitRule（应用限时规则），所以第 5 步必须把它的源码一起编译，
# 否则 javac 会报 cannot find symbol 而不是「漏了一个文件」这种能一眼看懂的错误
# AppLimitRule 会打 logcat（丢弃限额规则时给出原因），而 android.util.Log 不在 JVM 上，
# 所以要用桩顶掉。这个桩是空实现 —— Log 的方法返回 void、没有任何逻辑读它，
# 空实现掩盖不了差异（与 org/json 那两个「必须抛异常」的桩不同，原因见桩文件注释）
javac -nowarn -cp "$WORK/out" -d "$WORK/out" -encoding UTF-8 \
  "$HERE"/stubs/android/util/*.java \
  "$AGENT_SRC/model/PluginRule.java" \
  "$AGENT_SRC/model/AppLimitRule.java" \
  "$AGENT_SRC/capability/WindowNode.java" \
  "$AGENT_SRC/capability/GuardRules.java" \
  "$HERE/GuardCheck.java"
java -Duser.timezone="$TZ" -cp "$WORK/out" GuardCheck

echo "==> 6/7 安全区 / 应用限时 / 网址拦截 / 抗篡改时钟 / 知情说明的纯逻辑"
# 这五样在模拟器上验证不了：VpnService 要系统授权与真实网络，
# 应用限时要真实累积使用时长，安全区要真的移动位置，
# 抗篡改时钟要的是「把设备时间调回去」这种不能对着真机反复做的动作
# （TrustedClock 用 setSourceForTest 注入可控时间源，改墙钟与开机时长就能分开驱动），
# 而「还有多久解锁」要等到真的锁上、再等到真的解开才能看一眼 —— 锁定页显示错这个时间，
# 孩子就会盯着一个不会到的点等（LockState 的判定是纯函数，把时刻摆进去就行）。
# 与其写一条「跑得过但什么都没验证」的端到端断言，不如把算法逐条钉死。
javac -nowarn -cp "$WORK/out" -d "$WORK/out" -encoding UTF-8 \
  "$HERE"/stubs/android/util/*.java \
  "$HERE"/stubs/android/os/*.java \
  "$AGENT_SRC/model/SafeZone.java" \
  "$AGENT_SRC/model/AppLimitRule.java" \
  "$AGENT_SRC/capability/Geofence.java" \
  "$AGENT_SRC/capability/DomainBlocker.java" \
  "$AGENT_SRC/capability/DnsMessage.java" \
  "$AGENT_SRC/capability/GuardRules.java" \
  "$AGENT_SRC/capability/TrustedClock.java" \
  "$AGENT_SRC/capability/LockState.java" \
  "$AGENT_SRC/model/JsonUtils.java" \
  "$AGENT_SRC/capability/ChildStatus.java" \
  "$AGENT_SRC/capability/GuardianNotice.java" \
  "$AGENT_SRC/capability/StudyLauncher.java" \
  "$AGENT_SRC/capability/ChildTasks.java" \
  "$AGENT_SRC/capability/BlockedAddresses.java" \
  "$AGENT_SRC/capability/IpPackets.java" \
  "$HERE/PureLogicCheck.java"
java -Duser.timezone="$TZ" -cp "$WORK/out" PureLogicCheck

echo "==> 7/7 知情说明与 AndroidManifest 逐条对照（说明页不许说谎）"
# 为什么值得单独一步：这一页是孩子唯一能看到的「真相声明」，而它最容易悄悄过期 ——
# 代码里加了一个采集能力（比如后台位置），说明书还是那句「不采集位置」，
# 孩子看到的就成了假话。所以把「哪类数据 + 哪个权限 + 采不采」写成数据（Topic），
# 在这里与清单机械对照：清单有权限就必须承认会上报，清单没有就不能说会上报；
# 另外清单里任何一项敏感权限都不许在说明页里只字不提。
MANIFEST="$ANDROID_DIR/app/src/main/AndroidManifest.xml"
NOTICE="$AGENT_SRC/capability/GuardianNotice.java"

topics="$(grep -o 'new Topic("[^"]*", "[^"]*", \(true\|false\))' "$NOTICE" \
    | sed -e 's/^new Topic("//' -e 's/", "/|/' -e 's/", /|/' -e 's/)$//')"
if [ -z "$topics" ]; then
    echo "  ✗ 没能从 GuardianNotice 里解析出 Topic（是不是改了写法？）" >&2
    exit 1
fi

topic_count=0
while IFS='|' read -r label perm collected; do
    [ -z "$label" ] && continue
    topic_count=$((topic_count + 1))
    if [ -z "$perm" ]; then
        echo "  ✓ ${label}：本机数据（无对应权限），说明页结论「${collected}」"
        continue
    fi
    if grep -q "android:name=\"$perm\"" "$MANIFEST"; then
        if [ "$collected" != "true" ]; then
            echo "  ✗ ${label}：清单声明了 ${perm}，说明页却写着「不采集」" >&2
            exit 1
        fi
        echo "  ✓ ${label}：清单有 ${perm}，说明页承认会上报"
    else
        if [ "$collected" != "false" ]; then
            echo "  ✗ ${label}：清单里没有 ${perm}，说明页却声称会上报" >&2
            exit 1
        fi
        echo "  ✓ ${label}：清单没有 ${perm}，说明页也明说不采集"
    fi
done <<< "$topics"

# 反向：清单里声明了敏感权限，说明页里必须提到它（新增能力不能忘了更新说明）
# ACCESS_COARSE_LOCATION 故意不在这个清单里：粗糙定位与精确定位是同一类数据，
# 说明页用「位置」一条（对应 ACCESS_FINE_LOCATION）说清了，再要求它单独列一遍是
# 形式主义。清单只放「换一类数据就必须换一句话」的那些权限。
SENSITIVE="READ_SMS READ_CALL_LOG READ_CONTACTS READ_MEDIA_IMAGES READ_MEDIA_VIDEO \
READ_EXTERNAL_STORAGE READ_CALENDAR READ_PHONE_STATE GET_ACCOUNTS CALENDAR CAMERA \
RECORD_AUDIO ACCESS_FINE_LOCATION ACCESS_BACKGROUND_LOCATION \
PACKAGE_USAGE_STATS QUERY_ALL_PACKAGES BIND_ACCESSIBILITY_SERVICE"
for name in $SENSITIVE; do
    full="android.permission.$name"
    if grep -q "android:name=\"$full\"" "$MANIFEST"; then
        if ! grep -q "\"$full\"" "$NOTICE"; then
            echo "  ✗ 清单声明了 ${name}，但说明页一个字都没提" >&2
            exit 1
        fi
    fi
done
echo "  ✓ 说明页共 ${topic_count} 类数据的结论与清单一致，清单里的敏感权限无一遗漏"
